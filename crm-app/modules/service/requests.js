// Service → Requests (the Rotor guide's SR1-SR4, guide-gaps S4): the tiles
// Open · Assessments this week · Unassigned · Became work (the % of the
// year's closed ones that became a quote or a job) · Closed, each one the
// filter; then a Row2 per request (the name and what they asked for; where
// it came from, how long ago, photos; the status). The coral + (or + →
// Request) makes one. Returning keeps the tile and the search.

import { html, attrs, tileRow, tileToggle, listCard } from "../../core/ui.js";
import { findButton, findOpen } from "../../core/nav.js";
import { plural } from "../../core/format.js";
import { ensureStyles, requestRow, emptyText } from "./kit.js";

async function load(params, ctx) {
  ensureStyles();
  const asked = (typeof location !== "undefined" && (location.hash.match(/[?&]tile=([a-z_]+)/) || [])[1]) || null;
  const tile = ctx.keep.tile || asked || "open";
  const r = await ctx.api(`/requests?tile=${encodeURIComponent(tile)}`, { cache: false });
  return { tile, rows: r.data || [], tiles: (r.meta && r.meta.tiles) || [], q: ctx.keep.q || "" };
}

export default {
  load,
  action: (s, ctx) => (ctx.can("requests:write") ? { label: "New request", run: () => ctx.go("/requests/new") } : null),
  render(s, ctx) {
    const w = s.q.trim().toLowerCase();
    const rows = w ? s.rows.filter((r) => `${r.cn} ${(r.svc || []).join(" ")}`.toLowerCase().includes(w)) : s.rows;
    const tiles = s.tiles.map((t) => (t.key === "converted"
      ? { key: t.key, label: t.label, value: t.pct === null || t.pct === undefined ? String(t.count) : `${t.pct}%`, money: t.pct === null || t.pct === undefined ? null : plural(t.count, "request") }
      : { key: t.key, label: t.label, value: t.count, tone: t.key === "unassigned" && t.count ? "amber" : null }));
    return html`<div class="stack sv sv-reqs">
      ${tileRow(tiles, { name: "rq", on: s.tile, label: "Requests" })}
      <label class="${"field find-field" + (findOpen(s, ctx) ? " open" : "")}"><span class="sr">Search requests</span><input type="search" data-q placeholder="Name or service" ${attrs({ value: s.q, autocomplete: "off", enterkeyhint: "search" })}></label>
      ${listCard(rows.map(requestRow), { label: "Requests", empty: w ? "Nothing matches." : emptyText[s.tile] || "Nothing here." })}
    </div>`;
  },
  mount(view, s, ctx) { findButton(view, ctx, "Search requests"); },
  events: {
    "click [data-tile=rq]": (e, el, ctx) => { ctx.keep.tile = tileToggle(ctx.state.tile, el.dataset.key, "open"); ctx.refresh(); },
    "input [data-q]": (e, el, ctx) => {
      ctx.state.q = el.value; ctx.keep.q = el.value;
      clearTimeout(ctx.keep.timer);
      ctx.keep.timer = setTimeout(() => { if (!el.isConnected) return; const pos = el.selectionStart; ctx.rerender(); const n = document.querySelector("[data-q]"); if (n) { n.focus(); try { n.setSelectionRange(pos, pos); } catch (err) { /* type=search */ } } }, 180);
    },
  },
};
