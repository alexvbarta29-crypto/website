// Phone and desk checks of the Nov 2026 layout (Flyra's phone app first,
// Rotor's where Flyra shows nothing; the layout report): Flyra's floating
// glass bar with labels (Home · Schedule · Inbox · Map · Menu) and the round
// +, the Menu sheet (Customers, Leads, Pipeline are there, top-level), the +
// overlay with search, large titles, a person's own tab bar, the one-time
// "What moved" toast, Dark by default and Light from the Menu; the contact page
// that answers a call (header numbers and buttons, one page of sections, two
// columns and a header that stays put on a desk); the Visit's one big button
// (fixed at the bottom, On my way → Start → Finish, Start with no signal,
// "Saved, will send when online", the changes replaying when signal comes
// back) and its quick row. iPhone 13 and SE as owner and tech, 1440 x 900
// and 1024 x 768 on a desk. `npm run e2e`; E2E_SHOTS=<dir> saves screenshots.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { start } from "./server.mjs";
import { launch, phone, signIn, crmFrame, goTo, settled, title, screenProblems, badLinks, shot, noInstallCard } from "./kit.mjs";

let srv, browser, seeded;
before(async () => { srv = await start(); seeded = await srv.seed(); browser = await launch(); });
after(async () => { await browser?.close(); await srv?.close(); });

async function open(login, device = "iphone13", { office = false, keepMoved = false } = {}) {
  const p = await phone(browser, srv, { device, office });
  await signIn(p, login);
  await p.page.goto("/office");
  const f = await crmFrame(p.page);
  await settled(f);
  await noInstallCard(p.page);
  if (!keepMoved) { const x = await f.$("[data-moved-x]"); if (x) await x.click(); }
  return { p, page: p.page, f };
}
const toastSays = (f, re) => f.waitForFunction((src) => new RegExp(src).test((document.querySelector(".toasts") || {}).textContent || ""), re.source, { timeout: 8000 });
const box = (f, sel) => f.$eval(sel, (el) => { const r = el.getBoundingClientRect(); return { x: r.x, y: r.y, w: r.width, h: r.height, bottom: r.bottom, right: r.right }; });
async function server(p, apiPath) {
  const cookie = (await p.ctx.cookies()).map((c) => `${c.name}=${c.value}`).join("; ");
  const res = await fetch(srv.url + "/api/crm" + apiPath, { headers: { cookie, "x-crm": "1" } });
  return (await res.json()).data;
}

for (const device of ["iphone13", "iphonese"]) {
  test(`the phone shell (${device}): Flyra's bar, What moved once, the Menu sheet, the + with search, large titles, my own tab bar, Light and Dark`, async () => {
    const { p, page, f } = await open("olive", device, { office: true, keepMoved: true });
    try {
      assert.deepEqual(await f.$$eval("#tabs [data-tab]", (els) => els.map((e) => e.querySelector(".tl").textContent)), ["Home", "Schedule", "Inbox", "Map", "Menu"]);
      assert.equal(await f.evaluate(() => document.documentElement.dataset.theme), "dark", "Flyra's dark look first");
      assert.equal(await f.evaluate(() => getComputedStyle(document.body).backgroundColor), "rgb(17, 18, 20)", "the near-black canvas");
      const bar = await box(f, "#tabs");
      const fab = await box(f, "#fab");
      const vh = await f.evaluate(() => innerHeight);
      assert.ok(bar.bottom < vh && bar.x > 0, "a floating pill, inset from the edges");
      assert.ok(fab.x >= bar.right, "the round + beside it, on the right");
      assert.ok(Math.abs((fab.y + fab.h / 2) - (bar.y + bar.h / 2)) < 4, "level with the bar");
      assert.equal(await f.getAttribute('#tabs [data-tab="home"]', "aria-current"), "page");
      // What moved: once, as a toast (never a banner over Home)
      await toastSays(f, /New look: Customers, Leads and Pipeline are in the Menu/);
      assert.equal(await f.$("#moved"), null, "no banner");
      assert.deepEqual(await screenProblems(f), []);
      await shot(page, `layout-shell-home-${device}`);
      await page.reload();
      const g = await crmFrame(page);
      await settled(g);
      await g.waitForTimeout(1600);
      assert.doesNotMatch(await g.evaluate(() => (document.querySelector(".toasts") || {}).textContent || ""), /New look/, "not again on this phone");
      // the Menu: a sheet of groups, not a page
      await g.click('#tabs [data-tab="menu"]');
      await g.waitForSelector(".menu-sheet.on");
      assert.ok((await g.$$eval(".menu-sheet .ms-row", (els) => els.length)) > 15);
      assert.ok(await g.$('.menu-sheet a[href="#/me"]'), "the person's initials: My account");
      assert.deepEqual(await screenProblems(g), [], "the Menu sheet passes the phone checks");
      await shot(page, `layout-menu-sheet-${device}`);
      await g.click('.menu-sheet a[href="#/leaderboard"]');
      await settled(g, { hash: "#/leaderboard" });
      assert.equal(await g.getAttribute('#tabs [data-tab="menu"]', "aria-current"), "page", "the Menu is lit on what it opens");
      assert.ok(await g.$(".rp-row"), "the Leaderboard's reps");
      assert.deepEqual(await screenProblems(g), []);
      await shot(page, `layout-leaderboard-${device}`);
      // the +: the screen blurs, search on top, the things to make above the +
      await g.click("#fab");
      await g.waitForSelector(".qk.on");
      assert.deepEqual(await g.$$eval(".qk-pill span:last-child", (els) => els.map((e) => e.textContent)), ["Lead or customer", "Quote", "Job", "Invoice", "Plan", "Task"], "one list, the most used first");
      await g.fill("#qk-q", "Newlead");
      await g.waitForSelector(".qk-res:not([hidden]) a", { timeout: 5000 });
      assert.deepEqual(await screenProblems(g), [], "the + overlay passes the phone checks");
      await shot(page, `layout-plus-${device}`);
      await g.click(".qk-x");
      await g.waitForFunction(() => !document.querySelector(".qk"));
      // large titles and round buttons on a screen the Menu opens (top-level: no back button); a back arrow deeper in
      await g.click('#tabs [data-tab="menu"]');
      await g.waitForSelector(".menu-sheet.on");
      await g.click('.menu-sheet a[href="#/contacts"]');
      await settled(g, { hash: "#/contacts" });
      assert.equal(await title(g), "Customers");
      assert.ok(await g.evaluate(() => document.getElementById("app").classList.contains("big-top")));
      assert.equal(await g.isVisible("#top-back"), false, "top-level: no back button");
      assert.ok(await g.isVisible("#top-rnd .rnd.coral"), "a coral + for a new customer");
      assert.deepEqual(await g.$$eval("#top-rnd .rnd-own .rnd", (els) => els.map((e) => e.dataset.own)), ["find", "filter", "archived"], "Rotor's round buttons: search, filter, archived");
      assert.equal(await g.isVisible("#ct-q"), false, "no search bar under the title until the round search button asks");
      await g.click('#top-rnd [data-own="find"]');
      assert.equal(await g.isVisible("#ct-q"), true);
      assert.ok(await g.$("#ct-list .cc .cc-band"), "customers as cards");
      assert.deepEqual(await screenProblems(g), []);
      await shot(page, `layout-customers-${device}`);
      // my own tab bar
      await goTo(g, "/tab-bar");
      await g.click('[data-pick="map"]');
      await g.click('[data-pick="visits"]');
      await g.click("[data-save]");
      await toastSays(g, /saved/);
      assert.deepEqual(await g.$$eval("#tabs [data-tab]", (els) => els.map((e) => e.dataset.tab)), ["home", "schedule", "inbox", "visits", "menu"]);
      assert.deepEqual((await server(p, "/me")).nav, ["home", "schedule", "inbox", "visits", "menu"], "kept on the server");
      await g.click("[data-standard]");
      await g.waitForFunction(() => [...document.querySelectorAll("#tabs [data-tab]")].map((e) => e.dataset.tab).join() === "home,schedule,inbox,map,menu", null, { timeout: 8000 });
      assert.deepEqual((await server(p, "/me")).nav, ["home", "schedule", "inbox", "map", "menu"], "the standard bar again");
      // Light (Rotor's) from the Menu's sun button, on this phone; Dark again
      await g.click('#tabs [data-tab="menu"]');
      await g.waitForSelector(".menu-sheet.on");
      await g.click(".menu-sheet [data-theme-btn]");
      await g.click('[data-theme-pick="light"]');
      assert.equal(await g.evaluate(() => document.documentElement.dataset.theme), "light");
      assert.equal(await g.evaluate(() => getComputedStyle(document.body).backgroundColor), "rgb(242, 242, 247)", "iOS grouped grey");
      assert.deepEqual(await screenProblems(g), []);
      await page.reload();
      const h = await crmFrame(page);
      await settled(h);
      assert.equal(await h.evaluate(() => document.documentElement.dataset.theme), "light", "kept on this phone");
      await h.evaluate(() => localStorage.setItem("crm-theme", "dark"));
      await p.clean();
    } finally { await p.close(); }
  });
}

test("a tech's bar is the tech app's: Today · Inbox · Time · Pay · Me, no Menu, no What moved", async () => {
  const { p, page, f } = await open("theo", "iphonese", { keepMoved: true });
  try {
    assert.deepEqual(await f.$$eval("#tabs [data-tab]", (els) => els.map((e) => e.dataset.tab)), ["today", "inbox", "time", "pay", "me"]);
    assert.equal(await f.$("#moved"), null);
    assert.deepEqual(await screenProblems(f), []);
    await shot(page, "layout-tech-today-iphonese");
    await p.clean();
  } finally { await p.close(); }
});

for (const device of ["iphone13", "iphonese"]) {
  test(`the contact page answers a call (${device}): Flyra's top (name, since, rows, the action bar), the details with three numbers, one page of sections`, async () => {
    const { p, page, f } = await open("olive", device);
    try {
      await goTo(f, `/contacts/${seeded.contacts.plan}`);
      await f.waitForFunction(() => !document.querySelector("#view .ct-loading"), null, { timeout: 10000 });
      assert.deepEqual(await f.$$eval(".ct-num dt", (els) => els.map((e) => e.textContent)), ["Balance owed", "Lifetime spend", "Next visit"]);
      // Flyra's lead page: the action bar Call · Message · Quote · Book (Mark lost on a lead with an open deal)
      assert.deepEqual(await f.$$eval(".ct-acts > *", (els) => els.map((e) => e.textContent.trim())), ["Call", "Message", "Quote", "Book"]);
      assert.match(await f.textContent(".ct-hero .ct-since"), /^Customer since [A-Z][a-z]{2} \d+, \d{4}$/);
      assert.deepEqual(await f.$$eval(".ct-reach .lb", (els) => els.map((e) => e.textContent)), ["Mobile", "Email", "Address"]);
      assert.match(await f.textContent("#ct-sum h3"), /Customer details/);
      assert.equal(await f.isVisible("#top-back"), true, "the round back button");
      assert.ok((await box(f, "#top-title")).w <= 1, "alone at the top: the name is the page's big title (the h1 stays for screen readers)");
      assert.match(await f.textContent(".ct-hero .ct-plan"), /plan/i, "the plan badge");
      const order = await f.$$eval("#view .ct-sec", (els) => els.map((e) => e.id));
      const want = ["ct-sec-visits", "ct-sec-plan", "ct-sec-docs", "ct-sec-properties", "ct-sec-queued", "ct-sec-mod-sales", "ct-sec-details", "ct-sec-aside", "ct-sec-activity"].filter((x) => order.includes(x));
      assert.deepEqual(order.filter((x) => want.includes(x)), want, "in the report's order");
      for (const must of ["ct-sec-visits", "ct-sec-plan", "ct-sec-docs", "ct-sec-properties", "ct-sec-activity"]) assert.ok(order.includes(must), must);
      assert.equal(await f.$("#view [role=tablist]"), null, "no sideways tabs");
      assert.deepEqual(await screenProblems(f), []);
      assert.deepEqual(await badLinks(f), []);
      await shot(page, `layout-contact-${device}`);
      // an old link to a tab scrolls to its section
      await goTo(f, `/contacts/${seeded.contacts.plan}?tab=money`);
      await f.waitForFunction(() => { const m = document.getElementById("ct-mod-money"); const v = document.getElementById("view"); return m && v.scrollTop > 100; }, null, { timeout: 10000 });
      await p.clean();
    } finally { await p.close(); }
  });
}

for (const device of ["desk1440", "desk1024"]) {
  test(`on a desk (${device}): the contact's header stays put; the activity in its own column when there's room; the Visit's actions in its header`, async () => {
    const { p, page, f } = await open("olive", device);
    try {
      await goTo(f, `/contacts/${seeded.contacts.lead}`);
      await f.waitForFunction(() => !document.querySelector(".ct-loading"), null, { timeout: 10000 });
      const holder = (await f.$("#pane:not([hidden]) .ct-page")) ? "#pane" : "#view";
      const main = await box(f, `${holder} .ct-main`);
      const aside = await box(f, `${holder} .ct-aside`);
      if (device === "desk1440") assert.ok(aside.x > main.x + main.w - 1 && Math.abs(aside.y - main.y) < 4, "two columns: the activity beside the sections");
      const before = await box(f, `${holder} .ct-hero`);
      await f.evaluate((h) => { document.querySelector(h).scrollTop = 900; }, holder);
      await f.waitForTimeout(200);
      const afterScroll = await box(f, `${holder} .ct-hero`);
      assert.ok(Math.abs(afterScroll.y - before.y) < 30, `the header stays put (${before.y} → ${afterScroll.y})`);
      assert.deepEqual(await screenProblems(f), []);
      await f.evaluate((h) => { document.querySelector(h).scrollTop = 0; }, holder);
      await shot(page, `layout-contact-${device}`);
      await goTo(f, `/visits/${seeded.visits[2]}`);
      const q = await box(f, ".vb-quick");
      const go = await box(f, ".vb-head");
      assert.ok(q.y >= go.y && q.bottom <= go.bottom, "the quick buttons in the page's header");
      assert.deepEqual(await screenProblems(f), []);
      await shot(page, `layout-visit-office-${device}`);
      await shot(page, `layout-sidebar-${device}`);
      await p.clean();
    } finally { await p.close(); }
  });
}

for (const [device, login, n] of [["iphone13", "theo", 2], ["iphonese", "tess", 1]]) {
  test(`the Visit's one big button (${device}, ${login}): fixed at the bottom, On my way → Start → Finish; with no signal Start, saved and replayed`, async () => {
    const id = seeded.visits[n];
    const { p, page, f } = await open(login, device);
    try {
      await goTo(f, `/visits/${id}`);
      await f.waitForSelector(".vb-go");
      assert.deepEqual(await f.$$eval(".vb-quick .vb-l", (els) => els.map((e) => e.textContent)), ["Call", "Navigate", "Photos", "Checklist"]);
      assert.equal((await f.textContent(".vb-go")).trim(), "On my way");
      const go = await box(f, ".vb-go");
      const bar = await box(f, "#tabs");
      assert.ok(go.h >= 56 && go.bottom <= bar.y + 1, `big, and above the tab bar (${JSON.stringify(go)})`);
      assert.equal(await f.$eval(".vb-go", (el) => getComputedStyle(el).backgroundColor), "rgb(219, 58, 41)", "the button coral");
      assert.deepEqual(await screenProblems(f), []);
      await shot(page, `layout-visit-${device}`);
      // no signal: On my way waits (it texts the customer); Start works and is kept on the phone
      await p.ctx.setOffline(true);
      await f.waitForFunction(() => navigator.onLine === false);
      await f.waitForFunction(() => (document.querySelector(".vb-go") || {}).textContent.trim() === "Start");
      await f.click(".vb-go");
      await toastSays(f, /Saved, will send when online/);
      await f.waitForFunction(() => (document.querySelector(".vb-go") || {}).textContent.trim() === "Finish");
      assert.ok(await f.$(".vb-saved"), "Saved, will send when online, by the button");
      await f.click('[data-item="gate_closed"]');
      await f.waitForSelector('[data-item="gate_closed"][aria-pressed="true"]');
      // (a blocked Finish says what's left; it is aria-disabled, so the click is forced)
      await f.click(".vb-go", { force: true });
      await toastSays(f, /Finish the checklist first/);
      await shot(page, `layout-visit-offline-${device}`);
      assert.equal((await server(p, `/visits/${id}`)).visit.status, "scheduled", "the server hasn't heard yet");
      // signal again: they go out in order
      await p.ctx.setOffline(false);
      for (let i = 0; i < 60; i++) { const v = (await server(p, `/visits/${id}`)).visit; if (v.status === "in_progress" && v.checklist.items.find((x) => x.key === "gate_closed").done_at) break; await page.waitForTimeout(300); }
      const v = (await server(p, `/visits/${id}`)).visit;
      assert.equal(v.status, "in_progress");
      assert.ok(v.checklist.items.find((x) => x.key === "gate_closed").done_at, "the tick too");
      await p.clean({ allow: [/ERR_INTERNET_DISCONNECTED|Failed to fetch/] });
    } finally { await p.close(); }
  });
}
