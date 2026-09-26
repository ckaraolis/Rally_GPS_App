const crypto = require("crypto");
const os = require("os");
const path = require("path");
const express = require("express");
const { getStore, hasSupabase, pickColor, newToken, PALETTE, rallySummary, normalizeFlagTargets } = require("./lib/store");
const auth = require("./lib/auth");
const testSession = require("./lib/testSession");
const { parseKmzOrKml, buildLabel, classifyPinKind } = require("./lib/kml");
const { detectSection, haversineMeters } = require("./lib/geo");

const app = express();
const PORT = Number(process.env.PORT) || 3000;
const PUBLIC_BASE_URL = (process.env.PUBLIC_BASE_URL || "").replace(/\/$/, "");
const STALE_MS = 180_000;
const MAX_TRAIL = 4000;
const MAX_BATCH = 250;
const MAX_POINT_AGE_MS = 24 * 60 * 60 * 1000;
const store = getStore();

async function liveSections() {
  try {
    const live = await store.getLiveRally();
    if (live?.id) {
      const full = (await store.getRally(live.id).catch(() => live)) || live;
      return {
        rallyId: live.id,
        sections: await store.listSections(live.id),
        pinIcons: full.pinIcons || {},
      };
    }
    const rallies = await store.listRallies();
    if (rallies.length) return { rallyId: null, sections: [], pinIcons: {} };
  } catch {
    /* rallies table missing — fall back to any stored route */
  }
  try {
    return { rallyId: null, sections: await store.listSections(), pinIcons: {} };
  } catch {
    return { rallyId: null, sections: [], pinIcons: {} };
  }
}

app.set("trust proxy", 1);
app.disable("x-powered-by");
app.use(express.json({ limit: "15mb" }));
app.use((req, res, next) => {
  if (req.path === "/sw.js") {
    res.set("Service-Worker-Allowed", "/");
    res.set("Cache-Control", "no-store");
  }
  if (req.path === "/" || /\.(html|css|js)$/i.test(req.path)) {
    res.set("Cache-Control", "no-store");
  }
  next();
});

let memoryControlUser = null;

async function loadControlUser(username) {
  try {
    const stored = await store.getControlUser(username);
    if (stored) return stored;
  } catch (err) {
    console.error("control user store", err.message);
  }
  if (memoryControlUser && memoryControlUser.username === username) return memoryControlUser;
  return null;
}

async function saveControlUser(user) {
  memoryControlUser = user;
  try {
    await store.saveControlUser(user);
  } catch (err) {
    console.error("control user save", err.message);
  }
  return user;
}

async function ensureControlUser() {
  const existing = await loadControlUser(auth.DEFAULT_USERNAME);
  if (existing) {
    ensureDefaultDriverStopCodes().catch(() => {});
    return existing;
  }
  const { salt, hash } = auth.hashPassword(auth.DEFAULT_PASSWORD);
  const user = {
    username: auth.DEFAULT_USERNAME,
    salt,
    hash,
    mustChangePassword: true,
  };
  await saveControlUser(user);
  ensureDefaultDriverStopCodes().catch(() => {});
  return user;
}

function sendSession(res, req, user) {
  const token = auth.makeToken(user);
  res.setHeader("Set-Cookie", auth.cookieHeader(token, req));
  return token;
}

app.post(
  "/api/login",
  asyncHandler(async (req, res) => {
    const username = String(req.body.username || "").trim();
    const password = String(req.body.password || "");
    await ensureControlUser();
    const user = await loadControlUser(username);
    if (!user || !auth.verifyPassword(password, user.salt, user.hash)) {
      return res.status(401).json({ error: "Wrong username or password." });
    }
    const token = sendSession(res, req, user);
    res.json({
      ok: true,
      username: user.username,
      mustChangePassword: Boolean(user.mustChangePassword),
      earthToken: token,
    });
  })
);

app.post("/api/logout", (req, res) => {
  res.setHeader("Set-Cookie", auth.clearCookieHeader(req));
  res.json({ ok: true });
});

app.get("/api/me", (req, res) => {
  const session = auth.sessionFromRequest(req);
  if (!session) return res.status(401).json({ error: "Sign in to race control." });
  res.json({
    ok: true,
    username: session.username,
    mustChangePassword: session.mustChangePassword,
    earthToken: session.token,
  });
});

app.post(
  "/api/password",
  asyncHandler(async (req, res) => {
    const session = auth.sessionFromRequest(req);
    if (!session) return res.status(401).json({ error: "Sign in to race control." });
    const currentPassword = String(req.body.currentPassword || "");
    const newPassword = String(req.body.newPassword || "");
    const user = await loadControlUser(session.username);
    if (!user || !auth.verifyPassword(currentPassword, user.salt, user.hash)) {
      return res.status(401).json({ error: "Current password is wrong." });
    }
    if (newPassword.length < 8) {
      return res.status(400).json({ error: "New password must be at least 8 characters." });
    }
    if (newPassword === currentPassword) {
      return res.status(400).json({ error: "Choose a different password." });
    }
    if (newPassword === auth.DEFAULT_PASSWORD) {
      return res.status(400).json({ error: "Do not keep the default password." });
    }
    const { salt, hash } = auth.hashPassword(newPassword);
    user.salt = salt;
    user.hash = hash;
    user.mustChangePassword = false;
    await saveControlUser(user);
    const token = sendSession(res, req, user);
    res.json({ ok: true, username: user.username, mustChangePassword: false, earthToken: token });
  })
);

app.use(auth.protectControl);

const publicDir = path.join(__dirname, "public");
function sendPublic(res, file) {
  res.sendFile(path.join(publicDir, file));
}
app.get(["/test", "/test/"], (_req, res) => sendPublic(res, "test.html"));
app.get(["/test-driver", "/test-driver/"], (_req, res) => sendPublic(res, "test-driver.html"));
app.get(["/control", "/control/"], (_req, res) => sendPublic(res, "control.html"));
app.use(express.static(publicDir));

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

const STOPPED_SPEED_MPS = 1.2;
const MOTION_COLORS = {
  sos: "#ff1a1a",
  moving: "#22c55e",
  stopped: "#3d7dff",
};

const MOTION_KML_ICONS = {
  sos: "http://maps.google.com/mapfiles/kml/paddle/red-circle.png",
  moving: "http://maps.google.com/mapfiles/kml/paddle/grn-circle.png",
  stopped: "http://maps.google.com/mapfiles/kml/paddle/blu-circle.png",
};

function carMotion(car) {
  if (car.crewStatus?.status === "sos") return "sos";
  const speed = Number(car.last?.speed);
  if (Number.isFinite(speed) && speed > STOPPED_SPEED_MPS) return "moving";
  return "stopped";
}

function motionColor(motion) {
  return MOTION_COLORS[motion] || MOTION_COLORS.stopped;
}

function motionKmlIcon(motion) {
  return MOTION_KML_ICONS[motion] || MOTION_KML_ICONS.stopped;
}

function reviveLastFix(car) {
  car.reconnectRequested = Date.now();
  car.tracking = true;
  if (car.last && typeof car.last.lat === "number" && typeof car.last.lon === "number") {
    car.last = { ...car.last, ts: Date.now() };
  }
}

function sectionFlag(section) {
  if (!section || section.type !== "stage") return { flagStatus: "green", flagTs: 0, flagTargets: [] };
  return {
    flagStatus: section.flagStatus === "red" ? "red" : "green",
    flagTs: Number(section.flagTs) || 0,
    flagTargets: normalizeFlagTargets(section.flagTargets),
  };
}

function liveSectionForCar(car, sections) {
  if (!car?.section) return null;
  if (!Array.isArray(sections) || !car.section.id) return car.section;
  return sections.find((s) => s.id === car.section.id) || car.section;
}

function isFlagAudience(car, section) {
  if (!car || !section || section.type !== "stage" || section.flagStatus !== "red") return false;
  const targets = normalizeFlagTargets(section.flagTargets);
  if (!targets.length) return false;
  return targets.includes(String(car.id));
}

function flagForCar(car, sections) {
  const live = liveSectionForCar(car, sections);
  const base = sectionFlag(live);
  if (base.flagStatus === "red" && !isFlagAudience(car, live)) {
    return { flagStatus: "green", flagTs: base.flagTs, flagTargets: base.flagTargets, live, flagTargeted: false };
  }
  return { ...base, live, flagTargeted: base.flagStatus === "red" };
}

function hasAckedFlag(car, section) {
  const { flagStatus, flagTs } = sectionFlag(section);
  if (flagStatus !== "red" || !section || !isFlagAudience(car, section)) return true;
  return car.flagAck?.stageId === section.id && Number(car.flagAck?.flagTs) === flagTs;
}

function serializeCar(car, { includeTrail = false, sections = null } = {}) {
  const motion = carMotion(car);
  const { flagStatus, live } = flagForCar(car, sections);
  return {
    id: car.id,
    carNumber: car.carNumber,
    driverName: car.driverName,
    color: motionColor(motion),
    tracking: car.tracking,
    live: isLive(car),
    last: car.last,
    section: car.section || null,
    crewStatus: car.crewStatus || null,
    flagStatus,
    flagAcked: hasAckedFlag(car, live),
    reconnectRequested: Boolean(car.reconnectRequested),
    motion,
    trailCount: Array.isArray(car.trail) ? car.trail.length : 0,
    ...(includeTrail ? { trail: car.trail || [] } : {}),
  };
}

function parseDate(value) {
  const text = String(value || "").trim();
  if (!text) return null;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(text)) return null;
  return text;
}

function parseRallyStatus(value, fallback = "draft") {
  const status = String(value || "").toLowerCase();
  if (status === "live" || status === "ended" || status === "draft") return status;
  return fallback;
}

async function snapshotRally(rally) {
  const cars = await store.listCars();
  rally.status = "ended";
  rally.snapshot = cars.map((car) => serializeCar(car, { includeTrail: true }));
  rally.carCount = cars.length;
  rally.updatedAt = new Date().toISOString();
  return store.saveRally(rally);
}

/** In-process stop hashes when Supabase lacks columns or a cold instance has not loaded DB yet. */
const stopLockByRally = new Map();
/** Organiser cleared the PIN for this rally — do not auto-heal until they set a code or go LIVE. */
const stopLockOptOut = new Set();

function rememberStopLock(rally) {
  if (!rally?.id || !rally.driverStopSalt || !rally.driverStopHash) return;
  const offline =
    rally.driverStopOffline ||
    (auth.verifyPassword(auth.DEFAULT_DRIVER_STOP_CODE, rally.driverStopSalt, rally.driverStopHash)
      ? auth.offlineStopProof(auth.DEFAULT_DRIVER_STOP_CODE, rally.driverStopSalt)
      : null);
  if (offline && !rally.driverStopOffline) rally.driverStopOffline = offline;
  stopLockByRally.set(rally.id, {
    salt: rally.driverStopSalt,
    hash: rally.driverStopHash,
    offline: offline || null,
  });
  stopLockOptOut.delete(rally.id);
}

function mergeRememberedStopLock(rally) {
  if (!rally?.id) return rally;
  if (rally.driverStopSalt && rally.driverStopHash) {
    rememberStopLock(rally);
    return rally;
  }
  if (stopLockOptOut.has(rally.id)) {
    rally.driverStopSalt = null;
    rally.driverStopHash = null;
    rally.driverStopOffline = null;
    return rally;
  }
  const cached = stopLockByRally.get(rally.id);
  if (cached?.salt && cached?.hash) {
    rally.driverStopSalt = cached.salt;
    rally.driverStopHash = cached.hash;
    if (cached.offline) rally.driverStopOffline = cached.offline;
  }
  return rally;
}

function applyDefaultDriverStopCode(rally) {
  if (!rally) return false;
  mergeRememberedStopLock(rally);
  if (rally.driverStopHash) {
    // Backfill offline proof for the default PIN so phones can unlock without signal.
    if (
      !rally.driverStopOffline &&
      rally.driverStopSalt &&
      auth.verifyPassword(auth.DEFAULT_DRIVER_STOP_CODE, rally.driverStopSalt, rally.driverStopHash)
    ) {
      rally.driverStopOffline = auth.offlineStopProof(
        auth.DEFAULT_DRIVER_STOP_CODE,
        rally.driverStopSalt
      );
      rememberStopLock(rally);
      return true;
    }
    return false;
  }
  if (stopLockOptOut.has(rally.id)) return false;
  const { salt, hash } = auth.hashPassword(auth.DEFAULT_DRIVER_STOP_CODE);
  rally.driverStopSalt = salt;
  rally.driverStopHash = hash;
  rally.driverStopOffline = auth.offlineStopProof(auth.DEFAULT_DRIVER_STOP_CODE, salt);
  rememberStopLock(rally);
  return true;
}

async function seedDefaultDriverStopCodes() {
  try {
    const rallies = await store.listRallies();
    let applied = 0;
    for (const row of rallies) {
      const full = mergeRememberedStopLock((await store.getRally(row.id).catch(() => row)) || row);
      if (stopLockOptOut.has(full.id)) continue;
      if (!applyDefaultDriverStopCode(full)) continue;
      full.updatedAt = new Date().toISOString();
      try {
        await store.saveRally(full);
      } catch (err) {
        console.error("default driver stop save", full.id, err.message);
      }
      rememberStopLock(full);
      applied += 1;
    }
    if (applied) {
      invalidateStopLockCache();
      console.log(`  Driver stop: default PIN hashed onto ${applied} rally(ies) without a stop code`);
    }
  } catch (err) {
    console.error("default driver stop seed", err.message);
  }
}

let defaultStopSeedPromise = null;

function ensureDefaultDriverStopCodes() {
  if (!defaultStopSeedPromise) defaultStopSeedPromise = seedDefaultDriverStopCodes();
  return defaultStopSeedPromise;
}

async function setRallyLive(rally) {
  const rallies = await store.listRallies();
  for (const other of rallies) {
    if (other.id !== rally.id && other.status === "live") {
      const full = (await store.getRally(other.id)) || other;
      await snapshotRally(full);
    }
  }
  stopLockOptOut.delete(rally.id);
  applyDefaultDriverStopCode(rally);
  rally.status = "live";
  rally.updatedAt = new Date().toISOString();
  const saved = await store.saveRally(rally);
  rememberStopLock(saved || rally);
  invalidateStopLockCache();
  return saved;
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

function pingPayload(car, sections, stopLock = false) {
  const { flagStatus, flagTs, live } = flagForCar(car, sections);
  return {
    ok: true,
    receivedAt: car.last?.ts || Date.now(),
    section: car.section || null,
    crewStatus: car.crewStatus || null,
    flagStatus,
    flagTs,
    flagAcked: hasAckedFlag(car, live),
    stopLock: Boolean(stopLock),
  };
}

let stopLockCache = { at: 0, required: false, salt: null, hash: null, offline: null, rallyId: null };
const stopCodeAttempts = new Map();

function invalidateStopLockCache() {
  stopLockCache = { at: 0, required: false, salt: null, hash: null, offline: null, rallyId: null };
}

async function healLiveStopLock(rally) {
  if (!rally?.id || stopLockOptOut.has(rally.id)) return rally;
  mergeRememberedStopLock(rally);
  if (rally.driverStopSalt && rally.driverStopHash) return rally;
  if (!applyDefaultDriverStopCode(rally)) return rally;
  rally.updatedAt = new Date().toISOString();
  try {
    await store.saveRally(rally);
  } catch (err) {
    console.error("live stop lock heal", err.message);
  }
  rememberStopLock(rally);
  invalidateStopLockCache();
  return rally;
}

async function readLiveStopLock() {
  const now = Date.now();
  if (stopLockCache.at && now - stopLockCache.at < 2000) return stopLockCache;
  let required = false;
  let salt = null;
  let hash = null;
  let offline = null;
  let rallyId = null;
  try {
    await ensureDefaultDriverStopCodes();
    const live = await store.getLiveRally();
    if (live?.id) {
      rallyId = live.id;
      let full = mergeRememberedStopLock((await store.getRally(live.id).catch(() => live)) || live);
      full = await healLiveStopLock(full);
      salt = full.driverStopSalt || null;
      hash = full.driverStopHash || null;
      offline = full.driverStopOffline || stopLockByRally.get(rallyId)?.offline || null;
      if (!offline && salt && hash && auth.verifyPassword(auth.DEFAULT_DRIVER_STOP_CODE, salt, hash)) {
        offline = auth.offlineStopProof(auth.DEFAULT_DRIVER_STOP_CODE, salt);
        full.driverStopOffline = offline;
        rememberStopLock(full);
      }
      required = Boolean(salt && hash);
      // Fail closed for LIVE rallies: if opt-out was not set and we still lack a hash,
      // use an ephemeral default so stop cannot proceed without PIN verify.
      if (!required && !stopLockOptOut.has(rallyId)) {
        const ephemeral = auth.hashPassword(auth.DEFAULT_DRIVER_STOP_CODE);
        salt = ephemeral.salt;
        hash = ephemeral.hash;
        offline = auth.offlineStopProof(auth.DEFAULT_DRIVER_STOP_CODE, salt);
        required = true;
        stopLockByRally.set(rallyId, { salt, hash, offline });
      }
    }
  } catch (err) {
    console.error("stop lock", err.message);
  }
  stopLockCache = { at: now, required, salt, hash, offline, rallyId };
  return stopLockCache;
}

function normalizeDriverStopCode(raw) {
  const text = String(raw ?? "").trim();
  if (!/^\d{4,6}$/.test(text)) return null;
  return text;
}

function stopCodeWaitSeconds(carId) {
  const row = stopCodeAttempts.get(carId);
  if (!row?.lockedUntil || row.lockedUntil <= Date.now()) return 0;
  return Math.max(1, Math.ceil((row.lockedUntil - Date.now()) / 1000));
}

function noteStopCodeFailure(carId) {
  const row = stopCodeAttempts.get(carId) || { fails: 0, lockedUntil: 0 };
  row.fails += 1;
  if (row.fails >= 5) {
    row.lockedUntil = Date.now() + 20_000;
    row.fails = 0;
  }
  stopCodeAttempts.set(carId, row);
}

function noteStopCodeSuccess(carId) {
  stopCodeAttempts.delete(carId);
}

function rallyForClient(rally) {
  if (!rally) return null;
  return { ...rallySummary(rally), snapshot: rally.snapshot ?? null };
}

function asyncHandler(fn) {
  return (req, res, next) => {
    Promise.resolve(fn(req, res, next)).catch(next);
  };
}

app.get(
  "/api/health",
  asyncHandler(async (_req, res) => {
    let cars = null;
    let liveRallyId = null;
    try {
      cars = (await store.listCars()).length;
    } catch (err) {
      cars = -1;
      console.error("health cars", err.message);
    }
    try {
      const live = await store.getLiveRally();
      liveRallyId = live?.id || null;
    } catch (err) {
      console.error("health live", err.message);
    }
    res.json({
      ok: true,
      store: store.mode,
      supabase: hasSupabase(),
      cars,
      liveRallyId,
      time: Date.now(),
    });
  })
);

app.get("/api/test/session", (_req, res) => {
  res.json(testSession.snapshot());
});

app.patch(
  "/api/test/session",
  asyncHandler(async (req, res) => {
    try {
      res.json(testSession.applyHqPatch(req.body || {}));
    } catch (err) {
      const code = Number(err.statusCode) || 400;
      res.status(code).json({ error: err.message || "Could not update test session." });
    }
  })
);

app.post("/api/test/crew-status", (req, res) => {
  try {
    res.json(testSession.setCrewStatus(req.body?.status));
  } catch (err) {
    const code = Number(err.statusCode) || 400;
    res.status(code).json({ error: err.message || "Could not set test crew status." });
  }
});

app.post("/api/test/flag-ack", (_req, res) => {
  try {
    res.json(testSession.ackFlag());
  } catch (err) {
    const code = Number(err.statusCode) || 400;
    res.status(code).json({ error: err.message || "Could not acknowledge test red flag." });
  }
});

app.post(
  "/api/register",
  asyncHandler(async (req, res) => {
    const carNumber = String(req.body.carNumber || "").trim().slice(0, 8);
    const driverName = String(req.body.driverName || "").trim().slice(0, 40);

    if (!carNumber || !driverName) {
      return res.status(400).json({ error: "Car number and driver name are required." });
    }

    const stopLock = (await readLiveStopLock()).required;
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
        stopLock,
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
      stopLock,
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

    const { sections } = await liveSections();
    applyFix(car, point, sections, { detect: true });
    car.reconnectRequested = null;
    await store.saveCar(car);
    const stopLock = (await readLiveStopLock()).required;
    res.json(pingPayload(car, sections, stopLock));
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

    const { sections } = await liveSections();
    for (let i = 0; i < points.length; i += 1) {
      applyFix(car, points[i], sections, { detect: i === points.length - 1 });
    }
    car.reconnectRequested = null;
    await store.saveCar(car);
    const stopLock = (await readLiveStopLock()).required;
    res.json({ ...pingPayload(car, sections, stopLock), accepted: points.length });
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
    const { sections } = await liveSections();
    const live = sections.find((s) => s.id === car.section?.id) || car.section;
    const { flagStatus, flagTs } = sectionFlag(live);
    if (!live || live.type !== "stage" || flagStatus !== "red" || !isFlagAudience(car, live)) {
      return res.status(400).json({ error: "This car is not on a red-flagged stage." });
    }
    car.flagAck = { stageId: live.id, flagTs, ts: Date.now() };
    await store.saveCar(car);
    res.json({ ok: true, flagAcked: true, flagStatus, flagTs });
  })
);

app.get(
  "/api/stop-lock",
  asyncHandler(async (_req, res) => {
    const lock = await readLiveStopLock();
    res.json({
      stopLock: lock.required,
      liveRallyId: lock.rallyId || null,
      // Salt + offline proof let the phone verify the organiser PIN with no signal.
      // Never send the PIN itself or the scrypt hash used server-side.
      salt: lock.required ? lock.salt || null : null,
      offline: lock.required ? lock.offline || null : null,
    });
  })
);

app.post(
  "/api/stop",
  asyncHandler(async (req, res) => {
    const car = await store.getCar(req.body.id);
    if (!car || car.token !== req.body.token) {
      return res.status(401).json({ error: "Unknown car session." });
    }
    const lock = await readLiveStopLock();
    if (lock.required) {
      const wait = stopCodeWaitSeconds(car.id);
      if (wait) {
        return res.status(429).json({
          error: "Too many attempts. Wait a moment.",
          stopLock: true,
          retryAfter: wait,
        });
      }
      const code = normalizeDriverStopCode(req.body.code);
      if (!code) {
        return res.status(403).json({
          error: "Stop code required.",
          stopLock: true,
          needCode: true,
        });
      }
      if (!auth.verifyPassword(code, lock.salt, lock.hash)) {
        noteStopCodeFailure(car.id);
        return res.status(403).json({ error: "Wrong stop code.", stopLock: true });
      }
      noteStopCodeSuccess(car.id);
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
    let liveRally = null;
    let ralliesReady = true;
    let rallyCount = 0;
    try {
      const rallies = await store.listRallies();
      rallyCount = rallies.length;
      liveRally = rallies.find((r) => r.status === "live") || null;
    } catch (err) {
      ralliesReady = false;
      console.error("rally_events unavailable", err.message);
    }
    const mapOpen = Boolean(liveRally) || !ralliesReady || rallyCount === 0;
    const { sections } = await liveSections();
    res.json({
      serverTime: Date.now(),
      ralliesReady,
      mapOpen,
      liveRally: rallySummary(liveRally),
      cars: cars.map((car) => serializeCar(car, { sections })),
    });
  })
);

app.delete(
  "/api/cars",
  asyncHandler(async (_req, res) => {
    const count = await store.clearCars();
    res.json({ ok: true, count });
  })
);

app.get(
  "/api/rallies",
  asyncHandler(async (_req, res) => {
    await ensureDefaultDriverStopCodes();
    const rallies = await store.listRallies();
    const withLocks = rallies.map((row) => mergeRememberedStopLock({ ...row }));
    const live = withLocks.find((r) => r.status === "live") || null;
    if (live) await healLiveStopLock(live);
    res.json({
      liveRally: rallySummary(live),
      rallies: withLocks.map(rallySummary),
    });
  })
);

app.post(
  "/api/rallies",
  asyncHandler(async (req, res) => {
    const name = String(req.body.name || "").trim().slice(0, 80);
    if (!name) return res.status(400).json({ error: "Rally name is required." });
    const rally = {
      id: crypto.randomUUID(),
      name,
      startDate: parseDate(req.body.startDate),
      endDate: parseDate(req.body.endDate),
      status: "draft",
      snapshot: null,
      carCount: 0,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
    applyDefaultDriverStopCode(rally);
    if (parseRallyStatus(req.body.status, "draft") === "live") {
      await setRallyLive(rally);
    } else {
      await store.saveRally(rally);
      rememberStopLock(rally);
    }
    invalidateStopLockCache();
    res.json({ rally: rallySummary(rally) });
  })
);

app.get(
  "/api/rallies/:id",
  asyncHandler(async (req, res) => {
    const rally = await store.getRally(req.params.id);
    if (!rally) return res.status(404).json({ error: "Rally not found." });
    res.json({ rally: rallyForClient(rally) });
  })
);

app.patch(
  "/api/rallies/:id",
  asyncHandler(async (req, res) => {
    const rally = await store.getRally(req.params.id);
    if (!rally) return res.status(404).json({ error: "Rally not found." });
    if (req.body.name != null) {
      const name = String(req.body.name || "").trim().slice(0, 80);
      if (!name) return res.status(400).json({ error: "Rally name is required." });
      rally.name = name;
    }
    if (req.body.startDate !== undefined) rally.startDate = parseDate(req.body.startDate);
    if (req.body.endDate !== undefined) rally.endDate = parseDate(req.body.endDate);
    const nextStatus = req.body.status != null ? parseRallyStatus(req.body.status, rally.status) : rally.status;
    rally.updatedAt = new Date().toISOString();
    if (nextStatus === "live" && rally.status !== "live") {
      await setRallyLive(rally);
    } else if (nextStatus === "ended" && rally.status === "live") {
      await snapshotRally(rally);
    } else {
      rally.status = nextStatus;
      await store.saveRally(rally);
      rememberStopLock(rally);
    }
    const saved = mergeRememberedStopLock((await store.getRally(rally.id).catch(() => rally)) || rally);
    res.json({ rally: rallySummary(saved || rally) });
  })
);

app.post(
  "/api/rallies/:id/driver-stop-code",
  asyncHandler(async (req, res) => {
    const rally = await store.getRally(req.params.id);
    if (!rally) return res.status(404).json({ error: "Rally not found." });
    if (req.body.clear === true) {
      rally.driverStopSalt = null;
      rally.driverStopHash = null;
      rally.driverStopOffline = null;
      stopLockByRally.delete(rally.id);
      stopLockOptOut.add(rally.id);
    } else {
      const code = normalizeDriverStopCode(req.body.code);
      if (!code) {
        return res.status(400).json({ error: "Use a 4–6 digit code." });
      }
      const { salt, hash } = auth.hashPassword(code);
      rally.driverStopSalt = salt;
      rally.driverStopHash = hash;
      rally.driverStopOffline = auth.offlineStopProof(code, salt);
      stopLockOptOut.delete(rally.id);
      rememberStopLock(rally);
    }
    rally.updatedAt = new Date().toISOString();
    await store.saveRally(rally);
    if (req.body.clear !== true) rememberStopLock(rally);
    invalidateStopLockCache();
    const saved = mergeRememberedStopLock((await store.getRally(rally.id).catch(() => rally)) || rally);
    if (req.body.clear === true) {
      saved.driverStopSalt = null;
      saved.driverStopHash = null;
      saved.driverStopOffline = null;
    }
    res.json({
      ok: true,
      driverStopLock: Boolean(saved.driverStopHash),
      rally: rallySummary(saved),
    });
  })
);

const PIN_ICON_KINDS = ["tc", "start", "finish", "stop", "refuel"];
const PIN_ICON_MAX = 400 * 1024;

function normalizeIconBase64(raw) {
  const text = String(raw || "");
  return text.includes(",") ? text.split(",").pop() : text;
}

function iconMimeFromName(filename, fallback = "image/png") {
  const lower = String(filename || "").toLowerCase();
  if (lower.endsWith(".jpg") || lower.endsWith(".jpeg")) return "image/jpeg";
  if (lower.endsWith(".webp")) return "image/webp";
  if (lower.endsWith(".svg")) return "image/svg+xml";
  if (lower.endsWith(".gif")) return "image/gif";
  if (lower.endsWith(".png")) return "image/png";
  return fallback;
}

app.post(
  "/api/rallies/:id/pin-icons",
  asyncHandler(async (req, res) => {
    const kind = String(req.body.kind || "").toLowerCase();
    if (!PIN_ICON_KINDS.includes(kind)) {
      return res.status(400).json({ error: "kind must be tc, start, finish, stop, or refuel." });
    }
    const rally = await store.getRally(req.params.id);
    if (!rally) return res.status(404).json({ error: "Rally not found." });
    const filename = String(req.body.filename || "icon.png");
    const contentBase64 = normalizeIconBase64(req.body.contentBase64);
    if (!contentBase64) return res.status(400).json({ error: "Image file is required." });
    const buffer = Buffer.from(contentBase64, "base64");
    if (!buffer.length) return res.status(400).json({ error: "Empty image." });
    if (buffer.length > PIN_ICON_MAX) {
      return res.status(400).json({ error: "Image too large (max 400 KB). Use a 64–128 px PNG." });
    }
    const mime = String(req.body.mime || iconMimeFromName(filename)).slice(0, 40);
    if (!/^image\/(png|jpeg|jpg|webp|gif|svg\+xml)$/i.test(mime)) {
      return res.status(400).json({ error: "Use PNG, JPEG, WebP, GIF, or SVG." });
    }
    const pinIcons = { ...(rally.pinIcons || {}) };
    pinIcons[kind] = {
      mime: mime === "image/jpg" ? "image/jpeg" : mime,
      data: contentBase64,
      name: filename.slice(0, 80),
    };
    rally.pinIcons = pinIcons;
    rally.updatedAt = new Date().toISOString();
    await store.saveRally(rally);
    res.json({ ok: true, kind, pinIcons: rally.pinIcons });
  })
);

app.delete(
  "/api/rallies/:id/pin-icons/:kind",
  asyncHandler(async (req, res) => {
    const kind = String(req.params.kind || "").toLowerCase();
    if (!PIN_ICON_KINDS.includes(kind)) {
      return res.status(400).json({ error: "kind must be tc, start, finish, stop, or refuel." });
    }
    const rally = await store.getRally(req.params.id);
    if (!rally) return res.status(404).json({ error: "Rally not found." });
    const pinIcons = { ...(rally.pinIcons || {}) };
    delete pinIcons[kind];
    rally.pinIcons = pinIcons;
    rally.updatedAt = new Date().toISOString();
    await store.saveRally(rally);
    res.json({ ok: true, kind, pinIcons: rally.pinIcons });
  })
);

app.delete(
  "/api/rallies/:id",
  asyncHandler(async (req, res) => {
    const rally = await store.getRally(req.params.id);
    if (!rally) return res.status(404).json({ error: "Rally not found." });
    await store.deleteRally(req.params.id);
    res.json({ ok: true });
  })
);

app.get(
  "/api/cars/:id",
  asyncHandler(async (req, res) => {
    const car = await store.getCar(req.params.id);
    if (!car) return res.status(404).json({ error: "Car not found." });
    const { sections } = await liveSections();
    res.json(serializeCar(car, { includeTrail: true, sections }));
  })
);

app.post(
  "/api/poll",
  asyncHandler(async (req, res) => {
    const car = await store.getCar(req.body.id);
    if (!car || car.token !== req.body.token) {
      return res.status(401).json({ error: "Unknown car session." });
    }
    const { sections } = await liveSections();
    const { flagStatus, flagTs, live } = flagForCar(car, sections);
    const stopLock = (await readLiveStopLock()).required;
    res.json({
      ok: true,
      tracking: car.tracking,
      reconnectRequested: Boolean(car.reconnectRequested),
      section: car.section || null,
      flagStatus,
      flagTs,
      flagAcked: hasAckedFlag(car, live),
      stopLock,
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
  asyncHandler(async (req, res) => {
    const requested = String(req.query.rallyId || "").trim();
    if (requested) {
      if (!auth.sessionFromRequest(req)) {
        return res.status(401).json({ error: "Sign in to race control." });
      }
      const rally = await store.getRally(requested).catch(() => null);
      if (!rally) return res.status(404).json({ error: "Rally not found." });
      const sections = await store.listSections(requested);
      return res.json({ sections, rallyId: requested, pinIcons: rally.pinIcons || {} });
    }
    const live = await liveSections();
    res.json({ sections: live.sections, rallyId: live.rallyId, pinIcons: live.pinIcons || {} });
  })
);

app.post(
  "/api/sections/upload",
  asyncHandler(async (req, res) => {
    const rallyId = String(req.body.rallyId || "").trim();
    if (!rallyId) {
      return res.status(400).json({ error: "Select a rally first, then upload its KMZ." });
    }
    const rally = await store.getRally(rallyId).catch(() => null);
    if (!rally) return res.status(404).json({ error: "Rally not found. Create the event first." });

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
          "No LineString, Polygon, or Point placemarks found. Export roads, stages, and pins in Google Earth.",
      });
    }

    const saved = replace
      ? await store.replaceSections(parsed, rallyId)
      : await store.replaceSections([...(await store.listSections(rallyId)), ...parsed], rallyId);

    res.json({
      ok: true,
      rallyId,
      count: saved.length,
      stages: saved.filter((s) => s.type === "stage").length,
      roads: saved.filter((s) => s.type === "road").length,
      markers: saved.filter((s) => s.type === "marker" || s.geometryType === "Point").length,
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
    const current = (await store.getSection(req.params.id)) || null;
    if (type === "stage" || type === "road") {
      patch.type = type;
      patch.label = buildLabel(name || current?.name || "Section", type);
      if (type === "road") {
        patch.flagStatus = "green";
        patch.flagTs = Date.now();
        patch.flagTargets = [];
      }
    }
    if (typeof req.body.active === "boolean") patch.active = req.body.active;
    if (req.body.flagStatus === "red" || req.body.flagStatus === "green") {
      if (req.body.flagStatus === "red" && current && current.type !== "stage") {
        return res.status(400).json({ error: "Only special stages can be red-flagged." });
      }
      if (req.body.flagStatus === "red") {
        const targets = normalizeFlagTargets(req.body.flagTargets);
        if (!targets.length) {
          return res.status(400).json({
            error: "Select at least one car to receive the red flag.",
          });
        }
        patch.flagStatus = "red";
        patch.flagTs = Date.now();
        patch.flagTargets = targets;
      } else {
        patch.flagStatus = "green";
        patch.flagTs = Date.now();
        patch.flagTargets = [];
      }
    } else if (Object.prototype.hasOwnProperty.call(req.body, "flagTargets") && current?.flagStatus === "red") {
      const targets = normalizeFlagTargets(req.body.flagTargets);
      if (!targets.length) {
        return res.status(400).json({
          error: "Select at least one car to receive the red flag.",
        });
      }
      patch.flagTargets = targets;
      patch.flagTs = Date.now();
    }
    const updated = await store.updateSection(req.params.id, patch);
    if (!updated) return res.status(404).json({ error: "Section not found." });
    res.json({ section: updated });
  })
);

app.delete(
  "/api/sections",
  asyncHandler(async (req, res) => {
    const rallyId = String(req.query.rallyId || req.body?.rallyId || "").trim();
    if (!rallyId) {
      return res.status(400).json({ error: "Select a rally first, then clear its KMZ." });
    }
    const rally = await store.getRally(rallyId).catch(() => null);
    if (!rally) return res.status(404).json({ error: "Rally not found." });
    await store.clearSections(rallyId);
    res.json({ ok: true, rallyId });
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
  const session = auth.sessionFromRequest(req);
  const token = session?.token ? `?t=${encodeURIComponent(session.token)}` : "";
  const href = `${publicBase(req)}/earth.kml${token}`;
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
    const [cars, liveRoute] = await Promise.all([store.listCars(), liveSections()]);
    const sections = liveRoute.sections;
    let mapOpen = true;
    try {
      const rallies = await store.listRallies();
      mapOpen = rallies.some((r) => r.status === "live") || rallies.length === 0;
    } catch {
      mapOpen = true;
    }
    res.set({
      "Content-Type": "application/vnd.google-earth.kml+xml; charset=utf-8",
      "Cache-Control": "no-store",
    });
    res.send(buildLiveKml(mapOpen ? cars : [], sections, liveRoute.pinIcons || {}));
  })
);

function pinIconHref(pinIcons, kind, fallback) {
  const entry = pinIcons?.[kind];
  if (entry?.data) return `data:${entry.mime || "image/png"};base64,${entry.data}`;
  return fallback;
}

function kmlPinKind(section) {
  const point = section.coordinates?.[0];
  const classified = classifyPinKind(section.name, section.iconHref || point?.iconHref);
  if (classified === "refuel") return "refuel";
  const stored = section.iconKind || point?.iconKind;
  if (stored === "flag") return classified;
  return stored || classified;
}

function buildKmlPinStyle(id, href, hotspotY = "0.5") {
  return `    <Style id="${id}">
      <IconStyle>
        <scale>1.15</scale>
        <Icon><href>${xml(href)}</href></Icon>
        <hotSpot x="0.5" y="${hotspotY}" xunits="fraction" yunits="fraction"/>
      </IconStyle>
      <LabelStyle>
        <color>${kmlColor("#ffffff")}</color>
        <scale>0.9</scale>
      </LabelStyle>
    </Style>`;
}

function buildLiveKml(cars, sections = [], pinIcons = {}) {
  const list = cars.filter((car) => car.last);
  const styles = PALETTE.map(
    (color, i) => `    <Style id="car${i}">
      <IconStyle>
        <scale>1.1</scale>
        <Icon><href>http://maps.google.com/mapfiles/kml/paddle/wht-circle.png</href></Icon>
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
    </Style>
${buildKmlPinStyle("tcStyle", pinIconHref(pinIcons, "tc", "http://maps.google.com/mapfiles/kml/paddle/red-circle.png"), "0.5")}
${buildKmlPinStyle("startStyle", pinIconHref(pinIcons, "start", "http://maps.google.com/mapfiles/kml/shapes/flag.png"), "0")}
${buildKmlPinStyle("finishStyle", pinIconHref(pinIcons, "finish", "http://maps.google.com/mapfiles/kml/shapes/flag.png"), "0")}
${buildKmlPinStyle("stopStyle", pinIconHref(pinIcons, "stop", "http://maps.google.com/mapfiles/kml/shapes/flag.png"), "0")}
${buildKmlPinStyle("refuelStyle", pinIconHref(pinIcons, "refuel", "http://maps.google.com/mapfiles/kml/shapes/gas_stations.png"), "0.5")}
${buildKmlPinStyle("flagStyle", pinIconHref(pinIcons, "start", "http://maps.google.com/mapfiles/kml/shapes/flag.png"), "0")}
${buildKmlPinStyle("pinStyle", "http://maps.google.com/mapfiles/kml/paddle/ylw-blank.png", "0")}`;

  const carMarks = list
    .map((car) => {
      const live = isLive(car);
      const speedKmh =
        car.last.speed == null ? "—" : `${Math.round(car.last.speed * 3.6)} km/h`;
      const ageSec = Math.max(0, Math.round((Date.now() - car.last.ts) / 1000));
      const motion = carMotion(car);
      const sectionLabel = car.section?.label ? `<br/>${car.section.label}` : "";
      const status = live ? "LIVE" : car.tracking ? "SIGNAL LOST" : "STOPPED";
      return `      <Placemark>
        <name>${xml("#" + car.carNumber + "  " + car.driverName)}</name>
        <description><![CDATA[${status}<br/>Speed: ${speedKmh}<br/>Updated: ${ageSec}s ago${sectionLabel}]]></description>
        <Style>
          <IconStyle>
            <scale>1.1</scale>
            <Icon><href>${motionKmlIcon(motion)}</href></Icon>
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
    .filter((s) => s.active !== false && Array.isArray(s.coordinates) && s.coordinates.length)
    .map((section) => {
      const isPin = section.type === "marker" || section.geometryType === "Point" || section.coordinates.length === 1;
      if (isPin) {
        const p = section.coordinates[0];
        const kind = kmlPinKind(section);
        const styleUrl =
          kind === "tc"
            ? "#tcStyle"
            : kind === "start"
              ? "#startStyle"
              : kind === "finish"
                ? "#finishStyle"
                : kind === "stop"
                  ? "#stopStyle"
                  : kind === "refuel"
                    ? "#refuelStyle"
                    : kind === "flag"
                      ? "#flagStyle"
                      : "#pinStyle";
        return `      <Placemark>
        <name>${xml(section.name || section.label)}</name>
        <styleUrl>${styleUrl}</styleUrl>
        <Point>
          <altitudeMode>clampToGround</altitudeMode>
          <coordinates>${p.lon},${p.lat},0</coordinates>
        </Point>
      </Placemark>`;
      }
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
    ensureDefaultDriverStopCodes();
  });
}

if (require.main === module) {
  startLocal();
}

module.exports = app;
