// Phone checks of the contacts screens (M2a; design §12.4, §9.2): the
// Contacts list with its search, one contact and its tabs (the Sales tab),
// a tech's quick lead, at iPhone 13 and iPhone SE sizes. `npm run e2e`.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { start } from "./server.mjs";
import { launch, phone, signIn, crmFrame, goTo, settled, title, badLinks, screenProblems, shot, tap, noInstallCard, drawerGo } from "./kit.mjs";

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

for (const device of ["iphone13", "iphonese"]) {
  test(`contacts (${device}): open the list, search, open a lead, its cards and its priority`, async () => {
    const { p, page, f } = await open("olive", device);
    try {
      // (Customers is in the drawer: the bar is Home · Schedule · Inbox · Map · Menu)
      await drawerGo(f, "/contacts");
      await settled(f, { hash: "#/contacts" });
      assert.equal(await title(f), "Customers");
      assert.match(await f.textContent("#ct-count"), /^1\d\d contacts/, "the Customers tile: customers only (leads have their own screen)");
      assert.equal(await f.getAttribute('[data-tile="ct"][data-key="customer"]', "aria-pressed"), "true", "the Customers tile is on");
      assert.deepEqual(await screenProblems(f), [], "the list passes the phone checks");
      await shot(page, `contacts-list-${device}`);
      // search (Rotor's round search button opens the field in place): by phone digits, then by name (one row each)
      assert.equal(await f.isVisible("#ct-q"), false, "no search bar under the title");
      await f.click('#top-rnd [data-own="find"]');
      const search = async (q, name) => {
        await f.fill("#ct-q", q);
        await f.waitForFunction((n) => document.querySelectorAll("#ct-list .rs-lrow").length === 1 && document.getElementById("ct-list").textContent.includes(n), name, { timeout: 5000 });
      };
      await search("555-1902", "Blair Calledonce");
      await search("Newlead", "Avery Newlead");
      await tap(page, f, "#ct-list .rs-lr-main");
      await settled(f, { hash: `#/contacts/${seeded.contacts.lead}` });
      assert.match(await f.textContent("#view"), /Avery Newlead/);
      assert.deepEqual(await screenProblems(f), [], "the contact passes the phone checks");
      assert.deepEqual(await badLinks(f), []);
      await shot(page, `contacts-contact-${device}`);
      // Rotor's lead page (17-lead-detail): the profile on top (STAGE, EST. VALUE, FOLLOW-UP; Create Customer), then
      // Conversation | Service | Opportunities | Payments | Activity | Files; Follow-ups, Deals and Tasks (M2b) on Opportunities
      await f.waitForFunction(() => !document.querySelector("#view .sk"), null, { timeout: 10000 });
      for (const id of ["ct-card-properties", "ct-mod-sales", "ct-card-tasks", "ct-card-activity", "ct-card-calls", "ct-card-deals"]) assert.ok(await f.$(`#${id}`), id);
      assert.deepEqual(await f.$$eval('#view [data-seg="ctab"]', (els) => els.map((e) => e.dataset.key)), ["conversation", "service", "opportunities", "payments", "activity", "files"], "Rotor's lead tabs");
      assert.deepEqual(await f.$$eval("#ct-stat .ct-sv-l", (els) => els.map((e) => e.textContent)), ["Stage", "Est. value", "Follow-up", "Next visit"]);
      assert.ok(await f.isVisible("#view [data-make-customer]"), "Create Customer");
      await f.click('[data-seg="ctab"][data-key="opportunities"]');
      assert.match(await f.textContent("#ct-mod-sales"), /New lead/i, "the Follow-ups card shows the follow-up");
      assert.match(await f.textContent(".rs-name .pill"), /^(New|Open|Quoted|Following up|High)$/, "the stage (or the priority) pill beside the name");
      assert.deepEqual(await screenProblems(f), [], "the Sales cards pass the phone checks");
      await shot(page, `contacts-sales-tab-${device}`);
      // a lead's priority (Rotor's): the "..." sets it, the pill shows it
      await f.click("#top-more");
      await f.waitForSelector(".sheet.on [data-priority]");
      await f.click(".sheet.on [data-priority]");
      await f.waitForSelector('.sheet.on [data-pick="\\"high\\""]');
      await f.click('.sheet.on [data-pick="\\"high\\""]');
      await f.waitForFunction(() => (document.querySelector(".rs-name .pill") || {}).textContent === "High", null, { timeout: 8000 });
      assert.deepEqual(await screenProblems(f), [], "the priority pill passes the phone checks");
      // back keeps the search
      await f.click("#top-back");
      await settled(f, { hash: "#/contacts" });
      assert.equal(await f.inputValue("#ct-q"), "Newlead");
      await p.clean();
    } finally { await p.close(); }
  });
}

test("contacts: a tech's quick lead, and no contact list for a tech", async () => {
  const { p, page, f } = await open("theo", "iphonese");
  try {
    await goTo(f, "/contacts");
    assert.match(await f.textContent("#view"), /Not for this login/);
    await goTo(f, "/leads/new");
    assert.equal(await title(f), "Quick lead");
    assert.deepEqual(await screenProblems(f), [], "the quick lead form passes the phone checks");
    await shot(page, "contacts-quick-lead");
    const fields = await f.$$eval("#view input, #view textarea", (els) => els.map((e) => e.name).filter(Boolean));
    assert.ok(fields.includes("name") && fields.includes("phone"), `the form asks for a name and a phone (${fields.join(", ")})`);
    await f.fill('#view [name="name"]', "Jordan Quickpick");
    await f.fill('#view [name="phone"]', "763-555-1990");
    await f.click('#view button[type="submit"]');
    await settled(f, { hash: "#/today" });
    assert.match(await f.textContent(".toasts"), /Sent to the office/);
    // the office sees the lead (the tech was told only its id)
    const o = await phone(browser, srv);
    try {
      await signIn(o, "olive");
      const list = await o.ctx.request.get("/api/crm/contacts?q=Quickpick", { headers: { "x-crm": "1" } });
      assert.equal(list.status(), 200);
      assert.equal((await list.json()).data.length, 1, "the office has the quick lead");
    } finally { await o.close(); }
    await p.clean();
  } finally { await p.close(); }
});

test("contacts: the first slice's customer list for the office, not for a tech", async () => {
  const { p, f } = await open("olive", "iphone13");
  try {
    await goTo(f, "/legacy/customers");
    assert.equal(await title(f), "Customers");
    assert.deepEqual(await badLinks(f), []);
    await p.clean();
  } finally { await p.close(); }
  const t = await phone(browser, srv);
  try {
    await signIn(t, "theo");
    const res = await t.page.goto("/crm/legacy");
    assert.equal(res.status(), 403, "/crm/legacy for a tech");
    await t.clean({ allow: [/403/] });
  } finally { await t.close(); }
});

// The Rotor guide's Customers (guide-gaps §2.5): the tiles are the filter, two-line rows with the lifetime
// value and what is owed, the filter sheet's sort, Select with a bulk tag, a row's long press; the
// contact's Service tab (its tiles), the Mute row, the Files card and "Open their portal". Both themes.
async function themed(page, f, theme) {
  if (theme !== "light") return f;
  await f.evaluate(() => localStorage.setItem("crm-theme", "light"));
  await page.reload();
  const g = await crmFrame(page);
  await settled(g);
  return g;
}

for (const [device, theme] of [["iphone13", "dark"], ["iphonese", "light"], ["iphone13", "light"], ["iphonese", "dark"]]) {
  test(`customers (${device}, ${theme}): tiles, rows, sort, select; the contact's Service tab, Mute, Files, portal`, async () => {
    const { p, page, f: f0 } = await open("olive", device);
    try {
      const g = await themed(page, f0, theme);
      await goTo(g, "/contacts");
      await g.waitForSelector("#ct-list .rs-lrow");
      const tiles = await g.$$eval('[data-tile="ct"]', (els) => els.map((e) => e.dataset.key));
      assert.deepEqual(tiles, ["customer", "plan", "owes", "former_customer", "archived", ""], "Customers · Plan members · Owes · Former · Archived · Everyone");
      // a row: the name, town (and the owner) on line 2, a status pill, one round call
      const row = await g.$eval("#ct-list .rs-lrow", (el) => ({ t: el.querySelector(".rs-lr-t").textContent, sub: el.querySelector(".rs-lr-s").textContent, call: !!el.querySelector('.rs-acts a[href^="tel:"]') }));
      assert.ok(row.t && row.sub && row.call, JSON.stringify(row));
      // the Everyone tile: leads too; tapping Customers again goes back
      await g.click('[data-tile="ct"][data-key=""]');
      await g.waitForFunction(() => /^2\d\d contacts/.test(document.getElementById("ct-count").textContent));
      await g.click('[data-tile="ct"][data-key="customer"]');
      await g.waitForFunction(() => /^1\d\d contacts/.test(document.getElementById("ct-count").textContent));
      assert.deepEqual(await screenProblems(g), [], "the list passes the phone checks");
      await shot(page, `g2-customers-${device}-${theme}`);
      // the filter sheet: sort by newest
      await g.click('#top-rnd [data-own="filter"]');
      await g.waitForSelector(".sheet.on [data-f-show]");
      assert.match(await g.textContent(".sheet.on"), /Lifetime value[\s\S]*Sale value[\s\S]*Outstanding[\s\S]*Newest/);
      assert.deepEqual(await screenProblems(g), [], "the filter sheet");
      await g.click('.sheet.on [data-f-group="sort"][data-f-val="new"]');
      await g.click(".sheet.on [data-f-show]");
      await g.waitForFunction(() => !document.querySelector(".sheet.on"), null, { timeout: 5000 });
      assert.equal(await g.$(".ct-ltr"), null, "no letter headings when sorted by newest");
      assert.match(await g.getAttribute('#top-rnd [data-own="filter"]', "aria-label"), /on/);
      if (device === "iphone13" && theme === "dark") {
        // Select: pick two, tag them
        await g.click('#top-rnd [data-own="more"]');
        await g.waitForSelector(".sheet.on [data-select]");
        await g.click(".sheet.on [data-select]");
        await g.waitForSelector(".ct-bulk");
        const picks = await g.$$("#ct-list [data-pick]");
        await picks[0].click();
        await picks[1].click();
        assert.match(await g.textContent(".ct-bulk-n"), /2 picked/);
        assert.deepEqual(await screenProblems(g), [], "Select and its bar");
        await shot(page, `g2-customers-select-${device}`);
        await g.click('.ct-bulk [data-bulk="tag"]');
        await g.fill('.sheet.on [name="tag"]', "Spring list");
        await g.click('.sheet.on button[type="submit"]');
        await g.waitForFunction(() => /Tagged: 2/.test((document.querySelector(".toasts") || {}).textContent || ""), null, { timeout: 8000 });
        await g.waitForFunction(() => !document.querySelector(".ct-bulk"), null, { timeout: 8000 });
        // a long press (a right click on a desk) opens the row's "..."
        await g.waitForSelector("#ct-list .rs-lrow[data-hold]");
        await g.dispatchEvent("#ct-list .rs-lrow[data-hold] .rs-lr-main", "contextmenu");
        await g.waitForSelector(".sheet.on .rs-act");
        assert.match(await g.textContent(".sheet.on"), /Edit[\s\S]*Archive/);
        await g.click(".sheet.on [data-sheet-x]");
      }
      // the contact (Rotor's profile): the summary box, Mute, Edit / Portal / ...; Service first (tiles, Service Plans,
      // Scheduled Jobs, Pending Jobs with Delay and Schedule, each with its "+ New"); Payments; Files; the portal
      await goTo(g, `/contacts/${seeded.contacts.plan}`);
      await g.waitForFunction(() => !document.querySelector("#view .ct-loading"), null, { timeout: 10000 });
      assert.deepEqual(await g.$$eval("#ct-stat .ct-sv-l", (els) => els.map((e) => e.textContent)), ["Lifetime value", "Sale value", "Frequency", "Service type"]);
      assert.match(await g.textContent("#ct-stat"), /Quarterly/, "the plan's frequency");
      assert.ok(await g.isVisible("#ct-mute .switch"), "the Mute switch up front");
      assert.ok(await g.isVisible(".ct-btns [data-portal]") && await g.isVisible(".ct-btns [data-ct-more]"), "Edit, Portal, ...");
      assert.ok(await g.$("#ct-card-files"), "the Files card");
      assert.deepEqual(await g.$$eval('#view [data-seg="ctab"]', (els) => els.map((e) => e.dataset.key)), ["service", "payments", "conversation", "opportunities", "activity", "files"], "Rotor's tabs");
      assert.match(await g.textContent('[data-pane="service"] [data-card="plan"] .rs-ch'), /Service Plans[\s\S]*New Plan/);
      assert.ok(await g.$('[data-pane="service"] [data-card="pending"] [data-job-delay]'), "Pending Jobs: Delay");
      await g.click('[data-seg="ctab"][data-key="service"]');
      await g.waitForSelector('[data-pane="service"]:not(.off) #ct-svc-tiles');
      assert.match(await g.textContent("#ct-svc-tiles"), /Scheduled jobs[\s\S]*Avg completed job[\s\S]*Avg future job[\s\S]*Outstanding/);
      assert.deepEqual(await screenProblems(g), [], "the Service tab");
      await shot(page, `g2-contact-service-${device}-${theme}`);
      await g.click('[data-seg="ctab"][data-key="payments"]');
      assert.ok(await g.isVisible('[data-pane="payments"] #ct-mod-money'), "invoices on Payments");
      assert.deepEqual(await screenProblems(g), [], "the Payments tab");
      await g.click("#top-more");
      await g.waitForSelector(".sheet.on [data-portal]");
      await g.click(".sheet.on [data-portal]");
      await g.waitForSelector('.sheet.on a[href*="/p/"]', { timeout: 8000 });
      assert.match(await g.textContent(".sheet.on"), /15 minutes/);
      await g.click(".sheet.on [data-sheet-x]");
      await p.clean();
    } finally { await p.close(); }
  });
}

test("customers on a desk (desk1440): Rotor's table, and the contact's two columns (the profile, the tabs)", async () => {
  const { p, page, f } = await open("olive", "desk1440");
  try {
    await goTo(f, "/contacts");
    await f.waitForSelector("#ct-list .rs-table .rs-trow");
    assert.deepEqual(await f.$$eval("#ct-list .rs-thead .rs-td", (els) => els.map((e) => e.textContent)), ["Name", "Email", "Phone", "City", "Status", "SV", "LV", "Outstanding", "Assigned to"]);
    assert.match(await f.textContent("#top-action"), /Add Customer/);
    assert.deepEqual(await screenProblems(f), []);
    await shot(page, "r2b-customers-desk1440");
    await goTo(f, `/contacts/${seeded.contacts.plan}`);
    await f.waitForFunction(() => !document.querySelector(".ct-loading"), null, { timeout: 10000 });
    const holder = (await f.$("#pane:not([hidden]) .ct-page")) ? "#pane" : "#view";
    const prof = await f.$eval(`${holder} .ct-prof`, (el) => el.getBoundingClientRect().toJSON());
    const main = await f.$eval(`${holder} .ct-main`, (el) => el.getBoundingClientRect().toJSON());
    assert.ok(main.x >= prof.x + prof.width && Math.abs(main.y - prof.y) < 8 && prof.width < 340, "the profile on the left, the tabs beside it");
    assert.ok(await f.isVisible(`${holder} [data-pane="service"]`), "Service");
    assert.deepEqual(await screenProblems(f), []);
    await shot(page, "r2b-contact-desk1440");
    // the list beside the contact narrows to two-line rows
    await f.waitForSelector("#ct-list .rs-lrow");
    await p.clean();
  } finally { await p.close(); }
});
