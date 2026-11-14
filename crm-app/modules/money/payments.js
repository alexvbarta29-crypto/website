// Payments (design §9.2 "Payments"; the Rotor guide's FP1-FP3): one month
// at a time (‹ ›), Rotor's tiles: Total (after refunds) · Stripe (card and
// bank) · Cash & check · Tips · Refunds · Card fees; Stripe, Cash & check,
// Tips and Refunds are filters. Each payment opens its invoice. The round
// "..." has the Tip report (CSV: each payment with a tip and each person's
// share) and Autopay. Practice (test) payments are listed and marked,
// never counted.

import { html, attrs, rnd, actionSheet, tileRow, tileToggle } from "../../core/ui.js";
import { ensureStyles, paymentRow, emptyCard, monthLabel, addMonth, thisMonth } from "./kit.js";
import { download } from "./invoices.js";

const TILES = [["total", "Total", true], ["stripe", "Stripe", true], ["cash_check", "Cash & check", true], ["tips", "Tips", true], ["refunds", "Refunds", true], ["fees", "Card fees", false]];

async function load(params, ctx) {
  ensureStyles();
  const month = ctx.keep.month || thisMonth();
  const group = ctx.keep.group || "";
  const r = await ctx.api(`/payments?month=${encodeURIComponent(month)}${group ? `&group=${encodeURIComponent(group)}` : ""}`, { cache: false });
  return { rows: r.data || [], totals: (r.meta && r.meta.totals) || {}, tiles: (r.meta && r.meta.tiles) || {}, month, group };
}

export default {
  load,
  render(s) {
    const t = s.tiles;
    const tiles = TILES.map(([k, label, filter]) => ({ key: k, label, value: (t[k] && t[k].n) || 0, money: (t[k] && t[k].cents) || 0, info: !filter, tone: k === "refunds" && t[k] && t[k].n ? "red" : null }));
    return html`<div class="stack">
      <div class="mn-month"><button type="button" class="btn" data-month="-1" aria-label="The month before">‹</button><b>${monthLabel(s.month)}</b><button type="button" class="btn" data-month="1" aria-label="The month after" ${attrs({ disabled: s.month >= thisMonth() })}>›</button>${rnd("more", "Tip report, Autopay", { tone: "grey", sm: true, popup: true, data: { "pay-more": true } })}</div>
      ${tileRow(tiles, { name: "pay", on: s.group || "total", label: "Payments" })}
      ${s.totals.simulated ? html`<p class="foot-note">${s.totals.simulated} practice payment${s.totals.simulated === 1 ? "" : "s"} (marked "test") ${s.totals.simulated === 1 ? "is" : "are"} listed but never counted.</p>` : ""}
      ${s.rows.length ? html`<ul class="list tbl">${s.rows.map((p) => paymentRow(p))}</ul>` : emptyCard(s.group ? "Nothing here this month" : "No payments this month", "Payments land here as they come in.")}
    </div>`;
  },
  events: {
    "click [data-month]": (e, el, ctx) => { ctx.keep.month = addMonth(ctx.state.month, Number(el.dataset.month)); ctx.refresh(); },
    "click [data-tile=pay]": (e, el, ctx) => { const k = tileToggle(ctx.state.group || "total", el.dataset.key, "total"); ctx.keep.group = k === "total" ? "" : k; ctx.refresh(); },
    "click [data-pay-more]": (e, el, ctx) => actionSheet("Payments", [[
      { label: "Tip report", icon: "doc", hint: `${monthLabel(ctx.state.month)}, CSV`, run: () => download(`/api/crm/payments/tips.csv?month=${encodeURIComponent(ctx.state.month)}`), data: { "tip-report": true } },
      { label: "Autopay run", icon: "clock", href: "#/autopay" },
    ]]),
  },
};
