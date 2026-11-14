// Jobs (design §9.2): the open jobs (under way, booked, to book), the ones
// that need a look (booked but the date went by, under way for days), and
// the done or cancelled ones by year. A filter box narrows by name, number
// or title on the phone.

import { html, icon, attrs, statusPill } from "../../core/ui.js";
import { findButton, findOpen } from "../../core/nav.js";
import { money, dateShort, plural } from "../../core/format.js";
import { ensureStyles, officeView, kindLabel, STALE, emptyCard, today } from "./office-kit.js";

const JOB_WORD = { unscheduled: "To book", scheduled: "Booked", in_progress: "Under way", completed: "Done", cancelled: "Cancelled" };
const JOB_TONE = { unscheduled: "amber", scheduled: "blue", in_progress: "amber", completed: "green", cancelled: "red" };

const TABS = [["open", "Open"], ["stale", "Needs a look"], ["done", "Done"], ["cancelled", "Cancelled"]];

async function fetchRows(ctx, s) {
  const q = new URLSearchParams({ status: s.tab, ...(["done", "cancelled"].includes(s.tab) ? { year: s.year } : {}) });
  const r = await ctx.api(`/jobs?${q}`, { cache: false });
  s.rows = r.data || [];
  s.stale = !!(r.meta && r.meta.stale);
}

export default {
  title: "Jobs",
  async load(params, ctx) {
    ensureStyles();
    if (!officeView()) return { denied: true };
    const q = new URLSearchParams((typeof location !== "undefined" && location.hash.split("?")[1]) || "");
    const asked = TABS.some(([k]) => k === q.get("status")) ? q.get("status") : null;
    const s = { tab: asked || ctx.keep.tab || "open", year: ctx.keep.year || today().slice(0, 4), q: ctx.keep.q || "", rows: [] };
    await fetchRows(ctx, s);
    return s;
  },
  action: (s, ctx) => (s.denied || !ctx.can("schedule:write") ? null : { label: "New job", run: () => ctx.go("/jobs/new") }),
  render(s, ctx) {
    if (s.denied) return html`<div class="stack"><div class="card empty"><div class="art">${icon("schedule")}</div><h2>Not for this login</h2><p>Jobs are for the office.</p></div></div>`;
    const w = s.q.trim().toLowerCase();
    const rows = w ? s.rows.filter((r) => [r.cn, r.n, r.t].some((x) => String(x || "").toLowerCase().includes(w))) : s.rows;
    const shown = rows.slice(0, 200);
    const y = Number(s.year);
    // Rotor's list: the filters as pills (the year at their end), then 2-line rows:
    // the name and the amount; the number with the next date, and the status pill
    const when = (r) => (r.nv ? dateShort(r.nv) : r.tm && r.st === "unscheduled" ? `due ${r.tm}` : r.done ? `done ${dateShort(r.done)}` : "");
    return html`<div class="stack wk wk-jobs">
      <div class="wk-jchips"><div class="chips" role="tablist" aria-label="Which jobs">${TABS.map(([k, label]) => html`<button type="button" class="chip" role="tab" ${attrs({ "data-tab": k, "aria-pressed": String(s.tab === k) })}>${label}</button>`)}</div>
      ${["done", "cancelled"].includes(s.tab) ? html`<div class="wk-jyear" role="group" aria-label="Year"><button type="button" class="icon-btn" ${attrs({ "data-year": String(y - 1), "aria-label": "Year before" })}>${icon("back")}</button><span class="d num">${s.year}</span><button type="button" class="icon-btn" ${attrs({ "data-year": String(y + 1), "aria-label": "Next year" })}><span class="flip">${icon("back")}</span></button></div>` : ""}</div>
      <label class="${"field wk-filter find-field" + (findOpen(s, ctx) ? " open" : "")}"><span class="sr">Search jobs</span><input type="search" name="q" placeholder="Name, number or title" autocomplete="off" ${attrs({ value: s.q })}></label>
      ${shown.length ? html`<ul class="rs-card flush wk-jlist">${shown.map((r) => html`<li><a class="wk-jrow" href="${"#/jobs/" + encodeURIComponent(r.id)}">
        <span class="wk-jl1"><span class="nm">${r.cn || "Customer"}</span>${r.bill !== false && r.tot ? html`<b class="num">${money(r.tot)}</b>` : ""}</span>
        <span class="wk-jl2"><span class="sub">${[r.n, when(r), r.k !== "standard" ? kindLabel(r.k) : null, r.stale ? STALE[r.stale] || r.stale : null].filter(Boolean).join(" · ")}</span>${statusPill(JOB_WORD[r.st] || r.st, JOB_TONE[r.st] || "grey")}</span>
        <span class="sr">${r.t}</span></a></li>`)}</ul>`
        : emptyCard(w ? "Nothing matches" : s.tab === "stale" ? "Nothing needs a look" : "No jobs here", w ? "Try another name or number." : s.tab === "stale" ? "Jobs booked for a day that went by, or under way for days, show up here." : "Jobs show up here once they're made.", s.tab === "stale" ? "check" : "schedule")}
      <p class="small muted wk-count">${plural(rows.length, "job")}${rows.length > shown.length ? `, the first ${shown.length} shown` : ""}</p>
      ${s.stale ? html`<p class="foot-note">This list is being rebuilt; a change from the last minute may be missing.</p>` : ""}
    </div>`;
  },
  mount(view, s, ctx) { if (!s.denied) findButton(view, ctx, "Search jobs"); },
  events: {
    "click [data-tab]": async (e, el, ctx) => { const s = ctx.state; s.tab = el.dataset.tab; ctx.keep.tab = s.tab; await fetchRows(ctx, s).catch(() => { s.rows = []; }); ctx.rerender(); },
    "click [data-year]": async (e, el, ctx) => { const s = ctx.state; s.year = el.dataset.year; ctx.keep.year = s.year; await fetchRows(ctx, s).catch(() => { s.rows = []; }); ctx.rerender(); },
    "input [name=q]": (e, el, ctx) => {
      ctx.state.q = el.value; ctx.keep.q = el.value;
      clearTimeout(ctx.keep.t);
      ctx.keep.t = setTimeout(() => { ctx.rerender(); const i = document.querySelector("#view [name=q]"); if (i) { i.focus(); i.setSelectionRange(i.value.length, i.value.length); } }, 250);
    },
  },
};
