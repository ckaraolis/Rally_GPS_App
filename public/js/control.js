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
    return;
  }
  if (routeFile) routeFile.disabled = false;
  if (clearRoutes) clearRoutes.disabled = false;
  fileBtn?.classList.remove("disabled");
  if (routeTarget) {
    routeTarget.textContent = `KMZ for ${rally.name} (${String(rally.status || "draft").toUpperCase()}). Other rallies keep their own routes.`;
  }
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
    routeStatus.textContent = `Loaded ${data.count} sections for this rally (${data.stages} stages, ${data.roads} road).`;
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
      try {
        await setRallyStatus(btn.getAttribute("data-id"), btn.getAttribute("data-rally-status"));
        viewingRallyId = null;
        historyCars = [];
        persistSelectedRally(btn.getAttribute("data-id"));
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

function renderSections(sections) {
  if (!sections.length) {
    sectionList.innerHTML = '<li class="empty">No route uploaded for this rally yet</li>';
    return;
  }
  sectionList.innerHTML = sections
    .map((section) => {
      const kind = section.type === "stage" ? "STAGE" : "ROAD";
      const flag = section.flagStatus === "red" ? "red" : "green";
      const flagButtons =
        section.type === "stage"
          ? `<div class="car-actions">
            <button type="button" class="mini-toggle${flag === "green" ? " active" : ""}" data-flag="green" data-id="${section.id}">Green flag</button>
            <button type="button" class="mini-toggle flag-red${flag === "red" ? " active" : ""}" data-flag="red" data-id="${section.id}">Red flag</button>
            <button type="button" class="mini-toggle" data-type="road" data-id="${section.id}">Make road</button>
          </div>`
          : `<button type="button" class="mini-toggle" data-type="stage" data-id="${section.id}">Make stage</button>`;
      return `<li class="car-row" data-section="${section.id}">
        <span class="dot" style="background:${section.type === "stage" ? (flag === "red" ? "#ff1a1a" : "#ff3b30") : "#3d7dff"}"></span>
        <div>
          <strong>${escapeHtml(section.name)}</strong>
          <small>${kind} · ${escapeHtml(section.label)}${section.type === "stage" ? ` · ${flag === "red" ? "RED FLAG" : "GREEN FLAG"}` : ""}</small>
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
      await fetch(`/api/sections/${id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ flagStatus }),
      });
      await refreshSections();
    });
  }

  for (const row of sectionList.querySelectorAll("li[data-section]")) {
    row.addEventListener("click", () => {
      const section = sections.find((s) => s.id === row.dataset.section);
      const layer = routeLayers.get(section?.id);
      if (layer) map.fitBounds(layer.getBounds(), { padding: [40, 40] });
    });
  }
}

function renderRouteLayers(sections) {
  const seen = new Set();
  const bounds = [];
  for (const section of sections) {
    if (!section.coordinates?.length) continue;
    seen.add(section.id);
    const latlngs = section.coordinates.map((p) => [p.lat, p.lon]);
    latlngs.forEach((ll) => bounds.push(ll));
    // Blue = road, red = stage (same as KMZ convention)
    const color = section.type === "stage" ? "#ff3b30" : "#3d7dff";
    const weight = section.type === "stage" ? 5 : 3;
    if (routeLayers.has(section.id)) {
      const layer = routeLayers.get(section.id);
      if (layer.setLatLngs) layer.setLatLngs(latlngs);
      layer.setStyle?.({ color, weight });
    } else if (section.geometryType === "Polygon") {
      routeLayers.set(
        section.id,
        L.polygon(latlngs, { color, weight: 2, fillOpacity: 0.15 }).addTo(map)
      );
    } else {
      routeLayers.set(section.id, L.polyline(latlngs, { color, weight, opacity: 0.9 }).addTo(map));
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
      const flagLabel = car.flagStatus === "red" ? " · RED FLAG" : "";
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

ensureControlAuth().then(async (ok) => {
  if (!ok) return;
  await refreshRallies();
  refresh();
  refreshSections();
  setInterval(refresh, 3000);
  setInterval(refreshSections, 4000);
  setInterval(refreshRallies, 8000);
});

function resizeMap() {
  map.invalidateSize();
}
window.addEventListener("resize", resizeMap);
window.addEventListener("orientationchange", () => {
  setTimeout(resizeMap, 250);
});
