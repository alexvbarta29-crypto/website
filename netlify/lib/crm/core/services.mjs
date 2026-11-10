// Barta CRM core: services, the only way one module calls another (design
// §11.3 "Services"). A module provides services in its manifest; the
// registry calls provide() when it registers the module. Callers use
// call(name, ...args) (ctx is always the last argument) and has(name) to
// hide an action whose provider has not merged yet (feature gates).
//
// The contract table below is frozen for a wave: a provider may add optional
// fields, never change one. A provider other than the listed module is
// refused, so two tracks cannot both claim a service.

import { ServiceMissing, RegistryError } from "./errors.mjs";

export const SERVICE_CONTRACTS = Object.freeze({
  "stats.update": "system",            // (contact_id, part, mutate, ctx)
  "bulk.create": "system",             // ({ kind, recipients | audience, template_key, vars?, related?, requested_by }, ctx) → bulk_run_id
  "notify.users": "system",            // (user_ids, { kind, title, body, link }, ctx)
  "messages.sink": "comms",            // (message, ctx) → { message_id?, conversation_id?, outbox_id? }; core's default sink until M6
  "contacts.intake": "contacts",       // (input, { origin, rotor? }, ctx) → { ok, contact_id, created, deal_id?, enrollment_id? }
  "contacts.resolve": "contacts",      // (contact_id, ctx) → contact_id
  "contacts.findMatches": "contacts",  // ({ phones, emails, first_name, last_name, zip }, ctx) → [{ id, reason, confidence }]
  "contacts.ensureProperty": "contacts", // (contact_id, address, ctx) → property_id
  "sales.enroll": "sales",             // (contact_id, cadence_key, { quote_id?, deal_id? }, ctx) → enrollment_id | null
  "sales.stopAll": "sales",            // (contact_id, reason, ctx) → n
  "sales.markDeal": "sales",           // (deal_id, status, { reason?, quote_id?, job_id?, plan_id? }, ctx)
  "quotes.price": "quotes",
  "quotes.totals": "quotes",
  "quotes.approvedVersion": "quotes",  // (quote_id, ctx) → QuoteVersion
  "plans.agreementForOption": "plans", // (quote, version, option, ctx) → { template_id, template_version, body_rendered, body_sha256 }
  "plans.fromQuoteOption": "plans",    // (quote, version, option, opId, { signature? }, ctx) → { plan_id, agreement_id? }
  "work.createJobs": "work",           // (jobs, opId, scope, ctx) → job_ids
  "work.cancelJobs": "work",           // (job_ids, reason, opId, ctx)
  "money.createDepositInvoice": "money", // (quote, version, option, opId, ctx) → { invoice_id, checkout_url? }
  "money.cardStatus": "money",         // (contact_id, ctx) → { status, pm? }
  "reviews.isReviewed": "comms",       // (contact_id, ctx) → boolean
});

const services = new Map();   // name → { fn, module }

// "system" may also provide a default for a service another module takes
// over later (messages.sink: core's outbox sink until comms ships).
const DEFAULTS_BY_SYSTEM = new Set(["messages.sink"]);

export function provide(name, fn, { module = "system" } = {}) {
  if (typeof fn !== "function") throw new RegistryError(`services: ${name} must be a function`);
  const owner = SERVICE_CONTRACTS[name];
  if (owner && owner !== module && !(module === "system" && DEFAULTS_BY_SYSTEM.has(name))) {
    throw new RegistryError(`services: ${name} belongs to ${owner}, not ${module}`);
  }
  const had = services.get(name);
  if (had && had.fn !== fn) {
    // the owning module replaces a system default; anything else is a duplicate
    if (!(had.module === "system" && module === owner && DEFAULTS_BY_SYSTEM.has(name))) {
      throw new RegistryError(`services: ${name} is already provided by ${had.module}`);
    }
  }
  services.set(name, { fn, module });
}

export const has = (name) => services.has(name);
export const providerOf = (name) => (services.has(name) ? services.get(name).module : null);
export const list = () => [...services.keys()].sort();

export async function call(name, ...args) {
  const s = services.get(name);
  if (!s) throw new ServiceMissing(`The ${name} service is not available yet.`, { service: name });
  return s.fn(...args);
}

// Tests only: forget every provider.
export function __resetServicesForTests() { services.clear(); }
