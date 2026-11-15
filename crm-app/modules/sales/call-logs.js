// Power Dialer → Call logs (guide-gaps §2.8 D8, D9, D12, Rotor's Call Logs):
// the dates chip (This month ⌄), seven tiles (info only: total, answered,
// voicemails, completed, today, avg duration, calls per hour), a row of
// tiles per person (calls, booked, not interested), the search, and the calls
// as two-line rows (the name and the outcome; who · when · how long, or "-"
// until calls go through the business line). The filter: who, the outcome.

import { html, icon, attrs, tileRow, listRow, listCard, periodChip, periodSheet, periodRange, periodLabel, filterSheet } from "../../core/ui.js";
import { screenButtons } from "../../core/nav.js";
import { dateShort, time, localDate } from "../../core/format.js";
import { ensureStyles } from "./kit.js";

export const OUT = { no_answer: ["No answer", "grey"], voicemail: ["Voicemail", "amber"], spoke: ["Talked", "green"], booked: ["Booked", "green"], not_interested: ["Not interested", "red"], wrong_number: ["Wrong number", "red"], calling: ["Calling", "blue"] };
const dur = (s) => (Number.isSafeInteger(s) ? `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}` : "-");

export const statTiles = (st) => [
  { key: "total", label: "Total calls", value: st.total, info: true }, { key: "answered", label: "Answered", value: st.answered, info: true },
  { key: "vm", label: "Voicemails", value: st.voicemails, info: true }, { key: "done", label: "Completed", value: st.completed, info: true },
  { key: "today", label: "Calls today", value: st.today, info: true }, { key: "avg", label: "Avg duration", value: dur(st.avg_duration_s), info: true },
  { key: "ph", label: "Calls per hour", value: st.per_hour, info: true },
];
export const logRow = (r, users = new Map()) => listRow({
  title: r.cn || "Someone", sub: [users.get(r.by) || "", `${dateShort(r.at).replace(/^[A-Za-z]+, /, "")} ${time(r.at)}`, dur(r.dur), r.dir === "in" ? "they called" : ""].filter(Boolean).join(" · "),
  pill: { label: (OUT[r.out] || [r.out])[0], tone: (OUT[r.out] || [, "grey"])[1] }, href: "#/contacts/" + encodeURIComponent(r.c),
});

export default {
  title: "Call logs",
  async load(params, ctx) {
    ensureStyles();
    const period = ctx.keep.period || "month";
    const f = ctx.keep.f || {};
    const { from, to } = periodRange(period, localDate(new Date()));
    const q = `from=${from}&to=${to}${f.by ? `&by=${encodeURIComponent(f.by)}` : ""}${f.out ? `&out=${encodeURIComponent(f.out)}` : ""}`;
    const [logs, stats, users] = await Promise.all([
      ctx.api(`/calls/logs?${q}`, { cache: false }), ctx.api(`/calls/stats?${q}`, { cache: false }),
      ctx.can("schedule:read") ? ctx.api("/users").then((r) => r.data || []).catch(() => []) : [],
    ]);
    return { period, f, rows: logs.data || [], stats: stats.data, users: new Map(users.map((u) => [u.id, u.name])), team: users.filter((u) => u.status === "active"), q: ctx.keep.q || "", find: !!ctx.keep.q };
  },
  render(s) {
    const w = String(s.q || "").toLowerCase();
    const rows = s.rows.filter((r) => !w || String(r.cn || "").toLowerCase().includes(w));
    const per = Object.entries(s.stats.by_person || {});
    return html`<div class="stack dl-logs">
      <label class="${"ld-search" + (s.find ? " open" : "")}">${icon("search")}<span class="sr">Search calls</span><input type="search" data-clq ${attrs({ value: s.q, placeholder: "Search by name", autocomplete: "off" })}></label>
      <div class="rs-chips">${periodChip(s.period, { name: "cl", label: "Dates" })}</div>
      ${tileRow(statTiles(s.stats), { name: "cls", label: `Calls, ${periodLabel(s.period)}` })}
      ${per.length > 1 || (per.length && s.users.size) ? html`<h3 class="rs-label">By person</h3>${tileRow(per.map(([id, p]) => ({ key: id, label: s.users.get(id) || "Someone", value: p.total, money: null, info: true })), { name: "clp", label: "Calls by person" })}
        <p class="small muted dl-per">${per.map(([id, p]) => `${s.users.get(id) || "Someone"}: ${p.booked} booked, ${p.not_interested} not interested`).join(" · ")}</p>` : ""}
      ${listCard(rows.slice(0, 300).map((r) => logRow(r, s.users)), { label: "Calls", empty: "No calls logged in these dates." })}
      <p class="foot-note">Durations show once calls go through the business line. Until then, calls are made from each person's own phone.</p>
    </div>`;
  },
  mount(view, s, ctx) {
    const on = !!(s.f.by || s.f.out);
    screenButtons([
      { key: "find", icon: "search", label: "Search calls", on: s.find, expanded: s.find },
      { key: "filter", icon: "filter", label: on ? "Filter (on)" : "Filter", on },
    ], async (key) => {
      if (key === "find") { s.find = !s.find || !!s.q; ctx.rerender(); if (s.find) { const i = document.querySelector("[data-clq]"); if (i) i.focus(); } return; }
      const v = await filterSheet({ title: "Filter", values: s.f, groups: [
        s.team.length && { key: "by", label: "Who", type: "radio", options: s.team.map((u) => [u.id, u.name]) },
        { key: "out", label: "Outcome", type: "radio", options: Object.entries(OUT).filter(([k]) => k !== "calling").map(([k, [l]]) => [k, l]) },
      ] });
      if (v) { ctx.keep.f = v; ctx.refresh(); }
    });
  },
  events: {
    "input [data-clq]": (e, el, ctx) => {
      ctx.state.q = ctx.keep.q = el.value;
      clearTimeout(ctx.state.t);
      ctx.state.t = setTimeout(() => { const pos = el.selectionStart; ctx.rerender(); const i = document.querySelector("[data-clq]"); if (i) { i.focus(); try { i.setSelectionRange(pos, pos); } catch (x) { /* fine */ } } }, 150);
    },
    "click [data-period=cl]": async (e, el, ctx) => { const p = await periodSheet(ctx.state.period); if (p) { ctx.keep.period = p.key === "custom" ? p : p.key; ctx.refresh(); } },
  },
};
