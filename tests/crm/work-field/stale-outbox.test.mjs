// The phone's outbox and stale items (design §2.5 "Outbox", §11.4 M4b
// "stale-outbox.test.mjs"): items older than 6 days are never replayed
// (idempotency records last 7): they go once to POST /outbox-review, which
// keeps them as one pending action for the office. Fresh items replay in
// order; a 5xx or no signal keeps them; a refusal drops only that one.
// The client modules run here as they do on the phone (no IndexedDB in
// node: the outbox's in-memory store), against the real API.
import { test, afterEach } from "node:test";
import assert from "node:assert/strict";
import { setup, customer, job, visit, clock, store, cid, rec } from "./fixtures.mjs";

const outbox = await import("../../../crm-app/core/outbox.js");
const api = await import("../../../crm-app/core/api.js");
const kit = await import("../../../crm-app/modules/work/tech-kit.js");

// The app's fetch, routed into the real API handler as the signed-in tech.
function phoneFetch(t, as, { online = () => true, seen = [] } = {}) {
  const real = globalThis.fetch;
  globalThis.fetch = async (url, init = {}) => {
    if (!online()) throw new TypeError("Failed to fetch");
    const u = new URL(url, "https://www.bartawindowwashing.com");
    seen.push(`${init.method || "GET"} ${u.pathname}`);
    const headers = Object.fromEntries(Object.entries(init.headers || {}).map(([k, v]) => [k.toLowerCase(), v]));
    const r = await t.api(u.pathname.replace(/^\/api\/crm/, "") + u.search, { method: init.method || "GET", as, headers, body: init.body ? JSON.parse(init.body) : undefined });
    return new Response(r.text, { status: r.status, headers: { "content-type": "application/json" } });
  };
  return () => { globalThis.fetch = real; };
}

// node has its own navigator (onLine undefined: "online"); a test may say otherwise
const NAV = Object.getOwnPropertyDescriptor(globalThis, "navigator");
const setNav = (v) => Object.defineProperty(globalThis, "navigator", { value: v, configurable: true, writable: true });
afterEach(async () => { await outbox.wipe(); if (NAV) Object.defineProperty(globalThis, "navigator", NAV); });

test("items older than 6 days go to outbox-review once, never replayed; the rest replay in order", async () => {
  const { t, owner, tech } = await setup();
  const seen = [];
  const restore = phoneFetch(t, tech, { seen });
  try {
    const v = await visit(owner, await job(owner, await customer(owner)), { date: "2026-11-17", start: "09:00", end: "11:00", assignee_ids: [tech.id] });
    // a note queued 8 days ago (a phone that stayed in a drawer), two from today
    const old = await outbox.enqueue({ path: `/visits/${v.id}/notes`, body: { client_id: cid(), text: "Synthetic: old note.", queued_offline: true } });
    const mem = await outbox.list();
    const eightDays = new Date(Date.now() - 8 * 86400000).toISOString();
    Object.assign(mem.find((i) => i.key === old.key), { queued_at: eightDays, client_at: eightDays });
    await outbox.enqueue({ path: `/visits/${v.id}/notes`, body: { client_id: cid(), text: "Synthetic: first.", queued_offline: true, client_at: clock.nowIso(), queued_at: clock.nowIso() } });
    await outbox.enqueue({ path: `/visits/${v.id}/notes`, body: { client_id: cid(), text: "Synthetic: second.", queued_offline: true, client_at: clock.nowIso(), queued_at: clock.nowIso() } });

    const r = await outbox.replay();
    assert.deepEqual({ sent: r.sent, review: r.review, left: r.left }, { sent: 2, review: 1, left: 0 });
    assert.deepEqual(seen, [`POST /api/crm/visits/${v.id}/notes`, `POST /api/crm/visits/${v.id}/notes`, "POST /api/crm/outbox-review"]);
    const after = await rec("visit", v.id);
    assert.equal(after.tech_notes, "Synthetic: first.\n\nSynthetic: second.", "in order, and the stale one was never applied");
    const pa = t.stores.data.keys("rec/pending_action/").map((k) => t.stores.data.json(k));
    assert.equal(pa.length, 1);
    assert.equal(pa[0].kind, "outbox_review");
    assert.equal(pa[0].items.length, 1);
    assert.equal(pa[0].items[0].path, `/visits/${v.id}/notes`);
    assert.equal(pa[0].requested_by, tech.id);
    // replaying again sends nothing more
    seen.length = 0;
    await outbox.replay();
    assert.deepEqual(seen, []);
  } finally { restore(); t.done(); }
});

test("no signal keeps everything; a refusal drops only that item; tech-kit send() queues when offline and goes straight out online", async () => {
  const { t, owner, tech } = await setup();
  let up = false;
  const seen = [];
  const restore = phoneFetch(t, tech, { online: () => up, seen });
  setNav({ onLine: false });
  try {
    const v = await visit(owner, await job(owner, await customer(owner)), { date: "2026-11-17", start: "09:00", end: "11:00", assignee_ids: [tech.id] });
    const ctx = { api: api.api };
    const a = await kit.send(ctx, `/visits/${v.id}/checklist`, { key: "glass", done: true }, { method: "PATCH" });
    assert.equal(a.queued, true);
    const b = await kit.send(ctx, `/visits/${v.id}/checklist`, { key: "not_an_item", done: true }, { method: "PATCH" });
    assert.equal(b.queued, true);
    const c = await kit.send(ctx, `/visits/${v.id}/notes`, { text: "Synthetic: queued." });
    assert.equal(c.queued, true);
    const items = await outbox.list();
    assert.ok(items.every((i) => i.body.queued_offline === true && i.body.client_id && i.body.queued_at === i.body.client_at));
    await assert.rejects(() => kit.send(ctx, `/visits/${v.id}/on-my-way`, { eta_min: 10 }, { needsSignal: true, what: "On my way" }), (e) => e.code === "needs_signal");
    assert.equal(await outbox.count(), 3, "on my way never queues");

    let r = await outbox.replay();
    assert.equal(r.sent, 0, "still offline: nothing lost");
    assert.equal(await outbox.count(), 3);
    up = true;
    setNav({ onLine: true });
    const refused = [];
    r = await outbox.replay({ onRefused: (i, e) => refused.push([i.body.key, e.status]) });
    assert.equal(r.sent, 2);
    assert.deepEqual(refused, [["not_an_item", 400]], "the bad tick is refused; the rest went");
    const after = await rec("visit", v.id);
    assert.ok(after.checklist.items.find((i) => i.key === "glass").done_at);
    assert.equal(after.tech_notes, "Synthetic: queued.");
    // online with nothing waiting: straight to the server
    const d = await kit.send(ctx, `/visits/${v.id}/notes`, { text: "Synthetic: live." });
    assert.equal(d.sent, true);
    assert.match(d.data.visit.tech_notes, /live/);
    void store;
  } finally { restore(); t.done(); }
});

test("the overlay: what waits on the phone is laid over the last copy (ticks, notes, photos, the timer, completion, the clock)", () => {
  const uid = "us_0000000000000000000t";
  const v = { id: "vs_00000000000000000001", status: "scheduled", checklist: { items: [{ key: "glass", label: "Glass" }, { key: "after_photo", label: "After photo", kind: "photo", required: true }] }, photos: [], tech_notes: "" };
  const at = (m) => `2026-11-17T15:${String(m).padStart(2, "0")}:00.000Z`;
  const item = (what, body, m) => ({ path: `/visits/${v.id}/${what}`, body: { client_id: `c-${what}-${m}`, client_at: at(m), ...body } });
  const items = [
    item("timer", { action: "start" }, 0), item("checklist", { key: "glass", done: true }, 5), item("photos", { tag: "after", item: "after_photo", thumb: "AAAA" }, 10),
    item("notes", { text: "Synthetic: a note." }, 12), item("timer", { action: "pause" }, 20), item("timer", { action: "start" }, 25), item("complete", {}, 40),
    { path: "/visits/vs_00000000000000000099/notes", body: { text: "another visit" } },
  ];
  const o = kit.overlayVisit(v, items, uid, []);
  assert.equal(o.waiting, 7);
  assert.equal(o.visit.status, "completed");
  assert.equal(o.visit.completion.at, at(40));
  assert.equal(o.visit.checklist.items[0].done_at, at(5));
  assert.equal(o.visit.checklist.items[1].done_at, at(10), "the photo ticks its item");
  assert.equal(o.visit.photos[0].thumb, "data:image/jpeg;base64,AAAA");
  assert.equal(o.visit.tech_notes, "Synthetic: a note.");
  assert.deepEqual(o.timers.map((x) => [x.start_at, x.end_at, x.minutes]), [[at(0), at(20), 20], [at(25), at(40), 15]]);
  assert.equal(v.status, "scheduled", "the last copy itself is untouched");
  const day = kit.overlayDay({ clock: { open: null }, stops: [{ visit: v, timers: [] }] }, items, uid);
  assert.ok(day.clock.open, "starting a timer clocks in");
  assert.equal(day.stops[0].visit.status, "completed");
  const out = kit.overlayDay({ clock: { open: { start_at: at(0) } }, stops: [] }, [{ path: "/clock", body: { action: "out", client_at: at(50) } }], uid);
  assert.equal(out.clock.open, null);
});
