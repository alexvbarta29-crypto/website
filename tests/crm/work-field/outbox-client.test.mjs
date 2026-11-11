// The phone's outbox (crm-app/core/outbox.js) and tech-kit send(), run in
// node with a small fake IndexedDB (design §2.5 "Outbox"; M4b review C1-C5):
// nothing queued is lost on a 401, a full phone, a refusal, a clock set
// back or a slow photo; nothing one person queued is sent as, or shown to,
// another.
import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";

// ---------------------------------------------------------------- a small fake IndexedDB
function fakeIDB({ quotaFull = () => false } = {}) {
  const dbs = new Map();
  const deleted = [];
  const later = (fn) => setTimeout(fn, 0);
  function makeDb(name) {
    const stores = dbs.get(name) || new Map();
    dbs.set(name, stores);
    return {
      createObjectStore(s) { stores.set(s, new Map()); },
      transaction(s) {
        if (!stores.has(s)) stores.set(s, new Map());
        const data = stores.get(s);
        const t = { oncomplete: null, onerror: null, onabort: null };
        let failed = false;
        const req = (result) => ({ result });
        t.objectStore = () => ({
          put(v, k) {
            if (quotaFull()) { failed = true; return { error: new Error("QuotaExceededError") }; }
            const key = k !== undefined ? k : v.key; data.set(key, structuredClone(v)); return req(key);
          },
          getAll() { return req([...data.values()].map((x) => structuredClone(x))); },
          get(k) { return req(data.has(k) ? structuredClone(data.get(k)) : undefined); },
          delete(k) { data.delete(k); return req(undefined); },
          clear() { data.clear(); return req(undefined); },
        });
        later(() => (failed ? t.onabort && t.onabort() : t.oncomplete && t.oncomplete()));
        return t;
      },
    };
  }
  return {
    deleted, dbs,
    open(name) {
      const r = { result: null, onsuccess: null, onupgradeneeded: null, onerror: null };
      later(() => { r.result = makeDb(name); if (r.onupgradeneeded) r.onupgradeneeded(); if (r.onsuccess) r.onsuccess(); });
      return r;
    },
    deleteDatabase(name) { deleted.push(name); dbs.delete(name); return {}; },
  };
}

let full = false;
const idb = fakeIDB({ quotaFull: () => full });
globalThis.indexedDB = idb;
const replaced = [];
globalThis.location = { hash: "#/visits/x", replace: (u) => replaced.push(u) };
const json = (status, body) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
const ok = (data = {}) => json(200, { ok: true, data });
let seen = [];
let respond = () => ok();
globalThis.fetch = async (url, init = {}) => {
  const path = String(url).replace(/^.*\/api\/crm/, "");
  const req = { path, method: init.method, headers: init.headers || {}, body: init.body ? JSON.parse(init.body) : null, bytes: init.body ? Buffer.byteLength(init.body) : 0, signal: init.signal };
  seen.push(req);
  return respond(req);
};

const outbox = await import("../../../crm-app/core/outbox.js");
const kit = await import("../../../crm-app/modules/work/tech-kit.js");
const cache = await import("../../../crm-app/core/cache.js");
const api = await import("../../../crm-app/core/api.js");

const A = "us_aaaaaaaaaaaaaaaaaaaa";
const B = "us_bbbbbbbbbbbbbbbbbbbb";
beforeEach(async () => {
  full = false;
  seen = [];
  respond = () => ok();
  outbox.setUser(A);
  await outbox.wipe();
});
const paths = (list) => list.map((r) => r.path);

test("C1 a 401 in the middle of a replay stops it and keeps every item; the read cache goes, the outbox stays until the next sign-in", async () => {
  respond = (r) => (seen.length === 1 ? ok() : json(401, { ok: false, error: { code: "signed_out", message: "Sign in again." } }));
  for (const p of ["/clock", "/visits/vs_1/timer", "/visits/vs_1/photos", "/visits/vs_1/checklist", "/visits/vs_1/complete", "/clock"]) await outbox.enqueue({ path: p, body: { client_id: "c-" + p.length + "-" + Math.random().toString(36).slice(2, 8), queued_offline: true } });
  const r = await outbox.replay();
  await new Promise((x) => setTimeout(x, 20));
  assert.equal(r.sent, 1);
  assert.equal(r.refused, 0);
  assert.equal(r.stopped, "signed_out");
  assert.equal(await outbox.count(), 5, "nothing dropped");
  assert.equal(seen.length, 2, "it stopped at the 401");
  assert.ok(!idb.deleted.includes("crm-outbox"), "the outbox isn't deleted");
  await cache.wipe();
  assert.ok(!idb.deleted.includes("crm-outbox"), "nor by the sign-in page's wipe");
  // the same person signs in again: theirs go out
  respond = () => ok();
  assert.equal(await outbox.claim(A), 5);
  const again = await outbox.replay();
  assert.equal(again.sent, 5);
  assert.equal(await outbox.count(), 0);
});

test("B4 another person signs in on the phone: the last person's unsent items are deleted unseen, never sent as the new one", async () => {
  outbox.setUser(A);
  await outbox.enqueue({ path: "/visits/vs_1/notes", body: { client_id: "aaaaaaaa-0001", text: "Synthetic: A's note." } });
  await outbox.enqueue({ path: "/clock", body: { client_id: "aaaaaaaa-0002", action: "out" } });
  outbox.setUser(B);
  assert.equal(await outbox.count(), 0, "B never sees A's items");
  assert.deepEqual(await outbox.list(), []);
  assert.equal(await outbox.claim(B), 0);
  const r = await outbox.replay();
  assert.equal(r.sent, 0);
  assert.equal(seen.length, 0, "nothing of A's was sent as B");
  outbox.setUser(A);
  assert.equal(await outbox.count(), 0, "and they're gone");
  // B's own, stamped with B
  outbox.setUser(B);
  const it = await outbox.enqueue({ path: "/clock", body: { action: "in" } });
  assert.equal(it.user_id, B);
});

test("C2 storage full: the item waits in memory (saved: false), is listed, and is sent", async () => {
  await outbox.enqueue({ path: "/visits/vs_1/timer", body: { action: "start" } });
  full = true;
  const item = await outbox.enqueue({ path: "/visits/vs_1/complete", body: {} });
  full = false;
  assert.equal(item.saved, false, "the screen says this phone is full");
  assert.deepEqual(paths(await outbox.list()), ["/visits/vs_1/timer", "/visits/vs_1/complete"]);
  const r = await outbox.replay();
  assert.equal(r.sent, 2);
  assert.deepEqual(paths(seen), ["/visits/vs_1/timer", "/visits/vs_1/complete"]);
  assert.equal(r.left, 0);
  // send() passes it on
  full = true;
  const NAV = Object.getOwnPropertyDescriptor(globalThis, "navigator");
  Object.defineProperty(globalThis, "navigator", { value: { onLine: false }, configurable: true, writable: true });
  const s = await kit.send({ api: api.api }, "/visits/vs_1/notes", { text: "Synthetic" });
  full = false;
  if (NAV) Object.defineProperty(globalThis, "navigator", NAV);
  assert.deepEqual(s, { queued: true, saved: false });
  assert.match(kit.FULL_NOTE, /This phone is full; this change isn't saved/);
});

test("C3 a refusal during a replay send() started is told (onRefused, whoever started it) and goes to the office's review, bytes left out", async () => {
  const told = [];
  outbox.start({ onRefused: (i, e) => told.push([i.path, e.status]) });
  respond = (r) => (r.path === "/outbox-review" ? json(201, { ok: true, data: { pending_action_id: "pa_1" } }) : json(404, { ok: false, error: { code: "not_found", message: "That visit isn't there." } }));
  await outbox.enqueue({ path: "/visits/vs_gone/photos", body: { client_id: "aaaaaaaa-1111", tag: "before", data: Buffer.alloc(30000, 1).toString("base64"), thumb: "AAAA", queued_offline: true } });
  const r = await kit.send({ api: async () => { throw new Error("not used: something waits"); } }, "/visits/vs_gone/notes", { text: "Synthetic note" });
  assert.equal(r.queued, true);
  await new Promise((x) => setTimeout(x, 60));
  assert.deepEqual(told, [["/visits/vs_gone/photos", 404], ["/visits/vs_gone/notes", 404]]);
  const review = seen.filter((x) => x.path === "/outbox-review");
  assert.equal(review.length, 1);
  const items = review[0].body.items;
  assert.deepEqual(items.map((i) => i.path), ["/visits/vs_gone/photos", "/visits/vs_gone/notes"]);
  assert.equal(items[0].body.data, undefined, "no photo bytes in the review");
  assert.equal(items[0].body.thumb, undefined);
  assert.equal(items[0].body.data_bytes, 30000);
  assert.equal(items[0].body.refused.status, 404);
  assert.equal(items[1].body.text, "Synthetic note", "the note's words reach the office");
  assert.equal(await outbox.count(), 0);
});

test("C4 the order is a sequence kept with the items: a phone clock set back while items wait changes nothing", async () => {
  const real = Date.now;
  try {
    await outbox.enqueue({ path: "/clock", body: { action: "in" } });
    await outbox.enqueue({ path: "/visits/vs_1/timer", body: { action: "start" } });
    Date.now = () => real() - 3600000;
    await outbox.enqueue({ path: "/visits/vs_1/complete", body: {} });
    await outbox.enqueue({ path: "/clock", body: { action: "out" } });
  } finally { Date.now = real; }
  assert.deepEqual((await outbox.list()).map((i) => `${i.path}:${i.body.action || ""}`), ["/clock:in", "/visits/vs_1/timer:start", "/visits/vs_1/complete:", "/clock:out"]);
});

test("C5 a big photo on a slow line gets the time its size needs; a photo that can't get through holds back only its own visit", async () => {
  assert.ok(outbox.timeoutFor({ data: "x".repeat(1200000) }) >= 55000, "1.2 MB: about a minute");
  assert.ok(outbox.timeoutFor({ action: "out" }) < 10100, "a small change: the usual 10 s");
  // the photo's server stumbles: the same visit's completion waits behind it, the clock-out and another visit go
  respond = (r) => (r.path === "/visits/vs_1/photos" ? json(503, { ok: false, error: { code: "busy", message: "Try again." } }) : ok());
  await outbox.enqueue({ path: "/visits/vs_1/photos", body: { tag: "after", data: "AAAA" } });
  await outbox.enqueue({ path: "/visits/vs_1/complete", body: {} });
  await outbox.enqueue({ path: "/visits/vs_2/notes", body: { text: "Synthetic" } });
  await outbox.enqueue({ path: "/clock", body: { action: "out" } });
  const r = await outbox.replay();
  assert.deepEqual(paths(seen), ["/visits/vs_1/photos", "/visits/vs_2/notes", "/clock"]);
  assert.equal(r.sent, 2);
  assert.deepEqual(paths(await outbox.list()), ["/visits/vs_1/photos", "/visits/vs_1/complete"], "in order within the visit");
  // each try says the phone's clock as it sends (the server sees a phone whose clock is off)
  assert.ok(seen.every((x) => Date.parse(x.headers["X-CRM-Sent-At"]) > 0));
  // the photo goes; then the completion
  seen = [];
  respond = () => ok();
  await outbox.replay();
  assert.deepEqual(paths(seen), ["/visits/vs_1/photos", "/visits/vs_1/complete"]);
});

test("M2 a week-old queue with photos reaches the office: each photo is held first, the review carries no bytes, batches stay under the caps, one bad item doesn't block the rest", async () => {
  const old = new Date(Date.now() - 8 * 86400000).toISOString();
  const mk = async (path, body) => {
    const it = await outbox.enqueue({ path, body: { client_id: `aaaaaaaa-${Math.random().toString(36).slice(2, 10)}`, queued_offline: true, ...body } });
    const db = idb.dbs.get("crm-outbox").get("items");
    db.set(it.key, { ...db.get(it.key), queued_at: old, client_at: old });
    return it;
  };
  for (let i = 0; i < 3; i++) await mk("/visits/vs_1/photos", { tag: "before", data: Buffer.alloc(600 * 1024, i + 1).toString("base64") });
  await mk("/visits/vs_1/notes", { text: "x".repeat(5000) });
  const bad = await mk("/visits/vs_1/checklist", { key: "gate_closed", done: true });
  let reviewCalls = 0;
  respond = (r) => {
    if (/\/photos$/.test(r.path)) return json(202, { ok: true, data: { pending_entry_id: "ts_1", file_id: "fl_" + r.body.client_id.slice(-8), pending: true } });
    if (r.path === "/outbox-review") {
      reviewCalls += 1;
      const at = r.body.items.findIndex((i) => i.idempotency_key === bad.key);
      if (at >= 0) return json(400, { ok: false, error: { code: "invalid", message: "That item's path isn't valid.", field: `items.${at}.path` } });
      return json(201, { ok: true, data: { pending_action_id: "pa_1" } });
    }
    return ok();
  };
  const told = [];
  const r = await outbox.replay({ onRefused: (i, e) => told.push(i.path) });
  const holds = seen.filter((x) => /\/photos$/.test(x.path));
  assert.equal(holds.length, 3, "each photo kept on an entry first");
  assert.ok(holds.every((h) => h.body.hold === true && h.headers["Idempotency-Key"].startsWith("hold-")));
  const reviews = seen.filter((x) => x.path === "/outbox-review");
  for (const x of reviews) {
    assert.ok(x.bytes < 512 * 1024, "under the route's cap");
    for (const i of x.body.items) {
      assert.ok(JSON.stringify(i.body).length <= 8000, "under the item cap");
      assert.equal(i.body.data, undefined);
    }
  }
  const last = reviews[reviews.length - 1].body.items;
  assert.equal(last.length, 4, "three photos and the note");
  assert.ok(last.filter((i) => i.path.endsWith("/photos")).every((i) => i.body.held && i.body.held.file_id));
  assert.deepEqual(told, ["/visits/vs_1/checklist"], "the one the office can't take is said once");
  assert.equal(r.review, 4);
  assert.equal(await outbox.count(), 0, "nothing retries forever");
  assert.ok(reviewCalls >= 2);
});

test("send(): a 5xx on the direct attempt queues the change under the same key (a landed one is never done twice)", async () => {
  let n = 0;
  respond = (r) => { n += 1; return n === 1 ? json(502, { ok: false, error: { code: "busy", message: "Bad gateway." } }) : ok({ visit: {} }); };
  const s = await kit.send({ api: api.api }, "/visits/vs_1/notes", { text: "Synthetic" });
  assert.equal(s.queued, true);
  await new Promise((x) => setTimeout(x, 30));
  assert.equal(seen.length, 2);
  assert.equal(seen[0].headers["Idempotency-Key"], seen[1].headers["Idempotency-Key"], "the same Idempotency-Key");
  assert.equal(seen[0].body.client_id, seen[1].body.client_id, "the same client id");
  assert.equal(seen[1].body.queued_offline, true);
  // a 4xx is the server's answer: shown, not queued
  respond = () => json(400, { ok: false, error: { code: "invalid", message: "Write the note." } });
  await assert.rejects(() => kit.send({ api: api.api }, "/visits/vs_1/notes", { text: "" }), (e) => e.status === 400);
  assert.equal(await outbox.count(), 0);
});
