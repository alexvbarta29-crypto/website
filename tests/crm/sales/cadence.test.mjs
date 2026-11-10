// M2b acceptance: cadence timing (design §11.4 "cadence.test.mjs", §5.2,
// §7.4, §12.2 sales). The clock is pinned; America/Chicago; Sundays and
// holidays (Thanksgiving 2026-11-26) are skipped.
import { test } from "node:test";
import assert from "node:assert/strict";
import { setup, makeLead, enrollment, local, pin, C, SEED, E, AS, AUTOMATION } from "./fixtures.mjs";

const newLead = () => ({ ...SEED.SEED_CADENCES[0], steps: SEED.SEED_CADENCES[0].steps.map((s, i) => ({ ...s, n: i + 1 })) });

async function enrollAt(at, fields) {
  const s = await setup(at);
  const c = await makeLead(s.owner, fields);
  const id = await E.enroll(c.id, "new_lead", {}, AS(s.owner));
  assert.ok(id, "enrolled");
  return { ...s, c, id, e: await enrollment(id) };
}

test("a lead at 08:55 on a Tuesday is due in 9-10 that day", async () => {
  const { t, e } = await enrollAt("2026-11-17T14:55:00Z");
  try {
    assert.equal(e.day1, "2026-11-17");
    assert.equal(local(e.next_due_at), "Tue 11-17 09:00");
    assert.equal(local(e.due_end), "Tue 11-17 10:00");
    assert.equal(e.cur.label, "Day 1 - Call + VM/Text (1)");
    assert.equal(e.cur.template_key, "cad_new_1");
  } finally { t.done(); }
});

test("a lead at 17:30 starts the next business day", async () => {
  const { t, e } = await enrollAt("2026-11-17T23:30:00Z");
  try {
    assert.equal(e.day1, "2026-11-18");
    assert.equal(local(e.next_due_at), "Wed 11-18 09:00");
  } finally { t.done(); }
});

test("Sundays and holidays are skipped: Saturday evening → Monday; the day before Thanksgiving → Friday", async () => {
  let s = await enrollAt("2026-11-21T23:30:00Z");              // Saturday 17:30
  try {
    assert.equal(local(s.e.next_due_at), "Mon 11-23 09:00");
  } finally { s.t.done(); }
  s = await enrollAt("2026-11-25T23:30:00Z");                   // Wednesday 17:30, Thanksgiving tomorrow
  try {
    assert.equal(local(s.e.next_due_at), "Fri 11-27 09:00");
  } finally { s.t.done(); }
  // a lead at 10:30 the day before Thanksgiving: 12-1 today, day 2 is Friday, day 3 Saturday
  const cad = newLead();
  const env = { hours: undefined, calendar: undefined, now: "2026-11-25T16:30:00Z" };
  const first = C.firstStep(cad, { started_at: "2026-11-25T16:30:00Z", ...env });
  assert.equal(local(first.next_due_at), "Wed 11-25 12:00");
  const p4 = C.planStep(cad, 4, { day1: first.day1, now: "2026-11-25T16:30:00Z" });
  assert.equal(local(p4.due_at), "Fri 11-27 09:00", "Thanksgiving skipped");
  const p7 = C.planStep(cad, 7, { day1: first.day1, now: "2026-11-25T16:30:00Z" });
  assert.equal(local(p7.due_at), "Sat 11-28 09:00", "Saturday is a business day (8-5)");
  // and a Saturday's day 2 lands on Monday
  const sat = C.firstStep(cad, { started_at: "2026-11-21T14:55:00Z", now: "2026-11-21T14:55:00Z" });
  assert.equal(local(C.planStep(cad, 4, { day1: sat.day1, now: "2026-11-21T14:55:00Z" }).due_at), "Mon 11-23 09:00", "Sunday skipped");
  // an owner's extra holiday counts too
  const cal = { rules: ["thanksgiving", "christmas"], dates: ["2026-11-18"] };
  const tue = C.firstStep(cad, { started_at: "2026-11-17T23:30:00Z", now: "2026-11-17T23:30:00Z", calendar: cal });
  assert.equal(tue.day1, "2026-11-19", "Wednesday is the owner's day off");
});

test("a step logged late re-plans the next into the next open window, not a time already past", async () => {
  const { t, owner, id } = await enrollAt("2026-11-17T14:55:00Z");
  try {
    pin("2026-11-17T18:30:00Z");                                // 12:30: step 1 called late, inside the 12-1 window
    const r = await E.changeEnrollment(id, (e, c, env) => C.logStep(e, c, 1, { action: "call", outcome: "no_answer", by: owner.id }, env), AS(owner));
    assert.equal(r.changed, true);
    const e = await enrollment(id);
    assert.equal(e.step_n, 2);
    assert.equal(local(e.next_due_at), "Tue 11-17 16:00", "the next window, not 12:00 again");
    pin("2026-11-18T15:15:00Z");                                // step 2 logged the next morning (Wed 09:15)
    await E.changeEnrollment(id, (x, c, env) => C.logStep(x, c, 2, { action: "call", outcome: "no_answer", by: owner.id }, env), AS(owner));
    const e2 = await enrollment(id);
    assert.equal(e2.step_n, 3);
    assert.equal(local(e2.next_due_at), "Wed 11-18 12:00", "same-day steps follow in the next window");
    pin("2026-11-18T18:10:00Z");                                // step 3 at Wed 12:10: step 4 is a day later, so Thursday
    await E.changeEnrollment(id, (x, c, env) => C.logStep(x, c, 3, { action: "call", outcome: "no_answer", by: owner.id }, env), AS(owner));
    assert.equal(local((await enrollment(id)).next_due_at), "Thu 11-19 09:00", "the day gap is kept from when the step really happened");
  } finally { t.done(); }
});

test("the planner, table-first: every step of the new-lead cadence on time; a whole cadence logged", () => {
  const cad = newLead();
  let e = { ...C.firstStep(cad, { started_at: "2026-11-17T14:55:00Z", now: "2026-11-17T14:55:00Z" }) };
  const seen = [];
  for (let n = 1; n <= 10; n++) {
    seen.push(local(e.next_due_at));
    e = C.logStep(e, cad, n, { action: "call" }, { now: new Date(Date.parse(e.next_due_at) + 600000) });
  }
  assert.deepEqual(seen, ["Tue 11-17 09:00", "Tue 11-17 12:00", "Tue 11-17 16:00", "Wed 11-18 09:00", "Wed 11-18 12:00", "Wed 11-18 16:00", "Thu 11-19 09:00", "Thu 11-19 12:00", "Thu 11-19 16:00", "Thu 11-19 17:00"]);
  assert.equal(e.status, "completed");
  // a repeat of the same log changes nothing; a log for another step neither
  const e1 = C.firstStep(cad, { started_at: "2026-11-17T14:55:00Z", now: "2026-11-17T14:55:00Z" });
  const once = C.logStep({ ...e1, status: "active" }, cad, 1, { action: "call", cid: "ev_1" }, { now: "2026-11-17T15:10:00Z" });
  assert.equal(C.logStep(once, cad, 1, { action: "call", cid: "ev_1" }, { now: "2026-11-17T15:11:00Z" }), null);
  assert.equal(C.logStep(once, cad, 5, { action: "call" }, { now: "2026-11-17T15:11:00Z" }), null);
  // overdue and missed windows
  assert.equal(C.isOverdue({ de: "2026-11-17T16:00:00Z" }, new Date("2026-11-17T16:30:00Z")), true);
  assert.equal(C.windowsMissed("2026-11-17T16:00:00Z", "2026-11-17T18:30:00Z", C.windowsOf(cad)), 0, "the 12-1 window is still open");
  assert.equal(C.windowsMissed("2026-11-17T16:00:00Z", "2026-11-17T19:05:00Z", C.windowsOf(cad)), 1);
  // DST: the fall-back day keeps 09:00 local
  const dst = C.firstStep(cad, { started_at: "2026-11-02T14:00:00Z", now: "2026-11-02T14:00:00Z" });
  assert.equal(local(dst.next_due_at), "Mon 11-02 09:00");
});

test("one open enrollment per contact and cadence (B2): two at once make one; a finished one frees the slot", async () => {
  const s = await setup();
  try {
    const c = await makeLead(s.owner);
    const [a, b] = await Promise.all([E.enroll(c.id, "new_lead", {}, AUTOMATION), E.enroll(c.id, "new_lead", {}, AS(s.owner))]);
    assert.equal(a, b, "the same enrollment");
    assert.equal(s.t.stores.data.keys("rec/enrollment/").length, 1);
    assert.equal(s.t.stores.data.keys("rec/deal/").length, 1, "one deal");
    assert.equal(await E.enroll(c.id, "new_lead", {}, AS(s.owner)), a, "again: the open one");
    await E.stopEnrollment(a, "manual", AS(s.owner));
    const again = await E.enroll(c.id, "new_lead", {}, AS(s.owner));
    assert.ok(again && again !== a, "a stopped enrollment frees the slot");
    assert.equal((await enrollment(again)).deal_id, (await enrollment(a)).deal_id, "the open deal is reused");
    // automatic entry follows the cadence's rules; a person may enroll anyone
    const g = await makeLead(s.owner, { tags: ["Giveaway - New Lead"] });
    assert.equal(await E.enroll(g.id, "new_lead", {}, AUTOMATION), null, "giveaway leads stay out");
    assert.ok(await E.enroll(g.id, "new_lead", {}, AS(s.owner)), "unless a person enrolls them");
    const other = await makeLead(s.owner, { source: { source: "Holiday Lights Giveaway" } });
    assert.equal(await E.enroll(other.id, "new_lead", {}, AUTOMATION), null, "a source outside the list");
    assert.equal(await E.enroll(other.id, "giveaway", {}, AS(s.owner)), null, "a board has no steps");
  } finally { s.t.done(); }
});
