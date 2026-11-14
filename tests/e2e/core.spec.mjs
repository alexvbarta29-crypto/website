// Phone checks of the shell (design §11.4 M1.4 "core.spec.mjs", §12.4,
// §2.4, §2.5, §9.4): Barta Office as one app, back navigation, sheets, the
// offline start, links, the insets message, a slow network. Chromium at
// iPhone sizes against tests/e2e/server.mjs. Run with `npm run e2e`.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { start } from "./server.mjs";
import { launch, phone, signIn, crmFrame, goTo, settled, title, hashOf, backShown, badLinks, swipe, frameOffset, screenProblems, shot, noInstallCard, tap, OFFICE_PASSWORD } from "./kit.mjs";

let srv, browser, seeded;
before(async () => { srv = await start(); browser = await launch(); });
after(async () => { await browser?.close(); await srv?.close(); });

const PASS = "a long synthetic passphrase";

test("one app: office sign-in → first-owner setup (the office password again) → Home", async () => {
  const p = await phone(browser, srv);
  try {
    const { page } = p;
    await page.goto("/office");
    // before the CRM has an owner only the office password shows
    await page.fill("#pw", OFFICE_PASSWORD);
    await Promise.all([page.waitForNavigation(), page.click("#office button[type=submit]")]);
    // the office cookie alone, no owner yet: the CRM fills the screen with its setup
    assert.equal(await page.$(".bar .nav"), null, "no tab row: one app");
    const setupFrame = await (async () => {
      for (let i = 0; i < 100; i++) {
        const f = page.frames().find((x) => x.url().endsWith("/crm/setup"));
        if (f && (await f.$("#setup"))) return f;
        await page.waitForTimeout(100);
      }
      throw new Error("no setup screen: " + page.frames().map((x) => x.url()).join(", "));
    })();
    assert.match(await setupFrame.textContent("label.field"), /Office password/, "automatic setup asks for the office password, not a setup code");
    await shot(page, "core-setup");
    await setupFrame.fill("#setup_code", OFFICE_PASSWORD);
    await setupFrame.fill("#name", "Olive Owner");
    await setupFrame.fill("#login", "olive");
    await setupFrame.fill("#password", PASS);
    await Promise.all([page.waitForNavigation(), setupFrame.click("#go")]);
    const f = await crmFrame(page);
    await settled(f);
    assert.equal(await title(f), "Home");
    assert.equal(await page.$(".bar .nav"), null, "still one app");
    // the office's bar (Nov 2026, Flyra's): Home · Schedule · Inbox · Map · Menu (the Dashboard's numbers are on Home, its views in the Menu)
    assert.deepEqual(await f.$$eval("#tabs [data-tab]", (els) => els.map((e) => e.querySelector("span").textContent)), ["Home", "Schedule", "Inbox", "Map", "Menu"]);
    assert.equal(await f.$('.tabs [data-tab="dashboard"], .tabs [data-more]'), null, "no Dashboard tab, no More sheet");
    await p.clean();
  } finally {
    await p.close();
  }
  seeded = await srv.seed();
});

// The CRM inside /office for this phone: an owner with the office sign-in, or as given.
async function office(opts = {}, login = "olive", hash = "") {
  const p = await phone(browser, srv, opts);
  if (login) await signIn(p, login);
  await p.page.goto("/office" + hash);
  const f = await crmFrame(p.page);
  await settled(f);
  return { p, page: p.page, f };
}
const frameUrls = (page) => page.frames().map((x) => x.url()).filter((u) => /^https?:/.test(u));

test("one app: the Dashboard (Menu → Reports) switches its views in place; Menu stays lit", async () => {
  const { p, page, f } = await office({ office: true });
  try {
    // the Menu is a sheet (Flyra's): its Reports row opens the Dashboard
    await noInstallCard(page);
    await f.click('#tabs [data-tab="menu"]');
    await f.waitForSelector(".menu-sheet.on");
    await f.click('.menu-sheet a[href="#/dashboard"]');
    await settled(f, { hash: "#/dashboard" });
    assert.equal(await hashOf(f), "#/dashboard");
    assert.equal(await f.getAttribute('#tabs [data-tab="menu"]', "aria-current"), "page", "the Menu tab is lit");
    assert.equal(await backShown(f), false, "a screen the Menu lists is top-level (Flyra's): no back button");
    // (a frame that hasn't loaded anything yet has no URL)
    const dash = () => page.frames().find((x) => { try { return new URL(x.url()).pathname === "/dashboard"; } catch (e) { return false; } });
    await page.waitForFunction(() => true);
    for (let i = 0; i < 50 && !(dash() && new URL(dash().url()).hash === "#overview"); i++) await page.waitForTimeout(100);
    assert.equal(new URL(dash().url()).hash, "#overview");
    await f.click('[data-view="money"]');
    for (let i = 0; i < 50 && new URL(dash().url()).hash !== "#money"; i++) await page.waitForTimeout(100);
    assert.equal(new URL(dash().url()).hash, "#money", "the frame switched view");
    assert.equal(await hashOf(f), "#/dashboard", "in place: the CRM screen is still the Dashboard");
    assert.equal(await f.getAttribute('[data-view="money"]', "aria-pressed"), "true");
    assert.equal(await f.getAttribute('#tabs [data-tab="menu"]', "aria-current"), "page");
    // /dashboard/:view opens one view directly (old #money links land there)
    await goTo(f, "/dashboard/jobs");
    assert.equal(await f.getAttribute('[data-view="jobs"]', "aria-pressed"), "true");
    await shot(page, "core-dashboard");
    // back from the Dashboard: the Menu
    await goTo(f, "/menu");
    await goTo(f, "/dashboard");
    await f.click("#top-back");
    await settled(f, { hash: "#/menu" });
    await p.clean();
  } finally { await p.close(); }
});

test("one app: a Menu tool (Light Studio) opens in a frame under the CRM's header; Rotor opens a new tab", async () => {
  const { p, page, f } = await office({ office: true });
  try {
    // the Menu page (old #/menu links; Rotor's More): five groups and Settings, every screen once, Sign out at the bottom
    await goTo(f, "/menu");
    const groups = await f.$$eval(".menu-page .ms-grp", (els) => els.map((e) => [(e.querySelector(".ms-h") || {}).textContent || "", [...e.querySelectorAll(".ms-l")].map((x) => x.textContent)]));
    const all = await f.$$eval(".menu-page .ms-l, .menu-page .ms-tile span", (els) => els.map((e) => e.textContent));
    const of = (name) => (groups.find(([h]) => h === name) || [null, []])[1];
    assert.deepEqual(groups.map(([h]) => h), ["Work", "Sales", "Customers", "Money", "Marketing & messages", ""], JSON.stringify(groups));
    assert.ok(of("Sales").includes("Light Studio") && of("Money").includes("Purchases") && of("Marketing & messages").includes("Giveaway"), JSON.stringify(groups));
    for (const want of ["Customers", "Leads", "Pipeline", "Calls", "Quotes", "Plans", "Leaderboard", "My performance", "Reports",
      "Tasks", "Jobs", "Lights season", "Merge review", "Outbox", "Approvals", "Settings"]) assert.ok(all.includes(want), `the Menu lists ${want}: ${all.join(", ")}`);
    for (const gone of ["Home", "Schedule", "Inbox", "Visits", "To book", "Follow-ups", "Leads & calls", "Templates", "Automations", "Activity", "Team", "Tab bar", "Import from Rotor", "Rotor"]) assert.ok(!all.includes(gone), `${gone} is on the bar, merged, or in Settings: ${all.join(", ")}`);
    assert.equal(new Set(all).size, all.length, "each once");
    assert.ok(await f.$("[data-signout]"), "Sign out at the bottom");
    assert.deepEqual(await screenProblems(f), [], "the Menu passes the phone checks");
    await shot(page, "core-menu");
    await f.click('.menu-page a[href="#/tools/lights"]');
    await settled(f, { hash: "#/tools/lights" });
    assert.equal(await hashOf(f), "#/tools/lights");
    assert.equal(await title(f), "Lights");
    for (let i = 0; i < 50 && !frameUrls(page).some((u) => new URL(u).pathname === "/lights"); i++) await page.waitForTimeout(100);
    assert.ok(frameUrls(page).some((u) => new URL(u).pathname === "/lights"), "the Lights page loads in a frame");
    await shot(page, "core-tool-lights");
    // Settings: one hub; the setup screens and Rotor live there
    await goTo(f, "/settings");
    const heads = await f.$$eval("#view .set-hub .section-h", (els) => els.map((e) => e.textContent));
    assert.deepEqual(heads, ["Company", "Team & permissions", "Pricing & services", "Plans & agreements", "Schedule", "Messages & automations", "Payments", "Maps & door to door", "Import & data", "Appearance", "About"]);
    for (const path of ["/templates", "/automations", "/team", "/activity", "/import", "/tab-bar", "/tools/rotor", "/settings/schedule"]) assert.ok(await f.$(`#view a[href="#${path}"]`), `Settings opens ${path}`);
    assert.deepEqual(await screenProblems(f), [], "Settings passes the phone checks");
    await shot(page, "core-settings");
    // an old link to a merged screen opens the one it became
    await f.evaluate(() => { location.hash = "/visits"; });
    for (let i = 0; i < 50 && !(await hashOf(f)).startsWith("#/schedule"); i++) await page.waitForTimeout(100);
    assert.equal(await hashOf(f), "#/schedule?view=list", "Visits is the Schedule's List");
    await goTo(f, "/tools/rotor");
    assert.deepEqual(await badLinks(f), []);
    // a new tab (this harness stops the request itself, so Rotor never sees it)
    const [tab] = await Promise.all([p.ctx.waitForEvent("page"), f.click("a.btn.primary")]);
    for (let i = 0; i < 30 && !p.outside.some((u) => u.startsWith("https://app.getrotor.com")); i++) await page.waitForTimeout(100);
    assert.ok(p.outside.some((u) => u.startsWith("https://app.getrotor.com")), "the new tab asked for Rotor");
    assert.equal(await tab.evaluate(() => !!window.opener).catch(() => false), false, "noopener");
    assert.ok(page.url().startsWith(srv.url + "/office"), "the app stays put");
    await tab.close();
    await p.clean();
  } finally { await p.close(); }
});

test("one app: an old /office#lights link opens Lights inside the CRM (office sign-in only)", async () => {
  const { p, page, f } = await office({ office: true }, "olive", "#lights");
  try {
    for (let i = 0; i < 50 && (await hashOf(f)) !== "#/tools/lights"; i++) await page.waitForTimeout(100);
    assert.equal(await hashOf(f), "#/tools/lights");
    assert.equal(await page.$(".bar .nav"), null, "no tab row");
    await page.goto("/office#money");
    const g = await crmFrame(page);
    for (let i = 0; i < 50 && (await hashOf(g)) !== "#/dashboard/money"; i++) await page.waitForTimeout(100);
    assert.equal(await hashOf(g), "#/dashboard/money");
    await p.clean();
  } finally { await p.close(); }
});

test("one app: a tech never sees the office tools", async () => {
  const { p, page, f } = await office({}, "theo");
  try {
    const tabs = await f.$$eval("#tabs [data-tab]", (els) => els.map((e) => e.dataset.tab));
    assert.ok(!tabs.includes("dashboard") && !tabs.includes("more") && !tabs.includes("menu") && !tabs.includes("home"), `a tech's tabs: ${tabs.join(", ")}`);
    assert.equal(await title(f), "Today", "a tech keeps their own day");
    for (const path of ["/tools/lights", "/tools/rotor", "/dashboard", "/dashboard/money", "/legacy/customers", "/contacts"]) {
      await goTo(f, path);
      assert.match(await f.textContent("#view"), /Not for this login/, `${path} is not for a tech`);
      assert.ok(!frameUrls(page).some((u) => /\/(lights|dashboard|playbook|purchases)(\?|$|#)/.test(new URL(u).pathname + new URL(u).search)), `no office tool frame for ${path}`);
    }
    // an old tab link lands on the CRM, never a tool
    await page.goto("/office#lights");
    const g = await crmFrame(page);
    await settled(g);
    assert.ok(!frameUrls(page).some((u) => new URL(u).pathname === "/lights"), "no Lights frame");
    assert.equal(await page.$(".bar .nav"), null, "no tab row");
    // and the tools themselves send a CRM-only session back to /office
    for (const path of ["/lights", "/dashboard", "/playbook", "/purchases"]) {
      const body = await (await p.ctx.request.get(path, { maxRedirects: 0 })).text();
      assert.ok(body.includes("Sign in to Barta Office") && body.length < 600, `${path} without the office sign-in is the bounce page`);
    }
    await shot(page, "core-tech-today");
    await p.clean();
  } finally { await p.close(); }
});

test("the CSP listener is real: an inline script in the CRM is blocked and reported", async () => {
  const { p, f } = await office({}, "theo");
  try {
    assert.deepEqual(await p.csp(), []);
    await f.evaluate(() => { const sc = document.createElement("script"); sc.textContent = "window.__ran = 1"; document.head.appendChild(sc); });
    for (let i = 0; i < 20 && !(await p.csp()).length; i++) await p.page.waitForTimeout(50);
    assert.equal(await f.evaluate(() => window.__ran), undefined, "script-src 'self' blocked it");
    assert.match((await p.csp()).join(" "), /script-src/, "and every test's clean() would have failed on it");
  } finally { await p.close(); }
});

test("back arrow and edge swipe follow the stack, and the declared parent from a deep link", async () => {
  const id = seeded.contacts.customer;
  const { p, page, f } = await office({}, "olive", `#crm/contacts/${id}`);
  try {
    await noInstallCard(page);
    assert.equal(await hashOf(f), `#/contacts/${id}`, "the deep link opened the contact");
    assert.equal(await backShown(f), true, "a back arrow: the route's parent");
    await f.click("#top-back");
    await settled(f, { hash: "#/contacts" });
    assert.equal(await hashOf(f), "#/contacts", "back from a deep link goes to the declared parent");
    assert.equal(await backShown(f), false, "a tab root has no back arrow");
    // the list keeps its search and scroll when you come back (a phone: the round search button opens the field)
    if (!(await f.isVisible("#ct-q"))) await f.click('#top-rnd [data-own="find"]');
    await f.fill("#ct-q", "example");
    await page.waitForTimeout(400);
    const rows = await f.$$("#ct-list a.cc-top");
    assert.ok(rows.length > 10, `the search finds people (${rows.length})`);
    await f.evaluate(() => { document.getElementById("ct-scroll").scrollTop = 300; });
    await page.waitForTimeout(150);
    const scrolled = await f.evaluate(() => document.getElementById("ct-scroll").scrollTop);
    const row = await f.$$eval("#ct-list a.cc-top", (as) => { const a = as.find((x) => x.getBoundingClientRect().top > 220); return a.getAttribute("href"); });
    await tap(page, f, `#ct-list a.cc-top[href="${row}"]`);
    await settled(f, { hash: row });
    // the edge swipe: a touch from the left edge, 170 px to the right
    const o = await frameOffset(page, f);
    await swipe(page, { x: o.x + 4, y: o.y + 420 }, { x: o.x + 170, y: o.y + 430 });
    await settled(f, { hash: "#/contacts" });
    assert.equal(await f.inputValue("#ct-q"), "example", "the search is kept");
    const back = await f.evaluate(() => document.getElementById("ct-scroll").scrollTop);
    assert.ok(Math.abs(back - scrolled) < 40, `the scroll is kept (${back} vs ${scrolled})`);
    // a swipe that starts away from the edge does nothing
    await tap(page, f, `#ct-list a.cc-top[href="${row}"]`);
    await settled(f, { hash: row });
    await swipe(page, { x: o.x + 120, y: o.y + 420 }, { x: o.x + 300, y: o.y + 430 });
    await page.waitForTimeout(400);
    assert.equal(await hashOf(f), row, "not from the edge: no back");
    // a deeper deep link (a fresh start, as from a notification) walks up its parents: log a call → the contact → Contacts
    await page.goto("about:blank");
    await page.goto(`/office#crm/calls/log/${id}`);
    const g = await crmFrame(page);
    await settled(g);
    assert.equal(await hashOf(g), `#/calls/log/${id}`);
    await g.click("#top-back");
    await settled(g, { hash: `#/contacts/${id}` });   // the parent /contacts/:contact, filled in
    const o2 = await frameOffset(page, g);
    await swipe(page, { x: o2.x + 4, y: o2.y + 420 }, { x: o2.x + 170, y: o2.y + 430 });
    await settled(g, { hash: "#/contacts" });
    // the shell's address follows the CRM (crm:route)
    for (let i = 0; i < 20 && !page.url().endsWith("#crm/contacts"); i++) await page.waitForTimeout(100);
    assert.ok(page.url().endsWith("#crm/contacts"), `/office mirrors the CRM's screen (${page.url()})`);
    await p.clean();
  } finally { await p.close(); }
});

test("sheets close on the close button, on a swipe down and on back", async () => {
  const { p, page, f } = await office({}, "olive");
  try {
    const open = () => f.$$eval(".sheet", (els) => els.filter((e) => e.classList.contains("on")).length);
    const gone = async () => { for (let i = 0; i < 30 && (await f.$(".sheet")); i++) await page.waitForTimeout(50); return !(await f.$(".sheet")); };
    // the close button on the Menu sheet (Nov 2026: the + is an overlay, the Menu a sheet)
    assert.equal(!!(await f.$("#fab")), true, "Home: the + button");
    await goTo(f, "/contacts");
    await f.click('#tabs [data-tab="menu"]');
    await f.waitForSelector(".sheet.on");
    assert.equal(await open(), 1);
    assert.deepEqual(await screenProblems(f), [], "the sheet passes the phone checks");
    await shot(page, "core-sheet");
    await f.click(".sheet [data-sheet-x]");
    assert.ok(await gone(), "the close button closes it");
    // a swipe down from the sheet's head
    await f.click('#tabs [data-tab="menu"]');
    await f.waitForSelector(".sheet.on");
    await page.waitForTimeout(300);
    const o = await frameOffset(page, f);
    const headAt = () => f.$eval(".sheet .sheet-head", (h) => { const r = h.getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 }; });
    const h1 = await headAt();
    await swipe(page, { x: o.x + h1.x, y: o.y + h1.y }, { x: o.x + h1.x, y: o.y + h1.y + 220 });
    assert.ok(await gone(), "a swipe down closes it");
    // a short drag springs back
    await f.click('#tabs [data-tab="menu"]');
    await f.waitForSelector(".sheet.on");
    await page.waitForTimeout(300);
    const h2 = await headAt();
    await swipe(page, { x: o.x + h2.x, y: o.y + h2.y }, { x: o.x + h2.x, y: o.y + h2.y + 40 });
    await page.waitForTimeout(350);
    assert.equal(await open(), 1, "40 px is not enough to close");
    // back (the edge swipe) closes the sheet before leaving the screen
    const before = await hashOf(f);
    await swipe(page, { x: o.x + 4, y: o.y + 300 }, { x: o.x + 170, y: o.y + 310 });
    assert.ok(await gone(), "the edge swipe closes the sheet first");
    assert.equal(await hashOf(f), before, "and stays on the screen");
    await p.clean();
  } finally { await p.close(); }
});

test("every external and /p/ link opens a new tab", async () => {
  const { p, page, f } = await office({ office: true }, "olive");
  try {
    const screens = ["/today", "/menu", "/contacts", `/contacts/${seeded.contacts.customer}`, `/contacts/${seeded.contacts.lead}`, "/calls", `/enrollments/${seeded.enrollments.called}`, "/tasks", "/me", "/settings", "/settings/integrations", "/settings/lead-hooks", "/templates", "/outbox", "/import", "/team", "/tools/rotor", "/legacy/customers"];
    const bad = [];
    for (const s of screens) {
      await goTo(f, s);
      for (const l of await badLinks(f)) bad.push(`${s}: ${l}`);
    }
    assert.deepEqual(bad, []);
    // the office password alone once the CRM has owners: Team sign-in only (no tab row, no links out)
    const q = await phone(browser, srv, { office: true });
    try {
      await q.page.goto("/office");
      await q.page.waitForSelector("#team");
      assert.equal(await q.page.$(".bar, [data-tool]"), null, "no tab row");
      assert.deepEqual(await q.page.$$eval("a[href^=http]", (as) => as.map((a) => a.href)), []);
      await q.clean();
    } finally { await q.close(); }
    await p.clean();
  } finally { await p.close(); }
});

// What this phone keeps for a start with no signal (office-sw.js, crm-sw.js).
async function kept(page) {
  return page.evaluate(async () => {
    const out = {};
    for (const name of await caches.keys()) out[name] = (await (await caches.open(name)).keys()).map((r) => new URL(r.url).pathname);
    return out;
  });
}
async function keptOffline(page, { timeout = 15000 } = {}) {
  const deadline = Date.now() + timeout;
  let k = {};
  while (Date.now() < deadline) {
    k = await kept(page);
    const office = Object.entries(k).find(([n]) => n.startsWith("barta-office-"));
    const app = Object.entries(k).find(([n]) => n.startsWith("crm-app-"));
    if (office && office[1].includes("/office/launch") && app && app[1].includes("/crm-app/main.js") && (k["crm-shell"] || []).includes("/crm")) return k;
    await page.waitForTimeout(250);
  }
  return k;
}

test("cold start with no signal: after one online visit, /office opens the CRM shell from this phone's copy", async () => {
  const { p, page, f } = await office({}, "theo");
  try {
    assert.equal(await title(f), "Today");
    const k = await keptOffline(page);
    assert.ok((k["crm-shell"] || []).includes("/crm"), `the CRM shell is kept after one online visit (caches: ${JSON.stringify(Object.fromEntries(Object.entries(k).map(([n, v]) => [n, v.length])))})`);
    assert.ok(!Object.values(k).flat().some((u) => u.startsWith("/api/")), "nothing under /api/ is ever cached");
    await p.ctx.setOffline(true);
    await page.goto("/office");
    // the launcher: a full-screen CRM frame and the Offline strip
    await page.waitForSelector("#off:not([hidden])", { timeout: 10000 });
    assert.match(await page.textContent("#off"), /Offline/);
    const g = await crmFrame(page);
    await g.waitForSelector("#tabs [data-tab]", { timeout: 10000 });
    assert.equal(await title(g), "Today", "the tech's Today, from the cached shell");
    // "Offline": the app's banner, or the tech's Today's own line (which the banner steps aside for) once the tech app (M4b) is on the phone
    await g.waitForFunction(() => {
      const b = document.querySelector("#banner");
      return !!document.querySelector(".tf-own-offline") || (!!b && !b.hidden && /Offline/.test(b.textContent));
    }, null, { timeout: 10000 });
    await shot(page, "core-offline-start");
    // back online: the launcher goes to the real office by itself
    await p.ctx.setOffline(false);
    await page.waitForFunction(() => !document.getElementById("off"), null, { timeout: 10000 });
    const h = await crmFrame(page);
    await settled(h);
    assert.equal(await page.$("#off"), null, "the real /office, not the launcher");
    await p.clean();
  } finally { await p.close(); }
});

test("the office tells the CRM frame its safe areas (office:insets)", async () => {
  const { p, page, f } = await office({}, "theo");
  try {
    // a phone with a notch and a home bar: the probe reads env(safe-area-inset-*), which a desktop browser keeps at 0
    await page.addStyleTag({ content: "#sa-probe{padding:47px 0 34px 0 !important}" });
    await page.setViewportSize({ width: 390, height: 843 });
    await f.waitForFunction(() => getComputedStyle(document.documentElement).getPropertyValue("--sab").trim() === "34px", null, { timeout: 5000 });
    const got = await f.evaluate(() => {
      const cs = getComputedStyle(document.documentElement);
      const tabs = document.getElementById("tabs").getBoundingClientRect();
      return { top: cs.getPropertyValue("--sat").trim(), bottom: cs.getPropertyValue("--sab").trim(), tabsPad: getComputedStyle(document.getElementById("tabs")).paddingBottom, tabsBottom: Math.round(tabs.bottom), h: innerHeight, topPad: getComputedStyle(document.querySelector(".top")).paddingTop };
    });
    assert.equal(got.top, "47px", "solo: the CRM's own top bar takes the notch");
    // the floating pill (Nov 2026, Flyra's) sits just above the home bar
    assert.equal(got.topPad, "47px");
    assert.equal(got.tabsBottom, got.h - 34 - 4, "the tab bar floats above the home bar, fully on screen");
    await shot(page, "core-insets");
    await p.clean();
  } finally { await p.close(); }
});

test("the shell starts under a 2 s round trip: from this phone's copy at once, data when it comes", async () => {
  const { p, page } = await office({}, "theo");
  try {
    await keptOffline(page);
    srv.setLatency(2000);                       // every answer waits 2 s: page and service workers alike
    const t0 = Date.now();
    await page.goto("/crm", { waitUntil: "commit", timeout: 30000 });
    await page.waitForSelector("#tabs [data-tab]", { timeout: 20000 });
    const shellMs = Date.now() - t0;
    assert.ok(await page.$("#view [aria-busy=true]"), "a skeleton while the data is on its way");
    await page.waitForFunction(() => { const v = document.getElementById("view"); return v && v.children.length && !v.querySelector("[aria-busy=true]"); }, null, { timeout: 30000 });
    assert.ok(shellMs < 1500, `the shell and tab bar show before the first answer could arrive (${shellMs} ms)`);
    assert.equal(await page.textContent("#top-title"), "Today");
    assert.equal(await page.$("#view [data-retry]"), null, "no error card");
    await shot(page, "core-slow-start");
  } finally { srv.setLatency(0); await p.close(); }
});

test("the first start on a slow line (2 s round trip, nothing kept yet) still gets there, skeleton first", async () => {
  const p = await phone(browser, srv, { serviceWorkers: "block" });
  try {
    await signIn(p, "olive");
    srv.setLatency(2000);
    await p.page.goto("/crm", { waitUntil: "commit", timeout: 30000 });
    await p.page.waitForSelector("#view [aria-busy=true]", { timeout: 30000 });
    await p.page.waitForFunction(() => { const v = document.getElementById("view"); return v && v.children.length && !v.querySelector("[aria-busy=true]"); }, null, { timeout: 60000 });
    assert.equal(await p.page.textContent("#top-title"), "Home");
    assert.equal(await p.page.$("#view [data-retry]"), null, "no error card");
    srv.setLatency(0);
    await p.clean();
  } finally { srv.setLatency(0); await p.close(); }
});

// Every client route the modules' manifests register (generated: a new
// screen is walked as it registers), as an owner with the office sign-in
// and as a tech, at both phone sizes and at 1440 x 900 and 1024 x 768 (the
// desktop layout: the sidebar, list + detail): no console errors, no CSP violation,
// no sideways scroll, 44 px tap targets, 16 px inputs, the tab bar fully on
// screen above a 34 px home bar, links that leave in a new tab.
test("every client route in the manifests, as owner and tech, at both phone sizes and on two desks", async () => {
  const { MANIFESTS } = await import("../../crm-app/modules/index.js");
  // (an old link that redirects, #/visits, is checked where it lands)
  const routes = MANIFESTS.flatMap((m) => (m.routes || []).filter((r) => !r.redirect).map((r) => r.path));
  // ids for the params, from the API as the owner
  const o = await phone(browser, srv);
  await signIn(o, "olive");
  const get = async (path) => (await (await o.ctx.request.get("/api/crm" + path, { headers: { "x-crm": "1" } })).json()).data;
  const en = await get(`/enrollments/${seeded.enrollments.lead}`);
  const props = await get(`/contacts/${seeded.contacts.first}/properties`);
  const run = await (await o.ctx.request.post("/api/crm/import/runs", { headers: { "x-crm": "1", "content-type": "application/json" }, data: {} })).json();
  const sign = await (await o.ctx.request.post("/api/crm/qr-codes", { headers: { "x-crm": "1", "content-type": "application/json" }, data: { client_id: "00000000-0000-4000-8000-000000510001", name: "Yard sign, Delano", kind: "yard_sign", area: "Delano" } })).json();
  const ids = {
    "/contacts/:id": seeded.contacts.lead, "/contacts/:id/edit": seeded.contacts.lead, "/properties/:id": (props.properties || props || [])[0]?.id,
    "/team/:id": seeded.users.admin.id, "/templates/:id": (await get("/templates"))[0].id, "/enrollments/:id": seeded.enrollments.lead,
    "/deals/:id": (en.enrollment || en).deal_id, "/tasks/:id": seeded.tasks.tech, "/settings/cadences/:id": (await get("/cadences"))[0].id,
    "/import/:id": run.data.run.id, "/import/:id/conflicts": run.data.run.id, "/dashboard/:view": "money", "/tools/:id": "followups",
    "/jobs/:id": seeded.jobs.tech, "/visits/:id": seeded.visits.tech, "/settings/checklists/:id": (await get("/checklists"))[0].id,
    "/schedule/route/:date/:user": { date: (await get(`/visits/${seeded.visits.tech}`)).visit.date, user: seeded.users.tech.id },
    "/quotes/:id": seeded.quotes.sent, "/quotes/:id/edit": seeded.quotes.draft, "/quotes/:id/lights": seeded.quotes.draft,
    "/plans/:id": seeded.plans.active, "/lights/:season": String(seeded.seasons.year), "/settings/agreement-templates/:id": seeded.templates.quarterly,
    "/inbox/:id": seeded.comms.tech, "/campaigns/:id": seeded.comms.campaign,
    "/invoices/:id": seeded.money.invoices.open, "/autopay/:id": seeded.money.autopay,
    "/signs/:id": sign.data.code.id,
  };
  await o.close();
  const fill = (path) => path.replace(/:([a-z_]+)/g, (m, name) => (name === "contact" ? seeded.contacts.lead : ids[path] && typeof ids[path] === "object" ? ids[path][name] : ids[path] ?? null) ?? m);
  const problems = [];
  const missing = routes.filter((r) => fill(r).includes(":"));
  assert.deepEqual(missing, [], "every route's params have a fixture (add one when a module registers a new kind)");
  for (const [login, office] of [["olive", true], ["theo", false]]) {
    for (const device of ["iphone13", "iphonese", "desk1440", "desk1024"]) {
      const p = await phone(browser, srv, { device, office });
      try {
        await signIn(p, login);
        await p.page.goto("/office");
        const f = await crmFrame(p.page);
        await settled(f);
        await noInstallCard(p.page);
        // a phone with a home bar: 34 px at the bottom
        await p.page.addStyleTag({ content: "#sa-probe{padding:0 0 34px 0 !important}" });
        await p.page.setViewportSize({ ...p.page.viewportSize(), height: p.page.viewportSize().height - 1 });
        await f.waitForFunction(() => getComputedStyle(document.documentElement).getPropertyValue("--sab").trim() === "34px");
        for (const r of routes) {
          const path = fill(r);
          await goTo(f, path);
          await f.waitForFunction(() => !document.querySelector("#view .sk"), null, { timeout: 10000 }).catch(() => {});
          const where = `${login} ${device} ${r}`;
          for (const x of await screenProblems(f)) problems.push(`${where}: ${x}`);
          for (const x of await badLinks(f)) problems.push(`${where}: a link that leaves in this tab ${x}`);
          const bar = await f.evaluate(() => { const t = document.getElementById("tabs"); if (!t || t.offsetParent === null || getComputedStyle(t).display === "none") return null; const b = t.getBoundingClientRect(); return { bottom: b.bottom, h: innerHeight }; });
          if (bar && bar.bottom > bar.h - 34 + 0.5) problems.push(`${where}: the tab bar is not fully above the home bar (${JSON.stringify(bar)})`);
          await shot(p.page, `route-${login}-${device}${path.replace(/[/:]/g, "_").replace(/_[a-z]{2}_[0-9a-z]{20}/g, "_id")}`);
        }
        await p.clean();
      } finally { await p.close(); }
    }
  }
  assert.deepEqual(problems, []);
});
