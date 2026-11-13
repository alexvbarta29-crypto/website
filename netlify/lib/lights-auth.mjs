// Sign-in for the office tools: /office, /lights (Barta Light Studio and its
// Street View lookup) and /playbook all share this one password and one
// year-long cookie, so signing in once opens all of them.
//
// Password: the owner's chosen office password (kept here only as a slow
// PBKDF2 digest), or the OFFICE_PASSWORD Netlify env var when that is set. The
// cookie is the PBKDF2 key itself, which only someone who knows the password
// can make. Changing the password signs every device out.
//
// The same cookie also comes with a CRM sign-in (owners and the office,
// never techs; core/auth.mjs): then its value is "c1.{userId}.{issued}.{mac}",
// an HMAC-SHA256 the server alone can make (a key derived from the CRM's key
// salt, else one random per process), over the user, the time it was issued
// and the office password's digest, so changing the office password signs
// these out too. The browser keeps it a year like the password's, but the
// server takes it for CRM_OFFICE_DAYS (30) from `issued`: /office issues a
// fresh one on every visit with a CRM session (a tool's "sign in" bounce
// lands there too), and clears it on sign-out or when the CRM session is
// gone, so a login that is turned off loses the tools within 30 days even
// on a browser that never opens /office again. signedIn() takes either form, so every tool page
// keeps its own check unchanged.

import { pbkdf2Sync, createHash, createHmac, hkdfSync, randomBytes, timingSafeEqual } from "node:crypto";
import { keySalt } from "./crm/core/context.mjs";
import { nowMs } from "./crm/core/clock.mjs";

const SALT = "barta-light-studio-v1";
const ITERATIONS = 210000;
// sha256(PBKDF2(default password))
const DEFAULT_CHECK = "1790b0ef9e400629c086f0a5744894da1e0528658aa2217136197eef7b163f9a";
export const COOKIE = "barta_office";
export const ONE_YEAR = 365 * 24 * 60 * 60;

export const derive = (pw) => pbkdf2Sync(String(pw), SALT, ITERATIONS, 32, "sha256").toString("hex");
export const sha256 = (s) => createHash("sha256").update(String(s)).digest("hex");
export const same = (a, b) => a.length === b.length && timingSafeEqual(Buffer.from(a), Buffer.from(b));

let envCache = null;
export function expected() {
  const pw = String(process.env.OFFICE_PASSWORD || "");
  if (!pw) return DEFAULT_CHECK;
  if (!envCache || envCache.pw !== pw) envCache = { pw, check: sha256(derive(pw)) };
  return envCache.check;
}

export function readCookie(req) {
  const raw = req.headers.get("cookie") || "";
  for (const part of raw.split(";")) {
    const i = part.indexOf("=");
    if (i <= 0 || part.slice(0, i).trim() !== COOKIE) continue;
    // A malformed value ("%E0%A4%A") is just a wrong cookie, not a crash.
    try { return decodeURIComponent(part.slice(i + 1).trim()); } catch { return ""; }
  }
  return "";
}

// The office password's own cookie (the PBKDF2 key).
export const passwordSignedIn = (req) => {
  const check = expected();
  const token = readCookie(req);
  return !!check && /^[0-9a-f]{64}$/.test(token) && same(sha256(token), check);
};

// ---- the office cookie a CRM sign-in issues (owners and the office)
const CRM_RE = /^c1\.(us_[0-9a-hjkmnp-tv-z]{20})\.(\d{9,11})\.([A-Za-z0-9_-]{43})$/;
const SKEW_S = 300;
export const CRM_OFFICE_DAYS = 30;
let macKey = null;   // { salt, key }
let processKey = null;
function crmKey() {
  const salt = keySalt();
  if (!salt) return (processKey ||= randomBytes(32));
  if (!macKey || macKey.salt !== salt) macKey = { salt, key: Buffer.from(hkdfSync("sha256", Buffer.from(salt), Buffer.from("barta-office"), Buffer.from("crm office cookie v1"), 32)) };
  return macKey.key;
}
const crmMac = (uid, issued) => createHmac("sha256", crmKey()).update(`barta_office|c1|${uid}|${issued}|${expected()}`).digest("base64url");

// The value for this user, issued now.
export function crmOfficeToken(uid, at = nowMs()) {
  const issued = Math.floor(at / 1000);
  return `c1.${uid}.${issued}.${crmMac(uid, issued)}`;
}
// The user a CRM-issued office cookie names, when it is good; else null.
export function crmOfficeUser(req) {
  const m = CRM_RE.exec(readCookie(req));
  if (!m) return null;
  const issued = Number(m[2]);
  const t = Math.floor(nowMs() / 1000);
  if (!(issued <= t + SKEW_S && t - issued < CRM_OFFICE_DAYS * 86400)) return null;
  return same(crmMac(m[1], issued), m[3]) ? m[1] : null;
}
// "password" | "crm" | null: which office cookie this request carries.
export const officeCookieKind = (req) => (passwordSignedIn(req) ? "password" : crmOfficeUser(req) ? "crm" : null);

export const signedIn = (req) => passwordSignedIn(req) || !!crmOfficeUser(req);

export const cookieFor = (token, maxAge) =>
  `${COOKIE}=${token}; Path=/; Max-Age=${maxAge}; HttpOnly; Secure; SameSite=Lax`;
export const crmOfficeCookie = (uid) => cookieFor(crmOfficeToken(uid), ONE_YEAR);
export const clearOfficeCookie = () => cookieFor("", 0);


// Signed out of an office tool: there's only one sign-in, at /office. Sends
// the whole window there (also when the tool is inside the Office app).
export function toOffice(tab) {
  const to = "/office" + (tab ? "#" + tab : "");
  return new Response(`<!doctype html><meta charset="utf-8"><meta name="robots" content="noindex, nofollow"><title>Barta Office</title>
<script>try{(window.top||window).location.href=${JSON.stringify(to)}}catch(e){location.href=${JSON.stringify(to)}}</script>
<p style="font:16px system-ui;margin:40px;text-align:center"><a href="${to}">Sign in to Barta Office</a></p>`, {
    status: 200,
    headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "private, no-store", "X-Robots-Tag": "noindex, nofollow" },
  });
}
