// One follow-up (design §5.2): who, which cadence, where they are in it,
// the current step with Call / Log and its text (Copy text / Open in
// Messages while texting is dry-run), every step and what happened, and
// Pause / Resume / Skip / Done by hand / Stop.

import { html, icon, attrs, toast, confirmSheet } from "../../core/ui.js";
import { dateTime, timeWindow } from "../../core/format.js";
import {
  ensureStyles, enrollmentPill, winLabel, dueLabel, telHref, outcomeSheet, pendingSheet, pendingLabel, startCall, watchCalls, unwatchCalls,
  OUTCOME_LABEL, STOP_REASON, PAUSE_REASON, copyText,
} from "./kit.js";

async function load(params, ctx) {
  ensureStyles();
  const r = await ctx.api(`/enrollments/${encodeURIComponent(params.id)}`, { cache: false });
  return { ...r.data, etag: r.etag };
}

const ACTION = { call_then_text: "Call, then text if no answer", text: "Text", call: "Call", email: "Email", task: "Make a task", archive_quote: "Archive the quote" };

function histLabel(h) {
  if (h.action === "call") return `Call: ${OUTCOME_LABEL[h.outcome] || h.outcome}${h.double_dial ? " (twice)" : ""}`;
  if (h.action === "text") return h.sent_by_hand ? `Text sent by hand${h.sent_by_hand === "sms_link" ? " (Messages)" : " (copied)"}${h.edited ? ", edited" : ""}` : h.unattended ? "Text (window passed, no call)" : "Text";
  if (h.action === "text_blocked") return `Text held back (${String(h.reason || "").replace(/_/g, " ")})`;
  if (h.action === "skipped") return "Skipped";
  if (h.action === "done_by_hand") return "Marked done";
  if (h.action === "task_created") return "Task made";
  if (h.action === "inbound_call") return "They called in";
  if (h.action === "reply") return "They replied";
  if (h.action === "rotor_stage") return `Rotor: ${h.stage || "a stage"} (${h.status_raw || ""})`;
  return h.action;
}

function steps(s) {
  const e = s.enrollment;
  const list = (s.cadence && s.cadence.steps) || [];
  if (!list.length) return "";
  // steps are known by id (positions move when the cadence is edited)
  const idOf = (st, i) => st.id || `s${i + 1}`;
  const stepOfH = (h) => (h.sid ? list.find((st, i) => idOf(st, i) === h.sid) : list[h.n - 1]) || {};
  const done = new Set((e.history || []).filter((h) => ["text", "skipped", "done_by_hand", "task_created", "text_blocked"].includes(h.action) || (h.action === "call" && !["call_then_text", "text"].includes(stepOfH(h).action))).map((h) => h.sid || `s${h.n}`));
  const curAt = e.step_id ? list.findIndex((st, i) => idOf(st, i) === e.step_id) : e.step_n - 1;
  return html`<section class="card"><h2>Steps</h2><ol class="sl-steps">${list.map((st, i) => {
    const cls = i === curAt && ["active", "paused"].includes(e.status) ? "cur" : done.has(idOf(st, i)) || (curAt >= 0 && i < curAt) ? "done" : "";
    return html`<li class="${cls}"><span class="dot">${cls === "done" ? icon("check") : st.n}</span><span class="t"><b>${st.label || ACTION[st.action]}</b><small>Day ${st.day}${st.window ? ` · ${timeWindow(st.window.start, st.window.end)}` : ""} · ${ACTION[st.action] || st.action}${st.review_before_send ? " · read before sending" : ""}${st.offer === "followup_50" ? " · $50 off" : st.offer === "ten_free_screens" ? " · 10 free screens" : ""}${st.archive_quote ? " · archives the quote" : ""}</small></span></li>`;
  })}</ol></section>`;
}

function current(s) {
  const e = s.enrollment;
  if (!["active", "paused"].includes(e.status)) {
    return html`<section class="card"><h2>${e.status === "completed" ? "Finished" : e.status === "archived" ? "From Rotor" : "Stopped"}</h2><p>${e.stop_reason ? `Why: ${STOP_REASON[e.stop_reason] || e.stop_reason}.` : ""}${e.ended_at ? ` ${dateTime(e.ended_at)}.` : ""}</p></section>`;
  }
  const cur = e.cur || {};
  const late = e.status === "active" && e.due_end && Date.parse(e.due_end) <= Date.now();
  return html`<section class="${"card" + (late ? " alert" : "")}">
    <h2>Now: ${cur.label || `Step ${e.step_n}`}</h2>
    <p>${e.status === "paused" ? `Paused ${PAUSE_REASON[e.paused_reason] || ""}` : e.next_due_at ? html`${late ? "Overdue since " : "Due "}${winLabel({ due: e.next_due_at, due_end: e.due_end })} · ${dueLabel(e.next_due_at)}` : "Due now"}</p>
    ${e.pending ? html`<button type="button" class="sl-pending" style="margin-top:10px" data-pending>${icon("text")}${pendingLabel(e.pending.kind, e.pending.hold_until)}</button>` : ""}
    ${s.preview && s.preview.text && !e.pending ? html`<div class="bubble grey sl-preview" style="margin-top:10px">${s.preview.text}</div><textarea class="sr" readonly data-copy-area>${s.preview.text}</textarea>` : ""}
    <div class="sl-acts" style="margin-top:12px">
      ${s.contact && s.contact.phone ? html`<a class="btn primary" ${attrs({ href: telHref(s.contact.phone) })} data-call>${icon("phone")}Call</a>` : ""}
      <button type="button" class="btn" data-log>Log a call</button>
    </div>
    ${s.preview && s.preview.text && !e.pending && cur.action !== "call" ? html`<div class="sl-acts" style="margin-top:8px"><button type="button" class="btn" data-copy>${icon("copy")}Copy text</button>${s.preview.sms_href ? html`<a class="btn" ${attrs({ href: s.preview.sms_href })}>${icon("text")}Messages</a>` : ""}</div>` : ""}
  </section>`;
}

export default {
  title: (s) => (s && s.contact ? s.contact.name : "Follow-up"),
  load,
  render(s) {
    const e = s.enrollment;
    const hist = [...(e.history || [])].reverse();
    return html`<div class="stack">
      <section class="card">
        <div class="row" style="padding:0;min-height:0"><h2 style="flex:1;margin:0">${s.cadence ? s.cadence.name : e.cadence_key}</h2>${enrollmentPill(e.status)}</div>
        <dl class="kv sl-kv" style="margin-top:10px">
          ${s.contact ? html`<dt>Contact</dt><dd><a class="linkish" href="${"#/contacts/" + encodeURIComponent(s.contact.id)}">${s.contact.name}</a></dd>` : ""}
          <dt>Started</dt><dd>${dateTime(e.started_at)}</dd>
          ${e.deal_id ? html`<dt>Deal</dt><dd><a class="linkish" href="${"#/deals/" + encodeURIComponent(e.deal_id)}">Open the deal</a></dd>` : ""}
        </dl>
      </section>
      ${current(s)}
      ${["active", "paused"].includes(e.status) ? html`<div class="btn-row" style="margin-top:0">
        ${e.status === "active" ? html`<button type="button" class="btn" data-act="pause">${icon("pause")}Pause</button>` : html`<button type="button" class="btn dark" data-act="resume">Resume</button>`}
        <button type="button" class="btn" data-act="skip">Skip step</button>
        <button type="button" class="btn" data-act="advance">Done by hand</button>
        <button type="button" class="btn danger" data-act="stop">Stop</button>
      </div>` : ""}
      ${steps(s)}
      ${hist.length ? html`<section class="card"><h2>What happened</h2><ul class="sl-hist">${hist.map((h) => html`<li><span>${histLabel(h)}${h.note ? html`<br><span class="muted small">${h.note}</span>` : ""}</span><span class="w">${dateTime(h.at)}</span></li>`)}</ul></section>` : ""}
    </div>`;
  },
  mount(view, s, ctx) { watchCalls(ctx, { done: () => ctx.refresh(), smsMode: () => ctx.state.sms_mode }); },
  unmount() { unwatchCalls(); },
  events: {
    "click [data-call]": (e, el, ctx) => { const s = ctx.state; startCall(ctx, { contact_id: s.contact.id, enrollment_id: s.enrollment.id, name: s.contact.name, phone: s.contact.phone, label: (s.enrollment.cur || {}).label }); },
    "click [data-log]": (e, el, ctx) => { const s = ctx.state; outcomeSheet(ctx, { contact_id: s.contact.id, enrollment_id: s.enrollment.id, name: s.contact.name, phone: s.contact.phone, label: (s.enrollment.cur || {}).label }, { done: () => ctx.refresh(), smsMode: s.sms_mode }); },
    "click [data-pending]": (e, el, ctx) => {
      const s = ctx.state;
      const p = s.enrollment.pending;
      pendingSheet(ctx, { contact_id: s.contact.id, enrollment_id: s.enrollment.id, name: s.contact.name, phone: s.contact.phone }, { ...p, text: p.text || (s.preview && s.preview.text) || "", sms_href: s.preview && s.preview.sms_href, enrollment_id: s.enrollment.id }, { done: () => ctx.refresh(), smsMode: s.sms_mode });
    },
    "click [data-copy]": async (e, el, ctx) => { const ok = await copyText(ctx.state.preview.text, document.querySelector("[data-copy-area]")); toast(ok ? "Copied" : "Select the text and copy it", { bad: !ok }); },
    "click [data-act]": async (e, el, ctx) => {
      const act = el.dataset.act;
      if (act === "stop" && !(await confirmSheet("This follow-up stops here. You can start a new one from the contact.", { title: "Stop this follow-up?", yes: "Stop", danger: true }))) return;
      el.disabled = true;
      try {
        await ctx.api(`/enrollments/${encodeURIComponent(ctx.state.enrollment.id)}/${act}`, { method: "POST", body: {} });
        toast({ pause: "Paused", resume: "Resumed", skip: "Skipped", advance: "Done", stop: "Stopped" }[act]);
        ctx.refresh();
      } catch (err) { el.disabled = false; toast(err.message, { bad: true }); }
    },
  },
};
