// Financials → Expenses (Flyra's, the Rotor guide's FE1): the period chip
// (This month ⌄), tiles by category with $ (the tile is the filter), then
// Row2 rows (the vendor and the amount; the category, the day, a receipt
// mark), each opening the expense. The coral + (or New) adds one: the
// camera for the receipt, then the amount. The round "..." links the old
// Purchases page until its rows come over.

import { html, rnd, actionSheet, tileRow, tileToggle, listRow, listCard, periodChip, periodSheet, periodRange, periodLabel } from "../../core/ui.js";
import { dateShort } from "../../core/format.js";
import { ensureStyles, CATS, catLabel, localToday } from "./kit.js";

async function load(params, ctx) {
  ensureStyles();
  const period = ctx.keep.period || "month";
  const cat = ctx.keep.cat || "";
  // the company's day comes from the server (a phone's clock may be off); this month needs no dates
  const q = new URLSearchParams(cat ? { cat } : {});
  if (period !== "month") { const { from, to } = periodRange(period, ctx.keep.today || localToday()); q.set("from", from); q.set("to", to); }
  const r = await ctx.api(`/expenses?${q}`, { cache: false });
  if (r.meta && r.meta.today) ctx.keep.today = r.meta.today;
  return { rows: r.data || [], meta: r.meta || {}, period, cat };
}

export default {
  load,
  action: (s, ctx) => (ctx.can("expenses:write") ? { label: "New", run: () => ctx.go("/expenses/new") } : null),
  render(s, ctx) {
    const by = s.meta.by_category || {};
    const tiles = [{ key: "all", label: "All", value: Object.values(by).reduce((a, b) => a + b.n, 0), money: s.meta.total_cents || 0 },
      ...CATS.filter(([k]) => (by[k] && by[k].n) || k === s.cat).map(([k, label]) => ({ key: k, label, value: (by[k] && by[k].n) || 0, money: (by[k] && by[k].cents) || 0 }))];
    return html`<div class="stack ex-page">
      <div class="ex-head">${periodChip(s.period, { name: "ex", label: "Dates" })}${rnd("more", "Purchases", { tone: "grey", sm: true, popup: true, data: { "ex-more": true } })}</div>
      ${tileRow(tiles, { name: "ex", on: s.cat || "all", label: "Expenses" })}
      ${listCard(s.rows.map((r) => listRow({
        title: r.v || catLabel(r.cat), amount: r.a, sub: [catLabel(r.cat), dateShort(r.d), r.rc ? "receipt" : null].filter(Boolean).join(" · "), href: "#/expenses/" + encodeURIComponent(r.id),
      })), { label: "Expenses", empty: `No expenses ${periodLabel(s.period).toLowerCase()}.${ctx.can("expenses:write") ? " Tap + to add one with its receipt." : ""}` })}
    </div>`;
  },
  events: {
    "click [data-tile=ex]": (e, el, ctx) => { const k = tileToggle(ctx.state.cat || "all", el.dataset.key, "all"); ctx.keep.cat = k === "all" ? "" : k; ctx.refresh(); },
    "click [data-period=ex]": async (e, el, ctx) => { const p = await periodSheet(ctx.state.period, { max: localToday() }); if (p) { ctx.keep.period = p.key === "custom" ? p : p.key; ctx.refresh(); } },
    "click [data-ex-more]": (e, el, ctx) => actionSheet("Expenses", [[{ label: "Purchases (the old page)", icon: "cart", href: "#/tools/purchases" }]]),
  },
};

