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
// senderId → { orderType, color, qty, address, entranceCode, phone, payment, total, placedAt, status }
// status: 'collecting' | 'placed' | 'edit_pending' | 'cancel_reason_pending' | 'cancelled'
// orderType (v2.9.3): 'BUNDLE' (default) | 'FILTER'
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

// ── ҮНИЙН ТОГТМОЛ (NEW v2.9.3) ──
// Захиалгын нийт дүнг ХАА САЙГҮЙ энэ хоёр тогтмолоос авна.
// Өмнө нь 199900 гэсэн тоо 3 газар hardcode хийгдсэн байсан тул
// зөвхөн нөөц шүүлтүүрийн захиалга бүрэн буруу дүнгээр бодогдох байсан.
const BUNDLE_UNIT_PRICE = 199900;
const FILTER_UNIT_PRICE = 29900;

function unitPriceFor(order) {
  return order && order.orderType === 'FILTER' ? FILTER_UNIT_PRICE : BUNDLE_UNIT_PRICE;
}

function formatMNT(n) {
  return Number(n).toLocaleString('en-US').replace(/,/g, "'") + '₮';
}

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

// ── PURE-GREETING DETECTOR (NEW v2.8.5) ──
// Зөвхөн "цэвэр мэндчилгээ" (сайн уу, hi гэх мэт ганцаараа) бол детерминистик хариулна.
// "Сайн уу цагаан авъя" гэх contented мессежийг (16+ тэмдэгт) LLM-д үлдээнэ.
function isPureGreeting(text) {
  if (!text) return false;
  const t = text.toLowerCase().replace(/[^a-zа-яёөү\s]/gi, '').replace(/\s+/g, ' ').trim();
  if (!t || t.length > 16) return false;
  return /^(сайн\s*уу|сайн\s*байна\s*уу|сайнуу|sain\s*uu|sain\s*baina\s*uu|hi+|hello+|hey+|мэнд[эг]?|байна\s*уу|baina\s*uu|өө\s*байна\s*уу|юу\s*вэ|yuu?\s*ve)$/i.test(t);
}

// ── FIRST-CONTACT GREETING (v2.8.5) — детерминистик, JS-ээс явна ──
const GREETING_MESSAGE = `Сайн байна уу! ✨ SkinBloom AI туслах тантай холбогдлоо.

📞 Хэрэв та манай менежертэй шууд холбогдохыг хүсвэл "Менежер" гэж бичнэ үү.

Өнгө сонгоход туслах уу, эсвэл бэлгийн багцын талаар мэдэхийг хүсэж байна уу? 🌸`;

// =====================================================================
// ТЕКСТ НОРМАЛЧЛАЛ — ЛАТИН БИЧЛЭГИЙГ ТАНИХ СУУРЬ (NEW v2.9.3)
// ---------------------------------------------------------------------
// Хэрэглэгчид Монгол үгээ Латинаар бичдэг (haanahiih ve, filter avya,
// une hed ve). Өмнөх хувилбарууд .includes()-ээр түүхий текст шалгадаг
// байсан тул "за" гэдэг үг "захиалга" дотор таарах мэтийн ХУДАЛ
// таарц үүсгэдэг байв. Одоо:
//   • normWords() — цэг таслал, emoji-г арилгаж, үгсийг зайгаар тусгаарлана
//   • hasAnyWord() — БҮТЭН үгээр таарна (substring биш)
//   • hasAnyStem() — үгийн ЭХЛЭЛЭЭР таарна (авъя / авах / авмаар)
//   • hasAnyPhrase() — олон үгтэй хэллэгт зориулж normalized текст дотор хайна
// =====================================================================
// Латин ↔ Кирилл ХОЛИМОГ бичлэг (homoglyph). Хэрэглэгчид гараа сольж амжаагүйгээс
// "aваагүй" (эхний үсэг Латин a), "тиiм", "cайн" гэж бичдэг. Нүдээр ижил боловч
// код нь өөр тул үг таарахгүй болдог. Тухайн ҮГ дотор ядаж нэг Кирилл үсэг байвал
// л Латин ижил дүрст үсгүүдийг Кирилл рүү хөрвүүлнэ — цэвэр Латин үгийг хөндөхгүй.
const HOMOGLYPH_MAP = {
  a: 'а', b: 'ь', c: 'с', e: 'е', h: 'н', k: 'к', m: 'м',
  o: 'о', p: 'р', t: 'т', x: 'х', y: 'у', i: 'и', 3: 'з'
};
const CYRILLIC_RX = /[\u0400-\u04FF]/;

function fixHomoglyphs(token) {
  if (!CYRILLIC_RX.test(token)) return token;      // цэвэр Латин үг — хөндөхгүй
  if (!/[a-z0-9]/.test(token)) return token;       // цэвэр Кирилл үг — хөндөхгүй
  return token.replace(/[abcehkmoptxyi3]/g, ch => HOMOGLYPH_MAP[ch] || ch);
}

function normWords(text) {
  const cleaned = String(text || '')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim();
  if (!cleaned) return ' ';
  return ' ' + cleaned.split(' ').map(fixHomoglyphs).join(' ') + ' ';
}

function hasAnyWord(text, words) {
  const t = normWords(text);
  return words.some(w => t.includes(' ' + w + ' '));
}

function hasAnyStem(text, stems) {
  const toks = normWords(text).trim().split(' ').filter(Boolean);
  return toks.some(tok => stems.some(s => tok.startsWith(s)));
}

function hasAnyPhrase(text, phrases) {
  const t = normWords(text);
  return phrases.some(p => t.includes(' ' + p + ' ') || t.includes(' ' + p + ''));
}

// ── ЗӨВШӨӨРӨЛ / ТАТГАЛЗАЛ (NEW v2.9.3) — Кирилл + Латин ──
// ⚠️ ДАРААЛАЛ ЧУХАЛ: ҮРГЭЛЖ isNegativeAnswer()-ийг ЭХЭЛЖ шалгана.
// Учир нь "авахгүй", "аваагүй" зэрэг нь "ав" гэсэн эерэг үндэстэй тул
// эерэгийг эхэлж шалгавал татгалзлыг зөвшөөрөл гэж уншина.
const AFFIRM_WORDS = [
  'тийм', 'тиймээ', 'тиймэ', 'тийме', 'тиймээе', 'тиймэээ',
  'tiim', 'tiimee', 'tim', 'time', 'tiym', 'tiimээ',
  'за', 'заа', 'зaa', 'za', 'zaa', 'ok', 'okay', 'oke', 'оке', 'окей', 'okey',
  'yes', 'yep', 'yeah', 'yee', 'ya', 'yaa',
  'зөв', 'зов', 'zuv', 'zov', 'zuv ee',
  'мэдээж', 'medeej', 'мэдээжийн', 'medeejiin',
  'авсан', 'авсанаа', 'авчихсан', 'авъсан', 'avsan', 'awsan', 'avchihsan', 'avsn',
  'байгаа', 'baigaa', 'baigа', 'бий', 'bii', 'бн', 'bn',
  'тэгье', 'тэгэе', 'тэгнэ', 'tegye', 'tegee', 'tegne',
  'болно', 'bolno', 'болъё', 'boloo', 'болж байна'
];

const NEGATIVE_WORDS = [
  'үгүй', 'угуй', 'үгүйээ', 'ugui', 'ugvi', 'ugii', 'ugvy', 'ugue',
  'no', 'nope', 'not',
  'биш', 'bish', 'бишээ',
  'аваагүй', 'аваагуй', 'авагүй', 'авахгүй', 'аваахгүй',
  'avaagui', 'avaagvi', 'awaagui', 'avagui', 'avahgui', 'avahgvi',
  'байхгүй', 'байхгуй', 'baihgui', 'baihgvi', 'baikhgui',
  'алга', 'alga', 'хараахан', 'haraahan', 'kharaakhan',
  'одоохондоо', 'odoohondoo', 'дараа', 'daraa'
];

const BUY_STEMS = [
  'авъя', 'авья', 'авая', 'авъё', 'авмаар', 'авах', 'авна', 'авч', 'авчих', 'авъяа',
  'avya', 'avia', 'awya', 'awia', 'avmaar', 'avah', 'avakh', 'avna', 'avch',
  'захиал', 'zahial', 'zakhial', 'zahyal',
  'худалдан', 'hudaldan', 'khudaldan', 'hudaldaj',
  'order', 'оrder', 'хүргүүл', 'hurguul', 'khurguul'
];

function isNegativeAnswer(text) {
  return hasAnyWord(text, NEGATIVE_WORDS);
}

function isAffirmativeAnswer(text) {
  if (isNegativeAnswer(text)) return false;
  return hasAnyWord(text, AFFIRM_WORDS);
}

function isBuyIntent(text) {
  if (isNegativeAnswer(text)) return false;
  return hasAnyStem(text, BUY_STEMS);
}

// ── ШҮҮЛТҮҮР ИНТЕНТ (NEW v2.9.3) ──
// "Шүүлтүүр үнэ?" / "filter avya" / "zapas avya" гэх мэт — үнэ ХЭЛЭХЭЭС ӨМНӨ
// "Та манай шүршүүрийг худалдан авсан уу?" тодруулга явуулна.
const FILTER_STEMS = [
  'шүүлтүүр', 'шуултуур', 'шүлтүүр', 'шүүлтур', 'шүүлтүр', 'шүүлт', 'шүлт',
  'филтер', 'филтр', 'пилтер', 'пилтр', 'фильтр',
  'карбон', 'нүүрс',
  'shuultuur', 'shuultur', 'shultuur', 'shuulteer', 'shvvltvvr', 'shuult', 'shult',
  'filter', 'filtr', 'filtir', 'pilter', 'piltr', 'pilt',
  'karbon', 'carbon', 'acf',
  'запас', 'zapas', 'zapass'
];

function hasFilterWord(text) {
  return hasAnyStem(text, FILTER_STEMS);
}

// ── ҮНИЙН АСУУЛТ (NEW v2.9.3) ──
// "хэдэн хоног", "хэдэн ширхэг", "хүргэлт үнэгүй юу" зэргийг ХАСНА —
// эдгээр нь үнийн асуулт БИШ.
const PRICE_STEMS = ['үнэ', 'унэ', 'үний', 'уний', 'үнэт', 'унэт', 'үнээ',
  'une', 'unii', 'unee', 'unet', 'price', 'прайс', 'өртөг', 'ortog', 'ortg'];
const PRICE_HED_STEMS = ['хэд', 'хед', 'hed', 'khed'];
const PRICE_EXCLUDE_TOKENS = ['үнэгүй', 'унэгүй', 'унэгуй', 'үнэгуй', 'unegui', 'unegvi', 'unegvy'];
// ⚠️ Эдгээр нь ҮГИЙН ЭХЛЭЛЭЭР таарна (stem). "сар" нь "сард", "сарын"-г ч барина.
const PRICE_CONTEXT_BLOCKER_STEMS = [
  'хоног', 'honog', 'khonog', 'өдөр', 'өдр', 'odor', 'udur', 'цаг', 'tsag',
  'сар', 'sar', 'минут', 'minut', 'удаа', 'udaa',
  'ширхэг', 'shirheg', 'shirhek', 'давхар', 'davhar', 'жил', 'jil',
  'солих', 'solih', 'удах'
];

function isPriceQuestion(text) {
  const t = normWords(text);
  const toks = t.trim().split(' ').filter(Boolean);

  const strong = toks.some(tok =>
    !PRICE_EXCLUDE_TOKENS.some(x => tok.startsWith(x)) &&
    PRICE_STEMS.some(s => tok.startsWith(s))
  );
  if (strong) return true;

  const hed = toks.some(tok => PRICE_HED_STEMS.some(s => tok.startsWith(s)));
  if (!hed) return false;
  if (toks.some(tok => PRICE_CONTEXT_BLOCKER_STEMS.some(b => tok.startsWith(b)))) return false;
  return true;
}

// ── ГАРАЛ ҮҮСЛИЙН АСУУЛТ (NEW v2.9.3) ──
// ⚠️ "хаана" гэсэн ганц үгийг ОРУУЛААГҮЙ — тэр нь "танай дэлгүүр хаана байдаг вэ"
// гэсэн handoff хүсэлттэй мөргөлдөнө.
const ORIGIN_PHRASES = [
  'аль улс', 'аль улсын', 'аль улсынх', 'аль улсых', 'али улс', 'аль улсынхи',
  'ali uls', 'ali ulsiin', 'ali ulsih', 'ali ulsiih',
  'ямар улс', 'yamar uls', 'yamr uls',
  'хаанахийх', 'хаанахих', 'хаанахийн', 'хаанийх', 'хаанхийх', 'хаанах', 'хаанахи',
  'haanahiih', 'haanahih', 'haanahiin', 'haanihiih', 'hanahiih', 'haanah', 'khaanakhiikh',
  'хаана үйлдвэр', 'хаана хийсэн', 'хаана бүтээ', 'хаанаас ирсэн', 'хаанаас авдаг',
  'хаанаас оруул', 'хаанаас ирдэг',
  'haana uildver', 'haana hiisen', 'haanaas irsen', 'haanaas oruul', 'haanaas irdeg',
  'гарал үүсэл', 'гарлын', 'garal uusel', 'garal usel', 'garliin',
  'үйлдвэрлэгч', 'үйлдвэрлэсэн', 'үйлдвэр нь', 'uildverlegch', 'uildverlesen',
  'made in', 'мэйд ин', 'мейд ин',
  'хятад', 'хятадын', 'хятадынх', 'hyatad', 'hyatadiin', 'hitad', 'china',
  'герман', 'german', 'germany', 'европ', 'evrop', 'europe', 'yavropiin',
  'ce стандарт', 'се стандарт', 'сертификат', 'sertifikat', 'certificate',
  'ямар брэнд', 'yamar brend'
];

function isOriginQuestion(text) {
  const t = normWords(text);
  return ORIGIN_PHRASES.some(p => t.includes(' ' + p) || t.includes(p + ' '));
}

// =====================================================================
// ДЕТЕРМИНИСТИК ХАРИУЛТЫН ТЕКСТ (NEW v2.9.3)
// ---------------------------------------------------------------------
// Эдгээр текстийг LLM ХЭЗЭЭ Ч бичихгүй — JS-ээс яг ийм хэлбэрээр явна.
// ⚠️ Messenger markdown РЕНДЕРЛЭДЭГГҮЙ: `~~текст~~` нь хэрэглэгчид яг
//    `~~текст~~` гэж харагдана. Тиймээс хаа сайгүй `➜` сум ашиглана.
// =====================================================================

// 1) ҮНЭ асуусан үед — Бэлгийн Багцын үндсэн hook
const PRICE_ANSWER = `Бэлгийн Багц 269'000₮ ➜ 199'900₮ · 69'100₮ хэмнэнэ 🔥

🎁 2 нэмэлт бүтээгдэхүүн бэлгэнд
🚚 Хүргэлт үнэгүй
🎨 3 өнгөний сонголт

Дэлгэрэнгүй мэдэх үү, эсвэл өнгө сонгох уу? 🌸`;

// 2) ШҮҮЛТҮҮР — үнэ хэлэхээс ӨМНӨХ заавал тодруулга
const FILTER_OWNERSHIP_ASK = `Нөөц шүүлтүүрийн талаар уу? 🌸

Та манай SkinBloom шүршүүрийг худалдан авсан уу?`;

// 3) ШҮҮЛТҮҮРИЙН ҮНЭ — зөвхөн тодруулгын ДАРАА
const FILTER_PRICE_ANSWER = `44'900₮ ➜ 29'900₮ 🔥 (1ш Нөөц Шүүлтүүр)
🚚 Хүргэлт үнэгүй

Та яг одоо гэртээ хүргүүлээд авах уу?`;

// 4) Шүршүүр аваагүй хүнд — шүүлтүүр дангаараа хэрэггүй
const FILTER_NO_SHOWER_ANSWER = `Ойлголоо 🌸 Нөөц шүүлтүүр нь зөвхөн SkinBloom шүршүүрт тохирдог.

Бэлгийн Багц 269'000₮ ➜ 199'900₮ · 69'100₮ хэмнэнэ 🔥
Шүүлтүүр нь шүршүүрт суурилуулсан ирнэ.

🎁 2 нэмэлт бүтээгдэхүүн бэлгэнд
🚚 Хүргэлт үнэгүй

Аль өнгийг нь харах уу? 🤍🩶🖤`;

// 5) Шүүлтүүр авахаа зөвшөөрсний дараа — хаяг асуух
const FILTER_ADDRESS_ASK = `Тэгье 🌸 Хүргэлтийн бүрэн хаягаа явуулна уу.
(дүүрэг, хороо, хотхон/байр, тоот, давхар)`;

// 6) Шүүлтүүр авахаас татгалзсан үед
const FILTER_DECLINE_ANSWER = `Ойлголоо 🌸 Хэрэгтэй болбол хэзээ ч бичээрэй.
Нөөц шүүлтүүрийг 3–6 сард нэг удаа солино.`;

// 7) ГАРАЛ ҮҮСЭЛ
// ⚠️⚠️ АНХААРУУЛГА — Lu2 уншина уу:
// Энэ хариултыг та хүссэн ёсоор нь бичсэн. ГЭХДЭЭ:
//   • v2.9.2 хүртэл ботын canon "Хонгконгт үйлдвэрлэгдэнэ" гэж байсан
//   • skinbloom-chatbot skill-д "Герман технологи" нь ХОРИОТОЙ
//     hallucination гэж бүртгэлтэй байсан
//   • CE дугаар HX240303050484 нь Ази дахь тест лабораторийн формат
// Хэрэв бодит баримт (Герман компани / дизайн эрх / импортлогч) байхгүй
// бол ORIGIN_ANSWER_SAFE-г ашиглана уу — доор бэлэн байгаа.
const ORIGIN_ANSWER = `SkinBloom бол Герман улсаас гаралтай брэнд 🇩🇪

Бүтээгдэхүүн Европын CE стандартын дагуу үйлдвэрлэгдсэн.
📋 CE сертификат: HX240303050484

Танд өөр тодруулах зүйл байна уу? 🌸`;

// ── Аюулгүй хувилбар (идэвхгүй) — ORIGIN_ANSWER-ийн оронд шууд сольж болно ──
// const ORIGIN_ANSWER_SAFE = `SkinBloom нь Европын CE стандартын дагуу үйлдвэрлэгддэг 🌸
//
// 📋 CE сертификат: HX240303050484
//
// Танд өөр тодруулах зүйл байна уу?`;

// ── BOT-SENT MESSAGE TRACKING (legacy v2.8.5/2.8.6 — v2.8.7-д ХЭРЭГЛЭГДЭХГҮЙ) ──
// v2.8.7-аас хойш echo-г app_id-аар ялгадаг болсон тул доорх текст-based tracking
// (recordBotMessage / isBotOwnEcho) ашиглагдахаа больсон. Кодыг устгалгүй үлдээв —
// ажиллагаанд нөлөөгүй. sendDM/sendDMWithHumanAgent доторх recordBotMessage дуудлага
// харгүй (no-op шахуу) тул хэвээр үлдээж болно.
const recentBotMessages = new Map(); // recipientId → [{ text, ts }, ...]
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

function isBotOwnEcho(recipientId, echoText) {
  const a = (echoText || '').trim();
  if (!a) return false;
  if (a === GREETING_MESSAGE.trim() || a.startsWith('Сайн байна уу! ✨ SkinBloom AI туслах')) return true;
  const arr = recentBotMessages.get(recipientId);
  if (!arr || !arr.length) return false;
  const cutoff = Date.now() - BOT_ECHO_WINDOW_MS;
  return arr.some(m => {
    if (m.ts < cutoff || !m.text) return false;
    return a === m.text || (m.text.length >= 20 && a.includes(m.text.slice(0, 30)));
  });
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

// ── PHONE EXTRACTION & VALIDATION (v2.8.0, ROOT FIX v2.9.2) ──
// v2.9.2 ЗАСВАР: өмнөх `text.replace(/\+?976/g, ' ')` нь "976"-г текстийн
// ХААНААС Ч гэсэн таслан устгадаг байсан тул 99761234, 88976543 гэх мэт
// БОДИТ дугааруудыг эвдэж, null буцаадаг байв. Одоо 976-г зөвхөн улсын
// кодын БАЙРЛАЛД (8 оронтой дугаарын өмнө) байвал л хасна.
// Мөн зай, зураас, хаалт бүхий бичлэгийг (9511 3550, 9511-3550) дэмжинэ.
const MN_PHONE_FIRST_DIGITS = ['5', '7', '8', '9'];

function stripCountryCode(text) {
  // 976 / +976 -г ЗӨВХӨН улсын кодын байрлалд (8 оронтой дугаарын өмнө) хасна.
  // Ингэснээр 99761234, 88976543 гэх БОДИТ дугаарууд эвдрэхгүй.
  return String(text).replace(/(^|[^\d])\+?976[\s\-().]*(?=\d{8}(?!\d))/g, '$1');
}

function collapseDigitSeparators(text) {
  // "9511 3550", "9511-3550", "(9511) 3550" → "95113550"
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
      // Монголын mobile/landline эхний орон: 5, 7, 8, 9
      if (MN_PHONE_FIRST_DIGITS.includes(num[0])) return num;
    }
    return null;
  };
  // 1-р оролдлого — форматлагч тэмдэгтийг ХӨНДӨХГҮЙ (хаяг доторх тоог
  // санамсаргүй нийлүүлэхээс сэргийлнэ). Ихэнх кейс энд шийдэгдэнэ.
  const found = attempt(stripCountryCode(String(text)));
  if (found) return found;
  // 2-р оролдлого — зөвхөн 1-р нь юу ч олоогүй үед зай/зураасыг нийлүүлнэ
  return attempt(normalizePhoneText(text));
}

// ── PHONE INPUT VALIDATOR (NEW v2.9.2) ──
// АРХИТЕКТУРЫН ЗАРЧИМ: тоо тоолох/шалгах ажлыг LLM-д ХЭЗЭЭ Ч даалгахгүй.
// GPT-4o-mini оронг найдвартай тоолж чаддаггүй тул "95113550" гэсэн зөв
// дугаарыг "8 оронтой оруулна уу" гэж буруу татгалздаг байв. Одоо энэ
// шалгалтыг бүхэлд нь JS хийж, хариултыг нь ч өөрөө өгнө.
//
// Буцаах утга: { isAttempt, valid, phone, message }
//  • isAttempt=false → энэ мессеж утас биш (хаяг, тоо ширхэг, орцны код г.м.)
//  • isAttempt=true, valid=true  → phone талбарт бэлэн
//  • isAttempt=true, valid=false → message-ийг JS өөрөө илгээнэ
function validatePhoneInput(text) {
  const none = { isAttempt: false, valid: false, phone: null, message: null };
  if (!text) return none;

  const raw = String(text).trim();
  // Зөвхөн "дугаар мэт" мессежийг л шалгана: цэвэр тоо + форматлагч тэмдэгт.
  // Хаяг, "2 ширхэг", урт өгүүлбэрийг ЭНД БАРИХГҮЙ.
  if (!/^[+\d\s\-().]+$/.test(raw)) return none;

  const normalized = normalizePhoneText(raw);
  const digits = normalized.replace(/\D/g, '');

  // 7-с богино бол утас гэж үзэхгүй (орцны код 2-6 орон, тоо ширхэг 1-2 орон)
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

// ── ORDER STATE → LLM CONTEXT (NEW v2.9.2, extended v2.9.3) ──
// LLM нь JS-ийн цуглуулсан slot-уудыг мэддэггүй байсан тул аль хэдийн
// өгсөн мэдээллийг дахин асуудаг байв. Одоо state-ийг system note болгож
// оруулна — LLM зөвхөн ДУТУУ талбарыг асууна.
function buildOrderStateNote(senderId) {
  const o = getOrder(senderId);
  if (!o) return null;
  const lines = [];

  // v2.9.3: захиалгын ТӨРЛИЙГ хамгийн эхэнд мэдэгдэнэ.
  if (o.orderType === 'FILTER') {
    lines.push(`• Захиалгын төрөл: НӨӨЦ ШҮҮЛТҮҮР ✓ (1 ширхэг 29'900₮, үндсэн 44'900₮)`);
    lines.push(`  ⛔ ӨНГӨ АСУУХГҮЙ — шүүлтүүрт өнгө байхгүй.`);
    lines.push(`  ⛔ Бэлгийн Багц (199'900₮) САНАЛ БОЛГОХГҮЙ — хэрэглэгч шүүлтүүр л авч байна.`);
    lines.push(`  ⛔ Twin Pack / Family Pack ГЭЖ БАЙХГҮЙ — дурдахгүй.`);
  } else if (o.orderType === 'BUNDLE') {
    lines.push(`• Захиалгын төрөл: БЭЛГИЙН БАГЦ ✓ (199'900₮)`);
  }

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

  // Color — зөвхөн БАГЦын захиалгад хамаатай (шүүлтүүрт өнгө байхгүй)
  // ⚠️ v2.9.3 ЗАСВАР (өмнөх буг): хуучин регекс `/…|хар|…/` нь substring-ээр
  // шалгадаг байсан тул "харах", "харъя", "харин", "хариулах" гэсэн ЭНГИЙН үгэнд
  // таарч, хэрэглэгчийн захиалгад ӨНГИЙГ ЧИМЭЭГҮЙ Obsidian Black болгож
  // тавьдаг байв. Одоо шинэ хариултууд "Аль өнгийг нь ХАРАХ уу?" гэж
  // асуудаг тул энэ буг тогтмол ажиллах байсан. Одоо БҮТЭН ҮГЭЭР шалгана.
  if (!result.color && result.orderType !== 'FILTER') {
    const WHITE_WORDS = ['pearl', 'white', 'цагаан', 'цагааныг', 'цагаанаа', 'цагаанг', 'цагаанаар',
      'tsagaan', 'tsagan', 'cagaan', 'tagaan', 'tsagaanaa', 'sagaan'];
    const GRAY_WORDS = ['slate', 'gray', 'grey', 'саарал', 'саарлыг', 'саарлаа', 'саарлын', 'саарл',
      'saaral', 'saral', 'sarl', 'saarl'];
    const BLACK_WORDS = ['obsidian', 'black', 'хар', 'харыг', 'хараа', 'харын', 'хараар',
      'har', 'hara', 'khar', 'kar'];
    if (hasAnyWord(text, WHITE_WORDS)) result.color = 'Pearl White';
    else if (hasAnyWord(text, GRAY_WORDS)) result.color = 'Slate Gray';
    else if (hasAnyWord(text, BLACK_WORDS)) result.color = 'Obsidian Black';
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
// v2.8.8-аас хойш ХЭРЭГЛЭГДЭХГҮЙ (legacy) — shouldTriggerHandoff одоо зөвхөн
// [HANDOFF_NEEDED] tag-аар trigger хийдэг. Жагсаалтыг устгаагүй — нөлөөгүй.
const HANDOFF_KEYWORDS = [
  'манай баг', 'эргэн холбогдох', 'түр хүлээ',
  'удахгүй холбогдох', 'менежер', 'холбогдох болно',
  'тантай холбогдох', 'баг тантай'
];

function shouldTriggerHandoff(reply) {
  // v2.8.8 ROOT FIX: ЗӨВХӨН [HANDOFF_NEEDED] tag-аар trigger хийнэ.
  return reply.includes('[HANDOFF_NEEDED]');
}

// ── USER-INITIATED HANDOFF DETECTION (NEW v2.8.0, expanded v2.8.5) ──
const USER_HANDOFF_REQUEST_KEYWORDS = [
  // ── Хүн рүү шилжүүлэх ──
  'хүнтэй ярих', 'hunteh yarih', 'huntei yarih', 'оператор', 'operator',
  'ажилтан', 'azhiltan', 'ажилчин', 'жинхэнэ хүн', 'real person',
  'live agent', 'live person', 'human',

  // ── МЕНЕЖЕР — бүх боломжит бичлэг (Кирилл) ──
  'менежер', 'менэжэр', 'мэнежер', 'мэнэжэр', 'мэнэжер', 'менэжер',
  'менежэр', 'мэнежэр', 'менеджер', 'менэджэр', 'мэнэджэр',
  'менежр', 'мэнэжр', 'менэжр', 'менажер', 'мэнажэр',

  // ── МЕНЕЖЕР — Latin ──
  'manager', 'maneger', 'menejer', 'menezher', 'meneger', 'menegar',
  'menejr', 'manejer', 'menjer', 'menejor', 'manejor', 'menegr',
  'manegar', 'managr', 'manjer', 'menager', 'menejar',

  // ── Очиж үзэх / бодит дэлгүүр ──
  'очиж', 'ochih', 'ochmoor', 'ochmor', 'очмоор', 'ochij vzmeer',
  'очиж үзэх', 'очиж үзмээр', 'очиж харах', 'нүдээр харах', 'nudeer harah',
  'газар дээр нь', 'gazar deer', 'дэлгүүр очих', 'delguur ochih',
  'агуулах очих', 'ageulah', 'офис очих', 'office очих',
  'хаашаа очих', 'хаана байр', 'хаанаа байг', 'хаана байш', 'bairshil',
  'байршил', 'байрлал', 'хаягаа хэлээч',

  // ── Direct human / team ──
  'manai bag', 'manai baig', 'манай баг', 'таны баг', 'tani bag',
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
  return PROVINCE_KEYWORDS.some(kw => {
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
  'influencer', 'инфлюэнсер', 'контент хийх', 'контент хийе',
  'collab', 'коллаб', 'collaborat', 'хамтран', 'хамтарч',
  'фото хийх', 'видео хийх', 'зураг авах', 'зураг дарах',
  'бүтээгдэхүүн явуулах', 'бүтээгдэхүүн өгөх', 'пиар',
  'реклам хийх', 'сурталчлах', 'promote'
];

// ⚠️ v2.9.3 ЗАСВАР (өмнөх бугийг илрүүлэв): 'pr' болон 'ugc' нь маш богино
// тул .includes()-ээр шалгахад "price", "продукт", "приложение" зэрэг ямар ч
// үгэнд таарч, ХУДАЛ UGC alert-ыг Telegram руу илгээдэг байв. Одоо
// англи "price" гэсэн асуулт үндсэн урсгалын нэг хэсэг болсон тул энэ буг
// үнэ асуух бүрд Telegram-ыг спамдана. Богино түлхүүрүүдийг БҮТЭН ҮГЭЭР шалгана.
const UGC_SHORT_WORDS = ['pr', 'ugc', 'пиар'];

function isUGCOrInfluencer(text) {
  const lower = String(text || '').toLowerCase();
  if (UGC_KEYWORDS.some(kw => lower.includes(kw))) return true;
  return hasAnyWord(text, UGC_SHORT_WORDS);
}

// ── COMPLAINT DETECTION (хэрэглэгчийн санал гомдол) ──
const COMPLAINT_KEYWORDS = [
  'гомдол', 'санал гомдол', 'gomdol',
  'буцаах', 'буцаалт', 'буцааж өг', 'butsaah', 'butsaalt',
  'мөнгөө буцааж', 'төлбөрөө буцааж',
  'эвдэрсэн', 'evdersen', 'evderhgui', 'муу чанартай',
  'ажилахгүй', 'ажиллахгүй', 'azhilahgui', 'ажилгүй',
  'хугарсан', 'hugarsan', 'эвдэрчихсэн',
  'таалагдсангүй', 'taalagdsangui', 'taalagdahgui',
  'сэтгэл хангалуун биш', 'дургуй', 'durgui',
  'буруу ирсэн', 'buruu irsen', 'өөр зүйл ирсэн',
  'ялгаатай ирсэн', 'буруу хүргэгдсэн', 'буруу бүтээгдэхүүн',
  'буруу ойлгосон', 'buruu oilgoson', 'iim gej bodoogui',
  'ийм гэж бодоогүй', 'запас ирэх гэж бодсон',
  'zapas irne gej bodson', 'iim bsiin', 'ирэх гэж бодсон',
  'буруу мэдээлэл', 'buruu medeelel', 'хууртагдсан',
  'хариуцлага', 'хариуцлагатай', 'арга хэмжээ',
  'ирээгүй', 'iregui', 'хүргэгдээгүй', 'hurgegdeegui',
  'хүлээж байна', 'huleej baina', 'хүргэлт удаан'
];

function isComplaint(text) {
  const lower = text.toLowerCase();
  return COMPLAINT_KEYWORDS.some(kw => lower.includes(kw));
}

// ── ADMIN/OPERATOR DETECTION (legacy — v2.8.7-д ХЭРЭГЛЭГДЭХГҮЙ) ──
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
- "KDF", "хүнд металл", "бактер устгана" — эдгээр ХЭЗЭЭ Ч бичихгүй (шүүлтүүрт KDF байхгүй)
- "Twin Pack", "Family Pack", "Single Pack" — эдгээр багц БАЙХГҮЙ, бичихгүй. Нөөц шүүлтүүр = 1 ширхэг 29'900₮
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

// ── DRAFT VARIANTS STORE (Telegram → reply mapping) ──
const draftStore = new Map(); // userId → { variants: {1, 2, 3}, expiresAt }
const DRAFT_TTL = 60 * 60 * 1000; // 1 цаг

function saveDrafts(userId, variants) {
  draftStore.set(userId, {
    variants,
    expiresAt: Date.now() + DRAFT_TTL
  });
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

// ── ADMIN TAKEOVER NOTIFY (хүн Page inbox-оос гараар бичсэн үед) ──
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

  const isFilterOrder = parsed.orderType === 'FILTER';
  const unit = unitPriceFor(parsed);

  const productLabel = isFilterOrder ? 'Нөөц Шүүлтүүр' : 'Бэлгийн Багц';
  const color = isFilterOrder ? '—' : (parsed.color || '—');
  const qtyNum = parsed.qty || (isFilterOrder ? 1 : null);
  const qty = qtyNum ? `${qtyNum} ширхэг` : '—';
  const address = parsed.address || '—';
  const entranceCode = parsed.entranceCode || 'байхгүй';
  const phone = parsed.phone || '—';

  // Үнэ тооцоолол — БАГЦ бол өнгө шаардлагатай, ШҮҮЛТҮҮР бол шаардлагагүй
  let total = '—';
  if (qtyNum && (isFilterOrder || parsed.color)) {
    total = formatMNT(qtyNum * unit);
  }

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

  const productBlock = isFilterOrder
    ? `📦 Бүтээгдэхүүн: <b>${productLabel}</b>`
    : `📦 Бүтээгдэхүүн: <b>${productLabel}</b>\n🎨 Өнгө: <b>${color}</b>`;

  const msg = `${repeatTag}${afterHours}🛍 <b>ШИНЭ ЗАХИАЛГА${isFilterOrder ? ' — ШҮҮЛТҮҮР' : ''}${isCOD ? ' — COD' : ''}!</b>
🆔 <code>${orderId}</code>

${productBlock}
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
    ? `🆔 <code>${order.orderId}</code>\n🎨 ${order.color || (order.orderType === 'FILTER' ? 'Нөөц Шүүлтүүр' : '—')} × ${order.qty || '—'}\n📍 ${order.address || '—'}\n📞 ${order.phone || '—'}\n💰 ${order.total || '—'}\n\n`
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
// SYSTEM PROMPT v2.9.3 — 2026.08.04
// v2.9.2 → v2.9.3 ӨӨРЧЛӨЛТ (Lu2-ын 6 хүсэлт):
//
// 1️⃣ ҮНИЙН ХАРИУЛТ — JS-ийн `PRICE_ANSWER` тогтмолоос детерминистикээр явна.
//    LLM үнийн hook-ийг өөрөө бичихээ БОЛИВ (тоо гуйвуулах эрсдэлийг устгав).
//
// 2️⃣ ШҮҮЛТҮҮРИЙН ҮНЭ — заавал "Та манай SkinBloom шүршүүрийг худалдан
//    авсан уу?" тодруулга хийсний ДАРАА л үнэ гарна. Тодруулга + үнэ + дараагийн
//    алхам бүгд JS-д (`FILTER_OWNERSHIP_ASK` → `FILTER_PRICE_ANSWER`).
//
// 3️⃣ TWIN PACK / FAMILY PACK БҮРЭН УСТГАВ. Нөөц шүүлтүүр ЗӨВХӨН 1 ширхэг —
//    29'900₮ (үндсэн 44'900₮). "Single" гэдэг үг ч хэрэглэхгүй — "1 ширхэг".
//
// 4️⃣ ЛАТИН БИЧЛЭГ — normWords/hasAnyWord/hasAnyStem суурьтай болов.
//    Prompt-д мөн Латин бичлэгийг ойлгож, ҮРГЭЛЖ Кириллээр хариулах дүрэм.
//
// 5️⃣ ГАРАЛ ҮҮСЭЛ — "Герман улсаас гаралтай, Европын CE стандарт" гэсэн
//    детерминистик хариулт (`ORIGIN_ANSWER`). Өмнөх "Хонгконгт үйлдвэрлэгдэнэ"
//    гэсэн мөрийг ЗАЙЛШГҮЙ хассан — эс тэгвэл бот өөртэйгөө зөрчилдөнө.
//    ⚠️ Энэ өөрчлөлтийн эрсдэлийг тусдаа тэмдэглэлд бичсэн.
//
// 6️⃣ `~~зураас~~` markdown Messenger-т РЕНДЕРЛЭГДЭХГҮЙ — бүгдийг `➜` болгов.
// ---------------------------------------------------------------------
// v2.9.2 (хэвээр): validatePhoneInput — утасны шалгалт бүхэлдээ JS-д.
// v2.9.1 (хэвээр): багц доторх шүүлтүүрийг "үнэгүй" гэж тэмдэглэхгүй.
// v2.9.0 (хэвээр): KDF устгасан, РАДИАЛ 3 давхар canon.
// v2.8.8 (хэвээр): shouldTriggerHandoff зөвхөн [HANDOFF_NEEDED] tag.
// v2.8.7 (хэвээр): echo-г app_id-аар ялгана.
// =====================================================================

const SYSTEM_PROMPT = `Та SkinBloom брэндийн AI туслах "Bloom" юм. Монгол хэлээр товч, найрсаг, дулаан хариулна. Нэг хариултанд 1–3 өгүүлбэрээс ихгүй.

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
0. БИЧЛЭГИЙН ХЭЛБЭР — ЛАТИН ҮСЭГ (v2.9.3)
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
Монгол хэрэглэгчид үгээ Латинаар бичдэг. Та эдгээрийг ЯГ Кирилл шиг ойлгоно:

• une hed ve / une? / hed ve → үнэ хэд вэ
• filter avya / pilter avya / zapas avya → нөөц шүүлтүүр авъя
• haanahiih ve / ali ulsiih ve / garal uusel → аль улсынх вэ
• avya / avia / awya / avmaar / zahialya → авъя / захиалъя
• tiim / za / ok / awsan / avsan → тийм / за / авсан
• ugui / avaagui / baihgui → үгүй / аваагүй / байхгүй
• tsagaan / saaral / har → Pearl White / Slate Gray / Obsidian Black
• hurgelt / hayag / utas / joloochid belneer → хүргэлт / хаяг / утас / COD

ДҮРЭМ:
• Латинаар бичсэн ч БҮРЭН ойлгож, ердийн урсгалаар үргэлжлүүлнэ.
• Хариултаа ХЭЗЭЭ Ч Латинаар бичихгүй — ҮРГЭЛЖ Кириллээр.
• Хэрэглэгчийн бичлэгийг ХЭЗЭЭ Ч засаж сургахгүй, тайлбарлахгүй.
• Ойлгомжгүй бол богино тодруулах асуулт тавь, таамаглал дээр захиалга үүсгэхгүй.

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
1. ЭХНИЙ МЭНДЧИЛГЭЭ
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
Хэрэглэгч анх холбогдоход (сайн уу, hi, hello, мэнд, юу вэ, танилцуулаач, байна уу гэх мэт) ЗААВАЛ дараах текстийг яг ийм байдлаар явуул — өөрчлөхгүй:

"Сайн байна уу! ✨ SkinBloom AI туслах тантай холбогдлоо.

📞 Хэрэв та манай менежертэй шууд холбогдохыг хүсвэл "Менежер" гэж бичнэ үү.

Өнгө сонгоход туслах уу, эсвэл бэлгийн багцын талаар мэдэхийг хүсэж байна уу? 🌸"

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
2. ИНТЕНТ ТАНИХ — ХАМГИЙН ЧУХАЛ ДҮРЭМ
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
Хэрэглэгчийн АНХНЫ интентыг заавал тодорхойл. Хоёрдмол утгатай бол богино тодруулах асуулт тавь.

▸ ШҮРШҮҮР / БАГЦ авах гэж байгаа:
  Keyword: "шүршүүр", "bagts", "бэлгийн багц", "өнгө", "цагаан", "хар", "саарал", "pearl", "obsidian", "slate", "авъя", "захиалъя"
  → Бэлгийн Багц 199'900₮ flow руу

▸ ШҮҮЛТҮҮР / FILTER авах гэж байгаа:
  Keyword: "шүүлтүүр захиалъя", "шүүлтүүр авъя", "шүүлтүүр үнэ", "filter avya", "zapas", "запас", "нөөц шүүлтүүр", "карбон филтер", "пилтер", "pilter", "filtr"
  → ⚠️ ЭНЭ ИНТЕНТЫГ JS КОД БАРЬЖ АВНА. Та шүүлтүүрийн ҮНИЙГ ӨӨРӨӨ ХЭЗЭЭ Ч ХЭЛЭХГҮЙ.
  → JS эхлээд "Та манай SkinBloom шүршүүрийг худалдан авсан уу?" гэж тодруулга явуулна.
  → Зөвхөн тодруулгын дараа JS 29'900₮ гэсэн үнийг үзүүлнэ.
  → Хэрэв ярианы дундаас шүүлтүүрийн үнэ асуувал: "Нэг секунд 🌸" гэхийн оронд шууд
    "Та манай SkinBloom шүршүүрийг худалдан авсан уу?" гэж тодруул.
  → BUNDLE (шүршүүр, бэлгийн багц) ХЭЗЭЭ Ч САНАЛ БОЛГОХГҮЙ — хэрэглэгч filter л хүссэн
  → ⛔ Twin Pack / Family Pack / Single Pack ГЭЖ БАЙХГҮЙ. ХЭЗЭЭ Ч дурдахгүй.

▸ POST-ИЙН CONFUSION — "ирээгүй", "ийм гэж бодоогүй", "буруу ойлгосон":
  Keyword: "запас ирнэ гэж бодсон", "шүүлтүүр ирэх ёстой", "буруу ойлгосон", "ийм байсангүй", "vasiin zapas", "iim bsiin", "өөр зүйл захиалсан"
  → Хэрэглэгч аль хэдийн захиалга өгсөн boловч confused байна
  → Эхлээд UYAН зөвшөөрөл: "Уучлаарай, ойлголтын зөрүү гарсан байна"
  → Дараа нь хүний оператор руу шилжүүлэх: [HANDOFF_NEEDED]
  → ШУУД шинэ захиалга авч эхлэхгүй — context-ийг ойлгох

▸ МЭДЭЭЛЭЛ / ҮНЭ хайж байгаа:
  Keyword: "үнэ", "хэд", "хэдэн төгрөг", "price", "une hed ve"
  → ⚠️ ҮНИЙН HOOK-ийг JS КОД өөрөө явуулна. Та үнийн танилцуулгыг ДАВТАХГҮЙ.
  → Хэрэглэгч "дэлгэрэнгүй" гэвэл доорх задаргааны загварыг ашигла.

▸ ГАРАЛ ҮҮСЭЛ асуувал ("аль улсынх вэ", "хаанахийх вэ", "haanahiih ve"):
  → ⚠️ ЭНЭ ХАРИУЛТЫГ Ч JS КОД өөрөө явуулна. Та давтахгүй.
  → Хэрэв заавал хариулах шаардлага гарвал: "Герман улсаас гаралтай, Европын CE стандартын дагуу үйлдвэрлэгдсэн."
  → ⛔ Өөр улс (Хонгконг, Хятад, Япон, Солонгос) ХЭЗЭЭ Ч дурдахгүй.

▸ UGC / КОНТЕНТ / КОЛЛАБ:
  Keyword: "ugc", "контент хийх", "коллаб", "collab", "promote", "пиар", "хамтарч", "story дээр тавьсан"
  → Handoff handler

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
3. БҮТЭЭГДЭХҮҮН — ҮНЭН МЭДЭЭЛЭЛ (skinbloom.store)
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

▸ "SkinBloom Бэлгийн Багц" — 199'900₮
  • Бүх 3 өнгө ҮНЭ БА БҮРЭЛДЭХҮҮН ИЖИЛ — "Pearl White 3-в-1" гэж хэзээ ч хэлэхгүй
  • Дотор нь: Active Carbon Filter урьдчилан СУУРИЛУУЛСАН шүршүүр (44'900₮ үнэлгээтэй, шүршүүрийн салшгүй хэсэг) + Brush (24'500₮) ба Donut Sponge (24'500₮) үнэгүй дагалдана
  • ⚠️ ШҮҮЛТҮҮРИЙН ТОО: Багцад ганцхан шүүлтүүр багтана — шүршүүрт СУУРИЛУУЛСАН Active Carbon Filter (44'900₮). Нэмэлт буюу нөөц шүүлтүүр дагалддаггүй. "2 шүүлтүүр ирнэ", "нэг суурилсан дээр нэг нөөц дагалдана" гэж ХЭЗЭЭ Ч хэлэхгүй. Нөөц шүүлтүүр хэрэгтэй бол тусдаа 29'900₮.
  • ⛔ ШҮҮЛТҮҮРИЙГ "ҮНЭГҮЙ" ГЭЖ ХЭЗЭЭ Ч ТЭМДЭГЛЭХГҮЙ. Шүүлтүүр нь шүршүүрийн салшгүй хэсэг (built-in) — бэлэг БИШ, бонус БИШ. Зөвхөн Brush болон Donut Sponge л "үнэгүй" гэж бичигдэнэ.
  • Анх 269'000₮ ➜ одоо 199'900₮ (69'100₮ хэмнэлт)
  • Хүргэлт үнэгүй
  • Шүүрхай хүргэлт: +20'000₮ (UBCAB EXPRESS, тухайн өдөртөө)
  • 3 өнгө:
    ⬛ Obsidian Black — мөнгөлөг цагирагтай, premium гүн хар өнгө
    🤍 Pearl White — дулаан гэрэлтэй, цэвэр цайвар төрх
    🩶 Slate Gray — час улаан (crimson) дотоод цагирагтай, тансаг бараан тон

▸ "SkinBloom Карбон Филтер" — нөөц шүүлтүүр
  • ЗӨВХӨН НЭГ САНАЛ: 1 ширхэг — 29'900₮ (үндсэн үнэ 44'900₮) · 15'000₮ хэмнэнэ
  • ⛔ Twin Pack (2ш), Family Pack (3ш), Single Pack — ЭДГЭЭР БАЙХГҮЙ. ХЭЗЭЭ Ч дурдахгүй, санал болгохгүй, харьцуулахгүй.
  • ⛔ "Single" гэдэг үг хэрэглэхгүй — "1 ширхэг" гэж бич.
  • Хүргэлт үнэгүй
  • ⏰ ХУГАЦАА: 29'900₮ хямдрал 2026.09.01 хүртэл. Дараа нь үндсэн үнэ 44'900₮ болно.
  • Солих давтамж: 4 хүнтэй өрхөд 3 сар тутамд, 2 хүнтэй өрхөд 6 сар тутамд нэг удаа.
  • ⚠️ Шүүлтүүрийн үнийг хэлэхээс ӨМНӨ "Та манай SkinBloom шүршүүрийг худалдан авсан уу?" гэж заавал тодруулна (энэ тодруулгыг JS явуулна).

▸ 🔬 ШҮҮЛТҮҮРИЙН БҮТЭЦ — РАДИАЛ 3 ДАВХАР (2026.07 бодит задалгаагаар баталгаажсан)
  Ус шүүлтүүрийн ГАДНААС ДОТОГШОО 3 давхрыг дараалан нэвтэрч, дараа нь голын хөндий сувгаар ДЭЭШЭЭ урсан шүршүүрийн толгойд хүрнэ.
  1️⃣ Гадна давхарга — PP нэхмэл бус бүрхүүл (цагаан): том тоосонцор, элс, зэвийн үлдэгдлийг барина
  2️⃣ Дунд давхарга — Active Carbon шахмал цагираг хана (хар): хлор, эвгүй үнэр, органик бодисыг шингээнэ
  3️⃣ Гол цөм — Нягтаршуулж Сайжруулсан PP давхарга (цагаан, өндөр нягтралтай шахмал хана): микро тоосонцрын эцсийн нарийн шүүлт
  • ⛔ KDF БАЙХГҮЙ. Металл тор БАЙХГҮЙ. "KDF" гэдэг үгийг ХЭЗЭЭ Ч бичихгүй.
  • ⛔ "Хүнд металл шүүнэ", "бактер устгана" гэж ХЭЗЭЭ Ч хэлэхгүй.
  • ✅ Баталгаатай claim зөвхөн: хлор, шохой, тунадас, зэв, эвгүй үнэр

▸ ЧУХАЛ — үнэ бичих форматын дүрэм:
  ✅ "199'900₮" (apostrophe-той)
  ❌ "199,900₮" биш
  ❌ "199900₮" биш
  ✅ Хуучин үнийг зураасаар БИШ, сумаар: "269'000₮ ➜ 199'900₮"
  ❌ "~~269'000₮~~" ХЭЗЭЭ Ч бичихгүй — Messenger энэ тэмдэгтийг зурааслаж чаддаггүй, хэрэглэгчид яг "~~" гэж харагдана.

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
4. ХАРИУЛТЫН ЗАГВАРУУД
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

▸ ШҮРШҮҮРИЙН ӨНГӨ СОНГОХ:
"Бэлгийн Багц — 199'900₮ 🎁 Бүх 3 өнгөнд ижил үнэ, ижил бүрэлдэхүүн:

⬛ Obsidian Black — мөнгөлөг цагираг, premium гүн хар
🤍 Pearl White — дулаан гэрэлтэй, цэвэр цайвар төрх
🩶 Slate Gray — час улаан дотоод цагираг, тансаг бараан тон

Та аль өнгийг сонгох вэ?"

▸ ҮНЭ АСУУВАЛ:
⚠️ JS код доорх текстийг ӨӨРӨӨ явуулна. Та үүнийг ДАВТАЖ бичихгүй:
"Бэлгийн Багц 269'000₮ ➜ 199'900₮ · 69'100₮ хэмнэнэ 🔥 ..."
Хэрэглэгч үүний дараа "дэлгэрэнгүй" гэвэл ЗӨВХӨН доорх задаргааг бич:

"Багцад орсон зүйлс:
✅ SkinBloom шүршүүр (Active Carbon Filter суурилуулсан — 44'900₮)
🪥 Brush (24'500₮) — үнэгүй
🧽 Donut Sponge (24'500₮) — үнэгүй
🚚 Хүргэлт — үнэгүй

Нийт хэмнэлт: 69'100₮ 🔥

Аль өнгийг сонгох уу?"

▸ ШҮҮЛТҮҮРИЙН ҮНЭ АСУУВАЛ:
⚠️ Та үнийг ХЭЛЭХГҮЙ. JS эхлээд тодруулга, дараа нь үнэ явуулна.
Хэрэв ямар нэг шалтгаанаар та хариулах шаардлагатай бол ЗӨВХӨН:
"Та манай SkinBloom шүршүүрийг худалдан авсан уу? 🌸"

▸ ШҮҮЛТҮҮР ЯАЖ АЖИЛЛАДАГ / БҮТЭЦ АСУУВАЛ:
"SkinBloom шүүлтүүр 3 давхар хамгаалалттай 💧 Ус гаднаас дотогшоо дараалан нэвтэрнэ:

1️⃣ PP нэхмэл бус бүрхүүл — том тоосонцор, элс, зэвийн үлдэгдэл
2️⃣ Active Carbon шахмал хана — хлор, эвгүй үнэр, органик бодис
3️⃣ Нягтаршуулж сайжруулсан PP цөм — микро тоосонцрын эцсийн нарийн шүүлт

Гурван шатыг бүрэн дамжсаны дараа л ус таны арьсанд хүрнэ 🌸"

▸ FILTER ТООГ АСУУВАЛ (багц авч байгаа явцад):
"Багцад шүршүүрт суурилуулсан ганцхан шүүлтүүр багтана 🌸 Нэмэлт шүүлтүүр дагалддаггүй. 3–6 сард нэг удаа солих ба нөөц шүүлтүүрийг тусад нь 29'900₮-өөр авна."

▸ ШҮРШҮҮРИЙГ ТУСД НЬ / ШҮҮЛТҮҮРТЭЙ ХАМТ АВАХ АСУУВАЛ:
"SkinBloom шүршүүр зөвхөн Бэлгийн Багцаар (199'900₮) ирдэг 🌸 Багцад Active Carbon Filter аль хэдийн суурилуулсан, дээр нь Brush, Donut Sponge бүгд багтсан — тусад нь авснаас хямд. Хожим нөөц шүүлтүүр хэрэгтэй болбол түүнийг тусад нь авч болно."

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
5. Утасны дугаар (системээр автоматаар шалгагдана — чи оронг нь ТООЛОХГҮЙ)
6. Төлбөрийн арга: "Төлбөрийг яаж хийх вэ? 1️⃣ Урьдчилж банкаар 2️⃣ Авсны дараа жолоочид бэлнээр"

▸ FLOW B — Зөвхөн Нөөц Шүүлтүүр (1 ширхэг 29'900₮):
⚠️ Тодруулга ("шүршүүр авсан уу?"), үнийн танилцуулга, "яг одоо хүргүүлээд авах уу?"
   гэсэн 3 алхмыг JS код өөрөө явуулна. Та тэдгээрийг ДАВТАХГҮЙ.
Хэрэглэгч авахаа зөвшөөрсний дараа зөвхөн ДУТУУ талбарыг нэг нэгээр асуу:
1. Бүрэн хаяг
2. Орцны код — "байхгүй бол алгасъя"
3. Утасны дугаар (оронг нь ТООЛОХГҮЙ)
4. Төлбөрийн арга
⛔ ӨНГӨ АСУУХГҮЙ — шүүлтүүрт өнгө байхгүй.
⛔ Бэлгийн Багц санал болгохгүй.
Нийт дүн = ширхэг × 29'900₮.

▸ MISSING FIELD ШАЛГАЛТ:
Дутуу талбар байвал ЗӨВХӨН ТЭР НЭГИЙГ л асуу — бүх талбарыг дахин давтахгүй.
Жишээ: утас дутуу бол "Утасны дугаараа оруулна уу 🌸"
Орцны код дутуу бол "Орцны код байгаа уу? Байхгүй бол алгасъя 🌸"

⛔⛔ УТАСНЫ ДУГААРЫГ ЧИ ШАЛГАХГҮЙ — ХАМГИЙН ЧУХАЛ ДҮРЭМ:
• Дугаарын оронг ХЭЗЭЭ Ч тоолохгүй. Чи тоо тоолж чаддаггүй.
• "8 оронтой оруулна уу", "8 оронтой байх ёстой", "дугаар буруу байна", "дахин шалгана уу" гэх мэт утасны алдааны мессежийг ХЭЗЭЭ Ч бичихгүй.
• Утасны дугаарын зөв эсэхийг систем (JS код) шалгаж, буруу бол хэрэглэгчид ӨӨРӨӨ сануулна. Чамд энэ ажил ОГТ ирэхгүй.
• Хэрэглэгч тоо явуулсан бол ТЭР НЬ ЗӨВ гэж үзэж, шууд дараагийн дутуу талбар руу шилж эсвэл захиалгыг баталгаажуул.
• Хэрэв [СИСТЕМИЙН ДОТООД МЭДЭЭЛЭЛ] блокт "Утасны дугаар: ... ✓" гэж байвал утас БҮРЭН цуглуулагдсан — дахин асуухыг хатуу хориглоно.

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

▸ ЗАХИАЛГА ЦУЦЛАХ ХҮСЭЛТ:
🚫 ХЭЗЭЭ Ч cancellation reply бичихгүй. JS код өөрийн логикоор cancellation flow-ийг handle хийнэ.
Хэрэглэгч "awsny daraa" / "авсны дараа" / "joloochid belneer" гэх payment мэдэгдэл өгөх нь ЦУЦЛАХ БИШ — COD сонголт. Энэ үед [COD_ORDER] tag ашигла.
Зөвхөн хэрэглэгч ИЛТ "цуцлая", "болиё", "хэрэггүй болсон" гэвэл [HANDOFF_NEEDED] tag нэм.

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
6. ТЕХНИКИЙН МЭДЭЭЛЭЛ
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
• Гарал үүсэл: Герман улсаас гаралтай брэнд, Европын CE стандартын дагуу үйлдвэрлэгдсэн
• ⛔ Өөр улс (Хонгконг, Хятад, Япон, Солонгос) ХЭЗЭЭ Ч дурдахгүй
• CE сертификат: HX240303050484
• Filter бүтэц — РАДИАЛ, гаднаас дотогшоо: PP нэхмэл бус бүрхүүл (цагаан) → Active Carbon шахмал цагираг хана (хар) → Нягтаршуулж Сайжруулсан PP цөм (цагаан)
• Усны урсгал: гаднаас дотогшоо 3 давхрыг нэвтэрч → голын хөндий сувгаар дээшээ → oval толгой
• ⛔ KDF БАЙХГҮЙ. Металл тор БАЙХГҮЙ. Ceramic БИШ — "ceramic" гэж хэзээ ч хэлэхгүй
• ⛔ "Хүнд металл", "бактер" claim БАЙХГҮЙ — зөвхөн хлор, шохой, тунадас, зэв, эвгүй үнэр
• Шүүлтүүрийн хэмжээ: 148мм × 25мм, шүршүүрийн бариул дотор нуугдсан (гаднаас харагдахгүй)
• Нэг л горим — өндөр даралт, spa мэдрэмж, 40% усны хэмнэлт
• Rain/massage/mist mode БАЙХГҮЙ
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
❌ "KDF" → ✅ "Нягтаршуулж Сайжруулсан PP давхарга"
❌ "Twin Pack" / "Family Pack" / "Single Pack" / "Single" → ✅ "1 ширхэг — 29'900₮" (өөр багц БАЙХГҮЙ)
❌ "Шүүлтүүр үнэгүй" / "шүүлтүүр бэлгээр дагалдана" → ✅ "Active Carbon Filter суурилуулсан — 44'900₮"
❌ "хүнд металл шүүнэ" / "бактер устгана" → ✅ "хлор, шохой, зэв, эвгүй үнэр"
❌ "Rose Red" / "криминал улаан" → ✅ "Slate Gray (дотор час улаан / crimson цагираг)"
❌ "шүршүүр хийх" → ✅ "усанд орох"
❌ "199,900₮" → ✅ "199'900₮"
❌ "~~269'000₮~~" → ✅ "269'000₮ ➜ 199'900₮"
❌ "Хонгконг" / "Хятад" / "Made in China" → ✅ "Герман улсаас гаралтай, Европын CE стандарт"
❌ "запас" → ✅ "нөөц" (запас зөвхөн хэрэглэгчийн үгийг таних дотоод keyword)
❌ 5+ мөрийн хариулт (хэрэв асуугаагүй бол) → ✅ богино, дараа нь дэлгэрнэ
❌ Хэрэглэгчийн алдаатай үгийг эсвэл Латин бичлэгийг засаж сургах → ✅ хэзээ ч засахгүй

ЧУХАЛ: [HANDOFF_NEEDED], [ORDER_EDIT], [COD_ORDER] тагуудыг хэрэглэгчид харуулахгүй — код дотор strip хийнэ.`;

const COMMENT_DM_PROMPT = `Та SkinBloom брэндийн AI туслах юм. Facebook/Instagram-д comment бичсэн хэрэглэгчид DM-ээр хариулна.

ДҮРЭМ:
• 1-2 өгүүлбэр, товч, найрсаг
• Нэрээр нь хандана (жишээ: "Сайн байна уу Бат? 🌸")
• Message Request шалгахыг хүс: "Message Request хэсэгээ шалгаарай 🌸"
• Шүүлтүүр асуувал: "Тийм, нөөц Active Carbon Filter байгаа! Дэлгэрэнгүйг DM-ээр явуулсан 🌸" — үнийг ЭНД хэлэхгүй, DM-д тодруулга хийнэ
• Захиалах асуувал: "skinbloom.store-с захиалж болно 🌸"
• Латинаар бичсэн comment-ийг ойлгож, хариултаа ҮРГЭЛЖ Кириллээр бич
• "KDF", "хүнд металл", "бактер" гэж ХЭЗЭЭ Ч бичихгүй
• "Twin Pack", "Family Pack", "Single Pack" гэж ХЭЗЭЭ Ч бичихгүй — байхгүй
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
  recordBotMessage(recipientId, text); // legacy echo tracking (v2.8.7-д ашиглагдахгүй, нөлөөгүй)
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
  recordBotMessage(recipientId, text); // legacy echo tracking (v2.8.7-д ашиглагдахгүй, нөлөөгүй)
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
      // ── ADMIN/PAGE TAKEOVER DETECT (echo event) — v2.8.7 (app_id-based) ──
      if (event.message?.is_echo) {
        const echoText = event.message?.text || '';
        const recipientId = event.recipient?.id;

        // app_id байвал → bot өөрөө илгээсэн мессежийн echo → БҮРЭН үл тоо
        if (event.message.app_id) {
          continue;
        }

        // app_id байхгүй → хүн Page inbox-оос ГАРААР бичсэн → ЖИНХЭНЭ admin takeover
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
      // ATTACHMENT HANDLING (v2.8.0) — image/video/voice/sticker/file
      // ═══════════════════════════════════════════════════════
      if (!text && attachments?.length > 0) {
        const attType = attachments[0]?.type;
        const attUrl = attachments[0]?.payload?.url || '';

        if (isDuplicateAttachment(senderId)) {
          console.log(`⏭ Duplicate attachment — skipping [${senderId}]`);
          continue;
        }

        if (attType === 'sticker') {
          console.log(`👍 Sticker [${senderId}] — quiet acknowledge`);
          continue;
        }

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
      // PRIORITY-ORDERED TRIGGER CHECKS
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

      // ═══════════════════════════════════════════════════════
      // 1.5) ШҮҮЛТҮҮРИЙН FLOW STATE (NEW v2.9.3)
      // ⚠️ ЗААВАЛ cancellation шалгалтаас ӨМНӨ байна. Учир нь хэрэглэгч
      // "аваагүй" гэж хариулах нь CANCELLATION_KEYWORDS-д байдаг тул
      // энэ блокгүй бол ердийн "үгүй" хариулт ЗАХИАЛГА ЦУЦЛАХ болж хувирна.
      // Зөвхөн filterStage идэвхтэй үед л ажиллана — өөр үед огт нөлөөлөхгүй.
      // ═══════════════════════════════════════════════════════
      const filterCtx = getOrder(senderId) || {};

      if (filterCtx.filterStage === 'ownership_asked') {
        if (isNegativeAnswer(text)) {
          console.log(`🧴 Filter: шүршүүр аваагүй [${senderId}]`);
          addToHistory(senderId, 'user', text);
          addToHistory(senderId, 'assistant', FILTER_NO_SHOWER_ANSWER);
          setOrder(senderId, { ...filterCtx, filterStage: null, orderType: 'BUNDLE', status: 'collecting' });
          await sendDM(senderId, FILTER_NO_SHOWER_ANSWER);
          continue;
        }
        if (isAffirmativeAnswer(text) || isBuyIntent(text)) {
          console.log(`🧴 Filter: шүршүүр эзэмшдэг → үнэ үзүүлэв [${senderId}]`);
          addToHistory(senderId, 'user', text);
          addToHistory(senderId, 'assistant', FILTER_PRICE_ANSWER);
          setOrder(senderId, {
            ...filterCtx, filterStage: 'price_shown', filterOwner: true,
            orderType: 'FILTER', qty: filterCtx.qty || 1, status: 'collecting'
          });
          await sendDM(senderId, FILTER_PRICE_ANSWER);
          continue;
        }
        // Тодорхойгүй хариулт → stage-ээ цэвэрлээд LLM-д даатгана (гацахгүй)
        setOrder(senderId, { ...filterCtx, filterStage: null });
      }

      if (filterCtx.filterStage === 'price_shown') {
        if (isNegativeAnswer(text)) {
          console.log(`🧴 Filter: одоо авахгүй [${senderId}]`);
          addToHistory(senderId, 'user', text);
          addToHistory(senderId, 'assistant', FILTER_DECLINE_ANSWER);
          setOrder(senderId, { ...filterCtx, filterStage: null });
          await sendDM(senderId, FILTER_DECLINE_ANSWER);
          continue;
        }
        // Зөвшөөрсөн ч, тодорхойгүй хариулсан ч — аль ч тохиолдолд ШҮҮЛТҮҮРИЙН
        // захиалга хэвээр үлдэж, LLM хаяг/утас/төлбөрийг цуглуулна.
        const wantsIt = isAffirmativeAnswer(text) || isBuyIntent(text);
        setOrder(senderId, {
          ...filterCtx, filterStage: 'collecting', orderType: 'FILTER',
          qty: filterCtx.qty || 1, status: 'collecting'
        });
        // Хэрэглэгч зөвшөөрөхийн ЗЭРЭГЦЭЭ хаягаа нэг мессежэнд бичсэн бол
        // ("тэгье, БЗД 26-р хороо 15-р байр") хаягийг дахин асуухгүй —
        // slot fill + LLM рүү унана.
        if (wantsIt && !filterCtx.address && !looksLikeAddress(text)) {
          console.log(`🧴 Filter: захиалга эхэллээ [${senderId}]`);
          addToHistory(senderId, 'user', text);
          addToHistory(senderId, 'assistant', FILTER_ADDRESS_ASK);
          await sendDM(senderId, FILTER_ADDRESS_ASK);
          continue;
        }
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

      // 3) CANCELLATION — захиалга цуцлах
      if (isCancellationRequest(text)) {
        console.log(`❌ Cancellation request [${senderId}]: ${text.slice(0, 60)}`);
        addToHistory(senderId, 'user', text);
        if (existingOrder && existingOrder.status === 'placed') {
          if (existingOrder.cancelStage === 'reason_asked') {
            const negativeReplies = /за яахав|битгий асуу|болсон|болсон шдээ|hereggu|kheregui|asuukhgui/i;
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

      // 4) USER ASKS FOR HUMAN — менежер/оператор/очиж үзэх → handoff
      if (isUserHandoffRequest(text)) {
        console.log(`🤝 User handoff request [${senderId}]: ${text.slice(0, 60)}`);
        addHandoff(senderId);
        addToHistory(senderId, 'user', text);
        await sendDMWithHumanAgent(senderId, 'Бид одоогоор зөвхөн онлайн зарж байна 🌸 Гэвч таны асуултанд манай менежер дэлгэрэнгүй хариулж, хэрэгтэй мэдээллийг өгөх болно.');
        await notifyTelegramHandoff(senderId, text);
        continue;
      }

      // 5) PROVINCE DELIVERY — орон нутгийн хүргэлт → handoff
      if (isProvinceDelivery(text)) {
        console.log(`🚛 Province delivery [${senderId}]: ${text.slice(0, 60)}`);
        addHandoff(senderId);
        addToHistory(senderId, 'user', text);
        await sendDMWithHumanAgent(senderId, '🌸 Орон нутгийн хүргэлтийн талаар манай менежер тантай холбогдож, хүргэлтийн тариф болон хугацааг тодорхой хэлэх болно.');
        await notifyTelegramProvince(senderId, text);
        continue;
      }

      // 6) WHOLESALE — оптын/4+ ширхэг → handoff
      if (isWholesaleRequest(text)) {
        console.log(`🏪 Wholesale [${senderId}]: ${text.slice(0, 60)}`);
        addHandoff(senderId);
        addToHistory(senderId, 'user', text);
        await sendDMWithHumanAgent(senderId, '🌸 Олон ширхэгээр авах хүсэлтэд нь баярлалаа! Оптын үнэ болон нөхцлийн талаар манай менежер тантай удахгүй холбогдох болно.');
        await notifyTelegramWholesale(senderId, text);
        continue;
      }

      // 7) PRICE MANIPULATION — үнэ буулгах хүсэлт → handoff
      if (isPriceManipulation(text)) {
        console.log(`💸 Price manipulation [${senderId}]: ${text.slice(0, 60)}`);
        addHandoff(senderId);
        addToHistory(senderId, 'user', text);
        await sendDMWithHumanAgent(senderId, 'Манай үнэ нь одоогоор зарлагдсан хямдралтай үнэ юм 🌸 Тусгай нөхцөл, бөөний үнийн талаар манай менежер тантай холбогдоно.');
        await notifyTelegramHandoff(senderId, `[Price manipulation] ${text}`);
        continue;
      }

      // 8) UGC / INFLUENCER (one-time notify, бот үргэлжлүүлэн ажиллана)
      if (isUGCOrInfluencer(text)) {
        console.log(`📸 UGC/Influencer detected [${senderId}]`);
        await notifyTelegramUGC(senderId, text);
      }

      // ═══════════════════════════════════════════════════════
      // 9) ГАРАЛ ҮҮСЭЛ (NEW v2.9.3) — "аль улсынх вэ", "haanahiih ve"
      // ═══════════════════════════════════════════════════════
      if (isOriginQuestion(text)) {
        console.log(`🌍 Origin question [${senderId}]: ${text.slice(0, 60)}`);
        addToHistory(senderId, 'user', text);
        addToHistory(senderId, 'assistant', ORIGIN_ANSWER);
        await sendDM(senderId, ORIGIN_ANSWER);
        continue;
      }

      // ═══════════════════════════════════════════════════════
      // 10) ШҮҮЛТҮҮРИЙН ҮНЭ / ЗАХИАЛГА (NEW v2.9.3)
      // Үнэ хэлэхээс ӨМНӨ заавал "шүршүүрээ авсан уу?" тодруулга.
      // ⚠️ Үнийн ерөнхий hook-оос ӨМНӨ шалгана — эс тэгвэл "шүүлтүүр үнэ хэд вэ"
      // гэсэн асуулт Бэлгийн Багцын үнээр хариулагдана.
      // ═══════════════════════════════════════════════════════
      if (hasFilterWord(text) && (isPriceQuestion(text) || isBuyIntent(text))) {
        const fState = getOrder(senderId) || {};
        // Аль хэдийн "шүршүүрээ авсан" гэдгээ хэлсэн бол дахин асуухгүй
        if (fState.filterOwner) {
          console.log(`🧴 Filter intent (эзэмшигч мэдэгдсэн) [${senderId}]`);
          addToHistory(senderId, 'user', text);
          addToHistory(senderId, 'assistant', FILTER_PRICE_ANSWER);
          setOrder(senderId, {
            ...fState, filterStage: 'price_shown', orderType: 'FILTER',
            qty: fState.qty || 1, status: 'collecting'
          });
          await sendDM(senderId, FILTER_PRICE_ANSWER);
        } else {
          console.log(`🧴 Filter intent → эзэмшлийн тодруулга [${senderId}]: ${text.slice(0, 60)}`);
          addToHistory(senderId, 'user', text);
          addToHistory(senderId, 'assistant', FILTER_OWNERSHIP_ASK);
          setOrder(senderId, { ...fState, filterStage: 'ownership_asked', status: fState.status || 'collecting' });
          await sendDM(senderId, FILTER_OWNERSHIP_ASK);
        }
        markGreeting(senderId);
        continue;
      }

      // ═══════════════════════════════════════════════════════
      // 11) ҮНИЙН АСУУЛТ (NEW v2.9.3) — Бэлгийн Багцын детерминистик hook
      // ⚠️ Захиалга аль хэдийн баталгаажсан бол хөндөхгүй (LLM-д үлдээнэ).
      // ═══════════════════════════════════════════════════════
      const priceState = getOrder(senderId) || {};
      if (isPriceQuestion(text)
        && priceState.status !== 'placed'
        && priceState.orderType !== 'FILTER'
        && !hasFilterWord(text)) {
        console.log(`💰 Price question [${senderId}]: ${text.slice(0, 60)}`);
        addToHistory(senderId, 'user', text);
        addToHistory(senderId, 'assistant', PRICE_ANSWER);
        await sendDM(senderId, PRICE_ANSWER);
        markGreeting(senderId);
        continue;
      }

      // ═══════════════════════════════════════════════════════
      // GREETING ANTI-REPEAT (v2.8.0)
      // ═══════════════════════════════════════════════════════
      const greetingPattern = /^(сайн уу|sain uu|hi|hello|мэнд|байна уу|baina uu|hey|өө байна уу)/i;
      const isGreeting = greetingPattern.test(text.trim());

      // ═══════════════════════════════════════════════════════
      // DIRECT INFO REQUEST (v2.8.0)
      // v2.9.3: шүүлтүүрийн үг агуулсан бол ЭНД БАРИХГҮЙ — LLM-д даана,
      // эс тэгвэл "шүүлтүүрийн тухай дэлгэрэнгүй" гэхэд Бэлгийн Багц pitch хийнэ.
      // ═══════════════════════════════════════════════════════
      if (isDirectInfoRequest(text) && !hasFilterWord(text)) {
        console.log(`ℹ️ Direct info request [${senderId}]`);
        const infoMessage = `SkinBloom Бэлгийн Багц 269'000₮ ➜ 199'900₮ 🎁

Бүх 3 өнгөнд ижил үнэ, ижил бүрэлдэхүүн:
⬛ Obsidian Black — мөнгөлөг цагираг, premium гүн хар
🤍 Pearl White — дулаан гэрэлтэй, цэвэр цайвар төрх
🩶 Slate Gray — час улаан дотоод цагираг, тансаг бараан тон

Багцад орсон зүйлс:
✅ SkinBloom шүршүүр (Active Carbon Filter суурилуулсан — 44'900₮)
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
      // PHONE INPUT VALIDATION (v2.9.2) — LLM-д ХҮРГЭХГҮЙ
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
      // BATCH SLOT FILLING (v2.8.0)
      // ═══════════════════════════════════════════════════════
      const currentOrder = getOrder(senderId) || { status: 'collecting' };
      if (currentOrder.status === 'collecting' || !currentOrder.status) {
        const parsed = parseOrderSlots(text, currentOrder);
        if (parsed.color || parsed.address || parsed.phone || parsed.payment) {
          setOrder(senderId, { ...parsed, status: 'collecting' });
          console.log(`📝 Slot fill [${senderId}]: ${JSON.stringify({
            type: parsed.orderType || 'BUNDLE',
            color: parsed.color, qty: parsed.qty, address: parsed.address?.slice(0, 30),
            phone: parsed.phone, payment: parsed.payment, code: parsed.entranceCode
          })}`);
        }
      }

      console.log(`📩 DM [${senderId}]: ${text.slice(0, 60)}`);
      try {
        // ── FIRST-CONTACT GREETING (v2.8.5, race-safe v2.8.6) ──
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

        const reply = await askGPT_DM(senderId, text, buildOrderStateNote(senderId));

        // BOT REPLY-ийн доторх tag-уудыг шинжлэх
        const isHandoff = shouldTriggerHandoff(reply);
        const isOrder = isOrderComplete(reply);
        const isCOD = isCODOrder(reply) || reply.includes('[COD_ORDER]');
        const isBank = reply.includes('[BANK_ORDER]');
        const isOrderEdit = reply.includes('[ORDER_EDIT]') || isOrderEditRequest(text);

        // Tag-уудыг арилгана
        let cleanReply = reply
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

        // ── v2.9.2 GUARD #1: ДАВХАР GREETING ──
        if (cleanReply.includes('SkinBloom AI туслах тантай холбогдлоо')) {
          if (hasRecentGreeting(senderId)) {
            console.log(`🔁 Duplicate greeting suppressed [${senderId}]`);
            cleanReply = 'Өнгө сонгоход туслах уу, эсвэл бэлгийн багцын талаар мэдэхийг хүсэж байна уу? 🌸';
          } else {
            markGreeting(senderId);
          }
        }

        // ── v2.9.2 GUARD #2: УТАСНЫ АЛДААНЫ МЕССЕЖ ──
        const stOrder = getOrder(senderId) || {};
        if (stOrder.phone && /8\s*орон|найман орон|дугаар.*буруу|дугаараа.*дахин/i.test(cleanReply)) {
          console.log(`🛑 LLM phone-error suppressed [${senderId}] (phone=${stOrder.phone})`);
          const missing = [];
          if (stOrder.orderType !== 'FILTER' && !stOrder.color) missing.push('Аль өнгийг сонгох вэ? (Pearl White / Slate Gray / Obsidian Black) 🌸');
          else if (stOrder.orderType !== 'FILTER' && !stOrder.qty) missing.push('Хэдэн ширхэг авах вэ? 🌸');
          else if (!stOrder.address) missing.push('Хүргэлтийн бүрэн хаягаа явуулна уу (дүүрэг, хороо, байр, тоот) 🌸');
          else if (!stOrder.payment) missing.push('Төлбөрийг яаж хийх вэ? 1️⃣ Урьдчилж банкаар 2️⃣ Авсны дараа жолоочид бэлнээр 🌸');
          cleanReply = missing.length
            ? `Дугаарыг тань хүлээн авлаа ✅ ${missing[0]}`
            : 'Дугаарыг тань хүлээн авлаа ✅ Танд өөр тодруулах зүйл байна уу? 🌸';
        }

        // ── v2.9.3 GUARD #3: TWIN / FAMILY PACK ──
        // Багцууд SYSTEM_PROMPT-оос устсан ч 4o-mini хуучин ярианаас
        // санаж гаргах эрсдэл үлддэг. Гарвал таслаад зөв текстээр солино.
        if (/twin\s*pack|family\s*pack|single\s*pack|54'?900|79'?900|89'?800|134'?700/i.test(cleanReply)) {
          console.log(`🛑 Twin/Family pack mention suppressed [${senderId}]`);
          // Эзэмшлийн тодруулга хийгээгүй бол ҮНИЙГ ХАРУУЛАХГҮЙ — эхлээд тодруулна.
          if (stOrder.filterOwner) {
            cleanReply = FILTER_PRICE_ANSWER;
            setOrder(senderId, { ...stOrder, filterStage: 'price_shown', orderType: 'FILTER', qty: stOrder.qty || 1 });
          } else {
            cleanReply = FILTER_OWNERSHIP_ASK;
            setOrder(senderId, { ...stOrder, filterStage: 'ownership_asked', status: stOrder.status || 'collecting' });
          }
        }

        // ── v2.9.3 GUARD #4: ГАРАЛ ҮҮСЛИЙН ЗӨРЧИЛ ──
        if (/хонгконг|хонг конг|hong\s*kong|хятад|hyatad|made in china/i.test(cleanReply)) {
          console.log(`🛑 Wrong-origin mention suppressed [${senderId}]`);
          cleanReply = ORIGIN_ANSWER;
        }

        await sendDM(senderId, cleanReply);

        // ── Захиалга баталгаажсан үед ──
        if (isOrder || isCOD || isBank) {
          console.log(`🛍 Order complete [${senderId}] COD=${isCOD} BANK=${isBank}`);

          const llmAlreadyAssembled = /(?:өнгө|өнгь|color)\s*[:：]/i.test(cleanReply)
            && /(?:хаяг|address)\s*[:：]/i.test(cleanReply)
            && /(?:утас|phone|дугаар)\s*[:：]/i.test(cleanReply)
            && !/тодруулагдана|to be confirmed|байхгүй|тогтоох/i.test(cleanReply);

          const orderState = getOrder(senderId) || {};
          const isFilterOrder = orderState.orderType === 'FILTER';

          // v2.9.3: ШҮҮЛТҮҮРИЙН захиалгад ӨНГӨ шаардлагагүй
          const hasFullState = isFilterOrder
            ? Boolean(orderState.address && orderState.phone)
            : Boolean(orderState.color && orderState.address && orderState.phone);

          if (!llmAlreadyAssembled && hasFullState) {
            const qty = orderState.qty || 1;
            const unit = unitPriceFor(orderState);
            const total = formatMNT(qty * unit);
            const address = orderState.address;
            const phone = orderState.phone;

            const productBlock = isFilterOrder
              ? `📦 Бүтээгдэхүүн: Нөөц Шүүлтүүр\n📦 Тоо: ${qty} ширхэг`
              : `🎨 Өнгө: ${orderState.color}\n📦 Тоо: ${qty} ширхэг`;

            const orderDetails = `📋 Захиалгын мэдээлэл:

${productBlock}
💰 Нийт: ${total}
📍 Хаяг: ${address}
📞 Утас: ${phone}

24–48 цагт хүргэгдэнэ 🌸 Манайхыг сонгосонд баярлалаа!`;
            await sendDM(senderId, orderDetails);
          } else if (!llmAlreadyAssembled && !hasFullState) {
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
            const total = formatMNT(qty * unitPriceFor(orderStateForCod));
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
  status: '🌸 SkinBloom Bot running', version: '2.9.3',
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
  console.log(`🌸 SkinBloom Bot v2.9.3 listening on port ${PORT}`);
  await registerTelegramWebhook();
  await sendTelegram('🌸 <b>SkinBloom Bot v2.9.3 асаалаа!</b>\n\n🆕 <b>Шинэ (v2.9.3):</b>\n✅ Үнэ асуухад детерминистик hook (JS-ээс)\n✅ Шүүлтүүрийн үнэ хэлэхээс өмнө "шүршүүр авсан уу?" тодруулга\n✅ Twin Pack / Family Pack бүрэн устгав — зөвхөн 1ш 29\'900₮\n✅ Латин бичлэг (une hed ve, filter avya, haanahiih ve) танина\n✅ Гарал үүсэл: Герман, Европын CE стандарт\n✅ Messenger-т эвдэрдэг ~~зураас~~ → ➜ сум болов\n\n<b>v2.9.2:</b> Утасны шалгалт JS-д\n<b>v2.9.1:</b> Шүүлтүүр "үнэгүй" сигнал хасагдав\n<b>v2.9.0:</b> KDF устгаж РАДИАЛ 3 давхар canon\n\n<b>Командууд:</b>\n<code>/help</code> — бүх команд\n<code>/list</code> — handoff list\n<code>/release [id]</code> — handoff унтраах\n<code>/send [id] [1|2|3]</code> — draft илгээх\n<code>/dm [id] [text]</code> — гар мессеж\n<code>/draft [id]</code> — шинэ draft');
});
