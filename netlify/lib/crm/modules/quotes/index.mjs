// Barta CRM module "quotes" (M3a): the price book, the Barta pricing
// engine, discounts with visit-ordinal scope, quotes with one-time and plan
// options, frozen versions, the customer's approval page with one
// signature (and the plan's agreement under it), Present to customer, and
// conversion into a plan or jobs (design §5.3, §8, §9.2, §10.2 rows 4, 5,
// 18, §11.4 M3a). docs/CRM-QUOTES.md describes it.
//
// Files: types.mjs (price_item, discount_def, quote, quote_version),
// pricing.mjs (the engine, pure), seed.mjs (price book, discount catalog,
// templates), quotes.mjs (the lifecycle), versions.mjs (frozen versions),
// approve.mjs (approval and conversion runs and ops), render.mjs (the
// customer's view), portal.mjs (the portal pages and Present to customer),
// routes.mjs (the staff API), automations.mjs (quote.sent, quotes.expire),
// import-rotor.mjs (import phases), mcp.mjs (Claude's quote tools).

import { defineModule } from "../../core/registry.mjs";
import { getRecord, updateRecord, readIndex } from "../../../crm-store.mjs";
import { defineFileOwner } from "../../core/files.mjs";
import { types } from "./types.mjs";
import { PRICING_DEFAULTS, validatePricing, suggestOption, optionTotals, pricingWith } from "./pricing.mjs";
import { seedPriceBook, TEMPLATES } from "./seed.mjs";
import { applyOffer, archiveForSales, onMergeQuotes, loadPricing, priceBook, discountDefs } from "./quotes.mjs";
import { approvedVersion } from "./versions.mjs";
import "./approve.mjs";
import { portalRoutes } from "./portal.mjs";
import { quoteRoutes } from "./routes.mjs";
import { automations, sweeps } from "./automations.mjs";
import { phases } from "./import-rotor.mjs";
import { mcpTools } from "./mcp.mjs";

// Staff photos and mockups on a quote (POST /files?owner_type=quote&kind=photo|mockup).
defineFileOwner("quote", {
  canRead: (ctx) => ctx.can("quotes:read"),
  canEdit: (ctx) => ctx.can("quotes:write"),
  async attach(quote, file, ctx) {
    const field = file.kind === "mockup" ? "mockup_file_ids" : "photo_ids";
    await updateRecord("quote", quote.id, (q) => ((q[field] || []).includes(file.id) || (q[field] || []).length >= 20 ? null : { ...q, [field]: [...(q[field] || []), file.id] }), ctx.write());
  },
});

const changesRequested = async () => (await readIndex("quotes", "open")).rows.filter((r) => r.st === "changes_requested").length;

export default defineModule({
  name: "quotes",
  types,
  statsParts: {
    // the quotes part of ContactStats (§5.1): services quoted, an open quote
    quotes: { defaults: { svc_q: [], open_quote: false, open_ids: [] }, row: (p) => ({ svc_q: (p && p.svc_q) || [], oq: !!(p && p.open_quote) }) },
  },
  settings: { pricing: { defaults: { ...PRICING_DEFAULTS }, validate: validatePricing, perm: "settings:owner" } },
  routes: quoteRoutes,
  portalRoutes,
  emits: ["quote.sent", "quote.viewed", "quote.approved", "quote.declined", "quote.changes_requested", "quote.archived", "quote.converted"],
  services: {
    // (input, ctx) → { lines, discounts, warnings, plan? }: the engine for other modules (plans renewal, lights rebook)
    "quotes.price": async (input, ctx) => {
      const [pricing, book, defs] = await Promise.all([loadPricing(), priceBook(), discountDefs()]);
      return suggestOption(input || {}, pricing, book, defs);
    },
    // (option, ctx) → { first_cents, per_visit_cents, term_cents, annual_cents }
    "quotes.totals": async (option, ctx) => optionTotals(option || {}, await loadPricing()),
    // (quote_id, ctx) → QuoteVersion: conversion always uses the approved version
    "quotes.approvedVersion": (quoteId) => approvedVersion(quoteId),
    // Sales' estimate follow-up (M2b): the day-2 / day-3 offers and the day-4 archive
    "quotes.applyOffer": (quoteId, offer, opts, ctx) => applyOffer(quoteId, offer, opts || {}, ctx || {}),
    "quotes.archive": (quoteId, opts, ctx) => archiveForSales(quoteId, opts || {}, ctx || {}),
  },
  needs: ["plans.agreementForOption", "plans.fromQuoteOption", "work.createJobs", "money.createDepositInvoice", "sales.markDeal", "bulk.create"],
  sweeps,
  automations,
  templates: TEMPLATES,
  seeds: [{ v: 1, run: seedPriceBook }],
  onMerge: onMergeQuotes,
  attention: [{ key: "quotes.changes_requested", label: "Quote changes requested", perm: "quotes:read", count: changesRequested, link: "#/quotes?status=changes_requested" }],
  pushKinds: ["quote_approved", "changes_requested"],
  activityKinds: {
    "quote.sent": { label: "Quote sent", icon: "doc" },
    "quote.approved": { label: "Quote approved", icon: "check" },
    "quote.changes_requested": { label: "Asked for quote changes", icon: "text" },
    "quote.declined": { label: "Quote declined", icon: "doc" },
    "quote.converted": { label: "Quote booked", icon: "check" },
  },
  exportTypes: ["quote", "quote_version", "price_item", "discount_def"],
  mcpTools,
  importPhases: phases,
});

export { pricingWith, getRecord };
