// Phone and desk checks of Home (the owner's Nov 12 choice: Rotor's phone
// Home with the best of Flyra's, as cards each person picks with Edit
// Home; Nov 15, with Flyra's screenshots: "Make the home page look like
// Flyra"), the office's bar, the Sales switch and the Menu, at iPhone 13
// and SE sizes in both themes and 1440 x 900 and 1024 x 768: the header,
// the top without a card (Revenue | ARR, Revenue first; the period sheet
// on a phone, chips on a desk; the period in caps, the big number, AVG and
// PEAK; the line with its values at the left, a tap's readout, "Updated" or
// where Collected comes from; ARR by month (Nov 15: 6M 1Y YTD All, a bar a
// month with its MRR on top and its short name, no axis or grid, this
// month lit, the change since the period began and this month's, a tapped
// month's MRR, ARR and the plans added and lost; Nov 16: the next 12
// months first, In 12 months and the change, a month's projected MRR and
// ARR and the plans renewing and ending; Barta's red, no blue anywhere on
// Home); a tap to Payments or Plans), no Leaderboard or Inbox card (Nov
// 16: the Menu's Leaderboard), the compact
// Clock in (in and out), Today (Daily | Weekly | Monthly, tasks without a
// due date), Edit Home (on, off, order, from My account too), the optional
// cards, the empty state before any CRM data, Flyra's two columns on a
// desk, and a tech who never sees Home. The money is the made-up Rotor
// snapshot the server seals for its throwaway key, then (the real day) a
// made-up Rotor import of two days ago with its payments. No console
// errors, no CSP violations, no sideways scroll, 44 px targets.
// E2E_SHOTS=<dir> saves the screenshots.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { start } from "./server.mjs";
import { launch, phone, signIn, crmFrame, goTo, settled, title, hashOf, backShown, screenProblems, badLinks, shot, noInstallCard, drawerGo, openDrawer, drawerLabels } from "./kit.mjs";

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
// the cards in the order a phone shows them (each slot's order)
const cards = (f) => f.$$eval(".hm-grid [data-slot]", (els) => els.sort((a, b) => Number(a.style.order) - Number(b.style.order)).map((e) => e.dataset.slot));
// the words of an element as written (each text node apart, before any CSS capitals)
const tc = (f, sel) => f.$eval(sel, (el) => { const w = document.createTreeWalker(el, NodeFilter.SHOW_TEXT); const out = []; while (w.nextNode()) out.push(w.currentNode.nodeValue); return out.join(" ").replace(/\s+/g, " ").replace(/ ,/g, ",").trim(); });
// what Home no longer has: the KPI tiles, the quick actions, the dark money card, the old charts, Needs you, Rotor's Money card
const GONE = ".hm-kpi, .hm-qa, .hm-quick, .hm-hero, .hm-needs, .hm-need, [data-chart=weekly], [data-chart=monthly], [data-chart=weeks], .hm-pair, .hm-arrhead, [data-hm=m-period], [data-hm=m-move], [data-hm=m-fold], .hm-c-money";
// no blue on Home (Nov 16, "make it my business colors, not the blue"): every color Home's own CSS draws
// (text, fills, strokes, borders, backgrounds, the glow) is Barta's red or a grey; the people's own colors
// (an inline style: the visit bars, the avatars, the calendar's dots) and status pills are theirs
const blues = (f) => f.evaluate(() => {
  const out = [];
  const rgb = (c) => [...String(c).matchAll(/rgba?\(([^)]+)\)/g)].map((m) => m[1].split(/[ ,/]+/).filter(Boolean).map(Number)).filter((x) => x.length < 4 || x[3] > 0.02);
  const blue = (c) => rgb(c).some(([r, g, b]) => b > r + 24 && b > g + 8);
  const els = [document.querySelector(".app .top"), document.getElementById("view"), ...document.querySelectorAll("#view .hm *")].filter(Boolean);
  for (const el of els) {
    if (el.closest("[style*='--bar'], [style*='background'], [style*='--c']") || el.closest(".pill")) continue;
    const cs = getComputedStyle(el);
    for (const k of ["color", "backgroundColor", "backgroundImage", "fill", "stroke", "borderTopColor", "borderBottomColor", "outlineColor", "stopColor"]) {
      if (k === "color" && !el.childNodes.length) continue;
      if (blue(cs[k])) out.push(`${el.tagName.toLowerCase()}.${String(el.className && el.className.baseVal !== undefined ? el.className.baseVal : el.className).replace(/\s+/g, ".")} ${k} ${cs[k]}`);
    }
  }
  return out;
});
const box = (f, sel) => f.$eval(sel, (el) => { const r = el.getBoundingClientRect(); return { x: Math.round(r.left), y: Math.round(r.top), w: Math.round(r.width), h: Math.round(r.height) }; });
// the screen is drawn again (a card's own read finished)
const idle = (f) => f.waitForFunction(() => !document.querySelector('#view [aria-busy="true"]'));
// the top drawn again after its own read
const topIdle = (f) => f.waitForFunction(() => { const h = document.querySelector(".hm-mhead"); return h && h.getAttribute("aria-busy") === "false"; });
// Revenue | ARR
async function view(f, v) {
  await f.click(`[data-hm="m-view"][data-v="${v}"]`);
  await f.waitForSelector(`.hm-money[data-view="${v}"]`);
  await topIdle(f);
}
// a period from the phone's sheet (or a desk's chip); → the caps label
async function period(f, r) {
  if (await f.isVisible('[data-hm="m-ranges"]')) {
    await f.click('[data-hm="m-ranges"]');
    await f.waitForSelector(".sheet.on .hm-ropt");
    await f.click(`.sheet.on [data-r="${r}"]`);
    await f.waitForFunction(() => !document.querySelector(".sheet.on"));
  } else await f.click(`[data-hm="m-range"][data-v="${r}"]`);
  await f.waitForFunction((r) => { const b = document.querySelector('[data-hm="m-range"][aria-pressed="true"]'); return b && b.dataset.v === r; }, r);
  await topIdle(f);
  return tc(f, ".hm-mper");
}

test("before any CRM data: the header, Rotor's money at the top, Clock in and a calm empty Today; no Leaderboard, no Inbox", async () => {
  for (const device of DEVICES) {
    const { p, page, f } = await home("olive", { device, office: true });
    try {
      assert.equal(await title(f), "Home");
      assert.ok(["", "#/today"].includes(await hashOf(f)), "the app opens on Home");
      assert.deepEqual(await f.$$eval("#tabs [data-tab]", (els) => els.map((e) => e.querySelector("span").textContent)), ["Home", "Schedule", "Inbox", "Map", "Menu"]);
      // Flyra's Home: the greeting, the first name big; the money on the canvas, then the cards
      assert.match(await text(f, ".hm-head"), /^Good morning Olive/);
      assert.deepEqual(await cards(f), ["money", "clock", "agenda", "tasks", "goals"], "the default cards, in order (the clock: Olive goes out on visits; no Leaderboard, no Inbox since Nov 16)");
      assert.equal(await has(f, ".hm-c-board, .hm-c-inbox, [data-card=leaderboard], [data-card=inbox]"), false);
      assert.equal(await has(f, GONE), false, "nothing of the old Home");
      // the top: no card; Revenue first, this month; no import yet, so Collected is Rotor's snapshot and its weeks
      assert.equal(await f.$eval(".hm-money", (e) => !!e.closest(".hm-card")), false, "no card around the top");
      assert.equal(await f.getAttribute('[data-hm="m-view"][data-v="revenue"]', "aria-pressed"), "true", "Revenue first, as Flyra");
      assert.deepEqual(await f.$$eval('[data-hm="m-view"]', (els) => els.map((e) => e.textContent)), ["Revenue", "ARR"]);
      assert.equal(await tc(f, '[data-hm="m-ranges"]'), "1M");
      assert.equal(await tc(f, ".hm-mper"), "Revenue, November");
      assert.equal(await tc(f, ".hm-mbig"), "Collected, $10,453");
      assert.match(await tc(f, ".hm-stats"), /^Avg \$[\d,]+ Best week \$[\d,]+$/, "Rotor's weeks: its best week");
      assert.equal(await tc(f, ".hm-upd"), "From Rotor · updated Nov 16");
      assert.equal(await f.$$eval('[data-chart="revenue"] .hf-line', (x) => x.length), 1);
      // ARR: no plans yet: "-" (the next 12 months)
      await view(f, "arr");
      assert.match(await tc(f, ".hm-money"), /ARR, Nov 2026 – Oct 2027 ARR, - In 12 months - Change - ARR shows here once there are plans\. 0 active plans/);
      assert.equal(await has(f, ".hm-mread"), false, "no month to read out");
      await view(f, "revenue");
      // Clock in, compact
      assert.match(await text(f, ".hm-c-clock"), /^Timesheet 0h 0m Choose a role when you clock in Clock In$/i);
      assert.ok((await box(f, ".hm-c-clock")).h <= 80, "the clock is one short row");
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
      assert.deepEqual((await cards(f)).slice(0, 3), ["money", "clock", "agenda"]);
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

test("the top (Flyra's, Nov 15): Revenue first, AVG and PEAK, the line, the readout, the period sheet; ARR ahead by month (Nov 16) and the past, Barta's red, both themes", async () => {
  await day();
  for (const device of DEVICES) {
    const { p, page, f } = await home("olive", { device, office: true });
    try {
      assert.deepEqual((await cards(f))[0], "money", "the money at the top");
      await f.evaluate(() => { const t = document.getElementById("toasts"); if (t) t.style.visibility = "hidden"; });
      // Revenue, this month: per day from the import (two days ago), its average a day and its best day
      assert.equal(await f.getAttribute('[data-hm="m-view"][data-v="revenue"]', "aria-pressed"), "true");
      assert.equal(await tc(f, ".hm-mper"), "Revenue, November");
      const big = await tc(f, ".hm-mbig");
      assert.match(big, /^Collected, \$[\d,]+$/);
      const stats = (await tc(f, ".hm-stats")).match(/^Avg (\$[\d,]+) Peak (\$[\d,]+)$/);
      assert.ok(stats, await tc(f, ".hm-stats"));
      const total = Number(big.replace(/[^\d]/g, "")), avg = Number(stats[1].replace(/[$,]/g, "")), peak = Number(stats[2].replace(/[$,]/g, ""));
      assert.ok(Math.abs(avg - total / 15) <= 1 && peak > avg && peak <= total, `${total} ${avg} ${peak}: a day on average through the import's day`);
      assert.equal(await tc(f, ".hm-upd"), "From Rotor's import of Nov 15");
      assert.equal(await f.getAttribute(".hm-mlink", "href"), "#/payments", "a tap on the number opens Payments");
      // the line: one, the values at the left from 0, faint lines, a dotted baseline, no dates under it
      assert.equal(await f.$$eval('[data-chart="revenue"] .hf-line', (x) => x.length), 1);
      const ticks = await f.$$eval('[data-chart="revenue"] .hf-t', (els) => els.map((e) => e.textContent));
      assert.ok(ticks.length >= 3 && ticks[0] === "0" && ticks.every((x) => /^[\d.]+K?$/.test(x)), ticks.join(" "));
      assert.equal(await f.$$eval('[data-chart="revenue"] .hf-grid', (x) => x.length), ticks.length);
      assert.equal(await f.$$eval('[data-chart="revenue"] .hf-base', (x) => x.length), 1);
      const [top, chart] = await Promise.all([box(f, ".hm-money"), box(f, '[data-chart="revenue"]')]);
      assert.ok(chart.w >= top.w - 2, `the line across the width: ${chart.w} of ${top.w}`);
      // AVG and PEAK on the right of the big number
      const [num, side] = await Promise.all([box(f, ".hm-mbig"), box(f, ".hm-stats")]);
      assert.ok(side.x >= num.x + num.w && side.x + side.w <= top.x + top.w + 1, "AVG and PEAK on the right");
      for (const theme of ["dark", "light"]) {
        await f.evaluate((t) => { document.documentElement.dataset.theme = t; }, theme);
        await page.waitForTimeout(150);
        assert.deepEqual(await screenProblems(f), [], theme);
        await shot(page, `home-top-${device}-${theme}`);
      }
      await f.evaluate(() => { document.documentElement.dataset.theme = "dark"; });
      // the readout: nothing until the line is touched; then the day and its money
      assert.equal(await tc(f, ".hm-read"), "");
      await f.focus('[data-chart="revenue"]');
      assert.match(await tc(f, ".hm-read"), /^Nov 15 · \$[\d,]+$/, "the latest day counted");
      await page.keyboard.press("Home");
      assert.match(await tc(f, ".hm-read"), /^Nov 1 · \$[\d,]+$/);
      await page.keyboard.press("ArrowRight");
      assert.match(await tc(f, ".hm-read"), /^Nov 2 · \$[\d,]+$/);
      const cb = await box(f, '[data-chart="revenue"]');
      await f.click('[data-chart="revenue"]', { position: { x: Math.round(cb.w * 0.35), y: 60 } });
      assert.match(await tc(f, ".hm-read"), /^Nov \d+ · \$[\d,]+$/);
      assert.equal(await f.$$eval('[data-chart="revenue"] .hf-dot[visibility="visible"]', (x) => x.length), 1);
      // the period: a small sheet with 1W 1M 3M 1Y YTD
      await f.click('[data-hm="m-ranges"]');
      await f.waitForSelector(".sheet.on .hm-ropt");
      assert.deepEqual(await f.$$eval(".sheet.on .hm-ropt", (els) => els.map((e) => e.querySelector("b").textContent + " " + e.querySelector("span").textContent)), ["1W This week", "1M This month", "3M The last 3 months", "1Y The last 12 months", "YTD This year"]);
      assert.equal(await f.getAttribute('.sheet.on [data-r="1m"]', "aria-pressed"), "true");
      assert.deepEqual(await screenProblems(f), [], "the sheet");
      await shot(page, `home-period-${device}`);
      await page.keyboard.press("Escape");
      await f.waitForFunction(() => !document.querySelector(".sheet.on"));
      assert.equal(await period(f, "3m"), "Revenue, September – November");
      assert.equal(await tc(f, '[data-hm="m-ranges"]'), "3M");
      assert.equal(await tc(f, ".hm-mbig"), big, "the import's payments are all in November");
      assert.equal(await period(f, "1w"), "Revenue, Nov 16 – 22");
      assert.equal(await tc(f, ".hm-mbig"), "Collected, -", "this week is after the import's day: '-', never $0");
      assert.equal(await period(f, "1m"), "Revenue, November");
      // ARR ahead by month (the owner's Nov 16 ask, "the ARR for next year per month"): the next 12 months to start with
      await view(f, "arr");
      assert.equal(await tc(f, ".hm-mper"), "ARR, Nov 2026 – Oct 2027");
      assert.equal(await tc(f, '[data-hm="m-ranges"]'), "Next year");
      const arr = (await tc(f, ".hm-mbig")).match(/^ARR, (\$[\d,]+)$/);
      const ahead = (await tc(f, ".hm-stats")).match(/^In 12 months (\$[\d,]+) Change ([+−]?\$[\d,]+)(?: ([+−][\d.,]+%))?$/);
      assert.ok(arr && ahead, await tc(f, ".hm-money"));
      const dollars = (x) => Number(x.replace(/[$,+]/g, "").replace("−", "-"));
      // the months as the screen reader's table has them: projected MRR and ARR at each month's end, the plans renewing, ending, starting
      const fwd = await f.$$eval(".hm-money table.sr tbody tr", (trs) => trs.map((tr) => [...tr.children].map((c) => c.textContent)));
      assert.deepEqual(fwd.map((r) => r[0]), ["Nov 2026", "Dec 2026", "Jan 2027", "Feb 2027", "Mar 2027", "Apr 2027", "May 2027", "Jun 2027", "Jul 2027", "Aug 2027", "Sep 2027", "Oct 2027"]);
      for (const r of fwd) assert.ok(Math.abs(dollars(r[1]) * 12 - dollars(r[2])) <= 12, `${r[0]}: MRR is ARR / 12 (${r[1]}, ${r[2]})`);
      assert.equal(fwd[11][2], ahead[1], "In 12 months: the last month's projected ARR");
      assert.equal(dollars(ahead[2]), dollars(ahead[1]) - dollars(arr[1]), "the change: from today's ARR to it");
      assert.ok(dollars(fwd[0][2]) <= dollars(arr[1]), "this month's end: today's plans (a later start counts from its month)");
      assert.ok(fwd.some((r) => r[3] !== "0"), "the seed's plans renew in the year ahead");
      console.log(`# ARR ahead on the e2e seed (${device}): today ${arr[1]}, in 12 months ${ahead[1]}, change ${ahead[2]} ${ahead[3] || ""}; ${fwd.map((r) => `${r[0]} ${r[2]} (MRR ${r[1]}, renewing ${r[3]}, ending ${r[4]}, starting ${r[5]})`).join("; ")}`);
      // a bar a month with its MRR on top, the short names, this month lit (the first) and picked
      assert.equal(await f.$$eval('[data-chart="arr"] .hb-bar', (x) => x.length), 12);
      assert.deepEqual(await f.$$eval('[data-chart="arr"] .hb-m', (els) => els.map((e) => e.textContent)), ["Nov", "Dec", "Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct"]);
      assert.match(await tc(f, ".hm-bcap"), /^Projected MRR by month ARR ÷ 12$/);
      const flabels = await f.$$eval('[data-chart="arr"] .hb-v', (els) => els.map((e) => { const r = e.getBoundingClientRect(), c = e.closest(".hc").getBoundingClientRect(); return { t: e.textContent, l: r.left, r: r.right, inside: r.left >= c.left - 1 && r.right <= c.right + 1 && r.top >= c.top - 1, fs: parseFloat(getComputedStyle(e).fontSize) }; }));
      assert.equal(flabels.length, 12, "every month's MRR");
      assert.ok(flabels.every((x, i) => x.inside && x.fs >= 10 && (!i || x.l >= flabels[i - 1].r)), JSON.stringify(flabels));
      assert.deepEqual(await f.$$eval('[data-chart="arr"] .hb-bar.now, [data-chart="arr"] .hb-m.now', (els) => els.map((e) => e.dataset.i)), ["0", "0"], "this month lit");
      assert.equal(await tc(f, '[data-chart="arr"] .hb-m.on'), "Nov");
      const pw = (n) => `${n} ${n === "1" ? "plan" : "plans"}`;
      const readOf = (r) => `${r[0]} Projected MRR ${r[1]} ARR ${r[2]} Renewing ${pw(r[3])} Ending ${pw(r[4])}${r[5] !== "0" ? ` Starting ${pw(r[5])}` : ""}`;
      assert.equal(await tc(f, ".hm-mread"), readOf(fwd[0]));
      // Barta's red: the bars, the month lit; no blue anywhere on Home, in either theme
      const red = await f.$eval('[data-chart="arr"] .hb-bar.now', (e) => getComputedStyle(e).fill);
      assert.equal(red, "rgb(251, 77, 61)", "the logo red");
      const [head4, num4, side4] = await Promise.all([box(f, ".hm-mhead"), box(f, ".hm-mbig"), box(f, ".hm-stats")]);
      assert.ok(side4.x + side4.w <= head4.x + head4.w + 1 && (side4.x >= num4.x + num4.w || side4.y >= num4.y + num4.h - 4), "In 12 months and the change beside the big number, or under it");
      for (const theme of ["dark", "light"]) {
        await f.evaluate((t) => { document.documentElement.dataset.theme = t; }, theme);
        await page.waitForTimeout(150);
        assert.deepEqual(await screenProblems(f), [], `ARR ahead ${theme}`);
        assert.deepEqual(await blues(f), [], `no blue on Home (${theme})`);
        await shot(page, `home-arr-ahead-${device}-${theme}`);
      }
      await f.evaluate(() => { document.documentElement.dataset.theme = "dark"; });
      // a tap on a month ahead: its projected MRR and ARR, the plans renewing and ending in it
      const fb = await box(f, '[data-chart="arr"]');
      const fslot = await f.$eval('[data-chart="arr"] .hb-bar[data-i="4"]', (el) => { const r = el.getBoundingClientRect(), c = el.closest(".hc").getBoundingClientRect(); return Math.round(r.left - c.left + r.width / 2); });
      await f.click('[data-chart="arr"]', { position: { x: fslot, y: Math.round(fb.h / 2) } });
      assert.equal(await tc(f, '[data-chart="arr"] .hb-m.on'), "Mar");
      assert.equal(await tc(f, ".hm-mread"), readOf(fwd[4]));
      await f.focus('[data-chart="arr"]');
      await page.keyboard.press("End");
      assert.equal(await tc(f, ".hm-mread"), readOf(fwd[11]));
      assert.deepEqual(await screenProblems(f), [], "a month ahead picked");
      // ARR's periods: Next year, then the past (a small sheet on a phone)
      await f.click('[data-hm="m-ranges"]');
      await f.waitForSelector(".sheet.on .hm-ropt");
      assert.deepEqual(await f.$$eval(".sheet.on .hm-ropt", (els) => els.map((e) => e.querySelector("b").textContent + " " + e.querySelector("span").textContent)), ["Next year The next 12 months", "Past 6M The past 6 months", "Past year The past 12 months", "YTD This year so far", "All Since the first plan"]);
      assert.equal(await f.getAttribute('.sheet.on [data-r="next12"]', "aria-pressed"), "true");
      await page.keyboard.press("Escape");
      await f.waitForFunction(() => !document.querySelector(".sheet.on"));
      // ARR by month, the past year (the owner's Nov 15 ask)
      assert.equal(await period(f, "1y"), "ARR, Dec 2025 – Nov 2026");
      assert.equal(await tc(f, '[data-hm="m-ranges"]'), "Past year");
      assert.equal(await tc(f, ".hm-mbig"), arr[0], "the big number is today's ARR whatever the period");
      const side2 = (await tc(f, ".hm-stats")).match(/^Change ([+−]\$[\d,]+)(?: ([+−][\d.,]+%))? This month ([+−]?\$[\d,]+)$/);
      assert.ok(side2, await tc(f, ".hm-money"));
      // the months as the screen reader's table has them: MRR and ARR at each month's end, the plans added and lost
      const months = await f.$$eval(".hm-money table.sr tbody tr", (trs) => trs.map((tr) => [...tr.children].map((c) => c.textContent)));
      assert.deepEqual(months.map((r) => r[0]), ["Dec 2025", "Jan 2026", "Feb 2026", "Mar 2026", "Apr 2026", "May 2026", "Jun 2026", "Jul 2026", "Aug 2026", "Sep 2026", "Oct 2026", "Nov 2026"]);
      const at = (i) => dollars(months[i][2]);
      assert.equal(months[11][2], arr[1], "this month's point is today's ARR");
      for (const r of months) assert.ok(Math.abs(dollars(r[1]) * 12 - dollars(r[2])) <= 12, `${r[0]}: MRR is ARR / 12 (${r[1]}, ${r[2]})`);
      assert.equal(dollars(side2[3]), at(11) - at(10), "this month's change: since the end of October");
      assert.ok(dollars(side2[1]) > 0 && dollars(side2[1]) <= at(11), side2[1]);
      assert.ok(months.some((r) => r[4] !== "0"), "the seed's cancelled plans: a month lost one");
      // a bar a month, each with its MRR on top ("showing the MRR in all 12 months", Nov 15: no axis, no grid),
      // each month's short name under it, this month lit
      assert.equal(await f.$$eval('[data-chart="arr"] .hb-bar', (x) => x.length), 12);
      assert.deepEqual(await f.$$eval('[data-chart="arr"] .hb-m', (els) => els.map((e) => e.textContent)), ["Dec", "Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov"]);
      assert.equal(await f.$$eval('[data-chart="arr"] .hf-grid, [data-chart="arr"] .hf-t:not(.hb-m)', (x) => x.length), 0, "no axis, no grid");
      assert.match(await tc(f, ".hm-bcap"), /^MRR by month ARR ÷ 12$/);
      const vlabels = await f.$$eval('[data-chart="arr"] .hb-v', (els) => els.map((e) => { const r = e.getBoundingClientRect(), c = e.closest(".hc").getBoundingClientRect(); return { t: e.textContent, l: r.left, r: r.right, inside: r.left >= c.left - 1 && r.right <= c.right + 1 && r.top >= c.top - 1, fs: parseFloat(getComputedStyle(e).fontSize) }; }));
      assert.equal(vlabels.length, 12, "every month's MRR");
      assert.ok(vlabels.every((x, i) => x.inside && x.fs >= 10 && (!i || x.l >= vlabels[i - 1].r)), `readable, in the chart, never on each other: ${JSON.stringify(vlabels)}`);
      assert.ok(vlabels.every((x, i) => /^\$?\d+(\.\d)?[kM]?$/.test(x.t) && Math.abs(Number(x.t.replace(/[$kM]/g, "")) * (/k$/.test(x.t) ? 1000 : /M$/.test(x.t) ? 1e6 : 1) - dollars(months[i][1])) <= Math.max(1, dollars(months[i][1]) * 0.06)), vlabels.map((x) => x.t).join(" "));
      if (device === "iphone13") assert.ok(vlabels.every((x) => x.t.startsWith("$")), "with the $ where it fits");
      assert.deepEqual(await f.$$eval('[data-chart="arr"] .hb-bar.now, [data-chart="arr"] .hb-m.now', (els) => els.map((e) => e.dataset.i)), ["11", "11"], "this month lit");
      // the month picked to start with: this one, its readout under the bars (the month, its MRR and ARR, the plans added and lost)
      assert.equal(await tc(f, '[data-chart="arr"] .hb-m.on'), "Nov");
      assert.equal(await tc(f, ".hm-mread"), `Nov 2026 MRR ${months[11][1]} ARR ${arr[1]} Added ${months[11][3]} ${months[11][3] === "1" ? "plan" : "plans"} Lost ${months[11][4]} ${months[11][4] === "1" ? "plan" : "plans"}`);
      assert.match(await tc(f, ".hm-read"), /^\d+ active plans? · MRR \$[\d,]+$/);
      assert.match(await tc(f, ".hm-upd"), /^Updated \d+:\d\d [AP]M$/);
      assert.equal(await f.getAttribute(".hm-mlink", "href"), "#/plans");
      const [head2, num2, side3] = await Promise.all([box(f, ".hm-mhead"), box(f, ".hm-mbig"), box(f, ".hm-stats")]);
      assert.ok(side3.x >= num2.x + num2.w && side3.y < num2.y + num2.h && side3.x + side3.w <= head2.x + head2.w + 1, "the change and this month on the right of the big number");
      for (const theme of ["dark", "light"]) {
        await f.evaluate((t) => { document.documentElement.dataset.theme = t; }, theme);
        await page.waitForTimeout(150);
        assert.deepEqual(await screenProblems(f), [], `ARR ${theme}`);
        await shot(page, `home-arr-${device}-${theme}`);
      }
      await f.evaluate(() => { document.documentElement.dataset.theme = "dark"; });
      // a tap on a month: its ARR, the plans added and lost in it
      const ab = await box(f, '[data-chart="arr"]');
      const slot = await f.$eval('[data-chart="arr"] .hb-bar[data-i="5"]', (el) => { const r = el.getBoundingClientRect(), c = el.closest(".hc").getBoundingClientRect(); return Math.round(r.left - c.left + r.width / 2); });
      await f.click('[data-chart="arr"]', { position: { x: slot, y: Math.round(ab.h / 2) } });
      assert.equal(await tc(f, '[data-chart="arr"] .hb-m.on'), "May");
      assert.equal(await f.$$eval('[data-chart="arr"] .hb-bar.on', (x) => x.map((e) => e.dataset.i).join()), "5");
      const plansWord = (n) => `${n} ${n === "1" ? "plan" : "plans"}`;
      assert.equal(await tc(f, ".hm-mread"), `May 2026 MRR ${months[5][1]} ARR ${months[5][2]} Added ${plansWord(months[5][3])} Lost ${plansWord(months[5][4])}`);
      assert.equal(await f.$$eval('[data-chart="arr"] .hb-v.on', (x) => x.map((e) => e.dataset.i).join()), "5", "its value lit too");
      assert.deepEqual(await screenProblems(f), [], "a month picked");
      await shot(page, `home-arr-month-${device}`);
      // the arrow keys pick the month before and after
      await f.focus('[data-chart="arr"]');
      await page.keyboard.press("ArrowLeft");
      assert.ok((await tc(f, ".hm-mread")).startsWith(`Apr 2026 MRR ${months[4][1]} ARR ${months[4][2]} Added`), await tc(f, ".hm-mread"));
      await page.keyboard.press("End");
      assert.match(await tc(f, ".hm-mread"), /^Nov 2026 /);
      // the other past periods: 6M YTD All
      for (const [r, label, n, first] of [["6m", "ARR, Jun – Nov 2026", 6, "Jun"], ["ytd", "ARR, Jan – Nov 2026", 11, "Jan"], ["all", "ARR, Oct 2025 – Nov 2026", 14, "Oct"]]) {
        assert.equal(await period(f, r), label);
        assert.equal(await tc(f, ".hm-mbig"), arr[0], "the big number is today's ARR whatever the period");
        assert.equal(await f.$$eval('[data-chart="arr"] .hb-bar', (x) => x.length), n, r);
        const names = await f.$$eval('[data-chart="arr"] .hb-m', (els) => els.map((e) => e.textContent));
        assert.ok(names[names.length - 1] === "Nov" && (names.length === n ? names[0] === first : names.length >= n / 2), `${r}: ${names.join(" ")}`);
        assert.match(await tc(f, ".hm-mread"), /^Nov 2026 /, "this month picked again");
        assert.deepEqual(await screenProblems(f), [], r);
      }
      assert.equal(await period(f, "next12"), "ARR, Nov 2026 – Oct 2027");
      // back to Revenue: it keeps its own period
      await view(f, "revenue");
      assert.equal(await tc(f, ".hm-mper"), "Revenue, November");
      assert.equal(await tc(f, '[data-hm="m-ranges"]'), "1M");
      assert.deepEqual(await screenProblems(f), []);
      await view(f, "arr");
      await f.click(".hm-mlink");
      await settled(f, { hash: "#/plans" });
      await goTo(f, "/today");
      assert.equal(await f.getAttribute('[data-hm="m-view"][data-v="revenue"]', "aria-pressed"), "true", "Home opens on Revenue, this month, again");
      assert.equal(await tc(f, '[data-hm="m-ranges"]'), "1M");
      await f.click(".hm-mlink");
      await settled(f, { hash: "#/payments" });
      await p.clean();
    } finally { await p.close(); }
  }
});

test("no Leaderboard and no Inbox on Home (Nov 16): Edit Home doesn't offer them, an old layout drops them; the full Leaderboard is the Menu's", async () => {
  await day();
  const { p, page, f } = await home("olive", { device: "iphone13", office: true });
  try {
    // a layout saved before Nov 16 with both on (the API, as an older phone's Edit Home saves): they just drop
    const put = await p.ctx.request.put("/api/crm/home/layout", { headers: { "x-crm": "1", "content-type": "application/json" }, data: { cards: ["money", "leaderboard", "agenda", "inbox", "tasks", "goals"].map((key) => ({ key, on: true })) } });
    assert.equal(put.status(), 200);
    assert.deepEqual((await put.json()).data.layout.map((c) => c.key), ["money", "clock", "agenda", "tasks", "goals"]);
    await goTo(f, "/menu");
    await goTo(f, "/today");
    assert.deepEqual(await cards(f), ["money", "clock", "agenda", "tasks", "goals"]);
    assert.equal(await has(f, ".hm-c-board, .hm-c-inbox, [data-hm=board]"), false);
    await f.click(".hm-edit [data-hm=edit]");
    await f.waitForSelector(".sheet.on .hm-edit-list");
    assert.deepEqual(await f.$$eval(".sheet.on .hm-edit-list li", (els) => els.map((e) => e.dataset.key)), ["money", "clock", "agenda", "tasks", "goals"]);
    await f.click(".sheet.on [data-sheet-x]");
    await f.waitForFunction(() => !document.querySelector(".sheet.on"));
    // the full Leaderboard: the Menu's
    await goTo(f, "/menu");
    assert.equal(await has(f, '#view a[href="#/leaderboard"]'), true, "the Leaderboard in the Menu");
    await goTo(f, "/leaderboard");
    assert.equal(await title(f), "Leaderboard");
    assert.deepEqual(await screenProblems(f), []);
    assert.equal((await p.ctx.request.put("/api/crm/home/layout", { headers: { "x-crm": "1", "content-type": "application/json" }, data: { cards: [] } })).status(), 200);
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
    await f.waitForFunction(() => /Since/.test((document.querySelector(".hm-c-clock") || {}).textContent || ""));
    assert.match(await text(f, ".hm-c-clock"), /^Timesheet 0h \dm Since \d+:\d\d [AP]M · Office Clock Out$/i);
    assert.equal(await f.getAttribute(".hm-c-clock .hm-clock-main", "href"), "#/time", "the hours open your time");
    assert.equal(await has(f, ".hm-c-clock .hm-dot.on"), true);
    assert.deepEqual(await screenProblems(f), []);
    await shot(page, "home-clocked-in-iphonese");
    await f.click('.hm-c-clock [data-hm="clock"]');
    await f.waitForFunction(() => /Clock In/.test((document.querySelector(".hm-c-clock") || {}).textContent || ""));
    assert.equal((await p.ctx.request.put("/api/crm/home/layout", { headers: { "x-crm": "1", "content-type": "application/json" }, data: { cards: [] } })).status(), 200);
    await p.clean();
  } finally { await p.close(); }
});

test("Edit Home: turn cards on, order them, save; Goals and Tasks; from My account too", async () => {
  await day();
  const { p, page, f } = await home("olive", { device: "iphone13", office: true });
  try {
    await f.click(".hm-edit [data-hm=edit]");
    await f.waitForSelector(".sheet.on .hm-edit-list");
    assert.deepEqual(await f.$$eval(".sheet.on .hm-edit-list li", (els) => els.map((e) => `${e.dataset.key}:${e.querySelector("input").checked}`)), ["money:true", "clock:true", "agenda:true", "tasks:true", "goals:true"], "every card on (the clock: Olive goes out on visits); no Leaderboard, no Inbox");
    assert.equal(await f.$$eval('.sheet.on li[data-key="money"] [data-mv]', (x) => x.length), 0, "the money stays at the top");
    assert.deepEqual(await screenProblems(f), [], "the sheet's targets");
    await shot(page, "home-edit-iphone13");
    for (const k of ["tasks", "goals"]) await f.check(`.sheet.on li[data-key="${k}"] input`);
    await f.uncheck('.sheet.on li[data-key="clock"] input');
    // Goals up to the top: right under the money (it stays first)
    for (let i = 0; i < 5; i++) await f.click('.sheet.on li[data-key="goals"] [data-mv="-1"]');
    assert.deepEqual(await f.$$eval(".sheet.on .hm-edit-list li", (els) => els.map((e) => e.dataset.key)).then((x) => x.slice(0, 2)), ["money", "goals"]);
    await f.click(".sheet.on [data-save]");
    await f.waitForFunction(() => !document.querySelector(".sheet.on"));
    // the grid is drawn again in the saved order (Goals was already on: wait for the order, not the card)
    await f.waitForFunction(() => !document.querySelector('[data-slot="clock"]'));
    assert.deepEqual(await cards(f), ["money", "goals", "agenda", "tasks"]);
    // Goals: an owner adds them; progress here
    assert.match(await text(f, ".hm-c-goals"), /^Goals Add No goals yet Tap Add/);
    await f.click('.hm-c-goals [data-hm="goals"]');
    await f.waitForSelector(".sheet.on [data-goals]");
    await f.fill('.sheet.on input[name="revenue"]', "25000");
    await f.fill('.sheet.on input[name="jobs"]', "60");
    await f.click('.sheet.on [data-goals] button[type="submit"]');
    await f.waitForFunction(() => /Revenue this month/.test((document.querySelector(".hm-c-goals") || {}).textContent || ""));
    const collected = (await tc(f, ".hm-mbig")).replace("Collected, ", "");
    const pct = Math.round((Number(collected.replace(/[$,]/g, "")) / 25000) * 100);
    assert.match(await text(f, ".hm-c-goals"), new RegExp(`^Goals Edit Revenue this month \\$${collected.slice(1)} of \\$25,000 ${pct}% Jobs this month \\d+ of 60 \\d+%$`), "the month's Collected, as the top counts it");
    assert.equal(await has(f, ".hm-money .hm-goal"), false, "no goal line at the top");
    // Tasks: Upcoming ▾ and Add
    assert.equal(await f.getAttribute(".hm-c-tasks .hm-chip", "href"), "#/tasks/new");
    await f.selectOption('.hm-c-tasks select', "all");
    assert.ok(await has(f, ".hm-c-tasks .hm-task"), "the owner's team's open tasks");
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
    assert.deepEqual((await cards(f)).slice(0, 3), ["money", "agenda", "tasks"], "no clock for someone who doesn't go out on visits");
    assert.equal(await f.getAttribute(".hm-mlink", "href"), "#/payments");
    assert.deepEqual(await screenProblems(f), []);
    await shot(page, "home-admin-iphone13");
    await goTo(f, "/menu");
    assert.equal(await has(f, '#view a[href="#/reports"]'), true, "Reports in the Menu (Analytics)");
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

test("Pipeline and Leads from the Menu (top-level: no switch, no back button); the Sales switch for someone who pins Sales; the Menu", async () => {
  await day();
  for (const device of DEVICES) {
    const { p, page, f } = await home("olive", { device, office: true });
    try {
      for (const [path, name] of [["/pipeline", "Pipeline"], ["/leads", "Leads"]]) {
        await drawerGo(f, path);
        // (Track 2: the section opens on its first view, #/pipeline?view=list)
        await f.waitForFunction((h) => location.hash.split("?")[0] === h, "#" + path);
        await settled(f, { hash: await hashOf(f) });
        assert.equal(await title(f), name);
        // (the section's own List | Board tabs may show; the old Sales switch must not)
        assert.equal(await f.$eval("#subnav", (el) => !el.hidden && /Quotes/.test(el.textContent)), false, "no Pipeline · Leads · Calls · Quotes · Tasks switch");
        assert.equal(await backShown(f), false, `${path}, from the Menu, is top-level: no back button`);
        assert.equal(await f.getAttribute('#tabs [data-tab="menu"]', "aria-current"), "page", "the Menu is lit on what it opens");
        assert.ok(await f.$("#fab"), "the create button");
        assert.deepEqual(await screenProblems(f), []);
        await shot(page, `home-menu-${path.slice(1)}-${device}`);
      }
      // the Menu: Flyra's cards, every section of Rotor's menu in them, Settings last
      await openDrawer(f);
      assert.deepEqual(await drawerLabels(f), ["Home", "Schedule", "Inbox", "Customers", "Leads", "Jobs", "Quotes", "Invoices", "Plans", "Pipelines", "Power Dialer", "Requests", "Tasks", "Payments", "Payouts", "Payroll", "Expenses", "Leaderboard", "Map", "Reports", "Automations", "Campaigns", "Reviews", "Templates", "QR codes", "Tab bar", "Settings"]);
      assert.ok(await f.$('.fm-sheet a[href="#/settings"]'), "Settings");
      assert.deepEqual(await screenProblems(f), []);
      await shot(page, `home-menu-${device}`);
      await drawerGo(f, "/plans", { open: false });
      await settled(f, { hash: "#/plans" });
      assert.equal(await f.getAttribute('#tabs [data-tab="menu"]', "aria-current"), "page", "Plans is the Menu's (a tile; Service's tab)");
      assert.equal(await f.getAttribute('#subnav [data-seg="sec"][data-key="plans"]', "aria-selected"), "true", "Service's tabs, Plans on");
      // someone who pinned Sales on their own bar (before K0; Customize Tabs no longer offers it) keeps its switch
      await goTo(f, "/tab-bar");
      assert.equal(await f.$('[data-ctb-in="sales"]'), null, "Sales is no longer offered");
      const cookie = (await p.ctx.cookies()).map((c) => `${c.name}=${c.value}`).join("; ");
      const me = await (await fetch(srv.url + "/api/crm/me", { headers: { cookie, "x-crm": "1" } })).json();
      const put = await fetch(srv.url + `/api/crm/users/${me.data.user.id}`, { method: "PATCH", headers: { cookie, "x-crm": "1", "content-type": "application/json", "if-match": me.data.etag }, body: JSON.stringify({ tabs: ["home", "schedule", "inbox", "sales"] }) });
      assert.equal(put.status, 200);
      // (as the app does after Customize Tabs saves: this shell's bar again, from what the server keeps)
      const nav = await (await fetch(srv.url + "/api/crm/me", { headers: { cookie, "x-crm": "1" } })).json();
      assert.deepEqual(nav.data.nav, ["home", "schedule", "inbox", "sales", "menu"], "kept on the server");
      await f.evaluate(async (tabs) => (await import("/crm-app/core/nav.js")).setTabs(tabs), nav.data.nav);
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


test("on a desk: the sidebar, search and New; Flyra's dashboard at 1440 (the money and Today on the left, the clock and Tasks on the right, Goals across), one column at 1024", async () => {
  await day();
  for (const device of ["desk1440", "desk1024"]) {
    const { p, page, f } = await home("olive", { device, office: true });
    try {
      assert.equal(await title(f), "Home");
      assert.equal(await f.$eval("#tabs", (el) => getComputedStyle(el).display), "none", "no bottom bar on a desk");
      assert.ok(await f.isVisible("#side"), "the sidebar");
      // the sections in the Menu's order (its cards), then Settings (Nov 15 2026)
      assert.deepEqual(await f.$$eval("#side .side-main", (els) => els.map((g) => [...g.querySelectorAll(":scope > .side-item .sl, :scope > .side-grp > .side-h .sl")].map((e) => e.textContent))), [["Home", "Schedule", "Inbox", "Customers", "Leads"], ["Service", "Financials"], ["Pipelines", "Power Dialer", "Tasks"], ["Map", "Analytics", "Marketing"]]);
      assert.deepEqual(await f.$$eval("#side .side-foot .sl", (els) => els.map((e) => e.textContent)), ["Settings"]);
      assert.equal(await f.getAttribute('#side [data-path="/today"]', "aria-current"), "page", "Home lit");
      assert.ok(await f.isVisible("#top-q") && await f.isVisible("#top-new") && await f.isVisible("#top-me"), "search, New, the person");
      assert.deepEqual((await cards(f)).slice(0, 3), ["money", "clock", "agenda"]);
      const [money, clock, agenda, tasks, goals, grid] = await Promise.all([".hm-money", ".hm-c-clock", ".hm-c-agenda", ".hm-c-tasks", ".hm-c-goals", ".hm-grid"].map((s) => box(f, s)));
      assert.ok(grid.w <= 1160, `Home's width ${grid.w}`);
      // the money is a card on a desk, the period as chips
      assert.equal(await f.$eval(".hm-money", (e) => getComputedStyle(e).borderTopStyle), "solid");
      assert.equal(await f.isVisible('[data-hm="m-ranges"]'), false);
      assert.deepEqual(await f.$$eval('[data-hm="m-range"]', (els) => els.map((e) => e.textContent)), ["1W", "1M", "3M", "1Y", "YTD"]);
      if (device === "desk1440") {
        assert.ok(money.w > clock.w && clock.x >= money.x + money.w, "the money on the left, wider; the clock on the right");
        assert.equal(money.y, clock.y, "side by side at the top");
        assert.ok(agenda.x === money.x && agenda.y >= money.y + money.h, "Today under the money");
        assert.ok(tasks.x === clock.x && tasks.y >= clock.y + clock.h, "Tasks under the clock on the right");
        assert.ok(goals.w === grid.w && goals.y >= agenda.y + agenda.h, "Goals across, at the bottom");
        assert.equal(await period(f, "3m"), "Revenue, September – November");
        assert.equal(await f.getAttribute('[data-hm="m-range"][data-v="3m"]', "aria-pressed"), "true");
        await period(f, "1m");
        // ARR by month on a desk: its own chips (Next year first), a bar and a name a month, a month picked
        await view(f, "arr");
        assert.deepEqual(await f.$$eval('[data-hm="m-range"]', (els) => els.map((e) => e.textContent)), ["Next year", "Past 6M", "Past year", "YTD", "All"]);
        assert.equal(await f.getAttribute('[data-hm="m-range"][data-v="next12"]', "aria-pressed"), "true");
        assert.equal(await f.$$eval('[data-chart="arr"] .hb-bar', (x) => x.length), 12);
        assert.deepEqual(await f.$$eval('[data-chart="arr"] .hb-m', (els) => els.map((e) => e.textContent)), ["Nov", "Dec", "Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct"]);
        assert.match(await tc(f, ".hm-stats"), /^In 12 months \$[\d,]+ Change [+−]?\$[\d,]+/);
        await f.hover('[data-chart="arr"] .hb-bar[data-i="6"]');
        assert.match(await tc(f, ".hm-mread"), /^May 2027 Projected MRR \$[\d,]+ ARR \$[\d,]+ Renewing \d+ plans? Ending \d+ plans?( Starting \d+ plans?)?$/, "a mouse picks as it moves");
        assert.deepEqual(await blues(f), [], "no blue on Home (desk)");
        await shot(page, "home-desk-arr-ahead");
        assert.equal(await period(f, "1y"), "ARR, Dec 2025 – Nov 2026");
        assert.deepEqual(await f.$$eval('[data-chart="arr"] .hb-m', (els) => els.map((e) => e.textContent)), ["Dec", "Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov"]);
        const [ac, rd] = await Promise.all([box(f, '[data-chart="arr"]'), box(f, ".hm-mread")]);
        assert.ok(ac.x >= money.x && ac.x + ac.w <= money.x + money.w && rd.y >= ac.y + ac.h, "the bars in the card, the readout under them");
        await f.hover('[data-chart="arr"] .hb-bar[data-i="9"]');
        assert.match(await tc(f, ".hm-mread"), /^Sep 2026 MRR \$[\d,]+ ARR \$[\d,]+ Added \d+ plans? Lost \d+ plans?$/, "a mouse picks as it moves");
        assert.ok(await f.$$eval('[data-chart="arr"] .hb-v', (els) => els.length === 12 && els.every((e) => e.textContent.startsWith("$"))), "every month's MRR, with the $");
        assert.deepEqual(await screenProblems(f), [], "ARR on a desk");
        await shot(page, "home-desk-arr");
        assert.equal(await period(f, "all"), "ARR, Oct 2025 – Nov 2026");
        await view(f, "revenue");
        assert.equal(await tc(f, ".hm-mper"), "Revenue, November");
      } else {
        assert.ok(clock.y >= money.y + money.h && agenda.y >= clock.y + clock.h, "one column");
      }
      const [chart, svg] = await Promise.all([box(f, '[data-chart="revenue"]'), box(f, '[data-chart="revenue"] svg')]);
      assert.ok(Math.abs(chart.w - svg.w) <= 2 && chart.x >= money.x && chart.x + chart.w <= money.x + money.w, `the chart: ${svg.w} in ${chart.w}`);
      await f.evaluate(() => { const t = document.getElementById("toasts"); if (t) t.style.visibility = "hidden"; });
      for (const theme of ["light", "dark"]) {
        await f.evaluate((t) => { document.documentElement.dataset.theme = t; }, theme);
        await page.waitForTimeout(150);
        await shot(page, `home-desk-${device}-${theme}`);
      }
      assert.deepEqual(await screenProblems(f), []);
      await shot(page, `home-desk-${device}`);
      await fullShot(page, f, `home-desk-${device}-full`);
      // New and the person's menu
      await f.click("#top-new");
      assert.deepEqual(await f.$$eval("#new-pop a span", (els) => els.map((e) => e.textContent)).then((x) => x.slice(0, 3)), ["Lead or customer", "Quote", "Job"], "the same list as the phone's +");
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
    const other = await f.$$eval("#ct-list a.rs-lr-main", (as) => as.map((a) => a.getAttribute("href")));
    assert.ok(other.length >= 4, `the list filters (${other.length})`);
    await f.click(`#ct-list a.rs-lr-main[href="${other[1]}"]`);
    await settled(f, { hash: other[1] });
    assert.equal(await f.inputValue("#ct-q"), "Workday", "the list kept its search");
    assert.equal(await f.getAttribute(`#ct-list a.rs-lr-main[href="${other[1]}"]`, "aria-current"), "true", "the open card is lit");
    assert.deepEqual(await screenProblems(f), []);
    await shot(page, "home-desk-contacts-split");
    // back to the list alone: it fills the page again (Polish 3: no empty pane), its search kept
    await goTo(f, "/contacts");
    await f.waitForFunction(() => document.getElementById("pane").hidden && !document.getElementById("app").classList.contains("split"));
    assert.equal(await f.inputValue("#ct-q"), "Workday", "the list kept its search");
    assert.deepEqual(await screenProblems(f), []);
    // Quotes too
    await goTo(f, `/quotes/${seeded.quotes.sent}`);
    assert.ok(await f.$('#view [data-tile="quotes"]'), "the quotes list (its tiles, Track 3) on the left");
    assert.ok(await f.$("#pane .qt-page"), "the quote beside it");
    assert.match(await title(f), /^Quote (SQ-|Q-)/, "the quote's number heads the screen");
    assert.equal(await f.isVisible("#top-title"), true);
    await shot(page, "home-desk-quotes-split");
    // narrower than 1000 px: one screen at a time again
    await page.setViewportSize({ width: 960, height: 800 });
    await f.waitForFunction(() => document.getElementById("pane").hidden && !document.getElementById("app").classList.contains("split"));
    assert.equal(await hashOf(f), `#/quotes/${seeded.quotes.sent}`);
    await settled(f);
    await f.waitForSelector("#view .qt-page", { timeout: 10000 }); // the quote fills the view
    assert.match(await title(f), /^Quote (SQ-|Q-)/);
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
