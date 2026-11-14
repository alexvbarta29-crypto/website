// The Rotor shell (Nov 2026, the owner: "make it like Rotor"): the drawer
// (from the Menu tab and the round hamburger; four groups; a row with a dot
// opens its own list, "‹ Service" back; the X, a tap outside, a swipe to
// the left and Escape close it; the Inbox count; the gear), the top bar of a
// top-level screen (help, the person's sheet), and Customize Tabs (from the
// person's initials and a long press on the bar: − and +, the arrow keys
// and a drag on the handle, Done saves, the standard bar back), at iPhone 13
// and SE in both themes; the same drawer as the desk's sidebar at 1440.
// `node --test tests/e2e/shell.spec.mjs`; E2E_SHOTS=<dir> saves screenshots.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { start } from "./server.mjs";
import { launch, phone, signIn, crmFrame, goTo, settled, screenProblems, shot, noInstallCard, frameOffset, swipe, openDrawer } from "./kit.mjs";

let srv, browser;
before(async () => { srv = await start(); await srv.seed(); browser = await launch(); });
after(async () => { await browser?.close(); await srv?.close(); });

async function open(login, device, theme = "dark") {
  const p = await phone(browser, srv, { device, office: true });
  await signIn(p, login);
  await p.page.goto("/office");
  let f = await crmFrame(p.page);
  await settled(f);
  if (theme !== "dark") {
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
// the drawer's own tap targets (screenProblems looks at the view, the header, sheets and the bar)
const drawerProblems = (f) => f.evaluate(() => [...document.querySelectorAll(".drawer a, .drawer button")].filter((el) => { const r = el.getBoundingClientRect(); return r.width && r.height && !el.classList.contains("sr") && (r.height < 43.5 || r.width < 43.5); }).map((el) => `${(el.textContent || el.getAttribute("aria-label") || "").trim().slice(0, 20)} ${Math.round(el.getBoundingClientRect().width)}x${Math.round(el.getBoundingClientRect().height)}`));

for (const device of ["iphone13", "iphonese"]) {
  for (const theme of ["dark", "light"]) {
    test(`the drawer (${device}, ${theme}): four groups, lists with a dot, the Inbox count, the gear; every way to close it`, async () => {
      const { p, page, f } = await open("olive", device, theme);
      try {
        assert.equal(await f.evaluate(() => document.documentElement.dataset.theme), theme);
        await openDrawer(f);
        const vw = await f.evaluate(() => innerWidth);
        const d = await box(f, ".drawer");
        assert.ok(d.x === 0 && d.w >= 220 && d.w <= 300 && d.w < vw, `from the left, ${d.w} px`);
        assert.equal(await f.$eval(".drawer", (el) => getComputedStyle(el).backgroundColor), theme === "light" ? "rgb(255, 255, 255)" : "rgb(27, 28, 31)", "white in light, #1b1c1f in dark");
        assert.equal(await f.$$eval(".drawer .dr-logo img", (els) => els.filter((e) => e.getBoundingClientRect().width > 0).map((e) => e.getAttribute("src"))).then((x) => x.join()), theme === "light" ? "/assets/img/logo-bww.png" : "/assets/img/logo-bww-white.png", "our logo, for the theme");
        assert.deepEqual(await f.$$eval(".drawer .dr-grp", (els) => els.length), 4);
        assert.equal(await f.$$eval(".drawer [data-dr-sub] .dr-dot", (els) => els.length) >= 4, true, "a dot on Service, Financials, Analytics, Marketing");
        assert.equal(await f.getAttribute('.drawer .dr-row[href="#/today"]', "aria-current"), "page", "Home is the current row");
        assert.match(await f.textContent('.drawer a[href="#/inbox"]'), /Inbox\s*\d+/, "the Inbox count");
        assert.ok(await f.$('.drawer a[href="#/settings"]'), "the gear at the bottom");
        assert.deepEqual(await drawerProblems(f), [], "44 px rows and buttons");
        assert.deepEqual(await screenProblems(f), []);
        await shot(page, `shell-drawer-${device}-${theme}`);
        // a list: Financials, then back
        await f.click('.drawer [data-dr-sub="financials"]');
        assert.deepEqual(await f.$$eval(".drawer .dr-grp .dr-l", (els) => els.map((e) => e.textContent)), ["Invoices", "Payments", "Autopay", "Payroll", "Purchases"]);
        assert.match(await f.textContent(".drawer [data-dr-back]"), /Financials/);
        assert.deepEqual(await drawerProblems(f), []);
        await shot(page, `shell-drawer-list-${device}-${theme}`);
        await f.click(".drawer [data-dr-back]");
        assert.ok(await f.$('.drawer [data-dr-sub="financials"]'));
        // the X
        await f.click(".drawer [data-dr-x]");
        await gone(f, ".drawer");
        // a tap outside
        await openDrawer(f);
        const o = await frameOffset(page, f);
        await page.mouse.click(o.x + vw - 20, o.y + 400);
        await gone(f, ".drawer");
        // a swipe to the left
        await openDrawer(f);
        await swipe(page, { x: o.x + d.w - 30, y: o.y + 400 }, { x: o.x + 20, y: o.y + 405 });
        await gone(f, ".drawer");
        // the round hamburger, then Escape
        await f.click("#top-bar [data-tb-menu]");
        await f.waitForSelector(".drawer.on");
        await page.keyboard.press("Escape");
        await gone(f, ".drawer");
        // the gear opens Settings (top-level: no back button)
        await openDrawer(f);
        await f.click('.drawer a[href="#/settings"]');
        await settled(f, { hash: "#/settings" });
        assert.equal(await f.isVisible("#top-back"), false);
        assert.ok(await f.isVisible("#view [data-set-q]"), "Settings' search field");
        assert.deepEqual(await screenProblems(f), []);
        await shot(page, `shell-settings-${device}-${theme}`);
        // help and the person's sheet from the top bar
        await f.click("#top-bar [data-tb-help]");
        await f.waitForSelector(".sheet.on [data-moved]");
        assert.ok(await f.$(".sheet.on [data-bug]"), "Report a problem");
        assert.deepEqual(await screenProblems(f), []);
        await f.click(".sheet.on [data-sheet-x]");
        await gone(f, ".sheet");
        await f.click("#top-bar [data-tb-me]");
        await f.waitForSelector(".sheet.on [data-tabs-btn]");
        assert.deepEqual(await f.$$eval(".sheet.on .rs-act-l", (els) => els.map((e) => e.textContent)), ["My account", "Light or dark", "Customize Tabs", "Sign out of this phone"]);
        await f.click(".sheet.on [data-sheet-x]");
        await gone(f, ".sheet");
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

test("on a desk (1440): the sidebar is the drawer, its lists fold open in place; no bar, no top bar, no drawer", async () => {
  for (const theme of ["dark", "light"]) {
    const { p, page, f } = await open("olive", "desk1440", theme);
    try {
      assert.equal(await f.isVisible("#tabs"), false);
      assert.equal(await f.isVisible("#top-bar"), false, "the desk's own header: search, New, the person");
      assert.deepEqual(await f.$$eval("#side .side-main", (els) => els.length), 4, "four groups");
      assert.equal(await f.isVisible('#side a[href="#/invoices"]'), false, "Financials folded");
      await f.click('#side [data-grp="financials"] .side-h');
      assert.equal(await f.isVisible('#side a[href="#/invoices"]'), true, "and open");
      await f.click('#side a[href="#/invoices"]');
      await settled(f, { hash: "#/invoices" });
      assert.equal(await f.getAttribute('#side a[href="#/invoices"]', "aria-current"), "page");
      await goTo(f, "/jobs");
      assert.equal(await f.isVisible('#side a[href="#/jobs"]'), true, "the list holding the screen opens by itself");
      assert.ok(await f.isVisible('#side .side-foot a[href="#/settings"]'));
      assert.deepEqual(await screenProblems(f), []);
      await shot(page, `shell-desk1440-${theme}`);
      await p.clean();
    } finally { await p.close(); }
  }
});
