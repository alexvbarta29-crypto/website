// Money module: money.reconcile (design §7.6; bulk lane, daily 03:30).
//
// An invoice's `applied` map is derived from its payment records (the
// records are the truth: one per provider object). This sweep rebuilds each
// invoice's map from the payments that point at it (rel/invoice-payments)
// and repairs a map that disagrees: an entry whose payment is gone or
// belongs elsewhere is dropped, a payment the map never heard of (a function
// that died between the payment write and the invoice CAS) is added, a
// status the map is behind on moves forward. Paid, balance and status then
// follow from the pure mutator; an invoice the repair makes paid emits
// invoice.paid like any other path. Derived data only: it runs for imported
// invoices too and never touches a field the import owns.

import { getRecord, updateRecord, readIndex, listKeys } from "../../../crm-store.mjs";
import { emit } from "../../core/events.mjs";
import { updateHealth, withAlert } from "../../core/lanes.mjs";
import { safeErr } from "../../../referral-lib.mjs";
import { paymentsOf } from "./invoices.mjs";
import { touchMoneyStats } from "./common.mjs";

const entryOf = (p, at) => ({ kind: p.kind, amount_cents: p.amount_cents || 0, tip_cents: p.tip_cents || 0, status: p.status, ...(p.simulated ? { simulated: true } : {}), at: at || p.created_at });
const same = (a, b) => !!a && !!b && a.kind === b.kind && a.amount_cents === b.amount_cents && (a.tip_cents || 0) === (b.tip_cents || 0) && a.status === b.status && !!a.simulated === !!b.simulated;

// The applied map an invoice should have, from its payment records.
export function expectedApplied(inv, pays) {
  const out = {};
  for (const p of pays) {
    if (!p || p.deleted_at || p.invoice_id !== inv.id) continue;
    out[p.id] = entryOf(p, inv.applied && inv.applied[p.id] && inv.applied[p.id].at);
  }
  return out;
}
export function appliedDiffers(inv, expected) {
  const have = inv.applied || {};
  const keys = new Set([...Object.keys(have), ...Object.keys(expected)]);
  for (const k of keys) if (!same(have[k], expected[k])) return true;
  return false;
}

// → true when the invoice's map was rebuilt.
export async function reconcileInvoice(invoiceId, ctx = {}) {
  const g = await getRecord("invoice", invoiceId);
  if (!g || g.data.deleted_at) return false;
  const pays = await paymentsOf(invoiceId);
  if (!appliedDiffers(g.data, expectedApplied(g.data, pays))) return false;
  let wasPaid = false;
  const r = await updateRecord("invoice", invoiceId, (inv) => {
    wasPaid = inv.status === "paid";
    const want = expectedApplied(inv, pays);
    return appliedDiffers(inv, want) ? { ...inv, applied: want } : null;
  }, ctx);
  if (r.changed && !wasPaid && r.data.status === "paid") {
    await emit("invoice.paid", { id: r.data.id, wv: r.data.wv, invoice_id: r.data.id, contact_id: r.data.contact_id, amount_cents: r.data.total_cents || 0 }, ctx)
      .catch((e) => console.error(`crm:money: invoice.paid not queued (${safeErr(e)})`));
  }
  if (r.changed) await touchMoneyStats(r.data.contact_id, ctx);
  return r.changed;
}

export async function reconcileSweep(ctx) {
  const shards = [...new Set((await listKeys("ix/invoices/").catch(() => [])).map((k) => k.slice("ix/invoices/".length)).filter((s) => s && !s.includes("/")))].sort();
  const cur = ctx.cursor && typeof ctx.cursor === "object" ? ctx.cursor : { s: 0, i: 0, checked: 0, repaired: 0 };
  let { s, i, checked, repaired } = cur;
  const w = ctx.write();
  for (; s < shards.length; s++, i = 0) {
    const rows = (await readIndex("invoices", shards[s])).rows.sort((a, b) => String(a.id).localeCompare(String(b.id)));
    for (; i < rows.length; i++) {
      if (ctx.budget && ctx.budget.left() < 10000) return { done: false, cursor: { s, i, checked, repaired }, progress: checked };
      try { if (await reconcileInvoice(rows[i].id, w)) repaired += 1; } catch (e) { console.error(`crm:money: an invoice wasn't reconciled (${safeErr(e)})`); }
      checked += 1;
    }
  }
  if (repaired > 0) await updateHealth((h) => withAlert(h, "money.reconcile", `${repaired} invoice${repaired === 1 ? "" : "s"} had payments out of step and ${repaired === 1 ? "was" : "were"} repaired last night.`, "info"));
  return { progress: checked, result: `checked ${checked}, repaired ${repaired}` };
}
