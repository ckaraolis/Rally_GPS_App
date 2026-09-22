const map = L.map("map", { zoomControl: true }).setView([38.5, 23.5], 6);
L.tileLayer("https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}", {
  attribution: "Tiles &copy; Esri",
  maxZoom: 19,
}).addTo(map);

const markers = new Map();
const routeLayers = new Map();
const trailLayers = new Map();
const visibleTrails = new Set();
let fittedOnce = false;
let fittedRouteOnce = false;
let latestCars = [];
let liveRally = null;
let ralliesReady = true;
let viewingRallyId = null;
let historyCars = [];
let earthToken = "";
let selectedRallyId = sessionStorage.getItem("rallyRouteId") || null;
let rallyCache = [];
let lastRouteRallyId = null;

const STOPPED_SPEED_MPS = 1.2;
const MOTION_COLORS = {
  sos: "#ff1a1a",
  moving: "#22c55e",
  stopped: "#3d7dff",
};

function carMotion(car) {
  if (car.motion === "sos" || car.motion === "moving" || car.motion === "stopped") return car.motion;
  if (car.crewStatus?.status === "sos") return "sos";
  const speed = Number(car.last?.speed);
  if (Number.isFinite(speed) && speed > STOPPED_SPEED_MPS) return "moving";
  return "stopped";
}

function markerColor(car) {
  return MOTION_COLORS[carMotion(car)] || MOTION_COLORS.stopped;
}

const copyBtn = document.getElementById("copyLink");
const routeFile = document.getElementById("routeFile");
const clearRoutes = document.getElementById("clearRoutes");
const routeStatus = document.getElementById("routeStatus");
const sectionList = document.getElementById("sectionList");
const refreshLostBtn = document.getElementById("refreshLostBtn");
const clearCarsBtn = document.getElementById("clearCarsBtn");
const rallyForm = document.getElementById("rallyForm");
const rallyStatus = document.getElementById("rallyStatus");
const mapModeHint = document.getElementById("mapModeHint");
const routeTarget = document.getElementById("routeTarget");
const pinIconPack = document.getElementById("pinIconPack");
const PIN_ICON_SLOTS = [
  { kind: "tc", label: "TC" },
  { kind: "start", label: "Start" },
  { kind: "finish", label: "Finish" },
  { kind: "stop", label: "Stop" },
  { kind: "refuel", label: "Refueling" },
];
const PIN_IMAGE_VER = "gepins2";
const DEFAULT_PIN_IMAGES = {
  tc: `/icons/pins/red-circle.svg?v=${PIN_IMAGE_VER}`,
  start: `/icons/pins/flag.svg?v=${PIN_IMAGE_VER}`,
  finish: `/icons/pins/flag.svg?v=${PIN_IMAGE_VER}`,
  stop: `/icons/pins/flag.svg?v=${PIN_IMAGE_VER}`,
  flag: `/icons/pins/flag.svg?v=${PIN_IMAGE_VER}`,
  refuel: `/icons/pins/gas.svg?v=${PIN_IMAGE_VER}`,
  pin: `/icons/pins/yellow-pin.svg?v=${PIN_IMAGE_VER}`,
};
let pinIcons = {};
let pinIconsRallyId = null;
const ROUTE_TAB_KEY = "rallyRouteTab";
const ROUTE_TABS = ["all", "stage", "road", "pins"];
const ROUTE_TAB_EMPTY = {
  all: "No route uploaded for this rally yet",
  stage: "No stages on this rally",
  road: "No road sections on this rally",
  pins: "No time controls on this rally",
};
let selectedRouteTab = sessionStorage.getItem(ROUTE_TAB_KEY) || "all";
if (!ROUTE_TABS.includes(selectedRouteTab)) selectedRouteTab = "all";
let allSections = [];
const routeTabs = document.querySelector(".route-tabs");

function persistSelectedRally(id) {
  selectedRallyId = id || null;
  if (selectedRallyId) sessionStorage.setItem("rallyRouteId", selectedRallyId);
  else sessionStorage.removeItem("rallyRouteId");
}

function routeRallyId() {
  if (viewingRallyId) return viewingRallyId;
  if (selectedRallyId && rallyCache.some((rally) => rally.id === selectedRallyId)) return selectedRallyId;
  if (liveRally?.id) return liveRally.id;
  return rallyCache[0]?.id || null;
}

function routeRally() {
  const id = routeRallyId();
  return rallyCache.find((rally) => rally.id === id) || (liveRally?.id === id ? liveRally : null);
}

function updateRouteTarget() {
  const rally = routeRally();
  const fileBtn = routeFile?.closest(".file-btn");
  if (!rally) {
    if (routeTarget) routeTarget.textContent = "Create a rally first. The KMZ will belong only to that event.";
    if (routeFile) routeFile.disabled = true;
    if (clearRoutes) clearRoutes.disabled = true;
    fileBtn?.classList.add("disabled");
    pinIcons = {};
    pinIconsRallyId = null;
    renderPinIconSlots();
    return;
  }
  if (routeFile) routeFile.disabled = false;
  if (clearRoutes) clearRoutes.disabled = false;
  fileBtn?.classList.remove("disabled");
  if (routeTarget) {
    routeTarget.textContent = `KMZ for ${rally.name} (${String(rally.status || "draft").toUpperCase()}). Other rallies keep their own routes.`;
  }
  renderPinIconSlots();
}

copyBtn.addEventListener("click", async () => {
  const url = `${location.origin}/earth.kml${earthToken ? `?t=${encodeURIComponent(earthToken)}` : ""}`;
  try {
    await navigator.clipboard.writeText(url);
    copyBtn.textContent = "Copied";
    setTimeout(() => {
      copyBtn.textContent = "Copy live KML URL";
    }, 1600);
  } catch {
    prompt("Copy this URL into Google Earth as a network link:", url);
  }
});

routeFile.addEventListener("change", async () => {
  const file = routeFile.files?.[0];
  if (!file) return;
  const rallyId = routeRallyId();
  if (!rallyId) {
    routeStatus.textContent = "Create or select a rally first, then upload its KMZ.";
    routeFile.value = "";
    return;
  }
  routeStatus.textContent = `Uploading ${file.name} to this rally…`;
  try {
    const contentBase64 = await fileToBase64(file);
    const res = await fetch("/api/sections/upload", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        filename: file.name,
        contentBase64,
        replace: true,
        rallyId,
      }),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || "Upload failed");
    routeStatus.textContent = `Loaded ${data.count} items for this rally (${data.stages} stages, ${data.roads} road, ${data.markers || 0} pins).`;
    await refreshSections();
  } catch (err) {
    routeStatus.textContent = err.message || "Upload failed";
  } finally {
    routeFile.value = "";
  }
});

clearRoutes.addEventListener("click", async () => {
  const rally = routeRally();
  if (!rally) {
    routeStatus.textContent = "Create or select a rally first.";
    return;
  }
  if (!confirm(`Clear the KMZ for ${rally.name}? Other rallies keep their routes.`)) return;
  const res = await fetch(`/api/sections?rallyId=${encodeURIComponent(rally.id)}`, { method: "DELETE" });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    routeStatus.textContent = data.error || "Could not clear route";
    return;
  }
  routeStatus.textContent = `Route cleared for ${rally.name}.`;
  await refreshSections();
});

clearCarsBtn.addEventListener("click", async () => {
  if (!confirm("Clear all rally cars from the live list? This cannot be undone.")) return;
  clearCarsBtn.disabled = true;
  try {
    const res = await fetch("/api/cars", { method: "DELETE" });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || "Could not clear cars");
    for (const id of [...markers.keys()]) {
      map.removeLayer(markers.get(id));
      markers.delete(id);
    }
    for (const id of [...visibleTrails]) hideCarTrail(id);
    await refresh();
  } catch (err) {
    alert(err.message || "Could not clear cars");
  }
  clearCarsBtn.disabled = false;
});

rallyForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  const name = document.getElementById("rallyName").value.trim();
  const startDate = document.getElementById("rallyStart").value;
  const endDate = document.getElementById("rallyEnd").value;
  const startLive = document.getElementById("rallyStartLive").checked;
  rallyStatus.textContent = "Saving…";
  try {
    const res = await fetch("/api/rallies", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        name,
        startDate,
        endDate,
        status: startLive ? "live" : "draft",
      }),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || "Could not create rally");
    persistSelectedRally(data.rally?.id || null);
    rallyForm.reset();
    rallyStatus.textContent = startLive ? "Rally is LIVE. Cars will show on the map." : "Rally saved. Upload the KMZ for this event.";
    viewingRallyId = null;
    historyCars = [];
    await refreshRallies();
    await refresh();
    await refreshSections();
  } catch (err) {
    rallyStatus.textContent = err.message || "Could not create rally";
  }
});

async function setRallyStatus(id, status) {
  const res = await fetch(`/api/rallies/${encodeURIComponent(id)}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ status }),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || "Could not update rally");
  return data.rally;
}

async function viewRallyHistory(id) {
  const res = await fetch(`/api/rallies/${encodeURIComponent(id)}`);
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || "Could not load rally");
  viewingRallyId = id;
  persistSelectedRally(id);
  historyCars = Array.isArray(data.rally?.snapshot) ? data.rally.snapshot : [];
  mapModeHint.textContent = `History: ${data.rally?.name || "rally"} — map shows saved cars from this event.`;
  renderList(historyCars, { history: true });
  renderMap(historyCars);
  await refreshSections();
}

async function refreshRallies() {
  try {
    const res = await fetch("/api/rallies");
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || "Could not load rallies");
    ralliesReady = true;
    rallyCache = data.rallies || [];
    if (selectedRallyId && !rallyCache.some((rally) => rally.id === selectedRallyId)) {
      persistSelectedRally(data.liveRally?.id || rallyCache[0]?.id || null);
    }
    renderRallyList(rallyCache, data.liveRally || null);
    updateRouteTarget();
  } catch (err) {
    ralliesReady = false;
    document.getElementById("rallyList").innerHTML =
      `<li class="empty">${escapeHtml(err.message || "Rallies table missing. Run supabase/schema_rallies.sql in Supabase.")}</li>`;
    rallyCache = [];
    updateRouteTarget();
  }
}

function rallyDates(rally) {
  if (rally.startDate && rally.endDate) return `${rally.startDate} → ${rally.endDate}`;
  if (rally.startDate) return `From ${rally.startDate}`;
  if (rally.endDate) return `Until ${rally.endDate}`;
  return "No dates";
}

function renderRallyList(rallies, live) {
  const list = document.getElementById("rallyList");
  if (!rallies.length) {
    list.innerHTML = '<li class="empty">No rallies yet</li>';
    updateRouteTarget();
    return;
  }
  const activeId = routeRallyId();
  list.innerHTML = rallies
    .map((rally) => {
      const viewing = viewingRallyId === rally.id;
      const selected = activeId === rally.id;
      const badge = viewing && rally.status !== "live" ? "history" : rally.status;
      const badgeLabel = viewing && rally.status !== "live" ? "VIEWING" : rally.status.toUpperCase();
      const kmzBadge = selected ? ` <span class="rally-badge route">KMZ</span>` : "";
      const actions =
        rally.status === "live"
          ? `<button type="button" class="mini-toggle" data-rally-status="ended" data-id="${rally.id}">End live</button>`
          : rally.status === "draft"
            ? `<button type="button" class="mini-toggle" data-rally-status="live" data-id="${rally.id}">Go live</button>
               <button type="button" class="mini-toggle" data-rally-delete="${rally.id}">Delete</button>`
            : `<button type="button" class="mini-toggle${viewing ? " active" : ""}" data-rally-view="${rally.id}">${
                viewing ? "Showing history" : "View history"
              }</button>
               <button type="button" class="mini-toggle" data-rally-status="live" data-id="${rally.id}">Go live again</button>
               <button type="button" class="mini-toggle" data-rally-delete="${rally.id}">Delete</button>`;
      const backLive =
        viewing && live
          ? `<button type="button" class="mini-toggle" data-rally-back="1">Back to live</button>`
          : viewing
            ? `<button type="button" class="mini-toggle" data-rally-back="1">Close history</button>`
            : "";
      return `<li class="car-row${selected ? " selected-rally" : ""}" data-rally="${rally.id}">
        <span class="dot" style="background:${rally.status === "live" ? "#22c55e" : rally.status === "ended" ? "#3d7dff" : "#9a917f"}"></span>
        <div>
          <strong>${escapeHtml(rally.name)} <span class="rally-badge ${badge}">${badgeLabel}</span>${kmzBadge}</strong>
          <small>${escapeHtml(rallyDates(rally))}${rally.carCount ? ` · ${rally.carCount} cars saved` : ""}</small>
          <div class="car-actions">${actions}${backLive}</div>
        </div>
      </li>`;
    })
    .join("");

  for (const row of list.querySelectorAll("li[data-rally]")) {
    row.addEventListener("click", async () => {
      const id = row.getAttribute("data-rally");
      persistSelectedRally(id);
      if (viewingRallyId && viewingRallyId !== id) {
        viewingRallyId = null;
        historyCars = [];
        await refresh();
      }
      renderRallyList(rallies, live);
      await refreshSections();
    });
  }

  for (const btn of list.querySelectorAll("button[data-rally-status]")) {
    btn.addEventListener("click", async (event) => {
      event.stopPropagation();
      const id = btn.getAttribute("data-id");
      const nextStatus = btn.getAttribute("data-rally-status");
      const target = rallies.find((rally) => rally.id === id);
      if (nextStatus === "live" && live && live.id !== id) {
        if (
          !confirm(
            `${live.name} is LIVE. Ending it will save history, then ${target?.name || "this rally"} goes live. Continue?`
          )
        ) {
          return;
        }
      }
      try {
        await setRallyStatus(id, nextStatus);
        viewingRallyId = null;
        historyCars = [];
        persistSelectedRally(id);
        rallyStatus.textContent =
          nextStatus === "live"
            ? `${target?.name || "Rally"} is LIVE.`
            : nextStatus === "ended"
              ? `${target?.name || "Rally"} ended and was saved to history.`
              : "";
        await refreshRallies();
        await refresh();
        await refreshSections();
      } catch (err) {
        rallyStatus.textContent = err.message;
      }
    });
  }
  for (const btn of list.querySelectorAll("button[data-rally-view]")) {
    btn.addEventListener("click", async (event) => {
      event.stopPropagation();
      try {
        await viewRallyHistory(btn.getAttribute("data-rally-view"));
        await refreshRallies();
      } catch (err) {
        rallyStatus.textContent = err.message;
      }
    });
  }
  for (const btn of list.querySelectorAll("button[data-rally-back]")) {
    btn.addEventListener("click", async (event) => {
      event.stopPropagation();
      viewingRallyId = null;
      historyCars = [];
      await refreshRallies();
      await refresh();
      await refreshSections();
    });
  }
  for (const btn of list.querySelectorAll("button[data-rally-delete]")) {
    btn.addEventListener("click", async (event) => {
      event.stopPropagation();
      if (!confirm("Delete this rally from history?")) return;
      const deletedId = btn.getAttribute("data-rally-delete");
      await fetch(`/api/rallies/${encodeURIComponent(deletedId)}`, {
        method: "DELETE",
      });
      if (viewingRallyId === deletedId) {
        viewingRallyId = null;
        historyCars = [];
      }
      if (selectedRallyId === deletedId) persistSelectedRally(null);
      await refreshRallies();
      await refresh();
      await refreshSections();
    });
  }
}

refreshLostBtn.addEventListener("click", async () => {
  refreshLostBtn.disabled = true;
  refreshLostBtn.textContent = "Refreshing…";
  try {
    const res = await fetch("/api/refresh-lost", { method: "POST" });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || "Refresh failed");
    refreshLostBtn.textContent = data.count
      ? `Asked ${data.count} lost car${data.count === 1 ? "" : "s"} to reconnect`
      : "No lost cars";
    await refresh();
  } catch (err) {
    refreshLostBtn.textContent = err.message || "Refresh failed";
  }
  setTimeout(() => {
    refreshLostBtn.disabled = false;
    refreshLostBtn.textContent = "Refresh lost cars";
  }, 2500);
});

function fileToBase64(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const result = String(reader.result || "");
      const base64 = result.includes(",") ? result.split(",")[1] : result;
      resolve(base64);
    };
    reader.onerror = () => reject(new Error("Could not read file"));
    reader.readAsDataURL(file);
  });
}

async function refresh() {
  const res = await fetch("/api/cars");
  const data = await res.json();
  latestCars = data.cars || [];
  liveRally = data.liveRally || null;
  if (data.ralliesReady === false) ralliesReady = false;
  else if (data.ralliesReady === true) ralliesReady = true;

  if (viewingRallyId) {
    renderList(historyCars, { history: true });
    renderMap(historyCars);
    return;
  }

  const showOnMap = data.mapOpen !== false;
  if (liveRally) {
    mapModeHint.textContent = `LIVE: ${liveRally.name} — cars are on the map.`;
  } else if (!ralliesReady) {
    mapModeHint.textContent = "Rallies table not ready. Cars still show on the map. Run supabase/schema_rallies.sql.";
  } else if (showOnMap) {
    mapModeHint.textContent = "Create a rally and tap Go live to start an official live session.";
  } else {
    mapModeHint.textContent = "No LIVE rally. Cars stay in the list but are hidden on the map until you go live.";
  }
  renderList(latestCars);
  renderMap(showOnMap ? latestCars : []);
  if (showOnMap) await refreshVisibleTrails();
}

async function refreshSections() {
  const rallyId = routeRallyId();
  updateRouteTarget();
  if (!rallyId) {
    renderSections([]);
    renderRouteLayers([]);
    return;
  }
  if (lastRouteRallyId !== rallyId) {
    lastRouteRallyId = rallyId;
    fittedRouteOnce = false;
  }
  const res = await fetch(`/api/sections?rallyId=${encodeURIComponent(rallyId)}`);
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    renderSections([]);
    renderRouteLayers([]);
    if (routeStatus && !routeStatus.textContent) {
      routeStatus.textContent = data.error || "Could not load this rally’s route.";
    }
    return;
  }
  const sameRally = pinIconsRallyId === rallyId;
  pinIcons = data.pinIcons || {};
  pinIconsRallyId = rallyId;
  if (!sameRally) renderPinIconSlots();
  renderSections(data.sections || []);
  renderRouteLayers(data.sections || []);
}

function popupHtml(car) {
  const speed =
    car.last?.speed == null ? "—" : `${Math.round(car.last.speed * 3.6)} km/h`;
  const section = car.section?.label ? `<div>${escapeHtml(car.section.label)}</div>` : "";
  const crew = car.crewStatus?.status;
  const crewLine =
    crew === "sos"
      ? `<div style="color:#ff3b30;font-weight:800">RED SOS</div>`
      : crew === "ok"
        ? `<div style="color:#3ddc84;font-weight:800">GREEN OK</div>`
        : "";
  const motion = carMotion(car);
  const motionLine =
    motion === "sos"
      ? `<div style="color:#ff1a1a;font-weight:800">SOS</div>`
      : motion === "moving"
        ? `<div style="color:#15803d;font-weight:800">MOVING</div>`
        : `<div style="color:#1d4ed8;font-weight:800">STOPPED</div>`;
  return `<div class="car-popup">
    <strong>#${escapeHtml(car.carNumber)}</strong>
    <div>${escapeHtml(car.driverName)}</div>
    ${motionLine}
    <div>Speed: ${speed}</div>
    ${section}
    ${crewLine}
  </div>`;
}

function persistRouteTab(tab) {
  selectedRouteTab = tab;
  sessionStorage.setItem(ROUTE_TAB_KEY, tab);
}

function sectionCategory(section) {
  if (isKmzPin(section)) return "pins";
  if (section.type === "stage") return "stage";
  return "road";
}

function filterSectionsByTab(sections, tab) {
  if (tab === "all") return sections;
  return sections.filter((section) => sectionCategory(section) === tab);
}

function updateRouteTabs(sections) {
  const counts = { all: sections.length, stage: 0, road: 0, pins: 0 };
  for (const section of sections) counts[sectionCategory(section)] += 1;
  for (const btn of document.querySelectorAll("[data-route-tab]")) {
    const tab = btn.getAttribute("data-route-tab");
    const active = tab === selectedRouteTab;
    btn.classList.toggle("active", active);
    btn.setAttribute("aria-selected", active ? "true" : "false");
    const countEl = btn.querySelector(".route-tab-count");
    if (countEl) countEl.textContent = String(counts[tab] ?? 0);
  }
}

function renderSections(sections) {
  allSections = Array.isArray(sections) ? sections : [];
  updateRouteTabs(allSections);
  const filtered = filterSectionsByTab(allSections, selectedRouteTab);
  if (!allSections.length) {
    sectionList.innerHTML = `<li class="empty">${ROUTE_TAB_EMPTY.all}</li>`;
    return;
  }
  if (!filtered.length) {
    sectionList.innerHTML = `<li class="empty">${ROUTE_TAB_EMPTY[selectedRouteTab] || ROUTE_TAB_EMPTY.all}</li>`;
    return;
  }
  sectionList.innerHTML = filtered
    .map((section) => {
      const isPin = isKmzPin(section);
      const kind = isPin ? pinCaption(section).toUpperCase() : section.type === "stage" ? "STAGE" : "ROAD";
      const flag = section.flagStatus === "red" ? "red" : "green";
      const targetCount = Array.isArray(section.flagTargets) ? section.flagTargets.length : 0;
      const flagButtons = isPin
        ? ""
        : section.type === "stage"
          ? `<div class="car-actions">
            <button type="button" class="mini-toggle${flag === "green" ? " active" : ""}" data-flag="green" data-id="${section.id}">Green flag</button>
            <button type="button" class="mini-toggle flag-red${flag === "red" ? " active" : ""}" data-flag="red" data-id="${section.id}">Red flag</button>
            <button type="button" class="mini-toggle" data-type="road" data-id="${section.id}">Make road</button>
          </div>`
          : `<button type="button" class="mini-toggle" data-type="stage" data-id="${section.id}">Make stage</button>`;
      return `<li class="car-row" data-section="${section.id}">
        ${listIconHtml(section)}
        <div>
          <strong>${escapeHtml(section.name)}</strong>
          <small>${kind}${!isPin && section.type === "stage" ? ` · ${flag === "red" ? `RED FLAG${targetCount ? ` · ${targetCount} car${targetCount === 1 ? "" : "s"}` : ""}` : "GREEN FLAG"}` : ""}</small>
          ${flagButtons}
        </div>
      </li>`;
    })
    .join("");

  for (const btn of sectionList.querySelectorAll("button[data-type]")) {
    btn.addEventListener("click", async (event) => {
      event.stopPropagation();
      const id = btn.getAttribute("data-id");
      const type = btn.getAttribute("data-type");
      await fetch(`/api/sections/${id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ type }),
      });
      await refreshSections();
    });
  }

  for (const btn of sectionList.querySelectorAll("button[data-flag]")) {
    btn.addEventListener("click", async (event) => {
      event.stopPropagation();
      const id = btn.getAttribute("data-id");
      const flagStatus = btn.getAttribute("data-flag");
      if (flagStatus === "red") {
        openRedFlagPicker(id);
        return;
      }
      await fetch(`/api/sections/${id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ flagStatus: "green" }),
      });
      await refreshSections();
    });
  }

  for (const row of sectionList.querySelectorAll("li[data-section]")) {
    row.addEventListener("click", () => {
      const section = allSections.find((s) => s.id === row.dataset.section);
      const layer = routeLayers.get(section?.id);
      if (!layer) return;
      if (typeof layer.getLatLng === "function") {
        map.setView(layer.getLatLng(), Math.max(map.getZoom(), 15));
      } else if (layer.getBounds) {
        map.fitBounds(layer.getBounds(), { padding: [40, 40] });
      }
    });
  }
}

const redFlagModal = document.getElementById("redFlagModal");
const redFlagCarList = document.getElementById("redFlagCarList");
const redFlagModalStage = document.getElementById("redFlagModalStage");
const redFlagModalError = document.getElementById("redFlagModalError");
const flagSelectBehindSos = document.getElementById("flagSelectBehindSos");
let pendingFlagSectionId = null;
let pendingFlagCandidates = [];

function haversineMetersClient(a, b) {
  const toRad = (d) => (d * Math.PI) / 180;
  const R = 6371000;
  const dLat = toRad(b.lat - a.lat);
  const dLon = toRad(b.lon - a.lon);
  const lat1 = toRad(a.lat);
  const lat2 = toRad(b.lat);
  const h =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(h)));
}

function progressAlongPathClient(point, coords, maxDistM = 200) {
  if (!point || !coords || coords.length < 2) return null;
  const segLens = [];
  let total = 0;
  for (let i = 0; i < coords.length - 1; i++) {
    const len = haversineMetersClient(coords[i], coords[i + 1]);
    segLens.push(len);
    total += len;
  }
  if (total < 1) return null;
  let bestDist = Infinity;
  let bestAlong = 0;
  let alongBase = 0;
  const toLocalXY = (lat, lon, refLat) => {
    const toRad = (d) => (d * Math.PI) / 180;
    return {
      x: toRad(lon) * Math.cos(toRad(refLat)) * 6371000,
      y: toRad(lat) * 6371000,
    };
  };
  for (let i = 0; i < coords.length - 1; i++) {
    const a = coords[i];
    const b = coords[i + 1];
    const P = toLocalXY(point.lat, point.lon, point.lat);
    const A = toLocalXY(a.lat, a.lon, point.lat);
    const B = toLocalXY(b.lat, b.lon, point.lat);
    const abx = B.x - A.x;
    const aby = B.y - A.y;
    const ab2 = abx * abx + aby * aby;
    let t = 0;
    if (ab2 >= 1e-6) {
      t = Math.max(0, Math.min(1, ((P.x - A.x) * abx + (P.y - A.y) * aby) / ab2));
    }
    const closest = {
      lat: a.lat + (b.lat - a.lat) * t,
      lon: a.lon + (b.lon - a.lon) * t,
    };
    const dist = haversineMetersClient(point, closest);
    if (dist < bestDist) {
      bestDist = dist;
      bestAlong = alongBase + segLens[i] * t;
    }
    alongBase += segLens[i];
  }
  if (bestDist > maxDistM) return null;
  return { fraction: bestAlong / total, alongM: Math.round(bestAlong) };
}

function carsOnStage(sectionId) {
  return (latestCars || []).filter(
    (car) => car.section?.id === sectionId && car.section?.type === "stage"
  );
}

function buildFlagCandidates(section) {
  const onStage = carsOnStage(section.id);
  const coords = Array.isArray(section.coordinates) ? section.coordinates : [];
  const sosCars = onStage.filter((car) => car.crewStatus?.status === "sos");
  const sosProgress = sosCars
    .map((car) => {
      if (!car.last) return null;
      return progressAlongPathClient(car.last, coords);
    })
    .filter(Boolean)
    .map((p) => p.fraction);
  const sosCut = sosProgress.length ? Math.min(...sosProgress) : null;
  const onStageIds = new Set(onStage.map((car) => car.id));

  const rows = onStage.map((car) => {
    const progress =
      car.last && coords.length >= 2 ? progressAlongPathClient(car.last, coords) : null;
    const aheadOfSos =
      sosCut != null && progress != null ? progress.fraction > sosCut + 0.02 : false;
    return {
      id: car.id,
      carNumber: car.carNumber,
      driverName: car.driverName,
      crewStatus: car.crewStatus?.status || null,
      progress,
      aheadOfSos,
      onStage: true,
      selected: !aheadOfSos,
    };
  });

  const others = (latestCars || []).filter(
    (car) => car.tracking && !onStageIds.has(car.id)
  );
  for (const car of others) {
    rows.push({
      id: car.id,
      carNumber: car.carNumber,
      driverName: car.driverName,
      crewStatus: car.crewStatus?.status || null,
      progress: null,
      aheadOfSos: false,
      onStage: false,
      selected: false,
    });
  }

  rows.sort((a, b) => {
    if (a.onStage !== b.onStage) return a.onStage ? -1 : 1;
    const pa = a.progress?.fraction;
    const pb = b.progress?.fraction;
    if (pa == null && pb == null) {
      return String(a.carNumber).localeCompare(String(b.carNumber), undefined, { numeric: true });
    }
    if (pa == null) return 1;
    if (pb == null) return -1;
    return pa - pb;
  });

  return { rows, hasSosCut: sosCut != null, sosCount: sosCars.length };
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

function renderFlagCandidateList() {
  if (!redFlagCarList) return;
  if (!pendingFlagCandidates.length) {
    redFlagCarList.innerHTML = `<li class="empty">No tracking cars available to target.</li>`;
    return;
  }
  redFlagCarList.innerHTML = pendingFlagCandidates
    .map((row) => {
      const where = row.onStage
        ? row.progress != null
          ? `On stage · ~${Math.round(row.progress.fraction * 100)}%`
          : "On stage"
        : "Not on this stage";
      const crew =
        row.crewStatus === "sos" ? " · RED SOS" : row.crewStatus === "ok" ? " · GREEN OK" : "";
      const ahead = row.aheadOfSos ? " · ahead of SOS" : "";
      return `<li class="flag-target-row">
        <input type="checkbox" id="flagCar_${escapeHtml(row.id)}" data-car-id="${escapeHtml(
          row.id
        )}" ${row.selected ? "checked" : ""} />
        <label for="flagCar_${escapeHtml(row.id)}">
          <strong>#${escapeHtml(row.carNumber)} ${escapeHtml(row.driverName)}</strong>
          <small>${where}${crew}${ahead}</small>
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

function openRedFlagPicker(sectionId) {
  const section = allSections.find((s) => s.id === sectionId);
  if (!section || section.type !== "stage") return;
  pendingFlagSectionId = sectionId;
  const built = buildFlagCandidates(section);
  pendingFlagCandidates = built.rows;
  const existingTargets = new Set(
    Array.isArray(section.flagTargets) ? section.flagTargets.map(String) : []
  );
  if (section.flagStatus === "red" && existingTargets.size) {
    pendingFlagCandidates.forEach((row) => {
      row.selected = existingTargets.has(String(row.id));
    });
  }
  if (redFlagModalStage) {
    redFlagModalStage.textContent = `${section.name || "Stage"} · choose which cars see RED FLAG`;
  }
  if (flagSelectBehindSos) {
    flagSelectBehindSos.hidden = !built.hasSosCut;
  }
  setFlagModalError("");
  renderFlagCandidateList();
  if (redFlagModal) {
    redFlagModal.hidden = false;
    redFlagModal.classList.remove("hidden");
  }
}

function closeRedFlagPicker() {
  pendingFlagSectionId = null;
  pendingFlagCandidates = [];
  if (redFlagModal) {
    redFlagModal.hidden = true;
    redFlagModal.classList.add("hidden");
  }
  setFlagModalError("");
}

async function confirmRedFlag() {
  if (!pendingFlagSectionId) return;
  const targets = pendingFlagCandidates.filter((c) => c.selected).map((c) => c.id);
  if (!targets.length) {
    setFlagModalError("Select at least one car, or cancel.");
    return;
  }
  const res = await fetch(`/api/sections/${pendingFlagSectionId}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ flagStatus: "red", flagTargets: targets }),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    setFlagModalError(data.error || "Could not set red flag.");
    return;
  }
  closeRedFlagPicker();
  await refreshSections();
  await refresh();
}

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
flagSelectBehindSos?.addEventListener("click", () => {
  pendingFlagCandidates.forEach((c) => {
    c.selected = !c.aheadOfSos;
  });
  renderFlagCandidateList();
  setFlagModalError("");
});
redFlagModal?.addEventListener("click", (event) => {
  if (event.target === redFlagModal) closeRedFlagPicker();
});

function isKmzPin(section) {
  return (
    section.type === "marker" ||
    section.geometryType === "Point" ||
    (Array.isArray(section.coordinates) && section.coordinates.length === 1)
  );
}

function looksLikeRefuel(name, iconHref) {
  const n = String(name || "")
    .toLowerCase()
    .replace(/[_/]+/g, " ");
  const href = String(iconHref || "").toLowerCase();
  if (/gas_stations|gasoline|petrol|shapes\/gas|\bfuel/.test(href)) return true;
  if (/refuell?ing|re\s*fuel|refuel/.test(n)) return true;
  if (/\b(?:rz|rf)\s*[-.]?\s*\d*\b/.test(n)) return true;
  if (/\b(?:fuel(?:ing|ling)?|petrol|gas(?:oline)?(?:\s*stations?)?)\b/.test(n)) return true;
  if (/\bservice\s*(park|area|zone)\b/.test(n)) return true;
  return false;
}

function classifyPinKind(name, iconHref) {
  const n = String(name || "").toLowerCase();
  const href = String(iconHref || "").toLowerCase();
  if (looksLikeRefuel(name, iconHref)) return "refuel";
  if (/\bstart\b/.test(n)) return "start";
  if (/\bfinish\b/.test(n)) return "finish";
  if (/\bstop\b/.test(n)) return "stop";
  if (
    /\btc\s*\d|\btc\/|\btc\b|time\s*control/.test(n) ||
    /red-circle|wht-circle|grn-circle|paddle\/[^/]*circle|placemark_circle/.test(href)
  ) {
    return "tc";
  }
  if (/\/flag|shapes\/flag|triangle/.test(href)) return "start";
  if (/circle|paddle/.test(href)) return "tc";
  if (/^tc\d/i.test(String(name || "").replace(/\s+/g, ""))) return "tc";
  return "pin";
}

function pinKind(section) {
  const href = section.iconHref || section.coordinates?.[0]?.iconHref;
  const classified = classifyPinKind(section.name, href);
  // Old uploads stored iconKind as pin/tc/flag because refuel was not a kind yet.
  if (classified === "refuel") return "refuel";
  let kind = section.iconKind || section.coordinates?.[0]?.iconKind || classified;
  if (kind === "flag") kind = classified;
  return kind;
}

function pinCaption(section) {
  const kind = pinKind(section);
  if (kind === "tc") return "Time control";
  if (kind === "start") return "Start";
  if (kind === "finish") return "Finish";
  if (kind === "stop") return "Stop";
  if (kind === "refuel") return "Refueling";
  if (kind === "flag") return "Flag";
  return "Placemark";
}

function pinIconSrc(kind) {
  const entry = pinIcons[kind];
  if (!entry?.data) return "";
  return `data:${entry.mime || "image/png"};base64,${entry.data}`;
}

function safeIconSrc(href) {
  const raw = String(href || "").trim();
  if (raw.startsWith("data:image/")) return raw;
  if (raw.startsWith("/") && !raw.startsWith("//")) return raw;
  if (/^https?:\/\/[^\s"']+$/i.test(raw)) return raw.replace(/^http:\/\//i, "https://");
  return "";
}

function isGoogleMapfile(href) {
  return /maps\.google\.com\/mapfiles|maps\.gstatic\.com\/mapfiles/i.test(String(href || ""));
}

function pinImageSrc(section) {
  const kind = pinKind(section);
  const custom = pinIconSrc(kind);
  if (custom) return custom;
  const bundled = DEFAULT_PIN_IMAGES[kind];
  if (bundled && kind !== "pin") return bundled;
  const href = section.iconHref || section.coordinates?.[0]?.iconHref || "";
  const safe = safeIconSrc(href);
  if (safe.startsWith("data:image/")) return safe;
  if (safe && !isGoogleMapfile(safe)) return safe;
  return bundled || DEFAULT_PIN_IMAGES.pin;
}

function listIconHtml(section) {
  if (isKmzPin(section)) {
    const kind = pinKind(section);
    const src = pinImageSrc(section);
    if (src) return `<img class="kmz-list-icon custom" src="${src}" alt="${escapeHtml(pinCaption(section))}" />`;
    if (kind === "tc") return '<span class="kmz-list-icon tc" title="Time control"></span>';
    if (kind === "start" || kind === "finish" || kind === "stop" || kind === "flag") {
      return `<span class="kmz-list-icon flag" title="${escapeHtml(pinCaption(section))}"></span>`;
    }
    if (kind === "refuel") return '<span class="kmz-list-icon refuel" title="Refueling"></span>';
    return '<span class="kmz-list-icon pin" title="Placemark"></span>';
  }
  if (section.type === "stage") return '<span class="kmz-list-icon stage" title="Special stage"></span>';
  return '<span class="kmz-list-icon road" title="Road section"></span>';
}

function kmzLeafletIcon(section) {
  const kind = pinKind(section);
  const src = pinImageSrc(section);
  const isFlag = kind === "start" || kind === "finish" || kind === "stop" || kind === "flag";
  const isPin = kind === "pin";
  return L.icon({
    iconUrl: src,
    iconSize: [36, 36],
    iconAnchor: isFlag ? [8, 34] : isPin ? [18, 34] : [18, 18],
    className: "kmz-ge-icon",
  });
}

function bindKmzLabel(marker, section) {
  const name = section.name || "Pin";
  if (marker.getTooltip()) {
    marker.setTooltipContent(name);
    return marker;
  }
  return marker.bindTooltip(name, {
    permanent: true,
    direction: "left",
    offset: [-2, 0],
    className: "kmz-ge-label",
    opacity: 1,
  });
}

function kmzPinIcon(section) {
  return kmzLeafletIcon(section);
}

function renderPinIconSlots() {
  if (!pinIconPack) return;
  const rallyId = routeRallyId();
  if (!rallyId) {
    pinIconPack.hidden = true;
    pinIconPack.innerHTML = "";
    return;
  }
  pinIconPack.hidden = false;
  pinIconPack.innerHTML = PIN_ICON_SLOTS.map(({ kind, label }) => {
    const custom = pinIconSrc(kind);
    const src = custom || DEFAULT_PIN_IMAGES[kind];
    const preview = `<img src="${src}" alt="${escapeHtml(label)}" />`;
    return `<label class="pin-icon-slot">
      <span class="pin-icon-preview">${preview}</span>
      <span class="pin-icon-meta">
        <strong>${escapeHtml(label)}</strong>
        <small>${custom ? "Custom image" : "Google Earth icon · upload to replace"}</small>
        <span class="pin-icon-actions">
          <span class="pin-icon-upload">Upload
            <input type="file" accept="image/png,image/jpeg,image/webp,image/svg+xml,image/gif" data-pin-kind="${kind}" hidden />
          </span>
          ${custom ? `<button type="button" class="mini-toggle" data-pin-clear="${kind}">Clear</button>` : ""}
        </span>
      </span>
    </label>`;
  }).join("");

  for (const input of pinIconPack.querySelectorAll("input[data-pin-kind]")) {
    input.addEventListener("change", async () => {
      const file = input.files?.[0];
      input.value = "";
      if (!file) return;
      await uploadPinIcon(input.getAttribute("data-pin-kind"), file);
    });
  }
  for (const btn of pinIconPack.querySelectorAll("button[data-pin-clear]")) {
    btn.addEventListener("click", async (event) => {
      event.preventDefault();
      event.stopPropagation();
      await clearPinIcon(btn.getAttribute("data-pin-clear"));
    });
  }
}

async function uploadPinIcon(kind, file) {
  const rallyId = routeRallyId();
  if (!rallyId) return;
  routeStatus.textContent = `Saving ${kind} image…`;
  try {
    const contentBase64 = await fileToBase64(file);
    const res = await fetch(`/api/rallies/${encodeURIComponent(rallyId)}/pin-icons`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        kind,
        filename: file.name,
        mime: file.type,
        contentBase64,
      }),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || "Could not save image");
    pinIcons = data.pinIcons || pinIcons;
    routeStatus.textContent = `${kind.toUpperCase()} image saved. Matching KMZ placemarks use it on the map.`;
    renderPinIconSlots();
    await refreshSections();
  } catch (err) {
    routeStatus.textContent = err.message || "Could not save image";
  }
}

async function clearPinIcon(kind) {
  const rallyId = routeRallyId();
  if (!rallyId) return;
  const res = await fetch(`/api/rallies/${encodeURIComponent(rallyId)}/pin-icons/${encodeURIComponent(kind)}`, {
    method: "DELETE",
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    routeStatus.textContent = data.error || "Could not clear image";
    return;
  }
  pinIcons = data.pinIcons || {};
  routeStatus.textContent = `${kind.toUpperCase()} image cleared.`;
  renderPinIconSlots();
  await refreshSections();
}

function renderRouteLayers(sections) {
  const seen = new Set();
  const bounds = [];
  for (const section of sections) {
    if (!section.coordinates?.length) continue;
    seen.add(section.id);
    const latlngs = section.coordinates.map((p) => [p.lat, p.lon]);
    latlngs.forEach((ll) => bounds.push(ll));
    const existing = routeLayers.get(section.id);
    if (isKmzPin(section)) {
      const latlng = latlngs[0];
      const isPinMarker =
        existing && typeof existing.getLatLng === "function" && typeof existing.getLatLngs !== "function";
      if (isPinMarker) {
        existing.setLatLng(latlng);
        existing.setIcon?.(kmzLeafletIcon(section));
        bindKmzLabel(existing, section);
        existing.setPopupContent?.(`<strong>${escapeHtml(section.name)}</strong>`);
      } else {
        if (existing) {
          map.removeLayer(existing);
          routeLayers.delete(section.id);
        }
        const marker = bindKmzLabel(
          L.marker(latlng, {
            icon: kmzLeafletIcon(section),
            zIndexOffset: -200,
            keyboard: false,
          }).bindPopup(`<strong>${escapeHtml(section.name)}</strong>`),
          section
        ).addTo(map);
        routeLayers.set(section.id, marker);
      }
      continue;
    }
    // Blue = road, red = stage (same as KMZ convention)
    const color = section.type === "stage" ? "#ff3b30" : "#3d7dff";
    const weight = section.type === "stage" ? 5 : 3;
    if (existing && existing.setLatLngs) {
      existing.setLatLngs(latlngs);
      existing.setStyle?.({ color, weight });
    } else {
      if (existing) {
        map.removeLayer(existing);
        routeLayers.delete(section.id);
      }
      if (section.geometryType === "Polygon") {
        routeLayers.set(
          section.id,
          L.polygon(latlngs, { color, weight: 2, fillOpacity: 0.15 }).addTo(map)
        );
      } else {
        routeLayers.set(section.id, L.polyline(latlngs, { color, weight, opacity: 0.9 }).addTo(map));
      }
    }
  }
  for (const [id, layer] of routeLayers) {
    if (!seen.has(id)) {
      map.removeLayer(layer);
      routeLayers.delete(id);
    }
  }
  if (!fittedRouteOnce && bounds.length) {
    map.fitBounds(bounds, { padding: [40, 40], maxZoom: 13 });
    fittedRouteOnce = true;
  }
}

function renderList(cars, { history = false } = {}) {
  const list = document.getElementById("carList");
  if (!cars.length) {
    list.innerHTML = '<li class="empty">Waiting for drivers to start tracking…</li>';
    return;
  }
  list.innerHTML = cars
    .map((car) => {
      const held = Boolean(car.reconnectRequested);
      const state = car.live
        ? held
          ? "LIVE · LAST GPS"
          : "LIVE"
        : car.tracking
          ? "NO SIGNAL · LAST GPS"
          : "STOPPED";
      const speed =
        car.last?.speed == null ? "—" : `${Math.round(car.last.speed * 3.6)} km/h`;
      const section = car.section?.label || "Off route";
      const crew = car.crewStatus?.status;
      const crewLabel =
        crew === "sos" ? "RED SOS" : crew === "ok" ? "GREEN OK" : "";
      const flagLabel =
        car.flagStatus === "red"
          ? car.flagAcked
            ? ' · <span class="flag-acked">RED FLAG ACKED</span>'
            : ' · <span class="flag-waiting">RED FLAG WAITING</span>'
          : "";
      const color = markerColor(car);
      const motionLabel =
        carMotion(car) === "sos" ? "SOS" : carMotion(car) === "moving" ? "MOVING" : "STOPPED";
      const hasTrail = (car.trailCount || 0) > 1 || (Array.isArray(car.trail) && car.trail.length > 1);
      const showing = visibleTrails.has(car.id);
      return `<li class="car-row" data-id="${car.id}">
        <span class="dot" style="background:${color}"></span>
        <div>
          <strong>#${escapeHtml(car.carNumber)} ${escapeHtml(car.driverName)}</strong>
          <small>${state} · ${motionLabel} · ${speed}${crewLabel ? ` · ${crewLabel}` : ""}${flagLabel}</small>
          <small class="section-line">${escapeHtml(section)}</small>
          <div class="car-actions">
            <button type="button" class="mini-toggle${showing ? " active" : ""}" data-route="${car.id}" ${
              hasTrail ? "" : "disabled"
            }>${showing ? "Hide route" : "Show route"}</button>
            ${
              hasTrail && !history
                ? `<a class="mini-toggle" href="/api/cars/${encodeURIComponent(
                    car.id
                  )}/track.gpx" download>GPX</a>`
                : ""
            }
            ${
              car.tracking && !history
                ? `<button type="button" class="mini-toggle" data-refresh="${car.id}">Refresh</button>`
                : ""
            }
          </div>
        </div>
      </li>`;
    })
    .join("");

  for (const row of list.querySelectorAll("li[data-id]")) {
    row.addEventListener("click", (event) => {
      if (event.target.closest("a, button")) return;
      const car = cars.find((c) => c.id === row.dataset.id);
      if (!car?.last) return;
      map.flyTo([car.last.lat, car.last.lon], 14);
      const marker = markers.get(car.id);
      if (marker) marker.openPopup();
    });
  }

  for (const btn of list.querySelectorAll("button[data-route]")) {
    btn.addEventListener("click", async (event) => {
      event.stopPropagation();
      const id = btn.getAttribute("data-route");
      if (visibleTrails.has(id)) hideCarTrail(id);
      else if (history) {
        visibleTrails.add(id);
        const car = cars.find((c) => c.id === id);
        if (car) drawCarTrail(car, { fit: true });
      } else await showCarTrail(id, { fit: true });
      renderList(latestCars);
    });
  }

  for (const btn of list.querySelectorAll("button[data-refresh]")) {
    btn.addEventListener("click", async (event) => {
      event.stopPropagation();
      const id = btn.getAttribute("data-refresh");
      btn.disabled = true;
      btn.textContent = "Sending…";
      try {
        const res = await fetch(`/api/cars/${encodeURIComponent(id)}/refresh`, { method: "POST" });
        const data = await res.json().catch(() => ({}));
        if (!res.ok) throw new Error(data.error || "Refresh failed");
        btn.textContent = "Refresh sent";
        const car = latestCars.find((c) => c.id === id);
        if (car) car.reconnectRequested = true;
        await refresh();
        const updated = latestCars.find((c) => c.id === id);
        if (updated?.last) {
          map.flyTo([updated.last.lat, updated.last.lon], 14);
          markers.get(id)?.openPopup();
        }
      } catch (err) {
        btn.disabled = false;
        btn.textContent = err.message || "Failed";
      }
    });
  }
}

function hideCarTrail(id) {
  visibleTrails.delete(id);
  const layer = trailLayers.get(id);
  if (layer) {
    map.removeLayer(layer);
    trailLayers.delete(id);
  }
}

function drawCarTrail(car, { fit = false } = {}) {
  const trail = Array.isArray(car.trail) ? car.trail : [];
  if (trail.length < 2) return;
  const latlngs = trail.map((p) => [p.lat, p.lon]);
  const color = markerColor(car) || car.color || "#3d7dff";
  if (trailLayers.has(car.id)) {
    trailLayers.get(car.id).setLatLngs(latlngs).setStyle({ color });
  } else {
    trailLayers.set(
      car.id,
      L.polyline(latlngs, { color, weight: 4, opacity: 0.85 }).addTo(map)
    );
  }
  if (fit) {
    map.fitBounds(trailLayers.get(car.id).getBounds(), { padding: [40, 40], maxZoom: 15 });
  }
}

async function showCarTrail(id, { fit = false } = {}) {
  const res = await fetch(`/api/cars/${encodeURIComponent(id)}`);
  const car = await res.json();
  if (!res.ok) throw new Error(car.error || "Could not load car route");
  visibleTrails.add(id);
  drawCarTrail(car, { fit });
}

async function refreshVisibleTrails() {
  for (const id of [...visibleTrails]) {
    try {
      await showCarTrail(id);
    } catch {
      /* keep last drawn path */
    }
  }
}

function renderMap(cars) {
  const seen = new Set();
  const bounds = [];

  for (const car of cars) {
    if (!car.last) continue;
    seen.add(car.id);
    bounds.push([car.last.lat, car.last.lon]);

    const color = markerColor(car);
    const html = `<div class="leaflet-marker-num" style="background:${color}">${escapeHtml(
      car.carNumber
    )}</div>`;
    const icon = L.divIcon({ className: "", html, iconSize: [36, 36], iconAnchor: [18, 18] });

    if (markers.has(car.id)) {
      const marker = markers.get(car.id);
      marker.setLatLng([car.last.lat, car.last.lon]).setIcon(icon);
      marker.setPopupContent(popupHtml(car));
    } else {
      const marker = L.marker([car.last.lat, car.last.lon], {
        icon,
        title: `#${car.carNumber}`,
      }).addTo(map);
      marker.bindPopup(popupHtml(car), { closeButton: true, offset: [0, -8] });
      markers.set(car.id, marker);
    }
  }

  for (const [id, marker] of markers) {
    if (!seen.has(id)) {
      map.removeLayer(marker);
      markers.delete(id);
    }
  }

  if (!fittedOnce && bounds.length) {
    map.fitBounds(bounds, { padding: [40, 40], maxZoom: 14 });
    fittedOnce = true;
  }
}

function escapeHtml(value) {
  return String(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

async function ensureControlAuth() {
  const res = await fetch("/api/me");
  if (res.status === 401) {
    location.replace("/control-login.html");
    return false;
  }
  const data = await res.json().catch(() => ({}));
  if (data.mustChangePassword) {
    location.replace("/control-login.html?change=1");
    return false;
  }
  earthToken = data.earthToken || "";
  return true;
}

document.getElementById("logoutBtn")?.addEventListener("click", async () => {
  await fetch("/api/logout", { method: "POST" });
  location.replace("/control-login.html");
});

routeTabs?.addEventListener("click", (event) => {
  const btn = event.target.closest("[data-route-tab]");
  if (!btn || !routeTabs.contains(btn)) return;
  const tab = btn.getAttribute("data-route-tab");
  if (!ROUTE_TABS.includes(tab) || tab === selectedRouteTab) return;
  persistRouteTab(tab);
  renderSections(allSections);
});
updateRouteTabs(allSections);

function resizeMap() {
  if (!map) return;
  map.invalidateSize({ animate: false });
}

function scheduleMapResize() {
  resizeMap();
  requestAnimationFrame(resizeMap);
  setTimeout(resizeMap, 0);
  setTimeout(resizeMap, 200);
}

ensureControlAuth().then(async (ok) => {
  if (!ok) return;
  await refreshRallies();
  refresh();
  refreshSections();
  scheduleMapResize();
  setInterval(refresh, 3000);
  setInterval(refreshSections, 4000);
  setInterval(refreshRallies, 8000);
});

window.addEventListener("resize", resizeMap);
window.addEventListener("orientationchange", () => {
  setTimeout(resizeMap, 250);
});
window.addEventListener("load", scheduleMapResize);
document.fonts?.ready?.then(scheduleMapResize);
const mapEl = document.getElementById("map");
if (mapEl && typeof ResizeObserver !== "undefined") {
  new ResizeObserver(() => resizeMap()).observe(mapEl);
}
scheduleMapResize();
