# SkinBloom Facebook/Instagram AI Bot

## Render дээр суулгах алхмууд

### 1. GitHub repo үүсгэх
```bash
git init
git add .
git commit -m "SkinBloom bot init"
git remote add origin https://github.com/yourusername/skinbloom-bot
git push -u origin main
```

### 2. Render Web Service үүсгэх
- render.com → New → Web Service
- GitHub repo холбох
- Build command: `npm install`
- Start command: `node index.js`
- Instance: Free (эхлэхэд)

### 3. Environment Variables нэм
Render dashboard → Environment → Add:
```
OPENAI_API_KEY=sk-...
META_VERIFY_TOKEN=skinbloom_webhook_2024
META_APP_SECRET=...
PAGE_ACCESS_TOKEN=...
```

### 4. Meta App тохируулах
1. developers.facebook.com → Apps → Create App
2. "Business" сонгох
3. Messenger болон Instagram суулгах
4. Webhook URL: https://your-service.onrender.com/webhook
5. Verify Token: skinbloom_webhook_2024
6. Subscribe: messages, messaging_postbacks, feed (comments)

### 5. Page Access Token авах
- Graph API Explorer → Page сонгох → Generate token
- Permission: pages_messaging, pages_read_engagement, instagram_basic, instagram_manage_messages

## Ажиллах зарчим
User comment/DM → Meta webhook → Render server → GPT-4o-mini → Auto reply
