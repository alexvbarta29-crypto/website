// Phone checks of the map module (docs/CRM-MAP.md): Door to door (the
// knock map: a tap drops a pin, a pin opens, Convert to lead, knocking
// mode, a pin with no signal waiting and going out, the report, areas,
// drawing one) and the Team map (people, their age, their day), at iPhone
// 13, iPhone SE and a 1440 desk; a technician who knocks doors (Today's
// card, the knock map) and shares their location while on the clock (the
// bar across the top). The map services are stubbed (map-stub.mjs): the
// requests go to the real host names, so the CSP is tested as shipped,
// and nothing leaves the machine. `npm run e2e`.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { start } from "./server.mjs";
import { launch, phone, signIn, crmFrame, goTo, settled, title, badLinks, screenProblems, shot, noInstallCard, frameOffset } from "./kit.mjs";
import { seedMap, GRID } from "./map-seed.mjs";
import { stubMaps } from "./map-stub.mjs";

const store = await import("../../netlify/lib/crm-store.mjs");
const clock = await import("../../netlify/lib/crm/core/clock.mjs");
const TEAM = await import("../../netlify/lib/crm/modules/map/team.mjs");

let srv, browser, seeded, M;
before(async () => { srv = await start(); seeded = await srv.seed(); M = await seedMap(seeded); browser = await launch(); });
after(async () => { await browser?.close(); await srv?.close(); });

const HERE = { latitude: GRID.lat + 0.0002, longitude: GRID.lng - 0.0004 };
// geo: false leaves location unanswered, so the map stays on the service area and never flies under a finger
async function open(login, device, { geo = true } = {}) {
  const p = await phone(browser, srv, { device });
  const stub = await stubMaps(p.ctx);
  if (geo) await locate(p);
  await signIn(p, login);
  await p.page.goto("/office");
  const f = await crmFrame(p.page);
  await settled(f);
  await noInstallCard(p.page);
  return { p, page: p.page, f, stub };
}
async function locate(p) {
  await p.ctx.grantPermissions(["geolocation"], { origin: srv.url });
  await p.ctx.setGeolocation(HERE);
}
const api = async (p, path) => (await (await p.ctx.request.get("/api/crm" + path, { headers: { "x-crm": "1" } })).json()).data;
const sheetUp = (f, re) => f.waitForFunction((src) => { const h = document.querySelector(".sheet.on h2"); return !!h && new RegExp(src).test(h.textContent); }, re.source, { timeout: 8000 });
const sheetGone = (f) => f.waitForFunction(() => !document.querySelector(".sheet"), null, { timeout: 8000 });
// a screenshot once a sheet has finished sliding up
const sheetShot = async (page, name) => { await page.waitForTimeout(400); await shot(page, name); };
const closeSheet = async (f) => { await f.click(".sheet.on [data-sheet-x]"); await sheetGone(f); };
// the map drew its style and our layers
const mapReady = async (f) => {
  await f.waitForSelector(".mp-map .maplibregl-canvas", { timeout: 15000 });
  await f.waitForFunction(() => { const m = document.querySelector(".mp-map"); return m && m.getBoundingClientRect().height > 200; }, null, { timeout: 15000 });
  await f.evaluate(() => new Promise((ok) => setTimeout(ok, 1200)));
};
// a tap on the map at (dx, dy) from its center, in page coordinates
async function tapMap(page, f, dx = 0, dy = 0) {
  const o = await frameOffset(page, f);
  const r = await f.$eval(".mp-map", (el) => { const b = el.getBoundingClientRect(); return { x: b.left + b.width / 2, y: b.top + b.height / 2 }; });
  await page.mouse.click(o.x + r.x + dx, o.y + r.y + dy);
}

for (const device of ["iphone13", "iphonese", "desk1440"]) {
  test(`door to door (${device}): the map with customers, leads, pins and areas; a tap drops a pin; the pin opens; convert to lead; knocking mode; the report and areas`, async () => {
    const { p, page, f, stub } = await open("olive", device, { geo: false });
    try {
      await goTo(f, "/menu");
      assert.match(await f.textContent("#view"), /Sales[\s\S]*Door to door/);
      assert.match(await f.textContent("#view"), /Work[\s\S]*Team map/);
      await goTo(f, "/knock");
      assert.equal(await title(f), "Door to door");
      await mapReady(f);
      assert.ok(stub.calls.some((u) => u === "https://tiles.openfreemap.org/styles/liberty"), "the street map's style, from its real host");
      assert.ok(stub.calls.some((u) => u.startsWith("https://basemap.nationalmap.gov/arcgis/rest/services/USGSImageryOnly/MapServer/tile/")), "satellite first, from its real host");
      assert.equal(await f.$eval("[data-note]", (el) => el.textContent.trim()).then((x) => /didn't load|can't draw/.test(x)), false);
      assert.match(await f.textContent("[data-credits]"), /OpenStreetMap[\s\S]*USGS/);
      // Rotor's layout: no header on a phone, the round buttons top-left
      assert.equal(await f.$$eval("[data-top] .mp-fab", (b) => b.map((x) => x.dataset.fab).join(",")), "search,locate,filter,layers");
      if (device !== "desk1440") assert.equal(await f.$eval("#top", (el) => getComputedStyle(el).display), "none", "the map is the whole screen");
      assert.equal(await f.getAttribute("[data-fab=layers]", "aria-pressed"), "true");
      assert.match(await f.textContent("[data-note]"), /door[s]? to go back to/);
      assert.deepEqual(await screenProblems(f), []);
      await shot(page, `map-knock-${device}`);
      await f.click("[data-fab=layers]");
      assert.equal(await f.getAttribute("[data-fab=layers]", "aria-pressed"), "false", "one tap: streets");
      await f.evaluate(() => new Promise((ok) => setTimeout(ok, 400)));
      await shot(page, `map-knock-streets-${device}`);

      // the filter hides what's on the map (and a tap on an empty spot then drops a pin)
      await f.click("[data-fab=filter]");
      await sheetUp(f, /Show on the map/);
      assert.match(await f.textContent(".sheet.on"), /Pins[\s\S]*Customers[\s\S]*Open leads[\s\S]*Areas[\s\S]*Pin types[\s\S]*Not home[\s\S]*Whose pins/);
      for (const n of ["pins", "customers", "leads", "areas"]) await f.click(`.sheet.on [name=${n}]`);
      assert.deepEqual(await screenProblems(f), []);
      await sheetShot(page, `map-knock-filter-${device}`);
      await closeSheet(f);
      assert.match(await f.getAttribute("[data-fab=filter]", "class"), /\bon\b/);
      const before = (await api(p, "/map/pins")).pins.length;
      await tapMap(page, f, -22, 88);
      await sheetUp(f, /New pin/);
      assert.match(await f.textContent(".sheet.on"), /Not home[\s\S]*Interested[\s\S]*Booked/);
      assert.deepEqual(await screenProblems(f), []);
      await sheetShot(page, `map-knock-new-pin-${device}`);
      await f.click('.sheet.on [data-type="interested"]');
      await sheetGone(f);
      const after1 = (await api(p, "/map/pins")).pins;
      assert.equal(after1.length, before + 1);
      // everything back: the new pin is the nearest to the same spot
      await f.click("[data-fab=filter]");
      await sheetUp(f, /Show on the map/);
      await f.click(".sheet.on [data-reset]");
      await sheetGone(f);
      // search: a street of a pin, a customer, an area
      await f.click("[data-fab=search]");
      await sheetUp(f, /Search the map/);
      await f.fill(".sheet.on [name=q]", "west blocks");
      await f.waitForSelector(".sheet.on [data-hit]");
      assert.match(await f.textContent(".sheet.on [data-results]"), /West blocks/);
      await f.fill(".sheet.on [name=q]", "mapfolk");
      await f.waitForFunction(() => /Mapfolk/.test(document.querySelector(".sheet.on [data-results]").textContent));
      assert.deepEqual(await screenProblems(f), []);
      await closeSheet(f);
      // the pin opens where it was dropped: its knock, the actions
      await tapMap(page, f, -22, 88);
      await sheetUp(f, /^Pin$/);
      assert.match(await f.textContent(".sheet.on"), /Interested[\s\S]*Knocks[\s\S]*Knocked again[\s\S]*Convert to lead/);
      await f.click('.sheet.on [data-mode="convert"]');
      await f.fill(".sheet.on [name=first_name]", "Pat");
      await f.fill(".sheet.on [name=last_name]", "Doorstep");
      await f.fill(".sheet.on [name=phone]", "763-555-0177");
      await f.fill(".sheet.on [name=street1]", "250 Example Ave");
      await f.fill(".sheet.on [name=city]", "Delano");
      assert.deepEqual(await screenProblems(f), []);
      await sheetShot(page, `map-knock-convert-${device}`);
      await f.click(".sheet.on [type=submit]");
      // the office lands on the new lead
      await f.waitForFunction(() => /^#\/contacts\/ct_/.test(location.hash), null, { timeout: 10000 });
      await settled(f);
      // (on a desk the contact opens beside the list)
      assert.match(await f.textContent("#main"), /Pat Doorstep/);
      assert.match(await f.textContent("#main"), /Door to Door/);

      // knocking mode: the cross, Pin here, Stop (now with the phone's location)
      await locate(p);
      await goTo(f, "/knock");
      await mapReady(f);
      await f.click("[data-act=knock]");
      await f.waitForSelector("[data-cross]:not([hidden])");
      assert.match(await f.textContent("[data-bottom]"), /Pin here/);
      assert.deepEqual(await screenProblems(f), []);
      await shot(page, `map-knocking-${device}`);
      await f.click("[data-act=here]");
      await sheetUp(f, /New pin/);
      await closeSheet(f);
      await f.click("[data-act=stop]");
      await f.waitForSelector("[data-cross][hidden]", { state: "attached" });

      // the leaderboard and report (from More), the areas
      await f.click("[data-act=more]");
      await sheetUp(f, /Door to door/);
      assert.match(await f.textContent(".sheet.on"), /Leaderboard and report[\s\S]*Areas[\s\S]*Draw an area[\s\S]*Team map[\s\S]*Pin types[\s\S]*Map credits/);
      await f.click('.sheet.on a[href="#/knock/report"]');
      await settled(f, { hash: "#/knock/report" });
      assert.equal(await title(f), "Door-to-door report");
      const rep = await f.textContent("#view");
      assert.match(rep, /doors knocked[\s\S]*Leaderboard[\s\S]*Olive Owner/);
      assert.match(rep, /By area[\s\S]*West blocks/);
      assert.deepEqual(await screenProblems(f), []);
      await shot(page, `map-report-${device}`);
      await goTo(f, "/knock/areas");
      assert.match(await f.textContent("#view"), /West blocks[\s\S]*Theo Tech/);
      assert.deepEqual(await badLinks(f), []);
      assert.deepEqual(await screenProblems(f), []);
      await p.clean();
    } finally { await p.close(); }
  });

  test(`team map (${device}): each person on the clock, how fresh, their day; the help says what the iPhone can't do`, async () => {
    const { p, page, f } = await open("olive", device);
    try {
      await goTo(f, "/team-map");
      assert.equal(await title(f), "Team map");
      await mapReady(f);
      await f.waitForSelector("[data-list] .mp-prow");
      assert.equal(await f.getAttribute("[data-fab=layers]", "aria-pressed"), "false", "the team map starts on streets");
      const list = await f.textContent("[data-list]");
      assert.match(list, /Theo Tech[\s\S]*On the clock · [2-4] min ago/);
      assert.match(list, /Tess Rowe[\s\S]*On the clock · 1[4-6] min ago/);
      assert.match(list, /Now:|Next:/);
      assert.ok(await f.$(".mp-person .mp-person-dot"), "a person on the map");
      assert.deepEqual(await screenProblems(f), []);
      await shot(page, `map-team-${device}`);
      await f.click(`[data-list] [data-person="${seeded.users.tech.id}"]`);
      await sheetUp(f, /Theo Tech/);
      assert.match(await f.textContent(".sheet.on"), /Today[\s\S]*W\.[\s\S]*Booked[\s\S]*Open the route/);
      assert.deepEqual(await screenProblems(f), []);
      await sheetShot(page, `map-team-person-${device}`);
      await closeSheet(f);
      assert.equal(await f.$$eval("[data-top] .mp-fab", (b) => b.length), 4);
      await f.click("[data-help]");
      await sheetUp(f, /How the team map works/);
      assert.match(await f.textContent(".sheet.on"), /iPhone home-screen app can't share its location in the background/);
      await closeSheet(f);
      await p.clean();
    } finally { await p.close(); }
  });
}

test("a technician who knocks doors: Today's card, the knock map; on the clock they're asked once and then see the sharing bar on every screen; the team map isn't theirs", async () => {
  const { p, page, f } = await open("theo", "iphone13");
  try {
    // the team map's question, once (they're clocked in and turned on)
    await sheetUp(f, /Share your location while on the clock/);
    await f.click('.sheet.on [data-a="yes"]');
    await sheetGone(f);
    await f.waitForSelector("#loc-bar .loc-btn", { timeout: 8000 });
    assert.match(await f.textContent("#loc-bar"), /Sharing your location while on the clock/);
    // the position went to the server (the seed left 24 points of the day)
    let pts = 0;
    for (let i = 0; i < 40 && pts <= 24; i++) {
      await page.waitForTimeout(250);
      pts = await store.withStoreScope({ requestId: "e2e-map" }, async () => { const g = await store.getRaw(TEAM.dayKey(clock.localDate(clock.now()), seeded.users.tech.id)); return g && g.data ? g.data.pts.length : 0; });
    }
    assert.equal(pts, 25, "one position kept, at once");
    await goTo(f, "/today");
    assert.match(await f.textContent("#view"), /Door to door: the knock map/);
    await goTo(f, "/knock");
    await mapReady(f);
    assert.ok(await f.$("#loc-bar"), "the bar stays on every screen");
    assert.deepEqual(await screenProblems(f), []);
    await shot(page, `map-knock-tech-sharing-iphone13`);
    await tapMap(page, f, 30, 60);
    await sheetUp(f, /New pin/);
    await f.click('.sheet.on [data-type="not_home"]');
    await sheetGone(f);
    await goTo(f, "/team-map");
    assert.match(await f.textContent("#view"), /Not for this login/);
    // the bar's Details: stop for today on this phone
    await f.click("#loc-bar .loc-btn");
    await sheetUp(f, /Your location/);
    await f.click(".sheet.on [data-stop]");
    await f.waitForFunction(() => !document.getElementById("loc-bar"));
    await p.clean();
  } finally { await p.close(); }
});

test("Map as a top-level screen (#/map, a pinnable tab): the same knock map, titled Map", async () => {
  const { p, f } = await open("olive", "iphone13", { geo: false });
  try {
    // opened as itself (a link; a pinned tab once the bar offers it: the route has no parent, so a tab root has no back arrow)
    await p.page.goto("/office#crm/map");
    const g = await crmFrame(p.page);
    await settled(g, { hash: "#/map" });
    assert.equal(await title(g), "Map");
    await mapReady(g);
    assert.equal(await g.$$eval("[data-top] .mp-fab", (b) => b.length), 4);
    void f;
    assert.deepEqual(await screenProblems(g), []);
    await p.clean();
  } finally { await p.close(); }
});

test("no signal at the door: a pin waits on the phone, shows as waiting, and goes out when signal is back", async () => {
  const { p, page, f } = await open("olive", "iphone13");
  try {
    await goTo(f, "/knock");
    await mapReady(f);
    const before = (await api(p, "/map/pins")).pins.length;
    await p.ctx.setOffline(true);
    await f.evaluate(() => window.dispatchEvent(new Event("offline")));
    await tapMap(page, f, 40, -70);
    await sheetUp(f, /New pin/);
    await f.waitForFunction(() => /No signal/.test(document.querySelector(".sheet.on [data-addr]").textContent), null, { timeout: 8000 });
    await f.click('.sheet.on [data-type="not_home"]');
    await sheetGone(f);
    await f.waitForFunction(() => /wait for signal/.test(document.querySelector("[data-note]").textContent), null, { timeout: 8000 });
    await shot(page, "map-knock-offline-iphone13");
    await p.ctx.setOffline(false);
    await f.evaluate(() => window.dispatchEvent(new Event("online")));
    let after = before;
    for (let i = 0; i < 40 && after === before; i++) { await page.waitForTimeout(250); after = (await api(p, "/map/pins")).pins.length; }
    assert.equal(after, before + 1, "the waiting pin went out");
    await p.clean({ allow: [/Failed to fetch|NetworkError|ERR_INTERNET_DISCONNECTED/] });
  } finally { await p.close(); }
});

test("drawing an area (desk): More → Draw an area, three corners, Done, a name and who knocks it", async () => {
  const { p, page, f } = await open("olive", "desk1440");
  try {
    await goTo(f, "/knock");
    await mapReady(f);
    await f.click("[data-act=more]");
    await sheetUp(f, /Door to door/);
    await f.click(".sheet.on [data-draw]");
    await sheetGone(f);
    for (const [dx, dy] of [[-120, -80], [120, -80], [0, 120]]) await tapMap(page, f, dx, dy);
    await f.waitForFunction(() => /3 corners/.test(document.querySelector("[data-bottom]").textContent));
    await f.click("[data-act=done-draw]");
    await sheetUp(f, /New area/);
    await f.fill(".sheet.on [name=name]", "Lake blocks");
    await f.click(`.sheet.on [name="p_${seeded.users.tech.id}"]`);
    await sheetShot(page, "map-draw-area-desk1440");
    await f.click(".sheet.on [type=submit]");
    await sheetGone(f);
    const areas = await api(p, "/map/territories");
    const lake = areas.find((a) => a.name === "Lake blocks");
    assert.ok(lake && lake.polygon.length === 3 && lake.assignee_ids.includes(seeded.users.tech.id));
    assert.deepEqual(await screenProblems(f), []);
    await p.clean();
  } finally { await p.close(); }
});
