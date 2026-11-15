// Phone checks of the Rotor-style job page and schedule (Nov 2026, Track B;
// scratchpad simplify/rotor-spec.md §4.3, §4.5): the job's top card, the
// visit row, the person and place cards, Pricing with "+ Add discount"
// (an amount, then a percent, then removed: the total follows and so does
// the invoice made from the job), Create Invoice (then the reason it can't
// run again), the "..." sheet; the schedule's Day in both themes (the head,
// the week strip, the columns, the red line, To book). iPhone 13 and
// iPhone SE, light and dark; a desk at 1440 still shows both. Synthetic
// data only. `node --test tests/e2e/work-rotor.spec.mjs` (E2E_SHOTS=dir).
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { start } from "./server.mjs";
import { launch, phone, signIn, crmFrame, goTo, settled, title, badLinks, screenProblems, shot, noInstallCard } from "./kit.mjs";

let srv, browser, seeded;
before(async () => { srv = await start(); seeded = await srv.seed(); browser = await launch(); });
after(async () => { await browser?.close(); await srv?.close(); });

async function open(login, device, theme) {
  const p = await phone(browser, srv, { device, office: true });
  await p.ctx.addInitScript((t) => { try { localStorage.setItem("crm-theme", t); } catch (e) { /* fine */ } }, theme);
  await signIn(p, login);
  await p.page.goto("/office");
  const f = await crmFrame(p.page);
  await settled(f);
  await noInstallCard(p.page);
  return { p, page: p.page, f };
}
const sheetUp = (f, re) => f.waitForFunction((src) => { const h = document.querySelector(".sheet.on h2"); return !!h && new RegExp(src).test(h.textContent); }, re.source, { timeout: 5000 });
const sheetGone = (f) => f.waitForFunction(() => !document.querySelector(".sheet"), null, { timeout: 5000 });
async function checks(f, page, name, problems) {
  for (const x of await screenProblems(f)) problems.push(`${name}: ${x}`);
  for (const x of await badLinks(f)) problems.push(`${name}: a link that leaves in this tab ${x}`);
  await shot(page, name);
}
const api = async (p, path) => (await (await p.ctx.request.get(`/api/crm${path}`, { headers: { "x-crm": "1" } })).json()).data;
const pricing = (f) => f.textContent(".wk-pricing");

for (const [device, theme, n] of [["iphone13", "light", 2], ["iphonese", "dark", 3]]) {
  test(`the job page (${device}, ${theme}): Rotor's cards, + Add discount (amount, percent, removed), Create Invoice, the "..." sheet`, async () => {
    const { p, page, f } = await open("olive", device, theme);
    const problems = [];
    try {
      const id = seeded.jobs[n];
      const before = (await api(p, `/jobs/${id}`)).job;
      await goTo(f, `/jobs/${id}`);
      await f.waitForSelector(".wk-jtop");
      assert.equal(await f.evaluate(() => document.documentElement.dataset.theme), theme);
      assert.equal(await title(f), `Job ${before.number_label}`);
      assert.ok(await f.isVisible("#top-more"), "the round ...");
      assert.match(await f.textContent(".wk-jtop"), /Booked[\s\S]*Not invoiced/);
      assert.match(await f.textContent(".wk-jstats .rs-stat-v"), /^\$\d/, "Job total");
      assert.ok(await f.$(".wk-jtop [data-make-invoice]"), "the red Invoice $X");
      assert.ok(await f.$(".wk-jtop [data-edit-job]"), "Edit job");
      assert.ok(await f.$('.wk-visits a[href^="#/visits/"]'), "the visit row");
      assert.ok(await f.$(".wk-visits [data-book]"), "+ Visit");
      assert.ok(await f.$('.wk-cust a[href^="tel:"]'), "Call");
      assert.ok(await f.$('.wk-cust a[href^="sms:"]'), "Text");
      assert.ok(await f.$('.wk-cust a[href^="#/properties/"]'), "the place's pencil");
      for (const b of ["data-add-line", "data-add-discount", "data-make-invoice"]) assert.ok(await f.$(`.wk-pricing [${b}]`), b);
      assert.ok(await f.$('.wk-jnotes [data-notes="crew"]'));
      await checks(f, page, `rotor-job-${device}-${theme}`, problems);

      // + Add discount: $25 off, named
      await f.click(".wk-pricing [data-add-discount]");
      await sheetUp(f, /Add a discount/);
      await checks(f, page, `rotor-job-discount-${device}-${theme}`, problems);
      await f.fill(".sheet.on [name=value]", "25");
      await f.fill(".sheet.on [name=name]", "Neighbor deal");
      await f.click(".sheet.on [type=submit]");
      await sheetGone(f);
      const total0 = before.totals.total_cents;
      await f.waitForFunction(() => /Neighbor deal/.test(document.querySelector(".wk-pricing")?.textContent || ""), null, { timeout: 8000 });
      let now = (await api(p, `/jobs/${id}`)).job;
      assert.equal(now.totals.total_cents, total0 - 2500, "the total follows");
      assert.match(await pricing(f), /Subtotal[\s\S]*Neighbor deal[\s\S]*−\$25\.00/);
      // tap it: a percent instead
      await f.click(".wk-pricing [data-disc]");
      await sheetUp(f, /Change the discount/);
      await f.click('.sheet.on [data-seg=dkind][data-key="percentage"]');
      await f.fill(".sheet.on [name=value]", "10");
      await f.click(".sheet.on [type=submit]");
      await sheetGone(f);
      await f.waitForFunction(() => /Neighbor deal \(10%\)/.test(document.querySelector(".wk-pricing")?.textContent || ""), null, { timeout: 8000 });
      now = (await api(p, `/jobs/${id}`)).job;
      assert.equal(now.totals.total_cents, total0 - Math.round(total0 / 10));
      await checks(f, page, `rotor-job-discounted-${device}-${theme}`, problems);
      // a crew note saved as the box loses focus
      await f.fill('.wk-jnotes [data-notes="crew"]', "Synthetic: side gate sticks.");
      await f.click(".wk-jtop .wk-jtitle");
      await f.waitForFunction(() => /Saved/.test((document.querySelector(".toasts") || {}).textContent || ""), null, { timeout: 8000 });
      assert.equal((await api(p, `/jobs/${id}`)).job.crew_notes, "Synthetic: side gate sticks.");

      if (device === "iphone13") {
        // Create Invoice: the job's invoice, its discount line; then the job says it's invoiced
        await f.click(".wk-pricing [data-make-invoice]");
        await f.waitForFunction(() => /^#\/invoices\/in_/.test(location.hash), null, { timeout: 10000 });
        const invId = (await f.evaluate(() => location.hash)).slice("#/invoices/".length);
        const inv = (await api(p, `/invoices/${invId}`)).invoice;
        assert.equal(inv.total_cents, now.totals.total_cents, "the invoice's total is the job's");
        assert.ok(inv.lines.some((l) => l.kind === "discount" && /Neighbor deal/.test(l.description)), "the discount is an invoice line");
        await goTo(f, `/jobs/${id}`);
        await f.waitForSelector(".wk-invs .wk-irow");
        assert.match(await f.textContent(".wk-jtop"), /Invoiced[\s\S]*Invoice \$\d/);
        assert.match(await f.textContent(".wk-invs"), /#[A-Z]+-\d+/);
        assert.equal(await f.$(".wk-pricing [data-make-invoice]"), null, "no second invoice");
        await checks(f, page, `rotor-job-invoiced-${device}-${theme}`, problems);
      } else {
        // remove the discount: the total is back
        await f.click(".wk-pricing [data-disc]");
        await sheetUp(f, /Change the discount/);
        await f.click(".sheet.on [data-disc-del]");
        await sheetGone(f);
        await f.waitForFunction(() => !document.querySelector(".wk-pricing [data-disc]"), null, { timeout: 8000 });
        assert.equal((await api(p, `/jobs/${id}`)).job.totals.total_cents, total0);
      }
      // the "..." sheet
      await f.click("#top-more");
      await sheetUp(f, new RegExp(`Job ${before.number_label}`));
      const rows = await f.$$eval(".sheet.on .rs-act-l", (x) => x.map((e) => e.textContent));
      for (const r of ["Book a visit", "Mark done", "Edit the work", "Add a discount", "Open customer", "Cancel job"]) assert.ok(rows.includes(r), r);
      assert.equal(rows.at(-1), "Cancel job", "the red row last");
      await checks(f, page, `rotor-job-more-${device}-${theme}`, problems);
      await f.click(".sheet.on [data-sheet-x]");
      await sheetGone(f);
      // the jobs list: Rotor's tiles and table (two-line rows on a phone)
      await goTo(f, "/jobs");
      await f.waitForSelector(`.wk-jtable .rs-trow a[href="#/jobs/${id}"] .rs-td.c-date`);
      await checks(f, page, `rotor-jobs-${device}-${theme}`, problems);
      assert.deepEqual(problems, []);
      await p.clean();
    } finally { await p.close(); }
  });

  test(`the schedule's Day (${device}, ${theme === "light" ? "dark" : "light"}): Rotor's head, the week strip, the columns and the red line, To book`, async () => {
    const th = theme === "light" ? "dark" : "light";
    const { p, page, f } = await open("olive", device, th);
    const problems = [];
    try {
      const day = (await api(p, `/visits/${seeded.visits[0]}`)).visit.date;
      await goTo(f, `/schedule?view=day&date=${day}`);
      await f.waitForSelector(`.wk-cols [href="#/visits/${seeded.visits[0]}"]`);
      assert.equal(await f.evaluate(() => document.documentElement.dataset.theme), th);
      assert.equal(await f.getAttribute(".wk-fly [data-seg=view][data-key=day]", "aria-selected"), "true");
      assert.equal(await f.$$eval(".wk-fly .rnd", (b) => b.filter((x) => x.closest(".wk-rs-tools")).length), 3, "map, go to a date, filter");
      assert.ok(await f.isVisible(`.wk-strip .wk-sday.today[data-sday="${day}"]`), "today in the red circle");
      assert.equal(await f.$eval(`.wk-strip .wk-sday.today b`, (el) => getComputedStyle(el).backgroundColor), "rgb(219, 58, 41)");
      assert.match(await f.textContent(".wk-cols .wk-chead"), /Unassigned/);
      assert.match(await f.textContent(".wk-cols"), /\d\/\d/, "done of all");
      assert.ok(await f.$(".wk-cols .wk-nowline"), "the red line");
      await f.waitForSelector(".wk-tbchip >> visible=true");
      await checks(f, page, `rotor-schedule-day-${device}-${th}`, problems);
      // the strip: another day, then the segmented Month (the selected day's list under it)
      const next = new Date(Date.parse(day + "T12:00:00Z") + 86400000).toISOString().slice(0, 10);
      await f.click(`.wk-strip [data-sday="${next}"]`);
      await f.waitForFunction((d) => document.querySelector(`.wk-strip [data-sday="${d}"]`)?.getAttribute("aria-pressed") === "true", next);
      await f.click(".wk-fly [data-seg=view][data-key=month]");
      await f.waitForSelector(".wk-mgrid");
      await f.waitForSelector(".wk-dayp");
      await checks(f, page, `rotor-schedule-month-${device}-${th}`, problems);
      // the dashed chip (Track 2: Pending, the jobs to book for the dates on screen) opens the Pending page
      await f.click(".wk-fly [data-seg=view][data-key=week]");
      await f.waitForSelector(".wk-week");
      await f.waitForSelector(".wk-tbchip >> visible=true");
      await f.click(".wk-tbchip");
      await f.waitForSelector(".sheet.on [data-pend-overdue], [data-book]");
      await checks(f, page, `rotor-schedule-tray-${device}-${th}`, problems);
      assert.deepEqual(problems, []);
      await p.clean();
    } finally { await p.close(); }
  });
}

test("a desk (1440) still shows the job page and the schedule's own head", async () => {
  const { p, page, f } = await open("olive", "desk1440", "light");
  const problems = [];
  try {
    await goTo(f, `/jobs/${seeded.jobs[1]}`);
    await f.waitForSelector(".wk-pricing");
    for (const x of await screenProblems(f)) problems.push(`job: ${x}`);
    await shot(page, "rotor-job-desk1440");
    await goTo(f, "/schedule?view=day");
    await f.waitForSelector(".wk-cols");
    assert.equal(await f.isVisible(".wk-fly"), false, "the phone's head is a phone's");
    assert.ok(await f.isVisible(".wk-top"), "the desk's head");
    assert.equal(await f.isVisible(".wk-tbchip"), false, "the desk has the tray beside the day instead");
    for (const x of await screenProblems(f)) problems.push(`schedule: ${x}`);
    await shot(page, "rotor-schedule-day-desk1440");
    assert.deepEqual(problems, []);
    await p.clean();
  } finally { await p.close(); }
});
