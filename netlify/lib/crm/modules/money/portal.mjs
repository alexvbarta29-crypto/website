// Money module: the customer's pages (design §8.1, §8.5), registered through
// portalRoutes; crm-portal.mjs and portal/core.mjs (core) check the link's
// scope before any of these run, send the portal headers and CSP, and
// require X-CRM-Portal: 1 on POSTs. GET pages never change anything.
//
//   GET  /p/invoice/:id                          the invoice (scope invoice)
//   GET  /p/invoice/:id/receipt/:payment         a receipt of one of its payments
//   POST /api/portal/invoices/:id/checkout       { tip_choice, custom_tip_cents?, save_card } → { url }
//                                                (409 while a charge or a bank payment is in flight)
//   GET  /p/receipt/:id                          a receipt (scope receipt: the link in the receipt text)
//   GET  /p/card · POST /api/portal/card/checkout   add or update the card on file (scope card)
//   GET  /p/dry-checkout/:session                the dry-run stand-in for Stripe Checkout (sandboxed
//   POST /api/portal/dry-checkout/:session       subjects only; 404 once payments are test or live)
//   /p/return?cs=                                core's page; this module resolves the session
//
// The dry-run Checkout page is "public" to the portal frame (like Stripe's
// own page, it is opened by its unguessable session id), but it only ever
// exists for a session this module recorded, in dry-run, for a sandboxed
// invoice or contact.

import { getRecord, getRecords, listRel, withStoreScope, withBudget } from "../../../crm-store.mjs";
import { isId } from "../../core/ids.mjs";
import { ConflictError, InputError, NotFoundError } from "../../core/errors.mjs";
import { definePortalReturn } from "../../portal/core.mjs";
import { safeErr } from "../../../referral-lib.mjs";
import { moneySettings, liveContact, sysModeOf } from "./common.mjs";
import { paymentsOf } from "./invoices.mjs";
import { cardStatus } from "./cards.mjs";
import { payments, mayMoveMoney } from "./gate.mjs";
import { startInvoiceCheckout, startSetupCheckout, payRefusal, drySession, completeDryCheckout, resolveReturn } from "./checkout.mjs";
import { renderInvoicePage, renderReceiptPage, renderCardPage, renderReturnPage, renderDryCheckout } from "./render.mjs";

// Applying a payment writes the payment, the invoice, the customer's money
// stats and their events: more storage calls than a portal page's 30. The
// two places a portal request applies one (the practice Checkout's buttons,
// the return page reading a session before Stripe's webhook lands) get
// their own budget, as the staff routes that record payments do.
const APPLY_CALLS = 160;
const withApplyBudget = (fn) => withStoreScope({ budget: withBudget(8000, APPLY_CALLS) }, fn);

// One invoice for this page: it must belong to the link's contact.
async function invoiceFor(p, id) {
  if (!isId(id, "invoice")) return null;
  const g = await getRecord("invoice", id).catch(() => null);
  if (!g || g.data.deleted_at || g.data.contact_id !== p.contact_id) return null;
  return g.data;
}

const answer = (p, fn) => fn().catch((e) => {
  if (e instanceof ConflictError) return p.fail(e.code || "conflict", e.message, 409);
  if (e instanceof InputError) return p.json({ ok: false, error: { code: "invalid", message: e.message, field: e.field } }, 400);
  if (e instanceof NotFoundError) return p.fail("not_found", e.message || "Not found.", 404);
  throw e;
});

async function hasCardPlan(contactId) {
  const rows = await listRel("contact-plans", contactId, { limit: 20 }).catch(() => []);
  const plans = (await getRecords("plan", rows.map((r) => r.id)).catch(() => [])).filter(Boolean);
  return plans.some((g) => ["pending", "active", "paused", "cancelling"].includes(g.data.status) && g.data.billing && (g.data.billing.autopay || g.data.billing.card_required));
}

async function invoicePage(p) {
  const inv = await invoiceFor(p, p.params.id);
  if (!inv) return p.message("That invoice isn't here", "Check the link in your text or email, or call us.", { status: 404, company: p.company });
  const mode = await sysModeOf({});
  const [pays, contact, settings, gate, plan] = await Promise.all([paymentsOf(inv.id), liveContact(inv.contact_id), moneySettings(), payments({ mode }), hasCardPlan(inv.contact_id)]);
  const refusal = ["open"].includes(inv.status) ? await payRefusal(inv, { sor: mode.system_of_record }) : null;
  const { title, body } = renderInvoicePage({ invoice: inv, payments: pays, contact, company: p.company, settings, refusal: refusal || (!gate.impl ? { code: "paused", message: "Online payment is paused right now. Call or text us." } : null), plan, dry: gate.mode === "dry_run" });
  return p.portalPage(p.layout({ title, body, script: "money-invoice.js", company: p.company, page: "invoice" }));
}

async function receiptPage(p, paymentId, invoice) {
  const g = isId(paymentId, "payment") ? await getRecord("payment", paymentId).catch(() => null) : null;
  const pay = g && g.data;
  if (!pay || pay.contact_id !== p.contact_id || pay.kind !== "payment" || (invoice && pay.invoice_id !== invoice.id)) return p.message("That receipt isn't here", "Check the link in your text or email, or call us.", { status: 404, company: p.company });
  const inv = invoice || (isId(pay.invoice_id, "invoice") ? ((await getRecord("invoice", pay.invoice_id).catch(() => null)) || {}).data : null);
  const { title, body } = renderReceiptPage({ payment: pay, invoice: inv, company: p.company, back: invoice ? `/p/invoice/${invoice.id}` : null });
  return p.portalPage(p.layout({ title, body, company: p.company, page: "receipt" }));
}

async function cardPage(p) {
  const contact = await liveContact(p.contact_id);
  if (!contact) return p.message("We couldn't find your account", "Call or text us and we'll help.", { status: 404, company: p.company });
  const mode = await sysModeOf({});
  const [card, gate, settings] = await Promise.all([cardStatus(contact.id), payments({ mode }), moneySettings()]);
  const ok = await mayMoveMoney(contact, { sor: mode.system_of_record, contact });
  const refusal = !gate.impl ? "Adding a card is paused right now. Call or text us." : !ok ? "Adding a card online opens soon. Call or text us and we'll help." : null;
  const { title, body } = renderCardPage({ contact, card, company: p.company, refusal, dry: gate.mode === "dry_run", ach: settings.ach });
  return p.portalPage(p.layout({ title, body, script: "money-card.js", company: p.company, page: "card" }));
}

// The dry-run Checkout only exists while payments are in dry run.
async function dryOpen() {
  const gate = await payments({ mode: await sysModeOf({}) });
  return gate.mode === "dry_run";
}

export const portalRoutes = [
  { method: "GET", path: "/p/invoice/:id", scope: "invoice", handler: invoicePage },
  {
    method: "GET", path: "/p/invoice/:id/receipt/:payment", scope: "invoice",
    handler: async (p) => { const inv = await invoiceFor(p, p.params.id); return inv ? receiptPage(p, p.params.payment, inv) : p.message("That receipt isn't here", "Check the link in your text or email, or call us.", { status: 404, company: p.company }); },
  },
  {
    method: "POST", path: "/api/portal/invoices/:id/checkout", scope: "invoice",
    handler: (p) => answer(p, async () => {
      const b = p.body || {};
      const custom = b.custom_tip_cents === undefined || b.custom_tip_cents === null || b.custom_tip_cents === "" ? undefined : Number(b.custom_tip_cents);
      if (custom !== undefined && !Number.isSafeInteger(custom)) throw new InputError("Enter the tip as dollars and cents.", "custom_tip_cents");
      const out = await startInvoiceCheckout(p.params.id, p.contact_id, { tip_choice: b.tip_choice, custom_tip_cents: custom, save_card: b.save_card === true || b.save_card === "true" }, p.write());
      return p.json({ ok: true, data: { url: out.url, tip_cents: out.tip_cents } });
    }),
  },
  { method: "GET", path: "/p/receipt/:id", scope: "receipt", handler: (p) => receiptPage(p, p.params.id, null) },
  { method: "GET", path: "/p/card", scope: "card", handler: cardPage },
  {
    method: "POST", path: "/api/portal/card/checkout", scope: "card",
    handler: (p) => answer(p, async () => p.json({ ok: true, data: { url: (await startSetupCheckout(p.contact_id, p.write())).url } })),
  },
  {
    method: "GET", path: "/p/dry-checkout/:session", scope: "public",
    handler: async (p) => {
      const d = (await dryOpen()) ? await drySession(p.params.session) : null;
      if (!d) return p.message("This page isn't here", "Go back to your invoice and tap Pay again.", { status: 404, company: p.company });
      const { title, body } = renderDryCheckout({ sid: p.params.session, ptr: d.ptr, invoice: d.invoice });
      return p.portalPage(p.layout({ title, body, script: "money-dry.js", company: p.company, page: "dry-checkout" }));
    },
  },
  {
    method: "POST", path: "/api/portal/dry-checkout/:session", scope: "public",
    handler: (p) => answer(p, async () => {
      if (!(await dryOpen())) return p.fail("not_found", "Not found.", 404);
      const b = p.body || {};
      const out = await withApplyBudget(() => completeDryCheckout(p.params.session, { action: String(b.action || ""), method: String(b.method || "card") }, { by: "portal", origin: "portal", actor_kind: "portal", requestId: "portal" }));
      if (out.error) return p.fail(out.error, out.message, 409);
      return p.json({ ok: true, data: { location: out.location } });
    }),
  },
];

// /p/return?cs=: resolved on the server with the portal cookie (no portal
// token ever goes to Stripe).
definePortalReturn(async ({ url, session, company, layout, portalPage }) => {
  const sid = url.searchParams.get("cs") || "";
  let result = null;
  try { result = await withApplyBudget(() => resolveReturn(sid, session, { by: "portal", origin: "portal", actor_kind: "portal", requestId: "portal" })); } catch (e) { console.error(`crm:money: the return page failed (${safeErr(e)})`); }
  if (!result) result = { kind: "pending", title: "Thank you", text: "We're confirming your payment. You'll get a receipt by text or email in a moment." };
  const { title, body } = renderReturnPage({ result });
  return portalPage(layout({ title, body, company, page: "return" }));
});
