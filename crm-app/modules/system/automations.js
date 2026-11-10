// Automations (design §9.2, §5.7.4): the built-in catalog. Each one: on or
// off, when it runs, what it sends, and the last 7 days (sent, dry run,
// skipped, "would have" while Rotor is in charge). Tap one for its
// settings (channels, delay, time of day, templates) and today's log.
// Automations of modules that haven't shipped show "Arrives with ...".
// Before the switch-over everything that would reach a customer goes to
// the Outbox instead. automations:configure (owners and the office).

import { html, attrs, icon, sheet, toast, confirmSheet } from "../../core/ui.js";
import { readForm, busy, checkbox, field, clearErrors, showError } from "../../core/forms.js";
import { time as fmtTime } from "../../core/format.js";
import { reasonLabel } from "./kit.js";

const last7 = (l) => {
  if (!l) return "Nothing in the last 7 days";
  const parts = [];
  if (l.sent) parts.push(`${l.sent} sent`);
  if (l.dry_run) parts.push(`${l.dry_run} in the outbox`);
  if (l.would) parts.push(`${l.would} would have`);
  if (l.skipped) parts.push(`${l.skipped} skipped`);
  if (l.failed) parts.push(`${l.failed} failed`);
  return parts.length ? parts.join(" · ") + " (7 days)" : "Nothing in the last 7 days";
};

function editSheet(a, ctx, templates) {
  const st = a.settings || {};
  const tpl = templates.filter((t) => (st.channels || ["sms"]).includes(t.channel) || (st.template_keys || []).includes(t.key));
  const s = sheet({
    title: a.label,
    body: html`<form class="form" data-edit>
      <div class="err" data-form-err hidden></div>
      <p class="small muted">${a.when || ""}${a.action ? " · " + a.action : ""}</p>
      <div class="section-h">Send by</div>
      ${checkbox({ label: "Text", name: "ch_sms", checked: (st.channels || []).includes("sms") })}
      ${checkbox({ label: "Email", name: "ch_email", checked: (st.channels || []).includes("email") })}
      <div class="grid2">
        ${field({ label: "Wait (minutes)", name: "delay", value: String(st.delay ?? 0), inputmode: "numeric" })}
        <label class="field" data-field="at_local"><span>At (time of day)</span><input ${attrs({ type: "time", name: "at_local", value: st.at_local || "" })}><small class="why" hidden></small></label>
      </div>
      <div class="section-h">Templates</div>
      ${tpl.length ? tpl.map((t) => checkbox({ label: `${t.name} (${t.channel === "sms" ? "text" : "email"})`, name: `tpl_${t.key}`, checked: (st.template_keys || []).includes(t.key) })) : html`<p class="small muted">No templates for it yet.</p>`}
      <button type="submit" class="btn primary block">Save</button>
      <button type="button" class="btn block" data-log>Today's log</button>
    </form>`,
    events: {
      "submit [data-edit]": async (e, form) => {
        e.preventDefault();
        clearErrors(form);
        const v = readForm(form);
        const btn = form.querySelector("button[type=submit]");
        busy(btn, true);
        const channels = [v.ch_sms ? "sms" : null, v.ch_email ? "email" : null].filter(Boolean);
        const template_keys = tpl.filter((t) => v[`tpl_${t.key}`]).map((t) => t.key);
        try {
          await ctx.api(`/automations/${encodeURIComponent(a.key)}`, { method: "PATCH", body: { channels, template_keys, delay: Number(v.delay || 0), at_local: v.at_local || null } });
          toast("Saved");
          s.close();
          ctx.refresh();
        } catch (err) { busy(btn, false); showError(form, err); }
      },
      "click [data-log]": async () => { s.close(); logSheet(a, ctx); },
    },
  });
}

async function logSheet(a, ctx) {
  let rows = [];
  try { rows = (await ctx.api(`/automations/log?key=${encodeURIComponent(a.key)}`, { cache: false })).data || []; } catch (e) { rows = []; }
  sheet({
    title: `${a.label}: today`,
    body: rows.length
      ? html`<ul class="list">${rows.map((r) => html`<li><div class="row"><span class="who"><span class="nm">${r.result === "dry_run" ? "In the outbox (dry run)" : r.result === "sent" ? "Sent" : r.result.startsWith("would-") ? "Would have: " + r.result.slice(6).replace(/_/g, " ") : r.result.startsWith("skipped") ? "Skipped: " + reasonLabel(r.result) : r.result}</span><span class="sub mono">${r.subject}</span></span><span class="end small muted">${fmtTime(r.at)}</span></div></li>`)}</ul>`
      : html`<p class="muted">Nothing today.</p>`,
  });
}

export default {
  title: "Automations",
  async load(params, ctx) {
    const [r, t] = await Promise.all([ctx.api("/automations", { cache: false }), ctx.api("/templates").catch(() => ({ data: [] }))]);
    return { ...r.data, templates: t.data || [] };
  },
  action(s, ctx) {
    return { label: s.paused ? "Resume all" : "Pause all", run: async () => {
      if (!s.paused && !(await confirmSheet("No automation runs until you resume. Messages people send by hand still go.", { title: "Pause every automation?", yes: "Pause all", danger: true }))) return;
      try { await ctx.api(s.paused ? "/automations/resume" : "/automations/pause", { method: "POST", body: {} }); toast(s.paused ? "Automations resumed" : "Automations paused"); ctx.refresh(); } catch (e) { toast(e.message, { bad: true }); }
    } };
  },
  render(s) {
    const live = s.automations.filter((a) => a.available);
    const later = s.automations.filter((a) => !a.available);
    const row = (a) => html`<li><div class="row">
      <button type="button" class="who linkish" style="text-decoration:none;color:inherit;text-align:left" data-open="${a.key}">
        <span class="nm two">${a.label}</span><span class="sub two">${a.when || a.trigger || ""}</span><span class="sub">${last7(a.last7)}</span>
      </button>
      <span class="end"><button type="button" class="switch" role="switch" ${attrs({ "aria-checked": String(!!(a.settings && a.settings.enabled)), "aria-label": `${a.label} on or off`, "data-toggle": a.key })}></button></span>
    </div></li>`;
    return html`<div class="stack">
      ${s.paused ? html`<div class="warn-box">Every automation is paused.</div>` : ""}
      <div class="note">Until the switch-over, anything an automation would send to a customer goes to the Outbox instead, and changes to records Rotor owns are only reported ("would have").</div>
      ${live.length ? html`<ul class="list">${live.map(row)}</ul>` : ""}
      ${later.length ? html`<div class="section-h">Arriving with the next parts</div><ul class="list">${later.map((a) => html`<li><div class="row"><span class="ico">${icon("bolt")}</span><span class="who"><span class="nm two">${a.label}</span><span class="sub two">${a.when}</span><span class="sub two">${a.action}</span></span><span class="end"><span class="pill">${a.arrives_with}</span></span></div></li>`)}</ul>` : ""}
    </div>`;
  },
  events: {
    "click [data-toggle]": async (e, el, ctx) => {
      const key = el.getAttribute("data-toggle");
      const on = el.getAttribute("aria-checked") !== "true";
      el.disabled = true;
      try {
        await ctx.api(`/automations/${encodeURIComponent(key)}`, { method: "PATCH", body: { enabled: on } });
        el.setAttribute("aria-checked", String(on));
        toast(on ? "On" : "Off");
      } catch (err) { toast(err.message, { bad: true }); }
      el.disabled = false;
    },
    "click [data-open]": (e, el, ctx) => {
      const a = ctx.state.automations.find((x) => x.key === el.getAttribute("data-open"));
      if (a) editSheet(a, ctx, ctx.state.templates);
    },
  },
};
