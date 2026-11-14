// One task: new (from Tasks, the create button, or a contact's Sales tab),
// edit, done. An estimate visit has a start and an end (the Schedule draws
// it); an incident has no due date and shows how long ago it was reported.
// A technician sees their own task and moves it along (started, done).

import { html, attrs, toast } from "../../core/ui.js";
import { field, select, readForm, clearErrors, showError, busy } from "../../core/forms.js";
import { dateField, timeField, pickContact } from "../../core/pickers.js";
import { dateShort, dateTime } from "../../core/format.js";
import { ensureStyles, TASK_KINDS, PRIORITY, taskKindLabel } from "./kit.js";

const STATUSES = [{ value: "open", label: "Open" }, { value: "in_progress", label: "Started" }, { value: "waiting", label: "Waiting" }, { value: "done", label: "Done" }];
const tz = (iso, opts) => (iso ? new Intl.DateTimeFormat("en-CA", { timeZone: "America/Chicago", ...opts }).format(new Date(iso)) : "");
const localDay = (iso) => tz(iso);
const localHm = (iso) => (iso ? tz(iso, { hour: "2-digit", minute: "2-digit", hourCycle: "h23" }) : "");

// "2026-11-20" + "09:30" in Delano → an ISO instant (the browser may be elsewhere).
function toIso(date, hm) {
  if (!date) return null;
  const [h, m] = (hm || "09:00").split(":").map(Number);
  const guess = Date.UTC(+date.slice(0, 4), +date.slice(5, 7) - 1, +date.slice(8, 10), h, m);
  for (const off of [5, 6]) {
    const t = guess + off * 3600000;
    if (localDay(new Date(t).toISOString()) === date && localHm(new Date(t).toISOString()) === `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}`) return new Date(t).toISOString();
  }
  return new Date(guess + 6 * 3600000).toISOString();
}

async function load(params, ctx) {
  ensureStyles();
  const office = ctx.can("sales:work");
  const users = office ? await ctx.api("/users").then((r) => (r.data || []).filter((u) => u.status === "active")).catch(() => []) : [];
  if (!params.id || params.id === "new") {
    let contact = null;
    if (params.contact) {
      const r = await ctx.api(`/sales/contacts/${encodeURIComponent(params.contact)}`, { cache: false }).catch(() => null);
      if (r) contact = { id: r.data.contact.id, name: r.data.contact.name };
    }
    return { isNew: true, office, users, task: { kind: "todo", priority: "medium", status: "open", assignee_ids: ctx.user ? [ctx.user.id] : [], contact_id: contact && contact.id, contact_name: contact && contact.name } };
  }
  const r = await ctx.api(`/tasks/${encodeURIComponent(params.id)}`, { cache: false });
  return { isNew: false, office, users, task: r.data.task, etag: r.etag };
}

function techView(s) {
  const t = s.task;
  return html`<div class="stack">
    <section class="card"><h2>${t.title}</h2>
      <dl class="kv" style="margin-top:8px"><dt>Kind</dt><dd>${taskKindLabel(t.kind)}</dd><dt>Status</dt><dd>${(STATUSES.find((x) => x.value === t.status) || {}).label || t.status}</dd>
      ${t.due_at ? html`<dt>When</dt><dd>${dateTime(t.due_at)}</dd>` : ""}${t.reported_on ? html`<dt>Reported</dt><dd>${dateShort(t.reported_on)}</dd>` : ""}${t.contact_name ? html`<dt>Contact</dt><dd>${t.contact_name}</dd>` : ""}</dl>
    </section>
    ${t.status !== "done" ? html`<div class="btn-row" style="margin-top:0">${t.status === "open" ? html`<button type="button" class="btn" data-status="in_progress">Started</button>` : ""}<button type="button" class="btn primary" data-status="done">Done</button></div>` : ""}
  </div>`;
}

export default {
  title: (s) => (s && s.isNew ? "New task" : "Task"),
  load,
  render(s) {
    if (!s.office) return techView(s);
    const t = s.task;
    const timed = t.kind === "estimate_visit" || t.kind === "meeting" || t.kind === "personal";
    return html`<form class="form" id="task-f" novalidate>
      <div class="err" data-form-err hidden></div>
      ${field({ label: "What needs doing", name: "title", value: t.title || "", required: true, maxlength: 160 })}
      <div class="grid2">${select({ label: "Kind", name: "kind", value: t.kind, options: TASK_KINDS })}${select({ label: "Priority", name: "priority", value: t.priority, options: Object.entries(PRIORITY).map(([value, label]) => ({ value, label })) })}</div>
      ${t.kind === "incident" ? html`<p class="small muted">Incidents have no due date; the list shows how many days since they were reported${t.reported_on ? ` (${dateShort(t.reported_on)})` : ""}.</p>` : html`
        <div class="grid2">${dateField({ label: "Due", name: "due_date", value: localDay(t.due_at) })}${timeField({ label: "At", name: "due_time", value: localHm(t.due_at) })}</div>
        ${timed ? timeField({ label: "Until", name: "end_time", value: localHm(t.end_at), hint: "A start and an end put it on the Schedule." }) : ""}`}
      <div class="field" data-field="contact_id"><span>Contact</span>
        <div class="row" style="padding:0;min-height:44px">${t.contact_id ? html`<a class="linkish who" href="${"#/contacts/" + encodeURIComponent(t.contact_id)}">${t.contact_name || "A contact"}</a>` : html`<span class="who muted">None</span>`}<button type="button" class="btn" data-contact>${t.contact_id ? "Change" : "Pick"}</button></div>
        <small class="why" hidden></small></div>
      <fieldset class="field" style="border:0;padding:0;margin:0"><span>Who does it</span><div class="sl-people">${s.users.map((u) => html`<label class="check"><input ${attrs({ type: "checkbox", name: `who_${u.id}`, checked: (t.assignee_ids || []).includes(u.id) })}><span>${u.name}</span></label>`)}</div></fieldset>
      ${s.isNew ? "" : select({ label: "Status", name: "status", value: t.status, options: STATUSES })}
      <label class="field" data-field="notes"><span>Notes</span><textarea name="notes" rows="4" maxlength="4000">${t.notes || ""}</textarea><small class="why" hidden></small></label>
      ${(t.photo_ids || []).length ? html`<div class="field"><span>Photos from the customer</span><div class="sl-photos">${t.photo_ids.map((id) => html`<a ${attrs({ href: `/api/crm/files/${encodeURIComponent(id)}`, target: "_blank", rel: "noopener" })}><img ${attrs({ src: `/api/crm/files/${encodeURIComponent(id)}`, alt: "A photo the customer sent", loading: "lazy", width: 96, height: 96 })}></a>`)}</div></div>` : ""}
      <button type="submit" class="btn primary block">${s.isNew ? "Add task" : "Save"}</button>
      ${!s.isNew && t.status !== "done" ? html`<button type="button" class="btn block" data-status="done">Mark done</button>` : ""}
    </form>`;
  },
  events: {
    "change [name=kind]": (e, el, ctx) => { ctx.state.task = { ...ctx.state.task, ...readTask(el.form, ctx), kind: el.value }; ctx.rerender(); },
    "click [data-contact]": async (e, el, ctx) => {
      const c = await pickContact(ctx.api, { title: "Which contact?" });
      if (!c) return;
      ctx.state.task = { ...ctx.state.task, ...readTask(el.closest("form"), ctx), contact_id: c.id, contact_name: c.name };
      ctx.rerender();
    },
    "click [data-status]": async (e, el, ctx) => {
      const t = ctx.state.task;
      busy(el, true);
      try {
        if (el.dataset.status === "done") await ctx.api(`/tasks/${encodeURIComponent(t.id)}/done`, { method: "POST", body: {} });
        else await ctx.api(`/tasks/${encodeURIComponent(t.id)}`, { method: "PATCH", body: { status: el.dataset.status }, ifMatch: ctx.state.etag });
        toast("Saved");
        ctx.back();
      } catch (err) { busy(el, false); toast(err.message, { bad: true }); }
    },
    "submit #task-f": async (e, form, ctx) => {
      e.preventDefault(); clearErrors(form);
      const body = readTask(form, ctx);
      if (!body.title) { showError(form, { field: "title", message: "Say what needs doing." }); return; }
      const btn = form.querySelector("[type=submit]"); busy(btn, true);
      try {
        if (ctx.state.isNew) {
          const r = await ctx.api("/tasks", { method: "POST", body: { ...body, client_id: globalThis.crypto && crypto.randomUUID ? crypto.randomUUID() : undefined } });
          toast("Task added");
          ctx.go(`/tasks/${encodeURIComponent(r.data.task.id)}`, { replace: true });
        } else {
          await ctx.api(`/tasks/${encodeURIComponent(ctx.state.task.id)}`, { method: "PATCH", body, ifMatch: ctx.state.etag });
          toast("Saved");
          ctx.refresh();
        }
      } catch (err) {
        busy(btn, false);
        if (err.status === 412) { toast("Someone else just changed this task. Showing the latest.", { bad: true }); ctx.refresh(); } else showError(form, err);
      }
    },
  },
};

function readTask(form, ctx) {
  const v = readForm(form);
  const t = ctx.state.task;
  const kind = v.kind || t.kind;
  const due = kind === "incident" ? null : toIso(v.due_date, v.due_time);
  const end = due && v.end_time ? toIso(v.due_date, v.end_time) : null;
  return {
    title: v.title, kind, priority: v.priority || t.priority, ...(v.status ? { status: v.status } : {}),
    due_at: due || "", end_at: end || "", contact_id: t.contact_id || "", notes: v.notes || "",
    assignee_ids: ctx.state.users.filter((u) => v[`who_${u.id}`]).map((u) => u.id),
  };
}
