// Contacts module: a picture of the house (docs/CRM-MAP.md "The house
// picture"). The owner, Nov 2026: "make sure every lead and customer has a
// Google Street View or a Google Earth view or something of the house."
//
//   GET /properties/:id/house.jpg?kind=street|aerial&size=full|thumb
//       the picture, for whoever may read the property (a tech: the
//       properties of their visits). street: Google Street View Static,
//       aimed from the nearest outdoor panorama at the house (the metadata
//       endpoint first, so the grey "no imagery" tile is never shown; no
//       coverage → 404 and the screen shows the aerial). aerial: Maps Static,
//       satellite, zoom 20 (a thumb 19), a red pin. 404 when Google Maps
//       isn't live (local, tests, dry-run): the screens then show the
//       keyless satellite or a plain square, never a broken picture.
//   GET /contacts/:id/house.jpg?...   the same, of the contact's primary
//       property (else their first): a list row knows the contact; whoever
//       may read that property. A contact with no property yet but a billing
//       address (a lead typed in by hand): that address's picture, kept
//       under the contact's id, for whoever may read the contact.
//   GET /house/status → { on }: whether pictures can come at all (the
//       screens ask once, so a list never asks for 50 pictures that can't come)
//   runHouseSweep(ctx)  the contacts.house sweep (bulk lane, every pass):
//       walks every property (rec/property/, resumable after its last key,
//       once a day), geocodes one without a map point through the existing
//       geocodeProperty (a derived field, which the parallel-run guard
//       allows on imported records, as the contacts.geocode sweep does) and
//       warms the default picture (street, else aerial; full and thumb), a
//       few properties a pass; then every contact with a billing address and
//       no property (rec/contact/, the same way). Deleted properties lose
//       their pictures. Nothing it does changes a record but the derived geo.
//
// Pictures are kept in crm-files at h/{propertyId}/{hash}-{kind}-{size}
// (never backed up: they come back from Google), where hash is the
// address and map point (sha-256, 16 hex): a new address (or a moved map
// point) asks Google again and deletes the old ones; any other view is a
// Blobs read, never a Google call. geo/house/p/{propertyId} remembers the
// panorama, its aim and "no Street View here", so the free metadata call is
// made once per address too.
//
// Budget (geo/house/use/{YYYY-MM}, one CAS'd counter): every billed Google
// call (an image or a geocode) is counted BEFORE it is made, and refused
// past CAPS: 9,000 a month (under Google's 10,000 free calls a month per
// API), 600 a day, the sweep 450 of those, one person 150 a day. A storage
// error spends nothing (no call). Logs carry statuses and counts only,
// never an address or a key.

import { createHash } from "node:crypto";
import { getRaw, putRaw, deleteRaw, settledWrite, listKeys, getRecord, listRel } from "../../../crm-store.mjs";
import { adapter } from "../../adapters/index.mjs";
import { now, nowIso, localDate } from "../../core/clock.mjs";
import { NotFoundError, RateLimited } from "../../core/errors.mjs";
import { isId } from "../../core/ids.mjs";
import { addressOneLine } from "./display.mjs";
import { geocodeProperty } from "./properties.mjs";
import { readableProperty, readable } from "./routes.mjs";
import { safeErr } from "../../../referral-lib.mjs";

export const HOUSE_KINDS = Object.freeze(["street", "aerial"]);
export const HOUSE_SIZES = Object.freeze({ full: "640x400", thumb: "160x160" });
export const CAPS = Object.freeze({ month: 9000, day: 600, sweepDay: 450, userDay: 150 });
export const SWEEP_SCAN = 40;     // properties a pass looks at
export const SWEEP_WARM = 5;      // properties a pass may ask Google about
export const SWEEP_KEY = "geo/house/sweep";
export const metaKey = (pid) => `geo/house/p/${pid}`;
export const useKey = (month) => `geo/house/use/${month}`;
export const imageKey = (pid, h, kind, size) => `h/${pid}/${h}-${kind}-${size}`;

const str = (v) => (v == null ? "" : String(v)).trim();
const hasGeo = (p) => !!(p && p.geo && Number.isFinite(p.geo.lat) && Number.isFinite(p.geo.lng));
export const pictureable = (p) => !!(p && !p.deleted_at && p.address && str(p.address.street1));

// The address and the map point (to ~1 m): what the picture is of.
export function houseHash(p) {
  const g = hasGeo(p) ? [Math.round(p.geo.lat * 1e5), Math.round(p.geo.lng * 1e5)] : null;
  return createHash("sha256").update(JSON.stringify({ a: addressOneLine(p.address).toLowerCase(), g })).digest("hex").slice(0, 16);
}

// ------------------------------------------------------------ aiming the camera

const toRad = (d) => (d * Math.PI) / 180;
// Compass bearing from a to b, 0-360 (the same math as Light Studio's).
export function bearing(a, b) {
  const p1 = toRad(a.lat), p2 = toRad(b.lat), dl = toRad(b.lng - a.lng);
  const y = Math.sin(dl) * Math.cos(p2);
  const x = Math.cos(p1) * Math.sin(p2) - Math.sin(p1) * Math.cos(p2) * Math.cos(dl);
  return ((Math.atan2(y, x) * 180) / Math.PI + 360) % 360;
}
export function meters(a, b) {
  const R = 6371000, p1 = toRad(a.lat), p2 = toRad(b.lat);
  const h = Math.sin(toRad(b.lat - a.lat) / 2) ** 2 + Math.cos(p1) * Math.cos(p2) * Math.sin(toRad(b.lng - a.lng) / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}
// From the panorama to the house: the heading, and a wider, higher view when the house is close.
export function aim(pano, house) {
  if (!house || !hasGeo({ geo: house })) return { pitch: 8, fov: 90 };
  const d = meters(pano, house);
  return { heading: Math.round(bearing(pano, house)), pitch: d < 18 ? 12 : d < 35 ? 8 : 5, fov: d < 18 ? 110 : d < 35 ? 95 : 80 };
}

// ------------------------------------------------------------ the budget

// → true when one more billed Google call may be made (and it is counted now).
export async function spend({ sweep = false, uid = null } = {}) {
  const today = localDate(now());
  const key = useKey(today.slice(0, 7));
  for (let i = 0; i < 4; i++) {
    let got;
    try { got = await getRaw(key); } catch (e) { console.error(`crm:house: budget not read (${safeErr(e)})`); return false; }
    const d = got && got.data ? got.data : {};
    const fresh = d.d !== today;
    const dn = fresh ? 0 : Number(d.dn) || 0, ds = fresh ? 0 : Number(d.ds) || 0, u = fresh ? {} : { ...(d.u || {}) };
    const n = Number(d.n) || 0;
    if (n >= CAPS.month || dn >= CAPS.day || (sweep && ds >= CAPS.sweepDay) || (uid && (Number(u[uid]) || 0) >= CAPS.userDay)) return false;
    if (uid) u[uid] = (Number(u[uid]) || 0) + 1;
    try {
      const r = await settledWrite(key, { n: n + 1, d: today, dn: dn + 1, ds: ds + (sweep ? 1 : 0), u }, got ? { onlyIfMatch: got.etag } : { onlyIfNew: true });
      if (r.ok) return true;
    } catch (e) {
      console.error(`crm:house: budget not saved (${safeErr(e)})`);
      return false;
    }
  }
  return false;
}

// ------------------------------------------------------------ the picture

// What is remembered about a property's pictures: { h, street?: "ok" | "none", view?, have: [] }.
async function readMeta(pid) {
  const got = await getRaw(metaKey(pid));
  return got && got.data ? { data: got.data, etag: got.etag } : null;
}
// A change to it (a CAS, so two pictures made at once both stay listed).
async function saveMeta(pid, h, change) {
  for (let i = 0; i < 4; i++) {
    const cur = await readMeta(pid);
    const base = cur && cur.data.h === h ? cur.data : { h, have: [] };
    const next = change({ ...base, have: [...(base.have || [])] });
    const { _w, ...clean } = next;
    const r = await settledWrite(metaKey(pid), { ...clean, at: nowIso() }, cur ? { onlyIfMatch: cur.etag } : { onlyIfNew: true });
    if (r.ok) return;
  }
}

// The pictures of an old address (or a deleted property): gone.
export async function dropPictures(pid, keepHash = null) {
  const keys = await listKeys(`h/${pid}/`, { kind: "files" });
  for (const k of keys) if (!keepHash || !k.startsWith(`h/${pid}/${keepHash}-`)) await deleteRaw(k, { kind: "files" });
}

const cachedBytes = async (key) => {
  const got = await getRaw(key, { kind: "files", type: "arrayBuffer" });
  return got && got.data ? new Uint8Array(got.data) : null;
};

const liveMaps = (maps) => !!(maps && maps.mode === "live" && maps.impl && typeof maps.impl.streetMeta === "function" && typeof maps.impl.aerialImage === "function");

// The picture of one property. → { bytes, h } | { none: "off" | "no_address" | "no_imagery" | "budget" | "failed" }
// prop: the property record's data; maps: the "maps" adapter; who: { sweep, uid } for the budget;
// geo: { write, deploy } to geocode a property without a map point first (once).
export async function housePicture(prop, { kind = "street", size = "full", maps, who = {}, geo = null } = {}) {
  if (!HOUSE_KINDS.includes(kind) || !HOUSE_SIZES[size]) return { none: "failed" };
  if (!pictureable(prop)) return { none: "no_address" };
  if (!liveMaps(maps)) return { none: "off" };
  let p = prop;
  if (!hasGeo(p) && !p.geo_tried_at && geo && typeof maps.impl.geocode === "function") {
    if (!(await spend(who))) return { none: "budget" };
    try {
      await geocodeProperty(p.id, geo.write, { deploy: geo.deploy });
      const again = await getRecord("property", p.id);
      if (again && again.data) p = again.data;
    } catch (e) {
      console.error(`crm:house: geocode skipped (${safeErr(e)})`);
    }
  }
  const h = houseHash(p);
  const cur = await readMeta(p.id);
  if (cur && cur.data.h && cur.data.h !== h) await dropPictures(p.id, h).catch((e) => console.error(`crm:house: old pictures not deleted (${safeErr(e)})`));
  const meta = cur && cur.data.h === h ? cur.data : { h, have: [] };
  if (kind === "street" && meta.street === "none") return { none: "no_imagery" };
  const tag = `${kind}-${size}`;
  const key = imageKey(p.id, h, kind, size);
  if ((meta.have || []).includes(tag)) {
    const bytes = await cachedBytes(key);
    if (bytes) return { bytes, h };
  }
  const place = hasGeo(p) ? { lat: p.geo.lat, lng: p.geo.lng } : addressOneLine(p.address);
  let bytes = null;
  if (kind === "street") {
    let view = meta.view;
    if (!view) {
      const m = await maps.impl.streetMeta(place);
      if (m && m.status === "none") {
        await saveMeta(p.id, h, (x) => ({ ...x, street: "none" }));
        return { none: "no_imagery" };
      }
      if (!m || m.status !== "OK") return { none: "failed" };
      view = { pano: m.pano, ...aim(m, hasGeo(p) ? p.geo : null) };
      await saveMeta(p.id, h, (x) => ({ ...x, street: "ok", view }));
    }
    if (!(await spend(who))) return { none: "budget" };
    bytes = await maps.impl.streetImage({ ...view, size: HOUSE_SIZES[size] });
  } else {
    if (!(await spend(who))) return { none: "budget" };
    bytes = await maps.impl.aerialImage({ center: place, zoom: size === "thumb" ? 19 : 20, size: HOUSE_SIZES[size], pin: true });
  }
  if (!bytes || !bytes.length) return { none: "failed" };
  await putRaw(key, bytes, {}, { kind: "files" });
  await saveMeta(p.id, h, (x) => ({ ...x, have: [...new Set([...(x.have || []), tag])] }));
  return { bytes, h };
}

// ------------------------------------------------------------ the routes

const IMAGE_TYPE = (b) => (b[0] === 0x89 && b[1] === 0x50 ? "image/png" : "image/jpeg");
const isJpegOrPng = (b) => b.length > 3 && ((b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) || (b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47));

async function houseRoute(ctx, propertyId = ctx.params.id) {
  const kind = ctx.query.get("kind") === "aerial" ? "aerial" : "street";
  const size = ctx.query.get("size") === "thumb" ? "thumb" : "full";
  const got = await readableProperty(ctx, propertyId);
  const maps = await adapter("maps", { deploy: ctx.deploy });
  if (!liveMaps(maps)) throw new NotFoundError("No picture of this house yet.");
  if (!pictureable(got.data)) throw new NotFoundError("This property has no street address.");
  const etag = `"house-${houseHash(got.data)}-${kind}-${size}"`;
  if (hasGeo(got.data) && ctx.req.headers.get("if-none-match") === etag) {
    return new Response(null, { status: 304, headers: { ETag: etag, "Cache-Control": "private, max-age=3600" } });
  }
  const out = await housePicture(got.data, { kind, size, maps, who: { uid: ctx.user ? ctx.user.id : null }, geo: { write: ctx.write(), deploy: ctx.deploy } });
  return pictureResponse(out, kind, size);
}

function pictureResponse(out, kind, size) {
  if (out.none === "budget") throw new RateLimited("Too many house pictures today. The rest come tomorrow.", 3600);
  if (out.none || !isJpegOrPng(out.bytes)) throw new NotFoundError(out.none === "no_imagery" ? "No Street View here." : "No picture of this house yet.");
  return new Response(out.bytes, {
    status: 200,
    headers: {
      "Content-Type": IMAGE_TYPE(out.bytes),
      "X-Content-Type-Options": "nosniff",
      "Content-Security-Policy": "sandbox",
      "Content-Disposition": "inline",
      "Cache-Control": "private, max-age=3600",
      ETag: `"house-${out.h}-${kind}-${size}"`,
      "X-Robots-Tag": "noindex, nofollow",
    },
  });
}

// The place a contact's picture is of: their primary property (else their first), else (no
// property yet) their billing address, kept under the contact's own id. → { pid } | { place } | null
export async function contactPlace(c) {
  if (!c || c.deleted_at) return null;
  if (isId(c.primary_property_id, "property")) return { pid: c.primary_property_id };
  const first = (await listRel("contact-properties", c.id, { limit: 1 }))[0];
  if (first && isId(first.id, "property")) return { pid: first.id };
  const a = c.billing_address;
  return a && str(a.street1) ? { place: { id: c.id, address: a } } : null;
}

// A contact's picture (a list row knows the contact, not the property).
async function contactHouseRoute(ctx) {
  const got = await readable(ctx, ctx.params.id);
  const where = await contactPlace(got.data);
  if (!where) throw new NotFoundError("No picture of this house yet.");
  if (where.pid) return houseRoute(ctx, where.pid);
  const kind = ctx.query.get("kind") === "aerial" ? "aerial" : "street";
  const size = ctx.query.get("size") === "thumb" ? "thumb" : "full";
  const maps = await adapter("maps", { deploy: ctx.deploy });
  if (!liveMaps(maps)) throw new NotFoundError("No picture of this house yet.");
  // (no map point to find here: Google aims at the address itself)
  return pictureResponse(await housePicture(where.place, { kind, size, maps, who: { uid: ctx.user ? ctx.user.id : null } }), kind, size);
}

async function statusRoute(ctx) {
  const maps = await adapter("maps", { deploy: ctx.deploy });
  return { data: { on: liveMaps(maps) && !!str(process.env.GOOGLE_MAPS_API_KEY) } };
}

export const houseRoutes = [
  { method: "GET", path: "/properties/:id/house.jpg", auth: "session", perm: "contacts:read", subject: "required", mode: "inline", handler: houseRoute, maxCalls: 45 },
  { method: "GET", path: "/contacts/:id/house.jpg", auth: "session", perm: "contacts:read", subject: "required", mode: "inline", handler: contactHouseRoute, maxCalls: 45 },
  { method: "GET", path: "/house/status", auth: "session", perm: "contacts:read", subject: "required", mode: "inline", handler: statusRoute },
];

// ------------------------------------------------------------ the sweep

// The contacts.house sweep. → { done, progress?, result }
export async function runHouseSweep(ctx) {
  const maps = await adapter("maps", { deploy: ctx.deploy, mode: ctx.mode });
  if (!liveMaps(maps) || !str(process.env.GOOGLE_MAPS_API_KEY)) return { done: true, result: `skipped:${maps.mode}` };
  const today = localDate(now());
  const st = await getRaw(SWEEP_KEY);
  const state = st && st.data ? st.data : {};
  if (state.day_done === today) return { done: true, result: "done_today" };
  // two walks, one after the other: every property, then contacts with no property (their billing address)
  const after = typeof state.after === "string" ? state.after : "";
  const phase = state.phase === "contacts" ? "contacts" : "properties";
  if (phase === "contacts") return contactsWalk(ctx, maps, st, state, today, after);
  const keys = (await listKeys("rec/property/")).filter((k) => k > after);
  let last = after, looked = 0, warmed = 0, stop = null;
  for (const k of keys) {
    if (looked >= SWEEP_SCAN || warmed >= SWEEP_WARM) { stop = "batch"; break; }
    if (ctx.budget && ctx.budget.left() < 15000) { stop = "time"; break; }
    looked += 1;
    const id = k.slice("rec/property/".length);
    const got = await getRecord("property", id).catch(() => null);
    const p = got && got.data;
    if (!p || p.deleted_at) {
      if (p && p.deleted_at) {
        await dropPictures(id).catch(() => {});
        await deleteRaw(metaKey(id)).catch(() => {});
      }
      last = k;
      continue;
    }
    if (!pictureable(p)) { last = k; continue; }
    const meta = await readMeta(id);
    const have = meta && meta.data.h === houseHash(p) ? meta.data : null;
    const kind = have && have.street === "none" ? "aerial" : "street";
    if (have && (have.have || []).includes(`${kind}-full`) && (have.have || []).includes(`${kind}-thumb`)) { last = k; continue; }
    warmed += 1;
    let budget = false, cur = p;
    for (const size of ["full", "thumb"]) {
      // (the first picture may have found the map point: the second is of the same house)
      if (size === "thumb" && !hasGeo(cur)) cur = ((await getRecord("property", id).catch(() => null)) || { data: cur }).data;
      let out = await housePicture(cur, { kind, size, maps, who: { sweep: true }, geo: { write: ctx.write(), deploy: ctx.deploy } });
      if (out.none === "no_imagery") out = await housePicture(cur, { kind: "aerial", size, maps, who: { sweep: true } });
      if (out.none === "budget") { budget = true; break; }
    }
    if (budget) { stop = "budget"; break; }
    last = k;
  }
  // (the properties walked: the contacts' walk next, from its start)
  const next = !stop ? { phase: "contacts", after: null, day_done: state.day_done || null, warmed_last: warmed } : { phase, after: last, day_done: state.day_done || null, warmed_last: warmed };
  await saveSweep(st, next);
  return { done: true, progress: looked, result: !stop ? `properties:${warmed}` : `${stop}:${warmed}` };
}

const saveSweep = (st, next) => settledWrite(SWEEP_KEY, { ...next, at: nowIso() }, st ? { onlyIfMatch: st.etag } : { onlyIfNew: true }).catch((e) => console.error(`crm:house: sweep place not saved (${safeErr(e)})`));

// The second walk: a contact with a billing address and no property yet (a lead typed in by hand)
// gets that address's picture, kept under the contact's id (no map point is looked up for it).
async function contactsWalk(ctx, maps, st, state, today, after) {
  const keys = (await listKeys("rec/contact/")).filter((k) => k > after);
  let last = after, looked = 0, warmed = 0, stop = null;
  for (const k of keys) {
    if (looked >= SWEEP_SCAN || warmed >= SWEEP_WARM) { stop = "batch"; break; }
    if (ctx.budget && ctx.budget.left() < 15000) { stop = "time"; break; }
    looked += 1;
    const id = k.slice("rec/contact/".length);
    const got = await getRecord("contact", id).catch(() => null);
    const c = got && got.data;
    if (c && (c.deleted_at || c.merged_into)) {
      // (gone or merged away: its own pictures go too)
      if (await readMeta(id).catch(() => null)) { await dropPictures(id).catch(() => {}); await deleteRaw(metaKey(id)).catch(() => {}); }
      last = k;
      continue;
    }
    const where = c && c.lifecycle !== "archived" ? await contactPlace(c).catch(() => null) : null;
    if (!where || !where.place) { last = k; continue; }
    const p = where.place;
    const meta = await readMeta(id);
    const have = meta && meta.data.h === houseHash(p) ? meta.data : null;
    const kind = have && have.street === "none" ? "aerial" : "street";
    if (have && (have.have || []).includes(`${kind}-full`) && (have.have || []).includes(`${kind}-thumb`)) { last = k; continue; }
    warmed += 1;
    let budget = false;
    for (const size of ["full", "thumb"]) {
      let out = await housePicture(p, { kind, size, maps, who: { sweep: true } });
      if (out.none === "no_imagery") out = await housePicture(p, { kind: "aerial", size, maps, who: { sweep: true } });
      if (out.none === "budget") { budget = true; break; }
    }
    if (budget) { stop = "budget"; break; }
    last = k;
  }
  const next = !stop ? { phase: "properties", after: null, day_done: today, warmed_last: warmed } : { phase: "contacts", after: last, day_done: state.day_done || null, warmed_last: warmed };
  await saveSweep(st, next);
  return { done: true, progress: looked, result: !stop ? `walked:${warmed}` : `contacts-${stop}:${warmed}` };
}
