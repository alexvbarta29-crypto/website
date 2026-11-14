// Automations → one of yours: the builder (Flyra and Rotor style: "when X
// happens, if Y, then do Z after a wait"). From the top: the plain-English
// sentence (the server writes it as you edit), the name and the switch,
// When (the trigger: an event, or a daily check at a time on some days),
// Only if (conditions), Then (the steps in order, each with its wait: a
// number of minutes, hours or days, then optionally a time of day and
// business hours), Stop when (checked before every step and every text),
// the per-customer limit; then Test run (pick a customer: what each step
// would do, nothing written or sent), Run history, Duplicate and Delete.
// Saving needs the version you opened (If-Match). automations:configure.

import { html, attrs, icon, toast, confirmSheet, sheet, render } from "../../core/ui.js";
import { field, select, readForm, clearErrors, showError, busy, checkbox } from "../../core/forms.js";
import { pickContact } from "../../core/pickers.js";
import { dateTime } from "../../core/format.js";
import { ensureStyles, conditionRow, readCondition, OUTCOME } from "./kit.js";

const DOW = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const UNIT_LABEL = { minutes: "Minutes", hours: "Hours", days: "Days" };
const clone = (x) => JSON.parse(JSON.stringify(x));
const STRUCTURAL = /(_field|_op|_type)$/;
const cap = (x) => String(x || "").charAt(0).toUpperCase() + String(x || "").slice(1);

async function load(params, ctx) {
  ensureStyles();
  const r = await ctx.api(`/automations/flows/${encodeURIComponent(params.id)}?catalog=1`, { cache: false });
  const f = r.data.flow;
  return { f: draftOf(f), etag: r.etag, cat: r.data.catalog, ch: r.data.choices, summary: f.summary, problems: f.problems || [], runs: f.runs || 0, id: f.id, saved: f.name };
}
const draftOf = (f) => clone({ name: f.name, enabled: !!f.enabled, trigger: f.trigger, conditions: f.conditions || [], steps: f.steps || [], stop: f.stop || [], limits: f.limits || { per_contact_days: 1 } });

const triggerOf = (s) => s.cat.triggers.find((t) => t.key === s.f.trigger.type) || s.cat.triggers[0];
const whoOptions = (s) => [...s.cat.who, ...s.ch.users.map((u) => ({ value: u.id, label: u.name }))];

function triggerCard(s) {
  const t = triggerOf(s);
  const groups = [...new Set(s.cat.triggers.map((x) => x.group))];
  const tr = s.f.trigger;
  return html`<section class="card form au-card">
    <h2>When</h2>
    <label class="field" data-field="trigger.type"><span>What starts it</span><select name="t_type">${groups.map((g) => html`<optgroup ${attrs({ label: g })}>${s.cat.triggers.filter((x) => x.group === g).map((x) => html`<option ${attrs({ value: x.key, selected: x.key === tr.type })}>${x.label}</option>`)}</optgroup>`)}</select><small class="why" hidden></small></label>
    ${t.option === "tag" ? field({ label: "The tag", name: "t_tag", value: tr.tag || "", list: "au-tags", maxlength: 40, autocomplete: "off" }) : ""}
    ${t.option === "days" ? field({ label: t.key === "plan.renewing" ? "Days before the renewal" : "Days overdue", name: "t_days", value: String(tr.days ?? (t.key === "plan.renewing" ? 30 : 1)), inputmode: "numeric", maxlength: 3 }) : ""}
    ${t.schedule ? html`<div class="grid2">${field({ label: "Checked at", name: "t_at", type: "time", value: tr.at || "10:00" })}<span></span></div>
      <div class="au-days" role="group" aria-label="Days">${DOW.map((d, i) => html`<button type="button" class="chip" ${attrs({ "data-dow": String(i), "aria-pressed": String((tr.dows || [1, 2, 3, 4, 5]).includes(i)) })}>${d}</button>`)}</div>
      ${t.key === "schedule" ? html`<p class="small muted">Everyone who matches the conditions below, once a day. More than 5 people at once waits for a test send and your confirm (Approvals).</p>` : ""}` : ""}
    ${s.cat.not_yet.length ? html`<p class="small muted">Not yet: ${s.cat.not_yet.map((n) => `${n.label} (${n.why})`).join(" ")}</p>` : ""}
  </section>`;
}

const conds = (s, list, prefix, where) => list.map((c, i) => conditionRow(c, `${prefix}${i}`, s.cat, s.ch, triggerOf(s).subject, where));

function stepParams(s, st, i) {
  const p = `s${i}`;
  const tpl = (channel) => [{ value: "", label: "Pick a template" }, ...s.ch.templates.filter((t) => t.channel === channel).map((t) => ({ value: t.key, label: `${t.name}${t.category === "marketing" ? " (marketing)" : ""}` }))];
  switch (st.type) {
    case "text": return select({ label: "Text", name: `${p}_tpl`, value: st.template_key || "", options: tpl("sms"), hint: "The words live in Templates. Quiet hours, consent and the opt-out line are the sender's." });
    case "email": return select({ label: "Email", name: `${p}_tpl`, value: st.template_key || "", options: tpl("email") });
    case "task": return html`${field({ label: "Task", name: `${p}_title`, value: st.title || "Follow up", maxlength: 120 })}
      <div class="grid2">${select({ label: "For", name: `${p}_assign`, value: st.assign || "owner", options: whoOptions(s) })}${field({ label: "Due in (days)", name: `${p}_due`, value: st.due_days === undefined ? "" : String(st.due_days), inputmode: "numeric", maxlength: 2 })}</div>`;
    case "tag_add": case "tag_remove": return field({ label: "Tag", name: `${p}_tag`, value: st.tag || "", list: "au-tags", maxlength: 40, autocomplete: "off" });
    case "deal_stage": return select({ label: "Move the deal to", name: `${p}_stage`, value: st.stage || "won", options: s.cat.deal_stages });
    case "assign_owner": return select({ label: "Owner", name: `${p}_user`, value: st.user_id || "", options: [{ value: "", label: "Pick someone" }, ...s.ch.users.map((u) => ({ value: u.id, label: u.name }))] });
    case "notify": return html`${select({ label: "Tell", name: `${p}_to`, value: st.to || "owners", options: whoOptions(s) })}${field({ label: "What it says", name: `${p}_msg`, value: st.message || "", maxlength: 160 })}`;
    case "cadence": return select({ label: "Cadence", name: `${p}_cad`, value: st.cadence_key || "", options: [{ value: "", label: "Pick a cadence" }, ...s.ch.cadences.map((c) => ({ value: c.key, label: c.name }))] });
    case "stop_if": return html`${conds(s, st.conditions || [], `${p}c`, `step${i}`)}<button type="button" class="btn" ${attrs({ "data-add-cond": `step${i}` })}>${icon("plus")}Add a check</button>`;
    default: return "";
  }
}

function stepCard(s, st, i, n) {
  const p = `s${i}`;
  const w = st.wait || { n: 0, unit: "days" };
  return html`<div class="au-step" ${attrs({ "data-step": String(i) })}>
    <div class="hd"><b>Step ${i + 1}</b><span class="btns">
      ${i > 0 ? html`<button type="button" class="btn" ${attrs({ "data-move": `${i}:-1`, "aria-label": `Move step ${i + 1} up` })}>Up</button>` : ""}
      ${i < n - 1 ? html`<button type="button" class="btn" ${attrs({ "data-move": `${i}:1`, "aria-label": `Move step ${i + 1} down` })}>Down</button>` : ""}
      <button type="button" class="btn" ${attrs({ "data-del-step": String(i), "aria-label": `Remove step ${i + 1}` })}>Remove</button></span></div>
    <div class="au-wait">
      ${field({ label: "Wait", name: `${p}_wn`, value: String(w.n || 0), inputmode: "numeric", maxlength: 4 })}
      ${select({ label: "Of", name: `${p}_wu`, value: w.unit, options: s.cat.wait_units.map((u) => ({ value: u, label: UNIT_LABEL[u] || u })) })}
      ${field({ label: "At (time of day)", name: `${p}_at`, type: "time", value: st.at || "" })}
      ${checkbox({ label: "In business hours", name: `${p}_bh`, checked: !!st.business_hours })}
    </div>
    ${select({ label: "Do this", name: `${p}_type`, value: st.type, options: s.cat.steps.map((x) => ({ value: x.key, label: x.label })) })}
    ${stepParams(s, st, i)}
  </div>`;
}

const lists = (s) => html`<datalist id="au-tags">${s.ch.tags.map((x) => html`<option ${attrs({ value: x })}></option>`)}</datalist>
  <datalist id="au-sources">${s.ch.sources.map((x) => html`<option ${attrs({ value: x })}></option>`)}</datalist>
  <datalist id="au-towns">${s.ch.towns.map((x) => html`<option ${attrs({ value: x })}></option>`)}</datalist>`;

// The form → the draft (structure from the state, values from the form).
function read(form, s) {
  const v = readForm(form);
  const f = clone(s.f);
  f.name = v.name ?? f.name;
  f.enabled = !!v.enabled;
  const type = v.t_type || f.trigger.type;
  const t = s.cat.triggers.find((x) => x.key === type) || s.cat.triggers[0];
  const tr = { type };
  if (t.option === "tag") tr.tag = v.t_tag ?? f.trigger.tag ?? "";
  if (t.option === "days") { const d = parseInt(v.t_days, 10); tr.days = Number.isFinite(d) ? d : undefined; }
  if (t.schedule) { tr.at = v.t_at || f.trigger.at || "10:00"; tr.dows = f.trigger.dows || [1, 2, 3, 4, 5]; }
  f.trigger = tr;
  f.conditions = f.conditions.map((c, i) => readCondition(v, `c${i}`, s.cat, c));
  f.stop = f.stop.map((c, i) => readCondition(v, `x${i}`, s.cat, c));
  f.steps = f.steps.map((st, i) => {
    const p = `s${i}`;
    const typeNow = v[`${p}_type`] || st.type;
    const out = { id: st.id, type: typeNow };
    const n = parseInt(v[`${p}_wn`], 10);
    if (Number.isFinite(n) && n > 0) out.wait = { n, unit: v[`${p}_wu`] || "days" };
    if (v[`${p}_at`]) out.at = v[`${p}_at`];
    if (v[`${p}_bh`]) out.business_hours = true;
    if (typeNow !== st.type) return out;
    if (typeNow === "text" || typeNow === "email") out.template_key = v[`${p}_tpl`] || "";
    if (typeNow === "task") { out.title = v[`${p}_title`]; out.assign = v[`${p}_assign`]; const d = parseInt(v[`${p}_due`], 10); if (Number.isFinite(d)) out.due_days = d; }
    if (typeNow === "tag_add" || typeNow === "tag_remove") out.tag = v[`${p}_tag`];
    if (typeNow === "deal_stage") out.stage = v[`${p}_stage`];
    if (typeNow === "assign_owner") out.user_id = v[`${p}_user`];
    if (typeNow === "notify") { out.to = v[`${p}_to`]; out.message = v[`${p}_msg`]; }
    if (typeNow === "cadence") out.cadence_key = v[`${p}_cad`];
    if (typeNow === "stop_if") out.conditions = (st.conditions || []).map((c, k) => readCondition(v, `${p}c${k}`, s.cat, c));
    return out;
  });
  const lim = parseInt(v.per_contact_days, 10);
  f.limits = { per_contact_days: Number.isFinite(lim) ? lim : 0 };
  return f;
}

// The server's sentence and problems for the draft, a moment after an edit.
let timer = null;
let seq = 0;
function check(ctx) {
  clearTimeout(timer);
  timer = setTimeout(async () => {
    const my = ++seq;
    try {
      const r = await ctx.api("/automations/flows/check", { method: "POST", body: { flow: ctx.state.f } });
      if (my !== seq) return;
      ctx.state.summary = r.data.summary;
      ctx.state.problems = r.data.problems || [];
      paintSummary(ctx.state);
    } catch (e) { /* offline: the sentence waits */ }
  }, 350);
}
function summaryBody(s) {
  return html`<span class="k">In plain English</span><span data-sum-text>${s.summary || "Finish the parts below and it says what it does here."}</span>
    ${s.problems.length ? html`<ul class="au-probs">${s.problems.map((p) => html`<li>${p.message}</li>`)}</ul>` : ""}`;
}
function paintSummary(s) {
  const el = typeof document !== "undefined" && document.querySelector("[data-sum]");
  if (!el) return;
  render(el, summaryBody(s));
}

const sync = (form, ctx) => { ctx.state.f = read(form, ctx.state); };
const restructure = (el, ctx, fn) => { const form = el.closest("form"); sync(form, ctx); fn(ctx.state.f); ctx.rerender(); check(ctx); };

async function save(ctx, form) {
  clearErrors(form);
  sync(form, ctx);
  const btn = form.querySelector("[type=submit]");
  busy(btn, true);
  try {
    const r = await ctx.api(`/automations/flows/${encodeURIComponent(ctx.state.id)}`, { method: "PATCH", ifMatch: ctx.state.etag, body: ctx.state.f });
    ctx.state.f = draftOf(r.data.flow); ctx.state.etag = r.etag; ctx.state.summary = r.data.flow.summary; ctx.state.problems = r.data.flow.problems || []; ctx.state.saved = r.data.flow.name;
    busy(btn, false); toast("Saved"); ctx.rerender();
  } catch (err) {
    busy(btn, false);
    if (err.status === 412) { toast("Someone else just changed this automation. Showing the latest.", { bad: true }); ctx.refresh(); } else showError(form, err);
  }
}

function testSheet(ctx, out) {
  const d = out;
  sheet({
    title: `Test run: ${d.contact ? d.contact.name : "?"}`,
    body: html`<div class="stack">
      <div class="note">Nothing was written and nothing was sent. This is what would happen if it started now.</div>
      <p class="small"><b>${d.starts ? "It would start." : "It wouldn't start:"}</b> ${d.conditions.filter((c) => !c.ok).map((c) => c.phrase).join(", ")}</p>
      ${d.notes.map((n) => html`<p class="small muted">${n}</p>`)}
      <ol class="au-out">${d.steps.map((st, i) => { const o = OUTCOME[st.outcome] || [st.outcome, ""]; return html`<li><div class="t"><span>${i + 1}. ${cap(st.phrase)}</span><span ${attrs({ class: `pill ${o[1]}` })}>${o[0]}</span></div>
        <p class="d">${dateTime(st.at)}${st.quiet ? " (after quiet hours)" : ""}</p>${st.detail ? html`<p class="d">${st.detail}</p>` : ""}${st.body ? html`<blockquote>${st.body}</blockquote>` : ""}</li>`; })}</ol>
    </div>`,
  });
}

export default {
  title: (s) => (s && s.saved ? s.saved : "Automation"),
  load,
  action(s, ctx) { return { label: "Save", run: () => { const form = document.getElementById("au-f"); if (form) save(ctx, form); } }; },
  render(s) {
    const n = s.f.steps.length;
    return html`<form class="form stack" id="au-f" novalidate>
      <div class="err" data-form-err hidden></div>
      <div class="au-sum" data-sum aria-live="polite">${summaryBody(s)}</div>
      <section class="card form">
        ${field({ label: "Name", name: "name", value: s.f.name, required: true, maxlength: 80 })}
        ${checkbox({ label: "On (it starts by itself)", name: "enabled", checked: s.f.enabled })}
        <p class="small muted">${s.runs ? `${s.runs} run${s.runs === 1 ? "" : "s"} so far.` : "It hasn't run yet."} Until the switch-over, its texts go to the Outbox and changes to Rotor's customers are only reported.</p>
      </section>
      ${triggerCard(s)}
      <section class="card form au-card">
        <h2>Only if</h2>
        ${s.f.conditions.length ? conds(s, s.f.conditions, "c", "cond") : html`<p class="small muted">Every time. Add a check to narrow it down.</p>`}
        <button type="button" class="btn" data-add-cond="cond">${icon("plus")}Add a check</button>
      </section>
      <section class="card form au-card">
        <h2>Then</h2>
        ${s.f.steps.map((st, i) => stepCard(s, st, i, n))}
        ${n < s.cat.max_steps ? html`<button type="button" class="btn" data-add-step>${icon("plus")}Add a step</button>` : ""}
      </section>
      <section class="card form au-card">
        <h2>Stop when</h2>
        <p class="small muted">Checked before every step and again right before each text or email.</p>
        ${conds(s, s.f.stop, "x", "stop")}
        <button type="button" class="btn" data-add-cond="stop">${icon("plus")}Add a stop</button>
      </section>
      <section class="card form">
        ${field({ label: "Not again for the same customer within (days)", name: "per_contact_days", value: String(s.f.limits.per_contact_days ?? 1), inputmode: "numeric", maxlength: 4, hint: "0 means no limit. Every automation also stops after 3 starts a day for one customer." })}
      </section>
      <button type="submit" class="btn primary block">Save</button>
      <div class="au-acts">
        <button type="button" class="btn" data-test>${icon("check")}Test run</button>
        <a class="btn" ${attrs({ href: `#/automations/flow/${s.id}/runs` })}>${icon("clock")}Run history</a>
        <button type="button" class="btn" data-dup>${icon("copy")}Duplicate</button>
        <button type="button" class="btn" data-del>${icon("archive")}Delete</button>
      </div>
      ${lists(s)}
    </form>`;
  },
  events: {
    "input #au-f": (e, form, ctx) => { if (e.target && e.target.name && !STRUCTURAL.test(e.target.name)) { sync(form, ctx); check(ctx); } },
    // a choice that changes which fields show redraws the form; any other change only updates the sentence
    "change #au-f": (e, form, ctx) => {
      const el = e.target;
      if (!el || !el.name) return;
      if (!STRUCTURAL.test(el.name)) { sync(form, ctx); check(ctx); return; }
      restructure(el, ctx, (f) => { if (el.name === "t_type" && f.trigger.type === "schedule" && !f.conditions.length) f.conditions.push({ field: "tags", op: "has", value: "" }); });
    },
    "click [data-dow]": (e, el, ctx) => restructure(el, ctx, (f) => {
      const d = Number(el.dataset.dow);
      const set = new Set(f.trigger.dows || [1, 2, 3, 4, 5]);
      if (set.has(d)) set.delete(d); else set.add(d);
      f.trigger.dows = [...set].sort();
    }),
    "click [data-add-cond]": (e, el, ctx) => restructure(el, ctx, (f) => {
      const where = el.dataset.addCond;
      const c = where === "stop" ? { field: "replied", op: "yes" } : { field: "tags", op: "has", value: "" };
      if (where === "cond") f.conditions.push(c);
      else if (where === "stop") f.stop.push(c);
      else { const st = f.steps[Number(where.slice(4))]; st.conditions = [...(st.conditions || []), { field: "replied", op: "yes" }]; }
    }),
    "click [data-del-cond]": (e, el, ctx) => restructure(el, ctx, (f) => {
      const [where, p] = el.dataset.delCond.split(":");
      const i = Number(p.replace(/^.*?(\d+)$/, "$1"));
      if (where === "cond") f.conditions.splice(i, 1);
      else if (where === "stop") f.stop.splice(i, 1);
      else { const st = f.steps[Number(where.slice(4))]; st.conditions.splice(i, 1); }
    }),
    "click [data-add-step]": (e, el, ctx) => restructure(el, ctx, (f) => { f.steps.push({ type: "task", title: "Follow up", assign: "owner", wait: { n: 1, unit: "days" } }); }),
    "click [data-del-step]": (e, el, ctx) => restructure(el, ctx, (f) => { f.steps.splice(Number(el.dataset.delStep), 1); }),
    "click [data-move]": (e, el, ctx) => restructure(el, ctx, (f) => {
      const [i, d] = el.dataset.move.split(":").map(Number);
      const [st] = f.steps.splice(i, 1);
      f.steps.splice(i + d, 0, st);
    }),
    "submit #au-f": (e, form, ctx) => { e.preventDefault(); save(ctx, form); },
    "click [data-test]": async (e, el, ctx) => {
      sync(el.closest("form"), ctx);
      const who = await pickContact(ctx.api, { title: "Test with which customer?" });
      if (!who) return;
      try {
        const r = await ctx.api("/automations/flows/test", { method: "POST", body: { flow: { ...ctx.state.f, id: ctx.state.id }, contact_id: who.id } });
        testSheet(ctx, r.data);
      } catch (err) { toast(err.message, { bad: true }); }
    },
    "click [data-dup]": async (e, el, ctx) => {
      try { const r = await ctx.api(`/automations/flows/${encodeURIComponent(ctx.state.id)}/duplicate`, { method: "POST", body: {} }); toast("Duplicated (off)"); ctx.go(`/automations/flow/${r.data.flow.id}`); } catch (err) { toast(err.message, { bad: true }); }
    },
    "click [data-del]": async (e, el, ctx) => {
      if (!(await confirmSheet("Its waiting runs stop at their next step. Its history stays in the log.", { title: `Delete "${ctx.state.saved}"?`, yes: "Delete", danger: true }))) return;
      try { await ctx.api(`/automations/flows/${encodeURIComponent(ctx.state.id)}`, { method: "DELETE" }); toast("Deleted"); ctx.go("/automations"); } catch (err) { toast(err.message, { bad: true }); }
    },
  },
};
