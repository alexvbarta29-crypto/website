// Contacts module: its part of the contact_stats sidecar and the lifecycle
// machine (design §5.1 "Stats ownership", "Lifecycle machine", §7.6
// contacts.stats, C18).
//
//   statsParts.contacts   { customer_since } (the earliest of the first
//                         completed job, the first payment and created_at),
//                         shown in the contacts index row as `cs`
//   lifecycle listeners   job.completed, payment.succeeded, quote.converted and
//                         plan.activated make a lead or a former customer a
//                         customer (those modules emit them from wave 3 on)
//   contacts.stats sweep  bulk lane, daily 02:30: customer_since for
//                         customers without one; customer → former_customer
//                         after 24 months without service, with no active plan
//                         and no visit ahead (from the index's stats part;
//                         nothing happens until Scheduling and Plans fill it)
//
// A lifecycle change is a change to a field Rotor owns, so before cutover it
// is report-only on imported contacts (a would-update row, §3.10); stats
// parts are derived data and are always written.

import { updateStats, getRecord, updateRecord, readIndex } from "../../../crm-store.mjs";
import { isId } from "../../core/ids.mjs";
import { nowIso, localDate, addLocalDays, now } from "../../core/clock.mjs";
import { contactShard } from "../../core/stats.mjs";

export const FORMER_AFTER_MONTHS = 24;
export const STATS_BATCH = 200;

export const statsParts = {
  contacts: {
    defaults: { customer_since: null },
    row: (p) => ({ cs: (p && p.customer_since) || null }),
  },
};

// The lifecycle after an event that proves someone is a customer (pure).
// → the new lifecycle, or null for no change.
export function lifecycleOnCustomerEvent(c) {
  if (!c || c.merged_into || c.deleted_at) return null;
  if (c.lifecycle === "lead" || c.lifecycle === "former_customer") return "customer";
  return null;
}

// Should this customer become a former customer (pure)? row = the contacts
// index row (contact part + every module's stats part): ls last service date,
// nv next visit date, pl active plans.
export function becomesFormer(row, today) {
  if (!row || row.lc !== "customer") return false;
  if (!row.ls) return false;                        // no service history known: leave alone
  if (row.nv) return false;
  if (Array.isArray(row.pl) ? row.pl.length : row.pl) return false;
  const cutoff = addLocalDays(today, -Math.round(FORMER_AFTER_MONTHS * 30.44));
  return row.ls < cutoff;
}

const earlier = (a, b) => (!a ? b : !b ? a : a < b ? a : b);

// Sets lifecycle customer (when allowed) and customer_since. h = the queue handler context.
async function becomeCustomer(contactId, at, h) {
  if (!isId(contactId, "contact")) return { result: "skipped:no_contact" };
  const got = await getRecord("contact", contactId);
  if (!got) return { result: "skipped:gone" };
  const c = got.data;
  const since = (at || nowIso()).slice(0, 10);
  await updateStats(contactId, "contacts", (p) => (p.customer_since && p.customer_since <= since ? null : { ...p, customer_since: earlier(p.customer_since, since) }), h.ctx.write());
  const next = lifecycleOnCustomerEvent(c);
  if (!next) return { result: "done" };
  if (!h.ctx.mayAct({ record: c })) {
    await h.ctx.would({ record: c }, "update", { lifecycle: [c.lifecycle, next] });
    return { result: "would-update" };
  }
  await updateRecord("contact", contactId, (r) => (lifecycleOnCustomerEvent(r) ? { ...r, lifecycle: next } : null), h.ctx.write());
  return { result: "done" };
}

const onCustomerEvent = (field) => async (event, h) => {
  const p = event.payload || {};
  return becomeCustomer(p.contact_id, p[field] || p.at, h);
};

export const lifecycleListeners = {
  "job.completed": { handler: onCustomerEvent("completed_at"), mutates: true },
  "payment.succeeded": { handler: onCustomerEvent("at"), mutates: true },
  "quote.converted": { handler: onCustomerEvent("at"), mutates: true },
  "plan.activated": { handler: onCustomerEvent("at"), mutates: true },
};

// The contacts.stats sweep. ctx = the sweep context (mayAct, would, write, budget, cursor).
export async function runContactStats(ctx) {
  const ix = await readIndex("contacts", contactShard("ct_00000000000000000000"));
  const today = localDate(now());
  const rows = ix.rows.filter((r) => r.id > (ctx.cursor || "")).sort((a, b) => (a.id < b.id ? -1 : 1));
  let n = 0;
  for (const row of rows) {
    if (n >= STATS_BATCH || (ctx.budget && ctx.budget.left() < 15000)) return { done: false, cursor: rows[n - 1] ? rows[n - 1].id : ctx.cursor, progress: n };
    n += 1;
    if (row.lc === "customer" && !row.cs && row.u) {
      const got = await getRecord("contact", row.id);
      const created = got && got.data.created_at ? got.data.created_at.slice(0, 10) : null;
      if (created) await updateStats(row.id, "contacts", (p) => (p.customer_since ? null : { ...p, customer_since: created }), ctx.write());
    }
    if (becomesFormer(row, today)) {
      const got = await getRecord("contact", row.id);
      if (!got || got.data.lifecycle !== "customer") continue;
      if (!ctx.mayAct({ record: got.data })) {
        await ctx.would({ record: got.data }, "update", { lifecycle: ["customer", "former_customer"] });
        continue;
      }
      await updateRecord("contact", row.id, (r) => (r.lifecycle === "customer" ? { ...r, lifecycle: "former_customer" } : null), ctx.write());
    }
  }
  return { done: true, progress: n };
}
