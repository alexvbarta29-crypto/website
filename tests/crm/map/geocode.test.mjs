// Geocoding (docs/CRM-MAP.md "Outside hosts"): the Census Bureau's batch
// geocoder (the map.geocode sweep) and Nominatim for a dropped pin, both
// against a mocked fetch: only production calls them, only the address (or
// the two coordinates) goes out, the batch stays inside its size, its daily
// cap and its back-off, and Nominatim is asked at most once a second for
// the whole site, with an identifying User-Agent and a cache. Synthetic
// addresses only.
import { test, afterEach } from "node:test";
import assert from "node:assert/strict";
import { crmTest } from "../../helpers/crm-http.mjs";
import { strictFetch } from "../../helpers/crm-fetch.mjs";
import { devDeploy } from "../../helpers/crm-fixtures.mjs";

const store = await import("../../../netlify/lib/crm-store.mjs");
const G = await import("../../../netlify/lib/crm/modules/map/geocode.mjs");
const { setNow } = await import("../../../netlify/lib/crm/core/clock.mjs");
const { automationCtx } = await import("../../../netlify/lib/crm/core/activity.mjs");
const { withBudget } = store;

let t;
afterEach(() => { if (t) t.done(); t = null; delete globalThis.__crmSleepScale; });
const W = (by = "system") => ({ by, origin: "api", actor_kind: "user", requestId: "geo-test" });
const SET = { by: "system", origin: "seed", actor_kind: "user", requestId: "geo-test" };
const scope = (fn) => store.withStoreScope({ requestId: "geo-test" }, fn);
const PROD = devDeploy({ CRM_PRODUCTION: "1" });
const DEV = devDeploy({});
const sweepCtx = (deploy = PROD, extra = {}) => ({ ...automationCtx({ mode: { system_of_record: "rotor", paused: false }, key: "map.geocode", requestId: "geo-test" }), deploy, budget: withBudget(120000, 100000, { strict: false }), ...extra });

async function properties(n, extra = (i) => ({})) {
  const owner = await t.user("owner");
  const out = [];
  for (let i = 0; i < n; i++) {
    const c = (await store.createRecord("contact", { first_name: "Geo", last_name: `Person${i}`, phones: [{ e164: `+1763555${String(3300 + i)}`, sms: true }], lifecycle: "customer", source: { source: "Referral" } }, W(owner.id))).data;
    out.push((await store.createRecord("property", { contact_id: c.id, label: "Home", address: { street1: `${100 + i} Example Ave`, city: "Delano", state: "MN", zip: "55328" }, access: {}, ...extra(i) }, W(owner.id))).data);
  }
  return out;
}
// The batch geocoder's answer for the rows it got: odd rows match, even rows don't.
const census = (seen) => ({
  match: /geocoding\.geo\.census\.gov\/geocoder\/locations\/addressbatch$/,
  respond: async (url, init) => {
    const csv = await init.body.get("addressFile").text();
    seen.push({ csv, benchmark: init.body.get("benchmark"), fields: [...init.body.keys()] });
    const lines = csv.trim().split("\n").map((l) => l.match(/^"(\d+)","([^"]*)"/));
    return new Response(lines.map(([, n, street]) => (Number(n) % 2 ? `"${n}","${street}, DELANO, MN, 55328","Match","Exact","${street.toUpperCase()}, DELANO, MN, 55328","-93.7${n},45.0${n}","12345","L"` : `"${n}","${street}, DELANO, MN, 55328","No_Match"`)).join("\n"), { status: 200 });
  },
});

test("CSV in and out: only the row number and the address go to the Census Bureau; its answer is read with quotes and commas", () => {
  const csv = G.censusCsv([{ street1: '100 "Example" Ave', city: "Delano", state: "MN", zip: "55328", id: "pr_secret", name: "Pat" }]);
  assert.equal(csv, '"1","100 ""Example"" Ave","Delano","MN","55328"\n');
  assert.doesNotMatch(csv, /pr_secret|Pat/);
  const m = G.parseCensus('"1","100 EXAMPLE AVE, DELANO, MN, 55328","Match","Non_Exact","100 EXAMPLE AVE, DELANO, MN, 55328","-93.789123,45.041987","1","L"\n"2","x","Tie"\n"3","y","No_Match"');
  assert.deepEqual(m.get(1), { lat: 45.041987, lng: -93.789123, exact: false });
  assert.equal(m.get(2), null);
  assert.equal(m.get(3), null);
  assert.deepEqual(G.parseCsvLine('"a,b","c""d",e'), ["a,b", 'c"d', "e"]);
});

test("the map.geocode sweep: off the production deploy nothing is called; in production one batch fills map points (source census) and marks the rest tried", async () => {
  t = await crmTest({ now: "2026-11-17T15:00:00Z" });
  const props = await properties(5, (i) => (i === 4 ? { address: { street1: "", city: "Delano", state: "MN" } } : {}));
  const seen = [];
  const net = strictFetch([census(seen)]);
  try {
    const dev = await scope(() => G.runCensusGeocode(sweepCtx(DEV)));
    assert.equal(dev.result, "skipped:not_production");
    assert.equal(seen.length, 0);
    const r = await scope(() => G.runCensusGeocode(sweepCtx(PROD)));
    assert.equal(r.result, "matched:2/4", JSON.stringify(r));
    assert.equal(seen.length, 1);
    assert.equal(seen[0].benchmark, "Public_AR_Current");
    assert.deepEqual(seen[0].fields.sort(), ["addressFile", "benchmark"]);
    assert.doesNotMatch(seen[0].csv, /Geo|Person|pr_|ct_|763555/, "the address only");
    const after = await Promise.all(props.map(async (p) => (await store.getRecord("property", p.id)).data));
    assert.equal(after.filter((p) => p.geo && p.geo.source === "census").length, 2, "the two the Census Bureau matched");
    assert.equal(after[4].geo, undefined, "no street: never sent");
    assert.ok(after.every((p) => p.geo_tried_at), "every one leaves the waiting list");
    assert.ok(after.filter((p) => p.geo).every((p) => p.town_tier && Number.isFinite(p.distance_mi)), "the tier and distance from Delano");
    // nothing left: no second call
    const again = await scope(() => G.runCensusGeocode(sweepCtx(PROD)));
    assert.equal(again.result, "nothing");
    assert.equal(seen.length, 1);
  } finally { net.restore(); }
});

test("the batch backs off 30 minutes after a failure, stops at the daily cap, steps aside for Google, and follows the owner's switch", async () => {
  t = await crmTest({ now: "2026-11-17T15:00:00Z" });
  const owner = (await properties(3))[0];
  void owner;
  let calls = 0;
  const net = strictFetch([{ match: /census\.gov/, respond: () => { calls += 1; return new Response("busy", { status: 503 }); } }]);
  try {
    assert.equal((await scope(() => G.runCensusGeocode(sweepCtx()))).result, "failed");
    assert.equal((await scope(() => G.runCensusGeocode(sweepCtx()))).result, "skipped:backoff");
    assert.equal(calls, 1);
    setNow("2026-11-17T15:31:00Z");
    assert.equal((await scope(() => G.runCensusGeocode(sweepCtx()))).result, "failed", "tried again after 30 minutes");
    assert.equal(calls, 2);
    // the daily cap
    await store.settledWrite(G.STATE_KEY, { day: "2026-11-17", n: G.DAILY_CAP }, { onlyIfMatch: t.stores.data.etagOf(G.STATE_KEY) });
    assert.equal((await scope(() => G.runCensusGeocode(sweepCtx()))).result, "skipped:daily_cap");
    // Google Maps live takes over (contacts.geocode)
    await store.settledWrite(G.STATE_KEY, { day: "2026-11-16", n: 0 }, { onlyIfMatch: t.stores.data.etagOf(G.STATE_KEY) });
    await store.putSetting("integrations", { maps: { mode: "live" } }, SET);
    assert.equal((await scope(() => G.runCensusGeocode(sweepCtx()))).result, "skipped:google");
    await store.putSetting("integrations", { maps: { mode: "dry_run" } }, SET);
    await store.putSetting("map", { geocoding: { batch: "off" } }, SET);
    assert.equal((await scope(() => G.runCensusGeocode(sweepCtx()))).result, "skipped:off");
    // too little time left in the pass
    await store.putSetting("map", { geocoding: { batch: "census" } }, SET);
    assert.equal((await scope(() => G.runCensusGeocode(sweepCtx(PROD, { budget: withBudget(10000, 1000, { strict: false }) })))).result, "skipped:no_time");
    assert.equal(calls, 2);
  } finally { net.restore(); }
});

test("a dropped pin's address: Nominatim in production only, two coordinates and an identifying User-Agent, once a second for the whole site, cached", async () => {
  t = await crmTest({ now: "2026-11-17T15:00:00Z" });
  globalThis.__crmSleepScale = 0;
  const seen = [];
  const net = strictFetch([{ match: /nominatim\.openstreetmap\.org\/reverse/, respond: (url, init) => {
    seen.push({ url, ua: init.headers["User-Agent"] });
    return Response.json({ address: { house_number: "212", road: "Example Avenue", town: "Delano", state: "Minnesota", postcode: "55328", country_code: "us" } });
  } }]);
  const ctx = (deploy) => ({ deploy, sysMode: async () => ({ paused: false }) });
  try {
    assert.deepEqual(await scope(() => G.reverseGeocode({ lat: 45.0419, lng: -93.7891 }, ctx(DEV))), { address: null, why: "not_production" });
    assert.equal(seen.length, 0);
    const r = await scope(() => G.reverseGeocode({ lat: 45.0419, lng: -93.7891 }, ctx(PROD)));
    assert.deepEqual(r, { address: { street1: "212 Example Avenue", city: "Delano", state: "MN", zip: "55328" }, source: "nominatim" });
    assert.equal(seen.length, 1);
    const u = new URL(seen[0].url);
    assert.deepEqual([...u.searchParams.keys()].sort(), ["addressdetails", "format", "lat", "lon", "zoom"], "nothing but the point");
    assert.equal(seen[0].ua, G.USER_AGENT);
    assert.equal((await scope(() => G.reverseGeocode({ lat: 45.0419, lng: -93.7891 }, ctx(PROD)))).source, "cache");
    assert.equal(seen.length, 1, "the same spot again: the cache");
    // the site-wide gate: the next request waits for its second, and one far behind gives up
    const gate = t.stores.data.json(G.GATE_KEY);
    assert.equal(gate.next_at, "2026-11-17T15:00:01.100Z");
    await scope(() => G.reverseGeocode({ lat: 45.05, lng: -93.79 }, ctx(PROD)));
    assert.equal(t.stores.data.json(G.GATE_KEY).next_at, "2026-11-17T15:00:02.200Z", "queued a second behind the last");
    await store.settledWrite(G.GATE_KEY, { next_at: "2026-11-17T15:00:30.000Z" }, { onlyIfMatch: t.stores.data.etagOf(G.GATE_KEY) });
    assert.deepEqual(await scope(() => G.reverseGeocode({ lat: 45.06, lng: -93.79 }, ctx(PROD))), { address: null, why: "busy" });
    assert.equal(seen.length, 2);
    // the owner's switch and a paused CRM
    await store.putSetting("map", { geocoding: { reverse: "off" } }, SET);
    assert.equal((await scope(() => G.reverseGeocode({ lat: 45.07, lng: -93.79 }, ctx(PROD)))).why, "off");
    assert.equal((await scope(() => G.reverseGeocode({ lat: 45.07, lng: -93.79 }, { deploy: PROD, sysMode: async () => ({ paused: true }) }))).why, "paused");
  } finally { net.restore(); }
});

test("GET /map/reverse answers without a call off production, and checks the point", async () => {
  t = await crmTest({ now: "2026-11-17T15:00:00Z" });
  const owner = await t.user("owner");
  const r = await t.api("/map/reverse?lat=45.04&lng=-93.79", { as: owner });
  assert.equal(r.status, 200);
  assert.deepEqual(r.body.data, { address: null, why: "not_production" });
  assert.equal((await t.api("/map/reverse?lat=95&lng=-93.79", { as: owner })).status, 400);
  assert.deepEqual(t.fetchCalls(), []);
  const st = await t.api("/map/geocode", { as: owner });
  assert.equal(st.status, 200);
  assert.deepEqual(st.body.data.modes, { batch: "census", reverse: "nominatim" });
  assert.equal((await t.api("/map/geocode", { method: "POST", as: owner, body: {} })).status, 202);
});
