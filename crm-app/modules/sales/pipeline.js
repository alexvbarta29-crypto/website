// Pipelines (guide-gaps §2.7 P1-P10, Rotor's Pipelines): a pipeline is one
// of the follow-up cadences (Rotor's imported pipelines, like Giveaway, are
// board-only cadences), its stages the cadence's steps or a board's stages.
// The picker on top ("New Lead ⌄") opens a sheet of the pipelines and All
// pipelines (which lists everyone, grouped by pipeline). Two views under the
// section's tabs, List | Board (#/pipeline?view=list|board):
//
//   List   two-line rows: the name and the value; the stage · due, Open or
//          Paused, Lead or Customer; a round call; a long press: Text,
//          Convert, Move to a stage.
//   Board  a stage strip with counts, swiped columns with their $; a card's
//          Move opens the stage sheet: any stage, forward or back (POST
//          /enrollments/:id/move: the steps skipped send nothing). Rotor's
//          own follow-ups stay as Rotor has them until the switch.
//
// The filter sheet: Open or Paused, Lead or Customer, due today. "...": Add
// someone (a contact into this pipeline), Manage pipelines.

import { html, icon, attrs, toast, board as kitBoard, boardCard, boardMount, moveSheet, listRow, listCard, filterSheet, actionSheet, pillTap } from "../../core/ui.js";
import { money, dateShort, localDate } from "../../core/format.js";
import { pickContact, pickFrom } from "../../core/pickers.js";
import { ensureStyles, telHref } from "./kit.js";
import { convertSheet } from "./leads.js";
import { screenButtons } from "../../core/nav.js";

const $ = (c) => money(c || 0).replace(/\.00$/, "");
const phoneOf = (r) => (r && r.p && r.p[0] ? (String(r.p[0]).length === 10 ? "+1" + r.p[0] : String(r.p[0])) : "");
const viewOf = () => { try { return new URLSearchParams((location.hash.split("?")[1]) || "").get("view") === "board" ? "board" : "list"; } catch (e) { return "list"; } };
const ALL = "__all";

// The stages of a pipeline and its cards in them (pure, for the tests).
export function board(cadence, rows = [], { deals = [], index = [] } = {}) {
  const names = cadence && cadence.board_only ? (cadence.board_stages || []) : ((cadence && cadence.steps) || []).map((st, i) => st.label || `Step ${i + 1}`);
  const stages = names.length ? names.map((n, i) => ({ n: i + 1, name: n, cards: [] })) : [{ n: 1, name: "New", cards: [] }];
  const deal = new Map(deals.map((d) => [d.c, d]));
  const who = new Map(index.map((r) => [r.id, r]));
  for (const e of rows) {
    const d = deal.get(e.c);
    const c = who.get(e.c);
    const card = { id: e.id, contact_id: e.c, name: e.cn || (c && c.n) || "Someone", status: e.st === "paused" ? "Paused" : "Open", type: c && c.lc === "customer" ? "Customer" : "Lead", stage: e.lbl || "", value: d && Number.isSafeInteger(d.v) ? d.v : 0, due: e.due || null, phone: phoneOf(c), step: e.n || 1, cad: e.cad || null };
    const at = stages.find((s) => s.name === e.lbl) || stages[Math.min(Math.max((e.n || 1) - 1, 0), stages.length - 1)];
    at.cards.push(card);
  }
  for (const s of stages) s.total = s.cards.reduce((n, c) => n + c.value, 0);
  return stages;
}

// The filter (pure): open or paused, lead or customer, due today; and the search.
export function shownCards(cards, { q = "", f = {} } = {}, today = localDate(new Date())) {
  const w = String(q || "").trim().toLowerCase();
  return cards.filter((c) => (!w || c.name.toLowerCase().includes(w))
    && (!f.st || (f.st === "paused" ? c.status === "Paused" : c.status === "Open"))
    && (!f.type || c.type === (f.type === "customer" ? "Customer" : "Lead"))
    && (!f.today || (c.due && String(c.due).slice(0, 10) <= today)));
}

const cardRow = (c, cadName) => listRow({
  title: c.name, amount: c.value || null, sub: [cadName, c.stage, c.due ? `due ${dateShort(c.due).replace(/^[A-Za-z]+, /, "")}` : ""].filter(Boolean).join(" · "),
  tag: c.type, pill: c.status === "Paused" ? "Paused" : { label: "Open", tone: "blue" }, href: "#/enrollments/" + encodeURIComponent(c.id),
  action: c.phone ? { icon: "call", label: `Call ${c.name}`, href: telHref(c.phone) } : null, hold: { "pp-more": c.id },
});
const card = (c) => boardCard({
  title: c.name, pill: c.status === "Paused" ? "Paused" : { label: "Open", tone: "blue" }, sub: `${c.type} · ${$(c.value)}`, meta: c.due ? `Due ${dateShort(c.due).replace(/^[A-Za-z]+, /, "")}` : "",
  href: "#/enrollments/" + encodeURIComponent(c.id), move: { data: { move: c.id } },
  action: c.phone ? { icon: "call", label: `Call ${c.name}`, href: telHref(c.phone) } : null, hold: { "pp-more": c.id },
});

export default {
  title: "Pipeline",
  async load(params, ctx) {
    ensureStyles();
    const cads = (await ctx.api("/cadences")).data || [];
    const all = ctx.keep.pipe === ALL;
    const pick = all ? null : cads.find((c) => c.id === ctx.keep.pipe) || cads.find((c) => c.active) || cads[0] || null;
    const base = { cads, all, pick, view: all ? "list" : viewOf(), q: ctx.keep.q || "", find: !!ctx.keep.q, f: ctx.keep.f || {} };
    if (!pick && !all) return { ...base, stages: [] };
    const [cad, rows, deals, ix] = await Promise.all([
      all ? null : ctx.api(`/cadences/${encodeURIComponent(pick.id)}`).then((r) => r.data.cadence),
      ctx.api(`/enrollments?cadence=${all ? "all" : encodeURIComponent(pick.key)}`, { cache: false }).then((r) => r.data || []),
      ctx.api("/deals", { cache: false }).then((r) => r.data || []).catch(() => []),
      ctx.api("/contacts/index").then((r) => (r.data && r.data.rows) || []).catch(() => []),
    ]);
    if (all) {
      // every pipeline as a group (each its own stages)
      const groups = cads.map((c) => ({ cad: c, cards: board({ board_only: true, board_stages: [] }, rows.filter((e) => e.cad === c.key), { deals, index: ix }).flatMap((s) => s.cards) })).filter((g) => g.cards.length);
      return { ...base, groups, stages: [] };
    }
    return { ...base, cad, board_only: !!cad.board_only, stages: board(cad, rows, { deals, index: ix }) };
  },
  render(s, ctx) {
    const name = s.all ? "All pipelines" : s.pick ? s.pick.name : "No pipelines";
    const picker = html`<div class="pp-bar">${pillTap(name, { icon: "pipeline", data: { "pipe-pick": true }, aria: `Pipeline: ${name}. Change` })}</div>`;
    const search = html`<label class="${"ld-search" + (s.find ? " open" : "")}">${icon("search")}<span class="sr">Search this pipeline</span><input type="search" data-pq ${attrs({ value: s.q || "", placeholder: "Search this pipeline", autocomplete: "off" })}></label>`;
    if (!s.pick && !s.all) return html`<div class="stack pp-page">${picker}<div class="card empty"><h2>No pipelines yet</h2><p>Follow-ups (Manage pipelines) and Rotor's pipelines show here.</p></div></div>`;
    if (s.all) {
      const groups = (s.groups || []).map((g) => ({ ...g, cards: shownCards(g.cards, s) })).filter((g) => g.cards.length);
      return html`<div class="stack pp-page">${search}${picker}
        ${groups.length ? groups.map((g) => html`<h3 class="rs-label">${g.cad.name} · ${String(g.cards.length)}</h3>${listCard(g.cards.map((c) => cardRow(c, "")))}`) : html`<div class="rs-card"><p class="rs-empty">Nobody in a pipeline${s.q ? " matches" : ""}.</p></div>`}
      </div>`;
    }
    const stages = s.stages.map((st) => ({ ...st, cards: shownCards(st.cards, s) }));
    if (s.view === "board") {
      return html`<div class="stack pp-page">${search}${picker}
        ${kitBoard({ name: "pipe", label: name, on: ctx.keep.col || null, columns: stages.map((st) => ({ key: String(st.n), label: st.name, count: st.cards.length, amount: st.cards.reduce((n, c) => n + c.value, 0) || null, empty: "No opportunities", cards: st.cards.slice(0, 150).map(card) })) })}
      </div>`;
    }
    const cards = stages.flatMap((st) => st.cards);
    return html`<div class="stack pp-page">${search}${picker}
      ${listCard(cards.slice(0, 300).map((c) => cardRow(c, "")), { label: name, empty: s.q ? "Nobody matches." : "Nobody in this pipeline. Add someone from the ... button, or start a follow-up from a contact." })}
    </div>`;
  },
  mount(view, s, ctx) {
    if (s.view === "board") boardMount(view);
    const f = s.f || {};
    const on = !!(f.st || f.type || f.today);
    screenButtons([
      { key: "find", icon: "search", label: "Search this pipeline", on: s.find, expanded: s.find },
      { key: "filter", icon: "filter", label: on ? "Filter (on)" : "Filter", on },
      { key: "more", icon: "more", label: "More" },
    ], async (key) => {
      if (key === "find") { s.find = !s.find || !!s.q; ctx.rerender(); if (s.find) { const i = document.querySelector("[data-pq]"); if (i) i.focus(); } return; }
      if (key === "more") { actionSheet("Pipelines", pipeMore(s, ctx)); return; }
      const v = await filterSheet({ title: "Filter", values: f, groups: [
        { key: "st", label: "Status", type: "radio", options: [["open", "Open"], ["paused", "Paused"]] },
        { key: "type", label: "Who", type: "radio", options: [["lead", "Leads"], ["customer", "Customers"]] },
        { key: "today", label: "Due", type: "toggle", text: "Due today or late" },
      ] });
      if (v) { s.f = ctx.keep.f = v; ctx.rerender(); }
    });
  },
  more: (s, ctx) => pipeMore(s, ctx),
  events: {
    "input [data-pq]": (e, el, ctx) => {
      ctx.state.q = ctx.keep.q = el.value;
      clearTimeout(ctx.state.t);
      ctx.state.t = setTimeout(() => { const pos = el.selectionStart; ctx.rerender(); const i = document.querySelector("[data-pq]"); if (i) { i.focus(); try { i.setSelectionRange(pos, pos); } catch (x) { /* fine */ } } }, 150);
    },
    "click [data-pipe-pick]": async (e, el, ctx) => {
      const s = ctx.state;
      const v = await pickFrom({ title: "Pipeline", items: [{ value: ALL, label: "All pipelines", sub: s.all ? "now" : "" }, ...s.cads.map((c) => ({ value: c.id, label: c.name, sub: [s.pick && c.id === s.pick.id ? "now" : "", c.active ? "" : "off", c.board_only ? "board" : ""].filter(Boolean).join(" · ") }))] });
      if (v === null) return;
      ctx.keep.pipe = v;
      delete ctx.keep.col;
      ctx.refresh();
    },
    "click [data-convert]": (e, el, ctx) => convertSheet(ctx, el.dataset.convert),
    "click [data-move]": (e, el, ctx) => moveCard(ctx, el.dataset.move),
    "rs-hold [data-pp-more]": (e, el, ctx) => cardMore(ctx, el.dataset.ppMore),
  },
};

const cardsOf = (s) => (s.all ? (s.groups || []).flatMap((g) => g.cards) : s.stages.flatMap((st) => st.cards));

async function moveCard(ctx, id) {
  const s = ctx.state;
  const c = cardsOf(s).find((x) => x.id === id);
  if (!c || s.all) return;
  const to = await moveSheet(`Move ${c.name}`, s.stages.map((st) => ({ key: String(st.n), label: st.name, count: st.cards.length })), String(c.step));
  if (!to) return;
  try {
    await ctx.api(`/enrollments/${encodeURIComponent(id)}/move`, { method: "POST", body: { step: Number(to) } });
    ctx.keep.col = to;
    toast(`Moved to ${(s.stages.find((st) => String(st.n) === to) || {}).name || "the stage"}`);
    ctx.refresh();
  } catch (err) { toast(err.message || "That didn't move.", { bad: true }); }
}

function cardMore(ctx, id) {
  const c = cardsOf(ctx.state).find((x) => x.id === id);
  if (!c) return;
  actionSheet(c.name, [[
    !ctx.state.all && { label: "Move to a stage", icon: "swap", hint: c.stage, run: () => moveCard(ctx, id) },
    c.phone && { label: "Text", icon: "chat", href: "sms:" + c.phone },
    { label: "Convert", icon: "swap", run: () => convertSheet(ctx, c.contact_id) },
    { label: "Open the contact", icon: "user", href: "#/contacts/" + encodeURIComponent(c.contact_id) },
  ]]);
}

function pipeMore(s, ctx) {
  if (!s || !s.cads) return [];
  return [[
    s.pick && s.pick.active && { label: `Add someone to ${s.pick.name}`, icon: "userplus", data: { "pp-add": true }, run: () => addSomeone(ctx) },
    ctx.can("cadences:configure") && { label: "Manage pipelines", icon: "gear", href: "#/settings/cadences" },
  ]];
}

// + Add opportunity (P5): a contact into this pipeline (a board's first stage, or a cadence's step 1).
async function addSomeone(ctx) {
  const s = ctx.state;
  const who = await pickContact(ctx.api, { title: `Add to ${s.pick.name}` });
  if (!who) return;
  try { await ctx.api("/enrollments", { method: "POST", body: { contact_id: who.id, cadence_key: s.pick.key } }); toast(`${who.name} added`); ctx.refresh(); }
  catch (err) { toast(err.message || "That didn't add them.", { bad: true }); }
}
