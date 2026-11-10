// Barta CRM core: HTTP plumbing shared by the CRM functions (design §0
// rules 7-8, §2.2, §2.3, §4.7).
//
// - Headers: private HTML (no-store, noindex, same-origin referrer,
//   SAMEORIGIN framing: the shell lives inside /office) and JSON.
// - The CSP every /crm page sends (§2.3): script-src 'self', no inline
//   script. The legacy Customers page (moved unchanged from the first slice
//   to /crm/legacy until M2a replaces it) keeps its inline scripts, so its
//   CSP lists their sha256 hashes instead of 'unsafe-inline'.
// - Cookies: parse and build (HttpOnly; Secure; SameSite=Lax; Path=/).
// - The client version gate (MIN_CLIENT, MIN_REPLAY_CLIENT, step 5).
// - Bodies are read streamed under a byte cap (413 before buffering a huge
//   upload), like the first slice's readBodyText.
// - Post-sign-in destinations: only /office... or /crm... (§4.11).

import { createHash } from "node:crypto";

// The oldest client (crm-app/version.js APP_VERSION) the API still serves,
// and the one below it that offline-outbox (replaySafe) routes still accept,
// so a phone's queued work lands after a deploy (§2.2 step 5).
export const MIN_CLIENT = "2026.11.10-1";
export const MIN_REPLAY_CLIENT = "2026.11.10-1";
// Client versions are "yyyy.mm.dd-n": compare the date, then n.
export function compareVersions(a, b) {
  const parse = (v) => {
    const m = /^(\d{4})\.(\d{2})\.(\d{2})-(\d+)$/.exec(String(v || ""));
    return m ? [Number(m[1]), Number(m[2]), Number(m[3]), Number(m[4])] : null;
  };
  const x = parse(a), y = parse(b);
  if (!x || !y) return x ? 1 : y ? -1 : 0;
  for (let i = 0; i < 4; i++) if (x[i] !== y[i]) return x[i] < y[i] ? -1 : 1;
  return 0;
}

export const CSP = "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; font-src 'self'; connect-src 'self'; worker-src 'self'; manifest-src 'self'; object-src 'none'; base-uri 'none'; form-action 'self'; frame-ancestors 'self'";

export const PRIVATE_HEADERS = Object.freeze({
  "Cache-Control": "private, no-store",
  "X-Robots-Tag": "noindex, nofollow",
  "Referrer-Policy": "same-origin",
});
export const HTML_HEADERS = Object.freeze({
  ...PRIVATE_HEADERS,
  "Content-Type": "text/html; charset=utf-8",
  "X-Frame-Options": "SAMEORIGIN",
  "X-Content-Type-Options": "nosniff",
});
export const JSON_HEADERS = Object.freeze({
  "Cache-Control": "no-store",
  "X-Robots-Tag": "noindex, nofollow",
  "Referrer-Policy": "same-origin",
  "X-Content-Type-Options": "nosniff",
});

// The sha256 CSP sources of every executable inline <script> in a page
// (no src, no type or a JavaScript type). The legacy page only.
export function inlineScriptHashes(html) {
  const out = [];
  const re = /<script(\s[^>]*)?>([\s\S]*?)<\/script>/gi;
  let m;
  while ((m = re.exec(String(html)))) {
    const attrs = m[1] || "";
    if (/\ssrc\s*=/i.test(attrs)) continue;
    const type = /\stype\s*=\s*["']?([^"'\s>]+)/i.exec(attrs);
    if (type && !/^(text\/javascript|module|application\/javascript)$/i.test(type[1])) continue;
    out.push(`'sha256-${createHash("sha256").update(m[2], "utf8").digest("base64")}'`);
  }
  return [...new Set(out)];
}
export const cspWithHashes = (hashes) => (hashes.length ? CSP.replace("script-src 'self'", `script-src 'self' ${hashes.join(" ")}`) : CSP);

// A /crm HTML page with the strict CSP.
export function htmlPage(body, status = 200, extra = {}) {
  return new Response(body, { status, headers: { ...HTML_HEADERS, "Content-Security-Policy": CSP, ...extra } });
}
// A legacy page: its own inline scripts are allowed by hash, nothing else.
export function legacyPage(body, status = 200, extra = {}) {
  return new Response(body, { status, headers: { ...HTML_HEADERS, "Content-Security-Policy": cspWithHashes(inlineScriptHashes(body)), ...extra } });
}

export function json(body, status = 200, extra = {}) {
  return Response.json(body, { status, headers: { ...JSON_HEADERS, ...extra } });
}
export const ok = (data, meta, status = 200, extra = {}) => json(meta ? { ok: true, data, meta } : { ok: true, data }, status, extra);
export function fail(code, message, status, { field, details, headers } = {}) {
  const error = { code, message };
  if (field) error.field = field;
  if (details !== undefined) error.details = details;
  return json({ ok: false, error }, status, headers || {});
}

export function redirect(location, status = 302, extra = {}) {
  return new Response(null, { status, headers: { ...PRIVATE_HEADERS, Location: location, ...extra } });
}

// ------------------------------------------------------------ cookies

export function readCookies(req) {
  const out = {};
  const raw = req.headers.get("cookie") || "";
  for (const part of raw.split(";")) {
    const i = part.indexOf("=");
    if (i <= 0) continue;
    const name = part.slice(0, i).trim();
    if (Object.hasOwn(out, name)) continue;
    try { out[name] = decodeURIComponent(part.slice(i + 1).trim()); } catch { out[name] = ""; }
  }
  return out;
}
export const readCookie = (req, name) => readCookies(req)[name] ?? "";

export function cookie(name, value, maxAge) {
  return `${name}=${encodeURIComponent(value)}; Path=/; Max-Age=${maxAge}; HttpOnly; Secure; SameSite=Lax`;
}
export const clearCookie = (name) => `${name}=; Path=/; Max-Age=0; HttpOnly; Secure; SameSite=Lax`;

// A Response with several Set-Cookie headers.
export function withCookies(res, cookies) {
  for (const c of cookies) if (c) res.headers.append("Set-Cookie", c);
  return res;
}

// ------------------------------------------------------------ bodies

export class BodyTooLarge extends Error {}

// The body as bytes, giving up as soon as it passes `max`.
export async function readBodyBytes(req, max) {
  const declared = Number(req.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > max) throw new BodyTooLarge();
  if (!req.body) return new Uint8Array(0);
  const reader = req.body.getReader();
  const chunks = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > max) { await reader.cancel().catch(() => {}); throw new BodyTooLarge(); }
    chunks.push(value);
  }
  return new Uint8Array(Buffer.concat(chunks));
}
export async function readBodyText(req, max) {
  return Buffer.from(await readBodyBytes(req, max)).toString("utf8");
}

export const contentType = (req) => String(req.headers.get("content-type") || "").split(";")[0].trim().toLowerCase();

// ------------------------------------------------------------ destinations

export const DEFAULT_TO = "/office#crm";
const TO_RE = /^\/(office|crm)(#|\/|$)/;
// A post-sign-in destination: same-site paths under /office or /crm only.
export function safeTo(to, fallback = DEFAULT_TO) {
  const s = typeof to === "string" ? to.trim() : "";
  if (!s || s.length > 300 || !TO_RE.test(s) || s.includes("//") || /[\\\s]/.test(s) || /(^|\/)\.\.?(\/|#|$)/.test(s.split("#")[0])) return fallback;
  return s;
}

// The client IP the platform saw (context.ip, else Netlify's header).
export function clientIp(req, context) {
  const ip = (context && typeof context.ip === "string" && context.ip) || req.headers.get("x-nf-client-connection-ip") || req.headers.get("x-forwarded-for") || "";
  return String(ip).split(",")[0].trim().slice(0, 64) || "unknown";
}

// "iPhone Safari", "Android Chrome", "Mac Chrome": a family, never the full string.
export function uaFamily(ua) {
  const s = String(ua || "");
  const device = /iPhone/.test(s) ? "iPhone" : /iPad/.test(s) ? "iPad" : /Android/.test(s) ? "Android" : /Macintosh|Mac OS X/.test(s) ? "Mac" : /Windows/.test(s) ? "Windows" : /Linux/.test(s) ? "Linux" : "Device";
  const browser = /Edg\//.test(s) ? "Edge" : /CriOS|Chrome\//.test(s) ? "Chrome" : /FxiOS|Firefox\//.test(s) ? "Firefox" : /Safari\//.test(s) ? "Safari" : "Browser";
  return `${device} ${browser}`;
}

export const sha256Hex = (s) => createHash("sha256").update(String(s)).digest("hex");
