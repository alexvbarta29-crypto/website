// Phone checks of the automation builder (docs/CRM-AUTOMATIONS.md):
// Menu → Automations, "Your automations", New automation from a starter,
// the editor (the plain-English sentence follows an edit, a condition, a
// step with its wait), save with the switch on, a test run on a customer
// (nothing sent), the run history and one run's steps, duplicate and delete
// with a confirm, the list's switch; a technician opens none of it. iPhone
// 13 and a 1440 desk. `node --test tests/e2e/automations.spec.mjs`
// (E2E_PORT picks the port, E2E_SHOTS saves screenshots).
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { start } from "./server.mjs";
import { launch, phone, signIn, crmFrame, goTo, settled, title, badLinks, screenProblems, shot, noInstallCard } from "./kit.mjs";

const store = await import("../../netlify/lib/crm-store.mjs");
const C = await import("../../netlify/lib/crm/modules/automations/catalog.mjs");

let srv, browser, seeded, history;
before(async () => {
  srv = await start({ port: Number(process.env.E2E_PORT || 0) });
  seeded = await srv.seed();
  browser = await launch();
  // an automation with a few runs to look at (in the server's process: the memory stores)
  history = await store.withStoreScope({ requestId: "e2e-auto" }, async () => {
    const O = { by: seeded.users.owner.id, origin: "api", actor_kind: "user", requestId: "e2e-auto" };
    const flow = (await store.createRecord("flow", { ...C.cleanFlow(C.RECIPES[1].flow), name: "Review request after a visit", enabled: true }, O)).data;
    const run = (status, extra) => store.createRecord("flow_run", {
      flow_id: flow.id, flow_name: flow.name, status, trigger: { kind: "event", event: "visit.completed" }, subject: { type: "contact", id: seeded.contacts.customer },
      contact_id: seeded.contacts.customer, started_at: "2026-11-16T20:00:00.000Z", plan: flow.steps, stop: flow.stop, step: 1, ...extra,
    }, O);
    await run("done", { steps: [{ status: "queued", at: "2026-11-16T22:00:00.000Z", result: "queued" }], finished_at: "2026-11-16T22:00:00.000Z" });
    await run("stopped", { contact_id: seeded.contacts.first, subject: { type: "contact", id: seeded.contacts.first }, started_at: "2026-11-15T20:00:00.000Z", steps: [{ status: "done", at: "2026-11-15T22:00:00.000Z", result: "stopped:replied" }], stop_reason: "stop_replied", finished_at: "2026-11-15T22:00:00.000Z" });
    return { flow };
  });
});
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
const viewHas = (f, re, timeout = 10000) => f.waitForFunction((src) => new RegExp(src).test(document.getElementById("view").textContent), re.source, { timeout });
const sheetUp = (f, re) => f.waitForFunction((src) => { const h = document.querySelector(".sheet.on h2"); return !!h && new RegExp(src).test(h.textContent); }, re.source, { timeout: 8000 });
const sheetGone = (f) => f.waitForFunction(() => !document.querySelector(".sheet.on"), null, { timeout: 8000 });
const toastSays = (f, re) => f.waitForFunction((src) => new RegExp(src).test((document.querySelector(".toasts") || document.getElementById("toasts") || {}).textContent || ""), re.source, { timeout: 8000 });
const sumHas = (f, re) => f.waitForFunction((src) => new RegExp(src).test((document.querySelector("[data-sum]") || {}).textContent || ""), re.source, { timeout: 8000 });

// E2E_DEVICES=iphone13,iphonese,desk1440 for the full phone walk
for (const device of (process.env.E2E_DEVICES || "iphone13,desk1440").split(",")) {
  test(`automation builder (${device}): a starter, edit, the sentence, save, test run, history, duplicate, delete`, async () => {
    const { p, page, f } = await open("olive", device);
    try {
      await goTo(f, "/automations");
      await viewHas(f, /All folders/);
      assert.equal(await title(f), "Workflows");
      // Flyra's folders by object: the seeded one (a visit is finished) under Jobs, with the built-in visit texts; All · On · Off tiles
      assert.match(await f.textContent("#view"), /Jobs[\s\S]*Review request after a visit[\s\S]*2 runs/);
      assert.deepEqual(await f.$$eval("#view [data-tile=au]", (els) => els.map((e) => e.dataset.key)), ["all", "on", "off"]);
      await f.click("[data-folder-pick]");
      await f.waitForSelector('.sheet.on [data-folder-key="estimates"]');
      assert.deepEqual(await screenProblems(f), [], "the folder sheet");
      await f.click('.sheet.on [data-folder-key="jobs"]');
      await f.waitForFunction(() => /Jobs/.test(document.querySelector("[data-folder-pick]").textContent));
      assert.doesNotMatch(await f.textContent("#view"), /Send the quote link/, "one folder: Estimates' built-ins are not here");
      await f.click('#view [data-tile=au][data-key="off"]');
      await f.waitForFunction(() => document.querySelector('#view [data-tile=au][data-key="off"]').getAttribute("aria-pressed") === "true");
      assert.equal(await f.$("#view [data-flow-toggle][aria-checked=true], #view [data-toggle][aria-checked=true]"), null, "Off shows only what is off");
      await f.click('#view [data-tile=au][data-key="off"]');
      await f.click("[data-folder-pick]");
      await f.waitForSelector(".sheet.on .rs-act-l");
      await f.click(".sheet.on .rs-act-l");
      await f.waitForFunction(() => /All folders/.test(document.querySelector("[data-folder-pick]").textContent));
      assert.deepEqual(await screenProblems(f), [], "the list passes the phone checks");
      await shot(page, `automations-list-${device}`);
      // New automation → Quote follow-up
      await f.click("[data-new-flow]");
      await sheetUp(f, /New automation/);
      assert.deepEqual(await screenProblems(f), [], "the starters sheet");
      await f.click('.sheet.on [data-recipe="quote_followup"]');
      await f.waitForFunction(() => /#\/automations\/flow\/af_/.test(location.hash), null, { timeout: 8000 });
      await settled(f);
      assert.equal(await title(f), "Quote follow-up");
      await sumHas(f, /When a quote is sent, if no reply in 3 days, text the Day 3 follow-up at 10 AM/);
      // a condition: only Meta Ads leads
      await f.click('[data-add-cond="cond"]');
      await f.waitForSelector("[name=c0_field]");
      await f.selectOption("[name=c0_field]", "source");
      await f.waitForSelector("[name=c0_value]");
      await f.fill("[name=c0_value]", "Meta Ads");
      await sumHas(f, /When a quote is sent and the lead source is Meta Ads/);
      // the task step waits a day
      await f.fill("[name=s1_wn]", "1");
      await f.selectOption("[name=s1_wu]", "days");
      await sumHas(f, /wait 1 day, then make a task for the owner/);
      assert.deepEqual(await screenProblems(f), [], "the editor passes the phone checks");
      await f.evaluate(() => { document.activeElement && document.activeElement.blur(); document.querySelector("[data-sum]").scrollIntoView({ block: "start" }); });
      await f.waitForTimeout(300);
      await shot(page, `automations-editor-${device}`);
      // on, and save
      await f.check("[name=enabled]");
      await f.click('#au-f button[type="submit"]');
      await toastSays(f, /Saved/);
      // a test run on a lead: what each step would do, nothing sent
      await f.click("[data-test]");
      await sheetUp(f, /Test with which customer/);
      await f.fill(".sheet.on [data-q]", "Avery Newlead");
      await f.waitForSelector(".sheet.on [data-pick]");
      await f.click(".sheet.on [data-pick]");
      await sheetUp(f, /Test run: Avery/);
      const out = await f.textContent(".sheet.on");
      assert.match(out, /Nothing was written and nothing was sent/);
      assert.match(out, /It would start\.|It wouldn't start: the lead source is Meta Ads/);
      assert.match(out, /Outbox \(dry run\)/);
      assert.deepEqual(await screenProblems(f), [], "the test run sheet");
      await f.waitForTimeout(500);
      await shot(page, `automations-test-run-${device}`);
      await f.click(".sheet.on [data-sheet-x]");
      await sheetGone(f);
      // duplicate, then delete the copy with a confirm
      const flowHash = await f.evaluate(() => location.hash);
      await f.click("[data-dup]");
      await f.waitForFunction((h) => location.hash !== h && /#\/automations\/flow\/af_/.test(location.hash), flowHash, { timeout: 8000 });
      await settled(f);
      assert.equal(await title(f), "Quote follow-up (copy)");
      await f.click("[data-del]");
      await sheetUp(f, /Delete "Quote follow-up \(copy\)"/);
      await f.click('.sheet.on [data-a="yes"]');
      await settled(f, { hash: "#/automations" });
      await viewHas(f, /Quote follow-up/);
      assert.doesNotMatch(await f.textContent("#view"), /\(copy\)/);
      // the list's switch pauses it
      const sw = await f.$("#view [data-flow-toggle][aria-checked=true]");
      assert.ok(sw, "the saved one is on");
      await sw.click();
      await toastSays(f, /Paused/);
      // run history of the seeded one, and one run's steps
      await goTo(f, `/automations/flow/${history.flow.id}/runs`);
      await viewHas(f, /Stopped/);
      assert.match(await f.textContent("#view"), /they replied/);
      await f.click("[data-run]");
      await f.waitForSelector(".sheet.on .au-out");
      assert.match(await f.textContent(".sheet.on"), /Text: Review ask after a visit[\s\S]*Sent to the sender/);
      assert.deepEqual(await screenProblems(f), [], "the run sheet");
      await f.waitForTimeout(500);
      await shot(page, `automations-run-${device}`);
      assert.deepEqual(await badLinks(f), []);
      await p.clean();
    } finally { await p.close(); }
  });
}

test("a technician opens no automation screen", async () => {
  const { p, f } = await open("theo", "iphone13");
  try {
    await goTo(f, `/automations/flow/${history.flow.id}`);
    await viewHas(f, /Not for this login/);
    await p.clean({ allow: [/403/] });
  } finally { await p.close(); }
});
