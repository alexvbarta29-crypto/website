// The tech app with no signal (M4b; design §2.5, §11.4 M4b "offline.spec",
// §12.4): a cold start in flight mode shows the day this phone kept (and a
// visit of it opens); flight mode switched on halfway through a visit
// keeps working (timer, checklist, photos, notes, completion wait in the
// phone's outbox) and, with signal back, replays them in order so the
// server ends up exactly where the phone was; a 2 s round trip still
// starts the app from the phone's copy. Chromium at iPhone sizes against
// tests/e2e/server.mjs; `npm run e2e`.
//
// The release adds every client file to the service worker's precache
// (build/crm_precache.mjs, the integrator's step); a working tree with new
// client files isn't released yet, so these checks put the files the
// precache list doesn't name yet into the app cache themselves, as the
// release will.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { start } from "./server.mjs";
import { launch, phone, signIn, crmFrame, settled, title, screenProblems, shot, noInstallCard } from "./kit.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const { appFiles } = await import("../../build/crm_precache.mjs");

let srv, browser, seeded;
before(async () => { srv = await start(); seeded = await srv.seed(); browser = await launch(); });
after(async () => { await browser?.close(); await srv?.close(); });

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
// The client files the service worker's precache list doesn't name yet (new in this working tree), into its app cache.
async function precacheNew(page) {
  const sw = readFileSync(path.join(ROOT, "crm-sw.js"), "utf8");
  const listed = new Set([...sw.matchAll(/"(\/crm-app\/[^"]+)"/g)].map((m) => m[1]));
  const missing = appFiles(ROOT).filter((f) => !listed.has(f));
  await page.evaluate(async (files) => {
    const name = (await caches.keys()).find((n) => n.startsWith("crm-app-"));
    await (await caches.open(name)).addAll(files);
  }, missing);
  return missing;
}

async function open(login, device = "iphone13") {
  const p = await phone(browser, srv, { device });
  await p.ctx.clock.install({ time: Date.parse(srv.now()) });     // the phone's clock reads the server's test day
  await signIn(p, login);
  await p.page.goto("/office");
  const f = await crmFrame(p.page);
  await settled(f);
  await noInstallCard(p.page);
  return { p, page: p.page, f };
}
// The server's view, straight from this process (the phone may be offline).
async function server(p, apiPath) {
  const cookie = (await p.ctx.cookies()).map((c) => `${c.name}=${c.value}`).join("; ");
  const res = await fetch(srv.url + "/api/crm" + apiPath, { headers: { cookie, "x-crm": "1" } });
  return (await res.json()).data;
}
const waitFor = async (fn, { timeout = 30000, every = 300 } = {}) => {
  const deadline = Date.now() + timeout;
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() > deadline) throw new Error("timed out waiting");
    await new Promise((r) => setTimeout(r, every));
  }
};
async function snap(page, f, selector) {
  const b64 = await f.evaluate(async () => {
    const c = document.createElement("canvas");
    c.width = 640; c.height = 480;
    const g = c.getContext("2d");
    g.fillStyle = "#13a165"; g.fillRect(0, 0, 640, 480);
    return c.toDataURL("image/jpeg", 0.8).split(",")[1];
  });
  const [fc] = await Promise.all([page.waitForEvent("filechooser"), f.click(selector)]);
  await fc.setFiles({ name: "photo.jpg", mimeType: "image/jpeg", buffer: Buffer.from(b64, "base64") });
}

test("cold start in flight mode: the day this phone kept, and a visit of it, open with no signal", async () => {
  const { p, page, f } = await open("tess");
  const problems = [];
  try {
    await f.waitForSelector(`.tf-stop a[href="#/visits/${seeded.visits[1]}"]`);
    await keptOffline(page);
    await precacheNew(page);
    await page.waitForTimeout(1500);                    // the day's visits are copied in the background
    await p.ctx.setOffline(true);
    await page.goto("/office");
    await page.waitForSelector("#off", { state: "attached", timeout: 10000 });      // the offline launcher
    const g = await crmFrame(page);
    await g.waitForSelector(`.tf-stop a[href="#/visits/${seeded.visits[1]}"]`, { timeout: 10000 });
    assert.equal(await title(g), "Today");
    assert.match(await g.textContent(".tf-today"), /No signal\. Your day as of/);
    for (const x of await screenProblems(g)) problems.push(`offline today: ${x}`);
    await shot(page, "offline-cold-today");
    await g.click(`.tf-stop a[href="#/visits/${seeded.visits[1]}"]`);
    await g.waitForSelector("[data-panel=field] .tf-state", { timeout: 10000 });
    assert.match(await g.textContent("[data-panel=field]"), /No signal\. This visit as of/);
    for (const x of await screenProblems(g)) problems.push(`offline visit: ${x}`);
    await shot(page, "offline-cold-visit");
    // on my way needs signal: refused on the phone, nothing queued
    await g.click("[data-omw]");
    await g.waitForFunction(() => /needs signal/.test((document.querySelector(".toasts") || {}).textContent || ""));
    assert.equal(await g.evaluate(async () => (await import("/crm-app/core/outbox.js")).count()), 0);
    assert.deepEqual(problems, []);
    await p.ctx.setOffline(false);
    await p.clean();
  } finally { await p.close(); }
});

test("flight mode on halfway through a visit: timer, checklist, photos, a note and completion wait, then replay in order", async () => {
  const visitId = seeded.visits[2];                     // Theo's 10:00 visit
  const { p, page, f } = await open("theo", "iphonese");
  try {
    await f.waitForSelector(`.tf-stop a[href="#/visits/${visitId}"]`);
    await keptOffline(page);
    await precacheNew(page);
    await f.click(`.tf-stop a[href="#/visits/${visitId}"]`);
    await settled(f, { hash: `#/visits/${visitId}` });
    await f.waitForSelector("[data-timer=start]");
    await f.click("[data-timer=start]");               // with signal
    await f.waitForSelector("[data-timer=pause]");
    assert.equal((await server(p, `/visits/${visitId}`)).visit.status, "in_progress");

    // no signal from here
    await p.ctx.setOffline(true);
    await f.waitForFunction(() => navigator.onLine === false);
    await f.click("[data-item=gate_closed]");
    await f.waitForSelector("[data-item=gate_closed][aria-pressed=true]");
    await snap(page, f, "[data-item=walkaround_photo]");
    await f.waitForSelector("[data-item=walkaround_photo][aria-pressed=true]", { timeout: 15000 });
    await snap(page, f, "[data-item=after_photo]");
    await f.waitForSelector("[data-item=after_photo][aria-pressed=true]", { timeout: 15000 });
    assert.equal(await f.$$eval(".tf-photo.wait img", (x) => x.length), 2, "the photos show from the phone while they wait");
    await f.fill("[data-note-form] textarea", "Synthetic: done with no signal.");
    await f.click("[data-note-form] [type=submit]");
    await f.waitForFunction(() => /done with no signal/.test(document.querySelector("[data-panel=field]").textContent));
    await f.click("[data-complete]");
    await f.waitForSelector(".tf-done", { timeout: 8000 });
    assert.match(await f.textContent(".tf-done"), /waiting for signal/);
    assert.match(await f.textContent("[data-panel=field]"), /\d+ changes wait/);
    assert.equal(await f.$$eval(".tf-wait", (x) => x.length), 1, "one bar says it all");
    assert.equal(await f.$eval("#banner", (b) => getComputedStyle(b).display), "none", "the app's offline banner steps aside for it");
    await shot(page, "offline-halfway-done");
    for (const x of await screenProblems(f)) assert.fail(`offline visit: ${x}`);
    const queued = await f.evaluate(async () => (await import("/crm-app/core/outbox.js")).list());
    assert.deepEqual(queued.map((i) => i.path.split("/").pop()), ["checklist", "photos", "photos", "notes", "complete"], "in the order they were made");
    assert.ok(queued.every((i) => i.body.queued_offline === true && i.body.client_at && i.body.queued_at === i.body.client_at && i.body.client_id));
    // the server hasn't heard a thing
    const before = (await server(p, `/visits/${visitId}`)).visit;
    assert.equal(before.status, "in_progress");
    assert.equal(before.photos.length, 0);
    const tickedAt = queued[0].body.client_at;
    const doneAt = queued[4].body.client_at;

    // signal again: everything goes out, in order
    await p.ctx.setOffline(false);
    const after = await waitFor(async () => { const v = (await server(p, `/visits/${visitId}`)).visit; return v.status === "completed" ? v : null; });
    assert.equal(after.photos.length, 2, "both photos");
    assert.ok(after.checklist.items.filter((i) => i.required).every((i) => i.done_at), "every required item, so the completion was allowed");
    assert.equal(after.checklist.items.find((i) => i.key === "gate_closed").done_at, new Date(tickedAt).toISOString(), "ticked at the phone's time");
    assert.equal(after.completion.at, new Date(doneAt).toISOString(), "done at the phone's time");
    assert.match(after.tech_notes, /done with no signal/);
    const field = await server(p, `/visits/${visitId}/field`);
    assert.ok(field.timers.length === 1 && field.timers[0].end_at === after.completion.at, "the timer stopped at the completion");
    await f.waitForFunction(async () => (await import("/crm-app/core/outbox.js")).count().then((n) => n === 0), null, { timeout: 15000 });
    const sheets = await server(p, "/me/timesheets");
    assert.equal(sheets.pending.length, 0, "nothing for the office to decide: the phone's times were taken");
    await f.waitForFunction(() => !/\d+ changes? waits?/.test(document.querySelector("#view").textContent), null, { timeout: 15000 });
    await shot(page, "offline-halfway-replayed");
    await p.clean();
  } finally { await p.close(); }
});

// The phone's copies of the day, by date (core/cache.js: "{user}|/api/crm/tech/day?date=...").
const dayCopies = (f) => f.evaluate(() => new Promise((res) => {
  const r = indexedDB.open("crm-cache");
  r.onsuccess = () => { const t = r.result.transaction("kv").objectStore("kv").getAllKeys(); t.onsuccess = () => res(t.result.map(String).filter((k) => /tech\/day/.test(k)).map((k) => (/date=([\d-]+)/.exec(k) || [])[1] || "none")); };
  r.onerror = () => res([]);
}));

test("the next morning, opened with no signal: today's copy (kept the day before), never yesterday's shown as today", async () => {
  const { p, page, f } = await open("tess", "iphonese");
  try {
    await f.waitForSelector(`.tf-stop a[href="#/visits/${seeded.visits[1]}"]`);
    await keptOffline(page);
    await precacheNew(page);
    // the day is read by date, and tomorrow's copy is kept in the background
    await waitFor(async () => (await dayCopies(f)).includes("2026-11-18"));
    assert.ok(!(await dayCopies(f)).includes("none"), "never an undated copy");
    // 7:30 the next morning, first open of the day, at a stop with no signal
    await p.ctx.setOffline(true);
    await page.clock.setSystemTime(Date.parse(srv.now()) + 22.5 * 3600000);
    await page.goto("/office");
    await page.waitForSelector("#off", { state: "attached", timeout: 10000 });      // the offline launcher
    let g = await crmFrame(page);
    await g.waitForSelector(".tf-dayline", { timeout: 10000 });
    assert.match(await g.textContent(".tf-dayline"), /Today, Wed, Nov 18/);
    await g.waitForSelector(`.tf-stop a[href="#/visits/${seeded.visits[5]}"]`);
    assert.equal(await g.$(`.tf-stop a[href="#/visits/${seeded.visits[1]}"]`), null, "yesterday's visits aren't today's");
    assert.match(await g.textContent(".tf-today"), /No signal\. Your day as of Tue, Nov 17, /, "when the copy is from, with its day");
    assert.equal(await g.$$eval(".tf-wait", (x) => x.length), 1);
    // one bar: the app's banner and the office shell's bar both step aside for the screen's line
    assert.equal(await g.$eval("#banner", (b) => getComputedStyle(b).display), "none");
    await page.waitForFunction(() => document.getElementById("off").hidden === true, null, { timeout: 5000 });
    await shot(page, "offline-next-morning");
    // two days on, nothing kept for that day: said plainly, no other day in its place
    await page.clock.setSystemTime(Date.parse(srv.now()) + 72 * 3600000);
    await page.goto("/office");
    await page.waitForSelector("#off", { state: "attached", timeout: 10000 });      // the offline launcher
    g = await crmFrame(page);
    await g.waitForSelector(".tf-today .card.empty", { timeout: 10000 });
    assert.match(await g.textContent(".tf-dayline"), /Today, Fri, Nov 20/);
    assert.match(await g.textContent(".tf-today"), /today's list isn't on this phone yet/);
    assert.equal(await g.$(".tf-stop"), null);
    await shot(page, "offline-no-copy");
    await p.ctx.setOffline(false);
  } finally { await p.close(); }
});

test("a 2 s round trip: the app starts from the phone's copy at once, and the day arrives", async () => {
  const { p, page } = await open("tess", "iphonese");
  try {
    await keptOffline(page);
    await precacheNew(page);
    srv.setLatency(2000);
    const t0 = Date.now();
    await page.goto("/crm", { waitUntil: "commit", timeout: 30000 });
    await page.waitForSelector("#tabs [data-tab]", { timeout: 20000 });
    const shellMs = Date.now() - t0;
    assert.ok(shellMs < 1500, `the shell shows before the first answer could arrive (${shellMs} ms)`);
    await page.waitForSelector(".tf-stop", { timeout: 30000 });
    assert.equal(await page.$("#view [data-retry]"), null, "no error card");
    await shot(page, "offline-slow-start");
  } finally { srv.setLatency(0); await p.close(); }
});
