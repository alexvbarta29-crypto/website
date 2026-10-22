// Rotor writes for the giveaway, done so they never clobber a real lead.
//
// Rotor's open API (POST /open-api/leads, v1.1.0) upserts by phone: a person
// who is already a lead (a quote request, a Meta lead, a past referral) gets
// their lead UPDATED, and any name / source / notes we send replace theirs.
// So every giveaway write goes in two steps:
//
//   1. POST { phone, tags } only. Tags merge, nothing else changes.
//      201 → we just created this lead; 200 → it already existed.
//   2. With the lead id from step 1:
//      - new lead      → fill in name, address, source and notes;
//      - existing lead → append our notes under theirs (only when Rotor's
//        reply shows us their current notes), fill service_type only if
//        it is empty, and leave name, source and address alone.
//
// Step 1 carries no source, so a Rotor "Lead created" workflow filtered to
// the real lead sources (Website quote form, Meta Ads, Referral...) never
// fires for a giveaway entrant: they stay out of the sales pipeline.

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
export async function upsertGiveawayLead({ phone, tags, name, fields = {}, notes = "", service_type } = {}) {
  let r1 = await post({ phone, tags });
  // If this Rotor account insists on a name for new leads, ask again with one.
  if (r1.status === 400 && name) r1 = await post({ phone, tags, name });
  if (!okStatus(r1.status))
    return { delivered: false, status: r1.status, lead_id: null, existing: null, details: false };

  const existing = r1.status === 200;
  const lead = leadOf(r1.body);
  const id = lead ? lead.id : null;
  const wantsDetails = existing ? Boolean(notes || service_type) : Boolean(name || notes || Object.keys(fields).length);
  if (!wantsDetails) return { delivered: true, status: r1.status, lead_id: id, existing, details: true };

  let update;
  if (!existing) {
    update = { ...fields };
    if (name) update.name = name;
    if (notes) update.notes = String(notes).slice(0, MAX_NOTES);
  } else {
    update = {};
    // Notes only when Rotor showed us theirs, so we can keep them.
    if (notes && lead && Object.prototype.hasOwnProperty.call(lead, "notes")) {
      const merged = mergeNotes(lead.notes, notes);
      if (merged !== String(lead.notes || "").trim()) update.notes = merged;
    }
    if (service_type && lead && !String(lead.service_type || "").trim()) update.service_type = service_type;
    if (!Object.keys(update).length) return { delivered: true, status: r1.status, lead_id: id, existing, details: true };
  }
  // By id when we have it; otherwise by phone, which is safe only for a lead
  // we just created ourselves.
  if (id) update.id = id;
  else if (!existing) update.phone = phone;
  else return { delivered: true, status: r1.status, lead_id: null, existing, details: false };

  const r2 = await post(update);
  return { delivered: true, status: r1.status, lead_id: id, existing, details: okStatus(r2.status) };
}
