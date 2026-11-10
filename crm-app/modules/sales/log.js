// Log a call (design §5.2 "Calls", the create button's "Log a call"): a
// call made outside the list, or one that came in (a lead calling back
// never counts as our touch: it pauses their follow-up and makes a task).

import { html, attrs, toast, icon } from "../../core/ui.js";
import { checkbox, busy } from "../../core/forms.js";
import { pickContact } from "../../core/pickers.js";
import { ensureStyles, OUTCOMES, afterCall, telHref } from "./kit.js";

async function load(params, ctx) {
  ensureStyles();
  let who = ctx.keep.who || null;
  if (params.contact) {
    const r = await ctx.api(`/sales/contacts/${encodeURIComponent(params.contact)}`, { cache: false });
    const open = (r.data.enrollments || []).find((e) => e.status === "active") || null;
    who = { contact_id: r.data.contact.id, name: r.data.contact.name, phone: r.data.contact.phone, enrollment_id: open ? open.id : null, label: open && open.cur ? open.cur.label : "" };
  }
  return { who, direction: ctx.keep.direction || "out", outcome: ctx.keep.outcome || "no_answer", fixed: !!params.contact };
}

export default {
  title: "Log a call",
  load,
  render(s) {
    const w = s.who;
    return html`<form class="form" id="log-f" novalidate>
      <section class="card">
        ${w ? html`<div class="row" style="padding:0;min-height:0"><span class="who"><span class="nm">${w.name}</span><span class="sub">${w.label ? `Follow-up step: ${w.label}` : "No follow-up running"}</span></span>${w.phone ? html`<a class="btn" ${attrs({ href: telHref(w.phone) })}>${icon("phone")}Call</a>` : ""}</div>` : html`<p class="muted">Who was it?</p>`}
        ${s.fixed ? "" : html`<div class="btn-row"><button type="button" class="btn" data-pick>${w ? "Someone else" : "Pick a contact"}</button></div>`}
      </section>
      <div class="chips" role="group" aria-label="Which way">
        <button type="button" class="chip" ${attrs({ "data-dir": "out", "aria-pressed": String(s.direction === "out") })}>I called them</button>
        <button type="button" class="chip" ${attrs({ "data-dir": "in", "aria-pressed": String(s.direction === "in") })}>They called us</button>
      </div>
      ${s.direction === "out" ? html`<div class="sl-outcomes">${OUTCOMES.map(([k, label]) => html`<button type="button" class="${"btn" + (s.outcome === k ? " dark" : "")}" ${attrs({ "data-outcome": k, "aria-pressed": String(s.outcome === k) })}>${label}</button>`)}</div>
        ${checkbox({ label: "I called twice (one touch)", name: "double_dial" })}` : html`<p class="small muted">A call in pauses their follow-up and puts a "Called in" task on the list.</p>`}
      <label class="field"><span>Note (optional)</span><textarea name="note" rows="3" maxlength="1000"></textarea></label>
      <button type="submit" class="btn primary block" ${attrs({ disabled: !w })}>Save</button>
    </form>`;
  },
  events: {
    "click [data-pick]": async (e, el, ctx) => {
      const c = await pickContact(ctx.api, { title: "Who was it?" });
      if (!c) return;
      try {
        const r = await ctx.api(`/sales/contacts/${encodeURIComponent(c.id)}`, { cache: false });
        const open = (r.data.enrollments || []).find((x) => x.status === "active") || null;
        ctx.state.who = ctx.keep.who = { contact_id: r.data.contact.id, name: r.data.contact.name, phone: r.data.contact.phone, enrollment_id: open ? open.id : null, label: open && open.cur ? open.cur.label : "" };
        ctx.rerender();
      } catch (err) { toast(err.message, { bad: true }); }
    },
    "click [data-dir]": (e, el, ctx) => { ctx.state.direction = ctx.keep.direction = el.dataset.dir; ctx.rerender(); },
    "click [data-outcome]": (e, el, ctx) => { ctx.state.outcome = ctx.keep.outcome = el.dataset.outcome; ctx.rerender(); },
    "submit #log-f": async (e, form, ctx) => {
      e.preventDefault();
      const s = ctx.state;
      if (!s.who) return;
      const btn = form.querySelector("[type=submit]");
      busy(btn, true);
      try {
        const r = await ctx.api("/calls", { method: "POST", body: {
          contact_id: s.who.contact_id, direction: s.direction, ...(s.direction === "out" ? { outcome: s.outcome, double_dial: !!(form.querySelector("[name=double_dial]") || {}).checked } : {}),
          ...(s.direction === "out" && s.who.enrollment_id ? { enrollment_id: s.who.enrollment_id } : {}), note: form.querySelector("[name=note]").value,
          client_id: globalThis.crypto && crypto.randomUUID ? crypto.randomUUID() : undefined,
        } });
        busy(btn, false);
        delete ctx.keep.who;
        afterCall(ctx, s.who, r.data, { done: () => ctx.back() });
      } catch (err) { busy(btn, false); toast(err.message, { bad: true }); }
    },
  },
};
