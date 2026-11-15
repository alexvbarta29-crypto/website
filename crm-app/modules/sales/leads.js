// Leads (guide-gaps §2.6 L1-L9, Rotor's Leads; the owner's default: Rotor's
// seven stages as a real field). Two views under the section's tabs, List |
// Board (#/leads?view=list|board), both from GET /leads (each lead's stage,
// stored by hand or derived by the server until someone moves it, the open
// deal's value, the next follow-up, the last touch):
//
//   List   two-line rows: the name and the potential value; source · the
//          follow-up day, the priority (High) and the stage on the right; a
//          round call; a long press: Text, Convert, Move to a stage.
//   Board  New · Contacted · Quoted · Follow-Up · Sold · Not Interested · Not
//          Ready: a stage strip with counts, swiped columns with their $; a
//          card's Move opens the stage sheet. Sold opens Convert; Not
//          Interested asks why and closes the open deal as lost.
//
// The title row: search, filter (show and sort: newest, follow-up, value,
// priority, recently moved), "..." (Select: stage, priority, owner, tag or
// archive for the leads picked; Archived opens the Customers list's tile).

import { html, icon, attrs, sheet, toast, tileRow, listRow, listCard, board, boardCard, boardMount, moveSheet, filterSheet, actionSheet, confirmSheet, pillBtn, tileToggle } from "../../core/ui.js";
import { money, dateShort } from "../../core/format.js";
import { screenButtons } from "../../core/nav.js";
import { pickFrom } from "../../core/pickers.js";
import { ensureStyles, telHref, LOST_REASONS } from "./kit.js";

export const STAGES = Object.freeze([["new", "New"], ["contacted", "Contacted"], ["quoted", "Quoted"], ["follow_up", "Follow-Up"], ["sold", "Sold"], ["not_interested", "Not Interested"], ["not_ready", "Not Ready"]]);
const STAGE_LABEL = Object.fromEntries(STAGES);
const STAGE_TONE = { new: "blue", contacted: "amber", quoted: "blue", follow_up: "amber", sold: "green", not_interested: "grey", not_ready: "grey" };
const PRIO = { high: ["High", "red"], medium: ["Medium", "orange"], low: ["Low", "grey"] };
const SORTS = [["new", "Newest"], ["follow", "Follow-up date"], ["value", "Value"], ["priority", "Priority"], ["moved", "Recently moved"]];
const SHOW = [["follow", "With a follow-up"], ["paused", "Paused"], ["high", "High priority"], ["mine", "Mine"]];
const $ = (c) => money(c || 0).replace(/\.00$/, "");
const tel = (p) => { const d = String(p || "").replace(/[^\d+]/g, ""); return d ? (d.length === 10 ? "+1" + d : d) : ""; };
const DAY = 86400000;
const days = (iso, now = Date.now()) => (iso ? Math.max(0, Math.floor((now - Date.parse(iso)) / DAY)) : null);
const viewOf = () => { try { return new URLSearchParams((location.hash.split("?")[1]) || "").get("view") === "board" ? "board" : "list"; } catch (e) { return "list"; } };

// The rows a view shows (pure): the search, the filter's "show", the sort.
export function shownLeads(rows, { q = "", show = [], sort = "new", me = null, tile = "all" } = {}) {
  const ws = String(q || "").toLowerCase().split(/\s+/).filter(Boolean);
  const rank = { high: 3, medium: 2, low: 1 };
  const list = rows.filter((r) => {
    if (tile !== "all" && r.stage !== tile) return false;
    if (show.includes("follow") && !r.follow) return false;
    if (show.includes("paused") && !r.paused) return false;
    if (show.includes("high") && r.pr !== "high") return false;
    if (show.includes("mine") && r.o !== me) return false;
    const text = [r.n, r.src, r.c, ...(r.tg || [])].join(" ").toLowerCase();
    return ws.every((w) => text.includes(w) || (w.replace(/\D/g, "").length >= 3 && String(r.p || "").includes(w.replace(/\D/g, ""))));
  });
  const by = {
    new: (a, b) => String(b.ca || "").localeCompare(String(a.ca || "")),
    follow: (a, b) => String(a.follow || "9").localeCompare(String(b.follow || "9")),
    value: (a, b) => (b.pv || 0) - (a.pv || 0),
    priority: (a, b) => (rank[b.pr] || 0) - (rank[a.pr] || 0),
    moved: (a, b) => String(b.sa || "").localeCompare(String(a.sa || "")),
  }[sort] || (() => 0);
  return list.sort((a, b) => by(a, b) || String(a.n).localeCompare(String(b.n)));
}

const stagePill = (r) => ({ label: r.paused ? "Paused" : STAGE_LABEL[r.stage] || "New", tone: r.paused ? "grey" : STAGE_TONE[r.stage] || "blue" });
export const leadRow = (r) => listRow({
  title: r.n || "No name", amount: r.pv === null || r.pv === undefined ? null : r.pv,
  sub: [r.src, r.follow ? `follow up ${dateShort(r.follow).replace(/^[A-Za-z]+, /, "")}` : ""].filter(Boolean).join(" · "),
  tag: r.pr === "high" ? "High" : null, pill: stagePill(r), href: "#/contacts/" + encodeURIComponent(r.id),
  action: r.p ? { icon: "call", label: `Call ${r.n || ""}`, href: telHref(tel(r.p)) } : null,
  hold: { "lead-more": r.id },
});
export function leadCardHtml(r, { users = new Map(), now = Date.now() } = {}) {
  const d = days(r.sa, now);
  return boardCard({
    title: r.n || "No name", pill: PRIO[r.pr] && r.pr === "high" ? { label: "High", tone: "red" } : null,
    sub: `${r.src || "No source"} · ${$(r.pv)}`,
    meta: [`Created ${r.ca ? dateShort(r.ca).replace(/^[A-Za-z]+, /, "") : "-"}`, `Last contact ${r.lt ? dateShort(r.lt).replace(/^[A-Za-z]+, /, "") : "-"}`, `Follow-up ${r.follow ? dateShort(r.follow).replace(/^[A-Za-z]+, /, "") : "-"}`, d !== null && r.hand ? `${d} d in stage` : "", users.get(r.o) || ""].filter(Boolean).join(" · "),
    href: "#/contacts/" + encodeURIComponent(r.id), move: { data: { move: r.id } },
    action: r.p ? { icon: "call", label: `Call ${r.n || ""}`, href: telHref(tel(r.p)) } : null,
    hold: { "lead-more": r.id }, edge: r.follow && Date.parse(r.follow) < now ? "red" : null,
  });
}

// ------------------------------------------------------------ moving a lead

async function setStage(ctx, r, to) {
  try {
    const g = await ctx.api(`/contacts/${encodeURIComponent(r.id)}`, { cache: false });
    await ctx.api(`/contacts/${encodeURIComponent(r.id)}`, { method: "PATCH", body: { lead_stage: to }, ifMatch: g.etag });
  } catch (err) { toast(err.message || "That didn't move.", { bad: true }); return false; }
  return true;
}
export async function moveLead(ctx, id) {
  const r = (ctx.state.rows || []).find((x) => x.id === id);
  if (!r) return;
  const counts = ctx.state.counts || {};
  const to = await moveSheet(`Move ${r.n || "this lead"}`, STAGES.map(([key, label]) => ({ key, label, count: counts[key] })), r.stage);
  if (!to) return;
  if (to === "not_interested" && r.deal) {
    const why = await pickFrom({ title: "Why not?", items: LOST_REASONS.map((x) => ({ value: x.value, label: x.label })) });
    if (!why) return;
    try { await ctx.api(`/deals/${encodeURIComponent(r.deal)}/lose`, { method: "POST", body: { reason: why } }); } catch (err) { toast(err.message || "The deal didn't close.", { bad: true }); }
  }
  if (!(await setStage(ctx, r, to))) return;
  ctx.keep.col = to;
  toast(`Moved to ${STAGE_LABEL[to]}`);
  if (to === "sold") convertSheet(ctx, id);
  ctx.refresh();
}

function leadMore(ctx, id) {
  const r = (ctx.state.rows || []).find((x) => x.id === id);
  if (!r) return;
  const t = tel(r.p);
  actionSheet(r.n || "Lead", [
    [{ label: "Move to a stage", icon: "swap", hint: STAGE_LABEL[r.stage], run: () => moveLead(ctx, id) },
      t && { label: "Text", icon: "chat", href: "sms:" + t },
      { label: "Convert", icon: "swap", run: () => convertSheet(ctx, id) },
      r.enr && { label: "Open the follow-up", icon: "clock", href: "#/enrollments/" + encodeURIComponent(r.enr) }],
    [r.hand && { label: "Back to the automatic stage", icon: "undo", run: async () => { if (await setStage(ctx, r, null)) { toast("Automatic stage"); ctx.refresh(); } } }],
  ]);
}

// ------------------------------------------------------------ Select (bulk)

function bulkBar(s) {
  const n = s.picked ? s.picked.size : 0;
  return html`<div class="ct-bulk" role="toolbar" aria-label="With the leads picked"><span class="ct-bulk-n" aria-live="polite">${n} picked</span>
    <div class="ct-bulk-acts">${pillBtn("Stage", { icon: "swap", data: { bulk: "lead_stage" }, disabled: !n })}${pillBtn("Priority", { icon: "flag", data: { bulk: "priority" }, disabled: !n })}${pillBtn("Owner", { icon: "user", data: { bulk: "owner" }, disabled: !n })}${pillBtn("Archive", { icon: "archive", data: { bulk: "archive" }, disabled: !n })}${pillBtn("Done", { tone: "solid", data: { bulk: "done" } })}</div></div>`;
}
async function bulk(ctx, what) {
  const s = ctx.state;
  if (what === "done") { s.picked = null; ctx.rerender(); return; }
  if (!s.picked || !s.picked.size) return;
  let value = null;
  if (what === "lead_stage") value = await pickFrom({ title: "Move to", items: STAGES.map(([v, l]) => ({ value: v, label: l })) });
  else if (what === "priority") value = await pickFrom({ title: "Priority", items: [...Object.entries(PRIO).map(([v, [l]]) => ({ value: v, label: l })), { value: "", label: "None" }] });
  else if (what === "owner") {
    let users = [];
    try { users = ((await ctx.api("/users")).data || []).filter((u) => u.status === "active"); } catch (e) { toast(e.message || "The team didn't load.", { bad: true }); return; }
    value = await pickFrom({ title: "Owner", items: [...users.map((u) => ({ value: u.id, label: u.name })), { value: "", label: "Unassigned" }] });
  } else if (what === "archive") value = (await confirmSheet(`Archive ${s.picked.size} ${s.picked.size === 1 ? "lead" : "leads"}? They keep their history; you can restore each one.`, { title: "Archive", yes: "Archive", danger: true })) ? "other" : null;
  if (value === null) return;
  try {
    const r = await ctx.api("/contacts/bulk", { method: "POST", body: { ids: [...s.picked], action: what, value } });
    toast(`Done: ${r.data.done}${r.data.failed.length ? ` (${r.data.failed.length} didn't change)` : ""}`, { bad: !!r.data.failed.length });
    s.picked = null;
    ctx.refresh();
  } catch (err) { toast(err.message || "That didn't save.", { bad: true }); }
}
const pickRow = (r, picked) => {
  const on = picked.has(r.id);
  return html`<li class="rs-lrow ct-pick"><button type="button" ${attrs({ class: "rs-lr-main", "data-pick": r.id, "aria-pressed": on ? "true" : "false" })}><span ${attrs({ class: "ct-box" + (on ? " on" : ""), "aria-hidden": "true" })}>${on ? icon("check") : ""}</span><span class="rs-lr-a"><span class="rs-lr-1"><span class="rs-lr-t">${r.n || "No name"}</span></span><span class="rs-lr-2"><span class="rs-lr-s">${[r.src, STAGE_LABEL[r.stage]].filter(Boolean).join(" · ")}</span></span></span></button></li>`;
};

// ------------------------------------------------------------ the screen

async function openFilter(ctx) {
  const s = ctx.state;
  const v = await filterSheet({
    title: "Filter", values: { show: s.show, sort: s.sort },
    groups: [{ key: "show", label: "Show", type: "chips", options: SHOW }, { key: "sort", label: "Sort", type: "sort", default: "new", options: SORTS }],
    count: (x) => shownLeads(s.rows, { ...s, show: x.show || [], me: ctx.user && ctx.user.id }).length,
  });
  if (!v) return;
  s.show = ctx.keep.show = v.show || [];
  s.sort = ctx.keep.sort = v.sort || "new";
  ctx.rerender();
}

export default {
  title: "Leads",
  async load(params, ctx) {
    ensureStyles();
    const [r, users] = await Promise.all([
      ctx.api("/leads", { cache: false }),
      ctx.can("schedule:read") ? ctx.api("/users").then((u) => u.data || []).catch(() => []) : [],
    ]);
    const ini = (n) => String(n || "").split(/\s+/).filter(Boolean).slice(0, 2).map((w) => w[0].toUpperCase()).join("");
    return {
      rows: r.data || [], counts: (r.meta && r.meta.counts) || {}, users: new Map(users.map((u) => [u.id, ini(u.name)])), view: viewOf(),
      q: ctx.keep.q || "", show: Array.isArray(ctx.keep.show) ? ctx.keep.show : [], sort: ctx.keep.sort || "new", tile: ctx.keep.tile || "all",
      find: !!ctx.keep.find || !!ctx.keep.q, picked: null,
    };
  },
  render(s, ctx) {
    const me = ctx.user && ctx.user.id;
    const search = html`<label class="${"ld-search" + (s.find ? " open" : "")}">${icon("search")}<span class="sr">Search leads</span><input type="search" data-lq ${attrs({ value: s.q, placeholder: "Search leads", autocomplete: "off" })}></label>`;
    if (s.view === "board") {
      const list = shownLeads(s.rows, { ...s, me, tile: "all" });
      return html`<div class="stack sl-leads ld-board">${search}
        ${board({ name: "leads", label: "Leads", on: ctx.keep.col || null, columns: STAGES.map(([key, label]) => {
          const cards = list.filter((r) => r.stage === key);
          return { key, label, count: cards.length, amount: cards.reduce((n, r) => n + (r.pv || 0), 0) || null, empty: "No leads here", cards: cards.slice(0, 150).map((r) => leadCardHtml(r, { users: s.users })) };
        }) })}
      </div>`;
    }
    const list = shownLeads(s.rows, { ...s, me });
    const tiles = [{ key: "all", label: "All", value: s.rows.length }, ...STAGES.map(([key, label]) => ({ key, label, value: s.counts[key] || 0 }))];
    return html`<div class="stack sl-leads">${search}
      ${tileRow(tiles, { name: "ld", on: s.tile, label: "Stages" })}
      <p class="small muted ld-count">${list.length === 1 ? "1 lead" : `${list.length} leads`}</p>
      ${s.picked ? html`<ul class="rs-card flush rs-list">${list.slice(0, 300).map((r) => pickRow(r, s.picked))}</ul>${bulkBar(s)}`
        : listCard(list.slice(0, 300).map(leadRow), { label: "Leads", empty: s.q || s.show.length || s.tile !== "all" ? "No leads match." : "No leads yet. New website requests and leads you add show here." })}
      ${list.length > 300 ? html`<p class="small muted">The first 300 are shown; search or filter for the rest.</p>` : ""}
    </div>`;
  },
  // (a phone: Rotor's round buttons on top; the search opens in place, the filter is a sheet, "..." holds Select)
  mount(view, s, ctx) {
    if (s.view === "board") boardMount(view);
    const on = s.show.length || s.sort !== "new";
    screenButtons([
      { key: "find", icon: "search", label: "Search leads", on: s.find, expanded: s.find },
      { key: "filter", icon: "filter", label: on ? "Filter (on)" : "Filter", on },
      { key: "more", icon: "more", label: "More" },
    ], (key) => {
      if (key === "find") { s.find = !s.find || !!s.q; ctx.keep.find = s.find; ctx.rerender(); if (s.find) { const i = document.querySelector("[data-lq]"); if (i) i.focus(); } return; }
      if (key === "filter") { openFilter(ctx); return; }
      actionSheet("Leads", leadsMore(s, ctx));
    });
  },
  more: (s, ctx) => leadsMore(s, ctx),
  events: {
    "input [data-lq]": (e, el, ctx) => {
      ctx.state.q = ctx.keep.q = el.value;
      clearTimeout(ctx.state.t);
      ctx.state.t = setTimeout(() => { const pos = el.selectionStart; ctx.rerender(); const i = document.querySelector("[data-lq]"); if (i) { i.focus(); try { i.setSelectionRange(pos, pos); } catch (x) { /* fine */ } } }, 150);
    },
    "click [data-tile=ld]": (e, el, ctx) => { ctx.state.tile = ctx.keep.tile = tileToggle(ctx.state.tile, el.dataset.key, "all"); ctx.rerender(); },
    "click [data-move]": (e, el, ctx) => moveLead(ctx, el.dataset.move),
    "rs-hold [data-lead-more]": (e, el, ctx) => leadMore(ctx, el.dataset.leadMore),
    "click [data-pick]": (e, el, ctx) => { const p = ctx.state.picked; if (!p) return; if (p.has(el.dataset.pick)) p.delete(el.dataset.pick); else p.add(el.dataset.pick); ctx.rerender(); },
    "click [data-bulk]": (e, el, ctx) => bulk(ctx, el.dataset.bulk),
    "click [data-convert]": (e, el, ctx) => convertSheet(ctx, el.dataset.convert),
  },
};

function leadsMore(s, ctx) {
  if (!s || !s.rows) return [];
  return [[
    ctx.can("contacts:write") && s.view !== "board" && { label: s.picked ? "Stop selecting" : "Select", icon: "check", data: { "ld-select": true }, run: () => { s.picked = s.picked ? null : new Set(); ctx.rerender(); } },
    ctx.can("contacts:read_all") && { label: "Archived (the Customers list's tile)", icon: "archive", href: "#/contacts" },
  ]];
}

// Convert (⇄): what the CRM already offers for a lead.
export function convertSheet(ctx, id) {
  const c = encodeURIComponent(id);
  const s = sheet({
    title: "Convert this lead",
    body: html`<ul class="menu">
      ${ctx.can("quotes:write") ? html`<li><a ${attrs({ href: "#/quotes/new/" + c })} data-close>${icon("doc")}<span>Start a quote</span></a></li>` : ""}
      ${ctx.can("schedule:write") ? html`<li><a ${attrs({ href: "#/jobs/new/" + c })} data-close>${icon("schedule")}<span>Book a job</span></a></li>` : ""}
      ${ctx.can("contacts:write") ? html`<li><button type="button" data-customer>${icon("contacts")}<span>Make them a customer</span></button></li>` : ""}
    </ul>`,
    events: {
      "click [data-close]": () => s.close(),
      "click [data-customer]": async () => {
        try {
          const g = await ctx.api(`/contacts/${c}`, { cache: false });
          await ctx.api(`/contacts/${c}`, { method: "PATCH", body: { lifecycle: "customer" }, ifMatch: g.etag });
          s.close();
          toast("They're a customer now.");
          ctx.refresh();
        } catch (err) { toast(err.message || "That didn't save.", { bad: true }); }
      },
    },
  });
}
