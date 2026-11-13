// Inbox, titled Messages (design §9.2 "Inbox", §5.7.1 "Keeping screens
// fresh"; the Nov 2026 layout, after Flyra's header and Rotor's rows):
// every conversation, newest first; a search field over the names and the
// last words; All | Customers | Leads; an Unread switch; and a dropdown for
// All messages · Needs reply · Mine. Rows: a pastel initials circle, the
// name, the last words, the time and a coral count of unread. It refreshes
// every 30 s while on screen. A technician sees only the people on their
// own visits (and only All and Unread).
// The Nov 13 look (Flyra's Messages): round buttons on top (the calls, a
// filter sheet with All messages · Needs reply · Mine, and the coral + to
// text someone), the search, All | Customers | Leads and Unread under it.

import { html, attrs, icon, render, sheet } from "../../core/ui.js";
import { screenButtons } from "../../core/nav.js";
import { poll } from "../../core/poll.js";
import { ensureStyles, convRow, emptyCard } from "./kit.js";

let live = null;
// The server answers one filter at a time: the narrowest asked for goes to
// it, the rest is applied here. → the server's filter
export const serverFilter = (v) => (v.unread ? "unread" : v.kind !== "all" ? v.kind : v.seg !== "all" ? v.seg : "all");
export function shown(rows, v) {
  const q = String(v.q || "").trim().toLowerCase();
  return rows.filter((c) => (!v.unread || c.unread) && (v.seg === "all" || (v.seg === "leads" ? c.lifecycle === "lead" : c.lifecycle !== "lead"))
    && (v.kind !== "needs_reply" || c.needs_reply) && (!q || `${c.contact_name || ""} ${c.last_preview || ""}`.toLowerCase().includes(q)));
}
const url = (s) => `/inbox?filter=${encodeURIComponent(serverFilter(s))}`;

async function load(params, ctx) {
  ensureStyles();
  const k = ctx.keep;
  const v = { seg: k.seg || "all", unread: !!k.unread, kind: k.kind || "all", q: k.q || "" };
  const r = await ctx.api(url(v), { cache: false });
  return { ...v, filter: serverFilter(v), rows: r.data || [], next: (r.meta || {}).next_cursor || null, office: ctx.can("contacts:read_all") };
}
async function refetch(ctx) {
  const s = ctx.state;
  for (const key of ["seg", "unread", "kind", "q"]) ctx.keep[key] = s[key];
  const r = await ctx.api(url(s), { cache: false });
  s.filter = serverFilter(s);
  s.rows = r.data || [];
  s.next = (r.meta || {}).next_cursor || null;
  ctx.rerender();
  watch(ctx); live.for = ctx;
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
  title: "Messages",
  load,
  render(s) {
    const list = shown(s.rows, s);
    const segs = s.office ? [["all", "All"], ["customers", "Customers"], ["leads", "Leads"]] : [];
    return html`<div class="stack cm-inbox">
      <label class="cm-search">${icon("search")}<span class="sr">Search messages</span><input type="search" data-q ${attrs({ value: s.q, placeholder: "Search messages", autocomplete: "off", enterkeyhint: "search" })}></label>
      <div class="cm-filters">
        ${segs.length ? html`<div class="cm-seg" role="group" aria-label="Who">${segs.map(([k, l]) => html`<button type="button" ${attrs({ "data-seg": k, "aria-pressed": String(s.seg === k) })}>${l}</button>`)}</div>` : ""}
        <label class="cm-unread"><span>Unread</span><button type="button" class="switch" role="switch" data-unread ${attrs({ "aria-checked": String(!!s.unread), "aria-label": "Only unread" })}></button></label>
      </div>
      <label class="cm-kind cm-kind-desk"><span class="sr">Which messages</span><select data-kind>${[["all", "All Messages"], ["needs_reply", "Needs reply"], ...(s.office ? [["mine", "Mine"]] : [])].map(([k, l]) => html`<option ${attrs({ value: k, selected: s.kind === k })}>${l}</option>`)}</select></label>
      ${list.length ? html`<ul class="list cm-list">${list.map(convRow)}</ul>${s.next ? html`<button type="button" class="btn block" data-more>Show older</button>` : ""}`
        : emptyCard("inbox", s.filter === "all" && !s.q && s.seg === "all" ? "No conversations yet" : "Nothing here", s.filter === "all" && !s.q && s.seg === "all" ? (s.office ? "Texts and emails with customers show up here. Rotor's history arrives with the import." : "Texts with the people on your visits show up here.") : "Try another filter.")}
    </div>`;
  },
  mount(el, s, ctx) {
    if (!live || live.for !== ctx) { watch(ctx); live.for = ctx; }
    // a phone: Flyra's round buttons (the calls, the filter sheet); the coral + texts someone
    const kinds = [["all", "All Messages"], ["needs_reply", "Needs reply"], ...(s.office ? [["mine", "Mine"]] : [])];
    screenButtons([
      ...(ctx.can("sales:work") ? [{ key: "calls", icon: "call", label: "Calls" }] : []),
      { key: "filter", icon: "filter", label: s.kind !== "all" ? "Which messages (on)" : "Which messages", on: s.kind !== "all" },
    ], (key) => {
      if (key === "calls") { location.hash = "/calls"; return; }
      const sh = sheet({
        title: "Show",
        body: html`<ul class="menu theme-pick" role="radiogroup" aria-label="Which messages">${kinds.map(([k, l]) => html`<li><button type="button" role="radio" ${attrs({ "data-k": k, "aria-checked": String(s.kind === k) })}><span>${l}</span>${s.kind === k ? html`<span class="theme-ck">${icon("check")}</span>` : ""}</button></li>`)}</ul>`,
        events: { "click [data-k]": (e, b) => { sh.close(); s.kind = b.dataset.k; refetch(ctx); } },
      });
    });
  },
  unmount() { if (live) { live.stop(); live = null; } },
  events: {
    "click [data-seg]": (e, el, ctx) => { ctx.state.seg = el.dataset.seg; refetch(ctx); },
    "click [data-unread]": (e, el, ctx) => { ctx.state.unread = !ctx.state.unread; refetch(ctx); },
    "change [data-kind]": (e, el, ctx) => { ctx.state.kind = el.value; refetch(ctx); },
    "input [data-q]": (e, el, ctx) => {
      ctx.state.q = el.value;
      ctx.keep.q = el.value;
      clearTimeout(ctx.state.qt);
      // the list only, so the field keeps its focus and caret
      ctx.state.qt = setTimeout(() => {
        const box = document.querySelector(".cm-inbox .cm-list");
        const list = shown(ctx.state.rows, ctx.state);
        if (box && list.length) render(box, html`${list.map(convRow)}`); else ctx.rerender();
      }, 120);
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
