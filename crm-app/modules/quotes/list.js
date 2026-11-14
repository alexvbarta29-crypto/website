// Quotes (design §9.2 "Quotes"): chips by status with counts (open ones
// first), each row the contact, the number, the first-visit price and how
// long ago it was sent and viewed. Returning to the list keeps its chip,
// search and scroll (the router's keep).

import { html, attrs } from "../../core/ui.js";
import { findButton, findOpen } from "../../core/nav.js";
import { money, ago, dateShort } from "../../core/format.js";
import { ensureStyles, CHIPS, OPEN, statusPill, emptyCard } from "./kit.js";

// Two lines (Rotor's list): the customer and the first-visit price; the number, when it went out, the status.
export function quoteRow2(r) {
  return html`<li><a class="c-row" href="${"#/quotes/" + encodeURIComponent(r.id)}">
    <span class="c-l1"><b>${r.cn || "No name"}</b><span class="num">${r.first !== null && r.first !== undefined ? money(r.first) : ""}</span></span>
    <span class="c-l2"><span class="c-sub">${r.n} · ${r.sent ? `sent ${ago(r.sent)}` : `made ${dateShort(r.at || r.u)}`}${r.viewed ? ` · viewed ${ago(r.viewed)}` : ""}</span>${statusPill(r.st)}</span></a></li>`;
}

async function load(params, ctx) {
  ensureStyles();
  const chip = ctx.keep.chip || (location.hash.match(/status=([a-z_]+)/) || [])[1] || "open";
  const r = await ctx.api(`/quotes?status=all`, { cache: false });
  return { rows: r.data || [], counts: (r.meta && r.meta.counts) || {}, chip, q: ctx.keep.q || "" };
}

function visible(s) {
  const q = s.q.trim().toLowerCase();
  return s.rows.filter((r) => (s.chip === "open" ? OPEN.includes(r.st) : r.st === s.chip))
    .filter((r) => !q || `${r.cn} ${r.n}`.toLowerCase().includes(q));
}

export default {
  load,
  action: (s, ctx) => (ctx.can("quotes:write") ? { label: "New", run: () => ctx.go("/quotes/new") } : null),
  render(s, ctx) {
    const count = (k) => (k === "open" ? OPEN.reduce((a, x) => a + (s.counts[x] || 0), 0) : s.counts[k] || 0);
    const rows = visible(s);
    return html`<div class="stack">
      <label class="${"field find-field" + (findOpen(s, ctx) ? " open" : "")}"><span class="sr">Search quotes</span><input type="search" data-q placeholder="Name or number" ${attrs({ value: s.q, autocomplete: "off", enterkeyhint: "search" })}></label>
      <div class="chips" role="tablist">${CHIPS.filter(([k]) => k === "open" || count(k) > 0 || k === s.chip).map(([k, label]) => html`<button type="button" class="chip" ${attrs({ "data-chip": k, "aria-pressed": String(s.chip === k) })}>${label} <span class="n">${count(k)}</span></button>`)}</div>
      ${rows.length ? html`<ul class="rs-card flush c-rows">${rows.map(quoteRow2)}</ul>` : emptyCard(s.chip === "open" ? "No open quotes" : "Nothing here", s.chip === "open" ? "Tap New to price a house." : "Pick another chip.")}
    </div>`;
  },
  mount(view, s, ctx) { findButton(view, ctx, "Search quotes"); },
  events: {
    "click [data-chip]": (e, el, ctx) => { ctx.state.chip = el.dataset.chip; ctx.keep.chip = el.dataset.chip; ctx.rerender(); },
    "input [data-q]": (e, el, ctx) => {
      ctx.state.q = el.value; ctx.keep.q = el.value;
      clearTimeout(ctx.keep.timer);
      ctx.keep.timer = setTimeout(() => { if (!el.isConnected) return; const pos = el.selectionStart; ctx.rerender(); const n = document.querySelector("[data-q]"); if (n) { n.focus(); try { n.setSelectionRange(pos, pos); } catch (err) { /* type=search */ } } }, 180);
    },
  },
};
