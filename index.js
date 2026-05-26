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

// ── HANDOFF DETECTION ──
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
  let color = '—', qty = '—', address = '—', phone = '—';
  const fullText = messages.map(m => m.content).join(' ');

  const colorMatch = fullText.match(/(Pearl White|Slate Gray|Obsidian Black)/i);
  if (colorMatch) color = colorMatch[1];

  const qtyMatch = fullText.match(/(\d+)\s*(ширхэг|ш\.?)/i);
  if (qtyMatch) qty = qtyMatch[1] + ' ширхэг';

  const phoneMatch = fullText.match(/(\d{8})/);
  if (phoneMatch) phone = phoneMatch[1];

  const userMessages = messages.filter(m => m.role === 'user');
  const longMsg = userMessages.find(m => m.content.length > 20 && /дүүрэг|хороо|байр|хотхон|гудамж/i.test(m.content));
  if (longMsg) address = longMsg.content;

  const paymentLine = isCOD
    ? '💵 Төлбөр: <b>ЖОЛООЧИД БЭЛНЭЭР (COD)</b>'
    : '🏦 Төлбөр хүлээгдэж байна';

  const msg = `🛍 <b>ШИНЭ ЗАХИАЛГА${isCOD ? ' — COD' : ''}!</b>

🎨 Өнгө: <b>${color}</b>
📦 Тоо: <b>${qty}</b>
📍 Хаяг: <b>${address}</b>
📞 Утас: <b>${phone}</b>
${paymentLine}

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
// SYSTEM PROMPT v2.7.0 — 2026.05.25
// v2.6.1 → v2.7.0 fixes:
// • Complaint detection — гомдол үг ороход автомат handoff + Telegram alert
// • Admin takeover detect — Owner "Manager/менежер" гэж бичихэд автомат handoff
// • Draft variants generator — 3 хувилбарт мессеж Telegram-руу
// • /send, /dm, /draft, /help командууд нэмэгдсэн
// Засагдсан: intent detection, үнэ format, filter vs bundle split,
// storepay alternatives, story/UGC handler, missing field detection,
// "Pearl White 3-в-1" буруу framing устгасан
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
  → ЗӨВХӨН 29'900₮ запас filter flow
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
  • Дотор нь: Шүршүүр + Active Carbon Filter (44'900₮) + Brush (24'500₮) + Donut Sponge (24'500₮) — бүгд үнэгүй
  • Анх 269'000₮ → одоо 199'900₮ (69'100₮ хэмнэлт)
  • Хүргэлт үнэгүй
  • Шүүрхай хүргэлт: +20'000₮ (UBCAB EXPRESS, тухайн өдөртөө)
  • 3 өнгө:
    ⬛ Obsidian Black — мөнгөн цагираг, тансаг luxury
    🤍 Pearl White — цэвэр, гэрэлтсэн, арьс үсэнд анхаардаг хүмүүсийн сонголт
    🩶 Slate Gray — universal, дотор талд crimson (улаан) цагираг

▸ "SkinBloom Карбон Филтер" — запас
  • Single Pack 1 ширхэг — 29'900₮ (~~44'900₮~~) — БЭЛЭН
  • Twin Pack 2 ширхэг — 54'900₮ — Хүлээгдэж байна (6 сарын 6)
  • Family Pack 3 ширхэг — 79'900₮ — Хүлээгдэж байна (6 сарын 6)
  • Солих давтамж: 4 хүнтэй айлд 3 сарт 1 удаа, 2 хүнтэй айлд 6 сарт 1 удаа

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

▸ ЗӨВХӨН ЗАПАС FILTER ЗАХИАЛАХ (интент B):
"Запас Active Carbon Filter байгаа 🌸

🔹 Single Pack 1 ширхэг — 29'900₮ (~~44'900₮~~) — БЭЛЭН
🔹 Twin Pack 2 ширхэг — 54'900₮ — Хүлээгдэж байна 6.6
🔹 Family Pack 3 ширхэг — 79'900₮ — Хүлээгдэж байна 6.6

Та аль хувилбарыг авах вэ?"

  → Хэрэглэгч Twin/Family сонговол:
  "Twin/Family Pack одоогоор нөөцгүй, 6 сарын 6-нд ирэх төлөвтэй 🌸 Хүлээх боломжтой бол захиалга авч болно, эсвэл одоо Single Pack 29'900₮ авч болно."

  → Bundle (шүршүүр) санал болгохгүй — хэрэглэгч filter л хүссэн

▸ ҮНЭ АСУУВАЛ — БОГИНО HOOK (интент C):
"🎁 Бэлгийн Багц — 199'900₮ (~~269'000₮~~)
69'100₮ хэмнэнэ 🔥 Хүргэлт үнэгүй

Дэлгэрэнгүй мэдэх үү, эсвэл өнгө сонгох уу?"

  → Хэрэглэгч "дэлгэрэнгүй" / "юу дагалдах вэ" гэвэл:
  "Багцад орсон зүйлс:
✅ Шүүлтүүртэй шүршүүр
🧴 Active Carbon Filter (44'900₮) — үнэгүй
🪥 Brush (24'500₮) — үнэгүй
🧽 Donut Sponge (24'500₮) — үнэгүй
🚚 Хүргэлт — үнэгүй

Нийт хэмнэлт: 69'100₮ 🔥"

▸ FILTER ТООГ АСУУВАЛ (багц авч байгаа явцад):
"Багц авбал шүршүүр дотор 1 шүүлтүүр суурилсан — тэр 1 ширхэг дагалдана 🌸 3–6 сард 1 удаа солих шаардлагатай."

▸ ЗАПАС FILTER ҮНЭ АСУУВАЛ (тусдаа):
"Запас filter 1 ширхэг — 29'900₮ 🌸 (анх 44'900₮ байсан)"

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
1. Хэдэн ширхэг (Single/Twin/Family — Twin/Family хүлээгдэж байна 6.6)
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

МЕССЕЖ 1 (бүх тохиолдолд):
"Таны захиалгыг хүлээн авлаа ✅

[Өнгө] × [Тоо] — [Нийт үнэ]₮
📍 [Хаяг]
📞 [Утас]

24–48 цагт хүргэгдэнэ 🌸 Манайхыг сонгосонд баярлалаа!"

МЕССЕЖ 2 (урьдчилж банкаар төлөх үед):
"Хаан банк:
💳 5403645877
👤 С.Цолмонбаатар
IBAN: MN410005005403645877
✍️ Гүйлгээний утга: [Нэр] + [Утас]"

МЕССЕЖ 3 (авсны дараа бэлнээр — COD):
"Хүргэлтийн жолоочид [Нийт үнэ]₮ бэлнээр төлнө үү 🌸 Бэлэн мөнгө бэлдэж байгаарай. [COD_ORDER]"

▸ ЗАХИАЛГА БАТАЛГААЖСАНЫ ДАРАА ЗАСАХ:
"Мэдээллийг шинэчилье 🌸 [Засах зүйл]-г өөрчиллөө. Бусад мэдээлэл зөв үү?"
Засвар баталгаажсаны дараа: "Захиалгын мэдээлэл шинэчлэгдлээ ✅ [ORDER_EDIT]"

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
Дараах тохиолдолд handoff хийнэ:
• Гомдол / буцаалт / refund
• Wholesale (>5 ширхэг)
• Нарийн техникийн асуулт хариулж чадахгүй бол
• UGC / influencer / collab
• "Хүнтэй ярих", "оператор", "менежер" гэх мэт

Хариулт: "Манай менежер тантай удахгүй холбогдох болно 🌸 [HANDOFF_NEEDED]"

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
8. ЗУРАГ ИРҮҮЛСЭН ҮЕД
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
Зургийн агуулга тодорхойгүй бол:
"Зургийг харлаа 🌸 Зураг дээр ямар өнгө байгааг хэлэхэд (Pearl White, Slate Gray, Obsidian Black) тухайн өнгийн мэдээллийг өгье!"

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

      if (!text && attachments?.length > 0) {
        const attType = attachments[0]?.type;
        if (['image', 'video', 'sticker'].includes(attType)) {
          const attUrl = attachments[0]?.payload?.url || '';
          const attContext = attType === 'image'
            ? `[Хэрэглэгч зураг илгээлээ${attUrl ? ' — URL: ' + attUrl : ''}. Зургийн агуулга тодорхойгүй байж болно. Хэрэв өнгө эсвэл бүтээгдэхүүн таних боломжгүй бол хэрэглэгчээс зураг дээрх өнгийг (Pearl White, Slate Gray, Obsidian Black) хэлж өгөхийг хүс.]`
            : `[Хэрэглэгч ${attType} илгээлээ. Юу хэрэгтэйг нь эелдэгээр асуу.]`;
          try {
            const reply = await askGPT_DM(senderId, attContext);
            const isHandoff = shouldTriggerHandoff(reply);
            const cleanReply = reply.replace('[HANDOFF_NEEDED]', '').replace('[ORDER_EDIT]', '').replace('[COD_ORDER]', '').trim();
            await sendDM(senderId, cleanReply);
            if (isHandoff) {
              addHandoff(senderId);
              await notifyTelegramHandoff(senderId, `[${attType} илгээлээ]`);
            }
          } catch (e) {
            await sendDM(senderId, 'Зургийг харлаа 🌸 Зураг дээр ямар өнгө байгааг хэлэхэд (Pearl White, Slate Gray, Obsidian Black) тухайн өнгийн дэлгэрэнгүй мэдээллийг өгье!');
          }
        }
        continue;
      }

      if (!text) continue;

      // ── COMPLAINT DETECTION — ХАМГИЙН ӨНДӨР ПРИОРИТЕТ ──
      // Хэрэглэгч санал гомдол мэдүүлбэл Bot хариулахгүй, шууд handoff + Telegram-руу 3 draft
      if (isComplaint(text)) {
        console.log(`🚨 Complaint detected [${senderId}]: ${text.slice(0, 60)}`);
        addHandoff(senderId);
        // Хэрэглэгчид холбогдох мэдэгдэл явуулна
        await sendDMWithHumanAgent(senderId, '🌸 Таны мессежийг хүлээн авлаа. Манай менежер хариуцлагатайгаар тантай удахгүй холбогдох болно.');
        // Тухайн user-ын яриаг history-д бүртгэх (draft generation-д хэрэглэх)
        addToHistory(senderId, 'user', text);
        // Telegram-руу 3 draft variant санал
        await notifyTelegramComplaint(senderId, text, getHistory(senderId));
        continue;
      }

      if (isUGCOrInfluencer(text)) {
        console.log(`📸 UGC/Influencer detected [${senderId}]`);
        await notifyTelegramUGC(senderId, text);
      }

      console.log(`📩 DM [${senderId}]: ${text.slice(0, 60)}`);
      try {
        const reply = await askGPT_DM(senderId, text);
        const isHandoff = shouldTriggerHandoff(reply);
        const isOrder = isOrderComplete(reply);
        const isCOD = isCODOrder(reply);
        const isOrderEdit = reply.includes('[ORDER_EDIT]') || isOrderEditRequest(text);
        const cleanReply = reply.replace('[HANDOFF_NEEDED]', '').replace('[ORDER_EDIT]', '').replace('[COD_ORDER]', '').trim();

        await sendDM(senderId, cleanReply);

        if (isOrder || isCOD) {
          console.log(`🛍 Order complete [${senderId}] COD=${isCOD}`);
          await notifyTelegramOrder(senderId, getHistory(senderId), isCOD);
        }

        if (isOrderEdit && !isOrder && !isCOD) {
          await notifyTelegramOrderEdit(senderId, text);
        }

        if (isHandoff && !isOrder && !isCOD) {
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
  status: '🌸 SkinBloom Bot running', version: '2.7.0',
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
  console.log(`🌸 SkinBloom Bot v2.7.0 listening on port ${PORT}`);
  await registerTelegramWebhook();
  await sendTelegram('🌸 <b>SkinBloom Bot v2.7.0 асаалаа!</b>\n\n🆕 <b>Шинэ:</b>\n✅ Гомдол автомат detect + Telegram alert\n✅ Admin takeover (Manager бичихэд handoff)\n✅ 3 хувилбарт draft GPT-аар\n✅ /send, /dm, /draft, /help командууд\n\n<b>Командууд:</b>\n<code>/help</code> — бүх команд\n<code>/list</code> — handoff list\n<code>/release [id]</code> — handoff унтраах\n<code>/send [id] [1|2|3]</code> — draft илгээх\n<code>/dm [id] [text]</code> — гар мессеж\n<code>/draft [id]</code> — шинэ draft');
});
