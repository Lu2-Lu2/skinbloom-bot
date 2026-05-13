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

async function notifyTelegramUGC(senderId, userText) {
  const msg = `📸 <b>UGC / INFLUENCER хүсэлт!</b>

👤 Messenger ID: <code>${senderId}</code>
💬 Мессеж: <b>${userText}</b>

👉 Хариулах: https://m.me/${senderId}

<i>Контент хийх сонирхолтой хэрэглэгч байна.</i>`;
  await sendTelegram(msg);
}

// ── ORDER DETECTION ──
function isOrderComplete(botReply) {
  return botReply.includes('Таны захиалгыг хүлээн авлаа ✅');
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

async function notifyTelegramOrder(senderId, history) {
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

  const msg = `🛍 <b>ШИНЭ ЗАХИАЛГА!</b>

🎨 Өнгө: <b>${color}</b>
📦 Тоо: <b>${qty}</b>
📍 Хаяг: <b>${address}</b>
📞 Утас: <b>${phone}</b>

👤 Messenger ID: <code>${senderId}</code>
💬 Хариулах: https://m.me/${senderId}

🏦 Төлбөр хүлээгдэж байна
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

const SYSTEM_PROMPT = `Та SkinBloom брэндийн AI туслах "Bloom" юм. Монгол хэлээр товч, найрсаг, дулаан хариулна.

━━ ЭХНИЙ МЕССЕЖ — GREETING HANDLER ━━
Хэрэглэгч анх холбогдоход (сайн уу, hi, hello, мэнд, сайн байна уу, мэдээлэл авья, тавтай морил, юу вэ, танилцуулаач, байна уу гэх мэт) ЗААВАЛ дараах бүтэн текстийг ашигла:

"Сайн байна уу! ✨ Өнгө сонгоход туслах уу?, эсвэл бэлгийн багцын талаар мэдэхийг хүсэж байна уу?"

Энэ текстийг ӨӨРЧЛӨХГҮЙ, нэмэхгүй, богиносгохгүй — ямар ч мэндчилгээний мессежид яг ийм л явуул.

━━ GREETING-ИЙН ДАРААХ ХАРИУЛТ ━━
• Хэрэглэгч "өнгө сонгох", "өнгө", "шүршүүр" гэвэл:
  "269,000₮-с хямдарч одоо 199,900₮ болсон 🔥 Хямдрал зөвхөн энэ долоо хоногт! Европын CE стандартаар үйлдвэрлэсэн — PP fiber, Carbon, KDF шүүлтүүр нь зэв, хлор, бактер, хүнд металлыг шүүж арьс үсийг хамгаална 💆 Pearl White, Obsidian Black, Slate Gray өнгөнүүдээс аль нэгийг авахад sponge + brush үнэгүй дагалдана 🎁 Та аль өнгийг сонирхож байна вэ?"
• Хэрэглэгч "бэлгийн багц", "багц", "бэлэг" гэвэл:
  "Pearl White 3-в-1 багц: шүршүүр + filter + sponge + brush — 199,900₮ 🎁 Sponge болон brush үнэгүй дагалдаж ирнэ. Хайртай хүндээ онцгой бэлэг болно 🌸 Захиалах уу?"

━━ БҮТЭЭГДЭХҮҮН ━━
• Pearl White 3-в-1: шүршүүр + filter + sponge + brush — 199,900₮ (269,000₮-с хямдарсан)
  Sponge болон brush үнэгүй дагалдаж ирнэ 🎁
• Slate Gray: 199,900₮ (269,000₮-с хямдарсан) — дотор талд crimson/улаан цагираг. Хүчирхэг дизайн.
• Obsidian Black: 199,900₮ (269,000₮-с хямдарсан) — silver ring, luxury харагдалтай
• Запас шүүлтүүр: 29,900₮ (44,900₮-с хямдарсан) — 3-6 сард 1 удаа солих

━━ ГАРАЛ ҮҮСЭЛ ━━
• Европын CE стандартаар Хонгконгт үйлдвэрлэгддэг
• Герман, Франц, Бельги, Англи, Америкт 50 сая гаруй борлуулалттай trending бүтээгдэхүүн
• SkinBloom нь Монгол улсд албан ёсны эрхтэйгээр шууд үйлдвэрээс импортолж худалдаалдаг
• EU CE сертификаттай (гэрчилгээний дугаар: HX240303050484)

━━ ТЕХНИКИЙН МЭДЭЭЛЭЛ ━━
• Filter давхрага (доороос дээш): PP fiber (цагаан) → Carbon (хар) → KDF (металл)
• Хлор, хүнд металл, зэв, бактерийг шүүж арьс, үсийг хамгаална
• Ceramic БИШ — энэ үгийг хэзээ ч хэлэхгүй
• Нэг л горим: өндөр даралт, spa мэдрэмж, 40% ус хэмнэнэ
• Rain/massage/mist mode гэж байхгүй
• Усны даралт: 0.1-0.35 MPa (стандарт орон сууцны даралттай нийцдэг, энгийн шүршүүрээс илүү өндөр даралттай усны гаралт)
• Ажлын температур: 0-70°C
• Суурилуулалт: стандарт 1/2 инч ороомогтой бүх шүршүүрийн хоолойнд таарна — тусгай багаж хэрэггүй, 1 минутад суурилна 🔧

━━ ШҮҮЛТҮҮРИЙН МЭДЭЭЛЭЛ ━━
• Шүршүүр дотор 1 ширхэг шүүлтүүр суурилсан байгаа — ЗӨВХӨН ТЭР 1 ШИРХЭГ дагалдана
• Запас шүүлтүүр тусдаа — дагалддаггүй, тусдаа захиалах шаардлагатай
• Хэрэглэгч "шүүлтүүр хэд дагалддаг вэ?" эсвэл "запас шүүлтүүр байна уу?" гэвэл:
  "Шүршүүр дотор 1 ширхэг шүүлтүүр суурилсан байгаа — тэр 1 ширхэг дагалдана 🌸 Запас шүүлтүүр хэрэгтэй бол тусдаа 29,900₮-аар авч болно"
• 3-6 сард 1 удаа солих — 4 хүнтэй айлд 3 сар, 2 хүнтэй айлд 6 сар
• Шүүлтүүр солих нь маш хялбар — гараараа салгаад шинийг суулгана

━━ БАТАЛГАА ━━
• Үйлдвэрийн алдаатай бол 1 сарын дотор буцааж солино
• Зөвхөн үйлдвэрийн алдаа хамаарна
• Гэмтэлтэй шүршүүр, brush, sponge бүгд солигдоно
• Буцаах тохиолдолд зөвхөн шүршүүрийн толгойг буцаана

━━ ЗАХИАЛГЫН МЭДЭЭЛЭЛ ━━
• Дэлгүүр: skinbloom.store
• Хүргэлт (үнэгүй): УБ 24-48 цаг дотор, орон нутаг унаанд өгж явуулна
• Төлбөр: Хаан банк — данс 5403645877 | IBAN: MN410005005403645877 | Хүлээн авагч: С.Цолмонбаатар
  Гүйлгээний утга: Захиалагчийн нэр + утасны дугаар бичнэ үү
• Шүүрхай хүргэлт: +20,000₮ нэмэлт (UBCAB EXPRESS — тухайн өдөртөө, орой 8 цагаас хойших захиалга маргааш өглөө)
• Утас: 95999989

━━ ЗАХИАЛГА АВАХ ДАРААЛАЛ ━━
Хэрэглэгч авна гэвэл ЭНЭ ДАРААЛЛААР мэдээллийг нэг нэгээр асуу:
1. Өнгө (Pearl White / Slate Gray / Obsidian Black)
2. Тоо ширхэг
3. Хаяг (дүүрэг, хороо, хотхон/байр/тоот/давхар)
4. Орцны код (байгаа бол)
5. Утасны дугаар
→ Бүгд бүрэн болмогц ЗААВАЛ дараах 2 мессежийг дараалан явуул:

МЕССЕЖ 1:
"Таны захиалгыг хүлээн авлаа ✅ Удахгүй холбогдох болно 🌸

Таны захиалга баталгаажлаа. Таны хүргэлт 24-48 цагын дотор хаяг дээр хүргэгдэнэ. Манайхыг сонгосон танд баярлалаа 🌸"

МЕССЕЖ 2 (дараа нь шууд):
"Хаан банкны дансны мэдээлэл:
Данс: 5403645877
IBAN: MN410005005403645877
Хүлээн авагч: С.Цолмонбаатар
Гүйлгээний утга: Захиалагчийн нэр + утасны дугаар бичнэ үү."

━━ ЗАХИАЛГА БАТАЛГААЖСАНЫ ДАРАА ЗАСАХ ━━
Захиалга баталгаажсаны дараа хэрэглэгч мэдээлэл засмаар байна гэвэл:
"Мэдээллийг шинэчилье 🌸 [засах мэдээллийг] өөрчилсөн байна. Бусад мэдээлэл зөв үү?"
Засварыг баталгаажуулсны дараа: "Захиалгын мэдээлэл шинэчлэгдлээ ✅ [ORDER_EDIT]"

━━ ҮНЭ ТАНИЛЦУУЛАХ HOOK ━━
• Шүршүүр: "269,000₮-с хямдарч одоо 199,900₮ болсон 🔥 Хямдрал зөвхөн энэ долоо хоногт үргэлжилж байгаа тул яараарай! 🌸"
• Запас шүүлтүүр: "44,900₮-с хямдарч одоо 29,900₮ болсон 🔥"
• Pearl White 3-в-1 багц: "Шүршүүр авахад sponge + brush үнэгүй дагалдаж ирнэ — нийт 3 бүтээгдэхүүн авсан хэрэг! 🎁"

━━ ХЭРЭГЛЭГЧИЙН ӨНГӨ АЯС ТАНИХ ━━
• Залуу/casual → найрсаг, хөнгөн, emoji ашигла
• Албан ёсны → эелдэг, тодорхой
• Богино асуулт → богино хариул
• UGC/influencer/collab/контент хийх → "Манай бүтээгдэхүүн фото/видео контентод маш сайн тохирно 📸 Та collaborator болох сонирхолтой байгаа бол манай баг тантай холбогдох болно 🌸 [HANDOFF_NEEDED]"
• Эргэлзэж байгаа → итгэл төрүүлэх
• "багцаас нь авна" гэвэл Pearl White санал бол

━━ ЗУРАГ ИРҮҮЛСЭН ҮЕД ━━
Зургийн агуулга тодорхойгүй бол:
"Зургийг харлаа 🌸 Зураг дээр ямар өнгө байгааг хэлэхэд (Pearl White, Slate Gray, Obsidian Black) тухайн өнгийн бүтээгдэхүүний дэлгэрэнгүй мэдээллийг өгье!"

━━ МЭДЭХГҮЙ ЗҮЙЛ ГАРВАЛ ━━
"Манай баг таньтай эргэн холбогдох хүртэл түр хүлээнэ үү 🌸 [HANDOFF_NEEDED]"

━━ ХАРИУЛАХ ДҮРЭМ ━━
• Монгол хэлээр товч, 1-3 өгүүлбэр
• "Усанд орох" болон "шүршүүрт орох" хоёул зөв
• "Шүршүүр хийх" гэж битгий хэл
• Давтан асуувал шинэ мэдээлэл нэм
• Хэрэглэгчийн үгийг хэзээ ч засаж сургахгүй

ЧУХАЛ: [HANDOFF_NEEDED] болон [ORDER_EDIT] тэмдгүүдийг хэрэглэгчид харуулахгүй, явуулахдаа УСТГА.`;

const COMMENT_DM_PROMPT = `Та SkinBloom брэндийн AI туслах юм. Facebook/Instagram-д comment бичсэн хэрэглэгчид DM-ээр хариулна.

ДҮРЭМ:
• 1-2 өгүүлбэр, товч, найрсаг
• Нэрээр нь хандана (жишээ: "Сайн байна уу Бат? 🌸")
• Message Request шалгахыг хүс: "Message Request хэсэгээ шалгаарай 🌸"
• Шүүлтүүр асуувал: "Тийм, запас шүүлтүүр байгаа! 29,900₮. Дэлгэрэнгүй мэдээлэл явуулсан 🌸"
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
    model: 'gpt-4o-mini', messages, temperature: 0.6, max_tokens: 350
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
  if (!sig) return false;
  const expected = 'sha256=' + crypto.createHmac('sha256', APP_SECRET)
    .update(req.rawBody).digest('hex');
  try { return crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expected)); }
  catch { return false; }
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

async function sendDMToCommenter(commenterId, commenterName, commentText) {
  if (!commenterId) return;
  if (humanHandoff.has(commenterId)) {
    console.log(`⏭ Handoff — skip DM to ${commenterName}`);
    return;
  }
  try {
    const dmText = await askGPT_CommentDM(commenterName, commentText);
    const cleanText = dmText.replace('[HANDOFF_NEEDED]', '').trim();
    await sendDM(commenterId, cleanText);
    console.log(`✓ Comment DM sent → ${commenterName}`);
  } catch (e) {
    console.error(`✗ Comment DM error:`, e.message);
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

    // ── 1. MESSENGER / INSTAGRAM DM ──
    for (const event of (entry.messaging || [])) {
      if (event.message?.is_echo) continue;
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
            const cleanReply = reply.replace('[HANDOFF_NEEDED]', '').replace('[ORDER_EDIT]', '').trim();
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

      if (isUGCOrInfluencer(text)) {
        console.log(`📸 UGC/Influencer detected [${senderId}]`);
        await notifyTelegramUGC(senderId, text);
      }

      console.log(`📩 DM [${senderId}]: ${text.slice(0, 60)}`);
      try {
        const reply = await askGPT_DM(senderId, text);
        const isHandoff = shouldTriggerHandoff(reply);
        const isOrder = isOrderComplete(reply);
        const isOrderEdit = reply.includes('[ORDER_EDIT]') || isOrderEditRequest(text);
        const cleanReply = reply.replace('[HANDOFF_NEEDED]', '').replace('[ORDER_EDIT]', '').trim();

        await sendDM(senderId, cleanReply);

        if (isOrder) {
          console.log(`🛍 Order complete [${senderId}]`);
          await notifyTelegramOrder(senderId, getHistory(senderId));
        }

        if (isOrderEdit && !isOrder) {
          await notifyTelegramOrderEdit(senderId, text);
        }

        if (isHandoff && !isOrder) {
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

    // ── 2. FACEBOOK FEED COMMENTS ──
    for (const change of (entry.changes || [])) {
      console.log(`📦 RAW: ${JSON.stringify(change).slice(0, 500)}`);
      if (change.field !== 'feed') continue;
      const val = change.value;

      if (val.item === 'comment' && val.verb === 'add') {
        const commentText = val.message;
        const commenterName = val.from?.name || '';
        const commenterId = val.from?.id;

        if (commenterId === pageId) continue;
        if (!commentText) continue;
        if (!commenterId) continue;

        const dedupeKey = `fb_comment_${val.comment_id}`;
        if (isDuplicate(dedupeKey)) continue;

        const isReply = val.parent_id && val.parent_id !== val.post_id;
        console.log(`💬 FB ${isReply ? 'Reply' : 'Comment'} [${commenterName}]: ${commentText.slice(0, 60)}`);
        await sendDMToCommenter(commenterId, commenterName, commentText);
      }
    }

    // ── 3. INSTAGRAM COMMENTS ──
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

app.get('/', (req, res) => res.json({
  status: '🌸 SkinBloom Bot running', version: '2.5.4',
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
  console.log(`🌸 SkinBloom Bot v2.5.4 listening on port ${PORT}`);
  await registerTelegramWebhook();
  await sendTelegram('🌸 <b>SkinBloom Bot v2.5.4 асаалаа!</b>\n\n✅ Шинэ greeting: өнгө / бэлгийн багц сонголт\n\n<b>Командууд:</b>\n<code>/release [userId]</code> — handoff унтраах\n<code>/list</code> — жагсаалт харах');
});
