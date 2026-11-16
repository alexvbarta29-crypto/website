// Barta CRM: the Google Maps adapter (design §6.1 "maps", §6.5). Owned by
// the contacts module (M2a), registered as the live "maps" driver.
//
//   geocode(address) → { lat, lng, formatted, county?, zip? } | null
//   streetMeta(where) → { status: "OK", pano, lat, lng } | { status: "none" }
//       | { status: "denied" | "error" }: the Street View metadata endpoint
//       (free; no image), nearest outdoor panorama to a map point or an
//       address. "none" is Google's ZERO_RESULTS / NOT_FOUND (no coverage).
//   streetImage({ pano, heading, pitch, fov, size }) → JPEG bytes | null:
//       Street View Static (return_error_code, so never the grey tile)
//   aerialImage({ center, zoom, size, pin }) → JPEG bytes | null: Maps
//       Static, maptype satellite, scale 2, a red pin at the center
//   (the three above are the house picture's, modules/contacts/house.mjs)
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

// ------------------------------------------------------------ the house picture

export const STREETVIEW_URL = "https://maps.googleapis.com/maps/api/streetview";
export const STREETVIEW_META_URL = "https://maps.googleapis.com/maps/api/streetview/metadata";
export const STATICMAP_URL = "https://maps.googleapis.com/maps/api/staticmap";
const SIZE_RE = /^\d{2,3}x\d{2,3}$/;
const where = (w) => (w && Number.isFinite(w.lat) && Number.isFinite(w.lng) ? `${w.lat.toFixed(7)},${w.lng.toFixed(7)}` : typeof w === "string" ? str(w).slice(0, 300) : line(w || {}));

async function getGoogle(url, what) {
  try {
    return await fetch(url, { signal: AbortSignal.timeout(GOOGLE_TIMEOUT_MS) });
  } catch (e) {
    console.error(`crm:maps: Google ${what} didn't answer (${safeErr(e)})`);
    return null;
  }
}

async function imageBytes(res, what) {
  if (!res) return null;
  if (!res.ok) {
    console.error(`crm:maps: Google ${what} answered HTTP ${res.status}`);
    return null;
  }
  const ct = String(res.headers.get("content-type") || "");
  if (!/^image\/(jpeg|png)/.test(ct)) return null;
  const b = new Uint8Array(await res.arrayBuffer());
  return b.length > 100 && b.length < 3_000_000 ? b : null;
}

export async function streetMeta(at, { env = process.env } = {}) {
  const key = env.GOOGLE_MAPS_API_KEY;
  const loc = where(at);
  if (!key || !loc) return { status: "error" };
  // close first (the house's own pano), then a little further along the road
  for (const radius of ["50", "120"]) {
    const res = await getGoogle(`${STREETVIEW_META_URL}?${new URLSearchParams({ location: loc, radius, source: "outdoor", key })}`, "Street View metadata");
    if (!res) return { status: "error" };
    if (!res.ok) { console.error(`crm:maps: Street View metadata answered HTTP ${res.status}`); return { status: "error" }; }
    let body;
    try { body = await res.json(); } catch { return { status: "error" }; }
    const st = String((body && body.status) || "");
    if (st === "OK" && body.pano_id && body.location && Number.isFinite(body.location.lat) && Number.isFinite(body.location.lng)) {
      return { status: "OK", pano: String(body.pano_id).slice(0, 200), lat: body.location.lat, lng: body.location.lng };
    }
    if (st === "REQUEST_DENIED" || st === "OVER_QUERY_LIMIT") { console.error(`crm:maps: Street View metadata status ${st}`); return { status: "denied" }; }
    if (st !== "ZERO_RESULTS" && st !== "NOT_FOUND") { console.error(`crm:maps: Street View metadata status ${st.slice(0, 30)}`); return { status: "error" }; }
  }
  return { status: "none" };
}

export async function streetImage({ pano, heading, pitch = 8, fov = 90, size = "640x400" } = {}, { env = process.env } = {}) {
  const key = env.GOOGLE_MAPS_API_KEY;
  if (!key || !/^[A-Za-z0-9_-]{8,200}$/.test(String(pano || "")) || !SIZE_RE.test(size)) return null;
  const q = { size, pano, pitch: String(Math.round(pitch)), fov: String(Math.round(fov)), return_error_code: "true", key };
  if (Number.isFinite(heading)) q.heading = String(Math.round(heading));
  return imageBytes(await getGoogle(`${STREETVIEW_URL}?${new URLSearchParams(q)}`, "Street View"), "Street View");
}

export async function aerialImage({ center, zoom = 20, size = "640x400", pin = true } = {}, { env = process.env } = {}) {
  const key = env.GOOGLE_MAPS_API_KEY;
  const c = where(center);
  if (!key || !c || !SIZE_RE.test(size)) return null;
  const q = new URLSearchParams({ center: c, zoom: String(Math.max(15, Math.min(21, Math.round(zoom)))), size, scale: "2", maptype: "satellite", format: "jpg", key });
  if (pin) q.append("markers", `color:red|${c}`);
  return imageBytes(await getGoogle(`${STATICMAP_URL}?${q}`, "Static Maps"), "Static Maps");
}

export const mapsLive = Object.freeze({
  geocode: (address) => geocode(address),
  streetMeta: (at) => streetMeta(at),
  streetImage: (opts) => streetImage(opts),
  aerialImage: (opts) => aerialImage(opts),
});
registerAdapter("maps", "live", mapsLive);
