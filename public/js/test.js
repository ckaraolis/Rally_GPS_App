const frame = document.getElementById("testDriverFrame");
const nameForm = document.getElementById("nameForm");
const previewCarSelect = document.getElementById("previewCarSelect");
const redFlagModal = document.getElementById("redFlagModal");
const redFlagCarList = document.getElementById("redFlagCarList");
const redFlagModalStage = document.getElementById("redFlagModalStage");
const redFlagModalError = document.getElementById("redFlagModalError");

let latestSession = null;
let pendingFlagCandidates = [];
let testBus = null;
try {
  testBus = new BroadcastChannel("rally-gps-test");
} catch {
  testBus = null;
}

function escapeHtml(value) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
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
    location.replace("/control-login.html?next=/test");
    return false;
  }
  const data = await res.json().catch(() => ({}));
  return Boolean(data.ok);
}

function fillPreviewSelect(data) {
  if (!previewCarSelect || !Array.isArray(data.cars)) return;
  const current = data.previewCarId;
  const html = data.cars
    .map((car) => {
      const label = `#${car.carNumber} ${car.driverName}`;
      const selected = car.id === current ? " selected" : "";
      return `<option value="${escapeHtml(car.id)}"${selected}>${escapeHtml(label)}</option>`;
    })
    .join("");
  if (previewCarSelect.innerHTML !== html && document.activeElement !== previewCarSelect) {
    previewCarSelect.innerHTML = html;
    previewCarSelect.value = current;
  }
}

function targetSummary(data) {
  if (data.stageFlagStatus !== "red" && data.section?.flagStatus !== "red") return "—";
  const targets = Array.isArray(data.flagTargets) ? data.flagTargets : [];
  if (!targets.length) return "none";
  const cars = Array.isArray(data.cars) ? data.cars : [];
  const labels = targets.map((id) => {
    const car = cars.find((c) => c.id === id);
    return car ? `#${car.carNumber}` : id;
  });
  return labels.join(", ");
}

async function refreshStatus() {
  const res = await fetch("/api/test/session");
  const data = await res.json().catch(() => ({}));
  if (!res.ok) return;
  latestSession = data;
  const onStage = data.section?.type === "stage";
  const stageRed = data.stageFlagStatus === "red" || data.section?.flagStatus === "red";
  setText("stMode", onStage ? "STAGE" : "ROAD");
  setText("stFlag", stageRed ? "RED FLAG" : "GREEN FLAG");
  setText("stTargets", targetSummary(data));
  setText(
    "stPreview",
    `#${data.carNumber || "—"} · ${data.flagTargeted ? "FLASHING" : stageRed ? "not targeted" : "idle"}`
  );
  const crew = data.crewStatus?.status;
  setText("stCrew", crew === "sos" ? "RED SOS" : crew === "ok" ? "GREEN OK" : "—");
  setText(
    "stAck",
    data.flagTargeted ? (data.flagAcked ? "ACKED" : "WAITING") : stageRed ? "n/a (not targeted)" : "n/a"
  );
  setText("stMotion", data.motion === "stopped" ? "STOPPED" : "MOVING");
  fillPreviewSelect(data);
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
      (patch.flagStatus === "green" && !stageRed) ||
      (patch.motion && patch.motion === data.motion);
    btn.classList.toggle("active", Boolean(active));
  }
  const redBtn = document.getElementById("redFlagBtn");
  redBtn?.classList.toggle("active", Boolean(stageRed));
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
    return null;
  }
  try {
    testBus?.postMessage({ type: "test-updated" });
  } catch {
    /* ignore */
  }
  await refreshStatus();
  return data;
}

function setFlagModalError(message) {
  if (!redFlagModalError) return;
  if (!message) {
    redFlagModalError.hidden = true;
    redFlagModalError.textContent = "";
    return;
  }
  redFlagModalError.hidden = false;
  redFlagModalError.textContent = message;
}

function buildFlagCandidates(data) {
  const cars = Array.isArray(data?.cars) ? data.cars : [];
  const existing = new Set(
    Array.isArray(data?.flagTargets) ? data.flagTargets.map(String) : []
  );
  const stageAlreadyRed =
    data?.stageFlagStatus === "red" || data?.section?.flagStatus === "red";
  return cars.map((car) => ({
    id: car.id,
    carNumber: car.carNumber,
    driverName: car.driverName,
    crewStatus: car.crewStatus || null,
    progressPct: Number(car.progressPct) || 0,
    aheadOfSos: Boolean(car.aheadOfSos),
    selected: stageAlreadyRed && existing.size ? existing.has(String(car.id)) : !car.aheadOfSos,
  }));
}

function renderFlagCandidateList() {
  if (!redFlagCarList) return;
  if (!pendingFlagCandidates.length) {
    redFlagCarList.innerHTML = `<li class="empty">No sandbox cars available.</li>`;
    return;
  }
  redFlagCarList.innerHTML = pendingFlagCandidates
    .map((row) => {
      const crew =
        row.crewStatus === "sos" ? " · RED SOS" : row.crewStatus === "ok" ? " · GREEN OK" : "";
      const ahead = row.aheadOfSos ? " · ahead of SOS" : "";
      return `<li class="flag-target-row">
        <input type="checkbox" id="flagCar_${escapeHtml(row.id)}" data-car-id="${escapeHtml(
          row.id
        )}" ${row.selected ? "checked" : ""} />
        <label for="flagCar_${escapeHtml(row.id)}">
          <strong>#${escapeHtml(row.carNumber)} ${escapeHtml(row.driverName)}</strong>
          <small>On stage · ~${Math.round(row.progressPct)}%${crew}${ahead}</small>
        </label>
      </li>`;
    })
    .join("");

  for (const input of redFlagCarList.querySelectorAll("input[data-car-id]")) {
    input.addEventListener("change", () => {
      const id = input.getAttribute("data-car-id");
      const row = pendingFlagCandidates.find((c) => c.id === id);
      if (row) row.selected = input.checked;
      setFlagModalError("");
    });
  }
}

function openRedFlagPicker() {
  const data = latestSession || { cars: [] };
  pendingFlagCandidates = buildFlagCandidates(data);
  if (redFlagModalStage) {
    const name = data.section?.type === "stage" ? data.section.name : data.stageName || "SS Test";
    redFlagModalStage.textContent = `${name || "Stage"} · choose which cars see RED FLAG`;
  }
  setFlagModalError("");
  renderFlagCandidateList();
  if (redFlagModal) {
    redFlagModal.hidden = false;
    redFlagModal.classList.remove("hidden");
  }
}

function closeRedFlagPicker() {
  pendingFlagCandidates = [];
  if (redFlagModal) {
    redFlagModal.hidden = true;
    redFlagModal.classList.add("hidden");
  }
  setFlagModalError("");
}

async function confirmRedFlag() {
  const targets = pendingFlagCandidates.filter((c) => c.selected).map((c) => c.id);
  if (!targets.length) {
    setFlagModalError("Select at least one car, or cancel.");
    return;
  }
  const data = await sendPatch({ flagStatus: "red", flagTargets: targets });
  if (!data) {
    setFlagModalError("Could not set red flag.");
    return;
  }
  closeRedFlagPicker();
}

document.addEventListener("click", async (event) => {
  const btn = event.target.closest("[data-patch]");
  if (!btn) return;
  event.preventDefault();
  const patch = JSON.parse(btn.getAttribute("data-patch"));
  await sendPatch(patch);
});

document.getElementById("redFlagBtn")?.addEventListener("click", (event) => {
  event.preventDefault();
  openRedFlagPicker();
});

document.getElementById("redFlagCancel")?.addEventListener("click", closeRedFlagPicker);
document.getElementById("redFlagConfirm")?.addEventListener("click", () => {
  confirmRedFlag().catch(() => setFlagModalError("Could not set red flag."));
});
document.getElementById("flagSelectAll")?.addEventListener("click", () => {
  pendingFlagCandidates.forEach((c) => {
    c.selected = true;
  });
  renderFlagCandidateList();
  setFlagModalError("");
});
document.getElementById("flagSelectNone")?.addEventListener("click", () => {
  pendingFlagCandidates.forEach((c) => {
    c.selected = false;
  });
  renderFlagCandidateList();
});
document.getElementById("flagSelectBehindSos")?.addEventListener("click", () => {
  pendingFlagCandidates.forEach((c) => {
    c.selected = !c.aheadOfSos;
  });
  renderFlagCandidateList();
  setFlagModalError("");
});
redFlagModal?.addEventListener("click", (event) => {
  if (event.target === redFlagModal) closeRedFlagPicker();
});

previewCarSelect?.addEventListener("change", async () => {
  const id = previewCarSelect.value;
  if (!id) return;
  await sendPatch({ previewCarId: id }, { unlock: false });
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
