// Review fixes (M3b): the agreement states the plan's real terms, to the cent.
//   - add-ons the customer ticks on the quote page are priced in the text
//     (each listed with its price), so the approval page, the signed text
//     and the plan's jobs agree (B2a, end to end through Quotes and Scheduling);
//   - a first-visit-only discount is said as one ("first visit $X, then $Y a
//     visit"), never as the yearly price, and "a visit" is never doubled (B2b);
//   - Custom has its own text; how often, renewal, billing and autopay come
//     from the plan; the clawback is the plan discount visit 1 really got,
//     in the calculator, the cancel and the text alike (B3);
//   - a draft with "Owner check" lines can't be approved; seed v2 upgrades
//     an untouched first draft and never an owner's edit.
import { test } from "node:test";
import assert from "node:assert/strict";
import { setup, customer, importedCustomer, importedPlan, staffPlan, planOf, recOf, finishRun, scope, store, AG, M, PL, CAT, AS, drain } from "./fixtures.mjs";

const Q = await import("../quotes/fixtures.mjs");
const { fakeServices } = await import("../../helpers/crm-fixtures.mjs");
const TX = await import("../../../netlify/lib/crm/modules/plans/texts.mjs");
const W8 = (u) => ({ write: () => AS(u) });
const priceLine = (body) => (body.match(/^Your price:[^\n]*/m) || [""])[0];
const company = { name: "Barta Window Washing", legal_name: "Barta Window Washing LLC", phone: "(763) 314-3400" };

test("B2a: add-ons picked on the quote page: the signed text prices them, and it, the approval and the jobs agree to the cent", async () => {
  const { t, owner } = await Q.setup();
  const off = fakeServices({ "money.createDepositInvoice": null });
  try {
    await Q.scope(() => AG.seedAgreementTemplates(Q.AUTOMATION));
    await Q.scope(async () => {
      const id = AG.seedTemplateId("quarterly");
      const g = await store.getRecord("agreement_template", id);
      await AG.patchTemplate(id, { body_md: AG.withoutOwnerChecks(g.data.body_md) }, { ...W8(owner), ifMatch: g.etag });
      await AG.approveTemplate(id, W8(owner));
    });
    const plan = Q.quarterly({ recommended: true });
    plan.lines.push(Q.line({ title: "Screen Cleaning", qty_milli: 20000, unit_cents: 500, category: "screens", optional: true, scope: { type: "specific", visits: [1, 3, 4] } }));
    const { quote, version } = await Q.sentQuote(t, owner, { options: [Q.oneTime({ recommended: false }), plan] });
    const opt = version.options.find((o) => o.kind === "plan");
    const addOn = opt.lines.find((l) => l.optional);
    const shown = version.plan_agreements[opt.id];
    assert.match(shown.body_rendered, /- Screen Cleaning, only if you add it on your quote: \$100\.00, visits 1, 3 and 4 of each year/);
    const cookie = await Q.portalCookie(t, quote);
    const r = await t.portal(`/api/portal/quotes/${quote.id}/approve`, { method: "POST", cookie, headers: Q.PJSON, body: Q.approveBody(version, opt.id, { selected_line_ids: [addOn.id] }) });
    assert.ok([200, 202].includes(r.status), JSON.stringify(r.body));
    const run = await Q.finishRun(t, r.body.data.run_id, 10);
    assert.equal(run.status, "done", JSON.stringify(run));
    const q = await Q.quoteOf(quote.id);
    const p = t.stores.data.json(`rec/plan/${q.converted_to.plan_id}`);
    const ag = t.stores.data.json(`rec/agreement/${p.agreement_id}`);
    assert.equal(ag.status, "signed");
    assert.equal(ag.body_sha256, shown.body_sha256, "the text they read is the text they signed");
    const jobs = p.ordinals.map((o) => t.stores.data.json(`rec/job/${o.job_id}`).totals.total_cents);
    assert.deepEqual(jobs, q.approval.totals.per_visit_cents, "the jobs bill what the approval page showed");
    // and the text: the base price plus the add-on they picked, visit by visit
    const base = { 1: 19500, 2: 6000, 3: 19500, 4: 19500 };
    assert.match(priceLine(ag.body_rendered), /\$195\.00 a visit \(visit 2 of each year: \$60\.00\)/);
    assert.deepEqual(jobs, [1, 2, 3, 4].map((n) => base[n] + ([1, 3, 4].includes(n) ? 10000 : 0)));
  } finally { off(); t.done(); }
});

test("B2b: a first-visit offer is said as one; the price-change text never says \"a visit\" twice", async () => {
  const { t, owner } = await setup();
  try {
    const c = await customer(owner);
    const opt = { id: "op_b", name: "Biannual plan", kind: "plan",
      plan: { catalog_key: "biannual", frequency: { interval: "month", count: 6 }, visits_per_year: 2, term_months: 12, billing: "barta_standard", autopay: true, auto_renew: true },
      lines: [{ id: "ln_e", title: "Exterior Window Cleaning", qty_milli: 1000, unit_cents: 29500, total_cents: 29500, scope: { type: "all" } }],
      discounts: [{ id: "dc_p", name: "Biannual plan discount", type: "fixed", value: 5000, scope: { type: "all" } }, { id: "dc_f", name: "First Time Customer", type: "fixed", value: 5000, scope: { type: "initial" } }] };
    const shown = await scope(() => AG.agreementForOption({ id: "qt_0000000000000000000q", contact_id: c.id }, { options: [opt] }, opt));
    assert.equal(priceLine(shown.body_rendered), "Your price: first visit $195.00, then $245.00 a visit, locked in for the first 12 months.");
    assert.match(shown.body_rendered, /- First Time Customer: \$50\.00 off your first visit/);
    assert.doesNotMatch(priceLine(shown.body_rendered), /a visit[^\n]*a visit/, "\"a visit\" once");
    // what the plan really charges: $195 then $245, renewals $245
    const cat = CAT.catalogWith({});
    let p = PL.buildPlan({ id: "pl_00000000000000000001", contact_id: c.id, catalog_key: "biannual", lines: opt.lines, discounts: opt.discounts }, cat, { start_on: "2026-11-17" });
    assert.deepEqual(p.ordinals.map((o) => M.ordinalTotals(p, o).total_cents), [19500, 24500]);
    p = M.applyAction({ ...p, status: "active" }, "renew", {}, { today: "2027-11-17", at: "x" }).next;
    p = M.applyAction(p, "renew", {}, { today: "2028-05-17", at: "x" }).next;
    assert.deepEqual(p.ordinals.filter((o) => o.term > 1).map((o) => M.ordinalTotals(p, o).total_cents), [24500, 24500], "every later visit is $245, as the text says");
    // the renewal's price-change notice: a later year's price, and the template no longer adds "a visit"
    assert.equal(AG.perVisitText(p, { later: true }), "$245.00 a visit");
    const tpl = TX.TEMPLATES.find((x) => x.key === "plan_price_change");
    assert.match(tpl.body, /price will be \{\{per_visit_price\}\}\. /);
  } finally { t.done(); }
});

test("B3: Custom has its own text; how often, renewal, billing, autopay and the clawback come from the plan", async () => {
  const { t, owner } = await setup();
  try {
    const c = await customer(owner);
    const opt = { id: "op_c", name: "Custom plan", kind: "plan",
      plan: { catalog_key: "custom", frequency: { interval: "month", count: 3 }, visits_per_year: 4, term_months: 24, billing: "barta_standard", autopay: false, auto_renew: true },
      lines: [{ id: "ln_e", title: "Exterior Window Cleaning", qty_milli: 1000, unit_cents: 29500, total_cents: 29500, scope: { type: "all" } }],
      discounts: [{ id: "dc", name: "Plan discount", type: "fixed", value: 7500, scope: { type: "all" } }] };
    const q = { id: "qt_0000000000000000000q", contact_id: c.id, contact_name: "Pat", property_id: c.primary_property_id, agreement: { require_card: false } };
    const shown = await scope(() => AG.agreementForOption(q, { options: [opt] }, opt));
    const body = shown.body_rendered;
    assert.match(body, /^## Custom plan service agreement/);
    assert.equal(shown.template_id, AG.seedTemplateId("custom"), "its own text, not the Biannual one");
    assert.match(body, /Window cleaning 4 times a year, about every 3 months/);
    assert.doesNotMatch(body, /twice a year|every 6 months/);
    assert.match(body, /After that it renews every 3 months until you cancel\./);
    assert.match(body, /you pay back the plan discount that visit got \(\$75\.00\)/, "the plan's own $75, not the catalog's $0");
    assert.match(body, /Your first visit is billed after it's done\. After that, each visit is billed on the 1st of the month it's scheduled in\. We send you an invoice each time\./, "autopay off: no card on file");
    assert.doesNotMatch(body, /Keep a card or bank account on file/);
    // the plan made from it renews as often as it comes, and claws back what it gave
    const p = PL.buildPlan({ id: "pl_00000000000000000002", contact_id: c.id, catalog_key: "custom", frequency: opt.plan.frequency, visits_per_year: 4, term_months: 24, lines: opt.lines, discounts: opt.discounts }, CAT.catalogWith({}), { start_on: "2026-11-17" });
    assert.equal(p.term.renews_every_months, 3);
    assert.equal(p.policy.early_cancel_clawback_cents, 7500);
    // an imported plan Rotor bills on the 1st: the Payments paragraph says so
    const ip = await importedPlan(await importedCustomer());
    assert.equal(ip.billing.mode, "first_of_month");
    const a = await scope(() => AG.agreementForPlan(ip.id, {}, W8(owner)));
    assert.match(a.data.body_rendered, /## Payments\n\n[^\n]*Each visit is (charged|billed) on the 1st of the month it's scheduled in\./);
    assert.doesNotMatch(a.data.body_rendered, /first visit is (charged|billed) after it's done/);
    // after_visit, autopay off
    assert.equal(AG.billingTerms({ billing: { mode: "after_visit", autopay: false } }), "Each visit is billed after it's done. We send you an invoice each time.");
    assert.equal(AG.billingTerms({ billing: { mode: "after_visit", autopay: true } }), "Keep a card or bank account on file for your plan. Each visit is charged after it's done.");
  } finally { t.done(); }
});

test("B3: the clawback is the plan discount visit 1 got: calculator, cancel and text agree", async () => {
  const cat = CAT.catalogWith({});
  const EXT = { id: "ln_e", title: "Exterior", qty_milli: 1000, unit_cents: 29500, total_cents: 29500, scope: { type: "all" } };
  const mk = (key, discount, start = "2026-11-17", extra = []) => PL.buildPlan({ id: "pl_00000000000000000001", contact_id: "ct_00000000000000000001", catalog_key: key, lines: [EXT], discounts: [{ id: "d", name: "Plan discount", type: "fixed", value: discount, scope: { type: "all" } }, ...extra] }, cat, { start_on: start });
  const done1 = (p) => ({ ...p, status: "active", ordinals: p.ordinals.map((o) => (o.k === 1 ? { ...o, status: "completed", completed_on: "2026-11-20" } : o)) });
  // the worked cases still hold
  assert.equal(M.cancelQuote(done1(mk("quarterly", 10000)), "2027-01-10").clawback_cents, 10000);
  assert.equal(M.cancelQuote({ ...mk("quarterly", 10000), status: "active" }, "2026-11-18").clawback_cents, 0, "visit 1 not done: nothing");
  assert.equal(M.cancelQuote(done1(mk("monthly", 15000)), "2027-02-01").clawback_cents, 15000);
  // sold with $80 off: $80 back, and the text says $80
  const q80 = done1(mk("quarterly", 8000));
  assert.equal(M.cancelQuote(q80, "2027-01-10").clawback_cents, 8000);
  assert.equal(AG.agreementVars(q80, { contact: {}, company, catalog: cat }).clawback_amount, "$80.00");
  const cancelled = M.applyAction(q80, "cancel", { reason: "price" }, { today: "2027-01-10", at: "x", by: "u" }).next;
  assert.equal(cancelled.cancel.clawback_cents, 8000);
  // Custom with $75 off: $75 back (the catalog said 0)
  assert.equal(M.cancelQuote(done1(mk("custom", 7500)), "2027-01-10").clawback_cents, 7500);
  // a first-visit offer isn't a plan discount: it never comes back
  const ft = done1(mk("biannual", 5000, "2026-11-17", [{ id: "f", name: "First Time Customer", type: "fixed", value: 5000, scope: { type: "initial" } }]));
  assert.equal(M.cancelQuote(ft, "2027-01-10").clawback_cents, 5000);
  assert.equal(M.clawbackCents({ lines: [EXT], discounts: [] }), 0, "no plan discount: nothing to pay back");
  assert.match(AG.clawbackTerms({ lines: [EXT], discounts: [] }), /nothing to pay back/);
});

test("Owner checks: a draft can't be approved with one left (only the lights one is left after Nov 12); seed v2 upgrades an untouched first draft, never an owner's edit", async () => {
  const { t, owner } = await setup(undefined, { approve: false });
  try {
    const drafts = TX.AGREEMENT_DRAFTS;
    assert.equal(drafts.length, 6);
    for (const d of drafts) {
      // the owner's answers (Nov 12) settled every check but how the crew hangs the lights
      assert.equal(AG.ownerChecksIn(d.body_md).length, d.key === "lights" ? 1 : 0, `${d.key}: the checks left`);
      assert.doesNotMatch(d.body_md, /—|licensed|refund/i);
      AG.checkBody(d.body_md);
    }
    assert.match(AG.ownerChecksIn(drafts.find((d) => d.key === "lights").body_md)[0], /how the crew attaches the lights/);
    const lights = drafts.find((d) => d.key === "lights").body_md;
    assert.match(lights, /we'll come back and fix it for free/, "lights: fix, not re-clean");
    assert.doesNotMatch(lights, /windows, frames, screens or seals|re-clean/);
    assert.match(lights, /clips along your roofline and gutters/);
    await assert.rejects(scope(() => AG.approveTemplate(AG.seedTemplateId("lights"), W8(owner))), (e) => e.code === "owner_checks");
    const id = AG.seedTemplateId("biannual");
    // an old installation: the first biannual draft, untouched and approved; an owner-edited quarterly
    const OLD = "## {{plan_name}} service agreement\n\nThis agreement is between {{legal_name}} (\"{{company_name}}\", \"we\", \"us\") and {{full_name}} (\"you\").\n\n## What you get\n\n- Exterior window cleaning twice a year, about every 6 months.\n- Your price: {{per_visit_price}} a visit, locked in for the first {{term_months}} months.\n- Our 100% satisfaction guarantee: if anything isn't right, tell us and we'll come back and re-clean it for free.\n\n## Scheduling\n\nWe come out about every 6 months. We book each visit with you ahead of time and confirm it by text.\n\n## Reminders and rescheduling\n\nWe text or email you about 2 weeks and again 2 days before each visit. We give you an arrival window, not an exact time.\n\nNeed to move a visit? Just let us know at least 24 hours ahead. A cancel or reschedule with less than 24 hours' notice, or a visit where we can't get in and weren't told, may have a {{late_cancel_fee}} fee. There's never a fee when we're the ones moving a visit (rain, for example).\n\n## Payments\n\nKeep a card or bank account on file for your plan. Your first visit is charged after it's done. After that, each visit is charged on the 1st of the month it's scheduled in. We don't charge sales tax.\n\n## Skipped visits\n\nYou can skip a visit. Skipping doesn't cancel your plan, and a skipped visit doesn't turn into a credit.\n\n## Term and renewal\n\nYour plan starts with a {{term_months}}-month term at the price above. After that it renews every 6 months until you cancel. If your price ever changes after the first {{term_months}} months, we'll tell you in writing at least 30 days before.\n\n## Cancelling in the first {{term_months}} months\n\nGive us {{notice_days}} days' notice in writing (a text or email is fine). If your first visit is done, you pay back that visit's plan discount of {{clawback_amount}}. That's it.\n\n## Cancelling after the first {{term_months}} months\n\nCancel any time. It takes effect at the end of your current renewal term, and visits until then still happen and are billed.\n\n## The fine print\n\nWe're fully insured. You don't need to be home for exterior work as long as gates are unlocked; we set up interior visits with you. We're not responsible for damage that was already there, or for old or defective windows, frames, screens or seals.\n\nQuestions? Call or text us at {{company_phone}}. Thanks for trusting us with your home!";
    await scope(() => store.updateRecord("agreement_template", id, (x) => ({ ...x, body_md: OLD, version: 1, approved_version: 1, applies_to: { catalog_keys: ["biannual", "custom"], service_types: [] } }), AS(owner)));
    const qid = AG.seedTemplateId("quarterly");
    await scope(() => store.updateRecord("agreement_template", qid, (x) => ({ ...x, body_md: "## {{plan_name}}\n\nOur own words.", version: 4 }), AS(owner)));
    const custom = AG.seedTemplateId("custom");
    const out = await scope(() => AG.upgradeAgreementDrafts({ by: "system:test", origin: "worker", actor_kind: "automation", requestId: "t" }));
    assert.ok(out.upgraded >= 1);
    const b = await recOf("agreement_template", id);
    assert.equal(b.body_md, drafts.find((d) => d.key === "biannual").body_md, "the untouched first draft becomes the new one");
    assert.equal(b.version, 2);
    assert.notEqual(b.approved_version, b.version, "a new version: the owner reads and approves it again");
    assert.deepEqual(b.applies_to.catalog_keys, ["biannual"], "Custom has its own text now");
    assert.equal((await recOf("agreement_template", qid)).body_md, "## {{plan_name}}\n\nOur own words.", "an owner's edit stays");
    assert.ok(await recOf("agreement_template", custom), "the Custom text exists");
    // a second run changes nothing
    const again = await scope(() => AG.upgradeAgreementDrafts({ by: "system:test", origin: "worker", actor_kind: "automation", requestId: "t" }));
    assert.equal(again.upgraded, 0);
  } finally { t.done(); }
});
