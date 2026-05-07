require('dotenv').config();
const express = require('express');
const axios = require('axios');
const crypto = require('crypto');

const app = express();

// ── Raw body for signature verification ──
app.use(express.json({
  verify: (req, res, buf) => { req.rawBody = buf; }
}));

const OPENAI_KEY = process.env.OPENAI_API_KEY;
const VERIFY_TOKEN = process.env.META_VERIFY_TOKEN;
const APP_SECRET = process.env.META_APP_SECRET;
const PAGE_TOKEN = process.env.PAGE_ACCESS_TOKEN;

// ── SkinBloom system prompt ──
const SYSTEM_PROMPT = `Та SkinBloom брэндийн AI туслах "Bloom" юм. Монгол хэлээр товч, найрсаг хариулна.

БҮТЭЭГДЭХҮҮН:
- Pearl White 3-в-1: шүршүүр + filter + sponge + brush — 89,900₮ (сүүлийн 3 үнэгүй)
- Slate Gray: 89,900₮ — дотор crimson цагираг
- Obsidian Black: 89,900₮ — silver ring, luxury

FILTER: PP fiber → Carbon → KDF (керамик биш, 40% ус хэмнэнэ)
ХҮРГЭЛТ: УБ 1-2 хоног, орон нутаг 3-5 хоног
ЗАХИАЛГА: skinbloom.mn

ДҮРЭМ:
- Монгол хэлээр, 2-3 өгүүлбэр (comment), 3-5 өгүүлбэр (DM)
- Захиалах гэвэл skinbloom.mn руу чиглүүл
- "Усанд орох" хэл, "шүршүүр хийх" битгий хэл
- Ceramic, rain mode, massage mode гэж хэзээ ч хэлэхгүй
- Emoji дунд зэрэг ашиглана 🌸`;

// ── GPT call ──
async function askGPT(userMessage, context = '') {
  const messages = [
    { role: 'system', content: SYSTEM_PROMPT }
  ];
  if (context) messages.push({ role: 'user', content: `[Контекст: ${context}]` });
  messages.push({ role: 'user', content: userMessage });

  const res = await axios.post('https://api.openai.com/v1/chat/completions', {
    model: 'gpt-4o-mini',
    messages,
    temperature: 0.65,
    max_tokens: 300
  }, {
    headers: { Authorization: `Bearer ${OPENAI_KEY}` }
  });
  return res.data.choices[0].message.content.trim();
}

// ── Verify Meta signature ──
function verifySignature(req) {
  if (!APP_SECRET) return true; // dev mode
  const sig = req.headers['x-hub-signature-256'];
  if (!sig) return false;
  const expected = 'sha256=' + crypto.createHmac('sha256', APP_SECRET).update(req.rawBody).digest('hex');
  return crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expected));
}

// ── Send FB/IG message ──
async function sendMessage(recipientId, text) {
  try {
    await axios.post(`https://graph.facebook.com/v19.0/me/messages`, {
      recipient: { id: recipientId },
      message: { text }
    }, {
      params: { access_token: PAGE_TOKEN }
    });
    console.log('✓ Message sent to', recipientId);
  } catch (e) {
    console.error('✗ Send error:', e.response?.data || e.message);
  }
}

// ── Reply to comment ──
async function replyComment(commentId, text) {
  try {
    await axios.post(`https://graph.facebook.com/v19.0/${commentId}/comments`, {
      message: text
    }, {
      params: { access_token: PAGE_TOKEN }
    });
    console.log('✓ Comment replied:', commentId);
  } catch (e) {
    console.error('✗ Comment reply error:', e.response?.data || e.message);
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
  res.sendStatus(200); // Respond fast to Meta

  const body = req.body;
  if (body.object !== 'page' && body.object !== 'instagram') return;

  for (const entry of body.entry || []) {
    // ── MESSENGER / DM ──
    for (const event of entry.messaging || []) {
      if (!event.message || event.message.is_echo) continue;
      const senderId = event.sender.id;
      const text = event.message.text;
      if (!text) continue;

      console.log(`📩 DM from ${senderId}: ${text}`);
      try {
        const reply = await askGPT(text, 'Энэ нь DM/Messenger хариулт');
        await sendMessage(senderId, reply);
      } catch (e) {
        console.error('GPT error:', e.message);
        await sendMessage(senderId, 'Уучлаарай, дахин оролдоно уу. skinbloom.mn 🌸');
      }
    }

    // ── FACEBOOK COMMENTS ──
    for (const change of entry.changes || []) {
      if (change.field !== 'feed') continue;
      const val = change.value;

      // New comment on post
      if (val.item === 'comment' && val.verb === 'add' && !val.parent_id) {
        const commentId = val.comment_id;
        const text = val.message;
        const commenterName = val.from?.name || 'Хэрэглэгч';
        if (!text || val.from?.id === val.post_id?.split('_')[0]) continue; // skip own

        console.log(`💬 Comment from ${commenterName}: ${text}`);
        try {
          const reply = await askGPT(text, `Facebook comment. Хэрэглэгчийн нэр: ${commenterName}`);
          await replyComment(commentId, reply);
        } catch (e) {
          console.error('GPT error:', e.message);
        }
      }

      // Instagram comment
      if (val.item === 'comment' && val.verb === 'add' && val.media?.media_type) {
        const commentId = val.comment_id;
        const text = val.message;
        if (!text) continue;

        console.log(`📸 IG Comment: ${text}`);
        try {
          const reply = await askGPT(text, 'Instagram comment. Товч хариул.');
          await replyComment(commentId, reply);
        } catch (e) {
          console.error('GPT error:', e.message);
        }
      }
    }

    // ── INSTAGRAM DM ──
    for (const event of entry.messaging || []) {
      if (event.message?.is_echo) continue;
      if (!entry.id?.includes('ig')) continue; // IG only
      const text = event.message?.text;
      const senderId = event.sender?.id;
      if (!text || !senderId) continue;

      console.log(`📸 IG DM from ${senderId}: ${text}`);
      try {
        const reply = await askGPT(text, 'Instagram DM');
        await sendMessage(senderId, reply);
      } catch (e) {
        await sendMessage(senderId, 'Уучлаарай! skinbloom.mn-д зочилно уу 🌸');
      }
    }
  }
});

// ── Health check ──
app.get('/', (req, res) => res.json({ status: '🌸 SkinBloom Bot running', time: new Date() }));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`🌸 SkinBloom Bot listening on port ${PORT}`));
