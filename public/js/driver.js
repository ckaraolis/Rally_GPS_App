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
const MIN_QUEUE_MS = 2000;
const FLAG_SOUND_SRC = "/audio/red-flag-alert.wav?v=1";
const CREW_HOLD_MS = 3000;

function isRallyTestPage() {
  const path = String(location.pathname || "");
  if (!/\/test-driver(\.html)?$/i.test(path)) return false;
  return (
    window.RALLY_TEST_MODE === true ||
    new URLSearchParams(location.search).get("test") === "1"
  );
}
const TEST_MODE = isRallyTestPage();

let session = null;
let stopLock = null;
let stopBusy = false;
let exitGuardArmed = false;
try {
  const savedLock = sessionStorage.getItem("rallyStopLock");
  if (savedLock === "1") stopLock = true;
  else if (savedLock === "0") stopLock = false;
} catch {
  /* private mode */
}
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
let flagAudio = null;
let flagSoundWanted = false;
let flagSoundRetryBound = false;
let crewStatusSent = null;
let activeHold = null;

if (!TEST_MODE && !window.isSecureContext && secureNote) {
  secureNote.textContent =
    "This browser will not share GPS over plain HTTP. Open the app with HTTPS (deploy it, or use a tunnel such as cloudflared).";
  secureNote.classList.remove("hidden");
}

if (!TEST_MODE && "serviceWorker" in navigator) {
  navigator.serviceWorker.register("/sw.js").catch(() => {});
}

if (!TEST_MODE) {
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
}

joinForm?.addEventListener("submit", async (event) => {
  if (TEST_MODE) return;
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
    if (typeof data.stopLock === "boolean") noteStopLock(data.stopLock);
    showTrack();
  } catch (err) {
    showError(err.message);
  }
});

toggleBtn?.addEventListener("click", () => {
  if (TEST_MODE) return;
  if (tracking) requestStopTracking();
  else startTracking();
});
document.getElementById("stageStopBtn")?.addEventListener("click", () => {
  if (TEST_MODE) return;
  requestStopTracking();
});
document.getElementById("driverHome")?.addEventListener("click", (event) => {
  if (TEST_MODE || !tracking || !stopLikelyLocked()) return;
  event.preventDefault();
  requestStopTracking();
});
document.getElementById("stopLockForm")?.addEventListener("submit", (event) => {
  event.preventDefault();
  confirmStopCode();
});
document.getElementById("stopLockCancel")?.addEventListener("click", () => {
  closeStopLockDialog();
});

async function sendCrew(status) {
  acknowledgedStop = true;
  hideCrewAlert();
  setCrewStatusUi(status);
  renderMode();
  if (!session) return;
  try {
    if (TEST_MODE) {
      await fetch("/api/test/crew-status", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ status }),
      });
      return;
    }
    await fetch("/api/crew-status", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id: session.id, token: session.token, status }),
    });
  } catch {
    /* ignore */
  }
}

function crewHoldButtons() {
  return [
    { btn: document.getElementById("okBtn"), status: "ok" },
    { btn: document.getElementById("sosBtn"), status: "sos" },
    { btn: document.getElementById("alertOkBtn"), status: "ok" },
    { btn: document.getElementById("alertSosBtn"), status: "sos" },
  ];
}

function restoreHoldHint(btn, status, { change = false } = {}) {
  if (!btn) return;
  const hint = btn.querySelector(".hold-hint");
  if (!hint) return;
  const isAlert = btn.id === "alertOkBtn" || btn.id === "alertSosBtn";
  if (change) {
    hint.textContent = isAlert
      ? status === "ok"
        ? "Hold 3s to change to OK"
        : "Hold 3s to change to SOS"
      : "Hold 3s to change";
    return;
  }
  hint.textContent = isAlert
    ? status === "ok"
      ? "Both crew OK · Hold 3s"
      : "Need help · Hold 3s"
    : "Hold 3 seconds";
}

function cancelAnyHold() {
  if (!activeHold) return;
  const { button, timer, tick } = activeHold;
  clearTimeout(timer);
  clearInterval(tick);
  button.classList.remove("holding");
  const sent = button.classList.contains("is-sent");
  const status = button.id.toLowerCase().includes("sos") ? "sos" : "ok";
  if (sent) {
    const hint = button.querySelector(".hold-hint");
    if (hint) hint.textContent = "Sent to race control";
  } else {
    restoreHoldHint(button, status, { change: crewStatusSent && crewStatusSent !== status });
  }
  activeHold = null;
}

function resetCrewStatusUi() {
  cancelAnyHold();
  crewStatusSent = null;
  const banner = document.getElementById("crewStatusBanner");
  banner.classList.add("hidden");
  banner.classList.remove("ok", "sos");
  crewHoldButtons().forEach(({ btn, status }) => {
    btn.classList.remove("is-sent");
    btn.setAttribute("aria-pressed", "false");
    restoreHoldHint(btn, status);
  });
}

function setCrewStatusUi(status) {
  if (status !== "ok" && status !== "sos") {
    resetCrewStatusUi();
    return;
  }
  crewStatusSent = status;
  const isOk = status === "ok";
  const banner = document.getElementById("crewStatusBanner");
  banner.classList.remove("hidden");
  banner.classList.toggle("ok", isOk);
  banner.classList.toggle("sos", !isOk);
  document.getElementById("crewStatusRead").textContent = isOk ? "GREEN OK" : "RED SOS";
  document.getElementById("crewStatusHint").textContent = isOk
    ? "You confirmed OK. Hold SOS 3 seconds to change."
    : "You confirmed SOS. Hold OK 3 seconds to change.";
  crewHoldButtons().forEach(({ btn, status: s }) => {
    const sent = s === status;
    btn.classList.toggle("is-sent", sent);
    btn.setAttribute("aria-pressed", sent ? "true" : "false");
    if (sent) {
      const hint = btn.querySelector(".hold-hint");
      if (hint) hint.textContent = "Sent to race control";
    } else {
      restoreHoldHint(btn, s, { change: true });
    }
  });
}

function applyCrewStatusFromServer(data) {
  if (!Object.prototype.hasOwnProperty.call(data, "crewStatus")) return;
  const next = data.crewStatus?.status;
  if ((next === "ok" || next === "sos") && !crewStatusSent) {
    setCrewStatusUi(next);
  }
}

function bindCrewHold(button, status) {
  const hint = button.querySelector(".hold-hint");

  const complete = () => {
    if (!activeHold || activeHold.button !== button) return;
    clearTimeout(activeHold.timer);
    clearInterval(activeHold.tick);
    button.classList.remove("holding");
    activeHold = null;
    sendCrew(status);
  };

  const start = (event) => {
    if (event.pointerType === "mouse" && event.button !== 0) return;
    const isAlert = button.id === "alertOkBtn" || button.id === "alertSosBtn";
    if (!isAlert && (button.classList.contains("is-sent") || crewStatusSent === status)) return;
    event.preventDefault();
    cancelAnyHold();
    try {
      if (event.pointerId != null) button.setPointerCapture(event.pointerId);
    } catch {
      /* capture is optional */
    }
    button.classList.add("holding");
    const started = Date.now();
    if (hint) hint.textContent = "Keep holding 3s";
    const tick = setInterval(() => {
      const left = Math.max(0, CREW_HOLD_MS - (Date.now() - started));
      if (hint) hint.textContent = `Keep holding ${Math.max(1, Math.ceil(left / 1000))}s`;
    }, 120);
    activeHold = {
      button,
      timer: setTimeout(complete, CREW_HOLD_MS),
      tick,
    };
  };

  button.addEventListener("pointerdown", start);
  button.addEventListener("pointerup", cancelAnyHold);
  button.addEventListener("pointercancel", cancelAnyHold);
  button.addEventListener("lostpointercapture", cancelAnyHold);
  button.addEventListener("click", (event) => {
    event.preventDefault();
    event.stopPropagation();
  });
  button.addEventListener("contextmenu", (event) => event.preventDefault());
}

bindCrewHold(document.getElementById("okBtn"), "ok");
bindCrewHold(document.getElementById("sosBtn"), "sos");
bindCrewHold(document.getElementById("alertOkBtn"), "ok");
bindCrewHold(document.getElementById("alertSosBtn"), "sos");
document.getElementById("redFlagOkBtn").addEventListener("click", ackRedFlag);

async function ackRedFlag() {
  flagAcked = true;
  hideRedFlagAlert();
  renderMode();
  if (!session) return;
  try {
    if (TEST_MODE) {
      await fetch("/api/test/flag-ack", { method: "POST" });
      return;
    }
    await fetch("/api/flag-ack", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id: session.id, token: session.token }),
    });
  } catch {
    /* keep local ack so the crew can keep driving */
  }
}

function ensureFlagAudio() {
  if (flagAudio) return flagAudio;
  const audio = new Audio(FLAG_SOUND_SRC);
  audio.loop = true;
  audio.preload = "auto";
  audio.playsInline = true;
  audio.setAttribute("playsinline", "true");
  flagAudio = audio;
  return audio;
}

async function unlockFlagSound() {
  const audio = ensureFlagAudio();
  const wasWanted = flagSoundWanted;
  try {
    audio.muted = true;
    audio.volume = 0;
    await audio.play();
    if (!wasWanted) {
      audio.pause();
      audio.currentTime = 0;
    }
    audio.muted = false;
    audio.volume = 1;
  } catch {
    /* browsers need a later gesture */
  }
}

async function startFlagSound() {
  flagSoundWanted = true;
  bindFlagSoundRetry();
  const audio = ensureFlagAudio();
  audio.loop = true;
  audio.muted = false;
  audio.volume = 1;
  try {
    await audio.play();
  } catch {
    /* retry on the next tap / key */
  }
}

function stopFlagSound() {
  flagSoundWanted = false;
  if (!flagAudio) return;
  try {
    flagAudio.pause();
    flagAudio.currentTime = 0;
  } catch {
    /* ignore */
  }
}

function bindFlagSoundRetry() {
  if (flagSoundRetryBound) return;
  flagSoundRetryBound = true;
  const retry = () => {
    if (flagSoundWanted) startFlagSound();
  };
  document.addEventListener("pointerdown", retry, true);
  document.addEventListener("keydown", retry, true);
  document.addEventListener("touchstart", retry, { capture: true, passive: true });
}

function showTrack() {
  setupPanel?.classList.add("hidden");
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
  if (setupError && setupPanel && !setupPanel.classList.contains("hidden")) {
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

function applyTestState(data) {
  if (!TEST_MODE || !data) return;
  session = {
    id: "test-session",
    token: "test",
    carNumber: data.carNumber || "99",
    driverName: data.driverName || "TEST CREW",
  };
  tracking = true;
  const speed = Number(data.speed);
  const speedText = Number.isFinite(speed) ? `${Math.round(speed * 3.6)} km/h` : "—";
  const speedRead = document.getElementById("speedRead");
  const stageSpeed = document.getElementById("stageSpeed");
  const plateNumber = document.getElementById("plateNumber");
  const plateName = document.getElementById("plateName");
  if (speedRead) speedRead.textContent = speedText;
  if (stageSpeed) stageSpeed.textContent = `Speed ${speedText}`;
  if (plateNumber) plateNumber.textContent = `#${session.carNumber}`;
  if (plateName) plateName.textContent = session.driverName;
  applySectionAndFlag(data);
  const next = data.crewStatus?.status || null;
  if (next === "ok" || next === "sos") {
    if (crewStatusSent !== next) setCrewStatusUi(next);
  } else if (crewStatusSent) {
    resetCrewStatusUi();
  }
  if (data.forceStoppedAlert && inStage && !shouldShowRedFlag()) {
    if (crewAlert.classList.contains("hidden")) {
      acknowledgedStop = false;
      showCrewAlert();
    }
  } else if (!shouldShowRedFlag() && crewAlert.classList.contains("hidden")) {
    updateStopWatch(Number.isFinite(speed) ? speed : 0);
  }
  renderMode();
}

async function pollTestSession() {
  if (!TEST_MODE) return;
  try {
    const res = await fetch("/api/test/session");
    const data = await res.json().catch(() => ({}));
    if (!res.ok) return;
    applyTestState(data);
  } catch {
    /* keep last sandbox view */
  }
}

function shouldShowRedFlag() {
  return tracking && inStage && stageFlagStatus === "red" && !flagAcked;
}

function showRedFlagAlert() {
  closeStopLockDialog();
  cancelAnyHold();
  redFlagAlert.classList.remove("hidden");
  crewAlert.classList.add("hidden");
  trackPanel.classList.add("hidden");
  stagePanel.classList.add("hidden");
  setupPanel?.classList.add("hidden");
  startFlagSound();
  updateBgNote();
}

function hideRedFlagAlert() {
  redFlagAlert.classList.add("hidden");
  stopFlagSound();
}

function showCrewAlert() {
  if (shouldShowRedFlag()) return;
  closeStopLockDialog();
  cancelAnyHold();
  crewAlert.classList.remove("hidden");
  trackPanel.classList.add("hidden");
  stagePanel.classList.add("hidden");
  setupPanel?.classList.add("hidden");
  ["alertOkBtn", "alertSosBtn"].forEach((id) => {
    const btn = document.getElementById(id);
    btn.classList.remove("is-sent");
    restoreHoldHint(btn, id === "alertSosBtn" ? "sos" : "ok");
  });
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
  if (TEST_MODE) return;
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
  syncLockChrome();
  setTrackingWanted(true);
  toggleBtn.textContent = "Stop tracking";
  toggleBtn.className = "btn btn-stop";
  setLiveLamp();
  updateRoadSectionUi();
  updateBgNote();
  await requestWakeLock();
  ensureGeoWatch();
  startBackgroundKeepalive();
  await unlockFlagSound();
  bindFlagSoundRetry();
  await requestTrackingNotification();
  refreshStopLock();
  syncLockChrome();
  if (stopLikelyLocked()) armExitGuard();
  flushQueue();
}

function safetyAlertOpen() {
  return shouldShowRedFlag() || (crewAlert && !crewAlert.classList.contains("hidden"));
}

function noteStopLock(value) {
  if (value !== true && value !== false) return;
  stopLock = value;
  try {
    sessionStorage.setItem("rallyStopLock", value ? "1" : "0");
  } catch {
    /* private mode */
  }
  if (tracking && stopLikelyLocked()) armExitGuard();
  syncLockChrome();
}

async function refreshStopLock() {
  if (TEST_MODE) return;
  try {
    const res = await fetch("/api/stop-lock");
    const data = await res.json().catch(() => ({}));
    if (res.ok && typeof data.stopLock === "boolean") {
      noteStopLock(data.stopLock);
      return;
    }
  } catch {
    /* fall through */
  }
  // Could not confirm unlock — treat as unknown so Stop still prompts.
  if (stopLock === false) {
    stopLock = null;
    try {
      sessionStorage.removeItem("rallyStopLock");
    } catch {
      /* private mode */
    }
    syncLockChrome();
  }
}

function syncLockChrome() {
  const trackingOn = Boolean(!TEST_MODE && tracking);
  const locked = trackingOn && stopLikelyLocked();
  document.getElementById("driverHome")?.classList.toggle("hidden", locked);
  const note = document.getElementById("lockNote");
  if (note) note.classList.toggle("hidden", !(trackingOn && stopLock === true) || safetyAlertOpen());
}

function armExitGuard() {
  if (TEST_MODE || !tracking || !stopLikelyLocked() || exitGuardArmed) return;
  try {
    history.pushState({ rallyStopLock: 1 }, "", location.href);
    exitGuardArmed = true;
  } catch {
    /* ignore */
  }
}

function openStopLockDialog(message) {
  if (TEST_MODE || safetyAlertOpen()) return;
  const modal = document.getElementById("stopLockModal");
  if (!modal) return;
  const err = document.getElementById("stopLockError");
  if (err) {
    if (message) {
      err.textContent = message;
      err.classList.remove("hidden");
    } else {
      err.textContent = "";
      err.classList.add("hidden");
    }
  }
  modal.classList.remove("hidden");
  modal.hidden = false;
  const input = document.getElementById("stopLockCode");
  if (input) {
    input.value = "";
    input.focus();
  }
}

function closeStopLockDialog() {
  const modal = document.getElementById("stopLockModal");
  if (!modal) return;
  modal.classList.add("hidden");
  modal.hidden = true;
  const input = document.getElementById("stopLockCode");
  if (input) input.value = "";
}

function stopLikelyLocked() {
  // Fail closed: only skip the PIN UI when the server explicitly said unlocked.
  return stopLock !== false;
}

async function serverStop(code) {
  if (!session) return !stopLikelyLocked();
  stopBusy = true;
  const confirmBtn = document.getElementById("stopLockConfirm");
  if (confirmBtn) confirmBtn.disabled = true;
  try {
    const res = await fetch("/api/stop", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        id: session.id,
        token: session.token,
        ...(code ? { code } : {}),
      }),
    });
    const data = await res.json().catch(() => ({}));
    if (typeof data.stopLock === "boolean") noteStopLock(data.stopLock);
    if (res.status === 403 && data.needCode && !code) {
      noteStopLock(true);
      openStopLockDialog("");
      return false;
    }
    if (res.status === 403 || res.status === 429) {
      noteStopLock(true);
      openStopLockDialog(data.error || "Wrong code.");
      return false;
    }
    if (!res.ok) {
      // Never stop without a successful /api/stop. Prompt for PIN when lock may apply.
      if (stopLikelyLocked() || data.needCode || data.stopLock === true) {
        openStopLockDialog(data.error || "Could not check the code. Tracking stays on.");
      }
      return false;
    }
    return true;
  } catch {
    if (stopLikelyLocked()) {
      openStopLockDialog("No signal. Tracking stays on until the code can be checked.");
    }
    return false;
  } finally {
    stopBusy = false;
    if (confirmBtn) confirmBtn.disabled = false;
  }
}

async function requestStopTracking() {
  if (TEST_MODE || !tracking || stopBusy) return;
  if (safetyAlertOpen()) return;
  await refreshStopLock();
  // Prompt whenever lock is on or not yet known; unlock path still verifies with /api/stop.
  if (stopLikelyLocked()) {
    openStopLockDialog("");
    return;
  }
  const allowed = await serverStop(null);
  if (allowed) await applyLocalStop();
}

async function confirmStopCode() {
  if (TEST_MODE || stopBusy) return;
  const input = document.getElementById("stopLockCode");
  const code = String(input?.value || "").trim();
  const err = document.getElementById("stopLockError");
  if (!/^\d{4,6}$/.test(code)) {
    if (err) {
      err.textContent = "Enter the 4–6 digit organiser code.";
      err.classList.remove("hidden");
    }
    return;
  }
  const allowed = await serverStop(code);
  if (!allowed) {
    if (input) {
      input.value = "";
      input.focus();
    }
    return;
  }
  closeStopLockDialog();
  await applyLocalStop();
}

async function applyLocalStop() {
  if (TEST_MODE) return;
  tracking = false;
  inStage = false;
  sectionType = null;
  sectionLabel = null;
  bgFixesWhileHidden = 0;
  setTrackingWanted(false);
  hideCrewAlert();
  hideRedFlagAlert();
  resetCrewStatusUi();
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
  exitGuardArmed = false;
  closeStopLockDialog();
  syncLockChrome();
  updateBgNote();
  renderMode();
}

async function stopTracking() {
  await applyLocalStop();
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
  if (TEST_MODE || !tracking || !session) return;
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
    if (typeof data.stopLock === "boolean") noteStopLock(data.stopLock);
    if (data.section !== undefined || data.flagStatus || data.crewStatus !== undefined) {
      applySectionAndFlag(data);
      applyCrewStatusFromServer(data);
      renderMode();
    }
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

if (!TEST_MODE) setInterval(pollReconnect, 4000);

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
  if (typeof data.stopLock === "boolean") noteStopLock(data.stopLock);
  lastPingOkAt = Date.now();
  setLiveLamp();
  applySectionAndFlag(data);
  applyCrewStatusFromServer(data);
  if (!shouldShowRedFlag()) updateStopWatch(speed);
  renderMode();
}

function applySectionAndFlag(data) {
  const wasInStage = inStage;
  const prevStageId = stageId;
  if (Object.prototype.hasOwnProperty.call(data, "section")) {
    sectionType = data.section?.type || null;
    sectionLabel = data.section?.label || data.section?.name || null;
    inStage = sectionType === "stage";
    stageName = sectionLabel;
    stageId = data.section?.id || null;
  }
  applyFlagFromServer(data);
  if (!wasInStage && inStage) {
    stoppedSinceMs = null;
    acknowledgedStop = false;
    hideCrewAlert();
    resetCrewStatusUi();
  }
  if (wasInStage && !inStage) {
    stoppedSinceMs = null;
    acknowledgedStop = false;
    hideCrewAlert();
    hideRedFlagAlert();
    stageFlagStatus = "green";
    flagAcked = true;
    resetCrewStatusUi();
  }
  if (wasInStage && inStage && stageId && prevStageId && stageId !== prevStageId) {
    stoppedSinceMs = null;
    acknowledgedStop = false;
    hideCrewAlert();
    resetCrewStatusUi();
  }
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
  if (TEST_MODE || !session) return { ok: false };
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
  syncLockChrome();
  const el = document.getElementById("bgTrackNote");
  if (!el) return;
  const alertsUp =
    !crewAlert.classList.contains("hidden") || !redFlagAlert.classList.contains("hidden");
  if (TEST_MODE || !tracking || !session || alertsUp || !setupPanel?.classList.contains("hidden")) {
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

function applyFlagFromServer(data, { ackSource = "server" } = {}) {
  const nextFlag =
    data.flagStatus === "red" || data.flagStatus === "green"
      ? data.flagStatus
      : data.section?.flagStatus === "red"
        ? "red"
        : "green";
  const nextTs = Number(
    data.flagTs != null && data.flagTs !== ""
      ? data.flagTs
      : data.section?.flagTs || 0
  );
  if (nextFlag === "green") {
    stageFlagStatus = "green";
    stageFlagTs = nextTs;
    flagAcked = true;
    hideRedFlagAlert();
    return;
  }
  const isNewEvent = nextTs !== stageFlagTs || stageFlagStatus !== "red";
  stageFlagStatus = "red";
  stageFlagTs = nextTs;
  if (ackSource === "sections") {
    if (isNewEvent) flagAcked = false;
    return;
  }
  if (isNewEvent) {
    flagAcked = data.flagAcked === true;
    return;
  }
  if (data.flagAcked === true) flagAcked = true;
}

async function pollStageFlag() {
  if (TEST_MODE || !tracking || !inStage || !stageId || !session) return;
  try {
    const res = await fetch("/api/poll", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id: session.id, token: session.token }),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) return;
    if (typeof data.stopLock === "boolean") noteStopLock(data.stopLock);
    applyFlagFromServer(data);
    renderMode();
  } catch {
    /* keep last known flag */
  }
}

if (!TEST_MODE) setInterval(pollStageFlag, 2000);

if (TEST_MODE) {
  session = { id: "test-session", token: "test", carNumber: "99", driverName: "TEST CREW" };
  tracking = true;
  sectionType = "road";
  sectionLabel = "Liaison Test";
  showTrack();
  setLamp("lamp-live", "TEST MODE", "NOT LIVE. HQ sandbox — no GPS, no rally cars.");
  pollTestSession();
  setInterval(pollTestSession, 500);
  try {
    const bus = new BroadcastChannel("rally-gps-test");
    bus.addEventListener("message", () => pollTestSession());
  } catch {
    /* BroadcastChannel optional */
  }
  window.addEventListener("message", (event) => {
    if (event.origin !== location.origin) return;
    if (event.data?.type === "rally-test-unlock") unlockFlagSound();
  });
  const unlock = () => unlockFlagSound();
  document.addEventListener("pointerdown", unlock, { once: true });
  document.addEventListener("keydown", unlock, { once: true });
} else {
  window.addEventListener("beforeunload", (event) => {
    if (!tracking || !stopLikelyLocked()) return;
    event.preventDefault();
    event.returnValue = "";
  });
  window.addEventListener("popstate", () => {
    if (!tracking || !stopLikelyLocked()) {
      exitGuardArmed = false;
      return;
    }
    exitGuardArmed = false;
    armExitGuard();
    if (!safetyAlertOpen()) openStopLockDialog("");
  });
  document.addEventListener("visibilitychange", async () => {
    if (!tracking && trackingWanted() && session) {
      await startTracking();
      return;
    }
    if (!tracking) return;
    if (document.visibilityState === "visible") {
      await resumeForegroundTracking();
      return;
    }
    cancelAnyHold();
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
}

window.addEventListener("pointerup", cancelAnyHold);
window.addEventListener("pointercancel", cancelAnyHold);
window.addEventListener("blur", cancelAnyHold);
