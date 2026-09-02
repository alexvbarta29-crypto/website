// Receives quote-form submissions from the site (POSTed as JSON by
// assets/js/main.js — see docs/LEAD-FORM-SETUP.md) and creates or updates a
// lead in Rotor CRM via its open API (version 1.1.0). Rotor upserts by phone
// first, then email, and merges tags on update, so repeat submissions from
// the same visitor enrich one lead instead of duplicating it.
//
// The Rotor API key lives ONLY in the ROTOR_API_KEY environment variable set
// in the Netlify dashboard (Site configuration → Environment variables). It
// must never appear in this repo, in the static pages, or in any log line.

import { referralForLead } from "../lib/referral-hook.mjs";

const ROTOR_URL = "https://api.getrotor.com/open-api/leads";
const ROTOR_API_VERSION = "1.1.0";
const MAX_FIELD = 500;          // per-field sanity cap for form values
const MAX_SERVICE_TYPE = 100;   // Rotor's service_type limit
const MAX_NOTES = 2000;         // Rotor's notes limit

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
