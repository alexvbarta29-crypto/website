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
// - queued_at and client_at come from the device: the server decides
//   whether to trust them (§2.5 "Times from the device").
// - Items older than 6 days are not replayed (idempotency records last 7):
//   they go once to POST /outbox-review as one approval for the office.
// - A definitive refusal (4xx) drops the item and is reported through
//   onRefused, so the screen can show it; a 5xx or no signal keeps it.
// - Sign-out wipes the database (core/cache.js wipe()).
// Anything that contacts a customer (on-my-way texts, card payments,
// sending a quote) never queues: it needs signal.

import { api, uuid } from "./api.js";

const DB = "crm-outbox";
const STORE = "items";
export const STALE_MS = 6 * 24 * 3600 * 1000;
export const REPLAY_EVERY_MS = 30000;

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
const mem = new Map();   // when IndexedDB is unavailable (private mode): this page's life only

function tx(mode, fn) {
  return db().then((d) => new Promise((resolve) => {
    if (!d) return resolve(fn(null));
    try {
      const t = d.transaction(STORE, mode);
      const r = fn(t.objectStore(STORE));
      t.oncomplete = () => resolve(r && "result" in r ? r.result : r);
      t.onerror = () => resolve(null);
      t.onabort = () => resolve(null);
    } catch (e) { resolve(null); }
  }));
}

// Queues a change. → the item ({ key, method, path, body, queued_at, client_at, seq }).
let seq = 0;
export async function enqueue({ method = "POST", path, body = {}, ifMatch } = {}) {
  if (typeof path !== "string" || !path.startsWith("/")) throw new TypeError("outbox: path must start with /");
  const at = new Date().toISOString();
  const item = { key: uuid(), method: method.toUpperCase(), path, body, ifMatch: ifMatch || null, queued_at: at, client_at: at, seq: Date.now() * 1000 + (seq++ % 1000) };
  const ok = await tx("readwrite", (s) => (s ? s.put(item) : (mem.set(item.key, item), true)));
  if (ok === null && !mem.has(item.key)) mem.set(item.key, item);
  emit();
  return item;
}

export async function list() {
  const rows = await tx("readonly", (s) => (s ? s.getAll() : [...mem.values()]));
  return (Array.isArray(rows) ? rows : [...mem.values()]).sort((a, b) => a.seq - b.seq);
}
export async function count() { return (await list()).length; }
async function remove(key) {
  mem.delete(key);
  await tx("readwrite", (s) => (s ? s.delete(key) : true));
}

const listeners = new Set();
export function onChange(fn) { listeners.add(fn); return () => listeners.delete(fn); }
function emit() { count().then((n) => listeners.forEach((fn) => { try { fn(n); } catch (e) { /* a listener failed */ } })); }

// Sends what is queued, oldest first. → { sent, refused, review, left }.
let replaying = false;
export async function replay({ onRefused } = {}) {
  if (replaying) return { sent: 0, refused: 0, review: 0, left: await count() };
  replaying = true;
  let sent = 0, refused = 0, review = 0;
  try {
    const items = await list();
    const now = Date.now();
    const stale = items.filter((i) => now - Date.parse(i.queued_at) > STALE_MS);
    if (stale.length) {
      try {
        await api("/outbox-review", { method: "POST", body: { items: stale.map((i) => ({ method: i.method, path: i.path, body: i.body, queued_at: i.queued_at, client_at: i.client_at, idempotency_key: i.key })) }, idempotencyKey: "review-" + stale[0].key });
        for (const i of stale) await remove(i.key);
        review = stale.length;
      } catch (e) {
        if (e && e.code === "offline") return { sent, refused, review, left: items.length };
      }
    }
    for (const i of items.filter((x) => !stale.includes(x))) {
      try {
        await api(i.path, { method: i.method, body: i.body, ifMatch: i.ifMatch || undefined, idempotencyKey: i.key });
        await remove(i.key);
        sent += 1;
      } catch (e) {
        if (!e || e.code === "offline" || !e.status || e.status >= 500 || e.status === 409 && e.code === "in_progress") break;
        await remove(i.key);
        refused += 1;
        if (onRefused) { try { onRefused(i, e); } catch (x) { /* ignore */ } }
      }
    }
  } finally {
    replaying = false;
    emit();
  }
  return { sent, refused, review, left: await count() };
}

// Replays on online, focus and every 30 s while the app is on screen.
let started = false;
export function start(opts = {}) {
  if (started || typeof window === "undefined") return;
  started = true;
  const go = () => { if (!document.hidden && navigator.onLine !== false) replay(opts).catch(() => {}); };
  window.addEventListener("online", go);
  window.addEventListener("focus", go);
  document.addEventListener("visibilitychange", go);
  setInterval(go, REPLAY_EVERY_MS);
  go();
}

// Forget everything queued (sign-out; the caller warns first when count() > 0).
export async function wipe() {
  mem.clear();
  await tx("readwrite", (s) => (s ? s.clear() : true));
  emit();
}
