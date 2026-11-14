// Invoices (design §9.2 "Invoices"): chips Open · Overdue · Draft · Card
// failed · Overpaid · Paid · Void with counts, what's open and overdue in
// dollars, a search by name or number. Returning to the list keeps its
// chip, search and scroll; on a wide screen an invoice opens beside it.

import { html, attrs, statGrid, rnd, actionSheet } from "../../core/ui.js";
import { findButton, findOpen } from "../../core/nav.js";
import { money, dateShort } from "../../core/format.js";
import { ensureStyles, CHIPS, KIND, statusPill, emptyCard } from "./kit.js";

// Two lines (Rotor's list): the customer and the amount; the number, due date or kind, the status.
// The round "..." of the list (at the end of the chips: the big title row holds search and +):
// Payments, Autopay, Export. The drawer's Financials has them too.
const moreRows = (ctx) => [[
  { label: "Payments", icon: "money", href: "#/payments", data: { "go-payments": true } },
  { label: "Autopay", icon: "pay", href: "#/autopay", data: { "go-autopay": true } },
  ctx.can("audit:read") && { label: "Export", icon: "share", hint: "Data & backups", href: "#/settings/data" },
]];

export function invoiceRow2(r) {
  const sub = [r.n, r.k && r.k !== "standard" ? KIND[r.k] : null, r.st === "open" && r.due ? `due ${dateShort(r.due)}` : r.iss ? dateShort(r.iss) : null].filter(Boolean).join(" · ");
  return html`<li><a class="c-row" href="${"#/invoices/" + encodeURIComponent(r.id)}">
    <span class="c-l1"><b>${r.cn || "No name"}</b><span class="num">${money(r.st === "open" ? r.bal : r.tot)}</span></span>
    <span class="c-l2"><span class="c-sub">${sub}</span>${statusPill(r)}</span></a></li>`;
}

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
      ${statGrid([
        { label: "Waiting", value: money(s.totals.open_cents || 0), data: { chip: "open" } },
        { label: "Past due", value: money(s.totals.overdue_cents || 0), tone: s.totals.overdue_cents ? "red" : null, data: { chip: "overdue" } },
        { label: "Paid this month", value: money(s.totals.month_paid_cents || 0), tone: s.totals.month_paid_cents ? "green" : null },
      ], { label: "Money" })}
      <label class="${"field find-field" + (findOpen(s, ctx) ? " open" : "")}"><span class="sr">Search invoices</span><input type="search" data-q placeholder="Name or invoice number" ${attrs({ value: s.q, autocomplete: "off", enterkeyhint: "search" })}></label>
      <div class="chips" role="tablist">${CHIPS.filter(([k]) => ["open", "overdue", "draft", "paid"].includes(k) || count(k) > 0 || k === s.chip).map(([k, label]) => html`<button type="button" class="chip" ${attrs({ "data-chip": k, "aria-pressed": String(s.chip === k) })}>${label}${["paid", "void"].includes(k) && s.chip !== k ? "" : html` <span class="n">${count(k)}</span>`}</button>`)}${rnd("more", "Payments, Autopay, Export", { tone: "grey", sm: true, popup: true, data: { "list-more": true } })}</div>
      ${rows.length ? html`<ul class="rs-card flush c-rows">${rows.map(invoiceRow2)}</ul>` : emptyCard(t, p)}
      ${s.more ? html`<p class="foot-note">Showing the newest 500. Search by name or number to find an older one.</p>` : ""}
    </div>`;
  },
  mount(view, s, ctx) { findButton(view, ctx, "Search invoices"); },
  events: {
    "click [data-chip]": (e, el, ctx) => { ctx.keep.chip = el.dataset.chip; ctx.refresh(); },
    "click [data-list-more]": (e, el, ctx) => actionSheet("Invoices", moreRows(ctx)),
    "input [data-q]": (e, el, ctx) => {
      ctx.state.q = el.value; ctx.keep.q = el.value;
      clearTimeout(ctx.keep.timer);
      ctx.keep.timer = setTimeout(() => { if (!el.isConnected) return; const pos = el.selectionStart; ctx.rerender(); const n = document.querySelector("[data-q]"); if (n) { n.focus(); try { n.setSelectionRange(pos, pos); } catch (err) { /* type=search */ } } }, 180);
    },
  },
};
