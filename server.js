const crypto = require("crypto");
const os = require("os");
const path = require("path");
const express = require("express");
const { getStore, hasSupabase, pickColor, newToken, PALETTE } = require("./lib/store");

const app = express();
const PORT = Number(process.env.PORT) || 3000;
const PUBLIC_BASE_URL = (process.env.PUBLIC_BASE_URL || "").replace(/\/$/, "");
const STALE_MS = 45_000;
const MAX_TRAIL = 500;
const store = getStore();

app.set("trust proxy", 1);
app.disable("x-powered-by");
app.use(express.json({ limit: "32kb" }));
app.use(express.static(path.join(__dirname, "public")));

function publicBase(req) {
  if (PUBLIC_BASE_URL) return PUBLIC_BASE_URL;
  const proto = String(req.headers["x-forwarded-proto"] || req.protocol).split(",")[0].trim();
  const host = String(req.headers["x-forwarded-host"] || req.get("host")).split(",")[0].trim();
  return `${proto}://${host}`;
}

function xml(value) {
  return String(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

function kmlColor(hex, alpha = "ff") {
  const h = hex.replace("#", "");
  return `${alpha}${h.slice(4, 6)}${h.slice(2, 4)}${h.slice(0, 2)}`;
}

function haversineMeters(a, b) {
  const R = 6371000;
  const toRad = (d) => (d * Math.PI) / 180;
  const dLat = toRad(b.lat - a.lat);
  const dLon = toRad(b.lon - a.lon);
  const lat1 = toRad(a.lat);
  const lat2 = toRad(b.lat);
  const h =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(h)));
}

function isLive(car) {
  return Boolean(car.tracking && car.last && Date.now() - car.last.ts < STALE_MS);
}

function serializeCar(car) {
  return {
    id: car.id,
    carNumber: car.carNumber,
    driverName: car.driverName,
    color: car.color,
    tracking: car.tracking,
    live: isLive(car),
    last: car.last,
    trail: car.trail,
  };
}

function validCoord(lat, lon) {
  return (
    typeof lat === "number" &&
    typeof lon === "number" &&
    Number.isFinite(lat) &&
    Number.isFinite(lon) &&
    lat >= -90 &&
    lat <= 90 &&
    lon >= -180 &&
    lon <= 180
  );
}

function asyncHandler(fn) {
  return (req, res, next) => {
    Promise.resolve(fn(req, res, next)).catch(next);
  };
}

app.get("/api/health", (_req, res) => {
  res.json({
    ok: true,
    store: store.mode,
    supabase: hasSupabase(),
    time: Date.now(),
  });
});

app.post(
  "/api/register",
  asyncHandler(async (req, res) => {
    const carNumber = String(req.body.carNumber || "").trim().slice(0, 8);
    const driverName = String(req.body.driverName || "").trim().slice(0, 40);

    if (!carNumber || !driverName) {
      return res.status(400).json({ error: "Car number and driver name are required." });
    }

    const existing = await store.findByCarNumber(carNumber);
    if (existing) {
      existing.driverName = driverName;
      existing.token = newToken();
      existing.tracking = false;
      await store.saveCar(existing);
      return res.json({
        id: existing.id,
        token: existing.token,
        color: existing.color,
        carNumber: existing.carNumber,
        driverName: existing.driverName,
      });
    }

    const colorIndex = await store.nextColorIndex();
    const car = {
      id: crypto.randomUUID(),
      token: newToken(),
      carNumber,
      driverName,
      color: pickColor(colorIndex),
      tracking: false,
      last: null,
      trail: [],
    };
    await store.saveCar(car);
    res.json({
      id: car.id,
      token: car.token,
      color: car.color,
      carNumber: car.carNumber,
      driverName: car.driverName,
    });
  })
);

app.post(
  "/api/ping",
  asyncHandler(async (req, res) => {
    const { id, token, lat, lon, heading, speed, accuracy } = req.body;
    const car = await store.getCar(id);
    if (!car || car.token !== token) {
      return res.status(401).json({ error: "Unknown car session. Register again." });
    }
    if (!validCoord(lat, lon)) {
      return res.status(400).json({ error: "Invalid coordinates." });
    }

    const ts = Date.now();
    car.tracking = true;
    car.last = {
      lat,
      lon,
      heading: typeof heading === "number" && Number.isFinite(heading) ? heading : null,
      speed: typeof speed === "number" && Number.isFinite(speed) ? Math.max(0, speed) : null,
      accuracy: typeof accuracy === "number" && Number.isFinite(accuracy) ? accuracy : null,
      ts,
    };

    if (!Array.isArray(car.trail)) car.trail = [];
    const prev = car.trail[car.trail.length - 1];
    if (!prev || haversineMeters(prev, car.last) >= 3) {
      car.trail.push({ lat, lon, ts });
      if (car.trail.length > MAX_TRAIL) car.trail.splice(0, car.trail.length - MAX_TRAIL);
    }

    await store.saveCar(car);
    res.json({ ok: true, receivedAt: ts });
  })
);

app.post(
  "/api/stop",
  asyncHandler(async (req, res) => {
    const car = await store.getCar(req.body.id);
    if (!car || car.token !== req.body.token) {
      return res.status(401).json({ error: "Unknown car session." });
    }
    car.tracking = false;
    await store.saveCar(car);
    res.json({ ok: true });
  })
);

app.get(
  "/api/cars",
  asyncHandler(async (_req, res) => {
    const cars = await store.listCars();
    res.json({
      serverTime: Date.now(),
      cars: cars.map(serializeCar),
    });
  })
);

app.get("/earth-link.kml", (req, res) => {
  const href = `${publicBase(req)}/earth.kml`;
  res.set({
    "Content-Type": "application/vnd.google-earth.kml+xml; charset=utf-8",
    "Content-Disposition": 'attachment; filename="Rally_Live_Tracking.kml"',
    "Cache-Control": "no-store",
  });
  res.send(`<?xml version="1.0" encoding="UTF-8"?>
<kml xmlns="http://www.opengis.net/kml/2.2">
  <NetworkLink>
    <name>Rally Live Tracking</name>
    <visibility>1</visibility>
    <open>1</open>
    <description>Live rally cars. Leave Google Earth Pro open - positions refresh every 4 seconds.</description>
    <refreshVisibility>0</refreshVisibility>
    <flyToView>0</flyToView>
    <Link>
      <href>${xml(href)}</href>
      <refreshMode>onInterval</refreshMode>
      <refreshInterval>4</refreshInterval>
    </Link>
  </NetworkLink>
</kml>`);
});

app.get(
  "/earth.kml",
  asyncHandler(async (_req, res) => {
    const cars = await store.listCars();
    res.set({
      "Content-Type": "application/vnd.google-earth.kml+xml; charset=utf-8",
      "Cache-Control": "no-store",
    });
    res.send(buildLiveKml(cars));
  })
);

function buildLiveKml(cars) {
  const list = cars.filter((car) => car.last);
  const styles = PALETTE.map(
    (color, i) => `    <Style id="car${i}">
      <IconStyle>
        <color>${kmlColor(color)}</color>
        <scale>1.3</scale>
        <Icon><href>http://maps.google.com/mapfiles/kml/shapes/track.png</href></Icon>
        <hotSpot x="0.5" y="0.5" xunits="fraction" yunits="fraction"/>
      </IconStyle>
      <LabelStyle>
        <color>${kmlColor("#f3ead8")}</color>
        <scale>0.95</scale>
      </LabelStyle>
      <LineStyle>
        <color>${kmlColor(color, "cc")}</color>
        <width>4</width>
      </LineStyle>
    </Style>`
  ).join("\n");

  const carMarks = list
    .map((car) => {
      const live = isLive(car);
      const speedKmh =
        car.last.speed == null ? "—" : `${Math.round(car.last.speed * 3.6)} km/h`;
      const ageSec = Math.max(0, Math.round((Date.now() - car.last.ts) / 1000));
      const headingTag =
        car.last.heading == null ? "" : `<heading>${xml(car.last.heading)}</heading>`;
      const status = live ? "LIVE" : car.tracking ? "SIGNAL LOST" : "STOPPED";
      return `      <Placemark>
        <name>${xml("#" + car.carNumber + "  " + car.driverName)}</name>
        <description><![CDATA[${status}<br/>Speed: ${speedKmh}<br/>Updated: ${ageSec}s ago]]></description>
        <Style>
          <IconStyle>
            <color>${kmlColor(car.color)}</color>
            <scale>1.3</scale>
            ${headingTag}
            <Icon><href>http://maps.google.com/mapfiles/kml/shapes/track.png</href></Icon>
            <hotSpot x="0.5" y="0.5" xunits="fraction" yunits="fraction"/>
          </IconStyle>
          <LabelStyle>
            <color>${kmlColor("#f3ead8")}</color>
            <scale>0.95</scale>
          </LabelStyle>
        </Style>
        <Point>
          <altitudeMode>clampToGround</altitudeMode>
          <coordinates>${car.last.lon},${car.last.lat},0</coordinates>
        </Point>
      </Placemark>`;
    })
    .join("\n");

  const tracks = list
    .filter((car) => Array.isArray(car.trail) && car.trail.length >= 2)
    .map((car) => {
      const styleIndex = PALETTE.indexOf(car.color);
      const coords = car.trail.map((p) => `${p.lon},${p.lat},0`).join(" ");
      return `      <Placemark>
        <name>${xml("#" + car.carNumber + " track")}</name>
        <styleUrl>#car${styleIndex < 0 ? 0 : styleIndex}</styleUrl>
        <LineString>
          <tessellate>1</tessellate>
          <altitudeMode>clampToGround</altitudeMode>
          <coordinates>${coords}</coordinates>
        </LineString>
      </Placemark>`;
    })
    .join("\n");

  return `<?xml version="1.0" encoding="UTF-8"?>
<kml xmlns="http://www.opengis.net/kml/2.2">
  <Document>
    <name>Rally Live Tracking</name>
    <open>1</open>
    <description>${list.length ? xml(list.length + " cars on course") : "Waiting for cars to start tracking."}</description>
${styles}
    <Folder>
      <name>Cars</name>
      <open>1</open>
${carMarks}
    </Folder>
    <Folder>
      <name>Tracks</name>
      <open>0</open>
${tracks}
    </Folder>
  </Document>
</kml>`;
}

app.use((err, _req, res, _next) => {
  console.error(err);
  res.status(500).json({ error: err.message || "Server error" });
});

function lanIPs() {
  const ips = [];
  for (const addrs of Object.values(os.networkInterfaces())) {
    for (const addr of addrs || []) {
      const family = addr.family === 4 || addr.family === "IPv4";
      if (family && !addr.internal) ips.push(addr.address);
    }
  }
  return ips;
}

function startLocal() {
  app.listen(PORT, "0.0.0.0", () => {
    const ips = lanIPs();
    console.log("");
    console.log("  Rally GPS tracking is running");
    console.log(`  Store:     ${store.mode}${hasSupabase() ? " (Supabase)" : " (local memory)"}`);
    console.log(`  Local:     http://localhost:${PORT}`);
    for (const ip of ips) console.log(`  Network:   http://${ip}:${PORT}`);
    console.log("");
  });
}

if (require.main === module) {
  startLocal();
}

module.exports = app;
