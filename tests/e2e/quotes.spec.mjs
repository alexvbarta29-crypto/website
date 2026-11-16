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
      assert.match(await title(f), /^Quote SQ-\d{4}$/, "a quote is titled with its number (shadow numbers before cutover)");
      assert.match(await f.textContent("#view"), /What the customer sees \(version 1\)/);
      assert.ok(await f.$(".qt-top [data-act=send]") && await f.$(".qt-top [data-act=present]"), "Send again and Present on the top card");
      assert.deepEqual(await f.$$eval("#top-act .rnd", (els) => els.map((e) => e.getAttribute("aria-label"))), ["Edit the quote", "More"]);
      assert.deepEqual(await screenProblems(f), [], "a quote passes the phone checks");
      assert.deepEqual(await badLinks(f), [], "the customer view opens in a new tab");
      await shot(page, `quotes-view-${device}`);
      await f.click("[data-seg=quote][data-key=activity]");
      await f.waitForFunction(() => /What happened[\s\S]*Versions/.test(document.getElementById("view").textContent), null, { timeout: 5000 });
      assert.deepEqual(await screenProblems(f), [], "Activity passes the phone checks");
      await f.click("[data-seg=quote][data-key=options]");
      // the round ... holds the rest, each row with its old data-* hook
      await f.click("#top-more");
      await sheetUp(f, /Quote SQ-/);
      for (const hook of ["phone", "edit", "duplicate", "preview", "decline", "archive"]) assert.ok(await f.$(`.sheet.on [data-act=${hook}]`), `... has ${hook}`);
      assert.deepEqual(await screenProblems(f), [], "the ... sheet passes the phone checks");
      await shot(page, `quotes-more-${device}`);
      await f.click(".sheet.on [data-sheet-x]");
      await sheetGone(f);

      // New quote (Flyra's New Estimate sheet): the customer and their property, a line from the
      // price book, a second option as a plan with its own discount; "Measure and price" opens the builder
      await goTo(f, `/quotes/new/${seeded.contacts.first}`);
      assert.equal(await title(f), "New quote");
      await f.waitForSelector("#qt-new [data-cf-prop]");
      assert.equal(await f.$eval("#qt-new [data-cf-create]", (b) => b.disabled), true, "Create waits for a line item");
      await f.click('[data-cf-addline="0"]');
      await f.waitForSelector(".sheet.on [data-top=measure]");
      await f.click(".sheet.on [data-top=custom]");
      await f.waitForSelector(".sheet.on [data-cf-line]");
      await f.fill(".sheet.on [name=title]", "Gutter cleaning");
      await f.fill(".sheet.on [name=unit]", "180");
      await f.click(".sheet.on [data-cf-line] [type=submit]");
      await sheetGone(f);
      await f.click("[data-cf-addopt]");
      await f.click('[data-cf-otype="1"]');
      await f.waitForSelector('.sheet.on [data-pick="\\"quarterly\\""]');
      await f.click('.sheet.on [data-pick="\\"quarterly\\""]');
      await sheetGone(f);
      await f.waitForFunction(() => /Quarterly plan discount/.test(document.getElementById("view").textContent));
      assert.deepEqual(await screenProblems(f), [], "New Estimate passes the phone checks");
      await shot(page, `quotes-new-${device}`);
      await f.click("[data-cf-measure]");
      await sheetUp(f, /Measure and price/);
      await f.click(".sheet.on [data-a=yes]");
      await f.waitForFunction(() => /^#\/quotes\/measure\//.test(location.hash), null, { timeout: 5000 });
      await settled(f);
      // the builder: count panes, interior, Price it, save
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
      assert.equal(await f.$eval("[data-seg=qb][aria-selected=true]", (el) => el.dataset.key), "price", "Price it moves to Price");
      assert.match(await f.textContent("#view"), /\$295\.00/, "31 panes: the 21-40 tier");
      assert.deepEqual(await screenProblems(f), [], "the builder passes the phone checks");
      await shot(page, `quotes-builder-${device}`);
      await f.click("[data-seg=qb][data-key=extras]");
      await f.waitForSelector("[data-f=client_notes]", { timeout: 5000 });
      assert.deepEqual(await screenProblems(f), [], "Extras passes the phone checks");
      await f.click("[data-save]");
      await f.waitForFunction(() => /^#\/quotes\/qt_[0-9a-z]{20}$/.test(location.hash), null, { timeout: 5000 });
      await settled(f);
      assert.match(await title(f), /^Quote SQ-\d{4}$/);

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
    // the office sees it approved in person; with Scheduling merged, a one-time
    // option becomes a job right away (auto_convert), so it may read converted
    const q = await (await p.ctx.request.get(`/api/crm/quotes/${seeded.quotes.sent}`, { headers: { "x-crm": "1" } })).json();
    assert.ok(["approved", "converted"].includes(q.data.quote.status), q.data.quote.status);
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

// Estimate templates and the automatic lights mockup (the owner, Nov 16).
// Street View and Claude are mocked in the browser (the app's own two
// routes): the photo is a synthetic house drawn on a canvas; the lines are
// what the model would answer. The bulbs, the dusk look and Save are real.
async function syntheticHouse(page) {
  const url = await page.evaluate(() => {
    const c = document.createElement("canvas");
    c.width = 640; c.height = 480;
    const x = c.getContext("2d");
    const sky = x.createLinearGradient(0, 0, 0, 300); sky.addColorStop(0, "#8fb3d9"); sky.addColorStop(1, "#d9e4ee");
    x.fillStyle = sky; x.fillRect(0, 0, 640, 480);
    x.fillStyle = "#6b8f4e"; x.fillRect(0, 380, 640, 100);
    x.fillStyle = "#c9b79c"; x.fillRect(110, 250, 420, 140);
    x.fillStyle = "#3d3a38"; x.beginPath(); x.moveTo(90, 252); x.lineTo(320, 130); x.lineTo(550, 252); x.closePath(); x.fill();
    x.fillStyle = "#f4f1ea"; x.fillRect(96, 250, 448, 7);
    x.fillStyle = "#5d7d8f"; for (const wx of [150, 250, 390, 460]) x.fillRect(wx, 285, 46, 56);
    x.fillStyle = "#7a4b2a"; x.fillRect(300, 300, 44, 90);
    x.fillStyle = "#2f5d34"; for (const [bx, r] of [[170, 26], [230, 22], [420, 26], [480, 22]]) { x.beginPath(); x.arc(bx, 382, r, 0, Math.PI * 2); x.fill(); }
    return c.toDataURL("image/jpeg", 0.9);
  });
  return Buffer.from(url.split(",")[1], "base64");
}
const MOCK_LINES = [
  { kind: "eave", points: [[96, 252], [544, 252]] },
  { kind: "rake", points: [[96, 252], [320, 132], [544, 252]] },
  { kind: "bush", points: [[146, 380], [170, 356], [196, 380], [170, 404]] },
  { kind: "bush", points: [[396, 380], [420, 356], [446, 380], [420, 404]] },
];
async function mockMockup(page, propertyId, jpeg, { source = "claude" } = {}) {
  const calls = { photo: 0, lines: 0 };
  await page.route("**/api/crm/lights-mockup/photo", (r) => { calls.photo += 1; return r.fulfill({ json: { ok: true, data: { photo: { url: `/api/crm/lights-mockup/${propertyId}/photo.jpg?v=e2e`, w: 640, h: 480, at: "e2e" } } } }); });
  await page.route(`**/api/crm/lights-mockup/${propertyId}/photo.jpg*`, (r) => r.fulfill({ body: jpeg, contentType: "image/jpeg" }));
  await page.route("**/api/crm/lights-mockup/lines", (r) => { calls.lines += 1; return r.fulfill({ json: { ok: true, data: source === "claude" ? { source, lines: MOCK_LINES, w: 640, h: 480 } : { source: "none", reason: "no_key", lines: [], w: 640, h: 480 } } }); });
  return calls;
}
const bulbsDrawn = (f) => f.waitForFunction(() => { const c = document.querySelector(".sheet.on [data-mk-canvas]"); return c && !c.hidden && Number(c.dataset.bulbs) > 40 ? Number(c.dataset.bulbs) : false; }, null, { timeout: 10000 }).then((h) => h.jsonValue());

for (const device of ["iphone13", "iphonese"]) {
  test(`quotes (${device}): Start from a template, then Mockup makes the lights mockup of the house`, async () => {
    const { p, page, f } = await open("olive", device);
    try {
      const jpeg = await syntheticHouse(page);
      const calls = await mockMockup(page, seeded.lightsHome.property, jpeg);
      await goTo(f, `/quotes/new/${seeded.lightsHome.contact}`);
      await f.waitForSelector("#qt-new [data-cf-tpl]");
      assert.equal(await f.$("#qt-new [data-cf-mockup-auto]"), null, "no Mockup chip before lights work");
      await f.click("#qt-new [data-cf-tpl]");
      await sheetUp(f, /Start from a template/);
      await f.waitForFunction(() => document.querySelectorAll(".sheet.on [data-pick]").length >= 10, null, { timeout: 5000 });
      const names = await f.$$eval(".sheet.on [data-pick] .nm", (els) => els.map((e) => e.textContent));
      assert.ok(names.includes("Exterior windows") && names.includes("Christmas lights: roofline") && names.includes("Lights takedown + storage"), names.join(", "));
      assert.match(await f.textContent(".sheet.on"), /Outside glass, sills and frames/, "each with its one line");
      assert.deepEqual(await screenProblems(f), [], "the template picker passes the phone checks");
      await shot(page, `quotes-template-picker-${device}`);
      for (const b of await f.$$(".sheet.on [data-pick]")) {
        const text = await b.textContent();
        if (text.includes("Christmas lights: roofline") && !text.includes("bushes")) { await b.click(); break; }
      }
      await f.waitForSelector("#qt-new [data-cf-mockup-auto]", { timeout: 5000 });
      const form = await f.textContent("#qt-new");
      assert.match(form, /Christmas lights: roofline/, "the template's name shows");
      assert.match(form, /Christmas Light Installation[\s\S]*Takedown and Storage/, "its lines fill the form");
      assert.match(form, /Option 2/, "both of its options");
      assert.equal(await f.$eval("#qt-new [data-cf-create]", (b) => b.disabled), false, "ready to create (the customer stayed)");
      assert.deepEqual(await screenProblems(f), [], "New Quote from a template passes the phone checks");

      await f.click("#qt-new [data-cf-mockup-auto]");
      await sheetUp(f, /Lights mockup/);
      const n = await bulbsDrawn(f);
      assert.ok(n > 40, `bulbs drawn: ${n}`);
      assert.equal(calls.photo, 1);
      assert.equal(calls.lines, 1);
      assert.deepEqual(await screenProblems(f), [], "the mockup sheet passes the phone checks");
      await shot(page, `quotes-mockup-${device}`);
      await f.click(".sheet.on [data-mk-color=multi]");
      await f.waitForFunction(() => document.querySelector(".sheet.on [data-mk-color=multi]").getAttribute("aria-pressed") === "true");
      await bulbsDrawn(f);
      await f.click(".sheet.on [data-mk-save]");
      await f.waitForFunction(() => /Saved/.test(document.querySelector(".sheet.on [data-mk-save]").textContent), null, { timeout: 5000 });
      await f.click(".sheet.on [data-sheet-x]");
      await sheetGone(f);
      assert.match(await f.textContent("#qt-new"), /Lights mockup/, "it goes on the quote with Create");
      await p.clean();
    } finally { await p.close(); }
  });
}

test("quotes: a lights quote's Mockup saves the picture to the quote; the edge finder steps in without Claude; Settings lists the templates", async () => {
  const { p, page, f } = await open("olive", "iphone13");
  try {
    const jpeg = await syntheticHouse(page);
    await mockMockup(page, seeded.lightsHome.property, jpeg, { source: "none" });
    await goTo(f, `/quotes/${seeded.quotes.lights}`);
    await f.waitForSelector(".qt-mk-card [data-act=mockup]");
    await f.click(".qt-mk-card [data-act=mockup]");
    await sheetUp(f, /Lights mockup/);
    await bulbsDrawn(f);
    assert.match(await f.textContent(".sheet.on [data-mk-note]"), /edge finder/, "drawn by the app's own edge finder, and it says so");
    await f.click(".sheet.on [data-mk-save]");
    await f.waitForFunction(() => /Saved/.test((document.querySelector(".sheet.on [data-mk-save]") || {}).textContent || ""), null, { timeout: 8000 });
    await f.click(".sheet.on [data-sheet-x]");
    await sheetGone(f);
    await f.waitForFunction(() => /1 on the quote/.test(document.getElementById("view").textContent), null, { timeout: 8000 });
    const q = await (await p.ctx.request.get(`/api/crm/quotes/${seeded.quotes.lights}`, { headers: { "x-crm": "1" } })).json();
    assert.equal(q.data.quote.mockup_file_ids.length, 1, "a mockup file on the quote (the customer sees it once sent)");

    await goTo(f, "/settings/estimate-templates");
    assert.equal(await title(f), "Estimate templates");
    assert.equal((await f.$$("#view .qt-tpl-row")).length, 10);
    assert.deepEqual(await screenProblems(f), [], "Estimate templates passes the phone checks");
    await shot(page, "quotes-estimate-templates-iphone13");
    await f.click("#view .qt-tpl-row:first-child a.row");
    await f.waitForSelector("[data-tpl-form]");
    assert.deepEqual(await screenProblems(f), [], "a template's page passes the phone checks");
    await p.clean();
  } finally { await p.close(); }
});
