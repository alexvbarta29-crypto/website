// Barta CRM module "money" (M5): invoices, payments, tips, refunds,
// deposits, credits and autopay (design §5.6, §6.2, §8.1, §9.2, §10.2 rows
// 27-30, §11.4 M5; decisions D2, D3, D28, D31-D33). docs/CRM-MONEY.md
// describes it.
//
// Files: types.mjs (invoice, payment, credit, autopay_run), balance.mjs (the
// pure money rules: totals, the balance mutator, tips, refund splits),
// common.mjs (settings, numbers, the money stats part), gate.mjs (which
// payments driver runs: dry-run until the owner connects keys; the owner's
// Stripe rules), upsert.mjs (one payment, one record), invoices.mjs (making,
// issuing, voiding; job.completed), credits.mjs (account credit,
// overpayments), cards.mjs (the card on file, money.cardStatus), charge.mjs
// (off-session charges under the lock), checkout.mjs (hosted Checkout, the
// dry-run stand-in, the handlers every result goes through), refunds.mjs,
// webhook.mjs (Stripe's events, ownership), autopay.mjs (the 1st-of-month
// run and its preview), deposits.mjs (money.createDepositInvoice),
// automations.mjs (texts and their rules), render.mjs and portal.mjs (the
// customer's pages), routes.mjs (the staff API), import-rotor.mjs (import
// phases and the reconciliation), mcp.mjs (Claude's money tools).
// The Stripe driver is netlify/lib/crm/adapters/payments-stripe.mjs.

import { defineModule } from "../../core/registry.mjs";
import { readIndex, getRecord, updateRecord, listRel, currentScope } from "../../../crm-store.mjs";
import { nowMs } from "../../core/clock.mjs";
import { types } from "./types.mjs";
import { MONEY_DEFAULTS, validateMoneySettings, STATS_DEFAULTS, today, touchMoneyStats, refreshMoneyStats, W, nameOf } from "./common.mjs";
import { onJobCompleted, invoiceBackfill } from "./invoices.mjs";
import { onOverpay } from "./credits.mjs";
import { cardStatus, verifyCards } from "./cards.mjs";
import { onInvoiceIssued, retrySweep } from "./charge.mjs";
import { drySettle } from "./checkout.mjs";
import { webhookRoutes } from "./webhook.mjs";
import { autopayRun, previewSweep } from "./autopay.mjs";
import { createDepositInvoice } from "./deposits.mjs";
import { automations, TEMPLATES, overdueSweep, cardExpiringSweep } from "./automations.mjs";
import { portalRoutes } from "./portal.mjs";
import { moneyRoutes } from "./routes.mjs";
import { phases, reconcile } from "./import-rotor.mjs";
import { reconcileSweep } from "./reconcile.mjs";
import { mcpTools } from "./mcp.mjs";

// §5.1 merge: b's invoices, payments and credits move to the survivor a.
async function onMergeMoney(a, b, ctx = {}) {
  const w = W(ctx);
  const s = await getRecord("contact", a);
  const name = s ? nameOf(s.data) : undefined;
  for (const [type, rel] of [["invoice", "contact-invoices"], ["payment", "contact-payments"], ["credit", "contact-credits"]]) {
    for (const row of await listRel(rel, b, { limit: 500 })) {
      await updateRecord(type, row.id, (r) => (r.contact_id === b ? { ...r, contact_id: a, ...(name && type !== "credit" ? { contact_name: name } : {}) } : null), w).catch(() => null);
    }
  }
  await touchMoneyStats(a, w);
}

// Home's "Needs you" rows (§9.2): each count is the open invoices index,
// read once per request however many rows ask (Home's own memo, or this one).
const memo = new WeakMap();
async function openRows() {
  const sc = currentScope();
  if (!sc) return (await readIndex("invoices", "open")).rows;
  if (!memo.has(sc)) memo.set(sc, readIndex("invoices", "open").then((ix) => ix.rows));
  return memo.get(sc);
}
const unpaid = async () => (await openRows()).filter((r) => r.st === "open" && r.bal > 0 && !r.im).length;
const overdue = async () => { const day = today(); return (await openRows()).filter((r) => r.st === "open" && r.bal > 0 && !r.im && r.due && r.due < day).length; };
const failed = async () => (await openRows()).filter((r) => r.st === "open" && r.af && !r.im).length;
// an overpayment nobody decided on keeps its invoice in the open shard (types.mjs invoiceShard)
const overpaid = async () => (await openRows()).filter((r) => r.ex > 0 && !r.xk).length;

export default defineModule({
  name: "money",
  types,
  statsParts: {
    // the money part of ContactStats (§5.1): lifetime paid, open balance, the card on file
    money: { defaults: { ...STATS_DEFAULTS, stripe: { ...STATS_DEFAULTS.stripe } }, row: (p) => ({ mb: (p && p.open_balance_cents) || 0, ml: (p && p.lifetime_cents) || 0, mcs: (p && p.stripe && p.stripe.card_status) || "none" }) },
  },
  settings: { money: { defaults: { ...MONEY_DEFAULTS }, validate: validateMoneySettings, perm: "settings:owner" } },
  routes: [...moneyRoutes, ...webhookRoutes],
  portalRoutes,
  events: {
    "job.completed": { handler: onJobCompleted, mutates: true },
    "invoice.issued": { handler: onInvoiceIssued, mutates: true },
    "payment.succeeded": { handler: onOverpay, mutates: true },
    "payment.refunded": { handler: onOverpay, mutates: true },
  },
  emits: ["invoice.issued", "invoice.sent", "invoice.paid", "payment.processing", "payment.succeeded", "payment.failed", "payment.refunded", "card.saved"],
  services: {
    // (quote, version, option, opId, ctx) → { invoice_id?, checkout_url? }
    "money.createDepositInvoice": (quote, version, option, opId, ctx) => createDepositInvoice(quote, version, option, opId, ctx || {}),
    // (contact_id, ctx) → { status, pm? }
    "money.cardStatus": (contactId) => cardStatus(contactId),
    // the CRM's side of the import report's money comparison (§10.8)
    "money.reconcileImport": (input) => reconcile(input || {}),
  },
  needs: ["notify.users", "stats.update", "bulk.create"],
  sweeps: [
    { key: "money.dry_settle", label: "Test bank payments clearing", lane: "fast", every: "pass", mutates: true, run: (ctx) => drySettle(ctx) },
    { key: "money.autopay", label: "The 1st-of-month autopay run", lane: "fast", every: "monthly", day: 1, at_local: "09:00", mutates: true, run: (ctx) => autopayRun(ctx) },
    { key: "money.autopay_preview", label: "Autopay preview", lane: "fast", every: "monthly", day: 28, at_local: "09:00", mutates: false, run: (ctx) => previewSweep(ctx) },
    { key: "money.retry", label: "Autopay retries", lane: "fast", every: "daily", at_local: "09:00", mutates: true, run: (ctx) => retrySweep(ctx) },
    { key: "money.invoice_backfill", label: "Invoices for finished jobs", lane: "fast", every: "hourly", mutates: true, run: (ctx) => invoiceBackfill(ctx) },
    { key: "invoice.overdue", label: "Overdue reminders", lane: "fast", every: "daily", at_local: "10:00", mutates: false, run: (ctx) => overdueSweep(ctx) },
    { key: "card.expiring", label: "Cards about to expire", lane: "fast", every: "daily", at_local: "10:05", mutates: false, run: (ctx) => cardExpiringSweep(ctx) },
    { key: "money.reconcile", label: "Invoices against their payments", lane: "bulk", every: "daily", at_local: "03:30", mutates: true, run: (ctx) => reconcileSweep(ctx) },
    // what each customer owes (hourly) and has paid in all (nightly), from the indexes: derived stats only
    { key: "money.stats", label: "Customer balances", lane: "bulk", every: "hourly", mutates: false, run: (ctx) => refreshMoneyStats(ctx) },
    { key: "money.stats_lifetime", label: "Customer lifetime totals", lane: "bulk", every: "daily", at_local: "03:40", mutates: false, run: (ctx) => refreshMoneyStats(ctx, { lifetime: true }) },
    { key: "payments.verify_cards", label: "Cards on file check", lane: "bulk", every: "weekly", dow: 1, at_local: "05:00", mutates: false, run: (ctx) => verifyCards(ctx) },
  ],
  automations,
  templates: TEMPLATES,
  onMerge: onMergeMoney,
  attention: [
    { key: "payments.failed", label: "Card payments that failed", perm: "invoices:read_all", count: failed, link: "#/invoices?status=failed" },
    { key: "invoices.overdue", label: "Invoices past due", perm: "invoices:read_all", count: overdue, link: "#/invoices?status=overdue" },
    // listed on Home, never lights the tab's dot
    { key: "invoices.unpaid", label: "Invoices waiting to be paid", perm: "invoices:read_all", count: unpaid, link: "#/invoices?status=open", badge: false },
  ],
  approvals: [
    { kind: "money.overpayment", label: "Overpayments to refund or keep", perm: "payments:refund", count: overpaid, link: "#/invoices?status=overpaid" },
  ],
  pushKinds: ["payment", "payment_failed"],
  activityKinds: {
    "invoice.created": { label: "Invoice made", icon: "doc" },
    "invoice.paid": { label: "Invoice paid", icon: "money" },
    "payment.succeeded": { label: "Payment received", icon: "money" },
    "credit.issued": { label: "Credit added", icon: "gift" },
  },
  exportTypes: ["invoice", "payment", "credit", "autopay_run"],
  mcpTools,
  importPhases: phases,
});

export { nowMs };
