// Phone and desk checks of Home (the owner's Nov 12 choice: today's
// schedule and the money this month, nothing more), the office's bar
// (Home · Inbox · Schedule · Customers · Sales · Menu), the Sales switch and
// the Menu, at iPhone 13 and SE sizes and 1440 x 900 and 1024 x 768: the
// money from the made-up Rotor snapshot the server seals for its throwaway
// key, today's visits, a day with nothing booked ("Next up"), the chart,
// where each tap goes, the empty state before any CRM data, and a tech who
// never sees the money. No console errors, no CSP violations, no sideways
// scroll, 44 px targets. E2E_SHOTS=<dir> saves the screenshots.
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
async function home(login, { device = "iphone13", office = false, before: prep = null } = {}) {
  const p = await phone(browser, srv, { device, office });
  if (prep) await prep(p);
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
const cards = (f) => f.$$eval(".hm-grid > section h3", (els) => els.map((e) => e.textContent.trim()));
// what Home no longer has: the KPI tiles, the quick actions, the dark money card, the month chart, Needs you
const GONE = ".hm-kpi, .hm-qa, .hm-quick, .hm-hero, .hm-needs, .hm-need, .hm-sales, .hm-plans, .hm-jobs, [data-chart=monthly], [data-chart=leads], [data-chart=visits]";
const MONEY = /^Money this month \$[\d,]+ collected Nov 1–16 ▲ \d+% up this year vs the same dates in 2025 Per week \$[\d,]+ Nov 16, so far /;

test("before any CRM data: Rotor's money, a calm empty Today, the office's bar and the create button", async () => {
  for (const device of DEVICES) {
    const { p, page, f } = await home("olive", { device, office: true });
    try {
      assert.equal(await title(f), "Home");
      assert.ok(["", "#/today"].includes(await hashOf(f)), "the app opens on Home");
      assert.deepEqual(await f.$$eval("#tabs [data-tab]", (els) => els.map((e) => e.querySelector("span").textContent)), ["Home", "Schedule", "Inbox", "Customers", "Sales", "Menu"]);
      assert.equal(await f.getAttribute('#tabs [data-tab="home"]', "aria-current"), "page");
      // two cards, Today first
      assert.deepEqual(await cards(f), ["Today", "Money this month"]);
      assert.equal(!!(await f.$(GONE)), false, "nothing else");
      // the day: nothing booked, said calmly
      assert.equal(await text(f, ".hm-today"), "Today Schedule Nothing booked today Nothing on the schedule in the next few weeks.");
      // the money, from Rotor: the month, the year against last year, the weeks so far and the empty slots still ahead
      assert.match(await text(f, ".hm-money"), MONEY);
      assert.match(await text(f, ".hm-money .hm-more-row"), /^From Rotor · updated Nov 16 See more$/);
      assert.equal(await f.$eval(".hm-cmp", (el) => Math.round(el.getBoundingClientRect().height) <= 24), true, "the comparison on one line");
      assert.equal(await f.$$eval('[data-chart="weeks"] .hc-col', (x) => x.length), 6);
      assert.equal(await f.$$eval('[data-chart="weeks"] .hc-col path', (x) => x.length), 4, "Nov 1, 2, 9 and 16 so far; the 23rd and the 30th still ahead");
      // creating is the coral button (the quick actions are gone)
      assert.ok(await f.isVisible("#fab"), "the create button on Home");
      // (the Nov 2026 shell: the round + blurs the screen, search on top, the things to make above it)
      await f.click("#fab");
      await f.waitForSelector(".qk.on");
      assert.match(await f.textContent(".qk"), /Lead/);
      await page.keyboard.press("Escape");
      await f.waitForFunction(() => !document.querySelector(".qk"));
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

const visitRows = (f, sel = ".hm-today .hm-visits .hv-row") => f.$$eval(sel, (els) => els.map((e) => ({ href: e.getAttribute("href"), t: e.querySelector(".hv-time").textContent.replace(/\s+/g, " ").trim(), who: e.querySelector(".nm").textContent, sub: e.querySelector(".sub").textContent, av: e.querySelectorAll(".hv-av").length, ini: [...e.querySelectorAll(".hv-av")].map((a) => a.textContent), pill: (e.querySelector(".pill") || {}).textContent || "" })));
const minutes = (t) => { const m = /^(\d+):(\d+) (AM|PM)$/.exec(t); return m ? ((Number(m[1]) % 12) + (m[3] === "PM" ? 12 : 0)) * 60 + Number(m[2]) : 9999; };

test("an owner's Home on a real day: today's visits in time order, how many are done, the money, at both sizes", async () => {
  await day();
  for (const device of DEVICES) {
    const { p, page, f } = await home("olive", { device, office: true });
    try {
      assert.equal(await title(f), "Home");
      assert.match(await text(f, ".hm-head"), /^Tuesday, November 17 Morning, Olive/i, "the server's day and hour");
      assert.deepEqual(await cards(f), ["Today", "Money this month"]);
      assert.equal(!!(await f.$(GONE)), false);
      // today: seven visits in time order with time, customer, town and the work, who goes (initials), status
      const rows = await visitRows(f);
      assert.equal(rows.length, 7);
      assert.ok(rows.every((r) => /^#\/visits\/vs_/.test(r.href) && r.who && / · /.test(r.sub) && r.av >= 1 && r.ini.every((i) => /^[A-Z]{1,2}$/.test(i))), JSON.stringify(rows));
      assert.deepEqual(rows.map((r) => minutes(r.t)), [...rows.map((r) => minutes(r.t))].sort((a, b) => a - b), "in time order");
      assert.deepEqual(rows.map((r) => r.pill).filter(Boolean).sort(), ["Done", "Working"]);
      assert.ok(rows.some((r) => r.av === 2), "Olive and Theo together at one");
      assert.equal(await text(f, ".hm-progress"), "1 of 7 visits done");
      assert.equal(await f.getAttribute(".hm-today .hm-card-h .hm-more", "href"), "#/schedule");
      // the money card as before the day began (Rotor's numbers)
      assert.match(await text(f, ".hm-money"), MONEY);
      assert.equal(await f.getAttribute(".hm-money .hm-more-row", "href"), "#/dashboard/money", "See more: the full dashboards (this phone has the office sign-in)");
      // Olive goes out on visits: her own day with the clock, under the two cards
      assert.ok(!!(await f.$(".hm-extra .tf-clock")), "My visits");
      assert.equal(page.frames().filter((x) => /\/dashboard/.test(x.url())).length, 0, "no dashboard frame on Home");
      assert.deepEqual(await screenProblems(f), []);
      assert.deepEqual(await badLinks(f), []);
      await shot(page, `home-owner-${device}`);
      await fullShot(page, f, `home-owner-${device}-full`);
      await p.clean();
    } finally { await p.close(); }
  }
});

test("taps: the chart reads each week, See more opens the Money dashboard, a visit opens, Schedule opens the day", async () => {
  await day();
  const { p, page, f } = await home("olive", { device: "iphonese", office: true });
  try {
    // the readout starts on the latest week and follows a tap (and the arrow keys); a week still ahead reads the latest
    const before = await text(f, "#read-weeks");
    assert.match(before, /^\$[\d,]+ Nov 16, so far$/);
    const box = await (await f.$('[data-chart="weeks"]')).boundingBox();
    const x0 = Number(await f.$eval('[data-chart="weeks"]', (el) => el.dataset.x0));
    const slot = Number(await f.$eval('[data-chart="weeks"]', (el) => el.dataset.slot));
    await f.click('[data-chart="weeks"]', { position: { x: x0 + slot * 1.5, y: box.height / 2 } });
    assert.match(await text(f, "#read-weeks"), /^\$[\d,]+ Nov 2–8$/);
    await f.click('[data-chart="weeks"]', { position: { x: x0 + slot * 5.5, y: box.height / 2 } });
    assert.equal(await text(f, "#read-weeks"), before, "Nov 30 is ahead: the latest week reads");
    await f.focus('[data-chart="weeks"]');
    await page.keyboard.press("Home");
    assert.match(await text(f, "#read-weeks"), /^\$[\d,]+ Nov 1$/);
    await page.keyboard.press("ArrowRight");
    assert.match(await text(f, "#read-weeks"), /Nov 2–8$/);
    await page.keyboard.press("End");
    assert.equal(await text(f, "#read-weeks"), before);
    await shot(page, "home-chart-tap-iphonese");
    // See more → the Dashboard's Money view (this phone has the office sign-in)
    await f.click(".hm-money .hm-more-row");
    await settled(f, { hash: "#/dashboard/money" });
    assert.equal(await f.getAttribute('[data-view="money"]', "aria-pressed"), "true");
    assert.equal(await backShown(f), true);
    await backHome(f);
    // a visit
    const visit = await f.getAttribute(".hm-visits .hv-row", "href");
    await f.click(`.hm-visits .hv-row[href="${visit}"]`);
    await settled(f, { hash: visit });
    assert.match(await f.textContent("#view"), /Workday|Afternoon/, "the visit's screen");
    await backHome(f);
    // the Schedule
    await f.click('.hm-today .hm-more[href="#/schedule"]');
    await settled(f, { hash: "#/schedule" });
    assert.equal(await title(f), "Schedule");
    await p.clean();
  } finally { await p.close(); }
});

test("a day with nothing booked: a calm note and the next day with visits (Next up: Monday)", async () => {
  await day();
  // the server's answer as on a Tuesday off with the visits on Monday the 23rd (the server's own day-off logic: home.test.mjs)
  const dayOff = async (p) => p.ctx.route((url) => url.pathname === "/api/crm/home", async (route) => {
    const res = await route.fetch();
    const body = await res.json();
    const t = body.data.today;
    body.data.today = { date: t.date, visits: [], counts: { visits: 0, done: 0 }, next: { date: "2026-11-23", days: 6, count: t.visits.length, visits: t.visits.map((v) => ({ ...v, status: "scheduled" })) } };
    await route.fulfill({ response: res, json: body });
  });
  for (const device of DEVICES) {
    const { p, page, f } = await home("olive", { device, office: true, before: dayOff });
    try {
      assert.match(await text(f, ".hm-today"), /^Today Schedule Nothing booked today Next up: Monday Nov 23 · 7 visits 8:00 AM /);
      assert.equal(!!(await f.$(".hm-progress")), false, "no 'done' line on a day off");
      const rows = await visitRows(f);
      assert.equal(rows.length, 7);
      assert.ok(rows.every((r) => !r.pill), "nothing done yet on a day ahead");
      assert.deepEqual(await screenProblems(f), []);
      await shot(page, `home-dayoff-${device}`);
      await p.clean();
    } finally { await p.close(); }
  }
});

test("the office without the office sign-in: the money (reports:read), See more opens Payments", async () => {
  await day();
  const { p, page, f } = await home("ada", { device: "iphone13" });
  try {
    assert.equal(await title(f), "Home");
    assert.deepEqual(await cards(f), ["Today", "Money this month"]);
    assert.match(await text(f, ".hm-money"), MONEY);
    const more = await f.$$eval("#view a[href]", (els) => els.map((e) => e.getAttribute("href")));
    assert.ok(!more.some((h) => h.startsWith("#/dashboard")), `no Dashboard links without the office sign-in: ${more.join(", ")}`);
    assert.equal(await f.getAttribute(".hm-money .hm-more-row", "href"), "#/payments", "the CRM's own Payments instead");
    assert.equal(!!(await f.$(".hm-extra")), false, "Ada doesn't go out on visits: no My visits");
    assert.deepEqual(await screenProblems(f), []);
    await shot(page, "home-admin-iphone13");
    await goTo(f, "/menu");
    assert.equal(!!(await f.$('.mtile[href="#/dashboard"]')), false, "no Dashboard in the Menu either");
    assert.equal(!!(await f.$('.mtile[href="#/tools/lights"]')), false, "nor the office tools");
    await p.clean();
  } finally { await p.close(); }
});

test("a tech never sees the money: their own Today, and /home tells them nothing", async () => {
  await day();
  for (const device of DEVICES) {
    const { p, page, f } = await home("theo", { device, office: true });
    try {
      assert.equal(await title(f), "Today");
      assert.equal(!!(await f.$(".hm, .hm-money, .hm-today, [data-chart]")), false, "no Home");
      assert.doesNotMatch(await f.textContent("#view"), /\$\d|Collected|collected|Money this month/);
      const tabs = await f.$$eval("#tabs [data-tab]", (els) => els.map((e) => e.dataset.tab));
      assert.ok(!tabs.includes("home") && !tabs.includes("menu") && !tabs.includes("sales"), tabs.join(", "));
      const res = await p.ctx.request.get("/api/crm/home", { headers: { "x-crm": "1" } });
      assert.equal(res.status(), 200);
      const d = (await res.json()).data;
      assert.deepEqual([d.money, d.today, d.notifications], [null, null, null]);
      assert.deepEqual(await screenProblems(f), []);
      await shot(page, `home-tech-${device}`);
      await p.clean();
    } finally { await p.close(); }
  }
});

test("the Sales tab: Pipeline · Leads · Calls · Quotes · Tasks in one switch, the tab lit on each; the Menu sheet", async () => {
  await day();
  for (const device of DEVICES) {
    const { p, page, f } = await home("olive", { device, office: true });
    try {
      await f.click('#tabs [data-tab="sales"]');
      await settled(f, { hash: "#/pipeline" });
      assert.equal(await title(f), "Pipeline");
      assert.deepEqual(await f.$$eval("#subnav .seg", (els) => els.map((e) => e.textContent)), ["Pipeline", "Leads", "Calls", "Quotes", "Tasks"]);
      assert.equal(await f.getAttribute('#subnav [href="#/pipeline"]', "aria-current"), "page");
      await shot(page, `home-sales-pipeline-${device}`);
      for (const [path, name] of [["/leads", "Leads"], ["/calls", "Leads & calls"], ["/quotes", "Quotes"], ["/tasks", "Tasks"]]) {
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
      // the Menu: a sheet of rounded groups (Flyra's), the tab lit on what it opens
      await f.click('#tabs [data-tab="menu"]');
      await f.waitForSelector(".menu-sheet.on");
      assert.deepEqual(await f.$$eval(".menu-sheet .ms-h", (els) => els.map((e) => e.textContent)), ["Work", "Sales", "Customers", "Money", "Messages & automations", "Office tools", "Admin"]);
      assert.deepEqual(await f.$$eval(".menu-sheet .ms-grp:first-of-type .ms-l", (els) => els.map((e) => e.textContent)), ["Home", "Schedule", "Inbox", "Customers", "Leads", "Pipeline"]);
      assert.deepEqual(await screenProblems(f), []);
      await shot(page, `home-menu-${device}`);
      await f.click('.menu-sheet a[href="#/plans"]');
      await settled(f, { hash: "#/plans" });
      assert.equal(await f.getAttribute('#tabs [data-tab="menu"]', "aria-current"), "page", "Plans is the Menu's");
      await p.clean();
    } finally { await p.close(); }
  }
});

// ------------------------------------------------------------ the desk (1440 x 900, 1024 x 768)

const box = (f, sel) => f.$eval(sel, (el) => { const r = el.getBoundingClientRect(); return { x: Math.round(r.left), y: Math.round(r.top), w: Math.round(r.width), h: Math.round(r.height) }; });

test("on a desk: the sidebar with every section, the header's search and New, Today beside the money (over it at 1024)", async () => {
  await day();
  for (const device of ["desk1440", "desk1024"]) {
    const { p, page, f } = await home("olive", { device, office: true });
    try {
      assert.equal(await title(f), "Home");
      assert.equal(await f.$eval("#tabs", (el) => getComputedStyle(el).display), "none", "no bottom bar on a desk");
      assert.ok(await f.isVisible("#side"), "the sidebar");
      // the phone bar's places first, in its order, then the groups, then Settings and Team (Nov 2026)
      assert.deepEqual(await f.$$eval("#side .side-main .sl", (els) => els.map((e) => e.textContent)), ["Home", "Schedule", "Inbox", "Customers", "Sales"]);
      assert.deepEqual(await f.$$eval("#side .side-h span:first-child", (els) => els.map((e) => e.textContent)), ["Work", "Sales", "Customers", "Money", "Messages & automations", "Office tools", "Admin"]);
      assert.deepEqual(await f.$$eval("#side .side-foot .sl", (els) => els.map((e) => e.textContent)), ["Settings", "Team"]);
      assert.equal(await f.getAttribute('#side [data-path="/today"]', "aria-current"), "page", "Home lit");
      assert.match(await f.textContent('#side [data-tab="home"] .badge'), /^\d+$/, "Home's badge (what needs attention)");
      assert.ok(await f.isVisible("#top-q") && await f.isVisible("#top-new") && await f.isVisible("#top-me"), "search, New, the person");
      assert.equal(await f.$eval("#fab", (el) => getComputedStyle(el).display).catch(() => "none"), "none", "New is in the header");
      assert.deepEqual(await cards(f), ["Today", "Money this month"]);
      assert.equal(!!(await f.$(GONE)), false);
      // at 1440 Today (the wider) beside the money; at 1024 Today over the money, both the full width
      const [today, money, grid] = await Promise.all([".hm-today", ".hm-money", ".hm-grid"].map((s) => box(f, s)));
      if (device === "desk1440") {
        assert.equal(today.y, money.y, "side by side");
        assert.ok(money.x >= today.x + today.w, "the money on the right");
        assert.ok(today.w > money.w && money.w >= 340, `widths ${today.w} / ${money.w}`);
      } else {
        assert.ok(money.y >= today.y + today.h, "Today first, the money under it");
        assert.ok(today.w === grid.w && money.w === grid.w, `widths ${today.w} / ${money.w} in ${grid.w}`);
      }
      assert.ok(grid.w <= 1160, `Home's width ${grid.w}`);
      assert.equal(await f.$eval(".hm-cmp", (el) => Math.round(el.getBoundingClientRect().height) <= 24), true, "the comparison on one line");
      // the chart uses its card's width and stays inside it
      const [chart, svg] = await Promise.all([box(f, '[data-chart="weeks"]'), box(f, '[data-chart="weeks"] svg')]);
      assert.ok(Math.abs(chart.w - svg.w) <= 2 && chart.x >= money.x && chart.x + chart.w <= money.x + money.w, `the chart: ${svg.w} in ${chart.w}`);
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
    assert.equal(!!(await q.f.$("#view #ct-q")), false);
    await q.p.clean();
  } finally { await q.p.close(); }
});

test("on a desk: a tech gets their own sidebar (no sections, no search, no money)", async () => {
  await day();
  for (const device of ["desk1440", "desk1024"]) {
    const { p, page, f } = await home("theo", { device });
    try {
      assert.equal(await title(f), "Today");
      // a tech's own bar as a sidebar: Today, Time and Pay (the tech app, M4b), Me
      assert.deepEqual(await f.$$eval("#side .side-item .sl", (els) => els.map((e) => e.textContent)), ["Today", "Inbox", "Time", "Pay", "Me"]);
      assert.equal(!!(await f.$("#side .side-grp")), false);
      assert.equal(!!(await f.$("#top-q")), false, "no customer search for a tech");
      assert.equal(!!(await f.$(".hm, .hm-money, [data-chart]")), false);
      assert.deepEqual(await screenProblems(f), []);
      await shot(page, `home-desk-tech-${device}`);
      if (device === "desk1440") {
        // a contact opens alone: the list beside it is the office's
        await goTo(f, `/contacts/${seeded.contacts.customer}`);
        assert.equal(await f.$eval("#pane", (el) => el.hidden), true, "no list beside a tech's contact");
        assert.doesNotMatch(await f.textContent("#view"), /Not for this login[\s\S]*Not for this login/);
      }
      await p.clean();
    } finally { await p.close(); }
  }
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
    assert.equal(!!(await page.$(".bar .nav")), false, "one app");
    await shot(page, "home-desk-office-crm");
    await p.clean();
  } finally { await p.close(); }
});
