// Barta CRM client: the last good copy of what the app read (design §2.3,
// §2.5). A memory map in front of IndexedDB (database "crm-cache"), keyed
// by URL, holding { data, meta, etag, at }. api.js reads it when a GET
// times out or the phone has no signal, and the screen shows "as of".
// Signing out wipes it (and the service worker's copy of the shell), so the
// next person on the phone sees nothing of the last one's.
//
// Every IndexedDB call is wrapped: private browsing, a full disk or an old
// Safari just means no offline copy, never a broken screen.

const DB = "crm-cache";
const STORE = "kv";
const mem = new Map();
let dbp = null;

function db() {
  if (dbp) return dbp;
  dbp = new Promise((resolve) => {
    try {
      if (typeof indexedDB === "undefined") return resolve(null);
      const req = indexedDB.open(DB, 1);
      req.onupgradeneeded = () => { try { req.result.createObjectStore(STORE); } catch (e) { /* exists */ } };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => resolve(null);
      req.onblocked = () => resolve(null);
    } catch (e) { resolve(null); }
  });
  return dbp;
}

function tx(mode, fn) {
  return db().then((d) => new Promise((resolve) => {
    if (!d) return resolve(null);
    try {
      const t = d.transaction(STORE, mode);
      const r = fn(t.objectStore(STORE));
      t.oncomplete = () => resolve(r && "result" in r ? r.result : null);
      t.onerror = () => resolve(null);
      t.onabort = () => resolve(null);
    } catch (e) { resolve(null); }
  }));
}

export async function get(key) {
  if (mem.has(key)) return mem.get(key);
  const v = await tx("readonly", (s) => s.get(key));
  if (v) mem.set(key, v);
  return v || null;
}

export async function put(key, value) {
  const v = { data: value.data, meta: value.meta, etag: value.etag, at: new Date().toISOString() };
  mem.set(key, v);
  await tx("readwrite", (s) => s.put(v, key));
}

export async function del(key) {
  mem.delete(key);
  await tx("readwrite", (s) => s.delete(key));
}

// Forget everything this phone kept for the signed-in person.
export async function wipe() {
  mem.clear();
  await tx("readwrite", (s) => s.clear());
  try {
    if (typeof caches !== "undefined") {
      const names = await caches.keys();
      await Promise.all(names.filter((n) => n === "crm-shell").map((n) => caches.delete(n)));
    }
  } catch (e) { /* no Cache Storage */ }
  try { if (typeof indexedDB !== "undefined" && indexedDB.deleteDatabase) indexedDB.deleteDatabase("crm-outbox"); } catch (e) { /* none */ }
}
