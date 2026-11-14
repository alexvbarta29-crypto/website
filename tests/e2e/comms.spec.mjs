// Phone checks of the messages screens (M6; design §12.4, §9.2): the Inbox
// and its chips, a thread with Rotor's history, a reply that lands in the
// Outbox while texting is off, the templates sheet, the contact's Messages
// tab, a tech's inbox (only the people on their own visits), Campaigns
// with the required test send, Reviews, and the setup page. iPhone 13 and
// iPhone SE sizes, and the Inbox beside its thread on a desk. `npm run e2e`.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { start } from "./server.mjs";
import { launch, phone, signIn, crmFrame, goTo, settled, title, badLinks, screenProblems, shot, noInstallCard } from "./kit.mjs";

let srv, browser, seeded;
before(async () => { srv = await start(); seeded = await srv.seed(); browser = await launch(); });
after(async () => { await browser?.close(); await srv?.close(); });

async function open(login, device, opts = {}) {
  const p = await phone(browser, srv, { device, ...opts });
  await signIn(p, login);
  await p.page.goto("/office");
  const f = await crmFrame(p.page);
  await settled(f);
  await noInstallCard(p.page);
  return { p, page: p.page, f };
}
const sheetUp = (f, re) => f.waitForFunction((src) => { const h = document.querySelector(".sheet.on h2"); return !!h && new RegExp(src).test(h.textContent); }, re.source, { timeout: 5000 });
const sheetGone = (f) => f.waitForFunction(() => !document.querySelector(".sheet"), null, { timeout: 5000 });
const toastSays = (f, re) => f.waitForFunction((src) => new RegExp(src).test((document.querySelector(".toasts") || {}).textContent || ""), re.source, { timeout: 8000 });
const text = (f, sel = "#view") => f.textContent(sel);

for (const device of ["iphone13", "iphonese"]) {
  test(`comms (${device}): the Inbox, a thread from Rotor's history, a reply to the Outbox, templates, the contact's Messages tab`, async () => {
    const { p, page, f } = await open("olive", device);
    const c = seeded.comms;
    const first = device === "iphone13";
    try {
      // the Inbox: its own tab, the unanswered lead on top
      await f.click('#tabs [data-tab="inbox"]');
      await settled(f, { hash: "#/inbox" });
      assert.equal(await title(f), "Inbox", "titled Inbox, like the drawer");
      assert.match(await text(f), new RegExp(c.names.lead), "the lead's text is in the Inbox");
      assert.match(await text(f), /30 windows/, "with its latest words");
      if (first) assert.ok(await f.$(`a[href="#/inbox/${c.open}"].unread`), "unread until someone opens it");
      assert.deepEqual(await screenProblems(f), [], "the Inbox passes the phone checks");
      assert.deepEqual(await badLinks(f), []);
      await shot(page, `comms-inbox-${device}`);
      // Rotor's folders are one row of tiles (a tile IS the filter), each with its count; team inboxes after them
      assert.deepEqual(await f.$$eval("#view [data-tile=inbox]", (els) => els.map((e) => e.dataset.key)), ["all", "mine", "unread", "needs_reply", "sales", "service"]);
      assert.match(await text(f, "#view .rs-tiles"), /Sales\s*\d/, "the team inbox with its count");
      const pickTile = async (k) => { await f.click(`#view [data-tile=inbox][data-key="${k}"]`); await f.waitForFunction((key) => { const b = document.querySelector(`#view [data-tile=inbox][data-key="${key}"]`); return !!b && !document.querySelector("#view [aria-busy=true]"); }, k); await f.waitForTimeout(400); };
      await pickTile("needs_reply");
      assert.equal(await f.$eval('#view [data-tile=inbox][data-key="needs_reply"]', (b) => b.getAttribute("aria-pressed")), "true");
      // (the second phone comes after the first marked it done)
      if (first) assert.match(await text(f), new RegExp(c.names.lead));
      else assert.doesNotMatch(await text(f), new RegExp(c.names.lead), "done on the other phone: no longer waiting");
      assert.doesNotMatch(await text(f), /All done for today/, "a handled thread does not need a reply");
      await pickTile("sales");
      if (first) assert.match(await text(f), new RegExp(c.names.lead), "a lead lands in Sales by the inbox's rule");
      assert.doesNotMatch(await text(f, "#view .cm-list, #view .card").catch(() => ""), new RegExp(c.names.customer), "a customer is not in Sales");
      await pickTile("sales");
      // the round Filter: texts or email, customers or leads (one sheet, not three rows of controls)
      await f.click('#top-rnd [data-own="filter"]');
      await f.waitForSelector(".sheet.on");
      assert.deepEqual(await screenProblems(f), [], "the filter sheet");
      await f.click(".sheet.on [data-sheet-x]");
      await sheetGone(f);

      // the thread: bubbles, where they came from, and that texting is off
      await f.click(`a[href="#/inbox/${c.open}"]`);
      await settled(f, { hash: `#/inbox/${c.open}` });
      assert.equal(await title(f), c.names.lead, "a thread is titled with its contact");
      assert.equal(await f.$$eval(".cm-msg[data-msg]:not(.note)", (els) => els.length), 2);
      assert.match(await text(f), /from Rotor/, "imported messages say where they came from");
      assert.match(await text(f), /Texting isn't switched on yet/);
      assert.ok(await f.$("#top-act [data-panel]"), "the person's round button");
      assert.ok(await f.$("[data-from]"), "two business numbers: From ...");
      assert.match(await text(f, "[data-from]"), /Main/);
      assert.deepEqual(await screenProblems(f), [], "a thread passes the phone checks");
      assert.deepEqual(await badLinks(f), []);
      await shot(page, `comms-thread-${device}`);

      // a reply: nothing leaves, it waits in the Outbox as a grey bubble
      await f.fill("[data-compose] textarea", first ? "Thursday works. We'll text you a time window." : "One more thing: is there a dog we should know about?");
      await f.click("[data-compose] button[type=submit]");
      await toastSays(f, /Saved to the Outbox/);
      await f.waitForFunction((n) => document.querySelectorAll(".cm-msg .bubble.grey").length === n, first ? 1 : 2, { timeout: 8000 });
      assert.match(await text(f, ".cm-msgs"), /Not sent \(dry run\)/);
      assert.equal(await f.$eval("[data-compose] textarea", (el) => el.value), "", "the box is empty again");
      await shot(page, `comms-thread-outbox-${device}`);

      // the quick links put the review link in the box
      await f.click("[data-link=review]");
      assert.match(await f.$eval("[data-compose] textarea", (el) => el.value), /^https:\/\//);
      await f.fill("[data-compose] textarea", "");

      // templates: a list, then the preview for this contact; Put in the box
      await f.click("[data-templates]");
      await sheetUp(f, /Templates/);
      assert.ok((await f.$$(".sheet [data-tpl]")).length > 2, "the templates for texts");
      assert.deepEqual(await screenProblems(f), [], "the templates sheet passes the phone checks");
      await f.click(".sheet [data-tpl]");
      await f.waitForSelector(".sheet .preview", { timeout: 5000 });
      assert.deepEqual(await screenProblems(f), [], "a template's preview passes the phone checks");
      await shot(page, `comms-template-${device}`);
      await f.click(".sheet [data-put]");
      await sheetGone(f);
      assert.ok((await f.$eval("[data-compose] textarea", (el) => el.value)).length > 20, "the template's words are in the box");
      await f.fill("[data-compose] textarea", "");

      // an internal note: yellow, only the team sees it
      await f.click('[data-seg=ch][data-key="note"]');
      await f.fill("[data-compose] textarea", first ? "Wants the screens done too." : "Has a dog: text before the gate.");
      await f.click("[data-compose] button[type=submit]");
      await toastSays(f, /Note saved/);
      await f.waitForFunction((n) => document.querySelectorAll(".cm-msg .bubble.note").length === n, first ? 1 : 2, { timeout: 8000 });
      await f.click('[data-seg=ch][data-key="sms"]');

      // send later: a time sheet, then the Outbox at that time
      await f.fill("[data-compose] textarea", "A reminder for tomorrow morning.");
      await f.click("[data-later]");
      await sheetUp(f, /Send later/);
      assert.deepEqual(await screenProblems(f), [], "the send later sheet");
      // (the server's clock is pinned: a time a day after it)
      const at = Date.parse(srv.now()) + 86400000;
      await f.evaluate((ms) => { const d = new Date(ms); const pad = (n) => String(n).padStart(2, "0"); document.querySelector(".sheet.on [name=at]").value = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T10:00`; }, at);
      await f.click(".sheet.on button[type=submit]");
      await toastSays(f, /Scheduled for/);

      // their details beside the thread (Rotor's panel): numbers, Mute, + Create
      await f.click("#top-act [data-panel]");
      await f.waitForSelector(".sheet.on [data-mute]", { timeout: 8000 });
      assert.match(await text(f, ".sheet.on"), /Create/);
      assert.deepEqual(await screenProblems(f), [], "the person's panel passes the phone checks");
      await shot(page, `comms-panel-${device}`);
      await f.click(".sheet.on [data-sheet-x]");
      await sheetGone(f);

      // the "...": assign it, then mark it done (the second phone reopens it)
      await f.click("#top-more");
      await f.waitForSelector(".sheet.on [data-assign]");
      await f.click(".sheet.on [data-assign]");
      await f.waitForSelector(".sheet.on [data-assign-to]");
      await f.click(".sheet.on [data-assign-to]");
      await toastSays(f, /Assigned/);
      await sheetGone(f);
      await f.click("#top-more");
      await f.waitForSelector(".sheet.on [data-done]");
      await f.click(first ? '.sheet.on [data-done="1"]' : '.sheet.on [data-done="0"]');
      await toastSays(f, first ? /Marked done/ : /Reopened/);

      // a customer's history: texts and email in one thread; a failed text says so and where to fix it; the long email opens whole
      await goTo(f, `/inbox/${c.conversation}`);
      assert.match(await text(f), /Not delivered \(30007\)/);
      assert.ok(await f.$(".cm-fix"), "a failed send links to where it is fixed");
      assert.match(await text(f), /automatic/, "an automatic text is marked");
      assert.match(await text(f), /Your quote from BARTA Window Washing/, "their email is in the same thread");
      assert.match(await text(f, ".cm-msgs"), /· Email/, "each bubble says its channel");
      assert.deepEqual(await screenProblems(f), [], "a long thread passes the phone checks");
      await shot(page, `comms-history-${device}`);
      const before = (await text(f, ".cm-msgs")).length;
      await f.click("[data-whole]");
      await f.waitForFunction((n) => document.querySelector(".cm-msgs").textContent.length > n + 200 && !document.querySelector("[data-whole]"), before);
      await f.click('[data-seg=ch][data-key="email"]');
      assert.ok(await f.$("[data-compose] [name=subject]"), "an email has a subject line");
      assert.deepEqual(await screenProblems(f), [], "an email thread passes the phone checks");
      await shot(page, `comms-email-${device}`);
      await f.click('[data-seg=ch][data-key="sms"]');

      // the contact's Messages tab
      await goTo(f, `/contacts/${c.customer}`);
      await f.waitForFunction(() => !!document.querySelector("#ct-mod-messages .cm-msgs"), null, { timeout: 10000 });
      assert.match(await text(f), /Texts · 6/);
      assert.match(await text(f), /Email · 1/);
      assert.ok(await f.$(`#view a[href="#/inbox/${c.conversation}"]`));
      assert.deepEqual(await screenProblems(f), [], "the Messages tab passes the phone checks");
      await shot(page, `comms-contact-tab-${device}`);

      // Text someone: pick a contact first
      await goTo(f, "/inbox/new");
      assert.match(await text(f), /Who is it for/);
      assert.deepEqual(await screenProblems(f), []);
      await f.click("[data-pick]");
      await f.waitForSelector(".sheet.on");
      assert.deepEqual(await screenProblems(f), [], "the contact picker passes the phone checks");
      await f.click(".sheet [data-sheet-x]");
      await sheetGone(f);
      await p.clean();
    } finally { await p.close(); }
  });
}

test("comms: a tech's inbox holds only the people on their own visits", async () => {
  const { p, page, f } = await open("theo", "iphonese");
  const c = seeded.comms;
  try {
    assert.deepEqual(await f.$$eval("#tabs [data-tab]", (els) => els.map((e) => e.dataset.tab)), ["today", "inbox", "time", "pay", "me"]);
    await f.click('#tabs [data-tab="inbox"]');
    await settled(f, { hash: "#/inbox" });
    assert.match(await text(f), new RegExp(c.names.onVisit), "the contact on today's visit");
    assert.match(await text(f), /side gate/);
    assert.doesNotMatch(await text(f), new RegExp(c.names.lead), "nobody else's lead");
    assert.equal(await f.$$eval("#view .cm-row", (els) => els.length), 1);
    assert.deepEqual(await f.$$eval("#view [data-tile=inbox]", (els) => els.map((e) => e.dataset.key)), ["all", "unread"], "no Mine, no team inboxes for a tech");
    assert.equal(await f.$("#top-action:not([hidden])"), null, "no New for a tech");
    assert.deepEqual(await screenProblems(f), [], "a tech's Inbox passes the phone checks");
    await shot(page, "comms-inbox-tech");
    await f.click(`a[href="#/inbox/${c.tech}"]`);
    await settled(f, { hash: `#/inbox/${c.tech}` });
    assert.equal(await title(f), c.names.onVisit);
    assert.ok(await f.$("[data-compose] textarea"), "the tech can answer the customer of their visit");
    assert.equal(await f.$('[data-seg=ch][data-key="note"]'), null, "notes are the office's");
    assert.equal(await f.$("#top-act [data-panel]"), null);
    assert.deepEqual(await screenProblems(f), [], "a tech's thread passes the phone checks");
    await shot(page, "comms-thread-tech");
    // the office's threads are not theirs, by address or by API
    for (const id of [c.open, c.conversation]) {
      const res = await p.ctx.request.get(`/api/crm/conversations/${id}`, { headers: { "x-crm": "1" } });
      assert.equal(res.status(), 403, "someone else's conversation is not for a tech");
    }
    for (const path of ["/api/crm/campaigns", "/api/crm/reviews", `/api/crm/inbox/contact/${c.lead}`]) {
      const res = await p.ctx.request.get(path, { headers: { "x-crm": "1" } });
      assert.ok([403, 404].includes(res.status()), `${path} is not for a tech (${res.status()})`);
    }
    await goTo(f, "/campaigns");
    assert.doesNotMatch(await text(f), /Fall window cleaning/);
    await p.clean({ allow: [/404|403/] });
  } finally { await p.close(); }
});

test("comms: Campaigns: Rotor's history, a draft with its audience, the test send first, then send (dry run)", async () => {
  const { p, page, f } = await open("olive", "iphone13");
  const c = seeded.comms;
  try {
    await goTo(f, "/campaigns");
    assert.equal(await title(f), "Campaigns");
    assert.match(await text(f), /Fall window cleaning/);
    assert.match(await text(f), /Review Request - Last 30 Days/);
    assert.deepEqual(await screenProblems(f), [], "Campaigns passes the phone checks");
    await shot(page, "comms-campaigns");
    await goTo(f, `/campaigns/${c.rotorCampaign}`);
    assert.match(await text(f), /Sent from Rotor/);
    assert.equal(await f.$("[data-test], [data-now]"), null, "history can't be sent again");
    assert.deepEqual(await screenProblems(f), []);
    await shot(page, "comms-campaign-rotor");

    await goTo(f, `/campaigns/${c.campaign}`);
    assert.equal(await title(f), "Fall window cleaning");
    assert.match(await text(f, ".cm-stat"), /would get it/);
    const count = Number(await f.$eval(".cm-stat b", (el) => el.textContent));
    assert.ok(count > 0, "customers match");
    assert.ok(await f.$(".preview"), "sample texts");
    assert.equal(await f.$("[data-now]"), null, "no sending before the test");
    assert.deepEqual(await screenProblems(f), [], "the campaign builder passes the phone checks");
    await shot(page, "comms-campaign-draft");
    // narrow it: customers not on a plan
    await f.click('[data-plan="none"]');
    await f.waitForFunction(() => document.querySelector('[data-plan="none"]').getAttribute("aria-pressed") === "true");
    // the test goes to the test contact (prepared in the background first)
    await f.click("[data-test]");
    await f.waitForSelector("[data-now]", { timeout: 30000 });
    assert.match(await text(f), /Test sent/);
    assert.match(await text(f), /dry run/);
    assert.deepEqual(await screenProblems(f), [], "a tested campaign passes the phone checks");
    await shot(page, "comms-campaign-tested");
    await f.click("[data-now]");
    await sheetUp(f, /Send the campaign/);
    assert.deepEqual(await screenProblems(f), []);
    await f.click(".sheet .btn.primary, .sheet [data-yes]");
    await toastSays(f, /going out/);
    await f.waitForFunction(() => /Results/.test(document.getElementById("view").textContent), null, { timeout: 10000 });
    // 25 at a time in the background; nothing leaves this machine (dry run)
    for (let i = 0; i < 20; i++) {
      if (/Sent|Stopped|Cancelled/i.test(await f.textContent(".stack-head .pill").catch(() => ""))) break;
      await page.waitForTimeout(1000);
      await f.evaluate(() => { const b = document.querySelector("[data-refresh]"); if (b) b.click(); });
      await settled(f);
    }
    assert.match(await text(f), /to the Outbox \(dry run\)|skipped/);
    assert.deepEqual(await screenProblems(f), [], "the results pass the phone checks");
    await shot(page, "comms-campaign-results");
    assert.deepEqual(p.outside, [], "nothing asked for another host");
    await p.clean();
  } finally { await p.close(); }
});

test("comms: Reviews (match a review to its customer) and the setup page", async () => {
  const { p, page, f } = await open("olive", "iphonese");
  const c = seeded.comms;
  try {
    await goTo(f, "/reviews");
    assert.equal(await title(f), "Reviews");
    assert.match(await text(f), /aren't being read here yet/, "reading Google reviews is off until an owner switches it on");
    assert.match(await text(f), /1 to check/);
    assert.deepEqual(await screenProblems(f), [], "Reviews passes the phone checks");
    await shot(page, "comms-reviews");
    await f.click(`[data-review="${c.review}"]`);
    await f.waitForSelector(".sheet.on [data-sug]");
    assert.match(await text(f, ".sheet"), /Spotless windows/);
    assert.deepEqual(await screenProblems(f), [], "a review's sheet passes the phone checks");
    await shot(page, "comms-review-sheet");
    await f.click(`.sheet [data-sug="${c.customer}"]`);
    await toastSays(f, /Matched/);
    await f.waitForFunction(() => /Matched/.test((document.querySelector("#view .pill.green") || {}).textContent || ""), null, { timeout: 8000 });

    await goTo(f, "/settings/texting");
    assert.equal(await title(f), "Texting, email & reviews");
    assert.match(await text(f), /Twilio|texting/i);
    assert.doesNotMatch(await text(f), /AC[0-9a-f]{32}|sk_live|Bearer /, "no keys on screen");
    assert.deepEqual(await screenProblems(f), [], "the setup page passes the phone checks");
    assert.deepEqual(await badLinks(f), []);
    await shot(page, "comms-setup");
    await p.clean();
  } finally { await p.close(); }
});

test("comms: on a desk the Inbox sits beside its thread", async () => {
  const { p, page, f } = await open("olive", "desk1440", { office: true });
  const c = seeded.comms;
  try {
    await goTo(f, "/inbox");
    assert.ok(await f.$('#side a[href="#/inbox"]'), "Inbox is in the sidebar");
    await f.click(`#view a[href="#/inbox/${c.conversation}"]`);
    await settled(f, { hash: `#/inbox/${c.conversation}` });
    assert.equal(await f.isVisible("#pane"), true);
    assert.match(await f.textContent("#pane"), /gate code is on file/);
    assert.ok(await f.$("#view .cm-row"), "the list stays beside it");
    assert.ok(await f.$("#pane [data-compose] textarea"));
    assert.deepEqual(await screenProblems(f), [], "the Inbox with a thread passes the checks on a desk");
    await shot(page, "comms-inbox-desk");
    await p.clean();
  } finally { await p.close(); }
});
