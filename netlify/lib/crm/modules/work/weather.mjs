// Work module, office part: the forecast on the schedule (the Schedule's
// month grid, week and day; the layout report's "a weather icon on each
// day", Minnesota matters).
//
// The National Weather Service API (api.weather.gov: free, no key) is read
// on the server only, so the app's CSP never changes and a phone never
// calls it. Two calls, each cached:
//
//   GET https://api.weather.gov/points/{lat},{lng}        → the forecast office and grid
//                                                          (cached 30 days: sys/weather-point/{lat}_{lng})
//   GET https://api.weather.gov/gridpoints/{office}/{x},{y}/forecast
//                                                        → 14 day and night periods
//                                                          (cached 3 hours per office and grid: sys/weather/{office}-{x}-{y})
//
// The point is the service area's center (Settings → Service area), else
// the company's base (Settings → Company), rounded to 4 decimals (what NWS
// asks for). That is the only thing sent: no customer, address or person.
// The User-Agent names the site (NWS asks for one), never a person.
//
// Calls go out only on a Netlify deploy (production, a deploy preview or a
// branch deploy) with cfg/work.weather on, never in local dev or tests
// (context "dev"): there the route serves only what a cache already holds.
// Anything that goes wrong (a timeout, a 5xx, a point outside the US, a
// shape we don't know) answers no days, never an error, and is not asked
// again for 15 minutes; a forecast we already had keeps showing meanwhile.
//
//   forecastDays(json)            the forecast's periods → { "yyyy-mm-dd": { hi, lo, pop, icon, text } }
//   weatherKind(text)             "Chance Rain Showers" → "rain"
//   scheduleWeather(opts)         what GET /schedule/weather answers

import { getRaw, putRaw, getSetting, currentScope } from "../../../crm-store.mjs";
import { nowMs, nowIso, localDate, now } from "../../core/clock.mjs";
import { CANONICAL_ORIGIN } from "../../core/context.mjs";
import { safeErr } from "../../../referral-lib.mjs";

export const NWS_ORIGIN = "https://api.weather.gov";
export const NWS_HOST = "api.weather.gov";
export const USER_AGENT = `BartaCRM/1.0 (${CANONICAL_ORIGIN}; schedule forecast)`;
export const POINT_TTL_MS = 30 * 86400000;     // a grid point barely ever changes
export const FORECAST_TTL_MS = 3 * 3600000;    // NWS updates its forecasts a few times a day
export const FAIL_TTL_MS = 15 * 60000;         // after a failure, ask again in 15 minutes
export const CALL_MS = 3500;                   // one NWS call
export const MIN_CALL_MS = 800;                // not worth starting with less left in the request
export const DAYS = 7;
export const WET_POP = 40;                     // a chance of rain or snow worth showing (percent)

const r4 = (n) => Math.round(Number(n) * 10000) / 10000;
const okPoint = (p) => !!p && Number.isFinite(p.lat) && Number.isFinite(p.lng) && Math.abs(p.lat) <= 90 && Math.abs(p.lng) <= 180;
// keys: the key alphabet (lowercase, digits, - _ . /)
export const pointKey = (p) => `sys/weather-point/${r4(p.lat).toFixed(4)}_${r4(p.lng).toFixed(4)}`;
export const gridKey = (g) => `sys/weather/${g.office.toLowerCase()}-${g.x}-${g.y}`;

// ------------------------------------------------------------ reading a forecast (pure)

// The kind of weather a forecast's words describe (the icon on the schedule).
export function weatherKind(text) {
  const t = String(text || "").toLowerCase();
  if (/thunder|t-storm/.test(t)) return "storm";
  if (/snow|flurr|sleet|blizzard|freezing|wintry|\bice\b/.test(t)) return "snow";
  if (/rain|shower|drizzle/.test(t)) return "rain";
  if (/fog|haze|smoke|mist/.test(t)) return "fog";
  if (/partly|mostly sunny|mostly clear|increasing clouds|decreasing clouds/.test(t)) return "partly";
  if (/sunny|clear|fair/.test(t)) return "sun";
  if (/cloud|overcast|gloomy/.test(t)) return "cloud";
  if (/wind|breezy|blustery|gust/.test(t)) return "wind";
  return "cloud";
}

const toF = (t, unit) => {
  if (!Number.isFinite(t)) return null;
  return Math.round(String(unit || "F").toUpperCase() === "C" ? (t * 9) / 5 + 32 : t);
};
const popOf = (p) => {
  const v = p && p.probabilityOfPrecipitation && p.probabilityOfPrecipitation.value;
  return Number.isFinite(v) ? Math.max(0, Math.min(100, Math.round(v))) : 0;
};
const DATE_AT = /^(\d{4}-\d{2}-\d{2})T\d{2}:\d{2}/;

// The icon a day shows: the day's own kind, unless a chance of rain or snow
// of WET_POP or more says otherwise (snow when it stays at or below freezing).
export function dayIcon(kind, pop, hi) {
  if (pop < WET_POP || ["rain", "snow", "storm"].includes(kind)) return kind;
  return Number.isFinite(hi) && hi <= 32 ? "snow" : "rain";
}

// NWS forecast JSON → { "yyyy-mm-dd": { hi, lo, pop, icon, text } } for the
// first DAYS dates. A period's date is its own local date (NWS writes its
// start time with the place's offset). The day's words and chance come from
// its daytime period; a date with only a night period left (this evening)
// takes the night's.
export function forecastDays(json, { days = DAYS } = {}) {
  const periods = json && json.properties && Array.isArray(json.properties.periods) ? json.properties.periods : [];
  const byDate = new Map();
  for (const p of periods.slice(0, 30)) {
    const m = DATE_AT.exec(String((p && p.startTime) || ""));
    if (!m) continue;
    const d = m[1];
    if (!byDate.has(d)) byDate.set(d, {});
    const slot = byDate.get(d);
    if (p.isDaytime === true) { if (!slot.day) slot.day = p; } else if (!slot.night) slot.night = p;
  }
  const out = {};
  for (const [d, { day, night }] of [...byDate.entries()].sort((a, b) => a[0].localeCompare(b[0])).slice(0, days)) {
    const main = day || night;
    const hi = day ? toF(day.temperature, day.temperatureUnit) : null;
    const lo = night ? toF(night.temperature, night.temperatureUnit) : null;
    const pop = popOf(main);
    const text = String(main.shortForecast || "").slice(0, 80);
    const kind = weatherKind(text);
    out[d] = { hi, lo, pop, icon: dayIcon(kind, pop, hi ?? lo), text };
  }
  return out;
}

// The office and grid a points answer names, or null (never a URL we were handed).
export function gridOf(json) {
  const p = json && json.properties;
  if (!p) return null;
  const office = String(p.gridId || "");
  const x = p.gridX, y = p.gridY;
  if (!/^[A-Z]{3}$/.test(office) || !Number.isInteger(x) || !Number.isInteger(y) || x < 0 || y < 0 || x > 999 || y > 999) return null;
  return { office, x, y };
}

// ------------------------------------------------------------ the calls

class NwsError extends Error { constructor(code) { super(`nws ${code}`); this.code = code; } }

// One GET to NWS within what's left of the request.
async function nwsGet(url, { fetchImpl = globalThis.fetch, callMs = CALL_MS } = {}) {
  const budget = currentScope() && currentScope().budget;
  const left = budget ? budget.left() - 1500 : callMs;
  const ms = Math.min(callMs, left);
  if (ms < Math.min(MIN_CALL_MS, callMs)) throw new NwsError("no_time");
  let res;
  try {
    res = await fetchImpl(url, { headers: { "User-Agent": USER_AGENT, Accept: "application/geo+json" }, signal: AbortSignal.timeout(ms), redirect: "error" });
  } catch (e) {
    throw new NwsError(e && (e.name === "TimeoutError" || e.name === "AbortError") ? "timeout" : "network");
  }
  if (!res.ok) { try { await res.body?.cancel(); } catch { /* nothing to free */ } throw new NwsError(`http_${res.status}`); }
  try { return await res.json(); } catch { throw new NwsError("bad_json"); }
}

// ------------------------------------------------------------ the cache

// This instance's copies (a warm function answers without a storage read).
const mem = new Map();
const inflight = new Map();
export function clearWeatherCache() { mem.clear(); inflight.clear(); }

async function cached(key) {
  const m = mem.get(key);
  if (m) return m;
  const got = await getRaw(key).catch(() => null);
  const v = got && got.data ? got.data : null;
  if (v) mem.set(key, v);
  return v;
}
async function keep(key, value) {
  mem.set(key, value);
  await putRaw(key, value).catch((e) => console.error(`crm:weather: cache not saved (${safeErr(e)})`));
}
const age = (v, field = "at") => (v && v[field] ? nowMs() - Date.parse(v[field]) : Infinity);

// Where the forecast is for: the service area's center, else the company's base.
export async function forecastPoint() {
  const area = await getSetting("service_area").catch(() => null);
  if (area && okPoint(area.center)) return { lat: r4(area.center.lat), lng: r4(area.center.lng) };
  const company = await getSetting("company").catch(() => null);
  if (company && okPoint(company.base)) return { lat: r4(company.base.lat), lng: r4(company.base.lng) };
  return null;
}

// May this request call NWS? A Netlify deploy (not local dev or tests) with the weather on.
export const mayCall = (deploy, settings) => !!deploy && typeof deploy.ctx === "string" && deploy.ctx !== "dev" && !(settings && settings.weather === false);

async function gridFor(point, { live, fetchImpl, callMs }) {
  const key = pointKey(point);
  const have = await cached(key);
  if (have && have.office && age(have) < POINT_TTL_MS) return { office: have.office, x: have.x, y: have.y };
  if (have && have.fail_at && age(have, "fail_at") < FAIL_TTL_MS) return have.office ? { office: have.office, x: have.x, y: have.y } : null;
  if (!live) return have && have.office ? { office: have.office, x: have.x, y: have.y } : null;
  try {
    const g = gridOf(await nwsGet(`${NWS_ORIGIN}/points/${point.lat.toFixed(4)},${point.lng.toFixed(4)}`, { fetchImpl, callMs }));
    if (!g) throw new NwsError("no_grid");
    await keep(key, { ...g, at: nowIso() });
    return g;
  } catch (e) {
    console.error(`crm:weather: the point lookup failed (${e && e.code ? e.code : safeErr(e)})`);
    await keep(key, { ...(have && have.office ? { office: have.office, x: have.x, y: have.y, at: have.at } : {}), fail_at: nowIso(), fail: String((e && e.code) || "failed").slice(0, 30) });
    return have && have.office ? { office: have.office, x: have.x, y: have.y } : null;
  }
}

async function refresh(grid, have, { fetchImpl, callMs }) {
  const key = gridKey(grid);
  try {
    const json = await nwsGet(`${NWS_ORIGIN}/gridpoints/${grid.office}/${grid.x},${grid.y}/forecast`, { fetchImpl, callMs });
    const days = forecastDays(json);
    if (!Object.keys(days).length) throw new NwsError("no_periods");
    const value = { office: grid.office, x: grid.x, y: grid.y, at: nowIso(), updated: String((json.properties && json.properties.updated) || "").slice(0, 40), days };
    await keep(key, value);
    return value;
  } catch (e) {
    console.error(`crm:weather: the forecast failed (${e && e.code ? e.code : safeErr(e)})`);
    const value = { ...(have || { office: grid.office, x: grid.x, y: grid.y }), fail_at: nowIso(), fail: String((e && e.code) || "failed").slice(0, 30) };
    await keep(key, value);
    return value;
  }
}

// What GET /schedule/weather answers:
// { days: { date: { hi, lo, pop, icon, text } }, as_of, state, source }
// state: "ok" (fresh), "stale" (an older forecast, NWS didn't answer just now),
// "off" (cfg/work.weather is off), "none" (nothing to show).
export async function scheduleWeather({ deploy, fetchImpl = globalThis.fetch, callMs = CALL_MS } = {}) {
  const settings = await getSetting("work").catch(() => ({}));
  if (settings && settings.weather === false) return { days: {}, as_of: null, state: "off" };
  const point = await forecastPoint();
  if (!point) return { days: {}, as_of: null, state: "none" };
  const live = mayCall(deploy, settings);
  const grid = await gridFor(point, { live, fetchImpl, callMs });
  if (!grid) return { days: {}, as_of: null, state: "none" };
  const key = gridKey(grid);
  let have = await cached(key);
  const fresh = have && have.days && age(have) < FORECAST_TTL_MS;
  const resting = have && have.fail_at && age(have, "fail_at") < FAIL_TTL_MS;
  if (!fresh && !resting && live) {
    // one refresh at a time on this instance
    if (!inflight.has(key)) inflight.set(key, refresh(grid, have, { fetchImpl, callMs }).finally(() => inflight.delete(key)));
    have = await inflight.get(key);
  }
  const today = localDate(now());
  const days = Object.fromEntries(Object.entries((have && have.days) || {}).filter(([d]) => d >= today).slice(0, DAYS));
  if (!Object.keys(days).length) return { days: {}, as_of: null, state: "none" };
  const ok = have.at && age(have) < FORECAST_TTL_MS;
  return { days, as_of: have.at || null, state: ok ? "ok" : "stale", source: "National Weather Service" };
}
