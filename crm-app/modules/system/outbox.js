// Outbox (design §9.2 "Outbox", §6.1 "Dry-run", §3.10): everything the
// CRM would have sent (dry run) or held back (with the reason), by day,
// and beside it the automations' "would have" rows (what they would have
// changed on records Rotor still owns). Tap one for the whole message.
// outbox:read (owners and the office).

import { html, attrs, icon, sheet } from "../../core/ui.js";
import { time as fmtTime, dateTime } from "../../core/format.js";
import { dayBar, nextDay, today, reasonLabel, KIND_ICON, KIND_LABEL } from "./kit.js";

const KINDS = [["", "All"], ["sms", "Texts"], ["email", "Emails"], ["push", "Push"]];

function itemSheet(o) {
  sheet({
    title: `${KIND_LABEL[o.kind] || o.kind} to ${o.to_masked}`,
    body: html`<div class="stack">
      ${o.mode === "blocked" ? html`<div class="warn-box">Held back: ${reasonLabel(o.blocked_reason)}</div>` : html`<div class="note">Not sent: dry run${o.simulated && o.simulated.status === "failed" ? ` (it would have failed: ${o.simulated.code})` : ""}</div>`}
      ${o.subject ? html`<p><b>${o.subject}</b></p>` : ""}
      ${o.body ? html`<div class="bubble grey">${o.body}</div>` : ""}
      <dl class="kv">
        <dt>When</dt><dd>${dateTime(o.created_at)}</dd>
        ${o.template_key ? html`<dt>Template</dt><dd class="mono">${o.template_key}</dd>` : ""}
        ${o.category ? html`<dt>Kind</dt><dd>${o.category}</dd>` : ""}
        <dt>From</dt><dd>${o.origin ? (o.origin.kind === "automation" ? `Automation ${o.origin.id || ""}` : o.origin.kind === "user" ? "A person" : o.origin.kind) : ""}</dd>
        ${o.footer_appended ? html`<dt>Footer</dt><dd>Opt-out line added</dd>` : ""}
        ${o.segments ? html`<dt>Length</dt><dd>${o.segments} text${o.segments === 1 ? "" : "s"}</dd>` : ""}
        ${o.contact_id ? html`<dt>Contact</dt><dd>${o.contact_label || "A contact"}</dd>` : ""}
      </dl>
    </div>`,
  });
}

export default {
  title: "Outbox",
  async load(params, ctx) {
    const date = ctx.keep.date || today();
    const tab = ctx.keep.tab || "outbox";
    const kind = ctx.keep.kind || "";
    const [ob, log] = await Promise.all([
      ctx.api(`/outbox?date=${date}${kind ? `&kind=${kind}` : ""}`, { cache: false }),
      ctx.api(`/automations/log?date=${date}`, { cache: false }).catch(() => ({ data: [] })),
    ]);
    return { date, tab, kind, items: ob.data || [], next: (ob.meta || {}).next_cursor || null, log: (log.data || []).filter((r) => r.result.startsWith("would-") || r.result.startsWith("skipped") || r.result === "dry_run" || r.result === "bulk_run") };
  },
  render(s) {
    const would = s.log.filter((r) => r.result.startsWith("would-"));
    return html`<div class="stack">
      ${dayBar(s.date)}
      <div class="chips" role="tablist">
        <button type="button" class="chip" ${attrs({ "aria-pressed": String(s.tab === "outbox"), "data-tab": "outbox" })}>Would have sent <span class="n">${s.items.length}</span></button>
        <button type="button" class="chip" ${attrs({ "aria-pressed": String(s.tab === "log"), "data-tab": "log" })}>Automation log <span class="n">${s.log.length}</span></button>
      </div>
      ${s.tab === "outbox" ? html`
        <div class="chips" role="group" aria-label="Kind">${KINDS.map(([v, l]) => html`<button type="button" class="chip" ${attrs({ "aria-pressed": String(s.kind === v), "data-kind": v })}>${l}</button>`)}</div>
        ${s.items.length ? html`<ul class="list">${s.items.map((o) => html`<li><button type="button" class="row" data-item="${o.id}">
          <span class="ico ${o.mode === "blocked" ? "amber" : ""}">${icon(KIND_ICON[o.kind] || "send")}</span>
          <span class="who"><span class="nm">${o.contact_label || o.to_masked}${o.staff ? " (staff)" : ""}</span><span class="sub two">${o.subject ? o.subject + " · " : ""}${o.body || ""}</span></span>
          <span class="end"><span class="pill ${o.mode === "blocked" ? "amber" : ""}">${o.mode === "blocked" ? reasonLabel(o.blocked_reason) : "Not sent"}</span><span class="small muted">${fmtTime(o.created_at)}</span></span>
        </button></li>`)}</ul>${s.next ? html`<button type="button" class="btn block" data-more>Show more</button>` : ""}`
        : html`<div class="card empty"><div class="art">${icon("send")}</div><h2>Nothing that day</h2><p>Texts, emails and charges the CRM would have made show up here until each one is switched on.</p></div>`}`
      : html`
        ${would.length ? html`<p class="small">${would.length} change${would.length === 1 ? "" : "s"} automations would have made on records Rotor owns.</p>` : ""}
        ${s.log.length ? html`<ul class="list">${s.log.map((r) => html`<li><div class="row">
          <span class="ico ${r.result.startsWith("would-") ? "coral" : ""}">${icon(r.result.startsWith("would-") ? "shield" : "bolt")}</span>
          <span class="who"><span class="nm">${r.result.startsWith("would-") ? "Would have: " + r.result.slice(6).replace(/_/g, " ") : r.result === "dry_run" ? "Sent to the outbox" : r.result === "bulk_run" ? "Made a bulk send" : "Skipped: " + reasonLabel(r.result)}</span><span class="sub">${r.key}</span></span>
          <span class="end small muted">${fmtTime(r.at)}</span>
        </div></li>`)}</ul>` : html`<div class="card empty"><div class="art">${icon("bolt")}</div><h2>No automation activity that day</h2><p>Automations arrive with each part of the CRM.</p></div>`}`}
    </div>`;
  },
  events: {
    "click [data-day]": (e, el, ctx) => { ctx.keep.date = nextDay(ctx.state.date, el.getAttribute("data-day")); ctx.refresh(); },
    "click [data-tab]": (e, el, ctx) => { ctx.keep.tab = el.getAttribute("data-tab"); ctx.state.tab = ctx.keep.tab; ctx.rerender(); },
    "click [data-kind]": (e, el, ctx) => { ctx.keep.kind = el.getAttribute("data-kind"); ctx.refresh(); },
    "click [data-item]": (e, el, ctx) => { const o = ctx.state.items.find((x) => x.id === el.getAttribute("data-item")); if (o) itemSheet(o); },
    "click [data-more]": async (e, el, ctx) => {
      el.disabled = true;
      const s = ctx.state;
      try {
        const r = await ctx.api(`/outbox?date=${s.date}${s.kind ? `&kind=${s.kind}` : ""}&before=${encodeURIComponent(s.next)}`, { cache: false });
        s.items = [...s.items, ...(r.data || [])];
        s.next = (r.meta || {}).next_cursor || null;
        ctx.rerender();
      } catch (err) { el.disabled = false; }
    },
  },
};
