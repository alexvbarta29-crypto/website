// Quick lead (design §9.3, §5.1): a neighbour asks for a quote at the door.
// Name, phone, address, what they want, a note: the lead goes to the
// office. It never says whether the number is already on file (a tech must
// not learn whose number it is); the office sorts that out in Merge review.
// Owners and the office get the full New lead form instead.

import { html, toast, attrs } from "../../core/ui.js";
import { field, readForm, clearErrors, showError, busy } from "../../core/forms.js";
import { uuid } from "../../core/api.js";
import { ensureStyles, SERVICES } from "./kit.js";

export default {
  title: "Quick lead",
  load(params, ctx) {
    ensureStyles();
    if (ctx.can("contacts:write")) { ctx.go("/contacts/new", { replace: true }); return { redirect: true }; }
    return { clientId: ctx.keep.clientId || (ctx.keep.clientId = uuid()) };
  },
  render(s) {
    if (s.redirect) return html``;
    return html`<form class="form stack" id="ql-form" novalidate>
      <div class="err" data-form-err hidden></div>
      <section class="card form">
        ${field({ label: "Name", name: "name", autocomplete: "name", autocapitalize: "words" })}
        ${field({ label: "Phone", name: "phone", type: "tel", required: true })}
        ${field({ label: "Address", name: "street1", autocomplete: "address-line1", hint: "Street and number; the town below." })}
        <div class="grid2">${field({ label: "Town", name: "city", autocomplete: "address-level2" })}${field({ label: "ZIP", name: "zip", inputmode: "numeric", autocomplete: "postal-code", maxlength: 10 })}</div>
      </section>
      <section class="card form"><span class="small muted">What they'd like</span>
        <div class="svc-grid">${SERVICES.map((sv, i) => html`<label class="check"><input ${attrs({ type: "checkbox", name: `svc_${i}` })}><span>${sv}</span></label>`)}</div>
        <label class="field" data-field="notes"><span>Note for the office</span><textarea name="notes" rows="3" maxlength="2000"></textarea></label>
      </section>
      <button type="submit" class="btn primary block">Send to the office</button>
    </form>`;
  },
  events: {
    "submit #ql-form": async (e, form, ctx) => {
      e.preventDefault();
      clearErrors(form);
      const v = readForm(form);
      const services = SERVICES.filter((_, i) => v[`svc_${i}`]);
      const btn = form.querySelector("button[type=submit]");
      busy(btn, true, "Sending…");
      try {
        await ctx.api("/contacts", {
          method: "POST",
          body: { name: v.name, phone: v.phone, address: v.street1 || v.city || v.zip ? { street1: v.street1, city: v.city, state: "MN", zip: v.zip } : undefined, services, notes: v.notes, client_id: ctx.state.clientId },
        });
        ctx.keep.clientId = null;
        toast("Sent to the office. Thanks!");
        ctx.go("/today", { replace: true });
      } catch (err) {
        busy(btn, false);
        showError(form, err.field && /^phones/.test(err.field) ? { ...err, field: "phone" } : err);
      }
    },
  },
};
