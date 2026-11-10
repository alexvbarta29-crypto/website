// One job (design §9.2 "Job"): the customer and the place, the work and
// its total, the visits (tap one to open it), and the office's buttons:
// Book a visit, Edit, Mark done, Cancel, Reopen. A technician reaches a
// job only through a visit of theirs; the server answers with what they
// may see (no office notes, prices only with visits:prices).

import { html, icon, attrs, sheet, toast, confirmSheet } from "../../core/ui.js";
import { money, dateShort, ago } from "../../core/format.js";
import { readForm, showError, clearErrors, busy } from "../../core/forms.js";
import { directionsLink } from "../../core/map.js";
import {
  ensureStyles, jobPill, visitPill, kindLabel, JOB_KINDS, slotText, faces, scheduleSheet, reasonSheet, loadUsers, officeView, emptyCard,
  linesEditor, addLine, removeLine, readLines,
} from "./office-kit.js";

async function load(params, ctx) {
  ensureStyles();
  const r = await ctx.api(`/jobs/${encodeURIComponent(params.id)}`, { cache: false });
  const users = officeView() ? await loadUsers(ctx).catch(() => []) : [];
  return { ...r.data, etag: r.etag, users };
}

const monthLabel = (m) => (m ? new Intl.DateTimeFormat("en-US", { timeZone: "UTC", month: "long", year: "numeric" }).format(new Date(m + "-15T12:00:00Z")) : "");

function editSheet(ctx) {
  const s = ctx.state;
  const j = s.job;
  const closed = ["completed", "cancelled"].includes(j.status);
  const sh = sheet({
    title: "Edit the job",
    body: html`<form class="form" id="wk-job-edit" novalidate>
      <div class="err" data-form-err hidden></div>
      <label class="field" data-field="title"><span>Title</span><input name="title" maxlength="160" ${attrs({ value: j.title || "" })}><small>Leave it as it is and it follows the work.</small><small class="why" hidden></small></label>
      ${closed ? "" : html`<label class="field" data-field="kind"><span>Kind</span><select name="kind">${JOB_KINDS.map((k) => html`<option ${attrs({ value: k.value, selected: k.value === j.kind })}>${k.label}</option>`)}</select><small class="why" hidden></small></label>`}
      ${j.status === "unscheduled" ? html`<label class="field" data-field="target_month"><span>Due by (month)</span><input type="month" name="target_month" ${attrs({ value: j.target_month || "" })}><small class="why" hidden></small></label>` : ""}
      ${closed ? "" : linesEditor(j.lines || [])}
      <label class="field" data-field="crew_notes"><span>Notes for the crew</span><textarea name="crew_notes" rows="3" maxlength="2000">${j.crew_notes || ""}</textarea><small class="why" hidden></small></label>
      <label class="field" data-field="office_notes"><span>Office notes (the crew never sees these)</span><textarea name="office_notes" rows="3" maxlength="4000">${j.office_notes || ""}</textarea><small class="why" hidden></small></label>
      <button type="submit" class="btn primary block">Save</button>
    </form>`,
    events: {
      "click [data-addline]": () => addLine(sh.el),
      "click [data-unline]": (e, b) => removeLine(b),
      "submit #wk-job-edit": async (e, form) => {
        e.preventDefault();
        clearErrors(form);
        const v = readForm(form);
        const body = { title: v.title === j.title ? undefined : v.title, crew_notes: v.crew_notes, office_notes: v.office_notes };
        if (!closed) {
          body.kind = v.kind;
          const got = readLines(form);
          if (got.error) { showError(form, got.error); return; }
          if (!got.lines.length) { showError(form, { field: "lines", message: "Add the work (one line at least)." }); return; }
          body.lines = got.lines;
        }
        if (j.status === "unscheduled") body.target_month = v.target_month || "";
        const btn = form.querySelector("[type=submit]");
        busy(btn, true);
        try {
          await ctx.api(`/jobs/${encodeURIComponent(j.id)}`, { method: "PATCH", body, ifMatch: s.etag });
          sh.close(); toast("Saved"); ctx.refresh();
        } catch (err) {
          busy(btn, false);
          if (err.status === 412) { showError(form, { message: "Someone else just changed this job. Close this and look again." }); return; }
          showError(form, err);
        }
      },
    },
  });
}

async function post(ctx, path, body, ok) {
  try { await ctx.api(`/jobs/${encodeURIComponent(ctx.state.job.id)}/${path}`, { method: "POST", body }); toast(ok); }
  catch (err) { toast(err.message || "That didn't save.", { bad: true }); }
  ctx.refresh();
}

export default {
  title: (s) => (s && s.job ? s.job.number_label || "Job" : "Job"),
  load,
  action: (s, ctx) => (s.can && s.can.add_visit ? { label: "Book", run: () => scheduleSheet(ctx, { job_id: s.job.id, town: s.property && s.property.address && s.property.address.city, onDone: (d) => (d && d.visit ? ctx.go(`/visits/${d.visit.id}`) : ctx.refresh()) }) } : null),
  render(s) {
    const j = s.job;
    const office = officeView();
    const addr = s.property && s.property.address;
    const where = addr ? [addr.street1, addr.city].filter(Boolean).join(", ") : "";
    const c = s.can || {};
    const visits = s.visits || [];
    return html`<div class="stack wk">
      <div class="card wk-head">
        <div class="wk-head-top"><div class="wk-when-big"><b>${j.title}</b><span>${j.number_label}${j.kind !== "standard" ? ` · ${kindLabel(j.kind)}` : ""}</span></div>${jobPill(j.status)}</div>
        <dl class="kv">
          ${j.target_month && j.status === "unscheduled" ? html`<dt>Due by</dt><dd>${monthLabel(j.target_month)}</dd>` : ""}
          ${j.totals ? html`<dt>Total</dt><dd class="num">${money(j.totals.total_cents)}${j.billable === false ? html` <span class="pill">No charge</span>` : ""}</dd>` : ""}
          ${j.plan_id ? html`<dt>Plan</dt><dd>Visit ${j.plan_ordinal || ""} of a service plan</dd>` : ""}
        </dl>
        ${j.status === "cancelled" && j.cancel_reason ? html`<p class="warn-box">Cancelled: ${j.cancel_reason}</p>` : ""}
        ${j.completed_at && j.status === "completed" ? html`<p class="small muted">Done ${dateShort(j.completed_at)}</p>` : ""}
      </div>
      <ul class="list wk-linkrows">
        ${s.contact ? html`<li><a class="row" ${attrs({ href: "#/contacts/" + encodeURIComponent(s.contact.id) })}>${icon("contacts")}<span class="who"><span class="nm">${s.contact.display_name}</span><span class="sub">Customer</span></span><span class="chev" aria-hidden="true"></span></a></li>` : ""}
        ${where ? html`<li><a class="row" ${directionsLink(addr)}>${icon("map")}<span class="who"><span class="nm">${where}</span><span class="sub">Directions</span></span></a></li>` : ""}
      </ul>
      <div class="section-h">Visits</div>
      ${visits.length ? html`<ul class="list">${visits.map((v) => html`<li><a class="row" href="${"#/visits/" + encodeURIComponent(v.id)}">
        <span class="who"><span class="nm">${dateShort(v.date)}</span><span class="sub">${slotText(v)}</span></span>
        <span class="end">${office ? faces(s.users, v.assignee_ids) : ""}${visitPill(v.status)}<span class="chev" aria-hidden="true"></span></span></a></li>`)}</ul>`
        : emptyCard("No visit yet", c.add_visit ? "Book one with the button at the top." : "This job has no visit.")}
      ${(j.lines || []).length ? html`<div class="card"><h2>The work</h2><ul class="wk-lines">${j.lines.map((l) => html`<li><span>${l.title}${l.qty_milli && l.qty_milli !== 1000 ? html` <span class="muted">× ${l.qty_milli / 1000}</span>` : ""}</span>${l.total_cents != null ? html`<b class="num">${money(l.total_cents)}</b>` : ""}</li>`)}
        ${j.totals && (j.discounts || []).length ? html`<li><span>Discounts</span><b class="num">−${money(j.totals.discount_cents || 0)}</b></li>` : ""}
        ${j.totals ? html`<li class="tot"><span>Total</span><b class="num">${money(j.totals.total_cents)}</b></li>` : ""}</ul></div>` : ""}
      ${j.crew_notes ? html`<div class="card"><h2>Notes for the crew</h2><p class="wk-pre">${j.crew_notes}</p></div>` : ""}
      ${office && j.office_notes ? html`<div class="card"><h2>Office notes</h2><p class="wk-pre">${j.office_notes}</p></div>` : ""}
      ${c.write ? html`<div class="btn-row wk-acts">
        <button type="button" class="btn" data-edit>${icon("doc")}Edit</button>
        ${c.complete ? html`<button type="button" class="btn" data-complete>${icon("check")}Mark done</button>` : ""}
        ${c.reopen ? html`<button type="button" class="btn" data-reopen>Reopen</button>` : ""}
        ${c.cancel ? html`<button type="button" class="btn danger" data-cancel>Cancel job</button>` : ""}
      </div>` : ""}
      ${j.rotor ? html`<p class="foot-note">From Rotor (job ${j.number_label}). Changes here stay in the CRM.</p>` : ""}
      ${office && j.updated_at ? html`<p class="foot-note">Changed ${ago(j.updated_at)}</p>` : ""}
    </div>`;
  },
  events: {
    "click [data-edit]": (e, el, ctx) => editSheet(ctx),
    "click [data-complete]": async (e, el, ctx) => {
      if (!(await confirmSheet("Mark the job and its open visits done?", { title: "Mark done", yes: "Mark done" }))) return;
      post(ctx, "complete", {}, "Marked done");
    },
    "click [data-reopen]": async (e, el, ctx) => {
      if (!(await confirmSheet("Reopen this job? Book a visit on it after.", { title: "Reopen", yes: "Reopen" }))) return;
      post(ctx, "reopen", {}, "Reopened");
    },
    "click [data-cancel]": async (e, el, ctx) => {
      const r = await reasonSheet({ title: "Cancel this job", label: "Why? (its open visits are cancelled too)", yes: "Cancel the job" });
      if (r) post(ctx, "cancel", { reason: r.reason }, "Cancelled");
    },
  },
};
