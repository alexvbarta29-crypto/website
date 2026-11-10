// Barta CRM: the Google Maps adapter (design §6.1 "maps", §6.5). Owned by
// the contacts module (M2a), registered as the live "maps" driver.
//
//   geocode(address) → { lat, lng, formatted, county?, zip? } | null
//
// The Geocoding API with the site's existing server key GOOGLE_MAPS_API_KEY
// (components=country:US, 5 s timeout), the same key lights-streetview.mjs
// uses. It is only ever reached through adapter("maps"), which hands it out
// in production with cfg/integrations.maps.mode = "live"; everywhere else
// the dry-run geocode answers null without a call. Without the key it answers
// null without a call too. Logs carry the HTTP status or Google's status
// word only, never the address.

import { registerAdapter } from "./index.mjs";
import { safeErr } from "../../referral-lib.mjs";

export const GEOCODE_URL = "https://maps.googleapis.com/maps/api/geocode/json";
export const GOOGLE_TIMEOUT_MS = 5000;

const str = (v) => (v == null ? "" : String(v)).trim();
const line = (a) => [str(a.street1), str(a.street2), str(a.city), [str(a.state), str(a.zip)].filter(Boolean).join(" ")].filter(Boolean).join(", ");

// The county and ZIP from Google's address components ("Wright County" → "wright").
export function partsOf(result) {
  const comps = Array.isArray(result && result.address_components) ? result.address_components : [];
  const find = (type) => comps.find((c) => Array.isArray(c.types) && c.types.includes(type));
  const county = find("administrative_area_level_2");
  const zip = find("postal_code");
  return {
    ...(county ? { county: str(county.long_name).replace(/\s+county$/i, "").toLowerCase() } : {}),
    ...(zip ? { zip: str(zip.short_name || zip.long_name) } : {}),
  };
}

export async function geocode(address, { env = process.env } = {}) {
  const key = env.GOOGLE_MAPS_API_KEY;
  if (!key) return null;
  const q = typeof address === "string" ? str(address) : line(address || {});
  if (!q || q.length > 300) return null;
  const url = `${GEOCODE_URL}?address=${encodeURIComponent(q)}&components=country:US&key=${encodeURIComponent(key)}`;
  let res;
  try {
    res = await fetch(url, { signal: AbortSignal.timeout(GOOGLE_TIMEOUT_MS) });
  } catch (e) {
    console.error(`crm:maps: Google didn't answer (${safeErr(e)})`);
    return null;
  }
  if (!res.ok) {
    console.error(`crm:maps: Google answered HTTP ${res.status}`);
    return null;
  }
  let body;
  try { body = await res.json(); } catch { return null; }
  if (!body || body.status !== "OK" || !Array.isArray(body.results) || !body.results.length) {
    if (body && body.status && body.status !== "ZERO_RESULTS") console.error(`crm:maps: geocode status ${String(body.status).slice(0, 30)}`);
    return null;
  }
  const r = body.results[0];
  const loc = r.geometry && r.geometry.location;
  if (!loc || !Number.isFinite(loc.lat) || !Number.isFinite(loc.lng)) return null;
  return { lat: loc.lat, lng: loc.lng, formatted: str(r.formatted_address).slice(0, 200), ...partsOf(r) };
}

export const mapsLive = Object.freeze({ geocode: (address) => geocode(address) });
registerAdapter("maps", "live", mapsLive);
