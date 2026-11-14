// Phone checks of Payroll (M7a; design §9.2 "Payroll", §9.3 "Pay", §12.4):
// the office's Payroll (this week, the scoreboard, the periods), last
// week's pay sheets (lines, overtime, tips), an adjustment, Lock, the
// printable sheet, Settings → Payroll; a technician's own Pay (only theirs)
// and no way into Payroll. iPhone 13 and a 1440 desk. `node --test tests/e2e/payroll.spec.mjs`.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { start } from "./server.mjs";
import { seedPayroll } from "./payroll-seed.mjs";
import { launch, phone, signIn, crmFrame, goTo, settled, title, badLinks, screenProblems, shot, noInstallCard } from "./kit.mjs";

let srv, browser, seeded, PR;
before(async () => { srv = await start(); seeded = await srv.seed(); PR = await seedPayroll(seeded); browser = await launch(); });
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
const viewHas = (f, re, timeout = 15000) => f.waitForFunction((src) => new RegExp(src).test(document.getElementById("view").textContent), re.source, { timeout });
const sheetUp = (f, re) => f.waitForFunction((src) => { const h = document.querySelector(".sheet.on h2"); return !!h && new RegExp(src).test(h.textContent); }, re.source, { timeout: 5000 });

for (const device of ["iphone13", "desk1440"]) {
  test(`payroll (${device}): Payroll, last week's pay sheets, an adjustment, Lock, the printable sheet, Settings → Payroll`, async () => {
    const { p, page, f } = await open("olive", device);
    try {
      await goTo(f, "/menu");
      assert.match(await f.textContent("#view"), /Work[\s\S]*Payroll/);
      await goTo(f, "/payroll");
      assert.equal(await title(f), "Payroll");
      await viewHas(f, /Crew scoreboard/);
      assert.match(await f.textContent("#view"), /Pay periods/);
      assert.deepEqual(await screenProblems(f), [], "Payroll passes the phone checks");
      await shot(page, `payroll-${device}`);
      await goTo(f, `/payroll/${PR.lastPeriod.id}`);
      await viewHas(f, /Theo Tech/);
      const v = await f.textContent("#view");
      assert.match(v, /Overtime/);
      assert.match(v, /\$962\.50/, "Theo: 45 h at $20 with 5 h of overtime, and half a $25 tip");
      assert.match(v, /Tess Rowe/);
      assert.deepEqual(await screenProblems(f), [], "a pay period passes the phone checks");
      assert.deepEqual(await badLinks(f), []);
      // the printable sheet is a plain page of the site
      const href = await f.getAttribute('a[href*="/sheet/"]', "href");
      const sheet = await p.ctx.request.get(href);
      assert.equal(sheet.status(), 200);
      assert.match(await sheet.text(), /Pay sheet/);
      if (device === "iphone13") {
        // a bonus with a note, then lock
        await f.click('[data-act="add"]');
        await sheetUp(f, /Add to someone's pay/);
        await f.selectOption('.sheet.on select[name="user_id"]', { label: "Tess Rowe" });
        await f.fill('.sheet.on input[name="amount"]', "20");
        await f.fill('.sheet.on input[name="note"]', "Two Google reviews");
        assert.deepEqual(await screenProblems(f), [], "the sheet passes the phone checks");
        await f.click('.sheet.on button[type="submit"]');
        await viewHas(f, /Two Google reviews/);
        await f.click('[data-act="lock"]');
        await sheetUp(f, /Lock the period/);
        await f.click('.sheet.on [data-a="yes"]');
        await viewHas(f, /final; not marked paid yet/);
        await shot(page, `payroll-period-locked-${device}`);
      } else await shot(page, `payroll-period-${device}`);
      await goTo(f, "/settings/payroll");
      await viewHas(f, /Each person's pay/);
      assert.deepEqual(await screenProblems(f), [], "Settings → Payroll passes the phone checks");
      await f.click(`[data-edit="${seeded.users.tech.id}"]`);
      await sheetUp(f, /Theo Tech's pay/);
      assert.equal(await f.inputValue('.sheet.on input[name="service"]'), "20.00");
      await p.clean();
    } finally { await p.close(); }
  });
}

test("Pay (iphone13): a technician's own pay, line by line; Payroll isn't theirs", async () => {
  const { p, page, f } = await open("theo", "iphone13");
  try {
    await goTo(f, `/pay?period=${PR.last}`);
    await f.waitForSelector("[data-my-pay]");
    const v = await f.textContent("#view");
    assert.match(v, /\$962\.50/);
    assert.match(v, /What it's made of/);
    assert.match(v, /Overtime/);
    assert.doesNotMatch(v, /Tess/, "only their own");
    assert.deepEqual(await screenProblems(f), [], "Pay passes the phone checks");
    await shot(page, "payroll-pay-tech-iphone13");
    await goTo(f, "/pay");
    await f.waitForSelector("[data-my-pay]");
    await goTo(f, "/payroll");
    await viewHas(f, /Not for this login/);
    await p.clean();
  } finally { await p.close(); }
});
