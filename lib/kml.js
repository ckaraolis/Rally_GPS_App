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
  if (type === "marker") return clean || "Placemark";
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
  const iconColor = styleXml.match(/<IconStyle\b[\s\S]*?<color[^>]*>([\s\S]*?)<\/color>/i);
  if (iconColor) return parseKmlColor(decodeXmlEntities(iconColor[1]));
  const polyColor = styleXml.match(/<PolyStyle\b[\s\S]*?<color[^>]*>([\s\S]*?)<\/color>/i);
  if (polyColor) return parseKmlColor(decodeXmlEntities(polyColor[1]));
  const anyColor = styleXml.match(/<color[^>]*>([\s\S]*?)<\/color>/i);
  if (anyColor) return parseKmlColor(decodeXmlEntities(anyColor[1]));
  return null;
}

function extractIconHref(styleXml) {
  if (!styleXml) return null;
  const match =
    styleXml.match(/<IconStyle\b[\s\S]*?<href[^>]*>([\s\S]*?)<\/href>/i) ||
    styleXml.match(/<Icon\b[\s\S]*?<href[^>]*>([\s\S]*?)<\/href>/i);
  const href = match ? decodeXmlEntities(match[1]) : "";
  return href || null;
}

function extractStyleInfo(styleXml) {
  return {
    colorRgb: extractColorFromStyleXml(styleXml),
    iconHref: extractIconHref(styleXml),
  };
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

/** Google Earth-style pin: TC, Start, Finish, Stop, Refueling */
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

function buildStyleIndex(kmlText) {
  /** @type {Map<string, {colorRgb: object|null, iconHref: string|null}>} */
  const styles = new Map();

  const styleRe = /<Style\b([^>]*)>([\s\S]*?)<\/Style>/gi;
  let match;
  while ((match = styleRe.exec(kmlText))) {
    const attrs = match[1] || "";
    const body = match[2] || "";
    const idMatch = attrs.match(/\bid\s*=\s*["']([^"']+)["']/i);
    if (!idMatch) continue;
    styles.set(idMatch[1], extractStyleInfo(body));
  }

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

function resolvePlacemarkStyle(xml, styleIndex) {
  const inline = extractStyleInfo(xml);
  const styleUrlMatch = xml.match(/<styleUrl[^>]*>([\s\S]*?)<\/styleUrl>/i);
  const href = styleUrlMatch ? decodeXmlEntities(styleUrlMatch[1]).replace(/^#/, "").trim() : "";
  const linked = href ? styleIndex.get(href) : null;
  return {
    colorRgb: inline.colorRgb || linked?.colorRgb || null,
    iconHref: inline.iconHref || linked?.iconHref || null,
  };
}

function resolvePlacemarkColor(xml, styleIndex) {
  return resolvePlacemarkStyle(xml, styleIndex).colorRgb;
}

function parseGeometryBlocks(xml, tag) {
  const blocks = xml.match(new RegExp(`<(?:[\\w]+:)?${tag}\\b[\\s\\S]*?<\\/(?:[\\w]+:)?${tag}>`, "gi")) || [];
  return blocks
    .map((block) => {
      const coordMatch = block.match(/<coordinates[^>]*>([\s\S]*?)<\/coordinates>/i);
      return parseCoordinateTuples(coordMatch ? coordMatch[1] : "");
    })
    .filter((coords) => coords.length);
}

function resolveIconHref(href, iconFiles = {}) {
  const raw = String(href || "")
    .trim()
    .replace(/\\/g, "/");
  if (!raw) return null;
  if (raw.startsWith("data:image/")) return raw;
  if (/^https?:\/\//i.test(raw)) return raw.replace(/^http:\/\//i, "https://");
  const lower = raw.replace(/^\.\//, "").toLowerCase();
  const names = Object.keys(iconFiles);
  const hit =
    names.find((name) => name.replace(/\\/g, "/").toLowerCase() === lower) ||
    names.find((name) => name.replace(/\\/g, "/").toLowerCase().endsWith("/" + lower)) ||
    names.find((name) => name.replace(/\\/g, "/").toLowerCase().endsWith(lower));
  return hit ? iconFiles[hit] : raw;
}

function parsePlacemark(xml, index, styleIndex, iconFiles = {}) {
  const nameMatch = xml.match(/<name[^>]*>([\s\S]*?)<\/name>/i);
  const name = decodeXmlEntities(nameMatch ? nameMatch[1] : `Section ${index + 1}`) || `Section ${index + 1}`;
  const style = resolvePlacemarkStyle(xml, styleIndex);
  const colorRgb = style.colorRgb;
  const items = [];
  let sub = 0;

  for (const coordinates of parseGeometryBlocks(xml, "LineString")) {
    if (coordinates.length < 2) continue;
    const type = classifySection(name, colorRgb);
    items.push({
      id: crypto.randomUUID(),
      name,
      type,
      label: buildLabel(name, type),
      geometryType: "LineString",
      coordinates,
      colorRgb,
      sortOrder: index * 20 + sub,
      active: true,
      flagStatus: "green",
      flagTs: 0,
    });
    sub += 1;
  }

  for (const coordinates of parseGeometryBlocks(xml, "Polygon")) {
    if (coordinates.length < 2) continue;
    const type = classifySection(name, colorRgb);
    items.push({
      id: crypto.randomUUID(),
      name,
      type,
      label: buildLabel(name, type),
      geometryType: "Polygon",
      coordinates,
      colorRgb,
      sortOrder: index * 20 + sub,
      active: true,
      flagStatus: "green",
      flagTs: 0,
    });
    sub += 1;
  }

  for (const coordinates of parseGeometryBlocks(xml, "Point")) {
    const point = coordinates[0];
    if (!point) continue;
    const iconKind = classifyPinKind(name, style.iconHref);
    const iconHref = resolveIconHref(style.iconHref, iconFiles);
    items.push({
      id: crypto.randomUUID(),
      name,
      type: "marker",
      label: buildLabel(name, "marker"),
      geometryType: "Point",
      coordinates: [{ lat: point.lat, lon: point.lon, iconKind, iconHref }],
      iconKind,
      iconHref,
      colorRgb,
      sortOrder: index * 20 + sub,
      active: true,
      flagStatus: "green",
      flagTs: 0,
    });
    sub += 1;
  }

  return items;
}

function parseKml(kmlText, sourceFile = "upload.kml", iconFiles = {}) {
  const styleIndex = buildStyleIndex(kmlText);
  const blocks = extractPlacemarks(kmlText);
  const sections = [];
  blocks.forEach((block, index) => {
    for (const section of parsePlacemark(block, index, styleIndex, iconFiles)) {
      section.sourceFile = sourceFile;
      sections.push(section);
    }
  });
  return sections;
}

function iconMimeFromZipName(name) {
  const lower = String(name || "").toLowerCase();
  if (lower.endsWith(".jpg") || lower.endsWith(".jpeg")) return "image/jpeg";
  if (lower.endsWith(".gif")) return "image/gif";
  if (lower.endsWith(".svg")) return "image/svg+xml";
  if (lower.endsWith(".webp")) return "image/webp";
  return "image/png";
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
  const iconFiles = {};
  for (const name of Object.keys(zip.files)) {
    if (zip.files[name].dir) continue;
    if (!/\.(png|jpe?g|gif|svg|webp)$/i.test(name)) continue;
    const data = await zip.files[name].async("base64");
    if (!data) continue;
    iconFiles[name.replace(/\\/g, "/")] = `data:${iconMimeFromZipName(name)};base64,${data}`;
  }
  return parseKml(kmlText, filename, iconFiles);
}

module.exports = {
  parseKml,
  parseKmzOrKml,
  classifySection,
  classifyByColor,
  classifyPinKind,
  looksLikeRefuel,
  parseKmlColor,
  buildLabel,
};
