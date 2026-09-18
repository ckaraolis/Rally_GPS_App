const setupPanel = document.getElementById("setupPanel");
const trackPanel = document.getElementById("trackPanel");
const stagePanel = document.getElementById("stagePanel");
const crewAlert = document.getElementById("crewAlert");
const redFlagAlert = document.getElementById("redFlagAlert");
const joinForm = document.getElementById("joinForm");
const toggleBtn = document.getElementById("toggleBtn");
const statusLamp = document.getElementById("statusLamp");
const statusText = document.getElementById("statusText");
const statusHint = document.getElementById("statusHint");
const errorRead = document.getElementById("errorRead");
const secureNote = document.getElementById("secureNote");

const KEY = "rallyGpsSession";
const QUEUE_KEY = "rallyGpsQueue";
const TRACKING_KEY = "rallyGpsTracking";
const STOPPED_SPEED_MPS = 1.2;
const STOPPED_ALERT_MS = 20_000;
const MAX_QUEUE = 2000;
const MIN_QUEUE_METERS = 3;
const MIN_QUEUE_MS = 4000;

let session = null;
let watchId = null;
let wakeLock = null;
let tracking = false;
let lastFix = null;
let lastPingOkAt = 0;
let flushing = false;
let bgKeepalive = null;
let bgFixesWhileHidden = 0;
let lastResumeAt = 0;
let inStage = false;
let stageName = null;
let stageId = null;
let sectionType = null;
let sectionLabel = null;
let stageFlagStatus = "green";
let stageFlagTs = 0;
let flagAcked = true;
let stoppedSinceMs = null;
let acknowledgedStop = false;

if (!window.isSecureContext) {
  secureNote.textContent =
    "This browser will not share GPS over plain HTTP. Open the app with HTTPS (deploy it, or use a tunnel such as cloudflared).";
  secureNote.classList.remove("hidden");
}

if ("serviceWorker" in navigator) {
  navigator.serviceWorker.register("/sw.js").catch(() => {});
}

const saved = localStorage.getItem(KEY);
if (saved) {
  try {
    session = JSON.parse(saved);
    showTrack();
    if (trackingWanted()) startTracking();
  } catch {
    localStorage.removeItem(KEY);
    setTrackingWanted(false);
  }
}

joinForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  errorRead.classList.add("hidden");
  document.getElementById("setupError")?.classList.add("hidden");
  const carNumber = document.getElementById("carNumber").value.trim();
  const driverName = document.getElementById("driverName").value.trim();
  try {
    const res = await fetch("/api/register", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ carNumber, driverName }),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || "Could not join");
    session = data;
    localStorage.setItem(KEY, JSON.stringify(session));
    showTrack();
  } catch (err) {
    showError(err.message);
  }
});

toggleBtn.addEventListener("click", () => {
  if (tracking) stopTracking();
  else startTracking();
});
document.getElementById("stageStopBtn").addEventListener("click", () => stopTracking());

async function sendCrew(status) {
  acknowledgedStop = true;
  hideCrewAlert();
  if (!session) return;
  try {
    await fetch("/api/crew-status", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id: session.id, token: session.token, status }),
    });
  } catch {
    /* ignore */
  }
}

document.getElementById("okBtn").addEventListener("click", () => sendCrew("ok"));
document.getElementById("sosBtn").addEventListener("click", () => sendCrew("sos"));
document.getElementById("alertOkBtn").addEventListener("click", () => sendCrew("ok"));
document.getElementById("alertSosBtn").addEventListener("click", () => sendCrew("sos"));
document.getElementById("redFlagOkBtn").addEventListener("click", ackRedFlag);

async function ackRedFlag() {
  flagAcked = true;
  hideRedFlagAlert();
  renderMode();
  if (!session) return;
  try {
    await fetch("/api/flag-ack", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id: session.id, token: session.token }),
    });
  } catch {
    /* keep local ack so the crew can keep driving */
  }
}

function showTrack() {
  setupPanel.classList.add("hidden");
  trackPanel.classList.remove("hidden");
  stagePanel.classList.add("hidden");
  hideCrewAlert();
  hideRedFlagAlert();
  document.getElementById("plateNumber").textContent = `#${session.carNumber}`;
  document.getElementById("plateName").textContent = session.driverName;
  updateRoadSectionUi();
}

function updateRoadSectionUi() {
  const box = document.getElementById("roadSectionBox");
  const read = document.getElementById("roadSectionRead");
  if (!box || !read) return;
  if (!tracking) {
    read.textContent = "Start tracking";
    box.classList.remove("on-road", "off-route");
    return;
  }
  if (sectionType === "road") {
    read.textContent = sectionLabel || "Road section";
    box.classList.add("on-road");
    box.classList.remove("off-route");
    return;
  }
  read.textContent = "Off route";
  box.classList.add("off-route");
  box.classList.remove("on-road");
}

function setLamp(mode, title, hint) {
  statusLamp.className = `lamp ${mode}`;
  statusText.textContent = title;
  statusHint.textContent = hint;
}

function showError(message) {
  const setupError = document.getElementById("setupError");
  if (setupError && !setupPanel.classList.contains("hidden")) {
    setupError.textContent = message;
    setupError.classList.remove("hidden");
  }
  errorRead.textContent = message;
  errorRead.classList.remove("hidden");
}

function applyStageFlagUi() {
  const flagBox = document.querySelector(".stage-flag-box");
  const flagText = document.getElementById("stageFlag");
  const red = stageFlagStatus === "red";
  flagText.textContent = red ? "RED FLAG" : "GREEN FLAG";
  flagBox.classList.toggle("red", red);
}

function renderMode() {
  if (shouldShowRedFlag()) {
    showRedFlagAlert();
    return;
  }
  hideRedFlagAlert();
  if (!crewAlert.classList.contains("hidden")) return;
  if (tracking && inStage) {
    trackPanel.classList.add("hidden");
    stagePanel.classList.remove("hidden");
    document.getElementById("stageName").textContent = stageName || "SPECIAL STAGE";
    applyStageFlagUi();
  } else {
    stagePanel.classList.add("hidden");
    if (session) trackPanel.classList.remove("hidden");
    updateRoadSectionUi();
  }
  updateBgNote();
}

function shouldShowRedFlag() {
  return tracking && inStage && stageFlagStatus === "red" && !flagAcked;
}

function showRedFlagAlert() {
  redFlagAlert.classList.remove("hidden");
  crewAlert.classList.add("hidden");
  trackPanel.classList.add("hidden");
  stagePanel.classList.add("hidden");
  setupPanel.classList.add("hidden");
  updateBgNote();
}

function hideRedFlagAlert() {
  redFlagAlert.classList.add("hidden");
}

function showCrewAlert() {
  crewAlert.classList.remove("hidden");
  trackPanel.classList.add("hidden");
  stagePanel.classList.add("hidden");
  setupPanel.classList.add("hidden");
  updateBgNote();
}

function hideCrewAlert() {
  crewAlert.classList.add("hidden");
}

function updateStopWatch(speed) {
  if (!inStage) return;
  const moving = speed != null && !Number.isNaN(speed) && speed > STOPPED_SPEED_MPS;
  if (moving) {
    stoppedSinceMs = null;
    acknowledgedStop = false;
    hideCrewAlert();
    renderMode();
    return;
  }
  const now = Date.now();
  if (stoppedSinceMs == null) stoppedSinceMs = now;
  if (now - stoppedSinceMs >= STOPPED_ALERT_MS && !acknowledgedStop) {
    showCrewAlert();
  }
}

async function startTracking() {
  if (tracking && watchId != null) {
    await resumeForegroundTracking();
    return;
  }
  if (!navigator.geolocation) {
    showError("This phone has no GPS / geolocation support.");
    return;
  }
  errorRead.classList.add("hidden");
  tracking = true;
  bgFixesWhileHidden = 0;
  setTrackingWanted(true);
  toggleBtn.textContent = "Stop tracking";
  toggleBtn.className = "btn btn-stop";
  setLiveLamp();
  updateRoadSectionUi();
  updateBgNote();
  await requestWakeLock();
  ensureGeoWatch();
  startBackgroundKeepalive();
  await requestTrackingNotification();
  flushQueue();
}

async function stopTracking() {
  tracking = false;
  inStage = false;
  sectionType = null;
  sectionLabel = null;
  bgFixesWhileHidden = 0;
  setTrackingWanted(false);
  hideCrewAlert();
  hideRedFlagAlert();
  if (watchId != null) {
    navigator.geolocation.clearWatch(watchId);
    watchId = null;
  }
  stopBackgroundKeepalive();
  releaseWakeLock();
  clearTrackingNotification();
  toggleBtn.textContent = "Start tracking";
  toggleBtn.className = "btn btn-start";
  setLamp("lamp-idle", "STOPPED", "Tracking is off. Tap start when you are ready.");
  updateBgNote();
  renderMode();
  if (session) {
    try {
      await fetch("/api/stop", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id: session.id, token: session.token }),
      });
    } catch {
      /* ignore */
    }
  }
}

function requestFreshFix() {
  if (!tracking) return;
  if (!navigator.geolocation) {
    if (lastFix) onFix(lastFix);
    return;
  }
  navigator.geolocation.getCurrentPosition(
    onFix,
    () => {
      if (lastFix) onFix(lastFix);
    },
    { enableHighAccuracy: true, maximumAge: 0, timeout: 8000 }
  );
}

async function pollReconnect() {
  if (!tracking || !session) return;
  let nudged = false;
  try {
    const res = await fetch("/api/poll", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id: session.id, token: session.token }),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      if (lastFix) await onFix(lastFix);
      return;
    }
    nudged = Boolean(data.reconnectRequested);
  } catch {
    if (lastFix) {
      try {
        await onFix(lastFix);
      } catch {
        /* still offline */
      }
    }
    return;
  }
  if (nudged) requestFreshFix();
  if (lastFix) await onFix(lastFix);
  else requestFreshFix();
}

setInterval(pollReconnect, 4000);

function ensureGeoWatch() {
  if (!tracking || !navigator.geolocation) return;
  if (watchId != null) {
    navigator.geolocation.clearWatch(watchId);
    watchId = null;
  }
  watchId = navigator.geolocation.watchPosition(onFix, onGeoError, {
    enableHighAccuracy: true,
    maximumAge: 1000,
    timeout: 15000,
  });
}

async function resumeForegroundTracking() {
  if (!tracking) return;
  const now = Date.now();
  if (now - lastResumeAt < 800) {
    await requestWakeLock();
    return;
  }
  lastResumeAt = now;
  await requestWakeLock();
  ensureGeoWatch();
  requestFreshFix();
  flushQueue();
  setLiveLamp();
  updateBgNote();
}

async function onFix(pos) {
  if (document.hidden) bgFixesWhileHidden += 1;
  lastFix = pos;
  const { latitude: lat, longitude: lon, heading, speed, accuracy } = pos.coords;
  const speedText =
    speed == null || Number.isNaN(speed) ? "—" : `${Math.round(speed * 3.6)} km/h`;
  document.getElementById("speedRead").textContent = speedText;
  document.getElementById("stageSpeed").textContent = `Speed ${speedText}`;
  document.getElementById("accRead").textContent =
    accuracy == null ? "—" : `±${Math.round(accuracy)} m`;
  document.getElementById("headRead").textContent =
    heading == null || Number.isNaN(heading) ? "—" : `${Math.round(heading)}°`;
  document.getElementById("fixRead").textContent = new Date().toLocaleTimeString();
  document.getElementById("coordRead").textContent = `${lat.toFixed(6)}, ${lon.toFixed(6)}`;

  enqueueFix(pos);
  const result = await flushQueue();
  if (result?.busy) {
    updateBgNote();
    return;
  }
  if (result?.data) {
    applyPingResult(result.data, speed);
    return;
  }
  if (!result?.ok) {
    setLamp(
      "lamp-warn",
      "NO NETWORK",
      "GPS is saved on this phone. Race control will get the route when GSM returns."
    );
  }
  updateBgNote();
}

function applyPingResult(data, speed) {
  lastPingOkAt = Date.now();
  setLiveLamp();
  const wasInStage = inStage;
  sectionType = data.section?.type || null;
  sectionLabel = data.section?.label || data.section?.name || null;
  inStage = sectionType === "stage";
  stageName = sectionLabel;
  stageId = data.section?.id || null;
  applyFlagFromServer(data);
  if (!wasInStage && inStage) {
    stoppedSinceMs = null;
    acknowledgedStop = false;
    hideCrewAlert();
  }
  if (wasInStage && !inStage) {
    stoppedSinceMs = null;
    acknowledgedStop = false;
    hideCrewAlert();
    hideRedFlagAlert();
    stageFlagStatus = "green";
    flagAcked = true;
  }
  updateStopWatch(speed);
  renderMode();
}

function pointFromFix(pos) {
  const { latitude: lat, longitude: lon, heading, speed, accuracy } = pos.coords;
  return {
    lat,
    lon,
    heading: heading == null || Number.isNaN(heading) ? null : heading,
    speed: speed == null || Number.isNaN(speed) ? null : speed,
    accuracy: accuracy == null || Number.isNaN(accuracy) ? null : accuracy,
    ts: Number(pos.timestamp) || Date.now(),
  };
}

function loadQueue() {
  try {
    const parsed = JSON.parse(localStorage.getItem(QUEUE_KEY) || "[]");
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function saveQueue(queue) {
  localStorage.setItem(QUEUE_KEY, JSON.stringify(queue));
}

function enqueueFix(pos) {
  const point = pointFromFix(pos);
  const queue = loadQueue();
  const last = queue[queue.length - 1];
  if (last && !shouldKeepQueued(last, point)) queue[queue.length - 1] = point;
  else queue.push(point);
  while (queue.length > MAX_QUEUE) queue.shift();
  saveQueue(queue);
}

function shouldKeepQueued(prev, next) {
  return queueMeters(prev, next) >= MIN_QUEUE_METERS || next.ts - prev.ts >= MIN_QUEUE_MS;
}

function queueMeters(a, b) {
  const r = 6371000;
  const dLat = ((b.lat - a.lat) * Math.PI) / 180;
  const dLon = ((b.lon - a.lon) * Math.PI) / 180;
  const lat1 = (a.lat * Math.PI) / 180;
  const lat2 = (b.lat * Math.PI) / 180;
  const h =
    Math.sin(dLat / 2) ** 2 + Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLon / 2) ** 2;
  return 2 * r * Math.atan2(Math.sqrt(h), Math.sqrt(1 - h));
}

async function flushQueue() {
  if (!session) return { ok: false };
  if (flushing) return { ok: true, busy: true };
  if (!loadQueue().length) return { ok: true, empty: true };
  flushing = true;
  let lastData = null;
  try {
    while (true) {
      const queue = loadQueue();
      if (!queue.length) break;
      const batch = queue.slice(0, 80);
      const res = await fetch("/api/ping-batch", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id: session.id, token: session.token, points: batch }),
      });
      const data = await res.json().catch(() => ({}));
      if (res.status === 401) {
        localStorage.removeItem(KEY);
        localStorage.removeItem(QUEUE_KEY);
        await stopTracking();
        showError("This car was taken over by another phone. Join again.");
        setupPanel.classList.remove("hidden");
        trackPanel.classList.add("hidden");
        return { ok: false };
      }
      if (!res.ok) throw new Error(data.error || "Ping failed");
      saveQueue(queue.slice(batch.length));
      lastData = data;
    }
    return { ok: true, data: lastData };
  } catch {
    return { ok: false };
  } finally {
    flushing = false;
  }
}

function startBackgroundKeepalive() {
  stopBackgroundKeepalive();
  bgKeepalive = setInterval(() => {
    if (!tracking) return;
    requestFreshFix();
    flushQueue();
  }, 3000);
}

function stopBackgroundKeepalive() {
  if (bgKeepalive) {
    clearInterval(bgKeepalive);
    bgKeepalive = null;
  }
}

function onGeoError(err) {
  const messages = {
    1: "Location permission denied. Allow GPS for this site and try again.",
    2: "GPS signal unavailable. Move outdoors and wait for a fix.",
    3: "GPS timed out. Move to a clearer sky and try again.",
  };
  showError(messages[err.code] || err.message || "GPS error");
  setLamp("lamp-warn", "NO GPS", "Waiting for a valid position");
}

async function requestWakeLock() {
  try {
    if (!("wakeLock" in navigator)) return;
    if (document.visibilityState !== "visible") return;
    const next = await navigator.wakeLock.request("screen");
    wakeLock = next;
    next.addEventListener("release", () => {
      if (wakeLock === next) wakeLock = null;
      if (tracking && document.visibilityState === "visible") {
        requestWakeLock();
      }
    });
  } catch {
    wakeLock = null;
  }
}

function releaseWakeLock() {
  if (wakeLock) {
    wakeLock.release().catch(() => {});
    wakeLock = null;
  }
}

function trackingPlatform() {
  const ua = navigator.userAgent || "";
  const iOS =
    /iPad|iPhone|iPod/.test(ua) ||
    (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1);
  const android = /Android/i.test(ua);
  return { iOS, android };
}

function trackingWanted() {
  try {
    return localStorage.getItem(TRACKING_KEY) === "1";
  } catch {
    return false;
  }
}

function setTrackingWanted(on) {
  try {
    if (on) localStorage.setItem(TRACKING_KEY, "1");
    else localStorage.removeItem(TRACKING_KEY);
  } catch {
    /* private mode */
  }
}

function liveHint() {
  const { iOS, android } = trackingPlatform();
  if (document.hidden) {
    if (iOS) {
      return "iPhone usually pauses GPS here. Unlock the phone and keep Rally GPS on screen.";
    }
    if (bgFixesWhileHidden > 0) {
      return "GPS is still sending with this tab in the background.";
    }
    return "Trying to keep GPS alive. If the map stops, unlock the phone or use the Android app.";
  }
  if (iOS) {
    return "Keep this screen on. iPhone cannot track with the screen locked or after switching apps.";
  }
  if (android) {
    return "Keep this screen on, or tracking may pause. For lock-screen GPS, use the Rally GPS Android app.";
  }
  return "Keep this tab open. GPS may pause if you lock the screen or switch away.";
}

function setLiveLamp() {
  if (!tracking) return;
  setLamp(
    "lamp-live",
    document.hidden ? "TRACKING · BACKGROUND" : "TRACKING",
    liveHint()
  );
}

function bgNoteText() {
  const { iOS, android } = trackingPlatform();
  if (iOS) {
    return "Keep this screen on. iPhone Safari cannot do true background GPS.";
  }
  if (document.hidden && bgFixesWhileHidden > 0) {
    return "Background tracking is on. GPS is still sending.";
  }
  if (android) {
    return "Keep this screen on, or tracking may pause on some phones. Lock-screen GPS needs the Rally GPS Android app.";
  }
  return "Keep this screen on, or tracking may pause on some phones.";
}

function updateBgNote() {
  const el = document.getElementById("bgTrackNote");
  if (!el) return;
  const alertsUp =
    !crewAlert.classList.contains("hidden") || !redFlagAlert.classList.contains("hidden");
  if (!tracking || !session || alertsUp || !setupPanel.classList.contains("hidden")) {
    el.classList.add("hidden");
    el.classList.remove("ok");
    return;
  }
  const { iOS } = trackingPlatform();
  el.classList.remove("hidden");
  el.classList.toggle("ok", !iOS && document.hidden && bgFixesWhileHidden > 0);
  el.textContent = bgNoteText();
}

function trackingNotificationBody() {
  const { iOS, android } = trackingPlatform();
  if (iOS) return "Keep this screen on. iPhone cannot track with the screen locked.";
  if (android) return "Keep Rally GPS open. Lock-screen GPS needs the Android app.";
  return "Keep this tab open so GPS can continue.";
}

async function requestTrackingNotification() {
  try {
    if (!("Notification" in window)) return;
    if (Notification.permission === "default") {
      await Notification.requestPermission();
    }
    if (Notification.permission !== "granted") return;
    const ready = navigator.serviceWorker?.ready;
    const reg = ready ? await ready.catch(() => null) : null;
    if (reg?.showNotification) {
      await reg.showNotification("Rally GPS tracking", {
        body: trackingNotificationBody(),
        tag: "rally-tracking",
        silent: true,
        requireInteraction: true,
        icon: "/icons/icon.svg",
      });
      return;
    }
    navigator.serviceWorker?.controller?.postMessage({
      type: "tracking-on",
      body: trackingNotificationBody(),
    });
  } catch {
    /* notifications are a reminder only */
  }
}

function clearTrackingNotification() {
  try {
    navigator.serviceWorker?.controller?.postMessage({ type: "tracking-off" });
    navigator.serviceWorker?.ready
      .then((reg) => reg.getNotifications?.({ tag: "rally-tracking" }))
      .then((notes) => notes?.forEach((note) => note.close()))
      .catch(() => {});
  } catch {
    /* ignore */
  }
}

function applyFlagFromServer(data) {
  const nextFlag = data.flagStatus === "red" || data.section?.flagStatus === "red" ? "red" : "green";
  const nextTs = Number(data.flagTs || data.section?.flagTs || 0);
  if (nextFlag === "green") {
    stageFlagStatus = "green";
    stageFlagTs = nextTs;
    flagAcked = true;
    hideRedFlagAlert();
    return;
  }
  if (nextTs !== stageFlagTs || stageFlagStatus !== "red") {
    flagAcked = data.flagAcked === true;
  }
  stageFlagStatus = "red";
  stageFlagTs = nextTs;
}

async function pollStageFlag() {
  if (!tracking || !inStage || !stageId) return;
  try {
    const res = await fetch("/api/sections");
    const data = await res.json();
    const section = (data.sections || []).find((s) => s.id === stageId);
    if (!section) return;
    applyFlagFromServer({
      flagStatus: section.flagStatus,
      flagTs: section.flagTs,
      flagAcked: false,
      section,
    });
    renderMode();
  } catch {
    /* keep last known flag */
  }
}

setInterval(pollStageFlag, 2000);

document.addEventListener("visibilitychange", async () => {
  if (!tracking && trackingWanted() && session) {
    await startTracking();
    return;
  }
  if (!tracking) return;
  // Do not clearWatch or stop GPS just because the document is hidden.
  if (document.visibilityState === "visible") {
    await resumeForegroundTracking();
    return;
  }
  setLiveLamp();
  updateBgNote();
  requestFreshFix();
  flushQueue();
});

window.addEventListener("pageshow", () => {
  if (!session) return;
  if (trackingWanted() && !tracking) startTracking();
  else if (tracking) resumeForegroundTracking();
});

window.addEventListener("focus", () => {
  if (tracking) resumeForegroundTracking();
});

document.addEventListener("resume", () => {
  if (trackingWanted() && !tracking && session) startTracking();
  else if (tracking) resumeForegroundTracking();
});

window.addEventListener("online", () => {
  if (tracking) flushQueue();
});

window.addEventListener("pagehide", () => {
  if (tracking && session && lastFix) {
    const { latitude: lat, longitude: lon, heading, speed, accuracy } = lastFix.coords;
    navigator.sendBeacon?.(
      "/api/ping",
      new Blob(
        [
          JSON.stringify({
            id: session.id,
            token: session.token,
            lat,
            lon,
            heading,
            speed,
            accuracy,
          }),
        ],
        { type: "application/json" }
      )
    );
  }
});
