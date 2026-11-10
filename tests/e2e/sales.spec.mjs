// Phone checks of the sales screens (M2b; design §12.4, §9.2): Leads &
// calls, logging a call, the text sent by hand while texting is in dry-run,
// one follow-up, Tasks (the office's and a tech's), at iPhone 13 and
// iPhone SE sizes. `npm run e2e`.
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
const sheetGone = async (f) => f.waitForFunction(() => !document.querySelector(".sheet"), null, { timeout: 5000 });

for (const device of ["iphone13", "iphonese"]) {
  test(`sales (${device}): Leads & calls, log a call, send the text by hand`, async () => {
    const { p, page, f } = await open("olive", device);
    try {
      await goTo(f, "/calls");
      assert.equal(await title(f), "Leads & calls");
      assert.deepEqual(await screenProblems(f), [], "the call list passes the phone checks");
      assert.deepEqual(await badLinks(f), []);
      await shot(page, `sales-calls-${device}`);
      // the fresh lead's first step is due now: Log → No answer → the text to send by hand
      const row = `[data-log="${seeded.enrollments.lead}"]`;
      if (device === "iphone13") {
        await f.click(row);
        await sheetUp(f, /How did it go/);
        assert.deepEqual(await screenProblems(f), [], "the outcome sheet passes the phone checks");
        await shot(page, `sales-outcome-${device}`);
        await f.click('.sheet [data-outcome="no_answer"]');
        await sheetUp(f, /Send this text yourself/);
        assert.match(await f.getAttribute(".sheet [data-sms]", "href"), /^sms:/, "Open in Messages is an sms: link (it stays in the frame)");
        assert.deepEqual(await screenProblems(f), [], "the hand-send sheet passes the phone checks");
        await shot(page, `sales-hand-${device}`);
        await f.click(".sheet [data-sent]");
        await sheetGone(f);
        await f.waitForFunction(() => /On to the next step/.test((document.querySelector(".toasts") || {}).textContent || ""));
      } else {
        // the second phone: No answer, then "Not yet": the text waits on the list
        await f.click(`[data-log="${seeded.enrollments.called}"]`);
        await sheetUp(f, /How did it go/);
        await f.click('.sheet [data-outcome="no_answer"]');
        await sheetUp(f, /Send this text yourself/);
        assert.deepEqual(await screenProblems(f), [], "the hand-send sheet passes the phone checks");
        await f.click(".sheet [data-later]");
        await sheetGone(f);
        await f.waitForSelector(`[data-pending="${seeded.enrollments.called}"]`, { timeout: 5000 });
        // "Did you send it?" from the list
        await f.click(`[data-pending="${seeded.enrollments.called}"]`);
        await f.waitForSelector(".sheet.on");
        assert.deepEqual(await screenProblems(f), [], "the pending sheet passes the phone checks");
        await f.click(".sheet [data-sent]");
        await sheetGone(f);
      }
      // one follow-up
      await goTo(f, `/enrollments/${seeded.enrollments.talked}`);
      assert.equal(await title(f), "Quinn Talkedto", "a follow-up is titled with its lead");
      assert.deepEqual(await screenProblems(f), [], "a follow-up passes the phone checks");
      assert.deepEqual(await badLinks(f), []);
      await shot(page, `sales-enrollment-${device}`);
      await p.clean();
    } finally { await p.close(); }
  });
}

test("sales: tasks for the office and for a tech", async () => {
  const { p, page, f } = await open("olive", "iphone13");
  try {
    await goTo(f, "/tasks");
    assert.equal(await title(f), "Tasks");
    assert.match(await f.textContent("#view"), /gutter add-on/);
    assert.deepEqual(await screenProblems(f), [], "Tasks passes the phone checks");
    await shot(page, "sales-tasks-owner");
    await p.clean();
  } finally { await p.close(); }
  const t = await open("theo", "iphonese");
  try {
    await goTo(t.f, "/tasks");
    const text = await t.f.textContent("#view");
    assert.match(text, /ladder hooks/, "the tech's own task");
    assert.doesNotMatch(text, /gutter add-on|Talkedto/, "never the office's tasks or their contacts");
    assert.deepEqual(await screenProblems(t.f), [], "a tech's Tasks passes the phone checks");
    await goTo(t.f, `/tasks/${seeded.tasks.tech}`);
    assert.equal(await title(t.f), "Task");
    await shot(t.page, "sales-task-tech");
    for (const path of ["/calls", "/settings/cadences", `/enrollments/${seeded.enrollments.lead}`]) {
      await goTo(t.f, path);
      assert.match(await t.f.textContent("#view"), /Not for this login/, `${path} is not for a tech`);
    }
    await t.p.clean();
  } finally { await t.p.close(); }
});
