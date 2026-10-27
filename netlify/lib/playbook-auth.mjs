// Sign-in for /playbook (the office follow-up playbook).
//
// Password: PLAYBOOK_PASSWORD (Netlify env var) when that is set, otherwise
// the same password as Barta Light Studio (lights-auth.mjs). The cookie is
// the PBKDF2 key itself, so only someone who knows the password can make it.
// Changing the password signs every device out.

import { derive, sha256, same, expected as lightsExpected, ONE_YEAR } from "./lights-auth.mjs";

export { derive, sha256, same, ONE_YEAR };
export const COOKIE = "barta_playbook";

let envCache = null;
export function expected() {
  const pw = String(process.env.PLAYBOOK_PASSWORD || "");
  if (!pw) return lightsExpected();
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
