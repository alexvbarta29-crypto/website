// Leads & calls (design §9.2): today's follow-up steps by window (9-10,
// 12-1, 4-5), overdue ones on top in red. Tabs: Due now · Later today ·
// Paused · Needs attention. Call dials (tel:) and first notes a provisional
// "calling" (it holds the thank-you text off); when the phone comes back to
// the app the "How did it go?" sheet opens by itself. While texting is in
// dry-run every text shows Copy text and Open in Messages and asks "Did you
// send it?" before the step moves on.

import { html, icon, attrs, toast } from "../../core/ui.js";
import { plural } from "../../core/format.js";
import {
  ensureStyles, winLabel, dueLabel, age, ago, telHref, emptyCard, outcomeSheet, pendingSheet, pendingLabel, startCall, watchCalls, unwatchCalls,
  PAUSE_REASON,
} from "./kit.js";

const TABS = [["due", "Due now"], ["later", "Later today"], ["paused", "Paused"], ["attention", "Needs attention"]];
const REASONS = { untouched: "No call or text in a day", paused: "Paused a while", overdue: "Step overdue" };

async function load(params, ctx) {
  ensureStyles();
  const r = await ctx.api("/calls/list", { cache: false });
  return { ...r.data, tab: ctx.keep.tab || "due" };
}

const who = (r) => ({ contact_id: r.contact_id, enrollment_id: r.id, name: r.name, phone: r.phone, label: r.label });

function card(r, s) {
  const late = r.overdue && r.status === "active";
  const sub = [r.cadence, r.label].filter(Boolean).join(" · ");
  const meta = [`Lead ${age(r.started_at)}`, r.last_touch_at ? `last touch ${ago(r.last_touch_at)}` : "not touched yet"].join(" · ");
  return html`<li class="${"sl-card" + (late ? " late" : "")}">
    <a class="sl-top" href="${"#/enrollments/" + encodeURIComponent(r.id)}">
      <span class="who"><span class="nm">${r.name}</span><span class="sub">${sub}</span><span class="sub">${meta}</span>${r.source_label ? html`<span class="sub sl-src">From ${r.source_label}</span>` : ""}</span>
      <span class="when">${r.status === "paused" ? "Paused" : r.due ? html`${late ? "Overdue" : winLabel(r)}${late ? html`<br>${dueLabel(r.due)}` : ""}` : "Now"}</span>
    </a>
    ${r.pending ? html`<button type="button" class="sl-pending" ${attrs({ "data-pending": r.id })}>${icon("text")}${pendingLabel(r.pending, r.hold_until)}</button>` : ""}
    ${r.status === "paused" ? html`<div class="sl-meta"><span class="pill amber">${PAUSE_REASON[r.paused_reason] || "Paused"}</span>${r.paused_at ? html`<span class="pill">since ${ago(r.paused_at)}</span>` : ""}</div>` : ""}
    <div class="sl-acts">
      ${r.phone ? html`<a class="btn primary" ${attrs({ href: telHref(r.phone), "data-call": r.id })}>${icon("phone")}Call</a>` : html`<span class="btn" aria-disabled="true">No phone</span>`}
      ${r.status === "paused"
        ? html`<button type="button" class="btn" ${attrs({ "data-resume": r.id })}>Resume</button>`
        : html`<button type="button" class="btn" ${attrs({ "data-log": r.id })}>Log</button>`}
    </div>
  </li>`;
}

// Due rows grouped: overdue first, then by window.
function grouped(rows) {
  const out = [];
  const late = rows.filter((r) => r.overdue);
  if (late.length) out.push({ label: "Overdue", late: true, rows: late });
  const byWin = new Map();
  for (const r of rows.filter((x) => !x.overdue)) {
    const k = r.due ? winLabel(r) : "Now";
    if (!byWin.has(k)) byWin.set(k, []);
    byWin.get(k).push(r);
  }
  for (const [label, list] of byWin) out.push({ label, rows: list });
  return out;
}

function attentionList(s) {
  if (!s.attention.length) return emptyCard("Nobody is waiting", "Leads show up here after a day with no call or text, a long pause, or a step a whole window late.", "check");
  return html`<ul class="list">${s.attention.map((a) => html`<li><a class="row" href="${"#/enrollments/" + encodeURIComponent(a.enrollment_id)}">
    <span class="ico coral">${icon("phone")}</span>
    <span class="who"><span class="nm">${a.name}</span><span class="sub">${a.reasons.map((x) => REASONS[x] || x).join(" · ")}</span></span>
    <span class="end"><span class="chev" aria-hidden="true"></span></span></a></li>`)}</ul>`;
}

function body(s) {
  if (s.tab === "attention") return attentionList(s);
  if (s.tab === "paused") return s.paused.length ? html`<ul class="sl-cards">${s.paused.map((r) => card(r, s))}</ul>` : emptyCard("Nothing paused", "A follow-up pauses when the lead replies, calls in, or you talked with them.", "pause");
  if (s.tab === "later") {
    return s.later.length ? html`${grouped(s.later).map((g) => html`<div class="sl-group">${g.label}</div><ul class="sl-cards">${g.rows.map((r) => card(r, s))}</ul>`)}`
      : emptyCard("Nothing else today", s.upcoming.length ? `${plural(s.upcoming.length, "step")} on the next days.` : "New leads show up here as they come in.", "clock");
  }
  if (!s.due.length) return emptyCard("No calls due right now", s.later.length ? `Next: ${plural(s.later.length, "call")} later today.` : "New leads show up here as they come in.", "phone");
  return html`${grouped(s.due).map((g) => html`<div class="${"sl-group" + (g.late ? " late" : "")}">${g.label} <span class="pill">${g.rows.length}</span></div><ul class="sl-cards">${g.rows.map((r) => card(r, s))}</ul>`)}`;
}

const count = (s, k) => (k === "attention" ? s.counts.attention : (s[k] || []).length);
const find = (s, id) => [...s.due, ...s.later, ...s.upcoming, ...s.paused].find((r) => r.id === id);

export default {
  title: "Leads & calls",
  load,
  render(s) {
    return html`<div class="stack">
      ${s.sms_mode !== "live" && s.sms_mode !== "test" ? html`<div class="note sl-dry">${icon("text")}<span>Texts don't leave the CRM yet: each one shows up for you to send yourself (Copy text or Open in Messages), and lands in the Outbox.</span></div>` : ""}
      <div class="chips" role="tablist">${TABS.map(([k, label]) => html`<button type="button" class="chip" role="tab" ${attrs({ "data-tab": k, "aria-pressed": String(s.tab === k), "aria-selected": String(s.tab === k) })}>${label} <span class="n">${count(s, k)}</span></button>`)}</div>
      ${body(s)}
      <div class="btn-row"><a class="btn" href="#/calls/log">${icon("plus")}Log another call</a><button type="button" class="btn" data-refresh>Refresh</button></div>
    </div>`;
  },
  mount(view, s, ctx) {
    watchCalls(ctx, { done: () => ctx.refresh(), smsMode: () => ctx.state.sms_mode });
  },
  unmount() { unwatchCalls(); },
  events: {
    "click [data-tab]": (e, el, ctx) => { ctx.state.tab = el.dataset.tab; ctx.keep.tab = el.dataset.tab; ctx.rerender(); },
    "click [data-refresh]": (e, el, ctx) => ctx.refresh(),
    "click [data-call]": (e, el, ctx) => { const r = find(ctx.state, el.dataset.call); if (r) startCall(ctx, who(r)); },
    "click [data-log]": (e, el, ctx) => { const r = find(ctx.state, el.dataset.log); if (r) outcomeSheet(ctx, who(r), { done: () => ctx.refresh(), smsMode: ctx.state.sms_mode }); },
    "click [data-pending]": async (e, el, ctx) => {
      const r = find(ctx.state, el.dataset.pending);
      if (!r) return;
      try {
        const d = (await ctx.api(`/enrollments/${encodeURIComponent(r.id)}`, { cache: false })).data;
        const p = d.enrollment.pending;
        if (!p) { ctx.refresh(); return; }
        pendingSheet(ctx, who(r), { ...p, text: p.text || (d.preview && d.preview.text) || "", sms_href: d.preview && d.preview.sms_href, enrollment_id: r.id }, { done: () => ctx.refresh(), smsMode: ctx.state.sms_mode });
      } catch (err) { toast(err.message, { bad: true }); }
    },
    "click [data-resume]": async (e, el, ctx) => {
      el.disabled = true;
      try { await ctx.api(`/enrollments/${encodeURIComponent(el.dataset.resume)}/resume`, { method: "POST", body: {} }); toast("Resumed"); ctx.refresh(); }
      catch (err) { el.disabled = false; toast(err.message, { bad: true }); }
    },
  },
};
