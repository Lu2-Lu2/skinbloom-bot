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

// ── ACTIVE ORDERS STATE ──
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

// ── GREETING ANTI-REPEAT ──
const greetingTimestamps = new Map();
const GREETING_COOLDOWN_MS = 5 * 60 * 1000;

function hasRecentGreeting(senderId) {
  const ts = greetingTimestamps.get(senderId);
  return ts && (Date.now() - ts) < GREETING_COOLDOWN_MS;
}

function markGreeting(senderId) {
  greetingTimestamps.set(senderId, Date.now());
}

// ── PURE-GREETING DETECTOR ──
function isPureGreeting(text) {
  if (!text) return false;
  const t = text.toLowerCase().replace(/[^a-zа-яёөү\s]/gi, '').replace(/\s+/g, ' ').trim();
  if (!t || t.length > 16) return false;
  return /^(сайн\s*уу|сайн\s*байна\s*уу|сайнуу|sain\s*uu|sain\s*baina\s*uu|hi+|hello+|hey+|мэнд[эг]?|байна\s*уу|baina\s*uu|өө\s*байна\s*уу|юу\s*вэ|yuu?\s*ve)$/i.test(t);
}

const GREETING_MESSAGE = `Сайн байна уу! ✨ SkinBloom AI туслах тантай холбогдлоо.

📞 Хэрэв та манай менежертэй шууд холбогдохыг хүсвэл "Менежер" гэж бичнэ үү.

Өнгө сонгоход туслах уу, эсвэл бэлгийн багцын талаар мэдэхийг хүсэж байна уу? 🌸`;

// ── BOT-SENT MESSAGE TRACKING (legacy, v2.8.7-аас хойш ашиглагдахгүй) ──
const recentBotMessages = new Map();
const BOT_ECHO_WINDOW_MS = 5 * 60 * 1000;
const MAX_BOT_MSGS_PER_USER = 15;

function recordBotMessage(recipientId, text) {
  if (!recipientId || !text) return;
  const cutoff = Date.now() - BOT_ECHO_WINDOW_MS;
  const arr = (recentBotMessages.get(recipientId) || []).filter(m => m.ts >= cutoff);
  arr.push({ text: text.trim(), ts: Date.now() });
  recentBotMessages.set(recipientId, arr.slice(-MAX_BOT_MSGS_PER_USER));
  if (recentBotMessages.size > 5000) {
    const first = recentBotMessages.keys().next().value;
    recentBotMessages.delete(first);
  }
}

// ── ATTACHMENT DEDUPE ──
const attachmentTimestamps = new Map();
const ATTACHMENT_COOLDOWN_MS = 30 * 1000;

function isDuplicateAttachment(senderId) {
  const ts = attachmentTimestamps.get(senderId);
  if (ts && (Date.now() - ts) < ATTACHMENT_COOLDOWN_MS) return true;
  attachmentTimestamps.set(senderId, Date.now());
  return false;
}

// ── ORDER ID GENERATOR ──
function generateOrderId() {
  const d = new Date();
  const ymd = `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, '0')}${String(d.getDate()).padStart(2, '0')}`;
  const rand = Math.floor(Math.random() * 900 + 100);
  return `SB-${ymd}-${rand}`;
}

// ── PHONE EXTRACTION & VALIDATION ──
const MN_PHONE_FIRST_DIGITS = ['5', '7', '8', '9'];

function stripCountryCode(text) {
  return String(text).replace(/(^|[^\d])\+?976[\s\-().]*(?=\d{8}(?!\d))/g, '$1');
}

function collapseDigitSeparators(text) {
  return String(text).replace(/(\d)[\s\-().]{1,2}(?=\d)/g, '$1');
}

function normalizePhoneText(text) {
  if (!text) return '';
  return stripCountryCode(collapseDigitSeparators(String(text)));
}

function extractPhone(text) {
  if (!text) return null;
  const attempt = (t) => {
    const matches = t.match(/(?:^|[^\d])(\d{8})(?:[^\d]|$)/g);
    if (!matches) return null;
    for (const m of matches) {
      const num = m.match(/(\d{8})/)[1];
      if (MN_PHONE_FIRST_DIGITS.includes(num[0])) return num;
    }
    return null;
  };
  const found = attempt(stripCountryCode(String(text)));
  if (found) return found;
  return attempt(normalizePhoneText(text));
}

function validatePhoneInput(text) {
  const none = { isAttempt: false, valid: false, phone: null, message: null };
  if (!text) return none;

  const raw = String(text).trim();
  if (!/^[+\d\s\-().]+$/.test(raw)) return none;

  const normalized = normalizePhoneText(raw);
  const digits = normalized.replace(/\D/g, '');

  if (digits.length < 7 || digits.length > 11) return none;

  if (digits.length === 8 && MN_PHONE_FIRST_DIGITS.includes(digits[0])) {
    return { isAttempt: true, valid: true, phone: digits, message: null };
  }

  if (digits.length === 8) {
    return {
      isAttempt: true, valid: false, phone: null,
      message: 'Энэ дугаар танигдсангүй 🌸 Монголын дугаар 5, 7, 8 эсвэл 9-өөр эхэлдэг. Дугаараа дахин шалгаад явуулна уу.'
    };
  }

  if (digits.length < 8) {
    return {
      isAttempt: true, valid: false, phone: null,
      message: 'Дугаар дутуу байна 🌸 Монголын утасны дугаар 8 оронтой. Бүтнээр нь дахин явуулна уу.'
    };
  }

  return {
    isAttempt: true, valid: false, phone: null,
    message: 'Дугаар хэт урт байна 🌸 8 оронтой утасны дугаараа явуулна уу.'
  };
}

// =====================================================================
// v3.0 БЛОК 1 — OFFER LAYER (бэлгийн мөр)
// Бэлгийн мөрийг LLM бичихгүй — JS хавсаргана. 100% давтамж, 0% гуйвуулалт.
// =====================================================================
const GIFT_FULL  = '🎁 Багцаар авбал Brush ба Donut Sponge — 2 нэмэлт бүтээгдэхүүн бэлгэнд дагалдана.';
const GIFT_SHORT = '🎁 Багцад +2 нэмэлт бүтээгдэхүүн бэлгэнд.';
const GIFT_RX = /бэлгэнд|бэлгээр|Brush ба Donut|\+2 нэмэлт/i;

const giftShownCount = new Map();
const GIFT_TTL = 24 * 60 * 60 * 1000;

function ensureGiftLine(senderId, text) {
  if (!text) return text;
  if (GIFT_RX.test(text)) return text;

  const rec = giftShownCount.get(senderId);
  const n = (rec && Date.now() - rec.ts < GIFT_TTL) ? rec.n : 0;
  giftShownCount.set(senderId, { n: n + 1, ts: Date.now() });

  // 1-р удаа бүтэн, дараа нь богино.
  // ҮРГЭЛЖ бүтнээр давтахыг хүсвэл доорхыг зүгээр `GIFT_FULL` болго.
  return text.trim() + '\n\n' + (n === 0 ? GIFT_FULL : GIFT_SHORT);
}

// Бэлгийн мөр ЯВУУЛАХГҮЙ контекст (гомдол, цуцлалт, handoff, төлбөр, premium)
function shouldSkipGift(text) {
  return /цуцлагдлаа|цуцлах|уучлаарай|менежер тантай|менежер удахгүй|хүлээн авлаа ✅|Хаан банк|IBAN|Гүйлгээний утга/i.test(text || '');
}

function withGift(senderId, text) {
  if (shouldSkipGift(text)) return text;
  return ensureGiftLine(senderId, text);
}

// =====================================================================
// v3.0 БЛОК 2 — PRICE TEMPLATES
// ⚠️ Messenger нь markdown-г РЕНДЕРЛЭДЭГГҮЙ. `~~269'000₮~~` нь хэрэглэгчид
//    яг тэр зураастайгаа харагддаг. Бүх ~~...~~ устгасан, "➜" сум ашиглана.
// =====================================================================
const PRICE_TEMPLATE = `Бэлгийн Багц
269'000₮ ➜ 199'900₮ · 69'100₮ хэмнэнэ 🔥

🎁 2 нэмэлт бүтээгдэхүүн бэлгэнд
🚚 Хүргэлт үнэгүй
🎨 3 өнгөний сонголт

Дэлгэрэнгүй мэдэх үү, эсвэл өнгө сонгох уу? 🌸`;

function priceTemplateForColor(color) {
  return `${color} — 269'000₮ ➜ 199'900₮

🎁 2 нэмэлт бүтээгдэхүүн бэлгэнд
🚚 Хүргэлт үнэгүй, хүлээж аваад төлнө

Хаягаа үлдээвэл 24–48 цагт танайд хүрнэ. Явуулах уу? 🌸`;
}

const FILTER_PRICE_TEMPLATE = `Нөөц Карбон Шүүлтүүр (үндсэн үнэ 44'900₮)

🔹 1 ширхэг — 29'900₮
🔹 2 ширхэг — 54'900₮ (нэг нь 27'450₮)
🔹 3 ширхэг — 79'900₮ (нэг нь 26'633₮) ⭐

Хямдрал 9-р сарын 1 хүртэл. Аль нь тохирох вэ?`;

const INFO_TEMPLATE = `Бэлгийн Багц
269'000₮ ➜ 199'900₮ · 69'100₮ хэмнэнэ 🔥

🎁 Brush ба Donut Sponge бэлгэнд
🚚 Хүргэлт үнэгүй

⬛ Obsidian Black — мөнгөлөг цагираг, гүн хар
🤍 Pearl White — дулаан гэрэлтэй, цэвэр цайвар
🩶 Slate Gray — час улаан дотоод цагираг, тансаг бараан

Аль өнгө нь танд илүү таалагдаж байна?`;

// =====================================================================
// v3.0 БЛОК 3 — PREMIUM MODE (материал / чанар / бүтэц / үзэмж)
// P1 үнэ дурдахгүй · P2 emoji 0–1 · P3 жагсаалт биш урссан текст
// P4 "чанартай" гэх хий үг хориотой · P5 материалыг НЭРЛЭНЭ
// P6 макро зураг хамт · P7 сониуч асуултаар төгсөнө
// =====================================================================
const PREMIUM_KEYWORDS = [
  'материал', 'material', 'юугаар хийсэн', 'yugaar hiisen', 'ямар материал',
  'хуванцар', 'huvantsar', 'abs', 'металл', 'metall', 'жинтэй юу',
  'чанар', 'chanar', 'бат бөх', 'bat boh', 'эвдрэх', 'evdreh', 'удаан эдэлгээ',
  'хэр удаан', 'баталгаа', 'batalgaa', 'warranty', 'зэвэрдэг', 'zevreh',
  'бүтэц', 'butets', 'дотор нь', 'dotor ni', 'яаж ажилладаг', 'yaj ajilladag',
  'хэрхэн ажилладаг', 'давхарга', 'davharga', 'шүүлтүүр яаж', 'филтр яаж',
  'үзэмж', 'харагдац', 'ямар харагд', 'дизайн', 'design', 'гоё юу', 'goyo yu',
  'өнгө нь ямар', 'ongo ni yamar',
  'хаана үйлдвэр', 'хаанахын', 'хятад юм уу', 'hyatad', 'гарал үүсэл', 'сертификат'
];

function isPremiumIntent(text) {
  if (!text) return false;
  const lower = text.toLowerCase();
  return PREMIUM_KEYWORDS.some(kw => lower.includes(kw));
}

const PREMIUM_ANSWERS = {
  material: `Их бие нь матт ABS — гялалзахгүй, хуруу мөр үлдээхгүй, барихад бага зэрэг жинтэй мэдрэгддэг. Бариулын гадаргууг нарийн зүсэж хээлсэн тул нойтон гараар ч гулсахгүй. Урд ирмэгээр өнгөлсөн мөнгөлөг цоргот цагираг тойрсон — гэрэл тусахад зөвхөн тэр хэсэг нь гялалзаж, бусад нь тайван матт хэвээр үлдэнэ.

Танд аль өнгө нь илүү таалагдаж байна?`,

  structure: `Шүүлтүүр нь радиал бүтэцтэй — ус гаднаас нь дотогш нэвчиж явдаг. Хамгийн гадна талд PP нэхмэл бус давхарга тунадас, элс, зэвний ширхгийг барина. Дараа нь идэвхжүүлсэн нүүрсний шахмал цагираг хана хлор болон эвгүй үнэрийг шингээнэ. Төвд нь нягтруулсан PP цөм үлдсэн микро тоосонцрыг барьж, цэвэршсэн ус голын сувгаар дээшээ гарна.

Шүүлтүүр нь бариулын дотор бүрэн нуугдсан — гаднаас юу ч харагдахгүй, зөвхөн цэвэр хэлбэр нь үлдэнэ. Танай усанд зэвний өнгө ордог уу?`,

  durability: `Их бие нь нэг ширхэг цутгамал ABS — салдаг, чичирдэг хэсэггүй. Дотор нь эргэлддэг механизм ч, тохируулгын товч ч байхгүй тул эвдрэх цэг нь бага. Ганц солих зүйл нь шүүлтүүр өөрөө, тэр нь 3–6 сар тутам.

Шүршүүрийн толгойд 30 хоногийн баталгаа өгдөг. Танайх хэдүүлээ усанд ордог вэ?`,

  look: `Obsidian Black нь гүн хар матт — цоргот цагираг нь мөнгөлөг, тэр л ганц гялалзсан шугам үлддэг. Pearl White нь дулаан гэрэлтэй цайвар, цэвэрхэн орчинд уусаад алга болдог. Slate Gray нь гаднаа хатуу бараан, дотоод цагираг нь час улаан — хамгийн зоримог нь.

Танай угаалгын өрөө ямар өнгөтэй вэ?`,

  origin: `Европын CE тохирлын гэрчилгээтэй (HX240303050484), Хонгконгд угсардаг. Гадаргуугийн өнгөлгөө, цагирагийн зай, цоргоны жигд байдал — эдгээрийг л бид хамгийн их хардаг, учир нь гартаа барихад ялгаа нь тэндээс мэдрэгддэг.

Танд бүтээгдэхүүний талаар өөр тодруулах зүйл байна уу?`
};

function getPremiumAnswer(text) {
  const l = (text || '').toLowerCase();
  if (/бүтэц|butets|давхарга|davharga|дотор нь|яаж ажилл|хэрхэн ажилл|шүүлтүүр яаж|филтр яаж/i.test(l)) return PREMIUM_ANSWERS.structure;
  if (/эвдрэх|evdreh|бат бөх|удаан эдэлгээ|хэр удаан|баталгаа|warranty|зэвэрдэг/i.test(l)) return PREMIUM_ANSWERS.durability;
  if (/үзэмж|харагдац|ямар харагд|дизайн|design|өнгө нь ямар/i.test(l)) return PREMIUM_ANSWERS.look;
  if (/хаана үйлдвэр|хаанахын|хятад|hyatad|гарал үүсэл|сертификат/i.test(l)) return PREMIUM_ANSWERS.origin;
  if (/материал|material|юугаар хийсэн|ямар материал|хуванцар|abs|металл|жинтэй/i.test(l)) return PREMIUM_ANSWERS.material;
  return null;
}

const PREMIUM_NOTE = `[СИСТЕМИЙН ЗААВАР — PREMIUM ГОРИМ]
Хэрэглэгч материал / чанар / бүтэц / үзэмжийн талаар асууж байна.
Чи худалдагч биш — энэ бүтээгдэхүүнийг зохион бүтээсэн хүн шиг тайван, тодорхой ярина.

ДҮРЭМ:
• ҮНЭ ДУРДАХГҮЙ (хэрэглэгч шууд асуугаагүй бол).
• Emoji 0 эсвэл 1.
• Bullet жагсаалт БИШ — 2–4 өгүүлбэр урссан текст.
• "чанартай", "өндөр чанарын", "маш сайн" гэж БИЧИХГҮЙ — юу ч хэлээгүйтэй адил.
• Оронд нь материалыг НЭРЛЭ: матт ABS их бие, өнгөлсөн мөнгөлөг цоргот цагираг,
  зүсэж хээлсэн бариул, идэвхжүүлсэн нүүрсний шахмал цагираг хана.
• Мэдрэхүйгээр бич: гарт мэдрэгдэх жин, гэрэл барих ирмэг, чимээгүй урсгал.
• 1 сониуч асуултаар төгсө (захиалгын асуулт биш).

ЗӨВШӨӨРӨГДСӨН CLAIM ЗӨВХӨН: хлор, шохой, тунадас, зэв, эвгүй үнэр шүүнэ;
ганц өндөр даралттай горим; 40% ус хэмнэлт; 30 хоногийн баталгаа; CE HX240303050484.

ХОРИОТОЙ (зохиож БОЛОХГҮЙ): KDF, металл тор, хүнд металл, бактер устгах,
ион солилцоо, нано мөнгө, керамик, эрдэс чулуу, витамин, Герман/Япон/Солонгос
технологи, патент, medical-grade, олон горим, эмнэлгийн үр дүн.`;

// 📸 Premium макро зураг. Facebook-д хүрэх public HTTPS URL оруулна.
// Хоосон бол зураг илгээхгүй — алдаа гарахгүй.
const PREMIUM_IMAGES = {
  'Obsidian Black': [],
  'Pearl White': [],
  'Slate Gray': [],
  default: []
};

async function sendPremiumImages(senderId, color) {
  const urls = (PREMIUM_IMAGES[color] && PREMIUM_IMAGES[color].length)
    ? PREMIUM_IMAGES[color]
    : PREMIUM_IMAGES.default;
  for (const url of urls.slice(0, 2)) {
    try { await sendImageDM(senderId, url); }
    catch (e) { console.error('Premium image error:', e.message); }
  }
}

// =====================================================================
// v3.0 БЛОК 4 — BANLIST GUARD (LLM-ийн БҮХ гаралтад)
// "Премиум сонсогдуул" гэсэн заавар нь hallucination-ы №1 гох.
// =====================================================================
const BANNED_PATTERNS = [
  { rx: /\bKDF\b/i, label: 'KDF' },
  { rx: /хүнд\s*металл|heavy\s*metal/i, label: 'хүнд металл' },
  { rx: /бактер|вирус|микроб/i, label: 'бактер claim' },
  { rx: /керамик|ceramic/i, label: 'ceramic' },
  { rx: /нано|nano|ион\s*солилцоо|мөнгөн\s*ион/i, label: 'нано/ион' },
  { rx: /витамин|vitamin|эрдэс\s*чулуу/i, label: 'витамин/эрдэс' },
  { rx: /герман|япон|солонгос.*технолог|patent|патент|medical[-\s]?grade/i, label: 'зохиомол гарал/патент' },
  { rx: /rain\s*mode|massage\s*mode|mist|олон\s*горим|горим\s*сольж/i, label: 'олон горим' },
  { rx: /Rose\s*Red|криминал\s*улаан/i, label: 'буруу өнгөний нэр' },
  { rx: /~~/, label: 'markdown зураас' },
  { rx: /запас|zapas/i, label: 'запас (→ нөөц)' },
  { rx: /шүүлтүүр[^.\n]{0,20}үнэгүй|үнэгүй[^.\n]{0,20}шүүлтүүр/i, label: 'шүүлтүүр "үнэгүй"' }
];

const AUTOFIX_LABELS = ['markdown зураас', 'запас (→ нөөц)'];
const SAFE_FALLBACK = 'Энэ талаар манай менежер илүү тодорхой хариулж чадна 🌸 Тантай удахгүй холбогдох болно.';

function scrubBanned(text) {
  const hits = [];
  let out = text || '';
  for (const p of BANNED_PATTERNS) {
    if (p.rx.test(out)) hits.push(p.label);
  }
  if (!hits.length) return { text: out, hits };

  // Автоматаар засаж болох 2 зүйл
  out = out.replace(/~~/g, '').replace(/запас/gi, 'нөөц').replace(/zapas/gi, 'нөөц');

  const stillBad = BANNED_PATTERNS
    .filter(p => !AUTOFIX_LABELS.includes(p.label))
    .some(p => p.rx.test(out));

  if (stillBad) {
    const kept = out.split(/(?<=[.!?…])\s+|\n/).filter(s =>
      !BANNED_PATTERNS.some(p => !AUTOFIX_LABELS.includes(p.label) && p.rx.test(s))
    );
    out = kept.join(' ').replace(/\s{2,}/g, ' ').trim();
    if (out.length < 25) out = SAFE_FALLBACK;
  }
  return { text: out.trim(), hits };
}

// =====================================================================
// v3.0 БЛОК 6 — PRICE ENGINE
// v2.9.2-т дүн 3 газарт `qty * 199900` гэж hardcode байсан тул
// нөөц шүүлтүүрийн захиалгад ч 199'900₮ гэж бодогдож, COD мессежээр
// хэрэглэгчид буруу дүн очдог байв.
// =====================================================================
const FILTER_PACK_PRICE = { 1: 29900, 2: 54900, 3: 79900 };
const BUNDLE_PRICE = 199900;

function detectProductType(text, existing) {
  if (existing && existing.productType) return existing.productType;
  if (!text) return null;
  const l = text.toLowerCase();
  const filterIntent = /нөөц|шүүлтүүр|филтер|пилтер|filter|filtr|zapas|запас/i.test(l);
  const bundleIntent = /багц|шүршүүр|bundle|pearl|obsidian|slate|цагаан|хар|саарал/i.test(l);
  if (filterIntent && !bundleIntent) return 'FILTER';
  if (bundleIntent) return 'BUNDLE';
  return null;
}

function calcTotal(order) {
  const qty = order?.qty || 1;
  if (order?.productType === 'FILTER') {
    const price = FILTER_PACK_PRICE[qty] || (FILTER_PACK_PRICE[1] * qty);
    return { amount: price, text: price.toLocaleString('en-US').replace(/,/g, "'") + '₮' };
  }
  const amount = qty * BUNDLE_PRICE;
  return { amount, text: amount.toLocaleString('en-US').replace(/,/g, "'") + '₮' };
}

// ── ORDER STATE → LLM CONTEXT ──
function buildOrderStateNote(senderId) {
  const o = getOrder(senderId);
  if (!o) return null;
  const lines = [];
  if (o.color) lines.push(`• Өнгө: ${o.color} ✓`);
  if (o.qty) lines.push(`• Тоо ширхэг: ${o.qty} ✓`);
  if (o.address) lines.push(`• Хаяг: ${o.address} ✓`);
  if (o.entranceCode) lines.push(`• Орцны код: ${o.entranceCode} ✓`);
  if (o.phone) lines.push(`• Утасны дугаар: ${o.phone} ✓ (СИСТЕМ ШАЛГАЖ БАТАЛГААЖУУЛСАН — зөв дугаар. Дахин бүү асуу, бүү эргэлз, оронг нь бүү тоол.)`);
  if (o.payment) lines.push(`• Төлбөрийн арга: ${o.payment === 'COD' ? 'Жолоочид бэлнээр (COD)' : 'Урьдчилж банкаар'} ✓`);
  if (!lines.length) return null;

  return `[СИСТЕМИЙН ДОТООД МЭДЭЭЛЭЛ — хэрэглэгчид харагдахгүй]
Энэ захиалгад аль хэдийн ЦУГЛУУЛСАН БА БАТАЛГААЖСАН мэдээлэл:
${lines.join('\n')}

ДҮРЭМ: Дээр ✓ тэмдэглэгдсэн талбаруудыг ДАХИН АСУУХГҮЙ, эргэлзэхгүй, буруу гэж хэлэхгүй. Зөвхөн жагсаалтад БАЙХГҮЙ талбарыг асуу. Бүх талбар бүрэн бол захиалгыг баталгаажуул.`;
}

// ── ADDRESS DETECTION & SCORING ──
const DISTRICT_CODES = ['бзд', 'бгд', 'сбд', 'худ', 'чд', 'схд', 'нд', 'shd', 'bzd', 'bgd', 'sbd', 'khud', 'chd', 'skhd', 'nd'];
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
  const digits = (lower.match(/\d+/g) || []).length;
  if (digits >= 2) score += 1;
  return score;
}

function looksLikeAddress(text) {
  if (!text || text.trim().length < 6) return false;
  return scoreAddress(text) >= 2;
}

// ── v3.0 FIX 3: qty regex ──
// Хуучин `ш\.?` нь "ш"-г ГАНЦААРАА таьдаг байсан тул "5 шатны байр",
// "3 шинэ хотхон" гэх ХАЯГ бүр qty болж, 4+ бол оптын handoff руу явдаг байв.
const QTY_RX_V3 = /(\d+)\s*(ширхэг|ш(?![а-яёүөa-z])|piece|pcs)/i;

// ── BATCH ORDER PARSE ──
function parseOrderSlots(text, existing = {}) {
  const result = { ...existing };
  if (!text) return result;
  const lower = text.toLowerCase();

  if (!result.color) {
    if (/pearl\s*white|цагаан|tsagaan|tsagan|tagaan/i.test(text)) result.color = 'Pearl White';
    else if (/slate\s*gray|saaral|саарал|саарл/i.test(text)) result.color = 'Slate Gray';
    else if (/obsidian|black|хар|har\b|kar\b/i.test(text)) result.color = 'Obsidian Black';
  }

  if (!result.qty) {
    const qtyMatch = lower.match(QTY_RX_V3);
    if (qtyMatch) result.qty = parseInt(qtyMatch[1], 10);
  }
  if (!result.qty) {
    const xMatch = text.match(/[xX×](\d+)/);
    if (xMatch) result.qty = parseInt(xMatch[1], 10);
  }

  if (!result.phone) {
    const ph = extractPhone(text);
    if (ph) result.phone = ph;
  }

  if (!result.entranceCode) {
    const codeMatch = text.match(/(?:орцны\s*код|ortsnii\s*kod|орц[нии]*\s*код|код|code)[:\s#]*(\d{2,6})/i);
    if (codeMatch) result.entranceCode = codeMatch[1];
  }

  if (!result.payment) {
    if (/жолооч|joloochid|joloch|joloochi|cod|бэлнээр|belneer|авсны дараа|avsny daraa|avsni daraa|awsny daraa|awsni daraa|tootsoo hiine|tootsoo hiy|тооцоо хий|cash on delivery/i.test(lower)) {
      result.payment = 'COD';
    } else if (/банк|bank|урьдчилж|urdjilj|шилжүүл|shiljuule|шижлүүл/i.test(lower)) {
      result.payment = 'BANK';
    }
  }

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
    const fullScore = scoreAddress(text);
    if (fullScore > bestScore && text.length >= 8 && text.length <= 250) {
      bestLine = text.trim();
      bestScore = fullScore;
    }
    if (bestLine && bestScore >= 2) {
      result.address = bestLine.replace(/(?:^|[^\d])(\d{8})(?:[^\d]|$)/g, ' ').trim();
    }
  }

  // v3.0: бүтээгдэхүүний төрөл (үнэ зөв бодогдоход шаардлагатай)
  result.productType = detectProductType(text, result) || result.productType;

  return result;
}

// ── HANDOFF DETECTION ──
function shouldTriggerHandoff(reply) {
  return reply.includes('[HANDOFF_NEEDED]');
}

const USER_HANDOFF_REQUEST_KEYWORDS = [
  'хүнтэй ярих', 'hunteh yarih', 'huntei yarih', 'оператор', 'operator',
  'ажилтан', 'azhiltan', 'ажилчин', 'жинхэнэ хүн', 'real person',
  'live agent', 'live person', 'human',
  'менежер', 'менэжэр', 'мэнежер', 'мэнэжэр', 'мэнэжер', 'менэжер',
  'менежэр', 'мэнежэр', 'менеджер', 'менэджэр', 'мэнэджэр',
  'менежр', 'мэнэжр', 'менэжр', 'менажер', 'мэнажэр',
  'manager', 'maneger', 'menejer', 'menezher', 'meneger', 'menegar',
  'menejr', 'manejer', 'menjer', 'menejor', 'manejor', 'menegr',
  'manegar', 'managr', 'manjer', 'menager', 'menejar',
  'очиж', 'ochih', 'ochmoor', 'ochmor', 'очмоор', 'ochij vzmeer',
  'очиж үзэх', 'очиж үзмээр', 'очиж харах', 'нүдээр харах', 'nudeer harah',
  'газар дээр нь', 'gazar deer', 'дэлгүүр очих', 'delguur ochih',
  'агуулах очих', 'ageulah', 'офис очих', 'office очих',
  'хаашаа очих', 'хаана байр', 'хаанаа байг', 'хаана байш', 'bairshil',
  'байршил', 'байрлал', 'хаягаа хэлээч',
  'manai bag', 'manai baig', 'манай баг', 'таны баг', 'tani bag'
];

function isUserHandoffRequest(text) {
  if (!text) return false;
  const lower = text.toLowerCase();
  return USER_HANDOFF_REQUEST_KEYWORDS.some(kw => lower.includes(kw));
}

// ── COD PAYMENT INDICATORS ──
const COD_INDICATOR_PHRASES = [
  'авсны дараа', 'avsny daraa', 'avsni daraa', 'awsny daraa', 'awsni daraa',
  'жолоочид бэлн', 'joloochid beln', 'jolochid', 'joloch',
  'бэлнээр төл', 'belneer tol', 'belneer tul',
  'cod', 'cash on delivery',
  'tootsoo hiine', 'tootsoo hiy', 'тооцоо хий'
];

function isCODPaymentChoice(text) {
  if (!text) return false;
  const lower = text.toLowerCase();
  return COD_INDICATOR_PHRASES.some(p => lower.includes(p));
}

// ── v3.0 FIX 1: ХУДАЛ ЦУЦЛАЛТ ──
// v2.9.2-т 'хэрэггүй', 'аваагүй', 'болих' жагсаалтад байсан. Үр дагавар:
//  • Бот "Орцны код байгаа уу? Байхгүй бол алгасъя" гэж асууна →
//    хэрэглэгч "хэрэггүй" гэнэ → ЗАХИАЛГА ЦУЦЛАХ FLOW асдаг байв.
//  • "Захиалгаа аваагүй байна" (хүргэлт ирээгүй гомдол) → цуцлалт гэж уншина.
//  • "болихгүй ээ" дотор 'болих' substring → цуцлалт гэж уншина.
const CANCELLATION_KEYWORDS = [
  'цуцл', 'tsutsl', 'tsutsal', 'цуцал',
  'захиалга болиё', 'захиалгаа болиё', 'болиё', 'болъё', 'болио',
  'битгий илгээ', 'битгий явуул', 'битгий ил', 'битгий ирүүл',
  'хэрэггүй болсон', 'хэрэггүй боллоо', 'авахаа больё', 'авахаа болилоо',
  'авахгүй болсон', 'авахаа болих', 'хүсэхгүй болсон',
  'цуцлагдсан', 'tsutslagdsan', 'цуцлагдлаа',
  'cancel', 'canceled', 'cancelled', 'cancelation', 'cancellation'
];

const CANCEL_EXCLUSION_RX = /цуцлахгүй|цуцлах гэж хэлээгүй|болихгүй|болиогүй|tsutslakhgui|tsutslahgui|bolihgui|(орц|код|kod|давхар)[^.\n]{0,15}(хэрэггүй|байхгүй)|^(хэрэггүй|байхгүй|үгүй|ugui|baihgui)[\s.!]*$/i;

function isCancellationRequest(text) {
  if (!text) return false;
  const t = text.trim();
  if (CANCEL_EXCLUSION_RX.test(t)) return false;
  if (isCODPaymentChoice(t)) return false;
  const lower = t.toLowerCase();
  return CANCELLATION_KEYWORDS.some(kw => lower.includes(kw));
}

const CANCEL_DENIAL_PATTERNS = [
  'цуцлах гэж хэлээгүй', 'tsutsly gej heleegui', 'tsutslakh gej heleegui',
  'цуцлахгүй', 'tsutslakhgui', 'tsutslahgui',
  'захиалах гэж', 'zahialy gej', 'zahialah gej',
  'болиогүй', 'болиогуй', 'boliogui', 'болихгүй',
  'цуцлахаа болих', 'tsutslakhaa bolih',
  'буруу ойлго', 'buruu oilg', 'misunderstand',
  'миний хэлсэн нь', 'minii helsen ni'
];

function isCancellationDenial(text) {
  if (!text) return false;
  const lower = text.toLowerCase();
  return CANCEL_DENIAL_PATTERNS.some(p => lower.includes(p));
}

// ── v3.0 FIX 2: СҮХБААТАР ДҮҮРЭГ → "ОРОН НУТАГ" ──
// v2.9.2-т PROVINCE_KEYWORDS дотор 'сүхбаатар' байсан. Сүхбаатар нь УБ-ын
// ДҮҮРЭГ. "Сүхбаатар дүүрэг 5-р хороо" гэсэн энгийн УБ хаяг бүр орон нутгийн
// handoff руу явж, захиалга дундаа тасалддаг байв.
const UB_CONTEXT_RX = /дүүрэг|duureg|сбд|бзд|бгд|худ|схд|\bчд\b|хороо|khoroo|horoo|хотхон|улаанбаатар|ulaanbaatar|\bуб\b/i;

const PROVINCE_KEYWORDS = [
  'дархан', 'darhan', 'darkhan',
  'эрдэнэт', 'erdenet',
  'чойбалсан', 'choibalsan',
  'улаангом', 'ulaangom',
  'арвайхээр', 'arvaiheer',
  'баянхонгор', 'bayankhongor', 'bayanhongor',
  'говь-алтай', 'сайншанд', 'sainshand', 'зуунмод', 'zuunmod',
  'ховд', 'khovd', 'алтанбулаг', 'мандалговь', 'өлгий', 'ulgii',
  'аймаг', 'aimag', 'aymag',
  'хөдөө', 'khudoo', 'hudoo',
  'oron nutag', 'орон нутаг',
  'сүхбаатар аймаг', 'сүхбаатар хот', 'булган аймаг', 'мөрөн хот'
];

function isProvinceDelivery(text) {
  if (!text) return false;
  const lower = text.toLowerCase();
  if (UB_CONTEXT_RX.test(lower) && !/аймаг|орон нутаг|oron nutag/i.test(lower)) return false;
  return PROVINCE_KEYWORDS.some(kw => {
    const re = new RegExp(`(?:^|[\\s,.;:!?])${kw}(?:[\\s,.;:!?]|$)`, 'i');
    return re.test(lower);
  });
}

// ── WHOLESALE / BULK DETECTION ──
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
  const m = lower.match(QTY_RX_V3);
  if (m) {
    const n = parseInt(m[1], 10);
    if (n >= 4 && n <= 500) return true;
  }
  return false;
}

// ── PRICE MANIPULATION DETECTION ──
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

// ── DIRECT INFO REQUEST DETECTION ──
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

// ── COMPLAINT DETECTION ──
const COMPLAINT_KEYWORDS = [
  'гомдол', 'санал гомдол', 'gomdol',
  'буцаах', 'буцаалт', 'буцааж өг', 'butsaah', 'butsaalt',
  'мөнгөө буцааж', 'төлбөрөө буцааж',
  'эвдэрсэн', 'evdersen', 'муу чанартай',
  'ажилахгүй', 'ажиллахгүй', 'azhilahgui', 'ажилгүй',
  'хугарсан', 'hugarsan', 'эвдэрчихсэн',
  'таалагдсангүй', 'taalagdsangui', 'taalagdahgui',
  'сэтгэл хангалуун биш', 'дургуй', 'durgui',
  'буруу ирсэн', 'buruu irsen', 'өөр зүйл ирсэн',
  'ялгаатай ирсэн', 'буруу хүргэгдсэн', 'буруу бүтээгдэхүүн',
  'буруу ойлгосон', 'buruu oilgoson', 'iim gej bodoogui',
  'ийм гэж бодоогүй', 'нөөц ирэх гэж бодсон',
  'ирэх гэж бодсон', 'буруу мэдээлэл', 'buruu medeelel', 'хууртагдсан',
  'хариуцлага', 'хариуцлагатай', 'арга хэмжээ',
  'ирээгүй', 'iregui', 'хүргэгдээгүй', 'hurgegdeegui',
  'хүлээж байна', 'huleej baina', 'хүргэлт удаан'
];

// ── v3.0 FIX 5: "За хүлээж байна" → гомдол гэж уншигдахаа болино ──
const COMPLAINT_EXCLUSION_RX = /^(за|тэгье|ok|okay|тийм)?[\s,]*хүлээж байна[\s.!🌸]*$/i;

function isComplaint(text) {
  if (!text) return false;
  if (COMPLAINT_EXCLUSION_RX.test(text.trim())) return false;
  const lower = text.toLowerCase();
  return COMPLAINT_KEYWORDS.some(kw => lower.includes(kw));
}

// ── v3.0 FIX 4: зураг + тайлбар хамт ирвэл зураг алга болно ──
// v2.9.2: `if (!text && attachments?.length > 0)` — төлбөрийн screenshot +
// "шилжүүлчихлээ" гэж хамт илгээвэл attachment БҮРЭН үл тоогдоно.
function shouldHandoffForAttachment(attachments) {
  if (!attachments || !attachments.length) return false;
  const type = attachments[0]?.type;
  if (type === 'sticker') return false;
  return ['image', 'video', 'audio', 'file'].includes(type);
}

async function notifyTelegramUGC(senderId, userText) {
  const msg = `📸 <b>UGC / INFLUENCER хүсэлт!</b>

👤 Messenger ID: <code>${senderId}</code>
💬 Мессеж: <b>${userText}</b>

👉 Хариулах: https://m.me/${senderId}

<i>Контент хийх сонирхолтой хэрэглэгч байна.</i>`;
  await sendTelegram(msg);
}

// ── DRAFT VARIANTS GENERATOR ──
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
- Эхлэхдээ "Сайн байна уу?" гэж хандана
- 199'900₮ хэлбэрийн apostrophe ашиглах
- Markdown БИЧИХГҮЙ — Messenger рендерлэдэггүй (~~зураас~~, **тод** хэрэглэхгүй)
- "Pearl White 3-в-1", "ceramic", "Dyson", "Loofah", "Peeling", "Массажны", "Нэмэлт шүүлтүүр" — эдгээр үг бичихгүй
- "KDF", "хүнд металл", "бактер устгана" — эдгээр ХЭЗЭЭ Ч бичихгүй (шүүлтүүрт KDF байхгүй)
- Багц доторх шүүлтүүрийг "үнэгүй / бэлгээр дагалдана" гэж бичихгүй (шүршүүрийн салшгүй хэсэг). Гомдлын НӨХӨН ОЛГОВОР болгож нөөц шүүлтүүр санал болгох нь зөвшөөрөгдөнө — гэхдээ "нөхөн олговор" гэдгийг тодорхой хэл.
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

// ── DRAFT VARIANTS STORE ──
const draftStore = new Map();
const DRAFT_TTL = 60 * 60 * 1000;

function saveDrafts(userId, variants) {
  draftStore.set(userId, { variants, expiresAt: Date.now() + DRAFT_TTL });
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
  const alertMsg = `🚨 <b>САНАЛ ГОМДОЛ — Яаралтай!</b>

👤 Messenger ID: <code>${senderId}</code>
💬 Мессеж: <b>${userText}</b>

👉 Хариулах: https://m.me/${senderId}

<i>Bot хариулсангүй — handoff горимд оруулав.
Доор 3 draft хувилбар бэлдэж байна...</i>`;
  await sendTelegram(alertMsg);

  const drafts = await generateDraftVariants(senderId, userText, history);
  if (!drafts) {
    await sendTelegram(`⚠️ Draft бэлдэх алдаа гарлаа. Гар хариулна уу: https://m.me/${senderId}`);
    return;
  }

  saveDrafts(senderId, drafts);

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

  for (const m of messages.filter(x => x.role === 'user')) {
    parsed = parseOrderSlots(m.content, parsed);
  }

  const color = parsed.color || '—';
  const qty = parsed.qty ? `${parsed.qty} ширхэг` : '—';
  const address = parsed.address || '—';
  const entranceCode = parsed.entranceCode || 'байхгүй';
  const phone = parsed.phone || '—';

  // v3.0: дүн бүтээгдэхүүний төрлөөр бодогдоно (199'900 hardcode БИШ)
  parsed.productType = parsed.productType || 'BUNDLE';
  const productLabel = parsed.productType === 'FILTER' ? 'Нөөц шүүлтүүр' : 'Бэлгийн Багц';
  const total = (parsed.qty || parsed.color) ? calcTotal(parsed).text : '—';

  const orderId = parsed.orderId || generateOrderId();

  const placedCount = messages.filter(m =>
    m.role === 'assistant' && m.content.includes('Таны захиалгыг хүлээн авлаа')
  ).length;
  const repeatTag = placedCount >= 2 ? '🔁 <b>REPEAT CUSTOMER</b>\n\n' : '';

  const hour = new Date().getHours();
  const afterHours = (hour < 8 || hour >= 22) ? '🌙 <i>Шөнийн цаг — өглөө хариулж болно</i>\n\n' : '';

  const paymentLine = isCOD
    ? '💵 Төлбөр: <b>ЖОЛООЧИД БЭЛНЭЭР (COD)</b>'
    : '🏦 Төлбөр: <b>Урьдчилж банкаар (баталгаажилт хүлээгдэж байна)</b>';

  const msg = `${repeatTag}${afterHours}🛍 <b>ШИНЭ ЗАХИАЛГА${isCOD ? ' — COD' : ''}!</b>
🆔 <code>${orderId}</code>

📦 Бүтээгдэхүүн: <b>${productLabel}</b>
🎨 Өнгө: <b>${color}</b>
🔢 Тоо: <b>${qty}</b>
💰 Дүн: <b>${total}</b>
📍 Хаяг: <b>${address}</b>
🚪 Орцны код: <b>${entranceCode}</b>
📞 Утас: <b>${phone}</b>
${paymentLine}

👤 Messenger ID: <code>${senderId}</code>
💬 Хариулах: https://m.me/${senderId}

<i>Унтраах: <code>/release ${senderId}</code></i>`;

  await sendTelegram(msg);

  setOrder(senderId, {
    ...parsed,
    orderId,
    total,
    placedAt: Date.now(),
    status: 'placed',
    isCOD
  });
}

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

async function notifyTelegramAttachment(senderId, attType, attUrl = '', caption = '') {
  const urlLine = attUrl ? `🔗 URL: ${attUrl}\n` : '';
  const capLine = caption ? `💬 Тайлбар: <b>${caption.slice(0, 200)}</b>\n` : '';
  const msg = `📎 <b>ATTACHMENT — Гар хариулт шаардлагатай!</b>

📁 Төрөл: <b>${attType}</b>
${capLine}${urlLine}
👤 Messenger ID: <code>${senderId}</code>
💬 Хариулах: https://m.me/${senderId}

<i>Bot хариулахаа зогссон.</i>
<i>Унтраах: <code>/release ${senderId}</code></i>`;
  await sendTelegram(msg);
}

async function notifyTelegramProvince(senderId, text) {
  const msg = `🚛 <b>ОРОН НУТГИЙН ХҮРГЭЛТ!</b>

💬 Хэрэглэгчийн мессеж: <b>${text.slice(0, 200)}</b>

UB-аас гадуур учир тусгай зохицуулалт хэрэгтэй.

👤 Messenger ID: <code>${senderId}</code>
💬 Хариулах: https://m.me/${senderId}

<i>Унтраах: <code>/release ${senderId}</code></i>`;
  await sendTelegram(msg);
}

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

async function notifyTelegramBanned(senderId, hits) {
  const msg = `🛑 <b>LLM ХОРИОТОЙ КОНТЕНТ</b>

👤 Messenger ID: <code>${senderId}</code>
⚠️ Илэрсэн: <b>${hits.join(', ')}</b>

<i>Систем автоматаар цэвэрлэж илгээв. Давтагдвал SYSTEM_PROMPT-г шалгана уу.</i>`;
  await sendTelegram(msg);
}

// =====================================================================
// SYSTEM PROMPT v3.0 — 2026.08.04
//
// v2.9.2 → v3.0 ӨӨРЧЛӨЛТ:
// 🔴 БҮХ markdown (~~зураас~~) УСТГАСАН. Messenger нь markdown-г
//    РЕНДЕРЛЭДЭГГҮЙ — хэрэглэгч "~~269'000₮~~" гэж яг тэр зураастай нь
//    хардаг байсан. Одоо "269'000₮ ➜ 199'900₮" сум ашиглана.
// 🔴 Үнийн тоог LLM ӨӨРӨӨ БИЧИХГҮЙ. [PRICE_BLOCK] / [FILTER_PRICE_BLOCK]
//    tag бичих ба JS орлуулна. (Утасны цифрийн асуудалтай ижил зарчим —
//    4o-mini "199'900"-г "199,900" эсвэл "189'900" болгож гуйвуулж чадна.)
// ➕ Бэлгийн мөр JS-ээс автоматаар хавсрагдана (ensureGiftLine).
// ➕ PREMIUM MODE — материал/чанар/бүтэц/үзэмжийн асуулт детерминистик
//    хариулт авна; хуучин bullet-жагсаалттай "МАТЕРИАЛ" загвар устсан.
// ➕ scrubBanned() — LLM-ийн бүх гаралт хориотой claim-д шалгагдана.
// 🐛 6 live bug зассан: худал цуцлалт (хэрэггүй/аваагүй/болих),
//    Сүхбаатар ДҮҮРЭГ→орон нутаг, "5 шатны байр"→оптын, шүүлтүүрийн
//    захиалгад 199'900₮, зураг+тайлбар хамт ирвэл зураг алдагдах,
//    "За хүлээж байна"→гомдол.
// =====================================================================

const SYSTEM_PROMPT = `Та SkinBloom брэндийн AI туслах "Bloom" юм. Монгол хэлээр товч, найрсаг, дулаан хариулна. Нэг хариултанд 1–3 өгүүлбэрээс ихгүй.

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
0. MESSENGER-ИЙН ХЯЗГААР — ЗААВАЛ УНШ
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
Messenger нь markdown-г РЕНДЕРЛЭДЭГГҮЙ. Дараах тэмдэгтүүд хэрэглэгчид ЯГ
БИЧСЭН ХЭЛБЭРЭЭРЭЭ харагдана — ХЭЗЭЭ Ч БИЧИХГҮЙ:
  ~~зураас~~   **тод**   __доогуур__   <b>tag</b>
Хуучин үнийг зураасалж болохгүй. Оронд нь сум ашигла: 269'000₮ ➜ 199'900₮

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
1. ЭХНИЙ МЭНДЧИЛГЭЭ
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
Хэрэглэгч анх холбогдоход систем өөрөө мэндчилгээ явуулна. Чи мэндчилгээг
ДАХИН давтахгүй — шууд асуултад нь хариул.

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
2. ИНТЕНТ ТАНИХ — ХАМГИЙН ЧУХАЛ ДҮРЭМ
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
Хэрэглэгчийн АНХНЫ интентыг заавал тодорхойл. Хоёрдмол утгатай бол богино тодруулах асуулт тавь.

▸ ШҮРШҮҮР / БАГЦ авах гэж байгаа:
  Keyword: "шүршүүр", "bagts", "бэлгийн багц", "өнгө", "цагаан", "хар", "саарал", "pearl", "obsidian", "slate", "авъя", "захиалъя"
  → Бэлгийн Багц flow руу

▸ ШҮҮЛТҮҮР / FILTER авах гэж байгаа:
  Keyword: "шүүлтүүр захиалъя", "шүүлтүүр авъя", "filter avya", "нөөц шүүлтүүр", "карбон филтер захиалъя", "пилтер", "pilter", "filtr"
  → ЗӨВХӨН нөөц filter flow
  → BUNDLE (шүршүүр, бэлгийн багц) ХЭЗЭЭ Ч САНАЛ БОЛГОХГҮЙ
  → "шүршүүр авах уу, filter авах уу?" гэж АСУУХГҮЙ — хэрэглэгч filter л хүссэн

▸ POST-ИЙН CONFUSION — "ирээгүй", "ийм гэж бодоогүй", "буруу ойлгосон":
  → Эхлээд уян зөвшөөрөл: "Уучлаарай, ойлголтын зөрүү гарсан байна"
  → Дараа нь хүний оператор руу: [HANDOFF_NEEDED]
  → ШУУД шинэ захиалга авч эхлэхгүй

▸ МЭДЭЭЛЭЛ / ҮНЭ хайж байгаа:
  Keyword: "үнэ", "хэд", "хэдэн төгрөг", "price", "юу вэ", "ямар юм бэ"
  → [PRICE_BLOCK] tag (доор заасан)

▸ UGC / КОНТЕНТ / КОЛЛАБ → [HANDOFF_NEEDED]

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
3. БҮТЭЭГДЭХҮҮН — ҮНЭН МЭДЭЭЛЭЛ (skinbloom.store)
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

▸ "SkinBloom Бэлгийн Багц" — 199'900₮ (хуучин үнэ 269'000₮)
  • Бүх 3 өнгө ҮНЭ БА БҮРЭЛДЭХҮҮН ИЖИЛ — "Pearl White 3-в-1" гэж хэзээ ч хэлэхгүй
  • ҮНДСЭН БҮТЭЭГДЭХҮҮН (269'000₮): SkinBloom шүршүүр + урьдчилан СУУРИЛУУЛСАН
    Active Carbon Filter. Энэ хоёр нь салшгүй нэгж.
  • БЭЛЭГ (зөвхөн 2 ширхэг): Brush ба Donut Sponge. Зөвхөн эдгээр л "бэлэг".
  • ⚠️ ШҮҮЛТҮҮРИЙН ТОО: Багцад ганцхан шүүлтүүр багтана — шүршүүрт СУУРИЛУУЛСАН
    Active Carbon Filter. Нэмэлт буюу нөөц шүүлтүүр дагалддаггүй. "2 шүүлтүүр ирнэ",
    "нэг суурилсан дээр нэг нөөц дагалдана" гэж ХЭЗЭЭ Ч хэлэхгүй.
  • ⛔ ШҮҮЛТҮҮРИЙГ "ҮНЭГҮЙ" ГЭЖ ХЭЗЭЭ Ч ТЭМДЭГЛЭХГҮЙ. Шүүлтүүр нь шүршүүрийн
    салшгүй хэсэг — бэлэг БИШ, бонус БИШ. Ийм үг хэллэг нь хүргэлтийн дараа
    "нөөц шүүлтүүр ирнэ гэж бодсон" гэсэн гомдол үүсгэдэг.
  • Хүргэлт үнэгүй. Шүүрхай хүргэлт: +20'000₮ (UBCAB EXPRESS, тухайн өдөртөө)
  • 3 өнгө:
    ⬛ Obsidian Black — мөнгөлөг цагирагтай, premium гүн хар өнгө
    🤍 Pearl White — дулаан гэрэлтэй, цэвэр цайвар төрх
    🩶 Slate Gray — час улаан (crimson) дотоод цагирагтай, тансаг бараан тон

▸ "SkinBloom Карбон Филтер" — нөөц шүүлтүүр
  • Үндсэн үнэ 44'900₮/ш. Хямдрал 2026.09.01 хүртэл.
  • Үнийг ӨӨРӨӨ бичихгүй — [FILTER_PRICE_BLOCK] tag ашигла.
  • Солих давтамж: 4 хүнтэй өрхөд 3 сар тутам, 2 хүнтэй өрхөд 6 сар тутам.

▸ 🔬 ШҮҮЛТҮҮРИЙН БҮТЭЦ — РАДИАЛ 3 ДАВХАР
  Ус ГАДНААС ДОТОГШОО 3 давхрыг дараалан нэвтэрч, дараа нь голын хөндий сувгаар
  ДЭЭШЭЭ урсан шүршүүрийн толгойд хүрнэ.
  1️⃣ Гадна — PP нэхмэл бус бүрхүүл (цагаан): том тоосонцор, элс, зэвийн үлдэгдэл
  2️⃣ Дунд — Active Carbon шахмал цагираг хана (хар): хлор, эвгүй үнэр, органик бодис
  3️⃣ Гол цөм — Нягтаршуулж сайжруулсан PP давхарга: микро тоосонцрын эцсийн шүүлт
  • ⛔ KDF БАЙХГҮЙ. Металл тор БАЙХГҮЙ. "KDF" гэж ХЭЗЭЭ Ч бичихгүй.
  • ⛔ "Хүнд металл шүүнэ", "бактер устгана" гэж ХЭЗЭЭ Ч хэлэхгүй.
  • ✅ Баталгаатай claim зөвхөн: хлор, шохой, тунадас, зэв, эвгүй үнэр

▸ ЧУХАЛ — үнэ бичих формат: "199'900₮" (apostrophe-той). "199,900₮" / "199900₮" БИШ.

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
4. ХАРИУЛТЫН ЗАГВАРУУД
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

▸ ҮНЭ АСУУВАЛ (интент C) — ХАМГИЙН ЧУХАЛ ДҮРЭМ:
  Үнийн блокыг чи ӨӨРӨӨ БИЧИХГҮЙ. Хариултдаа ганц мөрөнд [PRICE_BLOCK] гэж
  бич — систем бодит үнийг орлуулна. Өөр ямар ч тоо бичихгүй.
  Дараа нь онцлог ЖАГСААХГҮЙ — сониуч байдал үлдээ.
  Тийм/үгүй гэж хариулагдах асуултаар ХЭЗЭЭ Ч төгсөхгүй.

  → Хэрэглэгч "дэлгэрэнгүй" / "юу дагалдах вэ" гэвэл ЭНД бэлгүүдийг НЭРЛЭ:
  "Багцад орсон зүйлс:
✅ SkinBloom шүршүүр — Active Carbon Filter суурилуулсан
🪥 Brush — бэлгэнд
🧽 Donut Sponge — бэлгэнд
🚚 Хүргэлт — үнэгүй

Аль өнгийг сонгох уу?"

▸ ШҮРШҮҮРИЙН ӨНГӨ СОНГОХ (интент A):
"Бүх 3 өнгөнд ижил үнэ, ижил бүрэлдэхүүн:

⬛ Obsidian Black — мөнгөлөг цагираг, premium гүн хар
🤍 Pearl White — дулаан гэрэлтэй, цэвэр цайвар төрх
🩶 Slate Gray — час улаан дотоод цагираг, тансаг бараан тон

Та аль өнгийг сонгох вэ?"

▸ ЗӨВХӨН НӨӨЦ FILTER (интент B):
  Хариултдаа [FILTER_PRICE_BLOCK] гэж бич. Тоо ӨӨРӨӨ бичихгүй.
  Bundle (шүршүүр) санал болгохгүй — хэрэглэгч filter л хүссэн.

  → "хамгийн ашигтай нь аль вэ?" гэвэл:
  "3 ширхэгийн багц хамгийн хэмнэлттэй — нэг шүүлтүүр нь 26'633₮-д ирнэ 🌸
  Хямдрал 9-р сарын 1 хүртэл."

▸ FILTER ТООГ АСУУВАЛ (багц авч байгаа явцад):
"Багцад шүршүүрт суурилуулсан ганцхан шүүлтүүр багтана 🌸 Нэмэлт шүүлтүүр дагалддаггүй. 3–6 сард нэг удаа солих ба нөөц шүүлтүүрийг тусад нь авна."

▸ ШҮРШҮҮРИЙГ ТУСД НЬ АВАХ АСУУВАЛ:
"SkinBloom шүршүүр зөвхөн Бэлгийн Багцаар ирдэг 🌸 Багцад Active Carbon Filter аль хэдийн суурилуулсан, дээр нь Brush, Donut Sponge багтсан — тусад нь авснаас хямд. Хожим нөөц шүүлтүүр хэрэгтэй болбол түүнийг тусад нь авч болно."

▸ STOREPAY / ХУВААГДСАН ТӨЛБӨР АСУУВАЛ:
"Манайх одоогоор Storepay-ийг дэмжихгүй байна 🌸 Гэхдээ 2 сонголт бий:

1️⃣ Урьдчилж банкаар шилжүүлэх (Хаан банк)
2️⃣ Барааг авсны дараа жолоочид бэлнээр төлөх

Аль нь танд тохирох вэ?"

▸ ҮНЭ CONFUSION ("599?", "199 биш үү?"):
"199'900₮ — нэг зуун ерэн есөн мянга есөн зуу 🌸"

▸ UGC / STORY MENTION / COLLAB:
"Манай бүтээгдэхүүнийг хуваалцсанд их баярлалаа! 🌸 Хэрэв контент хийх сонирхолтой бол манай баг тантай холбогдох болно. [HANDOFF_NEEDED]"

▸ МАТЕРИАЛ / ЧАНАР / БҮТЭЦ / ҮЗЭМЖИЙН АСУУЛТ:
  Эдгээрийг систем өөрөө боловсруулна (PREMIUM ГОРИМ). Хэрэв тэр асуулт чам
  хүрвэл: bullet жагсаалт БИЧИХГҮЙ, 2–4 өгүүлбэр урссан текстээр, материалыг
  нэрлэж (матт ABS, өнгөлсөн мөнгөлөг цоргот цагираг, зүсэж хээлсэн бариул),
  ҮНЭ ДУРДАЛГҮЙ, сониуч асуултаар төгсгө.

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
5. ЗАХИАЛГЫН FLOW
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

▸ FLOW A — Бэлгийн Багц:
1. Өнгө (Pearl White / Slate Gray / Obsidian Black)
2. Тоо ширхэг
3. Бүрэн хаяг (дүүрэг, хороо, хотхон/байр/тоот/давхар)
4. Орцны код — "байхгүй бол алгасъя" гэж хэл
5. Утасны дугаар (системээр автоматаар шалгагдана — чи оронг нь ТООЛОХГҮЙ)
6. Төлбөрийн арга: "Төлбөрийг яаж хийх вэ? 1️⃣ Урьдчилж банкаар 2️⃣ Авсны дараа жолоочид бэлнээр"

▸ FLOW B — Зөвхөн Filter: 1. Хэдэн ширхэг 2. Хаяг 3. Орцны код 4. Утас 5. Төлбөр

▸ MISSING FIELD ШАЛГАЛТ:
Дутуу талбар байвал ЗӨВХӨН ТЭР НЭГИЙГ л асуу — бүх 6-г дахин давтахгүй.

⛔⛔ УТАСНЫ ДУГААРЫГ ЧИ ШАЛГАХГҮЙ — ХАМГИЙН ЧУХАЛ ДҮРЭМ:
• Дугаарын оронг ХЭЗЭЭ Ч тоолохгүй. Чи тоо тоолж чаддаггүй.
• "8 оронтой оруулна уу", "дугаар буруу байна" гэх мессежийг ХЭЗЭЭ Ч бичихгүй.
• Хэрэглэгч тоо явуулсан бол ТЭР НЬ ЗӨВ гэж үзэж, дараагийн дутуу талбар руу шилж.
• [СИСТЕМИЙН ДОТООД МЭДЭЭЛЭЛ] блокт "Утасны дугаар: ... ✓" байвал дахин асуухыг хатуу хориглоно.

▸ БҮГД БҮРЭН БОЛМОГЦ:
"Таны захиалгыг хүлээн авлаа ✅"
Төлбөрийн арга тодорхой бол tag нэм:
• Урьдчилж банкаар: "Таны захиалгыг хүлээн авлаа ✅ [BANK_ORDER]"
• Жолоочид бэлнээр: "Таны захиалгыг хүлээн авлаа ✅ [COD_ORDER]"
Placeholder [Өнгө], [Хаяг], [Утас] хэлбэрээр БИЧИХГҮЙ — систем рендер хийнэ.

▸ ЗАХИАЛГА ЗАСАХ: "Захиалгын мэдээлэл шинэчлэгдлээ ✅ [ORDER_EDIT]"

▸ ЗАХИАЛГА ЦУЦЛАХ:
🚫 ХЭЗЭЭ Ч cancellation reply бичихгүй. JS код өөрөө handle хийнэ.
"авсны дараа" / "joloochid belneer" нь ЦУЦЛАХ БИШ — COD сонголт → [COD_ORDER].

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
6. ТЕХНИКИЙН МЭДЭЭЛЭЛ
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
• Гарал үүсэл: Европын CE стандартаар Хонгконгт үйлдвэрлэгдэнэ
• CE сертификат: HX240303050484
• Filter бүтэц — РАДИАЛ, гаднаас дотогшоо: PP нэхмэл бус → Active Carbon шахмал цагираг хана → нягтруулсан PP цөм
• ⛔ KDF БАЙХГҮЙ. Металл тор БАЙХГҮЙ. Ceramic БИШ.
• ⛔ "Хүнд металл", "бактер" claim БАЙХГҮЙ
• Шүүлтүүрийн хэмжээ: 148мм × 25мм, бариул дотор бүрэн нуугдсан
• Нэг л горим — өндөр даралт, spa мэдрэмж, 40% усны хэмнэлт
• Rain/massage/mist mode БАЙХГҮЙ
• Усны даралт: 0.1–0.35 MPa · Температур: 0–70°C
• Суурилуулалт: стандарт 1/2 инч ороомгод, 1 минутад

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
7. HANDOFF — ОПЕРАТОР РУУ ШИЛЖҮҮЛЭХ
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
ЭДГЭЭР ТОХИОЛДОЛД ШУУД [HANDOFF_NEEDED]:
• Гомдол / буцаалт / refund
• Нарийн техникийн асуулт хариулж чадахгүй бол
• UGC / influencer / collab
• "Хүнтэй ярих", "оператор", "менежер"
• Очиж үзэх хүсэлт
(Wholesale, орон нутаг, үнийн манипуляцийг JS код өөрөө барина.)

Хариулт: "Манай менежер тантай удахгүй холбогдох болно 🌸 [HANDOFF_NEEDED]"

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
8. ЗУРАГ/БИЧЛЭГ/STICKER ИРҮҮЛСЭН ҮЕД
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
ШУУД handoff: "Зураг/бичлэгийг хүлээн авлаа 🌸 Манай менежер таны мэдээллийг нягталж, шууд хариулах болно. [HANDOFF_NEEDED]"

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
9. БАТАЛГАА & ХОЛБОО БАРИХ
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
• Үйлдвэрийн алдаатай бол 30 хоногийн дотор буцааж солино
• Дэлгүүр: skinbloom.store · Утас: 95999989
• УБ хүргэлт: 24–48 цаг, шүүрхай: +20'000₮

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
10. ХЭЛНИЙ ХАТУУ ДҮРЭМ
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
❌ Markdown (~~зураас~~, **тод**) → ✅ Messenger рендерлэдэггүй, "➜" сум ашигла
❌ Үнийн тоог өөрөө бичих → ✅ [PRICE_BLOCK] / [FILTER_PRICE_BLOCK] tag
❌ "Pearl White 3-в-1 багц" → ✅ "Бэлгийн Багц (Pearl White)"
❌ "ceramic" → ✅ хэрэглэхгүй
❌ "KDF" → ✅ "Нягтаршуулж сайжруулсан PP давхарга"
❌ "Шүүлтүүр үнэгүй" / "шүүлтүүр бэлгээр дагалдана" → ✅ "Active Carbon Filter суурилуулсан"
❌ "хүнд металл шүүнэ" / "бактер устгана" → ✅ "хлор, шохой, зэв, эвгүй үнэр"
❌ "Герман технологи", "нано", "патент", "ион солилцоо" → ✅ зохиохгүй
❌ Материалын асуултад bullet жагсаалт → ✅ 2–4 өгүүлбэр урссан текст
❌ "Rose Red" / "криминал улаан" → ✅ "Slate Gray (дотор час улаан цагираг)"
❌ "шүршүүр хийх" → ✅ "усанд орох"
❌ "199,900₮" → ✅ "199'900₮"
❌ "запас" → ✅ "нөөц"
❌ Хэрэглэгчийн алдаатай үгийг засаж сургах → ✅ хэзээ ч засахгүй

ЧУХАЛ: [HANDOFF_NEEDED], [ORDER_EDIT], [COD_ORDER], [BANK_ORDER], [PRICE_BLOCK],
[FILTER_PRICE_BLOCK] тагуудыг систем боловсруулна — хэрэглэгчид харагдахгүй.`;

const COMMENT_DM_PROMPT = `Та SkinBloom брэндийн AI туслах юм. Facebook/Instagram-д comment бичсэн хэрэглэгчид DM-ээр хариулна.

ДҮРЭМ:
• 1-2 өгүүлбэр, товч, найрсаг
• Нэрээр нь хандана (жишээ: "Сайн байна уу Бат? 🌸")
• Message Request шалгахыг хүс: "Message Request хэсэгээ шалгаарай 🌸"
• Markdown БИЧИХГҮЙ — Messenger рендерлэдэггүй
• Шүүлтүүр асуувал: "Тийм, нөөц Active Carbon Filter байгаа! Дэлгэрэнгүй мэдээлэл явуулсан 🌸"
• Захиалах асуувал: "skinbloom.store-с захиалж болно 🌸"
• "KDF", "хүнд металл", "бактер" гэж ХЭЗЭЭ Ч бичихгүй
• Багц доторх шүүлтүүрийг "үнэгүй" эсвэл "бэлгээр дагалдана" гэж ХЭЗЭЭ Ч бичихгүй`;

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

async function askGPT_DM(senderId, userText, stateNote = null) {
  addToHistory(senderId, 'user', userText);
  const messages = [
    { role: 'system', content: SYSTEM_PROMPT },
    ...getHistory(senderId).slice(-MAX_HISTORY)
  ];
  if (stateNote) messages.push({ role: 'system', content: stateNote });
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
  recordBotMessage(recipientId, text);
  try {
    await axios.post('https://graph.facebook.com/v19.0/me/messages', {
      recipient: { id: recipientId }, message: { text }
    }, { params: { access_token: PAGE_TOKEN } });
    console.log(`✓ DM sent → ${recipientId}`);
  } catch (e) {
    console.error(`✗ DM error → ${recipientId}:`, e.response?.data?.error?.message || e.message);
  }
}

// ── v3.0: Premium макро зураг илгээх ──
async function sendImageDM(recipientId, url) {
  await axios.post('https://graph.facebook.com/v19.0/me/messages', {
    recipient: { id: recipientId },
    message: { attachment: { type: 'image', payload: { url, is_reusable: true } } }
  }, { params: { access_token: PAGE_TOKEN } });
  console.log(`✓ Image sent → ${recipientId}`);
}

async function sendDMWithHumanAgent(recipientId, text) {
  recordBotMessage(recipientId, text);
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
    const cleanText = scrubBanned(dmText.replace('[HANDOFF_NEEDED]', '').trim()).text;
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
      // ── ADMIN/PAGE TAKEOVER DETECT (app_id-based) ──
      if (event.message?.is_echo) {
        const echoText = event.message?.text || '';
        const recipientId = event.recipient?.id;

        if (event.message.app_id) continue;

        if (recipientId && recipientId !== pageId && !humanHandoff.has(recipientId)) {
          addHandoff(recipientId);
          console.log(`🤝 Admin takeover [${recipientId}] — human inbox: "${echoText.slice(0, 40)}"`);
          await notifyTelegramAdminTakeover(recipientId, echoText);
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
      // v3.0 FIX 4: ATTACHMENT HANDLING
      // Тайлбартай зураг (төлбөрийн screenshot + "шилжүүлчихлээ") ч
      // одоо баригдана. Өмнө нь `!text` нөхцөлөөс болж алдагддаг байв.
      // ═══════════════════════════════════════════════════════
      if (shouldHandoffForAttachment(attachments)) {
        const attType = attachments[0]?.type;
        const attUrl = attachments[0]?.payload?.url || '';

        if (isDuplicateAttachment(senderId)) {
          console.log(`⏭ Duplicate attachment — skipping [${senderId}]`);
          continue;
        }

        console.log(`📎 Attachment [${attType}] [${senderId}] → handoff`);
        addHandoff(senderId);
        if (text) addToHistory(senderId, 'user', text);
        try {
          await sendDMWithHumanAgent(senderId, 'Зураг/бичлэгийг хүлээн авлаа 🌸 Манай менежер таны мэдээллийг нягталж, шууд хариулах болно.');
        } catch (e) {
          console.error('Attachment DM send error:', e.message);
        }
        await notifyTelegramAttachment(senderId, attType, attUrl, text || '');
        continue;
      }

      if (!text) continue;

      // ═══════════════════════════════════════════════════════
      // PRIORITY-ORDERED TRIGGER CHECKS
      // ═══════════════════════════════════════════════════════

      // 1) COMPLAINT
      if (isComplaint(text)) {
        console.log(`🚨 Complaint [${senderId}]: ${text.slice(0, 60)}`);
        addHandoff(senderId);
        await sendDMWithHumanAgent(senderId, '🌸 Таны мессежийг хүлээн авлаа. Манай менежер хариуцлагатайгаар тантай удахгүй холбогдох болно.');
        addToHistory(senderId, 'user', text);
        await notifyTelegramComplaint(senderId, text, getHistory(senderId));
        continue;
      }

      // 2) CANCELLATION RECOVERY
      const existingOrder = getOrder(senderId);
      if (existingOrder && existingOrder.cancelStage === 'reason_asked' && isCancellationDenial(text)) {
        console.log(`🔄 Cancellation denial — recovering [${senderId}]: ${text.slice(0, 60)}`);
        addToHistory(senderId, 'user', text);
        delete existingOrder.cancelStage;
        existingOrder.status = 'placed';
        setOrder(senderId, existingOrder);
        await sendDM(senderId, 'Уучлаарай, буруу ойлголоо 🌸 Захиалга тань үргэлжилж байна. Танд өөр асуух зүйл байна уу?');
        await sendTelegram(`🔄 <b>FALSE CANCELLATION — RECOVERED</b>\n\n👤 ID: <code>${senderId}</code>\n💬 Денайл: ${text.slice(0, 150)}\n\n<i>Bot захиалгыг сэргээлээ.</i>`);
        continue;
      }

      // 3) CANCELLATION
      if (isCancellationRequest(text)) {
        console.log(`❌ Cancellation request [${senderId}]: ${text.slice(0, 60)}`);
        addToHistory(senderId, 'user', text);
        if (existingOrder && existingOrder.status === 'placed') {
          if (existingOrder.cancelStage === 'reason_asked') {
            const negativeReplies = /за яахав|битгий асуу|болсон шдээ|hereggu|kheregui|asuukhgui/i;
            const isNegative = negativeReplies.test(text);
            await sendDM(senderId, isNegative
              ? 'Ойлголоо 🌸 Захиалга цуцлагдлаа. Хэзээ ч буцаж ирэхээ мартсаагаарай.'
              : 'Ойлголоо, баярлалаа 🌸 Захиалга цуцлагдлаа. Дараа дахин туршиж үзвэл бид баяртай байх болно.');
            await notifyTelegramCancellation(senderId, isNegative ? '(шалтгаан хэлэхээс татгалзав)' : text, 'cancelled');
            existingOrder.status = 'cancelled';
            setOrder(senderId, existingOrder);
            addHandoff(senderId);
            continue;
          } else {
            await sendDM(senderId, 'Уучлаарай, захиалгыг тань цуцлахаас өмнө бид яагаад болсныг ойлгох сонирхолтой байна 🌸 Танд яагаад тохирохгүй болсон бэ? (хэт удаан / үнэ / өөр сонголт сонирхож байгаа / гэх мэт)');
            existingOrder.cancelStage = 'reason_asked';
            setOrder(senderId, existingOrder);
            await notifyTelegramCancellation(senderId, text, 'requested');
            continue;
          }
        } else {
          addHandoff(senderId);
          await sendDMWithHumanAgent(senderId, '🌸 Таны хүсэлтийг хүлээн авлаа. Манай менежер удахгүй холбогдох болно.');
          await notifyTelegramCancellation(senderId, text, 'requested');
          continue;
        }
      }

      // 4) USER ASKS FOR HUMAN
      if (isUserHandoffRequest(text)) {
        console.log(`🤝 User handoff request [${senderId}]: ${text.slice(0, 60)}`);
        addHandoff(senderId);
        addToHistory(senderId, 'user', text);
        await sendDMWithHumanAgent(senderId, 'Бид одоогоор зөвхөн онлайн зарж байна 🌸 Гэвч таны асуултанд манай менежер дэлгэрэнгүй хариулж, хэрэгтэй мэдээллийг өгөх болно.');
        await notifyTelegramHandoff(senderId, text);
        continue;
      }

      // 5) PROVINCE DELIVERY
      if (isProvinceDelivery(text)) {
        console.log(`🚛 Province delivery [${senderId}]: ${text.slice(0, 60)}`);
        addHandoff(senderId);
        addToHistory(senderId, 'user', text);
        await sendDMWithHumanAgent(senderId, '🌸 Орон нутгийн хүргэлтийн талаар манай менежер тантай холбогдож, хүргэлтийн тариф болон хугацааг тодорхой хэлэх болно.');
        await notifyTelegramProvince(senderId, text);
        continue;
      }

      // 6) WHOLESALE
      if (isWholesaleRequest(text)) {
        console.log(`🏪 Wholesale [${senderId}]: ${text.slice(0, 60)}`);
        addHandoff(senderId);
        addToHistory(senderId, 'user', text);
        await sendDMWithHumanAgent(senderId, '🌸 Олон ширхэгээр авах хүсэлтэд нь баярлалаа! Оптын үнэ болон нөхцлийн талаар манай менежер тантай удахгүй холбогдох болно.');
        await notifyTelegramWholesale(senderId, text);
        continue;
      }

      // 7) PRICE MANIPULATION
      if (isPriceManipulation(text)) {
        console.log(`💸 Price manipulation [${senderId}]: ${text.slice(0, 60)}`);
        addHandoff(senderId);
        addToHistory(senderId, 'user', text);
        await sendDMWithHumanAgent(senderId, 'Манай үнэ нь одоогоор зарлагдсан хямдралтай үнэ юм 🌸 Тусгай нөхцөл, бөөний үнийн талаар манай менежер тантай холбогдоно.');
        await notifyTelegramHandoff(senderId, `[Price manipulation] ${text}`);
        continue;
      }

      // 8) UGC / INFLUENCER (notify only)
      if (isUGCOrInfluencer(text)) {
        console.log(`📸 UGC/Influencer detected [${senderId}]`);
        await notifyTelegramUGC(senderId, text);
      }

      const greetingPattern = /^(сайн уу|sain uu|hi|hello|мэнд|байна уу|baina uu|hey|өө байна уу)/i;
      const isGreeting = greetingPattern.test(text.trim());

      // ═══════════════════════════════════════════════════════
      // DIRECT INFO REQUEST — v3.0 богино загвар
      // ═══════════════════════════════════════════════════════
      if (isDirectInfoRequest(text)) {
        console.log(`ℹ️ Direct info request [${senderId}]`);
        const infoMessage = INFO_TEMPLATE;
        await sendDM(senderId, infoMessage);
        addToHistory(senderId, 'user', text);
        addToHistory(senderId, 'assistant', infoMessage);
        markGreeting(senderId);
        continue;
      }

      // ═══════════════════════════════════════════════════════
      // v3.0 PREMIUM MODE — материал / чанар / бүтэц / үзэмж
      // Canon факт LLM-д даалгахгүй — детерминистик хариулт.
      // Үнэ дурдахгүй, bullet жагсаалтгүй, макро зурагтай.
      // ═══════════════════════════════════════════════════════
      let premiumNoteForThisTurn = null;
      if (isPremiumIntent(text)) {
        const premium = getPremiumAnswer(text);
        if (premium) {
          console.log(`💎 Premium (deterministic) [${senderId}]`);
          addToHistory(senderId, 'user', text);
          addToHistory(senderId, 'assistant', premium);
          await sendDM(senderId, premium); // бэлгийн мөр НЭМЭХГҮЙ (P1 дүрэм)
          const ord = getOrder(senderId) || {};
          await sendPremiumImages(senderId, ord.color);
          continue;
        }
        premiumNoteForThisTurn = PREMIUM_NOTE;
      }

      // ═══════════════════════════════════════════════════════
      // PHONE INPUT VALIDATION — LLM-д ХҮРГЭХГҮЙ
      // ═══════════════════════════════════════════════════════
      const phoneCheck = validatePhoneInput(text);
      if (phoneCheck.isAttempt && !phoneCheck.valid) {
        console.log(`📵 Invalid phone [${senderId}]: "${text.trim()}"`);
        addToHistory(senderId, 'user', text);
        addToHistory(senderId, 'assistant', phoneCheck.message);
        await sendDM(senderId, phoneCheck.message);
        continue;
      }
      if (phoneCheck.isAttempt && phoneCheck.valid) {
        const po = getOrder(senderId) || { status: 'collecting' };
        if (po.phone !== phoneCheck.phone) {
          setOrder(senderId, { ...po, phone: phoneCheck.phone, status: po.status || 'collecting' });
          console.log(`📞 Phone accepted [${senderId}]: ${phoneCheck.phone}`);
        }
      }

      // ═══════════════════════════════════════════════════════
      // BATCH SLOT FILLING
      // ═══════════════════════════════════════════════════════
      const currentOrder = getOrder(senderId) || { status: 'collecting' };
      if (currentOrder.status === 'collecting' || !currentOrder.status) {
        const parsed = parseOrderSlots(text, currentOrder);
        if (parsed.color || parsed.address || parsed.phone || parsed.payment) {
          setOrder(senderId, { ...parsed, status: 'collecting' });
          console.log(`📝 Slot fill [${senderId}]: ${JSON.stringify({
            type: parsed.productType, color: parsed.color, qty: parsed.qty,
            address: parsed.address?.slice(0, 30), phone: parsed.phone,
            payment: parsed.payment, code: parsed.entranceCode
          })}`);
        }
      }

      console.log(`📩 DM [${senderId}]: ${text.slice(0, 60)}`);
      try {
        // ── FIRST-CONTACT GREETING ──
        if (isPureGreeting(text)) {
          if (hasRecentGreeting(senderId)) {
            addToHistory(senderId, 'user', text);
            await sendDM(senderId, 'Тантай ярилцаж байна 🌸 Юу тусалцгаая?');
            continue;
          }
          markGreeting(senderId);
          addToHistory(senderId, 'user', text);
          addToHistory(senderId, 'assistant', GREETING_MESSAGE);
          console.log(`👋 First greeting [${senderId}]`);
          await sendDM(senderId, GREETING_MESSAGE);
          continue;
        }

        if (isGreeting && hasRecentGreeting(senderId)) {
          await sendDM(senderId, 'Тантай ярилцаж байна 🌸 Юу тусалцгаая?');
          addToHistory(senderId, 'user', text);
          continue;
        }
        if (isGreeting) {
          markGreeting(senderId);
        }

        const stateNote = [buildOrderStateNote(senderId), premiumNoteForThisTurn]
          .filter(Boolean).join('\n\n') || null;

        const reply = await askGPT_DM(senderId, text, stateNote);

        const isHandoff = shouldTriggerHandoff(reply);
        const isOrder = isOrderComplete(reply);
        const isCOD = isCODOrder(reply) || reply.includes('[COD_ORDER]');
        const isBank = reply.includes('[BANK_ORDER]');
        const isOrderEdit = reply.includes('[ORDER_EDIT]') || isOrderEditRequest(text);

        let cleanReply = reply;

        // ── v3.0: ҮНИЙН TAG ОРЛУУЛАЛТ ──
        // ⚠️ Энэ нь `.replace(/\[[^\]]+\]/g, '')`-ЭЭС ӨМНӨ байх ЁСТОЙ.
        cleanReply = cleanReply
          .replace(/\[PRICE_BLOCK\]/g, PRICE_TEMPLATE)
          .replace(/\[FILTER_PRICE_BLOCK\]/g, FILTER_PRICE_TEMPLATE);

        cleanReply = cleanReply
          .replace('[HANDOFF_NEEDED]', '')
          .replace('[ORDER_EDIT]', '')
          .replace('[COD_ORDER]', '')
          .replace('[BANK_ORDER]', '')
          .replace('[CANCEL_REASON_ASK]', '')
          .replace('[CANCEL_CONFIRMED]', '')
          .replace(/\[[^\]]+\]/g, '')
          .trim();

        if (/тодруулагдана|to be confirmed/i.test(cleanReply)) {
          cleanReply = cleanReply
            .split('\n')
            .filter(line => !/тодруулагдана|to be confirmed/i.test(line))
            .join('\n')
            .replace(/\n{3,}/g, '\n\n')
            .trim();
        }

        if (!cleanReply) {
          cleanReply = 'Таны захиалгыг хүлээн авлаа ✅';
        }

        // ── GUARD #1: ДАВХАР GREETING ──
        if (cleanReply.includes('SkinBloom AI туслах тантай холбогдлоо')) {
          if (hasRecentGreeting(senderId)) {
            console.log(`🔁 Duplicate greeting suppressed [${senderId}]`);
            cleanReply = 'Өнгө сонгоход туслах уу, эсвэл бэлгийн багцын талаар мэдэхийг хүсэж байна уу? 🌸';
          } else {
            markGreeting(senderId);
          }
        }

        // ── GUARD #2: УТАСНЫ АЛДААНЫ МЕССЕЖ ──
        const stOrder = getOrder(senderId) || {};
        if (stOrder.phone && /8\s*орон|найман орон|дугаар.*буруу|дугаараа.*дахин/i.test(cleanReply)) {
          console.log(`🛑 LLM phone-error suppressed [${senderId}] (phone=${stOrder.phone})`);
          const missing = [];
          if (!stOrder.color && stOrder.productType !== 'FILTER') missing.push('Аль өнгийг сонгох вэ? (Pearl White / Slate Gray / Obsidian Black) 🌸');
          else if (!stOrder.qty) missing.push('Хэдэн ширхэг авах вэ? 🌸');
          else if (!stOrder.address) missing.push('Хүргэлтийн бүрэн хаягаа явуулна уу (дүүрэг, хороо, байр, тоот) 🌸');
          else if (!stOrder.payment) missing.push('Төлбөрийг яаж хийх вэ? 1️⃣ Урьдчилж банкаар 2️⃣ Авсны дараа жолоочид бэлнээр 🌸');
          cleanReply = missing.length
            ? `Дугаарыг тань хүлээн авлаа ✅ ${missing[0]}`
            : 'Дугаарыг тань хүлээн авлаа ✅ Танд өөр тодруулах зүйл байна уу? 🌸';
        }

        // ── v3.0 GUARD #3: BANLIST ──
        const scrub = scrubBanned(cleanReply);
        if (scrub.hits.length) {
          console.log(`🛑 Banned content [${senderId}]: ${scrub.hits.join(', ')}`);
          await notifyTelegramBanned(senderId, scrub.hits);
        }
        cleanReply = scrub.text;

        // ── v3.0: БЭЛГИЙН МӨР (JS-ээс, LLM-д даалгахгүй) ──
        cleanReply = withGift(senderId, cleanReply);

        await sendDM(senderId, cleanReply);

        // ── Захиалга баталгаажсан үед ──
        if (isOrder || isCOD || isBank) {
          console.log(`🛍 Order complete [${senderId}] COD=${isCOD} BANK=${isBank}`);

          const llmAlreadyAssembled = /(?:өнгө|өнгь|color)\s*[:：]/i.test(cleanReply)
            && /(?:хаяг|address)\s*[:：]/i.test(cleanReply)
            && /(?:утас|phone|дугаар)\s*[:：]/i.test(cleanReply)
            && !/тодруулагдана|to be confirmed|байхгүй|тогтоох/i.test(cleanReply);

          const orderState = getOrder(senderId) || {};
          const isFilterOrder = orderState.productType === 'FILTER';
          const hasFullState = (orderState.color || isFilterOrder) && orderState.address && orderState.phone;

          if (!llmAlreadyAssembled && hasFullState) {
            const qty = orderState.qty || 1;
            const total = calcTotal(orderState).text; // v3.0: 199900 hardcode БИШ
            const productLine = isFilterOrder
              ? `📦 Бүтээгдэхүүн: Нөөц Карбон Шүүлтүүр`
              : `🎨 Өнгө: ${orderState.color}`;

            const orderDetails = `📋 Захиалгын мэдээлэл:

${productLine}
🔢 Тоо: ${qty} ширхэг
💰 Нийт: ${total}
📍 Хаяг: ${orderState.address}
📞 Утас: ${orderState.phone}

24–48 цагт хүргэгдэнэ 🌸 Манайхыг сонгосонд баярлалаа!`;
            await sendDM(senderId, orderDetails);
          } else if (!llmAlreadyAssembled && !hasFullState) {
            console.log(`⚠️ Order tag detected but incomplete state — handoff [${senderId}]`);
            addHandoff(senderId);
            await sendDMWithHumanAgent(senderId, '🌸 Захиалгын мэдээллийг нягтлах хэрэгцээтэй учир манай менежер тантай удахгүй холбогдох болно.');
            await notifyTelegramHandoff(senderId, `[INCOMPLETE ORDER] ${text}`);
            continue;
          }

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
            const total = calcTotal(orderStateForCod).text; // v3.0 FIX
            const codMsg = `Хүргэлт ирэхэд жолоочид ${total} төлбөрөө өгнө үү 🌸`;
            await sendDM(senderId, codMsg);
          }

          await notifyTelegramOrder(senderId, getHistory(senderId), isCOD);
        }

        if (isOrderEdit && !isOrder && !isCOD && !isBank) {
          await notifyTelegramOrderEdit(senderId, text);
        }

        if (isHandoff && !isOrder && !isCOD && !isBank) {
          addHandoff(senderId);
          await sendDMWithHumanAgent(senderId, '⏳ Манай менежер удахгүй тантай холбогдох болно 🌸');
          await notifyTelegramHandoff(senderId, text);
          console.log(`🤝 Handoff [${senderId}] — tag`);
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

        if (commenterId === pageId) continue;
        if (!commentText) continue;
        if (!commenterId) continue;
        if (!commentId) continue;

        const dedupeKey = `fb_comment_${commentId}`;
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
        await sendDMToCommenter(commenterId, commenterName, commentText, val.id);
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
  status: '🌸 SkinBloom Bot running', version: '3.0.0',
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
  console.log(`🌸 SkinBloom Bot v3.0.0 listening on port ${PORT}`);
  await registerTelegramWebhook();
  await sendTelegram(`🌸 <b>SkinBloom Bot v3.0 асаалаа!</b>

<b>🎁 Шинэ — Offer Layer:</b>
✅ Бэлгийн мөр JS-ээс автоматаар (LLM-д даалгахгүй)
✅ Гомдол/цуцлалт/төлбөрийн мессежид нэмэгдэхгүй

<b>💰 Шинэ — Үнийн блок:</b>
✅ Markdown ~~зураас~~ БҮРЭН устсан (Messenger рендерлэдэггүй байсан!)
✅ Үнийг LLM бичихгүй — [PRICE_BLOCK] tag, JS орлуулна
✅ 5 мөр, өнгөний асуултаар төгсөнө

<b>💎 Шинэ — Premium горим:</b>
✅ Материал/чанар/бүтэц/үзэмж → детерминистик хариулт
✅ Үнэ дурдахгүй, bullet жагсаалтгүй, макро зурагтай
✅ Banlist guard — KDF/хүнд металл/нано зэрэг автоматаар таслагдана

<b>🐛 6 live bug зассан:</b>
✅ "хэрэггүй" → худал цуцлалт
✅ Сүхбаатар ДҮҮРЭГ → орон нутгийн handoff
✅ "5 шатны байр" → оптын handoff
✅ Шүүлтүүрийн захиалгад 199'900₮ бодогдох
✅ Зураг+тайлбар хамт ирвэл зураг алдагдах
✅ "За хүлээж байна" → гомдол

<b>Командууд:</b>
<code>/help</code> — бүх команд`);
});
