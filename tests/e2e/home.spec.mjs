// Phone and desk checks of Home (the owner's Nov 12 choice: Rotor's phone
// Home with the best of Flyra's, as cards each person picks with Edit
// Home), the office's bar, the Sales switch and the Menu, at iPhone 13 and
// SE sizes and 1440 x 900 and 1024 x 768: the header, Clock in (in and
// out), the Money card (Collected | Scheduled | ARR, the period menu, a
// custom range, the chart's readout, goals), Today (Daily | Weekly |
// Monthly, tasks without a due date), Edit Home (on, off, order, from My
// account too), the optional cards, the empty state before any CRM data,
// and a tech who never sees Home. The money is the made-up Rotor snapshot
// the server seals for its throwaway key. No console errors, no CSP
// violations, no sideways scroll, 44 px targets. E2E_SHOTS=<dir> saves the
// screenshots.
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
  await page.setViewportSize({ width: vp.width, height: Math.min(h + 160, 6000) });
  await page.waitForTimeout(300);
  await shot(page, name);
  await page.setViewportSize(vp);
  await page.waitForTimeout(200);
}
const text = (f, sel) => f.$eval(sel, (el) => el.innerText.replace(/\s+/g, " ").trim());
const has = async (f, sel) => !!(await f.$(sel));
const cards = (f) => f.$$eval(".hm-grid > [data-card]", (els) => els.map((e) => e.dataset.card));
// what Home no longer has: the KPI tiles, the quick actions, the dark money card, the old charts, Needs you
const GONE = ".hm-kpi, .hm-qa, .hm-quick, .hm-hero, .hm-needs, .hm-need, [data-chart=weekly], [data-chart=monthly], [data-chart=weeks]";
// the screen is drawn again (a card's own read finished)
const idle = (f) => f.waitForFunction(() => !document.querySelector('#view [aria-busy="true"]'));
async function pickPeriod(f, label) {
  await f.click('[data-hm="period"]');
  await f.click(`.hm-menu button:text-is("${label}")`);
  await idle(f);
}

test("before any CRM data: the header, Clock in, Rotor's money and a calm empty Today", async () => {
  for (const device of DEVICES) {
    const { p, page, f } = await home("olive", { device, office: true });
    try {
      assert.equal(await title(f), "Home");
      assert.ok(["", "#/today"].includes(await hashOf(f)), "the app opens on Home");
      assert.deepEqual(await f.$$eval("#tabs [data-tab]", (els) => els.map((e) => e.querySelector("span").textContent)), ["Home", "Inbox", "Schedule", "Customers", "Sales", "Menu"]);
      assert.match(await text(f, ".hm-head"), /^OO Welcome back, Olive Tuesday, November 17$/);
      assert.deepEqual(await cards(f), ["clock", "money", "agenda"], "the default cards, in order");
      assert.equal(await has(f, GONE), false, "nothing of the old Home");
      // Clock in
      assert.match(await text(f, ".hm-c-clock"), /^Timesheet 0h 0m Choose a role when you clock in Clock In$/i);
      // Money: Rotor's numbers, this month, with AVG and PEAK and the chart
      assert.match(await text(f, ".hm-c-money"), /^Collected Scheduled ARR November This month \$10,453 Avg \/ day \$653 Peak week \$4,890 /i);
      assert.match(await text(f, ".hm-c-money .hm-foot"), /^From Rotor · updated Nov 16 See more$/);
      assert.equal(await f.$$eval('[data-chart="money"] .hc-line', (x) => x.length), 1);
      // Today: nothing yet
      assert.match(await text(f, ".hm-c-agenda"), /^Daily Weekly Monthly Tuesday, November 17 0 items Nothing scheduled for today/);
      assert.equal(await has(f, ".hm-edit [data-hm=edit]"), true, "Edit Home at the bottom");
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

test("an owner's Home on a real day: today's visits with a bar per tech, who and when; tasks without a due date", async () => {
  await day();
  for (const device of DEVICES) {
    const { p, page, f } = await home("olive", { device, office: true });
    try {
      assert.deepEqual(await cards(f), ["clock", "money", "agenda"]);
      const rows = await f.$$eval(".hm-c-agenda .hm-item", (els) => els.map((e) => ({ href: e.getAttribute("href"), name: e.querySelector(".who b").textContent, line: e.querySelector(".who small").textContent, av: e.querySelectorAll(".hm-av").length, time: e.querySelector(".hm-time").textContent, timeShown: getComputedStyle(e.querySelector(".hm-time")).display !== "none", bar: e.style.getPropertyValue("--bar") })));
      assert.equal(rows.length, 7);
      assert.match(await text(f, ".hm-ag-head"), /^Tuesday, November 17 7 items$/);
      assert.ok(rows.every((r) => /^#\/visits\/vs_/.test(r.href) && r.name && /^(Job|Plan visit|Lights [a-z]+) · \d+:\d\d( [AP]M)? – \d+:\d\d [AP]M/.test(r.line) && r.av >= 1 && /^\d+:\d\d [AP]M$/.test(r.time) && /^#[0-9a-f]{6}$/i.test(r.bar)), JSON.stringify(rows));
      assert.ok(rows.some((r) => / · Done$/.test(r.line)) && rows.some((r) => / · Working$/.test(r.line)), "what's done and what's under way");
      assert.ok(rows.some((r) => r.av === 2), "Olive and Theo together at one");
      // tasks without a due date fold away (remembered on this phone)
      assert.match(await text(f, ".hm-tasks-h"), /^Tasks without due date \d+$/i);
      const shown = await has(f, ".hm-tasks .hm-task-list");
      await f.click(".hm-tasks-h");
      assert.equal(await has(f, ".hm-tasks .hm-task-list"), !shown);
      assert.equal(await f.getAttribute(".hm-tasks-h", "aria-expanded"), String(!shown));
      if (shown) await f.click(".hm-tasks-h");
      assert.deepEqual(await screenProblems(f), []);
      assert.deepEqual(await badLinks(f), []);
      await shot(page, `home-owner-${device}`);
      await fullShot(page, f, `home-owner-${device}-full`);
      await p.clean();
    } finally { await p.close(); }
  }
});

test("Today: Weekly and Monthly, the arrows, and a visit opens", async () => {
  await day();
  const { p, page, f } = await home("olive", { device: "iphonese", office: true });
  try {
    await f.click('[data-hm="view"][data-v="week"]');
    await idle(f);
    assert.match(await text(f, ".hm-ag-head"), /^Nov 16 – 22 \d+ items$/);
    assert.ok(await has(f, ".hm-c-agenda .hm-day"), "the days as headings");
    await f.click('[data-hm="ag-move"][data-v="1"]');
    await idle(f);
    assert.match(await text(f, ".hm-ag-head"), /^Nov 23 – 29 /);
    await f.click('[data-hm="view"][data-v="month"]');
    await idle(f);
    assert.match(await text(f, ".hm-ag-head"), /^November 2026 \d+ items$/);
    // Daily keeps the day it was on (the Monday the arrows reached); back a day
    await f.click('[data-hm="view"][data-v="day"]');
    await idle(f);
    assert.match(await text(f, ".hm-ag-head"), /^Monday, November 23 /);
    await f.click('[data-hm="ag-move"][data-v="-1"]');
    await idle(f);
    assert.match(await text(f, ".hm-ag-head"), /^Sunday, November 22 \d+ items?$/);
    assert.deepEqual(await screenProblems(f), []);
    await shot(page, "home-agenda-iphonese");
    // the Home tab starts over on today
    await f.click('#tabs [data-tab="home"]');
    await f.waitForFunction(() => /Tuesday, November 17/.test((document.querySelector(".hm-ag-head") || {}).textContent || ""));
    const visit = await f.getAttribute(".hm-c-agenda .hm-item", "href");
    await f.click(`.hm-c-agenda .hm-item[href="${visit}"]`);
    await settled(f, { hash: visit });
    assert.match(await f.textContent("#view"), /Workday|Afternoon/, "the visit's screen");
    await p.clean();
  } finally { await p.close(); }
});

test("Money: Collected | Scheduled | ARR, the period menu, a custom range, the readout, See more", async () => {
  await day();
  const { p, page, f } = await home("olive", { device: "iphone13", office: true });
  try {
    // the readout starts on the latest point and follows the keys
    const first = await text(f, "#read-money");
    assert.match(first, /^\$10,453 \$780 week of Nov 16, so far$/, "the running total (the big number), then the week's own amount");
    await f.focus('[data-chart="money"]');
    await page.keyboard.press("Home");
    assert.match(await text(f, "#read-money"), /^\$[\d,]+ \$4,890 week of Nov 2$/);
    await page.keyboard.press("End");
    assert.equal(await text(f, "#read-money"), first);
    const ys = await f.$$eval('[data-chart="money"] .hc-line', (els) => els.map((e) => e.getAttribute("d")));
    const ends = ys[0].match(/-?[\d.]+,-?[\d.]+/g).map((p) => Number(p.split(",")[1]));
    assert.ok(ends.at(-1) <= Math.min(...ends) + 0.5, "the line climbs to its end (no dive at a partial week)");
    // Scheduled: the CRM's visits, per day
    await f.click('[data-hm="metric"][data-v="scheduled"]');
    await idle(f);
    assert.match(await text(f, ".hm-c-money"), /November This month \$[\d,]+ Avg \/ day \$[\d,]+ Peak day \$[\d,]+/i);
    assert.match(await text(f, ".hm-c-money .hm-foot"), /^Updated \d+:\d\d [AP]M See more$/);
    assert.match(await text(f, "#read-money"), /^\$[\d,]+ \$[\d,]+ Nov 17$/, "the readout starts on today");
    await shot(page, "home-money-scheduled-iphone13");
    // ARR with its change over the period
    await f.click('[data-hm="metric"][data-v="arr"]');
    await idle(f);
    assert.match(await text(f, ".hm-c-money"), /Annual recurring revenue This month \$[\d,]+ Change [+−]?\$[\d,]+/i);
    // the period menu: This year, Last 3 months, This week, a custom range
    await f.click('[data-hm="metric"][data-v="collected"]');
    await idle(f);
    await f.click('[data-hm="period"]');
    assert.deepEqual(await f.$$eval(".hm-menu button", (els) => els.map((e) => e.textContent.trim())), ["This week", "This month", "Last 3 months", "This year", "Custom range…"]);
    assert.deepEqual(await screenProblems(f), [], "the menu's targets");
    await shot(page, "home-money-menu-iphone13");
    await f.click('.hm-menu button:text-is("This year")');
    await idle(f);
    assert.match(await text(f, ".hm-c-money"), /2026 This year \$[\d,]+ Avg \/ day \$[\d,]+ Peak month \$[\d,]+/i);
    await pickPeriod(f, "Last 3 months");
    assert.match(await text(f, ".hm-c-money"), /September – November Last 3 months \$[\d,]+/i);
    await pickPeriod(f, "This week");
    assert.match(await text(f, ".hm-c-money"), /Nov 16 – 22 This week \$[\d,]+/i);
    await f.click('[data-hm="period"]');
    await f.click('[data-hm="custom"]');
    await f.waitForSelector(".sheet.on [data-range]");
    await f.fill('.sheet.on input[name="from"]', "2026-11-01");
    await f.fill('.sheet.on input[name="to"]', "2026-11-10");
    await f.click('.sheet.on [data-range] button[type="submit"]');
    await idle(f);
    assert.match(await text(f, ".hm-c-money"), /Nov 1 – 10 Custom - /i, "Rotor's snapshot has no custom range: '-'");
    await pickPeriod(f, "This month");
    // See more: the Dashboard's Money view (this phone has the office sign-in)
    await f.click(".hm-c-money .hm-more");
    await settled(f, { hash: "#/dashboard/money" });
    assert.equal(await backShown(f), true);
    await p.clean();
  } finally { await p.close(); }
});

test("Clock in from Home (a role first), the hours run, Clock out", async () => {
  await day();
  const { p, page, f } = await home("ada", { device: "iphonese" });
  try {
    await f.click('.hm-c-clock [data-hm="clock"]');
    await f.waitForSelector(".sheet.on [data-role]");
    assert.deepEqual(await f.$$eval(".sheet.on [data-role] b", (els) => els.map((e) => e.textContent)), ["Service", "Sales", "Office"]);
    await f.click('.sheet.on [data-role="office"]');
    await f.waitForFunction(() => /On the clock since/.test((document.querySelector(".hm-c-clock") || {}).textContent || ""));
    assert.match(await text(f, ".hm-c-clock"), /^Timesheet 0h \dm On the clock since \d+:\d\d [AP]M · Office Clock Out$/i);
    assert.equal(await has(f, ".hm-c-clock .hm-dot.on"), true);
    assert.deepEqual(await screenProblems(f), []);
    await shot(page, "home-clocked-in-iphonese");
    await f.click('.hm-c-clock [data-hm="clock"]');
    await f.waitForFunction(() => /Clock In/.test((document.querySelector(".hm-c-clock") || {}).textContent || ""));
    await p.clean();
  } finally { await p.close(); }
});

test("Edit Home: turn cards on, order them, save; Goals, Tasks and Inbox; from My account too", async () => {
  await day();
  const { p, page, f } = await home("olive", { device: "iphone13", office: true });
  try {
    await f.click(".hm-edit [data-hm=edit]");
    await f.waitForSelector(".sheet.on .hm-edit-list");
    assert.deepEqual(await f.$$eval(".sheet.on .hm-edit-list li", (els) => els.map((e) => `${e.dataset.key}:${e.querySelector("input").checked}`)), ["clock:true", "money:true", "agenda:true", "inbox:false", "tasks:false", "goals:false"], "no Leaderboard until the reports module brings it");
    assert.deepEqual(await screenProblems(f), [], "the sheet's targets");
    await shot(page, "home-edit-iphone13");
    for (const k of ["inbox", "tasks", "goals"]) await f.check(`.sheet.on li[data-key="${k}"] input`);
    await f.uncheck('.sheet.on li[data-key="clock"] input');
    // Goals up to the top: three taps
    for (let i = 0; i < 5; i++) await f.click('.sheet.on li[data-key="goals"] [data-mv="-1"]');
    await f.click(".sheet.on [data-save]");
    await f.waitForFunction(() => !document.querySelector(".sheet.on"));
    await f.waitForFunction(() => document.querySelector('.hm-grid > [data-card="goals"]'));
    assert.deepEqual(await cards(f), ["goals", "money", "agenda", "inbox", "tasks"]);
    // Goals: an owner adds them; progress here and under Money
    assert.match(await text(f, ".hm-c-goals"), /^Goals Add No goals yet Tap Add/);
    await f.click('.hm-c-goals [data-hm="goals"]');
    await f.waitForSelector(".sheet.on [data-goals]");
    await f.fill('.sheet.on input[name="revenue"]', "25000");
    await f.fill('.sheet.on input[name="jobs"]', "60");
    await f.click('.sheet.on [data-goals] button[type="submit"]');
    await f.waitForFunction(() => /Revenue this month/.test((document.querySelector(".hm-c-goals") || {}).textContent || ""));
    assert.match(await text(f, ".hm-c-goals"), /^Goals Edit Revenue this month \$10,453 of \$25,000 42% Jobs this month \d+ of 60 \d+%$/);
    assert.match(await text(f, ".hm-c-money .hm-goal"), /^42% of the \$25,000 goal$/);
    // Tasks: Upcoming ▾ and Add; Inbox: the latest conversations
    assert.equal(await f.getAttribute(".hm-c-tasks .hm-chip", "href"), "#/tasks/new");
    await f.selectOption('.hm-c-tasks select', "all");
    assert.ok(await has(f, ".hm-c-tasks .hm-task"), "the owner's team's open tasks");
    assert.ok(await f.$$eval(".hm-c-inbox .hm-conv", (x) => x.length) >= 1, "the seed's conversations");
    assert.deepEqual(await screenProblems(f), []);
    assert.deepEqual(await badLinks(f), []);
    await fullShot(page, f, "home-cards-iphone13-full");
    // My account → Edit Home opens the same sheet
    await goTo(f, "/me");
    await f.click('a[href="#/today?edit=1"]');
    await f.waitForSelector(".sheet.on .hm-edit-list");
    await f.click(".sheet.on [data-sheet-x]");
    await p.clean();
  } finally { await p.close(); }
  // back to the defaults (the API, as the sheet saves)
  const q = await phone(browser, srv, { device: "iphone13", office: true });
  try {
    await signIn(q, "olive");
    const r = await q.ctx.request.put("/api/crm/home/layout", { headers: { "x-crm": "1", "content-type": "application/json" }, data: { cards: [] } });
    assert.equal(r.status(), 200);
  } finally { await q.close(); }
});

test("the office without the office sign-in: the money (reports:read), See more opens Payments, goals for owners only", async () => {
  await day();
  const { p, page, f } = await home("ada", { device: "iphone13" });
  try {
    assert.deepEqual(await cards(f), ["clock", "money", "agenda"]);
    assert.equal(await f.getAttribute(".hm-c-money .hm-more", "href"), "#/payments", "no Dashboard without the office sign-in");
    assert.ok(!(await f.$$eval("#view a[href]", (els) => els.map((e) => e.getAttribute("href")))).some((h) => h.startsWith("#/dashboard")));
    assert.deepEqual(await screenProblems(f), []);
    await shot(page, "home-admin-iphone13");
    await goTo(f, "/menu");
    assert.equal(await has(f, '.mtile[href="#/dashboard"]'), false, "no Dashboard in the Menu either");
    await p.clean();
  } finally { await p.close(); }
});

test("a tech never sees Home: their own Today, and /home tells them nothing", async () => {
  await day();
  for (const device of DEVICES) {
    const { p, page, f } = await home("theo", { device, office: true });
    try {
      assert.equal(await title(f), "Today");
      assert.equal(await has(f, ".hm, .hm-card, [data-chart]"), false, "no Home");
      assert.doesNotMatch(await f.textContent("#view"), /\$\d|Collected|Welcome back/);
      const tabs = await f.$$eval("#tabs [data-tab]", (els) => els.map((e) => e.dataset.tab));
      assert.ok(!tabs.includes("home") && !tabs.includes("menu") && !tabs.includes("sales"), tabs.join(", "));
      const res = await p.ctx.request.get("/api/crm/home", { headers: { "x-crm": "1" } });
      assert.equal(res.status(), 200);
      const d = (await res.json()).data;
      assert.deepEqual([d.layout, d.cards, d.notifications], [[], {}, null]);
      assert.equal((await p.ctx.request.get("/api/crm/home/money", { headers: { "x-crm": "1" } })).status(), 403);
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

test("on a desk: the sidebar, search and New; the clock across, Money beside Today at 1440, under it at 1024", async () => {
  await day();
  for (const device of ["desk1440", "desk1024"]) {
    const { p, page, f } = await home("olive", { device, office: true });
    try {
      assert.equal(await title(f), "Home");
      assert.equal(await f.$eval("#tabs", (el) => getComputedStyle(el).display), "none", "no bottom bar on a desk");
      assert.ok(await f.isVisible("#side"), "the sidebar");
      assert.deepEqual(await f.$$eval("#side .side-h span:first-child", (els) => els.map((e) => e.textContent)), ["Work", "Sales", "Customers", "Money", "Messages & automations", "Office tools", "Admin"]);
      assert.equal(await f.getAttribute('#side [data-path="/today"]', "aria-current"), "page", "Home lit");
      assert.ok(await f.isVisible("#top-q") && await f.isVisible("#top-new") && await f.isVisible("#top-me"), "search, New, the person");
      assert.deepEqual(await cards(f), ["clock", "money", "agenda"]);
      const [clock, money, agenda, grid] = await Promise.all([".hm-c-clock", ".hm-c-money", ".hm-c-agenda", ".hm-grid"].map((s) => box(f, s)));
      assert.ok(grid.w <= 1160, `Home's width ${grid.w}`);
      if (device === "desk1440") {
        assert.equal(clock.w, grid.w, "the clock a bar across");
        assert.equal(money.y, agenda.y, "Money beside Today");
        assert.ok(agenda.x >= money.x + money.w);
      } else {
        assert.ok(money.y >= clock.y + clock.h && agenda.y >= money.y + money.h, "one over the other");
      }
      const [chart, svg] = await Promise.all([box(f, '[data-chart="money"]'), box(f, '[data-chart="money"] svg')]);
      assert.ok(Math.abs(chart.w - svg.w) <= 2 && chart.x >= money.x && chart.x + chart.w <= money.x + money.w, `the chart: ${svg.w} in ${chart.w}`);
      assert.deepEqual(await screenProblems(f), []);
      await shot(page, `home-desk-${device}`);
      await fullShot(page, f, `home-desk-${device}-full`);
      // New and the person's menu
      await f.click("#top-new");
      assert.deepEqual(await f.$$eval("#new-pop a span", (els) => els.map((e) => e.textContent)).then((x) => x.slice(0, 2)), ["New lead", "New quote"]);
      await page.keyboard.press("Escape");
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
      assert.deepEqual(await f.$$eval("#side .side-item .sl", (els) => els.map((e) => e.textContent)), ["Today", "Inbox", "Time", "Pay", "Me"]);
      assert.equal(await has(f, "#side .side-grp"), false);
      assert.equal(await has(f, "#top-q"), false, "no customer search for a tech");
      assert.equal(await has(f, ".hm, .hm-card, [data-chart]"), false);
      assert.deepEqual(await screenProblems(f), []);
      await shot(page, `home-desk-tech-${device}`);
      if (device === "desk1440") {
        await goTo(f, `/contacts/${seeded.contacts.customer}`);
        assert.equal(await f.$eval("#pane", (el) => el.hidden), true, "no list beside a tech's contact");
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
