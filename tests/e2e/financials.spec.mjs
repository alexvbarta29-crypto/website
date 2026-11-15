// Phone checks of Financials (the Rotor guide's §2.10 and Flyra's Expenses,
// Track 3): the tabs Invoices · Payments · Payouts · Payroll · Expenses;
// the Invoices tiles (Outstanding, Overdue, Due today, Paid this month)
// and Text a reminder; the Payments tiles and the Tip report; Payouts not
// connected; a pay period's track (Open, Approved, Paid, Closed) and its Job
// view; an expense added and its category tile. iPhone 13 and iPhone SE,
// light and dark; a desk at 1440 still works. Synthetic data only; nothing
// leaves (dry run). `node --test tests/e2e/financials.spec.mjs`.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { start } from "./server.mjs";
import { seedPayroll } from "./payroll-seed.mjs";
import { launch, phone, signIn, crmFrame, goTo, settled, badLinks, screenProblems, shot, noInstallCard } from "./kit.mjs";

let srv, browser, seeded, PR;
before(async () => { srv = await start(); seeded = await srv.seed(); PR = await seedPayroll(seeded); browser = await launch(); });
after(async () => { await browser?.close(); await srv?.close(); });

async function open(login, device, theme) {
  const p = await phone(browser, srv, { device, office: true });
  await p.ctx.addInitScript((t) => { try { localStorage.setItem("crm-theme", t); } catch (e) { /* fine */ } }, theme);
  await signIn(p, login);
  await p.page.goto("/office");
  const f = await crmFrame(p.page);
  await settled(f);
  await noInstallCard(p.page);
  return { p, page: p.page, f };
}
const sheetUp = (f, re) => f.waitForFunction((src) => { const h = document.querySelector(".sheet.on h2"); return !!h && new RegExp(src).test(h.textContent); }, re.source, { timeout: 5000 });
const sheetGone = (f) => f.waitForFunction(() => !document.querySelector(".sheet"), null, { timeout: 5000 });
async function checks(f, page, name, problems) {
  for (const x of await screenProblems(f)) problems.push(`${name}: ${x}`);
  for (const x of await badLinks(f)) problems.push(`${name}: a link that leaves in this tab ${x}`);
  await shot(page, name);
}
const labels = (f, name) => f.$$eval(`[data-tile="${name}"] .rs-tile-l, .rs-tile.info .rs-tile-l`, (x) => x.map((e) => e.textContent));

for (const [device, theme] of [["iphone13", "dark"], ["iphonese", "light"]]) {
  test(`Financials (${device}, ${theme}): Invoices, Payments, Payouts, a pay period and Expenses`, async () => {
    const { p, page, f } = await open("olive", device, theme);
    const problems = [];
    try {
      await goTo(f, "/invoices");
      await f.waitForSelector('[data-tile="inv"][data-key="open"]');
      for (const t of ["invoices", "payments", "payouts", "payroll", "expenses"]) assert.ok(await f.$(`#subnav a[href="#/${t}"]`), `the ${t} tab`);
      const il = await labels(f, "inv");
      assert.deepEqual(il.slice(0, 4), ["Paid this month", "Due today", "Outstanding", "Overdue"], "Rotor's four, in Rotor's order");
      assert.ok(await f.$("[data-tax-report]"), "Rotor's Tax Report");
      await checks(f, page, `fin-invoices-${device}-${theme}`, problems);
      await f.click('[data-tile="inv"][data-key="overdue"]');
      await f.waitForSelector('[data-tile="inv"][data-key="overdue"][aria-pressed="true"]');
      const remind = await f.$("[data-remind]");
      if (remind) {
        await remind.click();
        await f.waitForSelector(".toast");
      }
      await f.click("[data-list-more]");
      await sheetUp(f, /Invoices/);
      assert.ok(await f.$(".sheet.on [data-tax-report]"), "the Tax report");
      await f.click(".sheet.on [data-sheet-x]");
      await sheetGone(f);

      await goTo(f, "/payments");
      await f.waitForSelector('[data-tile="pay"][data-key="total"]');
      const pl = await f.$$eval('.rs-tile .rs-tile-l', (x) => x.map((e) => e.textContent));
      for (const l of ["Total Payments", "Stripe Payments", "Cash & check", "Total Tips", "Total Refunds", "Card fees"]) assert.ok(pl.includes(l), l);
      assert.ok(await f.$("[data-tip-report]"), "Rotor's Tip Report");
      await checks(f, page, `fin-payments-${device}-${theme}`, problems);
      await f.click("[data-pay-more]");
      await sheetUp(f, /Payments/);
      assert.ok(await f.$(".sheet.on [data-tip-report]"), "the Tip report");
      await f.click(".sheet.on [data-sheet-x]");
      await sheetGone(f);

      await goTo(f, "/payouts");
      await f.waitForSelector(".rs-emptycard");
      assert.match(await f.textContent("#view"), /Payouts show here once Stripe is connected/);
      await checks(f, page, `fin-payouts-${device}-${theme}`, problems);

      await goTo(f, `/payroll/${PR.lastPeriod.id}`);
      await f.waitForSelector(".py-track .rs-steps");
      assert.match(await f.textContent(".py-track"), /Open[\s\S]*Approved[\s\S]*Paid[\s\S]*Closed/);
      await f.click('[data-seg="py-view"][data-key="jobs"]');
      await f.waitForSelector('[data-seg="py-view"][data-key="jobs"][aria-selected="true"]');
      await checks(f, page, `fin-payroll-jobs-${device}-${theme}`, problems);

      await goTo(f, "/expenses/new");
      await f.waitForSelector("[data-ex-f]");
      await checks(f, page, `fin-expense-new-${device}-${theme}`, problems);
      await f.fill("[name=amount]", "45.99");
      await f.selectOption("[name=category]", "fuel");
      await f.fill("[name=vendor]", "Example Gas");
      await f.click("[data-ex-f] [type=submit]");
      await settled(f, { hash: "#/expenses" });
      await f.waitForSelector('[data-tile="ex"][data-key="fuel"]');
      assert.match(await f.textContent("#view"), /Example Gas[\s\S]*\$45\.99/);
      await checks(f, page, `fin-expenses-${device}-${theme}`, problems);
      assert.deepEqual(problems, []);
      await p.clean();
    } finally { await p.close(); }
  });
}

test("a desk at 1440: Invoices tiles and Expenses still lay out; a tech has no Financials", async () => {
  const { p, page, f } = await open("olive", "desk1440", "light");
  try {
    await goTo(f, "/invoices");
    await f.waitForSelector('[data-tile="inv"]');
    assert.deepEqual(await screenProblems(f), []);
    await shot(page, "fin-invoices-desk1440");
    await goTo(f, "/expenses");
    await f.waitForSelector('[data-tile="ex"]');
    assert.deepEqual(await screenProblems(f), []);
    await p.clean();
  } finally { await p.close(); }
  const t = await open("theo", "iphone13", "dark");
  try {
    const r = await t.p.ctx.request.get("/api/crm/expenses", { headers: { "x-crm": "1" } });
    assert.equal(r.status(), 403);
  } finally { await t.p.close(); }
});
