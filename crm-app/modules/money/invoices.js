// Invoices (design §9.2 "Invoices"; the Rotor guide's FI1-FI4): one tile
// row (the tile is the filter): Outstanding $ · Overdue $ · Due today $ ·
// Paid this month $ · Draft · Card failed · Overpaid · Paid this year ·
// Void; Row2 rows with a round "Text a reminder" on overdue ones; the
// round "..." has the Tax report (CSV). A search by name or number. Returning to the list keeps its
// chip, search and scroll; on a wide screen an invoice opens beside it.

import { html, attrs, rnd, actionSheet, tileRow, tileToggle, listRow, listCard, toast } from "../../core/ui.js";
import { findButton, findOpen } from "../../core/nav.js";
import { dateShort } from "../../core/format.js";
import { ensureStyles, KIND, statusOf } from "./kit.js";

// A CSV the server answers as an attachment: a link the browser downloads (the page stays).
export function download(href) {
  const a = document.createElement("a");
  a.href = href; a.download = ""; a.rel = "noopener";
  document.body.appendChild(a); a.click(); a.remove();
}

// The round "..." of the list: the Tax report (CSV), Payments, Autopay, Export.
const moreRows = (ctx) => [[
  { label: "Tax report", icon: "doc", hint: "this year, CSV", run: () => download("/api/crm/invoices/tax.csv"), data: { "tax-report": true } },
  { label: "Payments", icon: "money", href: "#/payments", data: { "go-payments": true } },
  { label: "Autopay", icon: "pay", href: "#/autopay", data: { "go-autopay": true } },
  ctx.can("audit:read") && { label: "Export", icon: "share", hint: "Data & backups", href: "#/settings/data" },
]];

// Row2 (Rotor's list): the customer and the amount; the number, due date or kind, a Plan tag; the status;
// a round "Text a reminder" on an overdue one.
export function invoiceRow2(r, ctx = null) {
  const [tone, words] = statusOf(r);
  const sub = [r.n, r.k && r.k !== "standard" ? KIND[r.k] : null, r.st === "open" && r.due ? `due ${dateShort(r.due)}` : r.st === "paid" && r.pd ? `paid ${dateShort(String(r.pd).slice(0, 10))}` : r.iss ? dateShort(r.iss) : null, r.sent && r.st === "open" ? "sent" : null].filter(Boolean).join(" · ");
  return listRow({
    title: r.cn || "No name", amount: r.st === "open" ? r.bal : r.tot, sub, tag: r.pl ? "Plan" : null,
    pill: { label: words, tone: tone || "grey" }, href: "#/invoices/" + encodeURIComponent(r.id), edge: r.od ? "red" : null,
    action: r.od && !r.im && (!ctx || ctx.can("invoices:send")) ? { icon: "chat", label: `Text ${r.cn || "them"} a reminder`, data: { remind: r.id } } : null,
  });
}

const TILES = [["open", "Outstanding"], ["overdue", "Overdue"], ["due_today", "Due today"], ["paid_month", "Paid this month"], ["draft", "Draft"], ["failed", "Card failed"], ["overpaid", "Overpaid"], ["paid", "Paid this year"], ["void", "Void"]];

async function load(params, ctx) {
  ensureStyles();
  const asked = (location.hash.match(/(?:status|f)=([a-z_]+)/) || [])[1];
  const chip = ctx.keep.chip || asked || "open";
  const r = await ctx.api(`/invoices?status=${encodeURIComponent(chip)}`, { cache: false });
  return { rows: r.data || [], counts: (r.meta && r.meta.counts) || {}, totals: (r.meta && r.meta.totals) || {}, more: !!(r.meta && r.meta.more), chip, q: ctx.keep.q || "" };
}

const visible = (s) => {
  const q = s.q.trim().toLowerCase();
  return s.rows.filter((r) => !q || `${r.cn} ${r.n}`.toLowerCase().includes(q));
};
const EMPTY = {
  open: "Nothing waiting to be paid. Invoices land here when a job is done.",
  overdue: "Nothing overdue. Good news.",
  due_today: "Nothing due today.",
  paid_month: "Nothing paid yet this month.",
  draft: "No drafts. An invoice you start and don't send waits here.",
  failed: "No failed cards. A card that doesn't go through shows up here.",
  overpaid: "No overpayments. A payment over the total waits here until you refund it or keep it as credit.",
};

export default {
  load,
  action: (s, ctx) => (ctx.can("invoices:write") ? { label: "New", run: () => ctx.go("/invoices/new") } : null),
  render(s, ctx) {
    const c = s.counts, t = s.totals;
    const money$ = { open: t.open_cents, overdue: t.overdue_cents, due_today: t.due_today_cents, paid_month: t.paid_month_cents };
    const tiles = TILES.filter(([k]) => ["open", "overdue", "due_today", "paid_month", "draft"].includes(k) || (c[k] || 0) > 0 || k === s.chip || k === "paid")
      .map(([k, label]) => ({ key: k, label, value: ["paid", "void"].includes(k) && s.chip !== k ? "" : c[k] || 0, money: money$[k] || null, tone: (k === "overdue" || k === "failed") && c[k] ? "red" : k === "due_today" && c[k] ? "amber" : k === "paid_month" && t.paid_month_cents ? "green" : null }))
      .map((x) => (x.value === "" ? { ...x, value: "See" } : x));
    const rows = visible(s);
    return html`<div class="stack">
      ${tileRow(tiles, { name: "inv", on: s.chip, label: "Invoices" })}
      <div class="mn-findrow"><label class="${"field find-field" + (findOpen(s, ctx) ? " open" : "")}"><span class="sr">Search invoices</span><input type="search" data-q placeholder="Name or invoice number" ${attrs({ value: s.q, autocomplete: "off", enterkeyhint: "search" })}></label>${rnd("more", "Tax report, Payments, Autopay, Export", { tone: "grey", sm: true, popup: true, data: { "list-more": true } })}</div>
      ${listCard(rows.map((r) => invoiceRow2(r, ctx)), { label: "Invoices", empty: EMPTY[s.chip] || "Nothing here. Pick another tile." })}
      ${s.more ? html`<p class="foot-note">Showing the newest 500. Search by name or number to find an older one.</p>` : ""}
    </div>`;
  },
  mount(view, s, ctx) { findButton(view, ctx, "Search invoices"); },
  events: {
    "click [data-tile=inv]": (e, el, ctx) => { ctx.keep.chip = tileToggle(ctx.state.chip, el.dataset.key, "open"); ctx.refresh(); },
    "click [data-list-more]": (e, el, ctx) => actionSheet("Invoices", moreRows(ctx)),
    "click [data-remind]": async (e, el, ctx) => {
      e.preventDefault();
      try { await ctx.api(`/invoices/${encodeURIComponent(el.dataset.remind)}/send`, { method: "POST", body: { channels: ["sms"] } }); toast("Reminder in the Outbox (texting isn't on yet)"); }
      catch (err) { toast(err.message || "That reminder didn't go.", { bad: true }); }
    },
    "input [data-q]": (e, el, ctx) => {
      ctx.state.q = el.value; ctx.keep.q = el.value;
      clearTimeout(ctx.keep.timer);
      ctx.keep.timer = setTimeout(() => { if (!el.isConnected) return; const pos = el.selectionStart; ctx.rerender(); const n = document.querySelector("[data-q]"); if (n) { n.focus(); try { n.setSelectionRange(pos, pos); } catch (err) { /* type=search */ } } }, 180);
    },
  },
};
