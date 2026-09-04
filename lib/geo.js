/** Distance / containment helpers for rally section detection */

function toRad(d) {
  return (d * Math.PI) / 180;
}

function haversineMeters(a, b) {
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

/** Approximate local meters projection around a reference latitude */
function toLocalXY(lat, lon, refLat) {
  const x = toRad(lon) * Math.cos(toRad(refLat)) * 6371000;
  const y = toRad(lat) * 6371000;
  return { x, y };
}

function distPointToSegmentMeters(p, a, b) {
  const refLat = p.lat;
  const P = toLocalXY(p.lat, p.lon, refLat);
  const A = toLocalXY(a.lat, a.lon, refLat);
  const B = toLocalXY(b.lat, b.lon, refLat);
  const abx = B.x - A.x;
  const aby = B.y - A.y;
  const apx = P.x - A.x;
  const apy = P.y - A.y;
  const ab2 = abx * abx + aby * aby;
  if (ab2 < 1e-6) return haversineMeters(p, a);
  let t = (apx * abx + apy * aby) / ab2;
  t = Math.max(0, Math.min(1, t));
  const closest = {
    lat: a.lat + (b.lat - a.lat) * t,
    lon: a.lon + (b.lon - a.lon) * t,
  };
  return haversineMeters(p, closest);
}

function distanceToLineMeters(point, coords) {
  if (!coords || coords.length < 2) return Infinity;
  let min = Infinity;
  for (let i = 0; i < coords.length - 1; i++) {
    const d = distPointToSegmentMeters(point, coords[i], coords[i + 1]);
    if (d < min) min = d;
  }
  return min;
}

/** Ray casting point-in-polygon. coords = [{lat,lon}, ...] */
function pointInPolygon(point, ring) {
  if (!ring || ring.length < 3) return false;
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const xi = ring[i].lon;
    const yi = ring[i].lat;
    const xj = ring[j].lon;
    const yj = ring[j].lat;
    const intersect =
      yi > point.lat !== yj > point.lat &&
      point.lon < ((xj - xi) * (point.lat - yi)) / (yj - yi + 0.0) + xi;
    if (intersect) inside = !inside;
  }
  return inside;
}

/**
 * Pick the best matching section for a GPS point.
 * Stages win over road sections when both are close.
 */
function detectSection(point, sections, options = {}) {
  const roadMax = options.roadMaxMeters ?? 120;
  const stageMax = options.stageMaxMeters ?? 80;
  if (!point || !sections?.length) return null;

  const candidates = [];
  for (const section of sections) {
    if (section.active === false) continue;
    const coords = section.coordinates || [];
    let distance = Infinity;
    let matched = false;

    if (section.geometryType === "Polygon") {
      matched = pointInPolygon(point, coords);
      distance = matched ? 0 : distanceToLineMeters(point, coords);
      if (!matched && distance <= (section.type === "stage" ? stageMax : roadMax)) {
        matched = true;
      }
    } else {
      distance = distanceToLineMeters(point, coords);
      const max = section.type === "stage" ? stageMax : roadMax;
      matched = distance <= max;
    }

    if (matched) {
      candidates.push({ section, distance });
    }
  }

  if (!candidates.length) return null;

  candidates.sort((a, b) => {
    const rank = (s) => (s.type === "stage" ? 0 : 1);
    const r = rank(a.section) - rank(b.section);
    if (r !== 0) return r;
    return a.distance - b.distance;
  });

  const best = candidates[0].section;
  return {
    id: best.id,
    name: best.name,
    type: best.type,
    label: best.label,
    flagStatus: best.flagStatus === "red" ? "red" : "green",
    flagTs: Number(best.flagTs) || 0,
    distanceM: Math.round(candidates[0].distance),
  };
}

module.exports = {
  haversineMeters,
  distanceToLineMeters,
  pointInPolygon,
  detectSection,
};
