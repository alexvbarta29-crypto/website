// The forecast on the schedule (GET /schedule/weather, weather.mjs): the
// National Weather Service read on the server only, through a mocked fetch
// (strictFetch: nothing reaches the network). Points → forecast, the
// caches (the grid point for 30 days, the forecast for 3 hours, per
// forecast office and grid), a failure answers no days (or the forecast it
// already had) and rests 15 minutes, the request's budget, no call in
// local dev or tests, the User-Agent names the site and nothing else is
// sent. Synthetic answers only (nws-fixtures.mjs).
import { test } from "node:test";
import assert from "node:assert/strict";
import { setup, store, clock } from "./fixtures.mjs";
import { strictFetch } from "../../helpers/crm-fetch.mjs";
import { advance, hours, minutes } from "../../helpers/crm-clock.mjs";
import { nwsPoints, nwsForecast } from "./nws-fixtures.mjs";

const WX = await import("../../../netlify/lib/crm/modules/work/weather.mjs");
const PREVIEW = { deploy: { context: "deploy-preview" } };        // a Netlify deploy (not local dev): calls allowed

async function center(t, owner, c) {
  const g = await t.api("/settings/service_area", { as: owner });
  const r = await t.api("/settings/service_area", { method: "PUT", as: owner, ifMatch: g.body.data.etag || "new", body: { ...g.body.data.data, center: c } });
  assert.equal(r.status, 200, JSON.stringify(r.body));
}

function nws({ points = () => Response.json(nwsPoints()), forecast = (url) => Response.json(nwsForecast(clock.localDate(clock.now()))) } = {}) {
  const seen = [];
  const net = strictFetch([{ match: /^https:\/\/api\.weather\.gov\//, respond: (url, init) => { seen.push({ url, headers: init.headers || {} }); return /\/points\//.test(url) ? points(url, init) : forecast(url, init); } }]);
  return { net, seen };
}

test("weather words: the kind of day, the icon (rain or snow at 40% and up), the forecast's days, the grid", () => {
  assert.equal(WX.weatherKind("Sunny"), "sun");
  assert.equal(WX.weatherKind("Mostly Sunny"), "partly");
  assert.equal(WX.weatherKind("Partly Cloudy"), "partly");
  assert.equal(WX.weatherKind("Mostly Cloudy"), "cloud");
  assert.equal(WX.weatherKind("Chance Rain Showers"), "rain");
  assert.equal(WX.weatherKind("Snow Likely"), "snow");
  assert.equal(WX.weatherKind("Freezing Drizzle"), "snow");
  assert.equal(WX.weatherKind("Slight Chance Showers And Thunderstorms"), "storm");
  assert.equal(WX.weatherKind("Patchy Fog"), "fog");
  assert.equal(WX.weatherKind("Breezy"), "wind");
  assert.equal(WX.dayIcon("cloud", 39, 40), "cloud", "under 40%: the day's own icon");
  assert.equal(WX.dayIcon("cloud", 40, 40), "rain", "40% and up: rain");
  assert.equal(WX.dayIcon("partly", 60, 30), "snow", "at or below freezing: snow");
  const days = WX.forecastDays(nwsForecast("2026-11-17"));
  assert.deepEqual(Object.keys(days), ["2026-11-17", "2026-11-18", "2026-11-19", "2026-11-20", "2026-11-21", "2026-11-22", "2026-11-23"]);
  assert.deepEqual(days["2026-11-17"], { hi: 41, lo: 24, pop: 0, icon: "sun", text: "Sunny" });
  assert.deepEqual(days["2026-11-19"], { hi: 44, lo: 33, pop: 70, icon: "rain", text: "Rain Showers Likely" });
  assert.equal(days["2026-11-21"].icon, "snow");
  // this evening: no daytime period left, the night's words and low
  const tonight = WX.forecastDays(nwsForecast("2026-11-17", { tonight: true }));
  assert.deepEqual(tonight["2026-11-17"], { hi: null, lo: 24, pop: 0, icon: "sun", text: "Clear" });
  // Celsius is read as Fahrenheit; shapes we don't know give nothing
  const c = nwsForecast("2026-11-17");
  c.properties.periods[0] = { ...c.properties.periods[0], temperature: 5, temperatureUnit: "C" };
  assert.equal(WX.forecastDays(c)["2026-11-17"].hi, 41);
  for (const bad of [null, {}, { properties: {} }, { properties: { periods: [{ startTime: "nope" }] } }]) assert.deepEqual(WX.forecastDays(bad), {});
  assert.deepEqual(WX.gridOf(nwsPoints()), { office: "MPX", x: 97, y: 71 });
  for (const g of [{ gridId: "../x", gridX: 1, gridY: 1 }, { gridId: "MPX", gridX: 1.5, gridY: 1 }, { gridId: "mpx", gridX: 1, gridY: 1 }, { gridId: "MPX", gridX: -1, gridY: 1 }]) assert.equal(WX.gridOf({ properties: g }), null);
  assert.equal(WX.pointKey({ lat: 45.04191, lng: -93.789149 }), "sys/weather-point/45.0419_-93.7891");
  assert.equal(WX.gridKey({ office: "MPX", x: 97, y: 71 }), "sys/weather/mpx-97-71");
  assert.match(WX.USER_AGENT, /^BartaCRM\/1\.0 \(https:\/\/www\.bartawindowwashing\.com; schedule forecast\)$/, "the site, never a person");
});

test("GET /schedule/weather: points then forecast for the service area's center, cached per grid (3 hours) and point (30 days); only the point is sent", async () => {
  const { t, owner, tech } = await setup();
  WX.clearWeatherCache();
  const { net, seen } = nws();
  try {
    const r = await t.api("/schedule/weather", { as: owner, context: PREVIEW });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(r.body.data.state, "ok");
    assert.equal(r.body.data.source, "National Weather Service");
    assert.deepEqual(Object.keys(r.body.data.days).length, 7);
    assert.deepEqual(r.body.data.days["2026-11-19"], { hi: 44, lo: 33, pop: 70, icon: "rain", text: "Rain Showers Likely" });
    assert.deepEqual(seen.map((x) => x.url), ["https://api.weather.gov/points/45.0419,-93.7891", "https://api.weather.gov/gridpoints/MPX/97,71/forecast"], "the center of Settings → Service area (its default), then its grid");
    for (const x of seen) {
      assert.match(x.headers["User-Agent"], /bartawindowwashing\.com/);
      assert.doesNotMatch(x.headers["User-Agent"], /@/, "no email in the User-Agent");
      assert.equal(x.headers.Accept, "application/geo+json");
    }
    // the same instance: no call; another instance (memory gone): the stored copy, no call
    assert.equal((await t.api("/schedule/weather", { as: owner, context: PREVIEW })).body.data.state, "ok");
    WX.clearWeatherCache();
    assert.equal((await t.api("/schedule/weather", { as: owner, context: PREVIEW })).body.data.days["2026-11-17"].hi, 41);
    assert.equal(seen.length, 2, "cached: no more calls");
    assert.ok(t.stores.data.keys("sys/weather/").includes("sys/weather/mpx-97-71"), "kept per forecast office and grid");
    // 4 hours on: the forecast again, the point from its cache
    advance(hours(4));
    await t.api("/schedule/weather", { as: owner, context: PREVIEW });
    assert.deepEqual(seen.slice(2).map((x) => x.url), ["https://api.weather.gov/gridpoints/MPX/97,71/forecast"]);
    // another center (Settings → Service area): its own point
    await center(t, owner, { lat: 44.97, lng: -93.5 });
    WX.clearWeatherCache();
    await t.api("/schedule/weather", { as: owner, context: PREVIEW });
    assert.equal(seen[3].url, "https://api.weather.gov/points/44.9700,-93.5000");
    // a technician never sees the office's schedule
    assert.equal((await t.api("/schedule/weather", { as: tech, context: PREVIEW })).status, 403);
  } finally { net.restore(); WX.clearWeatherCache(); t.done(); }
});

test("a failure answers no days (never an error) and rests 15 minutes; a forecast already kept shows meanwhile; the request's time is respected", async () => {
  const { t, owner } = await setup();
  WX.clearWeatherCache();
  let down = true;
  const { net, seen } = nws({ forecast: () => (down ? new Response("Unexpected Problem", { status: 503 }) : Response.json(nwsForecast(clock.localDate(clock.now())))) });
  try {
    const r = await t.api("/schedule/weather", { as: owner, context: PREVIEW });
    assert.equal(r.status, 200);
    assert.deepEqual(r.body.data, { days: {}, as_of: null, state: "none" });
    assert.equal(seen.length, 2);
    await t.api("/schedule/weather", { as: owner, context: PREVIEW });
    assert.equal(seen.length, 2, "rests after a failure");
    advance(minutes(16));
    down = false;
    assert.equal((await t.api("/schedule/weather", { as: owner, context: PREVIEW })).body.data.state, "ok");
    // later it fails again: the forecast it had shows, marked stale
    advance(hours(4));
    down = true;
    const stale = await t.api("/schedule/weather", { as: owner, context: PREVIEW });
    assert.equal(stale.body.data.state, "stale");
    assert.ok(Object.keys(stale.body.data.days).length >= 6, "the days it had, from today on");
    assert.ok(!Object.keys(stale.body.data.days).some((d) => d < "2026-11-17"));
    // a point NWS doesn't know (outside the US): nothing, no error
    WX.clearWeatherCache();
    await center(t, owner, { lat: 10, lng: 10 });
  } finally { net.restore(); }
  const outside = strictFetch([{ match: /api\.weather\.gov\/points/, respond: () => Response.json({ title: "Data Unavailable For Requested Point" }, { status: 404 }) }]);
  try {
    const r = await t.api("/schedule/weather", { as: owner, context: PREVIEW });
    assert.deepEqual([r.status, r.body.data.state], [200, "none"]);
  } finally { outside.restore(); }
  // a slow NWS: each call ends at its own timeout, the answer is still prompt and empty
  await center(t, owner, { lat: 44.5, lng: -93.25 });
  WX.clearWeatherCache();
  const hang = strictFetch([{ match: /api\.weather\.gov/, respond: (url, init) => new Promise((ok, no) => init.signal.addEventListener("abort", () => no(Object.assign(new Error("timeout"), { name: "TimeoutError" })))) }]);
  try {
    // (a real fetch holds a socket open; this fake holds nothing, so a timer keeps the test running)
    const hold = setTimeout(() => {}, 5000);
    const out = await store.withStoreScope({ deploy: undefined }, () => WX.scheduleWeather({ deploy: { ctx: "deploy-preview" }, callMs: 40 })).finally(() => clearTimeout(hold));
    assert.deepEqual(out, { days: {}, as_of: null, state: "none" });
    assert.ok(hang.calls.length >= 1);
  } finally { hang.restore(); WX.clearWeatherCache(); t.done(); }
});

test("no call in local dev or tests, none with the weather turned off; a cold call stays inside the route's storage budget", async () => {
  const { t, owner } = await setup();
  WX.clearWeatherCache();
  try {
    // dev (no Netlify context): strictFetch([]) would fail the test on any call
    const r = await t.api("/schedule/weather", { as: owner });
    assert.deepEqual([r.status, r.body.data.state], [200, "none"]);
    assert.equal(WX.mayCall({ ctx: "dev" }, {}), false);
    assert.equal(WX.mayCall({ ctx: "production" }, {}), true);
    assert.equal(WX.mayCall({ ctx: "deploy-preview" }, { weather: false }), false);
    // what a cache already holds still shows in dev (the phone checks rely on it)
    const point = { lat: 45.0419, lng: -93.7891 };
    await store.putRaw(WX.pointKey(point), { office: "MPX", x: 97, y: 71, at: clock.nowIso() });
    await store.putRaw(WX.gridKey({ office: "MPX", x: 97, y: 71 }), { office: "MPX", x: 97, y: 71, at: clock.nowIso(), days: WX.forecastDays(nwsForecast("2026-11-17")) });
    WX.clearWeatherCache();
    assert.equal((await t.api("/schedule/weather", { as: owner })).body.data.days["2026-11-17"].icon, "sun");
    // turned off (Schedule settings): nothing, no call
    const got = await t.api("/settings/work", { as: owner });
    const put = await t.api("/settings/work", { method: "PUT", as: owner, ifMatch: got.body.data.etag || "new", body: { ...got.body.data.data, weather: false } });
    assert.equal(put.status, 200, JSON.stringify(put.body));
    WX.clearWeatherCache();
    assert.equal((await t.api("/schedule/weather", { as: owner, context: PREVIEW })).body.data.state, "off");
    assert.equal((await t.api("/settings/work", { method: "PUT", as: owner, ifMatch: put.body.data.etag, body: { ...put.body.data.data, weather: "yes" } })).status, 400);
  } finally { WX.clearWeatherCache(); t.done(); }
  // a cold call (both NWS calls, both caches written) under the memory store's strict budget
  const s2 = await setup();
  WX.clearWeatherCache();
  const { net } = nws();
  try {
    const r = await s2.t.api("/schedule/weather", { as: s2.owner, context: PREVIEW });
    assert.equal(r.status, 200, "not 503 busy: within maxCalls");
    assert.equal(r.body.data.state, "ok");
  } finally { net.restore(); WX.clearWeatherCache(); s2.t.done(); }
});
