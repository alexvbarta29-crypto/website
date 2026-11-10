// Phone checks of the quotes screens (M3a; design §9.2, §8.1, §12.4): the
// list, a sent quote, building one (count panes, services, Price it, save),
// sending it (dry-run: the Outbox), and Present to customer on the staff
// phone (pick an option, tick an add-on, sign with a finger, approve; the
// link works once), at iPhone 13 and iPhone SE sizes. `npm run e2e`.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { start } from "./server.mjs";
import { launch, phone, signIn, crmFrame, goTo, settled, title, badLinks, screenProblems, shot, noInstallCard } from "./kit.mjs";

let srv, browser, seeded;
before(async () => { srv = await start(); seeded = await srv.seed(); browser = await launch(); });
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
const sheetGone = async (f) => f.waitForFunction(() => !document.querySelector(".sheet"), null, { timeout: 5000 });

// The customer's page has no #view: the same checks over its main.
const portalProblems = (page) => page.evaluate(() => {
  const out = [];
  if (document.documentElement.scrollWidth > innerWidth + 1) out.push(`scrolls sideways (${document.documentElement.scrollWidth} > ${innerWidth})`);
  for (const el of document.querySelectorAll("main a, main button, main input:not([type=checkbox]):not([type=radio]), main textarea, main summary")) {
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
  test(`quotes (${device}): the list, a sent quote, build one, price it, save, send to the Outbox`, async () => {
    const { p, page, f } = await open("olive", device);
    try {
      await goTo(f, "/quotes");
      assert.equal(await title(f), "Quotes");
      assert.match(await f.textContent("#view"), /Quinn Talkedto/, "the sent quote is open");
      assert.deepEqual(await screenProblems(f), [], "the list passes the phone checks");
      await shot(page, `quotes-list-${device}`);

      await goTo(f, `/quotes/${seeded.quotes.sent}`);
      assert.match(await title(f), /^SQ-\d{4}$/, "a quote is titled with its number (shadow numbers before cutover)");
      assert.match(await f.textContent("#view"), /What the customer sees \(version 1\)/);
      assert.deepEqual(await screenProblems(f), [], "a quote passes the phone checks");
      assert.deepEqual(await badLinks(f), [], "the customer view opens in a new tab");
      await shot(page, `quotes-view-${device}`);

      // a new quote for a customer with a property: count panes, interior, Price it, save
      await goTo(f, `/quotes/new/${seeded.contacts.first}`);
      assert.equal(await title(f), "New quote");
      await f.click("[data-mode=panes]");
      await f.fill("[data-win=standard]", "30");
      await f.dispatchEvent("[data-win=standard]", "input");
      await f.click("[data-inc=french]");
      await f.click("[data-inc=french]");
      assert.equal((await f.textContent("[data-panes]")).trim(), "31", "30 standard + 2 French × 0.4, rounded up");
      await f.check("[data-svc=windows_int]");
      await f.click("[data-price]");
      await f.waitForFunction(() => document.querySelectorAll(".qb-lines li").length >= 2, null, { timeout: 5000 });
      assert.match(await f.textContent("#view"), /\$295\.00/, "31 panes: the 21-40 tier");
      assert.deepEqual(await screenProblems(f), [], "the builder passes the phone checks");
      await shot(page, `quotes-builder-${device}`);
      await f.click("[data-save]");
      await f.waitForFunction(() => /^#\/quotes\/qt_[0-9a-z]{20}$/.test(location.hash), null, { timeout: 5000 });
      await settled(f);
      assert.match(await title(f), /^SQ-\d{4}$/);

      // send: the dry-run Outbox
      await f.click("[data-act=send]");
      await sheetUp(f, /Send the quote/);
      assert.match(await f.textContent(".sheet"), /they land in the Outbox/);
      assert.deepEqual(await screenProblems(f), [], "the send sheet passes the phone checks");
      await shot(page, `quotes-send-${device}`);
      await f.click(".sheet [data-send] [type=submit]");
      await sheetGone(f);
      await f.waitForFunction(() => /Sent to the Outbox/.test((document.querySelector(".toasts") || {}).textContent || ""), null, { timeout: 5000 });
      await settled(f);
      assert.match(await f.textContent("#view"), /Sent/);
      await p.clean();
    } finally { await p.close(); }
  });
}

test("quotes: Present to customer on the staff phone: pick, tick an add-on, sign, approve; the link works once", async () => {
  const p = await phone(browser, srv, { device: "iphonese" });
  try {
    await signIn(p, "olive");
    const res = await p.ctx.request.post(`/api/crm/quotes/${seeded.quotes.sent}/present`, { headers: { "content-type": "application/json", "x-crm": "1" }, data: {} });
    assert.equal(res.status(), 200);
    const { url } = (await res.json()).data;
    assert.match(url, /^\/p\/present\/[0-9A-Za-z]+$/);
    const page = p.page;
    const first = await page.goto(url);
    assert.equal(first.status(), 200);
    assert.match(first.headers()["content-security-policy"] || "", /script-src 'self'/, "the portal CSP");
    assert.match(await page.textContent("h1"), /Hi Quinn, here's your quote/);
    assert.match(await page.textContent("body"), /Hand the phone to Quinn/);
    assert.deepEqual(await portalProblems(page), [], "the customer's page passes the phone checks");
    await shot(page, "quotes-present-top");
    // the one-time option, its add-on ticked: the price changes as they tick
    const data = JSON.parse(await page.getAttribute("[data-quote]", "data-quote"));
    const oneTime = data.options.find((o) => o.kind === "one_time").id;
    await page.click(`[data-option="${oneTime}"] input[name=option]`);
    const before = await page.textContent(`[data-price="${oneTime}"]`);
    await page.check(`[data-optline^="${oneTime}|"]`);
    const after_ = await page.textContent(`[data-price="${oneTime}"]`);
    assert.notEqual(before, after_, "ticking the add-on changes the price");
    await page.fill("input[name=name_typed]", "Quinn Talkedto");
    const pad = await page.$("[data-sig]");
    await pad.scrollIntoViewIfNeeded();
    const b = await pad.boundingBox();
    await page.mouse.move(b.x + 30, b.y + b.height * 0.6);
    await page.mouse.down();
    for (let i = 0; i <= 12; i++) await page.mouse.move(b.x + 30 + i * 18, b.y + b.height * (0.6 - 0.25 * Math.sin(i / 2)));
    await page.mouse.up();
    await page.check("input[name=agree]");
    await page.click("[data-approve]");
    await page.waitForSelector("[data-done]:not([hidden])", { timeout: 20000 });
    assert.match(await page.textContent("[data-done]"), /You're all set/);
    assert.equal(await page.$eval(`[data-optline^="${oneTime}|"]`, (i) => i.disabled), true, "the choice is locked once approved");
    await shot(page, "quotes-present-done");
    // the link works once
    const again = await page.goto(url);
    assert.equal(again.status(), 410);
    // the office sees it approved in person
    const q = await (await p.ctx.request.get(`/api/crm/quotes/${seeded.quotes.sent}`, { headers: { "x-crm": "1" } })).json();
    assert.equal(q.data.quote.status, "approved");
    assert.equal(q.data.quote.approval.method, "in_person");
    assert.equal(q.data.quote.approval.option_id, oneTime);
    await p.clean();
  } finally { await p.close(); }
});

test("quotes: not for a tech", async () => {
  const { p, f } = await open("theo", "iphonese");
  try {
    for (const path of ["/quotes", `/quotes/${seeded.quotes.sent}`, `/quotes/new/${seeded.contacts.first}`, "/settings/pricing"]) {
      await goTo(f, path);
      assert.match(await f.textContent("#view"), /Not for this login/, `${path} is not for a tech`);
    }
    const r = await p.ctx.request.get("/api/crm/quotes", { headers: { "x-crm": "1" } });
    assert.equal(r.status(), 403);
    await p.clean();
  } finally { await p.close(); }
});
