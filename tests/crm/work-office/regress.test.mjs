// Regression tests from the M4a review (each names the finding):
//   B1 saving the Edit job sheet never prices the job again (lines merged by
//      id on the server; the import keeps a custom price at quantity 1)
//   B2 a crash between a visit write and its job's sync is finished by the
//      retry of the same request, and by the work.sync sweep
//   M1 automation never half-cancels a job Rotor still owns
//   M2 what a visit copies of its job, contact and place follows edits; the
//      route takes the map point from the property
//   m3 two techs sharing a visit keep their own route order
//   m4 reopening a visit can't reopen a job with a paid invoice
//   m5 the rain-day push sends techs to their Today
// Synthetic data only.
import { test } from "node:test";
import assert from "node:assert/strict";
import { setup, customer, importedCustomer, job, visit, store, ids, OFF, IMP, AS, AUTOMATION, IMPORT, services, drain, notes, outbox, pin, queued } from "./fixtures.mjs";

const SYNC = await import("../../../netlify/lib/crm/modules/work/office-sync.mjs");
const { mergeLines } = await import("../../../netlify/lib/crm/modules/work/office-routes.mjs");

// what the Edit job sheet's lines editor sends back for the lines it was filled with
const asSheetSends = (lines) => lines.map((l) => ({ id: l.id, title: l.title, unit_cents: l.unit_cents, qty_milli: l.qty_milli, ...(l.service_type ? { service_type: l.service_type } : {}) }));
const etagOf = async (type, id) => (await store.getRecord(type, id)).etag;

test("B1: an imported custom-price line (24 panes, $295 flat): notes edits and an unchanged lines save keep $295; a new price is priced again", async () => {
  const { t, owner } = await setup();
  try {
    const line = IMP.mapLine({ id: "rl-1", title: "Exterior window cleaning", quantity: 24, use_unit_pricing: false, use_custom_price: true, custom_price: 295, unit_price: 0, total_price: 295, service_type: ["Residential Window Cleaning"] }, 0);
    assert.deepEqual([line.qty_milli, line.unit_cents, line.total_cents, line.rotor.qty_milli], [1000, 29500, 29500, 24000], "a flat price is quantity 1; Rotor's count kept beside it");
    const ic = await importedCustomer();
    const j = (await store.createRecord("job", { number: 700, seq: "job", contact_id: ic.id, kind: "standard", lines: [{ ...line, qty_milli: 24000, unit_cents: 29500, total_cents: 29500 }], status: "unscheduled", visit_ids: [], invoice_ids: [], office_notes: "", crew_notes: "", review: {},
      rotor: { job_id: "rj-700", job_number: "0000700" }, import: { run_id: "ir_00000000000000000001", at: "2026-11-08T00:00:00.000Z", hash: "0".repeat(64) } }, IMPORT)).data;
    assert.equal(j.totals.total_cents, 29500, "an older import's line (qty 24, its total kept)");
    // the sheet saves the notes only (it sends lines only when they changed)
    let r = await t.api(`/jobs/${j.id}`, { method: "PATCH", as: owner, ifMatch: await etagOf("job", j.id), body: { crew_notes: "Gate code 4321", office_notes: "" } });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal((await store.getRecord("job", j.id)).data.totals.total_cents, 29500);
    // an older client sends every line back unchanged: still $295
    r = await t.api(`/jobs/${j.id}`, { method: "PATCH", as: owner, ifMatch: await etagOf("job", j.id), body: { crew_notes: "Gate code 4321", lines: asSheetSends((await store.getRecord("job", j.id)).data.lines) } });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    let now = (await store.getRecord("job", j.id)).data;
    assert.equal(now.totals.total_cents, 29500, "an unchanged price and quantity keep the line's total");
    assert.ok(now.lines[0].rotor, "fields the sheet doesn't show are kept");
    // a hostile body can't set a total or an override; a changed price is priced again; a new line gets its own id
    r = await t.api(`/jobs/${j.id}`, { method: "PATCH", as: owner, ifMatch: await etagOf("job", j.id), body: { lines: [{ id: "rl-1", title: "Exterior window cleaning", unit_cents: 1000, qty_milli: 24000, total_cents: 1, override: { cents: 1 } }, { title: "Screens", unit_cents: 500, qty_milli: 2000 }] } });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    now = (await store.getRecord("job", j.id)).data;
    assert.deepEqual(now.lines.map((l) => [l.id, l.total_cents, !!l.override]), [["rl-1", 24000, false], ["ln_1", 1000, false]]);
    assert.equal(now.totals.total_cents, 25000);
  } finally { t.done(); }
});

test("B1: a plan's 2nd-visit job (a quote override, an initial-only line): an unchanged save keeps its $250", async () => {
  const { t, owner } = await setup();
  try {
    const c = await customer(owner);
    const [id] = await OFF.createJobs([{ contact_id: c.id, kind: "standard", plan_ordinal: { term: 1, n: 2 }, lines: [
      { id: "q1", title: "Exterior window cleaning", unit_cents: 29500, qty_milli: 1000, service_type: "Residential Window Cleaning", scope: { type: "all" }, override: { cents: 25000, reason: "loyal customer" } },
      { id: "q2", title: "First-visit deep clean", unit_cents: 10000, qty_milli: 1000, scope: { type: "initial" } },
    ] }], "plan-op-1", "plans", AS(owner));
    const before = (await store.getRecord("job", id)).data;
    assert.equal(before.totals.total_cents, 25000);
    const r = await t.api(`/jobs/${id}`, { method: "PATCH", as: owner, ifMatch: await etagOf("job", id), body: { crew_notes: "Dog", lines: asSheetSends(before.lines).map((l) => (l.id === "q1" ? { ...l, title: "Outside windows" } : l)) } });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    const after = (await store.getRecord("job", id)).data;
    assert.equal(after.totals.total_cents, 25000, "a renamed line keeps its override and scope");
    assert.deepEqual(after.lines.map((l) => [l.id, l.title, l.scope.type, !!l.override]), [["q1", "Outside windows", "all", true], ["q2", "First-visit deep clean", "initial", false]]);
    // pure: a line left out is removed, new ids never collide with old ones
    assert.deepEqual(mergeLines([{ id: "ln_3", title: "A", unit_cents: 1, qty_milli: 1000 }], [{ title: "B", unit_cents: 2, qty_milli: 1000 }]).map((l) => l.id), ["ln_4"]);
  } finally { t.done(); }
});

test("B2: POST /visits dies between the visit and the job; the retry (same client id) syncs the job and queues the event once", async () => {
  const { t, owner, tech } = await setup();
  try {
    const j = await job(owner, await customer(owner));
    t.stores.data.fail({ op: "setJSON", key: new RegExp(`^rec/job/${j.id}$`), times: 20, kind: "internal" });
    const body = { job_id: j.id, date: "2026-11-24", start: "08:00", end: "10:00", window: { type: "window", minutes: 120 }, assignee_ids: [tech.id], client_id: "abcdef12-3456-7890" };
    const first = await t.api("/visits", { method: "POST", as: owner, body });
    t.stores.data.clearHooks();
    assert.ok(first.status >= 500 || first.status === 409, `the first try failed (${first.status})`);
    assert.equal(t.stores.data.keys("rec/visit/").length, 1, "the visit was written");
    const again = await t.api("/visits", { method: "POST", as: owner, body });
    assert.equal(again.status, 200, JSON.stringify(again.body));
    const jNow = (await store.getRecord("job", j.id)).data;
    assert.equal(jNow.status, "scheduled");
    assert.equal(jNow.visit_ids.length, 1);
    assert.ok(queued(t).some((q) => q.data && q.data.name === "visit.scheduled"), "the event is queued");
    await drain(t);
    await t.api("/visits", { method: "POST", as: owner, body });          // a third tap, after the event was handled
    await drain(t);
    const pushes = notes(t).filter((x) => x.kind === "visit_assigned" && x.user_id === tech.id);
    assert.equal(pushes.length, 1, "the tech hears once");
  } finally { t.done(); }
});

test("B2: a cancel that died before the job sync: the cancel sent again puts the job back to book; the sweep finds an orphan", async () => {
  const { t, owner, tech } = await setup();
  try {
    const j = await job(owner, await customer(owner));
    const v = await visit(owner, j, { date: "2026-11-24", assignee_ids: [tech.id] });
    t.stores.data.fail({ op: "setJSON", key: new RegExp(`^rec/job/${j.id}$`), times: 20, kind: "internal" });
    const first = await t.api(`/visits/${v.id}/cancel`, { method: "POST", as: owner, body: { reason: "customer asked" } });
    t.stores.data.clearHooks();
    assert.ok(first.status >= 500, `the first try failed (${first.status})`);
    assert.equal((await store.getRecord("job", j.id)).data.status, "scheduled", "out of step after the crash");
    const again = await t.api(`/visits/${v.id}/cancel`, { method: "POST", as: owner, body: { reason: "customer asked" } });
    assert.equal(again.status, 200, JSON.stringify(again.body));
    assert.equal((await store.getRecord("job", j.id)).data.status, "unscheduled");
    assert.ok(queued(t).some((q) => q.data && q.data.name === "visit.cancelled"), "the tech is told");

    // nobody retries: a booking whose job never heard of it is found by work.sync
    const j2 = await job(owner, await customer(owner));
    t.stores.data.fail({ op: "setJSON", key: new RegExp(`^rec/job/${j2.id}$`), times: 20, kind: "internal" });
    await t.api("/visits", { method: "POST", as: owner, body: { job_id: j2.id, date: "2026-11-25", start: "08:00", end: "10:00", assignee_ids: [tech.id], client_id: "0a1b2c3d-4e5f-6789" } });
    t.stores.data.clearHooks();
    assert.equal((await store.getRecord("job", j2.id)).data.status, "unscheduled");
    // and a cancelled job with a live visit it never listed
    const j3 = await job(owner, await customer(owner));
    t.stores.data.fail({ op: "setJSON", key: new RegExp(`^rec/job/${j3.id}$`), times: 20, kind: "internal" });
    await t.api("/visits", { method: "POST", as: owner, body: { job_id: j3.id, date: "2026-11-26", start: "08:00", end: "10:00", assignee_ids: [tech.id], client_id: "9f8e7d6c-5b4a-3210" } });
    t.stores.data.clearHooks();
    assert.equal((await t.api(`/jobs/${j3.id}/cancel`, { method: "POST", as: owner, body: { reason: "moved away" } })).status, 200);
    const out = await SYNC.syncSweep({ write: () => AUTOMATION });
    assert.equal(out.done, true);
    const j2Now = (await store.getRecord("job", j2.id)).data;
    assert.equal(j2Now.status, "scheduled", "the sweep synced the job with its visit");
    assert.equal(j2Now.visit_ids.length, 1);
    const orphan = t.stores.data.keys("rec/visit/").map((k) => t.stores.data.json(k)).find((x) => x.job_id === j3.id);
    assert.equal((await store.getRecord("visit", orphan.id)).data.status, "cancelled", "cancelJob found the visit through the relation");
    const again2 = await SYNC.syncSweep({ write: () => AUTOMATION });
    assert.match(again2.result, /^0 synced, 0 cancelled/, "a second pass finds nothing");
  } finally { t.done(); }
});

test("M1: automation cancelJobs on a job Rotor owns touches nothing: skipped, one would- row", async () => {
  const { t, owner, tech } = await setup();
  try {
    const ic = await importedCustomer();
    const j = (await store.createRecord("job", { number: 812, seq: "job", contact_id: ic.id, kind: "standard", lines: [{ id: "l1", title: "Window cleaning", unit_cents: 25000 }], status: "unscheduled",
      visit_ids: [], invoice_ids: [], office_notes: "", crew_notes: "", review: {}, rotor: { job_id: "rj-1", job_number: "0000812" }, import: { run_id: "ir_00000000000000000001", at: "2026-11-08T00:00:00.000Z", hash: "0".repeat(64) } }, IMPORT)).data;
    const v = (await OFF.createVisit({ job_id: j.id, date: "2026-11-24", start: "08:00", end: "10:00", assignee_ids: [tech.id] }, AS(owner))).visit;
    await drain(t);
    const pushes = notes(t).length;
    const out = await services.call("work.cancelJobs", [j.id], "plan cancelled", "cancel--pl_x--1", AUTOMATION);
    assert.deepEqual(out, { cancelled: [], skipped: [j.id] });
    assert.equal((await store.getRecord("visit", v.id)).data.status, "scheduled", "the visit is left as it was");
    assert.equal((await store.getRecord("job", j.id)).data.status, "scheduled");
    await drain(t);
    assert.equal(notes(t).length, pushes);
    assert.equal(t.stores.data.keys("alog/").filter((k) => k.includes(j.id) && /--would-cancel$/.test(k)).length, 1, "one would- row");
    // a person cancels it fine
    assert.equal((await t.api(`/jobs/${j.id}/cancel`, { method: "POST", as: owner, body: { reason: "customer asked" } })).status, 200);
  } finally { t.done(); }
});

test("M2: a job edited after booking: the visit's copies, its untouched checklist and the confirmation follow; a ticked checklist stays", async () => {
  const { t, owner, tech } = await setup("2026-11-17T15:00:00Z");
  try {
    const c = await customer(owner);
    const j = await job(owner, c);
    const v = await visit(owner, j, { date: "2026-12-08", assignee_ids: [tech.id] });
    assert.equal(v.checklist.template_key, "windows_exterior");
    const r = await t.api(`/jobs/${j.id}`, { method: "PATCH", as: owner, ifMatch: await etagOf("job", j.id), body: { lines: [{ title: "Gutter cleaning", unit_cents: 18000, service_type: "Exterior Cleaning" }] } });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    const vNow = (await store.getRecord("visit", v.id)).data;
    assert.deepEqual([vNow.job_title, vNow.service_types, vNow.checklist.template_key], ["Gutter cleaning", ["Exterior Cleaning"], "gutters"]);
    const row = (await store.readIndex("visits", "2026-12")).rows.find((x) => x.id === v.id);
    assert.equal(row.t, "Gutter cleaning", "the schedule shows the job's work");
    await drain(t, 4);
    pin("2026-11-17T15:20:00Z"); await drain(t, 4);
    pin("2026-11-17T15:40:00Z"); await drain(t, 4);
    const conf = outbox(t).filter((o) => o.template_key === "visit_confirm" && o.related && o.related.visit_id === v.id);
    assert.equal(conf.length, 1);
    assert.match(conf[0].body, /gutter cleaning/);
    // a visit whose crew ticked an item keeps its list
    const j2 = await job(owner, c);
    const v2 = await visit(owner, j2, { date: "2026-12-09", assignee_ids: [tech.id] });
    await store.updateRecord("visit", v2.id, (x) => ({ ...x, checklist: { ...x.checklist, items: x.checklist.items.map((i, n) => (n ? i : { ...i, done_at: "2026-11-17T15:30:00.000Z" })) } }), AS(owner));
    await t.api(`/jobs/${j2.id}`, { method: "PATCH", as: owner, ifMatch: await etagOf("job", j2.id), body: { lines: [{ title: "Gutter cleaning", unit_cents: 18000, service_type: "Exterior Cleaning" }] } });
    const v2Now = (await store.getRecord("visit", v2.id)).data;
    assert.equal(v2Now.job_title, "Gutter cleaning");
    assert.equal(v2Now.checklist.template_key, "windows_exterior", "a list someone started is never swapped");
  } finally { t.done(); }
});

test("M2: a property geocoded (and a contact renamed) after booking: the route uses the property's point, the summaries sweep refreshes the copies", async () => {
  const { t, owner, tech } = await setup("2026-11-17T15:00:00Z");
  try {
    const c = await customer(owner);
    const j = await job(owner, c);
    const v = await visit(owner, j, { date: "2026-11-19", assignee_ids: [tech.id] });
    assert.equal(v.geo, undefined);
    await store.updateRecord("property", c.primary_property_id, (p) => ({ ...p, geo: { lat: 45.04, lng: -93.78, source: "manual", at: "2026-11-17T15:05:00.000Z" } }), AS(owner));
    const g = await t.api(`/schedule/route?date=2026-11-19&user=${tech.id}`, { as: owner });
    assert.deepEqual(g.body.data.stops[0].geo, [45.04, -93.78], "the route reads the property's point");
    const r = await t.api("/schedule/route", { method: "POST", as: owner, body: { date: "2026-11-19", user_id: tech.id } });
    assert.deepEqual(r.body.data.no_geo, []);
    assert.deepEqual((await store.getRecord("visit", v.id)).data.geo, [45.04, -93.78], "and Optimize keeps it on the visit");
    // renamed and moved: the nightly sweep brings the copies (and the job's name) up to date
    await store.updateRecord("contact", c.id, (x) => ({ ...x, last_name: "Renamed" }), AS(owner));
    await store.updateRecord("property", c.primary_property_id, (p) => ({ ...p, address: { ...p.address, city: "Mound" } }), AS(owner));
    const out = await SYNC.summariesSweep({ write: () => AUTOMATION });
    assert.equal(out.progress, 1);
    const vNow = (await store.getRecord("visit", v.id)).data;
    assert.match(vNow.contact_name, /Renamed/);
    assert.equal(vNow.town, "Mound");
    assert.match((await store.getRecord("job", j.id)).data.contact_name, /Renamed/);
    assert.equal((await SYNC.summariesSweep({ write: () => AUTOMATION })).progress, 0, "nothing left to refresh");
  } finally { t.done(); }
});

test("m3: two techs sharing a visit keep their own route order", async () => {
  const { t, owner, tech, tech2 } = await setup();
  try {
    const mk = async (geo, who) => visit(owner, await job(owner, await customer(owner, {}, { geo })), { date: "2026-11-24", start: "08:00", end: "09:00", window: { type: "window", minutes: 240 }, assignee_ids: who });
    const shared = await mk([45.10, -93.70], [tech.id, tech2.id]);
    const theo = await mk([45.04, -93.78], [tech.id]);
    await mk([45.20, -93.60], [tech2.id]);
    await mk([45.21, -93.59], [tech2.id]);
    await t.api("/schedule/route", { method: "POST", as: owner, body: { date: "2026-11-24", user_id: tech.id } });
    const day = async (uid) => (await t.api(`/schedule/route?date=2026-11-24&user=${uid}`, { as: owner })).body.data.stops.map((s) => [s.id, s.o]);
    const before = await day(tech.id);
    assert.deepEqual(before.map((x) => x[0]), [theo.id, shared.id]);
    await t.api("/schedule/route", { method: "POST", as: owner, body: { date: "2026-11-24", user_id: tech2.id } });
    assert.deepEqual(await day(tech.id), before, "Tess's order doesn't change Theo's");
    assert.equal(Object.keys((await store.getRecord("visit", shared.id)).data.route_order).length, 2);
  } finally { t.done(); }
});

test("m4: reopening a visit can't reopen a job with a paid invoice; m5: the rain-day push sends techs to Today", async () => {
  const { t, owner, tech } = await setup();
  try {
    const j = await job(owner, await customer(owner));
    const v = await visit(owner, j, { date: "2026-11-17", assignee_ids: [tech.id] });
    await OFF.completeJob(j.id, AS(owner));
    assert.equal((await store.getRecord("job", j.id)).data.status, "completed");
    const inv = ids.newId("invoice");
    await store.settledWrite(`rec/invoice/${inv}`, { id: inv, type: "invoice", v: 1, wv: 1, status: "paid", job_id: j.id }, { onlyIfNew: true });
    await store.updateRecord("job", j.id, (x) => ({ ...x, invoice_ids: [inv] }), AS(owner));
    const r = await t.api(`/visits/${v.id}/reopen`, { method: "POST", as: owner, body: {} });
    assert.equal(r.status, 409, JSON.stringify(r.body));
    assert.equal((await store.getRecord("visit", v.id)).data.status, "completed");
    assert.equal((await store.getRecord("job", j.id)).data.status, "completed");

    // the rain-day push
    const w = await visit(owner, await job(owner, await customer(owner)), { date: "2026-11-24", assignee_ids: [tech.id] });
    await drain(t);
    const body = { from_date: "2026-11-24", to_date: "2026-11-27", filter: {}, notify: false };
    const p = (await t.api("/schedule/move-day", { method: "POST", as: owner, body })).body.data;
    assert.equal((await t.api("/schedule/move-day", { method: "POST", as: owner, body: { ...body, confirm: true, token: p.token } })).status, 202);
    for (let i = 0; i < 4; i++) { await t.runWorker({ lane: "bulk" }); await drain(t, 2); }
    assert.equal((await store.getRecord("visit", w.id)).data.date, "2026-11-27");
    const push = notes(t).find((n) => n.kind === "visit_changed" && /moved from/.test(n.body));
    assert.ok(push, "the tech is told once");
    assert.equal(push.link, "/today");
  } finally { t.done(); }
});
