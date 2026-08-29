const crypto = require("crypto");
const JSZip = require("jszip");

function decodeXmlEntities(value) {
  return String(value || "")
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .trim();
}

function parseCoordinateTuples(text) {
  return String(text || "")
    .trim()
    .split(/\s+/)
    .map((tuple) => tuple.trim())
    .filter(Boolean)
    .map((tuple) => {
      const parts = tuple.split(",");
      const lon = Number(parts[0]);
      const lat = Number(parts[1]);
      if (!Number.isFinite(lat) || !Number.isFinite(lon)) return null;
      return { lat, lon };
    })
    .filter(Boolean);
}

function classifySection(name, folderHint = "") {
  const text = `${folderHint} ${name}`.toLowerCase().trim();
  const bare = name.toLowerCase().trim();

  // Explicit stage names first
  if (/^(ss|special\s*stage)\s*\d+\b/.test(bare)) return "stage";
  if (/^special\s*stage\b/.test(bare)) return "stage";

  // Liaison / road patterns win over incidental "SS1" in the destination
  if (/\bliaison\b|\broad\s*section\b|\btransit\b/.test(text)) return "road";
  if (/\b(to|→|->|–)\b/.test(bare) && !/^(ss|special)/.test(bare)) return "road";
  if (/\bservice\s*park\b/.test(bare) && /\b(to|→|->|–)\b/.test(bare)) return "road";

  if (/\bspecial\s*stage\b|\bss\s*\d+\b|\bss\d+\b/.test(bare)) return "stage";
  if (/\bstage\b/.test(bare) && !/\broad\b/.test(bare)) return "stage";
  return "road";
}

function buildLabel(name, type) {
  const clean = name.replace(/\s+/g, " ").trim();
  if (type === "stage") {
    return `Special stage: ${clean}`;
  }
  const toMatch = clean.match(/(.+?)\s+(?:to|→|->|–|-)\s+(.+)/i);
  if (toMatch) {
    return `Road section: ${toMatch[1].trim()} → ${toMatch[2].trim()}`;
  }
  return `Road section: ${clean}`;
}

function extractPlacemarks(kmlText) {
  const placemarks = [];
  const re = /<Placemark\b[\s\S]*?<\/Placemark>/gi;
  let match;
  while ((match = re.exec(kmlText))) {
    placemarks.push(match[0]);
  }
  return placemarks;
}

function parsePlacemark(xml, index) {
  const nameMatch = xml.match(/<name[^>]*>([\s\S]*?)<\/name>/i);
  const name = decodeXmlEntities(nameMatch ? nameMatch[1] : `Section ${index + 1}`);

  let geometryType = null;
  let coordinates = [];

  const lineMatch = xml.match(
    /<LineString\b[\s\S]*?<coordinates[^>]*>([\s\S]*?)<\/coordinates>[\s\S]*?<\/LineString>/i
  );
  const polyMatch = xml.match(
    /<Polygon\b[\s\S]*?<coordinates[^>]*>([\s\S]*?)<\/coordinates>[\s\S]*?<\/Polygon>/i
  );

  if (lineMatch) {
    geometryType = "LineString";
    coordinates = parseCoordinateTuples(lineMatch[1]);
  } else if (polyMatch) {
    geometryType = "Polygon";
    coordinates = parseCoordinateTuples(polyMatch[1]);
  } else {
    return null;
  }

  if (coordinates.length < 2) return null;

  const type = classifySection(name);
  return {
    id: crypto.randomUUID(),
    name,
    type,
    label: buildLabel(name, type),
    geometryType,
    coordinates,
    sortOrder: index,
    active: true,
  };
}

function parseKml(kmlText, sourceFile = "upload.kml") {
  const blocks = extractPlacemarks(kmlText);
  const sections = [];
  blocks.forEach((block, index) => {
    const section = parsePlacemark(block, index);
    if (section) {
      section.sourceFile = sourceFile;
      sections.push(section);
    }
  });
  return sections;
}

async function parseKmzOrKml(buffer, filename = "upload.kmz") {
  const lower = filename.toLowerCase();
  if (lower.endsWith(".kml")) {
    return parseKml(buffer.toString("utf8"), filename);
  }

  const zip = await JSZip.loadAsync(buffer);
  const kmlName =
    Object.keys(zip.files).find((n) => n.toLowerCase().endsWith("doc.kml")) ||
    Object.keys(zip.files).find((n) => n.toLowerCase().endsWith(".kml"));
  if (!kmlName) {
    throw new Error("KMZ archive has no .kml file inside.");
  }
  const kmlText = await zip.files[kmlName].async("string");
  return parseKml(kmlText, filename);
}

module.exports = {
  parseKml,
  parseKmzOrKml,
  classifySection,
  buildLabel,
};
