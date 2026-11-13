// Leads (the Nov 2026 layout, after Rotor's Leads list): every lead as a
// card: the name, a priority pill (from their open task's priority, when
// one has it) and a stage pill (their follow-up's step, else the deal's
// status), a lower band with PV (the open deal's potential value) and FOLLOW
// UP (the follow-up's next due day, or "-"), and round call, text and a
// black convert button (start a quote, book a job, or make them a
// customer). From the contacts index, the open follow-ups, the open deals
// and the open tasks: four reads the app already uses.

import { html, icon, attrs, sheet, toast } from "../../core/ui.js";
import { money, dateShort } from "../../core/format.js";
import { screenButtons } from "../../core/nav.js";
import { ensureStyles, telHref } from "./kit.js";

const PRIO = { high: ["High", "red"], medium: ["Medium", "orange"], low: ["Low", "grey"] };
const DEAL = { open: "Open", quoted: "Quoted" };
const phoneOf = (r) => (r.p && r.p[0] ? (String(r.p[0]).length === 10 ? "+1" + r.p[0] : String(r.p[0])) : "");

export function leadCards(ix = [], { enrollments = [], deals = [], tasks = [] } = {}) {
  const enr = new Map();
  for (const e of enrollments) if (e.c && (!enr.has(e.c) || String(e.due || "") < String(enr.get(e.c).due || "9"))) enr.set(e.c, e);
  const deal = new Map(deals.map((d) => [d.c, d]));
  const prio = new Map();
  const rank = { high: 3, medium: 2, low: 1 };
  for (const t of tasks) if (t.c && (rank[t.pr] || 0) > (rank[prio.get(t.c)] || 0)) prio.set(t.c, t.pr);
  return ix.filter((r) => r.lc === "lead").map((r) => {
    const e = enr.get(r.id);
    const d = deal.get(r.id);
    return { id: r.id, name: r.n || "No name", phone: phoneOf(r), priority: prio.get(r.id) || null, stage: e ? e.lbl || "Following up" : d ? DEAL[d.st] || d.st : "New", pv: d && Number.isSafeInteger(d.v) ? d.v : null, follow: e && e.due ? e.due : null, paused: !!e && e.st === "paused" };
  }).sort((a, b) => String(a.follow || "9").localeCompare(String(b.follow || "9")) || a.name.localeCompare(b.name));
}

export const leadCard = (l) => html`<li class="lc"><a class="lc-top" ${attrs({ href: "#/contacts/" + encodeURIComponent(l.id) })}>
  <span class="lc-nm">${l.name}</span><span class="lc-pills">${l.priority ? html`<span ${attrs({ class: "lc-pr " + (PRIO[l.priority] || PRIO.medium)[1] })}>${(PRIO[l.priority] || PRIO.medium)[0]}</span>` : ""}<span class="lc-stage">${l.paused ? "Paused" : l.stage}</span></span></a>
  <div class="lc-band"><span class="cc-k"><small>PV</small><b>${l.pv === null ? "-" : money(l.pv).replace(/\.00$/, "")}</b></span><span class="cc-k"><small>Follow up</small><b>${l.follow ? dateShort(l.follow) : "-"}</b></span>
    <span class="cc-acts">${l.phone ? html`<a class="rnd" ${attrs({ href: telHref(l.phone), "aria-label": `Call ${l.name}` })}>${icon("call")}</a><a class="rnd" ${attrs({ href: "sms:" + l.phone, "aria-label": `Text ${l.name}` })}>${icon("chat")}</a>` : ""}<button type="button" class="rnd ink" ${attrs({ "data-convert": l.id, "aria-label": `Convert ${l.name}` })}>${icon("swap")}</button></span></div></li>`;

// The filter sheet's choices (what the cards already say).
const SHOW = [["", "All"], ["follow", "With a follow-up"], ["new", "New"], ["paused", "Paused"]];
const shown = (s) => s.cards.filter((c) => (s.show === "follow" ? !!c.follow : s.show === "new" ? c.stage === "New" : s.show === "paused" ? c.paused : true));

export default {
  title: "Leads",
  async load(params, ctx) {
    ensureStyles();
    const [ix, enr, deals, tasks] = await Promise.all([
      ctx.api("/contacts/index").then((r) => (r.data && r.data.rows) || []),
      ctx.can("sales:work") ? ctx.api("/enrollments", { cache: false }).then((r) => r.data || []).catch(() => []) : [],
      ctx.can("sales:work") ? ctx.api("/deals", { cache: false }).then((r) => r.data || []).catch(() => []) : [],
      ctx.api("/tasks", { cache: false }).then((r) => ((r.data && (r.data.all || r.data.items)) || (Array.isArray(r.data) ? r.data : []))).catch(() => []),
    ]);
    return { cards: leadCards(ix, { enrollments: enr, deals, tasks: tasks.map((t) => ({ c: t.c || t.contact_id, pr: t.pr || t.priority })) }), q: ctx.keep.q || "", show: ctx.keep.show || "", find: !!ctx.keep.find || !!ctx.keep.q };
  },
  render(s) {
    const q = s.q.trim().toLowerCase();
    const list = shown(s).filter((c) => !q || c.name.toLowerCase().includes(q));
    return html`<div class="stack sl-leads">
      <label class="${"ld-search" + (s.find ? " open" : "")}">${icon("search")}<span class="sr">Search leads</span><input type="search" data-lq ${attrs({ value: s.q, placeholder: "Search leads", autocomplete: "off" })}></label>
      <p class="small muted ld-count">${list.length === 1 ? "1 lead" : `${list.length} leads`}${s.show ? ` · ${SHOW.find(([k]) => k === s.show)[1]}` : ""}</p>
      ${list.length ? html`<ul class="cc-list">${list.slice(0, 200).map(leadCard)}</ul>` : html`<div class="card empty"><h2>No leads${q ? " match" : " yet"}</h2><p>New website requests and leads you add show here.</p></div>`}
    </div>`;
  },
  // (a phone: Rotor's round buttons on top; the search opens in place, the filter is a sheet)
  mount(view, s, ctx) {
    screenButtons([
      { key: "find", icon: "search", label: "Search leads", on: s.find, expanded: s.find },
      { key: "filter", icon: "filter", label: s.show ? "Filter (on)" : "Filter", on: !!s.show },
    ], (key) => {
      if (key === "find") { s.find = !s.find || !!s.q; ctx.keep.find = s.find; ctx.rerender(); if (s.find) { const i = document.querySelector("[data-lq]"); if (i) i.focus(); } return; }
      const sh = sheet({
        title: "Show",
        body: html`<div class="chips wrap" role="group" aria-label="Show">${SHOW.map(([k, l]) => html`<button type="button" class="chip" ${attrs({ "data-show": k, "aria-pressed": String(s.show === k) })}>${l}</button>`)}</div>`,
        events: { "click [data-show]": (e, b) => { s.show = ctx.keep.show = b.dataset.show; sh.close(); ctx.rerender(); } },
      });
    });
  },
  events: {
    "input [data-lq]": (e, el, ctx) => {
      ctx.state.q = ctx.keep.q = el.value;
      clearTimeout(ctx.state.t);
      ctx.state.t = setTimeout(() => { const pos = el.selectionStart; ctx.rerender(); const i = document.querySelector("[data-lq]"); if (i) { i.focus(); try { i.setSelectionRange(pos, pos); } catch (x) { /* fine */ } } }, 150);
    },
    "click [data-convert]": (e, el, ctx) => convertSheet(ctx, el.dataset.convert),
  },
};

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
