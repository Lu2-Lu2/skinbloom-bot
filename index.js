require('dotenv').config();
const express = require('express');
const axios = require('axios');
const crypto = require('crypto');

const app = express();

app.use(express.json({
  verify: (req, res, buf) => { req.rawBody = buf; }
}));

const OPENAI_KEY = process.env.OPENAI_API_KEY;
const VERIFY_TOKEN = process.env.META_VERIFY_TOKEN;
const APP_SECRET = process.env.META_APP_SECRET;
const PAGE_TOKEN = process.env.PAGE_ACCESS_TOKEN;

// ── Conversation history ──
const conversations = {};
const MAX_HISTORY = 20;

function getHistory(senderId) {
  if (!conversations[senderId]) conversations[senderId] = [];
  return conversations[senderId];
}

function addHistory(senderId, role, content) {
  const hist = getHistory(senderId);
  hist.push({ role, content });
  if (hist.length > MAX_HISTORY) hist.splice(0, hist.length - MAX_HISTORY);
}

// ── SkinBloom system prompt ──
const SYSTEM_PROMPT = `Та SkinBloom брэндийн AI туслах "Bloom" юм. Монгол хэлээр зөөлөн, найрсаг өнгө аястай хариулна.

БҮТЭЭГДЭХҮҮН:
- Pearl White 3-в-1: шүршүүр + filter + sponge + brush — 269,000₮-с хямдраад 199,900₮ (сүүлийн 3 үнэгүй)
- Slate Gray: 269,000₮-с хямдраад 199,900₮ — дотор crimson цагираг
- Obsidian Black: 269,000₮-с хямдраад 199,900₮ — silver ring, luxury

FILTER: PP fiber → Carbon → KDF (керамик биш, 40% ус хэмнэнэ)
ХҮРГЭЛТ: УБ 24-48 цагын дотор, орон нутаг унаанд өгж явуулна

ЗАХИАЛГА АВАХ ДҮРЭМ:
Хэрэглэгч захиалах гэж байвал эхлээд сонголт өгнө:
"Та skinbloom.store руу орж захиалга хийх эсвэл чат-р мэдээллээ явуулж захиалга хийх боломжтой 🌸"

ХАЯГИЙН МЭДЭЭЛЭЛ ЦУГЛУУЛАХ (уян хатан):
Хаягийн мэдээллийг хэрэглэгч өөрөө явуулсан хэлбэрт нь хүлээн ав — хотхон, байр, тоот гэх мэт нэршил хүн бүрд өөр байдаг.
Гол зорилго нь хүргэгч хаягийг олж чадах хэмжээний мэдээлэл цуглуулах явдал.

УБ хүргэлтэд цуглуулах мэдээлэл:
- Дүүрэг (заавал)
- Хороо (заавал)  
- Хаяг: хотхон/байр/тоот/хаалга — хэрэглэгч өөрийнхөөрөө дурайлган бичиж явуулна, хүргэгч олох боломжтой байвал хангалттай
- Орцны код (байгаа бол)
- Холбогдох утасны дугаар (заавал)
- Өнгөний сонголт (заавал)
- Тоо ширхэг (заавал)

Орон нутгийн хүргэлтэд цуглуулах мэдээлэл:
- Аймаг (заавал)
- Сум (заавал)
- Холбогдох утасны дугаар (заавал)
- Өнгөний сонголт (заавал)
- Тоо ширхэг (заавал)

МЭДЭЭЛЭЛ ЦУГЛУУЛАХ ДҮРЭМ (МАШ ЧУХАЛ):
- Хэрэглэгч явуулсан мэдээллийг хадгалж аваад ЗӨВХӨН дутуу байгаа зайлшгүй мэдээллийг нэг нэгээр нь зөөлөн асуу
- "мэдэгдэнэ үү" биш "явуулаарай" гэсэн үг ашиглах
- Жишээ: "Баярлалаа 🌸 Холбогдох утасны дугаараа явуулаарай"
- Хэзээ ч бүх жагсаалтыг дахин давтаж бичихгүй
- Хаягийн мэдээлэл хүргэгч олохуйц болсон гэж үзвэл дараагийн дутуу зүйл рүү шилж
- Бүх мэдээлэл бүрэн болсон үед: "Таны захиалгыг хүлээн авлаа ✅ Удахгүй холбогдох болно 🌸"

ЕРӨНХИЙ ДҮРЭМ:
- Монгол хэлээр, товч зөөлөн өнгө аястайгаар хариул
- "Усанд орох" хэл, "шүршүүр хийх" битгий хэл
- Ceramic, rain mode, massage mode гэж хэзээ ч хэлэхгүй
- Emoji дунд зэрэг ашиглана 🌸`;

// ── GPT call with history ──
async function askGPT(senderId, userMessage) {
  const history = getHistory(senderId);
  const messages = [
    { role: 'system', content: SYSTEM_PROMPT },
    ...history,
    { role: 'user', content: userMessage }
  ];

  const res = await axios.post('https://api.openai.com/v1/chat/completions', {
    model: 'gpt-4o-mini',
    messages,
    temperature: 0.65,
    max_tokens: 400
  }, {
    headers: { Authorization: `Bearer ${OPENAI_KEY}` }
  });

  const reply = res.data.choices[0].message.content.trim();
  addHistory(senderId, 'user', userMessage);
  addHistory(senderId, 'assistant', reply);
  return reply;
}

// ── GPT call without history (comments) ──
async function askGPTOnce(userMessage, extra = '') {
  const messages = [
    { role: 'system', content: SYSTEM_PROMPT + (extra ? '\n\n' + extra : '') },
    { role: 'user', content: userMessage }
  ];
  const res = await axios.post('https://api.openai.com/v1/chat/completions', {
    model: 'gpt-4o-mini', messages, temperature: 0.65, max_tokens: 200
  }, { headers: { Authorization: `Bearer ${OPENAI_KEY}` } });
  return res.data.choices[0].message.content.trim();
}

// ── Verify Meta signature ──
function verifySignature(req) {
  if (!APP_SECRET) return true;
  const sig = req.headers['x-hub-signature-256'];
  if (!sig) return false;
  const expected = 'sha256=' + crypto.createHmac('sha256', APP_SECRET).update(req.rawBody).digest('hex');
  return crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expected));
}

// ── Send message ──
async function sendMessage(recipientId, text) {
  try {
    await axios.post(`https://graph.facebook.com/v19.0/me/messages`, {
      recipient: { id: recipientId },
      message: { text }
    }, { params: { access_token: PAGE_TOKEN } });
    console.log('✓ Sent to', recipientId);
  } catch (e) {
    console.error('✗ Send error:', e.response?.data || e.message);
  }
}

// ── Reply to comment ──
async function replyComment(commentId, text) {
  try {
    await axios.post(`https://graph.facebook.com/v19.0/${commentId}/comments`, {
      message: text
    }, { params: { access_token: PAGE_TOKEN } });
    console.log('✓ Comment replied');
  } catch (e) {
    console.error('✗ Comment error:', e.response?.data || e.message);
  }
}

// ── Webhook verify ──
app.get('/webhook', (req, res) => {
  const mode = req.query['hub.mode'];
  const token = req.query['hub.verify_token'];
  const challenge = req.query['hub.challenge'];
  if (mode === 'subscribe' && token === VERIFY_TOKEN) {
    console.log('✓ Webhook verified');
    res.status(200).send(challenge);
  } else {
    res.sendStatus(403);
  }
});

// ── Webhook events ──
app.post('/webhook', async (req, res) => {
  if (!verifySignature(req)) return res.sendStatus(401);
  res.sendStatus(200);

  const body = req.body;
  if (body.object !== 'page' && body.object !== 'instagram') return;

  for (const entry of body.entry || []) {
    // ── MESSENGER / IG DM ──
    for (const event of entry.messaging || []) {
      if (!event.message || event.message.is_echo) continue;
      const senderId = event.sender.id;
      const text = event.message.text;
      if (!text) continue;

      console.log(`📩 DM from ${senderId}: ${text}`);
      try {
        const reply = await askGPT(senderId, text);
        await sendMessage(senderId, reply);
      } catch (e) {
        console.error('GPT error:', e.message);
        await sendMessage(senderId, 'Уучлаарай, дахин оролдоно уу 🌸');
      }
    }

    // ── FACEBOOK COMMENTS ──
    for (const change of entry.changes || []) {
      if (change.field !== 'feed') continue;
      const val = change.value;

      if (val.item === 'comment' && val.verb === 'add' && !val.parent_id) {
        const commentId = val.comment_id;
        const text = val.message;
        if (!text) continue;
        console.log(`💬 FB Comment: ${text}`);
        try {
          const reply = await askGPTOnce(text, 'Facebook comment. 1-2 өгүүлбэрт товч хариул.');
          await replyComment(commentId, reply);
        } catch (e) { console.error('GPT error:', e.message); }
      }

      // ── INSTAGRAM COMMENT ──
      if (val.item === 'comment' && val.verb === 'add' && val.media?.media_type) {
        const commentId = val.comment_id;
        const text = val.message;
        if (!text) continue;
        console.log(`📸 IG Comment: ${text}`);
        try {
          const reply = await askGPTOnce(text, 'Instagram comment. 1-2 өгүүлбэрт товч хариул.');
          await replyComment(commentId, reply);
        } catch (e) { console.error('GPT error:', e.message); }
      }
    }
  }
});

app.get('/', (req, res) => res.json({ status: '🌸 SkinBloom Bot running', time: new Date() }));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`🌸 SkinBloom Bot listening on port ${PORT}`));
