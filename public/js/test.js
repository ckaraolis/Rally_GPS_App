const frame = document.getElementById("testDriverFrame");
const nameForm = document.getElementById("nameForm");
let testBus = null;
try {
  testBus = new BroadcastChannel("rally-gps-test");
} catch {
  testBus = null;
}

function setText(id, value) {
  const el = document.getElementById(id);
  if (el) el.textContent = value;
}

function pingPreview(type) {
  try {
    frame?.contentWindow?.postMessage({ type }, location.origin);
  } catch {
    /* iframe may not be ready */
  }
}

async function ensureTestAuth() {
  const res = await fetch("/api/me");
  if (res.status === 401) {
    location.replace("/control-login.html?next=/test.html");
    return false;
  }
  const data = await res.json().catch(() => ({}));
  return Boolean(data.ok);
}

async function refreshStatus() {
  const res = await fetch("/api/test/session");
  const data = await res.json().catch(() => ({}));
  if (!res.ok) return;
  const onStage = data.section?.type === "stage";
  setText("stMode", onStage ? "STAGE" : "ROAD");
  setText("stFlag", data.flagStatus === "red" ? "RED FLAG" : "GREEN FLAG");
  const crew = data.crewStatus?.status;
  setText("stCrew", crew === "sos" ? "RED SOS" : crew === "ok" ? "GREEN OK" : "—");
  setText(
    "stAck",
    data.flagStatus === "red" ? (data.flagAcked ? "ACKED" : "WAITING") : "n/a"
  );
  setText("stMotion", data.motion === "stopped" ? "STOPPED" : "MOVING");
  const stageInput = document.getElementById("stageNameInput");
  const roadInput = document.getElementById("roadNameInput");
  if (stageInput && document.activeElement !== stageInput) {
    stageInput.value = data.section?.type === "stage" ? data.section.name : stageInput.value;
    if (data.section?.type === "stage" && data.section.name) stageInput.value = data.section.name;
  }
  if (roadInput && document.activeElement !== roadInput && data.section?.type === "road" && data.section.name) {
    roadInput.value = data.section.name;
  }
  for (const btn of document.querySelectorAll("[data-patch]")) {
    const patch = JSON.parse(btn.getAttribute("data-patch"));
    const active =
      (patch.mode && ((patch.mode === "stage" && onStage) || (patch.mode === "road" && !onStage))) ||
      (patch.flagStatus && patch.flagStatus === data.flagStatus) ||
      (patch.motion && patch.motion === data.motion);
    btn.classList.toggle("active", Boolean(active));
  }
}

async function sendPatch(patch, { unlock = true } = {}) {
  if (unlock) pingPreview("rally-test-unlock");
  if (patch.flagStatus === "red") pingPreview("rally-test-unlock");
  const res = await fetch("/api/test/session", {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(patch),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    alert(data.error || "Could not update test sandbox.");
    return;
  }
  try {
    testBus?.postMessage({ type: "test-updated" });
  } catch {
    /* ignore */
  }
  await refreshStatus();
}

document.addEventListener("click", async (event) => {
  const btn = event.target.closest("[data-patch]");
  if (!btn) return;
  event.preventDefault();
  const patch = JSON.parse(btn.getAttribute("data-patch"));
  await sendPatch(patch);
});

nameForm?.addEventListener("submit", async (event) => {
  event.preventDefault();
  await sendPatch({
    stageName: document.getElementById("stageNameInput").value,
    roadName: document.getElementById("roadNameInput").value,
  });
});

ensureTestAuth().then(async (ok) => {
  if (!ok) return;
  await refreshStatus();
  setInterval(refreshStatus, 800);
});
