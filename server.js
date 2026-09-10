const crypto = require("crypto");
const os = require("os");
const path = require("path");
const express = require("express");
const { getStore, hasSupabase, pickColor, newToken, PALETTE } = require("./lib/store");
const { parseKmzOrKml, buildLabel } = require("./lib/kml");
const { detectSection, haversineMeters } = require("./lib/geo");

const app = express();
const PORT = Number(process.env.PORT) || 3000;
const PUBLIC_BASE_URL = (process.env.PUBLIC_BASE_URL || "").replace(/\/$/, "");
const STALE_MS = 180_000;
const MAX_TRAIL = 4000;
const MAX_BATCH = 250;
const MAX_POINT_AGE_MS = 24 * 60 * 60 * 1000;
const store = getStore();

app.set("trust proxy", 1);
app.disable("x-powered-by");
app.use(express.json({ limit: "15mb" }));
app.use("/js", (_req, res, next) => {
  res.set("Cache-Control", "no-store");
  next();
});
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

function isLive(car) {
  if (!car.tracking || !car.last) return false;
  if (car.reconnectRequested) return true;
  return Date.now() - car.last.ts < STALE_MS;
}

function reviveLastFix(car) {
  car.reconnectRequested = Date.now();
  car.tracking = true;
  if (car.last && typeof car.last.lat === "number" && typeof car.last.lon === "number") {
    car.last = { ...car.last, ts: Date.now() };
  }
}

function sectionFlag(section) {
  if (!section || section.type !== "stage") return { flagStatus: "green", flagTs: 0 };
  return {
    flagStatus: section.flagStatus === "red" ? "red" : "green",
    flagTs: Number(section.flagTs) || 0,
  };
}

function hasAckedFlag(car, section) {
  const { flagStatus, flagTs } = sectionFlag(section);
  if (flagStatus !== "red" || !section) return true;
  return car.flagAck?.stageId === section.id && Number(car.flagAck?.flagTs) === flagTs;
}

function serializeCar(car, { includeTrail = false } = {}) {
  return {
    id: car.id,
    carNumber: car.carNumber,
    driverName: car.driverName,
    color: car.color,
    tracking: car.tracking,
    live: isLive(car),
    last: car.last,
    section: car.section || null,
    crewStatus: car.crewStatus || null,
    flagStatus: sectionFlag(car.section).flagStatus,
    flagAcked: hasAckedFlag(car, car.section),
    reconnectRequested: Boolean(car.reconnectRequested),
    trailCount: Array.isArray(car.trail) ? car.trail.length : 0,
    ...(includeTrail ? { trail: car.trail || [] } : {}),
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

function finiteOrNull(value) {
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function normalizeTs(raw) {
  const ts = Number(raw);
  const now = Date.now();
  if (!Number.isFinite(ts)) return now;
  if (ts > now + 120_000) return now;
  if (now - ts > MAX_POINT_AGE_MS) return now;
  return ts;
}

function normalizePoint(raw) {
  if (!raw || typeof raw !== "object") return null;
  const lat = Number(raw.lat);
  const lon = Number(raw.lon);
  if (!validCoord(lat, lon)) return null;
  const speed = finiteOrNull(raw.speed);
  return {
    lat,
    lon,
    heading: finiteOrNull(raw.heading),
    speed: speed == null ? null : Math.max(0, speed),
    accuracy: finiteOrNull(raw.accuracy),
    ts: normalizeTs(raw.ts),
  };
}

function applyFix(car, point, sections, { detect = true } = {}) {
  car.tracking = true;
  if (!car.last || point.ts >= Number(car.last.ts) || !Number.isFinite(Number(car.last.ts))) {
    car.last = {
      lat: point.lat,
      lon: point.lon,
      heading: point.heading,
      speed: point.speed,
      accuracy: point.accuracy,
      ts: point.ts,
    };
  }

  if (!Array.isArray(car.trail)) car.trail = [];
  const prev = car.trail[car.trail.length - 1];
  if (!prev || haversineMeters(prev, point) >= 3) {
    car.trail.push({ lat: point.lat, lon: point.lon, ts: point.ts });
    if (car.trail.length > MAX_TRAIL) car.trail.splice(0, car.trail.length - MAX_TRAIL);
  }

  if (!detect || !sections) return;
  try {
    const previousStageId = car.section?.type === "stage" ? car.section.id : null;
    car.section = detectSection({ lat: point.lat, lon: point.lon }, sections);
    const nowStageId = car.section?.type === "stage" ? car.section.id : null;
    if (nowStageId !== previousStageId) car.crewStatus = null;
  } catch (err) {
    console.error("section detect failed", err.message);
  }
}

function pingPayload(car) {
  const { flagStatus, flagTs } = sectionFlag(car.section);
  return {
    ok: true,
    receivedAt: car.last?.ts || Date.now(),
    section: car.section || null,
    crewStatus: car.crewStatus || null,
    flagStatus,
    flagTs,
    flagAcked: hasAckedFlag(car, car.section),
  };
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
    const car = await store.getCar(req.body.id);
    if (!car || car.token !== req.body.token) {
      return res.status(401).json({ error: "Unknown car session. Register again." });
    }
    const point = normalizePoint(req.body);
    if (!point) {
      return res.status(400).json({ error: "Invalid coordinates." });
    }

    const sections = await store.listSections().catch(() => []);
    applyFix(car, point, sections, { detect: true });
    car.reconnectRequested = null;
    await store.saveCar(car);
    res.json(pingPayload(car));
  })
);

app.post(
  "/api/ping-batch",
  asyncHandler(async (req, res) => {
    const car = await store.getCar(req.body.id);
    if (!car || car.token !== req.body.token) {
      return res.status(401).json({ error: "Unknown car session. Register again." });
    }
    const rawPoints = Array.isArray(req.body.points) ? req.body.points : [];
    if (!rawPoints.length) {
      return res.status(400).json({ error: "No GPS points." });
    }
    const points = rawPoints
      .slice(0, MAX_BATCH)
      .map(normalizePoint)
      .filter(Boolean)
      .sort((a, b) => a.ts - b.ts);
    if (!points.length) {
      return res.status(400).json({ error: "Invalid coordinates." });
    }

    const sections = await store.listSections().catch(() => []);
    for (let i = 0; i < points.length; i += 1) {
      applyFix(car, points[i], sections, { detect: i === points.length - 1 });
    }
    car.reconnectRequested = null;
    await store.saveCar(car);
    res.json({ ...pingPayload(car), accepted: points.length });
  })
);

app.post(
  "/api/crew-status",
  asyncHandler(async (req, res) => {
    const status = String(req.body.status || "").toLowerCase();
    if (status !== "ok" && status !== "sos") {
      return res.status(400).json({ error: "status must be ok or sos." });
    }
    const car = await store.getCar(req.body.id);
    if (!car || car.token !== req.body.token) {
      return res.status(401).json({ error: "Unknown car session." });
    }
    car.crewStatus = {
      status,
      ts: Date.now(),
      stageId: car.section?.id || null,
      stageName: car.section?.name || car.section?.label || null,
    };
    await store.saveCar(car);
    res.json({ ok: true, crewStatus: car.crewStatus });
  })
);

app.post(
  "/api/flag-ack",
  asyncHandler(async (req, res) => {
    const car = await store.getCar(req.body.id);
    if (!car || car.token !== req.body.token) {
      return res.status(401).json({ error: "Unknown car session." });
    }
    const sections = await store.listSections();
    const live = sections.find((s) => s.id === car.section?.id) || car.section;
    const { flagStatus, flagTs } = sectionFlag(live);
    if (!live || live.type !== "stage" || flagStatus !== "red") {
      return res.status(400).json({ error: "This car is not on a red-flagged stage." });
    }
    car.flagAck = { stageId: live.id, flagTs, ts: Date.now() };
    await store.saveCar(car);
    res.json({ ok: true, flagAcked: true, flagStatus, flagTs });
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
      cars: cars.map((car) => serializeCar(car)),
    });
  })
);

app.get(
  "/api/cars/:id",
  asyncHandler(async (req, res) => {
    const car = await store.getCar(req.params.id);
    if (!car) return res.status(404).json({ error: "Car not found." });
    res.json(serializeCar(car, { includeTrail: true }));
  })
);

app.post(
  "/api/poll",
  asyncHandler(async (req, res) => {
    const car = await store.getCar(req.body.id);
    if (!car || car.token !== req.body.token) {
      return res.status(401).json({ error: "Unknown car session." });
    }
    const { flagStatus, flagTs } = sectionFlag(car.section);
    res.json({
      ok: true,
      tracking: car.tracking,
      reconnectRequested: Boolean(car.reconnectRequested),
      section: car.section || null,
      flagStatus,
      flagTs,
      flagAcked: hasAckedFlag(car, car.section),
    });
  })
);

app.post(
  "/api/cars/:id/refresh",
  asyncHandler(async (req, res) => {
    const car = await store.getCar(req.params.id);
    if (!car) return res.status(404).json({ error: "Car not found." });
    reviveLastFix(car);
    await store.saveCar(car);
    res.json({
      ok: true,
      id: car.id,
      reconnectRequested: true,
      live: isLive(car),
      last: car.last || null,
    });
  })
);

app.post(
  "/api/refresh-lost",
  asyncHandler(async (_req, res) => {
    const cars = await store.listCars();
    const lost = cars.filter((car) => car.tracking && !isLive(car));
    for (const car of lost) {
      reviveLastFix(car);
      await store.saveCar(car);
    }
    res.json({ ok: true, count: lost.length });
  })
);

app.get(
  "/api/cars/:id/track.gpx",
  asyncHandler(async (req, res) => {
    const car = await store.getCar(req.params.id);
    if (!car) return res.status(404).json({ error: "Car not found." });
    const trail = Array.isArray(car.trail) ? car.trail : [];
    const points = trail
      .map((p) => {
        const time = p.ts ? new Date(p.ts).toISOString() : "";
        return `      <trkpt lat="${p.lat}" lon="${p.lon}"><time>${time}</time></trkpt>`;
      })
      .join("\n");
    const gpx = `<?xml version="1.0" encoding="UTF-8"?>
<gpx version="1.1" creator="Rally GPS">
  <metadata><name>#${xml(car.carNumber)} ${xml(car.driverName)}</name></metadata>
  <trk>
    <name>#${xml(car.carNumber)} ${xml(car.driverName)}</name>
    <trkseg>
${points}
    </trkseg>
  </trk>
</gpx>`;
    res.set({
      "Content-Type": "application/gpx+xml; charset=utf-8",
      "Content-Disposition": `attachment; filename="car-${car.carNumber}-track.gpx"`,
      "Cache-Control": "no-store",
    });
    res.send(gpx);
  })
);

app.get(
  "/api/cars/:id/track.kml",
  asyncHandler(async (req, res) => {
    const car = await store.getCar(req.params.id);
    if (!car) return res.status(404).json({ error: "Car not found." });
    const trail = Array.isArray(car.trail) ? car.trail : [];
    const coords = trail.map((p) => `${p.lon},${p.lat},0`).join(" ");
    const kml = `<?xml version="1.0" encoding="UTF-8"?>
<kml xmlns="http://www.opengis.net/kml/2.2">
  <Document>
    <name>#${xml(car.carNumber)} ${xml(car.driverName)}</name>
    <Placemark>
      <name>#${xml(car.carNumber)} track</name>
      <LineString>
        <tessellate>1</tessellate>
        <coordinates>${coords}</coordinates>
      </LineString>
    </Placemark>
  </Document>
</kml>`;
    res.set({
      "Content-Type": "application/vnd.google-earth.kml+xml; charset=utf-8",
      "Content-Disposition": `attachment; filename="car-${car.carNumber}-track.kml"`,
      "Cache-Control": "no-store",
    });
    res.send(kml);
  })
);

app.get(
  "/api/sections",
  asyncHandler(async (_req, res) => {
    const sections = await store.listSections();
    res.json({ sections });
  })
);

app.post(
  "/api/sections/upload",
  asyncHandler(async (req, res) => {
    const filename = String(req.body.filename || "route.kmz");
    const contentBase64 = String(req.body.contentBase64 || "");
    const replace = req.body.replace !== false;
    if (!contentBase64) {
      return res.status(400).json({ error: "contentBase64 is required (KMZ or KML file)." });
    }

    const buffer = Buffer.from(contentBase64, "base64");
    if (!buffer.length) {
      return res.status(400).json({ error: "Empty file." });
    }
    if (buffer.length > 12 * 1024 * 1024) {
      return res.status(400).json({ error: "File too large (max 12 MB)." });
    }

    const parsed = await parseKmzOrKml(buffer, filename);
    if (!parsed.length) {
      return res.status(400).json({
        error:
          "No LineString/Polygon placemarks found. Export road sections and stages as paths in Google Earth.",
      });
    }

    const saved = replace
      ? await store.replaceSections(parsed)
      : await store.replaceSections([...(await store.listSections()), ...parsed]);

    res.json({
      ok: true,
      count: saved.length,
      stages: saved.filter((s) => s.type === "stage").length,
      roads: saved.filter((s) => s.type === "road").length,
      sections: saved.map((s) => ({
        id: s.id,
        name: s.name,
        type: s.type,
        label: s.label,
        points: s.coordinates.length,
      })),
    });
  })
);

app.patch(
  "/api/sections/:id",
  asyncHandler(async (req, res) => {
    const type = req.body.type;
    const name = req.body.name != null ? String(req.body.name).trim() : undefined;
    const patch = {};
    if (name) patch.name = name;
    if (type === "stage" || type === "road") {
      patch.type = type;
      patch.label = buildLabel(name || (await store.listSections()).find((s) => s.id === req.params.id)?.name || "Section", type);
      if (type === "road") {
        patch.flagStatus = "green";
        patch.flagTs = Date.now();
      }
    }
    if (typeof req.body.active === "boolean") patch.active = req.body.active;
    if (req.body.flagStatus === "red" || req.body.flagStatus === "green") {
      const current =
        (await store.listSections()).find((s) => s.id === req.params.id) || null;
      if (req.body.flagStatus === "red" && current && current.type !== "stage") {
        return res.status(400).json({ error: "Only special stages can be red-flagged." });
      }
      patch.flagStatus = req.body.flagStatus;
      patch.flagTs = Date.now();
    }
    const updated = await store.updateSection(req.params.id, patch);
    if (!updated) return res.status(404).json({ error: "Section not found." });
    res.json({ section: updated });
  })
);

app.delete(
  "/api/sections",
  asyncHandler(async (_req, res) => {
    await store.clearSections();
    res.json({ ok: true });
  })
);

app.delete(
  "/api/sections/:id",
  asyncHandler(async (req, res) => {
    await store.deleteSection(req.params.id);
    res.json({ ok: true });
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
    const [cars, sections] = await Promise.all([store.listCars(), store.listSections()]);
    res.set({
      "Content-Type": "application/vnd.google-earth.kml+xml; charset=utf-8",
      "Cache-Control": "no-store",
    });
    res.send(buildLiveKml(cars, sections));
  })
);

function buildLiveKml(cars, sections = []) {
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

  const routeStyles = `    <Style id="roadStyle">
      <LineStyle><color>${kmlColor("#3d7dff", "cc")}</color><width>3</width></LineStyle>
      <PolyStyle><color>${kmlColor("#3d7dff", "44")}</color></PolyStyle>
    </Style>
    <Style id="stageStyle">
      <LineStyle><color>${kmlColor("#ff3b30", "ee")}</color><width>5</width></LineStyle>
      <PolyStyle><color>${kmlColor("#ff3b30", "55")}</color></PolyStyle>
    </Style>`;

  const carMarks = list
    .map((car) => {
      const live = isLive(car);
      const speedKmh =
        car.last.speed == null ? "—" : `${Math.round(car.last.speed * 3.6)} km/h`;
      const ageSec = Math.max(0, Math.round((Date.now() - car.last.ts) / 1000));
      const headingTag =
        car.last.heading == null ? "" : `<heading>${xml(car.last.heading)}</heading>`;
      const sectionLabel = car.section?.label ? `<br/>${car.section.label}` : "";
      const status = live ? "LIVE" : car.tracking ? "SIGNAL LOST" : "STOPPED";
      return `      <Placemark>
        <name>${xml("#" + car.carNumber + "  " + car.driverName)}</name>
        <description><![CDATA[${status}<br/>Speed: ${speedKmh}<br/>Updated: ${ageSec}s ago${sectionLabel}]]></description>
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

  const routeMarks = sections
    .filter((s) => s.active !== false && Array.isArray(s.coordinates) && s.coordinates.length >= 2)
    .map((section) => {
      const coords = section.coordinates.map((p) => `${p.lon},${p.lat},0`).join(" ");
      const styleUrl = section.type === "stage" ? "#stageStyle" : "#roadStyle";
      if (section.geometryType === "Polygon") {
        return `      <Placemark>
        <name>${xml(section.label)}</name>
        <styleUrl>${styleUrl}</styleUrl>
        <Polygon>
          <tessellate>1</tessellate>
          <outerBoundaryIs><LinearRing><coordinates>${coords}</coordinates></LinearRing></outerBoundaryIs>
        </Polygon>
      </Placemark>`;
      }
      return `      <Placemark>
        <name>${xml(section.label)}</name>
        <styleUrl>${styleUrl}</styleUrl>
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
${routeStyles}
    <Folder>
      <name>Route</name>
      <open>1</open>
${routeMarks}
    </Folder>
    <Folder>
      <name>Cars</name>
      <open>1</open>
${carMarks}
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
