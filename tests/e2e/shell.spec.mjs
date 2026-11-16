// The shell (Nov 2026, the owner: "make it like Rotor"; K0 of the Rotor
// guide; then Nov 15, the Menu and the bar like Flyra's): the Menu (a sheet
// from the Menu tab and the round hamburger; Flyra's cards holding every
// section Rotor's menu has, a row on the tab used there last; Escape, a tap
// outside and a swipe down close it; the badges, the round buttons, the Tab
// bar row, Settings), a section's tabs under the title (links: back,
// deep links), its round "..." for the rare screens, the bell, Help's "Where
// do I go to...", the person's sheet (My time, My pay), Customize Tabs (from
// the person's initials and a long press on the bar: − and +, the arrow keys
// and a drag on the handle, Done saves, the standard bar back), and the
// kit's list patterns on #/kit (the tile row that filters, two-line rows and
// a long press, the board's stage strip, a swipe and the Move sheet, the
// filter and period sheets), at iPhone 13 and SE in both themes; the
// sections in the Menu's order as the desk's sidebar at 1440.
// `node --test tests/e2e/shell.spec.mjs`; E2E_SHOTS=<dir> saves screenshots.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { start } from "./server.mjs";
import { launch, phone, signIn, crmFrame, goTo, settled, title, screenProblems, shot, noInstallCard, frameOffset, swipe, openDrawer, drawerGo } from "./kit.mjs";

let srv, browser;
before(async () => { srv = await start(); await srv.seed(); browser = await launch(); });
after(async () => { await browser?.close(); await srv?.close(); });

async function open(login, device, theme = "light") {
  const p = await phone(browser, srv, { device, office: true });
  await signIn(p, login);
  await p.page.goto("/office");
  let f = await crmFrame(p.page);
  await settled(f);
  if (theme !== "light") {   // (light is the default: the owner, Nov 2026)
    await f.evaluate((t) => localStorage.setItem("crm-theme", t), theme);
    await p.page.reload();
    f = await crmFrame(p.page);
    await settled(f);
  }
  await noInstallCard(p.page);
  return { p, page: p.page, f };
}
const box = (f, sel) => f.$eval(sel, (el) => { const r = el.getBoundingClientRect(); return { x: r.x, y: r.y, w: r.width, h: r.height, right: r.right, bottom: r.bottom }; });
const gone = (f, sel) => f.waitForFunction((s) => !document.querySelector(s), sel, { timeout: 5000 });
const tabs = (f) => f.$$eval("#tabs [data-tab]", (els) => els.map((e) => e.dataset.tab).join());
// the Menu's own checks: 44 px targets (screenProblems looks at sheets too) and no name cut off
const menuProblems = (f) => f.evaluate(() => [
  ...[...document.querySelectorAll(".fm-sheet a, .fm-sheet button")].filter((el) => { const r = el.getBoundingClientRect(); return r.width && r.height && !el.classList.contains("sr") && (r.height < 43.5 || r.width < 43.5); }).map((el) => `${(el.textContent || el.getAttribute("aria-label") || "").trim().slice(0, 20)} ${Math.round(el.getBoundingClientRect().width)}x${Math.round(el.getBoundingClientRect().height)}`),
  ...[...document.querySelectorAll(".fm-sheet .fm-l, .fm-sheet .fm-tl")].filter((e) => e.scrollWidth > e.clientWidth + 1).map((e) => `cut off: ${e.textContent}`),
]);

const KEYS = ["home", "inbox", "schedule", "customers", "leads", "pipelines", "dialer", "service", "financials", "tasks", "map", "analytics", "marketing"];
const secTabs = (f) => f.$$eval('#subnav [data-seg="sec"]', (els) => els.map((e) => [e.dataset.key, e.getAttribute("aria-selected")]));
const sheetGone = (f) => f.waitForFunction(() => !document.querySelector(".sheet"), null, { timeout: 5000 });

for (const device of ["iphone13", "iphonese"]) {
  for (const theme of ["dark", "light"]) {
    test(`the Menu (${device}, ${theme}): Flyra's sheet, its cards holding everything Rotor's menu has, the badges, the round buttons; every way to close it`, async () => {
      const { p, page, f } = await open("olive", device, theme);
      try {
        assert.equal(await f.evaluate(() => document.documentElement.dataset.theme), theme);
        await openDrawer(f);
        const vw = await f.evaluate(() => innerWidth);
        const vh = await f.evaluate(() => innerHeight);
        const d = await box(f, ".fm-sheet");
        assert.ok(d.x === 0 && d.w === vw && Math.abs(d.bottom - vh) < 1 && d.h >= vh - 60, `up from the bottom, nearly the whole height (${JSON.stringify(d)})`);
        assert.ok(await f.isVisible(".fm-sheet .grab"), "the grabber");
        assert.deepEqual(await f.evaluate(() => [".fm-sheet", ".fm-sheet .fm-card"].map((s) => getComputedStyle(document.querySelector(s)).backgroundColor)),
          theme === "light" ? ["rgb(246, 246, 248)", "rgb(255, 255, 255)"] : ["rgb(17, 18, 20)", "rgb(27, 28, 31)"], "grey sheet, white cards in light; near black, dark cards in dark");
        assert.equal(await f.textContent(".fm-sheet .sheet-head h2"), "Menu");
        assert.equal(await f.$eval(".fm-sheet .sheet-head h2", (e) => parseFloat(getComputedStyle(e).fontSize)), 34, "the large title");
        assert.deepEqual(await f.$$eval(".fm-sheet .fm-acts .rnd", (els) => els.map((e) => e.getAttribute("aria-label"))), ["Help", theme === "light" ? "Switch to dark" : "Switch to light", "Olive Owner: account"], "Help, Light or dark, the person");
        assert.deepEqual(await f.$$eval(".fm-sheet .fm-grp", (els) => els.map((g) => [...g.querySelectorAll(".fm-l, .fm-tl")].map((e) => e.textContent))), [["Home", "Schedule", "Inbox", "Customers", "Leads"], ["Jobs", "Quotes", "Invoices", "Plans"], ["Pipelines", "Power Dialer", "Requests", "Tasks"], ["Payments", "Payouts", "Payroll", "Expenses"], ["Leaderboard", "Map", "Reports", "Automations"], ["Campaigns", "Reviews", "Templates", "QR codes"], ["Tab bar", "Settings"]]);
        assert.deepEqual(await f.$$eval(".fm-sheet .fm-cap", (els) => els.map((e) => e.textContent)), ["Sales", "Money", "Marketing"]);
        assert.deepEqual([...new Set(await f.$$eval(".fm-sheet [data-fm-sec]", (els) => els.map((e) => e.dataset.fmSec)))].sort(), [...KEYS].sort(), "every section of SECTIONS is in it");
        assert.equal(await f.getAttribute('.fm-sheet .fm-row[href="#/today"]', "aria-current"), "page", "Home is the current row");
        assert.match(await f.textContent('.fm-sheet a[href="#/inbox"]'), /Inbox\s*\d+/, "the Inbox count");
        assert.equal(await f.getAttribute('.fm-sheet [data-fm-sec="service"].fm-row', "href"), "#/requests", "Requests, a row of Sales");
        assert.equal(await f.$$eval(".fm-sheet .fm-tiles .fm-tile", (els) => els.map((e) => e.getAttribute("href")).join()), "#/jobs,#/quotes,#/invoices,#/plans");
        const tiles = await f.$$eval(".fm-sheet .fm-tile", (els) => els.map((e) => { const i = e.querySelector("svg").getBoundingClientRect(); const l = e.querySelector(".fm-tl").getBoundingClientRect(); return l.y >= i.bottom - 1 && l.width > 20; }));
        assert.deepEqual(tiles, [true, true, true, true], "an icon over each tile's name");
        assert.equal(await f.$$eval(".fm-sheet [data-fm-tabs] .fm-prev svg", (els) => els.length), 4, "the Tab bar row: a small picture of the bar");
        assert.equal(await f.$$eval(".fm-sheet .fm-row", (els) => els.every((e) => e.querySelector(".fm-chev svg"))), true, "a chevron on every row");
        assert.deepEqual(await menuProblems(f), [], "44 px rows, tiles and buttons; nothing cut off");
        assert.deepEqual(await screenProblems(f), []);
        await shot(page, `shell-menu-${device}-${theme}`);
        await f.evaluate(() => { document.querySelector(".fm-sheet .sheet-body").scrollTop = 9999; });
        await shot(page, `shell-menu-end-${device}-${theme}`);
        await f.evaluate(() => { document.querySelector(".fm-sheet .sheet-body").scrollTop = 0; });
        // Light or dark: one tap switches, in place
        await f.click(".fm-sheet [data-fm-theme]");
        const other = theme === "light" ? "dark" : "light";
        assert.equal(await f.evaluate(() => document.documentElement.dataset.theme), other);
        assert.equal(await f.evaluate(() => localStorage.getItem("crm-theme")), other, "kept on this phone");
        await f.click(".fm-sheet [data-fm-theme]");
        assert.equal(await f.evaluate(() => document.documentElement.dataset.theme), theme);
        // Escape
        await page.keyboard.press("Escape");
        await gone(f, ".fm-sheet");
        // a tap outside (above the sheet)
        await openDrawer(f);
        const o = await frameOffset(page, f);
        await page.mouse.click(o.x + vw / 2, o.y + 4);
        await gone(f, ".fm-sheet");
        // a swipe down from the grabber
        await openDrawer(f);
        const gb = await box(f, ".fm-sheet .grab");
        await swipe(page, { x: o.x + vw / 2, y: o.y + gb.y + 2 }, { x: o.x + vw / 2, y: o.y + gb.y + 260 });
        await gone(f, ".fm-sheet");
        // the round hamburger; Help
        await f.click("#top-bar [data-tb-menu]");
        await f.waitForSelector(".fm-sheet.on");
        await f.click(".fm-sheet [data-fm-help]");
        await f.waitForSelector(".sheet.on [data-where]");
        await gone(f, ".fm-sheet");   // (the Menu steps aside for Help)
        await page.keyboard.press("Escape");
        await sheetGone(f);
        // the person: their sheet
        await openDrawer(f);
        await f.click(".fm-sheet [data-fm-me]");
        await f.waitForSelector(".sheet.on [data-tabs-btn]");
        await page.keyboard.press("Escape");
        await sheetGone(f);
        // the Tab bar row: Customize Tabs
        await openDrawer(f);
        await f.click(".fm-sheet [data-fm-tabs]");
        await f.waitForSelector(".sheet.on [data-ctb-line]");
        await page.keyboard.press("Escape");
        await sheetGone(f);
        // Settings (top-level: no back button)
        await openDrawer(f);
        await f.click('.fm-sheet a[href="#/settings"]');
        await settled(f, { hash: "#/settings" });
        await gone(f, ".fm-sheet");
        assert.equal(await f.isVisible("#top-back"), false);
        assert.ok(await f.isVisible("#view [data-set-q]"), "Settings' search field");
        assert.deepEqual(await screenProblems(f), []);
        await p.clean();
      } finally { await p.close(); }
    });

    test(`a section (${device}, ${theme}): its tabs under the title, the tab used last, its round "...", a deeper screen and back; the bell; Where do I go to; the person's sheet`, async () => {
      const { p, page, f } = await open("olive", device, theme);
      try {
        // Home has its own bell: the top bar's steps aside there
        assert.equal(await f.isVisible("#top-bar [data-tb-bell]"), false, "Home's own bell only");
        // the Menu's Requests (a row of Sales), with Service's tabs under the title
        await openDrawer(f);
        await f.click('.fm-sheet a.fm-row[href="#/requests"]');
        await settled(f, { hash: "#/requests" });
        assert.equal(await title(f), "Requests");
        assert.deepEqual(await secTabs(f), [["requests", "true"], ["quotes", "false"], ["jobs", "false"], ["plans", "false"]], "Requests, once its screen is there");
        assert.equal(await f.$eval('#subnav [data-key="jobs"]', (a) => a.tagName + " " + a.getAttribute("href")), "A #/jobs", "each tab is a link");
        assert.equal(await f.isVisible("#top-back"), false, "top-level");
        assert.equal(await f.getAttribute('#tabs [data-tab="menu"]', "aria-current"), "page", "the Menu is lit");
        const tt = await box(f, "#top-title");
        const sg = await box(f, "#subnav .rs-seg");
        const vw = await f.evaluate(() => innerWidth);
        assert.ok(sg.y >= tt.bottom - 1 && sg.x >= 15 && sg.right <= vw - 15, "the tabs under the title, inside the screen");
        // the bell, on every top-level screen but Home
        assert.ok(await f.isVisible("#top-bar [data-tb-bell]"), "the bell");
        assert.equal(await f.isVisible("#tb-time"), device === "iphone13", "the clock steps aside under 390 px");
        assert.deepEqual(await screenProblems(f), []);
        // a tab: Plans
        await f.click('#subnav [data-key="plans"]');
        await settled(f, { hash: "#/plans" });
        assert.deepEqual(await secTabs(f), [["requests", "false"], ["quotes", "false"], ["jobs", "false"], ["plans", "true"]]);
        assert.equal(await f.isVisible("#top-back"), false, "a tab is top-level too");
        assert.deepEqual(await screenProblems(f), []);
        await shot(page, `shell-section-${device}-${theme}`);
        // the section's round "...": its rare screens (Light Studio: the owner's office tools)
        await f.click("#top-rnd [data-sec-more]");
        await f.waitForSelector(".sheet.on .rs-act");
        assert.match(await f.textContent(".sheet.on .sheet-head h2"), /Service/);
        assert.deepEqual(await f.$$eval(".sheet.on .rs-act-l", (els) => els.map((e) => e.textContent)), ["Light Studio"]);
        assert.deepEqual(await screenProblems(f), []);
        await f.click(".sheet.on [data-sheet-x]");
        await sheetGone(f);
        // the tab used last: a section's row opens there next time, after a reload too (Leads: its Board)
        await goTo(f, "/leads?view=board");
        await openDrawer(f);
        assert.equal(await f.getAttribute('.fm-sheet .fm-row[data-fm-sec="leads"]', "href"), "#/leads?view=board");
        assert.equal(await f.getAttribute('.fm-sheet .fm-row[data-fm-sec="leads"]', "aria-current"), "page", "Leads is the current row");
        await page.keyboard.press("Escape");
        await gone(f, ".fm-sheet");
        await goTo(f, "/today");
        await page.reload();
        const g = await crmFrame(page);
        await settled(g);
        await openDrawer(g);
        assert.equal(await g.getAttribute('.fm-sheet .fm-row[data-fm-sec="leads"]', "href"), "#/leads?view=board", "kept on this phone");
        // Financials' "...": Timesheets sits deeper (a back button, the plain title), and back is Financials
        await drawerGo(g, "/timesheets", { open: false });
        await settled(g, { hash: "#/timesheets" });
        assert.equal(await g.isVisible("#top-back"), true, "a \"...\" screen has a back button");
        assert.equal(await g.$eval("#subnav", (el) => el.hidden), true, "no tabs on it");
        assert.equal(await g.getAttribute('#tabs [data-tab="menu"]', "aria-current"), "page", "still the Menu's");
        await g.click("#top-back");
        await settled(g, { hash: "#/invoices" });
        assert.deepEqual((await secTabs(g)).map(([k]) => k), ["invoices", "payments", "payouts", "payroll", "expenses"]);
        // Help: Where do I go to...
        await g.click("#top-bar [data-tb-help]");
        await g.waitForSelector(".sheet.on [data-where]");
        await g.click(".sheet.on [data-where]");
        await g.waitForFunction(() => document.querySelectorAll(".sheet.on .rs-where li").length === 17);
        assert.match(await g.textContent(".sheet.on .rs-where"), /Run payroll\s*Menu › Money › Payroll/);
        assert.deepEqual(await screenProblems(g), []);
        await shot(page, `shell-where-${device}-${theme}`);
        await g.click(".sheet.on [data-sheet-x]");
        await sheetGone(g);
        // the bell opens the notifications
        await g.click("#top-bar [data-tb-bell]");
        await settled(g, { hash: "#/notifications" });
        await goTo(g, "/invoices");
        // the person's sheet: My time and My pay sit here now
        await g.click("#top-bar [data-tb-me]");
        await g.waitForSelector(".sheet.on [data-tabs-btn]");
        const rows = await g.$$eval(".sheet.on .rs-act-l", (els) => els.map((e) => e.textContent));
        assert.deepEqual([rows[0], ...rows.slice(-3)], ["My account", "Light or dark", "Customize Tabs", "Sign out of this phone"]);
        for (const r of rows.slice(1, -3)) assert.ok(["My time", "My pay", "My performance"].includes(r), r);
        await g.click(".sheet.on [data-sheet-x]");
        await sheetGone(g);
        await p.clean();
      } finally { await p.close(); }
    });

    test(`the kit's list patterns (${device}, ${theme}): the tile row filters, a long press on a row, the board's strip and a swipe, the Move sheet, the filter and period sheets`, async () => {
      const { p, page, f } = await open("olive", device, theme);
      try {
        await goTo(f, "/kit");
        const rowsShown = () => f.$$eval(".kit-page .rs-list:not([data-kit-drag]) .rs-lrow", (els) => els.length);
        await f.$eval(".kit-page .rs-tiles", (el) => el.scrollIntoView());
        assert.equal(await f.$$eval('.kit-page [data-tile="kit"]', (els) => els.length), 5, "five filter tiles, and ARR for information");
        assert.equal(await f.$eval(".kit-page .rs-tiles-in", (el) => el.scrollWidth > el.clientWidth), true, "the row scrolls sideways");
        assert.equal(await rowsShown(), 4);
        // the tile is the filter: a tap filters and outlines it; a second tap clears it
        await f.click('.kit-page [data-tile="kit"][data-key="overdue"]');
        await f.waitForFunction(() => document.querySelectorAll(".kit-page .rs-list:not([data-kit-drag]) .rs-lrow").length === 1);
        assert.equal(await f.getAttribute('.kit-page [data-tile="kit"][data-key="overdue"]', "aria-pressed"), "true");
        assert.equal(await f.$eval('.kit-page [data-tile="kit"][data-key="overdue"]', (el) => getComputedStyle(el).borderTopColor !== getComputedStyle(document.querySelector('.kit-page [data-tile="kit"][data-key="sent"]')).borderTopColor), true, "drawn outlined");
        assert.deepEqual(await screenProblems(f), []);
        await shot(page, `shell-kit-tiles-${device}-${theme}`);
        await f.click('.kit-page [data-tile="kit"][data-key="overdue"]');
        await f.waitForFunction(() => document.querySelectorAll(".kit-page .rs-list:not([data-kit-drag]) .rs-lrow").length === 4);
        assert.equal(await f.getAttribute('.kit-page [data-tile="kit"][data-key="all"]', "aria-pressed"), "true");
        // a two-line row: one round action; a long press opens its "..."
        assert.equal(await f.$$eval('.kit-page [data-kit-row="a"] .rnd', (els) => els.length), 1);
        const o = await frameOffset(page, f);
        await f.$eval('.kit-page [data-kit-row="b"]', (el) => el.scrollIntoView({ block: "center" }));
        const r2 = await box(f, '.kit-page [data-kit-row="b"] .rs-lr-t');
        await page.mouse.move(o.x + r2.x + 6, o.y + r2.y + 6);
        await page.mouse.down();
        await page.waitForTimeout(750);
        await page.mouse.up();
        await f.waitForSelector(".sheet.on .rs-act");
        assert.deepEqual(await f.$$eval(".sheet.on .rs-act-l", (els) => els.map((e) => e.textContent)), ["Text a reminder", "Open customer", "Void"]);
        await f.click(".sheet.on [data-sheet-x]");
        await sheetGone(f);
        // the board: a strip of stages with counts; columns about 86% wide; a tap on a stage goes to its column
        await f.$eval(".kit-page .rs-board", (el) => el.scrollIntoView());
        assert.deepEqual(await f.$$eval(".kit-page .rs-strip-b", (els) => els.map((e) => `${e.firstChild.textContent} ${e.querySelector(".n").textContent}`)), ["New 2", "Contacted 1", "Quoted 1", "Follow-Up 0", "Sold 0"]);
        const col = await box(f, '.kit-page .rs-col[data-col="new"]');
        const ww = await f.evaluate(() => innerWidth);
        assert.ok(col.w / ww > 0.8 && col.w / ww < 0.9, `a column is about 86% of the phone (${col.w} of ${ww})`);
        const colAt = () => f.$eval(".kit-page .rs-cols", (c) => { const l = c.getBoundingClientRect().left; return [...c.children].map((x) => [x.dataset.col, Math.round(x.getBoundingClientRect().left - l)]).filter(([, x]) => x >= 0 && x < 40).map(([k]) => k)[0]; });
        await f.click('.kit-page .rs-strip-b[data-key="quoted"]');
        await f.waitForFunction(() => { const c = document.querySelector(".kit-page .rs-cols"); const q = c.querySelector('[data-col="quoted"]'); return Math.abs(q.getBoundingClientRect().left - c.getBoundingClientRect().left - 16) < 3; });
        await f.waitForTimeout(150);
        assert.equal(await f.getAttribute('.kit-page .rs-strip-b[data-key="quoted"]', "aria-pressed"), "true");
        // a swipe to the right goes back a column, and the strip follows
        const cb = await box(f, ".kit-page .rs-cols");
        await swipe(page, { x: o.x + 60, y: o.y + cb.y + 60 }, { x: o.x + 240, y: o.y + cb.y + 62 }, 12);
        await f.waitForFunction(() => document.querySelector('.kit-page .rs-strip-b[aria-pressed="true"]').dataset.key === "contacted", null, { timeout: 5000 });
        const lefts = () => f.$eval(".kit-page .rs-cols", (c) => [...c.children].map((x) => Math.round(x.getBoundingClientRect().left - c.getBoundingClientRect().left)));
        await f.waitForFunction(() => { const c = document.querySelector(".kit-page .rs-cols"); const q = c.querySelector('[data-col="contacted"]'); return Math.abs(q.getBoundingClientRect().left - c.getBoundingClientRect().left - 16) < 3; }, null, { timeout: 5000 }).catch(async (e) => { throw new Error(`not snapped: ${JSON.stringify(await lefts())}`); });
        assert.equal(await colAt(), "contacted", "snapped to a column");
        assert.deepEqual(await screenProblems(f), []);
        await shot(page, `shell-kit-board-${device}-${theme}`);
        // the Move pill: the stage sheet, the current one ticked; a pick moves the card
        await f.click('.kit-page .rs-strip-b[data-key="new"]');
        await f.click('.kit-page [data-kit-move="l1"]');
        await f.waitForSelector(".sheet.on [data-move-to]");
        assert.deepEqual(await f.$$eval(".sheet.on [data-move-to]", (els) => els.map((e) => [e.querySelector(".rs-act-l").textContent, e.getAttribute("aria-checked")])), [["New", "true"], ["Contacted", "false"], ["Quoted", "false"], ["Follow-Up", "false"], ["Sold", "false"]]);
        assert.deepEqual(await screenProblems(f), []);
        await f.click('.sheet.on [data-move-to="2"]');
        await sheetGone(f);
        await f.waitForFunction(() => !!document.querySelector('.kit-page .rs-col[data-col="quoted"] [data-kit-move="l1"]'));
        assert.equal(await f.textContent('.kit-page .rs-strip-b[data-key="quoted"] .n'), "2");
        // the filter sheet: chips, a switch, a period, a sort; Show N follows; Reset
        await f.click(".kit-page [data-kit-filter]");
        await f.waitForSelector(".sheet.on [data-f-show]");
        assert.match(await f.textContent(".sheet.on [data-f-show]"), /^Show 4$/);
        await f.click('.sheet.on [data-f-group="status"][data-f-val="overdue"]');
        assert.match(await f.textContent(".sheet.on [data-f-show]"), /^Show 1$/);
        assert.equal(await f.getAttribute('.sheet.on [data-f-group="status"][data-f-val="overdue"]', "aria-pressed"), "true");
        await f.click('.sheet.on [data-f-toggle="plan"]');
        assert.equal(await f.getAttribute('.sheet.on [data-f-toggle="plan"]', "aria-checked"), "true");
        assert.equal(await f.getAttribute('.sheet.on [data-f-group="sort"][data-f-val="due"]', "aria-checked"), "true", "the sort's default");
        assert.deepEqual(await screenProblems(f), []);
        await shot(page, `shell-kit-filter-${device}-${theme}`);
        await f.click(".sheet.on [data-f-reset]");
        assert.match(await f.textContent(".sheet.on [data-f-show]"), /^Show 4$/);
        await f.click(".sheet.on [data-f-show]");
        await sheetGone(f);
        // the period chip: Last month
        await f.click('.kit-page [data-period="kit"]');
        await f.waitForSelector(".sheet.on [data-period-pick]");
        assert.deepEqual(await f.$$eval(".sheet.on [data-period-pick] .rs-act-l", (els) => els.map((e) => e.textContent)), ["This week", "This month", "Last month", "Last 3 months", "This year", "Custom"]);
        await f.click('.sheet.on [data-period-pick="custom"]');
        await f.waitForSelector(".sheet.on [data-period-days] input[name=from]");
        assert.deepEqual(await screenProblems(f), [], "the days are 16 px inputs in 44 px rows");
        await f.click('.sheet.on [data-period-pick="last_month"]');
        await sheetGone(f);
        await f.waitForFunction(() => document.querySelector('.kit-page [data-period="kit"]').textContent.includes("Last month"));
        await p.clean();
      } finally { await p.close(); }
    });
  }

  test(`Customize Tabs (${device}): − and +, the arrow keys, a drag, Done saves; a long press opens it; the standard bar back`, async () => {
    const { p, page, f } = await open("olive", device);
    try {
      await f.click("#top-bar [data-tb-me]");
      await f.click(".sheet.on [data-tabs-btn]");
      await f.waitForSelector(".sheet.on .ctb-list");
      assert.match(await f.textContent(".sheet.on .sheet-head h2"), /Customize Tabs/);
      assert.match(await f.textContent(".sheet.on [data-ctb-line]"), /More menu/i);
      assert.deepEqual(await f.$$eval(".sheet.on [data-ctb-out]", (els) => els.map((e) => e.dataset.ctbOut)), ["home", "schedule", "inbox", "map"]);
      assert.deepEqual(await screenProblems(f), [], "the sheet page passes the phone checks");
      assert.equal(await f.$('.sheet.on [data-ctb-in="sales"]'), null, "Sales is no longer offered (the sections do that job)");
      await shot(page, `shell-tabs-${device}`);
      // + Quotes (the fifth), then a sixth is refused
      await f.click('.sheet.on [data-ctb-in="quotes"]');
      assert.deepEqual(await f.$$eval(".sheet.on [data-ctb-out]", (els) => els.map((e) => e.dataset.ctbOut)), ["home", "schedule", "inbox", "map", "quotes"]);
      assert.equal(await f.$eval('.sheet.on [data-ctb-in="leads"]', (b) => b.disabled), true, "five is the most");
      // the arrow keys on the handle: Quotes up one (above Map)
      await f.focus('.sheet.on [data-ctb-drag="quotes"]');
      await page.keyboard.press("ArrowUp");
      assert.deepEqual(await f.$$eval(".sheet.on [data-ctb-out]", (els) => els.map((e) => e.dataset.ctbOut)), ["home", "schedule", "inbox", "quotes", "map"]);
      assert.equal(await f.evaluate(() => document.activeElement && document.activeElement.dataset.ctbDrag), "quotes", "the handle keeps the focus");
      // a drag on the handle: Map down below the line (off the bar)
      const o = await frameOffset(page, f);
      const h = await box(f, '.sheet.on [data-ctb-drag="map"]');
      const line = await box(f, ".sheet.on [data-ctb-line]");
      await page.mouse.move(o.x + h.x + h.w / 2, o.y + h.y + h.h / 2);
      await page.mouse.down();
      for (let i = 1; i <= 8; i++) await page.mouse.move(o.x + h.x + h.w / 2, o.y + h.y + h.h / 2 + ((line.bottom + 40 - h.y) * i) / 8);
      await page.mouse.up();
      await f.waitForFunction(() => [...document.querySelectorAll(".sheet.on [data-ctb-out]")].map((e) => e.dataset.ctbOut).join() === "home,schedule,inbox,quotes");
      // Done saves: the bar is the new one, the Menu last
      await f.click(".sheet.on [data-save]");
      await f.waitForFunction(() => [...document.querySelectorAll("#tabs [data-tab]")].map((e) => e.dataset.tab).join() === "home,schedule,inbox,quotes,menu", null, { timeout: 8000 });
      await gone(f, ".sheet");
      // a long press on the bar opens it again
      const b = await box(f, '#tabs [data-tab="schedule"]');
      await page.mouse.move(o.x + b.x + b.w / 2, o.y + b.y + b.h / 2);
      await page.mouse.down();
      await page.waitForTimeout(800);
      await page.mouse.up();
      await f.waitForSelector(".sheet.on .ctb-list");
      assert.match(await f.evaluate(() => location.hash), /^(#\/today)?$/, "the press didn't open the Schedule");
      await f.click(".sheet.on [data-standard]");
      await f.waitForFunction(() => [...document.querySelectorAll("#tabs [data-tab]")].map((e) => e.dataset.tab).join() === "home,schedule,inbox,map,menu", null, { timeout: 8000 });
      assert.equal(await tabs(f), "home,schedule,inbox,map,menu");
      await p.clean();
    } finally { await p.close(); }
  });
}

test("on a desk (1440): the sidebar is the sections in the Menu's order; a row opens the tab used last; the tabs over the screen; the section's \"...\" in the header; a board's columns", async () => {
  for (const theme of ["dark", "light"]) {
    const { p, page, f } = await open("olive", "desk1440", theme);
    try {
      assert.equal(await f.isVisible("#tabs"), false);
      assert.equal(await f.isVisible("#top-bar"), false, "the desk's own header: search, New, the person");
      assert.deepEqual(await f.$$eval("#side .side-main", (els) => els.map((g) => [...g.querySelectorAll(".sl")].map((e) => e.textContent))), [["Home", "Schedule", "Inbox", "Customers", "Leads"], ["Service", "Financials"], ["Pipelines", "Power Dialer", "Tasks"], ["Map", "Analytics", "Marketing"]], "the Menu's order");
      assert.equal(await f.$("#side .side-grp, #side .side-h"), null, "nothing to fold");
      await f.click('#side [data-sec="financials"]');
      await settled(f, { hash: "#/invoices" });
      assert.equal(await f.getAttribute('#side [data-sec="financials"]', "aria-current"), "page");
      assert.deepEqual(await secTabs(f), [["invoices", "true"], ["payments", "false"], ["payouts", "false"], ["payroll", "false"], ["expenses", "false"]]);
      await f.click('#subnav [data-key="payroll"]');
      await settled(f, { hash: "#/payroll" });
      assert.equal(await f.getAttribute('#side [data-sec="financials"]', "href"), "#/payroll", "the row follows the tab used last");
      // the section's "..." in the desk's header
      assert.ok(await f.isVisible("#top-rnd [data-sec-more]"));
      assert.equal(await f.isVisible("#top-rnd .rnd-own"), false, "the phone's round buttons stay the phone's");
      await f.click("#top-rnd [data-sec-more]");
      await f.waitForSelector(".sheet.on .rs-act");
      assert.deepEqual(await f.$$eval(".sheet.on .rs-act-l", (els) => els.map((e) => e.textContent)), ["Autopay run", "Timesheets"], "Purchases left for the Expenses screen's \"...\" (Track 3)");
      await f.click('.sheet.on a[href="#/autopay"]');
      await settled(f, { hash: "#/autopay" });
      assert.equal(await f.isVisible("#top-back"), true, "a \"...\" screen has a back button");
      assert.equal(await f.getAttribute('#side [data-sec="financials"]', "aria-current"), "page", "a \"...\" screen lights its section");
      await goTo(f, "/jobs");
      assert.equal(await f.getAttribute('#side [data-sec="service"]', "aria-current"), "page", "Jobs is Service's");
      assert.ok(await f.isVisible('#side .side-foot a[href="#/settings"]'));
      assert.deepEqual(await screenProblems(f), []);
      await shot(page, `shell-desk1440-${theme}`);
      // a board on a desk: columns of their own width, side by side
      await goTo(f, "/kit");
      await f.$eval(".kit-page .rs-board", (el) => el.scrollIntoView());
      const w = await f.$$eval(".kit-page .rs-col", (els) => els.map((e) => Math.round(e.getBoundingClientRect().width)));
      assert.ok(w.every((x) => x === 300), `300 px columns (${w})`);
      await f.click('.kit-page [data-tile="kit"][data-key="paid"]');
      await f.waitForFunction(() => document.querySelectorAll(".kit-page .rs-list:not([data-kit-drag]) .rs-lrow").length === 1);
      await f.click('.kit-page [data-kit-move="l2"]');
      await f.click('.sheet.on [data-move-to="4"]');
      await f.waitForFunction(() => !!document.querySelector('.kit-page .rs-col[data-col="sold"] [data-kit-move="l2"]'));
      // a right click is the long press on a desk
      await f.click('.kit-page [data-tile="kit"][data-key="paid"]');
      await f.click('.kit-page [data-kit-row="c"] .rs-lr-t', { button: "right" });
      await f.waitForSelector(".sheet.on .rs-act");
      await f.click(".sheet.on [data-sheet-x]");
      await sheetGone(f);
      assert.deepEqual(await screenProblems(f), []);
      await shot(page, `shell-desk1440-kit-${theme}`);
      await p.clean();
    } finally { await p.close(); }
  }
});

// Polish 3 (the owner, Nov 14: "cleaner, more user friendly and like a professional CRM", Flyra's
// desk): the 64 px icon rail with tooltips and a toggle that shows the labels (remembered on this
// device), the top bar (the company, the search in the middle, Create, the bell, help, the person),
// the page's own plain title, a list alone filling the page, the kit's table with column headers.
for (const device of ["desk1440", "desk1024"]) {
  test(`on a desk (${device}), Flyra's frame: the icon rail and its tooltips and labels, the top bar, the page's title, a list fills the page, the table`, async () => {
    for (const theme of ["light", "dark"]) {
      const { p, page, f } = await open("olive", device, theme);
      try {
        const vw = await f.evaluate(() => innerWidth);
        const rail = await box(f, "#side");
        assert.equal(Math.round(rail.w), 64, "a 64 px rail");
        assert.ok((await box(f, '#side [data-sec="customers"] .sl')).w <= 1, "icons only (the label kept for screen readers)");
        // a tooltip on hover: the row's label beside it
        await f.hover('#side [data-sec="customers"]');
        await f.waitForSelector("#side-tip:not([hidden])");
        assert.equal(await f.textContent("#side-tip"), "Customers");
        const tip = await box(f, "#side-tip");
        assert.ok(tip.x >= rail.right, "beside the rail");
        // the toggle shows the labels, and this device remembers
        await f.click("#side [data-side-pin]");
        assert.equal(Math.round((await box(f, "#side")).w), 224);
        assert.ok((await box(f, '#side [data-sec="customers"] .sl')).w > 40, "the labels out");
        assert.equal(await f.getAttribute("#side [data-side-pin]", "aria-pressed"), "true");
        await f.hover('#side [data-sec="leads"]');
        assert.equal(await f.$eval("#side-tip", (el) => el.hidden), true, "no tooltip with the labels out");
        await page.reload();
        const g = await crmFrame(page);
        await settled(g);
        assert.equal(Math.round((await box(g, "#side")).w), 224, "remembered");
        await g.click("#side [data-side-pin]");
        assert.equal(Math.round((await box(g, "#side")).w), 64);
        // the top bar: the company, the search in the middle, Create, the bell, help, the person
        const bar = await box(g, "#deskbar");
        assert.ok(Math.abs(bar.x - 64) < 1 && Math.abs(bar.right - vw) < 1 && bar.h >= 56 && bar.h < 60, `across the page (${JSON.stringify(bar)})`);
        assert.match(await g.textContent("#deskbar .db-co"), /Barta Window Washing/);
        const q = await box(g, "#top-search");
        assert.ok(Math.abs(q.x + q.w / 2 - (64 + (vw - 64) / 2)) < 120 && q.w >= 300, `the search near the middle (${q.x}, ${q.w})`);
        assert.equal((await g.textContent("#top-new")).trim(), "Create");
        for (const sel of ["#deskbar [data-db-bell]", "#deskbar [data-db-help]", "#top-me"]) assert.ok(await g.isVisible(sel), sel);
        await g.click("#deskbar [data-db-help]");
        await g.waitForSelector(".sheet.on [data-where]");
        await page.keyboard.press("Escape");
        await g.waitForFunction(() => !document.querySelector(".sheet"));
        // the page's own header: the plain title in the page, the screen's one action
        await goTo(g, "/invoices");
        const t = await box(g, "#top-title");
        assert.ok(t.y > bar.bottom, "the title is the page's, under the top bar");
        assert.equal(await g.$eval("#top", (el) => getComputedStyle(el).backgroundColor), "rgba(0, 0, 0, 0)", "no header band");
        // a list alone fills the page: no empty pane beside it
        assert.equal(await g.$eval("#pane", (el) => el.hidden), true);
        assert.equal(await g.$eval("#app", (el) => el.classList.contains("split")), false);
        assert.ok((await box(g, "#view")).w > vw - 64 - 2, "the list is the page");
        // section tabs: underline tabs, no grey track
        assert.equal(await g.$eval("#subnav .rs-seg", (el) => getComputedStyle(el).backgroundColor), "rgba(0, 0, 0, 0)");
        assert.deepEqual(await screenProblems(g), []);
        await shot(page, `shell-flyra-${device}-${theme}-invoices`);
        // the kit's table: small grey caps headers over one row per line, the columns lined up
        await goTo(g, "/kit");
        await g.$eval(".kit-page .rs-table", (el) => el.scrollIntoView());
        assert.equal(await g.isVisible(".kit-page .rs-table .rs-thead"), true, "headers on a desk");
        assert.equal(await g.$eval(".kit-page .rs-table .rs-thead .rs-td", (el) => getComputedStyle(el).textTransform), "uppercase");
        const cells = await g.$$eval(".kit-page .rs-table .rs-tlist .rs-trow:first-child .rs-td", (els) => els.map((e) => Math.round(e.getBoundingClientRect().top)));
        assert.ok(Math.max(...cells) - Math.min(...cells) <= 12, `one line (${cells})`);
        const lefts = (sel) => g.$eval(".kit-page .rs-table", (t, s) => [...t.querySelectorAll(s)].map((e) => Math.round(e.getBoundingClientRect().left)), sel);
        const heads = await lefts(".rs-thead .rs-td");
        const firsts = await lefts(".rs-tlist .rs-trow:first-child .rs-td");
        assert.deepEqual(firsts, heads, "each cell under its header");
        assert.deepEqual(await screenProblems(g), []);
        await shot(page, `shell-flyra-${device}-${theme}-table`);
        await p.clean();
      } finally { await p.close(); }
    }
  });
}

test("the kit's table on a phone (iphone13): two-line rows, no headers, the empty state, loading rows", async () => {
  const { p, page, f } = await open("olive", "iphone13", "light");
  try {
    await goTo(f, "/kit");
    await f.$eval(".kit-page .rs-table", (el) => el.scrollIntoView());
    assert.equal(await f.isVisible(".kit-page .rs-table .rs-thead"), false, "no headers on a phone");
    const row = ".kit-page .rs-table .rs-tlist .rs-trow:first-child";
    const [tt, amt, st] = await Promise.all([".c-title", ".c-money", ".c-status"].map((c) => box(f, `${row} ${c}`)));
    assert.ok(Math.abs(tt.y - amt.y) < 6 && st.y > tt.y + 10 && amt.right > st.x, "line 1: the name and the $; line 2: the pill on the right");
    assert.ok((await box(f, `${row} .rs-tmain`)).h >= 44);
    assert.ok(await f.isVisible('.kit-page .rs-table .rs-emptystate .rs-pb.solid'), "the empty state's one dark pill");
    await f.click(".kit-page [data-kit-tload]");
    await f.waitForSelector('.kit-page .rs-table.rs-skel[aria-busy="true"] .rs-skrow');
    await f.click(".kit-page [data-kit-tload]");
    await f.waitForFunction(() => !document.querySelector(".kit-page [aria-busy=true]"));
    assert.deepEqual(await screenProblems(f), []);
    await shot(page, "shell-kit-table-iphone13-light");
    await p.clean();
  } finally { await p.close(); }
});

// Nov 2026, the owner: "Lead and then Customer, two separate buttons", "a little more premium
// animations", "make it white, not black". The + has Lead and Customer, each opening the one form as
// itself; with motion on (a phone not set to Reduce Motion) sheets spring up and settle exactly where
// they rest, the + pills rise in, a screen slides in (and the one left slides away going back), the
// segmented pill slides, toasts slide down as they go; set to Reduce Motion nothing moves at all. A
// phone that had picked Dark is moved to Light once, then keeps its own choice.
const still = (f) => f.waitForFunction(() => document.getAnimations().every((a) => a.playState !== "running" || a.effect.getComputedTiming().iterations === Infinity), null, { timeout: 5000 });
const moving = (f) => f.evaluate(() => document.getAnimations().filter((a) => a.playState === "running" && a.effect.getComputedTiming().iterations !== Infinity).length);
async function openMoving(device, { motion = true } = {}) {
  const p = await phone(browser, srv, { device, office: true, motion });
  await signIn(p, "olive");
  await p.page.goto("/office");
  const f = await crmFrame(p.page);
  await settled(f);
  await noInstallCard(p.page);
  const x = await f.$("[data-moved-x]");
  if (x) await x.click();
  return { p, page: p.page, f };
}

for (const device of ["iphone13", "iphonese"]) {
  test(`the + (${device}): Lead and then Customer, two buttons, each its own form; with motion the pills rise in and rest in place`, async () => {
    const { p, page, f } = await openMoving(device);
    try {
      assert.equal(await f.evaluate(() => document.documentElement.dataset.theme), "light", "white by default");
      for (const [i, want] of [[0, { label: "Lead", hash: "#/contacts/new", title: "New lead", lc: "lead", save: "Save lead" }], [1, { label: "Customer", hash: "#/contacts/new?as=customer", title: "New customer", lc: "customer", save: "Save customer" }]]) {
        await goTo(f, "/today");
        await f.click("#fab");
        await f.waitForSelector(".qk.on");
        assert.ok((await moving(f)) > 0, "the pills are rising");
        await still(f);
        const pills = await f.$$eval(".qk-pill", (els) => els.map((e) => ({ t: e.querySelector("span:last-child").textContent, href: e.getAttribute("href"), ic: e.querySelector(".qk-ic svg") ? 1 : 0, op: getComputedStyle(e).opacity, tf: getComputedStyle(e).transform })));
        assert.deepEqual(pills.slice(0, 3).map((x) => x.t), ["Lead", "Customer", "Quote"], "Lead, then Customer, at the top");
        assert.ok(pills.every((x) => x.ic && x.op === "1" && x.tf === "none"), "each with its icon, every pill at rest");
        assert.deepEqual(await screenProblems(f), [], "the + passes the phone checks (44 px, nothing cut off)");
        if (i === 0) await shot(page, `shell-plus-${device}`);
        await f.click(`.qk-list li:nth-child(${i + 1}) .qk-pill`);
        await settled(f, { hash: want.hash });
        await still(f);
        assert.equal(await title(f), want.title);
        assert.equal(await f.$eval("#ct-form [name=lifecycle]", (e) => e.value), want.lc);
        assert.equal((await f.textContent("#ct-form button[type=submit]")).trim(), want.save);
      }
      // "This is" turns the form into the other, keeping what was typed
      await f.fill("#ct-form [name=first_name]", "Synthetic");
      await f.selectOption("#ct-form [name=lifecycle]", "lead");
      await f.waitForFunction(() => document.getElementById("top-title").textContent === "New lead");
      assert.equal(await f.$eval("#ct-form [name=first_name]", (e) => e.value), "Synthetic");
      assert.ok(await f.$("#ct-form [name=priority]"), "a lead's priority shows");
      await p.clean();
    } finally { await p.close(); }
  });
}

test("motion (iphone13): screens slide in and away, the Menu springs up and rests at the bottom, the segmented pill slides, a toast slides down as it goes; a refresh moves nothing", async () => {
  const { p, page, f } = await openMoving("iphone13");
  try {
    const vh = await f.evaluate(() => innerHeight);
    // the Menu: a spring up, then exactly where it rests
    await f.click('#tabs [data-tab="menu"]');
    await f.waitForSelector(".fm-sheet.on");
    assert.ok(await f.evaluate(() => document.querySelector(".fm-sheet").getAnimations().some((a) => a.transitionProperty === "transform")), "the sheet springs up");
    await still(f);
    const d = await box(f, ".fm-sheet");
    assert.ok(Math.abs(d.bottom - vh) < 1, `resting on the bottom (${d.bottom} vs ${vh})`);
    assert.equal(await f.$eval(".backdrop.on", (e) => getComputedStyle(e).opacity), "1", "the backdrop dimmed");
    await page.keyboard.press("Escape");
    await gone(f, ".fm-sheet");
    // a screen slides in from the right, and rests where it was drawn
    await goTo(f, "/contacts");
    await still(f);
    const href = await f.$eval("#view a[href^='#/contacts/ct_']", (a) => a.getAttribute("href"));
    await f.click(`#view a[href="${href}"]`);
    await f.waitForFunction((h) => location.hash === h, href);
    assert.ok((await moving(f)) > 0, "the next screen is moving in");
    await settled(f);
    await still(f);
    assert.deepEqual(await f.$$eval("#view > *", (els) => els.map((e) => getComputedStyle(e).transform).filter((t) => t !== "none")), [], "nothing left moved");
    assert.deepEqual(await screenProblems(f), []);
    // the segmented pill slides to the tapped tab
    const seg = await f.$("#view .rs-seg-b[aria-selected=false]");
    if (seg) {
      await seg.click();
      await f.waitForSelector("#view .rs-seg-b.seg-slide[aria-selected=true]", { timeout: 2000 });
      await still(f);
    }
    // a refresh (a poll, a save): nothing moves
    await f.evaluate(() => import("/crm-app/core/router.js").then((r) => r.refresh()));
    await f.waitForTimeout(60);
    assert.equal(await f.evaluate(() => document.querySelectorAll("#view *").length && [...document.querySelectorAll("#view *")].some((e) => e.getAnimations().some((a) => a.effect.getComputedTiming().iterations !== Infinity))), false, "a refresh never animates");
    // back: the screen left slides away over the list, then is gone
    await f.click("#top-back");
    await f.waitForSelector(".mo-ghost", { state: "attached", timeout: 2000 });
    assert.equal(await f.$eval(".mo-ghost", (g) => [g.getAttribute("aria-hidden"), g.querySelectorAll("[id]").length, g.inert].join()), "true,0,true", "the ghost is out of reach: no ids, inert");
    await settled(f, { hash: "#/contacts" });
    await gone(f, ".mo-ghost");
    // a toast rises, then slides down and fades as it goes
    await f.evaluate(() => import("/crm-app/core/ui.js").then((m) => m.toast("Synthetic note saved", { ms: 400 })));
    await f.waitForSelector(".toast.out", { timeout: 2000 });
    await gone(f, ".toast");
    await p.clean();
  } finally { await p.close(); }
});

test("Reduce Motion (iphonese): nothing moves, nothing is left behind; and a Dark from before is moved to Light once, then kept", async () => {
  const { p, page, f } = await openMoving("iphonese", { motion: false });
  try {
    await f.click("#fab");
    await f.waitForSelector(".qk.on");
    assert.equal(await moving(f), 0, "the + just shows");
    assert.equal(await f.$eval(".qk-pill", (e) => getComputedStyle(e).opacity), "1");
    await page.keyboard.press("Escape");
    await goTo(f, "/contacts");
    const href = await f.$eval("#view a[href^='#/contacts/ct_']", (a) => a.getAttribute("href"));
    await f.click(`#view a[href="${href}"]`);
    await f.waitForFunction((h) => location.hash === h, href);
    assert.equal(await moving(f), 0, "a screen just shows");
    await settled(f);
    await f.click("#top-back");
    await settled(f, { hash: "#/contacts" });
    assert.equal(await f.$(".mo-ghost"), null, "no ghost");
    await f.click('#tabs [data-tab="menu"]');
    await f.waitForSelector(".fm-sheet.on");
    assert.equal(await moving(f), 0, "a sheet just shows");
    await page.keyboard.press("Escape");
    // a phone that picked Dark before Light became the default (no "crm-theme-white" yet)
    await f.evaluate(() => { sessionStorage.setItem("e2e-unmoved", "1"); localStorage.removeItem("crm-theme-white"); localStorage.setItem("crm-theme", "dark"); });
    await page.reload();
    let g = await crmFrame(page);
    await settled(g);
    assert.equal(await g.evaluate(() => document.documentElement.dataset.theme), "light", "moved to Light");
    assert.deepEqual(await g.evaluate(() => [localStorage.getItem("crm-theme"), localStorage.getItem("crm-theme-white")]), ["light", "1"]);
    assert.equal(await g.evaluate(() => getComputedStyle(document.body).backgroundColor), "rgb(246, 246, 248)");
    // Dark again, by choice: kept from now on
    await g.evaluate(() => import("/crm-app/core/nav.js").then((n) => n.setTheme("dark")));
    await page.reload();
    g = await crmFrame(page);
    await settled(g);
    assert.equal(await g.evaluate(() => document.documentElement.dataset.theme), "dark", "its own choice, kept");
    assert.equal(await page.$eval('meta[name="theme-color"]', (m) => m.content), "#111214", "the office's status bar follows");
    await g.evaluate(() => { localStorage.setItem("crm-theme", "light"); sessionStorage.removeItem("e2e-unmoved"); });
    await p.clean();
  } finally { await p.close(); }
});
