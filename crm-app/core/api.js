// Barta CRM client: the one way the app talks to /api/crm (design §2.2,
// §2.3, §2.5, §4.7).
//
// Every request is same-origin with the session cookie, X-CRM: 1 (the CSRF
// header the server requires on writes), X-CRM-Client (426 below the
// server's MIN_CLIENT) and JSON. POSTs carry an Idempotency-Key, so a retry
// after a dropped answer never does the work twice. PATCH/PUT carry
// If-Match; a 412 becomes a StaleError with the server's current copy.
// GETs give up after 4 s and fall back to the last good copy kept by
// core/cache.js, flagged { offline: true, as_of } so the screen can say
// "Offline, as of 7:42 AM". Writes time out after 10 s (the offline outbox
// for techs arrives in M1.3). A 401 wipes this phone's offline copies and
// sends this frame (never the top window) to /crm/login, keeping the screen
// it was on; the person's unsent changes stay in the outbox until the next
// sign-in on this phone (core/outbox.js claim()). Offline copies are keyed
// by the signed-in person (setCacheOwner), so on a shared phone nobody
// reads the last person's copy. opts.headers adds request headers (the
// outbox's X-CRM-Sent-At).

import { APP_VERSION } from "../version.js";
import * as cache from "./cache.js";

export const GET_TIMEOUT_MS = 4000;
export const WRITE_TIMEOUT_MS = 10000;

export class ApiError extends Error {
  constructor(status, error = {}) {
    super(error.message || "Something went wrong. Try again.");
    this.status = status;
    this.code = error.code || "failed";
    this.field = error.field;
    this.details = error.details;
  }
}
export class StaleError extends ApiError {}
export class OfflineError extends ApiError {}

const listeners = { outdated: [], signedOut: [], offline: [] };
export function on(event, fn) { (listeners[event] ||= []).push(fn); }
const emit = (event, data) => (listeners[event] || []).forEach((fn) => { try { fn(data); } catch (e) { /* a listener failed */ } });

export function uuid() {
  if (globalThis.crypto && crypto.randomUUID) return crypto.randomUUID();
  const b = new Uint8Array(16);
  crypto.getRandomValues(b);
  b[6] = (b[6] & 15) | 64; b[8] = (b[8] & 63) | 128;
  const h = [...b].map((x) => x.toString(16).padStart(2, "0")).join("");
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}

let owner = null;   // the signed-in person's id: offline copies are theirs only
export function setCacheOwner(id) { owner = typeof id === "string" && id ? id : null; }
const cacheKey = (url) => (owner ? owner + "|" + url : null);

let signingOut = false;
async function signedOut() {
  if (signingOut) return;
  signingOut = true;
  emit("signedOut");
  const here = location.hash && location.hash.length > 1 ? location.hash : "";
  // Signed out (expired, disabled, signed out elsewhere): forget this
  // person's offline copies before anything else can read them.
  try { await cache.wipe(); } catch (e) { /* nothing kept */ }
  location.replace("/crm/login?to=" + encodeURIComponent("/crm" + here));
}

// api(path, { method, body, ifMatch, ifNoneMatch, idempotencyKey, timeout, cache: false })
// → { data, meta, etag, offline?, as_of? } ({ notModified: true, etag } for a
// 304 to ifNoneMatch: core/poll.js)
export async function api(path, opts = {}) {
  const method = (opts.method || "GET").toUpperCase();
  const url = "/api/crm" + path;
  const headers = { ...(opts.headers || {}), "X-CRM": "1", "X-CRM-Client": APP_VERSION, Accept: "application/json" };
  const init = { method, credentials: "same-origin", headers };
  if (method !== "GET" && method !== "DELETE") {
    headers["Content-Type"] = "application/json";
    init.body = JSON.stringify(opts.body ?? {});
  }
  if (method === "POST") headers["Idempotency-Key"] = opts.idempotencyKey || uuid();
  if (opts.ifMatch) headers["If-Match"] = opts.ifMatch;
  if (opts.ifNoneMatch) headers["If-None-Match"] = opts.ifNoneMatch;
  const timeout = opts.timeout || (method === "GET" ? GET_TIMEOUT_MS : WRITE_TIMEOUT_MS);
  const ctrl = new AbortController();
  let timedOut = false;
  const timer = setTimeout(() => { timedOut = true; ctrl.abort(); }, timeout);
  init.signal = ctrl.signal;
  let res;
  try {
    res = await fetch(url, init);
  } catch (e) {
    clearTimeout(timer);
    if (method === "GET" && opts.cache !== false && cacheKey(url)) {
      const hit = await cache.get(cacheKey(url));
      if (hit) { emit("offline", hit.at); return { data: hit.data, meta: hit.meta, etag: hit.etag, offline: true, as_of: hit.at }; }
    }
    const err = new OfflineError(0, { code: "offline", message: method === "GET" ? "No connection. Try again when you have signal." : "No connection. Nothing was saved; try again when you have signal." });
    if (timedOut) err.timedOut = true;      // the line was there but too slow (a big photo)
    throw err;
  }
  clearTimeout(timer);
  if (res.status === 304) {
    if (opts.ifNoneMatch) return { notModified: true, etag: res.headers.get("ETag") || opts.ifNoneMatch };
    const hit = cacheKey(url) ? await cache.get(cacheKey(url)) : null;
    if (hit) return { data: hit.data, meta: hit.meta, etag: hit.etag };
  }
  let body = null;
  try { body = await res.json(); } catch (e) { body = null; }
  if (res.status === 401) { signedOut(); throw new ApiError(401, (body && body.error) || { code: "signed_out", message: "Sign in again." }); }
  if (res.status === 426) { emit("outdated"); throw new ApiError(426, (body && body.error) || {}); }
  if (!res.ok || !body || body.ok !== true) {
    const err = (body && body.error && typeof body.error === "object") ? body.error : { code: "failed", message: res.status >= 500 ? "Something went wrong on our side. Try again in a minute." : "That didn't work. Try again." };
    if (res.status === 412) throw new StaleError(412, err);
    throw new ApiError(res.status, err);
  }
  const out = { data: body.data, meta: body.meta, etag: res.headers.get("ETag") || undefined };
  if (method === "GET" && opts.cache !== false && cacheKey(url)) cache.put(cacheKey(url), out).catch(() => {});
  return out;
}

// "yyyy.mm.dd-n" versions: -1, 0 or 1.
export function compareVersions(a, b) {
  const p = (v) => (/^(\d{4})\.(\d{2})\.(\d{2})-(\d+)$/.exec(String(v || "")) || []).slice(1).map(Number);
  const x = p(a), y = p(b);
  for (let i = 0; i < 4; i++) if ((x[i] || 0) !== (y[i] || 0)) return (x[i] || 0) < (y[i] || 0) ? -1 : 1;
  return 0;
}

export const get = (path, opts) => api(path, { ...opts, method: "GET" });
export const post = (path, body, opts) => api(path, { ...opts, method: "POST", body });
export const patch = (path, body, ifMatch, opts) => api(path, { ...opts, method: "PATCH", body, ifMatch });
export const del = (path, opts) => api(path, { ...opts, method: "DELETE" });

// Sign out of this phone: the server forgets the session; this phone
// forgets its cached copies (the shell's cache and IndexedDB, §2.5).
export async function signOut({ everywhere = false } = {}) {
  signingOut = true;   // a 401 from here on is expected, not a reason to jump to the sign-in page
  try { await post(everywhere ? "/auth/logout-all" : "/auth/logout", {}); } catch (e) { /* signed out anyway */ }
  await cache.wipe();
}
