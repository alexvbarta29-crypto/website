// An owner edits a cadence while leads are in it (design §5.2, Settings →
// Cadences: "changes apply from each lead's next step"). Steps have ids: a
// lead keeps its own step whatever is inserted, removed or reordered; a lead
// whose step was removed goes to the next step that survived, or completes.
// Found in review: inserting a step made a lead get text 4 twice; removing
// steps left leads stuck on a step that no longer existed.
import { test } from "node:test";
import assert from "node:assert/strict";
import { setup, makeLead, enrollment, outbox, pin, E, AUTO, AS, store, SEED, AUTOMATION } from "./fixtures.mjs";

const { automationCtx } = await import("../../../netlify/lib/crm/core/activity.mjs");
const sweepCtx = () => ({ ...automationCtx({ mode: { system_of_record: "rotor", paused: false }, key: "sales.cadence", requestId: "test" }), budget: null, deploy: null, cursor: null });
const NL = () => SEED.seedCadenceId("new_lead");

// steps 1-4: no answer, the text sent by hand
async function toStep5(t, owner, c, id) {
  for (let n = 1; n <= 4; n++) {
    const e = await enrollment(id);
    pin(new Date(Date.parse(e.next_due_at) + 5 * 60000).toISOString());
    assert.equal((await t.api("/calls", { method: "POST", as: owner, body: { contact_id: c.id, enrollment_id: id, outcome: "no_answer", client_id: `step-${n}-aaaaaaaa` } })).status, 200);
    assert.equal((await t.api(`/cadence-steps/${id}/${n}/sent-by-hand`, { method: "POST", as: owner, body: { how: "copy" } })).status, 200);
  }
  const e = await enrollment(id);
  assert.equal(e.step_n, 5);
  assert.equal(e.step_id, "s5");
}
async function patchSteps(t, owner, fn) {
  const got = await t.api(`/cadences/${NL()}`, { as: owner });
  const r = await t.api(`/cadences/${NL()}`, { method: "PATCH", as: owner, ifMatch: got.headers.get("etag"), body: { steps: fn(got.body.data.cadence.steps.map(({ n, ...s }) => s)) } });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  return r.body.data.cadence;
}

test("the seeded cadences' steps have ids s1, s2, ...; a step added later gets the next unused one", async () => {
  const { t, owner } = await setup();
  try {
    const got = (await t.api(`/cadences/${NL()}`, { as: owner })).body.data.cadence;
    assert.deepEqual(got.steps.map((s) => s.id), ["s1", "s2", "s3", "s4", "s5", "s6", "s7", "s8", "s9", "s10"]);
    assert.equal(got.step_seq, 10);
    const cad = await patchSteps(t, owner, (steps) => [{ day: 1, window: { start: "09:00", end: "10:00" }, action: "call", label: "First" }, ...steps.slice(0, 9)]);
    assert.deepEqual(cad.steps.map((s) => s.id), ["s11", "s1", "s2", "s3", "s4", "s5", "s6", "s7", "s8", "s9"]);
    assert.deepEqual(cad.moved, { s10: null }, "s10 was removed, nothing after it");
    const again = await patchSteps(t, owner, (steps) => [...steps, { day: 3, action: "task", task_title: "Send estimate" }]);
    assert.equal(again.steps.at(-1).id, "s12", "an id is never reused");
  } finally { t.done(); }
});

test("a step inserted at the top while a lead is at step 5: step 5 still sends text 5, and text 4 only once", async () => {
  const { t, owner } = await setup();
  try {
    const c = await makeLead(owner);
    const id = await E.enroll(c.id, "new_lead", {}, AS(owner));
    await toStep5(t, owner, c, id);
    await patchSteps(t, owner, (steps) => [{ day: 1, window: { start: "09:00", end: "10:00" }, action: "text", template_key: "lead_ack", label: "Day 1 - Text first" }, ...steps]);
    const detail = await t.api(`/enrollments/${id}`, { as: owner });
    assert.match(detail.body.data.preview.text, /^Hey, just missed you again! You're probably getting a few other quotes/, "the preview is text 5");
    const e5 = await enrollment(id);
    pin(new Date(Date.parse(e5.next_due_at) + 5 * 60000).toISOString());
    const r = await t.api("/calls", { method: "POST", as: owner, body: { contact_id: c.id, enrollment_id: id, outcome: "no_answer", client_id: "step-5-bbbbbbbb" } });
    assert.equal(r.status, 200);
    assert.equal(r.body.data.next.kind, "hand");
    const sent = outbox(t).filter((o) => o.contact_id === c.id).map((o) => o.template_key);
    assert.deepEqual(sent, ["cad_new_1", "cad_new_2", "cad_new_3", "cad_new_4", "cad_new_5"]);
    assert.equal((await t.api(`/cadence-steps/${id}/5/sent-by-hand`, { method: "POST", as: owner, body: { how: "copy" } })).status, 200);
    const e6 = await enrollment(id);
    assert.equal(e6.step_id, "s6", "on to the step after its own");
    assert.equal(e6.step_n, 7, "which is 7th now");
    assert.equal(e6.cur.template_key, "cad_new_6");
    assert.equal(e6.history.filter((h) => h.action === "text").map((h) => h.sid).join(","), "s1,s2,s3,s4,s5");
  } finally { t.done(); }
});

test("steps removed: a lead on a removed step goes on to the next survivor (the sweep), or completes when none is left", async () => {
  const { t, owner } = await setup();
  try {
    const a = await makeLead(owner);
    const ida = await E.enroll(a.id, "new_lead", {}, AS(owner));
    await toStep5(t, owner, a, ida);
    const b = await makeLead(owner);
    const idb = await E.enroll(b.id, "new_lead", {}, AS(owner));
    const bDue = (await enrollment(idb)).next_due_at;
    // remove step 5 only: the lead at step 5 moves to step 6's text, planned from now
    await patchSteps(t, owner, (steps) => steps.filter((s) => s.id !== "s5"));
    pin("2026-11-18T19:10:00Z");                                 // Wed 13:10
    const r = await AUTO.cadenceSweep(sweepCtx());
    assert.ok(r.progress >= 2, "both leads brought up to date");
    const ea = await enrollment(ida);
    assert.equal(ea.status, "active");
    assert.equal(ea.step_id, "s6");
    assert.equal(ea.step_n, 5);
    assert.equal(ea.cur.template_key, "cad_new_6");
    assert.ok(Date.parse(ea.next_due_at) >= Date.parse("2026-11-18T22:00:00Z"), "the next window from now (4-5 PM)");
    const eb = await enrollment(idb);
    assert.equal(eb.step_id, "s1", "a lead before the change keeps its step");
    assert.equal(eb.next_due_at, bDue, "and its time (overdue stays overdue)");
    assert.equal((await AUTO.cadenceSweep(sweepCtx())).progress, 0, "once");
    // shorten to 3 steps: the lead now at step 6 has nothing left
    await patchSteps(t, owner, (steps) => steps.slice(0, 3));
    // logging a call on it before the sweep ran: noted, and the follow-up is done
    const call = await t.api("/calls", { method: "POST", as: owner, body: { contact_id: a.id, enrollment_id: ida, outcome: "no_answer", client_id: "removed-cccccccc" } });
    assert.equal(call.status, 200);
    const done = await enrollment(ida);
    assert.equal(done.status, "completed");
    assert.equal(done.history.at(-1).action, "call");
    assert.equal(outbox(t).filter((o) => o.contact_id === a.id && o.template_key === "cad_new_6").length, 0, "no text for a step that's gone");
  } finally { t.done(); }
});

test("an edit to the current step's text applies to it; reordering keeps each lead on its own step", async () => {
  const { t, owner } = await setup();
  try {
    const c = await makeLead(owner);
    const id = await E.enroll(c.id, "new_lead", {}, AS(owner));
    const before = await enrollment(id);
    await patchSteps(t, owner, (steps) => [steps[1], steps[0], ...steps.slice(2)].map((s) => (s.id === "s1" ? { ...s, template_key: "cad_new_9", label: "Day 1 - first (edited)" } : s)));
    await AUTO.cadenceSweep(sweepCtx());
    const e = await enrollment(id);
    assert.equal(e.step_id, "s1");
    assert.equal(e.step_n, 2, "its position now");
    assert.equal(e.cur.template_key, "cad_new_9");
    assert.equal(e.cur.label, "Day 1 - first (edited)");
    assert.equal(e.next_due_at, before.next_due_at, "its time as planned");
    const list = await t.api("/calls/list", { as: owner });
    const row = [...list.body.data.due, ...list.body.data.later, ...list.body.data.upcoming].find((r) => r.id === id);
    assert.equal(row.n, 2);
    assert.equal(row.label, "Day 1 - first (edited)");
  } finally { t.done(); }
});

test("before step ids: a stored cadence gets them by position (seed v2), an enrollment gets its step's id, a client without ids keeps them", async () => {
  const { t, owner } = await setup();
  try {
    // a cadence and an enrollment as stored before ids
    const cid = NL();
    const raw = t.stores.data.json(`rec/cadence/${cid}`);
    const legacy = { ...raw, steps: raw.steps.map(({ id: _i, ...s }) => s) };
    delete legacy.step_seq; delete legacy.steps_v;
    await t.stores.data.setJSON(`rec/cadence/${cid}`, legacy);
    const c = await makeLead(owner);
    const id = await E.enroll(c.id, "new_lead", {}, AS(owner));
    const old = { ...t.stores.data.json(`rec/enrollment/${id}`) };
    delete old.step_id; delete old.steps_v;
    await t.stores.data.setJSON(`rec/enrollment/${id}`, old);
    const { getRecord } = store;
    assert.equal((await getRecord("enrollment", id)).data.step_id, undefined);
    // seed v2
    const r = await SEED.addStepIds({ write: () => AUTOMATION });
    assert.ok(r.updated >= 1);
    const cad = (await getRecord("cadence", cid)).data;
    assert.deepEqual(cad.steps.map((s) => s.id).slice(0, 3), ["s1", "s2", "s3"]);
    // the sweep gives the enrollment its step's id
    await AUTO.cadenceSweep(sweepCtx());
    assert.equal((await enrollment(id)).step_id, "s1");
    // a client that sends steps without ids keeps them by position
    const got = await t.api(`/cadences/${cid}`, { as: owner });
    const p = await t.api(`/cadences/${cid}`, { method: "PATCH", as: owner, ifMatch: got.headers.get("etag"), body: { steps: got.body.data.cadence.steps.map(({ id: _i, n, ...s }) => s) } });
    assert.equal(p.status, 200);
    assert.deepEqual(p.body.data.cadence.steps.map((s) => s.id), cad.steps.map((s) => s.id));
    assert.equal(p.body.data.cadence.moved, undefined, "nothing removed");
  } finally { t.done(); }
});
