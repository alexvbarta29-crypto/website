// Payments (design §9.2 "Payments"; Rotor's Financials → Payments, the
// Rotor guide's FP1-FP3), laid out like Rotor's: one month at a time (‹ ›);
// the tiles Total Payments · Stripe Payments · Cash & check · Total Tips ·
// Total Refunds · Card fees (Stripe, Cash & check, Tips and Refunds are
// filters); Rotor's "Tip Report"; then the table: Date · Customer · Amount
// · Tip · Refunded · Method · Ref (the invoice) · Type · Status, and a round
// "..." (Open the invoice, Open customer). Each payment opens its invoice.
// On a phone the same table is two-line rows (the customer and the amount,
// the date and the method, the status). The round "..." of the page has
// the Tip report (CSV: each payment with a tip and each person's share)
// and Autopay. Practice (test) payments are listed and marked, never
// counted.

import { html, attrs, rnd, pillBtn, actionSheet, tileRow, tileToggle, dataTable } from "../../core/ui.js";
import { dateYear } from "../../core/format.js";
import { ensureStyles, emptyCard, monthLabel, addMonth, thisMonth, METHOD, PAY_STATUS } from "./kit.js";
import { download } from "./invoices.js";

const TILES = [["total", "Total Payments", true], ["stripe", "Stripe Payments", true], ["cash_check", "Cash & check", true], ["tips", "Total Tips", true], ["refunds", "Total Refunds", true], ["fees", "Card fees", false]];
const TONE = { "": "grey", blue: "blue", green: "green", red: "red" };

async function load(params, ctx) {
  ensureStyles();
  const month = ctx.keep.month || thisMonth();
  const group = ctx.keep.group || "";
  const r = await ctx.api(`/payments?month=${encodeURIComponent(month)}${group ? `&group=${encodeURIComponent(group)}` : ""}`, { cache: false });
  return { rows: r.data || [], totals: (r.meta && r.meta.totals) || {}, tiles: (r.meta && r.meta.tiles) || {}, month, group };
}

// Rotor's table: one row of a payment (or a refund).
export function paymentTableRow(p) {
  const refund = p.k === "refund";
  const [cls, words] = PAY_STATUS[p.st] || ["", p.st];
  const sign = refund ? -1 : 1;
  return {
    cells: {
      on: p.on ? dateYear(p.on) : "", cn: p.cn || (refund ? "Refund" : "Payment"), a: sign * ((p.a || 0) + (p.tip || 0)), tip: !refund && p.tip ? p.tip : null, rf: p.rf ? p.rf : null,
      m: [refund ? "Refund" : METHOD[p.m] || p.m, p.vq ? "pay code" : null].filter(Boolean).join(" · "), ref: p.inn || "", ty: [refund ? "Refund" : p.rt === "tip" ? "Tip" : "Invoice", p.sim ? "test" : null].filter(Boolean).join(" · "),
      st: refund ? { label: "Refund", tone: "grey" } : { label: words, tone: TONE[cls] || "grey" },
    },
    href: p.inv ? "#/invoices/" + encodeURIComponent(p.inv) : null,
    action: { icon: "more", label: `More for this payment${p.cn ? " from " + p.cn : ""}`, popup: true, wide: true, data: { "pay-row": p.id } },
  };
}
const COLUMNS = [
  { key: "on", label: "Date", kind: "date", width: "minmax(104px,.8fr)" },
  { key: "cn", label: "Customer", kind: "title", width: "minmax(140px,1.4fr)" },
  { key: "a", label: "Amount", kind: "money", width: "minmax(88px,.7fr)" },
  { key: "tip", label: "Tip", kind: "money", width: "minmax(64px,.5fr)" },
  { key: "rf", label: "Refunded", kind: "money", width: "minmax(80px,.6fr)" },
  { key: "m", label: "Method", kind: "text", width: "minmax(80px,.7fr)" },
  { key: "ref", label: "Ref", kind: "text", width: "minmax(88px,.7fr)" },
  { key: "ty", label: "Type", kind: "text", width: "minmax(64px,.6fr)" },
  { key: "st", label: "Status", kind: "status", width: "minmax(96px,.7fr)" },
];

export default {
  load,
  render(s) {
    const t = s.tiles;
    const tiles = TILES.map(([k, label, filter]) => ({ key: k, label, value: (t[k] && t[k].n) || 0, money: (t[k] && t[k].cents) || 0, info: !filter, tone: k === "refunds" && t[k] && t[k].n ? "red" : null }));
    return html`<div class="stack mn-list">
      <div class="mn-month"><button type="button" class="btn" data-month="-1" aria-label="The month before">‹</button><b>${monthLabel(s.month)}</b><button type="button" class="btn" data-month="1" aria-label="The month after" ${attrs({ disabled: s.month >= thisMonth() })}>›</button>
        <span class="mn-tools">${pillBtn("Tip Report", { icon: "doc", data: { "tip-report": true }, aria: `Tip report: ${monthLabel(s.month)}, CSV` })}${rnd("more", "Tip report, Autopay", { tone: "grey", sm: true, popup: true, data: { "pay-more": true } })}</span></div>
      ${tileRow(tiles, { name: "pay", on: s.group || "total", label: "Payments" })}
      ${s.totals.simulated ? html`<p class="foot-note">${s.totals.simulated} practice payment${s.totals.simulated === 1 ? "" : "s"} (marked "test") ${s.totals.simulated === 1 ? "is" : "are"} listed but never counted.</p>` : ""}
      ${s.rows.length ? html`<div class="mn-ptable">${dataTable({ label: "Payments", columns: COLUMNS, rows: s.rows.map(paymentTableRow) })}</div>` : emptyCard(s.group ? "Nothing here this month" : "No payments this month", "Payments land here as they come in.")}
    </div>`;
  },
  events: {
    "click [data-month]": (e, el, ctx) => { ctx.keep.month = addMonth(ctx.state.month, Number(el.dataset.month)); ctx.refresh(); },
    "click [data-tile=pay]": (e, el, ctx) => { const k = tileToggle(ctx.state.group || "total", el.dataset.key, "total"); ctx.keep.group = k === "total" ? "" : k; ctx.refresh(); },
    "click [data-tip-report]": (e, el, ctx) => download(`/api/crm/payments/tips.csv?month=${encodeURIComponent(ctx.state.month)}`),
    "click [data-pay-row]": (e, el, ctx) => {
      e.preventDefault();
      const p = (ctx.state.rows || []).find((x) => x.id === el.dataset.payRow);
      if (!p) return;
      actionSheet(p.cn || "Payment", [[
        p.inv && { label: `Open invoice${p.inn ? " " + p.inn : ""}`, icon: "doc", href: "#/invoices/" + encodeURIComponent(p.inv), hint: "refund it from there" },
        p.c && { label: "Open customer", icon: "user", href: "#/contacts/" + encodeURIComponent(p.c) },
      ]]);
    },
    "click [data-pay-more]": (e, el, ctx) => actionSheet("Payments", [[
      { label: "Tip report", icon: "doc", hint: `${monthLabel(ctx.state.month)}, CSV`, run: () => download(`/api/crm/payments/tips.csv?month=${encodeURIComponent(ctx.state.month)}`), data: { "tip-report": true } },
      { label: "Autopay run", icon: "clock", href: "#/autopay" },
    ]]),
  },
};
