// Phone checks of the sales screens (M2b; design §12.4, §9.2): Leads &
// calls, logging a call, the text sent by hand while texting is in dry-run,
// one follow-up, Tasks (the office's and a tech's), at iPhone 13 and
// iPhone SE sizes. `npm run e2e`.
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

for (const device of ["iphone13", "iphonese"]) {
  test(`sales (${device}): Calls, log a call, send the text by hand`, async () => {
    const { p, page, f } = await open("olive", device);
    try {
      // (the follow-up call list is the Power Dialer's Queue tab now, its built-in Follow-up calls queue)
      await goTo(f, "/calls/queue");
      assert.equal(await title(f), "Queue");
      assert.deepEqual(await screenProblems(f), [], "the call list passes the phone checks");
      assert.deepEqual(await badLinks(f), []);
      await shot(page, `sales-calls-${device}`);
      // the fresh lead's first step is due now: Log → No answer → the text to send by hand
      const row = `[data-log="${seeded.enrollments.lead}"]`;
      if (device === "iphone13") {
        await f.click(row);
        await sheetUp(f, /How did it go/);
        assert.deepEqual(await screenProblems(f), [], "the outcome sheet passes the phone checks");
        await shot(page, `sales-outcome-${device}`);
        await f.click('.sheet [data-outcome="no_answer"]');
        await sheetUp(f, /Send this text yourself/);
        assert.match(await f.getAttribute(".sheet [data-sms]", "href"), /^sms:/, "Open in Messages is an sms: link (it stays in the frame)");
        assert.deepEqual(await screenProblems(f), [], "the hand-send sheet passes the phone checks");
        await shot(page, `sales-hand-${device}`);
        await f.click(".sheet [data-sent]");
        await sheetGone(f);
        await f.waitForFunction(() => /On to the next step/.test((document.querySelector(".toasts") || {}).textContent || ""));
      } else {
        // the second phone: No answer, then "Not yet": the text waits on the list
        await f.click(`[data-log="${seeded.enrollments.called}"]`);
        await sheetUp(f, /How did it go/);
        await f.click('.sheet [data-outcome="no_answer"]');
        await sheetUp(f, /Send this text yourself/);
        assert.deepEqual(await screenProblems(f), [], "the hand-send sheet passes the phone checks");
        await f.click(".sheet [data-later]");
        await sheetGone(f);
        await f.waitForSelector(`[data-pending="${seeded.enrollments.called}"]`, { timeout: 5000 });
        // "Did you send it?" from the list
        await f.click(`[data-pending="${seeded.enrollments.called}"]`);
        await f.waitForSelector(".sheet.on");
        assert.deepEqual(await screenProblems(f), [], "the pending sheet passes the phone checks");
        await f.click(".sheet [data-sent]");
        await sheetGone(f);
      }
      // one follow-up
      await goTo(f, `/enrollments/${seeded.enrollments.talked}`);
      assert.equal(await title(f), "Quinn Talkedto", "a follow-up is titled with its lead");
      assert.deepEqual(await screenProblems(f), [], "a follow-up passes the phone checks");
      assert.deepEqual(await badLinks(f), []);
      await shot(page, `sales-enrollment-${device}`);
      await p.clean();
    } finally { await p.close(); }
  });
}

test("sales: tasks for the office and for a tech", async () => {
  const { p, page, f } = await open("olive", "iphone13");
  try {
    await goTo(f, "/tasks");
    assert.equal(await title(f), "Tasks");
    assert.match(await f.textContent("#view"), /gutter add-on/);
    assert.deepEqual(await screenProblems(f), [], "Tasks passes the phone checks");
    await shot(page, "sales-tasks-owner");
    await p.clean();
  } finally { await p.close(); }
  const t = await open("theo", "iphonese");
  try {
    await goTo(t.f, "/tasks");
    const text = await t.f.textContent("#view");
    assert.match(text, /ladder hooks/, "the tech's own task");
    assert.doesNotMatch(text, /gutter add-on|Talkedto/, "never the office's tasks or their contacts");
    assert.deepEqual(await screenProblems(t.f), [], "a tech's Tasks passes the phone checks");
    await goTo(t.f, `/tasks/${seeded.tasks.tech}`);
    assert.equal(await title(t.f), "Task");
    await shot(t.page, "sales-task-tech");
    for (const path of ["/calls", "/settings/cadences", `/enrollments/${seeded.enrollments.lead}`]) {
      await goTo(t.f, path);
      assert.match(await t.f.textContent("#view"), /Not for this login/, `${path} is not for a tech`);
    }
    await t.p.clean();
  } finally { await t.p.close(); }
});

test("Leads: a lead's own priority (Rotor's High) is its tag and a filter", async () => {
  const { p, page, f } = await open("olive", "iphone13");
  try {
    // set it the way the lead page's "..." does (PATCH with the version)
    const res = await f.evaluate(async (id) => {
      const g = await fetch(`/api/crm/contacts/${id}`, { headers: { "x-crm": "1" } });
      const etag = g.headers.get("etag");
      const r = await fetch(`/api/crm/contacts/${id}`, { method: "PATCH", headers: { "x-crm": "1", "content-type": "application/json", "if-match": etag }, body: JSON.stringify({ priority: "high" }) });
      return r.status;
    }, seeded.contacts.called);
    assert.equal(res, 200);
    await goTo(f, "/leads");
    await f.waitForSelector(".sl-leads .rs-lrow");
    const row = `.rs-lrow:has(a[href="#/contacts/${seeded.contacts.called}"])`;
    assert.equal((await f.textContent(`${row} .rs-tag`)).trim(), "High");
    await f.click('#top-rnd [data-own="filter"]');
    await f.waitForSelector('.sheet.on [data-f-group="show"][data-f-val="high"]');
    assert.deepEqual(await screenProblems(f), [], "the filter sheet passes the phone checks");
    await f.click('.sheet.on [data-f-group="show"][data-f-val="high"]');
    await f.click(".sheet.on [data-f-show]");
    await f.waitForFunction(() => /^1 lead/.test(document.querySelector(".ld-count").textContent));
    const names = await f.$$eval(".sl-leads .rs-lr-t", (els) => els.map((e) => e.textContent));
    assert.ok(names.includes("Blair Calledonce") && !names.includes("Avery Newlead"), names.join(", "));
    assert.deepEqual(await screenProblems(f), []);
    await shot(page, "sales-leads-priority");
    await p.clean();
  } finally { await p.close(); }
});

// The Rotor guide (guide-gaps §2.6, §2.7, §2.11): Leads List | Board with Rotor's seven stages, Pipelines
// with a card moved to any stage, Tasks Board | List; both phones, both themes.
async function themed(page, f, theme) {
  if (theme !== "dark") return f;   // (light is the default: the owner, Nov 2026)
  await f.evaluate(() => localStorage.setItem("crm-theme", "dark"));
  await page.reload();
  const g = await crmFrame(page);
  await settled(g);
  return g;
}
const moveTo = async (f, label) => {
  await f.waitForSelector(".sheet.on [data-move-to]");
  const i = await f.$$eval(".sheet.on [data-move-to]", (els, l) => els.findIndex((e) => e.textContent.includes(l)), label);
  assert.ok(i >= 0, label);
  await f.click(`.sheet.on [data-move-to="${i}"]`);
};

for (const [device, theme] of [["iphone13", "dark"], ["iphonese", "light"], ["iphone13", "light"], ["iphonese", "dark"]]) {
  test(`the Rotor guide's sales screens (${device}, ${theme}): Leads list and board, a lead moved; Pipelines board; Tasks board`, async () => {
    const { p, page, f: f0 } = await open("olive", device);
    try {
      const f = await themed(page, f0, theme);
      // Leads: the section's List | Board tabs (and QR codes), the stage tiles
      await goTo(f, "/leads");
      await f.waitForSelector(".sl-leads .rs-lrow");
      assert.deepEqual(await f.$$eval('#subnav [data-seg="sec"]', (els) => els.map((e) => e.dataset.key)), ["list", "board", "qr"], "List | Board, then Track 1's QR codes");
      assert.ok(await f.$('[data-tile="ld"][data-key="not_ready"]'), "a tile per stage");
      assert.deepEqual(await screenProblems(f), [], "the Leads list");
      await shot(page, `g2-leads-list-${device}-${theme}`);
      await goTo(f, "/leads?view=board");
      await f.waitForSelector('.rs-board[data-board="leads"]');
      assert.deepEqual(await f.$$eval(".rs-strip-b span:first-child", (els) => els.map((e) => e.textContent)), ["New", "Contacted", "Quoted", "Follow-Up", "Sold", "Not Interested", "Not Ready"]);
      assert.deepEqual(await screenProblems(f), [], "the Leads board");
      await shot(page, `g2-leads-board-${device}-${theme}`);
      if (device === "iphone13" && theme === "dark") {
        // a lead moved to Not Ready by its Move pill; the column counts it
        const card = `.rs-bcard:has(a[href="#/contacts/${seeded.contacts.lead}"])`;
        await f.click(`${card} [data-move]`);
        await moveTo(f, "Not Ready");
        await f.waitForFunction((id) => !!document.querySelector(`.rs-col[data-col="not_ready"] a[href="#/contacts/${id}"]`), seeded.contacts.lead, { timeout: 8000 });
        assert.equal(await f.getAttribute(".rs-board", "data-on"), "not_ready", "the board shows the column it moved to");
        // Pipelines: a card moved two stages on in one go
        await goTo(f, "/pipeline?view=board");
        await f.waitForSelector('.rs-board[data-board="pipe"] .rs-bcard [data-move]');
        await f.click('.rs-board[data-board="pipe"] .rs-bcard [data-move]');
        await f.waitForSelector(".sheet.on [data-move-to]");
        const n = await f.$$eval(".sheet.on [data-move-to]", (els) => els.length);
        assert.ok(n >= 3, "every stage is offered");
        await f.click('.sheet.on [data-move-to="2"]');
        await f.waitForFunction(() => /Moved to/.test((document.querySelector(".toasts") || {}).textContent || ""), null, { timeout: 8000 });
        assert.deepEqual(await screenProblems(f), [], "the Pipelines board");
        await shot(page, `g2-pipeline-board-${device}`);
        // the pipeline picker: All pipelines (a list grouped by pipeline)
        await f.click("[data-pipe-pick]");
        await f.waitForSelector(".sheet.on [data-pick]");
        await f.click('.sheet.on [data-pick="\\"__all\\""]');
        await f.waitForFunction(() => /All pipelines/.test(document.querySelector(".pp-bar").textContent), null, { timeout: 8000 });
        assert.ok(await f.$(".pp-page .rs-label"), "grouped by pipeline");
      }
      // Tasks: Board | List; Open · In Progress · Waiting · Done
      await goTo(f, "/tasks?view=board");
      await f.waitForSelector('.rs-board[data-board="tasks"]');
      assert.deepEqual(await f.$$eval('.rs-board[data-board="tasks"] .rs-col', (els) => els.map((e) => e.dataset.col)), ["open", "in_progress", "waiting", "done"]);
      assert.deepEqual(await screenProblems(f), [], "the Tasks board");
      await shot(page, `g2-tasks-board-${device}-${theme}`);
      if (device === "iphonese" && theme === "light") {
        await f.click('.rs-col[data-col="open"] .rs-bcard [data-task-move]');
        await moveTo(f, "In Progress");
        await f.waitForFunction(() => !!document.querySelector('.rs-col[data-col="in_progress"] .rs-bcard'), null, { timeout: 8000 });
      }
      await goTo(f, "/tasks?view=list");
      await f.waitForSelector(".sl-tasks .rs-lrow, .sl-tasks .rs-empty");
      assert.deepEqual(await screenProblems(f), [], "the Tasks list");
      await p.clean();
    } finally { await p.close(); }
  });
}

test("the Rotor guide's sales screens on a desk (desk1440): Leads board, Tasks board", async () => {
  const p = await phone(browser, srv, { device: "desk1440" });
  try {
    await signIn(p, "olive");
    await p.page.goto("/office");
    const f = await crmFrame(p.page);
    await settled(f);
    await goTo(f, "/leads?view=board");
    await f.waitForSelector('.rs-board[data-board="leads"]');
    assert.deepEqual(await screenProblems(f), []);
    await goTo(f, "/tasks?view=board");
    await f.waitForSelector('.rs-board[data-board="tasks"]');
    assert.deepEqual(await screenProblems(f), []);
    await p.clean();
  } finally { await p.close(); }
});

// The Power Dialer (guide-gaps §2.8): Dialer · Queue · Call logs. The Dialer works the follow-up calls one
// person at a time (Skip, Previous, Log how it went, the script); a named queue from the New leads; the
// Call logs' tiles and the call just logged. Both phones, both themes; nothing dials or sends.
for (const [device, theme] of [["iphone13", "dark"], ["iphonese", "light"], ["iphone13", "light"], ["iphonese", "dark"]]) {
  test(`the Power Dialer (${device}, ${theme}): Dialer, Queue, Call logs`, async () => {
    const { p, page, f: f0 } = await open("olive", device);
    try {
      const f = await themed(page, f0, theme);
      await goTo(f, "/calls");
      await f.waitForSelector(".dl-page");
      assert.equal(await title(f), "Power Dialer");
      assert.deepEqual(await f.$$eval('#subnav [data-seg="sec"]', (els) => els.map((e) => e.dataset.key)), ["dialer", "queue", "logs"], "Dialer | Queue | Call logs");
      assert.match(await f.textContent(".dl-top"), /Calling from: this phone/);
      assert.ok(await f.$(".dl-script details"), "the call script");
      assert.ok(await f.$('.rs-cta a[href^="tel:"]'), "the sticky Call dials from this phone");
      assert.deepEqual(await screenProblems(f), [], "the Dialer");
      await shot(page, `g2-dialer-${device}-${theme}`);
      if (device === "iphone13" && theme === "dark") {
        const first = await f.textContent(".dl-name b");
        await f.click('[data-dl-step="skip"]');
        await f.waitForFunction((n) => document.querySelector(".dl-name b").textContent !== n, first);
        await f.click('[data-dl-step="prev"]');
        await f.waitForFunction((n) => document.querySelector(".dl-name b").textContent === n, first);
        // log how it went: the outcome sheet, then the next person
        await f.click("[data-dl-log]");
        await sheetUp(f, /How did it go/);
        await f.click('.sheet.on [data-outcome="voicemail"]');
        await f.waitForFunction(() => /Saved|In the Outbox|text/i.test((document.querySelector(".toasts") || {}).textContent || ""), null, { timeout: 8000 });
        // a named queue: New leads
        await f.click('#top-rnd [data-own="more"]');
        await f.waitForSelector(".sheet.on .rs-act");
        await f.click('.sheet.on .rs-act:has-text("New queue")');
        await f.waitForSelector('.sheet.on [data-pick="\\"leads:new\\""]');
        await f.click('.sheet.on [data-pick="\\"leads:new\\""]');
        await f.waitForFunction(() => /New leads/.test((document.querySelector(".dl-top") || {}).textContent || ""), null, { timeout: 8000 });
        // the Queue tab shows it, rows with a drag handle
        await goTo(f, "/calls/queue");
        await f.waitForSelector(".dl-queue .rs-drag");
        assert.deepEqual(await screenProblems(f), [], "a named queue");
        await shot(page, `g2-dialer-queue-${device}`);
        // the Call logs: the voicemail just logged
        await goTo(f, "/calls/logs");
        await f.waitForSelector(".dl-logs .rs-tiles");
        assert.match(await f.textContent(".dl-logs"), /Voicemail/);
      }
      await goTo(f, "/calls/logs");
      await f.waitForSelector(".dl-logs .rs-tiles");
      assert.match(await f.textContent(".dl-logs .rs-tiles"), /Total calls[\s\S]*Calls per hour/);
      assert.deepEqual(await screenProblems(f), [], "the Call logs");
      await shot(page, `g2-call-logs-${device}-${theme}`);
      await p.clean();
    } finally { await p.close(); }
  });
}
