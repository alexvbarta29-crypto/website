// Quotes, Plans and Scheduling together, with no fakes for Plans or
// Scheduling: a customer approves a quote's plan option on their quote page
// with one signature; the conversion runs through the REAL
// plans.fromQuoteOption and the REAL work.createJobs: one plan, its
// ordinals, a job per visit (the first visit's job in the to-book tray), the
// agreement signed with the text the customer saw; a retried conversion
// creates nothing twice. Money is not built yet, so it is hidden.
// Synthetic data only.
import { test } from "node:test";
import assert from "node:assert/strict";
import { setup, sentQuote, portalCookie, approveBody, finishRun, quoteOf, quarterly, oneTime, PJSON, scope } from "../quotes/fixtures.mjs";
import { fakeServices } from "../../helpers/crm-fixtures.mjs";

const AG = await import("../../../netlify/lib/crm/modules/plans/agreements.mjs");
const store = await import("../../../netlify/lib/crm-store.mjs");
const AUTO = { by: "system:test", origin: "worker", actor_kind: "automation", requestId: "test", mode: { system_of_record: "rotor", paused: false } };

test("a customer's approval of a plan option makes one real plan with its visits' jobs, signed, once", async () => {
  const { t, owner } = await setup();
  const off = fakeServices({ "money.createDepositInvoice": null });
  try {
    await scope(() => AG.seedAgreementTemplates(AUTO));
    await scope(() => AG.approveTemplate(AG.seedTemplateId("quarterly"), { write: () => ({ by: owner.id, origin: "api", actor_kind: "user", requestId: "t" }) }));
    const { quote, version } = await sentQuote(t, owner, { options: [oneTime({ recommended: false }), quarterly({ recommended: true })] });
    const opt = version.options.find((o) => o.kind === "plan");
    const shown = version.plan_agreements[opt.id];
    assert.ok(shown && shown.body_rendered.includes("Quarterly plan"), "the plan's approved agreement text is frozen with the version");
    const cookie = await portalCookie(t, quote);
    const r = await t.portal(`/api/portal/quotes/${quote.id}/approve`, { method: "POST", cookie, headers: PJSON, body: approveBody(version, opt.id) });
    assert.ok([200, 202].includes(r.status), JSON.stringify(r.body));
    const run = await finishRun(t, r.body.data.run_id, 10);
    assert.equal(run.status, "done", JSON.stringify(run));
    assert.equal(run.result.status, "converted", JSON.stringify(run.result));
    const q = await quoteOf(quote.id);
    assert.equal(q.status, "converted");
    const plans = t.stores.data.keys("rec/plan/").map((k) => t.stores.data.json(k));
    assert.equal(plans.length, 1, "exactly one plan");
    const plan = plans[0];
    assert.equal(q.converted_to.plan_id, plan.id);
    assert.equal(plan.quote_id, quote.id);
    assert.equal(plan.quote_version_id, version.id);
    assert.equal(plan.status, "active", "signed with the quote, no card asked before Money");
    assert.deepEqual(plan.ordinals.map((o) => o.n), [1, 2, 3, 4]);
    const jobs = t.stores.data.keys("rec/job/").map((k) => t.stores.data.json(k));
    assert.equal(jobs.length, 4, "a job per visit");
    assert.deepEqual(plan.ordinals.map((o) => o.job_id).sort(), jobs.map((j) => j.id).sort());
    const first = jobs.find((j) => j.id === plan.ordinals[0].job_id);
    assert.equal(first.status, "unscheduled", "the first visit's job is in the to-book tray");
    assert.equal(first.kind, "standard");
    assert.equal(first.plan_id, plan.id);
    assert.deepEqual(first.plan_ordinal, { term: 1, n: 1 });
    assert.equal(first.totals.total_cents, q.approval.totals.per_visit_cents[0], "the first visit's price is the approved one");
    assert.equal(jobs.find((j) => j.id === plan.ordinals[1].job_id).totals.total_cents, q.approval.totals.per_visit_cents[1], "visit 2 (interior) too");
    // the agreement: signed with the quote, the same text hash as shown
    const ag = t.stores.data.json(`rec/agreement/${plan.agreement_id}`);
    assert.equal(ag.status, "signed");
    assert.equal(ag.source, "quote_approval");
    assert.equal(ag.body_sha256, shown.body_sha256);
    assert.equal(ag.signature.drawn_file_id, q.approval.signature_id);
    // a retried conversion creates nothing twice
    await t.api(`/quotes/${quote.id}/convert`, { method: "POST", as: owner, body: {} });
    for (let i = 0; i < 4; i++) await t.runWorker({ lane: "fast" });
    assert.equal(t.stores.data.keys("rec/plan/").length, 1, "still one plan");
    assert.equal(t.stores.data.keys("rec/job/").length, 4, "still four jobs");
    assert.equal(t.stores.data.keys("rec/agreement/").length, 1, "one agreement");
    const again = await scope(() => store.getRecord("plan", plan.id));
    assert.deepEqual(again.data.ordinals.map((o) => o.job_id), plan.ordinals.map((o) => o.job_id));
  } finally { off(); t.done(); }
});
