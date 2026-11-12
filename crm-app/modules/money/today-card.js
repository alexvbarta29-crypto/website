// The money strip on Home (design §9.2): what is owed and how much of it is
// past due, in dollars. The counts (unpaid, overdue, failed cards,
// overpayments) are Home's "Needs you" rows from the server; this adds the
// amounts and the month's take so far. Nothing shows when nothing is owed.

import { html } from "../../core/ui.js";
import { money } from "../../core/format.js";
import { ensureStyles } from "./kit.js";

export default {
  async load(ctx) {
    ensureStyles();
    const r = await ctx.api("/money/summary", { cache: false }).catch(() => null);
    return (r && r.data) || null;
  },
  render(s) {
    if (!s || (!s.open_cents && !s.revenue_cents)) return html``;
    return html`<div class="section-h">Money</div><div class="mn-strip">
      <a href="#/invoices?status=open"><b>${money(s.open_cents || 0)}</b><small>owed to you</small></a>
      <a class="${s.overdue_cents ? "bad" : ""}" href="#/invoices?status=overdue"><b>${money(s.overdue_cents || 0)}</b><small>past due</small></a>
      <a href="#/payments"><b>${money(s.revenue_cents || 0)}</b><small>in this month</small></a>
    </div>`;
  },
};
