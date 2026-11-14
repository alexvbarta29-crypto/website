// Phone checks of Reports (M7b; design §9.2 "Reports", §5.9, §12.4): Menu →
// Money → Reports, each tab (Revenue, Sales, Leads, Plans, Jobs, Team,
// Owed, Payroll), the date range and its custom days, the chart and its
// readout, the period before, Export CSV, the office dashboard from it, and
// Settings → Dashboard numbers; a technician never opens it. iPhone 13 and
// a 1440 desk. `node --test tests/e2e/reports.spec.mjs`.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { start } from "./server.mjs";
import { seedPayroll } from "./payroll-seed.mjs";
import { launch, phone, signIn, crmFrame, goTo, settled, title, badLinks, screenProblems, shot, noInstallCard } from "./kit.mjs";

let srv, browser, seeded;
before(async () => { srv = await start(); seeded = await srv.seed(); await seedPayroll(seeded); browser = await launch(); });
after(async () => { await browser?.close(); await srv?.close(); });

async function open(login, device) {
  const p = await phone(browser, srv, { device, office: login === "olive" });
  await signIn(p, login);
  await p.page.goto("/office");
  const f = await crmFrame(p.page);
  await settled(f);
  await noInstallCard(p.page);
  return { p, page: p.page, f };
}
const viewHas = (f, re, timeout = 15000) => f.waitForFunction((src) => new RegExp(src).test(document.getElementById("view").textContent), re.source, { timeout });
const tab = async (f, key, re) => { await f.click(`[data-tab="${key}"]`); await f.waitForSelector(`[data-tab="${key}"][aria-pressed="true"]`); await viewHas(f, re); };

for (const device of ["iphone13", "desk1440"]) {
  test(`reports (${device}): Menu → Reports, every tab, dates, the chart, CSV, the office dashboard`, async () => {
    const { p, page, f } = await open("olive", device);
    try {
      await goTo(f, "/menu");
      assert.match(await f.textContent("#view"), /Money[\s\S]*Reports/);
      await f.click('#view a[href="#/reports"]');
      await settled(f, { hash: "#/reports" });
      assert.equal(await title(f), "Reports");
      await viewHas(f, /Collected/);
      await f.selectOption("[data-range]", "12m");
      await viewHas(f, /against/);
      await f.waitForSelector("[data-chart] svg");
      assert.match(await f.textContent("[data-readout]"), /Collected/);
      assert.deepEqual(await screenProblems(f), [], "Revenue passes the phone checks");
      await shot(page, `reports-revenue-${device}`);
      await tab(f, "sales", /By person/);
      assert.match(await f.textContent("#view"), /Olive Owner/);
      assert.match(await f.textContent("#view"), /Close rate/);
      await shot(page, `reports-sales-${device}`);
      await tab(f, "leads", /New leads/);
      await tab(f, "plans", /MRR/);
      await tab(f, "jobs", /Revenue per tech-hour/);
      await tab(f, "team", /The crew/);
      await tab(f, "owed", /Aging/);
      assert.deepEqual(await screenProblems(f), [], "Owed passes the phone checks");
      await tab(f, "payroll", /Pay periods/);
      assert.deepEqual(await screenProblems(f), [], "Payroll passes the phone checks");
      assert.deepEqual(await badLinks(f), []);
      // the CSV of what's shown
      const href = await f.getAttribute('a[href^="/api/crm/reports/"]', "href");
      const csv = await p.ctx.request.get(href);
      assert.equal(csv.status(), 200);
      assert.match(csv.headers()["content-type"], /text\/csv/);
      // a custom range
      await tab(f, "revenue", /Collected/);
      await f.selectOption("[data-range]", "custom");
      await f.waitForSelector('.sheet.on input[name="from"]');
      await f.fill('.sheet.on input[name="from"]', "2026-11-01");
      await f.fill('.sheet.on input[name="to"]', "2026-11-16");
      await f.click('.sheet.on button[type="submit"]');
      await viewHas(f, /Nov 1 – 16, 2026/);
      // the office dashboard opens from Reports
      await f.click("[data-office-dashboard]");
      await settled(f, { hash: "#/dashboard" });
      await goTo(f, "/settings/dashboard");
      await viewHas(f, /Dashboard numbers/);
      assert.deepEqual(await screenProblems(f), [], "Settings → Dashboard numbers passes the phone checks");
      await p.clean();
    } finally { await p.close(); }
  });
}

test("reports (iphone13): a technician never opens Reports", async () => {
  const { p, f } = await open("theo", "iphone13");
  try {
    await goTo(f, "/reports");
    await viewHas(f, /Not for this login|don't have access/);
    assert.doesNotMatch(await f.textContent("#view"), /Collected/);
    await p.clean();
  } finally { await p.close(); }
});
