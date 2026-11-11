// Quotes, Scheduling, Plans and Money together, with no fakes: a customer
// approves a quote; the job is booked and done; Money makes and sends the
// invoice; the customer pays it from the text with a tip through the
// practice Checkout; the receipt goes out and the tip is the crew's. And a
// plan: it waits for a card, the card is saved, the first visit is billed
// when it is done and charged to the card, later visits are billed on the
// 1st of their month (once). Everything stays in dry run; synthetic data only.
import { test } from "node:test";
import assert from "node:assert/strict";
import { setup, sentQuote, portalCookie, approveBody, finishRun, quoteOf, quarterly, oneTime, PJSON, IPHONE, scope, store, AS, AUTOMATION } from "../quotes/fixtures.mjs";
import { advance, days, hours } from "../../helpers/crm-clock.mjs";

const OFF = await import("../../../netlify/lib/crm/modules/work/office.mjs");
const AG = await import("../../../netlify/lib/crm/modules/plans/agreements.mjs");
const AP = await import("../../../netlify/lib/crm/modules/money/autopay.mjs");
const sweeps = await import("../../../netlify/lib/crm/core/sweeps.mjs");

const recs = (t, type) => t.stores.data.keys(`rec/${type}/`).map((k) => t.stores.data.json(k));
const texts = (t, key) => recs(t, "outbox").filter((o) => o.kind === "sms" && o.template_key === key);
const drain = async (t, n = 5) => { for (let i = 0; i < n; i++) await t.runWorker({ lane: "fast" }); };
const linkIn = (body) => (/https:\/\/www\.bartawindowwashing\.com(\/p\/[0-9A-Za-z]{10})/.exec(body) || [])[1];
// The customer taps the link in a text: the code opens a session for exactly what the link is for.
async function openLink(t, body) {
  const path = linkIn(body);
  assert.ok(path, `a portal link in: ${body}`);
  const r = await t.portal("/api/portal/open", { method: "POST", headers: PJSON, body: { code: path.slice(3) } });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  return { cookie: t.setCookies(r).find((x) => x.startsWith("barta_portal=")).split(";")[0], location: r.body.data.location };
}
async function approve(t, quote, version, optionId) {
  const cookie = await portalCookie(t, quote);
  const r = await t.portal(`/api/portal/quotes/${quote.id}/approve`, { method: "POST", cookie, headers: PJSON, body: approveBody(version, optionId) });
  assert.ok([200, 202].includes(r.status), JSON.stringify(r.body));
  const run = await finishRun(t, r.body.data.run_id, 10);
  assert.equal(run.status, "done", JSON.stringify(run));
  for (let i = 0; i < 6 && (await quoteOf(quote.id)).status !== "converted"; i++) await t.runWorker({ lane: "fast" });
  return quoteOf(quote.id);
}
// The office books the job's visit for these techs and, later, marks it done.
async function book(owner, jobId, techs, date) {
  return scope(() => OFF.createVisit({ job_id: jobId, date, start: "08:00", end: "10:00", window: { type: "window", minutes: 120 }, assignee_ids: techs.map((u) => u.id) }, AS(owner))).then((r) => r.visit);
}
async function done(t, owner, visit) {
  const g = await scope(() => store.getRecord("visit", visit.id));
  const r = await t.api(`/visits/${visit.id}/done`, { method: "POST", as: owner, body: {}, ifMatch: g.etag });
  assert.equal(r.status, 200, JSON.stringify(r.body));
}
async function world() {
  const fx = await setup();
  sweeps.clearSweepCache();
  sweeps.clearSeedCache();
  await scope(() => OFF.seedChecklists({ write: () => AUTOMATION }));
  fx.tech2 = await fx.t.user("tech", { extra: { first_name: "Tess" } });
  return fx;
}

test("a one-time quote: approved, booked, done, invoiced, paid from the text with a tip; the receipt goes out and the tip is the crew's", async () => {
  const { t, owner, tech, tech2 } = await world();
  try {
    const { quote, version, contact } = await sentQuote(t, owner, { options: [oneTime()] });
    const q = await approve(t, quote, version, version.options[0].id);
    assert.equal(q.status, "converted");
    const job = recs(t, "job")[0];
    assert.equal(job.status, "unscheduled");
    assert.equal(recs(t, "invoice").length, 0, "nothing is billed before the work is done");
    // Scheduling: booked for two techs, then done
    const visit = await book(owner, job.id, [tech, tech2], "2026-11-12");
    advance(days(2));
    await done(t, owner, visit);
    await drain(t);
    // Money heard job.completed: one invoice, issued, numbered in the practice sequence, with the job's lines
    const invoices = recs(t, "invoice");
    assert.equal(invoices.length, 1);
    let inv = invoices[0];
    assert.deepEqual([inv.status, inv.kind, inv.number, inv.total_cents, inv.balance_cents, inv.contact_id], ["open", "standard", "SINV-0001", 29500, 29500, contact.id]);
    assert.deepEqual(inv.job_ids, [job.id]);
    assert.equal(inv.quote_id, quote.id);
    assert.deepEqual(inv.lines.map((l) => [l.kind, l.description, l.total_cents]), [["service", "Exterior Window Cleaning", 29500]]);
    assert.equal(inv.issued_on, "2026-11-12");
    assert.deepEqual((await scope(() => store.getRecord("job", job.id))).data.invoice_ids, [inv.id]);
    // the invoice text (dry run: it is in the Outbox, nothing left the site), in Barta's voice, linking to the portal and never to Stripe
    const sent = texts(t, "invoice_sent");
    assert.equal(sent.length, 1);
    assert.equal(sent[0].mode, "dry_run");
    assert.match(sent[0].body, /thanks for having Barta Window Washing out! Your invoice SINV-0001 for \$295\.00 is ready/);
    assert.doesNotMatch(sent[0].body, /stripe|—|licensed/i);
    // the customer taps it
    const { cookie, location } = await openLink(t, sent[0].body);
    assert.equal(location, `/p/invoice/${inv.id}`);
    const page = await t.portal(location, { cookie, headers: { "user-agent": IPHONE } });
    assert.equal(page.status, 200);
    assert.match(page.text, /here&#39;s your invoice|here's your invoice/);
    assert.match(page.text, /Add a tip for the crew\?/);
    assert.match(page.text, /Test mode: nothing is really charged/);
    // 15% for the crew, by card, on the practice Checkout
    const co = await t.portal(`/api/portal/invoices/${inv.id}/checkout`, { method: "POST", headers: PJSON, cookie, body: { tip_choice: "15" } });
    assert.equal(co.status, 200, JSON.stringify(co.body));
    assert.equal(co.body.data.tip_cents, 4425);
    const sid = co.body.data.url.split("/").pop();
    const paid = await t.portal(`/api/portal/dry-checkout/${sid}`, { method: "POST", headers: PJSON, body: { action: "pay", method: "card" } });
    assert.equal(paid.status, 200, JSON.stringify(paid.body));
    const ret = await t.portal(paid.body.data.location, { cookie, headers: { "user-agent": IPHONE } });
    assert.match(ret.text, /Paid\. Thank you!/);
    // paid, to the cent
    inv = (await scope(() => store.getRecord("invoice", inv.id))).data;
    assert.deepEqual([inv.status, inv.paid_cents, inv.tips_cents, inv.balance_cents], ["paid", 29500, 4425, 0]);
    const pays = recs(t, "payment");
    assert.equal(pays.length, 1);
    const p = pays[0];
    assert.deepEqual([p.status, p.method, p.amount_cents, p.tip_cents, p.simulated, p.job_id], ["succeeded", "card", 29500, 4425, true, job.id]);
    // the tip is attributed to the two techs who did the visit, evenly (the odd cent to the first): Payroll's data
    assert.deepEqual(p.tip_split.map((x) => x.cents), [2213, 2212]);
    assert.deepEqual(p.tip_split.map((x) => x.user_id).sort(), [tech.id, tech2.id].sort());
    // the receipt: a text and an email in the Outbox, once
    await drain(t);
    const receipts = texts(t, "payment_receipt");
    assert.equal(receipts.length, 1);
    assert.match(receipts[0].body, /We got your payment for invoice SINV-0001\. Here's your receipt:/);
    assert.equal(recs(t, "outbox").filter((o) => o.kind === "email" && o.template_key === "payment_receipt_email").length, 1);
    const r2 = await openLink(t, receipts[0].body);
    assert.equal(r2.location, `/p/receipt/${p.id}`);
    const receipt = await t.portal(r2.location, { cookie: r2.cookie, headers: { "user-agent": IPHONE } });
    assert.match(receipt.text, /Tip for the crew<\/dt><dd>\$44\.25/);
    assert.match(receipt.text, /Total paid<\/span><b>\$339\.25/);
    // the finished job stays finished now that it is paid (Scheduling asks Money's invoice), and no reminder ever goes for it
    const vg = await scope(() => store.getRecord("visit", visit.id));
    const reopen = await t.api(`/visits/${visit.id}/reopen`, { method: "POST", as: owner, body: {}, ifMatch: vg.etag });
    assert.equal(reopen.status, 409);
    assert.match(reopen.body.error.message, /paid invoice/);
    advance(days(10));
    await drain(t, 3);
    assert.equal(texts(t, "invoice_overdue").length, 0);
    // the office sees it all
    const one = await t.api(`/invoices/${inv.id}`, { as: owner });
    assert.equal(one.body.data.payments.length, 1);
    assert.equal(one.body.data.invoice.status, "paid");
    assert.equal((await t.api(`/money/contacts/${contact.id}`, { as: owner })).body.data.open_balance_cents, 0);
    assert.equal(t.fetchCalls().length, 0, "nothing left the site");
  } finally { t.done(); }
});

test("a plan from a quote: it waits for a card; the first visit is billed when it is done and charged to the card; the next visit is billed on the 1st of its month, once", async () => {
  const { t, owner, tech } = await world();
  try {
    await scope(() => AG.seedAgreementTemplates(AUTOMATION));
    await scope(async () => {
      const id = AG.seedTemplateId("quarterly");
      const own = { write: () => AS(owner) };
      const g = await store.getRecord("agreement_template", id);
      await AG.patchTemplate(id, { body_md: AG.withoutOwnerChecks(g.data.body_md) }, { ...own, ifMatch: g.etag });
      await AG.approveTemplate(id, own);
    });
    const { quote, version, contact } = await sentQuote(t, owner, { options: [oneTime({ recommended: false }), quarterly({ recommended: true })] });
    const opt = version.options.find((o) => o.kind === "plan");
    const q = await approve(t, quote, version, opt.id);
    let plan = recs(t, "plan")[0];
    assert.equal(q.converted_to.plan_id, plan.id);
    assert.deepEqual([plan.billing.mode, plan.billing.autopay], ["barta_standard", true]);
    // Money says there is no card yet, so the plan waits for one
    assert.equal(plan.status, "pending");
    assert.deepEqual(plan.pending_reasons, ["card"]);
    // the office texts the card link; the customer saves a card on the practice Checkout
    const link = await t.api(`/contacts/${contact.id}/card-link`, { method: "POST", as: owner, body: {} });
    assert.equal(link.status, 201, JSON.stringify(link.body));
    await drain(t, 2);
    const cardText = texts(t, "card_link")[0];
    const { cookie, location } = await openLink(t, cardText.body);
    assert.equal(location, "/p/card");
    assert.match((await t.portal("/p/card", { cookie, headers: { "user-agent": IPHONE } })).text, /add a card|Add a card/);
    const setupCo = await t.portal("/api/portal/card/checkout", { method: "POST", headers: PJSON, cookie, body: {} });
    assert.equal(setupCo.status, 200, JSON.stringify(setupCo.body));
    const saved = await t.portal(`/api/portal/dry-checkout/${setupCo.body.data.url.split("/").pop()}`, { method: "POST", headers: PJSON, body: { action: "pay", method: "card" } });
    assert.equal(saved.status, 200, JSON.stringify(saved.body));
    assert.match((await t.portal(saved.body.data.location, { cookie, headers: { "user-agent": IPHONE } })).text, /You're all set|You&#39;re all set/);
    await drain(t);
    plan = (await scope(() => store.getRecord("plan", plan.id))).data;
    assert.equal(plan.status, "active", "the saved card was the last thing it waited for");
    assert.match(plan.billing.payment_method_id, /^dry_pm_card_/);

    // visit 1 (barta_standard: billed when it is done), charged to the card on file at once
    const first = plan.ordinals.find((o) => o.n === 1);
    const v1 = await book(owner, first.job_id, [tech], "2026-11-12");
    advance(days(2));
    await done(t, owner, v1);
    await drain(t, 6);
    let invoices = recs(t, "invoice");
    assert.equal(invoices.length, 1);
    const i1 = invoices[0];
    assert.deepEqual([i1.kind, i1.status, i1.plan_id, i1.total_cents], ["standard", "paid", plan.id, q.approval.totals.per_visit_cents[0]]);
    assert.deepEqual(i1.plan_ordinals, [{ term: 1, n: 1 }]);
    assert.deepEqual(i1.autopay.attempts.map((a) => [a.origin, a.result]), [["invoice.issued", "succeeded"]]);
    assert.equal(texts(t, "invoice_sent").length, 0, "an autopay invoice doesn't ask to be paid: it waits for the charge");
    assert.equal(texts(t, "payment_receipt").length, 1);
    plan = (await scope(() => store.getRecord("plan", plan.id))).data;
    assert.equal(plan.ordinals.find((o) => o.n === 1).billed_invoice_id, i1.id);

    // visit 2 is billed on the 1st of its month: the preview says so, the run does it
    const second = plan.ordinals.find((o) => o.n === 2);
    const month = second.target_month;
    const preview = (await t.api(`/autopay/preview?month=${month}`, { as: owner })).body.data;
    assert.deepEqual(preview.items.map((i) => [i.plan_id, i.amount_cents, i.would]), [[plan.id, q.approval.totals.per_visit_cents[1], "charge"]]);
    const ctx = { instance: month, holder: "flow", cursor: null, budget: null, mode: AUTOMATION.mode, write: () => AUTOMATION, mayAct: () => true, would: async () => {} };
    const ran = await scope(() => AP.autopayRun(ctx, { month }));
    assert.match(ran.result, /1 plans/);
    invoices = recs(t, "invoice");
    assert.equal(invoices.length, 2);
    const i2 = invoices.find((i) => i.id !== i1.id);
    assert.deepEqual([i2.kind, i2.status, i2.plan_month, i2.total_cents], ["plan_cycle", "paid", month, q.approval.totals.per_visit_cents[1]]);
    assert.deepEqual(i2.job_ids, [second.job_id]);
    // when that visit is done later, Money bills nothing more for it
    const v2 = await book(owner, second.job_id, [tech], `${month}-10`);
    advance(hours(1));
    await done(t, owner, v2);
    await drain(t, 6);
    assert.equal(recs(t, "invoice").length, 2, "one invoice per visit");
    assert.equal(recs(t, "payment").filter((p) => p.status === "succeeded").length, 2);
    // the run asked again for the same month charges nobody
    assert.deepEqual(await scope(() => AP.autopayRun(ctx, { month })), { result: "done" });
    assert.equal(recs(t, "outbox").filter((o) => o.kind === "charge").length, 2);
  } finally { t.done(); }
});

test("a quote with a deposit: approving goes straight to paying it; the job's invoice takes the deposit off", async () => {
  const { t, owner, tech } = await world();
  try {
    const { quote, version } = await sentQuote(t, owner, { options: [oneTime()], agreement: { require_card: false, deposit: { type: "fixed", value: 10000 } } });
    const cookie = await portalCookie(t, quote);
    const r = await t.portal(`/api/portal/quotes/${quote.id}/approve`, { method: "POST", cookie, headers: PJSON, body: approveBody(version, version.options[0].id) });
    assert.ok([200, 202].includes(r.status), JSON.stringify(r.body));
    const run = await finishRun(t, r.body.data.run_id, 10);
    // the approval's answer carries the Checkout for the deposit (the practice one, in dry run)
    const seen = await t.portal(`/api/portal/quotes/${quote.id}/runs/${r.body.data.run_id}`, { cookie, headers: { "user-agent": IPHONE } });
    assert.equal(seen.status, 200, JSON.stringify(seen.body));
    const checkout = seen.body.data.result.checkout_url;
    assert.match(checkout, /^\/p\/dry-checkout\/dry_cs_[0-9a-f]{24}$/);
    assert.equal(run.result.invoice_id, (await quoteOf(quote.id)).converted_to.deposit_invoice_id);
    let dep = recs(t, "invoice").find((i) => i.kind === "deposit");
    assert.deepEqual([dep.number, dep.status, dep.total_cents, dep.quote_id], ["SD-0001", "open", 10000, quote.id]);
    const pay = await t.portal(`/api/portal/dry-checkout/${checkout.split("/").pop()}`, { method: "POST", headers: PJSON, body: { action: "pay", method: "card" } });
    assert.equal(pay.status, 200, JSON.stringify(pay.body));
    dep = (await scope(() => store.getRecord("invoice", dep.id))).data;
    assert.equal(dep.status, "paid");
    assert.equal(recs(t, "payment")[0].tip_cents, 0, "no tip on a deposit");
    // the work is done: the invoice is the job less the deposit
    for (let i = 0; i < 6 && (await quoteOf(quote.id)).status !== "converted"; i++) await t.runWorker({ lane: "fast" });
    const job = recs(t, "job")[0];
    const visit = await book(owner, job.id, [tech], "2026-11-12");
    advance(days(2));
    await done(t, owner, visit);
    await drain(t);
    const inv = recs(t, "invoice").find((i) => i.kind === "standard");
    assert.deepEqual(inv.lines.map((l) => [l.kind, l.total_cents]), [["service", 29500], ["deposit_credit", -10000]]);
    assert.deepEqual([inv.total_cents, inv.balance_cents, inv.status], [19500, 19500, "open"]);
    assert.match(inv.lines[1].description, /Deposit SD-0001/);
    assert.equal((await scope(() => store.getRecord("invoice", dep.id))).data.credited_invoice_id, inv.id, "a deposit is used once");
    assert.match(texts(t, "invoice_sent").at(-1).body, /for \$195\.00 is ready/);
  } finally { t.done(); }
});
