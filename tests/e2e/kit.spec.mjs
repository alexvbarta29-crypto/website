// The Rotor-style kit on #/kit (Nov 2026; core/ui.js, the router's header
// contract, styles/crm.css): every piece at iPhone 13 and SE in both
// themes with no sideways scroll, 44 px tap targets, no console error or
// CSP violation; the detail header (round back, the title centred, two
// round tools and the round "..."); the "..." sheet opens and closes (✕,
// Escape, a row), keeps its rows' data-* and puts red rows last; the
// segmented tabs answer the arrow keys; a sheet page keeps what was typed
// across its tabs and closes on Save; a tech can't open the page; and the
// Tab bar page's preview is a bar again, not full-width icons.
// `node --test tests/e2e/kit.spec.mjs`; E2E_SHOTS=<dir> saves screenshots.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { start } from "./server.mjs";
import { launch, phone, signIn, crmFrame, goTo, settled, title, backShown, screenProblems, badLinks, shot, noInstallCard } from "./kit.mjs";

let srv, browser;
before(async () => { srv = await start(); await srv.seed(); browser = await launch(); });
after(async () => { await browser?.close(); await srv?.close(); });

async function open(login, device) {
  const p = await phone(browser, srv, { device, office: true });
  await signIn(p, login);
  await p.page.goto("/office");
  const f = await crmFrame(p.page);
  await settled(f);
  await noInstallCard(p.page);
  const x = await f.$("[data-moved-x]");
  if (x) await x.click();
  return { p, page: p.page, f };
}
const box = (f, sel) => f.$eval(sel, (el) => { const r = el.getBoundingClientRect(); return { x: r.x, y: r.y, w: r.width, h: r.height, right: r.right, bottom: r.bottom }; });
const sheetOpen = (f) => f.evaluate(() => !!document.querySelector(".sheet.on"));
const waitSheet = (f, on = true) => f.waitForFunction((want) => !!document.querySelector(".sheet.on") === want && (want || !document.querySelector(".sheet")), on, { timeout: 5000 });
const bg = (f, sel) => f.$eval(sel, (el) => getComputedStyle(el).backgroundColor);

for (const device of ["iphone13", "iphonese"]) {
  test(`#/kit (${device}): every piece in light and dark, the detail header, the ... sheet, segmented tabs, a sheet page`, async () => {
    const { p, page, f } = await open("olive", device);
    try {
      await goTo(f, "/kit");
      assert.equal(await title(f), "Kit");
      assert.ok(await backShown(f), "a round back button");
      // the header contract: the round back left, the title centred, two round tools and the round ...
      assert.ok(await f.$eval("#top", (el) => el.classList.contains("rs-top")));
      const tools = await f.$$eval("#top-act .rnd", (els) => els.map((e) => e.getAttribute("aria-label")));
      assert.deepEqual(tools, ["Edit", "Share", "More"]);
      const t = await box(f, "#top-title");
      const vw = await f.evaluate(() => innerWidth);
      assert.ok(Math.abs(t.x + t.w / 2 - vw / 2) < 2, `the title is centred (${t.x + t.w / 2} vs ${vw / 2})`);
      for (const sel of ["#top-back", "#top-act .rnd:last-child"]) {
        const b = await box(f, sel);
        assert.ok(b.w >= 44 && b.h >= 44, `${sel} is 44 px (${b.w}x${b.h})`);
      }
      for (const theme of ["dark", "light"]) {
        await f.click(`[data-seg=theme][data-key=${theme}]`);
        await f.waitForFunction((th) => document.documentElement.dataset.theme === th, theme);
        assert.equal(await bg(f, "body"), theme === "light" ? "rgb(246, 246, 248)" : "rgb(17, 18, 20)", `${theme}: the canvas`);
        assert.equal(await bg(f, ".rs-card"), theme === "light" ? "rgb(255, 255, 255)" : "rgb(27, 28, 31)", `${theme}: a card`);
        assert.equal(await f.$eval(".rs-crow .rnd.red", (el) => getComputedStyle(el, "::before").backgroundColor), "rgb(251, 77, 61)", `${theme}: the red call button`);
        assert.deepEqual(await screenProblems(f), [], `${theme}: no sideways scroll, 44 px targets, 16 px inputs`);
        assert.deepEqual(await badLinks(f), []);
        // nothing sticks out of its card or the screen (the rows that scroll sideways clip what is past the edge: tabs, tiles, a board)
        const wide = await f.evaluate(() => [...document.querySelectorAll("#view *")].filter((el) => { const r = el.getBoundingClientRect(); return r.width && !el.parentElement.closest(".rs-seg.scroll, .rs-tiles-in, .rs-strip, .rs-cols") && (r.right > innerWidth + 0.5 || r.left < -0.5); }).map((el) => el.className || el.tagName).slice(0, 5));
        assert.deepEqual(wide, [], `${theme}: nothing past the screen's edge`);
        await shot(page, `kit-${theme}-${device}`);
        await f.evaluate(() => { document.getElementById("view").scrollTop = 1e6; });
        await shot(page, `kit-${theme}-${device}-bottom`);
        await f.evaluate(() => { document.getElementById("view").scrollTop = 0; });
      }
      // the small round button: a 38 px circle drawn in its 44 px box
      const sm = await f.$eval(".rs-ch .rnd.sm", (el) => { const r = el.getBoundingClientRect(); const s = getComputedStyle(el, "::before"); return { w: r.width, inset: s.top }; });
      assert.deepEqual(sm, { w: 44, inset: "3px" });

      // the round ... opens the action sheet: grouped rows, red ones last, their data-* kept
      await f.click("#top-more");
      await waitSheet(f);
      assert.equal(await f.$eval(".sheet.rs-actions h2", (el) => el.textContent), "Quinn Talkedto");
      const groups = await f.$$eval(".rs-act-g", (gs) => gs.map((g) => [...g.querySelectorAll(".rs-act")].map((r) => r.textContent.trim() + (r.classList.contains("danger") ? " (red)" : ""))));
      assert.deepEqual(groups, [["Log a call", "Start a follow-up", "New task"], ["New quote", "New invoiceAdd credit, card link"], ["Edit lead", "Merge with..."], ["Archive (red)"]]);
      assert.ok(await f.$(".sheet.rs-actions [data-kit-archive].danger"), "a row keeps its data-* hook");
      assert.ok(await f.$eval(".rs-act-g button:disabled", (el) => el.textContent.includes("Merge")), "a disabled row");
      assert.deepEqual(await screenProblems(f), [], "the sheet's rows are 44 px");
      await shot(page, `kit-more-${device}`);
      // Escape closes it, and the focus goes back to the ... button
      await page.keyboard.press("Escape");
      await waitSheet(f, false);
      assert.equal(await f.evaluate(() => document.activeElement && document.activeElement.id), "top-more");
      // the keyboard opens it again (Enter on the focused ...), ✕ closes it
      await page.keyboard.press("Enter");
      await waitSheet(f);
      await f.click(".sheet.on [data-sheet-x]");
      await waitSheet(f, false);
      // a row closes the sheet and runs
      await f.click("#top-more");
      await waitSheet(f);
      await f.click(".sheet.on .rs-act >> text=New task");
      await waitSheet(f, false);
      await f.waitForFunction(() => /New task/.test(document.querySelector(".toasts").textContent));
      // a tool runs too
      await f.click('#top-act [aria-label="Share"]');
      await f.waitForFunction(() => /Share/.test(document.querySelector(".toasts").textContent));

      // segmented tabs: a tap, and the arrow keys move along and keep the focus
      await f.click("[data-seg=tab][data-key=activity]");
      assert.equal(await f.getAttribute("[data-seg=tab][data-key=activity]", "aria-selected"), "true");
      await f.focus("[data-seg=tab][data-key=activity]");
      await page.keyboard.press("ArrowLeft");
      assert.equal(await f.getAttribute("[data-seg=tab][data-key=details]", "aria-selected"), "true");
      assert.equal(await f.evaluate(() => document.activeElement.dataset.key), "details", "the focus follows");
      await page.keyboard.press("End");
      assert.equal(await f.getAttribute("[data-seg=tab][data-key=activity]", "aria-selected"), "true");

      // the in-page action sheet: red rows last even when listed first; a link row
      await f.click("[data-kit-actions]");
      await waitSheet(f);
      assert.deepEqual(await f.$$eval(".sheet.on .rs-act", (els) => els.map((e) => e.textContent.trim())), ["Book a visit", "Mark done", "Open customer", "Cancel job"]);
      await page.keyboard.press("Escape");
      await waitSheet(f, false);

      // a sheet page: the black segmented control, panes keep what was typed, Save closes it
      await f.click("[data-kit-page]");
      await waitSheet(f);
      const sp = await box(f, ".sheet.rs-sheetpage");
      assert.ok(sp.h > (await f.evaluate(() => innerHeight)) * 0.85, "full height");
      assert.equal(await f.$eval(".rs-sheetpage .rs-done", (el) => el.textContent), "Save");
      await f.selectOption(".rs-sheetpage select[name=freq]", "Monthly");
      await f.click(".rs-sheetpage [data-seg=sheet][data-key=agree]");
      assert.equal(await f.$eval('.rs-sheetpage [data-pane="service"]', (el) => el.hidden), true);
      assert.equal(await f.$eval('.rs-sheetpage [data-pane="agree"]', (el) => el.hidden), false);
      assert.deepEqual(await screenProblems(f), []);
      await shot(page, `kit-sheetpage-${device}`);
      await f.focus(".rs-sheetpage [data-seg=sheet][data-key=agree]");
      await page.keyboard.press("ArrowLeft");
      assert.equal(await f.$eval('.rs-sheetpage [data-pane="service"]', (el) => el.hidden), false, "the arrow keys work in a sheet too");
      assert.equal(await f.$eval(".rs-sheetpage select[name=freq]", (el) => el.value), "Monthly", "what was picked is still there");
      await f.click(".rs-sheetpage [data-sheet-x]");
      await waitSheet(f, false);
      await f.click("[data-kit-page]");
      await waitSheet(f);
      await f.click(".rs-sheetpage .rs-done");
      await waitSheet(f, false);
      await f.waitForFunction(() => /Saved/.test(document.querySelector(".toasts").textContent));

      // the notes box saves on blur (change)
      await f.fill("[data-notes=crew]", "Synthetic: the side gate sticks.");
      await f.click(".rs-label");
      await f.waitForFunction(() => /Notes saved/.test(document.querySelector(".toasts").textContent));

      // leaving gives the device's own theme back (light, the default)
      await goTo(f, "/today");
      assert.equal(await f.evaluate(() => document.documentElement.dataset.theme), "light");
      assert.ok(!(await f.$eval("#top", (el) => el.classList.contains("rs-top"))), "a screen without tools or more keeps its header");
      assert.equal(await f.$$eval("#top-act .rnd", (els) => els.length), 0);
      await p.clean();
    } finally { await p.close(); }
  });
}

test("#/kit is for owners and the office: a tech sees Not for this login; it is in no menu", async () => {
  const { p, f } = await open("theo", "iphonese");
  try {
    await goTo(f, "/kit");
    assert.match(await f.textContent("#view"), /Not for this login/);
    assert.ok(!(await f.$eval("#top", (el) => el.classList.contains("rs-top"))));
    await p.clean();
  } finally { await p.close(); }
  const o = await open("olive", "iphone13");
  try {
    await goTo(o.f, "/menu");
    assert.equal(await o.f.$('a[href="#/kit"]'), null, "not in the Menu");
    await goTo(o.f, "/settings");
    assert.equal(await o.f.$('a[href="#/kit"]'), null, "not in Settings");
    await o.p.clean();
  } finally { await o.p.close(); }
});

test("#/tab-bar is Customize Tabs as a page: one list, the MORE MENU line, small icons, round − and +, drag handles", async () => {
  const { p, page, f } = await open("olive", "iphone13");
  try {
    await goTo(f, "/tab-bar");
    const line = await box(f, "[data-ctb-line]");
    const rows = await f.$$eval(".ctb-row", (els) => els.map((e) => e.dataset.k));
    assert.ok(rows.length >= 6 && line.h <= 60, `${rows.length} rows, the line ${line.h} px`);
    const icons = await f.$$eval(".ctb-ic svg", (els) => els.map((e) => Math.round(e.getBoundingClientRect().width)));
    assert.ok(icons.every((w) => w <= 24), `small icons: ${icons}`);
    assert.equal(await f.$$eval("[data-ctb-out]", (els) => els.length), 4, "the standard bar's four above the line");
    assert.ok((await f.$$eval("[data-ctb-drag]", (els) => els.length)) === rows.length, "a handle on every row");
    assert.deepEqual(await screenProblems(f), []);
    await shot(page, "kit-tab-bar");
    await p.clean();
  } finally { await p.close(); }
});
