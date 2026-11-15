// Invoices (design §9.2 "Invoices"; Rotor's Financials → Invoices, the
// Rotor guide's FI1-FI4), laid out like Rotor's: the tiles Paid this month
// · Due today · Outstanding · Overdue (count and $; the tile is the
// filter; Draft, Card failed and Overpaid join them when there are any);
// the search, the filter (every tile, Paid this year and Void too) and
// Rotor's "Tax Report"; then the table: Created · Invoice # · Customer ·
// Status · Cycle · Total · Due · Sent · Paid, a round "Text a reminder" on
// an overdue one. On a phone (or beside an open invoice) the same table is
// two-line rows: the customer and the total, the number and the due date,
// the status. The round "..." has the Tax report, Payments, Autopay,
// Export. Returning to the list keeps its tile, search and scroll; on a
// wide screen an invoice opens beside it.

import { html, attrs, rnd, pillBtn, actionSheet, filterSheet, tileRow, tileToggle, listRow, dataTable, toast } from "../../core/ui.js";
import { findButton, findOpen } from "../../core/nav.js";
import { dateShort, dateYear } from "../../core/format.js";
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

const TILES = [["paid_month", "Paid this month"], ["due_today", "Due today"], ["open", "Outstanding"], ["overdue", "Overdue"], ["draft", "Draft"], ["failed", "Card failed"], ["overpaid", "Overpaid"], ["paid", "Paid this year"], ["void", "Void"]];
// Rotor's four always; Draft, Card failed and Overpaid when there are any; the rest from the filter
const ROTOR = ["paid_month", "due_today", "open", "overdue"];
const SOMETIMES = ["draft", "failed", "overpaid"];
const day = (d) => (d ? dateYear(String(d).slice(0, 10)) : "");
const MONTH = new Intl.DateTimeFormat("en-US", { timeZone: "UTC", month: "short", year: "numeric" });
const cycleOf = (r) => (r.pm && /^\d{4}-\d{2}$/.test(r.pm) ? MONTH.format(new Date(r.pm + "-15T12:00:00Z")) : r.k && r.k !== "standard" ? KIND[r.k] || r.k : "");

// Rotor's table: one row of an invoice.
export function invoiceTableRow(r, ctx = null) {
  const [tone, words] = statusOf(r);
  return {
    cells: {
      at: day(r.at || r.iss), n: html`<b class="mn-inum">${r.n}</b>`, cn: r.cn || "No name", st: { label: words, tone: tone || "grey" }, cy: cycleOf(r),
      tot: r.tot, due: r.due ? html`<span class="mn-dw">due </span>${day(r.due)}` : "", sent: r.sent ? day(r.sent) : "", pd: r.st === "paid" && r.pd ? day(r.pd) : "",
    },
    href: "#/invoices/" + encodeURIComponent(r.id), edge: r.od ? "red" : null,
    action: r.od && !r.im && (!ctx || ctx.can("invoices:send")) ? { icon: "chat", label: `Text ${r.cn || "them"} a reminder`, data: { remind: r.id } } : null,
  };
}
const COLUMNS = [
  { key: "at", label: "Created", kind: "date", width: "minmax(104px,.8fr)" },
  { key: "n", label: "Invoice #", kind: "text", width: "minmax(104px,.8fr)" },
  { key: "cn", label: "Customer", kind: "title", width: "minmax(140px,1.3fr)" },
  { key: "st", label: "Status", kind: "status", width: "minmax(100px,.7fr)" },
  { key: "cy", label: "Cycle", kind: "text", width: "minmax(64px,.6fr)" },
  { key: "tot", label: "Total", kind: "money", width: "minmax(88px,.7fr)" },
  { key: "due", label: "Due", kind: "date", width: "minmax(104px,.8fr)" },
  { key: "sent", label: "Sent", kind: "date", width: "minmax(104px,.8fr)" },
  { key: "pd", label: "Paid", kind: "date", width: "minmax(104px,.8fr)" },
];

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
    const tiles = TILES.filter(([k]) => ROTOR.includes(k) || (SOMETIMES.includes(k) && (c[k] || 0) > 0) || k === s.chip)
      .map(([k, label]) => ({ key: k, label, value: ["paid", "void"].includes(k) && s.chip !== k ? "" : c[k] || 0, money: ROTOR.includes(k) ? money$[k] || 0 : null, tone: (k === "overdue" || k === "failed") && c[k] ? "red" : k === "due_today" && c[k] ? "amber" : k === "paid_month" && t.paid_month_cents ? "green" : null }))
      .map((x) => (x.value === "" ? { ...x, value: "See" } : x));
    const rows = visible(s);
    const extra = !ROTOR.includes(s.chip) && !SOMETIMES.includes(s.chip);
    return html`<div class="stack mn-list">
      ${tileRow(tiles, { name: "inv", on: s.chip, label: "Invoices" })}
      <div class="mn-findrow"><label class="${"field find-field" + (findOpen(s, ctx) ? " open" : "")}"><span class="sr">Search invoices</span><input type="search" data-q placeholder="Search invoice # or customer..." ${attrs({ value: s.q, autocomplete: "off", enterkeyhint: "search" })}></label>
        ${rnd("filter", extra ? `Filter: ${(TILES.find((x) => x[0] === s.chip) || [0, s.chip])[1]}` : "Filter", { tone: "grey", sm: true, popup: true, pressed: extra, data: { "inv-filter": true } })}
        <span class="mn-tools">${pillBtn("Tax Report", { icon: "doc", data: { "tax-report": true }, aria: "Tax report: this year, CSV" })}${rnd("more", "Tax report, Payments, Autopay, Export", { tone: "grey", sm: true, popup: true, data: { "list-more": true } })}</span></div>
      <div class="mn-itable">${dataTable({ label: "Invoices", columns: COLUMNS, rows: rows.map((r) => invoiceTableRow(r, ctx)), empty: EMPTY[s.chip] || "Nothing here. Pick another tile." })}</div>
      ${s.more ? html`<p class="foot-note">Showing the newest 500. Search by name or number to find an older one.</p>` : ""}
    </div>`;
  },
  mount(view, s, ctx) { findButton(view, ctx, "Search invoices"); },
  events: {
    "click [data-tile=inv]": (e, el, ctx) => { ctx.keep.chip = tileToggle(ctx.state.chip, el.dataset.key, "open"); ctx.refresh(); },
    "click [data-inv-filter]": async (e, el, ctx) => {
      const c = ctx.state.counts || {};
      const v = await filterSheet({ title: "Show", values: { show: ctx.state.chip }, groups: [{ key: "show", label: "Invoices", type: "radio", default: "open", options: TILES.map(([k, l]) => [k, ["paid", "void"].includes(k) ? l : `${l} (${c[k] || 0})`]) }] });
      if (v) { ctx.keep.chip = v.show || "open"; ctx.refresh(); }
    },
    "click [data-tax-report]": () => download("/api/crm/invoices/tax.csv"),
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
