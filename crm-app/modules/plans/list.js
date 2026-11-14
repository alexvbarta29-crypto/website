// Plans (design §9.2 "Plans"): chips Active · Waiting (signature or card) ·
// Paused · Ending · Due this month (and clawbacks to bill, cancelled, ended),
// each row the customer, the plan, the next visit's month, autopay.
// Returning to the list keeps its chip, search and scroll.

import { html, attrs } from "../../core/ui.js";
import { findButton, findOpen } from "../../core/nav.js";
import { money } from "../../core/format.js";
import { ensureStyles, CHIPS, statusPill, pendingText, monthLabel, emptyCard } from "./kit.js";

// Two lines (Rotor's list): the customer and the plan's value; the plan, what's next, Auto-Pay and the status.
export function planRow2(r) {
  const extra = r.st === "pending" ? `waiting for ${pendingText(r.pr) || "the agreement"}` : r.nx ? `next ${monthLabel(r.nx)}` : "";
  return html`<li><a class="c-row" href="${"#/plans/" + encodeURIComponent(r.id)}">
    <span class="c-l1"><b>${r.cn || "No name"}</b><span class="num">${money(r.sv || 0)}</span></span>
    <span class="c-l2"><span class="c-sub">${r.nm}${extra ? ` · ${extra}` : ""}${r.ap ? " · Auto-Pay" : ""}</span>${statusPill(r.st)}</span></a></li>`;
}

async function load(params, ctx) {
  ensureStyles();
  const chip = ctx.keep.chip || (location.hash.match(/status=([a-z_]+)/) || [])[1] || "active";
  const r = await ctx.api("/plans", { cache: false });
  const due = chip === "due" || chip === "clawback" ? (await ctx.api(`/plans?status=${chip}`, { cache: false })).data || [] : null;
  return { rows: r.data || [], counts: (r.meta && r.meta.counts) || {}, chip, q: ctx.keep.q || "", special: due };
}

function visible(s) {
  const q = s.q.trim().toLowerCase();
  const base = s.special && (s.chip === "due" || s.chip === "clawback") ? s.special : s.rows.filter((r) => r.st === s.chip);
  return base.filter((r) => !q || `${r.cn} ${r.nm}`.toLowerCase().includes(q));
}

export default {
  load,
  action: (s, ctx) => (ctx.can("plans:write") ? { label: "New", run: () => ctx.go("/plans/new") } : null),
  render(s, ctx) {
    const count = (k) => s.counts[k] || 0;
    const rows = visible(s);
    return html`<div class="stack rs-list">
      <label class="${"field find-field" + (findOpen(s, ctx) ? " open" : "")}"><span class="sr">Search plans</span><input type="search" data-q placeholder="Name or plan" ${attrs({ value: s.q, autocomplete: "off", enterkeyhint: "search" })}></label>
      <div class="chips" role="tablist">${CHIPS.filter(([k]) => ["active", "pending", "due"].includes(k) || count(k) > 0 || k === s.chip).map(([k, label]) => html`<button type="button" class="chip" ${attrs({ "data-chip": k, "aria-pressed": String(s.chip === k) })}>${label} <span class="n">${count(k)}</span></button>`)}</div>
      ${rows.length ? html`<ul class="rs-card flush c-rows">${rows.map(planRow2)}</ul>` : emptyCard(s.chip === "active" ? "No active plans yet" : "Nothing here", s.chip === "active" ? "Plans sold on a quote land here once they're signed." : "Pick another chip.")}
      <div class="links">
        <a class="tile" href="#/plans/due">Visits to book</a>
        ${ctx.can("plans:read") ? html`<a class="tile" href="#/lights">Lights season</a>` : ""}
      </div>
    </div>`;
  },
  mount(view, s, ctx) { findButton(view, ctx, "Search plans"); },
  events: {
    "click [data-chip]": async (e, el, ctx) => { ctx.keep.chip = el.dataset.chip; ctx.refresh(); },
    "input [data-q]": (e, el, ctx) => {
      ctx.state.q = el.value; ctx.keep.q = el.value;
      clearTimeout(ctx.keep.timer);
      ctx.keep.timer = setTimeout(() => { const pos = el.selectionStart; ctx.rerender(); const n = document.querySelector("[data-q]"); if (n) { n.focus(); try { n.setSelectionRange(pos, pos); } catch (err) { /* type=search */ } } }, 180);
    },
  },
};
