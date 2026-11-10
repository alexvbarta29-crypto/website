// Small pieces of the sales module: deal status rules (design §5.2 "Deal
// status is derived from events"), the cadence checks, the seeded texts
// (barta-rules: no "Reply STOP" in a template, the sender adds it), and a
// merge moving the merged contact's deals, follow-ups and tasks.
import { test } from "node:test";
import assert from "node:assert/strict";
import { setup, makeLead, enrollment, deal, E, D, SEED, AS, store } from "./fixtures.mjs";

const TY = await import("../../../netlify/lib/crm/modules/sales/types.mjs");
const { onMergeSales } = await import("../../../netlify/lib/crm/modules/sales/merge.mjs");

test("deal status: open → quoted → won; a won deal isn't lost by an event; by hand it can be (and says so)", () => {
  const d0 = { status: "open", quote_ids: [], job_ids: [], plan_ids: [] };
  const q = D.dealFor(d0, "quoted", { quote_id: "qt_00000000000000000001", at: "2026-11-17T15:00:00.000Z" });
  assert.equal(q.status, "quoted");
  assert.deepEqual(q.quote_ids, ["qt_00000000000000000001"]);
  assert.equal(D.dealFor(q, "quoted", { quote_id: "qt_00000000000000000001", at: q.last_activity_at }), null, "the same quote again changes nothing");
  const w = D.dealFor(q, "won", { job_id: "jb_00000000000000000001" });
  assert.equal(w.status, "won");
  assert.equal(D.dealFor(w, "lost", { reason: "price" }), null);
  assert.equal(D.dealFor(w, "abandoned"), null);
  const byHand = D.dealFor(w, "lost", { reason: "price", force: true });
  assert.equal(byHand.status, "lost");
  assert.equal(byHand.lost_reason, "price");
  assert.equal(byHand.status_set_by_hand, true);
  assert.equal(byHand.won_at, w.won_at, "kept for the history");
  assert.equal(D.dealFor(byHand, "won").status, "won", "a later approval still wins it");
  assert.equal(D.dealFor({ ...d0, status: "lost" }, "abandoned"), null);
  assert.equal(D.dealFor(d0, "lost", { reason: "nonsense" }).lost_reason, "other");
  assert.throws(() => D.dealFor(d0, "maybe"), /Pick open/);
  assert.equal(TY.lineOf(["Exterior Window Cleaning", "Gutter Cleaning"]), "mixed");
  assert.equal(TY.titleOf([]), "New lead");
});

test("cadence checks: steps in day order, renumbered; a text step names its text; never text anyway when a step is read first", () => {
  const ok = TY.validateCadence({ key: "x_test", name: "X", entry: { on: "manual" }, steps: [
    { day: 1, window: { start: "09:00", end: "10:00" }, action: "call", n: 7 },
    { day: 2, window: { start: "12:00", end: "13:00" }, action: "text", template_key: "cad_new_2" },
  ] }, { op: "create" });
  assert.deepEqual(ok.steps.map((s) => s.n), [1, 2]);
  assert.throws(() => TY.validateCadence({ key: "x_test", name: "X", entry: { on: "manual" }, steps: [{ day: 1, window: { start: "10:00", end: "09:00" }, action: "call" }] }, { op: "create" }));
  assert.throws(() => TY.validateCadence({ key: "x_test", name: "X", entry: { on: "manual" }, unattended: "text_anyway", steps: [{ day: 1, window: { start: "09:00", end: "10:00" }, action: "call_then_text", template_key: "cad_est_1", review_before_send: true }] }, { op: "create" }), (e) => e.field === "unattended");
  assert.throws(() => TY.validateCadence({ key: "x_test", name: "X", entry: { on: "manual" }, steps: [{ day: 1, window: { start: "09:00", end: "10:00" }, action: "teleport" }] }, { op: "create" }));
});

test("the seeded texts: the playbook's words, no opt-out line (the sender adds it), only the variables the CRM knows", () => {
  const keys = SEED.TEMPLATES.map((t) => t.key).sort();
  for (const k of ["lead_ack", "staff_new_lead", ...[1, 2, 3, 4, 5, 6, 7, 8, 9].map((n) => `cad_new_${n}`), ...[1, 2, 3, 4, 5].map((n) => `cad_est_${n}`)]) assert.ok(keys.includes(k), k);
  for (const t of SEED.TEMPLATES) {
    assert.doesNotMatch(t.body, /reply\s+stop/i, `${t.key}: no opt-out line`);
    for (const v of t.body.match(/\{\{\s*([\w.]+)/g) || []) assert.ok(/\{\{\s*(first_name|sender_first_name|review_count|review_link|town)\b/.test(v), `${t.key}: ${v}`);
  }
  const est = SEED.SEED_CADENCES.find((c) => c.key === "estimate_followup");
  assert.ok(est.steps.every((s) => s.review_before_send), "every estimate follow-up step is read before sending");
  assert.equal(est.unattended, "wait");
  const nl = SEED.SEED_CADENCES.find((c) => c.key === "new_lead");
  assert.equal(nl.steps.length, 10);
  assert.ok(nl.entry.exclude_tags.includes("Giveaway - New Lead"));
});

test("a merge moves the merged contact's deals, follow-ups and tasks; a second open one in the same cadence stops as a duplicate", async () => {
  const { t, owner } = await setup();
  try {
    const a = await makeLead(owner);
    const b = await makeLead(owner);
    const ea = await E.enroll(a.id, "new_lead", {}, AS(owner));
    const eb = await E.enroll(b.id, "new_lead", {}, AS(owner));
    const eb2 = await E.enroll(b.id, "estimate_followup", { quote_id: "qt_00000000000000000041" }, AS(owner));
    const task = (await store.createRecord("task", { title: "Call back", kind: "call", status: "open", priority: "medium", contact_id: b.id, assignee_ids: [owner.id] }, AS(owner))).data;
    await onMergeSales(a.id, b.id, AS(owner));
    assert.equal((await enrollment(ea)).status, "active");
    const dup = await enrollment(eb);
    assert.equal(dup.status, "stopped");
    assert.equal(dup.stop_reason, "duplicate");
    assert.equal(dup.contact_id, a.id);
    const moved = await enrollment(eb2);
    assert.equal(moved.status, "active");
    assert.equal(moved.contact_id, a.id);
    assert.equal(moved.contact_name, a.display_name || `${a.first_name} ${a.last_name}`);
    assert.equal((await deal(dup.deal_id)).contact_id, a.id);
    assert.equal((await store.getRecord("task", task.id)).data.contact_id, a.id);
    // the survivor's one-open slot now names the moved follow-up
    const again = await E.enroll(a.id, "estimate_followup", { quote_id: "qt_00000000000000000041" }, AS(owner));
    assert.equal(again, eb2);
  } finally { t.done(); }
});

test("every seeded text reads naturally with no first name on file (\"Good morning!\", \"Hey, ...\"), and with one", async () => {
  const T = await import("../../../netlify/lib/crm/core/templates.mjs");
  const base = { sender_first_name: "Alex", review_count: "150", review_link: "https://example.com/r" };
  for (const tpl of SEED.TEMPLATES) {
    const without = T.renderTemplate({ ...tpl }, { ...base, first_name: "", town: "" }).text;
    assert.doesNotMatch(without, /\bthere\b[!,]|morning there|Hey there|Hi there/, `${tpl.key}: no "there" for a missing name`);
    assert.doesNotMatch(without, / [,.!?]/, `${tpl.key}: no stray space before punctuation`);
    const withName = T.renderTemplate({ ...tpl }, { ...base, first_name: "Pat", town: "Delano" }).text;
    if (/\{\{\s*first_name\b/.test(tpl.body)) assert.match(withName, /Pat/, `${tpl.key}: the name when we have it`);
  }
  const r = (key, first) => T.renderTemplate(SEED.TEMPLATES.find((x) => x.key === key), { ...base, first_name: first }).text;
  assert.match(r("cad_new_4", ""), /^Good morning! This is Alex with BARTA Window Washing\./);
  assert.match(r("cad_new_4", "Pat"), /^Good morning Pat! This is Alex/);
  assert.match(r("cad_new_2", ""), /^Hey, just missed you again!/);
  assert.match(r("cad_est_1", ""), /^Hey, it's Alex with BARTA Window Washing\./);
  assert.match(r("lead_ack", ""), /^Hi! Thanks for reaching out/);
  assert.match(r("staff_new_lead", ""), /^New lead: Someone in the area\./);
});
