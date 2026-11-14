// Phone checks of the customer's account and the "on the way" page
// (portal/account.mjs, portal/track.mjs) and the property's counts with
// Re-quote (contacts assets.mjs): the hub from a texted link, upcoming
// visits, history with the tech's before and after photos, the plan,
// request work with a photo, ask to move a visit, your info and text
// choices; the tracking page with its live dot; the office's Counts card
// and a re-quote priced in one tap. iPhone 13 and iPhone SE sizes, no
// console errors or CSP violations, no sideways scroll, 44 px taps.
// `node --test tests/e2e/portal.spec.mjs` (part of `npm run e2e`).
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { start } from "./server.mjs";
import { launch, phone, signIn, crmFrame, goTo, settled, title, screenProblems, shot, noInstallCard } from "./kit.mjs";
import { seedPortal } from "./portal-seed.mjs";

let srv, browser, seeded, P;

// The customer's pages have no #view: the same checks over their main.
const portalProblems = (page) => page.evaluate(() => {
  const out = [];
  if (document.documentElement.scrollWidth > innerWidth + 1) out.push(`scrolls sideways (${document.documentElement.scrollWidth} > ${innerWidth})`);
  for (const el of document.querySelectorAll("main a, main button, main input:not([type=checkbox]):not([type=radio]):not([type=file]), main textarea, main select")) {
    const r = el.getBoundingClientRect();
    if (!r.width || !r.height || el.closest("[hidden]")) continue;
    const box = el.closest("label") ? el.closest("label").getBoundingClientRect() : r;
    if (box.height < 43.5 || box.width < 43.5) out.push(`small tap target ${el.tagName.toLowerCase()} "${(el.textContent || el.name || "").trim().slice(0, 24)}" ${Math.round(box.width)}x${Math.round(box.height)}`);
  }
  for (const el of document.querySelectorAll("main input[type=checkbox]")) {
    const l = el.closest("label");
    if (l && l.getBoundingClientRect().height < 43.5) out.push(`small checkbox row "${l.textContent.trim().slice(0, 24)}"`);
  }
  for (const i of document.querySelectorAll("main input:not([type=checkbox]):not([type=radio]), main textarea, main select")) {
    if (i.offsetParent && parseFloat(getComputedStyle(i).fontSize) < 16) out.push(`input under 16 px: ${i.name}`);
  }
  for (const el of document.querySelectorAll("main h1, main h2, main p, main b, main small")) {
    if (el.scrollWidth > el.clientWidth + 1 && getComputedStyle(el).overflow !== "visible") out.push(`cut off: "${el.textContent.trim().slice(0, 30)}"`);
  }
  return out;
});

// A made-up window, before and after (JPEG bytes drawn by the browser).
async function windowPhoto(b, dirty) {
  const ctx = await b.newContext({ viewport: { width: 480, height: 480 } });
  const page = await ctx.newPage();
  const spots = dirty ? Array.from({ length: 70 }, (_, i) => `<i style="left:${(i * 37) % 440 + 20}px;top:${(i * 53) % 440 + 20}px;width:${6 + (i % 5) * 3}px;height:${6 + (i % 4) * 3}px"></i>`).join("") : "";
  await page.setContent(`<style>body{margin:0;background:#c9b79c}.f{position:absolute;inset:20px;background:#fff;padding:16px;display:grid;grid-template-columns:1fr 1fr;gap:12px}.g{background:linear-gradient(160deg,#9fd3f5,#e3f3fd 60%,#bfe3f8);${dirty ? "filter:saturate(.35) brightness(.86)" : ""}}i{position:absolute;border-radius:50%;background:rgba(120,110,90,.45)}</style><div class="f"><div class="g"></div><div class="g"></div><div class="g"></div><div class="g"></div></div>${spots}`);
  const buf = await page.screenshot({ type: "jpeg", quality: 80 });
  await ctx.close();
  return new Uint8Array(buf);
}

before(async () => {
  srv = await start();
  seeded = await srv.seed();
  browser = await launch();
  P = await seedPortal(seeded, { photos: { before: await windowPhoto(browser, true), after: await windowPhoto(browser, false) } });
});
after(async () => { await browser?.close(); await srv?.close(); });

const text = async (page) => (await page.textContent("main")) || "";

for (const device of ["iphone13", "iphonese"]) {
  test(`portal (${device}): the hub from a texted link, visits, history with photos, the plan, request work, move a visit, your info`, async () => {
    const p = await phone(browser, srv, { device });
    try {
      const page = p.page;
      await page.goto(P.hub[device]);
      await page.waitForURL(/\/p\/hub$/, { timeout: 10000 });
      let t = await text(page);
      assert.match(t, /Hi Harper!/);
      assert.match(t, /On the way/, "today's visit shows Theo on the way");
      assert.match(t, /To pay[\s\S]*\$243\.10 due/);
      assert.match(t, /Quarterly plan/);
      assert.doesNotMatch(t, /Example Ave|—|licensed/i, "no address; Barta's voice");
      assert.deepEqual(await portalProblems(page), [], "the hub passes the phone checks");
      await shot(page, `portal-hub-${device}`);

      await page.click("a.tile[href='/p/visits']");
      await page.waitForURL(/\/p\/visits$/);
      t = await text(page);
      assert.ok((t.match(/Arriving between/g) || []).length >= 3, t);
      assert.match(t, /With Theo/);
      assert.deepEqual(await portalProblems(page), [], "visits pass");
      await shot(page, `portal-visits-${device}`);

      await page.goto("/p/history");
      t = await text(page);
      assert.match(t, /Exterior window cleaning and screens/);
      assert.ok(await page.$(`img[src*='${P.photos.before}']`), "the before photo");
      assert.ok(await page.$(`img[src*='${P.photos.after}']`), "the after photo");
      assert.equal(await page.$(`img[src*='${P.photos.issue}']`), null, "the issue photo stays with the office");
      await page.waitForFunction(() => [...document.querySelectorAll(".photos img")].every((i) => i.complete && i.naturalWidth > 0), null, { timeout: 10000 });
      assert.match(t, /Invoices and receipts/);
      assert.deepEqual(await portalProblems(page), [], "history passes");
      await shot(page, `portal-history-${device}`);

      await page.goto("/p/plan");
      t = await text(page);
      assert.match(t, /What's included[\s\S]*Exterior Window Cleaning/);
      assert.match(t, /Unlimited Touch-Ups/);
      assert.match(t, /\$50\.00 late fee/);
      assert.deepEqual(await portalProblems(page), [], "the plan passes");
      await shot(page, `portal-plan-${device}`);

      // request work with a photo
      await page.goto("/p/request");
      await page.check("input[name=services][value=gutters]");
      await page.check("input[name=services][value=screens]");
      await page.fill("textarea[name=notes]", "Synthetic: the back gutters overflow when it rains.");
      await page.setInputFiles("[data-photos]", { name: "gutter.jpg", mimeType: "image/jpeg", buffer: Buffer.from(await windowPhoto(browser, true)) });
      await page.waitForSelector("[data-photo-previews] img", { timeout: 10000 });
      assert.deepEqual(await portalProblems(page), [], "request work passes");
      await shot(page, `portal-request-${device}`);
      await page.click("[data-send]");
      await page.waitForURL(/\/p\/request\?sent=1$/, { timeout: 20000 });
      assert.match(await text(page), /Got it, thanks!/);

      // ask to move next week's visit (more than 24 hours away)
      await page.goto(`/p/visits/${P.next}/reschedule`);
      t = await text(page);
      assert.match(t, /Moving it is free with at least 24 hours' notice/);
      const d = await page.$eval("input[name=date1]", (el) => el.min);
      await page.fill("input[name=date1]", d.replace(/\d{2}$/, (x) => String(Math.min(28, Number(x) + 9)).padStart(2, "0")));
      assert.deepEqual(await portalProblems(page), [], "reschedule passes");
      await shot(page, `portal-reschedule-${device}`);
      await page.click("[data-reschedule-form] button[type=submit]");
      await page.waitForURL(/reschedule\?sent=1$/, { timeout: 15000 });
      assert.match(await text(page), /your visit stays where it is/i);

      // your info: a text choice saves as it's flipped
      await page.goto("/p/account");
      t = await text(page);
      assert.match(t, /\(763\) •••-/);
      await page.click("[data-pref=sms_marketing]");
      await page.waitForSelector("[data-pref-done]:not([hidden])", { timeout: 10000 });
      assert.equal(await page.isChecked("[data-pref=sms_marketing]"), device === "iphone13", "deals by text: on (the second phone turns it back off)");
      assert.deepEqual(await portalProblems(page), [], "your info passes");
      await shot(page, `portal-account-${device}`);
      await p.clean();
    } finally { await p.close(); }
  });

  test(`portal (${device}): the tracking link shows Theo on the way with a live dot, no address, then the start ends it`, async () => {
    const p = await phone(browser, srv, { device });
    try {
      const page = p.page;
      const res = await page.goto(P.track);
      assert.equal(res.status(), 200);
      assert.match(res.headers()["content-security-policy"] || "", /script-src 'self'/);
      const t = await text(page);
      assert.match(t, /Theo is on the way/);
      assert.match(t, /About \d+ minutes? away/);
      assert.match(t, /Look for a white Ford Transit\./);
      assert.match(t, /Arriving between 10:00 AM and 12:00 PM/);
      assert.doesNotMatch(t, /Example Ave|Planfolk|—/);
      await page.waitForSelector("[data-tk-map] svg circle", { timeout: 5000 });
      const box = await page.$eval("[data-tk-map] svg", (s) => { const r = s.getBoundingClientRect(); return [r.width, r.height]; });
      assert.ok(box[0] > 280 && box[1] > 150, `the map is drawn (${box})`);
      assert.deepEqual(await portalProblems(page), [], "the tracking page passes the phone checks");
      await shot(page, `portal-track-${device}`);
      await p.clean();
    } finally { await p.close(); }
  });

  test(`office (${device}): the property's counts for quoting and Re-quote priced in one tap`, async () => {
    const p = await phone(browser, srv, { device });
    try {
      await signIn(p, "olive");
      await p.page.goto("/office");
      const f = await crmFrame(p.page);
      await settled(f);
      await noInstallCard(p.page);
      await goTo(f, `/properties/${P.property}`);
      await f.waitForSelector("[data-counts]", { timeout: 10000 });
      const card = await f.textContent("[data-counts]");
      assert.match(card, /Standard\s*22/);
      assert.match(card, /Ladder \(feet\)\s*28/);
      assert.deepEqual(await screenProblems(f), [], "the property passes the phone checks");
      await shot(p.page, `portal-counts-${device}`);
      // edit the counts
      await f.click("[data-edit-counts]");
      await f.waitForSelector(".sheet.on #pr-counts", { timeout: 5000 });
      assert.deepEqual(await screenProblems(f), [], "the counts sheet passes");
      await shot(p.page, `portal-counts-edit-${device}`);
      await f.click(".sheet.on [data-sheet-x]");
      await f.waitForFunction(() => !document.querySelector(".sheet"), null, { timeout: 5000 });
      // Re-quote: the builder opens filled from the counts and prices itself
      await f.click("[data-requote]");
      await f.waitForFunction(() => /Filled from the property's counts/.test(document.getElementById("view").textContent), null, { timeout: 10000 });
      await f.waitForFunction(() => /Quarterly plan/.test(document.getElementById("view").textContent) && document.querySelectorAll(".qb-lines li").length > 0, null, { timeout: 15000 });
      assert.equal(await title(f), "New quote");
      assert.match(await f.textContent("[data-panes]"), /^38$/, "the weighted panes from the counted windows");
      assert.deepEqual(await screenProblems(f), [], "the re-quote passes");
      await shot(p.page, `portal-requote-${device}`);
      await p.clean();
    } finally { await p.close(); }
  });
}
