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

/** KML color is aabbggrr */
function parseKmlColor(raw) {
  const hex = String(raw || "")
    .replace(/[^0-9a-f]/gi, "")
    .toLowerCase();
  if (hex.length < 6) return null;
  const full = hex.padStart(8, "f").slice(-8);
  const b = parseInt(full.slice(2, 4), 16);
  const g = parseInt(full.slice(4, 6), 16);
  const r = parseInt(full.slice(6, 8), 16);
  if (![r, g, b].every((n) => Number.isFinite(n))) return null;
  return { r, g, b };
}

/**
 * Rally rule:
 * - RED line  => special stage
 * - BLUE line => road section
 */
function classifyByColor(rgb) {
  if (!rgb) return null;
  const { r, g, b } = rgb;
  const redLead = r - Math.max(g, b);
  const blueLead = b - Math.max(r, g);

  if (r >= 140 && redLead >= 25) return "stage";
  if (b >= 140 && blueLead >= 25) return "road";

  // Soft fallback if tinted
  if (r > b + 40 && r >= g) return "stage";
  if (b > r + 40 && b >= g) return "road";
  return null;
}

function classifyByName(name) {
  const bare = String(name || "")
    .toLowerCase()
    .trim();
  if (/^(ss|special\s*stage)\s*\d+\b/.test(bare)) return "stage";
  if (/^special\s*stage\b/.test(bare)) return "stage";
  if (/\bliaison\b|\broad\s*section\b|\btransit\b/.test(bare)) return "road";
  if (/\b(to|→|->|–)\b/.test(bare) && !/^(ss|special)/.test(bare)) return "road";
  if (/\bspecial\s*stage\b|\bss\s*\d+\b|\bss\d+\b/.test(bare)) return "stage";
  return "road";
}

function classifySection(name, colorRgb = null) {
  return classifyByColor(colorRgb) || classifyByName(name);
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

function extractColorFromStyleXml(styleXml) {
  if (!styleXml) return null;
  const lineColor = styleXml.match(/<LineStyle\b[\s\S]*?<color[^>]*>([\s\S]*?)<\/color>/i);
  if (lineColor) return parseKmlColor(decodeXmlEntities(lineColor[1]));
  const polyColor = styleXml.match(/<PolyStyle\b[\s\S]*?<color[^>]*>([\s\S]*?)<\/color>/i);
  if (polyColor) return parseKmlColor(decodeXmlEntities(polyColor[1]));
  const anyColor = styleXml.match(/<color[^>]*>([\s\S]*?)<\/color>/i);
  if (anyColor) return parseKmlColor(decodeXmlEntities(anyColor[1]));
  return null;
}

function buildStyleIndex(kmlText) {
  /** @type {Map<string, {r:number,g:number,b:number}|null>} */
  const styles = new Map();

  const styleRe = /<Style\b([^>]*)>([\s\S]*?)<\/Style>/gi;
  let match;
  while ((match = styleRe.exec(kmlText))) {
    const attrs = match[1] || "";
    const body = match[2] || "";
    const idMatch = attrs.match(/\bid\s*=\s*["']([^"']+)["']/i);
    if (!idMatch) continue;
    styles.set(idMatch[1], extractColorFromStyleXml(body));
  }

  // StyleMap: use the "normal" alias target
  const mapRe = /<StyleMap\b([^>]*)>([\s\S]*?)<\/StyleMap>/gi;
  while ((match = mapRe.exec(kmlText))) {
    const attrs = match[1] || "";
    const body = match[2] || "";
    const idMatch = attrs.match(/\bid\s*=\s*["']([^"']+)["']/i);
    if (!idMatch) continue;
    const pairs = body.match(/<Pair\b[\s\S]*?<\/Pair>/gi) || [];
    let normalHref = null;
    for (const pair of pairs) {
      const key = (pair.match(/<key[^>]*>([\s\S]*?)<\/key>/i) || [])[1];
      const href = (pair.match(/<styleUrl[^>]*>([\s\S]*?)<\/styleUrl>/i) || [])[1];
      if (decodeXmlEntities(key).trim().toLowerCase() === "normal" && href) {
        normalHref = decodeXmlEntities(href).replace(/^#/, "").trim();
      }
    }
    if (normalHref && styles.has(normalHref)) {
      styles.set(idMatch[1], styles.get(normalHref));
    }
  }

  return styles;
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

function resolvePlacemarkColor(xml, styleIndex) {
  const inline = extractColorFromStyleXml(xml);
  if (inline) return inline;

  const styleUrlMatch = xml.match(/<styleUrl[^>]*>([\s\S]*?)<\/styleUrl>/i);
  if (!styleUrlMatch) return null;
  const href = decodeXmlEntities(styleUrlMatch[1]).replace(/^#/, "").trim();
  if (!href) return null;
  return styleIndex.get(href) || null;
}

function parsePlacemark(xml, index, styleIndex) {
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

  const colorRgb = resolvePlacemarkColor(xml, styleIndex);
  const type = classifySection(name, colorRgb);
  return {
    id: crypto.randomUUID(),
    name,
    type,
    label: buildLabel(name, type),
    geometryType,
    coordinates,
    colorRgb,
    sortOrder: index,
    active: true,
  };
}

function parseKml(kmlText, sourceFile = "upload.kml") {
  const styleIndex = buildStyleIndex(kmlText);
  const blocks = extractPlacemarks(kmlText);
  const sections = [];
  blocks.forEach((block, index) => {
    const section = parsePlacemark(block, index, styleIndex);
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
  classifyByColor,
  parseKmlColor,
  buildLabel,
};
