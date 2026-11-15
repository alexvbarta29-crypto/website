// New job (Flyra's "New Job" sheet, the owner, Nov 15; design §9.2): the
// customer and their property, the Mockup chip on lights work, line items
// (the price book or typed) with discounts and the total, the schedule
// (starts, ends, the arrival window, View schedule for that day's
// conflicts; or "Book later" with the month it's due, for the To book
// list), the checklist (automatic by the work, one picked, or none), the
// lead source (the customer's own), the salesperson, who goes, "Notify the
// customer" (off: no booking text for this visit), notes for the crew and
// attachments (on the first visit, or on the customer when nothing is
// booked). One tap saves the job and books its visits (a job over several
// days gets one visit a day); a retry never makes a second job (client id).
//
// Flyra's "Recurring job" switch isn't here: the work module has no repeat
// rule, and recurring work is a plan (New plan).

import { toast } from "../../core/ui.js";
import { uuid } from "../../core/api.js";
import { busy } from "../../core/forms.js";
import { uploadPhoto } from "../../core/camera.js";
import {
  ensureCreateStyles, createPage, fieldLabel, customerCard, mockupChip, addRow, itemRows, lineRowOf, totalRow, pickRow, switchRow, pillDate, pillTime, slotRow, scheduleLink,
  notesField, attachRow, setReady, pillChanged, openPill, deskPointer, redraw, loadCustomer, primaryOf, saveLeadSource, pickCustomer, pickProperty, pickItem,
  lineFromItem, lineSheet, discountSheet, discountWords, pickOne, pickMany, daySheet, pickFiles, totalOf, toMin, fromMin, addDays, today,
} from "../../core/create.js";
import { html, attrs } from "../../core/ui.js";
import { ensureStyles, JOB_KINDS, kindLabel, loadUsers, team } from "./office-kit.js";
import { SOURCES } from "../contacts/kit.js";

const LIGHTS = (s) => /^lights_/.test(s.kind) || s.lines.some((l) => /christmas lights/i.test(l.service_type || "") || /\blights?\b/i.test(l.title || ""));
const isDate = (d) => /^\d{4}-\d{2}-\d{2}$/.test(String(d || ""));
const MAX_DAYS = 7;

async function load(params, ctx) {
  ensureStyles();
  await ensureCreateStyles();
  const q = new URLSearchParams((typeof location !== "undefined" && location.hash.split("?")[1]) || "");
  const [users, cx, checklists, contact] = await Promise.all([
    loadUsers(ctx).then(team).catch(() => []),
    ctx.can("quotes:read") ? ctx.api("/pricing/context").then((r) => r.data).catch(() => null) : null,
    ctx.api("/checklists").then((r) => (r.data || []).filter((c) => c.act !== false)).catch(() => []),
    params.contact ? loadCustomer(ctx.api, params.contact).catch(() => null) : null,
  ]);
  // ?date= (the Schedule's "Add job" books for its day); ?book=0 starts as "Book later"
  const date = isDate(q.get("date")) ? q.get("date") : addDays(today(), 1);
  const me = ctx.user && ctx.user.id && users.some((u) => u.id === ctx.user.id) ? ctx.user.id : "";
  return {
    contact, property: primaryOf(contact, q.get("property") || ""), source: contact ? contact.source : "",
    lines: [], discounts: [], kind: "standard", users, checklists, book: (cx && cx.book) || [], defs: ((cx && cx.discounts) || []).filter((d) => d.active !== false && d.sellable !== false && !d.plan_only && d.stack_group !== "plan"),
    later: q.get("book") === "0", date, start: "08:00", endDate: date, end: "10:00", window: true, month: (q.get("month") && /^\d{4}-\d{2}$/.test(q.get("month"))) ? q.get("month") : today().slice(0, 7),
    checklist: "", sold_by: me, people: [], notify: true, notes: "", files: [], client_id: uuid(),
  };
}

function ready(s) {
  if (!s.contact || !s.lines.length) return false;
  if (s.later) return true;
  return isDate(s.date) && isDate(s.endDate) && s.endDate >= s.date && toMin(s.end) > toMin(s.start) && days(s).length <= MAX_DAYS;
}
function days(s) {
  const out = [];
  for (let d = s.date; d <= s.endDate && out.length <= MAX_DAYS; d = addDays(d, 1)) out.push(d);
  return out;
}
const userName = (s, id) => (s.users.find((u) => u.id === id) || {}).name || "";
const crewText = (s) => (s.people.length ? s.people.map((id) => userName(s, id).split(" ")[0]).filter(Boolean).join(", ") : "Nobody yet");
const checklistText = (s) => (s.checklist === "none" ? "None" : s.checklist ? ((s.checklists.find((c) => c.k === s.checklist) || {}).n || "Picked") : "Automatic");

function render(s, ctx) {
  const total = totalOf(s.lines, s.discounts);
  const windowText = s.window ? `They're told ${clockOf(s.start)} to ${clockOf(fromMin(toMin(s.start) + 120))}` : "They're told the start time";
  const body = html`
    ${fieldLabel("Customer")}
    ${customerCard(s.contact, s.property)}
    ${mockupChip(LIGHTS(s) && ctx.can("office:tools"))}
    ${fieldLabel("Line items", { required: true, field: "lines" })}
    ${itemRows(s.lines.map((l, i) => lineRowOf(l, { "cf-line": String(i) })))}
    ${addRow("Add line item", { data: { "cf-addline": true } })}
    ${itemRows(s.discounts.map((d, i) => ({ title: d.name || "Discount", sub: discountWords(d), cents: null, data: { "cf-disc": String(i) } })))}
    ${addRow("Add discount", { icon: "tag", data: { "cf-adddisc": true } })}
    ${totalRow(total)}
    ${fieldLabel("Schedule", { field: "date", end: html`<span class="cf-lbl-end">Book later${switchOnly(s.later, "cf-later", "Book later")}</span>` })}
    ${s.later
      ? html`<div class="cf-card">${slotRow("Due by", html`<label class="cf-pill"><span aria-hidden="true">${monthText(s.month)}</span><input ${attrs({ type: "month", name: "target_month", value: s.month, "aria-label": "Due by (month)", "data-cf-month": true })}></label>`)}</div>
        <p class="cf-hint">It waits on the To book list for that month.</p>`
      : html`<div class="cf-card">
          ${slotRow("Starts", html`${pillDate("date", s.date, { label: "Starts (day)" })}${pillTime("start", s.start, { label: "Starts (time)" })}`)}
          ${slotRow("Ends", html`${pillDate("end_date", s.endDate, { label: "Ends (day)", min: s.date })}${pillTime("end", s.end, { label: "Ends (time)" })}`)}
          ${switchRow("Arrival window", s.window, { data: { "cf-window": true }, sub: windowText, muted: !s.window })}
        </div>
        ${days(s).length > 1 ? html`<p class="cf-hint">${days(s).length > MAX_DAYS ? `Up to ${MAX_DAYS} days in a row.` : `${days(s).length} days: a visit each day, ${clockOf(s.start)} to ${clockOf(s.end)}.`}</p>` : ""}
        ${scheduleLink()}`}
    <div class="cf-card">${pickRow("Checklist", checklistText(s), { data: { "cf-checklist": true }, chev: "chevdown", muted: !s.checklist })}</div>
    <div class="cf-card">
      ${pickRow("Job type", kindLabel(s.kind), { data: { "cf-kind": true } })}
      ${pickRow("Lead source", s.source || "None", { data: { "cf-source": true }, muted: !s.source })}
      ${pickRow("Salesperson", userName(s, s.sold_by) || "Nobody", { data: { "cf-seller": true }, muted: !s.sold_by })}
      ${s.later ? "" : pickRow("Dispatched to", crewText(s), { data: { "cf-crew": true }, muted: !s.people.length })}
    </div>
    ${s.later ? "" : html`<div class="cf-card">${switchRow("Notify the customer", s.notify, { data: { "cf-notify": true }, sub: s.notify ? "The booking text (in the Outbox while texts are off)" : "No booking text for this visit" })}</div>`}
    ${notesField("crew_notes", s.notes, { placeholder: "Add a note for the crew", label: "Notes" })}
    ${attachRow(s.files)}`;
  return createPage({ title: "New Job", body, form: { id: "wk-new-job" }, cta: { label: "Create Job", disabled: !ready(s) } });
}
const switchOnly = (on, key, label) => html`<button type="button" ${attrs({ class: "switch", role: "switch", "aria-checked": on ? "true" : "false", "aria-label": label, ["data-" + key]: "" })}></button>`;
const clockOf = (t) => { const m = toMin(t); if (m === null) return ""; const h = Math.floor(m / 60); return `${((h + 11) % 12) + 1}:${String(m % 60).padStart(2, "0")} ${h < 12 ? "AM" : "PM"}`; };
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const monthText = (m) => (/^\d{4}-\d{2}$/.test(String(m || "")) ? `${MONTHS[Number(m.slice(5, 7)) - 1]} ${m.slice(0, 4)}` : "Pick a month");

async function save(form, ctx) {
  const s = ctx.state;
  const err = form.querySelector("[data-form-err]");
  err.hidden = true;
  if (!ready(s)) {
    err.textContent = !s.contact ? "Pick the customer first." : !s.lines.length ? "Add a line item (the work)." : "Check the start and end.";
    err.hidden = false;
    return;
  }
  const visit = s.later ? null : { date: s.date, start: s.start, end: s.end, window: s.window ? { type: "window", minutes: 120 } : { type: "exact", minutes: 0 }, assignee_ids: s.people, ...(s.notify ? {} : { notify: false }) };
  const body = {
    contact_id: s.contact.id, ...(s.property ? { property_id: s.property.id } : {}), kind: s.kind, client_id: s.client_id,
    lines: s.lines.map((l) => ({ title: l.title, unit_cents: l.unit_cents || 0, qty_milli: Number.isInteger(l.qty_milli) ? l.qty_milli : 1000, ...(l.service_type ? { service_type: l.service_type } : {}) })),
    discounts: s.discounts.map((d) => ({ name: d.name || "Discount", type: d.type, value: d.value })),
    crew_notes: s.notes, ...(s.checklist ? { checklist_key: s.checklist } : {}), ...(s.sold_by ? { sold_by: s.sold_by } : {}),
    ...(visit ? { visit } : { target_month: s.month }),
  };
  const btn = form.querySelector("[data-cf-create]");
  busy(btn, true, "Creating…");
  try {
    const r = await ctx.api("/jobs", { method: "POST", body });
    const job = r.data.job;
    const warns = [...((r.meta && r.meta.warnings) || [])];
    // a job over several days: a visit a day
    if (visit) {
      for (const [n, d] of days(s).slice(1).entries()) {
        const x = await ctx.api("/visits", { method: "POST", body: { ...visit, job_id: job.id, date: d, client_id: `${s.client_id}-d${n + 2}` } }).catch((e) => { warns.push({ message: e.message }); return null; });
        if (x && x.meta && x.meta.warnings) warns.push(...x.meta.warnings);
      }
    }
    await saveLeadSource(ctx.api, s.contact, s.source);
    for (const f of s.files) {
      await uploadPhoto(r.data.visit ? { ownerType: "visit", ownerId: r.data.visit.id, file: f } : { ownerType: "contact", ownerId: s.contact.id, file: f }).catch((e) => warns.push({ message: `${f.name || "A file"} didn't upload: ${e.message}` }));
    }
    toast(warns.length ? `Job created. Heads up: ${warns[0].message}` : "Job created", { ms: warns.length ? 5000 : 2600 });
    ctx.go(r.data.visit ? `/visits/${r.data.visit.id}` : `/jobs/${job.id}`, { replace: true });
  } catch (e) {
    busy(btn, false);
    err.textContent = e.message || "That didn't save.";
    err.hidden = false;
    err.scrollIntoView({ block: "nearest" });
  }
}

export default {
  title: "New job",
  load,
  render,
  events: {
    "click [data-cf-close]": (e, el, ctx) => ctx.back(),
    "click [data-cf-pick]": (e, el, ctx) => choose(ctx),
    "click [data-cf-clear]": (e, el, ctx) => choose(ctx),
    "click [data-cf-prop]": async (e, el, ctx) => {
      const s = ctx.state;
      const p = await pickProperty(ctx.api, s.contact, s.property && s.property.id);
      if (p) { s.property = p; redraw(ctx); }
    },
    "click [data-cf-addline]": async (e, el, ctx) => {
      const s = ctx.state;
      const got = await pickItem({ book: s.book });
      if (!got) return;
      let line = got.item ? lineFromItem(got.item) : null;
      if (!line || !line.unit_cents) line = await lineSheet(line);
      if (!line || line === "remove") return;
      s.lines.push(line);
      redraw(ctx);
    },
    "click [data-cf-line]": async (e, el, ctx) => {
      const s = ctx.state;
      const i = Number(el.dataset.cfLine);
      const got = await lineSheet(s.lines[i]);
      if (!got) return;
      if (got === "remove") s.lines.splice(i, 1); else s.lines[i] = got;
      redraw(ctx);
    },
    "click [data-cf-adddisc]": async (e, el, ctx) => {
      const d = await discountSheet(ctx.state.defs);
      if (d && d !== "remove") { ctx.state.discounts.push(d); redraw(ctx); }
    },
    "click [data-cf-disc]": async (e, el, ctx) => {
      const s = ctx.state;
      const i = Number(el.dataset.cfDisc);
      const d = await discountSheet(s.defs, s.discounts[i]);
      if (!d) return;
      if (d === "remove") s.discounts.splice(i, 1); else s.discounts[i] = d;
      redraw(ctx);
    },
    "click .cf-pill": (e, el) => { if (deskPointer()) openPill(el); },
    "change [data-cf-pill]": (e, el, ctx) => {
      const s = ctx.state;
      pillChanged(el);
      if (el.name === "date") {
        const span = s.endDate && s.date && s.endDate >= s.date ? Math.round((Date.parse(s.endDate) - Date.parse(s.date)) / 86400000) : 0;
        s.date = el.value || s.date;
        s.endDate = addDays(s.date, span);
      } else if (el.name === "end_date") s.endDate = el.value || s.date;
      else if (el.name === "start") {
        const len = Math.max(15, (toMin(s.end) ?? 600) - (toMin(s.start) ?? 480));
        s.start = el.value || s.start;
        s.end = fromMin(toMin(s.start) + len);
      } else if (el.name === "end") s.end = el.value || s.end;
      redraw(ctx);
    },
    "change [data-cf-month]": (e, el, ctx) => { if (/^\d{4}-\d{2}$/.test(el.value)) ctx.state.month = el.value; redraw(ctx); },
    "click [data-cf-later]": (e, el, ctx) => { ctx.state.later = !ctx.state.later; redraw(ctx); },
    "click [data-cf-window]": (e, el, ctx) => { ctx.state.window = !ctx.state.window; redraw(ctx); },
    "click [data-cf-notify]": (e, el, ctx) => { ctx.state.notify = !ctx.state.notify; redraw(ctx); },
    "click [data-cf-day]": (e, el, ctx) => { const s = ctx.state; daySheet(ctx.api, { date: s.date, start: s.start, end: s.end, users: s.people }); },
    "click [data-cf-checklist]": async (e, el, ctx) => {
      const s = ctx.state;
      const v = await pickOne({ title: "Checklist", current: s.checklist || "auto", items: [
        { value: "auto", label: "Automatic", sub: "The one that fits the work" },
        ...s.checklists.map((c) => ({ value: c.k, label: c.n, sub: `${c.ni} item${c.ni === 1 ? "" : "s"}${c.nr ? `, ${c.nr} required` : ""}` })),
        { value: "none", label: "None", sub: "No checklist on this job" },
      ] });
      if (v === null) return;
      s.checklist = v === "auto" ? "" : v;
      redraw(ctx);
    },
    "click [data-cf-kind]": async (e, el, ctx) => {
      const v = await pickOne({ title: "Job type", current: ctx.state.kind, items: JOB_KINDS.map((k) => ({ value: k.value, label: k.label })) });
      if (v) { ctx.state.kind = v; redraw(ctx); }
    },
    "click [data-cf-source]": async (e, el, ctx) => {
      if (!ctx.state.contact) { toast("Pick the customer first.", { bad: true }); return; }
      const v = await pickOne({ title: "Lead source", current: ctx.state.source, items: SOURCES.map((x) => ({ value: x, label: x })) });
      if (v) { ctx.state.source = v; redraw(ctx); }
    },
    "click [data-cf-seller]": async (e, el, ctx) => {
      const s = ctx.state;
      const v = await pickOne({ title: "Salesperson", current: s.sold_by || "-", items: [{ value: "-", label: "Nobody" }, ...s.users.map((u) => ({ value: u.id, label: u.name }))] });
      if (v === null) return;
      s.sold_by = v === "-" ? "" : v;
      redraw(ctx);
    },
    "click [data-cf-crew]": async (e, el, ctx) => {
      const s = ctx.state;
      const v = await pickMany({ title: "Dispatched to", picked: s.people, items: s.users.map((u) => ({ value: u.id, label: u.name, color: u.color, sub: u.is_technician ? "Technician" : "" })) });
      if (v) { s.people = v; redraw(ctx); }
    },
    "input [name=crew_notes]": (e, el, ctx) => { ctx.state.notes = el.value; },
    "click [data-cf-attach]": async (e, el, ctx) => {
      const files = await pickFiles();
      if (files.length) { ctx.state.files.push(...files); ctx.state.files = ctx.state.files.slice(0, 10); redraw(ctx); }
    },
    "click [data-cf-unattach]": (e, el, ctx) => { ctx.state.files.splice(Number(el.dataset.cfUnattach), 1); redraw(ctx); },
    "submit #wk-new-job": (e, form, ctx) => { e.preventDefault(); save(form, ctx); },
  },
  // the Create button follows the form (also after a picker closes)
  mount(el, s) { setReady(el, ready(s)); },
};

async function choose(ctx) {
  const s = ctx.state;
  const c = await pickCustomer(ctx.api, { title: "Customer", lifecycle: "customer" });
  if (!c) return;
  s.contact = c;
  s.property = primaryOf(c);
  s.source = c.source || "";
  redraw(ctx);
}
