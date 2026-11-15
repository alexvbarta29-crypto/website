// Phone and desk checks of the Nov 2026 layout, then the owner's "make it
// like Rotor": Rotor's floating bar, icons only (Home · Schedule · Inbox · Map
// · Menu) and the red round +, the drawer (Customers, Leads, Pipelines there,
// top-level), the top bar of a top-level screen (the hamburger, search, the
// time, help, the person), the + overlay with search, large titles, a
// person's own tab bar (Customize Tabs), the one-time "What moved" toast,
// Dark by default and Light from the person's initials; the contact page
// (Rotor's: the name and pills, Details | Activity, the stat card, contact
// rows, cards; both side by side and a name that stays put on a desk); the Visit's one big button
// (fixed at the bottom, On my way → Start → Finish, Start with no signal,
// "Saved, will send when online", the changes replaying when signal comes
// back) and its quick row. iPhone 13 and SE as owner and tech, 1440 x 900
// and 1024 x 768 on a desk. `npm run e2e`; E2E_SHOTS=<dir> saves screenshots.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { start } from "./server.mjs";
import { launch, phone, signIn, crmFrame, goTo, settled, title, screenProblems, badLinks, shot, noInstallCard, openDrawer, drawerGo } from "./kit.mjs";

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
  test(`the phone shell (${device}): Rotor's bar, What moved once, the drawer, the top bar, the + with search, large titles, my own tabs, Light and Dark`, async () => {
    const { p, page, f } = await open("olive", device, { office: true, keepMoved: true });
    try {
      // Rotor's bar: icons only (the names stay for screen readers), the current one red with a dot
      assert.deepEqual(await f.$$eval("#tabs [data-tab]", (els) => els.map((e) => e.querySelector(".tl").textContent)), ["Home", "Schedule", "Inbox", "Map", "Menu"]);
      assert.ok(await f.evaluate(() => document.getElementById("app").classList.contains("rs-shell")), "the floating bar is on");
      assert.equal(await f.$eval('#tabs [data-tab="home"] .tl', (e) => e.getBoundingClientRect().width <= 1), true, "the labels are for screen readers");
      assert.equal(await f.evaluate(() => document.documentElement.dataset.theme), "dark", "Flyra's dark look first");
      assert.equal(await f.evaluate(() => getComputedStyle(document.body).backgroundColor), "rgb(17, 18, 20)", "the near-black canvas");
      const bar = await box(f, "#tabs");
      const fab = await box(f, "#fab");
      const vh = await f.evaluate(() => innerHeight);
      assert.ok(bar.bottom < vh && bar.x > 0, "a floating pill, inset from the edges");
      assert.ok(fab.x >= bar.right, "the round + beside it, on the right");
      assert.ok(Math.abs((fab.y + fab.h / 2) - (bar.y + bar.h / 2)) < 4, "level with the bar");
      assert.equal(fab.w, 62, "Rotor's red round +");
      assert.equal(await f.$eval("#fab", (e) => getComputedStyle(e).backgroundImage.includes("gradient")), true, "red");
      assert.equal(await f.getAttribute('#tabs [data-tab="home"]', "aria-current"), "page");
      // the top bar of a top-level screen: the hamburger, search, the time, help, the person
      for (const sel of ["#top-bar [data-tb-menu]", "#top-bar [data-tb-search]", "#top-bar [data-tb-help]", "#top-bar [data-tb-me]"]) assert.ok(await f.isVisible(sel), sel);
      assert.equal(await f.isVisible("#tb-time"), device === "iphone13", "the time, which steps aside under 390 px");
      assert.match(await f.textContent("#tb-time"), /^\d{1,2}:\d{2} [AP]M$/);
      // What moved: once, as a toast (never a banner over Home)
      await toastSays(f, /Rotor's sections now/);
      assert.equal(await f.$("#moved"), null, "no banner");
      assert.deepEqual(await screenProblems(f), []);
      await shot(page, `layout-shell-home-${device}`);
      await page.reload();
      const g = await crmFrame(page);
      await settled(g);
      await g.waitForTimeout(1600);
      assert.doesNotMatch(await g.evaluate(() => (document.querySelector(".toasts") || {}).textContent || ""), /Rotor's sections now/, "not again on this phone");
      // the drawer: from the left, four groups of sections (no sub-lists), the gear
      await openDrawer(g);
      const dr = await box(g, ".drawer");
      assert.ok(dr.x === 0 && dr.w >= 220 && dr.w <= 300 && dr.h >= vh - 1, `a left drawer, full height (${JSON.stringify(dr)})`);
      assert.equal(await g.$$eval(".drawer .dr-grp", (els) => els.length), 4, "four groups");
      assert.ok(await g.$('.drawer a[href="#/settings"]'), "the gear: Settings");
      await shot(page, `layout-drawer-${device}`);
      // Analytics' Leaderboard: the section, then its round "..."
      await drawerGo(g, "/leaderboard", { open: false });
      await settled(g, { hash: "#/leaderboard" });
      assert.equal(await g.getAttribute('#tabs [data-tab="menu"]', "aria-current"), "page", "the Menu is lit on what the drawer opens");
      assert.ok(await g.$(".rp-row"), "the Leaderboard's reps");
      assert.deepEqual(await screenProblems(g), []);
      await shot(page, `layout-leaderboard-${device}`);
      // (a section's "..." screen sits deeper: a back button, no top bar)
      assert.equal(await g.isVisible("#top-back"), true);
      // the hamburger of a top-level screen opens it too; X, Escape and a tap outside close it
      await g.click("#top-back");
      await settled(g, { hash: "#/reports" });
      await g.click("#top-bar [data-tb-menu]");
      await g.waitForSelector(".drawer.on");
      await page.keyboard.press("Escape");
      await g.waitForFunction(() => !document.querySelector(".drawer"));
      // the +: the screen blurs, search on top, the things to make above the +
      await g.click("#fab");
      await g.waitForSelector(".qk.on");
      assert.deepEqual(await g.$$eval(".qk-pill span:last-child", (els) => els.map((e) => e.textContent)), ["Lead or customer", "Quote", "Job", "Task", "Invoice", "Plan"], "one list, the most used first");
      await g.fill("#qk-q", "Newlead");
      await g.waitForSelector(".qk-res:not([hidden]) a", { timeout: 5000 });
      assert.deepEqual(await screenProblems(g), [], "the + overlay passes the phone checks");
      await shot(page, `layout-plus-${device}`);
      await g.click(".qk-x");
      await g.waitForFunction(() => !document.querySelector(".qk"));
      // large titles and round buttons on a screen the drawer opens (top-level: no back button); a back arrow deeper in
      await drawerGo(g, "/contacts");
      await settled(g, { hash: "#/contacts" });
      assert.equal(await title(g), "Customers");
      assert.ok(await g.evaluate(() => document.getElementById("app").classList.contains("big-top")));
      assert.equal(await g.isVisible("#top-back"), false, "top-level: no back button");
      assert.ok(await g.isVisible("#top-rnd .rnd.coral"), "a coral + for a new customer");
      const tb = await box(g, "#top-bar");
      const tt = await box(g, "#top-title");
      assert.ok(tt.y >= tb.bottom - 1, "the big title under the top bar");
      assert.deepEqual(await g.$$eval("#top-rnd .rnd-own .rnd", (els) => els.map((e) => e.dataset.own)), ["find", "filter", "archived"], "Rotor's round buttons: search, filter, archived");
      assert.equal(await g.isVisible("#ct-q"), false, "no search bar under the title until the round search button asks");
      await g.click('#top-rnd [data-own="find"]');
      assert.equal(await g.isVisible("#ct-q"), true);
      assert.ok(await g.$("#ct-list .cc .cc-band"), "customers as cards");
      assert.deepEqual(await screenProblems(g), []);
      await shot(page, `layout-customers-${device}`);
      // my own tabs (#/tab-bar: Customize Tabs as a page)
      await goTo(g, "/tab-bar");
      await g.click('[data-ctb-out="map"]');
      await g.click('[data-ctb-in="quotes"]');
      await g.click("[data-save]");
      await toastSays(g, /saved/);
      assert.deepEqual(await g.$$eval("#tabs [data-tab]", (els) => els.map((e) => e.dataset.tab)), ["home", "schedule", "inbox", "quotes", "menu"]);
      assert.deepEqual((await server(p, "/me")).nav, ["home", "schedule", "inbox", "quotes", "menu"], "kept on the server");
      assert.equal(await g.$('[data-ctb-in="visits"], [data-ctb-out="visits"]'), null, "Visits is the Schedule's List now: not a place of its own");
      await g.click("[data-standard]");
      await g.waitForFunction(() => [...document.querySelectorAll("#tabs [data-tab]")].map((e) => e.dataset.tab).join() === "home,schedule,inbox,map,menu", null, { timeout: 8000 });
      assert.deepEqual((await server(p, "/me")).nav, ["home", "schedule", "inbox", "map", "menu"], "the standard bar again");
      // Light (Rotor's) from the person's initials, on this phone; Dark again
      await goTo(g, "/today");
      await g.click("#top-bar [data-tb-me]");
      await g.waitForSelector(".sheet.on [data-theme-btn]");
      await g.click(".sheet.on [data-theme-btn]");
      await g.click('[data-theme-pick="light"]');
      assert.equal(await g.evaluate(() => document.documentElement.dataset.theme), "light");
      assert.equal(await g.evaluate(() => getComputedStyle(document.body).backgroundColor), "rgb(246, 246, 248)", "a faint grey canvas (Polish 3)");
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
  test(`the customer page (${device}): Rotor's top (name, pills), Details | Activity, the stat card, contact rows, cards; the "..." has the rest`, async () => {
    const { p, page, f } = await open("olive", device);
    try {
      await goTo(f, `/contacts/${seeded.contacts.plan}`);
      await f.waitForFunction(() => !document.querySelector("#view .ct-loading"), null, { timeout: 10000 });
      assert.deepEqual(await f.$$eval("#ct-stat .rs-stat-l", (els) => els.map((e) => e.textContent)), ["Balance", "Lifetime", "Next visit", "Plan", "Source"]);
      assert.match(await f.textContent(".ct-pills"), /Customer since [A-Z][a-z]{2} \d+, \d{4}/);
      assert.match(await f.textContent(".ct-pills"), /plan/i, "the plan pill");
      assert.deepEqual(await f.$$eval('[data-pane="details"] .rs-crow .rs-cl', (els) => els.map((e) => e.textContent)), ["Mobile", "Email"]);
      assert.ok(await f.$('.rs-crow .rnd.red[href^="tel:"]'), "the red round call");
      assert.equal(await f.isVisible("#top-back"), true, "the round back button");
      assert.ok(await f.isVisible("#top-act [data-top-tool]"), "the round pencil");
      assert.ok(await f.isVisible("#top-more"), "the round ...");
      assert.ok((await box(f, "#top-title")).w <= 1, "no title in sight: the name is the page's own (the h1 stays for screen readers)");
      // Details | Service | Payments | Activity (guide-gaps C17): the cards in Rotor's order on each tab
      const cardsOf = (pane) => f.$$eval(`[data-pane="${pane}"] [data-card]`, (els) => els.map((e) => e.dataset.card));
      const order = await cardsOf("details");
      for (const must of ["properties", "notes", "about"]) assert.ok(order.includes(must), must);
      const svc = await cardsOf("service");
      const want = ["visits", "plan", "quotes", "followups"].filter((x) => svc.includes(x));
      assert.deepEqual(svc.filter((x) => want.includes(x)), want, `in Rotor's order (${svc.join(", ")})`);
      for (const must of ["visits", "plan", "quotes"]) assert.ok(svc.includes(must), must);
      assert.ok((await cardsOf("payments")).includes("invoices"), "invoices on Payments");
      assert.equal(await f.isVisible('[data-pane="activity"]'), false, "one tab at a time");
      assert.deepEqual(await screenProblems(f), []);
      assert.deepEqual(await badLinks(f), []);
      await shot(page, `layout-contact-${device}`);
      // Activity: the timeline and the consent card
      await f.click('[data-seg="ctab"][data-key="activity"]');
      assert.equal(await f.isVisible('[data-pane="activity"]'), true);
      assert.equal(await f.isVisible('[data-pane="details"]'), false);
      assert.ok(await f.isVisible("#ct-card-activity") && await f.isVisible("#ct-card-consent"));
      assert.deepEqual(await screenProblems(f), []);
      // the "...": every other action
      await f.click("#top-more");
      await f.waitForSelector(".sheet.on .rs-act");
      const rows = await f.$$eval(".sheet.on .rs-act-l", (els) => els.map((e) => e.textContent));
      for (const want2 of ["Book a job", "New quote", "New plan", "New invoice", "Add credit", "Text a card link", "Log a call", "Start a follow-up", "New task", "Edit", "Texts and email", "Merge with...", "Pause automated texts", "Mark as test contact", "Archive"]) assert.ok(rows.includes(want2), `${want2} in the ...: ${rows.join(", ")}`);
      assert.equal(rows[rows.length - 1], "Archive", "Archive red, last");
      assert.deepEqual(await screenProblems(f), []);
      await shot(page, `layout-contact-more-${device}`);
      await f.click(".sheet.on [data-sheet-x]");
      // an old link to a tab opens its card
      await goTo(f, `/contacts/${seeded.contacts.plan}?tab=money`);
      await f.waitForFunction(() => { const m = document.getElementById("ct-mod-money"); return m && !m.closest(".ct-pane.off") && m.closest('[data-pane="payments"]'); }, null, { timeout: 10000 });
      await p.clean();
    } finally { await p.close(); }
  });
}

for (const device of ["desk1440", "desk1024"]) {
  test(`on a desk (${device}): the contact's name stays put; Details and Activity side by side when there's room; the Visit's actions in its header`, async () => {
    const { p, page, f } = await open("olive", device);
    try {
      await goTo(f, `/contacts/${seeded.contacts.lead}`);
      await f.waitForFunction(() => !document.querySelector(".ct-loading"), null, { timeout: 10000 });
      const holder = (await f.$("#pane:not([hidden]) .ct-page")) ? "#pane" : "#view";
      const main = await box(f, `${holder} [data-pane="details"]`);
      const aside = await box(f, `${holder} [data-pane="activity"]`);
      if (device === "desk1440") {
        assert.ok(aside.x > main.x + main.w - 1 && Math.abs(aside.y - main.y) < 4, "two columns: Activity beside Details");
        assert.equal(await f.isVisible(`${holder} .ct-seg`), false, "no tabs then");
      }
      const before = await box(f, `${holder} .ct-head`);
      await f.evaluate((h) => { document.querySelector(h).scrollTop = 900; }, holder);
      await f.waitForTimeout(200);
      const afterScroll = await box(f, `${holder} .ct-head`);
      assert.ok(Math.abs(afterScroll.y - before.y) < 30, `the name stays put (${before.y} → ${afterScroll.y})`);
      assert.deepEqual(await screenProblems(f), []);
      await f.evaluate((h) => { document.querySelector(h).scrollTop = 0; }, holder);
      await shot(page, `layout-contact-${device}`);
      // the sidebar is the drawer's sections: Service opens on its first tab, Jobs a tab of it
      assert.ok(await f.isVisible('#side [data-path="/today"]'));
      await f.click('#side [data-sec="service"]');
      await settled(f, { hash: "#/quotes" });
      assert.ok(await f.isVisible('#subnav a[href="#/jobs"]'), "Jobs, a tab of Service");
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
