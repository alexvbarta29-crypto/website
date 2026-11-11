// M3b acceptance: every transition of the plan state machine (design §5.4
// "Plan state machine", §11.4 "plan-machine.test.mjs"), first as pure
// arithmetic, then through the API, the worker and the listeners with the
// real Scheduling module (jobs per ordinal, cancelled jobs, re-spacing).
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  setup, staffPlan, planOf, recOf, finishRun, drain, queued, outbox, pin, scope, store, M, PL, AG, WORK, fakeServices, AS, customer,
} from "./fixtures.mjs";

const plan0 = (o = {}) => ({
  status: "active", kind: "recurring", name: "Quarterly plan", frequency: { interval: "month", count: 3 }, visits_per_year: 4,
  lines: [{ id: "a", title: "Ext", total_cents: 29500, scope: { type: "specific", visits: [1, 3, 4] } }, { id: "b", title: "Int", total_cents: 16000, scope: { type: "specific", visits: [2] } }],
  discounts: [{ id: "d", name: "Plan", type: "fixed", value: 10000, scope: { type: "all" } }],
  term: M.firstTerm({ start_on: "2026-11-17", initial_months: 12, renews_every_months: 3 }),
  policy: { early_cancel_clawback_cents: 10000, notice_days: 7, late_cancel_fee_cents: 5000 }, billing: { autopay: true },
  ordinals: M.termOrdinals({ frequency: { interval: "month", count: 3 }, visits_per_year: 4 }, { term: 1, start: "2026-11-17", months: 12 }), ...o,
});
const activity = (t, cid, kind) => t.stores.data.keys(`rel/contact-activity/${cid}/`).some((k) => k.includes(`--${kind}--`));
const ctx = { today: "2026-11-17", at: "2026-11-17T15:00:00.000Z", by: "us_00000000000000000001" };

test("the table: allowed events move the status, every other pair is refused", () => {
  const allowed = { pending: ["activate", "cancel"], active: ["schedule", "skip", "pause", "cancel", "renewal_notice", "renew", "expire", "change_price"], paused: ["resume", "cancel", "schedule"], cancelling: ["cancel_effective", "withdraw", "schedule"], cancelled: [], expired: ["renew"] };
  const all = ["activate", "schedule", "skip", "pause", "resume", "cancel", "cancel_effective", "withdraw", "renewal_notice", "renew", "expire", "change_price"];
  for (const [from, ok] of Object.entries(allowed)) {
    for (const ev of all) {
      if (ok.includes(ev)) assert.ok(M.planNext(from, ev), `${from} + ${ev}`);
      else assert.throws(() => M.planNext(from, ev), (e) => e.code === "transition", `${from} + ${ev} is refused`);
    }
  }
  assert.equal(M.planNext("pending", "activate"), "active");
  assert.equal(M.planNext("active", "pause"), "paused");
  assert.equal(M.planNext("paused", "resume"), "active");
  assert.equal(M.planNext("active", "cancel"), "cancelling");
  assert.equal(M.planNext("cancelling", "cancel_effective"), "cancelled");
  assert.equal(M.planNext("active", "expire"), "expired");
  assert.equal(M.planNext("pending", "cancel"), "cancelled");
});

test("terms, ordinals and prices: quarterly visit 2 is the interior one; a renewal term continues the cycle", () => {
  const p = plan0();
  assert.deepEqual(p.ordinals.map((o) => o.target_month), ["2026-11", "2027-02", "2027-05", "2027-08"]);
  assert.equal(p.term.initial_end_on, "2027-11-16");
  assert.deepEqual(p.ordinals.map((o) => M.ordinalTotals(p, o).total_cents), [19500, 6000, 19500, 19500]);
  assert.equal(M.saleValue(p), 64500);
  assert.deepEqual(M.ordinalLines(p, p.ordinals[1]).map((l) => [l.id, l.scope.type]), [["b", "all"]]);
  const nt = M.nextTerm(p);
  assert.equal(nt.term.current_term_n, 2);
  assert.equal(nt.term.current_term_start, "2027-11-17");
  assert.equal(nt.term.current_term_end, "2028-02-16", "renews every 3 months");
  assert.equal(nt.ordinals.length, 1);
  assert.equal(nt.ordinals[0].k, 5);
  const p2 = { ...p, ordinals: [...p.ordinals, ...nt.ordinals] };
  assert.equal(M.coverPos(p2, nt.ordinals[0]), 1, "visit 5 is visit 1 of the next year (exterior)");
  assert.equal(M.coverPos(p2, { term: 3, n: 1, k: 6 }), 2, "visit 6 is the interior one again");
  // "initial" covers only the plan's first visit, "after_initial" the rest
  assert.equal(M.covers({ type: "initial" }, p2, { term: 2, n: 1, k: 5 }), false);
  assert.equal(M.covers({ type: "after_initial" }, p2, { term: 1, n: 1, k: 1 }), false);
  // month arithmetic at month ends
  assert.equal(M.addMonthsDate("2027-01-31", 1), "2027-02-28");
  assert.equal(M.termEnd("2026-02-29".replace("29", "28"), 12), "2027-02-27");
});

test("pure transitions: re-spacing, pause and resume shift, skip, cancel inside and after the initial term, renew, expire", () => {
  const p = plan0();
  // ordinal 1 booked on Dec 3: the later unscheduled ones are re-spaced from that date
  const rs = M.respace(p, p.ordinals[0], "2026-12-03");
  assert.deepEqual(rs.map((o) => o.target_month), ["2026-11", "2027-03", "2027-06", "2027-09"]);
  // pause from Jan 5 to Mar 1: visit 2 (Feb) comes off; resume Mar 20 shifts the unscheduled visits by 2 months
  const withJobs = { ...p, ordinals: p.ordinals.map((o, i) => ({ ...o, job_id: `jb_0000000000000000000${i + 1}`, ...(i === 1 ? { status: "scheduled", visit_date: "2027-02-10" } : {}) })) };
  const pa = M.applyAction(withJobs, "pause", { from: "2027-01-05", until: "2027-03-01", reason: "Snowbirds" }, { ...ctx, today: "2027-01-05" });
  assert.equal(pa.next.status, "paused");
  assert.deepEqual(pa.to_cancel, ["jb_00000000000000000002"], "the booked visit's job");
  assert.equal(pa.notice, true, "the customer is told a booked visit came off");
  assert.equal(pa.next.ordinals[1].status, "unscheduled");
  assert.equal(pa.next.ordinals[1].job_id, undefined);
  assert.equal(pa.next.ordinals[1].gen, 1);
  assert.equal(pa.event, "plan.paused");
  const re = M.applyAction(pa.next, "resume", {}, { ...ctx, today: "2027-03-20" });
  assert.equal(re.next.status, "active");
  assert.deepEqual(re.next.ordinals.map((o) => o.target_month), ["2026-11", "2027-04", "2027-07", "2027-10"], "shifted by the paused length");
  assert.equal(re.next.pause, undefined);
  assert.equal(re.next.pauses.length, 1);
  // skip: no credit, the job cancelled
  const sk = M.applyAction(withJobs, "skip", { term: 1, n: 3 }, ctx);
  assert.equal(sk.next.ordinals[2].status, "skipped");
  assert.deepEqual(sk.to_cancel, ["jb_00000000000000000003"]);
  assert.equal(sk.event, null);
  assert.throws(() => M.applyAction(sk.next, "skip", { term: 1, n: 3 }, ctx), /still to come/);
  // cancel inside the initial term: 7 days' notice, the first visit's discount back once it was done
  const done1 = { ...p, ordinals: p.ordinals.map((o, i) => (i === 0 ? { ...o, status: "completed" } : o)) };
  const ci = M.applyAction(done1, "cancel", { reason: "moving" }, { ...ctx, today: "2027-01-10" });
  assert.equal(ci.next.status, "cancelling");
  assert.equal(ci.next.cancel.effective_on, "2027-01-17");
  assert.equal(ci.next.cancel.clawback_cents, 10000);
  assert.equal(ci.next.cancel.clawback_state, "to_bill", "a draft for the owner, never charged by itself");
  assert.equal(M.applyAction(p, "cancel", { reason: "price" }, { ...ctx, today: "2026-11-20" }).next.cancel.clawback_cents, 0, "first visit not done: nothing back");
  // cancel after the initial term: at the end of the current renewal term
  const late = { ...p, term: { ...p.term, current_term_n: 2, current_term_start: "2027-11-17", current_term_end: "2028-02-16" } };
  const ca = M.applyAction(late, "cancel", { reason: "price" }, { ...ctx, today: "2027-12-01" });
  assert.equal(ca.next.cancel.effective_on, "2028-02-16");
  assert.equal(ca.next.cancel.clawback_cents, 0);
  // cancelling → cancelled: open visits stop, autopay off
  const fin = M.applyAction(ci.next, "cancel_effective", {}, { ...ctx, today: "2027-01-17" });
  assert.equal(fin.next.status, "cancelled");
  assert.ok(fin.next.ordinals.filter((o) => o.status !== "completed").every((o) => o.status === "cancelled"));
  assert.equal(fin.next.billing.autopay, false);
  assert.equal(fin.event, "plan.cancelled");
  // a pending plan cancels at once
  assert.equal(M.applyAction({ ...p, status: "pending" }, "cancel", {}, ctx).next.status, "cancelled");
  // term end: renew (auto_renew) or expire
  assert.throws(() => M.applyAction(p, "renew", {}, ctx), /hasn't ended/);
  const rn = M.applyAction(p, "renew", {}, { ...ctx, today: "2027-11-17" });
  assert.equal(rn.next.term.current_term_n, 2);
  assert.equal(rn.next.ordinals.length, 5);
  assert.equal(rn.event, "plan.renewed");
  const ex = M.applyAction({ ...p, term: { ...p.term, auto_renew: false } }, "expire", {}, { ...ctx, today: "2027-11-17" });
  assert.equal(ex.next.status, "expired");
  // a price change: 30 days' notice and never inside the locked period; applied at the renewal on or after it
  assert.throws(() => M.applyAction(p, "change_price", { effective_on: "2026-12-01", new_lines: [{ id: "x" }] }, ctx), /30 days/);
  assert.throws(() => M.applyAction(p, "change_price", { effective_on: "2027-06-01", new_lines: [{ id: "x" }] }, ctx), /locked/);
  const pc = M.applyAction(p, "change_price", { effective_on: "2027-11-17", new_lines: [{ id: "n", title: "Ext", total_cents: 31500, scope: { type: "all" } }] }, ctx);
  const rn2 = M.applyAction(pc.next, "renew", {}, { ...ctx, today: "2027-11-17" });
  assert.equal(rn2.next.lines[0].id, "n", "the new price from the renewal on");
  assert.equal(rn2.next.renewal.price_change, undefined);
});

test("through the API and the worker: create (pending, jobs per visit) → signed (active) → a booked visit re-spaces → pause (job cancelled, customer told) → resume (jobs again) → skip → cancel → effective", async () => {
  const { t, owner, tech } = await setup();
  try {
    const { plan, contact } = await staffPlan(t, owner);
    assert.equal(plan.status, "pending");
    assert.deepEqual(plan.pending_reasons, ["signature"]);
    assert.equal(plan.ordinals.length, 4);
    const jobs = await Promise.all(plan.ordinals.map((o) => recOf("job", o.job_id)));
    assert.ok(jobs.every((j) => j && j.status === "unscheduled" && j.plan_id === plan.id), "one unscheduled job per visit");
    assert.deepEqual(jobs.map((j) => j.target_month), ["2026-11", "2027-02", "2027-05", "2027-08"]);
    assert.deepEqual(jobs.map((j) => j.totals.total_cents), [19500, 6000, 19500, 19500], "each job carries its visit's lines and discount");
    assert.equal(jobs[0].kind, "standard");
    // activate refuses while unsigned (unless an owner overrides with a reason)
    assert.equal((await t.api(`/plans/${plan.id}/activate`, { method: "POST", as: owner, body: {} })).status, 409);
    // pending → active: the customer signs the agreement
    const sent = await t.api(`/plans/${plan.id}/send-agreement`, { method: "POST", as: owner, body: { channels: ["sms"] } });
    assert.equal(sent.status, 200, JSON.stringify(sent.body));
    const ag = sent.body.data.agreement;
    await scope(() => AG.signAgreement(ag.id, { body_sha256: ag.body_sha256, name_typed: "Pat Sample", agree: true }, { method: "portal", contact_id: contact.id }, { write: () => ({ by: "portal", origin: "portal", actor_kind: "portal", requestId: "t" }) }, { onSigned: PL.activateIfReady }));
    let p = await planOf(plan.id);
    assert.equal(p.status, "active");
    assert.equal(p.agreement_status, "signed");
    assert.ok(queued(t, "plan.activated").length >= 1, "plan.activated for contacts and reports");
    await drain(t, 3);
    const stats = (await recOf("contact_stats", contact.id)).plans;
    assert.deepEqual(stats.active_plan_ids, [plan.id], "the contact's plans stats part");
    // active, ordinal 1 scheduled: the later unscheduled ones are re-spaced from the date
    await scope(() => WORK.createVisit({ job_id: p.ordinals[0].job_id, date: "2026-12-03", start: "09:00", end: "11:00", assignee_ids: [tech.id] }, { write: () => AS(owner) }));
    await drain(t, 3);
    p = await planOf(plan.id);
    assert.equal(p.ordinals[0].status, "scheduled");
    assert.equal(p.ordinals[0].visit_date, "2026-12-03");
    assert.deepEqual(p.ordinals.map((o) => o.target_month), ["2026-11", "2027-03", "2027-06", "2027-09"]);
    assert.equal((await recOf("job", p.ordinals[1].job_id)).target_month, "2027-03", "the job's due month follows");
    // active → paused: the booked visit comes off (its job cancelled) and the customer is told (the Outbox)
    const pause = await t.api(`/plans/${plan.id}/pause`, { method: "POST", as: owner, body: { from: "2026-11-17", until: "2027-01-31", reason: "Away for the winter" } });
    assert.equal(pause.status, 202, JSON.stringify(pause.body));
    assert.equal((await finishRun(t, pause.body.data.run_id)).status, "done");
    p = await planOf(plan.id);
    assert.equal(p.status, "paused");
    const off = await recOf("job", plan.ordinals[0].job_id);
    assert.equal(off.status, "cancelled");
    assert.equal(p.ordinals[0].job_id, undefined);
    assert.ok(p.cancelled_job_ids.includes(off.id));
    assert.ok(outbox(t).some((o) => o.template_key === "plan_paused"), "the pause notice (dry-run)");
    // a double tap on the same version is the same run
    // paused → active (the until date reached: plans.due at 06:00): target months shift, the visit gets a new job
    pin("2027-02-02T13:00:00Z");
    await drain(t, 3);
    const owner2 = await t.user("owner");          // the first session ran out over the winter
    p = await planOf(plan.id);
    assert.equal(p.status, "active", "the pause ended on its own");
    assert.equal(p.ordinals[0].target_month, "2027-02", "shifted by the paused months (Nov → Feb)");
    assert.ok(p.ordinals[0].job_id && p.ordinals[0].job_id !== plan.ordinals[0].job_id, "a fresh job for the visit");
    assert.equal(p.ordinals[0].gen, 1);
    // skip a visit: its job cancelled, no credit
    const skip = await t.api(`/plans/${plan.id}/skip`, { method: "POST", as: owner2, body: { term: 1, n: 3 } });
    assert.equal(skip.status, 202, JSON.stringify(skip.body));
    assert.equal((await finishRun(t, skip.body.data.run_id)).status, "done");
    p = await planOf(plan.id);
    assert.equal(p.ordinals[2].status, "skipped");
    assert.equal((await recOf("job", p.ordinals[2].job_id)).status, "cancelled");
    // cancel: the calculator first, then cancelling, then effective (plans.due)
    const q = await t.api(`/plans/${plan.id}/cancel-quote`, { as: owner2 });
    assert.equal(q.body.data.effective_on, "2027-02-09");
    assert.equal(q.body.data.inside_initial_term, true);
    const tech2 = await t.user("tech");
    assert.equal((await t.api(`/plans/${plan.id}/cancel`, { method: "POST", as: tech2, body: { reason: "price" } })).status, 403, "plans:cancel");
    const cancel = await t.api(`/plans/${plan.id}/cancel`, { method: "POST", as: owner2, body: { reason: "price" } });
    assert.equal((await finishRun(t, cancel.body.data.run_id)).status, "done");
    p = await planOf(plan.id);
    assert.equal(p.status, "cancelling");
    pin("2027-02-09T13:00:00Z");
    await drain(t, 3);
    p = await planOf(plan.id);
    assert.equal(p.status, "cancelled");
    assert.equal(p.billing.autopay, false);
    assert.ok(p.ordinals.filter((o) => o.status !== "skipped").every((o) => o.status === "cancelled"));
    assert.ok(activity(t, contact.id, "plan.cancelled"), "plan.cancelled (on the timeline too)");
    for (const o of p.ordinals) if (o.job_id) assert.equal((await recOf("job", o.job_id)).status, "cancelled");
    await drain(t, 2);
    assert.deepEqual((await recOf("contact_stats", contact.id)).plans.active_plan_ids, [], "no live plan left");
  } finally { t.done(); }
});

test("a completed visit completes its ordinal; the term ends: renew (new ordinals and jobs) or expire; the renewal notice 30 days before", async () => {
  const { t, owner, tech } = await setup();
  try {
    const { plan } = await staffPlan(t, owner, { catalog_key: "biannual", lines: [{ title: "Exterior Window Cleaning", qty_milli: 1000, unit_cents: 29500 }], discounts: [{ name: "Biannual plan discount", type: "fixed", value: 5000 }] });
    assert.equal(plan.ordinals.length, 2);
    await t.api(`/plans/${plan.id}/activate`, { method: "POST", as: owner, body: { override_reason: "Signed on paper" } }).then((r) => finishRun(t, r.body.data.run_id));
    let p = await planOf(plan.id);
    assert.equal(p.status, "active");
    assert.equal(p.activated_override.reason, "Signed on paper");
    // the first visit done: ordinal completed
    const v = await scope(() => WORK.createVisit({ job_id: p.ordinals[0].job_id, date: "2026-11-18", start: "09:00", end: "11:00", assignee_ids: [tech.id] }, { write: () => AS(owner) }));
    await scope(() => WORK.completeJob(v.job.id, { write: () => AS(owner) }));
    await drain(t, 3);
    p = await planOf(plan.id);
    assert.equal(p.ordinals[0].status, "completed");
    assert.equal(p.ordinals[0].completed_on, "2026-11-17", "the day the job was marked done");
    // 30 days before the term ends: the renewal notice (10:00), once per term
    pin("2027-10-20T15:30:00Z");
    await drain(t, 3);
    assert.ok(outbox(t).some((o) => o.template_key === "plan_renewal_notice"), "the renewal notice (dry-run)");
    p = await planOf(plan.id);
    assert.equal(p.renewal.notice_term, 1);
    const n0 = outbox(t).filter((o) => o.template_key === "plan_renewal_notice").length;
    pin("2027-10-21T15:30:00Z");
    await drain(t, 2);
    assert.equal(outbox(t).filter((o) => o.template_key === "plan_renewal_notice").length, n0, "once per term");
    // the term ends: renews every 6 months, one more visit with its job
    pin("2027-11-17T13:00:00Z");
    await drain(t, 3);
    p = await planOf(plan.id);
    assert.equal(p.status, "active");
    assert.equal(p.term.current_term_n, 2);
    assert.equal(p.term.current_term_end, "2028-05-16");
    assert.equal(p.ordinals.length, 3);
    assert.ok(p.ordinals[2].job_id, "the new term's visit has its job");
    assert.ok(activity(t, plan.contact_id, "plan.renewed"));
    // not auto-renewing: expires at the end of the term
    const o2 = await t.user("owner");
    const pr = await t.api(`/plans/${plan.id}`, { method: "PATCH", as: o2, ifMatch: (await t.api(`/plans/${plan.id}`, { as: o2 })).headers.get("etag"), body: { auto_renew: false } });
    assert.equal(pr.status, 200, JSON.stringify(pr.body));
    pin("2028-05-17T13:00:00Z");
    await drain(t, 3);
    assert.equal((await planOf(plan.id)).status, "expired");
  } finally { t.done(); }
});

test("pending until the card too when Money says one is needed; card.saved activates it", async () => {
  const { t, owner } = await setup();
  let card = "none";
  const restore = fakeServices({ "money.cardStatus": async () => ({ status: card }) });
  try {
    const { plan, contact } = await staffPlan(t, owner, { autopay: true });
    assert.equal(plan.billing.card_required, true);
    const sent = await t.api(`/plans/${plan.id}/send-agreement`, { method: "POST", as: owner, body: { channels: ["sms"] } });
    const ag = sent.body.data.agreement;
    await scope(() => AG.signAgreement(ag.id, { body_sha256: ag.body_sha256, name_typed: "Pat Sample", agree: true }, { method: "portal", contact_id: contact.id }, { write: () => ({ by: "portal", origin: "portal", actor_kind: "portal", requestId: "t" }) }, { onSigned: PL.activateIfReady }));
    await drain(t, 3);
    let p = await planOf(plan.id);
    assert.equal(p.status, "pending");
    assert.deepEqual(p.pending_reasons, ["card"]);
    card = "on_file";
    await scope(async () => {
      const { emit } = await import("../../../netlify/lib/crm/core/events.mjs");
      await emit("card.saved", { id: contact.id, wv: 99, contact_id: contact.id, pm: "pm_example" }, AS(owner));
    });
    await drain(t, 3);
    p = await planOf(plan.id);
    assert.equal(p.status, "active", "card.saved activates the plan");
  } finally { restore(); t.done(); }
});

test("POST /plans refuses bad input; a double tap on an action is one run", async () => {
  const { t, owner } = await setup();
  try {
    const c = await customer(owner);
    assert.equal((await t.api("/plans", { method: "POST", as: owner, body: { contact_id: c.id, catalog_key: "nope", lines: [{ title: "x", unit_cents: 1 }] } })).status, 400);
    assert.equal((await t.api("/plans", { method: "POST", as: owner, body: { contact_id: c.id, catalog_key: "quarterly", lines: [] } })).status, 400);
    assert.equal((await t.api("/plans", { method: "POST", as: owner, body: { contact_id: c.id, catalog_key: "quarterly", term_months: 6, lines: [{ title: "x", unit_cents: 1 }] } })).status, 400);
    const { plan } = await staffPlan(t, owner, { contact: c, client_id: "c0ffee00-0000-4000-8000-000000000001" });
    const again = await t.api("/plans", { method: "POST", as: owner, body: { contact_id: c.id, catalog_key: "quarterly", lines: [{ title: "x", unit_cents: 1 }], client_id: "c0ffee00-0000-4000-8000-000000000001" } });
    assert.equal(again.body.data.plan_id, plan.id, "a retried create is the same plan");
    assert.equal((await t.api(`/plans/${plan.id}/skip`, { method: "POST", as: owner, body: { n: 4 } })).status, 409, "a pending plan's visits aren't skipped");
    const [a, b] = await Promise.all([
      t.api(`/plans/${plan.id}/activate`, { method: "POST", as: owner, body: { override_reason: "Paper copy signed" } }),
      t.api(`/plans/${plan.id}/activate`, { method: "POST", as: owner, body: { override_reason: "Paper copy signed" } }),
    ]);
    assert.equal(a.status, 202, JSON.stringify(a.body));
    assert.equal(a.body.data.run_id, b.body.data.run_id);
    assert.equal((await t.api(`/plans/${plan.id}/resume`, { method: "POST", as: owner, body: {} })).status, 409, "a pending plan can't resume");
    assert.equal((await finishRun(t, a.body.data.run_id)).status, "done");
    assert.equal((await t.api(`/plans/${plan.id}/skip`, { method: "POST", as: owner, body: { n: 9 } })).status, 400);
  } finally { t.done(); }
});
