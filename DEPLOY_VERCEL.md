# Deploy Rally GPS to Vercel

## What changed
- Express app exports for Vercel (`api/index.js`)
- Shared car state via **Upstash Redis** (required on Vercel)
- Local `npm start` still uses memory if Redis env vars are missing

## Steps

### A. Upstash Redis (2 minutes)
1. https://console.upstash.com → Create database
2. Copy REST URL + TOKEN

### B. Vercel
1. https://vercel.com/new → import this folder / GitHub repo
2. Add env vars:
   - `UPSTASH_REDIS_REST_URL`
   - `UPSTASH_REDIS_REST_TOKEN`
3. Deploy → open `https://YOUR-APP.vercel.app/api/health`
   - Expect: `"store":"redis"`

### C. Android
Set in `ServerConfig.kt`:
```kotlin
const val DEFAULT_PUBLIC_URL = "https://YOUR-APP.vercel.app"
```
Rebuild APK.

### CLI alternative (if logged in)
```bash
npx vercel login
npx vercel
npx vercel env add UPSTASH_REDIS_REST_URL
npx vercel env add UPSTASH_REDIS_REST_TOKEN
npx vercel --prod
```
