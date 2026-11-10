// Barta CRM core: domain events (design §11.3 "Events").
//
// The owning module calls emit(name, payload, ctx) after its write (inside
// the op when there is one). Each emission is named by the record's write
// counter: event_id = deriveId("event", recordId + ":" + wv), so a job
// reopened and completed again is a second event, and a retried request is
// the same one. Each listener becomes a queue item with the marker
// done/evt/{event_id}--{module} (§7.3). core/queue.mjs installs that
// dispatcher with setDispatcher() when it loads; emit() loads it on first
// use if nothing else has, so an emission is never dropped.
//
// Listeners re-read the subject and act on its current state.

import { RegistryError } from "./errors.mjs";
import { deriveId } from "./ids.mjs";
import { nowIso } from "./clock.mjs";
import { listenersFor, isEmitted } from "./registry.mjs";

// The frozen event table (§11.3): payload fields beyond id, wv, at, by.
export const EVENTS = Object.freeze({
  "lead.created": ["contact_id", "origin", "source"],
  "contact.merged": ["survivor_id", "merged_id"],
  "consent.changed": ["contact_id", "channel", "address_hk", "state"],
  "message.inbound": ["contact_id", "conversation_id", "channel"],
  "call.logged": ["contact_id", "direction", "outcome"],
  ...Object.fromEntries(["quote.sent", "quote.viewed", "quote.approved", "quote.declined", "quote.changes_requested", "quote.archived", "quote.converted"]
    .map((e) => [e, ["quote_id", "version_id", "contact_id"]])),
  "agreement.signed": ["agreement_id"],
  "card.saved": ["contact_id", "pm"],
  ...Object.fromEntries(["plan.activated", "plan.paused", "plan.cancelled", "plan.renewed"].map((e) => [e, ["plan_id", "contact_id"]])),
  ...Object.fromEntries(["job.created", "job.scheduled", "job.completed", "job.reopened", "job.cancelled"]
    .map((e) => [e, ["job_id", "contact_id", "kind", "billable", "total_cents", "assignee_ids"]])),
  ...Object.fromEntries(["visit.scheduled", "visit.rescheduled", "visit.assigned", "visit.cancelled", "visit.completed", "visit.no_access"]
    .map((e) => [e, ["visit_id", "job_id", "contact_id", "date", "assignee_ids"]])),
  ...Object.fromEntries(["invoice.issued", "invoice.paid", "payment.processing", "payment.succeeded", "payment.failed", "payment.refunded"]
    .map((e) => [e, ["contact_id", "amount_cents"]])),
  "review.matched": ["review_id", "contact_id", "tech_ids"],
});

export const eventId = (recordId, wv) => deriveId("event", `${recordId}:${wv}`);

let dispatcher = null;
// M1.3's queue installs the function that turns (event, listeners) into queue items.
export function setDispatcher(fn) { dispatcher = typeof fn === "function" ? fn : null; }

export async function emit(name, payload, ctx = {}) {
  if (!Object.hasOwn(EVENTS, name) && !isEmitted(name)) throw new RegistryError(`event ${name} is not declared`);
  if (!payload || typeof payload !== "object") throw new RegistryError(`event ${name}: payload required`);
  if (typeof payload.id !== "string" || !Number.isSafeInteger(payload.wv)) throw new RegistryError(`event ${name}: payload needs the record id and wv`);
  for (const f of EVENTS[name] || []) {
    if (payload[f] === undefined) throw new RegistryError(`event ${name}: payload needs ${f}`);
  }
  const event = {
    name,
    event_id: eventId(payload.id, payload.wv),
    payload: { ...payload, at: payload.at || nowIso(), by: payload.by || (ctx && ctx.by) || "system" },
  };
  const listeners = listenersFor(name);
  if (!dispatcher) await import("./queue.mjs");
  if (dispatcher) return dispatcher(event, listeners, ctx);
  return { event, listeners: listeners.map((l) => l.module), queued: false };
}

// The marker a listener's queue item runs under (§7.3).
export const listenerMarker = (event_id, module) => ({ ns: "done", scope: "evt", key: `${event_id}--${module}` });
