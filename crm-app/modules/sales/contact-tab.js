// The contact's Sales tab (design §9.2 Contact → Sales): their follow-ups,
// deals and tasks, the last call, and links to log a call, start a
// follow-up or add a task. (A contact tab renders inside the Contact screen,
// so everything here is a link to a sales screen.)

import { html, icon } from "../../core/ui.js";
import { dateShort, money, ago } from "../../core/format.js";
import { ensureStyles, enrollmentPill, dealPill, winLabel, taskKindLabel, STOP_REASON } from "./kit.js";

export default {
  async load(params, ctx) {
    ensureStyles();
    if (!ctx.can("sales:work")) return { denied: true };
    const r = await ctx.api(`/sales/contacts/${encodeURIComponent(params.id)}`, { cache: false });
    return r.data;
  },
  render(s) {
    if (s.denied) return html`<div class="card empty"><h2>Not for this login</h2><p>Sales is for the office.</p></div>`;
    const id = encodeURIComponent(s.contact.id);
    const openTasks = (s.tasks || []).filter((t) => ["open", "in_progress", "waiting"].includes(t.status));
    return html`<div class="stack">
      <div class="sl-tab-acts">
        <a class="btn primary" href="${"#/calls/log/" + id}">${icon("phone")}Log a call</a>
        <a class="btn" href="${"#/sales/enroll/" + id}">${icon("clock")}Start a follow-up</a>
        <a class="btn" href="${"#/tasks/new/" + id}">${icon("check")}New task</a>
      </div>
      ${s.sales && (s.sales.last_called_at || s.sales.last_inbound_call_at) ? html`<p class="small muted">${s.sales.last_called_at ? `Last call ${ago(s.sales.last_called_at)}` : ""}${s.sales.last_called_at && s.sales.last_inbound_call_at ? " · " : ""}${s.sales.last_inbound_call_at ? `called in ${ago(s.sales.last_inbound_call_at)}` : ""}</p>` : ""}
      <div class="section-h">Follow-ups</div>
      ${(s.enrollments || []).length ? html`<ul class="list">${s.enrollments.map((e) => html`<li><a class="row" href="${"#/enrollments/" + encodeURIComponent(e.id)}">
        <span class="who"><span class="nm">${e.cadence_name}</span><span class="sub">${["active", "paused"].includes(e.status) ? `${(e.cur && e.cur.label) || ""}${e.next_due_at && e.status === "active" ? ` · due ${dateShort(e.next_due_at)} ${winLabel({ due: e.next_due_at, due_end: e.due_end })}` : ""}` : `${e.stop_reason ? STOP_REASON[e.stop_reason] || e.stop_reason : "finished"} · ${dateShort(e.ended_at || e.started_at)}`}</span></span>
        <span class="end">${enrollmentPill(e.status)}<span class="chev" aria-hidden="true"></span></span></a></li>`)}</ul>`
        : html`<p class="muted small">No follow-up yet.</p>`}
      <div class="section-h">Deals</div>
      ${(s.deals || []).length ? html`<ul class="list">${s.deals.map((d) => html`<li><a class="row" href="${"#/deals/" + encodeURIComponent(d.id)}">
        <span class="who"><span class="nm">${d.title}</span><span class="sub">${d.value_cents != null ? money(d.value_cents) + " · " : ""}opened ${dateShort(d.opened_at)}</span></span>
        <span class="end">${dealPill(d.status)}<span class="chev" aria-hidden="true"></span></span></a></li>`)}</ul>`
        : html`<p class="muted small">No deal yet. One opens with their first request or follow-up.</p>`}
      <div class="section-h">Tasks</div>
      ${openTasks.length ? html`<ul class="list">${openTasks.map((t) => html`<li><a class="row" href="${"#/tasks/" + encodeURIComponent(t.id)}">
        <span class="who"><span class="nm">${t.title}</span><span class="sub">${taskKindLabel(t.kind)}${t.due_at ? ` · ${dateShort(t.due_at)}` : ""}</span></span>
        <span class="end"><span class="chev" aria-hidden="true"></span></span></a></li>`)}</ul>`
        : html`<p class="muted small">No open tasks.</p>`}
    </div>`;
  },
};
