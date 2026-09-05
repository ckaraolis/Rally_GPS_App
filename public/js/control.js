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

const copyBtn = document.getElementById("copyLink");
const routeFile = document.getElementById("routeFile");
const clearRoutes = document.getElementById("clearRoutes");
const routeStatus = document.getElementById("routeStatus");
const sectionList = document.getElementById("sectionList");
const refreshLostBtn = document.getElementById("refreshLostBtn");

copyBtn.addEventListener("click", async () => {
  const url = `${location.origin}/earth.kml`;
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
  routeStatus.textContent = `Uploading ${file.name}…`;
  try {
    const contentBase64 = await fileToBase64(file);
    const res = await fetch("/api/sections/upload", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        filename: file.name,
        contentBase64,
        replace: true,
      }),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || "Upload failed");
    routeStatus.textContent = `Loaded ${data.count} sections (${data.stages} stages, ${data.roads} road).`;
    await refreshSections();
  } catch (err) {
    routeStatus.textContent = err.message || "Upload failed";
  } finally {
    routeFile.value = "";
  }
});

clearRoutes.addEventListener("click", async () => {
  if (!confirm("Clear all uploaded route sections?")) return;
  await fetch("/api/sections", { method: "DELETE" });
  routeStatus.textContent = "Route cleared.";
  await refreshSections();
});

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
  renderList(latestCars);
  renderMap(latestCars);
  await refreshVisibleTrails();
}

async function refreshSections() {
  const res = await fetch("/api/sections");
  const data = await res.json();
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
  return `<div class="car-popup">
    <strong>#${escapeHtml(car.carNumber)}</strong>
    <div>${escapeHtml(car.driverName)}</div>
    <div>Speed: ${speed}</div>
    ${section}
    ${crewLine}
  </div>`;
}

function renderSections(sections) {
  if (!sections.length) {
    sectionList.innerHTML = '<li class="empty">No route uploaded yet</li>';
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

function renderList(cars) {
  const list = document.getElementById("carList");
  if (!cars.length) {
    list.innerHTML = '<li class="empty">Waiting for drivers to start tracking…</li>';
    return;
  }
  list.innerHTML = cars
    .map((car) => {
      const held = Boolean(car.reconnectRequested);
      const state = car.live ? (held ? "LIVE · LAST GPS" : "LIVE") : car.tracking ? "LOST" : "STOPPED";
      const speed =
        car.last?.speed == null ? "—" : `${Math.round(car.last.speed * 3.6)} km/h`;
      const section = car.section?.label || "Off route";
      const crew = car.crewStatus?.status;
      const crewLabel =
        crew === "sos" ? "RED SOS" : crew === "ok" ? "GREEN OK" : "";
      const flagLabel = car.flagStatus === "red" ? " · RED FLAG" : "";
      const hasTrail = (car.trailCount || 0) > 1;
      const showing = visibleTrails.has(car.id);
      return `<li class="car-row" data-id="${car.id}">
        <span class="dot" style="background:${car.color}"></span>
        <div>
          <strong>#${escapeHtml(car.carNumber)} ${escapeHtml(car.driverName)}</strong>
          <small>${state} · ${speed}${crewLabel ? ` · ${crewLabel}` : ""}${flagLabel}</small>
          <small class="section-line">${escapeHtml(section)}</small>
          <div class="car-actions">
            <button type="button" class="mini-toggle${showing ? " active" : ""}" data-route="${car.id}" ${
              hasTrail ? "" : "disabled"
            }>${showing ? "Hide route" : "Show route"}</button>
            ${
              hasTrail
                ? `<a class="mini-toggle" href="/api/cars/${encodeURIComponent(
                    car.id
                  )}/track.gpx" download>GPX</a>`
                : ""
            }
            ${
              car.tracking
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
      else await showCarTrail(id, { fit: true });
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
  const color = car.color || "#ffc14a";
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

    const html = `<div class="leaflet-marker-num" style="background:${car.color}">${escapeHtml(
      car.carNumber
    )}</div>`;
    const icon = L.divIcon({ className: "", html, iconSize: [34, 28], iconAnchor: [17, 14] });

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

refresh();
refreshSections();
setInterval(refresh, 3000);
setInterval(refreshSections, 4000);

function resizeMap() {
  map.invalidateSize();
}
window.addEventListener("resize", resizeMap);
window.addEventListener("orientationchange", () => {
  setTimeout(resizeMap, 250);
});
