// Record types of the contacts module: contact, property, merge_candidate
// (design §3.3, §5.1). Each is a defineType() object with rotorFields,
// techFields and example() (§3.14).
//
// The Contact record holds only what people edit; everything the system
// keeps up to date lives in the contact_stats sidecar (core, §5.1). Rules
// the validators keep (§3.14 schema rules): unknown fields are kept, an enum
// value this code doesn't know is kept when it was already stored, and a
// stored phone or address that today's rules would refuse (an imported
// oddity) is kept as it was rather than blocking an unrelated edit.
//
// Keys never hold personal data (§3.2): phones and emails are looked up
// through ptr/phone/{hk} and ptr/email/{hk} (lookup lists the store keeps
// in step with the record), and a merged contact leaves both lists.

import { defineType } from "../../core/registry.mjs";
import { hk } from "../../../crm-store.mjs";
import { isId } from "../../core/ids.mjs";
import { tsKey, nowIso } from "../../core/clock.mjs";
import { InputError } from "../../core/errors.mjs";
import { shape, str, notes as notesText, enumValue, bool, arr, isoTime, int } from "../../core/validate.mjs";
import { contactShard } from "../../core/stats.mjs";
import { displayName, normalizePhone, normalizeEmail, phoneDigits, normalizeAddress, addressOneLine } from "./display.mjs";

export const KINDS = Object.freeze(["person", "business"]);
export const LIFECYCLES = Object.freeze(["lead", "customer", "former_customer", "archived"]);
export const ARCHIVED_REASONS = Object.freeze(["spam", "test", "vendor", "duplicate", "out_of_area", "do_not_contact", "other"]);
export const PHONE_LABELS = Object.freeze(["mobile", "home", "work", "other"]);
export const EMAIL_LABELS = Object.freeze(["personal", "work", "billing", "other"]);
export const CONSENT_CHANNELS = Object.freeze(["sms_service", "sms_marketing", "email_marketing"]);
export const CONSENT_STATES = Object.freeze(["granted", "unknown", "revoked"]);
export const CONSENT_SOURCES = Object.freeze(["website_form", "giveaway_optin", "verbal", "import", "keyword", "portal", "manual"]);
export const FLAG_KEYS = Object.freeze(["test", "spam", "vendor", "do_not_service", "vip", "placeholder"]);
export const TOWN_TIERS = Object.freeze(["primary", "extended", "outside", "unknown"]);
export const MAX_PHONES = 10;
export const MAX_EMAILS = 10;
export const MAX_TAGS = 30;

// The seed source list (§5.1); cfg/company.sources may replace it.
export const SOURCES = Object.freeze([
  "Website quote form", "Website", "Meta Ads", "Holiday Lights Giveaway", "Referral", "Returning Customer", "Facebook",
  "Facebook Messenger", "Google", "Family / Friends", "Door to Door", "Door Hanger", "Signage", "Yard Sign", "Cold Call",
  "Phone Call", "Email", "Parade", "Inbound text", "Map Pin", "Other",
]);
// The website's "how did you hear about us" answers (Source.channel).
export const CHANNELS = Object.freeze(["Facebook", "Instagram", "Google", "TikTok", "Family/Friend", "Yard Sign", "BARTA Van", "Postcard/Door Hanger", "Other"]);

const isObj = (v) => !!v && typeof v === "object" && !Array.isArray(v);
const clone = (v) => (v === undefined ? undefined : JSON.parse(JSON.stringify(v)));

// ------------------------------------------------------------ parts

// A phone entry. On an update a stored number today's rules would refuse is
// kept as it was (it came from an import or older code).
function phoneEntry(v, f, storedSet) {
  if (!isObj(v)) throw new InputError("Expected a phone number.", f);
  const raw = v.e164 ?? v.number ?? v.phone;
  const n = normalizePhone(raw);
  let e164 = n.e164;
  if (!e164) {
    if (storedSet && typeof raw === "string" && storedSet.has(raw)) e164 = raw;
    else throw new InputError("That phone number doesn't look right.", f);
  }
  return {
    ...v, e164,
    label: enumValue(v.label, PHONE_LABELS, { field: `${f}.label`, stored: true }) || "mobile",
    primary: v.primary === true,
    sms: v.sms === undefined ? true : bool(v.sms, { field: `${f}.sms` }),
  };
}

function emailEntry(v, f, storedSet) {
  if (!isObj(v)) throw new InputError("Expected an email address.", f);
  const raw = v.address ?? v.email;
  let address = normalizeEmail(raw);
  if (!address) {
    if (storedSet && typeof raw === "string" && storedSet.has(raw)) address = raw;
    else throw new InputError("That email doesn't look right.", f);
  }
  return { ...v, address, label: enumValue(v.label, EMAIL_LABELS, { field: `${f}.label`, stored: true }) || "personal", primary: v.primary === true };
}

// One primary, first if none is marked; duplicates (same number/address) dropped.
function onePrimary(list, keyOf) {
  const seen = new Set();
  const out = [];
  for (const x of list) { const k = keyOf(x); if (seen.has(k)) continue; seen.add(k); out.push(x); }
  const p = out.findIndex((x) => x.primary);
  return out.map((x, i) => ({ ...x, primary: p >= 0 ? i === p : i === 0 }));
}

// Spellings other sources use for the same parts (normalizeAddress reads them; they are not kept).
const ADDRESS_ALIASES = ["street", "line1", "line2", "address_street1", "address_street2", "address_city", "address_state", "address_zip", "zip_code", "postal_code"];

export function validateAddress(v, f, { stored = null, required = false } = {}) {
  if (v === undefined || v === null || v === "") {
    if (required) throw new InputError("Add an address.", f);
    return undefined;
  }
  if (!isObj(v)) throw new InputError("Expected an address.", f);
  if (stored && JSON.stringify(v) === JSON.stringify(stored)) return clone(stored);
  const a = normalizeAddress(v);
  if (!a) {
    if (required) throw new InputError("Add an address.", f);
    return undefined;
  }
  if (!/^[A-Z]{2}$/.test(a.state)) throw new InputError("Use the two-letter state, like MN.", `${f}.state`);
  if (a.zip && !/^\d{5}(-\d{4})?$/.test(a.zip)) throw new InputError("Use a 5-digit ZIP code.", `${f}.zip`);
  const rest = { ...v };
  for (const k of ADDRESS_ALIASES) delete rest[k];
  delete rest.street2;
  return { ...rest, ...a };
}

function consentState(v, f) {
  if (v === undefined || v === null) return { state: "unknown" };
  if (!isObj(v)) throw new InputError("Expected a consent state.", f);
  const out = { ...v, state: enumValue(v.state, CONSENT_STATES, { field: `${f}.state`, stored: true }) || "unknown" };
  if (v.at !== undefined) out.at = isoTime(v.at, { field: `${f}.at` });
  if (v.source !== undefined) out.source = enumValue(v.source, CONSENT_SOURCES, { field: `${f}.source`, stored: true });
  if (v.by !== undefined) out.by = str(v.by, { field: `${f}.by`, max: 80 });
  for (const k of Object.keys(out)) if (out[k] === undefined) delete out[k];
  return out;
}

function validateConsent(v, f) {
  const c = isObj(v) ? v : {};
  if (v !== undefined && v !== null && !isObj(v)) throw new InputError("Expected consent.", f);
  const out = { ...c };
  for (const ch of CONSENT_CHANNELS) out[ch] = consentState(c[ch], `${f}.${ch}`);
  return out;
}

function validateSource(v, f, { create }) {
  if (v === undefined || v === null || v === "") {
    if (!create) return undefined;
    return { source: "Other", captured_at: nowIso() };
  }
  if (typeof v === "string") v = { source: v };
  if (!isObj(v)) throw new InputError("Pick where they came from.", f);
  const out = { ...v, source: str(v.source, { field: `${f}.source`, max: 60 }) || "Other" };
  for (const k of ["channel", "form", "ad", "county", "campaign", "promo_code", "landing_page", "referral_code"]) {
    if (v[k] !== undefined && v[k] !== null) out[k] = str(v[k], { field: `${f}.${k}`, max: 120 }) || undefined;
  }
  if (v.referrer_contact_id !== undefined && v.referrer_contact_id !== null && v.referrer_contact_id !== "") {
    if (!isId(v.referrer_contact_id, "contact")) throw new InputError("That isn't a contact.", `${f}.referrer_contact_id`);
  }
  if (v.raw !== undefined && v.raw !== null) out.raw = str(v.raw, { field: `${f}.raw`, max: 2000, trim: false });
  out.captured_at = v.captured_at ? isoTime(v.captured_at, { field: `${f}.captured_at` }) : nowIso();
  for (const k of Object.keys(out)) if (out[k] === undefined) delete out[k];
  return out;
}

// Tags: trimmed, at most 40 characters each and 30 in all, no repeats (case-insensitive; the first spelling wins).
export function cleanTags(v, f = "tags") {
  const list = arr(v, (x, ff) => str(x, { field: ff, max: 40 }), { field: f, max: 200 }).filter(Boolean);
  const seen = new Set();
  const out = [];
  for (const t of list) { const k = t.toLowerCase(); if (!seen.has(k)) { seen.add(k); out.push(t); } }
  if (out.length > MAX_TAGS) throw new InputError(`Keep it to ${MAX_TAGS} tags.`, f);
  return out;
}

function validateFlags(v, f) {
  if (v === undefined || v === null) return {};
  if (!isObj(v)) throw new InputError("Expected flags.", f);
  const out = { ...v };
  for (const k of FLAG_KEYS) {
    if (out[k] === undefined) continue;
    if (bool(out[k], { field: `${f}.${k}` })) out[k] = true; else delete out[k];
  }
  return out;
}

function validatePaused(v, f) {
  if (v === undefined || v === null) return undefined;
  if (!isObj(v)) throw new InputError("Expected paused channels.", f);
  const out = { ...v };
  for (const ch of ["sms", "email"]) {
    if (out[ch] === undefined || out[ch] === null) { delete out[ch]; continue; }
    if (!isObj(out[ch])) throw new InputError("Expected a reason.", `${f}.${ch}`);
    out[ch] = { ...out[ch], reason: str(out[ch].reason, { field: `${f}.${ch}.reason`, max: 200 }), by: str(out[ch].by, { field: `${f}.${ch}.by`, max: 80 }), at: isoTime(out[ch].at, { field: `${f}.${ch}.at` }) || nowIso() };
  }
  return Object.keys(out).length ? out : undefined;
}

const userId = (v, f) => {
  if (v === undefined || v === null || v === "") return undefined;
  if (!isId(v, "user")) throw new InputError("That isn't someone on the team.", f);
  return v;
};
const contactId = (v, f) => {
  if (v === undefined || v === null || v === "") return undefined;
  if (!isId(v, "contact")) throw new InputError("That isn't a contact.", f);
  return v;
};

// ------------------------------------------------------------ contact

export function validateContact(data, { op, before } = {}) {
  const stored = op === "update";
  const create = op === "create";
  const storedPhones = new Set((before && Array.isArray(before.phones) ? before.phones : []).map((p) => p && p.e164).filter(Boolean));
  const storedEmails = new Set((before && Array.isArray(before.emails) ? before.emails : []).map((e) => e && e.address).filter(Boolean));
  const out = shape(data, {
    kind: (v, f) => enumValue(v, KINDS, { field: f, stored }),
    first_name: (v, f) => str(v, { field: f, max: 80 }),
    last_name: (v, f) => str(v, { field: f, max: 80 }),
    company_name: (v, f) => str(v, { field: f, max: 120 }),
    phones: (v, f) => onePrimary(arr(v, (x, ff) => phoneEntry(x, ff, storedPhones), { field: f, max: MAX_PHONES }), (p) => p.e164),
    emails: (v, f) => onePrimary(arr(v, (x, ff) => emailEntry(x, ff, storedEmails), { field: f, max: MAX_EMAILS }), (e) => e.address),
    lifecycle: (v, f) => enumValue(v, LIFECYCLES, { field: f, stored }) || "lead",
    lifecycle_at: (v, f) => isoTime(v, { field: f }),
    archived_reason: (v, f) => enumValue(v, ARCHIVED_REASONS, { field: f, stored }),
    owner_id: (v, f) => userId(v, f),
    watcher_ids: (v, f) => [...new Set(arr(v, (x, ff) => userId(x, ff), { field: f, max: 20 }).filter(Boolean))],
    source: (v, f) => validateSource(v, f, { create }),
    tags: (v, f) => cleanTags(v, f),
    notes: (v, f) => notesText(v, { field: f }),
    billing_address: (v, f) => validateAddress(v, f, { stored: before && before.billing_address }),
    primary_property_id: (v, f) => {
      if (v === undefined || v === null || v === "") return undefined;
      if (!isId(v, "property")) throw new InputError("That isn't a property.", f);
      return v;
    },
    consent: (v, f) => validateConsent(v, f),
    automations_paused: (v, f) => validatePaused(v, f),
    flags: (v, f) => validateFlags(v, f),
    merging_into: (v, f) => contactId(v, f),
    merged_into: (v, f) => contactId(v, f),
  });
  if (!out.kind) out.kind = !out.first_name && !out.last_name && out.company_name ? "business" : "person";
  out.display_name = displayName(out);
  if (create && !out.first_name && !out.last_name && !out.company_name && !(out.phones && out.phones.length) && !(out.emails && out.emails.length)) {
    throw new InputError("Add a name, a phone or an email.", "first_name");
  }
  if (out.lifecycle === "archived" && !out.archived_reason && !stored) out.archived_reason = "other";
  if (out.lifecycle !== "archived" && out.archived_reason && !stored) delete out.archived_reason;
  if (!out.lifecycle_at) out.lifecycle_at = before && before.lifecycle === out.lifecycle && before.lifecycle_at ? before.lifecycle_at : nowIso();
  if (before && before.lifecycle !== out.lifecycle) out.lifecycle_at = nowIso();
  if (out.id && out.merged_into === out.id) throw new InputError("A contact can't be merged into itself.", "merged_into");
  return out;
}

// The contacts index row's contact part (§3.5). Short keys keep the blob
// small; values (not keys), so phones and emails may appear like in the
// record. Never notes.
export function contactRow(r) {
  const a = r.billing_address || null;
  const fl = Object.fromEntries(Object.entries(r.flags || {}).filter(([, v]) => v === true));
  return {
    n: r.display_name || displayName(r), f: r.first_name || "", l: r.last_name || "", co: r.company_name || "",
    p: (r.phones || []).map((p) => phoneDigits(p.e164)).filter(Boolean),
    e: (r.emails || []).map((e) => e.address).filter(Boolean),
    a: a ? addressOneLine({ street1: a.street1, city: a.city }) : "", c: a ? a.city || "" : "", z: a ? a.zip || "" : "",
    lc: r.lifecycle || "lead", src: (r.source && r.source.source) || "", tg: r.tags || [], o: r.owner_id || null,
    // when the contact came in (Rotor's date for an imported one): the reports' leads and customers by source (M7b)
    ca: r.created_at || null,
    ...(Object.keys(fl).length ? { fl } : {}), u: r.updated_at,
  };
}

// Phone and email lookups (§3.7): one hk per address; a merged or deleted
// contact leaves them (its survivor holds them).
const lookupKeys = (r, kind) => {
  if (r.merged_into || r.deleted_at) return [];
  const out = [];
  if (kind === "phone") for (const p of r.phones || []) { try { out.push(hk("phone", p.e164)); } catch { /* an oddity kept from an import */ } }
  else for (const e of r.emails || []) { try { out.push(hk("email", e.address)); } catch { /* ditto */ } }
  return [...new Set(out)];
};

export const contactType = defineType({
  type: "contact",
  prefix: "ct",
  v: 1,
  validate: validateContact,
  rotorFields: ["kind", "first_name", "last_name", "company_name", "phones", "emails", "billing_address", "source", "tags", "notes",
    "owner_id", "watcher_ids", "lifecycle", "archived_reason", "flags.vendor", "rotor"],
  techFields: ["id", "display_name", "phones", "first_name"],
  readPerm: "contacts:read",
  indexes: [{ name: "contacts", part: "contact", shard: () => contactShard("ct_00000000000000000000"), row: contactRow }],
  pointers: [
    { kind: "phone", list: true, keys: (r) => lookupKeys(r, "phone") },
    { kind: "email", list: true, keys: (r) => lookupKeys(r, "email") },
  ],
  summary: (r) => ({ id: r.id, name: r.display_name, town: (r.billing_address && r.billing_address.city) || "" }),
  example: () => ({
    kind: "person", first_name: "Pat", last_name: "Example", company_name: "",
    phones: [{ e164: "+17635550100", label: "mobile", primary: true, sms: true }],
    emails: [{ address: "pat.example@example.com", label: "personal", primary: true }],
    lifecycle: "lead", source: { source: "Website quote form", captured_at: "2026-11-17T15:00:00.000Z" }, tags: ["Website"], notes: "",
    billing_address: { street1: "100 Example Ave", city: "Delano", state: "MN", zip: "55328", country: "US" },
    consent: { sms_service: { state: "granted", source: "website_form" }, sms_marketing: { state: "unknown" }, email_marketing: { state: "unknown" } },
    flags: {}, watcher_ids: [],
  }),
});

// ------------------------------------------------------------ property

const ASSET_KEYS = ["sqft", "panes_ext", "panes_int", "screens", "tracks", "stories", "french_panes", "gutter_ft", "downspouts", "roofline_ft"];

function validateProperty(data, { op, before } = {}) {
  const stored = op === "update";
  const out = shape(data, {
    contact_id: (v, f) => {
      if (!isId(v, "contact")) throw new InputError("A property belongs to a contact.", f);
      return v;
    },
    label: (v, f) => str(v, { field: f, max: 40 }) || "Home",
    address: (v, f) => validateAddress(v, f, { stored: before && before.address, required: true }),
    geo: (v, f) => {
      if (v === undefined || v === null) return undefined;
      if (!isObj(v) || !Number.isFinite(v.lat) || !Number.isFinite(v.lng) || Math.abs(v.lat) > 90 || Math.abs(v.lng) > 180) throw new InputError("That isn't a map point.", f);
      // census: the batch geocoder; pin: a door-to-door pin dropped at the house (docs/CRM-MAP.md)
      return { ...v, source: enumValue(v.source, ["google", "manual", "census", "pin"], { field: `${f}.source`, stored: true }) || "manual", at: isoTime(v.at, { field: `${f}.at` }) || nowIso() };
    },
    county: (v, f) => str(v, { field: f, max: 60 }) || undefined,
    town_tier: (v, f) => enumValue(v, TOWN_TIERS, { field: f, stored }) || "unknown",
    distance_mi: (v, f) => {
      if (v === undefined || v === null) return undefined;
      if (typeof v !== "number" || !Number.isFinite(v) || v < 0 || v > 5000) throw new InputError("That isn't a distance.", f);
      return v;
    },
    access: (v, f) => {
      const a = isObj(v) ? { ...v } : {};
      if (v !== undefined && v !== null && !isObj(v)) throw new InputError("Expected access notes.", f);
      for (const k of ["gate_code", "pets", "parking"]) if (a[k] !== undefined) a[k] = str(a[k], { field: `${f}.${k}`, max: 200 }) || undefined;
      if (a.notes !== undefined) a.notes = str(a.notes, { field: `${f}.notes`, max: 2000, trim: false }) || undefined;
      if (a.interior_ok !== undefined && a.interior_ok !== null) a.interior_ok = bool(a.interior_ok, { field: `${f}.interior_ok` });
      for (const k of Object.keys(a)) if (a[k] === undefined || a[k] === null) delete a[k];
      return a;
    },
    assets: (v, f) => {
      const a = isObj(v) ? { ...v } : {};
      if (v !== undefined && v !== null && !isObj(v)) throw new InputError("Expected counts.", f);
      for (const k of ASSET_KEYS) if (a[k] !== undefined) a[k] = int(a[k], { field: `${f}.${k}`, min: 0, max: 100000 });
      if (a.notes !== undefined) a.notes = str(a.notes, { field: `${f}.notes`, max: 2000, trim: false }) || undefined;
      for (const k of Object.keys(a)) if (a[k] === undefined || a[k] === null) delete a[k];
      return a;
    },
    photo_ids: (v, f) => arr(v, (x, ff) => { if (!isId(x, "file")) throw new InputError("That isn't a photo.", ff); return x; }, { field: f, max: 200 }),
  });
  return out;
}

export const propertyRow = (r) => ({ c: r.contact_id, lb: r.label, a: addressOneLine(r.address) });
// Every property with a map point (the door-to-door map's customers and leads, docs/CRM-MAP.md): one blob.
export const placeShard = (r) => (r && r.geo && Number.isFinite(r.geo.lat) && Number.isFinite(r.geo.lng) ? "" : null);
export const placeRow = (r) => ({ c: r.contact_id, la: Math.round(r.geo.lat * 1e6) / 1e6, ln: Math.round(r.geo.lng * 1e6) / 1e6, a: addressOneLine({ street1: r.address && r.address.street1, city: r.address && r.address.city }) });

export const propertyType = defineType({
  type: "property",
  prefix: "pr",
  v: 1,
  validate: validateProperty,
  rotorFields: ["label", "address", "rotor"],
  techFields: ["id", "contact_id", "label", "address", "geo", "access", "assets", "lights", "photo_ids", "town_tier"],
  readPerm: "contacts:read",
  indexes: [{ name: "places", shard: placeShard, row: placeRow }],
  rels: [
    { rel: "contact-properties", parent: (r) => r.contact_id, sort: (r) => tsKey(new Date(Date.parse(r.created_at) || 0)) },
    // properties still waiting for a map point: the contacts.geocode sweep walks these (§7.6)
    { rel: "geo-pending", parent: (r) => (!r.geo && r.address && !r.geo_tried_at && !r.deleted_at ? "all" : null), sort: (r) => tsKey(new Date(Date.parse(r.created_at) || 0)) },
  ],
  summary: (r) => ({ id: r.id, label: r.label, town: (r.address && r.address.city) || "" }),
  example: () => ({
    contact_id: "ct_0000000000000000000a", label: "Home",
    address: { street1: "100 Example Ave", city: "Delano", state: "MN", zip: "55328", country: "US" },
    town_tier: "unknown", access: {}, assets: {}, photo_ids: [],
  }),
});

// ------------------------------------------------------------ merge candidate

export const MERGE_REASONS = Object.freeze(["phone", "email", "name", "name_zip"]);
export const CONFIDENCES = Object.freeze(["high", "medium", "low"]);
export const MERGE_STATUSES = Object.freeze(["pending", "merged", "dismissed"]);
export const pairKey = (a, b) => [a, b].sort().join("--");

function validateCandidate(data, { op } = {}) {
  const stored = op === "update";
  const out = shape(data, {
    a: (v, f) => { if (!isId(v, "contact")) throw new InputError("Pick two contacts.", f); return v; },
    b: (v, f) => { if (!isId(v, "contact")) throw new InputError("Pick two contacts.", f); return v; },
    reason: (v, f) => enumValue(v, MERGE_REASONS, { field: f, required: true, stored }),
    confidence: (v, f) => enumValue(v, CONFIDENCES, { field: f, required: true, stored }),
    status: (v, f) => enumValue(v, MERGE_STATUSES, { field: f, stored }) || "pending",
    decided_by: (v, f) => str(v, { field: f, max: 80 }) || undefined,
    decided_at: (v, f) => isoTime(v, { field: f }),
    note: (v, f) => str(v, { field: f, max: 500 }) || undefined,
  });
  if (out.a === out.b) throw new InputError("Those are the same contact.", "b");
  return out;
}

const confRank = { high: 0, medium: 1, low: 2 };
export const candidateRow = (r) => ({ a: r.a, b: r.b, r: r.reason, cf: r.confidence, st: r.status, at: r.created_at, k: confRank[r.confidence] ?? 3 });

export const mergeCandidateType = defineType({
  type: "merge_candidate",
  prefix: "mc",
  v: 1,
  validate: validateCandidate,
  rotorFields: [],
  techFields: ["id"],
  readPerm: "contacts:merge",
  shadow: false,
  indexes: [{ name: "merge-candidates", shard: () => "", row: candidateRow }],
  // one candidate per pair, ever: a dismissal is remembered across import re-runs (§10.4)
  pointers: [{ kind: "merge-pair", key: (r) => pairKey(r.a, r.b) }],
  example: () => ({ a: "ct_0000000000000000000a", b: "ct_0000000000000000000b", reason: "phone", confidence: "high", status: "pending" }),
});

export const types = [contactType, propertyType, mergeCandidateType];
