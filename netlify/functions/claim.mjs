// POST /api/claim — a referred friend claims their discount from friend.html
// (the /r/CODE landing). Creates the quote request in Rotor CRM (source
// "Referral Program", tag "Referral", notes naming the referrer and code),
// and records the claim: the friend's referral moves to "quoted", or is
// created on the spot when the referrer only shared their link. See
// README.md → "API".
//
// Degraded modes mirror /api/referral: the CRM lead and the record are
// attempted independently, and only when BOTH fail does the friend see the
// call-us fallback (502). A claim is never silently lost.

import { REWARDS } from "../lib/referral-config.mjs";
import { ValidationError, fullName } from "../lib/referral-lib.mjs";
import { openGuardedStore, saveReferralRecord } from "../lib/referral-store.mjs";
import { createRotorLead } from "../lib/referral-notify.mjs";
import { recordClaim, validateClaim } from "../lib/referral-claim.mjs";

const MAX_NOTES = 2000;
const MAX_SERVICE_TYPE = 100;

const json = (body, status = 200) =>
  Response.json(body, { status, headers: { "Cache-Control": "no-store" } });
const fail = (status, error, field) =>
  json(field ? { ok: false, error, field } : { ok: false, error }, status);

// Whole service names that fit Rotor's service_type limit (the full list is
// always in the notes too).
const serviceType = (services) => {
  let out = "";
  for (const s of services) {
    const next = out ? `${out}, ${s}` : s;
    if (next.length > MAX_SERVICE_TYPE) break;
    out = next;
  }
  if (!out && services.length) out = services[0].slice(0, MAX_SERVICE_TYPE);
  return out;
};

function rotorPayload(lead, claim) {
  const lines = [];
  if (claim && !claim.self) lines.push(`Referral code: ${claim.code} (referred by ${claim.referrer_name})`);
  else if (claim && claim.self) lines.push(`Used their own referral code ${lead.code} (not a referral)`);
  else if (lead.typed_code) lines.push(`Referral code typed: ${lead.typed_code} (not recognized)`);
  lines.push(`Claimed $${REWARDS.friend_discount} off their first service through the referral link.`);
  if (lead.services.length) lines.push(`Interested in: ${lead.services.join(", ")}`);
  if (lead.note) lines.push(`Customer notes:\n${lead.note}`);
  let notes = lines.join("\n");
  if (notes.length > MAX_NOTES) notes = notes.slice(0, MAX_NOTES);

  const payload = {
    source: "Referral Program",
    tags: claim && claim.self ? ["Referral Program"] : ["Referral"],
    name: fullName(lead.first_name, lead.last_name),
    phone: lead.phone,
  };
  if (lead.email) payload.email = lead.email;
  if (lead.address) {
    // One free-text line, as street1 with the same MN/US fallbacks the
    // website's single-field forms use.
    payload.address_street1 = lead.address;
    payload.address_state = "MN";
    payload.address_country = "US";
  }
  const svc = serviceType(lead.services);
  if (svc) payload.service_type = svc;
  payload.notes = notes;
  return payload;
}

export default async (req) => {
  if (req.method !== "POST")
    return json({ ok: false, error: "Method not allowed" }, 405);

  let body;
  try { body = await req.json(); } catch { body = null; }
  let lead;
  try {
    lead = validateClaim(body);
  } catch (err) {
    if (err instanceof ValidationError) return fail(400, err.message, err.field);
    throw err;
  }

  const guard = await openGuardedStore();
  // Who referred them (and record the claim). A store outage yields
  // undefined: the lead still goes to the CRM, just without the referrer.
  const claim = await guard.run("record claim", (s) =>
    recordClaim(s, { code: lead.code, digits: lead.digits, lead }));

  const rotor = await createRotorLead(rotorPayload(lead, claim || null));
  const delivered = Boolean(rotor.delivered);

  if (claim && claim.record) {
    const prev = claim.record.rotor || {};
    // Keep an id we already had if this call didn't return one.
    const lead_id = rotor.lead_id || prev.lead_id || null;
    claim.record.rotor = { delivered, status: rotor.status ?? null, lead_id,
      // Still no id: keep the field names of the latest reply that had none
      // (see rotorLeadId in referral-notify.mjs) for the dashboard's note.
      ...(lead_id ? {} :
        Array.isArray(rotor.reply_keys) ? { reply_keys: rotor.reply_keys } :
        Array.isArray(prev.reply_keys) ? { reply_keys: prev.reply_keys } : {}),
      at: new Date().toISOString() };
    claim.record.updated_at = claim.record.rotor.at;
    await guard.run("save claim delivery", (s) => saveReferralRecord(s, claim.record));
  }
  const stored = guard.ok && Boolean(claim && claim.record);

  if (!delivered && !stored) {
    console.error("claim: lost — CRM failed and nothing recorded");
    return fail(502, "We couldn't send your request right now. Please call us and we'll take care of it.");
  }

  const referred = Boolean(claim && !claim.self && claim.code);
  console.log(`claim: referred=${referred} created=${Boolean(claim && claim.created)} delivered=${delivered} stored=${stored}`);
  return json({
    ok: true,
    code: referred ? claim.code : null,
    referrer_first_name: referred ? claim.referrer_first : "",
    delivered,
    stored,
  });
};

export const config = { path: "/api/claim" };
