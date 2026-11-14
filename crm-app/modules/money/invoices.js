// Invoices (design §9.2 "Invoices"): chips Open · Overdue · Draft · Card
// failed · Overpaid · Paid · Void with counts, what's open and overdue in
// dollars, a search by name or number. Returning to the list keeps its
// chip, search and scroll; on a wide screen an invoice opens beside it.

import { html, attrs } from "../../core/ui.js";
import { findButton, findOpen } from "../../core/nav.js";
import { money } from "../../core/format.js";
import { ensureStyles, CHIPS, invoiceRow, emptyCard } from "./kit.js";

async function load(params, ctx) {
  ensureStyles();
  const chip = ctx.keep.chip || (location.hash.match(/status=([a-z_]+)/) || [])[1] || "open";
  const r = await ctx.api(`/invoices?status=${encodeURIComponent(chip)}`, { cache: false });
  return { rows: r.data || [], counts: (r.meta && r.meta.counts) || {}, totals: (r.meta && r.meta.totals) || {}, more: !!(r.meta && r.meta.more), chip, q: ctx.keep.q || "" };
}

const visible = (s) => {
  const q = s.q.trim().toLowerCase();
  return s.rows.filter((r) => !q || `${r.cn} ${r.n}`.toLowerCase().includes(q));
};
const EMPTY = {
  open: ["Nothing waiting to be paid", "Invoices land here when a job is done."],
  overdue: ["Nothing overdue", "Good news."],
  draft: ["No drafts", "An invoice you start and don't send waits here."],
  failed: ["No failed cards", "A card that doesn't go through shows up here."],
  overpaid: ["No overpayments", "A payment over the total waits here until you refund it or keep it as credit."],
};

export default {
  load,
  action: (s, ctx) => (ctx.can("invoices:write") ? { label: "New", run: () => ctx.go("/invoices/new") } : null),
  render(s, ctx) {
    const count = (k) => s.counts[k] || 0;
    const rows = visible(s);
    const [t, p] = EMPTY[s.chip] || ["Nothing here", "Pick another chip."];
    return html`<div class="stack">
      <div class="mn-tot">
        <div class="stat"><b>${money(s.totals.open_cents || 0)}</b><small>waiting to be paid</small></div>
        <div class="${"stat" + (s.totals.overdue_cents ? " bad" : "")}"><b>${money(s.totals.overdue_cents || 0)}</b><small>past due</small></div>
      </div>
      <label class="${"field find-field" + (findOpen(s, ctx) ? " open" : "")}"><span class="sr">Search invoices</span><input type="search" data-q placeholder="Name or invoice number" ${attrs({ value: s.q, autocomplete: "off", enterkeyhint: "search" })}></label>
      <div class="chips" role="tablist">${CHIPS.filter(([k]) => ["open", "overdue", "draft", "paid"].includes(k) || count(k) > 0 || k === s.chip).map(([k, label]) => html`<button type="button" class="chip" ${attrs({ "data-chip": k, "aria-pressed": String(s.chip === k) })}>${label}${["paid", "void"].includes(k) && s.chip !== k ? "" : html` <span class="n">${count(k)}</span>`}</button>`)}</div>
      ${rows.length ? html`<ul class="list">${rows.map(invoiceRow)}</ul>` : emptyCard(t, p)}
      ${s.more ? html`<p class="foot-note">Showing the newest 500. Search by name or number to find an older one.</p>` : ""}
      <div class="links"><a class="tile" href="#/payments">Payments</a><a class="tile" href="#/autopay">Autopay</a></div>
    </div>`;
  },
  mount(view, s, ctx) { findButton(view, ctx, "Search invoices"); },
  events: {
    "click [data-chip]": (e, el, ctx) => { ctx.keep.chip = el.dataset.chip; ctx.refresh(); },
    "input [data-q]": (e, el, ctx) => {
      ctx.state.q = el.value; ctx.keep.q = el.value;
      clearTimeout(ctx.keep.timer);
      ctx.keep.timer = setTimeout(() => { const pos = el.selectionStart; ctx.rerender(); const n = document.querySelector("[data-q]"); if (n) { n.focus(); try { n.setSelectionRange(pos, pos); } catch (err) { /* type=search */ } } }, 180);
    },
  },
};
