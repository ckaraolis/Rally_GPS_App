# Deploy Rally GPS to Vercel + Supabase

## 1) Create the table in Supabase
1. Open your Supabase project
2. Go to **SQL Editor** → New query
3. Paste and run the contents of `supabase/schema.sql`

## 2) Copy API keys
Supabase → **Project Settings** → **API**:
- `SUPABASE_URL` = Project URL
- `SUPABASE_SERVICE_ROLE_KEY` = `service_role` key (secret — server only)

## 3) Vercel environment variables
Add:
- `SUPABASE_URL`
- `SUPABASE_SERVICE_ROLE_KEY`

Optional:
- `PUBLIC_BASE_URL=https://your-app.vercel.app`

## 4) Deploy
Import the GitHub repo in Vercel and deploy.

Check: `https://YOUR-APP.vercel.app/api/health`
Expect: `"store":"supabase"`

## 5) Android
Set in `ServerConfig.kt`:
```kotlin
const val DEFAULT_PUBLIC_URL = "https://YOUR-APP.vercel.app"
```
Rebuild APK.
