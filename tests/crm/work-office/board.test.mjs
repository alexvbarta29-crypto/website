// The desk's drag and drop, the side panel and the head's tools
// (office-board.js, office-vpanel.js, office-schedule.js): what a drop
// changes and the API calls it makes (the conflict check and its question,
// a fresh read for If-Match, the PATCH or the booking, the undo), the same
// against the real API with a conflict, the side panel and its address, Esc,
// a shared link on a phone, search, what the cards show, the week strip.
// Synthetic people only.
import { test } from "node:test";
import assert from "node:assert/strict";
import { setup, customer, job, visit, store } from "./fixtures.mjs";

globalThis.window = globalThis.window || { __crm: { session: { perms: { "schedule:read": true, "schedule:write": true } } } };
const B = await import("../../../crm-app/modules/work/office-board.js");
const P = await import("../../../crm-app/modules/work/office-vpanel.js");
const SC = await import("../../../crm-app/modules/work/office-schedule.js");
const text = (safe) => String(safe);
const U1 = "us_0000000000000000000t", U2 = "us_0000000000000000000u";
const row = (o = {}) => ({ id: "vs_00000000000000000001", j: "jb_00000000000000000001", cn: "Pat Sample", town: "Delano", ad: "1 Example Ave, Delano", d: "2026-11-24", s: "08:00", e: "10:00", w: { t: "window", m: 120 }, a: [U1], st: "scheduled", t: "Exterior window cleaning", ...o });
const slot = (o = {}) => ({ id: "vs_00000000000000000001", date: "2026-11-24", start: "08:00", end: "10:00", assignee_ids: [U1], status: "scheduled", ...o });

// A fake api: answers by path, records every call.
function fakeApi(answers = {}) {
  const calls = [];
  const api = async (path, opts = {}) => {
    const method = (opts.method || "GET").toUpperCase();
    calls.push({ method, path, body: opts.body, ifMatch: opts.ifMatch });
    for (const [re, fn] of Object.entries(answers)) {
      const [m, p] = re.split(" ");
      if (m === method && new RegExp(p).test(path)) return fn(path, opts);
    }
    throw Object.assign(new Error("no answer for " + method + " " + path), { status: 500 });
  };
  return { api, calls };
}

test("planning a drop: the people after it, the slot, only what changes", () => {
  assert.deepEqual(B.reassign([U1], U1, U2), [U2], "from Theo's row to Tess's");
  assert.deepEqual(B.reassign([U1, "us_x"], U1, U2), [U2, "us_x"], "the other person stays");
  assert.deepEqual(B.reassign([U1, U2], U1, U2), [U2], "already on it");
  assert.deepEqual(B.reassign([], "", U2), [U2], "from Unassigned");
  assert.deepEqual(B.reassign([U1], U1, ""), [], "onto Unassigned");
  assert.deepEqual(B.reassign([U1], U1, U1), [U1]);
  // the week board: another day, keeping the time
  let p = B.planMove(row(), U1, { day: "2026-11-25", user: U2 });
  assert.deepEqual(p.patch, { date: "2026-11-25", assignee_ids: [U2] });
  assert.equal(p.moving, true);
  // the lanes: a time, snapped to 15 minutes, the length kept
  p = B.planMove(row(), U1, { day: "2026-11-24", user: U1, minute: 13 * 60 + 7 });
  assert.deepEqual(p.patch, { start: "13:00", end: "15:00" });
  // an anytime visit dropped on a time gets a real time
  p = B.planMove(row({ do: true }), U1, { day: "2026-11-24", user: U1, minute: 9 * 60 });
  assert.deepEqual(p.patch, { start: "09:00", end: "11:00", date_only: false });
  // a person only: an assignment, not a move; nothing at all: nothing
  p = B.planMove(row(), U1, { day: "2026-11-24", user: U2 });
  assert.deepEqual([p.patch, p.moving], [{ assignee_ids: [U2] }, false]);
  assert.deepEqual(B.planMove(row(), U1, { day: "2026-11-24", user: U1 }).patch, {});
  // 3 Day (no person): the day and time, the people kept
  assert.deepEqual(B.planMove(row(), U1, { day: "2026-11-26", minute: 600 }).patch, { date: "2026-11-26", start: "10:00", end: "12:00" });
  assert.equal(B.planMove(row(), U1, { day: "2026-11-24", minute: 23 * 60 + 50 }).next.end <= "23:59", true, "never past midnight");
  assert.equal(B.moveWords(row(), B.planMove(row(), U1, { day: "2026-11-25", user: U2 }), [{ id: U2, name: "Tess Rowe" }]), "Pat S. moved to Wed, Nov 25 at 8:00 AM, now with Tess.");
  // the first free slot beside what's booked, in the open hours
  assert.equal(B.firstFreeSlot([[480, 600], [600, 720]], [480, 1080], 120), 720);
  assert.equal(B.firstFreeSlot([[540, 600]], [480, 1080], 60), 480);
  assert.equal(B.firstFreeSlot([[480, 1080]], [480, 1080], 60), null, "full: none");
  assert.equal(B.firstFreeSlot([], null, 60), null, "closed: none");
  assert.deepEqual(B.hoursSpan({ 2: ["08:00", "18:00"] }, "2026-11-24"), [480, 1080]);
  assert.deepEqual(B.dayBounds([{ s: "07:30", e: "19:15" }], [480, 1080]), [420, 1200], "stretched to whole hours");
  const pack = B.lanePack([{ key: "a", from: 480, to: 600 }, { key: "b", from: 540, to: 660 }, { key: "c", from: 660, to: 720 }]);
  assert.deepEqual([pack.get("a"), pack.get("b"), pack.get("c")].map((x) => [x.col, x.cols]), [[0, 2], [1, 2], [0, 1]], "side by side only where they overlap");
  assert.equal(B.sundayOf("2026-11-24"), "2026-11-22");
  assert.deepEqual(B.columnStats([row({ st: "completed", amt: 100 }), row({ st: "in_progress", amt: 50 }), row({ amt: 25 }), row({ st: "cancelled", amt: 999 })]), { total: 3, done: 1, going: 1, amt: 175, amtDone: 100 });
  assert.equal(typeof B.nowMinutes(new Date("2026-11-17T18:30:00Z")), "number");
  assert.equal(B.nowMinutes(new Date("2026-11-17T18:30:00Z")), 12 * 60 + 30, "Delano time");
});

test("dropVisit: the warnings asked first, a fresh read for If-Match, only the change sent; refused when it started, stale or someone changed it; undo puts it back", async () => {
  const fresh = (o = {}) => ({ data: { visit: slot(o) }, etag: '"e1"' });
  // no warnings: check → read → PATCH with If-Match
  let f = fakeApi({ "GET /schedule/check": () => ({ data: { warnings: [] } }), "GET /visits/": () => fresh(), "PATCH /visits/": (p, o) => ({ data: { visit: slot({ date: "2026-11-25", assignee_ids: [U2] }) }, meta: { warnings: [] } }) });
  let asked = 0;
  let r = await B.dropVisit({ api: f.api }, { row: row(), from: U1 }, { day: "2026-11-25", user: U2 }, { confirm: async () => { asked += 1; return true; }, users: [{ id: U2, name: "Tess Rowe" }] });
  assert.equal(r.ok, true);
  assert.equal(asked, 0, "nothing to ask");
  assert.deepEqual(f.calls.map((c) => c.method + " " + c.path.split("?")[0]), ["GET /schedule/check", "GET /visits/vs_00000000000000000001", "PATCH /visits/vs_00000000000000000001"]);
  assert.match(f.calls[0].path, /date=2026-11-25&start=08%3A00&end=10%3A00&users=us_0000000000000000000u&visit=vs_00000000000000000001&town=Delano/);
  assert.deepEqual(f.calls[2].body, { date: "2026-11-25", assignee_ids: [U2] });
  assert.equal(f.calls[2].ifMatch, '"e1"');
  assert.deepEqual(r.undo, { kind: "visit", id: "vs_00000000000000000001", before: { date: "2026-11-24", start: "08:00", end: "10:00", assignee_ids: [U1], date_only: false }, after: { date: "2026-11-25", start: "08:00", end: "10:00", assignee_ids: [U2], date_only: false } });
  // a warning: asked; declined → nothing written
  f = fakeApi({ "GET /schedule/check": () => ({ data: { warnings: [{ code: "time_off", message: "Tess is off." }] } }), "GET /visits/": () => fresh(), "PATCH /visits/": () => ({ data: { visit: slot() } }) });
  let question = null;
  r = await B.dropVisit({ api: f.api }, { row: row(), from: U1 }, { day: "2026-11-25", user: U2 }, { confirm: async (w, yes) => { question = [w.map((x) => x.message), yes]; return false; } });
  assert.deepEqual(question, [["Tess is off."], "Move it"]);
  assert.equal(r.cancelled, true);
  assert.deepEqual(f.calls.map((c) => c.method), ["GET"], "only the check");
  // a visit under way moves no more (its people may change)
  f = fakeApi({});
  r = await B.dropVisit({ api: f.api }, { row: row({ st: "in_progress" }), from: U1 }, { day: "2026-11-25", user: U1 }, {});
  assert.match(r.message, /hasn't started can move/);
  assert.equal(f.calls.length, 0);
  // someone changed it since the schedule was read: never moved on old information
  f = fakeApi({ "GET /schedule/check": () => ({ data: { warnings: [] } }), "GET /visits/": () => fresh({ start: "09:00" }) });
  r = await B.dropVisit({ api: f.api }, { row: row(), from: U1 }, { day: "2026-11-25", user: U1 }, {});
  assert.deepEqual([r.ok, r.reload], [false, true]);
  assert.ok(!f.calls.some((c) => c.method === "PATCH"));
  // a 412 in between
  f = fakeApi({ "GET /schedule/check": () => ({ data: { warnings: [] } }), "GET /visits/": () => fresh(), "PATCH /visits/": () => { throw Object.assign(new Error("stale"), { status: 412 }); } });
  r = await B.dropVisit({ api: f.api }, { row: row(), from: U1 }, { day: "2026-11-25", user: U1 }, {});
  assert.match(r.message, /Someone else just changed this visit/);
  // undo: read, then only what differs, with that read's etag; refused when it changed again
  f = fakeApi({ "GET /visits/": () => ({ data: { visit: slot({ date: "2026-11-25", assignee_ids: [U2] }) }, etag: '"e2"' }), "PATCH /visits/": () => ({ data: { visit: slot() } }) });
  const u = { kind: "visit", id: "vs_00000000000000000001", before: { date: "2026-11-24", start: "08:00", end: "10:00", assignee_ids: [U1], date_only: false }, after: { date: "2026-11-25", start: "08:00", end: "10:00", assignee_ids: [U2], date_only: false } };
  r = await B.undoChange({ api: f.api }, u);
  assert.equal(r.ok, true);
  assert.deepEqual([f.calls[1].body, f.calls[1].ifMatch], [{ date: "2026-11-24", assignee_ids: [U1] }, '"e2"']);
  f = fakeApi({ "GET /visits/": () => ({ data: { visit: slot({ date: "2026-11-27" }) }, etag: '"e3"' }) });
  r = await B.undoChange({ api: f.api }, u);
  assert.match(r.message, /changed again since/);
  assert.equal(f.calls.length, 1, "no write");
  // a booking's undo cancels it (the job goes back to To book)
  f = fakeApi({ "POST /visits/vs_9/cancel": () => ({ data: {} }) });
  r = await B.undoChange({ api: f.api }, { kind: "book", id: "vs_9" });
  assert.deepEqual([r.ok, f.calls[0].body.late], [true, false]);
});

test("dropJob: a job from the tray booked in the person's first free slot that day (or the time it was dropped on), with the default length and window", async () => {
  const data = { hours: { 2: ["08:00", "18:00"] }, defaults: { duration_min: 120, window_min: 120 }, visits: [row(), row({ id: "vs_2", s: "10:00", e: "12:00" }), row({ id: "vs_3", s: "08:00", e: "10:00", a: [U2] })] };
  const f = fakeApi({ "GET /schedule/check": () => ({ data: { warnings: [] } }), "POST /visits": (p, o) => ({ data: { visit: { id: "vs_new" } }, meta: {} }) });
  const r = await B.dropJob({ api: f.api }, { job: { id: "jb_9", cn: "Lee Sample" } }, { day: "2026-11-24", user: U1 }, { data, users: [{ id: U1, name: "Theo Tech" }] });
  assert.equal(r.ok, true);
  const post = f.calls.find((c) => c.method === "POST").body;
  assert.deepEqual({ ...post, client_id: undefined }, { job_id: "jb_9", date: "2026-11-24", start: "12:00", end: "14:00", window: { type: "window", minutes: 120 }, assignee_ids: [U1], client_id: undefined }, "after Theo's two visits");
  assert.match(post.client_id, /^[0-9a-f-]{36}$/, "a retry is the same booking");
  assert.equal(r.text, "Lee S. booked Tue, Nov 24 at 12:00 PM, with Theo.");
  assert.deepEqual(r.undo, { kind: "book", id: "vs_new" });
  const g = fakeApi({ "GET /schedule/check": () => ({ data: { warnings: [] } }), "POST /visits": () => ({ data: { visit: { id: "vs_new" } } }) });
  await B.dropJob({ api: g.api }, { job: { id: "jb_9", cn: "Lee" } }, { day: "2026-11-24", user: "", minute: 14 * 60 + 20 }, { data });
  assert.deepEqual([g.calls[1].body.start, g.calls[1].body.end, g.calls[1].body.assignee_ids], ["14:15", "16:15", []], "a time on Unassigned's column");
});

test("against the real API: a drop onto a day someone is off asks first, moves the visit, and Undo puts it back; a booking from the tray, undone, is cancelled", async () => {
  const { t, owner, tech, tech2 } = await setup();
  try {
    const c = await customer(owner, {}, { town: "Mound" });
    const v = await visit(owner, await job(owner, c), { date: "2026-11-24", start: "09:00", end: "11:00", assignee_ids: [tech.id] });
    await t.api("/time-off", { method: "POST", as: owner, body: { user_id: tech2.id, date: "2026-11-25", reason: "Off" } });
    const ctx = { api: async (path, opts = {}) => {
      const r = await t.api(path, { method: opts.method || "GET", as: owner, body: opts.body, ifMatch: opts.ifMatch });
      if (r.status >= 400) throw Object.assign(new Error((r.body && r.body.error && r.body.error.message) || "failed"), { status: r.status });
      return { data: r.body.data, meta: r.body.meta, etag: r.headers.get("etag") || undefined };
    } };
    const rowOf = async () => (await t.api("/schedule?from=2026-11-24&to=2026-11-25", { as: owner })).body.data.visits.find((x) => x.id === v.id);
    let asked = null;
    const r = await B.dropVisit(ctx, { row: await rowOf(), from: tech.id }, { day: "2026-11-25", user: tech2.id }, { confirm: async (w) => { asked = w.map((x) => x.code); return true; } });
    assert.deepEqual(asked, ["time_off"], "the conflict check, asked before the move");
    assert.equal(r.ok, true, JSON.stringify(r));
    let now = (await store.getRecord("visit", v.id)).data;
    assert.deepEqual([now.date, now.start, now.assignee_ids], ["2026-11-25", "09:00", [tech2.id]]);
    const u = await B.undoChange(ctx, r.undo);
    assert.equal(u.ok, true, JSON.stringify(u));
    now = (await store.getRecord("visit", v.id)).data;
    assert.deepEqual([now.date, now.start, now.assignee_ids], ["2026-11-24", "09:00", [tech.id]]);
    // the tray
    const j = await job(owner, c);
    const data = (await t.api("/schedule?from=2026-11-24&to=2026-11-24", { as: owner })).body.data;
    const b = await B.dropJob(ctx, { job: { id: j.id, cn: "Pat Sample" } }, { day: "2026-11-24", user: tech.id }, { data, confirm: async () => true });
    assert.equal(b.ok, true, JSON.stringify(b));
    const booked = (await store.getRecord("visit", b.undo.id)).data;
    assert.deepEqual([booked.start, booked.end], ["11:00", "13:00"], "after Theo's 9 to 11");
    assert.equal((await store.getRecord("job", j.id)).data.status, "scheduled");
    assert.equal((await B.undoChange(ctx, b.undo)).ok, true);
    assert.equal((await store.getRecord("visit", b.undo.id)).data.status, "cancelled");
    assert.equal((await store.getRecord("job", j.id)).data.status, "unscheduled", "back in To book");
  } finally { t.done(); }
});

test("the side panel: what it shows by what the server allows, its address (?visit=, the office shell told), Esc, a shared link on a phone", async () => {
  const data = {
    visit: { id: "vs_00000000000000000001", date: "2026-11-24", start: "08:00", end: "10:00", window: { type: "window", minutes: 120 }, status: "scheduled", assignee_ids: [U1], town: "Delano", tech_notes: "Synthetic: left a note." },
    job: { id: "jb_1", number_label: "S-000001", title: "Exterior window cleaning", kind: "standard", totals: { total_cents: 29500 }, crew_notes: "Dog in back", office_notes: "Pays by check" },
    contact: { id: "ct_1", display_name: "Pat </script><script>alert(1)</script>", phones: [{ e164: "+17635550100", primary: true }] },
    property: { id: "pr_1", address: { street1: "1 Example Ave", city: "Delano", state: "MN", zip: "55328" }, access: { gate_code: "1234" } },
    people: [{ id: U1, name: "Theo Tech" }], can: { office: true, prices: true, move: true },
  };
  const s = { panel: { id: data.visit.id, data, etag: '"1"' }, users: [{ id: U1, name: "Theo Tech", color: "#2563eb" }] };
  const h = text(P.panelView(s, {}));
  assert.ok(!h.includes("<script>alert(1)"), "escaped");
  for (const x of ["data-pclose", "data-pmove", "data-passign", 'href="#/visits/vs_00000000000000000001"', 'href="tel:+17635550100"', "Navigate", "$295.00", "Gate code", "Dog in back", "Pays by check", "Synthetic: left a note.", "Job S-000001"]) assert.ok(h.includes(x), x);
  assert.match(h, /Navigate/);
  const tech = text(P.panelView({ ...s, panel: { ...s.panel, data: { ...data, can: { office: false, prices: false, move: false } } } }, {}));
  assert.doesNotMatch(tech, /data-pmove|data-passign|\$295|Pays by check/, "no money, office notes or office buttons without the rights");
  assert.doesNotMatch(text(P.panelView({ ...s, panel: { ...s.panel, data: { ...data, visit: { ...data.visit, status: "completed" }, can: { office: true, prices: true, move: false } } } }, {})), /data-pmove|data-passign/, "a done visit: no Move, no Assign");
  assert.match(text(P.panelView({ panel: { id: "vs_x", loading: true } }, {})), /aria-busy="true"/);
  assert.match(text(P.panelView({ panel: { id: "vs_x", error: "That visit isn't there any more." } }, {})), /isn&#39;t there any more[\s\S]*Open visit/);
  assert.equal(P.panelPath({ view: "week", date: "2026-11-24" }, "vs_1"), "/schedule?view=week&date=2026-11-24&visit=vs_1");
  assert.equal(P.panelPath({ view: "month", date: "2026-11-24" }, null), "/schedule?date=2026-11-24");
  assert.ok(P.isVisitId("vs_01m7n0b8em436jqx5qfg") && !P.isVisitId("vs_1") && !P.isVisitId("jb_01m7n0b8em436jqx5qfg"));

  // open: the read, the address in the frame, the shell told; close: the address without it
  const urls = [], posts = [];
  globalThis.history = { state: null, replaceState: (st, t0, u) => urls.push(u) };
  globalThis.location = { hash: "#/schedule", origin: "https://www.bartawindowwashing.com" };
  globalThis.window.parent = { postMessage: (m, o) => posts.push([m, o]) };
  const f = fakeApi({ "GET /visits/": () => ({ data, etag: '"9"' }) });
  const ctx = { api: f.api, state: { view: "day", date: "2026-11-24" } };
  let painted = 0;
  await P.openPanel(ctx, "vs_00000000000000000001", { paint: () => { painted += 1; } });
  assert.equal(ctx.state.panel.etag, '"9"');
  assert.equal(painted, 2, "the loading state, then the visit");
  assert.deepEqual(urls, ["#/schedule?view=day&date=2026-11-24&visit=vs_00000000000000000001"]);
  assert.deepEqual(posts[0], [{ type: "crm:route", path: "/schedule?view=day&date=2026-11-24&visit=vs_00000000000000000001" }, "https://www.bartawindowwashing.com"]);
  P.closePanel(ctx, { paint() {} });
  assert.equal(ctx.state.panel, null);
  assert.equal(urls.at(-1), "#/schedule?view=day&date=2026-11-24");
  assert.equal(ctx.state.back, "vs_00000000000000000001", "focus goes back to the visit");
  delete globalThis.window.parent;

  // a shared link (?visit=) on a phone opens the Visit screen; on a desk its panel; Esc closes the panel
  const users = [{ id: U1, name: "Theo Tech", is_technician: true }];
  const answers = { "GET /users": () => ({ data: users }), "GET /schedule": () => ({ data: { from: "2026-11-01", to: "2026-12-05", month: "2026-11", today: "2026-11-17", visits: [], tasks: [], warnings: {} } }), "GET /visits/": () => ({ data, etag: '"9"' }) };
  globalThis.location = { hash: "#/schedule?view=month&visit=vs_00000000000000000001", origin: "https://www.bartawindowwashing.com" };
  const k = fakeApi(answers);
  let went = null;
  const c1 = { api: k.api, can: () => true, keep: {}, go: (p, o) => { went = [p, o]; }, rerender() {} };
  const st = await SC.default.load({}, c1);
  c1.state = st;
  const el = { querySelector: () => null, querySelectorAll: () => [], closest: () => null };
  SC.default.mount(el, st, c1);
  assert.deepEqual(went, ["/visits/vs_00000000000000000001", { replace: true }], "a phone: the Visit screen");
  SC.default.unmount();
  const keys = [];
  globalThis.document = { addEventListener: (tp, fn) => keys.push(fn), removeEventListener: () => {}, createElement: () => ({}), head: { appendChild() {} } };
  globalThis.matchMedia = () => ({ matches: true });
  try {
    const k2 = fakeApi(answers);
    const c2 = { api: k2.api, can: () => true, keep: {}, go: () => { throw new Error("no navigation on a desk"); }, rerender() {} };
    const st2 = await SC.default.load({}, c2);
    c2.state = st2;
    SC.default.mount(el, st2, c2);
    await new Promise((ok) => setTimeout(ok, 0));
    assert.ok(k2.calls.some((x) => x.path === "/visits/vs_00000000000000000001"), "a desk: the panel reads the visit");
    assert.equal(st2.panel.id, "vs_00000000000000000001");
    let stopped = false;
    keys.at(-1)({ key: "Escape", defaultPrevented: false, preventDefault() { stopped = true; } });
    assert.equal(st2.panel, null, "Esc closes it");
    assert.equal(stopped, true);
    // a click on a visit on a desk opens the panel instead of leaving
    let prevented = false;
    SC.default.events["click [data-vopen]"]({ button: 0, preventDefault() { prevented = true; } }, { dataset: { vopen: "vs_00000000000000000001" } }, c2);
    assert.equal(prevented, true);
    // a modified click keeps the browser's way
    prevented = false;
    SC.default.events["click [data-vopen]"]({ button: 0, metaKey: true, preventDefault() { prevented = true; } }, { dataset: { vopen: "vs_00000000000000000001" } }, c2);
    assert.equal(prevented, false);
    SC.default.unmount();
  } finally { delete globalThis.document; delete globalThis.matchMedia; delete globalThis.location; delete globalThis.history; }
});

test("the head's tools: search what's on screen, what the cards show (saved per person), the week strip, Who", async () => {
  const visits = [row(), row({ id: "vs_2", cn: "Lee Example", ad: "9 Lake St, Mound", town: "Mound", d: "2026-11-25" }), row({ id: "vs_3", cn: "Pat Other", jn: "S-000042", d: "2026-11-20" })];
  assert.deepEqual(SC.searchVisits(visits, "pat").map((v) => v.id), ["vs_3", "vs_00000000000000000001"], "by name, in date order");
  assert.deepEqual(SC.searchVisits(visits, "lake mound").map((v) => v.id), ["vs_2"], "every word, by address");
  assert.deepEqual(SC.searchVisits(visits, "S-000042").map((v) => v.id), ["vs_3"], "by job number");
  assert.deepEqual(SC.searchVisits(visits, "  "), []);
  // the cards: per person, on this device
  const mem = new Map();
  globalThis.localStorage = { getItem: (k) => (mem.has(k) ? mem.get(k) : null), setItem: (k, v) => mem.set(k, String(v)) };
  try {
    assert.deepEqual(B.loadCards("us_a"), { name: true, service: true, price: true, address: false, hideCancelled: false }, "Flyra's defaults");
    B.saveCards("us_a", { ...B.CARD_DEFAULTS, address: true, hideCancelled: true });
    assert.equal(B.loadCards("us_a").address, true);
    assert.equal(B.loadCards("us_b").address, false, "another person's choice is theirs");
    mem.set("crm-sched-cards:us_c", "{not json");
    assert.deepEqual(B.loadCards("us_c"), { ...B.CARD_DEFAULTS });
  } finally { delete globalThis.localStorage; }
  assert.deepEqual(B.cardBits(row({ amt: 29500 }), B.CARD_DEFAULTS, { prices: true }), { title: "Pat Sample", short: "Pat S.", where: "Delano", service: "Exterior window cleaning", price: "$295" });
  assert.deepEqual(B.cardBits(row({ amt: 29500 }), { name: false, service: true, price: true, address: true }, { prices: false }), { title: "Exterior window cleaning", short: "Exterior window cleaning", where: "1 Example Ave, Delano", service: "Exterior window cleaning", price: "" }, "no price without visits:prices");
  // the strip: a day, another week, a swipe
  const s = { view: "day", date: "2026-11-24", today: "2026-11-17", users: [], data: { visits: [] } };
  const h = text(SC.weekStrip(s));
  assert.equal((h.match(/data-sday=/g) || []).length, 7);
  assert.match(h, /class="wk-sday sel"[^>]*data-sday="2026-11-24"/);
  assert.doesNotMatch(h, /today/, "today isn't in this week");
  const reads = [];
  const c = { state: { ...s, month: "2026-11" }, keep: {}, rerender() {}, api: async (p) => { reads.push(p); return { data: { visits: [], tasks: [], warnings: {}, today: "2026-11-17" } }; } };
  SC.default.events["click [data-sday]"]({}, { dataset: { sday: "2026-11-26" } }, c);
  assert.equal(c.state.date, "2026-11-26");
  SC.default.events["click [data-sweek]"]({}, { dataset: { sweek: "1" } }, c);
  assert.equal(c.state.date, "2026-12-03");
  SC.default.events["touchstart [data-strip]"]({ touches: [{ clientX: 300 }] }, {}, c);
  SC.default.events["touchend [data-strip]"]({ changedTouches: [{ clientX: 120 }] }, {}, c);
  assert.equal(c.state.date, "2026-12-10", "a swipe to the left: the next week");
  await new Promise((ok) => setTimeout(ok, 0));
  assert.ok(reads.every((p) => /^\/schedule\?from=/.test(p) && /amounts=1&pay=1/.test(p)), "the day's read carries amounts and pay");
  // Who: one person
  SC.default.events["click [data-tech]"]({}, { dataset: { tech: U1 } }, c);
  assert.equal(c.state.tech, U1);
  assert.equal(c.keep.tech, U1, "kept");
  // 3 Day reads three days
  assert.deepEqual(SC.rangeOf("3day", "2026-11-24"), ["2026-11-24", "2026-11-26"]);
  assert.deepEqual(SC.rangeOf("week", "2026-11-24"), ["2026-11-22", "2026-11-28"]);
});
