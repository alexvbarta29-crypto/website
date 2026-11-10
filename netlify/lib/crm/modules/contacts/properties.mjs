// Contacts module: properties (design §5.1 "Property", §6.5).
//
// At least one property per customer (contact.primary_property_id); plans,
// jobs, visits and quotes point at a property, not only the contact.
//
//   ensureProperty(contactId, address)  the contacts.ensureProperty service:
//                                       the contact's property at that street
//                                       + ZIP, made when there is none (its id
//                                       derives from the contact and the
//                                       address, so a retry makes nothing twice)
//   geocodeProperty(id)                 one Google geocode through the maps
//                                       adapter (dry-run: no call, no change)
//   runGeocode(ctx)                     the contacts.geocode sweep: up to 10
//                                       properties still waiting for a map point
//
// The geo, county, distance and tier are derived fields (never rotorFields),
// so the parallel-run guard lets the sweep fill them on imported properties.

import { listRel, getRecords, getRecord, createRecord, updateRecord, getSetting } from "../../../crm-store.mjs";
import { deriveId, isId } from "../../core/ids.mjs";
import { nowIso } from "../../core/clock.mjs";
import { ExistsError, NotFoundError } from "../../core/errors.mjs";
import { adapter } from "../../adapters/index.mjs";
import { normalizeAddress, addressKey, areaTier } from "./display.mjs";
import { safeErr } from "../../../referral-lib.mjs";

export const GEOCODE_BATCH = 10;

// The contact's properties, newest first (deleted ones dropped).
export async function propertiesOf(contactId, opts = {}) {
  const rows = await listRel("contact-properties", contactId, { limit: 50 }, opts);
  const got = await getRecords("property", rows.map((r) => r.id).slice(0, 16), opts);
  return got.filter((g) => g && !g.data.deleted_at && g.data.contact_id === contactId).map((g) => ({ ...g.data, etag: g.etag }));
}

// → property_id (an existing match by street + ZIP, else a new one). When the
// contact has no primary property yet, this one becomes it.
export async function ensureProperty(contactId, address, ctx = {}) {
  const a = normalizeAddress(address);
  if (!a || !a.street1) return null;
  const key = addressKey(a);
  const existing = await propertiesOf(contactId, ctx);
  let found = existing.find((p) => addressKey(p.address) === key);
  if (!found) {
    const id = deriveId("property", `contact:${contactId}`, "contacts.ensureProperty", key);
    try {
      found = (await createRecord("property", { id, contact_id: contactId, label: existing.length ? "Property" : "Home", address: a, access: {}, assets: {}, photo_ids: [] }, ctx)).data;
    } catch (e) {
      if (!(e instanceof ExistsError)) throw e;
      const got = await getRecord("property", id, ctx);
      if (!got) throw e;
      found = got.data;
    }
  }
  const c = await getRecord("contact", contactId, ctx);
  if (c && !c.data.primary_property_id) {
    await updateRecord("contact", contactId, (rec) => (rec.primary_property_id ? null : { ...rec, primary_property_id: found.id }), ctx);
  }
  return found.id;
}

// The map point, county, distance from Delano and tier for one property.
// → { geo, town_tier, distance_mi, county } | { skipped: "dry_run" | "off" | "no_result" }
export async function geocodeProperty(id, ctx = {}, { deploy } = {}) {
  if (!isId(id, "property")) throw new NotFoundError("That property isn't there.");
  const got = await getRecord("property", id, ctx);
  if (!got || got.data.deleted_at) throw new NotFoundError("That property isn't there.");
  const maps = await adapter("maps", { deploy, mode: ctx.mode });
  if (maps.mode !== "live" || !maps.impl) return { skipped: maps.mode === "off" ? "off" : "dry_run" };
  let result = null;
  try {
    result = await maps.impl.geocode(got.data.address);
  } catch (e) {
    console.error(`crm:contacts: geocode failed (${safeErr(e)})`);
  }
  const area = await getSetting("service_area", ctx).catch(() => ({}));
  const r = await updateRecord("property", id, (p) => {
    if (!result) return { ...p, geo_tried_at: nowIso() };
    const geo = { lat: result.lat, lng: result.lng, source: "google", at: nowIso() };
    const tier = areaTier({ geo, city: p.address && p.address.city }, area);
    return { ...p, geo, town_tier: tier.town_tier, ...(tier.distance_mi !== undefined ? { distance_mi: tier.distance_mi } : {}), ...(result.county ? { county: result.county } : {}), geo_tried_at: nowIso() };
  }, ctx);
  if (!result) return { skipped: "no_result" };
  return { geo: r.data.geo, town_tier: r.data.town_tier, distance_mi: r.data.distance_mi ?? null, county: r.data.county || null };
}

// The contacts.geocode sweep (bulk lane, every chunk): up to 10 properties
// without a map point. Dry-run or off: nothing is called and nothing changes.
export async function runGeocode(ctx) {
  const maps = await adapter("maps", { deploy: ctx.deploy, mode: ctx.mode });
  if (maps.mode !== "live" || !maps.impl) return { done: true, result: `skipped:${maps.mode}` };
  const rows = await listRel("geo-pending", "all", { limit: GEOCODE_BATCH, newestFirst: false });
  let n = 0;
  for (const r of rows) {
    if (ctx.budget && ctx.budget.left() < 10000) break;
    try {
      await geocodeProperty(r.id, ctx.write(), { deploy: ctx.deploy });
      n += 1;
    } catch (e) {
      console.error(`crm:contacts: geocode sweep skipped one (${safeErr(e)})`);
    }
  }
  return { done: true, progress: n };
}
