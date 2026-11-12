// Phone checks of Home (design §9.2 "Today" for owners; industry spec
// 13.1), the office's new bar (Home · Inbox · Schedule · Customers · Sales · Menu),
// the Sales switch and the Menu, at iPhone 13 and SE sizes: the numbers
// from the made-up Rotor snapshot the server seals for its throwaway key,
// today's visits, "Needs you", quick actions, the charts, where each tap
// goes, the empty state before any CRM data, and a tech who never sees the
// numbers. No console errors, no CSP violations, no sideways scroll, 44 px
// targets. E2E_SHOTS=<dir> saves the screenshots.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { start } from "./server.mjs";
import { launch, phone, signIn, crmFrame, goTo, settled, title, hashOf, backShown, screenProblems, badLinks, shot, noInstallCard } from "./kit.mjs";

let srv, browser, team, seeded;
before(async () => {
  srv = await start();
  browser = await launch();
  team = await srv.seed({ teamOnly: true });
});
after(async () => { await browser?.close(); await srv?.close(); });

const DEVICES = ["iphone13", "iphonese"];

// The CRM inside /office for this phone, on Home.
async function home(login, { device = "iphone13", office = false } = {}) {
  const p = await phone(browser, srv, { device, office });
  await signIn(p, login);
  await p.page.goto("/office");
  const f = await crmFrame(p.page);
  await settled(f);
  await noInstallCard(p.page);
  return { p, page: p.page, f };
}
// A screenshot of the whole scroll: the viewport grown to the content, then put back.
async function fullShot(page, f, name) {
  if (!process.env.E2E_SHOTS) return;
  const vp = page.viewportSize();
  const h = await f.evaluate(() => document.getElementById("view").scrollHeight);
  await page.setViewportSize({ width: vp.width, height: Math.min(h + 160, 5000) });
  await page.waitForTimeout(300);
  await shot(page, name);
  await page.setViewportSize(vp);
  await page.waitForTimeout(200);
}
const text = (f, sel) => f.$eval(sel, (el) => el.innerText.replace(/\s+/g, " ").trim());
// back to Home (from /office the first entry may have no hash at all)
async function backHome(f) {
  await f.click("#top-back");
  await f.waitForFunction(() => document.getElementById("top-title").textContent === "Home" && !document.querySelector("#view [aria-busy=true]") && document.querySelector(".hm"));
}
const tiles = (f) => f.$$eval(".hm-kpi .hm-label", (els) => els.map((e) => e.textContent.replace(/\s+/g, " ").trim()));

test("before any CRM data: Rotor's numbers, a friendly empty Today, the office's new bar", async () => {
  for (const device of DEVICES) {
    const { p, page, f } = await home("olive", { device, office: true });
    try {
      assert.equal(await title(f), "Home");
      assert.ok(["", "#/today"].includes(await hashOf(f)), "the app opens on Home");
      assert.deepEqual(await f.$$eval("#tabs [data-tab]", (els) => els.map((e) => e.querySelector("span").textContent)), ["Home", "Inbox", "Schedule", "Customers", "Sales", "Menu"]);
      assert.equal(await f.getAttribute('#tabs [data-tab="home"]', "aria-current"), "page");
      // money this month, from Rotor, with its weekly columns
      assert.match(await text(f, ".hm-hero"), /^Collected this month Nov 1–16 \$[\d,]+ /);
      assert.match(await text(f, ".hm-hero"), /From Rotor · updated Nov 16/);
      assert.equal(await f.$$eval('[data-chart="weekly"] .hc-col', (x) => x.length), 12);
      assert.deepEqual(await tiles(f), ["Jobs completed", "Average ticket", "Close rate", "Active plans", "New leads", "Quotes out"]);
      assert.match(await text(f, ".hm-sec-h"), /^This month From Rotor · updated Nov 16$/i);
      // the day: nothing booked yet, said kindly
      assert.match(await text(f, ".hm-today"), /No visits booked today/);
      assert.match(await text(f, ".hm-today .hm-stats"), /^0 visits 0 done 0 to book 0 plan visits due$/);
      assert.ok(await f.$(".hm-needs"), "Needs you is there");
      assert.deepEqual(await screenProblems(f), []);
      assert.deepEqual(await badLinks(f), []);
      await shot(page, `home-empty-${device}`);
      await fullShot(page, f, `home-empty-${device}-full`);
      await p.clean();
    } finally { await p.close(); }
  }
});

// The real day (after the empty state above): seeded once, for every test below.
async function day() {
  if (!seeded) {
    seeded = await srv.seed({ home: true });
    await new Promise((ok) => setTimeout(ok, 2500));   // the lanes settle the seed's events
  }
  return seeded;
}

test("an owner's Home on a real day: the numbers, today's visits, what needs them, at both sizes", async () => {
  await day();
  for (const device of DEVICES) {
    const { p, page, f } = await home("olive", { device, office: true });
    try {
      assert.equal(await title(f), "Home");
      assert.match(await text(f, ".hm-head"), /^Tuesday, November 17 Morning, Olive/i, "the server's day and hour");
      // quick actions: each opens its create screen
      assert.deepEqual(await f.$$eval(".hm-qa", (els) => els.map((e) => [e.textContent.trim(), e.getAttribute("href")])), [["New lead", "#/leads/new"], ["New quote", "#/quotes/new"], ["Book a visit", "#/jobs/new"], ["Log a call", "#/calls/log"]]);
      assert.equal(await f.$("#fab"), null, "Home's quick actions take the create button's place");
      // today: seven visits in time order, who and where, one done, one under way
      const rows = await f.$$eval(".hm-visits .hv-row", (els) => els.map((e) => ({ href: e.getAttribute("href"), t: e.querySelector(".hv-time").textContent.replace(/\s+/g, " ").trim(), who: e.querySelector(".nm").textContent, sub: e.querySelector(".sub").textContent, av: e.querySelectorAll(".hv-av").length, pill: (e.querySelector(".pill") || {}).textContent || "" })));
      assert.equal(rows.length, 7);
      assert.ok(rows.every((r) => /^#\/visits\/vs_/.test(r.href) && r.who && r.sub && r.av >= 1), JSON.stringify(rows));
      assert.deepEqual(rows.map((r) => r.pill).filter(Boolean).sort(), ["Done", "Working"]);
      assert.ok(rows.some((r) => r.av === 2), "Olive and Theo together at one");
      assert.match(await text(f, ".hm-today .hm-stats"), /^7 visits 1 done \d+ to book \d+ plan visits due$/);
      // needs you: a row per kind, each with its count
      const needs = await f.$$eval(".hm-need", (els) => els.map((e) => [e.querySelector(".nl").textContent, e.getAttribute("href")]));
      for (const [label, href] of [["Calls due now", "#/calls"], ["Possible duplicates", "#/merge"], ["Requests waiting for your OK", "#/approvals"], ["Plan visits to book", "#/plans/due"], ["Unsigned agreements", "#/plans?status=pending"], ["Quotes waiting on the customer", "#/quotes?status=sent"], ["Tasks for you", "#/tasks"]]) {
        assert.ok(needs.some(([l, h]) => l === label && h === href), `${label} → ${href} in ${JSON.stringify(needs)}`);
      }
      // the cards and their charts, drawn here (no frame of the dashboard)
      for (const chart of ["weekly", "leads", "visits", "monthly"]) assert.ok(await f.$(`[data-chart="${chart}"] svg .hc-col`), `the ${chart} chart`);
      assert.equal(await f.$$eval('[data-chart="monthly"] .hc-col', (x) => x.length), 12);
      assert.equal(page.frames().filter((x) => /\/dashboard/.test(x.url())).length, 0, "no dashboard frame on Home");
      assert.deepEqual(await f.$$eval(".hm-card .hm-card-h h3", (els) => els.map((e) => e.firstChild.textContent.trim())), ["Today", "Needs you", "Sales", "Plans", "Jobs", "Collected by month"]);
      assert.deepEqual(await screenProblems(f), []);
      assert.deepEqual(await badLinks(f), []);
      await shot(page, `home-owner-${device}`);
      await fullShot(page, f, `home-owner-${device}-full`);
      await p.clean();
    } finally { await p.close(); }
  }
});

test("taps: a chart column reads out, a tile opens its Dashboard view, a visit opens, Needs you opens its list", async () => {
  await day();
  const { p, page, f } = await home("olive", { device: "iphonese", office: true });
  try {
    // the readout starts on the latest week and follows a tap (and the arrow keys)
    const before = await text(f, "#read-weekly");
    const box = await (await f.$('[data-chart="weekly"]')).boundingBox();
    await f.click('[data-chart="weekly"]', { position: { x: box.width * 0.45, y: box.height / 2 } });
    const after = await text(f, "#read-weekly");
    assert.notEqual(after, before, `the readout moved (${before} → ${after})`);
    assert.match(after, /^\$[\d,]+ week of [A-Z][a-z]{2} \d+$/);
    await shot(page, "home-chart-tap-iphonese");
    await f.focus('[data-chart="weekly"]');
    await page.keyboard.press("End");
    assert.equal(await text(f, "#read-weekly"), before, "End: the latest week again");
    // a KPI tile → the Dashboard's view (this phone has the office sign-in)
    await f.click('.hm-kpi[href="#/dashboard/sales"]');
    await settled(f, { hash: "#/dashboard/sales" });
    assert.equal(await f.getAttribute('[data-view="sales"]', "aria-pressed"), "true");
    assert.equal(await backShown(f), true);
    await backHome(f);
    // a visit
    const visit = await f.getAttribute(".hm-visits .hv-row", "href");
    await f.click(`.hm-visits .hv-row[href="${visit}"]`);
    await settled(f, { hash: visit });
    assert.match(await f.textContent("#view"), /Robin Workday|Alex Workday|Workday|Afternoon/, "the visit's screen");
    await backHome(f);
    // a Needs you row
    await f.click('.hm-need[href="#/merge"]');
    await settled(f, { hash: "#/merge" });
    assert.equal(await title(f), "Merge review");
    await p.clean();
  } finally { await p.close(); }
});

test("the office without the office sign-in: the numbers (reports:read), See more opens the CRM's own screens", async () => {
  await day();
  const { p, page, f } = await home("ada", { device: "iphone13" });
  try {
    assert.equal(await title(f), "Home");
    assert.ok((await tiles(f)).includes("Close rate"));
    const more = await f.$$eval(".hm-more", (els) => els.map((e) => e.getAttribute("href")).filter(Boolean));
    assert.ok(!more.some((h) => h.startsWith("#/dashboard")), `no Dashboard links without the office sign-in: ${more.join(", ")}`);
    assert.ok(more.includes("#/calls") && more.includes("#/plans") && more.includes("#/schedule"), more.join(", "));
    assert.deepEqual(await screenProblems(f), []);
    await shot(page, "home-admin-iphone13");
    await goTo(f, "/menu");
    assert.equal(await f.$('.mtile[href="#/dashboard"]'), null, "no Dashboard in the Menu either");
    assert.equal(await f.$('.mtile[href="#/tools/lights"]'), null, "nor the office tools");
    await p.clean();
  } finally { await p.close(); }
});

test("a tech never sees the numbers: their own Today, and /home tells them nothing", async () => {
  await day();
  for (const device of DEVICES) {
    const { p, page, f } = await home("theo", { device, office: true });
    try {
      assert.equal(await title(f), "Today");
      assert.equal(await f.$(".hm, .hm-kpi, .hm-hero, [data-chart]"), null, "no Home");
      assert.doesNotMatch(await f.textContent("#view"), /\$\d|Collected|Close rate|Active plans/);
      const tabs = await f.$$eval("#tabs [data-tab]", (els) => els.map((e) => e.dataset.tab));
      assert.ok(!tabs.includes("home") && !tabs.includes("menu") && !tabs.includes("sales"), tabs.join(", "));
      const res = await p.ctx.request.get("/api/crm/home", { headers: { "x-crm": "1" } });
      assert.equal(res.status(), 200);
      const d = (await res.json()).data;
      assert.deepEqual([d.kpis, d.today, d.needs], [null, null, []]);
      assert.deepEqual(await screenProblems(f), []);
      await shot(page, `home-tech-${device}`);
      await p.clean();
    } finally { await p.close(); }
  }
});

test("the Sales tab: Calls · Quotes · Tasks in one switch, the tab lit on each; the Menu's sections", async () => {
  await day();
  for (const device of DEVICES) {
    const { p, page, f } = await home("olive", { device, office: true });
    try {
      await f.click('#tabs [data-tab="sales"]');
      await settled(f, { hash: "#/calls" });
      assert.equal(await title(f), "Leads & calls");
      assert.deepEqual(await f.$$eval("#subnav .seg", (els) => els.map((e) => e.textContent)), ["Calls", "Quotes", "Tasks"]);
      assert.equal(await f.getAttribute('#subnav [href="#/calls"]', "aria-current"), "page");
      await shot(page, `home-sales-calls-${device}`);
      for (const [path, name] of [["/quotes", "Quotes"], ["/tasks", "Tasks"]]) {
        await f.click(`#subnav [href="#${path}"]`);
        await settled(f, { hash: "#" + path });
        assert.equal(await title(f), name);
        assert.equal(await f.getAttribute('#tabs [data-tab="sales"]', "aria-current"), "page", `Sales lit on ${path}`);
        assert.equal(await backShown(f), false, `${path} is one of the tab's screens: no back arrow`);
        assert.ok(await f.$("#fab"), "the create button on Sales");
        assert.deepEqual(await screenProblems(f), []);
      }
      await shot(page, `home-sales-tasks-${device}`);
      // a screen under it keeps the tab lit and hides the switch
      await goTo(f, `/quotes/${seeded.quotes.sent}`);
      assert.equal(await f.$eval("#subnav", (el) => el.hidden), true);
      assert.equal(await f.getAttribute('#tabs [data-tab="sales"]', "aria-current"), "page");
      // the Menu: sections of large tiles, the tab lit on what it opens
      await f.click('#tabs [data-tab="menu"]');
      await settled(f, { hash: "#/menu" });
      assert.deepEqual(await f.$$eval(".menu-sec .section-h", (els) => els.map((e) => e.textContent)), ["Work", "Sales", "Customers", "Money", "Messages & automations", "Office tools", "Admin"]);
      assert.deepEqual(await screenProblems(f), []);
      await shot(page, `home-menu-${device}`);
      await fullShot(page, f, `home-menu-${device}-full`);
      await f.click('.mtile[href="#/plans"]');
      await settled(f, { hash: "#/plans" });
      assert.equal(await f.getAttribute('#tabs [data-tab="menu"]', "aria-current"), "page", "Plans is the Menu's");
      await p.clean();
    } finally { await p.close(); }
  }
});

// ------------------------------------------------------------ the desk (1440 x 900, 1024 x 768)

const box = (f, sel) => f.$eval(sel, (el) => { const r = el.getBoundingClientRect(); return { x: Math.round(r.left), y: Math.round(r.top), w: Math.round(r.width), h: Math.round(r.height) }; });

test("on a desk: the sidebar with every section, the header's search and New, Home as a grid of cards", async () => {
  await day();
  for (const device of ["desk1440", "desk1024"]) {
    const { p, page, f } = await home("olive", { device, office: true });
    try {
      assert.equal(await title(f), "Home");
      assert.equal(await f.$eval("#tabs", (el) => getComputedStyle(el).display), "none", "no bottom bar on a desk");
      assert.ok(await f.isVisible("#side"), "the sidebar");
      assert.deepEqual(await f.$$eval("#side .side-h span:first-child", (els) => els.map((e) => e.textContent)), ["Work", "Sales", "Customers", "Money", "Messages & automations", "Office tools", "Admin"]);
      assert.equal(await f.getAttribute('#side [data-path="/today"]', "aria-current"), "page", "Home lit");
      assert.match(await f.textContent('#side [data-tab="home"] .badge'), /^\d+$/, "Home's badge");
      assert.ok(await f.isVisible("#top-q") && await f.isVisible("#top-new") && await f.isVisible("#top-me"), "search, New, the person");
      assert.equal(await f.$eval("#fab", (el) => getComputedStyle(el).display).catch(() => "none"), "none", "New is in the header");
      // the grid: the month's tiles in a row (six at 1440, three at 1024), money beside money by month, today beside what needs you
      const tiles = await f.$$eval(".hm-kpi", (els) => els.map((e) => Math.round(e.getBoundingClientRect().top)));
      const perRow = tiles.filter((y) => y === tiles[0]).length;
      assert.equal(perRow, device === "desk1440" ? 6 : 3, `tiles per row: ${tiles.join(",")}`);
      const [hero, money, today, needs, sales, plans, jobs] = await Promise.all([".hm-hero", ".hm-money", ".hm-today", ".hm-needs", ".hm-sales", ".hm-plans", ".hm-jobs"].map((s) => box(f, s)));
      assert.equal(hero.y, money.y, "money beside money by month");
      assert.ok(money.x > hero.x + hero.w - 1);
      assert.equal(today.y, needs.y, "today beside what needs you");
      assert.ok(sales.y === plans.y && plans.y === jobs.y, "Sales, Plans and Jobs side by side");
      // the charts use their cards' width and stay inside them
      for (const c of ["weekly", "monthly", "leads", "visits"]) {
        const [card, svg] = await Promise.all([box(f, `[data-chart="${c}"]`), box(f, `[data-chart="${c}"] svg`)]);
        assert.ok(Math.abs(card.w - svg.w) <= 2, `${c}: ${svg.w} in ${card.w}`);
      }
      assert.deepEqual(await screenProblems(f), []);
      await shot(page, `home-desk-${device}`);
      await fullShot(page, f, `home-desk-${device}-full`);
      // the groups fold and remember it
      await f.click('#side .side-grp[data-grp="office"] .side-h');
      assert.equal(await f.getAttribute('#side .side-grp[data-grp="office"] .side-h', "aria-expanded"), "false");
      assert.equal(await f.isVisible('#side a[href="#/tools/lights"]'), false);
      await f.click('#side .side-grp[data-grp="office"] .side-h');
      assert.equal(await f.isVisible('#side a[href="#/tools/lights"]'), true);
      // New and the person's menu
      await f.click("#top-new");
      assert.deepEqual(await f.$$eval("#new-pop a span", (els) => els.map((e) => e.textContent)).then((x) => x.slice(0, 2)), ["New lead", "New quote"]);
      await f.click("#top-me");
      assert.equal(await f.isVisible("#new-pop"), false, "one menu at a time");
      assert.ok(await f.isVisible("#me-pop [data-signout]"));
      await page.keyboard.press("Escape");
      assert.equal(await f.isVisible("#me-pop"), false);
      await p.clean();
    } finally { await p.close(); }
  }
});

test("on a desk: search finds a customer; Contacts and Quotes open beside their list; a phone keeps one screen", async () => {
  await day();
  const { p, page, f } = await home("olive", { device: "desk1440", office: true });
  try {
    await f.fill("#top-q", "Afternoon");
    await f.waitForSelector('#search-pop:not([hidden]) a[href^="#/contacts/"]');
    const hits = await f.$$eval("#search-pop .nm", (els) => els.map((e) => e.textContent));
    assert.ok(hits.length >= 3 && hits.every((h) => /Afternoon/.test(h)), hits.join(", "));
    await shot(page, "home-desk-search");
    const href = await f.getAttribute('#search-pop a[href^="#/contacts/"]', "href");
    await f.click(`#search-pop a[href="${href}"]`);
    await settled(f, { hash: href });
    // the contact beside the Contacts list, its row lit, the list where it was
    assert.equal(await f.isVisible("#pane"), true);
    assert.ok(await f.$("#view #ct-q"), "the list stays on the left");
    assert.match(await f.textContent("#pane"), /Afternoon/);
    assert.equal(await f.getAttribute('#side [data-path="/contacts"]', "aria-current"), "page", "Contacts lit in the sidebar");
    assert.equal(await f.inputValue("#top-q"), "", "the search box is cleared");
    // search the list; open another from it: the list keeps its words, the pane changes
    await f.fill("#ct-q", "Workday");
    await page.waitForTimeout(400);
    const other = await f.$$eval("#ct-list a.row", (as) => as.map((a) => a.getAttribute("href")));
    assert.ok(other.length >= 4, `the list filters (${other.length})`);
    await f.click(`#ct-list a.row[href="${other[1]}"]`);
    await settled(f, { hash: other[1] });
    assert.equal(await f.inputValue("#ct-q"), "Workday", "the list kept its search");
    assert.equal(await f.getAttribute(`#ct-list a.row[href="${other[1]}"]`, "aria-current"), "true", "the open row is lit");
    assert.deepEqual(await screenProblems(f), []);
    await shot(page, "home-desk-contacts-split");
    // back to the list alone: the pane asks what to open
    await goTo(f, "/contacts");
    assert.match(await f.textContent("#pane"), /Pick one of the contacts/);
    // Quotes too
    await goTo(f, `/quotes/${seeded.quotes.sent}`);
    assert.ok(await f.$('#view [data-chip]'), "the quotes list on the left");
    assert.match(await f.textContent("#pane"), /SQ-|Q-/);
    await shot(page, "home-desk-quotes-split");
    // narrower than 1000 px: one screen at a time again
    await page.setViewportSize({ width: 960, height: 800 });
    await f.waitForFunction(() => document.getElementById("pane").hidden && !document.getElementById("app").classList.contains("split"));
    assert.equal(await hashOf(f), `#/quotes/${seeded.quotes.sent}`);
    await settled(f);
    assert.match(await f.textContent("#view"), /SQ-|Q-/, "the quote fills the view");
    await p.clean();
  } finally { await p.close(); }
  // a phone: the contact alone, the pane never shows
  const q = await home("olive", { device: "iphone13", office: true });
  try {
    await goTo(q.f, `/contacts/${seeded.contacts.customer}`);
    assert.equal(await q.f.$eval("#pane", (el) => el.hidden), true);
    assert.equal(await q.f.$("#view #ct-q"), null);
    await q.p.clean();
  } finally { await q.p.close(); }
});

test("on a desk: a tech gets their own sidebar (no sections, no search, no numbers)", async () => {
  await day();
  const { p, page, f } = await home("theo", { device: "desk1440" });
  try {
    assert.equal(await title(f), "Today");
    // a tech's own bar as a sidebar: Today, Time and Pay (the tech app, M4b), Me
    assert.deepEqual(await f.$$eval("#side .side-item .sl", (els) => els.map((e) => e.textContent)), ["Today", "Inbox", "Time", "Pay", "Me"]);
    assert.equal(await f.$("#side .side-grp"), null);
    assert.equal(await f.$("#top-q"), null, "no customer search for a tech");
    assert.equal(await f.$(".hm-kpi, .hm-hero"), null);
    assert.deepEqual(await screenProblems(f), []);
    await shot(page, "home-desk-tech");
    // a contact opens alone: the list beside it is the office's
    await goTo(f, `/contacts/${seeded.contacts.customer}`);
    assert.equal(await f.$eval("#pane", (el) => el.hidden), true, "no list beside a tech's contact");
    assert.doesNotMatch(await f.textContent("#view"), /Not for this login[\s\S]*Not for this login/);
    await p.clean();
  } finally { await p.close(); }
});

test("on a desk: /office installs as an app (Chrome's own check), and the office password alone keeps its tab row", async () => {
  await day();
  // the office password alone: the old desktop layout, a row of tabs
  const o = await phone(browser, srv, { device: "desk1440", office: true });
  try {
    await o.page.goto("/office");
    await o.page.waitForSelector(".bar .nav");
    const tabs = await o.page.$$eval(".bar .nav [data-tool]", (els) => els.map((e) => e.textContent.trim()));
    assert.ok(tabs.length >= 4, `the tab row: ${tabs.join(", ")}`);
    const cdp = await o.ctx.newCDPSession(o.page);
    const { installabilityErrors } = await cdp.send("Page.getInstallabilityErrors");
    assert.deepEqual(installabilityErrors.map((e) => e.errorId), [], "Chrome can install /office");
    const { url, errors } = await cdp.send("Page.getAppManifest");
    assert.ok(url.endsWith("/office.webmanifest"));
    assert.deepEqual(errors, []);
    await shot(o.page, "home-desk-office-tabs");
    await o.clean();
  } finally { await o.close(); }
  // with a CRM sign-in: the CRM fills the window, sidebar and all, and installs from there too
  const { p, page } = await home("olive", { device: "desk1024", office: true });
  try {
    const cdp = await p.ctx.newCDPSession(page);
    const { installabilityErrors } = await cdp.send("Page.getInstallabilityErrors");
    assert.deepEqual(installabilityErrors.map((e) => e.errorId), []);
    assert.equal(await page.$(".bar .nav"), null, "one app");
    await shot(page, "home-desk-office-crm");
    await p.clean();
  } finally { await p.close(); }
});
