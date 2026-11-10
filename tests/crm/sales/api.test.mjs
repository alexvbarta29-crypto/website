// The sales API through the real dispatcher (design §5.2 "Endpoints", §4.5,
// §4.6): who may do what, deals by hand, cadences in Settings, tasks (a
// technician's own only, contacts hidden outside their visits), incidents,
// a contact's Sales tab, bulk resume.
import { test } from "node:test";
import assert from "node:assert/strict";
import { setup, makeLead, enrollment, E, store, AS } from "./fixtures.mjs";

test("permissions: the office works the call list; a technician gets 403 everywhere but their own tasks and incidents", async () => {
  const { t, owner, admin, tech } = await setup();
  try {
    const c = await makeLead(owner);
    const id = await E.enroll(c.id, "new_lead", {}, AS(owner));
    for (const [path, method] of [["/calls/list", "GET"], ["/calls/summary", "GET"], ["/attention", "GET"], ["/deals", "GET"], ["/enrollments", "GET"], ["/cadences", "GET"], ["/tasks", "GET"], [`/sales/contacts/${c.id}`, "GET"], [`/enrollments/${id}`, "GET"]]) {
      assert.equal((await t.api(path, { method, as: admin })).status, 200, `admin ${path}`);
      assert.equal((await t.api(path, { method, as: tech })).status, 403, `tech ${path}`);
    }
    assert.equal((await t.api(`/enrollments/${id}/pause`, { method: "POST", as: tech, body: {} })).status, 403);
    assert.equal((await t.api("/tasks/mine", { as: tech })).status, 200);
    assert.equal((await t.api("/calls/list")).status, 401, "signed out");
    const cad = (await t.api("/cadences", { as: admin })).body.data.find((x) => x.key === "new_lead");
    const got = await t.api(`/cadences/${cad.id}`, { as: admin });
    assert.equal((await t.api(`/cadences/${cad.id}`, { method: "PATCH", as: tech, ifMatch: got.headers.get("etag"), body: { name: "x" } })).status, 403);
  } finally { t.done(); }
});

test("enroll by hand, the open one again, pause / resume / stop; bulk resume; a deal by hand", async () => {
  const { t, owner } = await setup();
  try {
    const c = await makeLead(owner, { tags: ["Giveaway - New Lead"] });
    const r = await t.api("/enrollments", { method: "POST", as: owner, body: { contact_id: c.id, cadence_key: "new_lead" } });
    assert.equal(r.status, 201, JSON.stringify(r.body));
    const id = r.body.data.enrollment.id;
    assert.equal(r.body.data.cadence.key, "new_lead");
    assert.equal(r.body.data.sms_mode, "dry_run");
    assert.match(r.body.data.preview.text, /^Hey Pat!/);
    assert.ok(r.body.data.preview.sms_href.startsWith("sms:+1763555"));
    const again = await t.api("/enrollments", { method: "POST", as: owner, body: { contact_id: c.id, cadence_key: "new_lead" } });
    assert.equal(again.body.data.enrollment.id, id, "one open per contact and cadence");
    assert.equal((await t.api("/enrollments", { method: "POST", as: owner, body: { contact_id: c.id, cadence_key: "giveaway" } })).status, 409, "a board can't be started");
    assert.equal((await t.api(`/enrollments/${id}/pause`, { method: "POST", as: owner, body: {} })).body.data.enrollment.status, "paused");
    const res = await t.api("/enrollments/bulk-resume", { method: "POST", as: owner, body: { ids: [id, "en_00000000000000000000"] } });
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.equal(res.body.data.resumed, 1);
    assert.deepEqual(res.body.data.skipped, ["en_00000000000000000000"]);
    assert.equal((await enrollment(id)).status, "active");
    assert.equal((await t.api("/enrollments/bulk-resume", { method: "POST", as: owner, body: { ids: Array(16).fill(id) } })).status, 400);
    const stop = await t.api(`/enrollments/${id}/stop`, { method: "POST", as: owner, body: {} });
    assert.equal(stop.body.data.enrollment.stop_reason, "manual");
    // the deal: by hand, with If-Match
    const dealId = (await enrollment(id)).deal_id;
    const d = await t.api(`/deals/${dealId}`, { as: owner });
    assert.equal(d.status, 200);
    assert.equal(d.body.data.enrollments.length, 1);
    const p = await t.api(`/deals/${dealId}`, { method: "PATCH", as: owner, ifMatch: d.headers.get("etag"), body: { value_cents: 24310, status: "won" } });
    assert.equal(p.status, 200, JSON.stringify(p.body));
    assert.equal(p.body.data.deal.status, "won");
    assert.equal(p.body.data.deal.status_set_by_hand, true);
    assert.equal((await t.api(`/deals/${dealId}`, { method: "PATCH", as: owner, ifMatch: d.headers.get("etag"), body: { title: "x" } })).status, 412, "someone else changed it");
    assert.equal((await t.api(`/deals/${dealId}/lose`, { method: "POST", as: owner, body: { reason: "nope" } })).status, 400);
    const lost = await t.api(`/deals/${dealId}/lose`, { method: "POST", as: owner, body: { reason: "price", note: "Went with a cheaper crew." } });
    assert.equal(lost.body.data.deal.status, "lost");
    assert.equal((await t.api("/deals?status=won", { as: owner })).body.data.length, 0, "the open list holds open and quoted deals");
    assert.equal((await t.api(`/deals?contact=${c.id}`, { as: owner })).body.data[0].status, "lost");
    const hist = await t.api(`/records/deal/${dealId}/history`, { as: owner });
    assert.equal(hist.status, 200);
    assert.ok(hist.body.data.length >= 3, "every change is in the deal's history");
  } finally { t.done(); }
});

test("Settings → Cadences: edit steps with If-Match; a bad step is refused; a new cadence; the sales settings", async () => {
  const { t, owner } = await setup();
  try {
    const cad = (await t.api("/cadences", { as: owner })).body.data.find((x) => x.key === "new_lead");
    const got = await t.api(`/cadences/${cad.id}`, { as: owner });
    const steps = got.body.data.cadence.steps.slice(0, 9).map((s, i) => (i % 3 === 0 ? s : { ...s, action: "call", template_key: undefined }));
    const ok = await t.api(`/cadences/${cad.id}`, { method: "PATCH", as: owner, ifMatch: got.headers.get("etag"), body: { steps, unattended: "text_anyway" } });
    assert.equal(ok.status, 200, JSON.stringify(ok.body));
    assert.equal(ok.body.data.cadence.steps.length, 9, "D22's alternative: a text only after the first call each day");
    assert.equal(ok.body.data.cadence.unattended, "text_anyway");
    const bad = await t.api(`/cadences/${cad.id}`, { method: "PATCH", as: owner, ifMatch: ok.headers.get("etag"), body: { steps: [{ day: 2, window: { start: "09:00", end: "10:00" }, action: "call" }, { day: 1, window: { start: "09:00", end: "10:00" }, action: "call" }] } });
    assert.equal(bad.status, 400);
    const bad2 = await t.api(`/cadences/${cad.id}`, { method: "PATCH", as: owner, ifMatch: ok.headers.get("etag"), body: { steps: [{ day: 1, window: { start: "09:00", end: "10:00" }, action: "text" }] } });
    assert.equal(bad2.body.error.field, "steps.0.template_key", "a text step names its text");
    const nw = await t.api("/cadences", { method: "POST", as: owner, body: { key: "spring_reminder", name: "Spring reminder calls", entry: { on: "manual" }, steps: [{ day: 1, window: { start: "12:00", end: "13:00" }, action: "call", label: "Call" }] } });
    assert.equal(nw.status, 201, JSON.stringify(nw.body));
    assert.equal((await t.api("/cadences", { method: "POST", as: owner, body: { key: "spring_reminder", name: "Again" } })).status, 409);
    const sales = await t.api("/settings/sales", { as: owner });
    assert.equal(sales.body.data.data.attention_hours, 24);
    const put = await t.api("/settings/sales", { method: "PUT", as: owner, ifMatch: sales.body.data.etag || "new", body: { attention_hours: 12, abandon_days: 45, day_cutoff: "16:30" } });
    assert.equal(put.status, 200, JSON.stringify(put.body));
    assert.equal((await t.api("/settings/sales", { method: "PUT", as: owner, ifMatch: put.body.data.etag, body: { abandon_days: 1 } })).status, 400);
  } finally { t.done(); }
});

test("tasks: the office's list and edits; a technician's own task (no contact outside their visits); incidents", async () => {
  const { t, owner, tech } = await setup();
  try {
    const c = await makeLead(owner);
    const mk = await t.api("/tasks", { method: "POST", as: owner, body: { title: "Measure the sunroom", kind: "estimate_visit", due_at: "2026-11-20T15:00:00Z", end_at: "2026-11-20T16:00:00Z", contact_id: c.id, assignee_ids: [tech.id], notes: "Gate code on file." } });
    assert.equal(mk.status, 201, JSON.stringify(mk.body));
    const id = mk.body.data.task.id;
    assert.equal(mk.body.data.task.contact_name, c.display_name);
    assert.equal((await t.api("/tasks", { method: "POST", as: tech, body: { title: "x" } })).status, 403, "the office makes tasks");
    // the tech: their task, without the contact (no visit of theirs) and without notes
    const mine = await t.api("/tasks/mine", { as: tech });
    assert.equal(mine.body.data.length, 1);
    assert.equal(mine.body.data[0].contact_id, null);
    const one = await t.api(`/tasks/${id}`, { as: tech });
    assert.equal(one.status, 200);
    assert.equal(one.body.data.task.notes, undefined);
    assert.equal(one.body.data.task.contact_id, undefined);
    assert.ok(!JSON.stringify(one.body).includes(c.id), "no contact id leaks to a tech");
    const other = await t.api("/tasks", { method: "POST", as: owner, body: { title: "Not theirs", assignee_ids: [owner.id] } });
    assert.equal((await t.api(`/tasks/${other.body.data.task.id}`, { as: tech })).status, 404);
    assert.equal((await t.api(`/tasks/${id}`, { method: "PATCH", as: tech, body: { title: "renamed" } })).status, 403);
    const st = await t.api(`/tasks/${id}`, { method: "PATCH", as: tech, body: { status: "in_progress" } });
    assert.equal(st.status, 200);
    assert.equal((await t.api(`/tasks/${id}/done`, { method: "POST", as: tech, body: {} })).body.data.task.status, "done");
    assert.equal((await t.api("/tasks/mine", { as: tech })).body.data.length, 0, "done tasks leave the list");
    // office edits with If-Match
    const ot = await t.api(`/tasks/${other.body.data.task.id}`, { as: owner });
    const ed = await t.api(`/tasks/${other.body.data.task.id}`, { method: "PATCH", as: owner, ifMatch: ot.headers.get("etag"), body: { priority: "high", due_at: "2026-11-18T15:00:00Z" } });
    assert.equal(ed.body.data.task.priority, "high");
    assert.equal((await t.api("/tasks?assignee=me", { as: owner })).body.data.length, 1);
    assert.equal((await t.api(`/tasks?contact=${c.id}`, { as: owner })).body.data.length, 1);
    // an incident from the field: high priority, reported today, no due date
    const inc = await t.api("/incidents", { method: "POST", as: tech, body: { title: "Cracked storm window", notes: "On arrival." } });
    assert.equal(inc.status, 201);
    assert.ok(inc.body.data.task_id || inc.body.data.task);
    const it = (await store.getRecord("task", inc.body.data.task_id || inc.body.data.task.id)).data;
    assert.equal(it.kind, "incident");
    assert.equal(it.priority, "high");
    assert.equal(it.reported_on, "2026-11-17");
    assert.equal(it.due_at, undefined);
    assert.ok(it.assignee_ids.includes(owner.id), "it goes to the owners");
    assert.equal((await t.api("/incidents", { method: "POST", as: tech, body: { title: "x", contact_id: c.id } })).status, 404, "a contact outside their visits");
  } finally { t.done(); }
});

test("a contact's Sales tab: deals, follow-ups (newest open first), tasks, the cadences to start", async () => {
  const { t, owner } = await setup();
  try {
    const c = await makeLead(owner);
    const id = await E.enroll(c.id, "new_lead", {}, AS(owner));
    await t.api("/calls", { method: "POST", as: owner, body: { contact_id: c.id, enrollment_id: id, outcome: "spoke", note: "Call back Friday." } });
    const r = await t.api(`/sales/contacts/${c.id}`, { as: owner });
    assert.equal(r.status, 200);
    const d = r.body.data;
    assert.equal(d.enrollments[0].cadence_name, "New lead - no estimate yet");
    assert.equal(d.enrollments[0].status, "paused");
    assert.equal(d.deals.length, 1);
    assert.equal(d.tasks[0].kind, "follow_up");
    assert.ok(d.sales.last_called_at);
    assert.deepEqual(d.cadences.map((x) => x.key).sort(), ["estimate_followup", "new_lead"]);
    assert.equal((await t.api("/sales/contacts/ct_00000000000000000000", { as: owner })).status, 404);
  } finally { t.done(); }
});
