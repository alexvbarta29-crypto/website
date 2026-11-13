// Map module: geocoding (docs/CRM-MAP.md "Outside hosts").
//
//   censusBatch(rows, { fetch })     address → map point, many at once, with
//       the US Census Bureau's free geocoder (no key; public data):
//       POST geocoding.geo.census.gov/geocoder/locations/addressbatch, a CSV
//       of "row number, street, city, state, ZIP" and nothing else (no
//       name, no id of ours). 45 s timeout.
//   runCensusGeocode(ctx)            the map.geocode sweep (bulk lane, every
//       pass): up to CENSUS_BATCH properties still waiting for a map point
//       (rel geo-pending, the same list Google's contacts.geocode walks) in
//       one request; a match fills geo (source "census"), the service-area
//       tier and distance; no match marks geo_tried_at so it leaves the
//       list. Production only, when Settings → Maps says census, never
//       while Google Maps is live (contacts.geocode does it then). At most
//       DAILY_CAP addresses a day; a failed request backs off 30 minutes.
//   reverseGeocode({ lat, lng }, ctx)  a dropped pin's address: OpenStreetMap's
//       Nominatim (no key), only when someone drops a pin. Its usage policy:
//       at most one request a second for the whole site (geo/gate/nominatim,
//       a CAS'd "next allowed" time), an identifying User-Agent, results
//       cached (geo/rev/{month}/{lat}_{lng}). Sends the two coordinates only.
//       4 s timeout; no answer → the canvasser types it.
//
// geo/ keys are derived data: never backed up (core/backup.mjs lists
// prefixes), the month folders older than two months are deleted by
// map.retention. Logs carry counts and statuses, never an address.

import { listRel, getRecords, updateRecord, getSetting, getRaw, settledWrite } from "../../../crm-store.mjs";
import { adapter } from "../../adapters/index.mjs";
import { nowIso, nowMs, now, localDate } from "../../core/clock.mjs";
import { areaTier, normalizeAddress } from "../contacts/display.mjs";
import { safeErr } from "../../../referral-lib.mjs";

export const CENSUS_URL = "https://geocoding.geo.census.gov/geocoder/locations/addressbatch";
export const CENSUS_BENCHMARK = "Public_AR_Current";
export const CENSUS_TIMEOUT_MS = 45000;
export const CENSUS_BATCH = 50;
export const DAILY_CAP = 1000;
export const BACKOFF_MS = 30 * 60000;
export const STATE_KEY = "geo/census";
export const NOMINATIM_URL = "https://nominatim.openstreetmap.org/reverse";
export const NOMINATIM_TIMEOUT_MS = 4000;
export const NOMINATIM_GAP_MS = 1100;
export const GATE_KEY = "geo/gate/nominatim";
// Nominatim's policy asks for an application name and a way to reach its operator.
export const USER_AGENT = "BartaCRM/1.0 (+https://www.bartawindowwashing.com)";

const str = (v) => (v == null ? "" : String(v)).trim();
const sleep = (ms) => new Promise((r) => setTimeout(r, Math.max(0, ms * (globalThis.__crmSleepScale ?? 1))));

// ------------------------------------------------------------ the Census batch

const csvField = (s) => `"${str(s).replace(/[\r\n]+/g, " ").replace(/"/g, '""')}"`;
// One CSV line per address: "row","street","city","state","zip" (the format the batch geocoder reads).
export function censusCsv(addresses) {
  return addresses.map((a, i) => [String(i + 1), a.street1, a.city, a.state, a.zip].map(csvField).join(",")).join("\n") + "\n";
}

// A CSV line → fields (quotes, doubled quotes, commas inside quotes).
export function parseCsvLine(line) {
  const out = [];
  let cur = "";
  let q = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (q) {
      if (c === '"' && line[i + 1] === '"') { cur += '"'; i++; }
      else if (c === '"') q = false;
      else cur += c;
    } else if (c === '"') q = true;
    else if (c === ",") { out.push(cur); cur = ""; }
    else cur += c;
  }
  out.push(cur);
  return out;
}

// The batch geocoder's answer → Map(row number → { lat, lng, exact } | null)
export function parseCensus(text) {
  const out = new Map();
  for (const raw of String(text || "").split(/\r?\n/)) {
    if (!raw.trim()) continue;
    const f = parseCsvLine(raw);
    const n = Number(f[0]);
    if (!Number.isSafeInteger(n)) continue;
    if (f[2] !== "Match") { out.set(n, null); continue; }
    const [lng, lat] = String(f[5] || "").split(",").map(Number);
    if (!Number.isFinite(lat) || !Number.isFinite(lng) || Math.abs(lat) > 90 || Math.abs(lng) > 180) { out.set(n, null); continue; }
    out.set(n, { lat: Math.round(lat * 1e6) / 1e6, lng: Math.round(lng * 1e6) / 1e6, exact: f[3] === "Exact" });
  }
  return out;
}

// → Map(index → point | null) for the given addresses, or throws (network, HTTP status).
export async function censusBatch(addresses, { fetchImpl = globalThis.fetch, timeoutMs = CENSUS_TIMEOUT_MS } = {}) {
  const form = new FormData();
  form.append("benchmark", CENSUS_BENCHMARK);
  form.append("addressFile", new Blob([censusCsv(addresses)], { type: "text/csv" }), "addresses.csv");
  const res = await fetchImpl(CENSUS_URL, { method: "POST", body: form, signal: AbortSignal.timeout(timeoutMs) });
  if (!res.ok) { const e = new Error(`census answered HTTP ${res.status}`); e.status = res.status; throw e; }
  const byRow = parseCensus(await res.text());
  const out = new Map();
  addresses.forEach((_, i) => out.set(i, byRow.has(i + 1) ? byRow.get(i + 1) : null));
  return out;
}

// Settings → Maps (cfg/map.geocoding).
export async function geocodeModes(opts = {}) {
  const s = await getSetting("map", opts);
  const g = (s && s.geocoding) || {};
  return { batch: g.batch === "off" ? "off" : "census", reverse: g.reverse === "off" ? "off" : "nominatim" };
}

const usable = (p) => !!p && !p.deleted_at && !p.geo && !p.geo_tried_at && p.address && str(p.address.street1) && (str(p.address.zip) || str(p.address.city));

// The map.geocode sweep. → { done, progress?, result }
export async function runCensusGeocode(ctx, { fetchImpl = globalThis.fetch, batch = CENSUS_BATCH } = {}) {
  if (!ctx.deploy || !ctx.deploy.prod) return { done: true, result: "skipped:not_production" };
  if (ctx.budget && ctx.budget.left() < CENSUS_TIMEOUT_MS + 20000) return { done: true, result: "skipped:no_time" };
  const modes = await geocodeModes();
  if (modes.batch !== "census") return { done: true, result: "skipped:off" };
  // Google Maps live (the owner's key): contacts.geocode walks the same list
  const maps = await adapter("maps", { deploy: ctx.deploy, mode: ctx.mode });
  if (maps.mode === "live") return { done: true, result: "skipped:google" };
  const today = localDate(now());
  const st = await getRaw(STATE_KEY);
  const state = st && st.data ? st.data : {};
  if (state.fail_until && Date.parse(state.fail_until) > nowMs()) return { done: true, result: "skipped:backoff" };
  const used = state.day === today ? Number(state.n) || 0 : 0;
  const room = Math.min(batch, DAILY_CAP - used);
  if (room <= 0) return { done: true, result: "skipped:daily_cap" };
  const rows = await listRel("geo-pending", "all", { limit: room, newestFirst: false });
  if (!rows.length) return { done: true, result: "nothing" };
  const got = (await getRecords("property", rows.map((r) => r.id))).filter(Boolean).map((g) => g.data);
  const props = got.filter(usable);
  // one with no street or no town to send can't be found: it leaves the list, so it never blocks the ones behind it
  for (const p of got.filter((x) => !usable(x) && !x.deleted_at && !x.geo && !x.geo_tried_at)) {
    await updateRecord("property", p.id, (cur) => (cur.geo || cur.geo_tried_at ? null : { ...cur, geo_tried_at: nowIso() }), ctx.write()).catch((e) => console.error(`crm:map: a property without an address to send wasn't marked (${safeErr(e)})`));
  }
  if (!props.length) return { done: true, result: "nothing" };
  const saveState = (next) => settledWrite(STATE_KEY, { ...state, ...next, at: nowIso() }, st ? { onlyIfMatch: st.etag } : { onlyIfNew: true }).catch(() => null);
  let found;
  try {
    found = await censusBatch(props.map((p) => p.address), { fetchImpl });
  } catch (e) {
    console.error(`crm:map: census geocoder didn't answer (${safeErr(e)}); trying again in 30 minutes`);
    await saveState({ day: today, n: used, fail_until: new Date(nowMs() + BACKOFF_MS).toISOString(), last_error: String((e && e.status) || "network") });
    return { done: true, result: "failed" };
  }
  const area = await getSetting("service_area").catch(() => ({}));
  let matched = 0;
  for (const [i, p] of props.entries()) {
    const hit = found.get(i);
    try {
      await updateRecord("property", p.id, (cur) => {
        if (cur.geo || cur.deleted_at) return null;
        if (!hit) return { ...cur, geo_tried_at: nowIso() };
        const geo = { lat: hit.lat, lng: hit.lng, source: "census", at: nowIso() };
        const tier = areaTier({ geo, city: cur.address && cur.address.city }, area);
        return { ...cur, geo, town_tier: tier.town_tier, ...(tier.distance_mi !== undefined ? { distance_mi: tier.distance_mi } : {}), geo_tried_at: nowIso() };
      }, ctx.write());
      if (hit) matched += 1;
    } catch (e) {
      console.error(`crm:map: a property's map point wasn't saved (${safeErr(e)})`);
    }
  }
  await saveState({ day: today, n: used + props.length, fail_until: null, last_batch: props.length, last_matched: matched });
  return { done: true, progress: props.length, result: `matched:${matched}/${props.length}` };
}

// ------------------------------------------------------------ reverse (a dropped pin)

const round5 = (x) => (Math.round(x * 1e5) / 1e5).toFixed(5);
export const revKey = (lat, lng, at = now()) => `geo/rev/${localDate(at).slice(0, 7)}/${round5(lat)}_${round5(lng)}`;

// Nominatim's address parts → { street1, city, state, zip } | null
export function addressFromNominatim(body) {
  const a = body && body.address;
  if (!a || typeof a !== "object") return null;
  const street = [str(a.house_number), str(a.road || a.pedestrian || a.footway || a.residential)].filter(Boolean).join(" ");
  const city = str(a.city || a.town || a.village || a.hamlet || a.suburb || a.municipality || a.county);
  const n = normalizeAddress({ street1: street, city, state: str(a.state), zip: str(a.postcode).slice(0, 10) });
  if (!n || (!n.street1 && !n.city)) return null;
  return { ...(n.street1 ? { street1: n.street1 } : {}), ...(n.city ? { city: n.city } : {}), ...(n.state ? { state: n.state } : {}), ...(n.zip ? { zip: n.zip } : {}) };
}

// → { address, source: "nominatim" | "cache" } | { address: null, why }
export async function reverseGeocode({ lat, lng }, ctx, { fetchImpl = globalThis.fetch } = {}) {
  if (!ctx.deploy || !ctx.deploy.prod) return { address: null, why: "not_production" };
  const mode = await ctx.sysMode();
  if (mode && mode.paused) return { address: null, why: "paused" };
  const modes = await geocodeModes();
  if (modes.reverse !== "nominatim") return { address: null, why: "off" };
  const key = revKey(lat, lng);
  const cached = await getRaw(key);
  if (cached && cached.data && cached.data.address) return { address: cached.data.address, source: "cache" };
  // one request a second for the whole site
  for (let i = 0; i < 3; i++) {
    const g = await getRaw(GATE_KEY);
    const next = g && g.data ? Date.parse(g.data.next_at) || 0 : 0;
    const t = nowMs();
    if (next - t > NOMINATIM_GAP_MS * 2) return { address: null, why: "busy" };
    const w = await settledWrite(GATE_KEY, { next_at: new Date(Math.max(t, next) + NOMINATIM_GAP_MS).toISOString() }, g ? { onlyIfMatch: g.etag } : { onlyIfNew: true });
    if (!w.ok) continue;
    if (next > t) await sleep(next - t);
    let body = null;
    try {
      const url = `${NOMINATIM_URL}?format=jsonv2&addressdetails=1&zoom=18&lat=${encodeURIComponent(round5(lat))}&lon=${encodeURIComponent(round5(lng))}`;
      const res = await fetchImpl(url, { headers: { "User-Agent": USER_AGENT, Accept: "application/json", "Accept-Language": "en" }, signal: AbortSignal.timeout(NOMINATIM_TIMEOUT_MS) });
      if (!res.ok) { console.error(`crm:map: nominatim answered HTTP ${res.status}`); return { address: null, why: "no_answer" }; }
      body = await res.json();
    } catch (e) {
      console.error(`crm:map: nominatim didn't answer (${safeErr(e)})`);
      return { address: null, why: "no_answer" };
    }
    const address = addressFromNominatim(body);
    if (!address) return { address: null, why: "no_result" };
    await settledWrite(key, { address, at: nowIso() }, { onlyIfNew: true }).catch(() => null);
    return { address, source: "nominatim" };
  }
  return { address: null, why: "busy" };
}
