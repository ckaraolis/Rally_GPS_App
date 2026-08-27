# Rally GPS

Live rally-car tracking: drivers share smartphone GPS, race control watches a map, and Google Earth Pro follows the same live KML feed.

## Quick start (server on your PC)

```bash
npm install
npm start
```

Open **http://localhost:3000**

| Role | Page |
| --- | --- |
| Driver phone (web) | `/driver.html` |
| Race control | `/control.html` |
| Google Earth Pro link | `/earth-link.kml` |

## Deploy on Vercel + Supabase (permanent server)

Car positions are stored in your **Supabase** database so every phone and Google Earth see the same live data.

### 1) Create the table in Supabase

1. Open your Supabase project → **SQL Editor**
2. Run the SQL in `supabase/schema.sql`

### 2) Copy keys

Supabase → **Project Settings** → **API**:
- `SUPABASE_URL`
- `SUPABASE_SERVICE_ROLE_KEY` (use `service_role`, keep it secret)

### 3) Deploy to Vercel

1. Import `https://github.com/ckaraolis/Rally_GPS_App` in [vercel.com](https://vercel.com)
2. Add env vars:
   - `SUPABASE_URL`
   - `SUPABASE_SERVICE_ROLE_KEY`
3. Deploy

Public URL example: `https://your-app.vercel.app`  
Health check: `/api/health` should show `"store":"supabase"`

### 4) Point the Android app

Edit `android/app/src/main/java/com/rallygps/app/ServerConfig.kt`:

```kotlin
const val DEFAULT_PUBLIC_URL = "https://your-app.vercel.app"
```

Then rebuild the APK.

### Local without Supabase

`npm start` still works on your PC using in-memory storage (fine for same-Wi‑Fi tests).

## Android driver app (APK)

Ready-to-install file:

- Desktop: `RallyGPS.apk`
- Or: `Rally_GPS_APP/RallyGPS.apk`

### Install on your phone

1. Copy `RallyGPS.apk` to the phone (USB, Google Drive, WhatsApp to yourself, etc.).
2. Open the file on the phone.
3. If Android blocks it, allow **Install unknown apps** for Files / Chrome / Drive.
4. Install **Rally GPS**.
5. Open it and allow:
   - **Location** (Precise / Exact)
   - **Notifications** (needed for live tracking)
   - Optionally **Allow all the time** location (better with screen off)
6. Set **Server URL** to your Rally PC, for example `http://192.168.0.152:3000` (same Wi‑Fi).
7. Enter car number + name → **Continue** → **Start tracking**.

### Checklist before a stage

- Phone and PC on the same Wi‑Fi (for local HTTP), or use a public HTTPS server URL.
- Rally server is running (`npm start`).
- Race control page shows the car as LIVE after Start tracking.
- Keep Google Play services installed (almost all Android phones already have it).

Native project source remains in `android/` if you want to rebuild later.

## How it works

1. Android app (or web driver page) registers the car and starts GPS.
2. Positions are sent to the Rally server every few seconds.
3. Race control map reads `GET /api/cars`.
4. Google Earth Pro refreshes `GET /earth.kml` about every 4 seconds.

## Hosting / Vercel

**Vercel can host a public HTTPS URL**, but this live tracker is not a perfect fit for plain Vercel as-is:

- The current server keeps car positions **in memory**.
- Vercel runs **serverless** functions (short-lived). Memory is not shared reliably between requests.
- To use Vercel properly you need shared storage (for example **Upstash Redis** / Vercel KV) so every `/api/ping` and `/earth.kml` see the same cars.

Easier for a first public server:

- **Railway**, **Render**, or **Fly.io** — run the current Node `server.js` as a always-on service
- or keep it on a PC + **Cloudflare Tunnel** for HTTPS

We can walk through creating the public server next.

## Notes

- Restarting the local server clears all cars (memory only).
- The Android app uses a foreground notification so GPS can continue with the screen off.
- Google Earth **Pro** (desktop) is the reliable client for network-link KML.
