// Map module: the door-to-door map's pins, places and report
// (docs/CRM-MAP.md "Door to door").
//
//   GET    /map/knock                 the screen's start: map sources, pin types, territories, who I am
//   GET    /map/places?bbox=          customers and open leads with a map point (ix/places + ix/contacts);
//                                     only the office (contacts:read_all) gets names and addresses
//   GET    /map/pins?bbox=            pins of this year and last (ix/pins/{yyyy}), inside the box
//   POST   /map/pins                  drop a pin { client_id, lat, lng, type_key, note?, follow_up_on?, address? }
//                                     (replaySafe: a pin dropped with no signal arrives later, once)
//   GET    /map/pins/:id              one pin: its knocks, who, where, its lead
//   PATCH  /map/pins/:id              { client_id, type_key?, knock?, note?, follow_up_on?, address? }
//   DELETE /map/pins/:id              a wrong tap: the person who dropped it (same day) or a manager
//   POST   /map/pins/:id/convert      Convert to lead: contacts.intake (source "Door to Door", the pin's
//                                     address, the canvasser as owner; the follow-up the sales
//                                     module's rules start); the pin then names the contact
//   GET    /map/reverse?lat&lng       the address at a dropped pin (geocode.mjs)
//   GET    /map/report?from&to&group  doors, conversations, leads, booked: per person, per day or
//                                     week, per territory (pins count where they are)
//
// A knock: dropping a pin is one; "Knocked again" is another; changing a
// pin's type the same day by the same person corrects that day's knock
// (a wrong tap, or the answer after talking), never counts twice.

import { getRecord, createRecord, updateRecord, softDelete, readIndex, getSetting } from "../../../crm-store.mjs";
import { deriveId, isId } from "../../core/ids.mjs";
import { nowIso, now, localDate, addLocalDays, isLocalDate, dowOfDate } from "../../core/clock.mjs";
import { InputError, NotFoundError, ForbiddenError, ExistsError, ConflictError } from "../../core/errors.mjs";
import { has, call } from "../../core/services.mjs";
import { contactShard } from "../../core/stats.mjs";
import { mapSources } from "../../core/map-sources.mjs";
import { timeOf } from "../work/timesheets.mjs";
import { areaTier } from "../contacts/display.mjs";
import { safeErr } from "../../../referral-lib.mjs";
import { pinTypesOf, cleanAddress, CLIENT_RE, CONVERSATIONS, MAX_KNOCKS, MAX_OPS, TYPE_KEY_RE, isPinId } from "./types.mjs";
import { pointInPolygon, parseBbox, inBbox } from "./geo.mjs";
import { reverseGeocode } from "./geocode.mjs";

export const MAX_PINS = 4000;          // pins one map read returns
export const MAX_PLACES = 6000;
export const REPORT_DAYS = 400;        // the longest report

const str = (v) => (v == null ? "" : String(v)).trim();
const today = () => localDate(now());
const clientOf = (b) => {
  const c = b && typeof b.client_id === "string" && CLIENT_RE.test(b.client_id) ? b.client_id.toLowerCase() : null;
  if (!c) throw new InputError("This change needs the phone's client id.", "client_id");
  return c;
};
const num = (v, f, lim) => { if (typeof v !== "number" || !Number.isFinite(v) || Math.abs(v) > lim) throw new InputError("That isn't a place on the map.", f); return v; };

export const loadPinTypes = async () => pinTypesOf(await getSetting("pin_types"));
const typeOf = (types, key, { active = true } = {}) => {
  const t = types.find((x) => x.key === key);
  if (!t || (active && !t.active)) throw new InputError("Pick one of the pin types.", "type_key");
  return t;
};

// What a person sees of a pin: the office also sees the lead it became.
export function pinView(p, ctx) {
  const out = { ...p };
  if (!ctx.can("contacts:read_all")) { delete out.contact_id; delete out.property_id; delete out.converted_by; delete out.ops; delete out.client_id; }
  delete out._w;
  return out;
}

async function loadPin(id) {
  if (!isPinId(id)) throw new NotFoundError("That pin isn't there.");
  const g = await getRecord("pin", id);
  if (!g || g.data.deleted_at) throw new NotFoundError("That pin isn't there.");
  return g;
}

// ------------------------------------------------------------ the screen's start

export async function knockStart(ctx) {
  const [types, area, terr, users] = await Promise.all([loadPinTypes(), getSetting("service_area").catch(() => ({})), readIndex("territories", ""), readIndex("users", "")]);
  const me = ctx.user.id;
  const names = new Map(users.rows.map((u) => [u.id, u.name]));
  const territories = terr.rows.filter((t) => t.act !== false).map((t) => ({ id: t.id, name: t.n, color: t.col, polygon: t.p, assignee_ids: t.a || [], assignees: (t.a || []).map((u) => names.get(u) || "Someone"), mine: (t.a || []).includes(me) }));
  const center = area && area.center && Number.isFinite(area.center.lat) ? area.center : { lat: 45.0419, lng: -93.7891 };
  return {
    data: {
      sources: mapSources(), center, today: today(), types, territories,
      me: { id: me, manage: ctx.can("canvass:manage"), office: ctx.can("contacts:read_all") },
      people: ctx.can("canvass:manage") ? users.rows.filter((u) => u.status === "active").map((u) => ({ id: u.id, name: u.name, color: u.color })) : [],
    },
  };
}

// ------------------------------------------------------------ customers and leads on the map

const KIND = { customer: "customer", lead: "lead", former_customer: "former" };
export async function places(ctx) {
  const box = ctx.query.get("bbox") ? parseBbox(ctx.query.get("bbox")) : null;
  if (ctx.query.get("bbox") && !box) throw new InputError("Zoom in a little.", "bbox");
  const [pl, cx] = await Promise.all([readIndex("places", ""), readIndex("contacts", contactShard("ct_00000000000000000000"))]);
  const contacts = new Map(cx.rows.map((r) => [r.id, r]));
  const office = ctx.can("contacts:read_all");
  const out = [];
  const seen = new Set();
  for (const p of pl.rows) {
    if (!Number.isFinite(p.la) || !Number.isFinite(p.ln) || !inBbox(p.ln, p.la, box)) continue;
    const c = contacts.get(p.c);
    if (!c) continue;
    const kind = KIND[c.lc];
    const fl = c.fl || {};
    if (!kind || fl.test || fl.spam || fl.vendor || fl.placeholder) continue;
    const dot = `${p.la.toFixed(5)},${p.ln.toFixed(5)}`;
    if (seen.has(dot)) continue;          // one marker a house
    seen.add(dot);
    out.push(office ? { la: p.la, ln: p.ln, k: kind, c: p.c, n: c.n || "", a: p.a || "" } : { la: p.la, ln: p.ln, k: kind });
    if (out.length >= MAX_PLACES) break;
  }
  return { data: { places: out, truncated: out.length >= MAX_PLACES } };
}

// ------------------------------------------------------------ pins

const shardsFor = (from, to) => {
  const out = [];
  for (let y = Number(from.slice(0, 4)); y <= Number(to.slice(0, 4)); y++) out.push(String(y));
  return out;
};
async function pinRows(years) {
  const ix = await Promise.all(years.map((y) => readIndex("pins", y)));
  return ix.flatMap((x) => x.rows);
}

export async function listPins(ctx) {
  const box = ctx.query.get("bbox") ? parseBbox(ctx.query.get("bbox")) : null;
  if (ctx.query.get("bbox") && !box) throw new InputError("Zoom in a little.", "bbox");
  const y = today().slice(0, 4);
  const rows = await pinRows([String(Number(y) - 1), y]);
  const out = [];
  for (const r of rows) {
    if (!inBbox(r.ln, r.la, box)) continue;
    const last = r.k && r.k.length ? r.k[r.k.length - 1] : null;
    out.push({ id: r.id, la: r.la, ln: r.ln, t: r.t, o: r.o, c: r.c, ...(r.fu ? { fu: r.fu } : {}), ...(r.cv ? { lead: true } : {}), ...(last ? { d: last[0] } : {}), n: (r.k || []).length });
    if (out.length >= MAX_PINS) break;
  }
  return { data: { pins: out, truncated: out.length >= MAX_PINS } };
}

export async function createPin(ctx) {
  const b = ctx.body || {};
  const client = clientOf(b);
  const lat = num(b.lat, "lat", 90);
  const lng = num(b.lng, "lng", 180);
  if (!TYPE_KEY_RE.test(str(b.type_key))) throw new InputError("Pick one of the pin types.", "type_key");
  const id = deriveId("pin", `pin--${ctx.user.id}--${client}`, "map.pin", 1);
  const had = await getRecord("pin", id);
  if (had) return { status: had.data.deleted_at ? 200 : 201, data: pinView(had.data, ctx), etag: had.etag };
  const type = typeOf(await loadPinTypes(), str(b.type_key));
  const time = timeOf(ctx);
  const address = b.address !== undefined && b.address !== null ? cleanAddress(b.address) : undefined;
  const note = str(b.note).slice(0, 1000);
  const rec = {
    id, lat, lng, type_key: type.key, type_label: type.label, type_color: type.color, outcome: type.outcome,
    ...(note ? { note } : {}), ...(isLocalDate(b.follow_up_on) ? { follow_up_on: b.follow_up_on } : {}),
    ...(address ? { address, address_source: b.address_source === "reverse" ? "reverse" : "typed" } : {}),
    knocks: [{ at: time.at, by: ctx.user.id, type_key: type.key, outcome: type.outcome, ...(time.trusted === false ? { unverified: true } : {}) }],
    canvasser_id: ctx.user.id, client_id: client, ops: [client],
  };
  let made;
  try { made = await createRecord("pin", rec, ctx.write()); } catch (e) {
    if (!(e instanceof ExistsError)) throw e;
    const g = await getRecord("pin", id);
    if (!g) throw e;
    return { data: pinView(g.data, ctx), etag: g.etag };
  }
  return { status: 201, data: pinView(made.data, ctx), etag: made.etag };
}

export async function getPin(ctx) {
  const g = await loadPin(ctx.params.id);
  const p = g.data;
  const [types, terr, users] = await Promise.all([loadPinTypes(), readIndex("territories", ""), readIndex("users", "")]);
  const names = new Map(users.rows.map((u) => [u.id, u.name]));
  const territories = terr.rows.filter((t) => t.act !== false && pointInPolygon([p.lng, p.lat], t.p)).map((t) => ({ id: t.id, name: t.n }));
  const out = pinView(p, ctx);
  out.knocks = (p.knocks || []).map((k) => ({ ...k, by_name: names.get(k.by) || "Someone" }));
  out.canvasser_name = names.get(p.canvasser_id) || "Someone";
  out.territories = territories;
  const type = types.find((t) => t.key === p.type_key);
  out.type = type || { key: p.type_key, label: p.type_label || "Pin", color: p.type_color || "#808080", outcome: p.outcome, active: false };
  out.can = { delete: canDelete(ctx, p), convert: !p.contact_id && ctx.can("leads:create") };
  if (p.contact_id && ctx.can("contacts:read_all")) {
    const c = await getRecord("contact", p.contact_id);
    if (c) out.contact = { id: c.data.merged_into || c.data.id, name: c.data.display_name || [c.data.first_name, c.data.last_name].filter(Boolean).join(" ") || "Lead" };
  }
  return { data: out, etag: g.etag };
}

// A same-day change by the same person corrects that knock; "knock" adds one.
export function applyKnock(p, type, { by, at, knock = false, note, unverified = false }) {
  const knocks = [...(p.knocks || [])];
  const last = knocks[knocks.length - 1];
  const entry = { at, by, type_key: type.key, outcome: type.outcome, ...(note ? { note: note.slice(0, 300) } : {}), ...(unverified ? { unverified: true } : {}) };
  if (!knock && last && last.by === by && localDate(new Date(last.at)) === localDate(new Date(at))) knocks[knocks.length - 1] = { ...last, type_key: type.key, outcome: type.outcome, ...(note ? { note: note.slice(0, 300) } : {}) };
  else if (knock || type.key !== p.type_key) knocks.push(entry);
  else return p;
  return { ...p, knocks: knocks.slice(-MAX_KNOCKS), type_key: type.key, type_label: type.label, type_color: type.color, outcome: type.outcome };
}

export async function updatePin(ctx) {
  const b = ctx.body || {};
  const client = clientOf(b);
  const cur = await loadPin(ctx.params.id);
  if ((cur.data.ops || []).includes(client)) return { data: pinView(cur.data, ctx), etag: cur.etag };
  const types = await loadPinTypes();
  const type = b.type_key !== undefined ? typeOf(types, str(b.type_key)) : b.knock ? typeOf(types, cur.data.type_key, { active: false }) : null;
  const time = timeOf(ctx);
  const address = b.address !== undefined ? (b.address === null ? null : cleanAddress(b.address) || null) : undefined;
  if (b.follow_up_on !== undefined && b.follow_up_on !== null && b.follow_up_on !== "" && !isLocalDate(b.follow_up_on)) throw new InputError("Use a date like 2026-11-17.", "follow_up_on");
  const r = await updateRecord("pin", cur.data.id, (p) => {
    if (p.deleted_at || (p.ops || []).includes(client)) return null;
    let next = { ...p, ops: [...(p.ops || []), client].slice(-MAX_OPS) };
    if (type) next = applyKnock(next, type, { by: ctx.user.id, at: time.at, knock: b.knock === true, unverified: time.trusted === false });
    if (b.note !== undefined) { const n = str(b.note).slice(0, 1000); if (n) next.note = n; else delete next.note; }
    if (b.follow_up_on !== undefined) { if (isLocalDate(b.follow_up_on)) next.follow_up_on = b.follow_up_on; else delete next.follow_up_on; }
    if (address !== undefined) { if (address) { next.address = address; next.address_source = b.address_source === "reverse" ? "reverse" : "typed"; } else { delete next.address; delete next.address_source; } }
    return next;
  }, ctx.write());
  return { data: pinView(r.data, ctx), etag: r.etag };
}

const canDelete = (ctx, p) => ctx.can("canvass:manage") || (p.canvasser_id === ctx.user.id && localDate(new Date(p.created_at)) === today() && !p.contact_id);
export async function deletePin(ctx) {
  const cur = await loadPin(ctx.params.id);
  if (!canDelete(ctx, cur.data)) throw new ForbiddenError(cur.data.contact_id ? "This pin is a lead now; it stays." : "Only the person who dropped it can delete it, on the day.");
  await softDelete("pin", cur.data.id, ctx.write());
  return { data: { deleted: true } };
}

// ------------------------------------------------------------ convert to lead

const INTAKE_ERRORS = { no_contact: ["Add a phone number or an email.", "phone"], invalid: ["Something in that doesn't look right.", null] };
export async function convertPin(ctx) {
  const b = ctx.body || {};
  clientOf(b);
  const cur = await loadPin(ctx.params.id);
  const p = cur.data;
  if (p.contact_id) return { data: { pin: pinView(p, ctx), already: true, ...(ctx.can("contacts:read_all") ? { contact_id: p.contact_id } : {}) } };
  if (!has("contacts.intake")) throw new ConflictError("Converting to a lead arrives with Contacts.");
  const address = cleanAddress(b.address) || p.address;
  if (!address || !address.street1) throw new InputError("Add the street address first.", "address.street1");
  const first = str(b.first_name).slice(0, 80);
  const last = str(b.last_name).slice(0, 80);
  if (!first && !last) throw new InputError("Add their name.", "first_name");
  const note = str(b.note || p.note).slice(0, 2000);
  const w = ctx.write();
  const r = await call("contacts.intake", {
    first_name: first, last_name: last, phone: str(b.phone), email: str(b.email), address: { ...address, state: address.state || "MN" },
    source: "Door to Door", tags: ["Door to door"], services: Array.isArray(b.services) ? b.services.slice(0, 10) : [],
    notes: note ? `At the door: ${note}` : "", consent: { sms_service: b.sms_consent === true }, owner_id: ctx.user.id,
  }, { origin: "app" }, { by: ctx.user.id, requestId: w.requestId, mode: await ctx.sysMode() });
  if (!r || !r.ok) {
    const [msg, field] = INTAKE_ERRORS[r && r.error] || ["That lead wasn't saved. Try again in a minute.", null];
    if (r && (r.error === "no_contact" || r.error === "invalid")) throw new InputError(msg, (r && r.field) || field || undefined);
    throw new ConflictError(msg);
  }
  // the pin's own map point on the property, when it has none yet (a person dropped it at the house)
  let propertyId = null;
  if (has("contacts.ensureProperty")) {
    try {
      propertyId = await call("contacts.ensureProperty", r.contact_id, { ...address, state: address.state || "MN" }, w);
      if (propertyId) {
        const area = await getSetting("service_area").catch(() => ({}));
        await updateRecord("property", propertyId, (pr) => {
          if (pr.geo) return null;
          const geo = { lat: p.lat, lng: p.lng, source: "pin", at: nowIso() };
          const tier = areaTier({ geo, city: pr.address && pr.address.city }, area);
          return { ...pr, geo, town_tier: tier.town_tier, ...(tier.distance_mi !== undefined ? { distance_mi: tier.distance_mi } : {}), geo_tried_at: nowIso() };
        }, w);
      }
    } catch (e) {
      console.error(`crm:map: the lead's property wasn't given the pin's map point (${safeErr(e)})`);
    }
  }
  const done = await updateRecord("pin", p.id, (x) => (x.contact_id ? null : {
    ...x, contact_id: r.contact_id, ...(propertyId ? { property_id: propertyId } : {}), converted_at: nowIso(), converted_by: ctx.user.id,
    ...(cleanAddress(b.address) ? { address: cleanAddress(b.address), address_source: "typed" } : {}),
  }), w);
  return {
    data: {
      pin: pinView(done.data, ctx), created: !!r.created, enrolled: !!r.enrollment_id,
      ...(ctx.can("contacts:read_all") ? { contact_id: r.contact_id } : {}),
    },
  };
}

// ------------------------------------------------------------ reverse geocoding

export async function reverse(ctx) {
  const lat = Number(ctx.query.get("lat"));
  const lng = Number(ctx.query.get("lng"));
  if (!Number.isFinite(lat) || !Number.isFinite(lng) || Math.abs(lat) > 90 || Math.abs(lng) > 180) throw new InputError("That isn't a place on the map.", "lat");
  return { data: await reverseGeocode({ lat, lng }, ctx) };
}

// ------------------------------------------------------------ the report

const weekStart = (d) => addLocalDays(d, -dowOfDate(d));
const blank = () => ({ doors: 0, conversations: 0, leads: 0, booked: 0 });

// rows: ix/pins rows; → { people, periods, territories, totals } for [from, to].
export function buildReport(rows, { from, to, group = "day", territories = [], users = [] } = {}) {
  const names = new Map(users.map((u) => [u.id, u.name]));
  const people = new Map();
  const periods = new Map();
  const terr = territories.map((t) => ({ id: t.id, name: t.n || t.name, poly: t.p || t.polygon, ...blank(), pins: 0 }));
  const totals = blank();
  const bump = (map, key, f, extra = {}) => { if (!map.has(key)) map.set(key, { ...extra, ...blank() }); map.get(key)[f] += 1; };
  const keyOf = (d) => (group === "week" ? weekStart(d) : d);
  for (const r of rows) {
    const inside = terr.filter((t) => pointInPolygon([r.ln, r.la], t.poly));
    let counted = false;
    for (const [d, by, o] of r.k || []) {
      if (d < from || d > to) continue;
      counted = true;
      const add = (f) => {
        totals[f] += 1;
        bump(people, by, f, { id: by, name: names.get(by) || "Someone" });
        bump(periods, keyOf(d), f, { key: keyOf(d) });
        for (const t of inside) t[f] += 1;
      };
      add("doors");
      if (CONVERSATIONS.has(o)) add("conversations");
      if (o === "booked") add("booked");
    }
    if (r.cv && r.cv >= from && r.cv <= to) {
      const by = r.cb || r.c;
      totals.leads += 1;
      bump(people, by, "leads", { id: by, name: names.get(by) || "Someone" });
      bump(periods, keyOf(r.cv), "leads", { key: keyOf(r.cv) });
      for (const t of inside) t.leads += 1;
      counted = true;
    }
    if (counted) for (const t of inside) t.pins += 1;
  }
  const order = (a, b) => b.doors - a.doors || b.leads - a.leads || b.booked - a.booked || String(a.name || a.key).localeCompare(String(b.name || b.key));
  return {
    from, to, group, totals,
    people: [...people.values()].sort(order),
    periods: [...periods.values()].sort((a, b) => a.key.localeCompare(b.key)),
    territories: terr.map(({ poly, ...t }) => t),
  };
}

export async function report(ctx) {
  const t = today();
  const to = isLocalDate(ctx.query.get("to")) ? ctx.query.get("to") : t;
  const from = isLocalDate(ctx.query.get("from")) ? ctx.query.get("from") : addLocalDays(to, -6);
  if (from > to) throw new InputError("The start is after the end.", "from");
  if ((Date.parse(to) - Date.parse(from)) / 86400000 > REPORT_DAYS) throw new InputError(`Pick at most ${REPORT_DAYS} days.`, "from");
  const group = ctx.query.get("group") === "week" ? "week" : "day";
  const tid = ctx.query.get("territory");
  const [rows, terr, users] = await Promise.all([pinRows(shardsFor(addLocalDays(from, -366), to).slice(-3)), readIndex("territories", ""), readIndex("users", "")]);
  const territories = terr.rows.filter((x) => x.act !== false && (!tid || x.id === tid));
  // a pin's shard is the year of its first knock, so a report also reads last year's shard
  const scoped = tid ? rows.filter((r) => territories.some((x) => pointInPolygon([r.ln, r.la], x.p))) : rows;
  const out = buildReport(scoped, { from, to, group, territories, users: users.rows });
  return { data: { ...out, today: t, generated_at: nowIso(), ...(tid ? { territory: tid } : {}) } };
}

