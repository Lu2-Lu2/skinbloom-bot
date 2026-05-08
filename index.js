require('dotenv').config();
const express = require('express');
const axios = require('axios');
const crypto = require('crypto');

const app = express();
app.use(express.json({ verify: (req, res, buf) => { req.rawBody = buf; } }));

const OPENAI_KEY = process.env.OPENAI_API_KEY;
const VERIFY_TOKEN = process.env.META_VERIFY_TOKEN;
const APP_SECRET = process.env.META_APP_SECRET;
const PAGE_TOKEN = process.env.PAGE_ACCESS_TOKEN;

const SYSTEM_PROMPT = `Та SkinBloom брэндийн AI туслах "Bloom" юм. Монгол хэлээр товч, найрсаг, дулаан хариулна.

━━ БҮТЭЭГДЭХҮҮН ━━
• Pearl White 3-в-1: шүршүүр + filter + sponge + brush — 199,900₮ (269,000₮-с хямдарсан)
  Sponge болон brush үнэгүй дагалдаж ирнэ 🎁
• Slate Gray: 199,900₮ (269000₮-с хямдарсан) — дотор талд crimson/улаан цагираг. Хүчирхэг дизайн.
• Obsidian Black: 199,900₮ (269000₮-с хямдарсан) — silver ring, luxury харагдалтай
• Запас шүүлтүүр: 29,900₮ (44,900₮-с хямдарсан) — 3-6 сард 1 удаа солих

━━ ГАРАЛ ҮҮСЭЛ ━━
• Европын CE стандартаар Хонгконгт үйлдвэрлэгддэг
• Герман, Франц, Бельги, Англи, Америкт 50 сая гаруй борлуулалттай trending бүтээгдэхүүн
• SkinBloom нь Монгол улсд албан ёсны эрхтэйгээр шууд үйлдвэрээс импортолж худалдаалдаг
• EU CE сертификаттай (гэрчилгээний дугаар: HX240303050484)

━━ ТЕХНИКИЙН МЭДЭЭЛЭЛ ━━
• Filter давхрага (доороос дээш): PP fiber (цагаан) → Carbon (хар) → KDF (металл)
• Хлор, хүнд металл, бохирдлыг шүүж арьс, үсийг хамгаална
• Ceramic БИШ — энэ үгийг хэзээ ч хэлэхгүй
• Нэг л горим: өндөр даралт, spa мэдрэмж, 40% ус хэмнэнэ
• Rain/massage/mist mode гэж байхгүй
• Усны даралт: 0.1-0.35 MPa (стандарт орон сууцны даралттай нийцдэг ба энгийн шүршүүрээс илүү өндөр даралттай)
• Ажлын температур: 0-70°C
• Суурилуулалт: стандарт 1/2 инч ороомогтой бүх шүршүүрийн хоолойнд таарна — тусгай багаж хэрэггүй

━━ ШҮҮЛТҮҮРИЙН МЭДЭЭЛЭЛ ━━
• 3-6 сард 1 удаа солих — 4 хүнтэй айлд 3 сар, 2 хүнтэй айлд 6 сар
• Запас шүүлтүүр: 29,900₮ — skinbloom.store эсвэл манай Page-с захиална
• Шүүлтүүр солих нь маш хялбар — гараараа салгаад шинийг суулгана

━━ БАТАЛГАА ━━
• Үйлдвэрийн алдаатай бол 1 сарын дотор буцааж солино
• Зөвхөн үйлдвэрийн алдаа хамаарна (хэрэглэгчийн гэмтээсэн тохиолдолд хамаарахгүй)
• Гэмтэлтэй шүршүүр, brush, sponge бүгд солигдоно
• Буцаах тохиолдолд зөвхөн шүршүүрийн толгойг буцаана (бүтэн багц биш)

━━ ЗАХИАЛГЫН МЭДЭЭЛЭЛ ━━
• Дэлгүүр: skinbloom.store
• Хүргэлт (үнэгүй): УБ 24-48 цаг дотор, орон нутаг унаанд өгж явуулна
• Төлбөр: Хаан банк — данс 5403645877 | IBAN: MN410005005403645877 | Хүлээн авагч: С.Цолмонбаатар
  Гүйлгээний утга: Захиалагчийн нэр + утасны дугаар бичнэ үү
• Шүүрхай хүргэлт: +20,000₮ нэмэлт (UBCAB EXPRESS=Тухайн өдөртөө) (орой 8 цагаас хойших захиалга маргааш өглөө хүргэгдэхийг анхаарна уу)
• Утас: 95999989

━━ ЗАХИАЛГА АВАХ ДАРААЛАЛ ━━
Хэрэглэгч авна гэвэл ЭНЭ ДАРААЛЛААР мэдээллийг нэг нэгээр асуу:
1. Өнгө (Pearl White / Slate Gray / Obsidian Black)
2. Тоо ширхэг
3. Хаяг (дүүрэг, хороо, хотхон/байр/тоот/давхар)
4. Орцны код (байгаа бол)
5. Утасны дугаар
→ Бүгд бүрэн болмогц: "Таны захиалгыг хүлээн авлаа ✅ Удахгүй холбогдох болно 🌸"
→ Дараа нь Хаан банкны дансны мэдээллийг явуул

━━ ҮНЭ ТАНИЛЦУУЛАХ HOOK ━━
Үнэ асуухад заавал энэ загварыг ашигла — urgency, value харуулах:
• Шүршүүр: "269,000₮-с хямдарч одоо 199,900₮ болсон 🔥 Хямдрал зөвхөн энэ долоо хоногт үргэлжилж байгаа тул яараарай! 🌸"
• Запас шүүлтүүр: "44,900₮-с хямдарч одоо 29,900₮ болсон 🔥"
• Pearl White 3-в-1 багц: "Шүршүүр авахад sponge + brush үнэгүй дагалдаж ирнэ — нийт 3 бүтээгдэхүүн авсан хэрэг! 🎁"
• Urgency: "Одоогийн үнээр авах боломж хязгаарлагдмал тул яаралтай захиалгаа өгөөрэй 🌸"

━━ ХЭРЭГЛЭГЧИЙН ӨНГӨ АЯС ТАНИХ ━━
Хэрэглэгчийн бичих хэв маяг, өнгө аясыг судалж тохирсон хариулт өг:
• Залуу/casual хэлбэр ("yuuu", "hehe", emoji их) → найрсаг, хөнгөн, emoji ашигла
• Албан ёсны хэлбэр → эелдэг, тодорхой, мэргэжлийн
• Богино хариулт ("үнэ?", "яах уу?") → богино, цэгцтэй хариул
• UGC/influencer шинжтэй ("контент хийхэд тохиромжтой юу?", "фото гарна уу?") → брэндийн өнгө аяс, гоо сайхны талыг онцол
• Эргэлзэж байгаа хэрэглэгч → итгэл төрүүлэх (CE сертификат, 50 сая борлуулалт, баталгаа)
• Зураг/бичлэг илгээсэн → тэр контентоос нь ойлгож хариул (жишээ: bathroom зураг илгээвэл "таны угаалгын өрөөнд маш сайн тохирно!" гэх мэт)

━━ МЭДЭХГҮЙ ЗҮЙЛ ГАРВАЛ ━━
Хэрэглэгч асуусан зүйлд хариулт мэдэхгүй байвал:
• ХЭЗЭЭ Ч таах, зохиох, буруу мэдээлэл өгөхгүй
• "Манай баг таньтай эргэн холбогдох хүртэл түр хүлээнэ үү. Бид таны асуултад түргэн шуурхай хариулах болно 🌸" гэж хариул

━━ ХАРИУЛАХ ДҮРЭМ ━━
• Монгол хэлээр товч, 1-3 өгүүлбэр (DM), 1 өгүүлбэр (comment)
• "Усанд орох" болон "шүршүүрт орох" хоёул ижил утгатай — Монголчууд хоёуланг нь адилхан хэлдэг тул хоёуланг нь зөв гэж ойлго
• "Шүршүүр хийх" гэж битгий хэл
• Хэрэглэгч утас/хаяг дутуу өгвөл "явуулаарай" гэж хүс
• Хэрэглэгчийн үг утга нь тодорхойгүй байвал ЗАСАХГҮЙ — харин эелдэгээр лавлаж асуу. Жишээ: "Таны хэлсэн '.....' гэдэг нь ямар утгаар хэлсэн бэ? 🌸"
• Хэрэглэгчийн хэлсэн үгийг хэзээ ч засаж, зааж сургахгүй
• "avsaan", "zuv zuv", "done" гэж бичвэл баярлалаа гэж хариул
• Хэрэглэгч давтан асуувал шинэ мэдээлэл нэм, давталтаас зайл
• "багцаас нь авна" гэвэл Pearl White-г санал бол
• Гарал үүсэл асуувал: "Европын CE стандартаар Хонгконгт үйлдвэрлэгдэж, Европ Америкт 50 сая гаруй борлуулалттай trending бүтээгдэхүүн. Бид шууд үйлдвэрээс албан ёсны эрхтэйгээр Монголд нийлүүлдэг 🌸"
• Суурилуулалт асуувал: "Стандарт шүршүүрийн хоолойнд шууд таарна, тусгай багаж хэрэггүй — 1 минутад суурилна 🔧"
• Баталгаа асуувал: "Үйлдвэрийн алдаатай бол 1 сарын дотор буцааж солино 🌸"`;

// ══════════════════════════════════════════════════════════════
// COMMENT PROMPT — Facebook/Instagram comment-д хариулах
// ══════════════════════════════════════════════════════════════
const COMMENT_PROMPT = `Та SkinBloom брэндийн AI туслах юм. Facebook/Instagram comment-д хариулна.

ДҮРЭМ:
• 1-2 өгүүлбэр, маш товч
• Нэр дурдаж хандана (жишээ: "Сайн байна уу Бат? 🌸")
• Дараа нь DM руу урина: "Тань руу зурвас илгээлээ, Message Request хэсэгээ шалгаарай 🌸"
• Шүүлтүүр асуувал: "Тийм, запас шүүлтүүр байгаа! DM-д илүү дэлгэрэнгүй мэдээлэл явуулсан 🌸"
• Захиалах асуувал: "skinbloom.store-с захиалж болно, мөн DM-д тусламж үзүүлнэ 🌸"
• Буруу ойлголт засах: "Усыг тунгалаг цэвэр болгодог шүүлтүүр юм! Үсэнд биш усанд нөлөөлнө 💧"`;

// ══════════════════════════════════════════════════════════════
// CONVERSATION HISTORY
// ══════════════════════════════════════════════════════════════
const conversations = new Map();
// Human handoff — эзэн хариулж байгаа хэрэглэгчид bot хариулахгүй
const humanHandoff = new Set();
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

// ══════════════════════════════════════════════════════════════
// GPT FUNCTIONS
// ══════════════════════════════════════════════════════════════
async function askGPT_DM(senderId, userText) {
  const history = getHistory(senderId);
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

async function askGPT_Comment(commenterName, commentText) {
  const prompt = `Коммент хийсэн хэрэглэгч: ${commenterName || 'хэрэглэгч'}\nКоммент: ${commentText}`;
  const res = await axios.post('https://api.openai.com/v1/chat/completions', {
    model: 'gpt-4o-mini',
    messages: [
      { role: 'system', content: COMMENT_PROMPT },
      { role: 'user', content: prompt }
    ],
    temperature: 0.6, max_tokens: 120
  }, { headers: { Authorization: `Bearer ${OPENAI_KEY}` } });
  return res.data.choices[0].message.content.trim();
}

// ══════════════════════════════════════════════════════════════
// META HELPERS
// ══════════════════════════════════════════════════════════════
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

async function replyToComment(commentId, text) {
  try {
    await axios.post(`https://graph.facebook.com/v19.0/${commentId}/comments`, {
      message: text
    }, { params: { access_token: PAGE_TOKEN } });
    console.log(`✓ Comment reply → ${commentId}`);
  } catch (e) {
    console.error(`✗ Comment error → ${commentId}:`, e.response?.data?.error?.message || e.message);
  }
}

// Comment-ийн эзэнд DM явуулах (reply comment дээр)
async function sendDMToCommenter(commenterId, commenterName, context) {
  if (!commenterId) return;
  try {
    const dmText = await askGPT_DM(commenterId, `[Comment контекст: "${context}"] — хэрэглэгч comment дээр reply бичсэн.`);
    await sendDM(commenterId, dmText);
    console.log(`✓ DM sent to commenter ${commenterName} (${commenterId})`);
  } catch (e) {
    console.error(`✗ DM to commenter error:`, e.message);
  }
}

// ══════════════════════════════════════════════════════════════
// OWNER NOTIFICATION — мэдэхгүй зүйл гарвал эзэнд мэдэгдэх
// ══════════════════════════════════════════════════════════════
const OWNER_FB_ID = process.env.OWNER_FB_ID || '';

async function notifyOwner(senderId, senderText) {
  if (!OWNER_FB_ID || !PAGE_TOKEN) return;
  try {
    const msg = `⚠️ Хэрэглэгч мэдэхгүй зүйл асуулаа — гар хариулт шаардлагатай\n👤 Хэрэглэгчийн ID: ${senderId}\n💬 Асуулт: ${senderText}\n\n→ Мессенжерт нь шууд хариул: https://m.me/${senderId}`;
    await axios.post('https://graph.facebook.com/v19.0/me/messages', {
      recipient: { id: OWNER_FB_ID },
      message: { text: msg }
    }, { params: { access_token: PAGE_TOKEN } });
    console.log(`✓ Owner notified about ${senderId}`);
  } catch (e) {
    console.error('✗ Owner notify error:', e.message);
  }
}

// ══════════════════════════════════════════════════════════════
// DEDUPLICATION
// ══════════════════════════════════════════════════════════════
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

// ══════════════════════════════════════════════════════════════
// WEBHOOK VERIFY
// ══════════════════════════════════════════════════════════════
app.get('/webhook', (req, res) => {
  const { 'hub.mode': mode, 'hub.verify_token': token, 'hub.challenge': challenge } = req.query;
  if (mode === 'subscribe' && token === VERIFY_TOKEN) {
    console.log('✓ Webhook verified');
    return res.status(200).send(challenge);
  }
  res.sendStatus(403);
});

// ══════════════════════════════════════════════════════════════
// MAIN WEBHOOK
// ══════════════════════════════════════════════════════════════
app.post('/webhook', async (req, res) => {
  if (!verifySignature(req)) return res.sendStatus(401);
  res.sendStatus(200);

  const body = req.body;
  if (!['page', 'instagram'].includes(body.object)) return;

  for (const entry of (body.entry || [])) {
    const pageId = entry.id;

    // ── 1. MESSENGER / INSTAGRAM DM ──────────────────────────
    for (const event of (entry.messaging || [])) {
      if (event.message?.is_echo) continue;
      if (event.sender?.id === pageId) continue;
      const mid = event.message?.mid;
      if (mid && isDuplicate(mid)) continue;
      const senderId = event.sender?.id;
      const text = event.message?.text;
      const attachments = event.message?.attachments;
      if (!senderId) continue;

      // Human handoff горимд байгаа хэрэглэгчид bot хариулахгүй
      if (humanHandoff.has(senderId)) {
        console.log(`⏭ Handoff mode — skipping [${senderId}]`);
        continue;
      }

      // Зураг/attachment илгээсэн тохиолдол
      if (!text && attachments?.length > 0) {
        const attType = attachments[0]?.type;
        if (['image', 'video', 'sticker'].includes(attType)) {
          console.log(`🖼 Attachment [${senderId}]: ${attType}`);
          // Зургийн URL-г GPT-д дамжуулж контекст ойлгуулна
          const attUrl = attachments[0]?.payload?.url || '';
          const attContext = attType === 'image'
            ? `[Хэрэглэгч зураг илгээлээ${attUrl ? ' — зургийн URL: ' + attUrl : ''}. Магадгүй: бүтээгдэхүүний зураг харуулж захиалах гэсэн, угаалгын өрөөний зураг илгээсэн, эсвэл контент creator байж болно. Хэрэглэгчийн зорилгыг ойлгож тохирсон хариулт өг.]`
            : `[Хэрэглэгч ${attType} илгээлээ. Магадгүй бүтээгдэхүүний тухай асуух гэсэн байж болно. Эелдэгээр юу хэрэгтэйг нь асуу.]`;
          try {
            const reply = await askGPT_DM(senderId, attContext);
            await sendDM(senderId, reply);
          } catch (e) {
            await sendDM(senderId, 'Зургийг харлаа 🌸 Та SkinBloom-н бүтээгдэхүүний талаар асуух гэсэн үү? Өнгө, үнэ, захиалгын талаар туслая!');
          }
        }
        continue;
      }

      if (!text) continue;
      console.log(`📩 DM [${senderId}]: ${text.slice(0, 60)}`);
      try {
        const reply = await askGPT_DM(senderId, text);
        await sendDM(senderId, reply);
        // Мэдэхгүй зүйл гарвал — handoff горим идэвхжүүлэх
        if (reply.includes('Манай баг') || reply.includes('KaHeJi')) {
          humanHandoff.add(senderId);
          await notifyOwner(senderId, text);
          console.log(`🤝 Handoff activated for ${senderId}`);
        }
      } catch (e) {
        console.error('GPT DM error:', e.message);
        await sendDM(senderId, 'Уучлаарай, дахин оролдоно уу. skinbloom.store эсвэл 95999989 🌸');
      }
    }

    // ── 2. FACEBOOK FEED CHANGES ──────────────────────────────
    for (const change of (entry.changes || [])) {
      console.log(`📦 change: field=${change.field} item=${change.value?.item} verb=${change.value?.verb} from=${change.value?.from?.name}`);
      if (change.field !== 'feed') continue;
      const val = change.value;

      if (val.item === 'comment' && val.verb === 'add') {
        const commentId = val.comment_id;
        const commentText = val.message;
        const commenterName = val.from?.name || '';
        const commenterId = val.from?.id;

        if (commenterId === pageId) continue;
        if (!commentText || !commentId) continue;
        if (isDuplicate(commentId)) continue;

        const isReply = val.parent_id && val.parent_id !== val.post_id;

        if (isReply) {
          // ── Reply comment: comment-д хариул + DM явуул ──
          console.log(`💬 FB Reply [${commenterName}]: ${commentText.slice(0, 60)}`);
          try {
            const commentReply = await askGPT_Comment(commenterName, commentText);
            await replyToComment(commentId, commentReply);
            // DM-д дэлгэрэнгүй мэдээлэл явуул
            await sendDMToCommenter(commenterId, commenterName, commentText);
          } catch (e) {
            console.error('GPT reply comment error:', e.message);
          }
        } else {
          // ── Шинэ comment: comment-д хариул + DM явуул ──
          console.log(`💬 FB Comment [${commenterName}]: ${commentText.slice(0, 60)}`);
          try {
            const commentReply = await askGPT_Comment(commenterName, commentText);
            await replyToComment(commentId, commentReply);
            // DM-д дэлгэрэнгүй мэдээлэл явуул
            await sendDMToCommenter(commenterId, commenterName, commentText);
          } catch (e) {
            console.error('GPT comment error:', e.message);
            await replyToComment(commentId, `${commenterName ? commenterName + ' ' : ''}Сайн байна уу? 🌸 Тань руу зурвас илгээлээ, Message Request хэсэгээ шалгаарай.`);
          }
        }
      }
    }

    // ── 3. INSTAGRAM CHANGES ──────────────────────────────────
    for (const change of (entry.changes || [])) {
      if (change.field !== 'comments' && change.field !== 'messages') continue;
      const val = change.value;
      if (change.field === 'comments' && val.text) {
        const commentId = val.id;
        const commentText = val.text;
        const commenterName = val.from?.name || '';
        const commenterId = val.from?.id;
        if (!commentId || !commentText) continue;
        if (isDuplicate(commentId)) continue;
        console.log(`📸 IG Comment [${commenterName}]: ${commentText.slice(0, 60)}`);
        try {
          const reply = await askGPT_Comment(commenterName, commentText);
          await replyToComment(commentId, reply);
          await sendDMToCommenter(commenterId, commenterName, commentText);
        } catch (e) {
          console.error('GPT IG comment error:', e.message);
        }
      }
    }
  }
});

// ══════════════════════════════════════════════════════════════
// KEEP-ALIVE
// ══════════════════════════════════════════════════════════════
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
  status: '🌸 SkinBloom Bot running', version: '2.1.0',
  time: new Date().toISOString(), active_conversations: conversations.size
}));
app.get('/health', (req, res) => res.json({ ok: true, ts: Date.now() }));
app.get('/stats', (req, res) => {
  const convs = [];
  for (const [id, conv] of conversations) {
    convs.push({ id, msgs: conv.messages.length, lastActivity: new Date(conv.lastActivity) });
  }
  res.json({ active_conversations: conversations.size, conversations: convs });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`🌸 SkinBloom Bot v2.1 listening on port ${PORT}`));
