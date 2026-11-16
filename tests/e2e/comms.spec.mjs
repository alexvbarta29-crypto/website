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
      // simple (Nov 15): a search, ONE folder button (its sheet: the folders with counts, team inboxes, texts or email, customers or leads), the rows
      assert.equal(await f.$("#view .rs-tiles"), null, "no tile rows");
      assert.match((await text(f, "#view [data-folders]")).trim(), /^All/);
      const folders = async () => { await f.click("#view [data-folders]"); await sheetUp(f, /^Folders$/); };
      await folders();
      assert.deepEqual(await f.$$eval(".sheet.on [data-folder]", (els) => els.map((e) => e.dataset.folder)), ["all", "mine", "unread", "needs_reply", "sales", "service"]);
      assert.match(await text(f, '.sheet.on [data-folder="sales"]'), /Sales\s*\d/, "the team inbox with its count");
      for (const k of ["fch", "fwho"]) assert.ok(await f.$(`.sheet.on [data-${k}]`), `${k} in the same sheet`);
      assert.deepEqual(await screenProblems(f), [], "the folder sheet");
      await shot(page, `comms-folders-${device}`);
      await f.click(".sheet.on [data-sheet-x]");
      await sheetGone(f);
      const LABEL = { all: "All", needs_reply: "Needs reply", sales: "Sales" };
      const pickTile = async (k) => { await folders(); await f.click(`.sheet.on [data-folder="${k}"]`); await sheetGone(f); await f.waitForFunction((l) => (document.querySelector("#view [data-folders]")?.getAttribute("aria-label") || "").startsWith(`Folder: ${l}`), LABEL[k]); await f.waitForTimeout(400); };
      await pickTile("needs_reply");
      assert.match((await text(f, "#view [data-folders]")).trim(), /^Needs reply/);
      // (the second phone comes after the first marked it done)
      if (first) assert.match(await text(f), new RegExp(c.names.lead));
      else assert.doesNotMatch(await text(f), new RegExp(c.names.lead), "done on the other phone: no longer waiting");
      assert.doesNotMatch(await text(f), /All done for today/, "a handled thread does not need a reply");
      await pickTile("sales");
      if (first) assert.match(await text(f), new RegExp(c.names.lead), "a lead lands in Sales by the inbox's rule");
      assert.doesNotMatch(await text(f, "#view .cm-list, #view .card").catch(() => ""), new RegExp(c.names.customer), "a customer is not in Sales");
      await pickTile("all");
      // texts or email in the same sheet; the folder button says so, Clear undoes it
      await folders();
      await f.click('.sheet.on [data-fch="sms"]');
      await sheetGone(f);
      await f.waitForSelector("#view .cm-fx");
      assert.match(await text(f, "#view .cm-fx"), /Texts/);
      await f.click("#view [data-clear]");
      await f.waitForFunction(() => !document.querySelector("#view .cm-fx"));
      assert.equal(await f.$('#top-rnd [data-own="filter"]'), null, "no separate filter button");

      // the thread: bubbles, where they came from, and that texting is off
      await f.click(`a[href="#/inbox/${c.open}"]`);
      await settled(f, { hash: `#/inbox/${c.open}` });
      assert.equal(await title(f), c.names.lead, "a thread is titled with its contact");
      assert.equal(await f.$$eval(".cm-msg[data-msg]:not(.note)", (els) => els.length), 2);
      assert.match(await text(f), /from Rotor/, "imported messages say where they came from");
      assert.match(await text(f), /Texting isn't switched on yet/);
      assert.ok(await f.$("#top-title.cm-name-tap"), "the name opens the person");
      assert.equal(await f.$$eval("#top-act [data-top-tool]", (b) => b.length), 1, "one round button (call) and the ...");
      // the composer: one box, Text | Email, +, the clip, a template, Send; the rest in +
      assert.deepEqual(await f.$$eval("[data-compose] [data-seg=ch]", (b) => b.map((x) => x.dataset.key)), ["sms", "email"]);
      for (const b of ["data-plus", "data-attach", "data-templates"]) assert.ok(await f.$(`[data-compose] [${b}]`), b);
      for (const b of ["data-from", "data-link", "data-later"]) assert.equal(await f.$(`[data-compose] [${b}]`), null, `${b} is in the +`);
      await f.click("[data-compose] [data-plus]");
      await sheetUp(f, /Add to the message/);
      assert.match(await text(f, ".sheet.on [data-from]"), /Main/, "two business numbers: From ...");
      for (const b of ["data-note", "data-later", "data-link"]) assert.ok(await f.$(`.sheet.on [${b}]`), b);
      assert.deepEqual(await screenProblems(f), [], "the composer's +");
      await shot(page, `comms-plus-${device}`);
      await f.click(".sheet.on [data-sheet-x]");
      await sheetGone(f);
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
      await f.click("[data-compose] [data-plus]");
      await sheetUp(f, /Add to the message/);
      await f.click(".sheet.on [data-link=review]");
      await sheetGone(f);
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
      await f.click("[data-compose] [data-plus]");
      await sheetUp(f, /Add to the message/);
      await f.click(".sheet.on [data-note]");
      await sheetGone(f);
      await f.fill("[data-compose] textarea.note", first ? "Wants the screens done too." : "Has a dog: text before the gate.");
      await f.click("[data-compose] button[type=submit]");
      await toastSays(f, /Note saved/);
      await f.waitForFunction((n) => document.querySelectorAll(".cm-msg .bubble.note").length === n, first ? 1 : 2, { timeout: 8000 });
      await f.click('[data-seg=ch][data-key="sms"]');

      // send later: a time sheet, then the Outbox at that time
      await f.fill("[data-compose] textarea", "A reminder for tomorrow morning.");
      await f.click("[data-compose] [data-plus]");
      await sheetUp(f, /Add to the message/);
      await f.click(".sheet.on [data-later]");
      await sheetUp(f, /Send later/);
      assert.deepEqual(await screenProblems(f), [], "the send later sheet");
      // (the server's clock is pinned: a time a day after it)
      const at = Date.parse(srv.now()) + 86400000;
      await f.evaluate((ms) => { const d = new Date(ms); const pad = (n) => String(n).padStart(2, "0"); document.querySelector(".sheet.on [name=at]").value = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T10:00`; }, at);
      await f.click(".sheet.on button[type=submit]");
      await toastSays(f, /Scheduled for/);

      // their details beside the thread (Rotor's panel): numbers, Mute, + Create
      await f.click("#top-title");
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
    await f.click("#view [data-folders]");
    await sheetUp(f, /^Folders$/);
    assert.deepEqual(await f.$$eval(".sheet.on [data-folder]", (els) => els.map((e) => e.dataset.folder)), ["all", "unread"], "no Mine, no team inboxes for a tech");
    assert.equal(await f.$(".sheet.on [data-fwho]"), null, "customers or leads is the office's");
    await f.click(".sheet.on [data-sheet-x]");
    await sheetGone(f);
    assert.equal(await f.$("#top-action:not([hidden])"), null, "no New for a tech");
    assert.deepEqual(await screenProblems(f), [], "a tech's Inbox passes the phone checks");
    await shot(page, "comms-inbox-tech");
    await f.click(`a[href="#/inbox/${c.tech}"]`);
    await settled(f, { hash: `#/inbox/${c.tech}` });
    assert.equal(await title(f), c.names.onVisit);
    assert.ok(await f.$("[data-compose] textarea"), "the tech can answer the customer of their visit");
    assert.equal(await f.$('[data-seg=ch][data-key="note"]'), null, "notes are the office's");
    assert.equal(await f.$("#top-title.cm-name-tap"), null, "no panel for a tech");
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

for (const device of ["iphone13", "iphonese"]) {
  test(`comms (${device}): Campaigns' tiles and a text blast (words, the cost, a CSV with consent, a follow-up)`, async () => {
    const { p, page, f } = await open("olive", device);
    const c = seeded.comms;
    try {
      await goTo(f, "/campaigns");
      assert.equal(await f.$$eval("#view .rs-tiles .rs-tile", (els) => els.length), 7, "Sent · Response · Job revenue · ARR · Open · Click · Bounce");
      assert.match(await text(f, "#view .rs-tiles"), /Open\s*-[\s\S]*Click\s*-/, "open and click wait for email tracking");
      assert.deepEqual(await screenProblems(f), [], "Campaigns passes the phone checks");
      await f.click('#view a[href="#/campaigns/new?kind=blast"]');
      await f.waitForFunction(() => /^#\/campaigns\/cm_/.test(location.hash), null, { timeout: 8000 });
      await settled(f);
      await f.waitForSelector("[data-body]");
      await f.fill("[data-body]", "Hi there, spring window cleanings are open this week. Reply YES and we'll find you a time.");
      await f.waitForFunction(() => /characters · 1 text each/.test(document.querySelector("[data-cost]").textContent));
      await f.$eval("[data-body]", (el) => el.dispatchEvent(new Event("change", { bubbles: true })));
      await f.waitForFunction(() => /about/.test((document.querySelector("[data-cost]") || {}).textContent || "") || !!document.querySelector("[data-test]"), null, { timeout: 8000 });
      // a CSV with a consent column: only who agreed
      const me = await p.ctx.request.get(`/api/crm/contacts/${c.customer}`, { headers: { "x-crm": "1" } });
      const phone = (await me.json()).data.contact.phones[0].e164;
      const [fc] = await Promise.all([page.waitForEvent("filechooser"), f.click("[data-csv]")]);
      await fc.setFiles({ name: "people.csv", mimeType: "text/csv", buffer: Buffer.from(`Name,Phone,Consent\nA,${phone},yes\nB,7635550999,yes\nC,7635550998,no\n`) });
      await toastSays(f, /1 people from the file/);
      await f.waitForFunction(() => /From the CSV: 1 of 3 people, 1 left out with no consent, 1 not in the CRM/.test(document.getElementById("view").textContent), null, { timeout: 8000 });
      // a follow-up to who didn't reply
      await f.click("[data-fu-on]");
      await f.waitForSelector("[data-fu-body]", { timeout: 8000 });
      assert.deepEqual(await screenProblems(f), [], "the text blast passes the phone checks");
      await shot(page, `comms-blast-${device}`);
      await f.click("[data-blast-win]");
      await sheetUp(f, /past winner/);
      assert.deepEqual(await screenProblems(f), [], "the past winners sheet");
      await f.click(".sheet.on [data-sheet-x]");
      await sheetGone(f);
      assert.deepEqual(p.outside, [], "nothing asked for another host");
      await p.clean();
    } finally { await p.close(); }
  });
}

test("comms: Reviews (match a review to its customer) and the setup page", async () => {
  const { p, page, f } = await open("olive", "iphonese");
  const c = seeded.comms;
  try {
    await goTo(f, "/reviews");
    assert.equal(await title(f), "Reviews");
    // star ratings: tiles that ARE the filter, the spread, a low one to call back
    assert.deepEqual(await f.$$eval("#view [data-tile=rv]", (els) => els.map((e) => e.dataset.key)), ["all", "needs_follow_up", "public"]);
    assert.match(await text(f), /Star ratings are built and off until the switch/);
    assert.ok(await f.$(".cm-dist"), "the spread of stars");
    assert.match(await text(f), /Google ✓/);
    await f.click('#view [data-tile=rv][data-key="needs_follow_up"]');
    await f.waitForFunction(() => { const b = document.querySelector('#view [data-tile=rv][data-key="needs_follow_up"]'); return b && b.getAttribute("aria-pressed") === "true"; }, null, { timeout: 8000 });
    assert.equal(await f.$$eval("#view [data-rating]", (els) => els.length), 1);
    await f.click(`#view [data-rating="${c.ratings.low}"]`);
    await f.waitForSelector(".sheet.on [data-fu]");
    await f.waitForFunction(() => /garage/.test(document.querySelector(".sheet.on [data-rt-words]").textContent));
    assert.deepEqual(await screenProblems(f), [], "a rating's sheet passes the phone checks");
    await shot(page, "comms-rating-sheet");
    await f.click(".sheet.on [data-fu]");
    await toastSays(f, /followed up/);
    await sheetGone(f);
    await f.waitForFunction(() => !document.querySelector("#view [data-rating]"), null, { timeout: 8000 });
    await f.click('#view [data-tile=rv][data-key="needs_follow_up"]');
    await f.waitForSelector("#view [data-rv-add]");
    await f.click("#view [data-rv-add]");
    await sheetUp(f, /Add a review/);
    assert.deepEqual(await screenProblems(f), [], "the add sheet passes the phone checks");
    await f.click(".sheet.on [data-sheet-x]");
    await sheetGone(f);
    await f.click("#view [data-rv-board]");
    await sheetUp(f, /Review leaderboard/);
    assert.match(await text(f, ".sheet.on"), /2 ratings/);
    await f.click(".sheet.on [data-sheet-x]");
    await sheetGone(f);
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
    await f.waitForFunction(() => /Matched/.test((document.querySelector("#view [data-review] .pill.green") || {}).textContent || ""), null, { timeout: 8000 });

    await goTo(f, "/settings/reviews");
    assert.equal(await title(f), "Reviews");
    assert.match(await text(f), /Every rating/);
    assert.deepEqual(await screenProblems(f), [], "the review settings pass the phone checks");
    await shot(page, "comms-review-settings");

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
    assert.ok(await f.isVisible("#view .cm-fcol"), "the folders as one column (Rotor's inbox with folders)");
    assert.equal(await f.isVisible("#view [data-folders]"), false, "no folder button beside the column");
    assert.ok(await f.$("#pane [data-compose] textarea"));
    assert.deepEqual(await screenProblems(f), [], "the Inbox with a thread passes the checks on a desk");
    await shot(page, "comms-inbox-desk");
    await p.clean();
  } finally { await p.close(); }
});

// The Suggested reply (drafts.mjs, suggest.js). The Anthropic API is a mock
// in this process (the server's own fetch refuses every other host); the key
// is a made-up one set only for these tests.
function claudeMock() {
  const before = globalThis.fetch;
  const calls = [];
  const words = (ins) => (!ins ? "Hi there, this is Olive with Barta Window Washing! Thanks for letting us know the side gate is unlocked. See you soon!"
    : /^Make it shorter/.test(ins) ? "Thanks, see you soon!"
    : /^Offer two or three/.test(ins) ? "Thanks! We have Wednesday or Thursday open. Which works best?"
    : "Thanks! We can come Thursday.");
  globalThis.fetch = async (input, init = {}) => {
    const u = new URL(typeof input === "string" ? input : input.url);
    if (u.host !== "api.anthropic.com") return before(input, init);
    const b = JSON.parse(init.body);
    calls.push(b);
    const ins = (/<instruction>([\s\S]*?)<\/instruction>/.exec(b.messages[0].content) || [])[1] || "";
    return Response.json({ id: "msg_e2e", type: "message", role: "assistant", model: b.model, stop_reason: "end_turn", content: [{ type: "text", text: words(ins) }], usage: { input_tokens: 800, cache_read_input_tokens: 1500, output_tokens: 60 } });
  };
  process.env.ANTHROPIC_API_KEY = "test-key-not-real";
  return { calls, restore() { globalThis.fetch = before; delete process.env.ANTHROPIC_API_KEY; } };
}
const hold = async (page, f, sel) => {
  const b = await (await f.$(sel)).boundingBox();
  await page.mouse.move(b.x + b.width / 2, b.y + Math.min(20, b.height / 2));
  await page.mouse.down();
  await page.waitForTimeout(800);
  await page.mouse.up();
};

test("comms (iphone13): the Suggested reply: Use fills the box and sends nothing; the chips; hold for the same choices, Copy and Regenerate", async () => {
  const net = claudeMock();
  const { p, page, f } = await open("olive", "iphone13");
  const c = seeded.comms;
  try {
    // what waits in the Outbox for this person (the worker's own automations may add to others meanwhile)
    const outbox = async () => (await (await p.ctx.request.get(`/api/crm/outbox?contact=${c.onVisit}`, { headers: { "x-crm": "1" } })).json()).data.map((o) => o.body).join("|");
    const before = await outbox();
    await goTo(f, `/inbox/${c.tech}`);
    // the customer's text is the newest: a draft waits above the composer
    await f.waitForSelector("[data-sugg] [data-sugg-text]", { timeout: 8000 });
    assert.match(await text(f, "[data-sugg]"), /Suggested reply/);
    assert.match(await text(f, "[data-sugg-text]"), /side gate is unlocked/);
    assert.equal(net.calls.length, 1);
    assert.equal(net.calls[0].model, "claude-haiku-5-5");
    assert.doesNotMatch(net.calls[0].messages[0].content, /555|@/, "no number or email reaches the model");
    assert.deepEqual(await f.$$eval("[data-sugg-chip]", (b) => b.map((x) => x.dataset.suggChip)), ["shorter", "friendlier", "professional", "availability"], "an address on file: no Ask for their address");
    assert.ok(await f.$("[data-sugg-change]"), "Change it...");
    const card = await f.$eval("[data-sugg]", (el) => el.getBoundingClientRect().toJSON());
    const box = await f.$eval("[data-compose]", (el) => el.getBoundingClientRect().toJSON());
    assert.ok(card.bottom <= box.top + 1, "just above the composer");
    assert.deepEqual(await screenProblems(f), [], "the card passes the phone checks");
    await shot(page, "comms-suggested-reply-iphone13");
    // a chip changes it (the current draft goes with the instruction)
    await f.click('[data-sugg-chip="shorter"]');
    await f.waitForFunction(() => /^Thanks, see you soon!$/.test(document.querySelector("[data-sugg-text]")?.textContent || ""), null, { timeout: 8000 });
    assert.match(net.calls[1].messages[0].content, /<current_draft>\nHi there, this is Olive/);
    assert.match(net.calls[1].messages[0].content, /<instruction>Make it shorter/);
    // hold the words: the same choices as a sheet, with Copy and Regenerate
    await hold(page, f, "[data-sugg-text]");
    await sheetUp(f, /^Suggested reply$/);
    assert.deepEqual(await f.$$eval(".sheet.on [data-sugg-h]", (b) => b.map((x) => x.dataset.suggH)), ["use", "shorter", "friendlier", "professional", "availability", "change", "copy", "regenerate"]);
    assert.deepEqual(await screenProblems(f), [], "the hold sheet passes the phone checks");
    await shot(page, "comms-suggested-reply-options-iphone13");
    await f.click('.sheet.on [data-sugg-h="availability"]');
    await sheetGone(f);
    await f.waitForFunction(() => /Wednesday or Thursday/.test(document.querySelector("[data-sugg-text]")?.textContent || ""), null, { timeout: 8000 });
    assert.match(net.calls[2].messages[0].content, /<open_slots>\n\w+day, \w{3} \d+, anytime/, "the open days from the schedule");
    // Change it...: their own words
    await f.click("[data-sugg-change]");
    await sheetUp(f, /^Change it$/);
    await f.fill(".sheet.on [data-sugg-f] textarea", "say we can come Thursday");
    assert.deepEqual(await screenProblems(f), [], "the Change it sheet");
    await f.click(".sheet.on [data-sugg-f] button[type=submit]");
    await sheetGone(f);
    await f.waitForFunction(() => /We can come Thursday/.test(document.querySelector("[data-sugg-text]")?.textContent || ""), null, { timeout: 8000 });
    assert.match(net.calls[3].messages[0].content, /<instruction>say we can come Thursday<\/instruction>/);
    // Use: the words in the box, focused; nothing sent, nothing in the Outbox; the card goes
    await f.click("[data-sugg-use]");
    await f.waitForFunction(() => !document.querySelector("[data-sugg]"));
    assert.equal(await f.$eval("[data-compose] textarea", (el) => el.value), "Thanks! We can come Thursday.");
    assert.equal(await f.evaluate(() => document.activeElement && document.activeElement.matches("[data-compose] textarea")), true);
    await f.waitForTimeout(600);
    assert.equal(await outbox(), before, "Use never sends");
    assert.doesNotMatch(before, /We can come Thursday/);
    assert.equal(await f.$$eval(".cm-msg .bubble.grey", (els) => els.length), 0, "no Not sent bubble");
    assert.equal(net.calls.length, 4, "and asks for nothing more");
    // the 10 s refresh doesn't bring it back for the same message
    await f.waitForTimeout(10500);
    assert.equal(await f.$("[data-sugg]"), null);
    await f.fill("[data-compose] textarea", "");
    // + Draft a reply: a fresh one for any thread
    await f.click("[data-compose] [data-plus]");
    await sheetUp(f, /Add to the message/);
    assert.match(await text(f, ".sheet.on [data-draft-reply]"), /Draft a reply/);
    await f.click(".sheet.on [data-draft-reply]");
    await sheetGone(f);
    await f.waitForSelector("[data-sugg] [data-sugg-text]", { timeout: 8000 });
    assert.equal(net.calls.length, 5);
    await f.click("[data-sugg-x]");
    await f.waitForFunction(() => !document.querySelector("[data-sugg]"));
    await p.clean();
  } finally { net.restore(); await p.close(); }
});

test("comms: the Suggested reply on a desk beside the Inbox; without the key there is none", async () => {
  const net = claudeMock();
  const { p, page, f } = await open("olive", "desk1440", { office: true });
  const c = seeded.comms;
  try {
    await goTo(f, "/inbox");
    // the customer of Theo's visit is still waiting on an answer
    await f.click(`#view a[href="#/inbox/${c.tech}"]`);
    await settled(f, { hash: `#/inbox/${c.tech}` });
    await f.waitForSelector("#pane [data-sugg] [data-sugg-text]", { timeout: 8000 });
    assert.ok(await f.$("#view .cm-row"), "the list stays beside it");
    const card = await f.$eval("#pane [data-sugg]", (el) => el.getBoundingClientRect().toJSON());
    const box = await f.$eval("#pane [data-compose]", (el) => el.getBoundingClientRect().toJSON());
    assert.ok(card.bottom <= box.top + 1 && card.width > 300, "above the composer, the pane's width");
    assert.equal(await f.$$eval("#pane [data-sugg-chip]", (b) => b.filter((x) => x.getBoundingClientRect().right <= innerWidth).length), 4, "every chip in view (they wrap on a desk)");
    assert.deepEqual(await screenProblems(f), [], "the desk thread with its suggestion");
    await shot(page, "comms-suggested-reply-desk");
    // the key goes: no card, + says it needs the key
    net.restore();
    await goTo(f, "/inbox");
    await f.click(`#view a[href="#/inbox/${c.conversation}"]`);
    await settled(f, { hash: `#/inbox/${c.conversation}` });
    await f.click(`#view a[href="#/inbox/${c.tech}"]`);
    await settled(f, { hash: `#/inbox/${c.tech}` });
    await f.waitForTimeout(500);
    assert.equal(await f.$("[data-sugg]"), null, "no key: no card");
    await f.click("#pane [data-compose] [data-plus]");
    await sheetUp(f, /Add to the message/);
    assert.match(await text(f, ".sheet.on [data-draft-reply]"), /needs the Anthropic key/);
    assert.equal(await f.$eval(".sheet.on [data-draft-reply]", (el) => el.disabled), true);
    await f.click(".sheet.on [data-sheet-x]");
    await p.clean();
  } finally { net.restore(); await p.close(); }
});
