// The service module (the Rotor guide's Service section: guide-gaps S4,
// S15a, S16, S45b): the Jobs tab's tiles, requests and assessments, the job
// page's quick actions, and the Plans tab's ARR and failed payments.
// Synthetic people only; a pinned clock (Tuesday 2026-11-17 09:00 in
// Delano); every text a dry-run Outbox row.
import { test } from "node:test";
import assert from "node:assert/strict";
import { setup, customer, job, visit, store, drain, outbox, AS, LINES } from "../work-office/fixtures.mjs";

const J = await import("../../../netlify/lib/crm/modules/service/jobs.mjs");
const RQ = await import("../../../netlify/lib/crm/modules/service/requests.mjs");
const cid = (n) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;

test("withPlaces and monthsOf (pure): Rotor's Address and Start time from the row's visit on its day, else its property", () => {
  const rows = [{ id: "a", nv: "2026-11-24", pr: "pr_1" }, { id: "b", lv: "2026-11-10", pr: "pr_2" }, { id: "c", pr: "pr_9" }, { id: "d", fv: "2026-12-02" }];
  const visits = [
    { j: "a", d: "2026-11-24", s: "13:00", ad: "1 Example Ave, Delano" }, { j: "a", d: "2026-11-24", s: "08:00", ad: "1 Example Ave, Delano" },
    { j: "a", d: "2026-11-25", s: "07:00", ad: "Elsewhere" }, { j: "b", d: "2026-11-10", s: "09:00", do: true, town: "Mound" }, { j: "d", d: "2026-12-02", s: "10:00", st: "cancelled", ad: "Gone" },
  ];
  const out = J.withPlaces(rows, visits, [{ id: "pr_2", a: "2 Example Ave" }, { id: "pr_9", a: "9 Example Ave" }]);
  assert.deepEqual(out.map((r) => [r.ad || null, r.at || null]), [["1 Example Ave, Delano", "08:00"], ["Mound", null], ["9 Example Ave", null], [null, null]]);
  assert.equal(out[3], rows[3], "nothing found: the same row");
  assert.deepEqual(J.monthsOf([{ nv: "2026-11-03" }, { lv: "2026-10-01" }, { nv: "2026-11-09" }, { fv: "2027-01-02" }, { fv: "2026-12-01" }, {}]), ["2026-11", "2026-10", "2026-12"]);
});

test("jobTiles (pure): days ahead by the next visit, days behind by the day it was done, overdue, pending, paid", () => {
  const T = "2026-11-17";
  const rows = [
    { id: "a", st: "scheduled", nv: T, tot: 1000 },
    { id: "b", st: "scheduled", nv: "2026-11-18", tot: 2000 },
    { id: "c", st: "scheduled", nv: "2026-12-10", tot: 3000 },
    { id: "d", st: "scheduled", nv: "2026-11-10", tot: 500 },
    { id: "e", st: "unscheduled", tm: "2026-12", tot: 400 },
    { id: "f", st: "completed", done: "2026-11-15T20:00:00.000Z", tot: 700 },
    { id: "g", st: "completed", done: "2026-10-30T20:00:00.000Z", tot: 800, bill: false },
    { id: "h", st: "in_progress", nv: T, tot: 100, stale: { d: 1 } },
    { id: "i", st: "cancelled", u: "2026-11-01T00:00:00.000Z", tot: 50 },
  ];
  const out = J.jobTiles(rows, T, { paid: new Set(["f"]), due: new Map([["g", 800]]) });
  const t = Object.fromEntries(out.tiles.map((x) => [x.key, [x.count, x.cents]]));
  assert.deepEqual(t.open, [6, 7000]);
  assert.deepEqual(t.today, [2, 1100]);
  assert.deepEqual(t.tomorrow, [1, 2000]);
  assert.deepEqual(t.next_week, [1, 2000]);
  assert.deepEqual(t.next_month, [2, 5000]);
  assert.deepEqual(t.past_week, [1, 700]);
  assert.deepEqual(t.past_month, [2, 700], "a job that isn't billed counts, its $ doesn't");
  assert.deepEqual(t.overdue, [2, 600], "a day that went by, or the stale flag");
  assert.deepEqual(t.pending, [1, 400]);
  assert.deepEqual(t.in_progress, [1, 100]);
  assert.deepEqual(t.paid, [1, 700]);
  assert.deepEqual(t.done, [2, 700]);
  assert.deepEqual(t.cancelled, [1, 50]);
  assert.equal(out.rows.past_month.find((r) => r.id === "g").due, 800, "what its invoice owes rides on the row");
  // around New Year: the past month reaches into last year
  assert.deepEqual(J.tilesOf({ id: "x", st: "completed", done: "2026-12-30T18:00:00.000Z" }, "2027-01-05"), ["past_week", "past_month"]);
});

test("GET /jobs/stats: the tiles and one tile's rows with what they owe; techs can't list", async () => {
  const { t, owner, tech } = await setup();
  try {
    const c = await customer(owner);
    const j1 = await job(owner, c);
    await visit(owner, j1, { date: "2026-11-17", assignee_ids: [tech.id] });
    const j2 = await job(owner, c, { lines: [{ title: "Gutters", unit_cents: 15000, qty_milli: 1000 }] });
    await visit(owner, j2, { date: "2026-11-20" });
    await job(owner, c);
    const r = await t.api("/jobs/stats?tile=today", { as: owner });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    const tiles = Object.fromEntries(r.body.data.tiles.map((x) => [x.key, x]));
    assert.equal(tiles.today.count, 1);
    assert.equal(tiles.today.cents, 29500);
    assert.equal(tiles.next_week.count, 1);
    assert.equal(tiles.next_week.cents, 15000);
    assert.equal(tiles.pending.count, 1);
    assert.equal(tiles.open.count, 3);
    assert.deepEqual(r.body.data.rows.map((x) => x.id), [j1.id]);
    assert.equal((await t.api("/jobs/stats?tile=nope", { as: owner })).status, 400);
    assert.equal((await t.api("/jobs/stats", { as: tech })).status, 403, "a list: the unscoped schedule:read");
  } finally { t.done(); }
});

test("requests: made once per tap, an assessment on the Schedule, assessed, converted to a job (once), closed and reopened; techs locked out", async () => {
  const { t, owner, admin, tech } = await setup();
  try {
    const c = await customer(owner);
    const body = { client_id: cid(1), contact_id: c.id, services: ["Exterior windows", "Gutters", "  "], timing: "This month", notes: `Gate on the left <script>`, source: "phone" };
    const a = await t.api("/requests", { method: "POST", as: owner, body });
    assert.equal(a.status, 201, JSON.stringify(a.body));
    const rq = a.body.data.request;
    assert.deepEqual(rq.services, ["Exterior windows", "Gutters"]);
    assert.equal(rq.source, "phone");
    assert.equal(rq.status, "new");
    assert.equal(rq.property_id, c.primary_property_id, "their home by default");
    const again = await t.api("/requests", { method: "POST", as: owner, body });
    assert.equal(again.status, 200);
    assert.equal(again.body.data.request.id, rq.id, "a double tap is one request");
    assert.equal((await t.api("/requests", { method: "POST", as: owner, body: { ...body, client_id: cid(2), services: [], notes: "" } })).status, 400, "something to do");
    assert.equal((await t.api("/requests", { method: "POST", as: owner, body: { ...body, client_id: cid(3), source: "portal" } })).body.data.request.source, "office", "only the portal says portal");
    assert.equal((await t.api("/requests", { as: tech })).status, 403);
    assert.equal((await t.api(`/requests/${rq.id}`, { as: tech })).status, 403);

    // the list and its tiles
    const l = await t.api("/requests", { as: admin });
    const tiles = Object.fromEntries(l.body.meta.tiles.map((x) => [x.key, x.count]));
    assert.equal(tiles.open, 2);
    assert.equal(tiles.unassigned, 2);

    // the assessment: an estimate visit task with a time for that person
    assert.equal((await t.api(`/requests/${rq.id}/assessment`, { method: "POST", as: owner, body: { date: "2026-11-10", start: "10:00", end: "10:30", user_id: admin.id } })).status, 400, "not a day gone by");
    const b = await t.api(`/requests/${rq.id}/assessment`, { method: "POST", as: owner, body: { date: "2026-11-19", start: "10:00", end: "10:30", user_id: admin.id } });
    assert.equal(b.status, 200, JSON.stringify(b.body));
    const as1 = b.body.data.request.assessment;
    assert.equal(b.body.data.request.status, "assessment_booked");
    assert.equal(b.body.data.request.assignee_id, admin.id);
    const task = (await store.getRecord("task", as1.task_id)).data;
    assert.equal(task.kind, "estimate_visit");
    assert.equal(task.due_at, "2026-11-19T16:00:00.000Z", "10:00 in Delano");
    assert.deepEqual(task.assignee_ids, [admin.id]);
    // moving it moves the same task
    const m = await t.api(`/requests/${rq.id}/assessment`, { method: "POST", as: owner, body: { date: "2026-11-20", start: "13:00", end: "13:30", user_id: owner.id } });
    assert.equal(m.body.data.request.assessment.task_id, as1.task_id);
    assert.deepEqual((await store.getRecord("task", as1.task_id)).data.assignee_ids, [owner.id]);
    const l2 = await t.api("/requests?tile=assess_week", { as: admin });
    assert.deepEqual(l2.body.data.map((x) => x.id), [rq.id], "this week's assessments");

    const d = await t.api(`/requests/${rq.id}/assessed`, { method: "POST", as: owner, body: {} });
    assert.equal(d.body.data.request.status, "assessed");
    assert.equal((await store.getRecord("task", as1.task_id)).data.status, "done");

    // convert to a job: one job, once
    const cv = await t.api(`/requests/${rq.id}/convert`, { method: "POST", as: owner, body: { to: "job" } });
    assert.equal(cv.status, 200, JSON.stringify(cv.body));
    const jb = (await store.getRecord("job", cv.body.data.job_id)).data;
    assert.equal(jb.contact_id, c.id);
    assert.deepEqual(jb.lines.map((x) => x.title), ["Exterior windows", "Gutters"]);
    assert.match(jb.office_notes, /Gate on the left/);
    const cv2 = await t.api(`/requests/${rq.id}/convert`, { method: "POST", as: owner, body: { to: "quote" } });
    assert.equal(cv2.body.data.job_id, jb.id, "a second tap finds the first");
    assert.equal((await t.api(`/requests/${rq.id}/close`, { method: "POST", as: owner, body: { reason: "spam" } })).status, 409, "work can't be closed");
    assert.equal((await t.api("/requests?tile=converted", { as: owner })).body.data[0].id, rq.id);

    // the other one: to a quote, after closing and reopening
    const other = l.body.data.find((x) => x.id !== rq.id).id;
    assert.equal((await t.api(`/requests/${other}/close`, { method: "POST", as: owner, body: { reason: "nope" } })).status, 400);
    assert.equal((await t.api(`/requests/${other}/close`, { method: "POST", as: owner, body: { reason: "no_answer" } })).body.data.request.status, "closed");
    assert.equal((await t.api(`/requests/${other}/reopen`, { method: "POST", as: owner, body: {} })).body.data.request.status, "new");
    const q = await t.api(`/requests/${other}/convert`, { method: "POST", as: owner, body: { to: "quote" } });
    assert.equal(q.status, 200, JSON.stringify(q.body));
    const quote = (await store.getRecord("quote", q.body.data.quote_id)).data;
    assert.equal(quote.status, "draft");
    assert.equal(quote.contact_id, c.id);

    // PATCH needs If-Match; the contact's card lists both
    const g = await t.api(`/requests/${other}`, { as: owner });
    assert.equal((await t.api(`/requests/${other}`, { method: "PATCH", as: owner, body: { notes: "x" } })).status, 400);
    const p = await t.api(`/requests/${other}`, { method: "PATCH", as: owner, body: { notes: "Call after 5", assignee_id: admin.id }, ifMatch: g.headers.get ? g.headers.get("etag") : g.headers.etag });
    assert.equal(p.status, 200, JSON.stringify(p.body));
    assert.equal(p.body.data.request.notes, "Call after 5");
    const mine = await t.api(`/requests/contacts/${c.id}`, { as: owner });
    assert.equal(mine.body.data.length, 2, "the two that were made");
  } finally { t.done(); }
});

test("a request through the customer's account (the portal path) lands in Requests beside its office task", async () => {
  const { t, owner } = await setup();
  try {
    const c = await customer(owner);
    const task = (await store.createRecord("task", { title: "Work request: Gutters", kind: "follow_up", status: "open", contact_id: c.id, source: "portal" }, AS(owner))).data;
    const w = AS(owner);
    const r1 = await RQ.requestFromPortal({ contact: c, task, services: ["Gutters"], timing: "This month", notes: "Back side", property_id: c.primary_property_id }, w);
    const r2 = await RQ.requestFromPortal({ contact: c, task, services: ["Gutters"], timing: "This month", notes: "Back side" }, w);
    assert.equal(r1.id, r2.id, "once per task");
    assert.equal(r1.source, "portal");
    assert.equal(r1.task_id, task.id);
    const l = await t.api("/requests", { as: owner });
    assert.deepEqual(l.body.data.map((x) => x.src), ["portal"]);
  } finally { t.done(); }
});

test("job quick actions: a review ask and a callback on a done job (texts stay in the Outbox), refused before it's done", async () => {
  const { t, owner, tech, tech2 } = await setup();
  try {
    const c = await customer(owner);
    const j = await job(owner, c);
    const v = await visit(owner, j, { date: "2026-11-17", assignee_ids: [tech.id] });
    assert.equal((await t.api(`/jobs/${j.id}/review-ask`, { method: "POST", as: owner, body: {} })).status, 409, "not done yet");
    const g = await store.getRecord("visit", v.id);
    const done = await t.api(`/visits/${v.id}/done`, { method: "POST", as: owner, body: {}, ifMatch: g.etag });
    assert.equal(done.status, 200, JSON.stringify(done.body));
    const r = await t.api(`/jobs/${j.id}/review-ask`, { method: "POST", as: owner, body: {} });
    assert.equal(r.status, 201, JSON.stringify(r.body));
    await drain(t);
    const asks = outbox(t).filter((o) => o.template_key === "job_review_ask");
    assert.equal(asks.length, 1, "one Outbox row, never sent");
    assert.doesNotMatch(asks[0].text || asks[0].body || "", /—/);
    assert.equal((await t.api(`/jobs/${j.id}/review-ask`, { method: "POST", as: tech2, body: {} })).status, 403, "the office's (a tech asks through the office)");
    const cb = await t.api(`/jobs/${j.id}/callback`, { method: "POST", as: owner, body: { note: "Streaks on the bay window" } });
    assert.equal(cb.status, 201, JSON.stringify(cb.body));
    const tu = (await store.getRecord("job", cb.body.data.job_id)).data;
    assert.equal(tu.kind, "touch_up");
    assert.equal(tu.billable, false);
    assert.equal(tu.status, "unscheduled");
    assert.match(tu.office_notes, /Streaks/);
    const cb2 = await t.api(`/jobs/${j.id}/callback`, { method: "POST", as: owner, body: {} });
    assert.equal(cb2.body.data.job_id, tu.id, "once per job");
  } finally { t.done(); }
});

test("GET /plans: the Plans tab's Projected ARR (Home's math) and after agreement on each row", async () => {
  const { t, owner } = await setup();
  try {
    const { planType } = await import("../../../netlify/lib/crm/modules/plans/types.mjs");
    const c = await customer(owner);
    const ex = planType.example();
    const one = (await store.createRecord("plan", { ...ex, contact_id: c.id, status: "active", pending_reasons: [], agreement_status: "signed" }, AS(owner))).data;
    await store.createRecord("plan", { ...ex, contact_id: c.id, status: "active", pending_reasons: [], term: { ...ex.term, current_term_n: 2 } }, AS(owner));
    const r = await t.api("/plans", { as: owner });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    const rows = r.body.data;
    assert.equal(rows.length, 2);
    assert.equal(rows.find((x) => x.id === one.id).aa, 0);
    assert.equal(rows.filter((x) => x.aa === 1).length, 1, "the second term: after agreement");
    assert.ok(Number.isInteger(r.body.meta.arr) && r.body.meta.arr > 0, `ARR ${r.body.meta.arr}`);
    assert.equal(r.body.meta.arr, rows.reduce((s, x) => s + x.ay, 0), "a year of each recurring plan's visits");
    assert.equal(r.body.meta.failed, 0);
    assert.equal((await t.api(`/plans?contact=${c.id}`, { as: owner })).body.meta.arr, undefined, "the contact's tab doesn't need it");
  } finally { t.done(); }
});

test("the Save center (S38, Q4): an admin's cancel becomes a request the team works; owners cancel; the Plans tile and Home's reminders count it", async () => {
  const { t, owner, admin, tech } = await setup();
  try {
    const { planType } = await import("../../../netlify/lib/crm/modules/plans/types.mjs");
    const SV = await import("../../../netlify/lib/crm/modules/plans/save.mjs");
    const c = await customer(owner);
    const ex = planType.example();
    const plan = (await store.createRecord("plan", { ...ex, contact_id: c.id, status: "active", pending_reasons: [], ordinals: [{ term: 1, n: 1, k: 1, target_month: "2026-12", status: "unscheduled" }] }, AS(owner))).data;
    assert.equal((await t.api(`/plans/${plan.id}/cancel`, { method: "POST", as: admin, body: { reason: "price", note: "Too much" } })).status, 409, "not an admin");
    assert.equal((await t.api(`/plans/${plan.id}/cancel-request`, { method: "POST", as: admin, body: { reason: "nope" } })).status, 400);
    assert.equal((await t.api(`/plans/${plan.id}/cancel-request`, { method: "POST", as: tech, body: { reason: "price" } })).status, 403);
    const r = await t.api(`/plans/${plan.id}/cancel-request`, { method: "POST", as: admin, body: { reason: "price", note: "Neighbor pays less" } });
    assert.equal(r.status, 201, JSON.stringify(r.body));
    const cr = r.body.data.plan.cancel_request;
    assert.equal(cr.status, "open");
    assert.equal(cr.priority, "high", "a visit due next month");
    assert.equal((await t.api(`/plans/${plan.id}/cancel-request`, { method: "POST", as: admin, body: { reason: "price" } })).body.data.existed, true, "one open request");
    const save = await t.api("/plans/save", { as: owner });
    assert.deepEqual(save.body.data.map((x) => x.id), [plan.id]);
    assert.deepEqual(save.body.meta.tiles, { open: 1, high: 1 });
    assert.equal((await t.api("/plans", { as: owner })).body.data[0].sr, 2, "the Plans tile Cancel requests (red when high)");
    const w1 = await t.api(`/plans/${plan.id}/cancel-request`, { method: "PATCH", as: admin, body: { steps_done: ["call", "why"] } });
    assert.equal(w1.body.data.plan.cancel_request.status, "contacted");
    const w2 = await t.api(`/plans/${plan.id}/cancel-request`, { method: "PATCH", as: admin, body: { offer: "change_frequency" } });
    assert.equal(w2.body.data.plan.cancel_request.status, "offered");
    assert.equal((await t.api(`/plans/${plan.id}/cancel-request`, { method: "PATCH", as: admin, body: { offer: "free_money" } })).status, 400);
    const rem = await SV.planReminders();
    assert.equal(rem.boxes[0].lists.find((x) => x.key === "save").count, 1);
    const w3 = await t.api(`/plans/${plan.id}/cancel-request`, { method: "PATCH", as: admin, body: { status: "saved" } });
    assert.equal(w3.body.data.plan.cancel_request.status, "saved");
    assert.ok(w3.body.data.plan.cancel_request.outcome_at);
    assert.equal((await t.api(`/plans/${plan.id}/cancel-request`, { method: "PATCH", as: admin, body: { status: "cancelled" } })).status, 409, "closed");
    assert.equal((await t.api("/plans/save", { as: owner })).body.data.length, 0);
    assert.equal(SV.savePriority({ ordinals: [], billing: { autopay: false } }, "2026-11-17"), "normal");
    assert.equal(SV.savePriority({ ordinals: [], billing: { autopay: true } }, "2026-11-27"), "high", "an autopay charge on the 1st within 7 days");
  } finally { t.done(); }
});
