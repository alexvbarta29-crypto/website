// Barta CRM core: sign-in throttling (design §4.8).
//
// The platform rate limit on crm-auth.mjs (30 requests a minute per IP and
// domain) refuses a flood before any Blobs write. On top of it:
//
// - Per login and device: thr/login/{login}--{deviceId} { fails, first_at,
//   next_allowed_at }. After 5 failures in 15 minutes each further try
//   waits: 30 s, then doubling, capped at 15 min. A progressive delay, never
//   a hard lock, so someone who only knows a first name cannot lock Alex out
//   of his own phone (his phone has its own barta_dev device id).
// - A browser with no barta_dev cookie shares thr/login/{login}--new, which
//   locks for 1 hour after 20 failures in an hour.
// - Per IP: thr/ip/{sha256(ip + daily salt)}: 30 failures in an hour and
//   that IP is refused for an hour.
//
// The throttle is checked BEFORE the PBKDF2 work. Writes are conditional
// and best effort: a lost race only means one failure was not counted.
// Keys hold a login handle (a-z0-9.-) or a hash, never a name or an address.

import { createHash } from "node:crypto";
import { getRaw, settledWrite, deleteRaw } from "../../crm-store.mjs";
import { nowMs, localDate } from "./clock.mjs";
import { keySafe } from "./text.mjs";

export const LOGIN_WINDOW_MS = 15 * 60 * 1000;
export const LOGIN_FREE_FAILS = 5;
export const FIRST_DELAY_MS = 30 * 1000;
export const MAX_DELAY_MS = 15 * 60 * 1000;
export const NEW_WINDOW_MS = 60 * 60 * 1000;
export const NEW_LIMIT = 20;
export const NEW_LOCK_MS = 60 * 60 * 1000;
export const IP_WINDOW_MS = 60 * 60 * 1000;
export const IP_LIMIT = 30;
export const IP_LOCK_MS = 60 * 60 * 1000;

const sha = (s) => createHash("sha256").update(String(s)).digest("hex");
export const LOGIN_RE = /^[a-z0-9][a-z0-9.-]{1,31}$/;

// The key segment for what was typed as a login: the handle itself when it
// is one, else a hash (a typed email or phone never lands in a key).
export const loginKey = (login) => {
  const s = String(login || "").trim().toLowerCase();
  return LOGIN_RE.test(s) ? keySafe(s, 32) : "h-" + sha(s).slice(0, 24);
};
export const loginBucketKey = (login, device) => `thr/login/${loginKey(login)}--${device || "new"}`;
export const ipBucketKey = (ip, salt = process.env.CRM_KEY_SALT || "dev-only") => `thr/ip/${sha(`${ip}|${localDate(new Date(nowMs()))}|${salt}`).slice(0, 32)}`;

// The delay after `fails` failures inside the window (0 = none yet).
export function delayAfter(fails) {
  if (fails < LOGIN_FREE_FAILS) return 0;
  return Math.min(MAX_DELAY_MS, FIRST_DELAY_MS * 2 ** (fails - LOGIN_FREE_FAILS));
}

const waitOf = (b, t) => (b && Date.parse(b.next_allowed_at) > t ? Date.parse(b.next_allowed_at) - t : 0);

// → { ok: true } | { ok: false, retry_after_s, why: "login" | "ip" }
export async function checkThrottle({ login, device, ip }, opts = {}) {
  const t = nowMs();
  const [lb, ib] = await Promise.all([getRaw(loginBucketKey(login, device), opts), getRaw(ipBucketKey(ip), opts)]);
  const ipWait = waitOf(ib && ib.data, t);
  if (ipWait > 0) return { ok: false, retry_after_s: Math.ceil(ipWait / 1000), why: "ip" };
  const loginWait = waitOf(lb && lb.data, t);
  if (loginWait > 0) return { ok: false, retry_after_s: Math.ceil(loginWait / 1000), why: "login" };
  return { ok: true };
}

async function bump(key, next, opts) {
  for (let i = 0; i < 2; i++) {
    const cur = await getRaw(key, opts);
    const value = next(cur && cur.data ? cur.data : null);
    const w = await settledWrite(key, value, cur ? { onlyIfMatch: cur.etag } : { onlyIfNew: true }, opts).catch(() => ({ ok: false }));
    if (w.ok) return value;
  }
  return null;
}

// Counts one failed sign-in against the login/device and the IP.
export async function recordFailure({ login, device, ip }, opts = {}) {
  const t = nowMs();
  const iso = (ms) => new Date(ms).toISOString();
  const fresh = (b, windowMs) => !b || !(Date.parse(b.first_at) + windowMs > t);
  const loginNext = (b) => {
    if (device) {
      const base = fresh(b, LOGIN_WINDOW_MS) && !(waitOf(b, t) > 0) ? { fails: 0, first_at: iso(t) } : b;
      const fails = (base.fails || 0) + 1;
      const d = delayAfter(fails);
      return { fails, first_at: base.first_at, next_allowed_at: iso(t + d) };
    }
    const base = fresh(b, NEW_WINDOW_MS) && !(waitOf(b, t) > 0) ? { fails: 0, first_at: iso(t) } : b;
    const fails = (base.fails || 0) + 1;
    return { fails, first_at: base.first_at, next_allowed_at: iso(fails >= NEW_LIMIT ? t + NEW_LOCK_MS : t) };
  };
  const ipNext = (b) => {
    const base = fresh(b, IP_WINDOW_MS) && !(waitOf(b, t) > 0) ? { fails: 0, first_at: iso(t) } : b;
    const fails = (base.fails || 0) + 1;
    return { fails, first_at: base.first_at, next_allowed_at: iso(fails >= IP_LIMIT ? t + IP_LOCK_MS : t) };
  };
  await Promise.all([bump(loginBucketKey(login, device), loginNext, opts), bump(ipBucketKey(ip), ipNext, opts)]);
}

// A good sign-in clears that login's bucket for this device.
export async function recordSuccess({ login, device }, opts = {}) {
  await deleteRaw(loginBucketKey(login, device), opts).catch(() => {});
}
