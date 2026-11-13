// Phone and desk checks of the sign-in (the owner, Nov 2026: "when I'm on
// the desktop version I want it to be a legit CRM. Remove all the headers
// and have the sign in be the only thing allowing you into the CRM, and
// then also I forgot my password"): /office's sign-in page is Team sign-in
// only, in the CRM's look, with Forgot password (the office password stands
// in for a reset link); an owner's or the office's sign-in opens the office
// tools too; on a computer the CRM is the whole window (no header, no "Get
// the app" card). docs/OFFICE.md, docs/CRM.md. Run alone:
//   node --test --test-concurrency=1 tests/e2e/signin.spec.mjs
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { start } from "./server.mjs";
import { launch, phone, signIn, crmFrame, settled, shot, OFFICE_PASSWORD } from "./kit.mjs";

let srv, browser, team;
before(async () => { srv = await start(); browser = await launch(); team = await srv.seed({ teamOnly: true }); });
after(async () => { await browser?.close(); await srv?.close(); });

const PASS = "a long synthetic passphrase";
const officeCookie = async (p) => (await p.ctx.cookies()).find((c) => c.name === "barta_office") || null;
const visible = (page, sel) => page.isVisible(sel).catch(() => false);
// What the sign-in page itself must pass: no sideways scroll, 16 px inputs, 44 px controls.
const pageProblems = (page) => page.evaluate(() => {
  const out = [];
  if (document.documentElement.scrollWidth > innerWidth + 1) out.push("scrolls sideways");
  for (const el of document.querySelectorAll("input:not(.user), button")) {
    if (!el.offsetParent) continue;
    const r = el.getBoundingClientRect();
    if (r.height < 43.5) out.push(`small ${el.id || el.textContent.trim()} ${Math.round(r.height)}`);
    if (el.tagName === "INPUT" && parseFloat(getComputedStyle(el).fontSize) < 16) out.push(`input under 16 px: ${el.id}`);
  }
  return out;
});

test("the sign-in page is Team sign-in only (no office password tab), in the CRM's dark look; the office password alone opens nothing more", async () => {
  for (const device of ["iphone13", "desk1440"]) {
    for (const office of [false, true]) {
      const p = await phone(browser, srv, { device, office });
      try {
        const { page } = p;
        await page.goto("/office");
        await page.waitForSelector("#team");
        assert.equal(await visible(page, "#t-login"), true, device);
        assert.equal(await visible(page, "#t-pw"), true);
        assert.equal(await visible(page, "#to-forgot"), true, "Forgot password?");
        assert.equal(await page.$("#seg, [data-mode], #t-office, .bar, [data-tool]"), null, "no Office password tab, no optional office field, no tab row");
        assert.equal(await visible(page, "#office"), false, "the office password form is for setup only");
        assert.equal(await page.getAttribute("html", "data-theme"), "dark", "dark by default, as the CRM");
        assert.equal(await page.evaluate(() => getComputedStyle(document.body).backgroundColor), "rgb(17, 18, 20)");
        assert.match(await page.evaluate(() => getComputedStyle(document.body).fontFamily), /-apple-system/);
        assert.deepEqual(await pageProblems(page), [], device);
        if (!office) await shot(page, `signin-${device}-signin`);
        await p.clean();
      } finally { await p.close(); }
    }
  }
});

test("signing in on the page opens the CRM; an owner gets the office tools with it; on a desk nothing else is on screen; signing out closes them", async () => {
  for (const device of ["iphone13", "desk1440"]) {
    const p = await phone(browser, srv, { device });
    try {
      const { page } = p;
      await page.goto("/office");
      await page.fill("#t-login", team.users.owner.login);
      await page.fill("#t-pw", PASS);
      await page.click("#t-go");
      const f = await crmFrame(page);
      await settled(f);
      assert.equal(await page.$(".bar, .brand, [data-tool]"), null, "no office header, logo or tab row");
      const c = await officeCookie(p);
      assert.ok(c && /^c1\./.test(c.value), "the office cookie came with the sign-in");
      const lights = await (await p.ctx.request.get("/lights")).text();
      assert.doesNotMatch(lights, /Sign in to Barta Office/, "Light Studio opens on it");
      if (device === "desk1440") {
        assert.equal(await visible(page, "#install"), false, "no Get the app card on a computer");
        const box = await (await f.frameElement()).boundingBox();
        assert.deepEqual([box.x, box.y, box.width, box.height], [0, 0, 1440, 900], "the CRM is the whole window");
        assert.equal(await f.isVisible("#side"), true, "the CRM's own sidebar");
        assert.equal(await f.$$eval('#side a[href="#/dashboard"]', (els) => els.length) > 0, true, "the Dashboard is in the sidebar");
        await page.waitForTimeout(300);
        await shot(page, "signin-desk1440-crm");
      } else {
        assert.equal(await visible(page, "#install"), true, "a phone's browser tab keeps the Get the app card");
      }
      // sign out: the office cookie goes too, and /office is the sign-in page again
      const out = await p.ctx.request.post("/api/crm/auth/logout", { headers: { "x-crm": "1", "content-type": "application/json" }, data: {} });
      assert.equal(out.status(), 200);
      assert.equal(await officeCookie(p), null, "signed out of the office tools too");
      await page.goto("/office");
      await page.waitForSelector("#team");
      await p.clean();
    } finally { await p.close(); }
  }
});

test("Forgot password: the office password and a new one sign the person in; a wrong one says only that it didn't match", async () => {
  // a tech on a phone (the CRM only), the office (admin) at a desk (the tools too)
  for (const [device, who, tools] of [["iphone13", team.users.tech2, false], ["desk1440", team.users.admin, true]]) {
    const NEW = `a fresh passphrase for ${who.login}`;
    const p = await phone(browser, srv, { device });
    try {
      const { page } = p;
      await page.goto("/office");
      await page.fill("#t-login", who.login);
      await page.click("#to-forgot");
      await page.waitForSelector("#forgot", { state: "visible" });
      assert.equal(await page.inputValue("#f-login"), who.login, "the login carries over");
      assert.equal(await visible(page, "#team"), false);
      assert.deepEqual(await pageProblems(page), [], device);
      if (device === "desk1440") await shot(page, "signin-desk1440-forgot");
      // the two new passwords must match before anything is sent
      await page.fill("#f-office", OFFICE_PASSWORD);
      await page.fill("#f-pw", NEW);
      await page.fill("#f-again", NEW + "x");
      await page.click("#f-go");
      assert.equal(await page.textContent("#forgot-err"), "The two passwords don't match.");
      // a wrong office password: one plain answer
      await page.fill("#f-office", "not the office password");
      await page.fill("#f-again", NEW);
      await page.click("#f-go");
      await page.waitForFunction(() => !document.getElementById("forgot-err").hidden && /match/.test(document.getElementById("forgot-err").textContent) && !/two/.test(document.getElementById("forgot-err").textContent));
      assert.equal(await page.textContent("#forgot-err"), "That didn't match.");
      // the right one: signed in, on the CRM
      await page.fill("#f-office", OFFICE_PASSWORD);
      await page.click("#f-go");
      const f = await crmFrame(page);
      await settled(f);
      const c = await officeCookie(p);
      assert.equal(!!(c && /^c1\./.test(c.value)), tools, `${who.login}: office tools ${tools}`);
      // the new password is the password now
      await p.ctx.clearCookies();
      await signIn(p, who.login, NEW);
      const old = await p.ctx.request.post("/api/crm/auth/login", { headers: { "content-type": "application/json", "x-crm": "1" }, data: { login: who.login, password: PASS } });
      assert.equal(old.status(), 401, "the old password is gone");
      await p.clean();
    } finally { await p.close(); }
  }
  // /office#forgot (the CRM's own sign-in page links it) opens Forgot password directly
  const q = await phone(browser, srv, { device: "desk1440" });
  try {
    await q.page.goto("/office#forgot");
    await q.page.waitForSelector("#forgot", { state: "visible" });
    assert.equal(await visible(q.page, "#team"), false);
    await q.page.click("#to-team");
    await q.page.waitForSelector("#team", { state: "visible" });
    await q.clean();
  } finally { await q.close(); }
});
