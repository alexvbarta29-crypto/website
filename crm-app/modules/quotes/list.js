// Quotes (design §9.2 "Quotes"): chips by status with counts (open ones
// first), each row the contact, the number, the first-visit price and how
// long ago it was sent and viewed. Returning to the list keeps its chip,
// search and scroll (the router's keep).

import { html, attrs } from "../../core/ui.js";
import { ensureStyles, CHIPS, OPEN, quoteRow, emptyCard } from "./kit.js";

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
  render(s) {
    const count = (k) => (k === "open" ? OPEN.reduce((a, x) => a + (s.counts[x] || 0), 0) : s.counts[k] || 0);
    const rows = visible(s);
    return html`<div class="stack">
      <label class="field"><span class="sr">Search quotes</span><input type="search" data-q placeholder="Name or number" ${attrs({ value: s.q, autocomplete: "off", enterkeyhint: "search" })}></label>
      <div class="chips" role="tablist">${CHIPS.filter(([k]) => k === "open" || count(k) > 0 || k === s.chip).map(([k, label]) => html`<button type="button" class="chip" ${attrs({ "data-chip": k, "aria-pressed": String(s.chip === k) })}>${label} <span class="n">${count(k)}</span></button>`)}</div>
      ${rows.length ? html`<ul class="list">${rows.map(quoteRow)}</ul>` : emptyCard(s.chip === "open" ? "No open quotes" : "Nothing here", s.chip === "open" ? "Tap New to price a house." : "Pick another chip.")}
    </div>`;
  },
  events: {
    "click [data-chip]": (e, el, ctx) => { ctx.state.chip = el.dataset.chip; ctx.keep.chip = el.dataset.chip; ctx.rerender(); },
    "input [data-q]": (e, el, ctx) => {
      ctx.state.q = el.value; ctx.keep.q = el.value;
      clearTimeout(ctx.keep.timer);
      ctx.keep.timer = setTimeout(() => { const pos = el.selectionStart; ctx.rerender(); const n = document.querySelector("[data-q]"); if (n) { n.focus(); try { n.setSelectionRange(pos, pos); } catch (err) { /* type=search */ } } }, 180);
    },
  },
};
