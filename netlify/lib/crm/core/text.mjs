// Barta CRM core: text helpers shared by server code (design §0 rules 6-7, §3.2).
//
// esc() is the one HTML escaper for server-rendered pages; jsonForHtml()
// embeds JSON in a non-executed <script type="application/json"> block.
// The masks give screens and logs a hint of an address without the address
// itself ("(763) •••-0100", "j•••@example.com"). keySafe() keeps a value
// inside the Blobs key alphabet of §3.2.

const HTML = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" };
export const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => HTML[c]);

// JSON safe inside <script type="application/json">: no "</script>" can close it.
export const jsonForHtml = (v) => JSON.stringify(v).replace(/</g, "\\u003c").replace(/\u2028/g, "\\u2028").replace(/\u2029/g, "\\u2029");

// Collapse runs of whitespace and trim.
export const squish = (s) => String(s ?? "").replace(/\s+/g, " ").trim();

// Cut to n characters (by code point), adding "…" when cut.
export function truncate(s, n) {
  const chars = Array.from(String(s ?? ""));
  return chars.length <= n ? chars.join("") : chars.slice(0, Math.max(0, n - 1)).join("") + "…";
}

const digits = (s) => String(s ?? "").replace(/\D/g, "");

// "+17635550100" / "763-555-0100" → "(763) •••-0100"; anything else → "•••".
export function maskPhone(v) {
  let d = digits(v);
  if (d.length === 11 && d[0] === "1") d = d.slice(1);
  if (d.length !== 10) return "•••";
  return `(${d.slice(0, 3)}) •••-${d.slice(6)}`;
}

// "jane@example.com" → "j•••@example.com".
export function maskEmail(v) {
  const s = String(v ?? "").trim().toLowerCase();
  const at = s.lastIndexOf("@");
  if (at < 1) return "•••";
  return `${s[0]}•••${s.slice(at)}`;
}

// The Blobs key alphabet (§3.2): lowercase letters, digits, - _ / . @
export const KEY_RE = /^[a-z0-9\-_/.@]+$/;
export const isKeySafe = (s) => typeof s === "string" && s.length > 0 && KEY_RE.test(s) && !s.startsWith("/");

// A key segment from free text: lowercase, anything outside the alphabet
// (and "/") becomes "-", never empty.
export function keySafe(s, max = 80) {
  const out = String(s ?? "").toLowerCase().replace(/[^a-z0-9\-_.@]+/g, "-").replace(/^-+|-+$/g, "").slice(0, max);
  return out || "x";
}
