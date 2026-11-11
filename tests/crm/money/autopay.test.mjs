// The 1st-of-month run (design §5.6, §7.6 money.autopay; §11.4 M5
// autopay.test.mjs): a run killed at item 17 resumes at 18 and charges
// nobody twice; a 1st the worker missed runs on the next pass, late, and the
// owners are told; plans Rotor still bills are only reported (would_charge,
// no invoice) before the switch; an autopay invoice's text waits for the
// charge result.
import { test } from "node:test";
import assert from "node:assert/strict";
import { setup, customer, importedCustomer, cyclePlan, saveCard, invoiceOf, recs, outbox, texts, drain, advance, minutes, days, scope, store, AP, INV, AUTOMATION } from "./fixtures.mjs";

const NOV_30 = "2026-11-30T15:00:00Z";
const sweepCtx = (holder) => ({
  instance: "2026-12", holder, cursor: null, budget: null, mode: AUTOMATION.mode, write: () => ({ ...AUTOMATION, requestId: holder }),
  mayAct: (s) => { const c = s.contact !== undefined ? s.contact : null; return !!(c && ((c.shadow && !c.import) || (c.flags && c.flags.test))); },
  would: async (rec, action) => { wouldRows.push(`${action}:${rec.id}`); },
});
let wouldRows = [];
const runOf = async (month = "2026-12") => (await scope(() => store.getRecord("autopay_run", AP.runIdFor(month)))).data;

async function plans(owner, n) {
  const out = [];
  for (let i = 0; i < n; i++) {
    const c = await customer(owner, { last_name: `Plan${String(i + 1).padStart(2, "0")}` });
    await saveCard(c);
    out.push({ contact: c, plan: await cyclePlan(owner, c) });
  }
  return out;
}

test("the preview: plan by plan what the 1st would bill; Rotor's plans are reported only, a paused plan and one without a card are called out", async () => {
  const { t, owner, admin, tech } = await setup(NOV_30);
  try {
    wouldRows = [];
    const mine = await plans(owner, 3);
    const noCard = await customer(owner, { last_name: "NoCard" });
    await cyclePlan(owner, noCard);
    const paused = await customer(owner, { last_name: "Paused" });
    await saveCard(paused);
    await cyclePlan(owner, paused, { status: "paused" });
    const byInvoice = await customer(owner, { last_name: "ByInvoice" });
    await cyclePlan(owner, byInvoice, { autopay: false });
    const rotor = await importedCustomer();
    const rp = await cyclePlan(owner, rotor, { imported: true });
    const later = await customer(owner, { last_name: "Later" });
    await cyclePlan(owner, later, { month: "2027-01" });
    const r = await t.api("/autopay/preview?month=2026-12", { as: owner });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    const p = r.body.data;
    assert.equal(p.month, "2026-12");
    assert.equal(p.items.length, 7, "the January plan isn't in December's run");
    const by = Object.fromEntries(p.items.map((i) => [i.contact_name.split(" ").pop(), i]));
    assert.deepEqual([by.Plan01.would, by.Plan01.amount_cents, by.Plan01.card, by.Plan01.visits.length], ["charge", 24500, "ok", 1]);
    assert.equal(by.NoCard.would, "skipped_no_card");
    assert.equal(by.Paused.would, "skipped_paused");
    assert.equal(by.ByInvoice.would, "invoice_only");
    const rotorItem = p.items.find((i) => i.plan_id === rp.id);
    assert.deepEqual([rotorItem.would, rotorItem.imported, rotorItem.amount_cents], ["would_charge", true, 24500]);
    assert.deepEqual(p.totals, { plans: 7, amount_cents: 7 * 24500, charge_cents: 3 * 24500, would_charge_cents: 24500, no_card: 1, paused: 1, invoice_only: 1 });
    // the preview writes nothing
    assert.equal(recs(t, "invoice").length, 0);
    assert.equal(outbox(t, "charge").length, 0);
    // the default month is the next one; the office reads it, a tech doesn't
    assert.equal((await t.api("/autopay/preview", { as: admin })).body.data.month, "2026-12");
    assert.equal((await t.api("/autopay/preview", { as: tech })).status, 403);
    assert.equal((await t.api("/autopay/preview?month=2027-01", { as: owner })).body.data.items.length, 1);
    assert.ok(mine.length);
  } finally { t.done(); }
});

test("a run killed while saving item 17 resumes at 18; nobody is charged twice; the item it died on is settled from what was already done", async () => {
  const { t, owner } = await setup(NOV_30);
  try {
    wouldRows = [];
    const list = await plans(owner, 20);
    advance(days(1) + minutes(1));                           // Dec 1, 9:01 AM
    // the function dies on its 19th write of the run record: 1 makes it, 1 lists the plans, 16 results are saved, the 17th result is lost
    const runKey = `rec/autopay_run/${AP.runIdFor("2026-12")}`;
    let writes = 0;
    t.stores.data.beforeConditionalWrite(() => { writes += 1; if (writes >= 19) throw new Error("the function was killed"); }, { key: runKey, times: 1000 });
    await assert.rejects(() => scope(() => AP.autopayRun(sweepCtx("pass-1"))));
    t.stores.data.clearHooks();
    let run = await runOf();
    assert.equal(run.status, "running");
    assert.equal(run.items.length, 20);
    const order = run.items.map((i) => i.plan_id);
    assert.deepEqual(run.items.map((i) => i.result).slice(0, 16), new Array(16).fill("succeeded"));
    assert.deepEqual(run.items.map((i) => i.result).slice(16), ["pending", "pending", "pending", "pending"]);
    assert.equal(outbox(t, "charge").length, 17, "item 17 was charged before the function died");
    // the next pass (another function): 18, 19 and 20; item 17 is still held by the dead pass's marker
    const second = await scope(() => AP.autopayRun(sweepCtx("pass-2")));
    assert.equal(second.done, false);
    run = await runOf();
    assert.deepEqual(run.items.map((i) => i.result).slice(16), ["pending", "succeeded", "succeeded", "succeeded"]);
    assert.equal(outbox(t, "charge").length, 20);
    // once the dead pass's hold runs out, item 17 is settled from its paid invoice: no second charge
    advance(minutes(3));
    const third = await scope(() => AP.autopayRun(sweepCtx("pass-3")));
    assert.match(third.result, /20 plans/);
    run = await runOf();
    assert.equal(run.status, "done");
    assert.deepEqual(run.items.map((i) => i.plan_id), order, "the list was made once");
    assert.ok(run.items.every((i) => i.result === "succeeded" && i.invoice_id));
    assert.equal(outbox(t, "charge").length, 20, "20 plans, 20 charges");
    assert.deepEqual(run.totals, { attempted: 20, succeeded_cents: 20 * 24500, failed: 0, processing: 0, would_charge_cents: 0 });
    const invoices = recs(t, "invoice");
    assert.equal(invoices.length, 20);
    assert.ok(invoices.every((i) => i.kind === "plan_cycle" && i.status === "paid" && i.plan_month === "2026-12"));
    assert.deepEqual(new Set(invoices.map((i) => i.plan_id)).size, 20, "one invoice per plan");
    assert.equal(recs(t, "payment").length, 20);
    // a later pass, or the same month asked again, does nothing
    assert.deepEqual(await scope(() => AP.autopayRun(sweepCtx("pass-4"))), { result: "done" });
    assert.equal(outbox(t, "charge").length, 20);
    // each plan's visit is marked billed by its invoice, so the visit's own completion won't bill it again
    const plan = (await scope(() => store.getRecord("plan", list[0].plan.id))).data;
    const ord = plan.ordinals.find((o) => o.n === 2);
    assert.equal(ord.billed_invoice_id, INV.cycleInvoiceId(plan.id, "2026-12"));
    assert.deepEqual(await scope(() => AP.dueOrdinals(plan, "2026-12")), []);
    assert.deepEqual(wouldRows, []);
  } finally { t.done(); }
});

test("the worker missed the 1st: the run happens on the next pass, marked late, and the owners are told; Rotor's plans get would_charge and no invoice; texts wait for the charge", async () => {
  const { t, owner } = await setup(NOV_30);
  try {
    await drain(t, 2);                                        // the worker is up on Nov 30 ...
    const good = await customer(owner, { last_name: "Good" });
    await saveCard(good);
    const gp = await cyclePlan(owner, good);
    const declined = await customer(owner, { last_name: "Declined" });
    await saveCard(declined, "dry_pm_decline");
    const dp = await cyclePlan(owner, declined);
    const noCard = await customer(owner, { last_name: "NoCard" });
    const np = await cyclePlan(owner, noCard);
    const byInvoice = await customer(owner, { last_name: "ByInvoice" });
    const bp = await cyclePlan(owner, byInvoice, { autopay: false });
    const rotor = await importedCustomer();
    await saveCard(rotor);
    const rp = await cyclePlan(owner, rotor, { imported: true });
    // ... and down from then until the 3rd
    advance(days(3) + minutes(5));                            // Dec 3, 9:05 AM
    assert.equal((await runOf()).status, "planned", "nothing ran on the 1st");
    await drain(t, 6);
    const run = await runOf();
    assert.equal(run.status, "done");
    assert.equal(run.late, true);
    const by = Object.fromEntries(run.items.map((i) => [i.plan_id, i]));
    assert.equal(by[gp.id].result, "succeeded");
    assert.deepEqual([by[dp.id].result, by[dp.id].code], ["failed", "card_declined"]);
    assert.equal(by[np.id].result, "skipped_no_card");
    assert.equal(by[bp.id].result, "invoice_only");
    // Rotor's plan: reported, never invoiced, never charged
    assert.deepEqual([by[rp.id].result, by[rp.id].invoice_id], ["would_charge", undefined]);
    assert.equal(recs(t, "invoice").filter((i) => i.plan_id === rp.id).length, 0);
    assert.equal(recs(t, "payment").filter((p) => p.contact_id === rotor.id).length, 0);
    assert.ok(t.stores.data.keys("alog/").some((k) => k.includes("would-charge")), "a would-charge row for it");
    assert.deepEqual(run.totals, { attempted: 2, succeeded_cents: 24500, failed: 1, processing: 0, would_charge_cents: 24500 });
    // the owners are told: the summary says late, and the system alert says a day was missed
    const notes = recs(t, "notification").filter((n) => /Autopay ran/.test(n.title));
    assert.ok(notes.length >= 1);
    assert.match(notes[0].title, /Autopay ran \(late\): 5 plans/);
    assert.match(notes[0].body, /\$245\.00 charged, 1 failed, 1 without a card, 1 still billed by Rotor \(reported only\)/);
    const health = t.stores.data.json("sys/health");
    assert.ok((health.alerts || []).some((a) => /ran late \(it missed its day\)/.test(JSON.stringify(a))));
    // texts: the charged plan gets a receipt and no "here's your invoice"; the declined one the card link;
    // the plan without a card and the one that pays by invoice get the invoice text
    const sentTo = (key) => texts(t, key).map((o) => o.contact_id).sort();
    assert.deepEqual(sentTo("payment_receipt"), [good.id]);
    assert.deepEqual(sentTo("payment_failed"), [declined.id]);
    assert.deepEqual(sentTo("invoice_sent"), [byInvoice.id, noCard.id].sort());
    assert.equal(texts(t, "invoice_sent").filter((o) => [good.id, declined.id, rotor.id].includes(o.contact_id)).length, 0, "an autopay invoice waits for its charge instead of asking to be paid");
    assert.equal((await invoiceOf(by[dp.id].invoice_id)).autopay.next_attempt_at, "2026-12-06T15:00:00.000Z", "the declined card is tried again in 3 days");
    // the screens' data
    const runs = await t.api("/autopay/runs", { as: owner });
    assert.ok(runs.body.data.some((r) => r.m === "2026-12" && r.st === "done" && r.n === 5 && r.f === 1));
    const one = await t.api(`/autopay/runs/${run.id}`, { as: owner });
    assert.equal(one.status, 200);
    assert.equal(one.body.data.run.items.length, 5);
    assert.equal(one.body.data.names[gp.id].plan_name, "Biannual plan");
    // December is done: more passes change nothing
    advance(minutes(30));
    await drain(t, 3);
    assert.equal(outbox(t, "charge").length, 2);
    assert.equal(recs(t, "invoice").length, 4);
  } finally { t.done(); }
});

test("the 28th: next month's preview is kept on the run and the owners get the headline", async () => {
  const { t, owner } = await setup("2026-12-27T15:00:00Z");
  try {
    await drain(t, 2);
    const c = await customer(owner, { last_name: "January" });
    await saveCard(c);
    await cyclePlan(owner, c, { month: "2027-01" });
    const rotor = await importedCustomer();
    await cyclePlan(owner, rotor, { month: "2027-01", imported: true });
    advance(days(1) + minutes(10));                           // Dec 28, 9:10 AM
    await drain(t, 3);
    const run = await runOf("2027-01");
    assert.equal(run.status, "planned");
    assert.deepEqual([run.preview.totals.plans, run.preview.totals.amount_cents, run.preview.totals.would_charge_cents], [2, 49000, 24500]);
    const note = recs(t, "notification").find((n) => /Autopay on the 1st/.test(n.title));
    assert.match(note.title, /Autopay on the 1st: 2 plans, \$490\.00/);
    assert.match(note.body, /Rotor still bills its own plans; the CRM only reports them/);
    assert.equal(recs(t, "invoice").length, 0);
  } finally { t.done(); }
});
