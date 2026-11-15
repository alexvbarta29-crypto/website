// Inbox (the Rotor guide's: guide-gaps §2.3 I1 to I3, §3.2 X6, §7.3; design
// §9.2 "Inbox", §5.7.1 "Keeping screens fresh"): one row per person (their
// texts and email are one thread), newest first. Rotor's folders are one
// Tiles row, and a tile IS the filter: All · Mine · Unread · Needs reply,
// then each team inbox (Settings: Inbox "..." → Team inboxes), each with
// the count of open threads. Texts or email, customers or leads: the Filter
// sheet (one control row, not three). A search over names and the last
// words. Rows: a pastel initials circle, the name, the last words, the time
// and a coral unread count. It refreshes every 30 s while on screen. A
// technician sees only the people on their own visits (All, Unread).

import { html, attrs, icon, render, tileRow, tileToggle, filterSheet } from "../../core/ui.js";
import { screenButtons } from "../../core/nav.js";
import { poll } from "../../core/poll.js";
import { ensureStyles, convRow, emptyCard } from "./kit.js";

let live = null;
const BASE = ["all", "mine", "unread", "needs_reply"];
// The tile → the server's folder: a base folder is its filter, anything else a team inbox.
export const query = (v) => {
  const p = new URLSearchParams({ group: "contact" });
  if (BASE.includes(v.tile)) p.set("filter", v.tile); else { p.set("filter", "all"); p.set("inbox", v.tile); }
  if (v.channel) p.set("channel", v.channel);
  return `/inbox?${p}`;
};
// What the list shows of the rows it has: who (customers or leads) and the search.
export function shown(rows, v) {
  const q = String(v.q || "").trim().toLowerCase();
  const seen = new Set();
  return rows.filter((c) => {
    if (seen.has(c.contact_id)) return false;            // (a person's older thread on a later page)
    seen.add(c.contact_id);
    return (!v.who || (v.who === "leads" ? c.lifecycle === "lead" : c.lifecycle !== "lead")) && (!q || `${c.contact_name || ""} ${c.last_preview || ""}`.toLowerCase().includes(q));
  });
}
const tilesOf = (s) => {
  const c = s.counts || {};
  const base = s.office
    ? [["all", "All", c.all], ["mine", "Mine", c.mine], ["unread", "Unread", c.unread], ["needs_reply", "Needs reply", c.needs_reply]]
    : [["all", "All", c.all], ["unread", "Unread", c.unread]];
  return [...base.map(([key, label, value]) => ({ key, label, value: value ?? "-" })), ...(c.list || []).map((x) => ({ key: x.key, label: x.name, value: x.count }))];
};

async function fetchAll(ctx, v) {
  const [r, c] = await Promise.all([ctx.api(query(v), { cache: false }), ctx.api("/inbox/counts", { cache: false }).catch(() => ({ data: null }))]);
  return { rows: r.data || [], next: (r.meta || {}).next_cursor || null, counts: c.data };
}

async function load(params, ctx) {
  ensureStyles();
  const k = ctx.keep;
  const office = ctx.can("contacts:read_all");
  const v = { tile: k.tile || "all", channel: k.channel || null, who: office ? k.who || null : null, q: k.q || "" };
  let got;
  try { got = await fetchAll(ctx, v); } catch (e) {
    // a team inbox that was taken away: back to All
    if (v.tile === "all") throw e;
    v.tile = "all"; k.tile = "all"; got = await fetchAll(ctx, v);
  }
  return { ...v, ...got, office };
}
async function refetch(ctx) {
  const s = ctx.state;
  for (const key of ["tile", "channel", "who", "q"]) ctx.keep[key] = s[key];
  Object.assign(s, await fetchAll(ctx, s));
  ctx.rerender();
  watch(ctx); live.for = ctx;
}

function watch(ctx) {
  if (live) live.stop();
  live = poll(query(ctx.state), 30000, (data, meta) => {
    ctx.state.rows = data || [];
    ctx.state.next = (meta || {}).next_cursor || null;
    ctx.api("/inbox/counts", { cache: false }).then((c) => { ctx.state.counts = c.data; }).catch(() => {}).finally(() => ctx.rerender());
  }, { immediate: false });
}

const filtered = (s) => !!(s.channel || s.who);
const quiet = (s) => s.tile === "all" && !s.q && !filtered(s);

export default {
  title: "Inbox",
  load,
  render(s) {
    const list = shown(s.rows, s);
    return html`<div class="stack cm-inbox">
      ${tileRow(tilesOf(s), { name: "inbox", on: s.tile, label: "Folders" })}
      <label class="cm-search">${icon("search")}<span class="sr">Search messages</span><input type="search" data-q ${attrs({ value: s.q, placeholder: "Search messages", autocomplete: "off", enterkeyhint: "search" })}></label>
      ${filtered(s) ? html`<div class="cm-on"><span>${[s.channel === "sms" ? "Texts" : s.channel === "email" ? "Email" : "", s.who === "leads" ? "Leads" : s.who === "customers" ? "Customers" : ""].filter(Boolean).join(" · ")}</span><button type="button" class="linkish" data-clear>Clear</button></div>` : ""}
      ${list.length ? html`<ul class="list cm-list">${list.map(convRow)}</ul>${s.next ? html`<button type="button" class="btn block" data-more>Show older</button>` : ""}`
        : emptyCard("inbox", quiet(s) ? "No conversations yet" : "Nothing here", quiet(s) ? (s.office ? "Texts and emails with customers show up here. Rotor's history arrives with the import." : "Texts with the people on your visits show up here.") : "Try another folder or filter.")}
    </div>`;
  },
  mount(el, s, ctx) {
    if (!live || live.for !== ctx) { watch(ctx); live.for = ctx; }
    // a phone: the round Filter (texts or email; customers or leads); the coral + texts someone
    screenButtons([
      ...(ctx.can("sales:work") ? [{ key: "calls", icon: "call", label: "Calls" }] : []),
      { key: "filter", icon: "filter", label: filtered(s) ? "Filter (on)" : "Filter", on: filtered(s) },
    ], async (key) => {
      if (key === "calls") { location.hash = "/calls"; return; }
      const groups = [{ key: "channel", label: "Channel", type: "radio", options: [["sms", "Texts"], ["email", "Email"]] }];
      if (s.office) groups.push({ key: "who", label: "Who", type: "radio", options: [["customers", "Customers"], ["leads", "Leads"]] });
      const v = await filterSheet({ title: "Filter", values: { channel: s.channel || null, who: s.who || null }, count: (x) => shown(s.rows.filter((r) => !x.channel || (r.channels || [r.channel]).includes(x.channel)), { ...s, who: x.who }).length, groups });
      if (!v) return;
      s.channel = v.channel || null; s.who = v.who || null;
      refetch(ctx);
    });
  },
  unmount() { if (live) { live.stop(); live = null; } },
  events: {
    "click [data-tile=inbox]": (e, el, ctx) => { ctx.state.tile = tileToggle(ctx.state.tile, el.dataset.key, "all"); refetch(ctx); },
    "click [data-clear]": (e, el, ctx) => { ctx.state.channel = null; ctx.state.who = null; refetch(ctx); },
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
      const r = await ctx.api(`${query(ctx.state)}&cursor=${encodeURIComponent(ctx.state.next)}`, { cache: false });
      ctx.state.rows = ctx.state.rows.concat(r.data || []);
      ctx.state.next = (r.meta || {}).next_cursor || null;
      if (live) { live.stop(); live = null; }          // an extended list is not replaced by the first page
      ctx.rerender();
    },
  },
};
