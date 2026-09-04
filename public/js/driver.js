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
const STOPPED_SPEED_MPS = 1.2;
const STOPPED_ALERT_MS = 20_000;

let session = null;
let watchId = null;
let wakeLock = null;
let tracking = false;
let lastFix = null;
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

const saved = localStorage.getItem(KEY);
if (saved) {
  try {
    session = JSON.parse(saved);
    showTrack();
  } catch {
    localStorage.removeItem(KEY);
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
}

function hideRedFlagAlert() {
  redFlagAlert.classList.add("hidden");
}

function showCrewAlert() {
  crewAlert.classList.remove("hidden");
  trackPanel.classList.add("hidden");
  stagePanel.classList.add("hidden");
  setupPanel.classList.add("hidden");
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
  if (!navigator.geolocation) {
    showError("This phone has no GPS / geolocation support.");
    return;
  }
  errorRead.classList.add("hidden");
  tracking = true;
  toggleBtn.textContent = "Stop tracking";
  toggleBtn.className = "btn btn-stop";
  setLamp("lamp-live", "TRACKING", "Keep this screen open while you are on the stage");
  updateRoadSectionUi();
  await requestWakeLock();

  watchId = navigator.geolocation.watchPosition(onFix, onGeoError, {
    enableHighAccuracy: true,
    maximumAge: 1000,
    timeout: 15000,
  });
}

async function stopTracking() {
  tracking = false;
  inStage = false;
  sectionType = null;
  sectionLabel = null;
  hideCrewAlert();
  hideRedFlagAlert();
  if (watchId != null) {
    navigator.geolocation.clearWatch(watchId);
    watchId = null;
  }
  releaseWakeLock();
  toggleBtn.textContent = "Start tracking";
  toggleBtn.className = "btn btn-start";
  setLamp("lamp-idle", "STOPPED", "Tracking is off. Tap start when you are ready.");
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
  try {
    const res = await fetch("/api/poll", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id: session.id, token: session.token }),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) return;
    if (data.reconnectRequested) requestFreshFix();
  } catch {
    if (lastFix) {
      try {
        await onFix(lastFix);
      } catch {
        /* still offline */
      }
    }
  }
}

setInterval(pollReconnect, 4000);

async function onFix(pos) {
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

  try {
    const res = await fetch("/api/ping", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        id: session.id,
        token: session.token,
        lat,
        lon,
        heading: heading == null || Number.isNaN(heading) ? null : heading,
        speed: speed == null || Number.isNaN(speed) ? null : speed,
        accuracy: accuracy == null || Number.isNaN(accuracy) ? null : accuracy,
      }),
    });
    const data = await res.json().catch(() => ({}));
    if (res.status === 401) {
      localStorage.removeItem(KEY);
      await stopTracking();
      showError("This car was taken over by another phone. Join again.");
      setupPanel.classList.remove("hidden");
      trackPanel.classList.add("hidden");
      return;
    }
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
  } catch {
    setLamp("lamp-warn", "NO NETWORK", "GPS is on this phone, but the server did not receive it");
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
    if ("wakeLock" in navigator) wakeLock = await navigator.wakeLock.request("screen");
  } catch {
    /* older phones */
  }
}

function releaseWakeLock() {
  if (wakeLock) {
    wakeLock.release().catch(() => {});
    wakeLock = null;
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
  if (document.visibilityState === "visible" && tracking) await requestWakeLock();
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
