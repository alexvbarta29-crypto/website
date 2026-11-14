// A plan's terms after it's made (the owner, Nov 14: copy Rotor): frequency,
// agreement length and renewal, start date and billing mode are editable.
// The rule (machine.mjs planEdit): done, booked, skipped and cancelled visits
// stay; the current term's visits still to book are made again for the new
// terms (their jobs cancelled, new jobs made); a signed agreement is never
// edited (the plan is marked as needing a new one), an unsigned one is
// voided; an imported plan Rotor is in charge of changes nothing (a would-
// row); techs can't; a retry is one op.
import { test } from "node:test";
import assert from "node:assert/strict";
import { setup, staffPlan, customer, importedCustomer, importedPlan, planOf, recOf, finishRun, drain, alog, store, scope, AS, EXT, M, AG } from "./fixtures.mjs";

const TODAY = "2026-11-17";
// A pure plan for the machine: Biannual, one line on every visit.
function plan(extra = {}) {
  const p = {
    id: "pl_00000000000000000001", contact_id: "ct_0000000000000000000a", kind: "recurring", catalog_key: "biannual", name: "Biannual plan", status: "active",
    frequency: { interval: "month", count: 6 }, visits_per_year: 2,
    lines: [{ id: "ln_1", title: "Exterior Window Cleaning", qty_milli: 1000, unit_cents: 29500, total_cents: 29500, scope: { type: "all" } }],
    discounts: [{ id: "dc_1", name: "Biannual plan discount", type: "fixed", value: 5000, scope: { type: "all" } }],
    term: M.firstTerm({ start_on: "2026-11-17", initial_months: 12, renews_every_months: 6 }), billing: { mode: "barta_standard", autopay: true, card_required: true },
    policy: {}, agreement_status: "signed", agreement_id: "ag_00000000000000000001", renewal: {},
    ordinals: [
      { term: 1, n: 1, k: 1, target_month: "2026-11", status: "completed", completed_on: "2026-11-10", job_id: "jb_00000000000000000001", gen: 0 },
      { term: 1, n: 2, k: 2, target_month: "2027-05", status: "unscheduled", job_id: "jb_00000000000000000002", gen: 0 },
    ],
    ...extra,
  };
  return p;
}
const edit = (p, changes, booked) => M.planEdit(p, changes, { today: TODAY, booked: new Set(booked || []) });

test("frequency: done visits stay, the visits still to book are made again from the last one kept, their jobs cancelled", () => {
  const out = edit(plan(), { frequency: { interval: "month", count: 3 } });
  assert.deepEqual(out.fields.map((f) => f.field), ["frequency"]);
  assert.equal(out.next.visits_per_year, 4);
  const o = out.next.ordinals;
  assert.equal(o[0].status, "completed", "the done visit is untouched");
  assert.equal(o[0].job_id, "jb_00000000000000000001");
  assert.deepEqual(o.slice(1).map((x) => [x.n, x.target_month, x.status, !!x.job_id]), [[2, "2027-02", "unscheduled", false], [3, "2027-05", "unscheduled", false], [4, "2027-08", "unscheduled", false]]);
  assert.ok(o.slice(1).every((x) => x.gen === 1), "a new generation (never the old jobs' batch)");
  assert.deepEqual(out.to_cancel, ["jb_00000000000000000002"]);
  assert.deepEqual(out.visits, { kept: 1, removed: 1, added: 3, months: ["2027-02", "2027-05", "2027-08"] });
  assert.equal(out.next.sale_value_cents, 4 * 24500);
  assert.equal(out.stale, true, "a signed agreement: the plan needs a new one");
  assert.deepEqual(out.next.agreement_stale, { since: TODAY, fields: ["frequency"], agreement_id: "ag_00000000000000000001" });
  assert.equal(plan().ordinals[1].job_id, "jb_00000000000000000002", "pure: the plan passed in is unchanged");
});

test("a booked visit stays (also one whose job got booked a moment ago); fewer visits: nothing added", () => {
  const p = plan({ frequency: { interval: "month", count: 3 }, visits_per_year: 4, ordinals: [
    { term: 1, n: 1, k: 1, target_month: "2026-11", status: "completed", completed_on: "2026-11-10", gen: 0 },
    { term: 1, n: 2, k: 2, target_month: "2027-02", status: "scheduled", visit_date: "2027-02-09", job_id: "jb_00000000000000000002", gen: 0 },
    { term: 1, n: 3, k: 3, target_month: "2027-05", status: "unscheduled", job_id: "jb_00000000000000000003", gen: 0 },
    { term: 1, n: 4, k: 4, target_month: "2027-08", status: "unscheduled", job_id: "jb_00000000000000000004", gen: 0 },
  ] });
  const out = edit(p, { frequency: { interval: "month", count: 6 } }, ["jb_00000000000000000003"]);
  assert.deepEqual(out.next.ordinals.map((o) => [o.n, o.status, o.job_id || null]), [[1, "completed", null], [2, "scheduled", "jb_00000000000000000002"], [3, "unscheduled", "jb_00000000000000000003"]]);
  assert.deepEqual(out.to_cancel, ["jb_00000000000000000004"]);
  assert.equal(out.visits.added, 0, "2 a year, 3 kept: none to add");
});

test("length, renewal, start date and billing; what can't change says why", () => {
  const len = edit(plan(), { term_months: 24 });
  assert.equal(len.next.term.initial_months, 24);
  assert.equal(len.next.term.initial_end_on, "2028-11-16");
  assert.equal(len.next.term.current_term_end, "2028-11-16");
  assert.equal(len.next.term.price_locked_until, "2028-11-16");
  assert.equal(len.next.renewal.next_on, "2028-11-16");
  assert.deepEqual(len.next.ordinals.slice(1).map((o) => o.target_month), ["2027-05", "2027-11", "2028-05"], "3 more visits, 6 months apart");

  const ren = edit(plan(), { auto_renew: false, billing_mode: "after_visit" });
  assert.equal(ren.next.term.auto_renew, false);
  assert.equal(ren.next.billing.mode, "after_visit");
  assert.equal(ren.schedule, false);
  assert.deepEqual(ren.to_cancel, [], "no visit changes");
  assert.deepEqual(ren.next.ordinals, plan().ordinals, "the visits are as they were");
  assert.deepEqual(ren.next.agreement_stale.fields, ["auto_renew", "billing_mode"]);

  const fresh = plan({ agreement_status: "sent", ordinals: plan().ordinals.map((o) => ({ ...o, status: "unscheduled", completed_on: undefined })) });
  const st = edit(fresh, { start_on: "2027-01-05" });
  assert.equal(st.next.term.start_on, "2027-01-05");
  assert.equal(st.next.term.current_term_end, "2028-01-04");
  assert.deepEqual(st.next.ordinals.map((o) => o.target_month), ["2027-01", "2027-07"]);
  assert.equal(st.stale, false, "no signed agreement to mark");
  assert.equal(st.next.agreement_stale, undefined);
  assert.throws(() => edit(plan(), { start_on: "2027-01-05" }), /already booked or done/);
  assert.throws(() => edit(plan({ kind: "lights_annual", catalog_key: "lights_annual" }), { frequency: { interval: "month", count: 3 } }), /lights plan keeps its seasons/);
  assert.throws(() => edit(plan({ status: "paused" }), { frequency: { interval: "month", count: 3 } }), /Resume it first/);
  assert.throws(() => edit(plan({ status: "cancelled" }), { billing_mode: "after_visit" }), /cancelled plan can't change/);
  assert.equal(edit(plan({ status: "paused" }), { billing_mode: "after_visit" }).next.billing.mode, "after_visit", "billing changes on a paused plan");
  assert.throws(() => edit(plan({ term: { ...plan().term, current_term_n: 2 } }), { term_months: 24 }), /first term is over/);
  assert.equal(edit(plan(), { frequency: { interval: "month", count: 6 } }).fields.length, 0, "the same value is no change");
  assert.throws(() => edit(plan(), { discounts: [] }), /before the agreement is signed/);
  const disc = edit(plan({ status: "pending", agreement_status: "none", ordinals: fresh.ordinals }), { discounts: [] });
  assert.equal(disc.next.sale_value_cents, 2 * 29500, "a pending plan's discount comes off");
});

test("a visit the plan's lines don't cover is refused (Quarterly's interior and exterior visits)", () => {
  const q = plan({ catalog_key: "quarterly", frequency: { interval: "month", count: 3 }, visits_per_year: 4, lines: [
    { id: "ln_e", title: "Exterior", qty_milli: 1000, unit_cents: 29500, total_cents: 29500, scope: { type: "specific", visits: [1, 3, 4] } },
    { id: "ln_i", title: "Interior", qty_milli: 1000, unit_cents: 16000, total_cents: 16000, scope: { type: "specific", visits: [2] } }],
  ordinals: [1, 2, 3, 4].map((n) => ({ term: 1, n, k: n, target_month: M.addMonthsYm("2026-11", 3 * (n - 1)), status: n === 1 ? "completed" : "unscheduled", gen: 0 })) });
  assert.throws(() => edit(q, { frequency: { interval: "month", count: 1 } }), /Visit 5 would have nothing on it/);
});

test("API: preview, the edit as a run (old jobs cancelled, new jobs made, the done visit untouched), the agreement, who may", async () => {
  const { t, owner, admin, tech } = await setup();
  try {
    const { plan: p0 } = await staffPlan(t, owner, { catalog_key: "biannual", lines: [EXT()], discounts: [{ name: "Biannual plan discount", type: "fixed", value: 5000, scope: { type: "all" } }] });
    await t.api(`/plans/${p0.id}/activate`, { method: "POST", as: owner, body: { override_reason: "Paper copy" } }).then((r) => finishRun(t, r.body.data.run_id));
    let p = await planOf(p0.id);
    assert.equal(p.ordinals.length, 2);
    const [job1, job2] = p.ordinals.map((o) => o.job_id);
    assert.ok(job1 && job2, "a job per visit");
    // visit 1 done (as the job listener would leave it)
    await scope(() => store.updateRecord("plan", p.id, (x) => ({ ...x, ordinals: x.ordinals.map((o) => (o.n === 1 ? { ...o, status: "completed", completed_on: "2026-11-17" } : o)) }), AS(owner)));
    // an unsigned agreement is out
    const ag = await t.api(`/plans/${p.id}/send-agreement`, { method: "POST", as: owner, body: { channels: ["sms"] } });
    assert.equal(ag.status, 200, JSON.stringify(ag.body));
    const agId = ag.body.data.agreement.id;

    const changes = { frequency: { interval: "month", count: 3 }, billing_mode: "after_visit" };
    // techs can't, nonsense is refused
    assert.equal((await t.api(`/plans/${p.id}/edit`, { method: "POST", as: tech, body: { changes } })).status, 403);
    assert.equal((await t.api(`/plans/${p.id}/edit`, { method: "POST", as: owner, body: { changes: { frequency: { interval: "month", count: 5 } } } })).status, 400);
    assert.equal((await t.api(`/plans/${p.id}/edit`, { method: "POST", as: owner, body: { changes: { name: "x" } } })).status, 400);
    assert.equal((await t.api(`/plans/${p.id}/edit`, { method: "POST", as: owner, body: { changes: { term_months: 6 } } })).status, 400);
    assert.equal((await t.api(`/plans/${p.id}/edit`, { method: "POST", as: owner, ifMatch: '"stale"', body: { changes } })).status, 409, "a stale version");

    const pv = await t.api(`/plans/${p.id}/edit`, { method: "POST", as: admin, body: { changes, preview: true } });
    assert.equal(pv.status, 200, JSON.stringify(pv.body));
    const sum = pv.body.data.summary;
    assert.deepEqual(sum.fields.map((f) => f.field), ["frequency", "billing_mode"]);
    assert.deepEqual(sum.visits, { kept: 1, removed: 1, added: 3, months: ["2027-02", "2027-05", "2027-08"] });
    assert.equal(sum.cancel_jobs, 1);
    assert.equal(sum.agreement, "replaced", "the unsigned agreement is replaced");
    assert.equal((await planOf(p.id)).wv, (await planOf(p.id)).wv, "a preview writes nothing");
    assert.equal((await planOf(p.id)).frequency.count, 6);

    const r = await t.api(`/plans/${p.id}/edit`, { method: "POST", as: admin, body: { changes } });
    assert.equal(r.status, 202, JSON.stringify(r.body));
    const again = await t.api(`/plans/${p.id}/edit`, { method: "POST", as: admin, body: { changes } });
    assert.equal(again.body.data.run_id, r.body.data.run_id, "a double tap is one run");
    const run = await finishRun(t, r.body.data.run_id);
    assert.equal(run.status, "done", JSON.stringify(run));
    p = await planOf(p.id);
    assert.equal(p.frequency.count, 3);
    assert.equal(p.billing.mode, "after_visit");
    assert.equal(p.ordinals.length, 4);
    assert.equal(p.ordinals[0].job_id, job1, "the done visit keeps its job");
    assert.ok(p.ordinals.slice(1).every((o) => o.job_id && o.job_id !== job2), "each new visit got its own new job");
    assert.equal((await recOf("job", job2)).status, "cancelled", "the old visit's job is cancelled");
    assert.notEqual((await recOf("job", job1)).status, "cancelled");
    assert.equal((await recOf("agreement", agId)).status, "void", "the unsigned agreement says the old terms: voided");
    assert.equal(p.agreement_status, "none");
    assert.equal(p.agreement_stale, undefined);
    assert.equal(p.last_change.action, "edit");
    // the op ran once: running the worker again changes nothing
    const wv = p.wv;
    await drain(t, 2);
    assert.equal((await planOf(p.id)).wv, wv);
    assert.equal(t.stores.data.keys("rec/job/").map((k) => t.stores.data.json(k)).filter((j) => j.plan_id === p.id && j.status !== "cancelled").length, 4);
    // audit: the store's event for the change
    assert.ok(t.stores.data.keys(`evt/plan/${p.id}/`).length >= 3, "an audit event per write");
  } finally { t.done(); }
});

test("API: a signed agreement stays; the plan needs a new one; a new one can be made and sent; signing it clears the mark", async () => {
  const { t, owner } = await setup();
  try {
    const { plan: p0 } = await staffPlan(t, owner, { catalog_key: "biannual", lines: [EXT()] });
    const a = await scope(() => AG.agreementForPlan(p0.id, {}, { write: () => AS(owner) }));
    await scope(() => store.updateRecord("agreement", a.data.id, (x) => ({ ...x, status: "signed", signed_at: "2026-11-17T15:00:00.000Z", signature: { name_typed: "Pat Sample", method: "in_person", at: "2026-11-17T15:00:00.000Z" } }), AS(owner)));
    await scope(() => AG.notePlanAgreement(p0.id, { ...a.data, status: "signed" }, { write: () => AS(owner) }));
    assert.equal((await planOf(p0.id)).agreement_status, "signed");
    const r = await t.api(`/plans/${p0.id}/edit`, { method: "POST", as: owner, body: { changes: { term_months: 24 } } });
    assert.equal(r.body.data.summary.agreement, "needs_new");
    await finishRun(t, r.body.data.run_id);
    let p = await planOf(p0.id);
    assert.equal(p.term.initial_months, 24);
    assert.deepEqual(p.agreement_stale.fields, ["term_months"]);
    assert.equal(p.agreement_stale.agreement_id, a.data.id);
    assert.equal((await recOf("agreement", a.data.id)).status, "signed", "the signed one is never edited");
    // notes the next agreement carries
    const g = await t.api(`/plans/${p0.id}`, { as: owner });
    assert.equal((await t.api(`/plans/${p0.id}`, { method: "PATCH", as: owner, ifMatch: g.headers.get("etag"), body: { agreement_notes: "Gate code changes in spring.", notes: "Dog in the yard." } })).status, 200);
    const sent = await t.api(`/plans/${p0.id}/send-agreement`, { method: "POST", as: owner, body: { channels: ["sms"] } });
    assert.equal(sent.status, 200, JSON.stringify(sent.body));
    const fresh = sent.body.data.agreement.id;
    assert.notEqual(fresh, a.data.id, "a new agreement");
    const body = (await recOf("agreement", fresh)).body_rendered;
    assert.match(body, /Gate code changes in spring\./);
    assert.match(body, /24/, "the new length");
    p = await planOf(p0.id);
    assert.equal(p.notes, "Dog in the yard.");
    assert.ok(p.agreement_stale, "still needs the new one signed");
    await scope(() => store.updateRecord("agreement", fresh, (x) => ({ ...x, status: "signed", signed_at: "2026-11-18T15:00:00.000Z" }), AS(owner)));
    const signedNew = await recOf("agreement", fresh);
    await scope(() => AG.notePlanAgreement(p0.id, signedNew, { write: () => AS(owner) }));
    p = await planOf(p0.id);
    assert.equal(p.agreement_stale, undefined);
    assert.equal(p.agreement_id, fresh);
  } finally { t.done(); }
});

test("API: an imported plan Rotor is in charge of: a would-update row, nothing changes", async () => {
  const { t, owner } = await setup();
  try {
    const ip = await importedPlan(await importedCustomer());
    const before = await planOf(ip.id);
    const r = await t.api(`/plans/${ip.id}/edit`, { method: "POST", as: owner, body: { changes: { frequency: { interval: "month", count: 3 }, billing_mode: "after_visit" } } });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(r.body.data.would, true);
    assert.equal(r.body.data.run_id, undefined);
    const after = await planOf(ip.id);
    assert.equal(after.wv, before.wv, "the plan is unchanged");
    assert.ok(alog(t).some((k) => k.includes("plans.edit") && k.includes(ip.id) && k.endsWith("would-update")), "a would-update row");
  } finally { t.done(); }
});
