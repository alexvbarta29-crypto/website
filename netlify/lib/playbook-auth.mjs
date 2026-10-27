// Sign-in for /playbook (the office follow-up playbook).
//
// Password: the owner's chosen password (kept here only as a slow PBKDF2
// digest), or the PLAYBOOK_PASSWORD Netlify env var when that is set. The cookie is
// the PBKDF2 key itself, so only someone who knows the password can make it.
// Changing the password signs every device out.

import { derive, sha256, same, ONE_YEAR } from "./lights-auth.mjs";

// sha256(PBKDF2(owner's password))
const DEFAULT_CHECK = "cb2b02e799b3c6c6db45ade8d7ac0399dfec0b5eb2a9efdc2e45298b83f6a4e7";

export { derive, sha256, same, ONE_YEAR };
export const COOKIE = "barta_playbook";

let envCache = null;
export function expected() {
  const pw = String(process.env.PLAYBOOK_PASSWORD || "");
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
  `${COOKIE}=${token}; Path=/playbook; Max-Age=${maxAge}; HttpOnly; Secure; SameSite=Lax`;
