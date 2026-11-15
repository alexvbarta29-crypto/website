// Inbox (the Rotor guide's: guide-gaps §2.3 I1 to I3, §3.2 X6, §7.3; design
// §9.2 "Inbox", §5.7.1 "Keeping screens fresh"): one row per person (their
// texts and email are one thread), newest first. Simple, like Rotor's and
// Flyra's phone inbox (the owner, Nov 15: "the inbox is a lot"): a search
// field, ONE folder button (All · Mine · Unread · Needs reply, then each team
// inbox, each with its count; texts or email and customers or leads sit in
// the same sheet), then the rows: a pastel initials circle, the name, the
// last words on one line, the time and a coral unread count. On a wide desk
// the folders are a column beside the rows instead (Rotor's inbox with
// folders). It refreshes every 30 s while on screen. A technician sees only
// the people on their own visits (All, Unread).

import { html, attrs, icon, render, actionSheet } from "../../core/ui.js";
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
// The folders, each with its count (a tech: All and Unread).
export const foldersOf = (s) => {
  const c = s.counts || {};
  const base = s.office
    ? [["all", "All", c.all], ["mine", "Mine", c.mine], ["unread", "Unread", c.unread], ["needs_reply", "Needs reply", c.needs_reply]]
    : [["all", "All", c.all], ["unread", "Unread", c.unread]];
  return [...base.map(([key, label, value]) => ({ key, label, value: value ?? null })), ...(c.list || []).map((x) => ({ key: x.key, label: x.name, value: x.count, team: true }))];
};
const FICON = { all: "inbox", mine: "user", unread: "chat", needs_reply: "undo" };
const folderNow = (s) => foldersOf(s).find((f) => f.key === s.tile) || { key: "all", label: "All", value: null };
// What the folder button says besides the folder: "Texts", "Leads".
const showing = (s) => [s.channel === "sms" ? "Texts" : s.channel === "email" ? "Email" : "", s.who === "leads" ? "Leads" : s.who === "customers" ? "Customers" : ""].filter(Boolean).join(" · ");
const cnt = (v) => (v === null || v === undefined || v === "" ? "" : String(v));

// The one folder sheet: the folders (with counts), then texts or email, then customers or leads.
function folderSheet(ctx) {
  const s = ctx.state;
  const pick = (k, v) => () => { s[k] = v; refetch(ctx); };
  const mark = (on, ic) => (on ? "check" : ic);
  const fs = foldersOf(s);
  actionSheet("Folders", [
    fs.filter((f) => !f.team).map((f) => ({ label: f.label, icon: mark(s.tile === f.key, FICON[f.key] || "inbox"), hint: cnt(f.value), run: pick("tile", f.key), data: { folder: f.key, on: s.tile === f.key ? "1" : null } })),
    fs.filter((f) => f.team).map((f) => ({ label: f.label, icon: mark(s.tile === f.key, "inbox"), hint: cnt(f.value), run: pick("tile", f.key), data: { folder: f.key, on: s.tile === f.key ? "1" : null } })),
    [[null, "Texts and email"], ["sms", "Texts only"], ["email", "Email only"]].map(([v, l]) => ({ label: l, icon: mark((s.channel || null) === v, v === "email" ? "mail" : "text"), run: pick("channel", v), data: { fch: v || "all" } })),
    s.office && [[null, "Customers and leads"], ["customers", "Customers only"], ["leads", "Leads only"]].map(([v, l]) => ({ label: l, icon: mark((s.who || null) === v, "contacts"), run: pick("who", v), data: { fwho: v || "all" } })),
  ]);
}

// The folder button (a phone and a narrow desk): the folder, its count, what else is filtered.
function folderBtn(s) {
  const f = folderNow(s);
  const extra = showing(s);
  return html`<div class="cm-fbar"><button type="button" class="cm-folder" data-folders aria-haspopup="dialog" ${attrs({ "aria-label": `Folder: ${f.label}${extra ? ", " + extra : ""}${cnt(f.value) ? `, ${f.value}` : ""}. Change` })}>
    <span class="cm-fl">${f.label}</span>${cnt(f.value) ? html`<span class="cm-fn num">${String(f.value)}</span>` : ""}${extra ? html`<span class="cm-fx">${extra}</span>` : ""}${icon("chevdown")}</button>
    ${extra ? html`<button type="button" class="linkish cm-fclear" data-clear>Clear</button>` : ""}</div>`;
}
// A wide desk: the folders as a column (Rotor's inbox with folders).
function folderCol(s) {
  const fs = foldersOf(s);
  const row = (f) => html`<li><button type="button" class="cm-fcol-b" ${attrs({ "data-folder": f.key, "aria-pressed": String(s.tile === f.key) })}>${icon(FICON[f.key] || "inbox")}<span class="cm-fl">${f.label}</span>${cnt(f.value) ? html`<span class="cm-fn num">${String(f.value)}</span>` : ""}</button></li>`;
  const chip = (k, v, l) => html`<button type="button" class="chip" ${attrs({ [`data-f${k}`]: v || "all", "aria-pressed": String((s[k === "ch" ? "channel" : "who"] || null) === v) })}>${l}</button>`;
  return html`<nav class="cm-fcol" aria-label="Folders">
    <ul>${fs.filter((f) => !f.team).map(row)}</ul>
    ${fs.some((f) => f.team) ? html`<h2 class="cm-fcol-h">Team inboxes</h2><ul>${fs.filter((f) => f.team).map(row)}</ul>` : ""}
    <h2 class="cm-fcol-h">Show</h2>
    <div class="cm-fcol-c">${chip("ch", null, "All")}${chip("ch", "sms", "Texts")}${chip("ch", "email", "Email")}</div>
    ${s.office ? html`<div class="cm-fcol-c">${chip("who", null, "All")}${chip("who", "customers", "Customers")}${chip("who", "leads", "Leads")}</div>` : ""}
  </nav>`;
}

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
      ${folderCol(s)}
      <div class="cm-lcol">
        <label class="cm-search">${icon("search")}<span class="sr">Search messages</span><input type="search" data-q ${attrs({ value: s.q, placeholder: "Search", autocomplete: "off", enterkeyhint: "search" })}></label>
        ${folderBtn(s)}
        ${list.length ? html`<ul class="list cm-list">${list.map(convRow)}</ul>${s.next ? html`<button type="button" class="btn block" data-more>Show older</button>` : ""}`
          : emptyCard("inbox", quiet(s) ? "No conversations yet" : "Nothing here", quiet(s) ? (s.office ? "Texts and emails with customers show up here. Rotor's history arrives with the import." : "Texts with the people on your visits show up here.") : "Try another folder.")}
      </div>
    </div>`;
  },
  mount(el, s, ctx) {
    if (!live || live.for !== ctx) { watch(ctx); live.for = ctx; }
    // a phone's round buttons: Calls (sales); the folders and their filters are the folder button
    screenButtons(ctx.can("sales:work") ? [{ key: "calls", icon: "call", label: "Calls" }] : [], (key) => { if (key === "calls") location.hash = "/calls"; });
  },
  unmount() { if (live) { live.stop(); live = null; } },
  events: {
    "click [data-folders]": (e, el, ctx) => folderSheet(ctx),
    "click .cm-fcol [data-folder]": (e, el, ctx) => { ctx.state.tile = el.dataset.folder; refetch(ctx); },
    "click .cm-fcol [data-fch]": (e, el, ctx) => { ctx.state.channel = el.dataset.fch === "all" ? null : el.dataset.fch; refetch(ctx); },
    "click .cm-fcol [data-fwho]": (e, el, ctx) => { ctx.state.who = el.dataset.fwho === "all" ? null : el.dataset.fwho; refetch(ctx); },
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
