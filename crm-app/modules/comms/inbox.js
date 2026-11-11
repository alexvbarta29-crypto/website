// Inbox (design §9.2 "Inbox", §5.7.1 "Keeping screens fresh"): every
// conversation, newest first, with who needs a reply; chips All · Unread ·
// Needs reply · Leads · Customers · Mine. It refreshes every 30 s while on
// screen. A technician sees only the people on their own visits.

import { html, attrs } from "../../core/ui.js";
import { poll } from "../../core/poll.js";
import { ensureStyles, FILTERS, convRow, emptyCard } from "./kit.js";

let live = null;
const url = (s) => `/inbox?filter=${encodeURIComponent(s.filter)}`;

async function load(params, ctx) {
  ensureStyles();
  const filter = ctx.keep.filter || "all";
  const r = await ctx.api(url({ filter }), { cache: false });
  return { filter, rows: r.data || [], next: (r.meta || {}).next_cursor || null, office: ctx.can("contacts:read_all") };
}

function watch(ctx) {
  if (live) live.stop();
  live = poll(url(ctx.state), 30000, (data, meta) => {
    ctx.state.rows = data || [];
    ctx.state.next = (meta || {}).next_cursor || null;
    ctx.rerender();
  }, { immediate: false });
}

export default {
  load,
  action: (s, ctx) => (ctx.can("contacts:read_all") ? { label: "New", run: () => ctx.go("/inbox/new") } : null),
  render(s) {
    const chips = s.office ? FILTERS : FILTERS.filter(([k]) => ["all", "unread", "needs_reply"].includes(k));
    return html`<div class="stack">
      <div class="chips" role="tablist">${chips.map(([k, label]) => html`<button type="button" class="chip" ${attrs({ "data-filter": k, "aria-pressed": String(s.filter === k) })}>${label}</button>`)}</div>
      ${s.rows.length ? html`<ul class="list">${s.rows.map(convRow)}</ul>${s.next ? html`<button type="button" class="btn block" data-more>Show older</button>` : ""}`
        : emptyCard("inbox", s.filter === "all" ? "No conversations yet" : "Nothing here", s.filter === "all" ? (s.office ? "Texts and emails with customers show up here. Rotor's history arrives with the import." : "Texts with the people on your visits show up here.") : "Pick another chip.")}
    </div>`;
  },
  mount(el, s, ctx) { if (!live || live.for !== ctx) { watch(ctx); live.for = ctx; } },
  unmount() { if (live) { live.stop(); live = null; } },
  events: {
    "click [data-filter]": async (e, el, ctx) => {
      ctx.keep.filter = el.dataset.filter;
      ctx.state.filter = el.dataset.filter;
      const r = await ctx.api(url(ctx.state), { cache: false });
      ctx.state.rows = r.data || [];
      ctx.state.next = (r.meta || {}).next_cursor || null;
      ctx.rerender();
      watch(ctx); live.for = ctx;
    },
    "click [data-more]": async (e, el, ctx) => {
      const r = await ctx.api(`${url(ctx.state)}&cursor=${encodeURIComponent(ctx.state.next)}`, { cache: false });
      ctx.state.rows = ctx.state.rows.concat(r.data || []);
      ctx.state.next = (r.meta || {}).next_cursor || null;
      if (live) { live.stop(); live = null; }          // an extended list is not replaced by the first page
      ctx.rerender();
    },
  },
};
