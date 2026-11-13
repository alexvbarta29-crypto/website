// Pipeline (the Nov 2026 layout, after Rotor's Pipeline; the Sales tab's
// first screen): a pipeline is one of the follow-up cadences (Rotor's
// imported pipelines, like Referrals, are board-only cadences), its stages
// the cadence's steps or board stages. A dropdown picks the pipeline; a
// list / board toggle (coral when on). List: cards with the name, the
// status (Open, Paused), the type (Lead, Customer), the stage, VALUE (the
// open deal) and DUE, and call, text and convert. Board: a column per stage
// ("New 57 · $0"; "No opportunities" when empty) scrolling sideways, cards
// with a blue edge, the name, Open, the type and the amount. Moving a card on
// (dragging it to the next column on a desk, or Move on a phone) marks its
// step done by hand (POST /enrollments/:id/advance), as the follow-up screen
// does; a board-only pipeline's stages are Rotor's and stay read-only here.

import { html, icon, attrs, sheet, toast } from "../../core/ui.js";
import { money, dateShort } from "../../core/format.js";
import { ensureStyles, telHref } from "./kit.js";
import { convertSheet } from "./leads.js";

const $ = (c) => money(c || 0).replace(/\.00$/, "");
const phoneOf = (r) => (r && r.p && r.p[0] ? (String(r.p[0]).length === 10 ? "+1" + r.p[0] : String(r.p[0])) : "");

// The stages of a pipeline and its cards in them (pure, for the tests).
export function board(cadence, rows = [], { deals = [], index = [] } = {}) {
  const names = cadence && cadence.board_only ? (cadence.board_stages || []) : ((cadence && cadence.steps) || []).map((st, i) => st.label || `Step ${i + 1}`);
  const stages = names.length ? names.map((n, i) => ({ n: i + 1, name: n, cards: [] })) : [{ n: 1, name: "New", cards: [] }];
  const deal = new Map(deals.map((d) => [d.c, d]));
  const who = new Map(index.map((r) => [r.id, r]));
  for (const e of rows) {
    const d = deal.get(e.c);
    const c = who.get(e.c);
    const card = { id: e.id, contact_id: e.c, name: e.cn || (c && c.n) || "Someone", status: e.st === "paused" ? "Paused" : "Open", type: c && c.lc === "customer" ? "Customer" : "Lead", stage: e.lbl || "", value: d && Number.isSafeInteger(d.v) ? d.v : 0, due: e.due || null, phone: phoneOf(c), step: e.n || 1 };
    const at = stages.find((s) => s.name === e.lbl) || stages[Math.min(Math.max((e.n || 1) - 1, 0), stages.length - 1)];
    at.cards.push(card);
  }
  for (const s of stages) s.total = s.cards.reduce((n, c) => n + c.value, 0);
  return stages;
}

const listCard = (c) => html`<li class="lc" ${attrs({ "data-card": c.id })}><a class="lc-top" ${attrs({ href: "#/enrollments/" + encodeURIComponent(c.id) })}>
  <span class="lc-nm">${c.name}</span><span class="lc-pills"><span ${attrs({ class: "pp-st" + (c.status === "Paused" ? " paused" : "") })}>${c.status}</span><span class="lc-stage">${c.type}</span>${c.stage ? html`<span class="pp-stage">${c.stage}</span>` : ""}</span></a>
  <div class="lc-band"><span class="cc-k"><small>Value</small><b>${$(c.value)}</b></span><span class="cc-k"><small>Due</small><b>${c.due ? dateShort(c.due) : "-"}</b></span>
    <span class="cc-acts">${c.phone ? html`<a class="rnd" ${attrs({ href: telHref(c.phone), "aria-label": `Call ${c.name}` })}>${icon("phone")}</a><a class="rnd" ${attrs({ href: "sms:" + c.phone, "aria-label": `Text ${c.name}` })}>${icon("text")}</a>` : ""}<button type="button" class="rnd ink" ${attrs({ "data-convert": c.contact_id, "aria-label": `Convert ${c.name}` })}>${icon("swap")}</button></span></div></li>`;

const boardCard = (c, movable) => html`<li class="pp-card" ${attrs({ "data-card": c.id, draggable: movable ? "true" : null })}><a ${attrs({ href: "#/enrollments/" + encodeURIComponent(c.id) })}>
  <span class="pp-top"><span class="pp-nm">${c.name}</span><span ${attrs({ class: "pp-st" + (c.status === "Paused" ? " paused" : "") })}>${c.status}</span></span>
  <span class="pp-bot"><span>${c.type}</span><b class="num">${$(c.value)}</b></span></a>${movable ? html`<button type="button" class="pp-move" ${attrs({ "data-move": c.id })}>Move on</button>` : ""}</li>`;

export default {
  title: "Pipeline",
  async load(params, ctx) {
    ensureStyles();
    const cads = (await ctx.api("/cadences")).data || [];
    const pick = cads.find((c) => c.id === ctx.keep.pipe) || cads.find((c) => c.active) || cads[0] || null;
    if (!pick) return { cads, pick: null, stages: [], view: ctx.keep.view || "list" };
    const [cad, rows, deals, ix] = await Promise.all([
      ctx.api(`/cadences/${encodeURIComponent(pick.id)}`).then((r) => r.data.cadence),
      ctx.api(`/enrollments?cadence=${encodeURIComponent(pick.key)}`, { cache: false }).then((r) => r.data || []),
      ctx.api("/deals", { cache: false }).then((r) => r.data || []).catch(() => []),
      ctx.api("/contacts/index").then((r) => (r.data && r.data.rows) || []).catch(() => []),
    ]);
    return { cads, pick, board_only: !!cad.board_only, stages: board(cad, rows, { deals, index: ix }), view: ctx.keep.view || "list" };
  },
  render(s) {
    const movable = !s.board_only;
    const cards = s.stages.flatMap((st) => st.cards);
    return html`<div class="stack pp-page">
      <div class="pp-bar">
        <label class="pp-pick"><span class="sr">Pipeline</span><select data-pipe>${s.cads.map((c) => html`<option ${attrs({ value: c.id, selected: !!s.pick && c.id === s.pick.id })}>${c.name}</option>`)}</select></label>
        <div class="pp-toggle" role="group" aria-label="View"><button type="button" ${attrs({ "data-view": "list", "aria-pressed": String(s.view === "list"), "aria-label": "List" })}>${icon("list")}</button><button type="button" ${attrs({ "data-view": "board", "aria-pressed": String(s.view === "board"), "aria-label": "Board" })}>${icon("grid")}</button></div>
      </div>
      ${!s.pick ? html`<div class="card empty"><h2>No pipelines yet</h2><p>Follow-ups (Settings, Cadences) and Rotor's pipelines show here.</p></div>`
        : s.view === "board" ? html`<div class="pp-board" data-board>${s.stages.map((st) => html`<section class="pp-col" ${attrs({ "data-stage": String(st.n) })}><h3 class="pp-ch"><span>${st.name}</span><span class="pp-cnt">${String(st.cards.length)}</span></h3><p class="pp-tot">${$(st.total)}</p>
            ${st.cards.length ? html`<ul class="pp-cards">${st.cards.map((c) => boardCard(c, movable))}</ul>` : html`<p class="pp-none">No opportunities</p>`}</section>`)}</div>`
        : cards.length ? html`<ul class="cc-list">${cards.map((c) => listCard(c))}</ul>` : html`<div class="card empty"><h2>Nobody in this pipeline</h2><p>Start a follow-up from a contact to add them.</p></div>`}
      ${s.board_only ? html`<p class="small muted">Rotor's pipeline: its stages stay as Rotor had them.</p>` : ""}
    </div>`;
  },
  mount(view, s, ctx) {
    const b = view.querySelector("[data-board]");
    if (!b || s.board_only) return;
    let dragging = null;
    b.addEventListener("dragstart", (e) => { const li = e.target.closest("[data-card]"); dragging = li ? li.dataset.card : null; if (dragging && e.dataTransfer) e.dataTransfer.setData("text/plain", dragging); });
    b.addEventListener("dragover", (e) => { if (dragging && e.target.closest("[data-stage]")) e.preventDefault(); });
    b.addEventListener("drop", (e) => {
      const col = e.target.closest("[data-stage]");
      if (!col || !dragging) return;
      e.preventDefault();
      moveTo(ctx, dragging, Number(col.dataset.stage));
      dragging = null;
    });
  },
  events: {
    "change [data-pipe]": (e, el, ctx) => { ctx.keep.pipe = el.value; ctx.refresh(); },
    "click [data-view]": (e, el, ctx) => { ctx.keep.view = el.dataset.view; ctx.state.view = el.dataset.view; ctx.rerender(); },
    "click [data-convert]": (e, el, ctx) => convertSheet(ctx, el.dataset.convert),
    "click [data-move]": (e, el, ctx) => {
      const card = ctx.state.stages.flatMap((st) => st.cards).find((c) => c.id === el.dataset.move);
      if (!card) return;
      const next = ctx.state.stages.find((st) => st.n === card.step + 1);
      const sh = sheet({
        title: `Move ${card.name}`,
        body: html`<p class="muted">${next ? `On to "${next.name}": this marks "${card.stage || "this step"}" done by hand.` : "This is the last stage."}</p>${next ? html`<div class="btn-row"><button type="button" class="btn primary" data-go>Move on</button></div>` : ""}`,
        events: { "click [data-go]": () => { sh.close(); moveTo(ctx, card.id, card.step + 1); } },
      });
    },
  },
};

async function moveTo(ctx, id, stage) {
  const card = ctx.state.stages.flatMap((st) => st.cards).find((c) => c.id === id);
  if (!card || stage === card.step) return;
  if (stage !== card.step + 1) { toast("Move one stage on at a time. Open the follow-up for the rest.", { bad: true }); return; }
  try { await ctx.api(`/enrollments/${encodeURIComponent(id)}/advance`, { method: "POST", body: {} }); toast("Moved on"); ctx.refresh(); }
  catch (err) { toast(err.message || "That didn't move.", { bad: true }); }
}
