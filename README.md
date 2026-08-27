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

## Deploy on Vercel (recommended permanent server)

The app is converted for Vercel. Car positions are stored in **Upstash Redis** so every phone and Google Earth see the same live data.

### 1) Create free Redis (Upstash)

1. Go to [https://upstash.com](https://upstash.com) and sign up
2. Create a **Redis** database
3. Open the database → copy:
   - `UPSTASH_REDIS_REST_URL`
   - `UPSTASH_REDIS_REST_TOKEN`

### 2) Deploy to Vercel

1. Push this project to GitHub (or deploy from the Vercel dashboard with the project folder)
2. Import the project in [https://vercel.com](https://vercel.com)
3. In **Settings → Environment Variables**, add:
   - `UPSTASH_REDIS_REST_URL`
   - `UPSTASH_REDIS_REST_TOKEN`
   - optional: `PUBLIC_BASE_URL=https://your-app.vercel.app`
4. Deploy

Your public URL will look like:

`https://your-app.vercel.app`

### 3) Point the Android app

Edit `android/app/src/main/java/com/rallygps/app/ServerConfig.kt`:

```kotlin
const val DEFAULT_PUBLIC_URL = "https://your-app.vercel.app"
```

Then rebuild the APK.

### Local without Redis

`npm start` still works on your PC using in-memory storage (fine for same-Wi‑Fi tests).

Check storage mode:

`GET /api/health` → `{ "store": "redis" }` on Vercel, or `"memory"` locally.

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
