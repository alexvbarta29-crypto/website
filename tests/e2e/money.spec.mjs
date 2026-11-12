// Phone checks of the money screens (M5; design §9.2, §8.1, §12.4):
// Invoices, an invoice (record a check, charge the card on file, refund),
// a new invoice, Payments, Autopay, the contact's Money tab, Settings →
// Payments; Collect payment on a tech's visit (cash, and the QR pay link);
// the customer's invoice page with a tip through the practice Checkout, and
// the card page; the list beside the invoice on a desk. Payments stay in
// dry run throughout. iPhone 13 and iPhone SE sizes. `npm run e2e`.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { start } from "./server.mjs";
import { launch, phone, signIn, crmFrame, goTo, settled, title, badLinks, screenProblems, shot, noInstallCard } from "./kit.mjs";

let srv, browser, seeded, M;
before(async () => { srv = await start(); seeded = await srv.seed(); M = seeded.money; browser = await launch(); });
after(async () => { await browser?.close(); await srv?.close(); });

async function open(login, device) {
  const p = await phone(browser, srv, { device });
  await signIn(p, login);
  await p.page.goto("/office");
  const f = await crmFrame(p.page);
  await settled(f);
  await noInstallCard(p.page);
  return { p, page: p.page, f };
}
const sheetUp = (f, re) => f.waitForFunction((src) => { const h = document.querySelector(".sheet.on h2"); return !!h && new RegExp(src).test(h.textContent); }, re.source, { timeout: 5000 });
const sheetGone = (f) => f.waitForFunction(() => !document.querySelector(".sheet"), null, { timeout: 5000 });
const closeSheet = async (f) => { await f.click(".sheet.on [data-sheet-x]"); await sheetGone(f); };
const viewHas = (f, re, timeout = 15000) => f.waitForFunction((src) => new RegExp(src).test(document.getElementById("view").textContent), re.source, { timeout });
const api = async (p, path) => (await (await p.ctx.request.get("/api/crm" + path, { headers: { "x-crm": "1" } })).json()).data;
const post = async (p, path, data = {}) => (await p.ctx.request.post("/api/crm" + path, { headers: { "x-crm": "1", "content-type": "application/json" }, data })).json();

// The customer's pages have no #view: the same checks over their main.
const portalProblems = (page) => page.evaluate(() => {
  const out = [];
  if (document.documentElement.scrollWidth > innerWidth + 1) out.push(`scrolls sideways (${document.documentElement.scrollWidth} > ${innerWidth})`);
  for (const el of document.querySelectorAll("main a, main button, main input:not([type=checkbox]):not([type=radio]), main textarea")) {
    const r = el.getBoundingClientRect();
    if (!r.width || !r.height || el.closest("[hidden]")) continue;
    const box = el.closest("label") ? el.closest("label").getBoundingClientRect() : r;
    if (box.height < 43.5 || box.width < 43.5) out.push(`small tap target ${el.tagName.toLowerCase()} "${(el.textContent || el.name || "").trim().slice(0, 24)}" ${Math.round(box.width)}x${Math.round(box.height)}`);
  }
  for (const i of document.querySelectorAll("main input:not([type=checkbox]):not([type=radio]), main textarea")) {
    if (i.offsetParent && parseFloat(getComputedStyle(i).fontSize) < 16) out.push(`input under 16 px: ${i.name}`);
  }
  return out;
});

for (const device of ["iphone13", "iphonese"]) {
  test(`money (${device}): Invoices, an invoice, a check recorded, the card charged, a refund, a new invoice, Payments, Autopay, the contact's Money tab, Settings`, async () => {
    const { p, page, f } = await open("olive", device);
    try {
      // the Menu has its Money section
      await goTo(f, "/menu");
      assert.match(await f.textContent("#view"), /Money[\s\S]*Invoices[\s\S]*Payments[\s\S]*Autopay/);

      await goTo(f, "/invoices");
      assert.equal(await title(f), "Invoices");
      const list = await f.textContent("#view");
      assert.match(list, /waiting to be paid/);
      assert.match(list, /Marlow Moneyfolk/);
      assert.match(list, /Indigo Moneyfolk[\s\S]*Overdue/);
      assert.match(list, /Robin Moneyfolk/, "Rotor's own open invoice is listed");
      assert.doesNotMatch(list, /Onyx Moneyfolk/, "a draft isn't under Open");
      assert.deepEqual(await screenProblems(f), [], "Invoices passes the phone checks");
      assert.deepEqual(await badLinks(f), []);
      await shot(page, `money-invoices-${device}`);
      await f.click("[data-chip=overdue]");
      await f.waitForFunction(() => !/Marlow Moneyfolk/.test(document.getElementById("view").textContent), null, { timeout: 5000 });
      assert.match(await f.textContent("#view"), /Indigo Moneyfolk/);
      await f.click("[data-chip=draft]");
      await viewHas(f, /Onyx Moneyfolk/);
      await f.click("[data-chip=open]");
      await viewHas(f, /Marlow Moneyfolk/);
      await f.fill("[data-q]", "indigo");
      await f.waitForFunction(() => !/Marlow Moneyfolk/.test(document.getElementById("view").textContent), null, { timeout: 5000 });
      await f.fill("[data-q]", "");

      // one invoice: record a check for part of it
      const fresh = (await post(p, "/invoices", { contact_id: M.contacts.open, lines: [{ description: "Exterior window cleaning", unit_cents: 29500 }], issue: true, use_credit: false })).data.invoice;
      await goTo(f, `/invoices/${fresh.id}`);
      assert.match(await title(f), /^SINV-\d{4}$/);
      let text = await f.textContent("#view");
      assert.match(text, /Marlow Moneyfolk/);
      assert.match(text, /\$295\.00/);
      assert.match(text, /No card on file/);
      assert.deepEqual(await screenProblems(f), [], "an invoice passes the phone checks");
      assert.deepEqual(await badLinks(f), []);
      await shot(page, `money-invoice-${device}`);
      await f.click("[data-act=record]");
      await sheetUp(f, /Record a payment/);
      assert.deepEqual(await screenProblems(f), [], "the payment sheet passes the phone checks");
      await shot(page, `money-record-${device}`);
      await f.fill(".sheet.on input[name=amount]", "100");
      await f.fill(".sheet.on input[name=reference]", "1042");
      await f.click(".sheet.on [type=submit]");
      await sheetGone(f);
      await viewHas(f, /Part paid/);
      text = await f.textContent("#view");
      assert.match(text, /\$195\.00/);
      assert.match(text, /Check · 1042/);
      // send it: a sheet with text and email; in dry run it lands in the Outbox
      await f.click("[data-act=send]");
      await sheetUp(f, /Send it again/);
      assert.match(await f.textContent(".sheet.on"), /still practice: this lands in the Outbox/);
      await f.click(".sheet.on [type=submit]");
      await sheetGone(f);

      // the test contact's invoice: the card on file is charged (practice money), then part of it refunded
      const mine = (await post(p, "/invoices", { contact_id: M.contacts.test, lines: [{ description: "Exterior window cleaning", unit_cents: 24500 }], issue: true, use_credit: false })).data.invoice;
      await goTo(f, `/invoices/${mine.id}`);
      assert.match(await f.textContent("#view"), /VISA ending 4242 · On file/);
      await f.click("[data-act=charge]");
      await sheetUp(f, /Charge the card/);
      assert.match(await f.textContent(".sheet.on"), /Charge \$245\.00 to the VISA ending 4242\?[\s\S]*practice mode/);
      await f.click(".sheet.on [data-a=yes]");
      await viewHas(f, /Paid/, 30000);
      await f.waitForSelector("[data-refund]", { timeout: 15000 });
      text = await f.textContent("#view");
      assert.match(text, /Card ending 4242[\s\S]*test/);
      await shot(page, `money-invoice-paid-${device}`);
      await f.click("[data-refund]");
      await sheetUp(f, /Refund/);
      assert.deepEqual(await screenProblems(f), [], "the refund sheet passes the phone checks");
      await f.fill(".sheet.on input[name=amount]", "45");
      await f.fill(".sheet.on input[name=reason]", "Two panes missed");
      await f.click(".sheet.on [type=submit]");
      await sheetGone(f);
      await viewHas(f, /Refund/);
      assert.match(await f.textContent("#view"), /−\$45\.00/);

      // Rotor's own invoice: shown, and nothing online is offered for it
      await goTo(f, `/invoices/${M.invoices.rotor}`);
      text = await f.textContent("#view");
      assert.match(text, /still Rotor's until the switch/);
      assert.equal(await f.$$eval("[data-act]", (els) => els.length), 0, "read here, changed in Rotor: no buttons");
      await shot(page, `money-invoice-rotor-${device}`);

      // a new invoice for a customer: two lines, the total follows, saved as a draft
      await goTo(f, `/invoices/new/${seeded.contacts.customer}`);
      assert.equal(await title(f), "New invoice");
      await f.fill("[data-line='0'] [data-desc]", "Screen repair");
      await f.fill("[data-line='0'] [data-price]", "60");
      await f.click("[data-add]");
      await f.fill("[data-line='1'] [data-desc]", "Track cleaning");
      await f.fill("[data-line='1'] [data-price]", "45.50");
      await f.waitForFunction(() => /\$105\.50/.test(document.querySelector("[data-total]").textContent));
      assert.deepEqual(await screenProblems(f), [], "New invoice passes the phone checks");
      await shot(page, `money-new-${device}`);
      await f.click("[data-go=draft]");
      await f.waitForFunction(() => /^#\/invoices\/in_[0-9a-z]{20}$/.test(location.hash), null, { timeout: 15000 });
      await settled(f);
      text = await f.textContent("#view");
      assert.match(text, /Draft/);
      assert.match(text, /\$105\.50/);
      assert.ok(await f.$("[data-act=send]"), "Send to the customer");

      await goTo(f, "/payments");
      assert.equal(await title(f), "Payments");
      text = await f.textContent("#view");
      assert.match(text, /November 2026/);
      assert.match(text, /came in \(after refunds\)/);
      assert.match(text, /Sage Moneyfolk/);
      assert.match(text, /practice payments? \(marked "test"\)/);
      assert.deepEqual(await screenProblems(f), [], "Payments passes the phone checks");
      assert.deepEqual(await badLinks(f), []);
      await shot(page, `money-payments-${device}`);
      await f.click("[data-month='-1']");
      await viewHas(f, /October 2026/);
      assert.match(await f.textContent("#view"), /No payments this month/);

      await goTo(f, "/autopay");
      assert.equal(await title(f), "Autopay");
      text = await f.textContent("#view");
      assert.match(text, /December 2026/);
      assert.match(text, /What the 1st would bill/);
      assert.deepEqual(await screenProblems(f), [], "Autopay passes the phone checks");
      await shot(page, `money-autopay-${device}`);
      await goTo(f, `/autopay/${M.autopay}`);
      assert.match(await title(f), /Autopay/);
      assert.deepEqual(await screenProblems(f), []);

      // the contact's Money tab
      await goTo(f, `/contacts/${M.contacts.test}`);
      await f.click("[data-tab=money]");
      await viewHas(f, /Card on file/);
      text = await f.textContent("#view");
      assert.match(text, /open balance/);
      assert.match(text, /VISA ending 4242/);
      assert.match(text, /New invoice/);
      assert.deepEqual(await screenProblems(f), [], "the Money tab passes the phone checks");
      await shot(page, `money-contact-tab-${device}`);
      await f.click("[data-mn-credit]");
      await sheetUp(f, /Add account credit/);
      assert.deepEqual(await screenProblems(f), [], "the credit sheet passes the phone checks");
      await f.fill(".sheet.on input[name=amount]", "25");
      await f.fill(".sheet.on input[name=note]", "Sorry for the wait");
      await f.click(".sheet.on [type=submit]");
      await sheetGone(f);
      await viewHas(f, /Sorry for the wait/);
      assert.match(await f.textContent("#view"), /\$\d+\.00\s*account credit/);

      // Settings → Payments: the mode, plainly; live can't be picked while Rotor is in charge
      await goTo(f, "/settings/payments");
      assert.equal(await title(f), "Payments");
      text = await f.textContent("#view");
      assert.match(text, /Dry run/);
      assert.match(text, /Nothing is charged/);
      assert.match(text, /Rotor is still in charge of billing/);
      assert.equal(await f.$eval("[data-mode=live]", (b) => b.disabled), true);
      assert.match(text, /STRIPE_SECRET_KEY[\s\S]*not set/);
      assert.deepEqual(await screenProblems(f), [], "Settings → Payments passes the phone checks");
      await shot(page, `money-settings-${device}`);
      await f.click("[data-mode=test]");
      await sheetUp(f, /Switch payments to Test/);
      await f.click(".sheet.on [data-a=yes]");
      await f.waitForFunction(() => [...document.querySelectorAll(".toast")].some((x) => /no test Stripe key yet/.test(x.textContent)), null, { timeout: 5000 });
      assert.equal((await api(p, "/money/status")).mode, "dry_run");

      // Home: the money this month only (what's owed is on Invoices; past due lights the tab's dot)
      await goTo(f, "/today");
      await viewHas(f, /Money this month/);
      assert.doesNotMatch(await f.textContent("#view"), /owed to you|Invoices past due/);
      await shot(page, `money-home-${device}`);
      await p.clean();
    } finally { await p.close(); }
  });

  test(`money (${device}): a tech collects on their own visit (cash, or the QR for the customer's phone) and sees none of the money screens`, async () => {
    const { p, page, f } = await open("theo", device);
    try {
      await goTo(f, "/menu");
      assert.doesNotMatch(await f.textContent("#view"), /Invoices|Payments|Autopay/);
      await goTo(f, "/invoices");
      assert.doesNotMatch(await f.textContent("#view"), /Moneyfolk/, "the Invoices screen isn't a tech's");
      await goTo(f, `/visits/${M.visits.collects[device]}`);
      await f.waitForSelector("[data-vact='money.collect']", { timeout: 10000 });
      assert.deepEqual(await screenProblems(f), [], "the visit with Collect payment passes the phone checks");
      await f.click("[data-vact='money.collect']");
      await sheetUp(f, /Collect payment/);
      let sheet = await f.textContent(".sheet.on");
      assert.match(sheet, /Needs signal: a payment is never saved for later/);
      assert.deepEqual(await screenProblems(f), [], "the Collect payment sheet passes the phone checks");
      await shot(page, `money-collect-${device}`);
      // the QR: a pay link the customer scans (the invoice is made for it)
      await f.click(".sheet.on [data-qr]");
      await f.waitForSelector(".sheet.on .mn-qr svg", { timeout: 15000 });
      sheet = await f.textContent(".sheet.on");
      assert.match(sheet, /\$2[57][05]\.00 · SINV-\d{4}/, "what's left on the visit (less any account credit the customer had)");
      const box = await f.$eval(".sheet.on .mn-qr svg", (s) => { const b = s.getBoundingClientRect(); return { w: b.width, h: b.height, vw: innerWidth }; });
      assert.ok(box.w >= 200 && Math.abs(box.w - box.h) < 1 && box.w <= box.vw, `a square code big enough to scan (${JSON.stringify(box)})`);
      assert.deepEqual(await screenProblems(f), [], "the QR sheet passes the phone checks");
      await shot(page, `money-collect-qr-${device}`);
      await f.click(".sheet.on [data-check]");
      await f.waitForFunction(() => [...document.querySelectorAll(".toast")].some((x) => /Not yet/.test(x.textContent)), null, { timeout: 5000 });
      await f.click(".sheet.on [data-back]");
      await f.waitForSelector(".sheet.on [data-collect]", { timeout: 5000 });
      // cash for what's left (already filled in), with a tip
      assert.match(await f.inputValue(".sheet.on input[name=amount]"), /^2[57][05]\.00$/);
      await f.fill(".sheet.on input[name=tip]", "20");
      await f.click(".sheet.on [type=submit]");
      await sheetGone(f);
      await f.waitForFunction(() => [...document.querySelectorAll(".toast")].some((x) => /Recorded\. The visit is paid\./.test(x.textContent)), null, { timeout: 10000 });
      // tapping it again: nothing left to collect
      await f.waitForSelector("[data-vact='money.collect']", { timeout: 10000 });
      await f.click("[data-vact='money.collect']");
      await sheetUp(f, /Collect payment/);
      assert.match(await f.textContent(".sheet.on"), /This visit is paid/);
      await closeSheet(f);
      await p.clean();
    } finally { await p.close(); }
  });

  test(`money (${device}): the customer pays an invoice from its link with a tip, through the practice Checkout; the card page`, async () => {
    const p = await phone(browser, srv, { device });
    const page = p.page;
    try {
      // the link in the invoice text (each phone size has its own invoice to pay)
      const res = await page.goto(M.portal.invoices[device]);
      assert.equal(res.status(), 200);
      await page.waitForURL(/\/p\/invoice\/in_/, { timeout: 10000 });
      await page.waitForSelector("[data-pay-btn]", { timeout: 10000 });
      let text = await page.textContent("main");
      assert.match(text, /Terry, here's your invoice/);
      assert.match(text, /Test mode: nothing is really charged/);
      assert.match(text, /Add a tip for the crew\?/);
      assert.deepEqual(await portalProblems(page), [], "the invoice page passes the phone checks");
      await shot(page, `money-portal-invoice-${device}`);
      const paidAlready = /Paid in full/.test(text);
      assert.equal(paidAlready, false);
      const before = await page.textContent("[data-paytotal]");
      await page.click("label.tip:has(input[value='15'])");
      await page.waitForFunction((b) => document.querySelector("[data-paytotal]").textContent !== b, before);
      const total = await page.textContent("[data-paytotal]");
      assert.match(await page.textContent("[data-pay-btn]"), new RegExp(`Pay \\${total.replace(/[.$]/g, "\\$&").slice(1)}`));
      // a custom tip: its field appears, 16 px, and is counted
      await page.click("label.tip:has(input[value='custom'])");
      await page.waitForSelector("[data-custom]:not([hidden])");
      await page.fill("input[name=custom_tip]", "12.50");
      assert.deepEqual(await portalProblems(page), [], "the tip field passes the phone checks");
      await page.click("label.tip:has(input[value='15'])");
      await shot(page, `money-portal-tip-${device}`);
      await page.click("[data-pay-btn]");
      await page.waitForURL(/\/p\/dry-checkout\/dry_cs_/, { timeout: 15000 });
      await page.waitForSelector("[data-dry-act=pay]", { timeout: 10000 });
      assert.match(await page.textContent("main"), /Test checkout\. This stands in for Stripe/);
      assert.deepEqual(await portalProblems(page), [], "the practice Checkout passes the phone checks");
      await shot(page, `money-portal-checkout-${device}`);
      await page.click("[data-dry-act=decline]");
      await page.waitForFunction(() => { const e = document.querySelector("[data-error]"); return e && !e.hidden && /declined/.test(e.textContent); }, null, { timeout: 10000 });
      await page.click("[data-dry-act=pay][data-method=card]");
      await page.waitForURL(/\/p\/return\?cs=/, { timeout: 15000 });
      await page.waitForFunction(() => /Paid\. Thank you!|Thank you/.test(document.querySelector("main").textContent), null, { timeout: 10000 });
      assert.deepEqual(await portalProblems(page), [], "the return page passes the phone checks");
      await shot(page, `money-portal-paid-${device}`);
      // back on the invoice: paid, with a receipt to open
      await page.click("main a[href^='/p/invoice/']");
      await page.waitForFunction(() => /Paid in full/.test(document.querySelector("main").textContent), null, { timeout: 10000 });
      text = await page.textContent("main");
      assert.match(text, /includes a \$\d+\.\d\d tip/);
      await page.click("main a[href*='/receipt/']");
      await page.waitForFunction(() => /Receipt/.test(document.querySelector("main").textContent), null, { timeout: 10000 });
      assert.match(await page.textContent("main"), /Tip for the crew/);
      assert.deepEqual(await portalProblems(page), [], "the receipt passes the phone checks");
      await shot(page, `money-portal-receipt-${device}`);
      assert.deepEqual(p.outside, [], "nothing asked another site for anything (no Stripe in dry run)");
      await p.clean();
    } finally { await p.close(); }
    // the card page, from its own link
    const c = await phone(browser, srv, { device });
    try {
      await c.page.goto(M.portal.card);
      await c.page.waitForURL(/\/p\/card$/, { timeout: 10000 });
      await c.page.waitForSelector("[data-card-btn]", { timeout: 10000 });
      assert.match(await c.page.textContent("main"), /Update your card|a card/);
      assert.deepEqual(await portalProblems(c.page), [], "the card page passes the phone checks");
      await shot(c.page, `money-portal-card-${device}`);
      await c.page.click("[data-card-btn]");
      await c.page.waitForURL(/\/p\/dry-checkout\/dry_cs_/, { timeout: 15000 });
      await c.page.click("[data-dry-act=pay][data-method=card]");
      await c.page.waitForURL(/\/p\/return\?cs=/, { timeout: 15000 });
      await c.page.waitForFunction(() => /You're all set/.test(document.querySelector("main").textContent), null, { timeout: 10000 });
      await c.clean();
    } finally { await c.close(); }
  });
}

test("money on a desk: the list with the invoice beside it", async () => {
  const p = await phone(browser, srv, { device: "desk1440" });
  try {
    await signIn(p, "olive");
    await p.page.goto("/office");
    const f = await crmFrame(p.page);
    await settled(f);
    await goTo(f, "/invoices");
    await f.click(`a[href="#/invoices/${M.invoices.overdue}"]`);
    await settled(f, { hash: `#/invoices/${M.invoices.overdue}` });
    const both = await f.evaluate(() => { const v = document.getElementById("view"), pn = document.getElementById("pane"); return { list: /waiting to be paid/.test(v.textContent), pane: !!pn && !pn.hidden && /Gutter cleaning/.test(pn.textContent) }; });
    assert.deepEqual(both, { list: true, pane: true }, "the list stays, the invoice opens beside it");
    assert.deepEqual(await screenProblems(f), []);
    await shot(p.page, "money-desk-split");
    await p.clean();
  } finally { await p.close(); }
});
