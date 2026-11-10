// The work module's office API (design §5.5, §4.5, §4.6): tech scoping,
// the job and visit lifecycle through the job rule, prices for techs (D11),
// route order, time off, checklists, the contact's Work tab, stale jobs,
// the late-cancel task, merge.
import { test } from "node:test";
import assert from "node:assert/strict";
import { setup, customer, job, visit, store, drain, OFF, AU, AS, LINES } from "./fixtures.mjs";
import { pin } from "../../helpers/crm-clock.mjs";

// Every contact id in a JSON body (the §4.6 crawl).
const contactIds = (body) => [...new Set(JSON.stringify(body).match(/ct_[0-9a-hjkmnp-tv-z]{20}/g) || [])];

test("a tech sees only their own visits in the ±7/30-day window, with techFields only", async () => {
  const { t, owner, tech, tech2 } = await setup();
  try {
    const c = await customer(owner, { notes: "Prefers mornings. Gate code in the notes." });
    const other = await customer(owner);
    const j = await job(owner, c, { office_notes: "Owner owes us a callback", crew_notes: "Dog in the back yard" });
    const mine = await visit(owner, j, { date: "2026-11-24", assignee_ids: [tech.id] });
    const late = await visit(owner, j, { date: "2026-12-20", assignee_ids: [tech.id] });        // > today + 30
    const theirs = await visit(owner, await job(owner, other), { date: "2026-11-24", assignee_ids: [tech2.id] });
    await store.updateRecord("visit", mine.id, (v) => ({ ...v, moved_by_op: "moveday--2026-11-23--1", reminders: { d2_for: "2026-11-24" } }), AS(owner));

    const r = await t.api(`/visits/${mine.id}`, { as: tech });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    const d = r.body.data;
    assert.equal(d.visit.moved_by_op, undefined, "techFields only");
    assert.equal(d.visit.reminders, undefined);
    assert.equal(d.reminders, undefined, "the office's reminder states aren't for techs");
    assert.equal(d.job.office_notes, undefined, "office notes never reach a tech");
    assert.equal(d.job.crew_notes, "Dog in the back yard");
    assert.equal(d.job.lines[0].total_cents, 29500, "techs see the prices of their own visits (D11)");
    assert.deepEqual(Object.keys(d.contact).sort(), ["display_name", "first_name", "id", "phones"]);
    assert.equal(d.property.access.gate_code, "1234");
    assert.deepEqual(contactIds(r.body), [c.id], "only the contact of their visit");
    assert.equal(d.can.office, false);
    assert.equal(d.can.assignee, true);

    for (const id of [late.id, theirs.id, "vs_00000000000000000000"]) assert.equal((await t.api(`/visits/${id}`, { as: tech })).status, 404, "outside the window, someone else's, or missing: 404");
    // a week after, still theirs; 8 days after, gone
    pin("2026-12-01T15:00:00Z");
    assert.equal((await t.api(`/visits/${mine.id}`, { as: tech })).status, 200);
    pin("2026-12-02T15:00:00Z");
    assert.equal((await t.api(`/visits/${mine.id}`, { as: tech })).status, 404);
    pin("2026-11-17T15:00:00Z");

    // the job: only their visits, the same scope
    const jr = await t.api(`/jobs/${j.id}`, { as: tech });
    assert.equal(jr.status, 200);
    assert.deepEqual(jr.body.data.visits.map((v) => v.id), [mine.id], "not the visit outside their window");
    assert.equal(jr.body.data.job.office_notes, undefined);
    assert.equal((await t.api(`/jobs/${theirs.job_id}`, { as: tech })).status, 404);

    // prices hidden when the owner says so (D11 "hidden")
    await store.updateRecord("user", tech.id, (u) => ({ ...u, denies: ["visits:prices"] }), AS(owner));
    (await import("../../../netlify/lib/crm/core/sessions.mjs")).clearSessionCache();
    const hid = await t.api(`/visits/${mine.id}`, { as: tech });
    assert.equal(hid.body.data.job.lines[0].total_cents, undefined);
    assert.equal(hid.body.data.job.totals, undefined);
    assert.equal(hid.body.data.job.lines[0].title, "Exterior window cleaning");

    // lists and every office action: 403
    for (const path of ["/schedule", "/jobs", "/schedule/unscheduled", "/time-off", "/checklists", "/stale", `/work/contacts/${c.id}`, "/schedule/route?date=2026-11-24&user=" + tech.id]) {
      assert.equal((await t.api(path, { as: tech })).status, 403, path);
    }
    const cur = await store.getRecord("visit", mine.id);
    assert.equal((await t.api(`/visits/${mine.id}`, { method: "PATCH", as: tech, ifMatch: cur.etag, body: { start: "09:00" } })).status, 403);
    assert.equal((await t.api(`/visits/${mine.id}/cancel`, { method: "POST", as: tech, body: { reason: "x" } })).status, 403);
    assert.equal((await t.api("/jobs", { method: "POST", as: tech, body: { contact_id: c.id } })).status, 403);
    assert.equal((await t.api("/visits", { method: "POST", as: tech, body: { job_id: j.id, date: "2026-11-25", start: "08:00", end: "09:00" } })).status, 403);
  } finally { t.done(); }
});

test("the job follows its visits: booked, under way, done, reopened, cancelled; work stats on the contact", async () => {
  const { t, owner, tech } = await setup();
  try {
    const c = await customer(owner);
    const nj = await t.api("/jobs", { method: "POST", as: owner, body: { contact_id: c.id, lines: [{ title: "Gutter cleaning", unit_cents: 19900, service_type: "Exterior Cleaning" }], crew_notes: "Ladder needed", client_id: "job-client-0001" } });
    assert.equal(nj.status, 201, JSON.stringify(nj.body));
    const jid = nj.body.data.job.id;
    assert.equal(nj.body.data.job.status, "unscheduled");
    assert.equal(nj.body.data.job.number_label, "S-000001");
    const replay = await t.api("/jobs", { method: "POST", as: owner, body: { contact_id: c.id, lines: [{ title: "Gutter cleaning", unit_cents: 19900, service_type: "Exterior Cleaning" }], crew_notes: "Ladder needed", client_id: "job-client-0001" } });
    assert.equal(replay.body.data.job.id, jid, "the same client id is the same job");

    const nv = await t.api("/visits", { method: "POST", as: owner, body: { job_id: jid, date: "2026-11-24", start: "08:00", end: "10:00", window: { type: "exact" }, assignee_ids: [tech.id], client_id: "visit-client-0001" } });
    assert.equal(nv.status, 201, JSON.stringify(nv.body));
    const vid = nv.body.data.visit.id;
    assert.equal(nv.body.data.job.status, "scheduled");
    assert.equal(nv.body.data.visit.checklist.template_key, "gutters", "the checklist by service type");
    assert.equal(nv.body.data.visit.start_utc, "2026-11-24T14:00:00.000Z");
    const dup = await t.api("/visits", { method: "POST", as: owner, body: { job_id: jid, date: "2026-11-24", start: "08:00", end: "10:00", client_id: "visit-client-0001" } });
    assert.equal(dup.status, 200, "a double tap books one visit");
    assert.equal(dup.body.data.visit.id, vid);

    // the tech starts the visit (the tech app's event, through the same door) → the job is under way
    await OFF.changeVisit(vid, "start", { ctx: AS(tech) });
    assert.equal((await store.getRecord("job", jid)).data.status, "in_progress");
    // a visit under way can't be moved by the office
    const cur = await store.getRecord("visit", vid);
    const mv = await t.api(`/visits/${vid}`, { method: "PATCH", as: owner, ifMatch: cur.etag, body: { date: "2026-11-25" } });
    assert.equal(mv.status, 409);
    // finish needs the required checklist items
    await assert.rejects(OFF.changeVisit(vid, "finish", { ctx: AS(tech) }), /Finish the checklist first: Before photo, Downspouts flushed, After photo/);
    await OFF.changeVisit(vid, "finish", { ctx: AS(tech), mutate: (v) => ({ ...v, checklist: { ...v.checklist, items: v.checklist.items.map((i) => ({ ...i, done_at: "2026-11-24T15:00:00.000Z", done_by: tech.id })) } }) });
    let job = (await store.getRecord("job", jid)).data;
    assert.equal(job.status, "completed");
    assert.ok(job.completed_at);
    await drain(t);
    let stats = (await store.getRecord("contact_stats", c.id)).data.work;
    assert.equal(stats.jobs_completed, 1);
    assert.equal(stats.last_service_on, "2026-11-17");
    assert.deepEqual(stats.svc_d, ["Exterior Cleaning"]);

    // reopen the job (owner/admin), add another visit, the office marks it done
    assert.equal((await t.api(`/jobs/${jid}/reopen`, { method: "POST", as: owner, body: {} })).body.data.job.status, "scheduled");
    const v2 = await t.api("/visits", { method: "POST", as: owner, body: { job_id: jid, date: "2026-11-30", start: "09:00", end: "11:00", assignee_ids: [tech.id] } });
    assert.equal(v2.status, 201);
    await drain(t);
    stats = (await store.getRecord("contact_stats", c.id)).data.work;
    assert.equal(stats.next_visit_on, "2026-11-30");
    const done = await t.api(`/jobs/${jid}/complete`, { method: "POST", as: owner, body: {} });
    assert.equal(done.body.data.job.status, "completed");
    assert.equal((await store.getRecord("visit", v2.body.data.visit.id)).data.completion.office, true);

    // a reopened visit reopens the job; a cancelled job cancels its open visits
    await t.api(`/visits/${v2.body.data.visit.id}/reopen`, { method: "POST", as: owner, body: {} });
    job = (await store.getRecord("job", jid)).data;
    assert.equal(job.status, "in_progress");
    const can = await t.api(`/jobs/${jid}/cancel`, { method: "POST", as: owner, body: { reason: "Moved away" } });
    assert.equal(can.body.data.job.status, "cancelled");
    assert.equal((await store.getRecord("visit", v2.body.data.visit.id)).data.status, "cancelled");
    assert.equal((await t.api(`/jobs/${jid}/cancel`, { method: "POST", as: owner, body: {} })).status, 400, "a reason is required");
    assert.equal((await t.api("/visits", { method: "POST", as: owner, body: { job_id: jid, date: "2026-12-01", start: "09:00", end: "10:00" } })).status, 409, "no visit on a cancelled job");
  } finally { t.done(); }
});

test("PATCH /visits: If-Match required, a stale one is 412; cancelling the only visit sends the job back to the tray", async () => {
  const { t, owner, tech } = await setup();
  try {
    const j = await job(owner, await customer(owner));
    const v = await visit(owner, j, { assignee_ids: [tech.id] });
    const cur = await store.getRecord("visit", v.id);
    assert.equal((await t.api(`/visits/${v.id}`, { method: "PATCH", as: owner, body: { start: "09:00", end: "11:00" } })).status, 400);
    const ok = await t.api(`/visits/${v.id}`, { method: "PATCH", as: owner, ifMatch: cur.etag, body: { start: "09:00", end: "11:00" } });
    assert.equal(ok.status, 200);
    const stale = await t.api(`/visits/${v.id}`, { method: "PATCH", as: owner, ifMatch: cur.etag, body: { start: "10:00", end: "12:00" } });
    assert.equal(stale.status, 412);
    assert.equal(stale.body.error.details.current.start, "09:00");
    assert.equal((await t.api(`/visits/${v.id}`, { method: "PATCH", as: owner, ifMatch: ok.headers.get("etag"), body: { start: "12:00", end: "11:00" } })).status, 400);
    await t.api(`/visits/${v.id}/cancel`, { method: "POST", as: owner, body: { reason: "Customer called" } });
    assert.equal((await store.getRecord("job", j.id)).data.status, "unscheduled", "back to the tray");
  } finally { t.done(); }
});

test("no access and a late cancel make the owners an approval task for the late-cancel fee (D28)", async () => {
  const { t, owner, tech } = await setup();
  try {
    const j = await job(owner, await customer(owner));
    const v = await visit(owner, j, { assignee_ids: [tech.id] });
    const r = await t.api(`/visits/${v.id}/mark-no-access`, { method: "POST", as: owner, body: { note: "Gate locked" } });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(r.body.data.visit.status, "no_access");
    assert.equal(r.body.data.visit.no_access.note, "Gate locked");
    assert.equal(r.body.data.job.status, "unscheduled", "rebook it from the tray");
    const tasks = t.stores.data.keys("rec/task/").map((k) => t.stores.data.json(k));
    assert.equal(tasks.length, 1);
    assert.equal(tasks[0].approval.kind, "late_cancel_fee");
    assert.deepEqual(tasks[0].assignee_ids, [owner.id]);
    const v2 = await visit(owner, j, { date: "2026-11-18", assignee_ids: [tech.id] });
    await t.api(`/visits/${v2.id}/cancel`, { method: "POST", as: owner, body: { reason: "Customer cancelled the night before", late: true } });
    assert.equal(t.stores.data.keys("rec/task/").length, 2);
    assert.equal((await store.getRecord("visit", v2.id)).data.late_cancel, true);
  } finally { t.done(); }
});

test("route order: windows first, then the shortest drive; the office can drag its own order", async () => {
  const { t, owner, tech } = await setup();
  try {
    // the shop is in Delano (45.0419, -93.7891); a far stop and a near stop in the same 8-10 window, a 1-3 stop near the shop
    const far = await customer(owner, {}, { town: "Wayzata", geo: [44.97, -93.51] });
    const near = await customer(owner, {}, { town: "Montrose", geo: [45.06, -93.91] });
    const pm = await customer(owner, {}, { town: "Delano", geo: [45.04, -93.79] });
    const nogeo = await customer(owner, {}, { town: "Rockford" });
    const vFar = await visit(owner, await job(owner, far), { start: "08:00", end: "10:00", assignee_ids: [tech.id] });
    const vNear = await visit(owner, await job(owner, near), { start: "08:00", end: "10:00", assignee_ids: [tech.id] });
    const vPm = await visit(owner, await job(owner, pm), { start: "13:00", end: "15:00", assignee_ids: [tech.id] });
    const vNo = await visit(owner, await job(owner, nogeo), { start: "08:30", end: "09:30", window: { type: "exact" }, assignee_ids: [tech.id] });
    const r = await t.api("/schedule/route", { method: "POST", as: owner, body: { date: "2026-11-19", user_id: tech.id } });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.deepEqual(r.body.data.order, [vNo.id, vNear.id, vFar.id, vPm.id], "the exact 8:30 first, then the 8-10s near to far, then the afternoon");
    assert.deepEqual(r.body.data.no_geo, [vNo.id]);
    assert.equal((await store.getRecord("visit", vFar.id)).data.route_order, 3);
    const g = await t.api(`/schedule/route?date=2026-11-19&user=${tech.id}`, { as: owner });
    assert.deepEqual(g.body.data.stops.map((s) => s.id), r.body.data.order);
    const drag = await t.api("/schedule/route", { method: "POST", as: owner, body: { date: "2026-11-19", user_id: tech.id, order: [vNear.id, vNo.id, vFar.id, vPm.id] } });
    assert.equal(drag.body.data.changed, 2);
    assert.equal((await t.api("/schedule/route", { method: "POST", as: owner, body: { date: "2026-11-19", user_id: tech.id, order: [vNear.id] } })).status, 409, "an order that isn't the day's");
  } finally { t.done(); }
});

test("time off, checklists, the contact's Work tab and GET /jobs", async () => {
  const { t, owner, admin, tech } = await setup();
  try {
    const add = await t.api("/time-off", { method: "POST", as: admin, body: { user_id: tech.id, date: "2026-12-24", end_date: "2026-12-26", reason: "Holidays" } });
    assert.equal(add.status, 201);
    assert.equal(add.body.data.time_off.start_at, "2026-12-24T06:00:00.000Z");
    assert.equal(add.body.data.time_off.end_at, "2026-12-27T06:00:00.000Z");
    const list = await t.api(`/time-off?user=${tech.id}`, { as: owner });
    assert.equal(list.body.data.length, 1);
    const ed = await t.api(`/time-off/${add.body.data.time_off.id}`, { method: "PATCH", as: owner, ifMatch: add.headers.get("etag"), body: { date: "2026-12-24", end_date: "2026-12-24", reason: "Christmas Eve" } });
    assert.equal(ed.status, 200, JSON.stringify(ed.body));
    assert.equal((await t.api(`/time-off/${add.body.data.time_off.id}`, { method: "DELETE", as: owner })).status, 200);
    assert.equal((await t.api(`/time-off?user=${tech.id}`, { as: owner })).body.data.length, 0);
    // part of a day, in Delano time on each side of the DST change
    const part = await t.api("/time-off", { method: "POST", as: admin, body: { user_id: tech.id, date: "2027-03-15", start: "09:00", end: "11:30", reason: "Dentist" } });
    assert.equal(part.status, 201, JSON.stringify(part.body));
    assert.equal(part.body.data.time_off.start_at, "2027-03-15T14:00:00.000Z", "CDT after Mar 14");
    assert.equal(part.body.data.time_off.end_at, "2027-03-15T16:30:00.000Z");
    assert.ok(!part.body.data.time_off.all_day);
    const bad = await t.api("/time-off", { method: "POST", as: admin, body: { user_id: tech.id, date: "2027-03-15", start: "11:00", end: "09:00" } });
    assert.equal(bad.status, 400);
    assert.equal(bad.body.error.field, "end");
    assert.equal((await t.api(`/time-off/${part.body.data.time_off.id}`, { method: "DELETE", as: owner })).status, 200);

    const cl = await t.api("/checklists", { as: owner });
    assert.deepEqual(cl.body.data.map((r) => r.k), ["windows_exterior", "windows_interior", "gutters", "lights_install", "lights_takedown"]);
    const one = await t.api(`/checklists/${cl.body.data[0].id}`, { as: owner });
    const items = one.body.data.checklist.items.filter((i) => i.key !== "tracks");
    const ch = await t.api(`/checklists/${cl.body.data[0].id}`, { method: "PATCH", as: owner, ifMatch: one.etag || one.headers.get("etag"), body: { items } });
    assert.equal(ch.status, 200, JSON.stringify(ch.body));
    assert.equal(ch.body.data.checklist.items.length, 7);
    assert.equal((await t.api("/checklists", { method: "POST", as: owner, body: { key: "windows_exterior", name: "Again", items: [] } })).status, 409);
    assert.equal((await t.api("/checklists", { method: "POST", as: owner, body: { key: "screens_only", name: "Screens", items: [{ key: "x", label: "Screens", required: true }, { key: "x", label: "Again" }] } })).status, 400, "two items share a key");

    const c = await customer(owner);
    const j1 = await job(owner, c);
    const v = await visit(owner, j1, { date: "2026-11-24", assignee_ids: [tech.id] });
    await job(owner, c, { title: "Gutters", lines: [{ title: "Gutters", unit_cents: 10000 }] });
    const w = await t.api(`/work/contacts/${c.id}`, { as: owner });
    assert.equal(w.status, 200);
    assert.equal(w.body.data.jobs.length, 2);
    assert.deepEqual(w.body.data.upcoming.map((x) => x.id), [v.id]);
    const jobs = await t.api("/jobs", { as: owner });
    assert.equal(jobs.body.data.length, 2);
    assert.equal(jobs.body.data[0].st, "scheduled", "booked jobs first");
    assert.equal((await t.api(`/jobs?contact=${c.id}`, { as: owner })).body.data.length, 2);
  } finally { t.done(); }
});

test("stale jobs: scheduled with every visit behind today, in progress too long; the flag lives in the index row, not the record", async () => {
  const { t, owner, tech } = await setup("2026-11-01T15:00:00Z");
  try {
    const past = await job(owner, await customer(owner));
    await visit(owner, past, { date: "2026-11-05", assignee_ids: [tech.id] });
    const stuck = await job(owner, await customer(owner));
    const sv = await visit(owner, stuck, { date: "2026-11-14", assignee_ids: [tech.id] });
    pin("2026-11-14T16:00:00Z");
    await OFF.changeVisit(sv.id, "start", { ctx: AS(tech) });
    const fine = await job(owner, await customer(owner));
    await visit(owner, fine, { date: "2026-11-24" });
    pin("2026-11-17T15:00:00Z");
    const wv = (await store.getRecord("job", past.id)).data.wv;
    await AU.staleSweep({});
    const s = await t.api("/stale", { as: owner });
    const flags = Object.fromEntries(s.body.data.jobs.map((r) => [r.id, r.stale]));
    assert.deepEqual(flags, { [past.id]: "scheduled_past", [stuck.id]: "in_progress_stuck" });
    assert.equal((await store.getRecord("job", past.id)).data.wv, wv, "the record is untouched");
    assert.equal((await t.api("/jobs?status=stale", { as: owner })).body.data.length, 2);
    assert.equal(await AU.staleCount(), 2);
    // finished: the flag goes, also from the raw blob
    await t.api(`/jobs/${past.id}/complete`, { method: "POST", as: owner, body: {} });
    await AU.staleSweep({});
    assert.equal(await AU.staleCount(), 1);
    const raw = t.stores.data.json("ix/jobs/open");
    assert.ok(!(raw.rows[past.id] && raw.rows[past.id].stale && raw.rows[past.id].stale.d), "no stale part left behind");
  } finally { t.done(); }
});

test("a merge moves b's jobs and visits to a", async () => {
  const { t, owner, tech } = await setup();
  try {
    const a = await customer(owner);
    const b = await customer(owner);
    const j = await job(owner, b);
    const v = await visit(owner, j, { assignee_ids: [tech.id] });
    await OFF.onMergeWork(a.id, b.id, AS(owner));
    assert.equal((await store.getRecord("job", j.id)).data.contact_id, a.id);
    assert.equal((await store.getRecord("visit", v.id)).data.contact_id, a.id);
    assert.equal((await store.getRecord("visit", v.id)).data.contact_name, `${a.first_name} ${a.last_name}`);
    assert.deepEqual((await store.listRel("contact-jobs", a.id)).map((r) => r.id), [j.id]);
    assert.deepEqual(await store.listRel("contact-jobs", b.id), []);
    assert.equal((await store.getRecord("contact_stats", a.id)).data.work.next_visit_on, "2026-11-19");
  } finally { t.done(); }
});

test("GET /visits/:id for the office: reminders, people, what may be done", async () => {
  const { t, owner, tech } = await setup();
  try {
    const v = await visit(owner, await job(owner, await customer(owner)), { date: "2026-11-24", assignee_ids: [tech.id] });
    await drain(t);
    pin("2026-11-17T15:11:00Z");
    await drain(t);
    const r = await t.api(`/visits/${v.id}`, { as: owner });
    assert.equal(r.status, 200);
    assert.equal(r.body.data.reminders.confirm.state, "done");
    assert.equal(r.body.data.reminders.confirm.dry, true);
    assert.equal(r.body.data.reminders.d2, null);
    assert.equal(r.body.data.people[0].id, tech.id);
    assert.equal(r.body.data.arrival, "arriving between 8:00 and 10:00 AM");
    assert.deepEqual(r.body.data.can, { office: true, assignee: false, prices: true, reopen: false, move: true, cancel: true, no_access: true, done: true });
    assert.ok(r.headers.get("etag"));
  } finally { t.done(); }
});
