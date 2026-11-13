// Barta CRM core: sign-in throttling (design §4.8).
//
// The platform rate limit on crm-auth.mjs (30 requests a minute per IP and
// domain) refuses a flood before any Blobs write. On top of it, three kinds
// of bucket:
//
// - Per login and device: thr/login/{login}--{deviceId}/. After 5 failures
//   in 15 minutes each further try waits: 30 s, then doubling, capped at
//   15 min. A progressive delay, never a hard lock, so someone who only
//   knows a first name cannot lock Alex out of his own phone (his phone has
//   its own signed barta_dev device id, core/sessions.mjs).
// - A browser with no valid barta_dev cookie shares thr/login/{login}--new/,
//   which locks for 1 hour after 20 failures in an hour.
// - Per IP: thr/ip/{sha256(ip + daily salt)}/: 30 failures in an hour and
//   that IP is refused for an hour.
// - The office password (one shared secret, so guesses from many addresses
//   add up): a check made with `office: true` (lib/office-password.mjs, every
//   place that takes the office password) also counts in thr/office/, 40
//   failures in an hour from anywhere and every office-password check is
//   refused for an hour. 40 is above one address's 30, so a single address
//   alone never trips it. A good password writes no ok marker there: the
//   failures only age out.
//
// Every counted failure is its own small blob, {bucket}/f-{tsKey}-{rand}
// (a fresh key, so failures landing at the same moment from 30 function
// instances are all counted; a read-then-CAS counter loses most of them).
// A good sign-in writes {bucket}/ok-{tsKey}. A bucket's state { fails,
// first, next } is a replay of its failures after its latest ok marker,
// over the last LOOKBACK_MS: the same state machine the design describes
// for the single { fails, first_at, next_allowed_at } record. Checking is
// one list per bucket, BEFORE the PBKDF2 work. The nightly auth sweep
// (M1.3) deletes thr/ keys older than a day; until then they stay (tiny).
// Keys hold a login handle (a-z0-9.-) or a hash, never a name or an address.

import { createHash, randomBytes } from "node:crypto";
import { listKeys, putRaw } from "../../crm-store.mjs";
import { nowMs, localDate, tsKey, fromTsKey } from "./clock.mjs";
import { keySafe } from "./text.mjs";
import { keySalt } from "./context.mjs";

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
export const OFFICE_WINDOW_MS = 60 * 60 * 1000;
export const OFFICE_LIMIT = 40;
export const OFFICE_LOCK_MS = 60 * 60 * 1000;
// Older failures can't change a bucket's state (a window plus its lock).
export const LOOKBACK_MS = 2 * 60 * 60 * 1000 + 60 * 1000;

const sha = (s) => createHash("sha256").update(String(s)).digest("hex");
export const LOGIN_RE = /^[a-z0-9][a-z0-9.-]{1,31}$/;

// The key segment for what was typed as a login: the handle itself when it
// is one, else a hash (a typed email or phone never lands in a key).
export const loginKey = (login) => {
  const s = String(login || "").trim().toLowerCase();
  return LOGIN_RE.test(s) ? keySafe(s, 32) : "h-" + sha(s).slice(0, 24);
};
// Bucket prefixes (each ends in "/": one bucket never lists another).
export const loginBucketKey = (login, device) => `thr/login/${loginKey(login)}--${device || "new"}/`;
export const OFFICE_BUCKET = "thr/office/";
export const ipBucketKey = (ip, salt = keySalt() || "dev-only") => `thr/ip/${sha(`${ip}|${localDate(new Date(nowMs()))}|${salt}`).slice(0, 32)}/`;

// The delay after `fails` failures inside the window (0 = none yet).
export function delayAfter(fails) {
  if (fails < LOGIN_FREE_FAILS) return 0;
  return Math.min(MAX_DELAY_MS, FIRST_DELAY_MS * 2 ** (fails - LOGIN_FREE_FAILS));
}

// One failure at time t on top of state b ({ fails, first, next } in ms).
// A new window starts once the old one is over and no wait is pending.
const startOver = (b, t, windowMs) => !b || (!(b.first + windowMs > t) && !(b.next > t));
const deviceStep = (b, t) => {
  const base = startOver(b, t, LOGIN_WINDOW_MS) ? { fails: 0, first: t } : b;
  const fails = base.fails + 1;
  return { fails, first: base.first, next: t + delayAfter(fails) };
};
const lockStep = (windowMs, limit, lockMs) => (b, t) => {
  const base = startOver(b, t, windowMs) ? { fails: 0, first: t } : b;
  const fails = base.fails + 1;
  return { fails, first: base.first, next: fails >= limit ? t + lockMs : t };
};
const newStep = lockStep(NEW_WINDOW_MS, NEW_LIMIT, NEW_LOCK_MS);
const ipStep = lockStep(IP_WINDOW_MS, IP_LIMIT, IP_LOCK_MS);
const officeStep = lockStep(OFFICE_WINDOW_MS, OFFICE_LIMIT, OFFICE_LOCK_MS);

const KEY_RE = /\/(f|ok)-(\d{8}t\d{9}z)(?:-[a-z0-9]+)?$/;

// A bucket's state from its keys: the failures after the latest ok marker
// (and inside LOOKBACK_MS), replayed in time order. null = no failures.
export function bucketState(keys, step, t = nowMs()) {
  const fails = [];
  let okAt = -Infinity;
  for (const k of keys) {
    const m = KEY_RE.exec(k);
    if (!m) continue;
    const d = fromTsKey(m[2]);
    if (!d) continue;
    const at = d.getTime();
    if (m[1] === "ok") okAt = Math.max(okAt, at);
    else if (at > t - LOOKBACK_MS && at <= t) fails.push(at);
  }
  let b = null;
  for (const at of fails.filter((x) => x > okAt).sort((x, y) => x - y)) b = step(b, at);
  return b;
}

const waitOf = (b, t) => (b && b.next > t ? b.next - t : 0);

// → { ok: true } | { ok: false, retry_after_s, why: "office" | "ip" | "login" }
// `office: true` adds the office password's global bucket.
export async function checkThrottle({ login, device, ip, office = false }, opts = {}) {
  const t = nowMs();
  const [lk, ik, ok] = await Promise.all([
    listKeys(loginBucketKey(login, device), {}, opts),
    listKeys(ipBucketKey(ip), {}, opts),
    office ? listKeys(OFFICE_BUCKET, {}, opts) : [],
  ]);
  const officeWait = office ? waitOf(bucketState(ok, officeStep, t), t) : 0;
  if (officeWait > 0) return { ok: false, retry_after_s: Math.ceil(officeWait / 1000), why: "office" };
  const ipWait = waitOf(bucketState(ik, ipStep, t), t);
  if (ipWait > 0) return { ok: false, retry_after_s: Math.ceil(ipWait / 1000), why: "ip" };
  const loginWait = waitOf(bucketState(lk, device ? deviceStep : newStep, t), t);
  if (loginWait > 0) return { ok: false, retry_after_s: Math.ceil(loginWait / 1000), why: "login" };
  return { ok: true };
}

const mark = (prefix, kind, t) => `${prefix}${kind}-${tsKey(new Date(t))}${kind === "f" ? "-" + randomBytes(5).toString("hex") : ""}`;

// Counts one failed sign-in against the login/device and the IP (and, with
// `office: true`, the office password's global bucket): one new blob each,
// so parallel failures never overwrite each other.
export async function recordFailure({ login, device, ip, office = false }, opts = {}) {
  const t = nowMs();
  const at = new Date(t).toISOString();
  await Promise.all([
    putRaw(mark(loginBucketKey(login, device), "f", t), { at }, {}, opts),
    putRaw(mark(ipBucketKey(ip), "f", t), { at }, {}, opts),
    ...(office ? [putRaw(mark(OFFICE_BUCKET, "f", t), { at }, {}, opts)] : []),
  ]);
}

// A good sign-in clears that login's bucket for this device (an ok marker:
// failures before it no longer count).
export async function recordSuccess({ login, device }, opts = {}) {
  const t = nowMs();
  await putRaw(mark(loginBucketKey(login, device), "ok", t), { at: new Date(t).toISOString() }, {}, opts).catch(() => {});
}
