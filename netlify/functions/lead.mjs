// Receives quote-form submissions from the site (POSTed as JSON by
// assets/js/main.js — see docs/LEAD-FORM-SETUP.md) and creates or updates a
// lead in Rotor CRM.
//
// Two Rotor API versions, picked by which key is set:
//   - ROTOR_API_TOKEN set → API 2026-11-14 (POST /leads, Bearer auth). Rotor
//     matches an existing lead by phone or email and merges into it, so a
//     repeat visitor enriches one lead instead of duplicating it. The notes
//     are appended to the lead's note afterwards, so a returning customer's
//     earlier notes are never replaced.
//   - otherwise → the legacy API (1.1.0, x-api-key, upsert by phone/email)
//     with ROTOR_API_KEY, exactly as before. Rotor froze that version on
//     2026-11-14; it keeps working, it just gets nothing new.
//
// Rotor keys live ONLY in those environment variables, set in the Netlify
// dashboard (Site configuration → Environment variables). They must never
// appear in this repo, in the static pages, or in any log line.
//
// The Barta CRM (docs/CRM-CONTACTS.md, "Website leads"): AFTER the Rotor
// call, which is unchanged, the same lead also goes to the CRM when an owner
// set Settings → Intake mode to "Rotor and the CRM" (the default is Rotor
// only, and before the CRM's Netlify setup nothing happens at all). When
// Rotor accepted the lead the visitor's answer is Rotor's and the CRM write
// runs after it; when Rotor failed, a lead the CRM kept is still a success.

import { referralForLead } from "../lib/referral-hook.mjs";
import { rotorLeadId } from "../lib/referral-notify.mjs";
import { afterRotor, crmRescued, watchRotor } from "../lib/crm/modules/contacts/hook.mjs";

const ROTOR_URL = "https://api.getrotor.com/open-api/leads";
const ROTOR_API_VERSION = "1.1.0";
const ROTOR_V2_URL = "https://api.getrotor.com/leads";
const ROTOR_V2_VERSION = "2026-11-14";
const MAX_FIELD = 500;          // per-field sanity cap for form values
const MAX_SERVICE_TYPE = 100;   // Rotor's service_type limit
const MAX_NOTES = 2000;         // Rotor's notes limit
const MAX_LIST = 20;            // v2: tags and service_types hold at most 20
const MAX_SOURCE = 100;         // v2: source limit
const NOTE_TIMEOUT_MS = 3000;   // v2: the note append is best-effort

// v2 needs a real phone number; Rotor keeps phones as +1XXXXXXXXXX.
const e164 = (v) => {
  const d = String(v || "").replace(/\D/g, "");
  if (d.length === 10) return "+1" + d;
  if (d.length === 11 && d[0] === "1") return "+" + d;
  return String(v || "").trim();
};

const v2Headers = (token) => ({
  "Content-Type": "application/json",
  Authorization: "Bearer " + token,
  "Rotor-Version": ROTOR_V2_VERSION,
});

// v2 checks service_types against the company's picklist in Rotor. If the
// website's service names don't match it, Rotor answers 400: try once more
// without them (the services still travel in the note), so a picklist
// mismatch can never cost a lead.
async function createLeadV2(token, payload) {
  const send = (body) => fetch(ROTOR_V2_URL, {
    method: "POST", headers: v2Headers(token), body: JSON.stringify(body),
  });
  const res = await send(payload);
  if (res.status !== 400 || !payload.service_types) return res;
  console.warn("Rotor rejected the lead with service types (HTTP 400): retrying without them");
  const { service_types, ...rest } = payload;
  return send(rest);
}

// Adds the form's notes under whatever the lead already has. Best-effort:
// the lead exists by now, so a failure here is logged (status only) and
// never shown to the visitor.
async function appendNoteV2(token, id, text) {
  if (!id || !text) return false;
  try {
    const res = await fetch(`${ROTOR_V2_URL}/${encodeURIComponent(id)}/note/append`, {
      method: "POST", headers: v2Headers(token),
      body: JSON.stringify({ text, separator: "\n\n" }),
      signal: AbortSignal.timeout(NOTE_TIMEOUT_MS),
    });
    if (!res.ok) console.error("Rotor note append failed: HTTP " + res.status);
    return res.ok;
  } catch (err) {
    console.error("Rotor note append failed (" + (err && err.name || "error") + ")");
    return false;
  }
}

const clean = (v) =>
  (typeof v === "string" ? v.replace(/\r\n?/g, "\n").trim().slice(0, MAX_FIELD) : "");

// The plan radio values are lowercase slugs; the office reads them in notes.
const PLAN_LABELS = { biannual: "Bi-Annual", quarterly: "Quarterly", monthly: "Monthly" };
const planLabel = (p) =>
  PLAN_LABELS[p.toLowerCase()] || (p.charAt(0).toUpperCase() + p.slice(1));

// Joins as many whole service names as fit Rotor's service_type limit. The
// full list always travels in tags as well, so dropping overflow here loses
// nothing — it just keeps service_type valid.
const serviceType = (services) => {
  let out = "";
  for (const s of services) {
    const next = out ? out + ", " + s : s;
    if (next.length > MAX_SERVICE_TYPE) break;
    out = next;
  }
  if (!out && services.length) out = services[0].slice(0, MAX_SERVICE_TYPE);
  return out;
};

// Rotor notes carry, per the owners: the customer's own message, the
// services they picked, the plan they selected, and (for Christmas leads)
// where they want the lights. Nothing else goes in, and the customer's
// words take priority under the length cap. The one addition is the
// referral program's line (docs/REFERRAL-PROGRAM.md), passed in as
// extraLines and kept ahead of the others because it is what the office
// acts on when the friend books.
const buildNotes = (data, services, plan, extraLines = []) => {
  const message = clean(data.notes || data.additional_information || data.message);
  const lightsLoc = clean(data.light_location);
  const lines = [...extraLines];
  if (services.length) lines.push("Services: " + services.join(", "));
  if (plan) lines.push("Plan: " + planLabel(plan));
  if (lightsLoc) lines.push("Lights location: " + lightsLoc);
  const msgBlock = message ? "Customer notes:\n" + message : "";
  const assemble = (ls) => [msgBlock, ls.join("\n")].filter(Boolean).join("\n\n");
  let notes = assemble(lines);
  while (notes.length > MAX_NOTES && lines.length) {
    lines.pop();
    notes = assemble(lines);
  }
  if (notes.length > MAX_NOTES) notes = notes.slice(0, MAX_NOTES);
  return notes;
};

// What the CRM's intake gets: the same lead, with the notes Rotor got.
const crmInput = ({ name, data, phone, email, street1, street2, city, state, zip, services, svcType, plan, source, tags, notes }) => ({
  name, first_name: clean(data.first_name), last_name: clean(data.last_name), phone, email,
  address: street1 || city || zip ? { street1, street2, city, state, zip } : null,
  services, service_type: svcType, plan, promo_code: clean(data.promo_code), referral_source: source,
  page: clean(data.page), tags, source: "Website quote form", notes,
  // the form's required text-consent box ("reminders"): texts about their own quote and visits
  consent: { sms_service: data.reminders === "on" || data.reminders === true },
});

export default async (req, context) => {
  if (req.method !== "POST")
    return Response.json({ error: "Method not allowed" }, { status: 405 });

  const token = process.env.ROTOR_API_TOKEN;   // 2026-11-14 key: preferred
  const key = process.env.ROTOR_API_KEY;       // legacy 1.1.0 key: fallback
  if (!token && !key) {
    console.error("ROTOR_API_TOKEN and ROTOR_API_KEY are not set — lead dropped");
    return Response.json({ error: "Lead endpoint not configured" }, { status: 500 });
  }

  let data;
  try { data = await req.json(); } catch { data = null; }
  if (!data || typeof data !== "object" || Array.isArray(data))
    return Response.json({ error: "Invalid body" }, { status: 400 });

  const name = clean(data.name) ||
    [clean(data.first_name), clean(data.last_name)].filter(Boolean).join(" ");
  const phone = clean(data.phone);
  const email = clean(data.email);
  // Without phone or email the lead is uncontactable (and Rotor has nothing
  // to upsert on); the forms require phone, so only hand-crafted requests
  // ever hit this. The 2026-11-14 API requires a phone outright.
  if (!phone && !email)
    return Response.json({ error: "Phone or email required" }, { status: 400 });
  if (token && !phone)
    return Response.json({ error: "Phone required" }, { status: 400 });

  // Rotor's structured address. Single-address-field forms send the street
  // line as "address" (Nominatim fills the hidden city/state/zip/country
  // fields on selection). MN/US are fallbacks only when a submission carries
  // some address but the hidden fields never got set.
  const street1 = clean(data.address_street) || clean(data.address);
  const street2 = clean(data.address_street2);
  const city = clean(data.address_city);
  const zip = clean(data.address_zip);
  const hasAddress = Boolean(street1 || city || zip);
  const state = clean(data.address_state) || (hasAddress ? "MN" : "");
  const country = clean(data.address_country) || (hasAddress ? "US" : "");

  const services = Array.isArray(data.services)
    ? data.services.map(clean).filter(Boolean).slice(0, 20) : [];
  const svcType = services.length ? serviceType(services)
    : clean(data.service_type).slice(0, MAX_SERVICE_TYPE);
  const plan = clean(data.plan || data.plan_choice);
  // Tags: Website on every lead, Christmas Lights on christmas-light leads,
  // and the "how did you hear about us" answer as the source tag.
  const source = clean(data.referral_source);
  const isChristmas = [...services, clean(data.service_type)]
    .some((s) => s.includes("Christmas"));
  const tags = ["Website"];
  if (isChristmas) tags.push("Christmas Lights");
  if (source) tags.push(source);

  // Referral program (docs/REFERRAL-PROGRAM.md): a referred friend's quote
  // gets the Referral tag and a notes line naming the referrer, and their
  // referral moves to "quoted" in the office dashboard. Best-effort with a
  // short timeout inside — it can never fail or hold up the quote itself.
  const referral = await referralForLead({
    promo_code: data.promo_code, phone, name, email,
    address: [street1, city, [state, zip].filter(Boolean).join(" ")].filter(Boolean).join(", "),
  });
  if (referral) tags.push("Referral");

  const notes = buildNotes(data, services, plan, referral ? [referral.notes_line] : []);

  const input = crmInput({ name, data, phone, email, street1, street2, city, state, zip, services, svcType, plan, source, tags, notes });

  if (token) {
    // 2026-11-14: name and phone are required; the address nests under
    // property; service types are a list; the note is appended afterwards.
    const payload = {
      name: (name || "Website lead").slice(0, 255),
      phone: e164(phone),
      source: "Website quote form".slice(0, MAX_SOURCE),
      tags: tags.slice(0, MAX_LIST),
      match_on: ["phone", "email"],
      on_match: "merge",
    };
    if (email) payload.email = email;
    if (hasAddress) {
      const address = {};
      for (const [k, v] of Object.entries({ street1, street2, city, state, zip, country }))
        if (v) address[k] = v;
      payload.property = { address };
    }
    const types = services.length ? services : (svcType ? [svcType] : []);
    if (types.length) payload.service_types = types.slice(0, MAX_LIST);

    let res;
    try {
      res = await watchRotor(createLeadV2(token, payload), { req, context, input, origin: "lead-form" });
    } catch (err) {
      if (crmRescued(await afterRotor({ req, context, input, origin: "lead-form", rotorOk: false }))) return Response.json({ ok: true });
      throw err;
    }
    // 201 = new lead, 200 = matched an existing lead and merged into it.
    // Log only the status: the error body may echo customer information.
    if (res.status !== 200 && res.status !== 201) {
      console.error("Rotor rejected lead: HTTP " + res.status);
      if (crmRescued(await afterRotor({ req, context, input, origin: "lead-form", rotorOk: false }))) return Response.json({ ok: true });
      return Response.json({ error: "Upstream error" }, { status: 502 });
    }
    const { id } = await rotorLeadId(res, "lead");
    await appendNoteV2(token, id, notes);
    await afterRotor({ req, context, input, origin: "lead-form", rotorOk: true, rotor: { lead_id: id } });
    return Response.json({ ok: true });
  }

  // Legacy 1.1.0 (ROTOR_API_KEY), unchanged.
  // Only Rotor-supported fields, and no empty optional properties.
  const payload = { source: "Website quote form", tags };
  if (name) payload.name = name;
  if (phone) payload.phone = phone;
  if (email) payload.email = email;
  if (street1) payload.address_street1 = street1;
  if (street2) payload.address_street2 = street2;
  if (city) payload.address_city = city;
  if (state) payload.address_state = state;
  if (zip) payload.address_zip = zip;
  if (country) payload.address_country = country;
  if (svcType) payload.service_type = svcType;
  if (notes) payload.notes = notes;

  let res;
  try {
    // watchRotor: in "rotor" mode (and before the CRM is set up) the call itself;
    // in "dual" it starts the CRM write if Rotor takes more than 5 s
    res = await watchRotor(fetch(ROTOR_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": key,
        "rotor-api-version": ROTOR_API_VERSION,
      },
      body: JSON.stringify(payload),
    }), { req, context, input, origin: "lead-form" });
  } catch (err) {
    // Rotor unreachable (or silent for 9 s): as before, unless the CRM (intake "dual") kept the lead
    if (crmRescued(await afterRotor({ req, context, input, origin: "lead-form", rotorOk: false }))) return Response.json({ ok: true });
    throw err;
  }

  // 201 = new lead, 200 = existing lead updated. Anything else must NOT look
  // like success to the visitor — main.js only shows the success screen on
  // 2xx and falls back to phone/email otherwise. Log only the status: the
  // upstream error body may echo submitted customer information.
  if (res.status !== 200 && res.status !== 201) {
    console.error("Rotor rejected lead: HTTP " + res.status);
    if (crmRescued(await afterRotor({ req, context, input, origin: "lead-form", rotorOk: false }))) return Response.json({ ok: true });
    return Response.json({ error: "Upstream error" }, { status: 502 });
  }
  // Rotor has it: the answer is Rotor's; the CRM write (if intake is on) runs after it
  await afterRotor({ req, context, input, origin: "lead-form", rotorOk: true, rotor: async () => ({ lead_id: (await rotorLeadId(res, "lead")).id }) });
  return Response.json({ ok: true });
};

export const config = { path: "/api/lead" };
