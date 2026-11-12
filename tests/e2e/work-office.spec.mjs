// Phone checks of the scheduling screens (M4a; design §12.4, §9.2):
// Schedule (the month by default with the chosen day's list, then day,
// week, list, to book; on a desk the list beside the grid and the arrow
// keys), booking a visit from the tray with
// the schedule's warnings, one visit (the office's buttons, the texts
// that would have gone), moving it, a tech's route, the rain-day move up to
// the notice waiting in Approvals, a new job, Time off and a checklist, at
// iPhone 13 and iPhone SE sizes; and a tech, who reaches only their own
// visit. `npm run e2e` (E2E_SHOTS=dir for screenshots).
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { start } from "./server.mjs";
import { launch, phone, signIn, crmFrame, goTo, settled, title, badLinks, screenProblems, shot, noInstallCard } from "./kit.mjs";

let srv, browser, seeded;
before(async () => { srv = await start(); seeded = await srv.seed(); browser = await launch(); });
after(async () => { await browser?.close(); await srv?.close(); });

async function open(login, device, { office = false } = {}) {
  const p = await phone(browser, srv, { device, office });
  await signIn(p, login);
  await p.page.goto("/office");
  const f = await crmFrame(p.page);
  await settled(f);
  await noInstallCard(p.page);
  const errors = [];
  p.page.on("console", (m) => { if (m.type() === "error") errors.push(m.text()); });
  return { p, page: p.page, f, errors };
}
const sheetUp = (f, re) => f.waitForFunction((src) => { const h = document.querySelector(".sheet.on h2"); return !!h && new RegExp(src).test(h.textContent); }, re.source, { timeout: 5000 });
const sheetGone = (f) => f.waitForFunction(() => !document.querySelector(".sheet"), null, { timeout: 5000 });
const toastSays = (f, re) => f.waitForFunction((src) => new RegExp(src).test((document.querySelector(".toasts") || {}).textContent || ""), re.source, { timeout: 8000 });
async function checks(f, page, name, problems) {
  for (const x of await screenProblems(f)) problems.push(`${name}: ${x}`);
  for (const x of await badLinks(f)) problems.push(`${name}: a link that leaves in this tab ${x}`);
  await shot(page, name);
}

for (const device of ["iphone13", "iphonese"]) {
  test(`schedule (${device}): the month first with the chosen day's list, then day, week, list, to book; book from the tray with warnings; open the visit`, async () => {
    const { p, page, f, errors } = await open("olive", device);
    const problems = [];
    const reads = [];
    page.on("request", (r) => { if (/\/api\/crm\/schedule(\?|$)/.test(r.url())) reads.push(r.url()); });
    try {
      // the server's day (its clock is pinned; the phone's is not)
      const day = (await (await p.ctx.request.get(`/api/crm/visits/${seeded.visits[0]}`, { headers: { "x-crm": "1" } })).json()).data.visit.date;
      const tomorrow = (await (await p.ctx.request.get(`/api/crm/visits/${seeded.visits[4]}`, { headers: { "x-crm": "1" } })).json()).data.visit.date;
      // the tab opens on the month (nothing kept yet): one read for the whole grid, today chosen
      await goTo(f, "/schedule");
      assert.equal(await title(f), "Schedule");
      await f.waitForSelector(".wk-mgrid");
      assert.equal(await f.getAttribute("[data-view=month]", "aria-selected"), "true", "Month is the default");
      assert.equal(await f.getAttribute(`[data-mday="${day}"]`, "aria-pressed"), "true", "today is chosen");
      assert.equal(await f.getAttribute(`[data-mday="${day}"]`, "aria-current"), "date");
      assert.equal(reads.length, 1, reads.join(" "));
      assert.match(reads[0], /month=now&amounts=1/);
      // the day's list: both techs' visits today, each opening the visit
      await f.waitForSelector(`.wk-dayp [href="#/visits/${seeded.visits[0]}"]`);
      assert.ok(await f.$(`.wk-dayp [href="#/visits/${seeded.visits[1]}"]`), "both techs' visits today");
      assert.match(await f.textContent(".wk-dayp-h h2"), /· \d+ visits/);
      assert.match(await f.textContent(".wk-dayp"), /\$\d/, "amounts for the office");
      await checks(f, page, `work-schedule-month-${device}`, problems);
      // tap another day: its list, no new read
      await f.click(`[data-mday="${tomorrow}"]`);
      await f.waitForSelector(`.wk-dayp [href="#/visits/${seeded.visits[4]}"]`);
      assert.equal(await f.getAttribute(`[data-mday="${tomorrow}"]`, "aria-pressed"), "true");
      assert.equal(await f.$(`.wk-dayp [href="#/visits/${seeded.visits[0]}"]`), null, "only that day's visits");
      assert.equal(reads.length, 1, "picking a day inside the month never reads again");
      await checks(f, page, `work-schedule-month-picked-${device}`, problems);
      // a day with nothing: a calm empty state
      const free = await f.$eval(".wk-mday:not(.out)", () => { const b = [...document.querySelectorAll(".wk-mday:not(.out)")].find((x) => !x.querySelector(".wk-mdots i")); return b ? b.dataset.mday : null; });
      if (free) { await f.click(`[data-mday="${free}"]`); await f.waitForFunction(() => /Nothing booked/.test(document.querySelector(".wk-dayp").textContent)); }
      // an old link to a day still opens the Day view
      await goTo(f, `/schedule?view=day&date=${day}`);
      await f.waitForSelector(`.list [href="#/visits/${seeded.visits[0]}"]`);
      assert.equal(await f.getAttribute("[data-view=day]", "aria-selected"), "true");
      assert.ok(await f.$(`[href="#/visits/${seeded.visits[1]}"]`), "both techs' visits today");
      await checks(f, page, `work-schedule-day-${device}`, problems);
      // one tech: their visits, and their route
      await f.click(`[data-tech="${seeded.users.tech.id}"]`);
      assert.equal(await f.$(`[href="#/visits/${seeded.visits[1]}"]`), null, "only Theo's");
      await f.waitForSelector(`[href^="#/schedule/route/"]`);
      await f.click("[data-view=week]");
      await f.waitForSelector(".wk-week");
      await checks(f, page, `work-schedule-week-${device}`, problems);
      await f.click("[data-view=list]");
      await f.waitForSelector(".section-h");
      await checks(f, page, `work-schedule-list-${device}`, problems);
      await f.click("[data-view=tray]");
      await f.waitForSelector(`[data-book="${seeded.jobs[7]}"]`);             // the lights takedown due this month
      await checks(f, page, `work-schedule-tray-${device}`, problems);
      if (device === "iphone13") {
        // book job 6 for Tess on her day off: the warning shows while picking, the visit books anyway
        await f.click(`[data-book="${seeded.jobs[6]}"]`);
        await sheetUp(f, /Book a visit/);
        const offDay = new Date(Date.parse(day + "T12:00:00Z") + 3 * 86400000).toISOString().slice(0, 10);     // Tess's day off (seed.mjs)
        await f.fill(".sheet [name=date]", offDay);
        await f.dispatchEvent(".sheet [name=date]", "change");
        await f.click(`.sheet [data-person="${seeded.users.tech2.id}"]`);
        await f.waitForFunction(() => /off/i.test((document.querySelector(".sheet [data-warn]") || {}).textContent || ""), null, { timeout: 5000 });
        await checks(f, page, `work-book-sheet-${device}`, problems);
        await f.click(".sheet [type=submit]");
        await sheetGone(f);
        await toastSays(f, /Saved|Booked|Heads up/);
        await f.waitForFunction((id) => !document.querySelector(`[data-book="${id}"]`), seeded.jobs[6], { timeout: 8000 });
      }
      // the visit (office): buttons, the texts, link rows
      await goTo(f, `/visits/${seeded.visits[0]}`);
      await f.waitForSelector("[data-move]");
      assert.ok(await f.$("[data-cancel]"));
      assert.ok(await f.$('a[href^="tel:"]'));
      assert.match(await f.textContent("#view"), /Texts and emails/);
      await checks(f, page, `work-visit-${device}`, problems);
      await f.click("[data-move]");
      await sheetUp(f, /Move or reassign/);
      await checks(f, page, `work-move-sheet-${device}`, problems);
      await f.click(".sheet [data-sheet-x]");
      await sheetGone(f);
      // the job
      await goTo(f, `/jobs/${seeded.jobs[0]}`);
      await f.waitForSelector(`[href="#/visits/${seeded.visits[0]}"]`);
      await checks(f, page, `work-job-${device}`, problems);
      if (device === "iphone13") {
        // Edit: a notes change sends no lines, so the price never moves
        const jobApi = async () => (await (await p.ctx.request.get(`/api/crm/jobs/${seeded.jobs[0]}`, { headers: { "x-crm": "1" } })).json()).data.job;
        const before = await jobApi();
        await f.click("[data-edit]");
        await sheetUp(f, /Edit the job/);
        await checks(f, page, `work-job-edit-${device}`, problems);
        await f.fill(".sheet [name=crew_notes]", "Synthetic: gate code changed.");
        await f.click(".sheet [type=submit]");
        await sheetGone(f);
        const after = await jobApi();
        assert.equal(after.crew_notes, "Synthetic: gate code changed.");
        assert.deepEqual(after.lines, before.lines, "the lines are as they were");
        assert.equal(after.totals.total_cents, before.totals.total_cents);
      }
      assert.deepEqual(problems, []);
      assert.deepEqual(errors.filter((e) => !/favicon/.test(e)), [], "no console errors");
      await p.clean();
    } finally { await p.close(); }
  });
}

for (const device of ["desk1440", "desk1024"]) {
  test(`schedule on a desk (${device}): the month with the day's list ${device === "desk1440" ? "beside" : "under"} the grid, chips in the team's colors, the arrow keys`, async () => {
    const { p, page, f, errors } = await open("olive", device, { office: true });
    const problems = [];
    const reads = [];
    page.on("request", (r) => { if (/\/api\/crm\/schedule(\?|$)/.test(r.url())) reads.push(r.url()); });
    try {
      const day = (await (await p.ctx.request.get(`/api/crm/visits/${seeded.visits[0]}`, { headers: { "x-crm": "1" } })).json()).data.visit.date;
      await goTo(f, `/schedule?date=${day}`);
      await f.waitForSelector(".wk-mgrid .wk-mchip");
      assert.equal(await f.getAttribute("[data-view=month]", "aria-selected"), "true");
      const [grid, list] = await Promise.all([".wk-cal", ".wk-dayp"].map((sel) => f.$eval(sel, (el) => { const r = el.getBoundingClientRect(); return { x: r.left, y: r.top, w: r.width, h: r.height }; })));
      if (device === "desk1440") assert.ok(list.x >= grid.x + grid.w && Math.abs(list.y - grid.y) < 2, "the list beside the grid");
      else assert.ok(list.y >= grid.y + grid.h, "the list under the grid");
      assert.equal(await f.$eval(".wk-mdots", (el) => getComputedStyle(el).display), "none", "chips, not dots, on a desk");
      const chip = await f.$eval(`[data-mday="${day}"] .wk-mchip`, (el) => getComputedStyle(el).boxShadow);
      assert.match(chip, /rgb/, "a chip carries its tech's color");
      // the arrow keys move the chosen day, without a read inside the month
      const n0 = reads.length;
      await f.focus(`[data-mday="${day}"]`);
      await page.keyboard.press("ArrowRight");
      const next = new Date(Date.parse(day + "T12:00:00Z") + 86400000).toISOString().slice(0, 10);
      await f.waitForFunction((d) => document.querySelector(`[data-mday="${d}"]`)?.getAttribute("aria-pressed") === "true" && document.activeElement?.dataset.mday === d, next);
      await page.keyboard.press("ArrowLeft");
      await f.waitForFunction((d) => document.activeElement?.dataset.mday === d, day);
      assert.equal(reads.length, n0, "the keys never read inside the month");
      // Page Down turns the month: one read
      await page.keyboard.press("PageDown");
      await f.waitForFunction(() => /^[A-Z][a-z]+ \d{4}$/.test(document.querySelector(".wk-mtitle")?.textContent || "") && document.activeElement?.dataset?.mday);
      assert.equal(reads.length, n0 + 1);
      await f.click("[data-cal=today]");
      await f.waitForFunction((d) => document.querySelector(`[data-mday="${d}"]`)?.getAttribute("aria-pressed") === "true", day);
      for (const x of await screenProblems(f)) problems.push(`${device}: ${x}`);
      await shot(page, `work-schedule-month-${device}`);
      assert.deepEqual(problems, []);
      assert.deepEqual(errors.filter((e) => !/favicon/.test(e)), [], "no console errors");
      await p.clean();
    } finally { await p.close(); }
  });
}

test("route, rain day (preview, move, the notice waits in Approvals), new job, time off, a checklist", async () => {
  const { p, page, f, errors } = await open("olive", "iphonese");
  const problems = [];
  try {
    const v = (await (await p.ctx.request.get(`/api/crm/visits/${seeded.visits[2]}`, { headers: { "x-crm": "1" } })).json()).data.visit;
    await goTo(f, `/schedule/route/${v.date}/${seeded.users.tech.id}`);
    await f.waitForSelector(".wk-stop");
    assert.equal(await f.$$eval(".wk-stop", (x) => x.length), 2, "Theo's two stops today");
    await checks(f, page, "work-route-iphonese", problems);
    await f.click("#top-action");                      // Optimize
    await toastSays(f, /drive order/);
    await f.click(`[data-down="${await f.$eval(".wk-stop [data-down]", (b) => b.dataset.down)}"]`);
    assert.equal(await f.textContent("#top-action"), "Save");
    await f.click("#top-action");
    await toastSays(f, /Saved/);

    // rain day: tomorrow's visits move to the day after
    const tomorrow = (await (await p.ctx.request.get(`/api/crm/visits/${seeded.visits[4]}`, { headers: { "x-crm": "1" } })).json()).data.visit.date;
    await goTo(f, `/schedule/move-day?date=${tomorrow}`);
    await f.waitForSelector("#wk-move");
    await checks(f, page, "work-rainday-iphonese", problems);
    await f.click("#wk-move [type=submit]");
    await f.waitForFunction(() => /Move 2 visits/.test(document.querySelector("#wk-move [type=submit]").textContent), null, { timeout: 8000 });
    await checks(f, page, "work-rainday-preview-iphonese", problems);
    await f.click("#wk-move [type=submit]");
    await f.waitForFunction(() => /^Moved$/.test((document.querySelector("#view h2") || {}).textContent || ""), null, { timeout: 30000 });
    await f.waitForSelector('a[href="#/approvals"]');
    await checks(f, page, "work-rainday-done-iphonese", problems);
    const moved = (await (await p.ctx.request.get(`/api/crm/visits/${seeded.visits[4]}`, { headers: { "x-crm": "1" } })).json()).data.visit;
    assert.notEqual(moved.date, tomorrow, "the visit moved");
    assert.ok(moved.moved_by_op);

    // a new job for a contact, with its first visit booked
    await goTo(f, `/jobs/new/${seeded.contacts.customer}`);
    await f.waitForSelector("#wk-new-job");
    await f.fill("[name=l_title]", "Exterior window cleaning");
    await f.fill("[name=l_price]", "325");
    await f.check("[name=book]");
    await f.waitForSelector("[name=date]");
    await f.fill("[name=date]", new Date(Date.parse(v.date + "T12:00:00Z") + 2 * 86400000).toISOString().slice(0, 10));
    await f.click(`[data-person="${seeded.users.tech.id}"]`);
    await checks(f, page, "work-new-job-iphonese", problems);
    await f.click("#wk-new-job [type=submit]");
    await f.waitForFunction(() => /^#\/visits\//.test(location.hash), null, { timeout: 8000 });
    await settled(f);

    await goTo(f, "/schedule/time-off");
    await f.waitForSelector("[data-del]");
    await checks(f, page, "work-timeoff-iphonese", problems);
    await goTo(f, "/settings/checklists");
    await f.waitForSelector('[href^="#/settings/checklists/ck_"]');
    await f.click('[href^="#/settings/checklists/ck_"]');
    await f.waitForSelector("#wk-cl");
    await checks(f, page, "work-checklist-iphonese", problems);
    assert.deepEqual(problems, []);
    assert.deepEqual(errors.filter((e) => !/favicon/.test(e)), [], "no console errors");
    await p.clean();
  } finally { await p.close(); }
});

test("a tech: their own visit opens with no office buttons; another tech's is not there; the schedule is the office's", async () => {
  const { p, page, f } = await open("theo", "iphone13");
  const problems = [];
  try {
    await goTo(f, `/visits/${seeded.visits[0]}`);
    await f.waitForSelector(".wk-head");
    assert.equal(await f.$("[data-move]"), null);
    assert.equal(await f.$("[data-cancel]"), null);
    assert.doesNotMatch(await f.textContent("#view"), /Texts and emails|Office notes/);
    await checks(f, page, "work-visit-tech-iphone13", problems);
    await goTo(f, `/visits/${seeded.visits[1]}`);              // Tess's
    await f.waitForSelector("[data-retry]");
    assert.match(await f.textContent("#view"), /isn't there/);
    await goTo(f, "/schedule");
    assert.match(await f.textContent("#view"), /Your day is on Today/);
    assert.deepEqual(problems, []);
    await p.clean();
  } finally { await p.close(); }
});
