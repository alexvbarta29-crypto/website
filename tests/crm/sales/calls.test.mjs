// M2b acceptance: calls (design §11.4 "calls.test.mjs", §5.2 "Calls", D20).
// An inbound call pauses the enrollment and is not an outbound touch; a
// provisional "calling" holds lead.ack off for 30 minutes. And every
// outcome of §5.2 step 3.
import { test } from "node:test";
import assert from "node:assert/strict";
import { advance, minutes } from "../../helpers/crm-clock.mjs";
import { setup, makeLead, enrollment, outbox, drain, pin, E, intake, store } from "./fixtures.mjs";

const webLead = (n, extra = {}) => ({
  first_name: "Casey", last_name: `Webform${n}`, phone: `(763) 555-03${String(n).padStart(2, "0")}`, email: `casey.web${n}@example.com`,
  address: { street1: `${300 + n} Lake St`, city: "Delano", state: "MN", zip: "55328" }, services: ["Exterior Window Cleaning"],
  notes: "Customer notes:\nTwo-story.", source: "Website quote form", consent: { sms_service: true }, ...extra,
});

test("an inbound call pauses the enrollment and is not an outbound touch", async () => {
  const { t, owner } = await setup();
  try {
    const c = await makeLead(owner);
    const id = await E.enroll(c.id, "new_lead", {}, { by: owner.id, origin: "api", actor_kind: "user", requestId: "x" });
    const r = await t.api("/calls", { method: "POST", as: owner, body: { contact_id: c.id, direction: "in", note: "Called back about the quote." } });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    const e = await enrollment(id);
    assert.equal(e.status, "paused");
    assert.equal(e.paused_reason, "inbound_call");
    assert.equal(e.step_n, 1, "the step did not move on");
    assert.equal(e.last_touch_at, undefined, "not an outbound touch");
    assert.equal(e.history[0].action, "inbound_call");
    const st = (await store.getRecord("contact_stats", c.id)).data.sales;
    assert.equal(st.last_called_at, null, "no outbound call recorded");
    assert.ok(st.last_inbound_call_at);
    assert.ok(r.body.data.task && r.body.data.task.title.startsWith("Called in:"), "someone gets back to them");
    assert.equal(outbox(t).length, 0, "no text");
    // the call.logged listener (the backstop) finds nothing more to pause
    await drain(t, 2);
    assert.equal((await enrollment(id)).status, "paused");
    assert.equal(t.stores.data.keys("rec/task/").length, 1, "one task");
    // resume from the Leads screen: active, the step planned from now
    pin("2026-11-17T19:05:00Z");
    const res = await t.api(`/enrollments/${id}/resume`, { method: "POST", as: owner, body: {} });
    assert.equal(res.status, 200);
    assert.equal(res.body.data.enrollment.status, "active");
    assert.ok(Date.parse(res.body.data.enrollment.next_due_at) >= Date.parse("2026-11-17T22:00:00Z"), "the next open window (4-5 PM)");
  } finally { t.done(); }
});

test("a provisional calling holds lead.ack off for 30 minutes; without it the thank-you text goes at 5 minutes", async () => {
  const { t, owner } = await setup();
  try {
    const a = await intake.intakeLead(webLead(1), { origin: "lead-form" });
    const b = await intake.intakeLead(webLead(2), { origin: "lead-form" });
    assert.ok(a.ok && b.ok && a.enrollment_id && b.enrollment_id, "intake enrolled both");
    await drain(t, 2);                                           // the lead.created listeners and automations queue lead.ack
    const call = await t.api("/calls", { method: "POST", as: owner, body: { contact_id: a.contact_id, enrollment_id: a.enrollment_id, outcome: "calling" } });
    assert.equal(call.status, 200);
    assert.ok(call.body.data.call.calling_until);
    advance(minutes(5) + 1000);
    await drain(t, 3);
    const acks = outbox(t).filter((o) => o.template_key === "lead_ack");
    assert.equal(acks.length, 1, "one thank-you text: the lead nobody was calling");
    assert.equal(acks[0].contact_id, b.contact_id);
    assert.equal(acks[0].mode, "dry_run", "dry-run before cutover");
    assert.match(acks[0].body, /^Hi Casey! Thanks for reaching out to BARTA Window Washing\./);
    const skipped = t.stores.data.keys("alog/").filter((k) => k.includes("lead.ack") && k.includes("skipped-calling"));
    assert.equal(skipped.length, 1, "the called lead's text was held off (calling)");
    // the owners heard about both leads
    assert.ok(t.stores.data.keys("rec/notification/").length >= 2);
  } finally { t.done(); }
});

test("lead.ack after hours: right away (then quiet hours hold it to 8:00)", async () => {
  const { t } = await setup("2026-11-18T03:30:00Z");          // Tuesday 21:30
  try {
    const a = await intake.intakeLead(webLead(3), { origin: "lead-form" });
    assert.ok(a.ok);
    await drain(t, 3);
    assert.equal(outbox(t).filter((o) => o.template_key === "lead_ack").length, 0, "not at 21:30 (quiet hours)");
    pin("2026-11-18T14:01:00Z");                               // Wednesday 08:01
    await drain(t, 3);
    assert.equal(outbox(t).filter((o) => o.template_key === "lead_ack").length, 1, "at 8:00, when nobody had called yet");
  } finally { t.done(); }
});

test("outcomes: spoke pauses with a task; booked completes; not interested stops and loses the deal; wrong number flags the phone", async () => {
  const { t, owner } = await setup();
  try {
    const user = { by: owner.id, origin: "api", actor_kind: "user", requestId: "x" };
    const mk = async () => { const c = await makeLead(owner); return { c, id: await E.enroll(c.id, "new_lead", {}, user) }; };
    const s = await mk();
    const spoke = await t.api("/calls", { method: "POST", as: owner, body: { contact_id: s.c.id, enrollment_id: s.id, outcome: "spoke", note: "Wants a quote for 30 windows, call Friday." } });
    assert.equal((await enrollment(s.id)).status, "paused");
    assert.equal(spoke.body.data.task.kind, "follow_up");
    assert.equal(spoke.body.data.task.notes, "Wants a quote for 30 windows, call Friday.");
    assert.deepEqual(spoke.body.data.task.assignee_ids, [owner.id]);

    const b = await mk();
    await t.api("/calls", { method: "POST", as: owner, body: { contact_id: b.c.id, enrollment_id: b.id, outcome: "booked" } });
    const be = await enrollment(b.id);
    assert.equal(be.status, "completed");
    assert.equal(be.stop_reason, "booked");
    assert.equal((await store.getRecord("deal", be.deal_id)).data.status, "open", "won only when the job or quote is approved");

    const ni = await mk();
    await t.api("/calls", { method: "POST", as: owner, body: { contact_id: ni.c.id, enrollment_id: ni.id, outcome: "not_interested" } });
    const ne = await enrollment(ni.id);
    assert.equal(ne.status, "stopped");
    assert.equal(ne.stop_reason, "lost");
    const nd = (await store.getRecord("deal", ne.deal_id)).data;
    assert.equal(nd.status, "lost");
    assert.equal(nd.lost_reason, "other");

    const w = await mk();
    await t.api("/calls", { method: "POST", as: owner, body: { contact_id: w.c.id, enrollment_id: w.id, outcome: "wrong_number" } });
    assert.equal((await enrollment(w.id)).stop_reason, "wrong_number");
    const ph = (await store.getRecord("contact", w.c.id)).data.phones[0];
    assert.equal(ph.flag, "wrong_number");
    assert.equal(ph.sms, false, "no more texts to that number");
    // a call on the contact itself, no enrollment named: it decides for their open follow-ups
    const x = await mk();
    await t.api("/calls", { method: "POST", as: owner, body: { contact_id: x.c.id, outcome: "booked" } });
    assert.equal((await enrollment(x.id)).status, "completed");
    // bad input
    assert.equal((await t.api("/calls", { method: "POST", as: owner, body: { contact_id: x.c.id, outcome: "maybe" } })).status, 400);
    assert.equal((await t.api("/calls", { method: "POST", as: owner, body: { contact_id: "ct_00000000000000000000", outcome: "spoke" } })).status, 404);
    const tech = await t.user("tech");
    assert.equal((await t.api("/calls", { method: "POST", as: tech, body: { contact_id: x.c.id, outcome: "spoke" } })).status, 403, "techs don't work the call list");
  } finally { t.done(); }
});
