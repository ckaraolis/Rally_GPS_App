const setupPanel = document.getElementById("setupPanel");
const trackPanel = document.getElementById("trackPanel");
const joinForm = document.getElementById("joinForm");
const toggleBtn = document.getElementById("toggleBtn");
const statusLamp = document.getElementById("statusLamp");
const statusText = document.getElementById("statusText");
const statusHint = document.getElementById("statusHint");
const errorRead = document.getElementById("errorRead");
const secureNote = document.getElementById("secureNote");

const KEY = "rallyGpsSession";
let session = null;
let watchId = null;
let wakeLock = null;
let tracking = false;
let lastFix = null;

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

function showTrack() {
  setupPanel.classList.add("hidden");
  trackPanel.classList.remove("hidden");
  document.getElementById("plateNumber").textContent = `#${session.carNumber}`;
  document.getElementById("plateName").textContent = session.driverName;
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
  await requestWakeLock();

  watchId = navigator.geolocation.watchPosition(onFix, onGeoError, {
    enableHighAccuracy: true,
    maximumAge: 1000,
    timeout: 15000,
  });
}

async function stopTracking() {
  tracking = false;
  if (watchId != null) {
    navigator.geolocation.clearWatch(watchId);
    watchId = null;
  }
  releaseWakeLock();
  toggleBtn.textContent = "Start tracking";
  toggleBtn.className = "btn btn-start";
  setLamp("lamp-idle", "STOPPED", "Tracking is off. Tap start when you are ready.");
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

async function onFix(pos) {
  lastFix = pos;
  const { latitude: lat, longitude: lon, heading, speed, accuracy } = pos.coords;
  document.getElementById("speedRead").textContent =
    speed == null || Number.isNaN(speed) ? "—" : `${Math.round(speed * 3.6)} km/h`;
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
    if (res.status === 401) {
      localStorage.removeItem(KEY);
      await stopTracking();
      showError("This car was taken over by another phone. Join again.");
      setupPanel.classList.remove("hidden");
      trackPanel.classList.add("hidden");
    }
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
