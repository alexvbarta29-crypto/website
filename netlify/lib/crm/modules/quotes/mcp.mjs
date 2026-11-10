// Quotes module: Claude's quote tools (design §6.9; the MCP endpoint itself
// arrives with M7c, which reads every module's mcpTools). Reads only: a
// quote reaches a customer through a person (send, present), never a key.
//
//   quotes_list    open quotes (or one contact's), with status and first-visit price
//   quote_detail   one quote: options, lines, discounts, totals, versions
//   quotes_price   the Barta engine's lines for a pane count or square feet (nothing saved)

import { readIndex, listRel, getRecords, getRecord } from "../../../crm-store.mjs";
import { isId } from "../../core/ids.mjs";
import { quoteRow } from "./types.mjs";
import { suggestOption, tierFromSqft } from "./pricing.mjs";
import { loadPricing, priceBook, discountDefs } from "./quotes.mjs";
import { versionsOf, versionSummary } from "./versions.mjs";

export const mcpTools = [
  {
    name: "quotes_list", effect: "read", perm: "quotes:read",
    description: "Open quotes (draft, sent, viewed, changes requested, approved), newest first, or every quote of one contact.",
    inputSchema: { type: "object", properties: { contact_id: { type: "string" }, status: { type: "string" } }, additionalProperties: false },
    run: async (input = {}) => {
      if (isId(input.contact_id, "contact")) {
        const rels = await listRel("contact-quotes", input.contact_id, { limit: 40 });
        const got = await getRecords("quote", rels.map((r) => r.id));
        return { quotes: got.filter(Boolean).map((g) => ({ id: g.data.id, ...quoteRow(g.data) })) };
      }
      const ix = await readIndex("quotes", "open");
      return { quotes: ix.rows.filter((r) => !input.status || r.st === input.status).sort((a, b) => String(b.u).localeCompare(String(a.u))).slice(0, 100) };
    },
  },
  {
    name: "quote_detail", effect: "read", perm: "quotes:read",
    description: "One quote: its options with lines, discounts and per-visit totals (cents), status and versions.",
    inputSchema: { type: "object", properties: { quote_id: { type: "string" } }, required: ["quote_id"], additionalProperties: false },
    run: async (input = {}) => {
      if (!isId(input.quote_id, "quote")) return { found: false };
      const g = await getRecord("quote", input.quote_id);
      if (!g) return { found: false };
      const q = g.data;
      return {
        found: true, id: q.id, number: q.number_label, status: q.status, contact_id: q.contact_id, expires_on: q.expires_on || null,
        options: (q.options || []).map((o) => ({ id: o.id, name: o.name, kind: o.kind, recommended: !!o.recommended, plan: o.plan || null, totals: o.totals, lines: (o.lines || []).map((l) => ({ title: l.title, qty_milli: l.qty_milli, unit_cents: l.unit_cents, total_cents: l.total_cents, scope: l.scope, override: l.override ? { cents: l.override.cents, reason: l.override.reason } : null })), discounts: o.discounts || [] })),
        versions: (await versionsOf(q.id)).map(versionSummary),
      };
    },
  },
  {
    name: "quotes_price", effect: "read", perm: "quotes:read",
    description: "Price a house with the Barta engine: services (windows_ext, windows_int, screens, tracks_standard, tracks_premium, gutters) and panes or square feet; an optional plan (biannual, quarterly, monthly). Nothing is saved.",
    inputSchema: {
      type: "object",
      properties: { services: { type: "array", items: { type: "string" } }, panes_ext: { type: "integer" }, panes_int: { type: "integer" }, sqft: { type: "integer" }, screens: { type: "integer" }, plan: { type: "string" } },
      additionalProperties: false,
    },
    run: async (input = {}) => {
      const [pricing, book, defs] = await Promise.all([loadPricing(), priceBook(), discountDefs()]);
      const x = { ...input };
      let tier = null;
      if (!x.panes_ext && x.sqft) { tier = tierFromSqft(x.sqft, pricing); if (!tier.manual) x.panes_ext = tier.pane_estimate; }
      const out = suggestOption(x, pricing, book, defs);
      return { ...out, sqft_tier: tier };
    },
  },
];
