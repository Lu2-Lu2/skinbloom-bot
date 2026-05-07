# SkinBloom Bot v2.0 🌸

Facebook/Instagram AI bot — 582 conversation analysis дээр тулгуурлан бүтээгдсэн.

## Шинэчлэлт (v2.0)
- ✅ Conversation history (24 цаг хадгална)
- ✅ Deduplication (давхар хариулахгүй)
- ✅ Comment-д тусгай товч prompt
- ✅ DM-д бүрэн history-тэй хариулт
- ✅ Keep-alive (Render free tier 15 мин унтах асуудал засгасан)
- ✅ /stats endpoint (идэвхтэй conversation хянах)
- ✅ Бодит үнэ: 199,900₮ (269,000₮-с)
- ✅ Запас: 29,900₮
- ✅ Хаан банкны данс мэдээлэл автоматаар

## GitHub-д push хийх
```bash
cd skinbloom-bot
git add -A
git commit -m "v2.0: data-driven upgrade"
git push origin main
```
→ Render автоматаар deploy хийнэ

## Environment Variables
```
OPENAI_API_KEY=sk-...
META_VERIFY_TOKEN=skinbloom_webhook_2024
META_APP_SECRET=...
PAGE_ACCESS_TOKEN=...
RENDER_URL=https://skinbloom-bot.onrender.com
```

## Endpoints
- GET /         → Status + active conversation тоо
- GET /health   → Keep-alive ping
- GET /stats    → Бүх идэвхтэй conversation жагсаалт
- GET /webhook  → Meta verify
- POST /webhook → Meta events
