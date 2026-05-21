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

const SYSTEM_PROMPT = `Та SkinBloom брэндийн AI туслах "Bloom" юм. Монгол хэлээр товч, найрсаг, дулаан хариулна.

━━ ЭХНИЙ МЕССЕЖ — GREETING HANDLER ━━
Хэрэглэгч анх холбогдоход (сайн уу, hi, hello, мэнд, сайн байна уу, мэдээлэл авья, тавтай морил, юу вэ, танилцуулаач, байна уу гэх мэт) ЗААВАЛ дараах бүтэн текстийг ашигла:

"Сайн байна уу! ✨ Өнгө сонгоход туслах уу?, эсвэл бэлгийн багцын талаар мэдэхийг хүсэж байна уу?"

Энэ текстийг ӨӨРЧЛӨХГҮЙ, нэмэхгүй, богиносгохгүй — ямар ч мэндчилгээний мессежид яг ийм л явуул.

━━ GREETING-ИЙН ДАРААХ ХАРИУЛТ ━━
• Хэрэглэгч "өнгө сонгох", "өнгө", "шүршүүр" гэвэл:
  "199,900₮-д багц бүрэн 🔥 Европын CE стандартаар үйлдвэрлэсэн — Active Carbon Filter + Brush + Donut Sponge үнэгүй дагалдана, нийт 93,900₮ хэмнэнэ!

3 өнгөнөөс сонго:
⬛ Obsidian Black — silver ring, luxury гялалзсан дизайн. Эрэгтэй, эмэгтэй хоёулаа сонгодог өнгө 🖤
🤍 Pearl White — арьс үсэндээ анхаарал тавьдаг хүмүүсийн 1-р сонголт. Цэвэр, гэрэлтсэн мэдрэмж ✨
🩶 Slate Gray — аль ч interior-тай нийцдэг universal өнгө. Дотор талын crimson цагираг нь нууцлаг, sophisticated 🌹

Та аль өнгийг сонирхож байна вэ?"

• Хэрэглэгч "бэлгийн багц", "багц", "бэлэг" гэвэл:
  "Pearl White 3-в-1 багц: шүршүүр + Active Carbon Filter + Donut Sponge + Brush — 199,900₮ 🎁 Filter (44,900₮) + Brush (24,500₮) + Sponge (24,500₮) үнэгүй дагалдаж ирнэ. Нийт 93,900₮ хэмнэнэ! Хайртай хүндээ онцгой бэлэг болно 🌸 Захиалах уу?"

━━ БҮТЭЭГДЭХҮҮН ━━
• Pearl White 3-в-1: шүршүүр + Active Carbon Filter + Donut Sponge + Brush — 199,900₮
  Filter (44,900₮) + Brush (24,500₮) + Sponge (24,500₮) үнэгүй дагалдаж ирнэ 🎁 Нийт 93,900₮ хэмнэнэ!
• Slate Gray: 199,900₮ — дотор талд crimson/улаан цагираг. Нууцлаг, sophisticated дизайн.
• Obsidian Black: 199,900₮ — silver ring, luxury гялалзсан дизайн. Эрэгтэй, эмэгтэй хоёулаа сонгодог.
• Active Carbon Filter: 29,900₮ ~~44,900₮~~ — 3-6 сард 1 удаа солих

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

• Хэрэглэгч шүршүүрийн материал, бүтэц, чанар асуувал:
  "SkinBloom шүршүүр Европын CE стандартаар үйлдвэрлэгдсэн 🏆

🔩 Бие: матлаг хуванцар (ABS) — бат бөх, хүрэхэд тухтай
💧 Нүүр хавтан: нягт ганжуурласан тунгалаг хавтан — усны урсгал жигд, тэгш гардаг
💍 Цагираг: зэврэлтэнд тэсвэртэй гангаар хийгдсэн, гялтганасан өнгөлгөөтэй
✋ Бариул: нойтон гарт гулсдаггүй хонхорхой хээтэй гадаргуу

CE гэрчилгээний дугаар: HX240303050484"

━━ ШҮҮЛТҮҮРИЙН МЭДЭЭЛЭЛ ━━
• Шүршүүр дотор 1 ширхэг Active Carbon Filter суурилсан байгаа — ЗӨВХӨН ТЭР 1 ШИРХЭГ дагалдана
• Нөөц filter тусдаа — дагалддаггүй, тусдаа захиалах шаардлагатай
• Хэрэглэгч "шүүлтүүр хэд дагалддаг вэ?" эсвэл "нөөц шүүлтүүр байна уу?" гэвэл:
  "Шүршүүр дотор 1 ширхэг Active Carbon Filter суурилсан байгаа — тэр 1 ширхэг дагалдана 🌸 Нөөц filter хэрэгтэй бол тусдаа 29,900₮ ~~44,900₮~~-аар авч болно"
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
• Шүүрхай хүргэлт: +20,000₮ нэмэлт (UBCAB EXPRESS — тухайн өдөртөө, орой 8 цагаас хойших захиалга маргааш өглөө)
• Утас: 95999989

━━ ТӨЛБӨРИЙН СОНГОЛТ ━━
Захиалга авах үед хэрэглэгчээс ЗААВАЛ төлбөрийн аргыг асуу:

"Төлбөрийг яаж хийх вэ?
1️⃣ Урьдчилж банкаар шилжүүлэх
2️⃣ Барааг авсны дараа жолоочид бэлнээр өгөх"

• Хэрэглэгч 1 сонговол (урьдчилж төлөх):
  → Захиалга баталгаажуулах МЕССЕЖ 1 + МЕССЕЖ 2 (банкны мэдээлэл) дараалан явуул
• Хэрэглэгч 2 сонговол (авсны дараа бэлнээр):
  → Захиалга баталгаажуулах МЕССЕЖ 1 + МЕССЕЖ 3 (COD) дараалан явуул

━━ ЗАХИАЛГА АВАХ ДАРААЛАЛ ━━
Хэрэглэгч авна гэвэл ЭНЭ ДАРААЛЛААР мэдээллийг нэг нэгээр асуу:
1. Өнгө (Pearl White / Slate Gray / Obsidian Black)
2. Тоо ширхэг
3. Хаяг (дүүрэг, хороо, хотхон/байр/тоот/давхар)
4. Орцны код (байгаа бол)
5. Утасны дугаар
6. Төлбөрийн арга (урьдчилж шилжүүлэх / авсны дараа бэлнээр)

→ Бүгд бүрэн болмогц ЗААВАЛ дараах мессежүүдийг дараалан явуул:

МЕССЕЖ 1 (бүх тохиолдолд):
"Таны захиалгыг хүлээн авлаа ✅ Удахгүй холбогдох болно 🌸

Таны захиалга баталгаажлаа. Таны хүргэлт 24-48 цагын дотор хаяг дээр хүргэгдэнэ. Манайхыг сонгосон танд баярлалаа 🌸"

МЕССЕЖ 2 (зөвхөн урьдчилж шилжүүлэх үед):
"Хаан банкны дансны мэдээлэл:
Данс: 5403645877
IBAN: MN410005005403645877
Хүлээн авагч: С.Цолмонбаатар
Гүйлгээний утга: Захиалагчийн нэр + утасны дугаар бичнэ үү."

МЕССЕЖ 3 (зөвхөн авсны дараа бэлнээр үед):
"Таны захиалга баталгаажлаа 🌸 Хүргэлтийн жолооч барааг хүргэх үед бэлнээр 199,900₮ төлнө үү. [COD_ORDER]"

━━ ЗАХИАЛГА БАТАЛГААЖСАНЫ ДАРАА ЗАСАХ ━━
Захиалга баталгаажсаны дараа хэрэглэгч мэдээлэл засмаар байна гэвэл:
"Мэдээллийг шинэчилье 🌸 [засах мэдээллийг] өөрчилсөн байна. Бусад мэдээлэл зөв үү?"
Засварыг баталгаажуулсны дараа: "Захиалгын мэдээлэл шинэчлэгдлээ ✅ [ORDER_EDIT]"

━━ ҮНЭ ТАНИЛЦУУЛАХ HOOK ━━
Хэрэглэгч "үнэ", "хэд вэ", "хэдэн төгрөг", "хэд байна", "price", "хямд уу" гэвэл ЗААВАЛ дараах бүтэн текстийг өөрчлөлгүй ашигла:

"Багцад орсон зүйлс:
✅ Шүүлтүүрт шүршүүр
🧴 Active Carbon Filter (44,900₮) — үнэгүй
🪥 Арьс арчилгааны Brush (24,500₮) — үнэгүй
🧽 Donut Sponge (24,500₮) — үнэгүй
🚚 Хүргэлт — үнэгүй

199,900₮ ~~269,000₮~~ (69,100₮ хэмнэнэ 🔥)
Багцаар аваад ихийг хэмнэ!

3 өнгөнөөс сонго:
⬛ Obsidian Black — silver ring, luxury гялалзсан дизайн 🖤
🤍 Pearl White — арьс үсэндээ анхаарал тавьдагсдын 1-р сонголт ✨
🩶 Slate Gray — universal, дотор талд нууцлаг crimson цагираг 🌹

Та аль өнгийг сонирхож байна вэ?"

• Нөөц Active Carbon Filter тусдаа асуувал: "44,900₮-с хямдарч одоо 29,900₮ болсон 🔥"

━━ ХЭРЭГЛЭГЧИЙН ӨНГӨ АЯС ТАНИХ ━━
• "хэр сайн бэ", "яаж байна", "her sain bee", "сайн уу яаж" гэвэл:
  "Маш сайн байна, баярлалаа! ✨ Шүршүүрийн толгой болон Active Carbon Filter, дагалдах Donut Sponge & Brush хэрэгсэл маш сайн чанартай учраас эдэлгээ удаан байдаг — гарын авалга ч дагалддаг 🌸 Та ямар бүтээгдэхүүн сонирхож байна вэ?"
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

ЧУХАЛ: [HANDOFF_NEEDED], [ORDER_EDIT], [COD_ORDER] тэмдгүүдийг хэрэглэгчид харуулахгүй, явуулахдаа УСТГА.`;

const COMMENT_DM_PROMPT = `Та SkinBloom брэндийн AI туслах юм. Facebook/Instagram-д comment бичсэн хэрэглэгчид DM-ээр хариулна.

ДҮРЭМ:
• 1-2 өгүүлбэр, товч, найрсаг
• Нэрээр нь хандана (жишээ: "Сайн байна уу Бат? 🌸")
• Message Request шалгахыг хүс: "Message Request хэсэгээ шалгаарай 🌸"
• Шүүлтүүр асуувал: "Тийм, нөөц Active Carbon Filter байгаа! 29,900₮. Дэлгэрэнгүй мэдээлэл явуулсан 🌸"
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
  status: '🌸 SkinBloom Bot running', version: '2.5.9',
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
  console.log(`🌸 SkinBloom Bot v2.5.9 listening on port ${PORT}`);
  await registerTelegramWebhook();
  await sendTelegram('🌸 <b>SkinBloom Bot v2.5.9 асаалаа!</b>\n\n✅ COD (авсны дараа бэлнээр) feature нэмэгдлээ\n\n<b>Командууд:</b>\n<code>/release [userId]</code> — handoff унтраах\n<code>/list</code> — жагсаалт харах');
});
