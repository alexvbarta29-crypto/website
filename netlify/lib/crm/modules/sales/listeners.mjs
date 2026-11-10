// Sales module: what sales does when something happens elsewhere (design
// §11.3 "Events", §5.2). Each listener is a queue item with its own marker
// (done/evt/{event_id}--sales), re-reads what it acts on and acts on its
// current state, and runs as automation: on a deal or enrollment the import
// brought in it only writes a would- row before cutover (§0 rule 12).
//
//   lead.created            enroll in each active cadence that starts on a new
//                           lead and lets this contact in (the intake already
//                           enrolled most leads: one open enrollment per
//                           contact and cadence, so this is a backstop and
//                           the office's own new leads)
//   quote.sent              deal → quoted; the new-lead cadence hands over to
//                           the estimate follow-up (first send of a quote)
//   quote.approved/converted deal → won; follow-ups end (won)
//   quote.declined          deal → lost; the quote's follow-up stops
//   quote.changes_requested the quote's follow-up stops (they replied); a task
//   quote.archived          deal → lost (no response) unless it closed already
//   job.completed           a job booked without a quote: deal → won, follow-ups end
//   consent.changed         a STOP (or texts revoked) stops every follow-up
//   message.inbound         a reply pauses (or stops) the follow-ups, makes a task
//   call.logged             an inbound call does the same (backstop for calls
//                           logged elsewhere than POST /calls)

import { getRecord, readPointer } from "../../../crm-store.mjs";
import { isId } from "../../core/ids.mjs";
import { safeErr } from "../../../referral-lib.mjs";
import { readIndex } from "../../../crm-store.mjs";
import { enroll, openEnrollmentsOf, enrollmentsOf, stopEnrollment, cadenceById } from "./enroll.mjs";
import { exitsOn } from "./cadence.mjs";
import { markDeal, openDealOf } from "./deals.mjs";
import { inboundOnEnrollments } from "./calls.mjs";
import { followUpTask } from "./tasks.mjs";
import { contactOf, nameOf, leadPeople } from "./common.mjs";
import { OPEN_DEAL } from "./types.mjs";

const STOP_KEYWORDS = new Set(["STOP", "STOPALL", "UNSUBSCRIBE", "CANCEL", "END", "QUIT", "OPTOUT", "REVOKE"]);
const done = (result) => ({ result });

// Cadences a new lead may join (active, with steps, starting on lead.created).
async function leadCadences() {
  const ix = await readIndex("cadences", "");
  return ix.rows.filter((r) => r.act && !r.bo && r.s > 0 && r.on === "lead.created").map((r) => r.k);
}

export async function onLeadCreated(event, h) {
  const p = event.payload || {};
  const contact = await contactOf(p.contact_id, h.ctx);
  if (!contact) return done("skipped:no_contact");
  if (!(await h.ctx.mayAct({ record: contact }))) { await h.ctx.would(contact.id, "enroll"); return done("would-enroll"); }
  let keys = await leadCadences();
  if (!keys.length) keys = ["new_lead"];                // before the seed's first pass
  const recent = await enrollmentsOf(contact.id, { limit: 10 });
  let n = 0;
  for (const key of keys) {
    // the intake enrolled this lead a moment ago (and someone may already have ended it): leave it
    const fresh = recent.find((e) => e.cadence_key === key && Date.parse(e.started_at || e.created_at) >= Date.parse(p.at || 0) - 60000);
    if (fresh) continue;
    try { if (await enroll(contact.id, key, {}, h.ctx.write())) n += 1; } catch (e) { console.error(`crm:sales: enrollment not started (${safeErr(e)})`); throw e; }
  }
  return done(n ? `enrolled:${n}` : "done");
}

async function dealOfEvent(p) {
  if (isId(p.deal_id, "deal")) {
    const g = await getRecord("deal", p.deal_id);
    if (g) return g.data;
  }
  return isId(p.contact_id, "contact") ? openDealOf(p.contact_id) : null;
}

async function stopFor(contactId, reason, h, { exit, quoteId } = {}) {
  let n = 0;
  for (const e of await openEnrollmentsOf(contactId)) {
    const cadence = await cadenceById(e.cadence_id);
    const forQuote = quoteId && e.quote_id === quoteId;
    if (!forQuote && exit && !exitsOn(cadence, exit)) continue;
    const r = await stopEnrollment(e.id, reason, h.ctx);
    if (r.changed) n += 1;
  }
  return n;
}

export async function onQuoteSent(event, h) {
  const p = event.payload || {};
  const contact = await contactOf(p.contact_id, h.ctx);
  if (!contact) return done("skipped:no_contact");
  const deal = await dealOfEvent({ ...p, contact_id: contact.id });
  if (deal) await markDeal(deal.id, "quoted", { quote_id: p.quote_id }, h.ctx);
  await stopFor(contact.id, "quote_sent", h, { exit: "quote_sent" });
  // first send of this quote only: a resent quote doesn't restart the follow-up
  const all = await enrollmentsOf(contact.id, { limit: 30 });
  if (isId(p.quote_id, "quote") && all.some((e) => e.quote_id === p.quote_id)) return done("already_following_up");
  if (!(await h.ctx.mayAct({ record: contact }))) { await h.ctx.would(contact.id, "enroll"); return done("would-enroll"); }
  const id = await enroll(contact.id, "estimate_followup", { quote_id: isId(p.quote_id, "quote") ? p.quote_id : undefined, deal_id: deal ? deal.id : undefined, skip_entry_rules: true }, h.ctx.write());
  return done(id ? "enrolled" : "skipped:cadence");
}

export async function onQuoteWon(event, h) {
  const p = event.payload || {};
  const contact = await contactOf(p.contact_id, h.ctx);
  if (!contact) return done("skipped:no_contact");
  const deal = await dealOfEvent({ ...p, contact_id: contact.id });
  if (deal) await markDeal(deal.id, "won", { quote_id: p.quote_id, ...(Array.isArray(p.job_ids) && p.job_ids[0] ? { job_id: p.job_ids[0] } : {}), ...(p.plan_id ? { plan_id: p.plan_id } : {}) }, h.ctx);
  await stopFor(contact.id, "won", h, { exit: "quote_approved", quoteId: p.quote_id });
  return done("done");
}

export async function onQuoteDeclined(event, h) {
  const p = event.payload || {};
  const contact = await contactOf(p.contact_id, h.ctx);
  if (!contact) return done("skipped:no_contact");
  const deal = await dealOfEvent({ ...p, contact_id: contact.id });
  if (deal) await markDeal(deal.id, "lost", { reason: "other", note: "Quote declined.", quote_id: p.quote_id }, h.ctx);
  await stopFor(contact.id, "lost", h, { exit: "quote_declined", quoteId: p.quote_id });
  return done("done");
}

export async function onQuoteChanges(event, h) {
  const p = event.payload || {};
  const contact = await contactOf(p.contact_id, h.ctx);
  if (!contact) return done("skipped:no_contact");
  const n = await stopFor(contact.id, "replied", h, { exit: "changes_requested", quoteId: p.quote_id });
  const people = await leadPeople(contact);
  await followUpTask(contact, { title: `Quote changes requested: ${nameOf(contact)}`, kind: "follow_up", assignee_ids: people.slice(0, 3), seed: `${event.event_id}--changes` }, h.ctx.write());
  return done(`stopped:${n}`);
}

export async function onQuoteArchived(event, h) {
  const p = event.payload || {};
  const contact = await contactOf(p.contact_id, h.ctx);
  if (!contact) return done("skipped:no_contact");
  const deal = await dealOfEvent({ ...p, contact_id: contact.id });
  if (deal && OPEN_DEAL.includes(deal.status)) await markDeal(deal.id, "lost", { reason: "no_response", quote_id: p.quote_id }, h.ctx);
  await stopFor(contact.id, "expired", h, { quoteId: p.quote_id, exit: "__none__" });
  return done("done");
}

export async function onJobCompleted(event, h) {
  const p = event.payload || {};
  const contact = await contactOf(p.contact_id, h.ctx);
  if (!contact) return done("skipped:no_contact");
  const deal = await openDealOf(contact.id);
  if (deal) await markDeal(deal.id, "won", { job_id: isId(p.job_id, "job") ? p.job_id : undefined, plan_id: isId(p.plan_id, "plan") ? p.plan_id : undefined }, h.ctx);
  await stopFor(contact.id, "booked", h, { exit: "booked" });
  return done("done");
}

// Contacts an opt-out names: the event's, else everyone on that number.
async function contactsForConsent(p) {
  if (isId(p.contact_id, "contact")) return [p.contact_id];
  if (p.channel === "sms" && typeof p.address_hk === "string") {
    const ptr = await readPointer("phone", p.address_hk).catch(() => null);
    return (ptr && Array.isArray(ptr.ids) ? ptr.ids : []).filter((x) => isId(x, "contact")).slice(0, 10);
  }
  return [];
}

export async function onConsentChanged(event, h) {
  const p = event.payload || {};
  const optedOut = (p.channel === "sms" && p.state === "opted_out") || (p.channel === "sms_service" && p.state === "revoked");
  if (!optedOut) return done("skipped:not_an_opt_out");
  let n = 0;
  for (const id of await contactsForConsent(p)) {
    const contact = await contactOf(id, h.ctx);
    if (!contact) continue;
    for (const e of await openEnrollmentsOf(contact.id)) {
      const r = await stopEnrollment(e.id, "opted_out", h.ctx);
      if (r.changed) n += 1;
    }
  }
  return done(`stopped:${n}`);
}

export async function onInbound(event, h) {
  const p = event.payload || {};
  const contact = await contactOf(p.contact_id, h.ctx);
  if (!contact) return done("skipped:no_contact");
  const kw = String(p.keyword || "").trim().toUpperCase();
  if (STOP_KEYWORDS.has(kw)) {
    let n = 0;
    for (const e of await openEnrollmentsOf(contact.id)) { const r = await stopEnrollment(e.id, "opted_out", h.ctx); if (r.changed) n += 1; }
    return done(`stopped:${n}`);
  }
  if (kw === "START" || kw === "HELP" || kw === "UNSTOP" || kw === "INFO") return done("skipped:keyword");
  const res = await inboundOnEnrollments(contact, "replied", { ctx: h.ctx, by: "system", kind: "reply" });
  return done(`paused:${res.enrollments.length}`);
}

export async function onCallLogged(event, h) {
  const p = event.payload || {};
  if (p.direction !== "in") return done("skipped:outbound");
  const contact = await contactOf(p.contact_id, h.ctx);
  if (!contact) return done("skipped:no_contact");
  const open = (await openEnrollmentsOf(contact.id)).filter((e) => e.status === "active");
  if (!open.length) return done("done");
  const res = await inboundOnEnrollments(contact, "inbound_call", { ctx: h.ctx, by: "system", kind: "call" });
  return done(`paused:${res.enrollments.length}`);
}

export const listeners = {
  "lead.created": { handler: onLeadCreated, mutates: true },
  "quote.sent": { handler: onQuoteSent, mutates: true },
  "quote.approved": { handler: onQuoteWon, mutates: true },
  "quote.converted": { handler: onQuoteWon, mutates: true },
  "quote.declined": { handler: onQuoteDeclined, mutates: true },
  "quote.changes_requested": { handler: onQuoteChanges, mutates: true },
  "quote.archived": { handler: onQuoteArchived, mutates: true },
  "job.completed": { handler: onJobCompleted, mutates: true },
  "consent.changed": { handler: onConsentChanged, mutates: true },
  "message.inbound": { handler: onInbound, mutates: true },
  "call.logged": { handler: onCallLogged, mutates: true },
};

export { safeErr };
