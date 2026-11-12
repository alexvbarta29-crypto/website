// Map module: record types (docs/CRM-MAP.md).
//
//   pin        a door on the door-to-door map: where (lat, lng), its pin
//              type (cfg/pin_types) and outcome, an optional note and
//              follow-up date, the address (filled by reverse geocoding,
//              editable), every knock at it (who, when, which type) and,
//              once converted, the lead it became. Its id derives from the
//              phone's client id, so a pin dropped with no signal and sent
//              twice is one pin. Index "pins/{yyyy}" (the year of its
//              first knock): what the map and the report read.
//   territory  a drawn polygon with a name, a color and the people it is
//              assigned to. Index "territories" (one blob). Pins count
//              toward a territory by where they are (point in polygon),
//              worked out when read, so redrawing one recounts at once.
//
// Both are the CRM's own records (Rotor had 0 pins and its pin types are
// settings): rotorFields are empty, nothing here ever goes to Rotor.
// Positions of the live team map are NOT records (team.mjs): they live
// under loc/ (never backed up, deleted after the retention days).

import { defineType } from "../../core/registry.mjs";
import { InputError } from "../../core/errors.mjs";
import { isId } from "../../core/ids.mjs";
import { localDate, isLocalDate, now } from "../../core/clock.mjs";
import { shape, str, enumValue, arr, isoTime, id as idOf, bool } from "../../core/validate.mjs";

const isObj = (v) => !!v && typeof v === "object" && !Array.isArray(v);

// What a knock came to. "Doors knocked" counts every knock; conversations
// are the knocks where someone answered.
export const OUTCOMES = Object.freeze(["not_home", "talked", "interested", "not_interested", "booked", "skip"]);
export const CONVERSATIONS = Object.freeze(new Set(["talked", "interested", "not_interested", "booked"]));
export const OUTCOME_LABELS = Object.freeze({
  not_home: "No answer", talked: "Talked (come back)", interested: "Interested", not_interested: "Not interested", booked: "Booked", skip: "Don't knock",
});

// A pin type's outcome when the owner hasn't set one: from its name.
export function inferOutcome(label) {
  const s = String(label || "").toLowerCase();
  if (/never|do not|don'?t knock|no solicit/.test(s)) return "skip";
  if (/not interested|no thanks/.test(s)) return "not_interested";
  if (/no answer|not home|nobody|no one/.test(s)) return "not_home";
  if (/sale|sold|booked|closed|signed/.test(s)) return "booked";
  if (/interested|quote|estimate/.test(s)) return "interested";
  return "talked";
}

// When cfg/pin_types is empty (a new install before the Rotor import):
// Barta's own set, in Rotor's colors.
export const DEFAULT_PIN_TYPES = Object.freeze([
  { key: "not_home", label: "Not home", color: "#808080", outcome: "not_home" },
  { key: "not_interested", label: "Not interested", color: "#e5484d", outcome: "not_interested" },
  { key: "interested", label: "Interested", color: "#d0b116", outcome: "interested" },
  { key: "come_back", label: "Come back", color: "#7c4dff", outcome: "talked" },
  { key: "booked", label: "Booked", color: "#03ad00", outcome: "booked" },
  { key: "renter", label: "Renter", color: "#2a78d6", outcome: "talked" },
  { key: "never_knock", label: "Never knock", color: "#16161b", outcome: "skip" },
].map((t) => Object.freeze({ ...t, active: true })));

export const TYPE_KEY_RE = /^[a-z0-9_-]{1,40}$/;
const slug = (s) => String(s || "").toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "").slice(0, 34) || "type";

// The pin types to use from cfg/pin_types ({ types: [...] }): each with a
// stable key (the saved one, else from Rotor's id, else from its name), a
// color and an outcome (the saved one, else from its name). Never empty.
export function pinTypesOf(setting) {
  const list = setting && Array.isArray(setting.types) ? setting.types.filter((t) => t && t.label) : [];
  if (!list.length) return DEFAULT_PIN_TYPES.map((t) => ({ ...t }));
  const seen = new Set();
  const out = [];
  for (const t of list) {
    let key = typeof t.key === "string" && TYPE_KEY_RE.test(t.key) ? t.key : t.rotor_id ? "r_" + slug(t.rotor_id).slice(0, 36) : "l_" + slug(t.label);
    while (seen.has(key)) key = key.slice(0, 36) + "_" + (seen.size % 10);
    seen.add(key);
    out.push({
      key, label: String(t.label).slice(0, 40), color: /^#[0-9a-f]{3,8}$/i.test(String(t.color || "")) ? t.color : "#808080",
      outcome: OUTCOMES.includes(t.outcome) ? t.outcome : inferOutcome(t.label), active: t.active !== false, ...(t.rotor_id ? { rotor_id: t.rotor_id } : {}),
    });
  }
  return out;
}

// ------------------------------------------------------------ pin

const lat = (v, f) => { if (typeof v !== "number" || !Number.isFinite(v) || Math.abs(v) > 90) throw new InputError("That isn't a place on the map.", f); return Math.round(v * 1e6) / 1e6; };
const lng = (v, f) => { if (typeof v !== "number" || !Number.isFinite(v) || Math.abs(v) > 180) throw new InputError("That isn't a place on the map.", f); return Math.round(v * 1e6) / 1e6; };
const color = (v, f) => { const s = str(v, { field: f, max: 9 }); if (s && !/^#[0-9a-f]{3,8}$/i.test(s)) throw new InputError("That isn't a color.", f); return s || undefined; };
const typeKey = (v, f) => { const s = str(v, { field: f, max: 40, required: true }); if (!TYPE_KEY_RE.test(s)) throw new InputError("That isn't a pin type.", f); return s; };
const optDate = (v, f) => { if (v === undefined || v === null || v === "") return undefined; if (!isLocalDate(v)) throw new InputError("Use a date like 2026-11-17.", f); return v; };
export const CLIENT_RE = /^[A-Za-z0-9-]{8,64}$/;
const clientId = (v, f) => { if (v === undefined || v === null || v === "") return undefined; if (typeof v !== "string" || !CLIENT_RE.test(v)) throw new InputError("That isn't a client id.", f); return v.toLowerCase(); };

export function cleanAddress(v, f = "address") {
  if (v === undefined || v === null) return undefined;
  if (!isObj(v)) throw new InputError("Expected an address.", f);
  const out = {};
  for (const k of ["street1", "city", "state", "zip"]) {
    const s = str(v[k], { field: `${f}.${k}`, max: k === "street1" ? 120 : k === "city" ? 60 : 12 });
    if (s) out[k] = s;
  }
  return Object.keys(out).length ? out : undefined;
}

export const MAX_KNOCKS = 60;
export const MAX_OPS = 40;
function validateKnock(v, f) {
  if (!isObj(v)) throw new InputError("Expected a knock.", f);
  return {
    at: isoTime(v.at, { field: `${f}.at`, required: true }),
    by: idOf(v.by, "user", { field: `${f}.by`, required: true }),
    type_key: typeKey(v.type_key, `${f}.type_key`),
    outcome: enumValue(v.outcome, OUTCOMES, { field: `${f}.outcome`, required: true, stored: true }),
    ...(v.note ? { note: str(v.note, { field: `${f}.note`, max: 300 }) } : {}),
    ...(v.unverified ? { unverified: true } : {}),
  };
}

function validatePin(data, { op, before } = {}) {
  const stored = op === "update";
  const out = shape(data, {
    // where a pin is never moves (a wrong tap is deleted and dropped again)
    lat: (v, f) => (stored && before ? before.lat : lat(v, f)),
    lng: (v, f) => (stored && before ? before.lng : lng(v, f)),
    type_key: typeKey,
    type_label: (v, f) => str(v, { field: f, max: 40 }) || undefined,
    type_color: color,
    outcome: (v, f) => enumValue(v, OUTCOMES, { field: f, required: true, stored }),
    note: (v, f) => str(v, { field: f, max: 1000, trim: false }) || undefined,
    follow_up_on: optDate,
    address: cleanAddress,
    address_source: (v, f) => enumValue(v, ["reverse", "typed"], { field: f, stored }),
    knocks: (v, f) => { const k = arr(v, validateKnock, { field: f, max: MAX_KNOCKS + 5 }); if (!k.length) throw new InputError("A pin is a knock.", f); return k.slice(-MAX_KNOCKS); },
    canvasser_id: (v, f) => idOf(v, "user", { field: f, required: true }),
    contact_id: (v, f) => idOf(v, "contact", { field: f }),
    property_id: (v, f) => idOf(v, "property", { field: f }),
    converted_at: (v, f) => isoTime(v, { field: f }),
    converted_by: (v, f) => idOf(v, "user", { field: f }),
    client_id: clientId,
    ops: (v, f) => arr(v, (x, ff) => clientId(x, ff), { field: f, max: MAX_OPS + 5 }).filter(Boolean).slice(-MAX_OPS),
  });
  for (const k of Object.keys(out)) if (out[k] === undefined) delete out[k];
  return out;
}

const knockDate = (k) => localDate(new Date(k.at));
// The year of the pin's first knock (its index shard).
export const pinShard = (r) => (r && Array.isArray(r.knocks) && r.knocks[0] ? knockDate(r.knocks[0]) : localDate(r.created_at ? new Date(r.created_at) : now())).slice(0, 4);
// Short keys keep the blob small (§3.5): no notes, no address.
export const pinRow = (r) => ({
  la: r.lat, ln: r.lng, t: r.type_key, o: r.outcome, c: r.canvasser_id,
  k: (r.knocks || []).map((k) => [knockDate(k), k.by, k.outcome]),
  ...(r.follow_up_on ? { fu: r.follow_up_on } : {}),
  ...(r.contact_id ? { cv: localDate(new Date(r.converted_at || r.updated_at)), cb: r.converted_by || r.canvasser_id } : {}),
  u: r.updated_at,
});

export const PIN_TECH_FIELDS = Object.freeze(["id", "type", "v", "wv", "lat", "lng", "type_key", "type_label", "type_color", "outcome", "note", "follow_up_on",
  "address", "address_source", "knocks", "canvasser_id", "converted_at", "created_at", "updated_at"]);

export const pinType = defineType({
  type: "pin",
  prefix: "pn",
  v: 1,
  validate: validatePin,
  rotorFields: [],
  techFields: [...PIN_TECH_FIELDS],
  readPerm: "canvass:use",
  indexes: [{ name: "pins", shard: pinShard, row: pinRow }],
  summary: (r) => ({ id: r.id, type_key: r.type_key, outcome: r.outcome }),
  example: () => ({
    lat: 45.0419, lng: -93.7891, type_key: "not_home", type_label: "Not home", type_color: "#808080", outcome: "not_home",
    knocks: [{ at: "2026-11-17T15:00:00.000Z", by: "us_00000000000000000000", type_key: "not_home", outcome: "not_home" }],
    canvasser_id: "us_00000000000000000000", address: { street1: "100 Example Ave", city: "Delano", state: "MN", zip: "55328" }, address_source: "typed",
  }),
});

// ------------------------------------------------------------ territory

export const MAX_POLYGON = 100;
function validatePolygon(v, f) {
  if (!Array.isArray(v)) throw new InputError("Draw the area on the map.", f);
  const pts = v.map((p, i) => {
    if (!Array.isArray(p) || p.length !== 2) throw new InputError("That isn't a point.", `${f}.${i}`);
    return [lng(p[0], `${f}.${i}`), lat(p[1], `${f}.${i}`)];
  });
  // a closed ring's last point repeats the first: keep it open
  if (pts.length > 1 && pts[0][0] === pts[pts.length - 1][0] && pts[0][1] === pts[pts.length - 1][1]) pts.pop();
  if (pts.length < 3) throw new InputError("An area needs at least 3 corners.", f);
  if (pts.length > MAX_POLYGON) throw new InputError(`Keep an area under ${MAX_POLYGON} corners.`, f);
  return pts;
}

function validateTerritory(data, { op } = {}) {
  const stored = op === "update";
  const out = shape(data, {
    name: (v, f) => str(v, { field: f, max: 60, required: true }),
    color: (v, f) => color(v, f) || "#fb4d3d",
    polygon: validatePolygon,
    assignee_ids: (v, f) => [...new Set(arr(v, (x, ff) => idOf(x, "user", { field: ff, required: true }), { field: f, max: 10 }))],
    active: (v, f) => (v === undefined ? true : bool(v, { field: f })),
    notes: (v, f) => str(v, { field: f, max: 500, trim: false }) || undefined,
  });
  if (stored && out.name === "") throw new InputError("Give the area a name.", "name");
  for (const k of Object.keys(out)) if (out[k] === undefined) delete out[k];
  return out;
}

export const territoryRow = (r) => ({ n: r.name, col: r.color, p: r.polygon, a: r.assignee_ids || [], act: r.active !== false, u: r.updated_at });

export const territoryType = defineType({
  type: "territory",
  prefix: "tr",
  v: 1,
  validate: validateTerritory,
  rotorFields: [],
  techFields: ["id", "type", "v", "wv", "name", "color", "polygon", "assignee_ids", "active", "created_at", "updated_at"],
  readPerm: "canvass:use",
  indexes: [{ name: "territories", shard: () => "", row: territoryRow }],
  summary: (r) => ({ id: r.id, name: r.name }),
  example: () => ({
    name: "Example blocks", color: "#2a78d6", assignee_ids: [], active: true,
    polygon: [[-93.80, 45.03], [-93.78, 45.03], [-93.78, 45.05], [-93.80, 45.05]],
  }),
});

export const isPinId = (v) => isId(v, "pin");
export const isTerritoryId = (v) => isId(v, "territory");
