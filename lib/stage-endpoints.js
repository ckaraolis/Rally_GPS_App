/**
 * Synthetic Start / Finish pins at the ends of each special-stage line
 * (where ALGE start/finish timing devices sit).
 */

function stageBaseName(section) {
  const raw = String(section.label || section.name || "Stage").trim();
  return raw || "Stage";
}

/**
 * @param {Array<object>} sections
 * @returns {Array<object>} marker sections (not persisted)
 */
function buildStageStartFinishMarkers(sections) {
  if (!Array.isArray(sections)) return [];
  const out = [];
  for (const section of sections) {
    if (!section || section.type !== "stage" || section.active === false) continue;
    if (section.geometryType === "Polygon") continue;
    const coords = Array.isArray(section.coordinates) ? section.coordinates : [];
    if (coords.length < 2) continue;
    const first = coords[0];
    const last = coords[coords.length - 1];
    if (
      !first ||
      !last ||
      !Number.isFinite(first.lat) ||
      !Number.isFinite(first.lon) ||
      !Number.isFinite(last.lat) ||
      !Number.isFinite(last.lon)
    ) {
      continue;
    }
    const base = stageBaseName(section);
    out.push({
      id: `${section.id}__ss-start`,
      name: `${base} Start`,
      label: `${base} Start`,
      type: "marker",
      geometryType: "Point",
      iconKind: "start",
      coordinates: [{ lat: first.lat, lon: first.lon, iconKind: "start" }],
      sortOrder: (Number(section.sortOrder) || 0) + 0.1,
      active: true,
      synthetic: true,
      flagStatus: "green",
      flagTs: 0,
      flagTargets: [],
    });
    out.push({
      id: `${section.id}__ss-finish`,
      name: `${base} Finish`,
      label: `${base} Finish`,
      type: "marker",
      geometryType: "Point",
      iconKind: "finish",
      coordinates: [{ lat: last.lat, lon: last.lon, iconKind: "finish" }],
      sortOrder: (Number(section.sortOrder) || 0) + 0.2,
      active: true,
      synthetic: true,
      flagStatus: "green",
      flagTs: 0,
      flagTargets: [],
    });
  }
  return out;
}

/**
 * @param {Array<object>} sections
 * @param {boolean} enabled
 */
function withStageStartFinishMarkers(sections, enabled) {
  const list = Array.isArray(sections) ? sections : [];
  if (!enabled) return list;
  return [...list, ...buildStageStartFinishMarkers(list)];
}

/**
 * Resolve Start or Finish coords for a stage section (line ends).
 * @param {Array<object>} sections
 * @param {string} sectionId
 * @param {"start"|"finish"} point
 * @returns {{ lat: number, lon: number, sectionId: string, point: string, label: string } | null}
 */
function resolveStageEndpoint(sections, sectionId, point) {
  const id = String(sectionId || "").trim();
  const which = String(point || "").trim().toLowerCase() === "finish" ? "finish" : "start";
  if (!id || !Array.isArray(sections)) return null;
  const section = sections.find(
    (s) =>
      s &&
      !s.synthetic &&
      String(s.id) === id &&
      s.type === "stage" &&
      s.active !== false,
  );
  if (!section) return null;
  if (section.geometryType === "Polygon") return null;
  const coords = Array.isArray(section.coordinates) ? section.coordinates : [];
  if (coords.length < 2) return null;
  const c = which === "finish" ? coords[coords.length - 1] : coords[0];
  if (!c || !Number.isFinite(c.lat) || !Number.isFinite(c.lon)) return null;
  const base = stageBaseName(section);
  return {
    lat: c.lat,
    lon: c.lon,
    sectionId: section.id,
    point: which,
    label: `${base} ${which === "finish" ? "Finish" : "Start"}`,
  };
}

module.exports = {
  buildStageStartFinishMarkers,
  withStageStartFinishMarkers,
  resolveStageEndpoint,
};
