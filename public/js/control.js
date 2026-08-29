const map = L.map("map", { zoomControl: true }).setView([38.5, 23.5], 6);
L.tileLayer("https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}", {
  attribution: "Tiles &copy; Esri",
  maxZoom: 19,
}).addTo(map);

const markers = new Map();
const routeLayers = new Map();
let fittedOnce = false;
let fittedRouteOnce = false;
let latestCars = [];

const copyBtn = document.getElementById("copyLink");
const routeFile = document.getElementById("routeFile");
const clearRoutes = document.getElementById("clearRoutes");
const routeStatus = document.getElementById("routeStatus");
const sectionList = document.getElementById("sectionList");

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
      return `<li data-section="${section.id}">
        <span class="dot" style="background:${section.type === "stage" ? "#ff3b30" : "#3d7dff"}"></span>
        <div>
          <strong>${escapeHtml(section.name)}</strong>
          <small>${kind} · ${escapeHtml(section.label)}</small>
        </div>
        <button type="button" class="mini-toggle" data-id="${section.id}" data-type="${
        section.type === "stage" ? "road" : "stage"
      }">Make ${section.type === "stage" ? "road" : "stage"}</button>
      </li>`;
    })
    .join("");

  for (const btn of sectionList.querySelectorAll(".mini-toggle")) {
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
      const state = car.live ? "LIVE" : car.tracking ? "LOST" : "STOPPED";
      const speed =
        car.last?.speed == null ? "—" : `${Math.round(car.last.speed * 3.6)} km/h`;
      const section = car.section?.label || "Off route";
      const crew = car.crewStatus?.status;
      const crewLabel =
        crew === "sos" ? "RED SOS" : crew === "ok" ? "GREEN OK" : "";
      const canDownload = (car.trailCount || 0) > 1;
      return `<li data-id="${car.id}">
        <span class="dot" style="background:${car.color}"></span>
        <div>
          <strong>#${escapeHtml(car.carNumber)} ${escapeHtml(car.driverName)}</strong>
          <small>${state} · ${speed}${crewLabel ? ` · ${crewLabel}` : ""}</small>
          <small class="section-line">${escapeHtml(section)}</small>
        </div>
        ${
          canDownload
            ? `<a class="mini-toggle" href="/api/cars/${encodeURIComponent(
                car.id
              )}/track.gpx" download>GPX</a>`
            : `<small>${car.section?.type === "stage" ? "SS" : ""}</small>`
        }
      </li>`;
    })
    .join("");

  for (const row of list.querySelectorAll("li[data-id]")) {
    row.addEventListener("click", (event) => {
      if (event.target.closest("a")) return;
      const car = cars.find((c) => c.id === row.dataset.id);
      if (!car?.last) return;
      map.flyTo([car.last.lat, car.last.lon], 14);
      const marker = markers.get(car.id);
      if (marker) marker.openPopup();
    });
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
