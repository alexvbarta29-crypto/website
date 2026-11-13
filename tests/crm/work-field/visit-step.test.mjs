// The Visit screen's one big button (the Nov 2026 layout; work/visit-step.js,
// work/visit.js, work/visit-field.js): it steps through the states the
// visit machine already has (On my way → Start → Finish → Get paid), never
// one work/states.mjs doesn't hold; with no signal it offers Start (On my
// way texts the customer and never queues); a change made offline is laid
// over the last copy so the button moves on at once, and the queued changes
// replay on the server in order to the same end.
import { test } from "node:test";
import assert from "node:assert/strict";

globalThis.window = globalThis.window || { __crm: { session: { perms: {} } } };
const { nextStep, STEPS, owedFrom } = await import("../../../crm-app/modules/work/visit-step.js");
const { VISIT_STATES, VISIT_STATUSES } = await import("../../../netlify/lib/crm/modules/work/states.mjs");
const { overlayVisit } = await import("../../../crm-app/modules/work/tech-kit.js");
const visitMod = await import("../../../crm-app/modules/work/visit.js");
import { setup, customer, job, visit, clock, cid, offline, post, patch, rec } from "./fixtures.mjs";
import { BYTES } from "../../helpers/crm-fixtures.mjs";

const EVENT = { omw: "on_my_way", start: "start", resume: "start", finish: "finish" };
const PAY = { key: "money.collect", owed: true };

test("the big button: one step per state, each a transition the visit machine holds", () => {
  const seen = {};
  for (const status of VISIT_STATUSES) {
    const s = nextStep({ status, online: true, collect: PAY });
    seen[status] = s && s.key;
    if (s && EVENT[s.key]) assert.ok(VISIT_STATES[status][EVENT[s.key]], `${status} → ${s.key} is in states.mjs`);
  }
  assert.deepEqual(seen, { scheduled: "omw", en_route: "start", in_progress: "finish", paused: "resume", completed: "pay", no_access: null, cancelled: null });
  assert.deepEqual(["omw", "start", "finish", "pay"].map((k) => STEPS[k].label), ["On my way", "Start", "Finish", "Get paid"]);
  // the attributes the field panel's own buttons use
  assert.deepEqual(nextStep({ status: "scheduled" }).attr, { "data-omw": true });
  assert.deepEqual(nextStep({ status: "en_route" }).attr, { "data-timer": "start" });
  assert.deepEqual(nextStep({ status: "in_progress" }).attr, { "data-complete": true });
  assert.deepEqual(nextStep({ status: "completed", collect: PAY }).attr, { "data-vact": "money.collect" });
});

test("Finish waits for the required checklist; Get paid only when the person may collect and something is owed", () => {
  const f = nextStep({ status: "in_progress", missing: ["Gate closed"] });
  assert.equal(f.key, "finish");
  assert.deepEqual(f.blocked, ["Gate closed"]);
  assert.equal(nextStep({ status: "in_progress" }).blocked, undefined);
  assert.equal(nextStep({ status: "completed", collect: null }), null, "may not collect: no button");
  assert.equal(nextStep({ status: "completed", collect: { key: "money.collect", owed: false } }), null, "nothing owed: no button");
  assert.equal(owedFrom({ can: { record: true } }), true);
  assert.equal(owedFrom({ can: { make: true } }), true, "an invoice made on the spot");
  assert.equal(owedFrom({ invoice: { status: "paid" }, can: { record: false, link: false, make: false } }), false);
  assert.equal(owedFrom(null), false);
});

test("with no signal the button offers Start (On my way texts the customer and never queues)", () => {
  const s = nextStep({ status: "scheduled", online: false });
  assert.equal(s.key, "start");
  assert.match(s.note, /No signal/);
  assert.equal(nextStep({ status: "en_route", online: false }).key, "start");
  assert.equal(nextStep({ status: "in_progress", online: false }).key, "finish");
});

test("offline: each change waits on the phone and the button moves on at once (overlay), Saved, will send when online", async () => {
  const field = (await import("../../../crm-app/modules/work/visit-field.js"));
  assert.equal(field.SAVED_OFFLINE, "Saved, will send when online.");
  const uid = "us_0000000000000000000t";
  const v = { id: "vs_00000000000000000001", status: "scheduled", checklist: { items: [{ key: "gate_closed", label: "Gate closed", required: true, kind: "check" }] } };
  const q = (what, body) => ({ path: `/visits/${v.id}/${what}`, body: { client_id: cid(), client_at: "2026-11-17T15:00:00.000Z", queued_offline: true, ...body } });
  let items = [q("timer", { action: "start" })];
  let o = overlayVisit(v, items, uid, []);
  assert.equal(o.visit.status, "in_progress");
  assert.equal(nextStep({ status: o.visit.status, online: false, missing: ["Gate closed"] }).key, "finish");
  items = [...items, q("checklist", { key: "gate_closed", done: true }), q("complete", {})];
  o = overlayVisit(v, items, uid, []);
  assert.equal(o.visit.status, "completed");
  assert.equal(o.waiting, 3);
  assert.equal(nextStep({ status: o.visit.status, online: false, collect: { key: "money.collect", owed: false } }), null);
  // the Visit screen draws the step from the panel and says the change is saved
  const panel = { key: "field", mod: field.default, state: { visit: { ...v, status: "in_progress", checklist: { items: [] } }, timers: [], waiting: 1 }, ctx: { user: { id: uid }, data: {} } };
  const go = visitMod.bigStep({ panels: [panel], visit: v, collect: null });
  assert.deepEqual([go.key, go.label, go.panel], ["finish", "Finish", "field"]);
  assert.equal(visitMod.bigStep({ panels: [], visit: { status: "completed" }, collect: PAY }).key, "pay", "the office, not on the visit: Get paid only");
  assert.equal(visitMod.bigStep({ panels: [], visit: { status: "scheduled" }, collect: PAY }), null);
});

test("the queued big-button changes replay on the server in order: started, ticked, finished at the phone's times", async () => {
  const { t, owner, tech } = await setup();
  try {
    const c = await customer(owner);
    const j = await job(owner, c);
    const v = await visit(owner, j, { date: "2026-11-17", start: "09:00", end: "11:00", assignee_ids: [tech.id] });
    const base = Date.parse(clock.nowIso());
    const at = (m) => new Date(base + m * 60000).toISOString();
    const replay = (body, m) => offline(body, at(m));
    let r = await post(t, tech, `/visits/${v.id}/timer`, replay({ action: "start" }, -40));
    assert.equal(r.status, 200, JSON.stringify(r.body));
    const jpeg = Buffer.from(BYTES.jpeg()).toString("base64");
    for (const [k, m] of [["walkaround_photo", -38], ["after_photo", -6]]) {
      r = await post(t, tech, `/visits/${v.id}/photos`, replay({ data: jpeg, tag: k === "after_photo" ? "after" : "before", item: k }, m));
      assert.equal(r.status, 201, JSON.stringify(r.body));
    }
    r = await patch(t, tech, `/visits/${v.id}/checklist`, replay({ key: "gate_closed", done: true }, -5));
    assert.equal(r.status, 200, JSON.stringify(r.body));
    r = await post(t, tech, `/visits/${v.id}/notes`, replay({ text: "Synthetic: done with no signal." }, -4));
    r = await post(t, tech, `/visits/${v.id}/complete`, replay({}, -3));
    assert.equal(r.status, 200, JSON.stringify(r.body));
    const done = await rec("visit", v.id);
    assert.equal(done.status, "completed");
    assert.equal(done.completion.at, at(-3), "done at the phone's time");
    assert.match(done.tech_notes, /no signal/);
    // and the button: nothing left but Get paid (when owed)
    assert.equal(nextStep({ status: done.status, collect: { key: "money.collect", owed: true } }).key, "pay");
  } finally { t.done(); }
});
