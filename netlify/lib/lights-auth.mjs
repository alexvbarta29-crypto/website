// Sign-in for the office tools: /office, /lights (Barta Light Studio and its
// Street View lookup) and /playbook all share this one password and one
// year-long cookie, so signing in once opens all of them.
//
// Password: the owner's chosen office password (kept here only as a slow
// PBKDF2 digest), or the OFFICE_PASSWORD Netlify env var when that is set. The
// cookie is the PBKDF2 key itself, which only someone who knows the password
// can make. Changing the password signs every device out.

import { pbkdf2Sync, createHash, timingSafeEqual } from "node:crypto";

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
  `${COOKIE}=${token}; Path=/; Max-Age=${maxAge}; HttpOnly; Secure; SameSite=Lax`;

