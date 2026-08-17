// Receives quote-form submissions from the site (POSTed as JSON by
// assets/js/main.js — see docs/LEAD-FORM-SETUP.md) and creates or updates a
// lead in Rotor CRM via its open API (version 1.1.0). Rotor upserts by phone
// first, then email, and merges tags on update, so repeat submissions from
// the same visitor enrich one lead instead of duplicating it.
//
// The Rotor API key lives ONLY in the ROTOR_API_KEY environment variable set
// in the Netlify dashboard (Site configuration → Environment variables). It
// must never appear in this repo, in the static pages, or in any log line.

const ROTOR_URL = "https://api.getrotor.com/open-api/leads";
const ROTOR_API_VERSION = "1.1.0";
const MAX_FIELD = 500;          // per-field sanity cap for form values
const MAX_SERVICE_TYPE = 100;   // Rotor's service_type limit
const MAX_NOTES = 2000;         // Rotor's notes limit

const clean = (v) =>
  (typeof v === "string" ? v.replace(/\r\n?/g, "\n").trim().slice(0, MAX_FIELD) : "");

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

// Readable labels for submission details that have no structured Rotor field.
// Never includes name/phone/email/address/services — those land in their own
// Rotor categories and must not be duplicated into notes.
const DETAIL_LABELS = [
  ["plan", "Plan interest"],
  ["plan_choice", "Plan interest"],
  ["promo_code", "Promo code"],
  ["preferred_date", "Preferred date"],
  ["preferred_time", "Preferred time"],
  ["referral_source", "How they heard about us"],
  ["light_location", "Lights location"],
  ["reminders", "Wants seasonal reminders"],
  ["plan_info", "Wants maintenance-plan info"],
  ["page", "Submitted from"],
];

const buildNotes = (data) => {
  const message = clean(data.notes || data.additional_information || data.message);
  const seen = new Set();
  const details = [];
  for (const [field, label] of DETAIL_LABELS) {
    if (seen.has(label)) continue;
    let v = data[field];
    if (v === "on" || v === true) v = "yes";
    v = clean(String(v ?? ""));
    if (!v || v === "false" || v === "undefined" || v === "null") continue;
    seen.add(label);
    details.push(label + ": " + v);
  }
  const msgBlock = message ? "Customer notes:\n" + message : "";
  const assemble = (lines) => {
    const detailBlock = lines.length ? "Additional submission details:\n" + lines.join("\n") : "";
    return [msgBlock, detailBlock].filter(Boolean).join("\n\n");
  };
  // The customer's own words take priority: drop detail lines from the end
  // before ever shortening the message itself.
  let lines = details.slice();
  let notes = assemble(lines);
  while (notes.length > MAX_NOTES && lines.length) {
    lines.pop();
    notes = assemble(lines);
  }
  if (notes.length > MAX_NOTES) notes = notes.slice(0, MAX_NOTES);
  return notes;
};

export default async (req) => {
  if (req.method !== "POST")
    return Response.json({ error: "Method not allowed" }, { status: 405 });

  const key = process.env.ROTOR_API_KEY;
  if (!key) {
    console.error("ROTOR_API_KEY is not set — lead dropped");
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
  // ever hit this.
  if (!phone && !email)
    return Response.json({ error: "Phone or email required" }, { status: 400 });

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
  const tags = ["website-lead", ...services, ...(plan ? ["plan: " + plan] : [])];

  const notes = buildNotes(data);

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

  const res = await fetch(ROTOR_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": key,
      "rotor-api-version": ROTOR_API_VERSION,
    },
    body: JSON.stringify(payload),
  });

  // 201 = new lead, 200 = existing lead updated. Anything else must NOT look
  // like success to the visitor — main.js only shows the success screen on
  // 2xx and falls back to phone/email otherwise. Log only the status: the
  // upstream error body may echo submitted customer information.
  if (res.status !== 200 && res.status !== 201) {
    console.error("Rotor rejected lead: HTTP " + res.status);
    return Response.json({ error: "Upstream error" }, { status: 502 });
  }
  return Response.json({ ok: true });
};

export const config = { path: "/api/lead" };
