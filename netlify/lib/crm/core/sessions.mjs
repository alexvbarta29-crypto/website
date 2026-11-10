// Barta CRM core: staff sessions (design §4.3).
//
// Cookie barta_crm = "{userId}.{token}" (token: 32 random bytes,
// base64url), HttpOnly; Secure; SameSite=Lax; Path=/; one year. The server
// keeps ses/{sha256(token)} = { user_id, epoch, created_at, last_seen_at,
// idle_expires_at, absolute_expires_at, ua: "iPhone Safari", ip_hash } and
// the relation rel/user-sessions/{uid}/{tsKey}--{hash} for "your devices".
// The token itself is never stored.
//
// Valid iff the session exists, names this user, is inside both lifetimes
// (idle 60 days, sliding; absolute 365 days), carries the user's current
// session_epoch, and the user is active. last_seen is refreshed at most
// every 6 hours (no write per request).
//
// A warm instance keeps a verified session for 30 s; every cache hit still
// compares sys/auth-epoch (one small read, itself cached 5 s), so "sign out
// everywhere", a disable or a role change (each bumps sys/auth-epoch) takes
// effect within 5 s. Revocation: delete the session, or bump the user's
// session_epoch (password change, role change, disable, "sign out
// everywhere"). A nightly auth.sessions sweep (M1.3) deletes expired ones.

import { randomBytes, createHash, createHmac, timingSafeEqual } from "node:crypto";
import { getRaw, deleteRaw, settledWrite, addRel, removeRel, listRel, getRecord, getRecords } from "../../crm-store.mjs";
import { nowMs, nowIso, tsKey } from "./clock.mjs";
import { isId } from "./ids.mjs";
import { cookie, clearCookie, readCookie, uaFamily, clientIp } from "./http.mjs";

export const SESSION_COOKIE = "barta_crm";
export const DEVICE_COOKIE = "barta_dev";
export const ONE_YEAR_S = 365 * 24 * 3600;
export const IDLE_MS = 60 * 24 * 3600 * 1000;
export const ABSOLUTE_MS = 365 * 24 * 3600 * 1000;
export const REFRESH_MS = 6 * 3600 * 1000;
export const CACHE_MS = 30 * 1000;
export const EPOCH_CACHE_MS = 5 * 1000;

export const SES_KEY = (hash) => `ses/${hash}`;
export const AUTH_EPOCH_KEY = "sys/auth-epoch";

const sha256 = (s) => createHash("sha256").update(String(s)).digest("hex");
const HASH_RE = /^[0-9a-f]{64}$/;
const TOKEN_RE = /^[A-Za-z0-9_-]{43}$/;

export const sessionCookie = (uid, token) => cookie(SESSION_COOKIE, `${uid}.${token}`, ONE_YEAR_S);
export const clearSessionCookie = () => clearCookie(SESSION_COOKIE);

// { uid, token, hash } from the request's barta_crm cookie, or null.
export function parseSessionCookie(req) {
  const raw = readCookie(req, SESSION_COOKIE);
  const dot = raw.indexOf(".");
  if (dot <= 0) return null;
  const uid = raw.slice(0, dot);
  const token = raw.slice(dot + 1);
  if (!isId(uid, "user") || !TOKEN_RE.test(token)) return null;
  return { uid, token, hash: sha256(token) };
}

// The device id from barta_dev (§4.8): a random id per browser, signed by
// the server ("{id}.{mac}", mac = HMAC-SHA256 with CRM_KEY_SALT), so a
// client can't make up a fresh id per guess to dodge the per-device delay
// and the shared "new" bucket. An id that doesn't verify counts as none.
const DEVICE_RE = /^([a-z0-9]{24})\.([0-9a-f]{20})$/;
const deviceMac = (id, salt = process.env.CRM_KEY_SALT || "dev-only") => createHmac("sha256", salt).update("barta_dev|" + id).digest("hex").slice(0, 20);
export function deviceId(req) {
  const m = DEVICE_RE.exec(readCookie(req, DEVICE_COOKIE));
  if (!m) return null;
  const want = Buffer.from(deviceMac(m[1]), "utf8");
  const got = Buffer.from(m[2], "utf8");
  return want.length === got.length && timingSafeEqual(want, got) ? m[1] : null;
}
export function newDeviceCookie() {
  const id = randomBytes(15).toString("base64url").toLowerCase().replace(/[^a-z0-9]/g, "a").slice(0, 24).padEnd(24, "a");
  const value = `${id}.${deviceMac(id)}`;
  return { id, value, cookie: cookie(DEVICE_COOKIE, value, ONE_YEAR_S) };
}

export function ipHash(ip, salt = process.env.CRM_KEY_SALT || "dev-only") {
  return sha256(`${salt}|${ip}`).slice(0, 16);
}

// ------------------------------------------------------------ auth epoch

let epochCache = null;   // { n, at }

export async function readAuthEpoch(opts = {}, { fresh = false } = {}) {
  const t = nowMs();
  if (!fresh && epochCache && t - epochCache.at < EPOCH_CACHE_MS && t >= epochCache.at) return epochCache.n;
  const got = await getRaw(AUTH_EPOCH_KEY, opts);
  const n = got && got.data && Number.isSafeInteger(got.data.n) ? got.data.n : 0;
  epochCache = { n, at: t };
  return n;
}

// Bumps sys/auth-epoch (CAS): every warm instance re-verifies its cached
// sessions within EPOCH_CACHE_MS.
export async function bumpAuthEpoch(reason = "change", opts = {}) {
  for (let i = 0; i < 5; i++) {
    const cur = await getRaw(AUTH_EPOCH_KEY, opts);
    const n = (cur && cur.data && Number.isSafeInteger(cur.data.n) ? cur.data.n : 0) + 1;
    const w = await settledWrite(AUTH_EPOCH_KEY, { n, at: nowIso(), reason: String(reason).slice(0, 40) }, cur ? { onlyIfMatch: cur.etag } : { onlyIfNew: true }, opts);
    if (w.ok) { epochCache = { n, at: nowMs() }; cache.clear(); return n; }
  }
  cache.clear();
  return null;
}

// ------------------------------------------------------------ sessions

const cache = new Map();   // hash → { uid, user, session, epoch, at }

export function clearSessionCache() { cache.clear(); epochCache = null; }
// Drops this instance's cached sessions of one user (after an edit of the user).
export function forgetUser(uid) { for (const [k, v] of cache) if (v.uid === uid) cache.delete(k); }

export async function createSession(user, req, context, opts = {}) {
  const token = randomBytes(32).toString("base64url");
  const hash = sha256(token);
  const t = nowMs();
  const at = new Date(t).toISOString();
  const record = {
    user_id: user.id,
    epoch: user.session_epoch || 0,
    created_at: at,
    last_seen_at: at,
    idle_expires_at: new Date(t + IDLE_MS).toISOString(),
    absolute_expires_at: new Date(t + ABSOLUTE_MS).toISOString(),
    ua: uaFamily(req.headers.get("user-agent")),
    ip_hash: ipHash(clientIp(req, context)),
  };
  const w = await settledWrite(SES_KEY(hash), record, { onlyIfNew: true }, opts);
  if (!w.ok) throw new Error("session id collision");
  await addRel("user-sessions", user.id, tsKey(new Date(t)), hash, {}, opts).catch(() => {});
  return { token, hash, record, cookie: sessionCookie(user.id, token) };
}

export function sessionValid(session, user, uid, t = nowMs()) {
  if (!session || !user) return false;
  if (session.user_id !== uid || user.id !== uid) return false;
  if (!(Date.parse(session.idle_expires_at) > t) || !(Date.parse(session.absolute_expires_at) > t)) return false;
  if ((session.epoch || 0) !== (user.session_epoch || 0)) return false;
  return user.status === "active";
}

// The signed-in user of a request: { user, userEtag, session, hash } or null.
// opts carries the store scope ({ deploy, budget, requestId }).
export async function lookupSession(req, opts = {}) {
  const parsed = parseSessionCookie(req);
  if (!parsed) return null;
  const { uid, hash } = parsed;
  const t = nowMs();
  const hit = cache.get(hash);
  if (hit && hit.uid === uid && t - hit.at < CACHE_MS && t >= hit.at) {
    const epoch = await readAuthEpoch(opts);
    if (epoch === hit.epoch && sessionValid(hit.session, hit.user, uid, t)) return { user: hit.user, userEtag: hit.userEtag, session: hit.session, hash };
    cache.delete(hash);
  }
  const [ses, rec, epoch] = await Promise.all([getRaw(SES_KEY(hash), opts), getRecord("user", uid, opts), readAuthEpoch(opts, { fresh: !!hit })]);
  const session = ses && ses.data;
  const user = rec && rec.data;
  if (!sessionValid(session, user, uid, t)) { cache.delete(hash); return null; }
  // Slide the idle lifetime at most every REFRESH_MS (best effort).
  let live = session;
  if (t - Date.parse(session.last_seen_at) > REFRESH_MS && ses.etag) {
    const next = { ...session, last_seen_at: new Date(t).toISOString(), idle_expires_at: new Date(t + IDLE_MS).toISOString() };
    delete next._w;
    try {
      const w = await settledWrite(SES_KEY(hash), next, { onlyIfMatch: ses.etag }, opts);
      if (w.ok) live = next;
    } catch { /* the next request tries again */ }
  }
  cache.set(hash, { uid, user, userEtag: rec.etag, session: live, epoch, at: t });
  if (cache.size > 500) cache.delete(cache.keys().next().value);
  return { user, userEtag: rec.etag, session: live, hash };
}

// Deletes one session (sign out, "sign out that device").
export async function revokeSession(hash, opts = {}) {
  if (!HASH_RE.test(String(hash))) return false;
  const got = await getRaw(SES_KEY(hash), opts);
  cache.delete(hash);
  if (!got || !got.data) return false;
  await deleteRaw(SES_KEY(hash), opts);
  const uid = got.data.user_id;
  const created = Date.parse(got.data.created_at);
  if (uid && Number.isFinite(created)) await removeRel("user-sessions", uid, tsKey(new Date(created)), hash, opts).catch(() => {});
  return true;
}

// A user's devices, newest first: [{ hash, ua, created_at, last_seen_at, current }].
// Sessions that no longer count (expired, older epoch) are left out.
export async function listSessions(user, currentHash = null, opts = {}) {
  const rows = await listRel("user-sessions", user.id, { limit: 20 }, opts);
  const got = await Promise.all(rows.map((r) => (HASH_RE.test(r.id) ? getRaw(SES_KEY(r.id), opts).catch(() => null) : null)));
  const t = nowMs();
  const out = [];
  rows.forEach((r, i) => {
    const s = got[i] && got[i].data;
    if (!s || !sessionValid(s, user, user.id, t)) return;
    out.push({ hash: r.id, ua: s.ua || "Device", created_at: s.created_at, last_seen_at: s.last_seen_at, current: r.id === currentHash });
  });
  return out;
}

// The users behind several ids (for lists), in order.
export const usersById = (ids, opts) => getRecords("user", ids, opts);
