// New job (design §9.2): the customer (picked, or the contact it was
// opened from), which of their places, the kind, the work, notes, and
// optionally the first visit (day, time, window, who). One tap saves the
// job and books the visit; a retry never makes a second job (client id).

import { html, icon, attrs, toast, render } from "../../core/ui.js";
import { readForm, showError, clearErrors, busy } from "../../core/forms.js";
import { pickContact } from "../../core/pickers.js";
import { uuid } from "../../core/api.js";
import {
  ensureStyles, JOB_KINDS, WINDOWS, windowFrom, linesEditor, addLine, removeLine, readLines, loadUsers, team, today, addDays, toMin, fromMin,
} from "./office-kit.js";

async function contactOf(ctx, id) {
  const r = await ctx.api(`/contacts/${encodeURIComponent(id)}`);
  const d = r.data || {};
  return { id: d.contact.id, name: d.contact.display_name, properties: (d.properties || []).filter((p) => !p.deleted_at), primary: d.contact.primary_property_id };
}
const who = (c) => html`<button type="button" class="row wk-pick" data-pick>${icon("contacts")}<span class="who"><span class="nm">${c ? c.name : "Pick the customer"}</span>${c ? "" : html`<span class="sub">Name, phone, email or address</span>`}</span><span class="chev" aria-hidden="true"></span></button>`;
const places = (c) => (c && c.properties.length > 1 ? html`<label class="field" data-field="property_id"><span>Where</span><select name="property_id">${c.properties.map((p) => html`<option ${attrs({ value: p.id, selected: p.id === c.primary })}>${addrLine(p)}</option>`)}</select><small class="why" hidden></small></label>` : html``);
const addrLine = (p) => (p && p.address ? [p.address.street1, p.address.city].filter(Boolean).join(", ") : (p && p.label) || "Place");

export default {
  title: "New job",
  async load(params, ctx) {
    ensureStyles();
    const users = team(await loadUsers(ctx).catch(() => []));
    const contact = params.contact ? await contactOf(ctx, params.contact).catch(() => null) : null;
    return { contact, users, people: [], book: false, client_id: uuid() };
  },
  render(s) {
    return html`<form class="form stack wk" id="wk-new-job" novalidate>
      <div class="err" data-form-err hidden></div>
      <div class="field" data-field="contact_id"><span>Customer</span><div data-who>${who(s.contact)}</div><small class="why" hidden></small></div>
      <div data-props>${places(s.contact)}</div>
      <label class="field" data-field="kind"><span>Kind</span><select name="kind">${JOB_KINDS.map((k) => html`<option ${attrs({ value: k.value })}>${k.label}</option>`)}</select><small class="why" hidden></small></label>
      ${linesEditor([])}
      <label class="field" data-field="crew_notes"><span>Notes for the crew</span><textarea name="crew_notes" rows="2" maxlength="2000" placeholder="Dog in the back yard, use the side gate"></textarea><small class="why" hidden></small></label>
      <label class="field" data-field="office_notes"><span>Office notes</span><textarea name="office_notes" rows="2" maxlength="4000"></textarea><small class="why" hidden></small></label>
      <label class="check"><input type="checkbox" name="book" ${attrs({ checked: s.book })}><span>Book the first visit now</span></label>
      <div class="card wk-first" data-book-on ${attrs({ hidden: !s.book })}>
        <label class="field" data-field="date"><span>Day</span><input type="date" name="date" ${attrs({ value: addDays(today(), 1) })}><small class="why" hidden></small></label>
        <div class="grid2">
          <label class="field" data-field="start"><span>Start</span><input type="time" name="start" step="900" value="08:00"><small class="why" hidden></small></label>
          <label class="field" data-field="end"><span>End</span><input type="time" name="end" step="900" value="10:00"><small class="why" hidden></small></label>
        </div>
        <label class="field" data-field="window"><span>What the customer is told</span><select name="window">${WINDOWS.map((w) => html`<option ${attrs({ value: w.value })}>${w.label}</option>`)}</select></label>
        <div class="field" data-field="assignee_ids"><span>Who goes</span><div class="wk-people">${s.users.map((u) => html`<button type="button" class="chip wk-person" ${attrs({ "data-person": u.id, "aria-pressed": String(s.people.includes(u.id)) })}><span class="wk-dot" ${attrs({ style: `background:${u.color || "#4a4a52"}` })}></span>${u.name}</button>`)}</div><small class="why" hidden></small></div>
      </div>
      <label class="field" data-field="target_month" data-book-off ${attrs({ hidden: s.book })}><span>Due by (month, for the To book list)</span><input type="month" name="target_month" ${attrs({ value: today().slice(0, 7) })}><small class="why" hidden></small></label>
      <button type="submit" class="btn primary block">${s.book ? "Save and book" : "Save the job"}</button>
    </form>`;
  },
  events: {
    "click [data-pick]": async (e, el, ctx) => {
      const got = await pickContact(ctx.api, { title: "Who is it for?" });
      if (!got) return;
      const c = await contactOf(ctx, got.id).catch(() => ({ id: got.id, name: got.name, properties: [] }));
      ctx.state.contact = c;
      // only the customer's part changes: what's typed below stays
      const form = el.closest("form");
      render(form.querySelector("[data-who]"), who(c));
      render(form.querySelector("[data-props]"), places(c));
    },
    "change [name=book]": (e, el, ctx) => {
      const form = el.form;
      ctx.state.book = el.checked;
      form.querySelector("[data-book-on]").hidden = !el.checked;
      form.querySelector("[data-book-off]").hidden = el.checked;
      form.querySelector("[type=submit]").textContent = el.checked ? "Save and book" : "Save the job";
    },
    "click [data-person]": (e, b, ctx) => {
      const s = ctx.state; const id = b.dataset.person;
      s.people = s.people.includes(id) ? s.people.filter((x) => x !== id) : [...s.people, id];
      b.setAttribute("aria-pressed", String(s.people.includes(id)));
    },
    "change [name=start]": (e, el) => {
      const end = el.form.querySelector("[name=end]");
      if (end && toMin(end.value) <= toMin(el.value)) end.value = fromMin(toMin(el.value) + 120);
    },
    "click [data-addline]": (e, el) => addLine(el.closest("form")),
    "click [data-unline]": (e, el) => removeLine(el),
    "submit #wk-new-job": async (e, form, ctx) => {
      e.preventDefault();
      clearErrors(form);
      const s = ctx.state;
      if (!s.contact) { showError(form, { field: "contact_id", message: "Pick the customer first." }); return; }
      const v = readForm(form);
      const got = readLines(form);
      if (got.error) { showError(form, got.error); return; }
      if (!got.lines.length) { showError(form, { field: "lines", message: "Add the work (one line at least)." }); return; }
      const body = {
        contact_id: s.contact.id, ...(v.property_id ? { property_id: v.property_id } : {}), kind: v.kind, lines: got.lines,
        crew_notes: v.crew_notes, office_notes: v.office_notes, client_id: s.client_id,
        ...(s.book ? { visit: { date: v.date, start: v.start, end: v.end, window: windowFrom(v.window), assignee_ids: s.people } } : { target_month: v.target_month || undefined }),
      };
      const btn = form.querySelector("[type=submit]");
      busy(btn, true);
      try {
        const r = await ctx.api("/jobs", { method: "POST", body });
        const warns = (r.meta && r.meta.warnings) || [];
        toast(warns.length ? `Saved. Heads up: ${warns[0].message}` : "Saved", { ms: warns.length ? 5000 : 2600 });
        ctx.go(r.data.visit ? `/visits/${r.data.visit.id}` : `/jobs/${r.data.job.id}`, { replace: true });
      } catch (err) {
        busy(btn, false);
        const f = err && err.field ? String(err.field).replace(/^visit\./, "").replace(/^lines\.\d+.*$/, "lines") : null;
        showError(form, { ...err, field: f, message: err.message });
      }
    },
  },
};
