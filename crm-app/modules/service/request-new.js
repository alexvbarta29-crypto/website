// New request (the Rotor guide's SR4): who (a customer or lead, picked by
// name, phone or address; or the one this was opened from), what they need
// (service chips), when, a note, where it came from (phone, office,
// website). Saved once per tap (a client id), then the request opens.

import { html, attrs, toast } from "../../core/ui.js";
import { pickContact } from "../../core/pickers.js";
import { readForm, showError, clearErrors, busy } from "../../core/forms.js";
import { ensureStyles, SERVICES, TIMING } from "./kit.js";

const cid = () => (globalThis.crypto && crypto.randomUUID ? crypto.randomUUID() : `rq-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`);

async function load(params, ctx) {
  ensureStyles();
  let contact = null;
  if (params.contact) {
    const r = await ctx.api(`/contacts/${encodeURIComponent(params.contact)}`).catch(() => null);
    const c = r && r.data && (r.data.contact || r.data);
    if (c && c.id) contact = { id: c.id, name: c.display_name || [c.first_name, c.last_name].filter(Boolean).join(" ") || "Customer" };
  }
  return { contact, client_id: cid(), picked: [] };
}

export default {
  title: "New request",
  load,
  render(s) {
    return html`<div class="rs-page sv sv-rnew"><form class="form" data-rq-f novalidate>
      <div class="err" data-form-err hidden></div>
      <div class="field" data-field="contact_id"><span>Who</span>
        <button type="button" class="btn block sv-who" data-pick-contact>${s.contact ? s.contact.name : "Pick a customer or lead"}</button>
        <small class="why" hidden></small></div>
      <fieldset class="field sv-svc" data-field="services"><legend>What they need</legend>
        <div class="chips">${SERVICES.map((x) => html`<button type="button" class="chip" ${attrs({ "data-svc": x, "aria-pressed": String(s.picked.includes(x)) })}>${x}</button>`)}</div>
        <small class="why" hidden></small></fieldset>
      <label class="field" data-field="timing"><span>When</span><select name="timing">${TIMING.map((x) => html`<option ${attrs({ value: x })}>${x}</option>`)}</select></label>
      <label class="field" data-field="notes"><span>Note</span><textarea name="notes" rows="3" maxlength="4000" placeholder="Two story, gate on the left..."></textarea><small class="why" hidden></small></label>
      <label class="field" data-field="source"><span>How it came in</span><select name="source"><option value="phone">Phone</option><option value="office">Office</option><option value="website">Website</option></select></label>
      <button type="submit" class="btn primary block">Save the request</button>
    </form></div>`;
  },
  events: {
    "click [data-pick-contact]": async (e, el, ctx) => {
      const c = await pickContact(ctx.api, { title: "Who is it for?" });
      if (c) { ctx.state.contact = c; el.textContent = c.name; }
    },
    "click [data-svc]": (e, el, ctx) => {
      const s = ctx.state;
      const x = el.dataset.svc;
      s.picked = s.picked.includes(x) ? s.picked.filter((y) => y !== x) : [...s.picked, x];
      el.setAttribute("aria-pressed", String(s.picked.includes(x)));
    },
    "submit [data-rq-f]": async (e, form, ctx) => {
      e.preventDefault();
      clearErrors(form);
      const s = ctx.state;
      if (!s.contact) { showError(form, { field: "contact_id", message: "Pick who it's for." }); return; }
      const v = readForm(form);
      const btn = form.querySelector("[type=submit]");
      busy(btn, true);
      try {
        const r = await ctx.api("/requests", { method: "POST", body: { client_id: s.client_id, contact_id: s.contact.id, services: s.picked, timing: v.timing, notes: v.notes, source: v.source } });
        toast("Request saved");
        ctx.go(`/requests/${encodeURIComponent(r.data.request.id)}`, { replace: true });
      } catch (err) { busy(btn, false); showError(form, err); }
    },
  },
};
