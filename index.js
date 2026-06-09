require('dotenv').config();
const express = require('express');
const axios = require('axios');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const app = express();
app.use(express.json({ verify: (req, res, buf) => { req.rawBody = buf; } }));

const OPENAI_KEY = process.env.OPENAI_API_KEY;
const VERIFY_TOKEN = process.env.META_VERIFY_TOKEN;
const APP_SECRET = process.env.META_APP_SECRET;
const PAGE_TOKEN = process.env.PAGE_ACCESS_TOKEN;
const AD_ACCOUNT_ID = process.env.AD_ACCOUNT_ID || 'act_1556768588735258';
const GRAPH_BASE = 'https://graph.facebook.com/v19.0';

// ── TELEGRAM CONFIG ──
const TELEGRAM_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const TELEGRAM_CHAT_ID = process.env.TELEGRAM_CHAT_ID;

async function sendTelegram(text) {
  try {
    await axios.post(`https://api.telegram.org/bot${TELEGRAM_TOKEN}/sendMessage`, {
      chat_id: TELEGRAM_CHAT_ID,
      text,
      parse_mode: 'HTML'
    });
    console.log('✓ Telegram sent');
  } catch (e) {
    console.error('✗ Telegram error:', e.response?.data?.description || e.message);
  }
}

// ── TELEGRAM WEBHOOK — /release, /list команд ──
app.post('/telegram', async (req, res) => {
  res.sendStatus(200);
  const msg = req.body?.message;
  if (!msg) return;

  const chatId = String(msg.chat?.id);
  const text = msg.text || '';

  if (chatId !== String(TELEGRAM_CHAT_ID)) return;

  if (text.startsWith('/release')) {
    const parts = text.trim().split(/\s+/);
    const userId = parts[1];
    if (!userId) {
      await sendTelegram('⚠️ Хэрэглэгчийн ID оруулна уу.\nЖишээ: <code>/release 24473552475676679</code>');
      return;
    }
    if (humanHandoff.has(userId)) {
      removeHandoff(userId);
      await sendTelegram(`✅ <b>Handoff унтраагдлаа!</b>\n\n👤 ID: <code>${userId}</code>\n🤖 Bot дахин энэ хэрэглэгчтэй харьцаж эхэллээ.`);
      console.log(`✓ Handoff released via Telegram for ${userId}`);
    } else {
      await sendTelegram(`ℹ️ <code>${userId}</code> handoff горимд байгаагүй.`);
    }
  }

  if (text === '/list') {
    if (humanHandoff.size === 0) {
      await sendTelegram('ℹ️ Одоо handoff горимд байгаа хэрэглэгч байхгүй.');
    } else {
      const list = [...humanHandoff].map(id => `• <code>${id}</code> → https://m.me/${id}`).join('\n');
      await sendTelegram(`📋 <b>Handoff горимд байгаа хэрэглэгчид:</b>\n\n${list}`);
    }
  }

  // ── /send <userId> <variantNumber> ── 3 хувилбараас сонгож илгээх
  if (text.startsWith('/send')) {
    const parts = text.trim().split(/\s+/);
    const userId = parts[1];
    const variantNum = parts[2];

    if (!userId || !variantNum) {
      await sendTelegram('⚠️ Формат: <code>/send [userId] [1|2|3]</code>\nЖишээ: <code>/send 24473552475676679 1</code>');
      return;
    }
    if (!['1', '2', '3'].includes(variantNum)) {
      await sendTelegram('⚠️ Variant дугаар 1, 2 эсвэл 3 байх ёстой.');
      return;
    }

    const drafts = getDrafts(userId);
    if (!drafts) {
      await sendTelegram(`⚠️ <code>${userId}</code>-ын draft байхгүй (TTL 1 цаг).\nЭсвэл өөрөө бичих: <code>/dm ${userId} [мессеж]</code>`);
      return;
    }

    const variant = drafts[`variant_${variantNum}`];
    if (!variant || !variant.body) {
      await sendTelegram(`⚠️ Variant ${variantNum} хоосон байна.`);
      return;
    }

    try {
      await sendDMWithHumanAgent(userId, variant.body);
      await sendTelegram(`✅ <b>Илгээлээ!</b>\n\n👤 <code>${userId}</code>\n📝 Variant ${variantNum}: <i>${variant.label}</i>\n\n💬 Мессеж:\n<i>${variant.body.slice(0, 200)}${variant.body.length > 200 ? '...' : ''}</i>`);
      // Draft used — remove from store
      draftStore.delete(userId);
    } catch (e) {
      await sendTelegram(`✗ Илгээх алдаа: ${e.message}`);
    }
    return;
  }

  // ── /dm <userId> <message> ── Өөрийн бичсэн мессеж шууд илгээх
  if (text.startsWith('/dm ')) {
    const remaining = text.slice(4).trim();
    const firstSpace = remaining.indexOf(' ');
    if (firstSpace === -1) {
      await sendTelegram('⚠️ Формат: <code>/dm [userId] [мессеж]</code>\nЖишээ: <code>/dm 24473552475676679 Сайн байна уу...</code>');
      return;
    }
    const userId = remaining.slice(0, firstSpace);
    const message = remaining.slice(firstSpace + 1).trim();

    if (!userId || !message) {
      await sendTelegram('⚠️ userId эсвэл мессеж дутуу байна.');
      return;
    }

    try {
      await sendDMWithHumanAgent(userId, message);
      await sendTelegram(`✅ <b>Илгээлээ!</b>\n\n👤 <code>${userId}</code>\n💬 <i>${message.slice(0, 200)}${message.length > 200 ? '...' : ''}</i>`);
    } catch (e) {
      await sendTelegram(`✗ Илгээх алдаа: ${e.message}`);
    }
    return;
  }

  // ── /draft <userId> ── Тодорхой хэрэглэгчид draft дахин үүсгэх
  if (text.startsWith('/draft')) {
    const parts = text.trim().split(/\s+/);
    const userId = parts[1];

    if (!userId) {
      await sendTelegram('⚠️ Формат: <code>/draft [userId]</code>\nЭнэ нь тухайн хэрэглэгчид 3 шинэ draft бэлдэнэ.');
      return;
    }

    const history = getHistory(userId);
    if (history.length === 0) {
      await sendTelegram(`⚠️ <code>${userId}</code>-ын яриа байхгүй.`);
      return;
    }
    const lastUserMsg = history.filter(m => m.role === 'user').slice(-1)[0];
    if (!lastUserMsg) {
      await sendTelegram(`⚠️ Хэрэглэгчийн мессеж олдсонгүй.`);
      return;
    }

    await sendTelegram(`⏳ Draft бэлдэж байна...`);
    await notifyTelegramComplaint(userId, lastUserMsg.content, history);
    return;
  }

  // ── /help ──
  if (text === '/help' || text === '/start') {
    const helpMsg = `🌸 <b>SkinBloom Bot — Telegram командууд</b>

<b>Handoff удирдлага:</b>
<code>/list</code> — handoff горимд байгаа хүмүүс
<code>/release [userId]</code> — handoff унтраах

<b>Хэрэглэгчид мессеж илгээх:</b>
<code>/send [userId] [1|2|3]</code> — Draft variant сонгож илгээх
<code>/dm [userId] [text]</code> — Өөрийн бичсэн мессеж илгээх
<code>/draft [userId]</code> — Шинэ 3 draft бэлдэх

<b>Тусламж:</b>
<code>/help</code> — энэ мессеж`;
    await sendTelegram(helpMsg);
    return;
  }
});

const HANDOFF_FILE = path.join('/tmp', 'handoff.json');

function loadHandoff() {
  try {
    if (fs.existsSync(HANDOFF_FILE)) {
      const data = JSON.parse(fs.readFileSync(HANDOFF_FILE, 'utf8'));
      return new Set(data);
    }
  } catch (e) { console.error('Handoff load error:', e.message); }
  return new Set();
}

function saveHandoff(set) {
  try { fs.writeFileSync(HANDOFF_FILE, JSON.stringify([...set])); }
  catch (e) { console.error('Handoff save error:', e.message); }
}

const humanHandoff = loadHandoff();

function addHandoff(senderId) {
  humanHandoff.add(senderId);
  saveHandoff(humanHandoff);
}

function removeHandoff(senderId) {
  humanHandoff.delete(senderId);
  saveHandoff(humanHandoff);
}

// ── ACTIVE ORDERS STATE (NEW v2.8.0) ──
// senderId → { color, qty, address, entranceCode, phone, payment, total, placedAt, status }
// status: 'collecting' | 'placed' | 'edit_pending' | 'cancel_reason_pending' | 'cancelled'
const ACTIVE_ORDERS_FILE = path.join('/tmp', 'active_orders.json');
const activeOrders = new Map();

function loadActiveOrders() {
  try {
    if (fs.existsSync(ACTIVE_ORDERS_FILE)) {
      const data = JSON.parse(fs.readFileSync(ACTIVE_ORDERS_FILE, 'utf8'));
      data.forEach(([k, v]) => activeOrders.set(k, v));
    }
  } catch (e) { console.error('Active orders load error:', e.message); }
}

function saveActiveOrders() {
  try { fs.writeFileSync(ACTIVE_ORDERS_FILE, JSON.stringify([...activeOrders])); }
  catch (e) { console.error('Active orders save error:', e.message); }
}

function setOrder(senderId, order) {
  activeOrders.set(senderId, { ...order, updatedAt: Date.now() });
  saveActiveOrders();
}

function getOrder(senderId) {
  return activeOrders.get(senderId);
}

function clearOrder(senderId) {
  activeOrders.delete(senderId);
  saveActiveOrders();
}

loadActiveOrders();

// ── GREETING ANTI-REPEAT (NEW v2.8.0) ──
const greetingTimestamps = new Map(); // senderId → timestamp
const GREETING_COOLDOWN_MS = 5 * 60 * 1000;

function hasRecentGreeting(senderId) {
  const ts = greetingTimestamps.get(senderId);
  return ts && (Date.now() - ts) < GREETING_COOLDOWN_MS;
}

function markGreeting(senderId) {
  greetingTimestamps.set(senderId, Date.now());
}

// ── ATTACHMENT DEDUPE (NEW v2.8.0) ──
const attachmentTimestamps = new Map(); // senderId → timestamp
const ATTACHMENT_COOLDOWN_MS = 30 * 1000;

function isDuplicateAttachment(senderId) {
  const ts = attachmentTimestamps.get(senderId);
  if (ts && (Date.now() - ts) < ATTACHMENT_COOLDOWN_MS) return true;
  attachmentTimestamps.set(senderId, Date.now());
  return false;
}

// ── ORDER ID GENERATOR (NEW v2.8.0) ──
function generateOrderId() {
  const d = new Date();
  const ymd = `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, '0')}${String(d.getDate()).padStart(2, '0')}`;
  const rand = Math.floor(Math.random() * 900 + 100);
  return `SB-${ymd}-${rand}`;
}

// ── PHONE EXTRACTION & VALIDATION (NEW v2.8.0) ──
function extractPhone(text) {
  if (!text) return null;
  // +976 prefix-ийг арилгана
  const normalized = text.replace(/\+?976/g, ' ');
  // Бие даасан 8-оронтой тоо хайх (boundary-той)
  const matches = normalized.match(/(?:^|[^\d])(\d{8})(?:[^\d]|$)/g);
  if (!matches) return null;
  for (const m of matches) {
    const num = m.match(/(\d{8})/)[1];
    const firstDigit = num[0];
    // Монголын mobile/landline эхний орон: 5, 7, 8, 9
    if (['5', '7', '8', '9'].includes(firstDigit)) {
      return num;
    }
  }
  return null;
}

// ── ADDRESS DETECTION & SCORING (NEW v2.8.0) ──
const DISTRICT_CODES = ['бзд', 'бгд', 'сбд', 'худ', 'чд', 'схд', 'нд', 'shd', 'bzd', 'bgd', 'sbd', 'khud', 'chd', 'skhd', 'nd', 'shd'];
const DISTRICT_FULL = ['баянзүрх', 'баянгол', 'сүхбаатар', 'хан-уул', 'чингэлтэй', 'сонгинохайрхан', 'налайх', 'багахангай', 'багануур'];
const ADDRESS_MARKERS = ['хороо', 'хороолол', 'байр', 'тоот', 'хотхон', 'гудамж', 'давхар', 'apartment', 'apt', 'building', 'street', 'khoroo', 'baig', 'bair', 'toot', 'hothon', 'davhar', 'gudamj', 'horoolol'];

function scoreAddress(text) {
  if (!text) return 0;
  const lower = text.toLowerCase();
  let score = 0;
  if (DISTRICT_CODES.some(d => lower.includes(d))) score += 2;
  if (DISTRICT_FULL.some(d => lower.includes(d))) score += 2;
  const markersFound = ADDRESS_MARKERS.filter(m => lower.includes(m)).length;
  score += markersFound;
  // Дугаартай тоо (тоот дугаар, давхар, байр гэх мэт)
  const digits = (lower.match(/\d+/g) || []).length;
  if (digits >= 2) score += 1;
  return score;
}

function looksLikeAddress(text) {
  if (!text || text.trim().length < 6) return false;
  return scoreAddress(text) >= 2;
}

// ── BATCH ORDER PARSE (NEW v2.8.0) ──
// Хэрэглэгч нэг мессеж дотор олон slot өгсөн үед бүгдийг ялган авна
function parseOrderSlots(text, existing = {}) {
  const result = { ...existing };
  if (!text) return result;
  const lower = text.toLowerCase();

  // Color
  if (!result.color) {
    if (/pearl\s*white|цагаан|tsagaan|tsagan|tagaan/i.test(text)) result.color = 'Pearl White';
    else if (/slate\s*gray|saaral|саарал|саарл/i.test(text)) result.color = 'Slate Gray';
    else if (/obsidian|black|хар|har\b|kar\b/i.test(text)) result.color = 'Obsidian Black';
  }

  // Qty
  if (!result.qty) {
    const qtyMatch = lower.match(/(\d+)\s*(ширхэг|ш\.?|piece|pcs|x)/i);
    if (qtyMatch) result.qty = parseInt(qtyMatch[1], 10);
  }
  // "X1", "x2" гэх формат
  if (!result.qty) {
    const xMatch = text.match(/[xX×](\d+)/);
    if (xMatch) result.qty = parseInt(xMatch[1], 10);
  }

  // Phone
  if (!result.phone) {
    const ph = extractPhone(text);
    if (ph) result.phone = ph;
  }

  // Entrance code: "орцны код 3333", "ortsnii kod 3333#", "код: 3333"
  if (!result.entranceCode) {
    const codeMatch = text.match(/(?:орцны\s*код|ortsnii\s*kod|орц[нии]*\s*код|код|code)[:\s#]*(\d{2,6})/i);
    if (codeMatch) result.entranceCode = codeMatch[1];
  }

  // Payment
  if (!result.payment) {
    // COD indicator phrases (isCODPaymentChoice-той ижил logic)
    if (/жолооч|joloochid|joloch|joloochi|cod|бэлнээр|belneer|belnerr|belnerr|авсны дараа|avsny daraa|avsni daraa|awsny daraa|awsni daraa|tootsoo hiine|tootsoo hiy|тооцоо хий|cash on delivery/i.test(lower)) {
      result.payment = 'COD';
    } else if (/банк|bank|урьдчилж|urdjilj|шилжүүл|shiljuule|шижлүүл/i.test(lower)) {
      result.payment = 'BANK';
    }
  }

  // Address: longest "address-looking" line
  if (!result.address) {
    const lines = text.split(/\n|[,;]/).map(s => s.trim()).filter(Boolean);
    let bestLine = null;
    let bestScore = 0;
    for (const line of lines) {
      const sc = scoreAddress(line);
      if (sc > bestScore && line.length >= 8) {
        bestScore = sc;
        bestLine = line;
      }
    }
    // Бүтэн message тэр чигтээ address байж болзошгүй
    const fullScore = scoreAddress(text);
    if (fullScore > bestScore && text.length >= 8 && text.length <= 250) {
      bestLine = text.trim();
      bestScore = fullScore;
    }
    if (bestLine && bestScore >= 2) {
      // Phone-ыг arilgah
      result.address = bestLine.replace(/(?:^|[^\d])(\d{8})(?:[^\d]|$)/g, ' ').trim();
    }
  }

  return result;
}

// ── HANDOFF DETECTION (Bot reply-аас trigger) ──
const HANDOFF_KEYWORDS = [
  'манай баг', 'эргэн холбогдох', 'түр хүлээ',
  'удахгүй холбогдох', 'менежер', 'холбогдох болно',
  'тантай холбогдох', 'баг тантай'
];

function shouldTriggerHandoff(reply) {
  if (reply.includes('[HANDOFF_NEEDED]')) return true;
  const lower = reply.toLowerCase();
  return HANDOFF_KEYWORDS.some(kw => lower.includes(kw.toLowerCase()));
}

// ── USER-INITIATED HANDOFF DETECTION (NEW v2.8.0) ──
// Хэрэглэгч өөрөө хүн/менежер хүсэх, очиж үзэх, дэлгүүр визит хүсэх үг
const USER_HANDOFF_REQUEST_KEYWORDS = [
  // Хүн руу шилжүүлэх
  'хүнтэй ярих', 'hunteh yarih', 'huntei yarih', 'оператор', 'operator',
  'ажилтан', 'azhiltan', 'ажилчин', 'менежер', 'menezher', 'manager',
  'жинхэнэ хүн', 'real person', 'live agent', 'live person',
  // Очиж үзэх / бодит дэлгүүр
  'очиж', 'ochih', 'ochmoor', 'ochmor', 'очмоор', 'ochij vzmeer',
  'очиж үзэх', 'очиж үзмээр', 'очиж харах', 'нүдээр харах', 'nudeer harah',
  'газар дээр нь', 'gazar deer', 'дэлгүүр очих', 'delguur ochih',
  'агуулах очих', 'ageulah', 'офис очих', 'office очих',
  'хаашаа очих', 'хаана байр', 'хаанаа байг', 'хаана байш', 'bairshil',
  'байршил', 'байрлал', 'хаягаа хэлээч',
  // Direct human request
  'human', 'manai bag', 'manai baig', 'таны баг', 'tani bag',
  'bag tanij', 'bag tanij ognoroi'
];

function isUserHandoffRequest(text) {
  if (!text) return false;
  const lower = text.toLowerCase();
  return USER_HANDOFF_REQUEST_KEYWORDS.some(kw => lower.includes(kw));
}

// ── CANCELLATION DETECTION (NEW v2.8.0, refined v2.8.1) ──
const CANCELLATION_KEYWORDS = [
  // Direct cancellation — root "цуцл" гэж эхэлсэн бүх үг
  'цуцл', 'tsutsl', 'tsutsal', 'цуцал',
  'захиалга цуцл', 'захиалгаа цуцл', 'захиалгаа боли',
  'болих', 'bolih', 'болисон', 'болилоо', 'bolisuun', 'болиё', 'болио',
  // Indirect
  'битгий илгээ', 'битгий явуул', 'битгий ил', 'битгий ирүүл',
  'хэрэггүй', 'kheregguy', 'kheregui', 'хэрэг алга', 'kherg alga',
  'авахгүй', 'аваагүй', 'avahgui', 'avaagui',
  'хүсэхгүй', 'huseh gui',
  // Past-tense (хэрэглэгчийн ёжтой acknowledgment)
  'цуцлагдсан', 'tsutslagdsan', 'цуцлагдлаа',
  // English
  'cancel', 'canceled', 'cancelled', 'cancelation', 'cancellation'
];

// COD payment indicator phrases — ЭДГЭЭР CANCELLATION БИШ
// "авсны дараа", "awsni daraa" гэх phrase нь COD сонголт, цуцлах биш.
// Эдгээр substring CANCELLATION_KEYWORDS-той false match хийж болзошгүй учир exclude хийнэ.
const COD_INDICATOR_PHRASES = [
  'авсны дараа', 'avsny daraa', 'avsni daraa', 'awsny daraa', 'awsni daraa',
  'жолоочид бэлн', 'joloochid beln', 'jolochid', 'joloch',
  'бэлнээр төл', 'belneer tol', 'belneer tul',
  'cod', 'cash on delivery',
  // Зураг 2-аас real-world test: 'awsni daraa tootsoo hiine' (авсны дараа тооцоо хийнэ)
  'tootsoo hiine', 'tootsoo hiy', 'тооцоо хий'
];

function isCODPaymentChoice(text) {
  if (!text) return false;
  const lower = text.toLowerCase();
  return COD_INDICATOR_PHRASES.some(p => lower.includes(p));
}

function isCancellationRequest(text) {
  if (!text) return false;
  // COD payment мэдэгдэл бол cancellation БИШ — урьдчилан exclude хийх
  if (isCODPaymentChoice(text)) return false;
  const lower = text.toLowerCase();
  return CANCELLATION_KEYWORDS.some(kw => lower.includes(kw));
}

// Хэрэглэгч cancellation reason flow-д "цуцлах гэж хэлээгүй" гэх денайл хэлсэн эсэхийг шалгах
const CANCEL_DENIAL_PATTERNS = [
  'цуцлах гэж хэлээгүй', 'tsutsly gej heleegui', 'tsutslakh gej heleegui',
  'цуцлахгүй', 'tsutslakhgui', 'tsutslahgui',
  'захиалах гэж', 'zahialy gej', 'zahialah gej',
  'болиогүй', 'болиогуй', 'boliogui',
  'цуцлахаа болих', 'tsutslakhaa bolih',
  'буруу ойлго', 'buruu oilg', 'misunderstand',
  'миний хэлсэн нь', 'minii helsen ni'
];

function isCancellationDenial(text) {
  if (!text) return false;
  const lower = text.toLowerCase();
  return CANCEL_DENIAL_PATTERNS.some(p => lower.includes(p));
}

// ── PROVINCE / OUT-OF-UB DELIVERY DETECTION (NEW v2.8.0) ──
const PROVINCE_KEYWORDS = [
  'дархан', 'darhan', 'darkhan',
  'эрдэнэт', 'erdenet',
  'чойбалсан', 'choibalsan', 'choibals',
  'мөрөн', 'moron', 'muren',
  'улаангом', 'ulaangom',
  'арвайхээр', 'arvaiheer',
  'сүхбаатар', 'sukhbaatar', 'suhbaatar',
  'баянхонгор', 'bayankhongor', 'bayanhongor',
  'булган', 'bulgan',
  'говь-алтай', 'gobi altai', 'altai',
  'сайншанд', 'sainshand',
  'зуунмод', 'zuunmod',
  'аймаг', 'aimag', 'aymag',
  'хөдөө', 'khudoo', 'hudoo',
  'oron nutag', 'орон нутаг'
];

function isProvinceDelivery(text) {
  if (!text) return false;
  const lower = text.toLowerCase();
  // Орон нутгийн нэр илрүүлэх (хатуу word boundary үгүйгээр ч ажиллах)
  return PROVINCE_KEYWORDS.some(kw => {
    // "darkhan" нь "darkhanchuud" гэх мэт үгэнд орохгүй гэдгийг шалгахын тулд boundary
    const re = new RegExp(`(?:^|[\\s,.;:!?])${kw}(?:[\\s,.;:!?]|$)`, 'i');
    return re.test(lower);
  });
}

// ── WHOLESALE / BULK DETECTION (NEW v2.8.0) ──
const WHOLESALE_KEYWORDS = [
  'wholesale', 'optoor', 'оптоор', 'опт',
  'олноор', 'olnoor', 'олон ширхэг авах', 'олон ширхэгээр',
  'reseller', 'дилер', 'diler', 'агент',
  'b2b', 'бизнес'
];

function isWholesaleRequest(text) {
  if (!text) return false;
  const lower = text.toLowerCase();
  if (WHOLESALE_KEYWORDS.some(kw => lower.includes(kw))) return true;
  // 4+ ширхэг хүсэх
  const qtyMatch = lower.match(/(\d+)\s*(ширхэг|ш\.?|piece|pcs)/i);
  if (qtyMatch && parseInt(qtyMatch[1], 10) >= 4) return true;
  return false;
}

// ── PRICE MANIPULATION DETECTION (NEW v2.8.0) ──
const PRICE_MANIPULATION_KEYWORDS = [
  'хямдрал нэмэх', 'хямдруулах', 'дискаунт', 'discount өгөх',
  'хямдхан болго', 'үнэ буулга', 'буулгаач', 'buulgach',
  'хямд болго', 'илүү хямд', 'arai khyamd', 'арай хямд'
];

function isPriceManipulation(text) {
  if (!text) return false;
  const lower = text.toLowerCase();
  return PRICE_MANIPULATION_KEYWORDS.some(kw => lower.includes(kw));
}

// ── DIRECT INFO REQUEST DETECTION (NEW v2.8.0) ──
const DIRECT_INFO_KEYWORDS = [
  'мэдээлэл авъя', 'medeelel avya', 'medeelel awya',
  'тайлбар', 'tailbar',
  'дэлгэрэнгүй мэд', 'delgerengui',
  'шүршүүрийн тухай', 'shurshuuriin tuhai',
  'шүршүүрийн мэдээлэл', 'шүршүүрийн толгойн мэдээлэл',
  'бүтээгдэхүүний мэдээлэл', 'буүтээгдэхүүний тухай',
  'product info', 'товч танилцуул', 'танилцуул'
];

function isDirectInfoRequest(text) {
  if (!text) return false;
  const lower = text.toLowerCase();
  return DIRECT_INFO_KEYWORDS.some(kw => lower.includes(kw));
}

// ── UGC/INFLUENCER DETECTION ──
const UGC_KEYWORDS = [
  'ugc', 'influencer', 'инфлюэнсер', 'контент хийх', 'контент хийе',
  'collab', 'коллаб', 'collaborat', 'хамтран', 'хамтарч',
  'фото хийх', 'видео хийх', 'зураг авах', 'зураг дарах',
  'бүтээгдэхүүн явуулах', 'бүтээгдэхүүн өгөх', 'pr', 'пиар',
  'реклам хийх', 'сурталчлах', 'promote'
];

function isUGCOrInfluencer(text) {
  const lower = text.toLowerCase();
  return UGC_KEYWORDS.some(kw => lower.includes(kw));
}

// ── COMPLAINT DETECTION (хэрэглэгчийн санал гомдол) ──
const COMPLAINT_KEYWORDS = [
  // Direct гомдол
  'гомдол', 'санал гомдол', 'gomdol',
  // Буцаалт
  'буцаах', 'буцаалт', 'буцааж өг', 'butsaah', 'butsaalt',
  'мөнгөө буцааж', 'төлбөрөө буцааж',
  // Чанарын асуудал
  'эвдэрсэн', 'evdersen', 'evderhgui', 'муу чанартай',
  'ажилахгүй', 'ажиллахгүй', 'azhilahgui', 'ажилгүй',
  'хугарсан', 'hugarsan', 'эвдэрчихсэн',
  // Сэтгэл хангалуун биш
  'таалагдсангүй', 'taalagdsangui', 'taalagdahgui',
  'сэтгэл хангалуун биш', 'дургуй', 'durgui',
  // Буруу ирсэн
  'буруу ирсэн', 'buruu irsen', 'өөр зүйл ирсэн',
  'ялгаатай ирсэн', 'буруу хүргэгдсэн', 'буруу бүтээгдэхүүн',
  // Confusion (post-аас)
  'буруу ойлгосон', 'buruu oilgoson', 'iim gej bodoogui',
  'ийм гэж бодоогүй', 'запас ирэх гэж бодсон',
  'zapas irne gej bodson', 'iim bsiin', 'ирэх гэж бодсон',
  'буруу мэдээлэл', 'buruu medeelel', 'хууртагдсан',
  // Хариуцлага
  'хариуцлага', 'хариуцлагатай', 'арга хэмжээ',
  // Ирээгүй
  'ирээгүй', 'iregui', 'хүргэгдээгүй', 'hurgegdeegui',
  'хүлээж байна', 'huleej baina', 'хүргэлт удаан'
];

function isComplaint(text) {
  const lower = text.toLowerCase();
  return COMPLAINT_KEYWORDS.some(kw => lower.includes(kw));
}

// ── ADMIN/OPERATOR DETECTION (Page side-аас echo event) ──
// Энд "manager", "менежер" гэх мэт үг бичигдсэн бол owner гар хүргэхээр оров гэж танина
const ADMIN_HANDOFF_KEYWORDS = [
  'manager', 'менежер', 'manai bag', 'манай баг',
  'manai bagas', 'манайхаас', 'тантай холбогдох',
  'эргэн холбогдох', 'удахгүй холбогдох'
];

function isAdminTakeover(text) {
  if (!text) return false;
  const lower = text.toLowerCase();
  return ADMIN_HANDOFF_KEYWORDS.some(kw => lower.includes(kw.toLowerCase()));
}

async function notifyTelegramUGC(senderId, userText) {
  const msg = `📸 <b>UGC / INFLUENCER хүсэлт!</b>

👤 Messenger ID: <code>${senderId}</code>
💬 Мессеж: <b>${userText}</b>

👉 Хариулах: https://m.me/${senderId}

<i>Контент хийх сонирхолтой хэрэглэгч байна.</i>`;
  await sendTelegram(msg);
}

// ── DRAFT VARIANTS GENERATOR (Owner-руу 3 хувилбар санал болгох) ──
// GPT-аар тухайн хэрэглэгчийн context-д тохирсон 3 өөр strategy-ийн мессеж бэлдэнэ
async function generateDraftVariants(senderId, userText, history) {
  const recentMessages = history.slice(-8).map(m =>
    `${m.role === 'user' ? 'Хэрэглэгч' : 'Bot'}: ${m.content}`
  ).join('\n');

  const draftPrompt = `Та SkinBloom брэндийн customer service менежер. Хэрэглэгч санал гомдол мэдүүлсэн.

ХЭРЭГЛЭГЧИЙН СҮҮЛИЙН МЕССЕЖ:
"${userText}"

СҮҮЛИЙН ЯРИАНЫ КОНТЕКСТ:
${recentMessages || '(контекст байхгүй — анхны мессеж)'}

ЭНЭ ХЭРЭГЛЭГЧИД ИЛГЭЭХ 3 ӨӨР СТРАТЕГИЙН МЕССЕЖ БЭЛД:

Variant 1: EMPATHY + RECOVERY OFFER (өршөөл хүсч, нөхөн төлбөрт зөвхөн SkinBloom-аас voucher эсвэл үнэгүй filter санал)
Variant 2: DIRECT FIX — SHORT (богино, шууд хариулт + tactical solution)
Variant 3: ESCALATE — буцаах/цуцлах сонголтыг өгөх

ДҮРЭМ:
- Монгол хэлээр бичих
- Эхлэхдээ "Сайн байна уу [нэр]?" эсвэл "Сайн байна уу?" гэж хандана
- 199'900₮ хэлбэрийн apostrophe ашиглах
- "Pearl White 3-в-1", "ceramic", "Dyson", "Loofah", "Peeling", "Массажны", "Нэмэлт шүүлтүүр" — эдгээр үг бичихгүй
- Холбоо: 95999989
- Хариуцлагатай, дулаан tone
- Богино, mobile дээр уншигдахаар (5-10 мөрөөс ихгүй)

JSON форматаар хариул:
{
  "variant_1": {"label": "Empathy + recovery", "body": "..."},
  "variant_2": {"label": "Direct fix", "body": "..."},
  "variant_3": {"label": "Escalate", "body": "..."}
}

Зөвхөн JSON-ийг буцаа, өөр текст бичихгүй.`;

  try {
    const res = await axios.post('https://api.openai.com/v1/chat/completions', {
      model: 'gpt-4o-mini',
      messages: [{ role: 'user', content: draftPrompt }],
      temperature: 0.7,
      max_tokens: 1500,
      response_format: { type: 'json_object' }
    }, { headers: { Authorization: `Bearer ${OPENAI_KEY}` } });

    const json = JSON.parse(res.data.choices[0].message.content);
    return json;
  } catch (e) {
    console.error('Draft variants error:', e.message);
    return null;
  }
}

// ── DRAFT VARIANTS STORE (Telegram → reply mapping) ──
// Owner Telegram-аас /send 1 эсвэл /send 2 командаар сонгоход
// тухайн userId-руу variant_N-ийн body илгээнэ
const draftStore = new Map(); // userId → { variants: {1, 2, 3}, expiresAt }
const DRAFT_TTL = 60 * 60 * 1000; // 1 цаг

function saveDrafts(userId, variants) {
  draftStore.set(userId, {
    variants,
    expiresAt: Date.now() + DRAFT_TTL
  });
  // Cleanup expired
  for (const [id, d] of draftStore) {
    if (d.expiresAt < Date.now()) draftStore.delete(id);
  }
}

function getDrafts(userId) {
  const d = draftStore.get(userId);
  if (!d || d.expiresAt < Date.now()) {
    draftStore.delete(userId);
    return null;
  }
  return d.variants;
}

// ── COMPLAINT TELEGRAM ALERT + DRAFT SUGGESTION ──
async function notifyTelegramComplaint(senderId, userText, history) {
  // 1) Initial alert
  const alertMsg = `🚨 <b>САНАЛ ГОМДОЛ — Яаралтай!</b>

👤 Messenger ID: <code>${senderId}</code>
💬 Мессеж: <b>${userText}</b>

👉 Хариулах: https://m.me/${senderId}

<i>Bot хариулсангүй — handoff горимд оруулав.
Доор 3 draft хувилбар бэлдэж байна...</i>`;
  await sendTelegram(alertMsg);

  // 2) Generate 3 draft variants
  const drafts = await generateDraftVariants(senderId, userText, history);
  if (!drafts) {
    await sendTelegram(`⚠️ Draft бэлдэх алдаа гарлаа. Гар хариулна уу: https://m.me/${senderId}`);
    return;
  }

  // 3) Save drafts for /send command
  saveDrafts(senderId, drafts);

  // 4) Send 3 variants as separate messages
  const v1 = drafts.variant_1 || {};
  const v2 = drafts.variant_2 || {};
  const v3 = drafts.variant_3 || {};

  const draftMsg = `📝 <b>3 хувилбарт мессеж:</b>

━━━━━━━━━━━━━━━━━━
<b>1️⃣ ${v1.label || 'Empathy'}</b>
<i>${v1.body || '(хоосон)'}</i>

━━━━━━━━━━━━━━━━━━
<b>2️⃣ ${v2.label || 'Direct fix'}</b>
<i>${v2.body || '(хоосон)'}</i>

━━━━━━━━━━━━━━━━━━
<b>3️⃣ ${v3.label || 'Escalate'}</b>
<i>${v3.body || '(хоосон)'}</i>

━━━━━━━━━━━━━━━━━━

✅ <b>Сонгох:</b>
<code>/send ${senderId} 1</code> — Variant 1 илгээх
<code>/send ${senderId} 2</code> — Variant 2 илгээх
<code>/send ${senderId} 3</code> — Variant 3 илгээх

✏️ <b>Өөрийн мессеж:</b>
<code>/dm ${senderId} [таны бичих мессеж]</code>`;

  await sendTelegram(draftMsg);
}

// ── ADMIN TAKEOVER NOTIFY (Owner Page-аас Manager гэж бичсэн үед) ──
async function notifyTelegramAdminTakeover(senderId, adminText) {
  const msg = `🤝 <b>ADMIN TAKEOVER илрэв</b>

👤 Messenger ID: <code>${senderId}</code>
💬 Та бичсэн: "${adminText.slice(0, 100)}${adminText.length > 100 ? '...' : ''}"

✅ Bot автоматаар handoff горимд оруулав — энэ хэрэглэгчтэй цаашид Bot хариулахгүй.

<i>Bot-ийг буцаан асаах: <code>/release ${senderId}</code></i>`;
  await sendTelegram(msg);
}

// ── ORDER DETECTION ──
function isOrderComplete(botReply) {
  return botReply.includes('Таны захиалгыг хүлээн авлаа ✅');
}

// ── COD ORDER DETECTION ──
function isCODOrder(botReply) {
  return botReply.includes('[COD_ORDER]');
}

const ORDER_EDIT_KEYWORDS = [
  'хаяг солих', 'хаяг өөрчлөх', 'хаяг засах', 'хаяг буруу',
  'утас солих', 'утас өөрчлөх', 'дугаар солих', 'дугаар буруу',
  'өнгө солих', 'өнгө өөрчлөх', 'өнгө буруу',
  'тоо солих', 'тоо өөрчлөх', 'ширхэг солих',
  'мэдээлэл солих', 'мэдээлэл өөрчлөх', 'засах', 'буруу бичлээ',
  'буруу оруулсан', 'өөрчилье', 'өөрчлөх'
];

function isOrderEditRequest(text) {
  const lower = text.toLowerCase();
  return ORDER_EDIT_KEYWORDS.some(kw => lower.includes(kw));
}

async function notifyTelegramOrder(senderId, history, isCOD = false) {
  const messages = history.slice(-16);
  const existing = getOrder(senderId) || {};
  let parsed = { ...existing };

  // History-ийн user message-уудаас slot-уудыг nэгтгэн ялгах
  for (const m of messages.filter(x => x.role === 'user')) {
    parsed = parseOrderSlots(m.content, parsed);
  }

  const color = parsed.color || '—';
  const qty = parsed.qty ? `${parsed.qty} ширхэг` : '—';
  const address = parsed.address || '—';
  const entranceCode = parsed.entranceCode || 'байхгүй';
  const phone = parsed.phone || '—';

  // Үнэ тооцоолох (зөвхөн bundle бол)
  let total = '—';
  if (parsed.qty && parsed.color) {
    total = (parsed.qty * 199900).toLocaleString('en-US').replace(/,/g, "'") + '₮';
  }

  const orderId = parsed.orderId || generateOrderId();

  // Repeat customer check
  const placedCount = messages.filter(m =>
    m.role === 'assistant' && m.content.includes('Таны захиалгыг хүлээн авлаа')
  ).length;
  const repeatTag = placedCount >= 2 ? '🔁 <b>REPEAT CUSTOMER</b>\n\n' : '';

  // Time-based tag
  const hour = new Date().getHours();
  const afterHours = (hour < 8 || hour >= 22) ? '🌙 <i>Шөнийн цаг — өглөө хариулж болно</i>\n\n' : '';

  const paymentLine = isCOD
    ? '💵 Төлбөр: <b>ЖОЛООЧИД БЭЛНЭЭР (COD)</b>'
    : '🏦 Төлбөр: <b>Урьдчилж банкаар (баталгаажилт хүлээгдэж байна)</b>';

  const msg = `${repeatTag}${afterHours}🛍 <b>ШИНЭ ЗАХИАЛГА${isCOD ? ' — COD' : ''}!</b>
🆔 <code>${orderId}</code>

🎨 Өнгө: <b>${color}</b>
📦 Тоо: <b>${qty}</b>
💰 Дүн: <b>${total}</b>
📍 Хаяг: <b>${address}</b>
🔢 Орцны код: <b>${entranceCode}</b>
📞 Утас: <b>${phone}</b>
${paymentLine}

👤 Messenger ID: <code>${senderId}</code>
💬 Хариулах: https://m.me/${senderId}

<i>Унтраах: <code>/release ${senderId}</code></i>`;

  await sendTelegram(msg);

  // Order state-д хадгалах (30 мин follow-up window-д хэрэгтэй)
  setOrder(senderId, {
    ...parsed,
    orderId,
    total,
    placedAt: Date.now(),
    status: 'placed',
    isCOD
  });
}

// ── CANCELLATION NOTIFY (NEW v2.8.0) ──
async function notifyTelegramCancellation(senderId, reason = '—', stage = 'requested') {
  const order = getOrder(senderId) || {};
  const orderInfo = order.orderId
    ? `🆔 <code>${order.orderId}</code>\n🎨 ${order.color || '—'} × ${order.qty || '—'}\n📍 ${order.address || '—'}\n📞 ${order.phone || '—'}\n💰 ${order.total || '—'}\n\n`
    : '';
  const stageLabel = stage === 'requested' ? 'ЦУЦЛАХ ХҮСЭЛТ' : 'ЦУЦЛАГДЛАА';
  const emoji = stage === 'requested' ? '⚠️' : '❌';

  const msg = `${emoji} <b>${stageLabel}</b>

${orderInfo}📝 Шалтгаан: <b>${reason}</b>

👤 Messenger ID: <code>${senderId}</code>
💬 Хариулах: https://m.me/${senderId}

<i>Унтраах: <code>/release ${senderId}</code></i>`;
  await sendTelegram(msg);
}

// ── ATTACHMENT NOTIFY (NEW v2.8.0) ──
async function notifyTelegramAttachment(senderId, attType, attUrl = '') {
  const urlLine = attUrl ? `🔗 URL: ${attUrl}\n` : '';
  const msg = `📎 <b>ATTACHMENT — Гар хариулт шаардлагатай!</b>

📁 Төрөл: <b>${attType}</b>
${urlLine}
👤 Messenger ID: <code>${senderId}</code>
💬 Хариулах: https://m.me/${senderId}

<i>Bot хариулахаа зогссон.</i>
<i>Унтраах: <code>/release ${senderId}</code></i>`;
  await sendTelegram(msg);
}

// ── PROVINCE DELIVERY NOTIFY (NEW v2.8.0) ──
async function notifyTelegramProvince(senderId, text) {
  const msg = `🚛 <b>ОРОН НУТГИЙН ХҮРГЭЛТ!</b>

💬 Хэрэглэгчийн мессеж: <b>${text.slice(0, 200)}</b>

UB-аас гадуур учир тусгай зохицуулалт хэрэгтэй.

👤 Messenger ID: <code>${senderId}</code>
💬 Хариулах: https://m.me/${senderId}

<i>Унтраах: <code>/release ${senderId}</code></i>`;
  await sendTelegram(msg);
}

// ── WHOLESALE NOTIFY (NEW v2.8.0) ──
async function notifyTelegramWholesale(senderId, text) {
  const msg = `🏪 <b>WHOLESALE / BULK хүсэлт!</b>

💬 Хэрэглэгчийн мессеж: <b>${text.slice(0, 200)}</b>

4+ ширхэг буюу оптын үнэ хүсэлт байна.

👤 Messenger ID: <code>${senderId}</code>
💬 Хариулах: https://m.me/${senderId}

<i>Унтраах: <code>/release ${senderId}</code></i>`;
  await sendTelegram(msg);
}

async function notifyTelegramOrderEdit(senderId, userText) {
  const msg = `✏️ <b>ЗАХИАЛГА ЗАСАХ хүсэлт!</b>

👤 Messenger ID: <code>${senderId}</code>
💬 Засах мэдээлэл: <b>${userText}</b>

👉 Шалгах: https://m.me/${senderId}`;
  await sendTelegram(msg);
}

async function notifyTelegramHandoff(senderId, userText) {
  const msg = `⚠️ <b>HANDOFF — Гар хариулт шаардлагатай!</b>

👤 Messenger ID: <code>${senderId}</code>
💬 Асуулт: <b>${userText}</b>

👉 Хариулах: https://m.me/${senderId}

<i>Bot хариулахаа зогссон.</i>
<i>Унтраах: <code>/release ${senderId}</code></i>`;
  await sendTelegram(msg);
}

// =====================================================================
// SYSTEM PROMPT v2.8.4 — 2026.06.09
// v2.8.3 → v2.8.4 FIX:
// • Нөөц шүүлтүүрийн үнэ/хямдралыг Shopify-аас баталгаажуулж цэгцлэв.
//   Үндсэн үнэ 44'900₮ (compare-at). 2026.08.01 хүртэл хямдрал:
//   Single 29'900₮, Twin 54'900₮ (~~89'800₮~~), Family 79'900₮
//   (~~134'700₮~~). Family нэг бүр ~26'600₮ — хамгийн ашигтай.
//   8-р сарын 1-ний хугацааны яаралтай байдлыг (хэт шахалтгүй) нэмэв.
// • Багц доторх шүүлтүүрийн "44'900₮ үнэ цэнэтэй" → "44'900₮, Үнэгүй".
// • ШИНЭ дүрэм: шүршүүрийг ТУСД нь зардаггүй — зөвхөн Бэлгийн Багцаар.
//   "шүршүүрээ шүүлтүүртэй хамт" гэх асуултад эвтэйхэн ойлгуулна.
// ---------------------------------------------------------------------
// SYSTEM PROMPT v2.8.3 — 2026.06.09
// v2.8.2 → v2.8.3 FIX:
// • Нөөц шүүлтүүрийн нөөц шинэчлэгдсэн — Twin Pack (2ш, 54'900₮) ба
//   Family Pack (3ш, 79'900₮) дахин БЭЛЭН болсон. "Одоогоор бэлэн биш"
//   гэх бүх зөвлөмжийг (section 3, 4, 5) устгаж, гурван багцыг үнэтэй нь
//   зарж эхэлсэн. Single Pack 29'900₮ хэвээр.
// • Брэндийн хориотой "запас" үгийг bot-ийн ХЭЛДЭГ бүх текстээс "нөөц"
//   болгов (intent таних keyword дотор "запас/zapas" нь хэрэглэгчийн
//   бичдэг үг тул ХЭВЭЭР). "Solih davtamj" → "Солих давтамж".
// ---------------------------------------------------------------------
// SYSTEM PROMPT v2.8.2 — 2026.06.09
// v2.8.1 → v2.8.2 FIX:
// • Шүүлтүүрийн тоо тодорхой болгов — багцад ганцхан шүүлтүүр (шүршүүрт
//   суурилуулсан Active Carbon Filter), нөөц дагалддаггүй. "Шүршүүр +
//   Active Carbon Filter" гэж 2 тусдаа эд анги мэт жагсаахаа больж, нэг
//   бүхэл зүйл болгов. "2 шүүлтүүр ирнэ" гэх буруу ойлголтоос сэргийлнэ.
//   (System prompt section 3, 4 + JS infoMessage бүгдэд засагдсан.)
// ---------------------------------------------------------------------
// SYSTEM PROMPT v2.8.0 — 2026.05.27
// v2.7.1 → v2.8.0 CRITICAL SAFETY FIXES:
// • User-intent handoff trigger — хэрэглэгч "очиж үзмээр", "менежер" гэхэд бот REPLY бус USER message-аас trigger хийнэ
// • Cancellation flow — захиалга цуцлах хүсэлт illrew → empathetic reason ask → Telegram notify → handoff
// • Attachment full-handoff — зураг/бичлэг/voice/sticker ирэх үед AUTO handoff + URL Telegram-руу
// • Order State Machine — slot-filling, batched parsing (нэг мессеж олон slot fills)
// • Address detection upgrade — БЗД/БГД/СБД/ХУД/ЧД/СХД/НД district codes + apartment markers
// • Phone validation — Mongolian mobile prefix check (8/9/7), boundary regex
// • Province delivery handoff — Дархан/Эрдэнэт/etc → auto handoff (UB-аас гадуур)
// • Wholesale handoff — 4+ ширхэг буюу wholesale keyword → handoff
// • Direct info request bypass — "мэдээлэл авъя" type queries → бүх 3 өнгийн info шууд явуулах
// • Greeting anti-repeat — 5 минутад greeting давтахгүй
// • Twin/Family filter — "одоогоор бэлэн биш" гэх realistic alternative
// • Fraud-pattern phrase removed — "Бэлэн мөнгө бэлдэж байгаарай" → trust-building wording
// • Placeholder substitution — confirmation message JS-ээр assemble хийнэ (LLM-д найдахгүй)
// • Order followup window — order placed дараа 30 минут идэвхтэй
// • Repeat customer detect — Telegram-руу нэмэлт мэдээлэлтэй alert
// =====================================================================
const SYSTEM_PROMPT = `Та SkinBloom брэндийн AI туслах "Bloom" юм. Монгол хэлээр товч, найрсаг, дулаан хариулна. Нэг хариултанд 1–3 өгүүлбэрээс ихгүй.

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
1. ЭХНИЙ МЭНДЧИЛГЭЭ
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
Хэрэглэгч анх холбогдоход (сайн уу, hi, hello, мэнд, юу вэ, танилцуулаач, байна уу гэх мэт) ЗААВАЛ дараах текстийг яг ийм байдлаар явуул — өөрчлөхгүй:

"Сайн байна уу! ✨ Өнгө сонгоход туслах уу, эсвэл бэлгийн багцын талаар мэдэхийг хүсэж байна уу?"

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
2. ИНТЕНТ ТАНИХ — ХАМГИЙН ЧУХАЛ ДҮРЭМ
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
Хэрэглэгчийн АНХНЫ интентыг заавал тодорхойл. Хоёрдмол утгатай бол богино тодруулах асуулт тавь.

▸ ШҮРШҮҮР / БАГЦ авах гэж байгаа:
  Keyword: "шүршүүр", "bagts", "бэлгийн багц", "өнгө", "цагаан", "хар", "саарал", "pearl", "obsidian", "slate", "авъя", "захиалъя"
  → Бэлгийн Багц 199'900₮ flow руу

▸ ШҮҮЛТҮҮР / FILTER авах гэж байгаа:
  Keyword: "шүүлтүүр захиалъя", "шүүлтүүр авъя", "filter avya", "zapas", "запас", "нөөц шүүлтүүр", "карбон филтер захиалъя", "пилтер захиалъя", "пилтер", "pilter", "filtr"
  → ЗӨВХӨН нөөц filter flow (Single 29'900₮ / Twin 54'900₮ / Family 79'900₮)
  → BUNDLE (шүршүүр, бэлгийн багц) ХЭЗЭЭ Ч САНАЛ БОЛГОХГҮЙ
  → "шүршүүр авах уу, filter авах уу?" гэж АСУУХГҮЙ — хэрэглэгч filter л хүссэн

▸ POST-ИЙН CONFUSION — "ирээгүй", "ийм гэж бодоогүй", "буруу ойлгосон":
  Keyword: "запас ирнэ гэж бодсон", "шүүлтүүр ирэх ёстой", "буруу ойлгосон", "ийм байсангүй", "vasiin zapas", "iim bsiin", "өөр зүйл захиалсан"
  → Хэрэглэгч аль хэдийн захиалга өгсөн boловч confused байна
  → Эхлээд UYAН зөвшөөрөл: "Уучлаарай, ойлголтын зөрүү гарсан байна"
  → Дараа нь хүний оператор руу шилжүүлэх: [HANDOFF_NEEDED]
  → ШУУД шинэ захиалга авч эхлэхгүй — context-ийг ойлгох

▸ МЭДЭЭЛЭЛ / ҮНЭ хайж байгаа:
  Keyword: "үнэ", "хэд", "хэдэн төгрөг", "price", "юу вэ", "ямар юм бэ"
  → Богино pricing hook (доор заасан), дараа "дэлгэрэнгүй мэдэх үү?" гэж асуу

▸ UGC / КОНТЕНТ / КОЛЛАБ:
  Keyword: "ugc", "контент хийх", "коллаб", "collab", "promote", "пиар", "хамтарч", "story дээр тавьсан"
  → Handoff handler

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
3. БҮТЭЭГДЭХҮҮН — ҮНЭН МЭДЭЭЛЭЛ (skinbloom.store)
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

▸ "SkinBloom Бэлгийн Багц" — 199'900₮
  • Бүх 3 өнгө ҮНЭ БА БҮРЭЛДЭХҮҮН ИЖИЛ — "Pearl White 3-в-1" гэж хэзээ ч хэлэхгүй
  • Дотор нь: Active Carbon Filter урьдчилан суурилуулсан шүршүүр + Brush (24'500₮) + Donut Sponge (24'500₮) — бүгд үнэгүй
  • ⚠️ ШҮҮЛТҮҮРИЙН ТОО: Багцад ганцхан шүүлтүүр багтана — шүршүүрт суурилуулсан Active Carbon Filter (44'900₮, багцад Үнэгүй). Нэмэлт буюу нөөц шүүлтүүр дагалддаггүй. "2 шүүлтүүр ирнэ", "нэг суурилсан дээр нэг нөөц дагалдана" гэж ХЭЗЭЭ Ч хэлэхгүй. Нөөц шүүлтүүр хэрэгтэй бол тусдаа 29'900₮.
  • Анх 269'000₮ → одоо 199'900₮ (69'100₮ хэмнэлт)
  • Хүргэлт үнэгүй
  • Шүүрхай хүргэлт: +20'000₮ (UBCAB EXPRESS, тухайн өдөртөө)
  • 3 өнгө:
    ⬛ Obsidian Black — мөнгөн цагираг, тансаг luxury
    🤍 Pearl White — цэвэр, гэрэлтсэн, арьс үсэнд анхаардаг хүмүүсийн сонголт
    🩶 Slate Gray — universal, дотор талд crimson (улаан) цагираг

▸ "SkinBloom Карбон Филтер" — нөөц шүүлтүүр
  • Үндсэн үнэ: 1 ширхэг 44'900₮. ОДОО 2026.08.01 хүртэл бүх багцад хямдралтай:
  • Single Pack 1 ширхэг — 29'900₮ (~~44'900₮~~) · 15'000₮ хэмнэнэ
  • Twin Pack 2 ширхэг — 54'900₮ (~~89'800₮~~) · 34'900₮ хэмнэнэ · нэг бүр 27'450₮
  • Family Pack 3 ширхэг — 79'900₮ (~~134'700₮~~) · 54'800₮ хэмнэнэ · нэг бүр 26'633₮ (ХАМГИЙН АШИГТАЙ)
  • ⏰ ХУГАЦАА: хямдрал 2026.08.01 хүртэл үргэлжилнэ. Дараа нь үндсэн үнэ 44'900₮ болж нэмэгдэнэ — "хямдралтай байгаа дээр урьдчилж нөөцлөх" сэдлийг эвтэйхэн төрүүл (хэт шахалт биш).
  • Солих давтамж: 4 хүнтэй өрхөд 3 сар тутамд, 2 хүнтэй өрхөд 6 сар тутамд нэг удаа — урт хугацаанд хэрэглэх тул Family Pack-аар урьдчилж нөөцлөх нь хамгийн хэмнэлттэй.

▸ ЧУХАЛ — үнэ бичих форматын дүрэм:
  ✅ "199'900₮" (apostrophe-той)
  ❌ "199,900₮" биш
  ❌ "199900₮" биш

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
4. ХАРИУЛТЫН ЗАГВАРУУД
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

▸ ШҮРШҮҮРИЙН ӨНГӨ СОНГОХ (интент A):
"Бэлгийн Багц — 199'900₮ 🎁 Бүх 3 өнгөнд ижил үнэ, ижил бүрэлдэхүүн:

⬛ Obsidian Black — мөнгөн цагираг, тансаг
🤍 Pearl White — цэвэр, гэрэлтсэн мэдрэмж
🩶 Slate Gray — дотор талд crimson цагираг

Та аль өнгийг сонгох вэ?"

▸ ЗӨВХӨН НӨӨЦ FILTER ЗАХИАЛАХ (интент B):
"Нөөц Active Carbon Filter — 8-р сарын 1 хүртэл хямдралтай 🌸 (үндсэн үнэ 44'900₮)

🔹 Single Pack 1 ширхэг — 29'900₮ (~~44'900₮~~)
🔹 Twin Pack 2 ширхэг — 54'900₮ (~~89'800₮~~)
🔹 Family Pack 3 ширхэг — 79'900₮ (~~134'700₮~~) — хамгийн ашигтай

Аль багцыг сонгох уу?"

  → Хэрэглэгч "хамгийн ашигтай нь аль вэ?" гэвэл:
  "Family Pack хамгийн хэмнэлттэй — нэг шүүлтүүр нь ~26'600₮-д ирнэ 🌸 Хямдрал 8-р сарын 1 хүртэл, дараа нь үндсэн үнэ 44'900₮ болно."

  → Bundle (шүршүүр) санал болгохгүй — хэрэглэгч filter л хүссэн

▸ ҮНЭ АСУУВАЛ — БОГИНО HOOK (интент C):
"🎁 Бэлгийн Багц — 199'900₮ (~~269'000₮~~)
69'100₮ хэмнэнэ 🔥 Хүргэлт үнэгүй

Дэлгэрэнгүй мэдэх үү, эсвэл өнгө сонгох уу?"

  → Хэрэглэгч "дэлгэрэнгүй" / "юу дагалдах вэ" гэвэл:
  "Багцад орсон зүйлс:
✅ SkinBloom шүршүүр (Active Carbon Filter суурилуулсан — 44'900₮, Үнэгүй)
🪥 Brush (24'500₮) — үнэгүй
🧽 Donut Sponge (24'500₮) — үнэгүй
🚚 Хүргэлт — үнэгүй

Нийт хэмнэлт: 69'100₮ 🔥"

▸ FILTER ТООГ АСУУВАЛ (багц авч байгаа явцад):
"Багцад шүршүүрт суурилуулсан ганцхан шүүлтүүр багтана 🌸 Нэмэлт шүүлтүүр дагалддаггүй. 3–6 сард нэг удаа солих ба нөөц шүүлтүүрийг тусад нь 29'900₮-өөр авна."

▸ ШҮРШҮҮРИЙГ ТУСД НЬ / ШҮҮЛТҮҮРТЭЙ ХАМТ АВАХ АСУУВАЛ:
Хэрэглэгч "зөвхөн шүршүүр", "шүршүүрээ дангаар нь", "шүршүүр + нэмэлт шүүлтүүр хамт", "шүршүүрээ шүүлтүүртэй нь авъя" гэх мэт асуувал — шүршүүрийг ТУСД нь зардаггүй, ЗӨВХӨН Бэлгийн Багцаар ирдгийг эвтэйхэн, эерэг өнгөөр ойлгуул (татгалзсан мэт сонсогдуулахгүй):
"SkinBloom шүршүүр зөвхөн Бэлгийн Багцаар (199'900₮) ирдэг 🌸 Багцад Active Carbon Filter аль хэдийн суурилуулсан, дээр нь Brush, Donut Sponge бүгд багтсан — тусад нь авснаас хямд. Хожим нөөц шүүлтүүр хэрэгтэй болбол түүнийг тусад нь авч болно."

▸ НӨӨЦ FILTER ҮНЭ АСУУВАЛ (тусдаа):
"Нөөц filter (8-р сарын 1 хүртэл хямдралтай, үндсэн үнэ 44'900₮):
🔹 Single 29'900₮ · 🔹 Twin 54'900₮ · 🔹 Family 79'900₮ 🌸
Family хамгийн ашигтай — нэг бүр ~26'600₮."

▸ STOREPAY / ХУВААГДСАН ТӨЛБӨР АСУУВАЛ:
"Манайх одоогоор Storepay-ийг дэмжихгүй байна 🌸 Гэхдээ 2 сонголт бий:

1️⃣ Урьдчилж банкаар шилжүүлэх (Хаан банк)
2️⃣ Барааг авсны дараа жолоочид бэлнээр төлөх

Аль нь танд тохирох вэ?"

▸ ҮНЭ CONFUSION ("599?", "199 биш үү?" гэх мэт):
"199'900₮ — нэг зуун ерэн есөн мянган есөн зуу 🌸 Хэмнэх дүн 69'100₮."

▸ UGC / STORY MENTION / COLLAB:
"Манай бүтээгдэхүүнийг хуваалцсанд их баярлалаа! 🌸 Хэрэв контент хийх сонирхолтой бол манай баг тантай холбогдох болно. [HANDOFF_NEEDED]"

▸ ШҮРШҮҮРИЙН МАТЕРИАЛ / ЧАНАР АСУУВАЛ:
"SkinBloom шүршүүр Европын CE стандартаар үйлдвэрлэгдсэн 🏆

🔩 Бие: матлаг ABS хуванцар — бат бөх
💧 Нүүр хавтан: тунгалаг ганжуурласан хавтан — жигд урсгал
💍 Цагираг: зэврэлтэнд тэсвэртэй ган
✋ Бариул: нойтон гарт гулсдаггүй хонхорхой гадаргуу

CE дугаар: HX240303050484"

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
5. ЗАХИАЛГЫН FLOW
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

▸ FLOW A — Бэлгийн Багц (199'900₮):
Нэг нэгээр асуу:
1. Өнгө (Pearl White / Slate Gray / Obsidian Black)
2. Тоо ширхэг
3. Бүрэн хаяг (дүүрэг, хороо, хотхон/байр/тоот/давхар)
4. Орцны код — "байхгүй бол алгасъя" гэж хэл
5. Утасны дугаар (8 оронтой байх ёстой)
6. Төлбөрийн арга: "Төлбөрийг яаж хийх вэ? 1️⃣ Урьдчилж банкаар 2️⃣ Авсны дараа жолоочид бэлнээр"

▸ FLOW B — Зөвхөн Filter (29'900₮):
Нэг нэгээр асуу:
1. Хэдэн ширхэг (Single 29'900₮ / Twin 54'900₮ / Family 79'900₮)
2. Бүрэн хаяг
3. Орцны код
4. Утасны дугаар
5. Төлбөрийн арга

▸ MISSING FIELD ШАЛГАЛТ:
Дутуу талбар байвал ЗӨВХӨН ТЭР НЭГИЙГ л асуу — бүх 6-г дахин давтахгүй.
Жишээ: утас дутуу бол "Утасны дугаараа оруулна уу 🌸"
Орцны код дутуу бол "Орцны код байгаа уу? Байхгүй бол алгасъя 🌸"
Утас 8 оронгүй бол "8 оронтой дугаар оруулна уу 🌸"

▸ БҮГД БҮРЭН БОЛМОГЦ — ЗАХИАЛГА БАТАЛГААЖУУЛАХ:

⚠️ ЧУХАЛ: Та зөвхөн "Таны захиалгыг хүлээн авлаа ✅" гэж тэмдэглэгээтэй мессеж явуул — бодит үнэ/хаяг/утас substitution-ийг систем хийнэ. Placeholder [Өнгө], [Хаяг], [Утас] хэлбэрээр БИЧИХГҮЙ — энэ нь spam харагдана.

ЯГ ИЙМ ФОРМАТААР хариулна:
"Таны захиалгыг хүлээн авлаа ✅"

Төлбөрийн арга тодорхой бол [BANK_ORDER] эсвэл [COD_ORDER] tag-аа нэмж бич — JS код үлдсэн мэдээллийг рендер хийнэ:
• Урьдчилж банкаар: "Таны захиалгыг хүлээн авлаа ✅ [BANK_ORDER]"
• Жолоочид бэлнээр: "Таны захиалгыг хүлээн авлаа ✅ [COD_ORDER]"

▸ ЗАХИАЛГА БАТАЛГААЖСАНЫ ДАРАА ЗАСАХ:
"Мэдээллийг шинэчилье 🌸 [Засах зүйл]-г өөрчиллөө. Бусад мэдээлэл зөв үү?"
Засвар баталгаажсаны дараа: "Захиалгын мэдээлэл шинэчлэгдлээ ✅ [ORDER_EDIT]"

▸ ЗАХИАЛГА ЦУЦЛАХ ХҮСЭЛТ — v2.8.1 шинэчилсэн:
🚫 ХЭЗЭЭ Ч cancellation reply бичихгүй. JS код өөрийн логикоор cancellation flow-ийг handle хийнэ.
Хэрэглэгч "awsny daraa" / "авсны дараа" / "joloochid belneer" гэх payment мэдэгдэл өгөх нь ЦУЦЛАХ БИШ — COD сонголт. Энэ үед [COD_ORDER] tag ашигла.
Зөвхөн хэрэглэгч ИЛТ "цуцлая", "болиё", "хэрэггүй болсон" гэвэл [HANDOFF_NEEDED] tag нэм — JS код handoff хийж дараагийн алхамыг удирдана.

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
6. ТЕХНИКИЙН МЭДЭЭЛЭЛ
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
• Гарал үүсэл: Европын CE стандартаар Хонгконгт үйлдвэрлэгдэнэ
• CE сертификат: HX240303050484
• Filter давхарга (доороос дээш): PP fiber (цагаан) → Carbon (хар) → KDF (металл)
• Нэг л горим — өндөр даралт, spa мэдрэмж, 40% усны хэмнэлт
• Rain/massage/mist mode БАЙХГҮЙ
• Ceramic БИШ — "ceramic" гэж хэзээ ч хэлэхгүй
• Усны даралт: 0.1–0.35 MPa
• Ажлын температур: 0–70°C
• Суурилуулалт: стандарт 1/2 инч ороомгод таарна, 1 минутад

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
7. HANDOFF — ОПЕРАТОР РУУ ШИЛЖҮҮЛЭХ
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
ЭДГЭЭР ТОХИОЛДОЛД ШУУД [HANDOFF_NEEDED]:
• Гомдол / буцаалт / refund
• Wholesale (4+ ширхэг) — JS код шууд handle хийнэ
• Нарийн техникийн асуулт хариулж чадахгүй бол
• UGC / influencer / collab
• "Хүнтэй ярих", "оператор", "менежер" гэх мэт
• ОЧИЖ ҮЗЭХ хүсэлт — "очиж", "очмоор", "нүдээр харах", "дэлгүүр очих", "офис очих", "байршил", "газар дээр нь" → handoff
• ОРОН НУТГИЙН хүргэлт — Дархан, Эрдэнэт, Чойбалсан, гэх аймгийн хот → JS код шууд handle хийнэ
• ҮНИЙН МАНИПУЛЯЦИ — "хямдрал нэмэх", "discount нэм", "арай хямд" → JS код handle хийнэ

Хариулт: "Манай менежер тантай удахгүй холбогдох болно 🌸 [HANDOFF_NEEDED]"

ОЧИЖ ҮЗЭХ хүсэлтэд хариулт: "Бид одоогоор зөвхөн онлайн зарж байна 🌸 Гэвч таны асуултанд манай менежер дэлгэрэнгүй хариулж, хэрэгтэй мэдээллийг өгөх болно. [HANDOFF_NEEDED]"

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
8. ЗУРАГ/БИЧЛЭГ/STICKER ИРҮҮЛСЭН ҮЕД
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
ЗУРАГ, БИЧЛЭГ, VOICE, ФАЙЛ ИРЭХ ҮЕД:
ШУУД handoff болгоно. Хариулт ингэж: "Зураг/бичлэгийг хүлээн авлаа 🌸 Манай менежер таны мэдээллийг нягталж, шууд хариулах болно. [HANDOFF_NEEDED]"

ХЭРЭГЛЭГЧЭЭС ӨНГӨ ХЭЛЭХ ЗААЛГА БИТГИЙ ӨГ — хэрэглэгчид ачаалал бий болгоно.

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
9. БАТАЛГАА & ХОЛБОО БАРИХ
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
• Үйлдвэрийн алдаатай бол 30 хоногийн дотор буцааж солино (зөвхөн үйлдвэрийн алдаа)
• Дэлгүүр: skinbloom.store
• Утас: 95999989
• УБ хүргэлт: 24–48 цаг, шүүрхай: +20'000₮

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
10. ХЭЛНИЙ ХАТУУ ДҮРЭМ
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
❌ "Pearl White 3-в-1 багц" → ✅ "Бэлгийн Багц (Pearl White)"
❌ "ceramic" → ✅ хэрэглэхгүй
❌ "Rose Red" → ✅ "Slate Gray (дотор crimson цагираг)"
❌ "шүршүүр хийх" → ✅ "усанд орох"
❌ "199,900₮" → ✅ "199'900₮"
❌ 5+ мөрийн хариулт (хэрэв асуугаагүй бол) → ✅ богино, дараа нь дэлгэрнэ
❌ Хэрэглэгчийн алдаатай үгийг засаж сургах → ✅ хэзээ ч засахгүй

ЧУХАЛ: [HANDOFF_NEEDED], [ORDER_EDIT], [COD_ORDER] тагуудыг хэрэглэгчид харуулахгүй — код дотор strip хийнэ.`;

const COMMENT_DM_PROMPT = `Та SkinBloom брэндийн AI туслах юм. Facebook/Instagram-д comment бичсэн хэрэглэгчид DM-ээр хариулна.

ДҮРЭМ:
• 1-2 өгүүлбэр, товч, найрсаг
• Нэрээр нь хандана (жишээ: "Сайн байна уу Бат? 🌸")
• Message Request шалгахыг хүс: "Message Request хэсэгээ шалгаарай 🌸"
• Шүүлтүүр асуувал: "Тийм, нөөц Active Carbon Filter байгаа! 29'900₮. Дэлгэрэнгүй мэдээлэл явуулсан 🌸"
• Захиалах асуувал: "skinbloom.store-с захиалж болно 🌸"`;

const conversations = new Map();
const MAX_HISTORY = 16;
const CONV_TTL = 24 * 60 * 60 * 1000;

function getHistory(senderId) {
  const conv = conversations.get(senderId);
  if (!conv) return [];
  if (Date.now() - conv.lastActivity > CONV_TTL) {
    conversations.delete(senderId);
    return [];
  }
  conv.lastActivity = Date.now();
  return conv.messages;
}

function addToHistory(senderId, role, content) {
  if (!conversations.has(senderId)) {
    conversations.set(senderId, { messages: [], lastActivity: Date.now() });
  }
  const conv = conversations.get(senderId);
  conv.messages.push({ role, content });
  conv.lastActivity = Date.now();
  if (conv.messages.length > MAX_HISTORY) {
    conv.messages.splice(0, conv.messages.length - MAX_HISTORY);
  }
}

async function askGPT_DM(senderId, userText) {
  addToHistory(senderId, 'user', userText);
  const messages = [
    { role: 'system', content: SYSTEM_PROMPT },
    ...getHistory(senderId).slice(-MAX_HISTORY)
  ];
  const res = await axios.post('https://api.openai.com/v1/chat/completions', {
    model: 'gpt-4o-mini', messages, temperature: 0.5, max_tokens: 500
  }, { headers: { Authorization: `Bearer ${OPENAI_KEY}` } });
  const reply = res.data.choices[0].message.content.trim();
  addToHistory(senderId, 'assistant', reply);
  return reply;
}

async function askGPT_CommentDM(commenterName, commentText) {
  const prompt = `Comment хийсэн хэрэглэгч: ${commenterName || 'хэрэглэгч'}\nComment: ${commentText}\n\nЭнэ хэрэглэгчид DM-ээр товч хариул. Message Request шалгахыг хүс.`;
  const res = await axios.post('https://api.openai.com/v1/chat/completions', {
    model: 'gpt-4o-mini',
    messages: [
      { role: 'system', content: COMMENT_DM_PROMPT },
      { role: 'user', content: prompt }
    ],
    temperature: 0.6, max_tokens: 120
  }, { headers: { Authorization: `Bearer ${OPENAI_KEY}` } });
  return res.data.choices[0].message.content.trim();
}

function verifySignature(req) {
  if (!APP_SECRET) return true;
  const sig = req.headers['x-hub-signature-256'];
  if (!sig) return true;
  const expected = 'sha256=' + crypto.createHmac('sha256', APP_SECRET)
    .update(req.rawBody).digest('hex');
  try { return crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expected)); }
  catch { return true; }
}

async function sendDM(recipientId, text) {
  try {
    await axios.post('https://graph.facebook.com/v19.0/me/messages', {
      recipient: { id: recipientId }, message: { text }
    }, { params: { access_token: PAGE_TOKEN } });
    console.log(`✓ DM sent → ${recipientId}`);
  } catch (e) {
    console.error(`✗ DM error → ${recipientId}:`, e.response?.data?.error?.message || e.message);
  }
}

async function sendDMWithHumanAgent(recipientId, text) {
  try {
    await axios.post('https://graph.facebook.com/v19.0/me/messages', {
      recipient: { id: recipientId },
      message: { text },
      messaging_type: 'MESSAGE_TAG',
      tag: 'HUMAN_AGENT'
    }, { params: { access_token: PAGE_TOKEN } });
    console.log(`✓ Human Agent DM sent → ${recipientId}`);
  } catch (e) {
    console.error(`✗ Human Agent DM error:`, e.response?.data?.error?.message || e.message);
    await sendDM(recipientId, text);
  }
}

async function sendPrivateReply(commentId, text) {
  await axios.post(
    `https://graph.facebook.com/v19.0/${commentId}/private_replies`,
    { message: text },
    { params: { access_token: PAGE_TOKEN } }
  );
}

async function sendDMToCommenter(commenterId, commenterName, commentText, commentId) {
  if (!commentId) {
    console.log(`⚠️ No commentId — cannot send private reply to ${commenterName}`);
    return;
  }
  if (humanHandoff.has(commenterId)) {
    console.log(`⏭ Handoff — skip DM to ${commenterName}`);
    return;
  }
  try {
    const dmText = await askGPT_CommentDM(commenterName, commentText);
    const cleanText = dmText.replace('[HANDOFF_NEEDED]', '').trim();
    await sendPrivateReply(commentId, cleanText);
    console.log(`✓ Private reply DM sent → ${commenterName} (comment: ${commentId})`);
  } catch (e) {
    console.error(`✗ Private reply error → ${commenterName}:`, e.response?.data?.error?.message || e.message);
  }
}

const processedEvents = new Set();
function isDuplicate(id) {
  if (processedEvents.has(id)) return true;
  processedEvents.add(id);
  if (processedEvents.size > 2000) {
    const first = processedEvents.values().next().value;
    processedEvents.delete(first);
  }
  return false;
}

app.get('/webhook', (req, res) => {
  const { 'hub.mode': mode, 'hub.verify_token': token, 'hub.challenge': challenge } = req.query;
  if (mode === 'subscribe' && token === VERIFY_TOKEN) {
    console.log('✓ Webhook verified');
    return res.status(200).send(challenge);
  }
  res.sendStatus(403);
});

app.post('/webhook', async (req, res) => {
  if (!verifySignature(req)) return res.sendStatus(401);
  res.sendStatus(200);

  const body = req.body;
  if (!['page', 'instagram'].includes(body.object)) return;

  for (const entry of (body.entry || [])) {
    const pageId = entry.id;

    for (const event of (entry.messaging || [])) {
      // ── ADMIN/PAGE TAKEOVER DETECT (echo event) ──
      // Page-аас хэрэглэгч рүү мессеж явахад echo гэж тэмдэглэгдэнэ.
      // Хэрэв тэр мессеж "manager", "менежер" гэх admin keyword агуулбал
      // тухайн хэрэглэгчийг автомат handoff болгоно.
      if (event.message?.is_echo) {
        const echoText = event.message?.text || '';
        const recipientId = event.recipient?.id;
        // Echo дотор recipient нь target хэрэглэгч, sender нь page
        if (recipientId && recipientId !== pageId && isAdminTakeover(echoText)) {
          if (!humanHandoff.has(recipientId)) {
            addHandoff(recipientId);
            console.log(`🤝 Admin takeover [${recipientId}] — page-аас "${echoText.slice(0, 40)}..."`);
            await notifyTelegramAdminTakeover(recipientId, echoText);
          }
        }
        continue;
      }
      if (event.sender?.id === pageId) continue;
      const mid = event.message?.mid;
      if (mid && isDuplicate(mid)) continue;
      const senderId = event.sender?.id;
      const text = event.message?.text;
      const attachments = event.message?.attachments;
      if (!senderId) continue;

      if (humanHandoff.has(senderId)) {
        console.log(`⏭ Handoff mode — skipping [${senderId}]`);
        continue;
      }

      // ═══════════════════════════════════════════════════════
      // ATTACHMENT HANDLING (v2.8.0) — image/video/voice/sticker/file
      // → ШУУД handoff + Telegram alert (vision биш, manual нягтлал)
      // ═══════════════════════════════════════════════════════
      if (!text && attachments?.length > 0) {
        const attType = attachments[0]?.type;
        const attUrl = attachments[0]?.payload?.url || '';

        // Дараалсан attachment dedupe
        if (isDuplicateAttachment(senderId)) {
          console.log(`⏭ Duplicate attachment — skipping [${senderId}]`);
          continue;
        }

        // Sticker — зөвхөн emoji-like reaction юм, хариу хэрэггүй
        if (attType === 'sticker') {
          console.log(`👍 Sticker [${senderId}] — quiet acknowledge`);
          continue;
        }

        // Image / video / audio / file → handoff
        if (['image', 'video', 'audio', 'file'].includes(attType)) {
          console.log(`📎 Attachment [${attType}] [${senderId}] → handoff`);
          addHandoff(senderId);
          try {
            await sendDMWithHumanAgent(senderId, 'Зураг/бичлэгийг хүлээн авлаа 🌸 Манай менежер таны мэдээллийг нягталж, шууд хариулах болно.');
          } catch (e) {
            console.error('Attachment DM send error:', e.message);
          }
          await notifyTelegramAttachment(senderId, attType, attUrl);
        }
        continue;
      }

      if (!text) continue;

      // ═══════════════════════════════════════════════════════
      // PRIORITY-ORDERED TRIGGER CHECKS (v2.8.0)
      // Дараах дарааллаар шалгана — өндөр приоритеттэй эхэлж
      // ═══════════════════════════════════════════════════════

      // 1) COMPLAINT — гомдол ноцтой → шууд handoff + 3 draft
      if (isComplaint(text)) {
        console.log(`🚨 Complaint [${senderId}]: ${text.slice(0, 60)}`);
        addHandoff(senderId);
        await sendDMWithHumanAgent(senderId, '🌸 Таны мессежийг хүлээн авлаа. Манай менежер хариуцлагатайгаар тантай удахгүй холбогдох болно.');
        addToHistory(senderId, 'user', text);
        await notifyTelegramComplaint(senderId, text, getHistory(senderId));
        continue;
      }

      // 2) CANCELLATION RECOVERY — Cancellation flow дотор хэрэглэгч "цуцлах гэж хэлээгүй"
      // гэж денайл хийвэл flow-аас гарч, захиалгыг сэргээж, цааш үргэлжлүүлэх.
      // v2.8.1 шинэ: bot ёжтой буруу cancellation-р алддагүй болох
      const existingOrder = getOrder(senderId);
      if (existingOrder && existingOrder.cancelStage === 'reason_asked' && isCancellationDenial(text)) {
        console.log(`🔄 Cancellation denial — recovering [${senderId}]: ${text.slice(0, 60)}`);
        addToHistory(senderId, 'user', text);
        // Cancel state-ийг арилгана, захиалгыг сэргээнэ
        delete existingOrder.cancelStage;
        existingOrder.status = 'placed';
        setOrder(senderId, existingOrder);
        await sendDM(senderId, 'Уучлаарай, буруу ойлголоо 🌸 Захиалга тань үргэлжилж байна. Танд өөр асуух зүйл байна уу?');
        await sendTelegram(`🔄 <b>FALSE CANCELLATION — RECOVERED</b>\n\n👤 ID: <code>${senderId}</code>\n💬 Денайл: ${text.slice(0, 150)}\n\n<i>Bot захиалгыг сэргээлээ.</i>`);
        continue;
      }

      // 3) CANCELLATION — захиалга цуцлах
      if (isCancellationRequest(text)) {
        console.log(`❌ Cancellation request [${senderId}]: ${text.slice(0, 60)}`);
        addToHistory(senderId, 'user', text);
        // Захиалга байгаа эсэхийг шалгах
        if (existingOrder && existingOrder.status === 'placed') {
          if (existingOrder.cancelStage === 'reason_asked') {
            // Хэрэглэгч шалтгаан өгсөн (эсвэл татгалзсан)
            const negativeReplies = /за яахав|битгий асуу|болсон|болсон шдээ|hereggu|kheregui|asuukhgui/i;
            const isNegative = negativeReplies.test(text);
            await sendDM(senderId, isNegative
              ? 'Ойлголоо 🌸 Захиалга цуцлагдлаа. Хэзээ ч буцаж ирэхээ мартсаагаарай.'
              : 'Ойлголоо, баярлалаа 🌸 Захиалга цуцлагдлаа. Дараа дахин туршиж үзвэл бид баяртай байх болно.');
            await notifyTelegramCancellation(senderId, isNegative ? '(шалтгаан хэлэхээс татгалзав)' : text, 'cancelled');
            existingOrder.status = 'cancelled';
            setOrder(senderId, existingOrder);
            // Bot continue хариулахгүй
            addHandoff(senderId);
            continue;
          } else {
            // Шалтгаан асуух
            await sendDM(senderId, 'Уучлаарай, захиалгыг тань цуцлахаас өмнө бид яагаад болсныг ойлгох сонирхолтой байна 🌸 Танд яагаад тохирохгүй болсон бэ? (хэт удаан / үнэ / өөр сонголт сонирхож байгаа / гэх мэт)');
            existingOrder.cancelStage = 'reason_asked';
            setOrder(senderId, existingOrder);
            await notifyTelegramCancellation(senderId, text, 'requested');
            continue;
          }
        } else {
          // Order байхгүй ч цуцлах хүсэлт ирэх → handoff
          addHandoff(senderId);
          await sendDMWithHumanAgent(senderId, '🌸 Таны хүсэлтийг хүлээн авлаа. Манай менежер удахгүй холбогдох болно.');
          await notifyTelegramCancellation(senderId, text, 'requested');
          continue;
        }
      }

      // 3) USER ASKS FOR HUMAN — менежер/оператор/очиж үзэх → handoff
      if (isUserHandoffRequest(text)) {
        console.log(`🤝 User handoff request [${senderId}]: ${text.slice(0, 60)}`);
        addHandoff(senderId);
        addToHistory(senderId, 'user', text);
        await sendDMWithHumanAgent(senderId, 'Бид одоогоор зөвхөн онлайн зарж байна 🌸 Гэвч таны асуултанд манай менежер дэлгэрэнгүй хариулж, хэрэгтэй мэдээллийг өгөх болно.');
        await notifyTelegramHandoff(senderId, text);
        continue;
      }

      // 4) PROVINCE DELIVERY — орон нутгийн хүргэлт → handoff
      if (isProvinceDelivery(text)) {
        console.log(`🚛 Province delivery [${senderId}]: ${text.slice(0, 60)}`);
        addHandoff(senderId);
        addToHistory(senderId, 'user', text);
        await sendDMWithHumanAgent(senderId, '🌸 Орон нутгийн хүргэлтийн талаар манай менежер тантай холбогдож, хүргэлтийн тариф болон хугацааг тодорхой хэлэх болно.');
        await notifyTelegramProvince(senderId, text);
        continue;
      }

      // 5) WHOLESALE — оптын/4+ ширхэг → handoff
      if (isWholesaleRequest(text)) {
        console.log(`🏪 Wholesale [${senderId}]: ${text.slice(0, 60)}`);
        addHandoff(senderId);
        addToHistory(senderId, 'user', text);
        await sendDMWithHumanAgent(senderId, '🌸 Олон ширхэгээр авах хүсэлтэд нь баярлалаа! Оптын үнэ болон нөхцлийн талаар манай менежер тантай удахгүй холбогдох болно.');
        await notifyTelegramWholesale(senderId, text);
        continue;
      }

      // 6) PRICE MANIPULATION — үнэ буулгах хүсэлт → handoff
      if (isPriceManipulation(text)) {
        console.log(`💸 Price manipulation [${senderId}]: ${text.slice(0, 60)}`);
        addHandoff(senderId);
        addToHistory(senderId, 'user', text);
        await sendDMWithHumanAgent(senderId, 'Манай үнэ нь одоогоор зарлагдсан хямдралтай үнэ юм 🌸 Тусгай нөхцөл, бөөний үнийн талаар манай менежер тантай холбогдоно.');
        await notifyTelegramHandoff(senderId, `[Price manipulation] ${text}`);
        continue;
      }

      // 7) UGC / INFLUENCER (one-time notify, бот үргэлжлүүлэн ажиллана)
      if (isUGCOrInfluencer(text)) {
        console.log(`📸 UGC/Influencer detected [${senderId}]`);
        await notifyTelegramUGC(senderId, text);
      }

      // ═══════════════════════════════════════════════════════
      // GREETING ANTI-REPEAT (v2.8.0)
      // ═══════════════════════════════════════════════════════
      const greetingPattern = /^(сайн уу|sain uu|hi|hello|мэнд|байна уу|baina uu|hey|өө байна уу)/i;
      const isGreeting = greetingPattern.test(text.trim());

      // ═══════════════════════════════════════════════════════
      // DIRECT INFO REQUEST (v2.8.0)
      // "мэдээлэл авъя", "шүршүүрийн тухай" гэх direct query →
      // greeting bypass, шууд бүх 3 өнгө + bundle
      // ═══════════════════════════════════════════════════════
      if (isDirectInfoRequest(text)) {
        console.log(`ℹ️ Direct info request [${senderId}]`);
        const infoMessage = `SkinBloom Бэлгийн Багц — 199'900₮ 🎁 (~~269'000₮~~)

Бүх 3 өнгөнд ижил үнэ, ижил бүрэлдэхүүн:
⬛ Obsidian Black — мөнгөн цагираг, тансаг
🤍 Pearl White — цэвэр, гэрэлтсэн
🩶 Slate Gray — дотор crimson цагираг

Багцад орсон зүйлс:
✅ SkinBloom шүршүүр (Active Carbon Filter суурилуулсан — 44'900₮, Үнэгүй)
🪥 Brush (24'500₮) — үнэгүй
🧽 Donut Sponge (24'500₮) — үнэгүй
🚚 Хүргэлт — үнэгүй

Хэмнэлт: 69'100₮ 🔥

Аль өнгийг сонгох уу?`;
        await sendDM(senderId, infoMessage);
        addToHistory(senderId, 'user', text);
        addToHistory(senderId, 'assistant', infoMessage);
        markGreeting(senderId);
        continue;
      }

      // ═══════════════════════════════════════════════════════
      // BATCH SLOT FILLING (v2.8.0)
      // Хэрэглэгч нэг мессежэнд олон slot өгсөн бол ялгах
      // ═══════════════════════════════════════════════════════
      const currentOrder = getOrder(senderId) || { status: 'collecting' };
      if (currentOrder.status === 'collecting' || !currentOrder.status) {
        const parsed = parseOrderSlots(text, currentOrder);
        if (parsed.color || parsed.address || parsed.phone || parsed.payment) {
          setOrder(senderId, { ...parsed, status: 'collecting' });
          console.log(`📝 Slot fill [${senderId}]: ${JSON.stringify({
            color: parsed.color, qty: parsed.qty, address: parsed.address?.slice(0, 30),
            phone: parsed.phone, payment: parsed.payment, code: parsed.entranceCode
          })}`);
        }
      }

      console.log(`📩 DM [${senderId}]: ${text.slice(0, 60)}`);
      try {
        // Greeting давталтаас сэргийлэх
        if (isGreeting && hasRecentGreeting(senderId)) {
          // Greeting дахин явуулахгүй — generic intent ask
          await sendDM(senderId, 'Тантай ярилцаж байна 🌸 Юу тусалцгаая?');
          addToHistory(senderId, 'user', text);
          continue;
        }
        if (isGreeting) {
          markGreeting(senderId);
        }

        const reply = await askGPT_DM(senderId, text);

        // BOT REPLY-ийн доторх tag-уудыг шинжлэх
        const isHandoff = shouldTriggerHandoff(reply);
        const isOrder = isOrderComplete(reply);
        const isCOD = isCODOrder(reply) || reply.includes('[COD_ORDER]');
        const isBank = reply.includes('[BANK_ORDER]');
        const isOrderEdit = reply.includes('[ORDER_EDIT]') || isOrderEditRequest(text);
        // v2.8.1: isCancelAsk / isCancelConfirmed устгасан — JS-only cancellation handling

        // Tag-уудыг арилгана
        let cleanReply = reply
          .replace('[HANDOFF_NEEDED]', '')
          .replace('[ORDER_EDIT]', '')
          .replace('[COD_ORDER]', '')
          .replace('[BANK_ORDER]', '')
          .replace('[CANCEL_REASON_ASK]', '')
          .replace('[CANCEL_CONFIRMED]', '')
          .replace(/\[[^\]]+\]/g, '') // Үлдсэн placeholder-уудыг арилгана
          .trim();

        // v2.8.1 SAFEGUARD: order confirm reply дотор "(... тодруулагдана)" гэх
        // round-bracket placeholder байвал тэр мөрүүдийг хасна — spam-shig харагдахаас сэргийлнэ
        if (/тодруулагдана|to be confirmed/i.test(cleanReply)) {
          cleanReply = cleanReply
            .split('\n')
            .filter(line => !/тодруулагдана|to be confirmed/i.test(line))
            .join('\n')
            .replace(/\n{3,}/g, '\n\n')
            .trim();
        }

        // cleanReply хоосон болсон бол (бүх агуулга нь tag/placeholder байсан) → safety message
        if (!cleanReply) {
          cleanReply = 'Таны захиалгыг хүлээн авлаа ✅';
        }

        await sendDM(senderId, cleanReply);

        // ── Захиалга баталгаажсан үед ──
        if (isOrder || isCOD || isBank) {
          console.log(`🛍 Order complete [${senderId}] COD=${isCOD} BANK=${isBank}`);

          // BUG #1 FIX (v2.8.1):
          // LLM өөрөө reply дотор бүх захиалгын мэдээллийг бичсэн бол JS дахин нэмэхгүй.
          // Илрүүлэх дохио: LLM reply дотор "Өнгө:", "Хаяг:", "Утас:" гэх label бий бөгөөд placeholder-биш утга агуулж буй
          const llmAlreadyAssembled = /(?:өнгө|өнгь|color)\s*[:：]/i.test(cleanReply)
            && /(?:хаяг|address)\s*[:：]/i.test(cleanReply)
            && /(?:утас|phone|дугаар)\s*[:：]/i.test(cleanReply)
            && !/тодруулагдана|to be confirmed|байхгүй|тогтоох/i.test(cleanReply);

          const orderState = getOrder(senderId) || {};
          const hasFullState = orderState.color && orderState.address && orderState.phone;

          // JS-р order details assembly хийх нь зөвхөн дараах нөхцөлд:
          //  (a) LLM reply дотор аль хэдийн full details байхгүй
          //  (b) AND JS state-д бүрэн мэдээлэл бий
          if (!llmAlreadyAssembled && hasFullState) {
            const color = orderState.color;
            const qty = orderState.qty || 1;
            const total = (qty * 199900).toLocaleString('en-US').replace(/,/g, "'") + '₮';
            const address = orderState.address;
            const phone = orderState.phone;

            const orderDetails = `📋 Захиалгын мэдээлэл:

🎨 Өнгө: ${color}
📦 Тоо: ${qty} ширхэг
💰 Нийт: ${total}
📍 Хаяг: ${address}
📞 Утас: ${phone}

24–48 цагт хүргэгдэнэ 🌸 Манайхыг сонгосонд баярлалаа!`;
            await sendDM(senderId, orderDetails);
          } else if (!llmAlreadyAssembled && !hasFullState) {
            // State дутуу + LLM-аас гаргаагүй → safety net (handoff)
            console.log(`⚠️ Order tag detected but incomplete state — handoff [${senderId}]`);
            addHandoff(senderId);
            await sendDMWithHumanAgent(senderId, '🌸 Захиалгын мэдээллийг нягтлах хэрэгцээтэй учир манай менежер тантай удахгүй холбогдох болно.');
            await notifyTelegramHandoff(senderId, `[INCOMPLETE ORDER] ${text}`);
            continue;
          }

          // Төлбөрийн дэлгэрэнгүй мэдээлэл — зөвхөн LLM өгөөгүй бол
          const llmHasBankInfo = /5403645877|хаан банк|khaan bank/i.test(cleanReply);
          const llmHasCodInfo = /жолоочид|joloochid|төлбөрөө өг/i.test(cleanReply);

          if (isBank && !llmHasBankInfo) {
            const orderStateForBank = getOrder(senderId) || {};
            const phoneRef = orderStateForBank.phone || '(утас)';
            const bankMsg = `💳 Хаан банк: 5403645877
👤 С.Цолмонбаатар
📋 IBAN: MN410005005403645877
✍️ Гүйлгээний утга: ${phoneRef}

Шилжүүлсний дараа screenshot явуулж захиалгаа баталгаажуулна уу 🌸`;
            await sendDM(senderId, bankMsg);
          } else if (isCOD && !llmHasCodInfo) {
            const orderStateForCod = getOrder(senderId) || {};
            const qty = orderStateForCod.qty || 1;
            const total = (qty * 199900).toLocaleString('en-US').replace(/,/g, "'") + '₮';
            const codMsg = `Хүргэлт ирэхэд жолоочид ${total} төлбөрөө өгнө үү 🌸`;
            await sendDM(senderId, codMsg);
          }

          await notifyTelegramOrder(senderId, getHistory(senderId), isCOD);
        }

        if (isOrderEdit && !isOrder && !isCOD && !isBank) {
          await notifyTelegramOrderEdit(senderId, text);
        }

        // v2.8.1: [CANCEL_REASON_ASK] болон [CANCEL_CONFIRMED] tag handling-ийг УСТГАСАН.
        // Cancellation flow-ийг бүхэлд нь JS keyword detection-аар удирдах болсон.
        // Ингэснээр LLM өөрөө буруу cancellation triggered хийх боломжгүй.

        if (isHandoff && !isOrder && !isCOD && !isBank) {
          addHandoff(senderId);
          await sendDMWithHumanAgent(senderId, '⏳ Манай менежер удахгүй тантай холбогдох болно 🌸');
          await notifyTelegramHandoff(senderId, text);
          console.log(`🤝 Handoff [${senderId}] — ${reply.includes('[HANDOFF_NEEDED]') ? 'tag' : 'keyword'}`);
        }

      } catch (e) {
        console.error('GPT DM error:', e.message);
        await sendDM(senderId, 'Уучлаарай, дахин оролдоно уу. skinbloom.store эсвэл 95999989 🌸');
      }
    }

    for (const change of (entry.changes || [])) {
      console.log(`📦 RAW: ${JSON.stringify(change).slice(0, 500)}`);
      if (change.field !== 'feed') continue;
      const val = change.value;

      if (val.item === 'comment' && val.verb === 'add') {
        const commentText = val.message;
        const commenterName = val.from?.name || '';
        const commenterId = val.from?.id;
        const commentId = val.comment_id || '';
        const rawCommentId = commentId;

        if (commenterId === pageId) continue;
        if (!commentText) continue;
        if (!commenterId) continue;
        if (!commentId) continue;

        const dedupeKey = `fb_comment_${rawCommentId}`;
        if (isDuplicate(dedupeKey)) continue;

        const isReply = val.parent_id && val.parent_id !== val.post_id;
        console.log(`💬 FB ${isReply ? 'Reply' : 'Comment'} [${commenterName}] id=${commentId}: ${commentText.slice(0, 60)}`);
        await sendDMToCommenter(commenterId, commenterName, commentText, commentId);
      }
    }

    for (const change of (entry.changes || [])) {
      if (change.field !== 'comments') continue;
      const val = change.value;
      if (val.text) {
        const commentText = val.text;
        const commenterName = val.from?.name || '';
        const commenterId = val.from?.id;
        if (!commentText || !commenterId) continue;
        if (isDuplicate(val.id)) continue;
        console.log(`📸 IG Comment [${commenterName}]: ${commentText.slice(0, 60)}`);
        await sendDMToCommenter(commenterId, commenterName, commentText);
      }
    }
  }
});

// ── TELEGRAM WEBHOOK БҮРТГЭХ ──
async function registerTelegramWebhook() {
  if (!TELEGRAM_TOKEN) return;
  const renderUrl = process.env.RENDER_URL || '';
  if (!renderUrl) return;
  try {
    await axios.post(`https://api.telegram.org/bot${TELEGRAM_TOKEN}/setWebhook`, {
      url: `${renderUrl}/telegram`
    });
    console.log('✓ Telegram webhook registered');
  } catch (e) {
    console.error('✗ Telegram webhook error:', e.message);
  }
}

const RENDER_URL = process.env.RENDER_URL || '';
if (RENDER_URL) {
  setInterval(async () => {
    try {
      await axios.get(`${RENDER_URL}/health`);
      console.log('💓 Keep-alive ping OK');
    } catch (e) {
      console.log('💓 Keep-alive ping failed:', e.message);
    }
  }, 14 * 60 * 1000);
}

async function graphGet(path, params = {}) {
  const url = new URL(`${GRAPH_BASE}${path}`);
  url.searchParams.set('access_token', PAGE_TOKEN);
  for (const [k, v] of Object.entries(params)) {
    url.searchParams.set(k, v);
  }
  const res = await axios.get(url.toString());
  return res.data;
}

function extractAction(actions, type) {
  if (!actions) return 0;
  const found = actions.find(a => a.action_type === type);
  return found ? parseInt(found.value) : 0;
}

function extractCPA(cpaArr, type) {
  if (!cpaArr) return null;
  const found = cpaArr.find(a => a.action_type === type);
  return found ? parseFloat(found.value).toFixed(2) : null;
}

function getUnixDaysAgo(days) {
  return Math.floor((Date.now() - days * 24 * 60 * 60 * 1000) / 1000);
}

function buildSummary(insights) {
  if (!insights.length) return null;
  let totalSpend = 0, totalImpressions = 0, totalClicks = 0;
  let totalPurchases = 0, totalATC = 0, totalVC = 0, totalPurchaseValue = 0;

  for (const row of insights) {
    totalSpend += parseFloat(row.spend);
    totalImpressions += parseInt(row.impressions.replace(/,/g, ''));
    totalClicks += Math.round((parseFloat(row.ctr.replace('%', '')) / 100) * parseInt(row.impressions.replace(/,/g, '')));
    totalPurchases += row.conversions.purchase;
    totalATC += row.conversions.add_to_cart;
    totalVC += row.conversions.view_content;
    totalPurchaseValue += parseFloat(row.conversions.purchase_value || 0);
  }

  const avgCTR = totalImpressions > 0 ? ((totalClicks / totalImpressions) * 100).toFixed(2) + '%' : '—';
  const roas = totalSpend > 0 && totalPurchaseValue > 0 ? (totalPurchaseValue / totalSpend).toFixed(2) + 'x' : '—';
  const cpPurchase = totalPurchases > 0 ? '$' + (totalSpend / totalPurchases).toFixed(2) : '—';

  return {
    total_spend: '$' + totalSpend.toFixed(2),
    total_impressions: totalImpressions.toLocaleString(),
    avg_ctr: avgCTR,
    total_purchases: totalPurchases,
    total_add_to_cart: totalATC,
    total_view_content: totalVC,
    total_purchase_value: '$' + totalPurchaseValue.toFixed(2),
    roas,
    cost_per_purchase: cpPurchase,
  };
}

app.get('/meta-stats', async (req, res) => {
  try {
    const preset = req.query.preset || 'last_7d';
    const level = req.query.level || 'campaign';

    const PRESET_MAP = {
      today: 'today', yesterday: 'yesterday',
      last_7d: 'last_7d', last_14d: 'last_14d',
      last_30d: 'last_30d', this_month: 'this_month',
    };
    const datePreset = PRESET_MAP[preset] || 'last_7d';

    const insightsFields = [
      'campaign_name', 'adset_name', 'ad_name',
      'impressions', 'reach', 'frequency',
      'clicks', 'ctr', 'cpc', 'cpm', 'cpp', 'spend',
      'actions', 'action_values', 'cost_per_action_type',
      'video_play_actions', 'video_thruplay_watched_actions',
    ].join(',');

    const [insights, campaigns] = await Promise.all([
      graphGet(`/${AD_ACCOUNT_ID}/insights`, {
        fields: insightsFields,
        date_preset: datePreset,
        level,
        limit: 50,
      }),
      graphGet(`/${AD_ACCOUNT_ID}/campaigns`, {
        fields: 'id,name,status,objective,daily_budget,lifetime_budget',
        limit: 20,
      }),
    ]);

    let pixelEvents = null;
    try {
      const pixels = await graphGet(`/${AD_ACCOUNT_ID}/adspixels`, {
        fields: 'id,name', limit: 5,
      });
      if (pixels.data && pixels.data.length > 0) {
        const pixelId = pixels.data[0].id;
        pixelEvents = await graphGet(`/${pixelId}/stats`, {
          start_time: getUnixDaysAgo(7),
          end_time: Math.floor(Date.now() / 1000),
          aggregation: 'event',
        });
      }
    } catch (pixelErr) {
      pixelEvents = { error: pixelErr.response?.data?.error?.message || pixelErr.message };
    }

    let topAds = [];
    try {
      const adInsights = await graphGet(`/${AD_ACCOUNT_ID}/insights`, {
        fields: 'ad_id,ad_name,impressions,clicks,ctr,spend,actions,cost_per_action_type',
        date_preset: datePreset,
        level: 'ad',
        sort: 'clicks_descending',
        limit: 10,
      });
      topAds = adInsights.data || [];
    } catch (e) {}

    const formattedInsights = (insights.data || []).map(row => {
      const purchases = extractAction(row.actions, 'purchase');
      const addToCart = extractAction(row.actions, 'add_to_cart');
      const viewContent = extractAction(row.actions, 'view_content');
      const initiateCheckout = extractAction(row.actions, 'initiate_checkout');
      const purchaseValue = row.action_values?.find(a => a.action_type === 'purchase')?.value || 0;
      const spend = parseFloat(row.spend || 0);
      const roas = spend > 0 && purchaseValue > 0 ? (parseFloat(purchaseValue) / spend).toFixed(2) : null;

      return {
        name: row.campaign_name || row.adset_name || row.ad_name || '—',
        spend: spend.toFixed(2),
        impressions: parseInt(row.impressions || 0).toLocaleString(),
        reach: parseInt(row.reach || 0).toLocaleString(),
        frequency: parseFloat(row.frequency || 0).toFixed(2),
        ctr: parseFloat(row.ctr || 0).toFixed(2) + '%',
        cpc: row.cpc ? '$' + parseFloat(row.cpc).toFixed(2) : '—',
        cpm: row.cpm ? '$' + parseFloat(row.cpm).toFixed(2) : '—',
        conversions: { view_content: viewContent, add_to_cart: addToCart, initiate_checkout: initiateCheckout, purchase: purchases, purchase_value: purchaseValue },
        roas: roas ? roas + 'x' : '—',
        cost_per_purchase: extractCPA(row.cost_per_action_type, 'purchase') ? '$' + extractCPA(row.cost_per_action_type, 'purchase') : '—',
      };
    });

    res.json({
      ok: true,
      generated_at: new Date().toISOString(),
      date_preset: datePreset,
      level,
      summary: buildSummary(formattedInsights),
      insights: formattedInsights,
      campaigns: (campaigns.data || []).map(c => ({
        id: c.id, name: c.name, status: c.status,
        objective: c.objective,
        daily_budget: c.daily_budget ? (parseInt(c.daily_budget) / 100).toFixed(2) : null,
      })),
      pixel_events: pixelEvents,
      top_ads: topAds,
    });

  } catch (err) {
    console.error('/meta-stats error:', err.response?.data || err.message);
    res.status(500).json({
      ok: false,
      error: err.response?.data?.error?.message || err.message,
    });
  }
});

app.get('/', (req, res) => res.json({
  status: '🌸 SkinBloom Bot running', version: '2.8.4',
  time: new Date().toISOString(),
  active_conversations: conversations.size,
  handoff_count: humanHandoff.size
}));
app.get('/health', (req, res) => res.json({ ok: true, ts: Date.now() }));
app.get('/stats', (req, res) => {
  const convs = [];
  for (const [id, conv] of conversations) {
    convs.push({ id, msgs: conv.messages.length, lastActivity: new Date(conv.lastActivity) });
  }
  res.json({
    active_conversations: conversations.size,
    handoff_users: [...humanHandoff],
    conversations: convs
  });
});

app.post('/handoff/release/:userId', (req, res) => {
  const userId = req.params.userId;
  removeHandoff(userId);
  console.log(`✓ Handoff released for ${userId}`);
  res.json({ ok: true, userId, released: true });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, async () => {
  console.log(`🌸 SkinBloom Bot v2.8.4 listening on port ${PORT}`);
  await registerTelegramWebhook();
  await sendTelegram('🌸 <b>SkinBloom Bot v2.8.4 асаалаа!</b>\n\n🆕 <b>Шинэ:</b>\n✅ Гомдол автомат detect + Telegram alert\n✅ Admin takeover (Manager бичихэд handoff)\n✅ 3 хувилбарт draft GPT-аар\n✅ /send, /dm, /draft, /help командууд\n\n<b>Командууд:</b>\n<code>/help</code> — бүх команд\n<code>/list</code> — handoff list\n<code>/release [id]</code> — handoff унтраах\n<code>/send [id] [1|2|3]</code> — draft илгээх\n<code>/dm [id] [text]</code> — гар мессеж\n<code>/draft [id]</code> — шинэ draft');
});
