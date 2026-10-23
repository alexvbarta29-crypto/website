// Rotor writes for the giveaway, done so they never clobber a real lead.
//
// Rotor's open API (POST /open-api/leads, v1.1.0) upserts by phone: a person
// who is already a lead (a quote request, a Meta lead, a past referral) gets
// their lead UPDATED, and any name / source / notes we send replace theirs.
// So every giveaway write goes in two steps:
//
//   1. POST { phone } only. Nothing on an existing lead changes.
//      201 → we just created this lead; 200 → it already existed.
//   2. By phone again (never by id, which blanks fields it isn't sent), the
//      tags (always, so Rotor's "Tag added" workflows fire) plus:
//      - new lead      → name, address, source and notes;
//      - existing lead → append our notes under theirs (only when Rotor's
//        reply shows us their current notes), fill service_type only if
//        it is empty, and leave name, source and address alone.
//
// Step 1 carries no source, so a Rotor "Lead created" workflow filtered to
// the real lead sources (Website quote form, Meta Ads, Referral...) never
// fires for a giveaway entrant: they stay out of the sales pipeline.

import { GIVEAWAY, DATES, TAGS, shareUrl } from "./giveaway-config.mjs";
import { addressLine } from "./giveaway-lib.mjs";
import { fullName } from "./referral-lib.mjs";

const ROTOR_URL = "https://api.getrotor.com/open-api/leads";
const ROTOR_API_VERSION = "1.1.0";
const TIMEOUT_MS = 3500;
const MAX_NOTES = 2000;

async function post(payload) {
  const key = process.env.ROTOR_API_KEY;
  if (!key) {
    console.error("giveaway: ROTOR_API_KEY is not set — lead not delivered");
    return { status: null, body: null };
  }
  try {
    const res = await fetch(ROTOR_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-api-key": key, "rotor-api-version": ROTOR_API_VERSION },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    let body = null;
    try { body = await res.json(); } catch { body = null; }
    if (res.status !== 200 && res.status !== 201)
      console.error("giveaway: Rotor rejected lead: HTTP " + res.status);  // status only: the body may echo customer data
    return { status: res.status, body: body && typeof body === "object" ? body : null };
  } catch (err) {
    console.error("giveaway: Rotor unreachable (" + (err && err.name || "error") + ")");
    return { status: null, body: null };
  }
}

const okStatus = (s) => s === 200 || s === 201;
const usableId = (v) => (typeof v === "string" && /^[\w.-]{1,64}$/.test(v) ? v : null);
function leadOf(body) {
  if (!body) return null;
  for (const h of [body, body.data, body.lead]) if (h && typeof h === "object" && usableId(h.id)) return h;
  return null;
}

// Our lines go under theirs. Re-running a write (a retry, a re-tag) never
// stacks the same block twice. If both don't fit Rotor's 2,000 characters,
// theirs win and ours are cut.
export function mergeNotes(existing, ours) {
  const theirs = String(existing || "").trim();
  const add = String(ours || "").trim();
  if (!add) return theirs;
  if (!theirs) return add.slice(0, MAX_NOTES);
  if (theirs.includes(add.split("\n")[0])) return theirs;
  return (theirs + "\n\n" + add).slice(0, MAX_NOTES);
}

/**
 * @param {object} o
 * @param {string} o.phone
 * @param {string[]} o.tags          merged onto the lead
 * @param {string} [o.name]          for a NEW lead (also used if Rotor insists on a name in step 1)
 * @param {object} [o.fields]        for a NEW lead only: source, address_*, service_type...
 * @param {string} [o.notes]         new lead: the notes; existing lead: appended to theirs
 * @param {string} [o.service_type]  existing lead: set only if theirs is empty
 * @returns {{delivered:boolean, status:number|null, lead_id:string|null, existing:boolean|null, details:boolean}}
 */
// Rotor keeps phones as +1XXXXXXXXXX; sending that form makes both steps
// match the same lead however the entrant typed it.
function e164(v) {
  const d = String(v || "").replace(/\D/g, "");
  if (d.length === 10) return "+1" + d;
  if (d.length === 11 && d[0] === "1") return "+" + d;
  return String(v || "").trim();
}

export async function upsertGiveawayLead({ phone: rawPhone, tags, name, fields = {}, notes = "", service_type } = {}) {
  const phone = e164(rawPhone);
  // Step 1: find or create the lead by phone alone. The tags wait for step 2
  // so they always arrive as an UPDATE, which is what fires Rotor's
  // "Tag added" workflows (the giveaway pipelines) for new and existing leads.
  let r1 = await post({ phone });
  // If this Rotor account insists on a name for new leads, ask again with one.
  if (r1.status === 400 && name) r1 = await post({ phone, name });
  if (!okStatus(r1.status))
    return { delivered: false, status: r1.status, lead_id: null, existing: null, details: false };

  const existing = r1.status === 200;
  const lead = leadOf(r1.body);
  const id = lead ? lead.id : null;

  const update = { tags };
  if (!existing) {
    Object.assign(update, fields);
    if (name) update.name = name;
    if (notes) update.notes = String(notes).slice(0, MAX_NOTES);
  } else {
    // Notes only when Rotor showed us theirs, so we can keep them.
    if (notes && lead && Object.prototype.hasOwnProperty.call(lead, "notes")) {
      const merged = mergeNotes(lead.notes, notes);
      if (merged !== String(lead.notes || "").trim()) update.notes = merged;
    }
    if (service_type && lead && !String(lead.service_type || "").trim()) update.service_type = service_type;
  }
  // Always by phone, never by id: an update by id blanks fields it isn't
  // sent (it erased the phone on the first live entries), while an upsert by
  // phone only changes what it carries. The phone is the lead's own, so it
  // finds the same lead step 1 found or made.
  update.phone = phone;
  const r2 = await post(update);
  const delivered = okStatus(r2.status);
  return { delivered, status: delivered ? r1.status : r2.status, lead_id: id, existing, details: delivered };
}

// ---------------------------------------------------------------------------
// What each giveaway event writes to Rotor (used by /api/giveaway and the
// office dashboard).

export function rotorEntryPayload(e) {
  const a = e.address;
  const lines = [
    `Entered the ${GIVEAWAY.name} (drawing ${DATES.draw}).`,
    `Share link: ${shareUrl(e.code)}`,
  ];
  if (e.referred_by) lines.push(`Invited by: ${e.referred_by.name} (${e.referred_by.code})`);
  lines.push(`$${GIVEAWAY.coupon} coupon texts: ${e.offers_opt_in ? "YES, opted in" : "no"}`);
  if (e.area.ok !== true) lines.push("Service area: couldn't verify the address, please check.");
  // No "Christmas Lights" tag here: entering isn't a request for lights, and
  // that tag is how real light leads are found. A coupon claim adds it.
  const fields = { source: GIVEAWAY.name, address_state: a.state || "MN", address_country: "US" };
  if (a.street) fields.address_street1 = a.street;
  if (a.city) fields.address_city = a.city;
  if (a.zip) fields.address_zip = a.zip;
  return {
    phone: e.phone,
    tags: [TAGS.ENTRANT, ...(e.offers_opt_in ? [TAGS.COUPON_OPTIN] : [])],
    name: fullName(e.first_name, e.last_name),
    fields,
    notes: lines.join("\n"),
  };
}

export function rotorClaimPayload(e, at, by = "") {
  return {
    phone: e.phone,
    tags: [TAGS.CLAIMED, TAGS.LIGHTS],
    name: fullName(e.first_name, e.last_name),
    service_type: "Christmas Light Installation",
    fields: { source: GIVEAWAY.name, service_type: "Christmas Light Installation" },
    notes: `Claimed $${GIVEAWAY.coupon} off a Christmas light installation (${GIVEAWAY.name}) on `
      + `${new Date(at).toLocaleString("en-US", { timeZone: "America/Chicago" })}${by ? " (" + by + ")" : ""}. Send the quote!\n`
      + `Address: ${addressLine(e.address)}`,
  };
}
