// Phone checks of the Service hub (the Rotor guide's §2.9, Track 3): the
// tabs Requests · Quotes · Jobs · Plans each with Rotor's tile row (the tile
// is the filter) and Row2 rows; a request made from the +, its assessment
// booked and done, converted to a job; the job page's balance due, time on
// site, status track, the visit's step pills, the plan banner and the quick
// actions. iPhone 13 and iPhone SE, light and dark; a desk at 1440 still
// works. Synthetic data only; texts stay in the Outbox (dry run).
// `node --test tests/e2e/service.spec.mjs` (E2E_SHOTS=dir).
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
const viewHas = (f, re, timeout = 15000) => f.waitForFunction((src) => new RegExp(src).test(document.getElementById("view").textContent), re.source, { timeout });
async function checks(f, page, name, problems) {
  for (const x of await screenProblems(f)) problems.push(`${name}: ${x}`);
  for (const x of await badLinks(f)) problems.push(`${name}: a link that leaves in this tab ${x}`);
  await shot(page, name);
}
const tileOn = (f, name) => f.getAttribute(`[data-tile="${name}"][aria-pressed="true"]`, "data-key");

for (const [device, theme] of [["iphone13", "light"], ["iphonese", "dark"]]) {
  test(`Service tabs (${device}, ${theme}): Requests, Quotes, Jobs and Plans with their tiles and Row2 rows`, async () => {
    const { p, page, f } = await open("olive", device, theme);
    const problems = [];
    try {
      await goTo(f, "/jobs");
      await f.waitForSelector('[data-tile="jobs"][data-key="today"]');
      assert.equal(await f.evaluate(() => document.documentElement.dataset.theme), theme);
      for (const t of ["requests", "quotes", "jobs", "plans"]) assert.ok(await f.$(`#subnav a[href="#/${t}"]`), `the ${t} tab`);
      const labels = await f.$$eval('[data-tile="jobs"] .rs-tile-l', (x) => x.map((e) => e.textContent));
      for (const l of ["Open", "Today", "Tomorrow", "Next week", "Next month", "Past week", "Past month", "Overdue", "Pending", "Paid"]) assert.ok(labels.includes(l), l);
      assert.equal(await tileOn(f, "jobs"), "open");
      assert.ok(await f.$(".rs-lrow a[href^='#/jobs/']"), "Row2 rows");
      await checks(f, page, `service-jobs-${device}-${theme}`, problems);
      await f.click('[data-tile="jobs"][data-key="today"]');
      await f.waitForFunction(() => document.querySelector('[data-tile="jobs"][data-key="today"]').getAttribute("aria-pressed") === "true");
      const today = await f.$$eval(".rs-lrow", (x) => x.length);
      const n = Number(await f.textContent('[data-tile="jobs"][data-key="today"] .rs-tile-v'));
      assert.equal(today, n, "the tile is the filter");

      await goTo(f, "/quotes");
      await f.waitForSelector('[data-tile="quotes"][data-key="open"]');
      const ql = await f.$$eval('[data-tile="quotes"] .rs-tile-l', (x) => x.map((e) => e.textContent));
      for (const l of ["All", "Open", "Sent", "Approved", "Converted"]) assert.ok(ql.includes(l), l);
      await checks(f, page, `service-quotes-${device}-${theme}`, problems);

      await goTo(f, "/plans");
      await f.waitForSelector('.rs-tile.info');
      assert.match(await f.textContent(".rs-tile.info"), /Projected ARR\$[\d,]+/);
      const pl = await f.$$eval('[data-tile="plans"] .rs-tile-l', (x) => x.map((e) => e.textContent));
      for (const l of ["Active", "Awaiting signature", "Card needed", "Autopay off", "Failed payments", "After agreement", "Lights"]) assert.ok(pl.includes(l), l);
      assert.ok(await f.$('.rs-lrow a[href^="#/plans/"]'));
      await checks(f, page, `service-plans-${device}-${theme}`, problems);

      await goTo(f, "/requests");
      await f.waitForSelector('[data-tile="rq"][data-key="open"]');
      assert.equal(await title(f), "Requests");
      await checks(f, page, `service-requests-${device}-${theme}`, problems);
      assert.deepEqual(problems, []);
      await p.clean();
    } finally { await p.close(); }
  });

  test(`a request (${device}, ${theme}): from the +, an assessment booked and done, converted to a job`, async () => {
    const { p, page, f } = await open("olive", device, theme);
    const problems = [];
    try {
      await goTo(f, "/requests/new");
      await f.waitForSelector("[data-rq-f]");
      await checks(f, page, `service-request-new-${device}-${theme}`, problems);
      await f.click("[data-pick-contact]");
      await sheetUp(f, /Who is it for/);
      await f.fill(".sheet.on [data-q]", "Harper");
      await f.waitForSelector(".sheet.on [data-pick]");
      await f.click(".sheet.on [data-pick]");
      await sheetGone(f);
      await f.click('[data-svc="Exterior windows"]');
      await f.click('[data-svc="Gutters"]');
      await f.fill("[name=notes]", "Two story, gate on the left.");
      await f.click("[data-rq-f] [type=submit]");
      await f.waitForSelector(".sv-rtop");
      assert.match(await f.textContent(".sv-rtop"), /New[\s\S]*Phone[\s\S]*Exterior windows, Gutters/);
      await checks(f, page, `service-request-${device}-${theme}`, problems);
      // the assessment
      await f.click(".sv-rtop [data-assess]");
      await sheetUp(f, /Schedule an assessment/);
      await checks(f, page, `service-request-assess-${device}-${theme}`, problems);
      await f.click(".sheet.on [data-assess-f] [type=submit]");
      await sheetGone(f);
      await viewHas(f, /Assessment booked/);
      assert.match(await f.textContent(".sv-assess"), /on the Schedule/);
      await f.click(".sv-rtop [data-assessed]");
      await viewHas(f, /Assessed/);
      // convert to a job
      await f.click(".sv-rtop [data-convert]");
      await sheetUp(f, /Convert to/);
      await f.click('.sheet.on [data-pick="\\"job\\""]');
      await f.waitForFunction(() => location.hash.startsWith("#/jobs/jb_"), null, { timeout: 10000 });
      await f.waitForSelector(".wk-jtop .wk-jtitle");
      assert.match(await f.textContent(".wk-pricing"), /Exterior windows[\s\S]*Gutters/);
      assert.match(await f.inputValue('[data-notes="office"]'), /gate on the left/i, "the request's note rides on the job");
      // the list: it became work
      await goTo(f, "/requests");
      await f.click('[data-tile="rq"][data-key="converted"]');
      await f.waitForSelector('.rs-lrow a[href^="#/requests/"]');
      assert.match(await f.textContent(".rs-list"), /Converted/);
      assert.deepEqual(problems, []);
      await p.clean();
    } finally { await p.close(); }
  });

  test(`the job page's extras (${device}, ${theme}): balance due, time on site, the track, the visit's pills, the quick actions`, async () => {
    const { p, page, f } = await open("olive", device, theme);
    const problems = [];
    try {
      const id = seeded.jobs[1];
      await goTo(f, `/jobs/${id}`);
      await f.waitForSelector(".wk-jtop .rs-stat");
      assert.match(await f.textContent(".wk-jtop .rs-stat"), /Balance due[\s\S]*Time on site/);
      assert.ok(await f.$(".wk-jtop .rs-steps"), "the status track");
      assert.match(await f.textContent(".wk-jtop .rs-steps"), /Scheduled[\s\S]*On my way[\s\S]*Started[\s\S]*Done[\s\S]*Paid/);
      assert.ok(await f.$(".sv-vacts [data-v-move]"), "Reschedule for the office");
      await checks(f, page, `service-job-${device}-${theme}`, problems);
      await f.click(".sv-vacts [data-v-note]");
      await sheetUp(f, /A note on this visit/);
      await f.fill(".sheet.on [name=text]", "Back gate sticks.");
      await f.click(".sheet.on [data-vnote-f] [type=submit]");
      await sheetGone(f);
      // a done job: the quick actions
      const done = seeded.jobs[3];
      const mk = await p.ctx.request.post(`/api/crm/jobs/${done}/complete`, { headers: { "x-crm": "1", "content-type": "application/json" }, data: {} });
      assert.ok([200, 409].includes(mk.status()), `the job is done (${mk.status()})`);
      await goTo(f, `/jobs/${done}`);
      await f.waitForSelector(".wk-jtop");
      await f.click("#top-more");
      await sheetUp(f, /Job /);
      const rows = await f.$$eval(".sheet.on .rs-act-l", (x) => x.map((e) => e.textContent));
      for (const r of ["Ask for a review now", "Book a callback"]) assert.ok(rows.includes(r), r);
      await checks(f, page, `service-job-more-${device}-${theme}`, problems);
      await f.click('.sheet.on [data-q-review]');
      await sheetGone(f);
      await f.waitForSelector(".toast");
      assert.deepEqual(problems, []);
      await p.clean();
    } finally { await p.close(); }
  });

  test(`a plan (${device}, ${theme}): this year, the history strip, each visit's cost; an admin asks to cancel and the team saves it`, async () => {
    const { p, page, f } = await open("ada", device, theme);
    const problems = [];
    try {
      const id = device === "iphone13" ? seeded.plans.active : seeded.plans.lights;
      await goTo(f, `/plans/${id}`);
      await f.waitForSelector(".sv-strip");
      assert.match(await f.textContent(".pl-page"), /This year[\s\S]*How often[\s\S]*Next visit/);
      assert.match(await f.textContent(".sv-strip"), /Sold/);
      await checks(f, page, `service-plan-${device}-${theme}`, problems);
      await f.click("#top-more");
      await sheetUp(f, /./);
      const rows = await f.$$eval(".sheet.on .rs-act-l", (x) => x.map((e) => e.textContent));
      assert.ok(rows.includes("Ask to cancel") && !rows.includes("Cancel plan"), "an admin asks (Q4)");
      await f.click(".sheet.on [data-act=ask-cancel]");
      await sheetUp(f, /Ask to cancel/);
      await f.selectOption(".sheet.on [name=reason]", "price");
      await f.fill(".sheet.on [name=note]", "Found a cheaper guy.");
      await f.click(".sheet.on [data-ask-cancel] [type=submit]");
      await sheetGone(f);
      await f.waitForSelector(".pl-save");
      assert.match(await f.textContent(".pl-save"), /Wants to cancel[\s\S]*Found a cheaper guy/);
      await checks(f, page, `service-plan-save-${device}-${theme}`, problems);
      await f.click('.pl-save [data-save-step="call"]');
      await f.waitForSelector('.pl-save [data-save-step="call"][aria-checked="true"]');
      await f.click('.pl-save [data-save-offer="pause"]');
      await f.waitForSelector('.pl-save [data-save-offer="pause"][aria-checked="true"]');
      assert.match(await f.textContent(".pl-save"), /Offered/);
      await f.click('.pl-save [data-save-out="saved"]');
      await sheetUp(f, /Saved/);
      await f.click(".sheet.on [data-a=yes]");
      await f.waitForFunction(() => !document.querySelector(".pl-save"));
      assert.deepEqual(problems, []);
      await p.clean();
    } finally { await p.close(); }
  });
}

test("a desk at 1440: the Jobs tiles and a request page still lay out", async () => {
  const { p, page, f } = await open("olive", "desk1440", "light");
  try {
    await goTo(f, "/jobs");
    await f.waitForSelector('[data-tile="jobs"][data-key="today"]');
    assert.deepEqual(await screenProblems(f), []);
    await shot(page, "service-jobs-desk1440");
    await goTo(f, "/requests");
    await f.waitForSelector('[data-tile="rq"]');
    assert.deepEqual(await screenProblems(f), []);
    await p.clean();
  } finally { await p.close(); }
});
