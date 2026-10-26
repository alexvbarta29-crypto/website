// Sign-in for /payroll (crew pay sheets): the password check and the
// year-long cookie, shared by the page and its data route
// (functions/payroll.mjs). Same scheme as /lights (lib/lights-auth.mjs).
//
// Password: the PAYROLL_PASSWORD Netlify env var. There is no default: until
// it is set, /payroll only says it isn't set up yet. The cookie is the PBKDF2
// key itself, which only someone who knows the password can make. Changing
// the password signs every device out.

import { pbkdf2Sync, createHash, timingSafeEqual } from "node:crypto";

const SALT = "barta-payroll-v1";
const ITERATIONS = 210000;
export const COOKIE = "barta_payroll";
export const ONE_YEAR = 365 * 24 * 60 * 60;

export const derive = (pw) => pbkdf2Sync(String(pw), SALT, ITERATIONS, 32, "sha256").toString("hex");
export const sha256 = (s) => createHash("sha256").update(String(s)).digest("hex");
export const same = (a, b) => a.length === b.length && timingSafeEqual(Buffer.from(a), Buffer.from(b));

let envCache = null;
/** sha256(PBKDF2(password)), or "" when no password is set. */
export function expected() {
  const pw = String(process.env.PAYROLL_PASSWORD || "");
  if (!pw) return "";
  if (!envCache || envCache.pw !== pw) envCache = { pw, check: sha256(derive(pw)) };
  return envCache.check;
}

export function readCookie(req) {
  const raw = req.headers.get("cookie") || "";
  for (const part of raw.split(";")) {
    const i = part.indexOf("=");
    if (i > 0 && part.slice(0, i).trim() === COOKIE) return decodeURIComponent(part.slice(i + 1).trim());
  }
  return "";
}

export const signedIn = (req) => {
  const check = expected();
  const token = readCookie(req);
  return !!check && /^[0-9a-f]{64}$/.test(token) && same(sha256(token), check);
};

export const cookieFor = (token, maxAge) =>
  `${COOKIE}=${token}; Path=/payroll; Max-Age=${maxAge}; HttpOnly; Secure; SameSite=Lax`;
