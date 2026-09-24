const crypto = require("crypto");

const COOKIE = "rally_control";
const DEFAULT_USERNAME = "admiin";
const DEFAULT_PASSWORD = "rallycontrol";
/** Organiser PIN hashed onto rallies with no driver stop code. Never send to driver clients. */
const DEFAULT_DRIVER_STOP_CODE = "192421";
const SESSION_MS = 7 * 24 * 60 * 60 * 1000;

function sessionSecret() {
  return (
    process.env.CONTROL_SESSION_SECRET ||
    process.env.SUPABASE_SERVICE_ROLE_KEY ||
    process.env.SUPABASE_URL ||
    "rally-gps-control-session"
  );
}

function hashPassword(password, salt = crypto.randomBytes(16).toString("hex")) {
  const hash = crypto.scryptSync(String(password), salt, 64).toString("hex");
  return { salt, hash };
}

function verifyPassword(password, salt, hash) {
  if (!salt || !hash) return false;
  const next = crypto.scryptSync(String(password), salt, 64);
  const prev = Buffer.from(String(hash), "hex");
  if (next.length !== prev.length) return false;
  return crypto.timingSafeEqual(next, prev);
}

function b64url(value) {
  return Buffer.from(value).toString("base64url");
}

function signPayload(payload) {
  const body = b64url(JSON.stringify(payload));
  const sig = crypto.createHmac("sha256", sessionSecret()).update(body).digest("base64url");
  return `${body}.${sig}`;
}

function readPayload(token) {
  if (!token || !token.includes(".")) return null;
  const [body, sig] = token.split(".");
  const expected = crypto.createHmac("sha256", sessionSecret()).update(body).digest("base64url");
  const a = Buffer.from(sig);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
  try {
    const payload = JSON.parse(Buffer.from(body, "base64url").toString("utf8"));
    if (!payload?.u || !payload.exp || payload.exp < Date.now()) return null;
    return payload;
  } catch {
    return null;
  }
}

function parseCookies(req) {
  const header = String(req.headers.cookie || "");
  const out = {};
  for (const part of header.split(";")) {
    const idx = part.indexOf("=");
    if (idx < 0) continue;
    const key = part.slice(0, idx).trim();
    const value = part.slice(idx + 1).trim();
    try {
      out[key] = decodeURIComponent(value);
    } catch {
      out[key] = value;
    }
  }
  return out;
}

function makeToken(user) {
  return signPayload({
    u: user.username,
    exp: Date.now() + SESSION_MS,
    mc: Boolean(user.mustChangePassword),
  });
}

function cookieHeader(token, req) {
  const secure = String(req.headers["x-forwarded-proto"] || req.protocol).includes("https");
  return `${COOKIE}=${token}; HttpOnly; Path=/; Max-Age=${Math.floor(
    SESSION_MS / 1000
  )}; SameSite=Lax${secure ? "; Secure" : ""}`;
}

function clearCookieHeader(req) {
  const secure = String(req.headers["x-forwarded-proto"] || req.protocol).includes("https");
  return `${COOKIE}=; HttpOnly; Path=/; Max-Age=0; SameSite=Lax${secure ? "; Secure" : ""}`;
}

function sessionFromRequest(req) {
  const cookies = parseCookies(req);
  const queryToken = String(req.query?.t || req.query?.token || "");
  const payload = readPayload(cookies[COOKIE] || queryToken);
  if (!payload) return null;
  return {
    username: payload.u,
    mustChangePassword: Boolean(payload.mc),
    token: cookies[COOKIE] || queryToken,
  };
}

const DRIVER_POST = new Set([
  "/api/register",
  "/api/ping",
  "/api/ping-batch",
  "/api/poll",
  "/api/crew-status",
  "/api/flag-ack",
  "/api/stop",
]);

function isPublicPath(req) {
  const p = req.path;
  if (p === "/api/login" || p === "/api/health") return true;
  if (p === "/api/logout" || p === "/api/password" || p === "/api/me") return true;
  if (req.method === "POST" && DRIVER_POST.has(p)) return true;
  if (req.method === "GET" && p === "/api/sections") return true;
  if (req.method === "GET" && p === "/api/stop-lock") return true;
  if (req.method === "GET" && p === "/api/test/session") return true;
  if (req.method === "POST" && (p === "/api/test/crew-status" || p === "/api/test/flag-ack")) return true;
  if (req.method !== "GET") return false;
  if (p === "/" || p === "/index.html" || p === "/driver.html" || p === "/control-login.html") return true;
  if (p === "/test-driver.html" || p === "/test-driver") return true;
  if (p === "/js/driver.js" || p === "/js/login.js" || p === "/js/test-driver.js") return true;
  if (p.startsWith("/css/") || p.startsWith("/icons/") || p.startsWith("/audio/") || p === "/manifest.json" || p === "/favicon.ico") {
    return true;
  }
  return false;
}

function protectControl(req, res, next) {
  if (isPublicPath(req)) return next();
  const session = sessionFromRequest(req);
  if (!session) {
    if (req.path.startsWith("/api/") || req.path.endsWith(".kml")) {
      return res.status(401).json({ error: "Sign in to race control." });
    }
    if (req.path === "/control.html" || req.path === "/control") {
      return res.redirect("/control-login.html");
    }
    if (req.path === "/test.html" || req.path === "/test") {
      return res.redirect("/control-login.html?next=/test");
    }
    if (req.path === "/js/control.js" || req.path === "/js/test.js") {
      return res.status(401).type("text/plain").send("Sign in to race control.");
    }
    return next();
  }
  req.controlUser = session;
  const changing =
    req.path === "/control-login.html" ||
    req.path === "/api/password" ||
    req.path === "/api/logout" ||
    req.path === "/api/me" ||
    req.path === "/test.html" ||
    req.path === "/test" ||
    req.path === "/js/test.js" ||
    req.path === "/api/test/session";
  if (session.mustChangePassword && !changing) {
    if (req.path.startsWith("/api/") || req.path.endsWith(".kml")) {
      return res.status(403).json({ error: "Change your password first.", mustChangePassword: true });
    }
    if (req.path === "/control.html" || req.path === "/control") {
      return res.redirect("/control-login.html?change=1");
    }
    if (req.path === "/js/control.js" || req.path === "/js/test.js") {
      return res.status(403).type("text/plain").send("Change your password first.");
    }
  }
  next();
}

module.exports = {
  DEFAULT_USERNAME,
  DEFAULT_PASSWORD,
  DEFAULT_DRIVER_STOP_CODE,
  hashPassword,
  verifyPassword,
  makeToken,
  cookieHeader,
  clearCookieHeader,
  sessionFromRequest,
  protectControl,
};
