// Phone and desk checks of Home (the owner's Nov 12 choice: Rotor's phone
// Home with the best of Flyra's, as cards each person picks with Edit
// Home), the office's bar, the Sales switch and the Menu, at iPhone 13 and
// SE sizes and 1440 x 900 and 1024 x 768: the header, Clock in (in and
// out), the Money card (Rotor's: Week | Month, the arrows, share and fold,
// Collected and Scheduled side by side, both lines per day, the readout,
// where Collected comes from, the ARR under it), Today (Daily | Weekly |
// Monthly, tasks without a due date), Edit Home (on, off, order, from My
// account too), the optional cards, the empty state before any CRM data,
// and a tech who never sees Home. The money is the made-up Rotor snapshot
// the server seals for its throwaway key, then (the real day) a made-up
// Rotor import of two days ago with its payments. No console errors, no CSP
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
// the Money card's own read finished, its label
async function moneyTo(f, sel) {
  const was = await text(f, ".hm-mper");
  await f.click(sel);
  await f.waitForFunction((w) => { const h = document.querySelector(".hm-mper"); return h && h.textContent !== w && !document.querySelector('.hm-pair[aria-busy="true"]'); }, was);
  return text(f, ".hm-mper");
}

test("before any CRM data: the header, Clock in, Rotor's money and a calm empty Today", async () => {
  for (const device of DEVICES) {
    const { p, page, f } = await home("olive", { device, office: true });
    try {
      assert.equal(await title(f), "Home");
      assert.ok(["", "#/today"].includes(await hashOf(f)), "the app opens on Home");
      assert.deepEqual(await f.$$eval("#tabs [data-tab]", (els) => els.map((e) => e.querySelector("span").textContent)), ["Home", "Schedule", "Inbox", "Map", "Menu"]);
      // Flyra's Home: the greeting, the first name big; the money on the canvas, then the cards
      assert.match(await text(f, ".hm-head"), /^Good morning Olive/);
      assert.deepEqual(await cards(f), ["money", "clock", "leaderboard", "agenda", "inbox", "tasks", "goals"], "the default cards, in order (the clock: Olive goes out on visits)");
      assert.equal(await has(f, GONE), false, "nothing of the old Home");
      // Clock in
      assert.match(await text(f, ".hm-c-clock"), /^Timesheet 0h 0m Choose a role when you clock in Clock In$/i);
      // Money: Rotor's card, this month; no import yet, so Collected is Rotor's snapshot and its weeks (Scheduled summed to the same weeks)
      assert.match(await text(f, ".hm-c-money"), /^Week Month November 2026 Collected \$10,453 Scheduled \$0 Week of Nov 16 Collected \$780 Scheduled \$0 /);
      assert.equal(await f.getAttribute('[data-hm="m-period"][data-v="month"]', "aria-pressed"), "true");
      assert.equal(await text(f, ".hm-c-money .hm-mfoot"), "From Rotor · updated Nov 16");
      assert.equal(await text(f, ".hm-money .hm-arr"), "See more", "no plans yet: no ARR");
      assert.equal(await f.$$eval('[data-chart="money"] .hc-line', (x) => x.length), 2);
      // Today: nothing yet
      assert.match(await text(f, ".hm-c-agenda"), /^Today Tue, Nov 17 · 0 items Daily Weekly Monthly Nothing scheduled for today/);
      assert.equal(await has(f, ".hm-edit [data-hm=edit]"), true, "Edit Home at the bottom");
      // creating is the shell's round + (Nov 2026: it blurs the screen, search on top, the things to make above it)
      assert.ok(await f.isVisible("#fab"), "the + on Home");
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

test("an owner's Home on a real day: today's visits with a bar per tech, who and when; tasks without a due date", async () => {
  await day();
  for (const device of DEVICES) {
    const { p, page, f } = await home("olive", { device, office: true });
    try {
      assert.deepEqual((await cards(f)).slice(0, 2), ["money", "clock"]);
      const rows = await f.$$eval(".hm-c-agenda .hm-item", (els) => els.map((e) => ({ href: e.getAttribute("href"), name: e.querySelector(".who b").textContent, line: e.querySelector(".who small").textContent, av: e.querySelectorAll(".hm-av").length, time: e.querySelector(".hm-time").textContent, timeShown: getComputedStyle(e.querySelector(".hm-time")).display !== "none", bar: e.style.getPropertyValue("--bar") })));
      assert.equal(rows.length, 7);
      assert.match(await text(f, ".hm-ag-head"), /^Today Tue, Nov 17 · 7 items$/);
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
    // Monthly is a calendar (the owner's Nov 13 ask): the switch and the arrows on one row, Sunday first
    assert.equal(await has(f, ".hm-c-agenda .hm-ag-top .hm-seg + .hm-arrows"), true);
    assert.equal(await has(f, ".hm-c-agenda .hm-day"), false, "no long list of the month");
    assert.deepEqual(await f.$$eval(".hm-cal-dow span", (els) => els.map((e) => e.textContent)), ["S", "M", "T", "W", "T", "F", "S"]);
    const cal = await f.$$eval(".hm-cal-days > *", (els) => els.map((e) => ({ tag: e.tagName, d: e.dataset.v || "", n: e.querySelector(".n").textContent, dots: e.querySelectorAll(".dots i").length, today: e.classList.contains("today"), sel: e.getAttribute("aria-pressed") === "true", label: e.getAttribute("aria-label") || "", w: e.getBoundingClientRect().width, h: e.getBoundingClientRect().height })));
    assert.equal(cal.length, 35, "Sun Nov 1 to Sat Dec 5");
    const inMonth = cal.filter((c) => c.tag === "BUTTON");
    assert.deepEqual([inMonth.length, inMonth[0].d, inMonth[29].d, cal.slice(30).map((c) => c.n).join(" ")], [30, "2026-11-01", "2026-11-30", "1 2 3 4 5"]);
    assert.ok(inMonth.every((c) => c.w >= 44 && c.h >= 44), "44 px days");
    assert.deepEqual(cal.filter((c) => c.today).map((c) => [c.d, c.sel]), [["2026-11-17", true]], "today, picked first");
    assert.equal(cal.find((c) => c.d === "2026-11-17").dots, 3, "seven visits today: three dots");
    assert.match(await text(f, ".hm-selh"), /^TUE, NOV 17 · 7 items$/);
    assert.equal((await f.$$(".hm-selday .hm-item")).length, 7);
    // a tap on another day lists that day's visits only, from the month already read
    let asked = 0;
    const onReq = (r) => { if (r.url().includes("/home/agenda")) asked++; };
    page.on("request", onReq);
    const next = inMonth.find((c) => c.d === "2026-11-18");
    const n18 = Number(next.label.match(/(\d+) items?/)[1]);
    assert.ok(next.dots === Math.min(3, n18) && n18 >= 1, next.label);
    await f.click('[data-hm="ag-day"][data-v="2026-11-18"]');
    assert.match(await text(f, ".hm-selh"), new RegExp(`^WED, NOV 18 · ${n18} items?$`));
    assert.equal(await f.getAttribute('[data-hm="ag-day"][data-v="2026-11-18"]', "aria-pressed"), "true");
    assert.equal(await f.getAttribute('[data-hm="ag-day"][data-v="2026-11-17"]', "aria-pressed"), "false");
    const picked = await f.$$eval(".hm-selday .hm-item", (els) => els.map((e) => e.getAttribute("href")).sort());
    assert.equal(picked.length, n18);
    const empty = inMonth.find((c) => !c.dots && c.d > "2026-11-18");
    await f.click(`[data-hm="ag-day"][data-v="${empty.d}"]`);
    assert.match(await text(f, ".hm-selday"), /· 0 items Nothing booked No visits on /);
    assert.equal(asked, 0, "picking a day reads nothing");
    page.off("request", onReq);
    assert.deepEqual(await screenProblems(f), []);
    await f.click('[data-hm="ag-day"][data-v="2026-11-18"]');
    // Daily opens on the day picked, with the same visits
    await f.click('[data-hm="view"][data-v="day"]');
    await idle(f);
    assert.match(await text(f, ".hm-ag-head"), /^Wednesday, November 18 /);
    assert.deepEqual(await f.$$eval(".hm-c-agenda .hm-item", (els) => els.map((e) => e.getAttribute("href")).sort()), picked);
    // the arrows from the Monday the week reached; back a day
    await f.click('[data-hm="view"][data-v="week"]');
    await idle(f);
    await f.click('[data-hm="ag-move"][data-v="1"]');
    await idle(f);
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
    await f.waitForFunction(() => /Today/.test((document.querySelector(".hm-ag-head") || {}).textContent || ""));
    const visit = await f.getAttribute(".hm-c-agenda .hm-item", "href");
    await f.click(`.hm-c-agenda .hm-item[href="${visit}"]`);
    await settled(f, { hash: visit });
    assert.match(await f.textContent("#view"), /Workday|Afternoon/, "the visit's screen");
    await p.clean();
  } finally { await p.close(); }
});

test("Monthly at iPhone 13 and SE, dark and light: the calendar fits, a day picked, no sideways scroll", async () => {
  await day();
  for (const device of DEVICES) {
    const { p, page, f } = await home("olive", { device, office: true });
    try {
      await f.click('[data-hm="view"][data-v="month"]');
      await idle(f);
      await f.click('[data-hm="ag-day"][data-v="2026-11-18"]');
      await f.$eval(".hm-c-agenda", (el) => { el.scrollIntoView({ block: "start" }); document.getElementById("view").scrollTop -= 12; });
      await f.waitForFunction(() => !document.querySelector("#toasts .toast"), null, { timeout: 8000 });   // the "New look" note, gone
      for (const theme of ["dark", "light"]) {
        await f.evaluate((t) => { document.documentElement.dataset.theme = t; }, theme);
        await page.waitForTimeout(150);
        const look = await f.evaluate(() => {
          const q = (s) => getComputedStyle(document.querySelector(s));
          const card = document.querySelector(".hm-c-agenda").getBoundingClientRect();
          const days = document.querySelector(".hm-cal-days").getBoundingClientRect();
          return { today: q(".hm-cd.today .n").color, num: q('.hm-cd[data-v="2026-11-02"] .n').color, top: document.querySelector(".hm-ag-top").scrollWidth <= document.querySelector(".hm-ag-top").clientWidth, inCard: days.left >= card.left && days.right <= card.right };
        });
        assert.notEqual(look.today, look.num, "today in coral");
        assert.ok(look.top && look.inCard, JSON.stringify(look));
        assert.deepEqual(await screenProblems(f), []);
        await shot(page, `home-month-${device}-${theme}`);
      }
      await p.clean();
    } finally { await p.close(); }
  }
});

test("Money (Rotor's card): Collected and Scheduled per day from the import, the readout, Week | Month and the arrows, share, fold, ARR, both themes", async () => {
  await day();
  for (const device of DEVICES) {
    const { p, page, f } = await home("olive", { device, office: true });
    try {
      await f.evaluate(() => { document.documentElement.dataset.theme = "light"; });
      assert.match(await text(f, ".hm-c-money"), /^Week Month November 2026 Collected \$[\d,]+ Scheduled \$[\d,]+ Nov 17 Collected - Scheduled \$[\d,]+ /, "per day; today is after the import: '-' for Collected");
      assert.equal(await text(f, ".hm-c-money .hm-mfoot"), "From Rotor's import of Nov 15");
      assert.match(await text(f, ".hm-money .hm-arr"), /^ARR \$[\d,]+ · See more$/);
      // the chart: both lines, the dashed grid, $ at the left, Nov 1, 7, 13, 19, 25 under it
      assert.equal(await f.$$eval('[data-chart="money"] .hc-line.c', (x) => x.length), 1);
      assert.equal(await f.$$eval('[data-chart="money"] .hc-line.s', (x) => x.length), 1);
      assert.deepEqual(await f.$$eval('[data-chart="money"] text[text-anchor="middle"]', (els) => els.map((e) => e.textContent)), ["Nov 1", "Nov 7", "Nov 13", "Nov 19", "Nov 25"]);
      assert.equal(await f.$$eval('[data-chart="money"] .hc-vgrid', (x) => x.length), 5);
      const ticks = await f.$$eval('[data-chart="money"] text[text-anchor="end"]', (els) => els.map((e) => e.textContent));
      assert.ok(ticks.length >= 3 && ticks[0] === "$0" && ticks.every((x) => /^\$[\d.]+K?$/.test(x)), ticks.join(" "));
      const [card, pair] = await Promise.all([f.$eval(".hm-c-money", (e) => e.getBoundingClientRect().toJSON()), f.$$eval(".hm-pv", (els) => els.map((e) => e.getBoundingClientRect().toJSON()))]);
      assert.ok(Math.abs(pair[0].y - pair[1].y) < 1 && pair[1].x >= pair[0].x + pair[0].width - 1 && pair[1].x + pair[1].width <= card.x + card.width, "Collected and Scheduled side by side");
      assert.deepEqual(await screenProblems(f), []);
      // (the shell's one-time "New look" note off the screenshots)
      await f.evaluate(() => { const t = document.getElementById("toasts"); if (t) t.style.visibility = "hidden"; });
      await shot(page, `home-money-${device}-light`);
      await f.evaluate(() => { document.documentElement.dataset.theme = "dark"; });
      await page.waitForTimeout(150);
      await shot(page, `home-money-${device}-dark`);
      await p.clean();
    } finally { await p.close(); }
  }
  const { p, page, f } = await home("olive", { device: "iphone13", office: true });
  try {
    // the readout: today to start; the keys and a tap move it
    await f.focus('[data-chart="money"]');
    await page.keyboard.press("Home");
    assert.match(await text(f, "#read-money"), /^Nov 1 Collected \$[\d,]+ Scheduled \$[\d,]+$/);
    await page.keyboard.press("ArrowRight");
    assert.match(await text(f, "#read-money"), /^Nov 2 Collected \$[\d,]+ Scheduled \$[\d,]+$/);
    const box = await f.$eval('[data-chart="money"]', (e) => e.getBoundingClientRect().toJSON());
    await f.click('[data-chart="money"]', { position: { x: box.width - 8, y: 40 } });
    assert.match(await text(f, "#read-money"), /^Nov 30 Collected - Scheduled \$[\d,]+$/);
    assert.equal(await f.$$eval('[data-chart="money"] .hc-dot[visibility="visible"]', (x) => x.length), 1, "a dot on the line that has the day");
    // share: the phone's share sheet gets a short summary
    await f.evaluate(() => { Object.defineProperty(navigator, "share", { configurable: true, value: async (d) => { window.__shared = d; } }); });
    const collected = await text(f, ".hm-pv:first-child b"), scheduled = await text(f, ".hm-pv:last-child b");
    await f.click('[data-hm="m-share"]');
    await f.waitForFunction(() => window.__shared);
    assert.equal(await f.evaluate(() => window.__shared.text), `November 2026: Collected ${collected}, Scheduled ${scheduled}`);
    // the arrows: October, back, December (ahead of the import: '-')
    assert.equal(await moneyTo(f, '[data-hm="m-move"][data-v="-1"]'), "October 2026");
    assert.equal(await f.getAttribute('[data-hm="m-move"][data-v="-1"]', "aria-label"), "Previous month");
    assert.equal(await moneyTo(f, '[data-hm="m-move"][data-v="1"]'), "November 2026");
    assert.equal(await moneyTo(f, '[data-hm="m-move"][data-v="1"]'), "December 2026");
    assert.match(await text(f, ".hm-pair"), /^Collected - Scheduled \$[\d,]+$/);
    // Week: this week, then the one before (the import's last week, per day)
    assert.equal(await moneyTo(f, '[data-hm="m-period"][data-v="week"]'), "Nov 30 – Dec 6", "Week opens on the period on screen (the week of its 1st)");
    assert.equal(await moneyTo(f, '[data-hm="m-period"][data-v="month"]'), "November 2026", "the month of the week's Monday");
    assert.equal(await moneyTo(f, '[data-hm="m-period"][data-v="week"]'), "Nov 16 – 22", "today's week: today is in November");
    assert.equal(await f.getAttribute('[data-hm="m-move"][data-v="1"]', "aria-label"), "Next week");
    assert.equal(await moneyTo(f, '[data-hm="m-move"][data-v="-1"]'), "Nov 9 – 15");
    assert.match(await text(f, ".hm-pair"), /^Collected \$[\d,]+ Scheduled \$[\d,]+$/);
    assert.equal(await f.$$eval('[data-chart="money"] text[text-anchor="middle"]', (els) => els.length) >= 3, true);
    assert.deepEqual(await screenProblems(f), []);
    await shot(page, "home-money-week-iphone13");
    // fold: just the numbers, remembered on this phone
    await f.click('[data-hm="m-fold"]');
    assert.equal(await has(f, '[data-chart="money"]'), false);
    assert.equal(await f.getAttribute('[data-hm="m-fold"]', "aria-expanded"), "false");
    await goTo(f, "/menu");
    await goTo(f, "/today");
    assert.equal(await has(f, '[data-chart="money"]'), false, "still folded");
    assert.match(await text(f, ".hm-pair"), /^Collected \$[\d,]+ Scheduled \$[\d,]+$/);
    await f.click('[data-hm="m-fold"]');
    assert.equal(await has(f, '[data-chart="money"]'), true);
    // See more: the Dashboard's Money view (this phone has the office sign-in)
    await f.click(".hm-money .hm-more");
    await settled(f, { hash: "#/dashboard/money" });
    assert.equal(await backShown(f), true);
    await p.clean();
  } finally { await p.close(); }
});

test("Money: the older one-metric read still answers (Collected | Scheduled | ARR, a period)", async () => {
  await day();
  const { p, page, f } = await home("olive", { device: "iphone13", office: true });
  try {
    for (const [metric, period] of [["collected", "month"], ["scheduled", "year"], ["arr", "3m"]]) {
      const r = await p.ctx.request.get(`/api/crm/home/money?metric=${metric}&period=${period}`, { headers: { "x-crm": "1" } });
      assert.equal(r.status(), 200);
      assert.equal((await r.json()).data.metric, metric);
    }
    await p.clean();
  } finally { await p.close(); }
});

test("Clock in from Home (a role first), the hours run, Clock out", async () => {
  await day();
  const { p, page, f } = await home("ada", { device: "iphonese" });
  try {
    // (Ada doesn't go out on visits: the clock is off until she adds it with Edit Home)
    assert.equal(await has(f, ".hm-c-clock"), false);
    const put = await p.ctx.request.put("/api/crm/home/layout", { headers: { "x-crm": "1", "content-type": "application/json" }, data: { cards: [{ key: "money", on: true }, { key: "clock", on: true }] } });
    assert.equal(put.status(), 200);
    await goTo(f, "/menu");
    await goTo(f, "/today");
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
    assert.equal((await p.ctx.request.put("/api/crm/home/layout", { headers: { "x-crm": "1", "content-type": "application/json" }, data: { cards: [] } })).status(), 200);
    await p.clean();
  } finally { await p.close(); }
});

test("Edit Home: turn cards on, order them, save; Goals, Tasks and Inbox; from My account too", async () => {
  await day();
  const { p, page, f } = await home("olive", { device: "iphone13", office: true });
  try {
    await f.click(".hm-edit [data-hm=edit]");
    await f.waitForSelector(".sheet.on .hm-edit-list");
    assert.deepEqual(await f.$$eval(".sheet.on .hm-edit-list li", (els) => els.map((e) => `${e.dataset.key}:${e.querySelector("input").checked}`)), ["money:true", "clock:true", "leaderboard:true", "agenda:true", "inbox:true", "tasks:true", "goals:true"], "Flyra's Home: every card on (the clock: Olive goes out on visits)");
    assert.deepEqual(await screenProblems(f), [], "the sheet's targets");
    await shot(page, "home-edit-iphone13");
    for (const k of ["inbox", "tasks", "goals"]) await f.check(`.sheet.on li[data-key="${k}"] input`);
    await f.uncheck('.sheet.on li[data-key="clock"] input');
    // Goals up to the top
    for (let i = 0; i < 6; i++) await f.click('.sheet.on li[data-key="goals"] [data-mv="-1"]');
    await f.click(".sheet.on [data-save]");
    await f.waitForFunction(() => !document.querySelector(".sheet.on"));
    // the grid is drawn again in the saved order (Goals was already on: wait for the order, not the card)
    await f.waitForFunction(() => { const c = document.querySelector(".hm-grid > [data-card]"); return c && c.dataset.card === "goals"; });
    assert.deepEqual(await cards(f), ["goals", "money", "leaderboard", "agenda", "inbox", "tasks"]);
    // Goals: an owner adds them; progress here
    assert.match(await text(f, ".hm-c-goals"), /^Goals Add No goals yet Tap Add/);
    await f.click('.hm-c-goals [data-hm="goals"]');
    await f.waitForSelector(".sheet.on [data-goals]");
    await f.fill('.sheet.on input[name="revenue"]', "25000");
    await f.fill('.sheet.on input[name="jobs"]', "60");
    await f.click('.sheet.on [data-goals] button[type="submit"]');
    await f.waitForFunction(() => /Revenue this month/.test((document.querySelector(".hm-c-goals") || {}).textContent || ""));
    const collected = await text(f, ".hm-pv:first-child b");
    const pct = Math.round((Number(collected.replace(/[$,]/g, "")) / 25000) * 100);
    assert.match(await text(f, ".hm-c-goals"), new RegExp(`^Goals Edit Revenue this month \\$${collected.slice(1)} of \\$25,000 ${pct}% Jobs this month \\d+ of 60 \\d+%$`), "the month's Collected, as the Money card counts it");
    assert.equal(await has(f, ".hm-c-money .hm-goal"), false, "Rotor's card has no goal line");
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

test("the office (admin): the money (reports:read), and the Dashboard with her own sign-in (no office password)", async () => {
  await day();
  const { p, page, f } = await home("ada", { device: "iphone13" });
  try {
    assert.deepEqual((await cards(f)).slice(0, 2), ["money", "leaderboard"], "no clock for someone who doesn't go out on visits");
    assert.match(await f.getAttribute(".hm-money .hm-more", "href"), /^#\/dashboard/, "her sign-in opens the dashboards too");
    assert.deepEqual(await screenProblems(f), []);
    await shot(page, "home-admin-iphone13");
    await goTo(f, "/menu");
    assert.equal(await has(f, '#view a[href="#/dashboard"]'), true, "the Dashboard in the Menu");
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

test("Pipeline and Leads from the Menu (top-level: no switch, no back button); the Sales switch for someone who pins Sales; the Menu sheet", async () => {
  await day();
  for (const device of DEVICES) {
    const { p, page, f } = await home("olive", { device, office: true });
    try {
      for (const [path, name] of [["/pipeline", "Pipeline"], ["/leads", "Leads"]]) {
        await f.click('#tabs [data-tab="menu"]');
        await f.waitForSelector(".menu-sheet.on");
        await f.click(`.menu-sheet a[href="#${path}"]`);
        await settled(f, { hash: "#" + path });
        assert.equal(await title(f), name);
        assert.equal(await f.$eval("#subnav", (el) => el.hidden), true, "no Pipeline · Leads · Calls · Quotes · Tasks switch");
        assert.equal(await backShown(f), false, `${path}, from the Menu, is top-level: no back button`);
        assert.equal(await f.getAttribute('#tabs [data-tab="menu"]', "aria-current"), "page", "the Menu is lit on what it opens");
        assert.ok(await f.$("#fab"), "the create button");
        assert.deepEqual(await screenProblems(f), []);
        await shot(page, `home-menu-${path.slice(1)}-${device}`);
      }
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
      // someone who pins Sales on their own bar (Menu → Tab bar) still gets its switch
      await goTo(f, "/tab-bar");
      await f.click('[data-pick="map"]');
      await f.click('[data-pick="sales"]');
      await f.click("[data-save]");
      await f.waitForSelector('#tabs [data-tab="sales"]');
      await f.click('#tabs [data-tab="sales"]');
      await settled(f, { hash: "#/pipeline" });
      assert.deepEqual(await f.$$eval("#subnav .seg", (els) => els.map((e) => e.textContent)), ["Pipeline", "Leads", "Calls", "Quotes", "Tasks"]);
      await f.click('#subnav [href="#/tasks"]');
      await settled(f, { hash: "#/tasks" });
      assert.equal(await f.getAttribute('#tabs [data-tab="sales"]', "aria-current"), "page", "Sales lit on Tasks");
      assert.equal(await backShown(f), false);
      await goTo(f, "/tab-bar");
      await f.click("[data-standard]");
      await f.waitForFunction(() => [...document.querySelectorAll("#tabs [data-tab]")].map((e) => e.dataset.tab).join() === "home,schedule,inbox,map,menu", null, { timeout: 8000 });
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
      // the phone bar's places first, in its order, then the groups, then Settings and Team (Nov 2026)
      assert.deepEqual(await f.$$eval("#side .side-main .sl", (els) => els.map((e) => e.textContent)), ["Home", "Schedule", "Inbox", "Map", "Customers", "Sales"]);
      assert.deepEqual(await f.$$eval("#side .side-h span:first-child", (els) => els.map((e) => e.textContent)), ["Work", "Sales", "Customers", "Money", "Messages & automations", "Office tools", "Admin"]);
      assert.deepEqual(await f.$$eval("#side .side-foot .sl", (els) => els.map((e) => e.textContent)), ["Settings", "Team"]);
      assert.equal(await f.getAttribute('#side [data-path="/today"]', "aria-current"), "page", "Home lit");
      assert.ok(await f.isVisible("#top-q") && await f.isVisible("#top-new") && await f.isVisible("#top-me"), "search, New, the person");
      assert.deepEqual((await cards(f)).slice(0, 4), ["money", "clock", "leaderboard", "agenda"]);
      const [clock, money, agenda, grid, board] = await Promise.all([".hm-c-clock", ".hm-c-money", ".hm-c-agenda", ".hm-grid", ".hm-c-board"].map((s) => box(f, s)));
      assert.ok(grid.w <= 1160, `Home's width ${grid.w}`);
      if (device === "desk1440") {
        assert.equal(clock.w, grid.w, "the clock a bar across, on top");
        assert.ok(money.y >= clock.y + clock.h);
        assert.equal(money.y, board.y, "Money beside the Leaderboard");
        assert.ok(board.x >= money.x + money.w);
        assert.ok(agenda.y > money.y);
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
    const other = await f.$$eval("#ct-list a.cc-top", (as) => as.map((a) => a.getAttribute("href")));
    assert.ok(other.length >= 4, `the list filters (${other.length})`);
    await f.click(`#ct-list a.cc-top[href="${other[1]}"]`);
    await settled(f, { hash: other[1] });
    assert.equal(await f.inputValue("#ct-q"), "Workday", "the list kept its search");
    assert.equal(await f.getAttribute(`#ct-list a.cc-top[href="${other[1]}"]`, "aria-current"), "true", "the open card is lit");
    assert.deepEqual(await screenProblems(f), []);
    await shot(page, "home-desk-contacts-split");
    // back to the list alone: the pane asks what to open
    await goTo(f, "/contacts");
    assert.match(await f.textContent("#pane"), /Pick one of the customers/);
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

test("on a desk: /office installs as an app (Chrome's own check), and the office password alone opens only Team sign-in", async () => {
  await day();
  // the office password alone: Team sign-in, no tab row (the CRM sign-in is the only way in)
  const o = await phone(browser, srv, { device: "desk1440", office: true });
  try {
    await o.page.goto("/office");
    await o.page.waitForSelector("#team");
    assert.equal(await o.page.$(".bar, [data-tool]"), null, "no tab row");
    const cdp = await o.ctx.newCDPSession(o.page);
    const { installabilityErrors } = await cdp.send("Page.getInstallabilityErrors");
    assert.deepEqual(installabilityErrors.map((e) => e.errorId), [], "Chrome can install /office");
    const { url, errors } = await cdp.send("Page.getAppManifest");
    assert.ok(url.endsWith("/office.webmanifest"));
    assert.deepEqual(errors, []);
    await shot(o.page, "home-desk-office-signin");
    await o.clean();
  } finally { await o.close(); }
  // with a CRM sign-in: the CRM fills the window, sidebar and all, and installs from there too
  const { p, page } = await home("olive", { device: "desk1024", office: true });
  try {
    const cdp = await p.ctx.newCDPSession(page);
    const { installabilityErrors } = await cdp.send("Page.getInstallabilityErrors");
    assert.deepEqual(installabilityErrors.map((e) => e.errorId), []);
    assert.equal(!!(await page.$(".bar .nav")), false, "one app");
    assert.equal(await page.isVisible("#install"), false, "no Get the app card on a computer");
    await shot(page, "home-desk-office-crm");
    await p.clean();
  } finally { await p.close(); }
});
