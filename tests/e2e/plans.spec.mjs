// Phone checks of the plans screens (M3b; design §9.2, §8.1, §12.4): Plans,
// a plan (its visits, the agreement, the cancel calculator), a new plan,
// plan visits to book, the lights season, Settings → Plans and the
// agreement texts; the customer's agreement page (from a texted link, and
// Sign on this phone, once), "Text me a link"; and none of it for a tech.
// iPhone 13 and iPhone SE sizes. `npm run e2e`.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { start } from "./server.mjs";
import { launch, phone, signIn, crmFrame, goTo, settled, title, badLinks, screenProblems, shot, noInstallCard } from "./kit.mjs";

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
  return { p, page: p.page, f };
}
const sheetUp = (f, re) => f.waitForFunction((src) => { const h = document.querySelector(".sheet.on h2"); return !!h && new RegExp(src).test(h.textContent); }, re.source, { timeout: 5000 });
const sheetGone = (f) => f.waitForFunction(() => !document.querySelector(".sheet"), null, { timeout: 5000 });
const closeSheet = async (f) => { await f.click(".sheet.on [data-sheet-x]"); await sheetGone(f); };

// The customer's pages have no #view: the same checks over their main.
const portalProblems = (page) => page.evaluate(() => {
  const out = [];
  if (document.documentElement.scrollWidth > innerWidth + 1) out.push(`scrolls sideways (${document.documentElement.scrollWidth} > ${innerWidth})`);
  for (const el of document.querySelectorAll("main a, main button, main input:not([type=checkbox]):not([type=radio]), main textarea")) {
    const r = el.getBoundingClientRect();
    if (!r.width || !r.height || el.closest("[hidden]")) continue;
    const box = el.closest("label") ? el.closest("label").getBoundingClientRect() : r;
    if (box.height < 43.5 || box.width < 43.5) out.push(`small tap target ${el.tagName.toLowerCase()} "${(el.textContent || el.name || "").trim().slice(0, 24)}" ${Math.round(box.width)}x${Math.round(box.height)}`);
  }
  for (const i of document.querySelectorAll("main input:not([type=checkbox]):not([type=radio]), main textarea")) {
    if (i.offsetParent && parseFloat(getComputedStyle(i).fontSize) < 16) out.push(`input under 16 px: ${i.name}`);
  }
  return out;
});
async function draw(page) {
  const pad = await page.$("[data-sig]");
  await pad.scrollIntoViewIfNeeded();
  const b = await pad.boundingBox();
  await page.mouse.move(b.x + 30, b.y + b.height * 0.6);
  await page.mouse.down();
  for (let i = 0; i <= 12; i++) await page.mouse.move(b.x + 30 + i * 18, b.y + b.height * (0.6 - 0.25 * Math.sin(i / 2)));
  await page.mouse.up();
}
const api = async (p, path) => (await (await p.ctx.request.get("/api/crm" + path, { headers: { "x-crm": "1" } })).json()).data;
async function until(fn, ms = 20000) {
  const end = Date.now() + ms;
  for (;;) {
    const v = await fn();
    if (v || Date.now() > end) return v;
    await new Promise((ok) => setTimeout(ok, 500));
  }
}

for (const device of ["iphone13", "iphonese"]) {
  test(`plans (${device}): the list, a plan, the cancel calculator, a new plan, visits to book, the lights season, the settings`, async () => {
    const { p, page, f } = await open("olive", device);
    try {
      await goTo(f, "/plans");
      assert.equal(await title(f), "Plans");
      assert.match(await f.textContent("#view"), /Harper Planfolk/, "the active plan");
      assert.deepEqual(await screenProblems(f), [], "the list passes the phone checks");
      await shot(page, `plans-list-${device}`);
      await f.click("[data-chip=pending]");
      await f.waitForFunction(() => /Finley Planfolk/.test(document.getElementById("view").textContent), null, { timeout: 5000 });
      assert.match(await f.textContent("#view"), /waiting for agreement to sign/);

      await goTo(f, `/plans/${seeded.plans.active}`);
      assert.equal(await title(f), "Quarterly plan");
      const text = await f.textContent("#view");
      assert.match(text, /Signed · Harper Planfolk \(in person\)/);
      assert.match(text, /Book/, "the first visit's job to book");
      assert.match(text, /\$195\.00/, "$295 less the $100 plan discount");
      assert.deepEqual(await screenProblems(f), [], "a plan passes the phone checks");
      assert.deepEqual(await badLinks(f), []);
      await shot(page, `plans-plan-${device}`);
      await f.click("[data-act=cancel]");
      await sheetUp(f, /Cancel the plan/);
      assert.match(await f.textContent(".sheet.on"), /Ends[\s\S]*days' notice in the first term/);
      assert.deepEqual(await screenProblems(f), [], "the cancel calculator passes the phone checks");
      await shot(page, `plans-cancel-${device}`);
      await closeSheet(f);
      await f.click("[data-read]");
      await sheetUp(f, /Quarterly plan agreement/);
      assert.match(await f.textContent(".sheet.on"), /Signed .* by Harper Planfolk/);
      await shot(page, `plans-agreement-read-${device}`);
      await closeSheet(f);

      // a new plan for a customer: pending, its agreement to send
      await goTo(f, `/plans/new/${seeded.contacts.first}`);
      assert.equal(await title(f), "New plan");
      await f.fill("input[name=ext]", "245");
      await f.fill("input[name=int]", "150");
      assert.deepEqual(await screenProblems(f), [], "New plan passes the phone checks");
      await shot(page, `plans-new-${device}`);
      await f.click("[data-new] [type=submit]");
      await f.waitForFunction(() => /^#\/plans\/pl_[0-9a-z]{20}$/.test(location.hash), null, { timeout: 15000 });
      await settled(f);
      assert.match(await f.textContent("#view"), /Waiting for the agreement to sign/);
      assert.ok(await f.$("[data-act=send-agreement]"), "Send to sign");

      await goTo(f, "/plans/due");
      assert.equal(await title(f), "Plan visits to book");
      assert.match(await f.textContent("#view"), /Mound[\s\S]*Harper Planfolk/, "the active plan's first visit, under its town");
      assert.deepEqual(await screenProblems(f), [], "visits to book pass the phone checks");
      await shot(page, `plans-due-${device}`);

      await goTo(f, `/lights/${seeded.seasons.year}`);
      assert.equal(await title(f), `Lights ${seeded.seasons.year}`);
      assert.match(await f.textContent("#view"), /Rowan Planfolk/);
      assert.deepEqual(await screenProblems(f), [], "the lights board passes the phone checks");
      await shot(page, `plans-lights-${device}`);
      await f.click(`[data-season="${seeded.seasons.id}"]`);
      await sheetUp(f, /Rowan Planfolk/);
      assert.ok(await f.$(".sheet.on input[name=bin_id]"));
      assert.deepEqual(await screenProblems(f), [], "the season sheet passes the phone checks");
      await shot(page, `plans-lights-sheet-${device}`);
      await closeSheet(f);

      await goTo(f, "/settings/plans");
      assert.equal(await title(f), "Plans catalog & perks");
      assert.match(await f.textContent("#view"), /Request signatures for 1 plan/, "the lights plan has no signature on file");
      assert.deepEqual(await screenProblems(f), [], "the catalog settings pass the phone checks");
      await shot(page, `plans-settings-${device}`);
      await goTo(f, "/settings/agreement-templates");
      assert.match(await f.textContent("#view"), /Needs approval/, "the one-time lights text waits for the owner");
      await shot(page, `plans-templates-${device}`);
      await goTo(f, `/settings/agreement-templates/${seeded.templates.one_time}`);
      assert.match(await f.textContent("#view"), /Draft, needs owner approval/);
      await f.click("[data-preview]");
      await f.waitForSelector(".pl-doc", { timeout: 5000 });
      assert.deepEqual(await screenProblems(f), [], "an agreement text passes the phone checks");
      await shot(page, `plans-template-${device}`);
      await p.clean();
    } finally { await p.close(); }
  });
}

test("plans: the customer signs from the texted link; the plan turns active", async () => {
  const p = await phone(browser, srv, { device: "iphonese" });
  try {
    const page = p.page;
    await page.goto(seeded.portal.agreement);
    await page.waitForURL(/\/p\/agreement\/ag_[0-9a-z]{20}$/, { timeout: 10000 });
    assert.match(await page.textContent("h1"), /Hi Finley, here's your agreement/);
    assert.match(await page.textContent("main"), /Quarterly plan service agreement/);
    assert.doesNotMatch(await page.textContent("main"), /—/, "no em dashes in the customer's text");
    assert.deepEqual(await portalProblems(page), [], "the agreement page passes the phone checks");
    await shot(page, "plans-portal-agreement");
    await page.click("[data-sign]");
    assert.match(await page.textContent("[data-error]"), /Type your full name/);
    await page.fill("input[name=name_typed]", "Finley Planfolk");
    await draw(page);
    await page.check("input[name=agree]");
    await page.click("[data-sign]");
    await page.waitForSelector("[data-signed]:not([hidden])", { timeout: 15000 });
    assert.match(await page.textContent("[data-signed]"), /Thanks, Finley! You're all signed/);
    await shot(page, "plans-portal-signed");
    // the office: signed and (the listener, on the next lanes tick) active
    const o = await phone(browser, srv);
    try {
      await signIn(o, "olive");
      const plan = await until(async () => { const d = await api(o, `/plans/${seeded.plans.pending}`); return d.plan.status === "active" ? d.plan : null; });
      assert.ok(plan, "the plan turned active once signed");
      assert.equal(plan.agreement_status, "signed");
    } finally { await o.close(); }
    await p.clean();
  } finally { await p.close(); }
});

test("plans: Sign on this phone: the customer signs in person; the link works once", async () => {
  const p = await phone(browser, srv, { device: "iphone13" });
  try {
    await signIn(p, "olive");
    const res = await p.ctx.request.post(`/api/crm/agreements/${seeded.agreements.present}/present`, { headers: { "content-type": "application/json", "x-crm": "1" }, data: {} });
    assert.equal(res.status(), 200);
    const { url } = (await res.json()).data;
    assert.match(url, /^\/p\/sign\/[0-9A-Za-z]+$/);
    const page = p.page;
    const first = await page.goto(url);
    assert.equal(first.status(), 200);
    assert.match(first.headers()["content-security-policy"] || "", /script-src 'self'/, "the portal CSP");
    assert.match(await page.textContent("body"), /Hand the phone to Emerson/);
    assert.deepEqual(await portalProblems(page), [], "the in-person page passes the phone checks");
    await shot(page, "plans-present");
    await page.fill("input[name=name_typed]", "Emerson Planfolk");
    await page.check("input[name=agree]");
    await page.click("[data-sign]");
    await page.waitForSelector("[data-signed]:not([hidden])", { timeout: 15000 });
    assert.ok(await page.$("[data-signed] a[href*='/office#crm/plans/']"), "back to the plan (staff)");
    await shot(page, "plans-present-signed");
    const again = await page.goto(url);
    assert.equal(again.status(), 410, "the link works once");
    const ag = await api(p, `/agreements/${seeded.agreements.present}`);
    assert.equal(ag.status, "signed");
    assert.equal(ag.signature.method, "in_person");
    await p.clean();
  } finally { await p.close(); }
});

test("plans: \"Text me a link\" answers the same whether or not the number is on file", async () => {
  const p = await phone(browser, srv, { device: "iphonese" });
  try {
    const page = p.page;
    const r = await page.goto("/p/login");
    assert.equal(r.status(), 200);
    assert.match(await page.textContent("h1"), /Text me a link/);
    assert.deepEqual(await portalProblems(page), [], "the login page passes the phone checks");
    await shot(page, "plans-login");
    await page.fill("input[name=phone]", "(763) 555-1700");
    await page.click("[data-login-send]");
    await page.waitForSelector("[data-done]:not([hidden])", { timeout: 10000 });
    const answer = await page.textContent("[data-done]");
    assert.match(answer, /If that number is on file, we texted you a link/);
    await shot(page, "plans-login-done");
    // the text (dry-run: the Outbox) goes out from the fast lane
    const o = await phone(browser, srv);
    try {
      await signIn(o, "olive");
      const sent = await until(async () => ((await api(o, `/outbox?contact=${seeded.contacts.plan}`)) || []).find((x) => x.template_key === "portal_login"));
      assert.ok(sent, "a text with the account link");
    } finally { await o.close(); }
    await page.goto("/p/login");
    await page.fill("input[name=phone]", "(763) 555-0199");
    await page.click("[data-login-send]");
    await page.waitForSelector("[data-done]:not([hidden])", { timeout: 10000 });
    assert.equal(await page.textContent("[data-done]"), answer);
    await p.clean();
  } finally { await p.close(); }
});

test("plans: not for a tech", async () => {
  const { p, f } = await open("theo", "iphonese");
  try {
    for (const path of ["/plans", `/plans/${seeded.plans.active}`, "/plans/due", `/lights/${seeded.seasons.year}`, "/settings/plans", "/settings/agreement-templates"]) {
      await goTo(f, path);
      assert.match(await f.textContent("#view"), /Not for this login/, `${path} is not for a tech`);
    }
    for (const path of ["/plans", `/plans/${seeded.plans.active}`, "/agreements", `/lights/seasons/${seeded.seasons.year}`]) {
      const r = await p.ctx.request.get("/api/crm" + path, { headers: { "x-crm": "1" } });
      assert.equal(r.status(), 403, path);
    }
    await p.clean();
  } finally { await p.close(); }
});
