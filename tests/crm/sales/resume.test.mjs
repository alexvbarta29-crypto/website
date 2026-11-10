// Resuming a follow-up (design §5.2): the current step is planned from now,
// however long it was paused; an enrollment shaped like Rotor's (no day 1,
// as the cutover re-opens them) resumes too; bulk resume reports the one
// that can't instead of failing the batch. Found in review: after ~5 weeks
// the old due time stayed and the next sweep expired the follow-up; an
// imported shape threw and bulk resume answered 500.
import { test } from "node:test";
import assert from "node:assert/strict";
import { setup, makeLead, importedContact, enrollment, pin, E, AUTO, AS, store, SEED, IMPORT, clock } from "./fixtures.mjs";

const { automationCtx } = await import("../../../netlify/lib/crm/core/activity.mjs");
const sweepCtx = () => ({ ...automationCtx({ mode: { system_of_record: "rotor", paused: false }, key: "sales.cadence", requestId: "test" }), budget: null, deploy: null, cursor: null });

for (const weeks of [3, 7]) {
  test(`paused after a talk, resumed ${weeks} weeks later: planned from now, still active after the next sweep`, async () => {
    const { t, owner } = await setup();
    try {
      const c = await makeLead(owner);
      const id = await E.enroll(c.id, "new_lead", {}, AS(owner));
      pin("2026-11-17T15:10:00Z");
      assert.equal((await t.api("/calls", { method: "POST", as: owner, body: { contact_id: c.id, enrollment_id: id, outcome: "spoke", note: "Call back later." } })).status, 200);
      pin(new Date(Date.parse("2026-11-17T15:10:00Z") + weeks * 7 * 86400000).toISOString());
      const res = await t.api(`/enrollments/${id}/resume`, { method: "POST", as: owner, body: {} });
      assert.equal(res.status, 200, JSON.stringify(res.body));
      const e = await enrollment(id);
      assert.ok(Date.parse(e.due_end) > clock.nowMs(), `its window (${e.next_due_at}) hasn't ended`);
      assert.ok(Date.parse(e.next_due_at) - clock.nowMs() < 4 * 86400000, "the next open window, not weeks out");
      await AUTO.cadenceSweep(sweepCtx());
      assert.equal((await enrollment(id)).status, "active");
    } finally { t.done(); }
  });
}

test("an enrollment shaped like Rotor's (no day 1, no step id) resumes: day 1 is today, its step planned from now", async () => {
  const { t, owner } = await setup("2027-01-04T16:00:00Z");      // Monday 10:00
  try {
    const c = await importedContact();
    const en = (await store.createRecord("enrollment", {
      contact_id: c.id, cadence_id: SEED.seedCadenceId("new_lead"), cadence_key: "new_lead", status: "paused", paused_reason: "manual", step_n: 4, history: [],
      started_at: "2027-01-01T15:00:00.000Z", import: { run_id: "ir_00000000000000000001", at: "2026-12-31T00:00:00.000Z", hash: "4".repeat(64) },
    }, IMPORT)).data;
    assert.equal(en.day1, undefined);
    const r = await t.api(`/enrollments/${en.id}/resume`, { method: "POST", as: owner, body: {} });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    const e = await enrollment(en.id);
    assert.equal(e.status, "active");
    assert.equal(e.day1, "2027-01-04");
    assert.equal(e.step_id, "s4");
    assert.equal(e.next_due_at, "2027-01-05T15:00:00.000Z", "step 4 is a day-2 step: Tuesday 9-10");
  } finally { t.done(); }
});

test("bulk resume: one that can't resume is reported, the others resume", async () => {
  const { t, owner } = await setup();
  try {
    const ids = [];
    for (let i = 0; i < 2; i++) {
      const c = await makeLead(owner);
      const id = await E.enroll(c.id, "new_lead", {}, AS(owner));
      await E.pauseEnrollment(id, "manual", AS(owner));
      ids.push(id);
    }
    // one stored broken (a history that isn't a list): its write is refused
    const raw = t.stores.data.json(`rec/enrollment/${ids[1]}`);
    await t.stores.data.setJSON(`rec/enrollment/${ids[1]}`, { ...raw, history: "not a list" });
    const r = await t.api("/enrollments/bulk-resume", { method: "POST", as: owner, body: { ids } });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(r.body.data.resumed, 1);
    assert.deepEqual(r.body.data.failed.map((f) => f.id), [ids[1]]);
    assert.equal((await enrollment(ids[0])).status, "active");
  } finally { t.done(); }
});
