// The plan page and its editor in Rotor's look (Nov 2026): a top card, the
// customer, black segments Service | Agree | Schedule; the round pencil opens
// the editor, a full-height sheet with the same segments and a red Save. The
// owner's decision (Nov 14): how often, agreement length and renewal, start
// date and billing mode change after a plan is made, with a confirm sheet
// that says what happens to the visits and the agreement (a signed one
// stays; the plan needs a new one). iPhone 13 and SE in both themes, and a
// desk at 1440 px. `node --test tests/e2e/plan-editor.spec.mjs`.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { start } from "./server.mjs";
import { launch, phone, signIn, crmFrame, goTo, settled, title, screenProblems, badLinks, shot, noInstallCard } from "./kit.mjs";

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
  const x = await f.$("[data-moved-x]");
  if (x) await x.click();
  return { p, page: p.page, f };
}
// the top sheet's own title (a confirm sheet opens over the editor)
const sheetUp = (f, re) => f.waitForFunction((src) => { const all = document.querySelectorAll(".sheet.on > .sheet-head h2"); const h = all[all.length - 1]; return !!h && new RegExp(src).test(h.textContent); }, re.source, { timeout: 5000 });
const theme = (f, t) => f.evaluate((th) => { try { localStorage.setItem("crm-theme", th); } catch (e) { /* private */ } document.documentElement.dataset.theme = th; }, t);
const bg = (f, sel) => f.$eval(sel, (el) => getComputedStyle(el).backgroundColor);
const errorsOf = (page) => page.evaluate(() => [...document.querySelectorAll("iframe")].flatMap((fr) => { try { return fr.contentWindow.__csp || []; } catch (e) { return []; } }));

for (const device of ["iphone13", "iphonese"]) {
  test(`plan editor (${device}): the page's segments, the editor sheet in both themes, the ... sheet`, async () => {
    const { p, page, f } = await open("olive", device);
    const consoleErrors = [];
    page.on("console", (m) => { if (m.type() === "error") consoleErrors.push(m.text()); });
    try {
      await goTo(f, `/plans/${seeded.plans.active}`);
      assert.equal(await title(f), "Quarterly plan");
      assert.ok(await f.$eval("#top", (el) => el.classList.contains("rs-top")), "the detail header");
      assert.deepEqual(await f.$$eval("#top-act .rnd", (els) => els.map((e) => e.getAttribute("aria-label"))), ["Edit the plan", "More"]);
      for (const t of ["light", "dark"]) {
        await theme(f, t);
        assert.equal(await bg(f, ".rs-card"), t === "light" ? "rgb(255, 255, 255)" : "rgb(27, 28, 31)", `${t}: a card`);
        for (const tab of ["service", "agree", "schedule"]) {
          await f.click(`[data-seg=plan][data-key=${tab}]`);
          await f.waitForFunction((k) => document.querySelector(`[data-seg=plan][data-key=${k}]`).getAttribute("aria-selected") === "true", tab);
          assert.deepEqual(await screenProblems(f), [], `${t} ${tab}: the phone checks`);
          assert.deepEqual(await badLinks(f), []);
          await shot(page, `plan-page-${tab}-${t}-${device}`);
        }
        await f.click("[data-seg=plan][data-key=service]");
        // the editor: a full-height sheet with the same black segments and a red Save
        await f.click("[data-edit-plan]");
        await sheetUp(f, /Quarterly plan/);
        assert.ok(await f.$(".sheet.on.rs-sheetpage .rs-seg.black"), "black segments");
        assert.equal(await f.$eval(".sheet.on .rs-done", (el) => el.textContent), "Save");
        assert.ok(await f.$(".sheet.on select[name=frequency]"), "how often can change");
        assert.ok(await f.$(".sheet.on select[name=term_months]"), "the length can change");
        assert.ok(await f.$(".sheet.on select[name=billing_mode]"), "billing can change");
        assert.ok(await f.$(".sheet.on [data-renew][role=switch]"), "renewal is a switch");
        assert.deepEqual(await screenProblems(f), [], `${t} editor: the phone checks`);
        await shot(page, `plan-editor-service-${t}-${device}`);
        for (const tab of ["agree", "schedule"]) {
          await f.click(`.sheet.on [data-seg=sheet][data-key=${tab}]`);
          await f.waitForFunction((k) => !document.querySelector(`.sheet.on [data-pane=${k}]`).hidden, tab);
          assert.deepEqual(await screenProblems(f), [], `${t} editor ${tab}: the phone checks`);
          await shot(page, `plan-editor-${tab}-${t}-${device}`);
        }
        await f.click(".sheet.on [data-sheet-x]");
        await f.waitForFunction(() => !document.querySelector(".sheet"), null, { timeout: 5000 });
      }
      // the ... sheet holds the plan's actions, each with its old data-* hook
      await f.click("#top-more");
      await sheetUp(f, /Quarterly plan/);
      for (const hook of ["edit", "price", "pause", "cancel"]) assert.ok(await f.$(`.sheet.on [data-act=${hook}]`), `... has ${hook}`);
      assert.ok(await f.$(".sheet.on .rs-act.danger[data-act=cancel]"), "Cancel plan is red");
      await f.click(".sheet.on [data-sheet-x]");
      assert.deepEqual(await errorsOf(page), [], "no CSP violations");
      assert.deepEqual(consoleErrors.filter((x) => !/favicon|Failed to load resource/.test(x)), [], "no console errors");
      await p.clean();
    } finally { await p.close(); }
  });
}

test("plan editor: a change the visits can't take is refused in place; a billing and renewal change asks first, saves, and the plan needs a new agreement", async () => {
  const { p, page, f } = await open("olive", "iphone13");
  try {
    await goTo(f, `/plans/${seeded.plans.active}`);
    await f.click("[data-edit-plan]");
    await sheetUp(f, /Quarterly plan/);
    // Quarterly's interior and exterior visits: monthly would leave visits with nothing on them
    await f.selectOption(".sheet.on select[name=frequency]", "1");
    await f.click(".sheet.on .rs-done");
    await f.waitForFunction(() => /would have nothing on it/.test((document.querySelector(".toasts") || {}).textContent || ""), null, { timeout: 8000 });
    assert.ok(await f.$(".sheet.on.rs-sheetpage"), "the editor stays open");
    await f.selectOption(".sheet.on select[name=frequency]", "3");
    // billing and renewal: the confirm sheet says what changes
    await f.selectOption(".sheet.on select[name=billing_mode]", "after_visit");
    await f.click(".sheet.on [data-renew]");
    await f.click(".sheet.on .rs-done");
    await sheetUp(f, /Save these changes/);
    const confirm = await f.textContent(".sheet.on [data-edit-confirm]");
    assert.match(confirm, /Billing[\s\S]*After each visit/);
    assert.match(confirm, /Renews[\s\S]*Yes → No/);
    assert.match(confirm, /signed agreement stays on file/);
    assert.deepEqual(await screenProblems(f), [], "the confirm sheet passes the phone checks");
    await shot(page, "plan-editor-confirm-iphone13");
    await f.click(".sheet.on [data-a=yes]");
    await f.waitForFunction(() => /Plan saved/.test((document.querySelector(".toasts") || {}).textContent || ""), null, { timeout: 20000 });
    await f.waitForFunction(() => !!document.querySelector("[data-stale]"), null, { timeout: 10000 });
    await settled(f);
    const text = await f.textContent("#view");
    assert.match(text, /terms changed after the agreement was signed/);
    assert.match(text, /After each visit/);
    await f.click("[data-seg=plan][data-key=agree]");
    await f.waitForSelector("[data-act=send-agreement]", { timeout: 5000 });
    assert.match(await f.textContent("#view"), /Generate New Agreement/, "a new agreement can be made");
    await p.clean();
  } finally { await p.close(); }
});

test("plan page on a desk (1440): the editor opens as a dialog, the page still works", async () => {
  const { p, page, f } = await open("olive", "desk1440");
  try {
    await goTo(f, `/plans/${seeded.plans.active}`);
    assert.equal(await title(f), "Quarterly plan");
    assert.deepEqual(await screenProblems(f), [], "the desk checks");
    await f.click("[data-edit-plan]");
    await sheetUp(f, /Quarterly plan/);
    const r = await f.$eval(".sheet.on", (el) => { const b = el.getBoundingClientRect(); return { w: b.width, left: b.left, vw: innerWidth }; });
    assert.ok(r.w < r.vw * 0.8, `a centred dialog, not full width (${r.w} of ${r.vw})`);
    assert.deepEqual(await screenProblems(f), [], "the editor passes the desk checks");
    await shot(page, "plan-editor-desk1440");
    await f.click(".sheet.on [data-sheet-x]");
    await p.clean();
  } finally { await p.close(); }
});
