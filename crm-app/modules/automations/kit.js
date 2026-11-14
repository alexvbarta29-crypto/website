// The automation builder's shared parts: the stylesheet, a condition row
// (what to check, how, the value, by the field's type) and reading one back
// from the form, and the words for a run's or a step's outcome. The
// catalog (fields, ops, statuses...) comes from the server
// (GET /automations/flows/:id?catalog=1), never a copy here.

import { html, attrs, icon } from "../../core/ui.js";

let styled = false;
export function ensureStyles() {
  if (styled || typeof document === "undefined") return;
  styled = true;
  const l = document.createElement("link");
  l.rel = "stylesheet";
  l.href = "/crm-app/modules/automations/automations.css";
  document.head.appendChild(l);
}

const sel = (name, value, options, label) => html`<label class="field" data-field="${name}"><span>${label}</span><select ${attrs({ name })}>${options.map((o) => html`<option ${attrs({ value: o.value, selected: String(o.value) === String(value ?? "") })}>${o.label}</option>`)}</select><small class="why" hidden></small></label>`;
const inp = (name, value, label, extra = {}) => html`<label class="field" data-field="${name}"><span>${label}</span><input ${attrs({ name, value: value ?? "", ...extra })}><small class="why" hidden></small></label>`;
const md = (v) => (/^\d{2}-\d{2}$/.test(v || "") ? `2026-${v}` : "");

// One condition row. p: the name prefix ("c0", "x1", "s2c0"); subject: the trigger's record kind.
export function conditionRow(c, p, cat, ch, subject, where) {
  const field = cat.fields.find((f) => f.key === c.field) || cat.fields[0];
  const ops = field.ops.map((o) => ({ value: o, label: cat.ops[o] || o }));
  const fieldOpts = cat.fields.filter((f) => f.key !== "status" || (cat.statuses[subject] || []).length).map((f) => ({ value: f.key, label: f.label }));
  let value = "";
  const v = c.value;
  switch (field.type) {
    case "text": value = inp(`${p}_value`, v, "Value", { type: "text", list: field.key === "source" ? "au-sources" : "au-towns", maxlength: 60, autocomplete: "off" }); break;
    case "tag": value = inp(`${p}_value`, v, "Tag", { type: "text", list: "au-tags", maxlength: 40, autocomplete: "off" }); break;
    case "user": value = c.op === "none" ? "" : sel(`${p}_value`, v, [{ value: "", label: "Pick someone" }, ...ch.users.map((u) => ({ value: u.id, label: u.name }))], "Person"); break;
    case "enum": value = sel(`${p}_value`, v, field.options, "Value"); break;
    case "status": value = sel(`${p}_value`, v, (cat.statuses[subject] || []).map((s) => ({ value: s, label: s.replace(/_/g, " ") })), "Status"); break;
    case "money": value = inp(`${p}_value`, Number.isInteger(v) ? String(v) : "", "Dollars", { type: "text", inputmode: "numeric", maxlength: 9 }); break;
    case "time_range": value = html`${inp(`${p}_value`, (v || [])[0] || "09:00", "From", { type: "time" })}${inp(`${p}_v2`, (v || [])[1] || "17:00", "To", { type: "time" })}`; break;
    case "date_range": value = html`${inp(`${p}_value`, md((v || [])[0]), "From", { type: "date" })}${inp(`${p}_v2`, md((v || [])[1]), "To", { type: "date" })}`; break;
    default: value = "";
  }
  return html`<div class="au-row" ${attrs({ "data-cond": p })}>
    ${sel(`${p}_field`, field.key, fieldOpts, "Check")}
    ${sel(`${p}_op`, c.op || field.ops[0], ops, "How")}
    ${value ? html`<div class="au-v">${value}</div>` : ""}
    <button type="button" class="btn au-x" ${attrs({ "data-del-cond": `${where}:${p}`, "aria-label": "Remove this condition" })}>${icon("close")}Remove</button>
  </div>`;
}

// The row back from the form values (v: readForm()).
export function readCondition(v, p, cat, prev = {}) {
  const field = cat.fields.find((f) => f.key === v[`${p}_field`]) || cat.fields[0];
  const changed = prev.field !== field.key;
  const op = !changed && field.ops.includes(v[`${p}_op`]) ? v[`${p}_op`] : field.ops[0];
  const out = { field: field.key, op };
  const raw = changed ? undefined : v[`${p}_value`];
  switch (field.type) {
    case "money": { const n = Number(String(raw || "").replace(/[$,\s]/g, "")); out.value = raw === undefined || raw === "" || !Number.isFinite(n) ? undefined : Math.round(n); break; }
    case "time_range": out.value = [raw || "09:00", (changed ? null : v[`${p}_v2`]) || "17:00"]; break;
    case "date_range": { const a = (raw || "").slice(5); const b = ((changed ? "" : v[`${p}_v2`]) || "").slice(5); out.value = [a || "09-15", b || "10-15"]; break; }
    case "bool": case "days": break;
    case "enum": out.value = raw || (field.options[0] && field.options[0].value); break;
    default: if (raw !== undefined && !(field.type === "user" && op === "none")) out.value = raw;
  }
  return out;
}

export const RUN_STATUS = { running: ["Waiting", "blue"], waiting: ["Waiting", "blue"], done: ["Done", "green"], stopped: ["Stopped", "amber"], skipped: ["Skipped", ""], failed: ["Failed", "red"] };
export const STEP_STATUS = { pending: "Not yet", waiting: "Waiting", held: "Held (paused)", done: "Done", queued: "Sent to the sender", would: "Would have (Rotor's record)", skipped: "Skipped", bulk: "Waiting for a test send and your confirm", failed: "Failed" };
export const OUTCOME = { outbox: ["Outbox (dry run)", "blue"], change: ["Does it", "green"], would: ["Report only", "amber"], notify: ["Tells the team", "green"], blocked: ["Blocked", "red"], skipped: ["Skipped", ""], stop: ["Stops here", "amber"], continue: ["Goes on", "green"] };
const REASONS = { stop_replied: "they replied", stop_reviewed: "they left a review", stop_status: "the record changed", stop_has_plan: "they have a plan", deleted: "the automation was deleted", paused_too_long: "paused for more than 14 days", switch_over: "started before the switch-over", everyone_stopped: "everyone stopped" };
export const reasonText = (r) => (r ? REASONS[r] || String(r).replace(/^stop_(if_)?/, "").replace(/_/g, " ") : "");
