// Phone checks of the money screens (M5; design §9.2, §8.1, §12.4):
// Invoices, an invoice as Rotor's phone invoice (edit it, Rotor's payment
// sheet: Tap to Pay explained, a check recorded, the card on file charged,
// a pay link sent, a refund), Flyra's New Invoice and Checkout (with a tip),
// Payments, Autopay, the contact's Money tab, Settings →
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
// (the top sheet: a sheet may open over the invoice editor)
const sheetUp = (f, re) => f.waitForFunction((src) => { const all = document.querySelectorAll(".sheet.on h2"); const h = all[all.length - 1]; return !!h && new RegExp(src).test(h.textContent); }, re.source, { timeout: 5000 });
const sheetGone = (f) => f.waitForFunction(() => !document.querySelector(".sheet"), null, { timeout: 5000 });
const closeSheet = async (f) => { await f.click(".sheet.on [data-sheet-x]"); await sheetGone(f); };
const toastHas = (f, re) => f.waitForFunction((src) => [...document.querySelectorAll(".toast")].some((x) => new RegExp(src).test(x.textContent)), re.source, { timeout: 10000 });
// Rotor's phone invoice: the editor full screen (a phone) or a dialog (a desk), with the invoice's number in its title
const editorUp = async (f, number) => {
  await f.waitForFunction((n) => { const s = document.querySelector(".mn-edsheet.on"); return !!s && s.querySelector(".sheet-head h2").textContent === `Invoice #${n}` && !!s.querySelector(".mn-ed"); }, number, { timeout: 10000 });
  await f.waitForTimeout(320);          // (the sheet slides up)
};
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
      // the Menu page: the Invoices tile, Money's Payments, and Financials' Autopay run under More screens
      await goTo(f, "/menu");
      assert.match(await f.textContent("#view"), /Invoices[\s\S]*Money[\s\S]*Payments[\s\S]*More screens[\s\S]*Financials[\s\S]*Autopay/);

      await goTo(f, "/invoices");
      assert.equal(await title(f), "Invoices");
      const list = await f.textContent("#view");
      assert.match(list, /Paid this month[\s\S]*Due today[\s\S]*Outstanding[\s\S]*Overdue/, "the tiles in Rotor's order (the Rotor guide's FI1)");
      assert.match(list, /Marlow Moneyfolk/);
      assert.match(list, /Indigo Moneyfolk[\s\S]*Overdue/);
      assert.match(list, /Robin Moneyfolk/, "Rotor's own open invoice is listed");
      assert.doesNotMatch(list, /Onyx Moneyfolk/, "a draft isn't under Open");
      assert.deepEqual(await screenProblems(f), [], "Invoices passes the phone checks");
      assert.deepEqual(await badLinks(f), []);
      await shot(page, `money-invoices-${device}`);
      await f.click('[data-tile="inv"][data-key="overdue"]');
      await f.waitForFunction(() => !/Marlow Moneyfolk/.test(document.getElementById("view").textContent), null, { timeout: 5000 });
      assert.match(await f.textContent("#view"), /Indigo Moneyfolk/);
      await f.click('[data-tile="inv"][data-key="draft"]');
      await viewHas(f, /Onyx Moneyfolk/);
      await f.click('[data-tile="inv"][data-key="open"]');
      await viewHas(f, /Marlow Moneyfolk/);
      // (on a phone the search waits behind the round search button)
      if (!(await f.isVisible("[data-q]"))) await f.click('#top-rnd [data-own="find"]');
      await f.fill("[data-q]", "indigo");
      await f.waitForFunction(() => !/Marlow Moneyfolk/.test(document.getElementById("view").textContent), null, { timeout: 5000 });
      await f.fill("[data-q]", "");
      await viewHas(f, /Marlow Moneyfolk/);

      // one invoice, Rotor's phone invoice: full screen, its cards in Rotor's order, Save | Payment at the foot
      const fresh = (await post(p, "/invoices", { contact_id: M.contacts.open, lines: [{ description: "Exterior window cleaning", unit_cents: 29500 }], issue: true, use_credit: false })).data.invoice;
      await goTo(f, `/invoices/${fresh.id}`);
      await editorUp(f, fresh.number);
      let text = await f.textContent(".sheet.on");
      assert.match(text, /Bill To[\s\S]*Marlow Moneyfolk[\s\S]*Invoice Details[\s\S]*Invoice number[\s\S]*Title[\s\S]*Due Date[\s\S]*Notes[\s\S]*Line Items[\s\S]*Summary[\s\S]*Total[\s\S]*\$295\.00/, "Rotor's cards in Rotor's order");
      assert.ok(await f.$(".sheet.on [data-ed-save]") && await f.$(".sheet.on [data-ed-pay]") && await f.$(".sheet.on [data-ed-bin]") && await f.$(".sheet.on [data-ed-x]"), "Save and Payment at the foot; the red bin and the X up top");
      const full = await f.evaluate(() => { const s = document.querySelector(".sheet.on"); const r = s.getBoundingClientRect(); return { top: Math.round(r.top), h: Math.round(r.height), vh: innerHeight }; });
      assert.deepEqual([full.top, full.h], [0, full.vh], "full screen, over the bar and the tabs");
      assert.deepEqual(await screenProblems(f), [], "the invoice editor passes the phone checks");
      await shot(page, `money-invoice-${device}`);
      // edit it: the title, a second line, a $10 discount from "+ Saved"; the totals follow; Save keeps it
      await f.fill(".sheet.on [name=title]", "Fall windows");
      await f.click(".sheet.on [data-ed-add]");
      await f.fill(".sheet.on .mn-ed-line[data-key]:nth-of-type(2) [data-l=description]", "Screen repair");
      await f.fill(".sheet.on .mn-ed-line[data-key]:nth-of-type(2) [data-l=price]", "40");
      await f.click(".sheet.on [data-ed-saved]");
      await sheetUp(f, /Saved items/);
      await f.locator(".sheet.on").last().locator("[data-pick]").first().click();
      await f.waitForSelector(".sheet.on .mn-ed-line[data-key]:nth-of-type(3) [data-l=price]");
      await f.fill(".sheet.on .mn-ed-line[data-key]:nth-of-type(3) [data-l=price]", "10");
      await f.waitForFunction(() => /\$325\.00/.test(document.querySelector(".sheet.on [data-sum=tot]").textContent));
      assert.match(await f.textContent(".sheet.on .mn-ed-line[data-key]:nth-of-type(3) .mn-ed-lt"), /−\$10\.00/, "a discount, in green");
      await shot(page, `money-invoice-edit-${device}`);
      await f.click(".sheet.on [data-ed-save]");
      await toastHas(f, /Saved/);
      let inv = (await api(p, `/invoices/${fresh.id}`)).invoice;
      assert.deepEqual([inv.title, inv.total_cents, inv.discount_cents, inv.lines.length], ["Fall windows", 32500, 1000, 3], "the server worked the total out");
      // Payment: Rotor's sheet. Tap to Pay says it isn't connected; Manual records a check for part of it
      await f.click(".sheet.on [data-ed-pay]");
      await f.waitForSelector(".mn-paysheet.on .mn-ps", { timeout: 5000 });
      text = await f.textContent(".mn-paysheet.on");
      assert.match(text, /Amount Due[\s\S]*\$325\.00[\s\S]*Tap to Pay on iPhone[\s\S]*Charge[\s\S]*Manual[\s\S]*Send/);
      assert.deepEqual(await screenProblems(f), [], "the payment sheet passes the phone checks");
      await shot(page, `money-payment-${device}`);
      await f.click(".mn-paysheet.on [data-pm=tap]");
      assert.match(await f.textContent(".mn-paysheet.on"), /The customer taps their card or phone on your device[\s\S]*needs Stripe Terminal/);
      assert.match(await f.textContent(".mn-paysheet.on [data-ps-go]"), /Start Tap to Pay on iPhone - \$325\.00/);
      await f.click(".mn-paysheet.on [data-ps-go]");
      await toastHas(f, /Tap to Pay isn't connected yet/);
      assert.ok(await f.$(".mn-paysheet.on .mn-ps"), "nothing started: the sheet stays");
      await f.click(".mn-paysheet.on [data-pm=manual]");
      await f.click(".mn-paysheet.on label:has(input[value=check])");
      await f.fill(".mn-paysheet.on input[name=amount]", "100");
      await f.fill(".mn-paysheet.on input[name=reference]", "1042");
      assert.match(await f.textContent(".mn-paysheet.on [data-ps-go]"), /Record payment - \$100\.00/);
      assert.deepEqual(await screenProblems(f), [], "Manual passes the phone checks");
      await f.click(".mn-paysheet.on [data-ps-go]");
      await f.waitForFunction(() => !document.querySelector(".mn-paysheet"), null, { timeout: 10000 });
      await f.waitForFunction(() => /Part paid/.test(document.querySelector(".mn-edsheet.on").textContent), null, { timeout: 10000 });
      text = await f.textContent(".mn-edsheet.on");
      assert.match(text, /Check · 1042/);
      assert.match(text, /Balance due\s*\$225\.00/);
      assert.match(text, /A payment is on this invoice/, "its money is fixed now, and it says why");
      assert.equal(await f.$(".mn-edsheet.on [data-l=price]"), null, "the lines are read-only");
      // Send: the pay link (texts are practice: the Outbox)
      await f.click(".sheet.on [data-ed-pay]");
      await f.waitForSelector(".mn-paysheet.on .mn-ps", { timeout: 5000 });
      await f.click(".mn-paysheet.on [data-pm=send]");
      assert.match(await f.textContent(".mn-paysheet.on"), /this lands in the Outbox/);
      await f.click(".mn-paysheet.on [data-ps-go]");
      await toastHas(f, /In the Outbox/);
      await f.click(".mn-edsheet.on [data-ed-x]");
      await f.waitForFunction(() => !document.querySelector(".mn-edsheet"), null, { timeout: 5000 });

      // the test contact's invoice: the card on file is charged from the payment sheet (practice money), then part of it refunded
      const mine = (await post(p, "/invoices", { contact_id: M.contacts.test, lines: [{ description: "Exterior window cleaning", unit_cents: 24500 }], issue: true, use_credit: false })).data.invoice;
      await goTo(f, `/invoices/${mine.id}`);
      await editorUp(f, mine.number);
      await f.click(".sheet.on [data-ed-pay]");
      await f.waitForSelector(".mn-paysheet.on .mn-ps", { timeout: 5000 });
      text = await f.textContent(".mn-paysheet.on");
      assert.match(text, /Charge the card on file[\s\S]*VISA ending 4242 · On file[\s\S]*practice/);
      assert.match(await f.textContent(".mn-paysheet.on [data-ps-go]"), /Charge card - \$245\.00/);
      await f.click(".mn-paysheet.on [data-ps-go]");
      await f.waitForFunction(() => /Paid/.test((document.querySelector(".mn-edsheet.on .mn-ed-pills") || {}).textContent || ""), null, { timeout: 30000 });
      await f.waitForSelector(".mn-edsheet.on [data-refund]", { timeout: 15000 });
      text = await f.textContent(".mn-edsheet.on");
      assert.match(text, /Card[\s\S]*test/);
      assert.match(text, /This invoice is paid/, "a paid invoice keeps its money, and says so");
      await shot(page, `money-invoice-paid-${device}`);
      await f.click(".mn-edsheet.on [data-refund]");
      await sheetUp(f, /Refund/);
      assert.deepEqual(await screenProblems(f), [], "the refund sheet passes the phone checks");
      await f.locator(".sheet.on").last().locator("input[name=amount]").fill("45");
      await f.locator(".sheet.on").last().locator("input[name=reason]").fill("Two panes missed");
      await f.locator(".sheet.on").last().locator("[type=submit]").click();
      await f.waitForFunction(() => /Refund/.test(document.querySelector(".mn-edsheet.on").textContent) && /−\$45\.00/.test(document.querySelector(".mn-edsheet.on").textContent), null, { timeout: 10000 });
      await f.click(".mn-edsheet.on [data-ed-x]");
      await f.waitForFunction(() => !document.querySelector(".mn-edsheet"), null, { timeout: 5000 });

      // Rotor's own invoice: shown, read-only, and nothing online is offered for it
      await goTo(f, `/invoices/${M.invoices.rotor}`);
      await f.waitForSelector(".sheet.on .mn-ed", { timeout: 10000 });
      text = await f.textContent(".sheet.on");
      assert.match(text, /still Rotor's until the switch/);
      assert.equal(await f.$$eval("[data-act]", (els) => els.length), 0, "read here, changed in Rotor: no buttons");
      assert.equal(await f.$(".sheet.on [data-ed-save]"), null);
      assert.equal(await f.$(".sheet.on [data-ed-pay]"), null);
      assert.equal(await f.$(".sheet.on [data-l]"), null);
      await shot(page, `money-invoice-rotor-${device}`);

      // New Invoice (Flyra's sheet): the customer, two lines and a discount, the total follows; Create Invoice makes a draft
      await goTo(f, `/invoices/new/${seeded.contacts.customer}`);
      await f.waitForSelector(".mn-nvsheet.on .mn-nv", { timeout: 10000 });
      assert.match(await f.textContent(".mn-nvsheet.on"), /New Invoice[\s\S]*Customer[\s\S]*Line items[\s\S]*Add line item[\s\S]*Add discount[\s\S]*Total[\s\S]*Salesperson[\s\S]*Olive[\s\S]*Notes[\s\S]*Create Invoice/);
      assert.equal(await f.$eval(".mn-nvsheet.on [data-go]", (b) => b.disabled), true, "off until there's a line with a price");
      await f.click(".mn-nvsheet.on [data-add]");
      await f.fill(".mn-nvsheet.on [data-line='0'] [data-desc]", "Screen repair");
      await f.fill(".mn-nvsheet.on [data-line='0'] [data-price]", "60");
      await f.click(".mn-nvsheet.on [data-add]");
      await f.fill(".mn-nvsheet.on [data-line='1'] [data-desc]", "Track cleaning");
      await f.fill(".mn-nvsheet.on [data-line='1'] [data-price]", "45.50");
      await f.click(".mn-nvsheet.on [data-add-disc]");
      await f.fill(".mn-nvsheet.on [data-line='2'] [data-price]", "5");
      await f.waitForFunction(() => /\$100\.50/.test(document.querySelector(".mn-nvsheet.on [data-total]").textContent));
      assert.deepEqual(await screenProblems(f), [], "New Invoice passes the phone checks");
      await shot(page, `money-new-${device}`);
      await f.click(".mn-nvsheet.on [data-go]");
      await f.waitForFunction(() => /^#\/invoices\/in_[0-9a-z]{20}$/.test(location.hash), null, { timeout: 15000 });
      await settled(f);
      await f.waitForSelector(".mn-edsheet.on .mn-ed", { timeout: 10000 });
      text = await f.textContent(".mn-edsheet.on");
      assert.match(text, /Draft/);
      assert.match(text, /\$100\.50/);
      assert.ok(await f.$(".mn-edsheet.on [data-ed-sent]"), "Mark as Sent");
      // Mark as Sent: open, nothing texted
      await f.click(".mn-edsheet.on [data-ed-sent]");
      await toastHas(f, /Nothing was sent/);
      await f.waitForFunction(() => !document.querySelector(".mn-edsheet.on [data-ed-sent]"), null, { timeout: 10000 });
      // its X goes back (to Rotor's invoice, the screen before it)
      const made = await f.evaluate(() => location.hash);
      await f.click(".mn-edsheet.on [data-ed-x]");
      await f.waitForFunction((h) => location.hash !== h, made, { timeout: 5000 });

      await goTo(f, "/payments");
      assert.equal(await title(f), "Payments");
      text = await f.textContent("#view");
      assert.match(text, /November 2026/);
      assert.match(text, /Total[\s\S]*Stripe[\s\S]*Cash & check[\s\S]*Tips/, "the tiles (the Rotor guide's FP1)");
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

      // the contact's Money section (an old Money tab link jumps to it)
      await goTo(f, `/contacts/${M.contacts.test}?tab=money`);
      await viewHas(f, /VISA ending in 4242/);
      text = await f.textContent("#view");
      assert.match(text, /Outstanding/, "the balance: the Service tab's numbers (Rotor's phone page)");
      assert.match(text, /Card · exp \d\d\/\d\d/, "the card on file (Rotor's Payment card)");
      assert.deepEqual(await screenProblems(f), [], "the Money tab passes the phone checks");
      await shot(page, `money-contact-tab-${device}`);
      // New invoice and Add credit: the red + (Rotor's)
      await f.click("[data-ct-fab]");
      await sheetUp(f, /New for/);
      assert.match(await f.textContent(".sheet.on"), /New invoice[\s\S]*Add credit[\s\S]*Text a card link/);
      await f.locator(".sheet.on").last().getByText("Add credit", { exact: true }).click();
      await sheetUp(f, /Add account credit/);
      assert.deepEqual(await screenProblems(f), [], "the credit sheet passes the phone checks");
      await f.fill(".sheet.on input[name=amount]", "25");
      await f.fill(".sheet.on input[name=note]", "Sorry for the wait");
      await f.click(".sheet.on [type=submit]");
      await sheetGone(f);
      await viewHas(f, /Sorry for the wait/);
      assert.match(await f.textContent("#view"), /Sorry for the wait[\s\S]*Available[\s\S]*\$25\.00/, "the credit, on their invoices card");

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

      // Home: the top (Nov 15, Flyra's: Revenue | ARR, Revenue first: Collected, its average a day and its peak); what's owed is on Invoices, past due lights the tab's dot
      await goTo(f, "/today");
      await viewHas(f, /Revenue[\s\S]*ARR/);
      await f.waitForSelector('.hm-money[data-view="revenue"]');
      await viewHas(f, /Collected[\s\S]*Avg[\s\S]*(Peak|Best week)/);
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
      assert.match(sheet, /\$2[57][05]\.00[\s\S]*Terry · SINV-\d{4}[\s\S]*Scan with your phone camera to pay/, "what's left on the visit (less any account credit the customer had), the first name, the words to scan");
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

// Rotor's phone invoice and payment sheet, and Flyra's Checkout, in the light theme (the money test above runs dark)
for (const device of ["iphone13", "iphonese"]) {
  test(`money (${device}, light): the invoice editor, the payment sheet, a 15% tip paid in cash on Manual`, async () => {
    const { p, page, f: f0 } = await open("olive", device);
    try {
      await f0.evaluate(() => localStorage.setItem("crm-theme", "light"));
      await page.reload();
      const f = await crmFrame(page);
      await settled(f);
      assert.equal(await f.evaluate(() => document.documentElement.dataset.theme), "light");
      const inv = (await post(p, "/invoices", { contact_id: M.contacts.test, lines: [{ description: "Quarterly window cleaning", unit_cents: 29500 }, { description: "Plan discount", unit_cents: 10000, kind: "discount" }], issue: false, use_credit: false })).data.invoice;
      await goTo(f, `/invoices/${inv.id}`);
      await editorUp(f, inv.number);
      assert.match(await f.textContent(".mn-edsheet.on"), /Draft[\s\S]*Mark as Sent[\s\S]*Bill To[\s\S]*Invoice Details[\s\S]*Line Items[\s\S]*Summary/);
      assert.deepEqual(await screenProblems(f), [], "the editor passes the phone checks (light)");
      await shot(page, `money-invoice-${device}-light`);
      // the number: Edit, a number another invoice has is refused there and then
      await f.click(".mn-edsheet.on [data-ed-num]");
      await f.fill(".mn-edsheet.on [name=number]", (await api(p, `/invoices/${M.invoices.rotor}`)).invoice.number);
      await f.click(".mn-edsheet.on [data-ed-save]");
      await f.waitForFunction(() => { const w = document.querySelector('.mn-edsheet.on [data-field="number"] .why'); return w && !w.hidden && /already another invoice's number|the CRM's own/.test(w.textContent); }, null, { timeout: 10000 });
      await f.fill(".mn-edsheet.on [name=number]", `BW-${device.toUpperCase()}`);
      await f.click(".mn-edsheet.on [data-ed-save]");
      await editorUp(f, `BW-${device.toUpperCase()}`);
      // Payment on a draft: marked sent first (nothing goes out), then Rotor's sheet
      await f.click(".mn-edsheet.on [data-ed-pay]");
      await sheetUp(f, /Take a payment/);
      await f.locator(".sheet.on").last().locator("[data-a=yes]").click();
      await f.waitForSelector(".mn-paysheet.on .mn-ps", { timeout: 10000 });
      assert.match(await f.textContent(".mn-paysheet.on"), /Amount Due[\s\S]*\$195\.00/);
      assert.deepEqual(await screenProblems(f), [], "the payment sheet passes the phone checks (light)");
      await shot(page, `money-payment-${device}-light`);
      // a tip (Flyra's Checkout is the job page's; on Rotor's sheet the tip rides on Manual or Charge): cash, $29.25 tip
      await f.click(".mn-paysheet.on [data-pm=manual]");
      await f.fill(".mn-paysheet.on input[name=tip]", "29.25");
      assert.match(await f.textContent(".mn-paysheet.on [data-ps-go]"), /Record payment - \$195\.00/);
      await f.click(".mn-paysheet.on [data-ps-go]");
      await toastHas(f, /Payment saved/);
      await f.waitForFunction(() => !document.querySelector(".mn-paysheet"), null, { timeout: 10000 });
      // the editor's "..." has no Checkout any more (Rotor's invoice: Payment is the way to take money)
      await f.click(".mn-edsheet.on [data-ed-more]");
      await sheetUp(f, new RegExp(`Invoice #BW-${device.toUpperCase()}`));
      assert.doesNotMatch(await f.textContent(".rs-actions.on"), /Checkout/);
      await f.locator(".sheet.on").last().locator("[data-sheet-x]").click();
      await f.waitForFunction(() => /Paid/.test((document.querySelector(".mn-edsheet.on .mn-ed-pills") || {}).textContent || ""), null, { timeout: 10000 });
      const pays = (await api(p, `/invoices/${inv.id}`)).payments;
      assert.deepEqual(pays.map((x) => [x.method, x.amount_cents, x.tip_cents]), [["cash", 19500, 2925]], "the tip rides on the payment");
      const text = await f.textContent(".mn-edsheet.on");
      assert.match(text, /Tips for the crew\s*\$29\.25/);
      await p.clean();
    } finally { await p.close(); }
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
    const both = await f.evaluate(() => { const v = document.getElementById("view"), pn = document.getElementById("pane"); return { list: /Overdue/.test(v.textContent), pane: !!pn && !pn.hidden && /Gutter cleaning/.test(pn.textContent) }; });
    assert.deepEqual(both, { list: true, pane: true }, "the list stays, the invoice opens beside it");
    assert.deepEqual(await screenProblems(f), []);
    await shot(p.page, "money-desk-split");
    // the desk keeps its two columns and gains the editor: the pencil opens it in a dialog
    assert.equal(await f.$(".mn-edsheet"), null, "a desk doesn't open the editor by itself");
    const inv = (await api(p, `/invoices/${M.invoices.overdue}`)).invoice;
    await f.click("[data-act=edit]");
    await editorUp(f, inv.number);
    const box = await f.evaluate(() => { const r = document.querySelector(".mn-edsheet.on").getBoundingClientRect(); return { w: Math.round(r.width), left: Math.round(r.left), vw: innerWidth }; });
    assert.ok(box.w <= 640 && box.left > 0, `a dialog in the middle (${JSON.stringify(box)})`);
    assert.deepEqual(await screenProblems(f), [], "the editor on a desk");
    await shot(p.page, "money-desk-editor");
    await f.fill(".mn-edsheet.on [name=title]", "Gutters, fall");
    await f.click(".mn-edsheet.on [data-ed-save]");
    await f.waitForFunction(() => [...document.querySelectorAll(".toast")].some((x) => /Saved/.test(x.textContent)), null, { timeout: 10000 });
    await f.click(".mn-edsheet.on [data-ed-x]");
    await f.waitForFunction(() => !document.querySelector(".mn-edsheet"), null, { timeout: 5000 });
    await f.waitForFunction(() => /Gutters, fall/.test(document.getElementById("pane").textContent), null, { timeout: 10000 });
    // Collect Payment: Rotor's payment sheet, a dialog on a desk
    await f.click("#pane [data-act=collect]");
    await f.waitForSelector(".mn-paysheet.on .mn-ps", { timeout: 5000 });
    assert.match(await f.textContent(".mn-paysheet.on"), /Amount Due[\s\S]*Tap to Pay on iPhone[\s\S]*Charge[\s\S]*Manual[\s\S]*Send/);
    assert.deepEqual(await screenProblems(f), [], "the payment sheet on a desk");
    await shot(p.page, "money-desk-payment");
    await f.click(".mn-paysheet.on [data-sheet-x]");
    await p.clean();
  } finally { await p.close(); }
});
