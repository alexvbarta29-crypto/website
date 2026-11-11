// Money module: quote deposits and "card required" (design §5.6 "Deposits",
// §5.3; the money.createDepositInvoice service the quote's approve op calls).
//
// (quote, version, option, opId, ctx) → { invoice_id?, checkout_url? }
//   - a deposit (fixed cents, or basis points of the first visit's price):
//     a deposit invoice D-NNNN, issued at once, and a fresh Checkout Session
//     for it (the customer's approval page goes straight there; with "card
//     required" the card is saved for later charges). The job's invoice
//     later credits it (a deposit_credit line, invoices.mjs).
//   - "card required" with no deposit: a Checkout Session in setup mode.
// A retry of the approve op lands on the same invoice (its id derives from
// the quote and the approval's number); a new session is made each time
// (sessions last an hour). Where online payment isn't open (a customer
// Rotor still owns, payments paused) the invoice is still made and its
// link is sent the usual way.

import { percentOfBps } from "../../core/money.mjs";
import { safeErr } from "../../../referral-lib.mjs";
import { depositInvoiceId, makeInvoice } from "./invoices.mjs";
import { startInvoiceCheckout, startSetupCheckout } from "./checkout.mjs";
import { W } from "./common.mjs";
import { emit } from "../../core/events.mjs";

export function depositCents(quote, option) {
  const dep = (quote && quote.agreement && quote.agreement.deposit) || {};
  const first = (option && option.totals && option.totals.first_cents) || 0;
  if (dep.type === "fixed") return Math.max(0, Math.min(dep.value || 0, first || dep.value || 0));
  if (dep.type === "percent") return first > 0 ? percentOfBps(first, Math.max(0, Math.min(10000, dep.value || 0))) : 0;
  return 0;
}

export async function createDepositInvoice(quote, version, option, opId, ctx = {}) {
  const ag = (quote && quote.agreement) || {};
  const amount = depositCents(quote, option);
  const saveCard = ag.require_card === true;
  if (!(amount > 0)) {
    if (!saveCard) return {};
    try { return { checkout_url: (await startSetupCheckout(quote.contact_id, ctx)).url }; } catch (e) { return {}; }
  }
  const id = depositInvoiceId(quote.id, quote.approvals_count || 1);
  const inv = await makeInvoice({
    invoice: {
      id, kind: "deposit", contact_id: quote.contact_id, ...(quote.property_id ? { property_id: quote.property_id } : {}), job_ids: [], quote_id: quote.id, deposit_of: quote.id,
      lines: [{ id: "dep", kind: "service", description: `Deposit: ${String((option && option.name) || "your quote").slice(0, 120)}`, qty_milli: 1000, unit_cents: amount, total_cents: amount }], origin: "quote.approved",
    },
    issue: true, silent: true, credit: false, links: { job_ids: [] },
  }, ctx);
  let url = null;
  if (inv.status === "open" && inv.balance_cents > 0) {
    try { url = (await startInvoiceCheckout(inv.id, quote.contact_id, { tip_choice: "0", save_card: saveCard }, ctx)).url; } catch (e) {
      // no online payment for this one right now: the link goes out the usual way
      const w = W(ctx);
      await emit("invoice.sent", { id: `${inv.id}.sent`, wv: inv.wv, invoice_id: inv.id, contact_id: inv.contact_id, channels: ["sms", "email"], wait_for_charge: false, by: "system:deposit" }, w)
        .catch((x) => console.error(`crm:money: invoice.sent not queued (${safeErr(x)})`));
    }
  }
  return { invoice_id: inv.id, ...(url ? { checkout_url: url } : {}) };
}
