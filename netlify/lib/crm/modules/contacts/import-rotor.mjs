// Contacts module: the Rotor import phases (design §10.1 contract, §10.2
// rows 6-12 and 36, §10.3 identity resolution). The framework (staging,
// the phase runner on the bulk lane, field ownership and the three-way
// merge, the report) is M2c's; these phases only map rows.
//
//   phase = { name, entity, after, normalize(row) → row (throws RowError),
//             map(row, ctx) → Promise<Output> }
//   ctx   = { runId, idForRotor, lookup(type, rotorId) → crmId | null, users: Map, settings, report }
//
// Output (the §10.1 contract plus the extras rows 7, 8, 12 and 36 need):
//   records          [{ type, data }]       full mapped records: the runner writes them with field ownership
//   pointers         [{ kind, key, value }] unique pointers (ptr/rotor/customer/{rid} ...), claimed onlyIfNew
//   mergeCandidates  [{ a, b, reason, confidence }]
//   patches          [{ type, id, fill?, add?, set?, only_if? }]   fill: set where empty; add: union into a
//                                                        list (dotted path); set: CRM-owned fields (consent ...);
//                                                        only_if guards `set` alone (a guarded grant is its own patch)
//   stats            [{ contact_id, part, merge }]       a stats part, merged (the money/comms parts)
//   suppressions     [{ channel, address_hk, state, source, masked }]  written before any comms phase
//   warnings         ["phone_twelve_digits", ...]       for the report, never a value
// applyExtras(output, ctx) writes the patches, stats, suppressions and
// merge candidates (M2c may call it; the tests do).
//
// Row 11 (the tag catalog) is derived, not imported: tagCatalog() builds it
// from the contacts index when a screen needs it (see docs/CRM-CONTACTS.md).

import { readPointer, updateRecord, updateStats, getRecord, hk } from "../../../crm-store.mjs";
import { idForRotor, isId } from "../../core/ids.mjs";
import { nowIso } from "../../core/clock.mjs";
import { getType, statsPart } from "../../core/registry.mjs";
import { maskPhone } from "../../core/text.mjs";
import { setSuppression } from "../../core/suppressions.mjs";
import { fixMojibake, normalizePhone, normalizeEmail, normalizeAddress, addressKey, normName, rotorKey, stripeKey } from "./display.mjs";
import { SOURCES, cleanTags } from "./types.mjs";
import { contactsAt, createCandidate } from "./match.mjs";
import { propertiesOf } from "./properties.mjs";

export class RowError extends Error {
  constructor(field) { super(`${field} is missing, the wrong type or too long`); this.field = field; }
}

const str = (v) => (v == null ? "" : String(v)).trim();
const clean = (v) => fixMojibake(str(v));
const plain = (v) => !!v && typeof v === "object" && !Array.isArray(v);
// a Rotor id: letters, digits, "_", "-", "." (never only dots: "." and ".." are path segments in a key)
const ROTOR_ID = /^(?!\.+$)[A-Za-z0-9_.-]{1,64}$/;
export const MARKATE_BATCH_2 = "2026-07-29T21:49:46";
export const MAIN_NUMBER = "+17633143400";
export const STOP_WORDS = Object.freeze(["STOP", "STOPALL", "UNSUBSCRIBE", "CANCEL", "END", "QUIT", "OPTOUT", "REVOKE"]);
export const COUPON_OPTIN_TAG = "Giveaway - Coupon Opt-In";

// ------------------------------------------------------------ pure helpers

// A Rotor source → the controlled list (§5.1): { source, tag?, flag?, raw }.
const SOURCE_MAP = new Map([
  ["website quote form", "Website quote form"], ["website", "Website"], ["meta ads", "Meta Ads"], ["facebook ads", "Meta Ads"],
  ["holiday lights giveaway", "Holiday Lights Giveaway"], ["referral", "Referral"], ["returning customer", "Returning Customer"],
  ["facebook", "Facebook"], ["facebook messenger", "Facebook Messenger"], ["google", "Google"], ["family / friends", "Family / Friends"],
  ["family/friends", "Family / Friends"], ["door to door", "Door to Door"], ["door hanger", "Door Hanger"], ["signage", "Signage"],
  ["yard sign", "Yard Sign"], ["cold call", "Cold Call"], ["phone call", "Phone Call"], ["email", "Email"], ["parade", "Parade"],
  ["inbound text", "Inbound text"], ["map pin", "Map Pin"], ["other", "Other"],
]);
export function canonicalSource(raw) {
  const s = clean(raw);
  const k = s.toLowerCase();
  if (!s) return { source: "Other", raw: "" };
  if (k === "referral program") return { source: "Referral", tag: "Referral Program", raw: s };
  if (k === "test") return { source: "Other", flag: "test", raw: s };
  if (k === "markate import") return { source: "Returning Customer", markate: true, raw: s };
  if (k === "vendor") return { source: "Other", flag: "vendor", raw: s };
  return { source: SOURCE_MAP.get(k) || (SOURCES.includes(s) ? s : "Other"), raw: s };
}

// The structured facts in a lead's notes (website, giveaway, referral, Meta
// and Rotor's "Converted from lead … Original Lead Notes" block). Pure.
export function parseLeadNotes(notes) {
  const text = String(notes || "");
  const out = {};
  const orig = /Original Lead Notes:\s*([\s\S]*)$/i.exec(text);
  if (orig) Object.assign(out, parseLeadNotes(orig[1]));
  const conv = /^Converted from lead on (\d{1,2}\/\d{1,2}\/\d{4})/m.exec(text);
  if (conv) out.converted_on = conv[1];
  for (const line of text.split(/\r?\n/)) {
    const m = /^\s*([A-Za-z$0-9 ?/'()-]{2,40}):\s*(.+?)\s*$/.exec(line);
    if (!m) continue;
    const k = m[1].toLowerCase().trim(), v = m[2];
    if (k === "services" || k === "interested in") out.services = v.split(/\s*,\s*/).filter(Boolean);
    else if (k === "plan") out.plan = v;
    else if (k === "lights location") out.lights_location = v;
    else if (k === "referral code" || k === "referral code typed") out.referral_code = (/([A-Z]+-[A-Z0-9]+)/.exec(v) || [])[1] || v.slice(0, 40);
    else if (k === "share link") out.share_link = v;
    else if (k === "invited by") out.invited_by = v;
    else if (/coupon texts$/.test(k)) out.coupon_optin = /^yes/i.test(v);
    else if (k === "service area") out.area_check = v;
    else if (k === "form" || k === "form name") out.form = v;
    else if (k === "ad" || k === "ad name") out.ad = v;
    else if (k === "campaign" || k === "campaign name") out.campaign = v;
    else if (k === "county" || k === "where are you located?" || k === "where are you located" || k === "where") out.county = v.toLowerCase().replace(/\s+county$/, "");
    else if (k === "how did you hear about us?" || k === "how did you hear about us" || k === "heard about us") out.channel = v;
  }
  const msg = /Customer notes:\n([\s\S]*?)(?:\n\n|$)/.exec(text);
  if (msg) out.message = msg[1].trim();
  return out;
}

// "Test Test", "asdf", a link: a name nobody real gives (with no engagement → archived as spam).
export function isSpamName(first, last) {
  const n = `${str(first)} ${str(last)}`.trim();
  if (!n) return false;
  if (/https?:|www\.|\.com\b/i.test(n)) return true;
  if (!/\p{L}/u.test(n)) return true;
  if (/^(asdf|qwer|xxx|aaa|test)\b/i.test(n) && n.split(/\s+/).every((w) => /^(asdf\w*|qwer\w*|x+|a+|test)$/i.test(w))) return true;
  return false;
}

// Rotor's dollars ("243.1") → cents, without floats (§10.5).
export function toCents(v) {
  const s = str(v).replace(/[$,\s]/g, "");
  if (!/^-?\d+(\.\d+)?$/.test(s)) return null;
  const neg = s.startsWith("-");
  const [d, c = ""] = s.replace("-", "").split(".");
  const cents = Number(d) * 100 + Number((c + "00").slice(0, 2)) + (Number(c[2] || 0) >= 5 ? 1 : 0);
  return neg ? -cents : cents;
}

// The catalog of tags (row 11): every tag in use, how many contacts carry it,
// and its kind (attribution, program, other). Pure, from contacts index rows.
const PROGRAM = /^(giveaway|christmas lights|referral program|holiday)/i;
const ATTRIBUTION = /(form|ad\b|facebook|instagram|google|tiktok|yard sign|van|postcard|door hanger|family|friend|meta)/i;
export const tagKind = (t) => (PROGRAM.test(t) ? "program" : ATTRIBUTION.test(t) ? "attribution" : "other");
export function tagCatalog(rows) {
  const counts = new Map();
  for (const r of rows || []) for (const t of r.tg || []) { const k = String(t); counts.set(k, (counts.get(k) || 0) + 1); }
  return [...counts].map(([name, count]) => ({ name, count, kind: tagKind(name) })).sort((a, b) => b.count - a.count || a.name.localeCompare(b.name));
}

// ------------------------------------------------------------ row shapes

function needId(row, field = "id") {
  if (!plain(row)) throw new RowError("row");
  const id = str(row[field]);
  if (!ROTOR_ID.test(id)) throw new RowError(field);
  return id;
}
const opt = (row, k, max) => {
  const v = row[k];
  if (v == null || v === "") return "";
  if (typeof v !== "string" && typeof v !== "number") throw new RowError(k);
  const s = String(v);
  if (s.length > max) throw new RowError(k);
  return s;
};

// A person row (customer or lead): Rotor's own field names, flat or nested address.
export function normalizePerson(row) {
  const id = needId(row);
  const addr = plain(row.address) ? row.address : {
    street1: row.address_street1 ?? row.street1, street2: row.address_street2, city: row.address_city ?? row.city,
    state: row.address_state ?? row.state, zip: row.address_zip ?? row.zip,
  };
  const tags = row.tags == null ? [] : Array.isArray(row.tags) ? row.tags.map(str).filter(Boolean).slice(0, 60) : (() => { throw new RowError("tags"); })();
  const assigned = row.assigned_to == null ? [] : Array.isArray(row.assigned_to) ? row.assigned_to.map(str).filter(Boolean) : [str(row.assigned_to)].filter(Boolean);
  let first = opt(row, "first_name", 120), last = opt(row, "last_name", 120);
  if (!first && !last && row.name) { const p = String(opt(row, "name", 240)).trim().split(/\s+/); first = p[0] || ""; last = p.slice(1).join(" "); }
  return {
    id, first_name: first, last_name: last, company_name: opt(row, "company_name", 200), email: opt(row, "email", 200), phone: opt(row, "phone", 40),
    status: opt(row, "status", 40), source: opt(row, "source", 120), assigned_to: assigned, address: addr, tags,
    notes: opt(row, "notes", 20000), created_at: opt(row, "created_at", 40), service_type: opt(row, "service_type", 200),
    projected_value: row.projected_value ?? null, follow_up_date: opt(row, "follow_up_date", 40), stage: opt(row, "stage", 80),
  };
}

// ------------------------------------------------------------ shared mapping

async function lookup(ctx, type, rid) {
  if (ctx && typeof ctx.lookup === "function") return (await ctx.lookup(type, rid)) || null;
  const p = await readPointer(`rotor/${type}`, rotorKey(rid)).catch(() => null);
  return p && isId(p.id, "contact") ? p.id : null;
}

// The people fields of a Rotor row, as the contact holds them.
function personFields(r, ctx, warnings) {
  const phone = normalizePhone(r.phone);
  if (!phone.e164 && phone.problem !== "empty") warnings.push(`phone_${phone.problem}`);
  const email = normalizeEmail(r.email);
  if (!email && str(r.email)) warnings.push("email_invalid");
  const repaired = [];
  const address = normalizeAddress(r.address || {}, { repaired });
  for (const x of repaired) warnings.push(`address_${x}`);
  const src = canonicalSource(r.source);
  const facts = parseLeadNotes(r.notes);
  const tags = cleanTags([...(r.tags || []).map(clean), ...(src.tag ? [src.tag] : [])].slice(0, 30), "tags");
  const users = (ctx && ctx.users) || new Map();
  const assigned = r.assigned_to.map((u) => users.get(u)).filter((u) => isId(u, "user"));
  const first = clean(r.first_name), last = clean(r.last_name), company = clean(r.company_name);
  const source = { source: src.source, captured_at: r.created_at && !Number.isNaN(Date.parse(r.created_at)) ? new Date(r.created_at).toISOString() : nowIso(), raw: src.raw };
  for (const k of ["form", "ad", "campaign", "county", "channel", "referral_code"]) if (facts[k]) source[k] = String(facts[k]).slice(0, 120);
  const optin = tags.some((t) => t.toLowerCase() === COUPON_OPTIN_TAG.toLowerCase()) || facts.coupon_optin === true;
  return {
    data: {
      kind: company && !first && !last ? "business" : "person", first_name: first.slice(0, 80), last_name: last.slice(0, 80), company_name: company.slice(0, 120),
      phones: phone.e164 ? [{ e164: phone.e164, label: "mobile", primary: true, sms: true }] : [],
      emails: email ? [{ address: email, label: "personal", primary: true }] : [],
      source, tags, notes: String(r.notes || "").slice(0, 10000),
      ...(address ? { billing_address: address } : {}),
      owner_id: assigned[0] || undefined, watcher_ids: assigned.slice(1),
      flags: { ...(src.flag ? { [src.flag]: true } : {}) },
    },
    phone: phone.e164, email, address, src, facts, optin,
  };
}

const consentGrant = (source) => ({ state: "granted", at: nowIso(), source });

// ------------------------------------------------------------ row 6: customers

async function mapCustomer(r, ctx) {
  const warnings = [];
  const p = personFields(r, ctx, warnings);
  // §10.3: through the pointers first, then a converted lead with the same phone or email
  let id = await lookup(ctx, "customer", r.id);
  if (!id && p.facts.converted_on) {
    const cands = [...(p.phone ? await contactsAt("phone", p.phone) : []), ...(p.email ? await contactsAt("email", p.email) : [])];
    const lead = cands.find((c) => c.data.lifecycle === "lead" && (c.data.rotor && (c.data.rotor.lead_ids || []).length) && !(c.data.rotor && c.data.rotor.customer_id));
    if (lead) id = lead.id;
  }
  if (!id) id = idForRotor("contact", r.id);
  const inactive = r.status.toLowerCase() === "inactive";
  const archived = p.src.flag === "test" || p.src.flag === "vendor";
  const tags = inactive && !p.data.tags.includes("Rotor inactive") ? [...p.data.tags, "Rotor inactive"].slice(0, 30) : p.data.tags;
  const markate = r.created_at.startsWith(MARKATE_BATCH_2) ? 2 : p.src.markate ? 1 : undefined;
  const propertyId = p.address && p.address.street1 ? idForRotor("property", `customer:${r.id}`) : null;
  const data = {
    id, ...p.data, tags,
    lifecycle: archived ? "archived" : inactive ? "former_customer" : "customer",
    ...(archived ? { archived_reason: p.src.flag } : {}),
    ...(propertyId ? { primary_property_id: propertyId } : {}),
    rotor: { customer_id: r.id, lead_ids: [], source_raw: p.src.raw, status_raw: r.status, tags_raw: r.tags, ...(markate ? { markate_batch: markate } : {}) },
    ...(r.created_at && !Number.isNaN(Date.parse(r.created_at)) ? { created_at: new Date(r.created_at).toISOString() } : {}),
  };
  const records = [{ type: "contact", data }];
  if (propertyId) records.push({ type: "property", data: { id: propertyId, contact_id: id, label: "Home", address: p.address, access: {}, assets: {}, photo_ids: [], rotor: { from: "customer" } } });
  const patches = p.optin ? [{ type: "contact", id, set: { "consent.sms_marketing": consentGrant("giveaway_optin") }, only_if: { "consent.sms_marketing.state": ["unknown", undefined] } }] : [];
  return { records, pointers: [{ kind: "rotor/customer", key: rotorKey(r.id), value: { id } }], patches, warnings };
}

// ------------------------------------------------------------ row 7: quote contact rows

export function normalizeQuoteContact(row) {
  const id = needId(row);
  const ms = plain(row.messaging_config) && plain(row.messaging_config.sms) ? row.messaging_config.sms : {};
  return {
    id, kind: str(row.type || row.contact_type).toLowerCase() === "lead" ? "lead" : "customer",
    stripe_customer_id: str(row.stripe_customer_id) || null, sms_opted_in: ms.opted_in === true,
    first_sms_sent_date: str(row.first_sms_sent_date) || null, converted_from_lead_id: str(row.converted_from_lead_id) || null,
    muted_channels: Array.isArray(row.muted_channels) ? row.muted_channels.map((x) => str(x).toLowerCase()).filter((x) => x === "sms" || x === "email") : [],
  };
}

async function mapQuoteContact(r, ctx) {
  const id = (await lookup(ctx, r.kind, r.id)) || (r.kind === "customer" ? idForRotor("contact", r.id) : null);
  if (!id) return { warnings: ["quote_contact_unknown"] };
  const out = { patches: [], pointers: [], stats: [], warnings: [] };
  // two patches: the grant only where consent is still unknown; the muted channels whatever consent says
  if (r.sms_opted_in) out.patches.push({ type: "contact", id, set: { "consent.sms_service": consentGrant("import") }, only_if: { "consent.sms_service.state": ["unknown", undefined] } });
  const paused = {};
  for (const ch of r.muted_channels) paused[`automations_paused.${ch}`] = { reason: "Muted in Rotor", by: "import", at: nowIso() };
  if (Object.keys(paused).length) out.patches.push({ type: "contact", id, fill: paused });
  if (r.stripe_customer_id) {
    out.stats.push({ contact_id: id, part: "money", merge: { stripe: { customer_ids: [r.stripe_customer_id] } } });
    out.pointers.push({ kind: "stripe-cus", key: stripeKey(r.stripe_customer_id), value: { id }, list: true });
  }
  if (r.first_sms_sent_date && !Number.isNaN(Date.parse(r.first_sms_sent_date))) out.stats.push({ contact_id: id, part: "comms", merge: { first_sms: { [MAIN_NUMBER]: new Date(r.first_sms_sent_date).toISOString() } } });
  // a converted lead: its Rotor lead id names this contact, so the leads phase updates it in place (§10.3)
  if (r.converted_from_lead_id && ROTOR_ID.test(r.converted_from_lead_id)) {
    out.pointers.push({ kind: "rotor/lead", key: rotorKey(r.converted_from_lead_id), value: { id } });
    out.patches.push({ type: "contact", id, add: { "rotor.lead_ids": [r.converted_from_lead_id] }, fill: { "rotor.converted_from_lead_id": r.converted_from_lead_id } });
  }
  return out;
}

// ------------------------------------------------------------ row 8: leads

async function mapLead(r, ctx) {
  const warnings = [];
  const p = personFields(r, ctx, warnings);
  const out = { records: [], pointers: [], patches: [], mergeCandidates: [], warnings };
  const services = [...new Set([...(r.service_type ? r.service_type.split(/\s*,\s*/) : []), ...(p.facts.services || [])].filter(Boolean))].slice(0, 20);
  // Where the lead lands: its own contact (made by an earlier run, or by the
  // website's dual-write, with or without Rotor's id) gets the full mapped
  // record, so the runner applies field ownership (§10.7: a re-run takes
  // Rotor's edits; a linked intake contact fills its empty fields and gains
  // `import`). A lead that joins a customer's contact (converted, or the
  // same person, §10.4) only adds its lead id, tags and empty fields.
  let id = await lookup(ctx, "lead", r.id);
  let joins = false;
  if (id) {
    // a contact that is a customer (Rotor converted the lead, or the lead joined a customer): the lead row only
    // adds to it, whatever its id, even when the export still lists the lead (exported before the conversion, R3)
    const cur = await getRecord("contact", id).catch(() => null);
    joins = !!(cur && ((cur.data.rotor && cur.data.rotor.customer_id) || ["customer", "former_customer"].includes(cur.data.lifecycle)));
  }
  if (!id) {
    // a dual-write lead whose Rotor id the website never got back (§10.3 step 3)
    const cands = [...(p.phone ? await contactsAt("phone", p.phone) : []), ...(p.email ? await contactsAt("email", p.email) : [])];
    const pending = cands.find((c) => c.data.intake_pending_rotor);
    if (pending) {
      id = pending.id;
      out.patches.push({ type: "contact", id, set: { intake_pending_rotor: null } });
    } else {
      // a customer with this phone or email and the same first name: the lead joins them (§10.4)
      const customer = cands.find((c) => ["customer", "former_customer"].includes(c.data.lifecycle) && normName(c.data.first_name) && normName(c.data.first_name) === normName(p.data.first_name));
      if (customer) { id = customer.id; joins = true; }
      else {
        id = idForRotor("contact", r.id);
        for (const c of cands.slice(0, 3)) if (c.id !== id) out.mergeCandidates.push({ a: c.id, b: id, reason: p.phone && (c.data.phones || []).some((x) => x.e164 === p.phone) ? "phone" : "email", confidence: "high" });
      }
    }
  }
  out.pointers.push({ kind: "rotor/lead", key: rotorKey(r.id), value: { id } });
  if (joins) {
    out.patches.push({ type: "contact", id, add: { "rotor.lead_ids": [r.id], tags: p.data.tags }, fill: { first_name: p.data.first_name, last_name: p.data.last_name, billing_address: p.address || undefined, owner_id: p.data.owner_id } });
  } else {
    const spam = isSpamName(p.data.first_name, p.data.last_name);
    out.records.push({
      type: "contact",
      data: {
        id, ...p.data, lifecycle: spam || p.data.flags.test ? "archived" : "lead",
        ...(spam ? { archived_reason: "spam", flags: { ...p.data.flags, spam: true } } : p.data.flags.test ? { archived_reason: "test" } : {}),
        rotor: { lead_ids: [r.id], source_raw: p.src.raw, status_raw: r.status || r.stage || "", tags_raw: r.tags },
        ...(r.created_at && !Number.isNaN(Date.parse(r.created_at)) ? { created_at: new Date(r.created_at).toISOString() } : {}),
      },
    });
  }
  if (p.optin) out.patches.push({ type: "contact", id, set: { "consent.sms_marketing": consentGrant("giveaway_optin") }, only_if: { "consent.sms_marketing.state": ["unknown", undefined] } });
  // the lead's deal (sales owns the type; written once it ships, §11.3 feature gates)
  if (getType("deal")) {
    const value = r.projected_value != null ? toCents(r.projected_value) : null;
    out.records.push({ type: "deal", data: { id: idForRotor("deal", `lead:${r.id}`), contact_id: id, services, ...(value !== null ? { value_cents: value } : {}), status: "open", rotor: { lead_id: r.id } } });
  } else if (services.length || r.projected_value != null) warnings.push("deal_waits_for_sales");
  if (r.follow_up_date && !getType("task")) warnings.push("follow_up_waits_for_sales");
  return out;
}

// ------------------------------------------------------------ row 9: placeholders

// A contact some other row names but the export does not have (archived
// leads, a missing customer): made under exactly idForRotor so a later
// export overwrites it in place (R3). For other modules' phases.
export function placeholderContact(rotorId, { name, kind = "lead" } = {}) {
  const id = idForRotor("contact", rotorId);
  const parts = str(name).split(/\s+/).filter(Boolean);
  return {
    type: "contact",
    data: {
      id, kind: "person", first_name: parts.length ? parts[0].slice(0, 80) : "Rotor contact", last_name: parts.length ? parts.slice(1).join(" ").slice(0, 80) : "(missing)", company_name: "",
      phones: [], emails: [], lifecycle: "archived", archived_reason: "other", flags: { placeholder: true }, tags: [], notes: "",
      source: { source: "Other", captured_at: nowIso() }, rotor: kind === "customer" ? { customer_id: rotorId, lead_ids: [] } : { lead_ids: [rotorId] },
    },
  };
}

// ------------------------------------------------------------ row 10: properties

// One address seen on a quote, a plan or a visit → the contact's property at
// that street + ZIP (matched to what exists), else a new one.
async function mapProperty({ contactRotorId, contactKind, propertyId, address, from }, ctx) {
  const cid = (await lookup(ctx, contactKind || "customer", contactRotorId)) || (contactKind === "lead" ? null : await lookup(ctx, "lead", contactRotorId));
  if (!cid) return { warnings: ["property_no_contact"] };
  const a = normalizeAddress(address || {});
  if (!a || !a.street1) return { warnings: ["property_no_address"] };
  const key = addressKey(a);
  const existing = (await propertiesOf(cid)).find((p) => addressKey(p.address) === key);
  if (existing) {
    return propertyId ? { patches: [{ type: "property", id: existing.id, fill: { "rotor.property_id": propertyId } }], pointers: [{ kind: "rotor/property", key: rotorKey(propertyId), value: { id: existing.id } }] } : {};
  }
  const id = propertyId ? idForRotor("property", String(propertyId)) : idForRotor("property", `${cid}:${key}`);
  return {
    records: [{ type: "property", data: { id, contact_id: cid, label: "Property", address: a, access: {}, assets: {}, photo_ids: [], rotor: { ...(propertyId ? { property_id: propertyId } : {}), from } } }],
    pointers: propertyId ? [{ kind: "rotor/property", key: rotorKey(propertyId), value: { id } }] : [],
  };
}

const flatAddress = (o, prefix) => ({ street1: o[`${prefix}street1`] ?? o[`${prefix}street`], street2: o[`${prefix}street2`], city: o[`${prefix}city`], state: o[`${prefix}state`], zip: o[`${prefix}zip`] });

export function normalizePropertySource(row) {
  const id = needId(row);
  const cfg = plain(row.jobs_config) ? row.jobs_config : row;
  return {
    // plans and visits embed their customer as `customer: { id, ... }`; quotes say `contact_type` (rotor-ops §2.3, §4.3; rotor-money §1.1)
    id, contact: str(row.customer_id || row.contact_id || row.lead_id || (plain(row.customer) ? row.customer.id : "")),
    contact_kind: str(row.contact_type).toLowerCase() === "lead" || (row.lead_id && !row.customer_id) ? "lead" : "customer",
    property_id: row.property_id ?? cfg.property_id ?? null,
    address: plain(row.address) ? row.address : flatAddress(cfg, "property_"),
  };
}

// ------------------------------------------------------------ row 12: STOP replies

export function normalizeMessage(row) {
  const id = needId(row);
  return {
    id, direction: str(row.direction).toLowerCase(), channel: str(row.channel || row.type || "sms").toLowerCase(),
    // Rotor's list_messages rows carry the text in `content` and the contact's number in `contact_phone` (rotor-comms §2.3)
    body: typeof row.body === "string" ? row.body : typeof row.content === "string" ? row.content : str(row.text), from: str(row.from_number || row.from || row.contact_phone || row.phone),
  };
}

export const isStop = (body) => STOP_WORDS.includes(String(body || "").trim().toUpperCase());

async function mapStop(m) {
  if (m.direction !== "inbound" || m.channel !== "sms" || !isStop(m.body)) return {};
  const phone = normalizePhone(m.from);
  if (!phone.e164) return { warnings: ["stop_without_number"] };
  return { suppressions: [{ channel: "sms", address_hk: hk("phone", phone.e164), state: "opted_out", source: "import", keyword: String(m.body).trim().toUpperCase().slice(0, 12), masked: maskPhone(phone.e164) }] };
}

// ------------------------------------------------------------ row 36: giveaway entrants and referrals

export function normalizeEntrant(row) {
  const id = needId(row);
  return { id, phone: str(row.phone), offers_opt_in: row.offers_opt_in === true, sms_opt_out: row.sms_opt_out === true || !!(plain(row.sms) && row.sms.opted_out), code: str(row.code).slice(0, 40), invited_by: plain(row.referred_by) ? str(row.referred_by.code).slice(0, 40) : "" };
}

async function mapEntrant(e) {
  const phone = normalizePhone(e.phone);
  if (!phone.e164) return { warnings: ["entrant_no_phone"] };
  const out = { patches: [], suppressions: [], warnings: [] };
  if (e.sms_opt_out) out.suppressions.push({ channel: "sms", address_hk: hk("phone", phone.e164), state: "opted_out", source: "import", masked: maskPhone(phone.e164) });
  const people = await contactsAt("phone", phone.e164);
  if (!people.length) { out.warnings.push("entrant_no_contact"); return out; }
  for (const c of people.slice(0, 3)) {
    if (e.offers_opt_in && !e.sms_opt_out) out.patches.push({ type: "contact", id: c.id, set: { "consent.sms_marketing": consentGrant("giveaway_optin") }, only_if: { "consent.sms_marketing.state": ["unknown", undefined] } });
    if (e.code) out.patches.push({ type: "contact", id: c.id, fill: { "source.promo_code": e.code } });
  }
  return out;
}

export function normalizeReferral(row) {
  const id = needId(row);
  const friend = plain(row.friend) ? row.friend : row;
  return { id, phone: str(friend.phone), code: str(row.code || row.referral_code).slice(0, 40), sms_opt_out: row.sms_opt_out === true };
}

async function mapReferral(r) {
  const phone = normalizePhone(r.phone);
  if (!phone.e164) return { warnings: ["referral_no_phone"] };
  const people = await contactsAt("phone", phone.e164);
  const out = { patches: [], suppressions: [], warnings: people.length ? [] : ["referral_no_contact"] };
  if (r.sms_opt_out) out.suppressions.push({ channel: "sms", address_hk: hk("phone", phone.e164), state: "opted_out", source: "import", masked: maskPhone(phone.e164) });
  if (r.code) for (const c of people.slice(0, 3)) out.patches.push({ type: "contact", id: c.id, fill: { "source.referral_code": r.code } });
  return out;
}

// ------------------------------------------------------------ the phases

export const phases = [
  { name: "contacts.customers", entity: "customers", after: ["system.users"], normalize: normalizePerson, map: mapCustomer },
  { name: "contacts.quote_contacts", entity: "quote_contacts", after: ["contacts.customers"], normalize: normalizeQuoteContact, map: mapQuoteContact },
  { name: "contacts.leads", entity: "leads", after: ["contacts.quote_contacts"], normalize: normalizePerson, map: mapLead },
  { name: "contacts.properties_quotes", entity: "quotes", after: ["contacts.leads"], normalize: normalizePropertySource, map: (r, ctx) => mapProperty({ contactRotorId: r.contact, contactKind: r.contact_kind, propertyId: r.property_id, address: r.address, from: "quote" }, ctx) },
  { name: "contacts.properties_plans", entity: "service_plans", after: ["contacts.leads"], normalize: normalizePropertySource, map: (r, ctx) => mapProperty({ contactRotorId: r.contact, contactKind: r.contact_kind, propertyId: r.property_id, address: r.address, from: "plan" }, ctx) },
  { name: "contacts.properties_visits", entity: "visits", after: ["contacts.leads"], normalize: normalizePropertySource, map: (r, ctx) => mapProperty({ contactRotorId: r.contact, contactKind: r.contact_kind, propertyId: r.property_id, address: r.address, from: "visit" }, ctx) },
  // written before any comms phase (M6's messages phase lists it in `after`)
  { name: "contacts.suppressions", entity: "messages", after: ["contacts.leads"], normalize: normalizeMessage, map: mapStop },
  { name: "contacts.giveaway", entity: "giveaway_entrants", after: ["contacts.leads"], normalize: normalizeEntrant, map: mapEntrant },
  { name: "contacts.referrals", entity: "referrals", after: ["contacts.leads"], normalize: normalizeReferral, map: mapReferral },
];

// ------------------------------------------------------------ applying the extras

const getPath = (o, path) => path.split(".").reduce((x, k) => (x == null ? undefined : x[k]), o);
function setPath(o, path, v) {
  const ks = path.split(".");
  let x = o;
  for (const k of ks.slice(0, -1)) { if (!plain(x[k])) x[k] = {}; x = x[k]; }
  if (v === null) delete x[ks[ks.length - 1]]; else x[ks[ks.length - 1]] = v;
}

// A patch on one record (pure): fill where empty, union into lists, set CRM fields.
export function applyPatch(rec, patch) {
  const next = JSON.parse(JSON.stringify(rec));
  if (patch.only_if) {
    for (const [path, allowed] of Object.entries(patch.only_if)) if (!allowed.includes(getPath(next, path))) { delete patch.set; break; }
  }
  for (const [path, v] of Object.entries(patch.fill || {})) {
    if (v === undefined || v === null || v === "") continue;
    const cur = getPath(next, path);
    if (cur === undefined || cur === null || cur === "" || (Array.isArray(cur) && !cur.length)) setPath(next, path, v);
  }
  for (const [path, list] of Object.entries(patch.add || {})) {
    const cur = Array.isArray(getPath(next, path)) ? getPath(next, path) : [];
    const seen = new Set(cur.map((x) => String(x).toLowerCase()));
    const add = (list || []).filter((x) => x && !seen.has(String(x).toLowerCase()));
    setPath(next, path, path === "tags" ? [...cur, ...add].slice(0, 30) : [...cur, ...add]);
  }
  for (const [path, v] of Object.entries(patch.set || {})) setPath(next, path, v);
  return JSON.stringify(next) === JSON.stringify(rec) ? null : next;
}

const deepMerge = (a, b) => {
  const out = { ...(a || {}) };
  for (const [k, v] of Object.entries(b || {})) {
    if (Array.isArray(v)) out[k] = [...new Set([...(Array.isArray(out[k]) ? out[k] : []), ...v])];
    else if (plain(v)) out[k] = deepMerge(out[k], v);
    else if (out[k] === undefined || out[k] === null) out[k] = v;
  }
  return out;
};

// Writes an output's patches, stats, suppressions and merge candidates
// (records and unique pointers are the runner's). ctx: the import's write
// context (origin "import"). → { patched, stats, suppressed, candidates }
export async function applyExtras(out, ctx = {}) {
  const res = { patched: 0, stats: 0, suppressed: 0, candidates: 0 };
  for (const p of out.suppressions || []) {
    await setSuppression({ channel: p.channel, address_hk: p.address_hk, state: p.state, source: p.source || "import", masked: p.masked, keyword: p.keyword, by: "import" });
    res.suppressed += 1;
  }
  for (const p of out.patches || []) {
    if (!(await getRecord(p.type, p.id))) continue;
    const r = await updateRecord(p.type, p.id, (rec) => applyPatch(rec, { ...p }), ctx);
    if (r.changed) res.patched += 1;
  }
  for (const s of out.stats || []) {
    if (!statsPart(s.part)) continue;              // a part whose module has not shipped yet
    await updateStats(s.contact_id, s.part, (cur) => deepMerge(cur, s.merge), ctx);
    res.stats += 1;
  }
  for (const m of out.mergeCandidates || []) {
    const c = await createCandidate(m.a, m.b, { reason: m.reason, confidence: m.confidence }, ctx);
    if (c && c.created) res.candidates += 1;
  }
  return res;
}
