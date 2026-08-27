const map = L.map("map", { zoomControl: true }).setView([38.5, 23.5], 6);
L.tileLayer("https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}", {
  attribution: "Tiles &copy; Esri",
  maxZoom: 19,
}).addTo(map);

const markers = new Map();
const lines = new Map();
let fittedOnce = false;

const copyBtn = document.getElementById("copyLink");
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

async function refresh() {
  const res = await fetch("/api/cars");
  const data = await res.json();
  renderList(data.cars);
  renderMap(data.cars);
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
      return `<li data-id="${car.id}">
        <span class="dot" style="background:${car.color}"></span>
        <div>
          <strong>#${escapeHtml(car.carNumber)} ${escapeHtml(car.driverName)}</strong>
          <small>${state} · ${speed}</small>
        </div>
        <small>${car.live ? "on course" : ""}</small>
      </li>`;
    })
    .join("");

  for (const row of list.querySelectorAll("li[data-id]")) {
    row.addEventListener("click", () => {
      const car = cars.find((c) => c.id === row.dataset.id);
      if (car?.last) map.flyTo([car.last.lat, car.last.lon], 14);
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
      markers.get(car.id).setLatLng([car.last.lat, car.last.lon]).setIcon(icon);
    } else {
      markers.set(
        car.id,
        L.marker([car.last.lat, car.last.lon], { icon, title: `#${car.carNumber}` }).addTo(map)
      );
    }

    const latlngs = (car.trail || []).map((p) => [p.lat, p.lon]);
    if (lines.has(car.id)) {
      lines.get(car.id).setLatLngs(latlngs);
    } else {
      lines.set(
        car.id,
        L.polyline(latlngs, { color: car.color, weight: 4, opacity: 0.85 }).addTo(map)
      );
    }
  }

  for (const [id, marker] of markers) {
    if (!seen.has(id)) {
      map.removeLayer(marker);
      markers.delete(id);
    }
  }
  for (const [id, line] of lines) {
    if (!seen.has(id)) {
      map.removeLayer(line);
      lines.delete(id);
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
setInterval(refresh, 3000);
