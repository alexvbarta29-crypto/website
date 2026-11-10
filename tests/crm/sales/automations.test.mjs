// The sales automations and sweeps (design §5.2, §5.7.5 "lead.*", §7.5):
// lead.alert (the owners hear about a new lead: first name and town only),
// sales.attention (once per lead per day), sales.cadence (a task step, a
// call step's text sent anyway when the cadence says so, a step two weeks
// late ends its follow-up).
import { test } from "node:test";
import assert from "node:assert/strict";
import { setup, makeLead, enrollment, outbox, drain, pin, E, AUTO, intake, AS } from "./fixtures.mjs";

const { automationCtx } = await import("../../../netlify/lib/crm/core/activity.mjs");
const sweepCtx = (key, mode = { system_of_record: "rotor", paused: false }) => ({ ...automationCtx({ mode, key, requestId: "test" }), budget: null, deploy: null, cursor: null });
const notes = (t) => t.stores.data.keys("rec/notification/").map((k) => t.stores.data.json(k));

test("lead.alert: the owners hear about a new web lead with a first name and a town, linked to the contact", async () => {
  const { t, owner } = await setup();
  try {
    const r = await intake.intakeLead({
      first_name: "Morgan", last_name: "Alertson", phone: "(763) 555-0491", email: "morgan.alert@example.com",
      address: { street1: "12 Elm St", city: "Delano", state: "MN", zip: "55328" }, services: ["Gutter Cleaning"], source: "Website quote form", consent: { sms_service: true },
    }, { origin: "lead-form" });
    assert.ok(r.ok);
    await drain(t, 3);
    const n = notes(t).filter((x) => x.title === "New lead");
    assert.equal(n.length, 1, "one owner, one note");
    assert.equal(n[0].user_id, owner.id);
    assert.equal(n[0].link, `/contacts/${r.contact_id}`);
    assert.match(n[0].body, /Morgan/);
    assert.match(n[0].body, /Delano/);
    assert.doesNotMatch(n[0].body, /Alertson|555|example\.com|Elm/, "nothing more on a lock screen");
  } finally { t.done(); }
});

test("sales.attention: a lead nobody has called is pushed once a day, and counted on Today", async () => {
  const { t, owner } = await setup();
  try {
    const c = await makeLead(owner);
    await E.enroll(c.id, "new_lead", {}, AS(owner));
    pin("2026-11-18T16:30:00Z");                                 // Wednesday 10:30: step 1 (Tue 9-10) is overdue
    const one = await AUTO.attentionSweep(sweepCtx("sales.attention"));
    assert.equal(one.progress, 1);
    await drain(t, 2);                                          // the notice is a queue item
    const pushed = notes(t).filter((x) => x.title === "Lead needs a call");
    assert.equal(pushed.length, 1);
    assert.match(pushed[0].body, /^Pat in Delano: /);
    assert.equal(pushed[0].link, "/calls");
    const again = await AUTO.attentionSweep(sweepCtx("sales.attention"));
    assert.equal(again.progress, 0, "once per lead per day");
    await drain(t, 2);
    assert.equal(notes(t).filter((x) => x.title === "Lead needs a call").length, 1);
    const att = await t.api("/attention", { as: owner });
    assert.equal(att.status, 200);
    assert.equal(att.body.data.count, 1);
    assert.equal(att.body.data.items[0].contact_id, c.id);
    assert.equal(await AUTO.attentionCount(), 1, "the Today count");
    pin("2026-11-19T16:30:00Z");                                 // Thursday: still nobody called
    assert.equal((await AUTO.attentionSweep(sweepCtx("sales.attention"))).progress, 1);
    // a call takes it off the list
    await t.api("/calls", { method: "POST", as: owner, body: { contact_id: c.id, outcome: "spoke" } });
    assert.equal((await t.api("/attention", { as: owner })).body.data.count, 0);
  } finally { t.done(); }
});

test("sales.cadence: a call step's text goes anyway (dry-run) when the cadence says so; a task step makes its task; two weeks late ends it", async () => {
  const { t, owner } = await setup();
  try {
    const mk = await t.api("/cadences", { method: "POST", as: owner, body: {
      key: "test_anyway", name: "Test: text anyway", entry: { on: "manual" }, unattended: "text_anyway",
      steps: [{ day: 1, window: { start: "09:00", end: "10:00" }, action: "call_then_text", template_key: "cad_new_1", label: "Call 1" },
        { day: 1, action: "task", task_title: "Send estimate", label: "Send the estimate" }],
    } });
    assert.equal(mk.status, 201, JSON.stringify(mk.body));
    const c = await makeLead(owner);
    const id = await E.enroll(c.id, "test_anyway", {}, AS(owner));
    pin("2026-11-17T16:05:00Z");                                 // Tuesday 10:05: the window passed with no call
    const r = await AUTO.cadenceSweep(sweepCtx("sales.cadence"));
    assert.equal(r.progress, 1);
    const sent = outbox(t).filter((o) => o.contact_id === c.id);
    assert.equal(sent.length, 1);
    assert.equal(sent[0].mode, "dry_run", "nothing leaves the site");
    assert.equal(sent[0].template_key, "cad_new_1");
    assert.doesNotMatch(sent[0].body, /Reply STOP to opt out\.?\s*Reply STOP/, "one footer at most (the sender's)");
    const e1 = await enrollment(id);
    assert.equal(e1.step_n, 2);
    assert.equal(e1.history.at(-1).action, "text");
    assert.equal(e1.history.at(-1).unattended, true);
    await AUTO.cadenceSweep(sweepCtx("sales.cadence"));
    const e2 = await enrollment(id);
    assert.equal(e2.status, "completed", "the last step done");
    const tasks = (await t.api(`/tasks?contact=${c.id}`, { as: owner })).body.data;
    assert.equal(tasks.length, 1);
    assert.match(tasks[0].title, /^Send estimate: Pat Sample/);
    assert.deepEqual(tasks[0].assignee_ids, [owner.id], "nobody owns or called this lead: the owner");
    // the sweep again: nothing twice
    assert.equal((await AUTO.cadenceSweep(sweepCtx("sales.cadence"))).progress, 0);
    assert.equal(outbox(t).filter((o) => o.contact_id === c.id).length, 1);

    // a new-lead step left for over two weeks ends its follow-up (expired)
    const d = await makeLead(owner);
    const old = await E.enroll(d.id, "new_lead", {}, AS(owner));
    pin("2026-12-03T16:00:00Z");
    await AUTO.cadenceSweep(sweepCtx("sales.cadence"));
    const ex = await enrollment(old);
    assert.equal(ex.status, "stopped");
    assert.equal(ex.stop_reason, "expired");
    assert.equal(outbox(t).filter((o) => o.contact_id === d.id).length, 0, "new_lead waits: no text on its own");
  } finally { t.done(); }
});
