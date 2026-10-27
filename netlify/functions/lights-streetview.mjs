// GET /lights/streetview — Street View for Barta Light Studio, so the owner can
// type an address and start on the house photo without taking a screenshot.
//
//   ?address=123 Main St, Delano   → JSON {address, pano, heading, pitch, fov}:
//       the nearest outdoor Street View panorama, aimed at the house.
//   ?pano=…&heading=…&pitch=…&fov=… → the 640×480 JPEG of that view.
//   ?move=1|-1&pano=…&lat=…&lng=…&heading=…&hlat=…&hlng=… → the next panorama
//       to the right (1) or left (-1) along the road, still aimed at the house
//       (Street View metadata lookups are free).
//
// Only answers a signed-in /lights browser (same cookie as the page), so the
// Google key can't be spent by anyone else. The key stays server-side:
// GOOGLE_MAPS_API_KEY in Netlify, with the Geocoding API and the Street View
// Static API enabled. See docs/LIGHT-STUDIO.md.

import { signedIn } from "../lib/lights-auth.mjs";

export const config = { path: "/lights/streetview" };

const GOOGLE = "https://maps.googleapis.com/maps/api";
const SIZE = "640x480"; // Street View Static's largest size is 640 on each side

const headers = { "Cache-Control": "private, no-store", "X-Robots-Tag": "noindex, nofollow" };
const json = (body, status = 200) => Response.json(body, { status, headers });
const fail = (error, status) => json({ ok: false, error }, status);

const toRad = (d) => (d * Math.PI) / 180;
const toDeg = (r) => (r * 180) / Math.PI;
// Compass bearing from a to b, 0–360.
export function bearing(a, b) {
  const p1 = toRad(a.lat), p2 = toRad(b.lat), dl = toRad(b.lng - a.lng);
  const y = Math.sin(dl) * Math.cos(p2);
  const x = Math.cos(p1) * Math.sin(p2) - Math.sin(p1) * Math.cos(p2) * Math.cos(dl);
  return (toDeg(Math.atan2(y, x)) + 360) % 360;
}
// Meters between a and b.
export function meters(a, b) {
  const R = 6371000, p1 = toRad(a.lat), p2 = toRad(b.lat);
  const h = Math.sin(toRad(b.lat - a.lat) / 2) ** 2 + Math.cos(p1) * Math.cos(p2) * Math.sin(toRad(b.lng - a.lng) / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}

// The point d meters from a along compass bearing b.
export function offset(a, b, d) {
  const R = 6371000, br = toRad(b), p1 = toRad(a.lat), l1 = toRad(a.lng), q = d / R;
  const p2 = Math.asin(Math.sin(p1) * Math.cos(q) + Math.cos(p1) * Math.sin(q) * Math.cos(br));
  const l2 = l1 + Math.atan2(Math.sin(br) * Math.sin(q) * Math.cos(p1), Math.cos(q) - Math.sin(p1) * Math.sin(p2));
  return { lat: toDeg(p2), lng: toDeg(l2) };
}

async function getJson(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`google ${res.status}`);
  return res.json();
}

async function find(address, key) {
  const geo = await getJson(`${GOOGLE}/geocode/json?${new URLSearchParams({ address, components: "country:US", key })}`);
  if (geo.status === "ZERO_RESULTS" || !geo.results || !geo.results.length) return fail("not_found", 404);
  if (geo.status !== "OK") {
    console.error("lights-streetview geocode:", geo.status, geo.error_message || "");
    return fail(geo.status === "REQUEST_DENIED" ? "not_configured" : "google_error", 502);
  }
  const top = geo.results[0];
  const house = top.geometry.location;
  let meta = null;
  for (const q of [{ radius: "60", source: "outdoor" }, { radius: "150", source: "outdoor" }, { radius: "150" }]) {
    const m = await getJson(`${GOOGLE}/streetview/metadata?${new URLSearchParams({ location: `${house.lat},${house.lng}`, ...q, key })}`);
    if (m.status === "OK" && m.pano_id) { meta = m; break; }
    if (m.status === "REQUEST_DENIED") {
      console.error("lights-streetview metadata:", m.status, m.error_message || "");
      return fail("not_configured", 502);
    }
  }
  if (!meta) return fail("no_imagery", 404);
  const from = meta.location || house;
  const d = meters(from, house);
  return json({
    ok: true,
    address: top.formatted_address || address,
    pano: meta.pano_id,
    lat: from.lat,
    lng: from.lng,
    hlat: house.lat,
    hlng: house.lng,
    heading: Math.round(bearing(from, house)),
    // Closer houses need a wider, higher view to fit the roofline.
    pitch: d < 18 ? 14 : d < 35 ? 10 : 6,
    fov: d < 18 ? 100 : d < 35 ? 85 : 70,
  });
}

const num = (v, lo, hi) => {
  const n = Number(v);
  return Number.isFinite(n) && n >= lo && n <= hi ? n : null;
};

// Step sideways along the road: the next panorama past the current one, at
// right angles to where the camera faces, then aim it back at the house.
async function move(params, key) {
  const dir = Number(params.get("move")) < 0 ? -1 : 1;
  const pano = String(params.get("pano") || "");
  const here = { lat: num(params.get("lat"), -90, 90), lng: num(params.get("lng"), -180, 180) };
  const house = { lat: num(params.get("hlat"), -90, 90), lng: num(params.get("hlng"), -180, 180) };
  const heading = num(params.get("heading"), -720, 720);
  if (here.lat === null || here.lng === null || house.lat === null || house.lng === null || heading === null) return fail("bad_request", 400);
  const side = (heading + 90 * dir + 360) % 360;
  for (const d of [10, 16, 24, 34]) {
    const to = offset(here, side, d);
    const m = await getJson(`${GOOGLE}/streetview/metadata?${new URLSearchParams({ location: `${to.lat},${to.lng}`, radius: "12", source: "outdoor", key })}`);
    if (m.status === "OK" && m.pano_id && m.pano_id !== pano && m.location) {
      return json({ ok: true, pano: m.pano_id, lat: m.location.lat, lng: m.location.lng, heading: Math.round(bearing(m.location, house)) });
    }
  }
  return fail("end_of_road", 404);
}

async function image(params, key) {
  const pano = String(params.get("pano") || "");
  const heading = num(params.get("heading"), 0, 360);
  const pitch = num(params.get("pitch"), -90, 90);
  const fov = num(params.get("fov"), 10, 120);
  if (!/^[A-Za-z0-9_-]{8,120}$/.test(pano) || heading === null || pitch === null || fov === null) return fail("bad_request", 400);
  const res = await fetch(`${GOOGLE}/streetview?${new URLSearchParams({
    size: SIZE, pano, heading: String(heading), pitch: String(pitch), fov: String(fov), return_error_code: "true", key,
  })}`);
  if (!res.ok) {
    console.error("lights-streetview image:", res.status);
    return fail(res.status === 404 ? "no_imagery" : "google_error", res.status === 404 ? 404 : 502);
  }
  return new Response(await res.arrayBuffer(), {
    status: 200,
    headers: { "Content-Type": "image/jpeg", "Cache-Control": "private, max-age=86400", "X-Robots-Tag": "noindex, nofollow" },
  });
}

export default async (req) => {
  if (req.method !== "GET") return fail("method_not_allowed", 405);
  if (!signedIn(req)) return fail("signed_out", 401);
  const key = String(process.env.GOOGLE_MAPS_API_KEY || "").trim();
  if (!key) return fail("not_configured", 503);
  const params = new URL(req.url).searchParams;
  try {
    const address = String(params.get("address") || "").trim().slice(0, 200);
    if (address) return await find(address, key);
    if (params.has("move")) return await move(params, key);
    if (params.has("pano")) return await image(params, key);
    return fail("bad_request", 400);
  } catch (e) {
    console.error("lights-streetview:", e && e.message);
    return fail("google_error", 502);
  }
};
