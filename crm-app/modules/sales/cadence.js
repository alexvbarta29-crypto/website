// Settings → Cadences → one cadence (design §5.2, D7, D21, D22): its name,
// on or off, who joins it (new leads from which sources, not with which
// tags), what a reply does (pause or stop), what happens when a call
// step's window passes with no call (wait, or text anyway: never when a
// step's text is read before sending), and its steps: day, window, what
// it does, which text, read before sending, offer, archive the quote.
// Changes apply from each lead's next step. The texts themselves are edited
// in Templates.

import { html, attrs, toast, icon } from "../../core/ui.js";
import { field, select, readForm, clearErrors, showError, busy, checkbox } from "../../core/forms.js";
import { timeField } from "../../core/pickers.js";
import { ensureStyles } from "./kit.js";

const ACTIONS = [
  { value: "call_then_text", label: "Call, text if no answer" }, { value: "call", label: "Call only" }, { value: "text", label: "Text only" },
  { value: "email", label: "Email" }, { value: "task", label: "Make a task" },
];
const OFFERS = [{ value: "", label: "No offer" }, { value: "followup_50", label: "$50 off the estimate" }, { value: "ten_free_screens", label: "10 free screens" }];
const SOURCES = ["Website quote form", "Meta Ads", "Referral", "Phone Call", "Email", "Facebook Messenger", "Inbound text", "Other", "Google", "Facebook", "Returning Customer", "Yard Sign", "Door Hanger", "Holiday Lights Giveaway"];

async function load(params, ctx) {
  ensureStyles();
  const [r, tpl] = await Promise.all([
    ctx.api(`/cadences/${encodeURIComponent(params.id)}`, { cache: false }),
    ctx.api("/templates?channel=sms", { cache: false }).then((x) => x.data || []).catch(() => []),
  ]);
  const c = r.data.cadence;
  return { c: JSON.parse(JSON.stringify(c)), etag: r.etag, templates: tpl.filter((t) => t.channel === "sms" && t.category !== "staff" && t.category !== "marketing") };
}

function step(s, st, i) {
  const textual = ["call_then_text", "text", "email"].includes(st.action);
  const windowed = st.action !== "task";
  return html`<div class="sl-step" ${attrs({ "data-step": String(i) })}>
    <div class="hd"><b>Step ${i + 1}</b><button type="button" class="btn" ${attrs({ "data-del": String(i), "aria-label": `Remove step ${i + 1}` })}>Remove</button></div>
    ${field({ label: "Name", name: `label_${i}`, value: st.label || "", maxlength: 80 })}
    <div class="sl-grid3">
      ${field({ label: "Day", name: `day_${i}`, value: String(st.day || 1), inputmode: "numeric" })}
      ${windowed ? timeField({ label: "From", name: `from_${i}`, value: (st.window || {}).start || "09:00" }) : html`<span></span>`}
      ${windowed ? timeField({ label: "To", name: `to_${i}`, value: (st.window || {}).end || "10:00" }) : html`<span></span>`}
    </div>
    ${select({ label: "What it does", name: `action_${i}`, value: st.action, options: ACTIONS })}
    ${textual ? select({ label: "Text", name: `tpl_${i}`, value: st.template_key || "", options: [{ value: "", label: "Pick a text" }, ...s.templates.map((t) => ({ value: t.key, label: t.name }))] }) : ""}
    ${st.action === "task" ? field({ label: "Task", name: `task_${i}`, value: st.task_title || "Follow up" }) : ""}
    ${textual ? checkbox({ label: "Read before sending (opens the text to adjust)", name: `rbs_${i}`, checked: !!st.review_before_send }) : ""}
    ${textual ? select({ label: "Offer", name: `offer_${i}`, value: st.offer || "", options: OFFERS }) : ""}
    ${textual ? checkbox({ label: "Archive the quote after this step (its offers expire)", name: `arch_${i}`, checked: !!st.archive_quote }) : ""}
  </div>`;
}

// The form → the cadence (steps included).
function read(form, s) {
  const v = readForm(form);
  const c = s.c;
  const steps = c.board_only ? [] : (c.steps || []).map((st, i) => {
    const action = v[`action_${i}`] || st.action;
    const textual = ["call_then_text", "text", "email"].includes(action);
    const out = { ...st, label: v[`label_${i}`] ?? st.label, day: Number(v[`day_${i}`] || st.day || 1), action };
    if (action !== "task") out.window = { start: v[`from_${i}`] || (st.window || {}).start || "09:00", end: v[`to_${i}`] || (st.window || {}).end || "10:00" };
    else delete out.window;
    if (textual) { out.template_key = v[`tpl_${i}`] || st.template_key; out.review_before_send = !!v[`rbs_${i}`]; out.archive_quote = !!v[`arch_${i}`]; if (v[`offer_${i}`]) out.offer = v[`offer_${i}`]; else delete out.offer; }
    else { delete out.template_key; out.review_before_send = false; delete out.offer; delete out.archive_quote; }
    if (action === "task") out.task_title = v[`task_${i}`] || st.task_title || "Follow up";
    return out;
  });
  const sources = SOURCES.filter((x) => v[`src_${x}`]);
  const entry = { ...(c.entry || {}) };
  if (entry.on === "lead.created") {
    entry.sources = sources;
    entry.exclude_tags = String(v.exclude_tags || "").split(",").map((x) => x.trim()).filter(Boolean);
  }
  return { name: v.name, description: v.description, active: !!v.active, on_reply: v.on_reply, unattended: v.unattended, entry, steps };
}

export default {
  title: (s) => (s && s.c ? s.c.name : "Cadence"),
  load,
  render(s) {
    const c = s.c;
    const rbs = (c.steps || []).some((x) => x.review_before_send);
    const entry = c.entry || {};
    return html`<form class="form" id="cad-f" novalidate>
      <div class="err" data-form-err hidden></div>
      <section class="card form">
        ${field({ label: "Name", name: "name", value: c.name, required: true, maxlength: 80 })}
        <label class="field" data-field="description"><span>Notes for the team</span><textarea name="description" rows="2" maxlength="300">${c.description || ""}</textarea><small class="why" hidden></small></label>
        ${checkbox({ label: "On (new leads join it)", name: "active", checked: c.active !== false })}
      </section>
      ${c.board_only ? html`<div class="note">A board only (no steps): ${(c.board_stages || []).join(" → ")}.</div>` : html`
      <section class="card form">
        <h2>Who joins</h2>
        ${entry.on === "lead.created" ? html`
          <p class="small muted">A new lead from these sources joins by itself (someone can still start it by hand for anyone).</p>
          <div class="sl-sources">${SOURCES.map((x) => html`<label class="check"><input ${attrs({ type: "checkbox", name: `src_${x}`, checked: (entry.sources || []).includes(x) })}><span>${x}</span></label>`)}</div>
          ${field({ label: "Not when tagged (commas between tags)", name: "exclude_tags", value: (entry.exclude_tags || []).join(", ") })}`
          : html`<p class="small muted">${entry.on === "quote.sent" ? "Starts when a quote is first sent (Quotes)." : "Started by hand."}</p>`}
        ${select({ label: "When they reply or call in", name: "on_reply", value: c.on_reply || "pause", options: [{ value: "pause", label: "Pause, and make a task" }, { value: "stop", label: "Stop" }] })}
        ${select({ label: "When a call step's window passes with no call", name: "unattended", value: c.unattended || "wait", options: [{ value: "wait", label: "Wait (it stays on the list, red)" }, ...(rbs ? [] : [{ value: "text_anyway", label: "Send its text anyway" }])], hint: rbs ? "Its texts are read before sending, so they never go out on their own." : "" })}
      </section>
      <div class="section-h">Steps</div>
      ${(c.steps || []).map((st, i) => step(s, st, i))}
      <button type="button" class="btn" data-add>${icon("plus")}Add a step</button>`}
      <button type="submit" class="btn primary block">Save</button>
      <p class="small muted">The words of each text live in <a class="linkish" href="#/templates">Templates</a>. Changes here apply from each lead's next step.</p>
    </form>`;
  },
  events: {
    "change [name^=action_]": (e, el, ctx) => { ctx.state.c = { ...ctx.state.c, ...read(el.form, ctx.state) }; ctx.rerender(); },
    "change [name^=rbs_]": (e, el, ctx) => { ctx.state.c = { ...ctx.state.c, ...read(el.form, ctx.state) }; if (ctx.state.c.steps.some((x) => x.review_before_send)) ctx.state.c.unattended = "wait"; ctx.rerender(); },
    "click [data-add]": (e, el, ctx) => {
      const c = { ...ctx.state.c, ...read(el.closest("form"), ctx.state) };
      const last = c.steps[c.steps.length - 1] || { day: 1 };
      c.steps = [...c.steps, { day: last.day || 1, window: { start: "09:00", end: "10:00" }, action: "call_then_text", template_key: last.template_key || "", review_before_send: !!last.review_before_send, label: "" }];
      ctx.state.c = c; ctx.rerender();
    },
    "click [data-del]": (e, el, ctx) => {
      const c = { ...ctx.state.c, ...read(el.closest("form"), ctx.state) };
      c.steps = c.steps.filter((_, i) => i !== Number(el.dataset.del));
      ctx.state.c = c; ctx.rerender();
    },
    "submit #cad-f": async (e, form, ctx) => {
      e.preventDefault(); clearErrors(form);
      const body = read(form, ctx.state);
      const btn = form.querySelector("[type=submit]"); busy(btn, true);
      try {
        const r = await ctx.api(`/cadences/${encodeURIComponent(ctx.state.c.id)}`, { method: "PATCH", ifMatch: ctx.state.etag, body });
        ctx.state.c = r.data.cadence; ctx.state.etag = r.etag;
        busy(btn, false); toast("Saved"); ctx.rerender();
      } catch (err) {
        busy(btn, false);
        if (err.status === 412) { toast("Someone else just changed this cadence. Showing the latest.", { bad: true }); ctx.refresh(); } else showError(form, err);
      }
    },
  },
};
