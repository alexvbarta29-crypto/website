// Barta CRM client: the offline outbox (design §2.5 "Outbox"). Changes a
// tech makes with no signal (timers, clock in/out, checklist ticks, notes,
// photos, completion, cash/check payments) wait here, in IndexedDB
// (database "crm-outbox"), and go out in order when the phone is back
// online, on focus, and every 30 s while visible.
//
// - Each item keeps the Idempotency-Key it was queued with, so a replay
//   that already landed (the answer was lost) is answered from the
//   server's record and never runs twice; creates carry a client record id
//   (the screens put it in the body).
// - Order is a sequence number kept with the items (never the phone's
//   clock, which can be set back while items wait).
// - queued_at and client_at come from the device: the server decides
//   whether to trust them (§2.5 "Times from the device"). Each try also
//   says the phone's clock as it sends (header X-CRM-Sent-At), so the
//   server sees a phone whose clock is off.
// - Every item belongs to the person who made it (user_id). Only theirs
//   is listed and sent. A 401 (the session ran out) stops the replay and
//   keeps everything; the items wait for the next sign-in on this phone:
//   the same person's go out, another person's are deleted unseen
//   (claim()). Signing out on purpose warns and deletes them (wipe()).
// - Items older than 6 days are not replayed (idempotency records last
//   7), and an item the server refuses (a 4xx) is not dropped: both go to
//   POST /outbox-review for the office, in batches under its caps, photo
//   bytes left out (a week-old photo is first kept on an entry for the
//   office: POST its path with hold: true). onRefused tells the screen.
// - A photo that can't get through (a slow line, a 5xx) holds back only
//   its own visit's later changes; other visits and the clock go on. Its
//   time to send grows with its size.
// - When the phone's storage is full the item waits in memory for this
//   page's life only (saved: false): the screen says so plainly.
// Anything that contacts a customer (on-my-way texts, card payments,
// sending a quote) never queues: it needs signal.

import { api, uuid, WRITE_TIMEOUT_MS } from "./api.js";

const DB = "crm-outbox";
const STORE = "items";
export const STALE_MS = 6 * 24 * 3600 * 1000;
export const REPLAY_EVERY_MS = 30000;
// /outbox-review's caps (core/pending.mjs, system/pending.mjs): items a
// request, characters an item's body, bytes a request (with room to spare)
export const REVIEW_MAX_ITEMS = 200;
export const REVIEW_MAX_BODY = 7500;
export const REVIEW_MAX_BYTES = 400 * 1024;
// a write's time to answer: 10 s, plus a second for every 24 KB it carries (a slow line), at most 3 minutes
export const timeoutFor = (body) => Math.min(180000, WRITE_TIMEOUT_MS + Math.round(((body ? JSON.stringify(body).length : 0) / 24000) * 1000));

let dbp = null;
function db() {
  if (dbp) return dbp;
  dbp = new Promise((resolve) => {
    try {
      if (typeof indexedDB === "undefined") return resolve(null);
      const req = indexedDB.open(DB, 1);
      req.onupgradeneeded = () => { try { req.result.createObjectStore(STORE, { keyPath: "key" }); } catch (e) { /* exists */ } };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => resolve(null);
      req.onblocked = () => resolve(null);
    } catch (e) { resolve(null); }
  });
  return dbp;
}
// Items IndexedDB couldn't keep (private mode, a full phone): this page's life only.
const mem = new Map();

// → the request's result, or null when IndexedDB is missing or the write failed
function tx(mode, fn) {
  return db().then((d) => new Promise((resolve) => {
    if (!d) return resolve(null);
    try {
      const t = d.transaction(STORE, mode);
      const r = fn(t.objectStore(STORE));
      t.oncomplete = () => resolve(r && "result" in r ? (r.result === undefined ? true : r.result) : true);
      t.onerror = () => resolve(null);
      t.onabort = () => resolve(null);
    } catch (e) { resolve(null); }
  }));
}

// ------------------------------------------------------------ whose items

let owner = null;
// The signed-in person (main.js): items are stamped with it and only theirs are listed.
export function setUser(id) { owner = typeof id === "string" && id ? id : null; }
const mine = (i) => !!i && (i.user_id || null) === owner;

async function all() {
  const rows = await tx("readonly", (s) => s.getAll());
  const out = new Map();
  for (const r of Array.isArray(rows) ? rows : []) if (r && r.key) out.set(r.key, r);
  for (const [k, v] of mem) out.set(k, v);
  return [...out.values()].sort((a, b) => (a.seq || 0) - (b.seq || 0));
}

// At sign-in on this phone: the person's own waiting items stay (they go
// out); anyone else's are deleted without being read out. → how many stayed
export async function claim(id) {
  setUser(id);
  const items = await all();
  for (const i of items) if (!mine(i)) await remove(i.key);
  return items.filter(mine).length;
}

// ------------------------------------------------------------ queueing

let lastSeq = 0;
async function nextSeq() {
  const top = (await all()).reduce((n, i) => Math.max(n, Number(i.seq) || 0), 0);
  lastSeq = Math.max(lastSeq, top) + 1;
  return lastSeq;
}

// Queues a change. → the item ({ key, method, path, body, queued_at,
// client_at, seq, user_id, saved }); saved: false when only this page holds it.
export async function enqueue({ method = "POST", path, body = {}, ifMatch, key } = {}) {
  if (typeof path !== "string" || !path.startsWith("/")) throw new TypeError("outbox: path must start with /");
  const at = new Date().toISOString();
  const item = { key: key || uuid(), method: method.toUpperCase(), path, body, ifMatch: ifMatch || null, queued_at: at, client_at: at, seq: await nextSeq(), user_id: owner };
  const ok = await tx("readwrite", (s) => s.put(item));
  if (ok === null) mem.set(item.key, { ...item, memory: true });
  emit();
  return { ...item, saved: ok !== null };
}

export async function list() { return (await all()).filter(mine); }
export async function count() { return (await list()).length; }
async function remove(key) {
  mem.delete(key);
  await tx("readwrite", (s) => s.delete(key));
}
async function save(item) {
  if (mem.has(item.key)) { mem.set(item.key, item); return; }
  const ok = await tx("readwrite", (s) => s.put(item));
  if (ok === null) mem.set(item.key, { ...item, memory: true });
}

const listeners = new Set();
export function onChange(fn) { listeners.add(fn); return () => listeners.delete(fn); }
function emit() { count().then((n) => listeners.forEach((fn) => { try { fn(n); } catch (e) { /* a listener failed */ } })); }

// ------------------------------------------------------------ the office's review (§2.5)

const PHOTO = /^\/visits\/[^/]+\/photos$/;
const laneOf = (path) => { const m = /^\/visits\/([^/]+)\//.exec(path || ""); return m ? "visit:" + m[1] : "other"; };
const stop = (e) => !e || e.code === "offline" || !e.status || e.status >= 500 || e.status === 401 || e.status === 426 || e.status === 429 || (e.status === 409 && e.code === "in_progress");

// What the office reads of an item: never the photo's bytes, nothing too long.
function forReview(i) {
  const b = { ...(i.body || {}) };
  if (typeof b.data === "string") { b.data_bytes = Math.round((b.data.length * 3) / 4); delete b.data; }
  delete b.thumb;
  for (const [k, v] of Object.entries(b)) if (typeof v === "string" && v.length > 2000) b[k] = v.slice(0, 2000);
  if (i.held) b.held = i.held;
  if (i.refused) b.refused = { status: i.refused.status, code: i.refused.code, message: String(i.refused.message || "").slice(0, 200) };
  let out = { method: i.method, path: i.path, body: b, queued_at: i.queued_at, client_at: i.client_at, idempotency_key: i.key };
  if (JSON.stringify(b).length > REVIEW_MAX_BODY) out = { ...out, body: { client_id: b.client_id, too_big: true, ...(b.refused ? { refused: b.refused } : {}) } };
  return out;
}

// A week-old photo is kept on an entry for the office first (its bytes
// can't go in the review). → false when there's no signal to do it now
async function holdPhoto(i, onRefused) {
  try {
    const r = await api(i.path, { method: "POST", body: { ...i.body, hold: true, queued_offline: true }, idempotencyKey: "hold-" + i.key, timeout: timeoutFor(i.body), headers: sentAt() });
    i.held = { pending_entry_id: r.data && r.data.pending_entry_id, file_id: r.data && r.data.file_id };
  } catch (e) {
    if (stop(e)) return false;
    i.held = { kept: false, message: String((e && e.message) || "").slice(0, 200) };
    if (onRefused) { try { onRefused(i, e); } catch (x) { /* ignore */ } }
  }
  await save(i);
  return true;
}

// Sends items to /outbox-review in batches under its caps; a batch the
// server turns down for one item loses only that item. → { sent, done }
async function review(items, onRefused) {
  let sent = 0;
  let queue = [...items];
  let guard = 0;
  while (queue.length && guard++ < 50) {
    const batch = [];
    let bytes = 0;
    for (const i of queue) {
      const r = forReview(i);
      const n = JSON.stringify(r).length;
      if (batch.length && (batch.length >= REVIEW_MAX_ITEMS || bytes + n > REVIEW_MAX_BYTES)) break;
      batch.push({ i, r });
      bytes += n;
    }
    try {
      await api("/outbox-review", { method: "POST", body: { items: batch.map((x) => x.r) }, idempotencyKey: "review-" + batch.map((x) => x.i.key).join("").slice(0, 60) + batch.length, headers: sentAt() });
      for (const x of batch) await remove(x.i.key);
      sent += batch.length;
      queue = queue.slice(batch.length);
    } catch (e) {
      if (stop(e)) return { sent, done: false };
      const m = /^items\.(\d+)/.exec((e && e.field) || "");
      const bad = m ? batch[Number(m[1])] : batch.length === 1 ? batch[0] : null;
      if (bad) {
        // the office can't take this one: it's said once and goes
        await remove(bad.i.key);
        if (onRefused) { try { onRefused(bad.i, e); } catch (x) { /* ignore */ } }
        queue = queue.filter((i) => i !== bad.i);
      } else if (batch.length > 1) {
        // too big together (413): half as many next time
        const half = Math.ceil(batch.length / 2);
        const first = batch.slice(0, half).map((x) => x.i);
        const rest = await review(first, onRefused);
        sent += rest.sent;
        if (!rest.done) return { sent, done: false };
        queue = queue.filter((i) => !first.includes(i));
      } else return { sent, done: false };
    }
  }
  return { sent, done: !queue.length };
}

// ------------------------------------------------------------ replaying

const sentAt = () => ({ "X-CRM-Sent-At": new Date().toISOString() });
const defaults = { onRefused: null };

// Sends what is queued, oldest first. → { sent, refused, review, left, stopped? }
let replaying = false;
export async function replay({ onRefused = defaults.onRefused } = {}) {
  if (replaying) return { sent: 0, refused: 0, review: 0, left: await count() };
  replaying = true;
  let sent = 0, refused = 0, reviewed = 0, stopped = null;
  try {
    const items = await list();
    const now = Date.now();
    const blocked = new Set();          // visits whose photo couldn't get through this time
    for (const i of items) {
      if (i.refused || now - Date.parse(i.queued_at) > STALE_MS) continue;
      const lane = laneOf(i.path);
      if (blocked.has(lane)) continue;
      try {
        await api(i.path, { method: i.method, body: i.body, ifMatch: i.ifMatch || undefined, idempotencyKey: i.key, timeout: timeoutFor(i.body), headers: sentAt() });
        await remove(i.key);
        sent += 1;
      } catch (e) {
        if (stop(e)) {
          // a photo too slow for this line (or a 5xx on it) holds back only its own visit
          if (PHOTO.test(i.path) && e && (e.timedOut || e.status >= 500)) { blocked.add(lane); continue; }
          stopped = (e && (e.status === 401 ? "signed_out" : e.code)) || "offline";
          break;
        }
        // refused: kept for the office's review, never just dropped
        i.refused = { status: e.status, code: e.code, message: e.message, at: new Date().toISOString() };
        await save(i);
        refused += 1;
        if (onRefused) { try { onRefused(i, e); } catch (x) { /* ignore */ } }
      }
    }
    if (!stopped) {
      const left = (await list()).filter((i) => i.refused || now - Date.parse(i.queued_at) > STALE_MS);
      const stalePhotos = left.filter((i) => !i.refused && !i.held && PHOTO.test(i.path) && i.body && typeof i.body.data === "string");
      let ok = true;
      for (const p of stalePhotos) if (!(await holdPhoto(p, onRefused))) { ok = false; break; }
      if (ok && left.length) {
        const r = await review(await list().then((l) => l.filter((i) => left.some((x) => x.key === i.key))), onRefused);
        reviewed = r.sent;
      }
    }
  } finally {
    replaying = false;
    emit();
  }
  return { sent, refused, review: reviewed, left: await count(), ...(stopped ? { stopped } : {}) };
}

// Replays on online, focus and every 30 s while the app is on screen.
// opts.onRefused is used by every replay, whoever starts it.
let started = false;
export function start(opts = {}) {
  if (typeof opts.onRefused === "function") defaults.onRefused = opts.onRefused;
  if (started || typeof window === "undefined") return;
  started = true;
  const go = () => { if (!document.hidden && navigator.onLine !== false) replay().catch(() => {}); };
  window.addEventListener("online", go);
  window.addEventListener("focus", go);
  document.addEventListener("visibilitychange", go);
  setInterval(go, REPLAY_EVERY_MS);
  go();
}

// Forget everything queued on this phone (Sign out; the caller warns first when count() > 0).
export async function wipe() {
  mem.clear();
  await tx("readwrite", (s) => s.clear());
  emit();
}
