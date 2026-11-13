// A new sign or flyer code (Signs & flyers → New), and the form the Edit
// sheet reuses: a name you'll know it by, the kind, the town or area and
// when it went up (both optional), and where it sends people: the quote
// page (the default) or another page of the website. The short address is
// made by the server and never changes, so a printed code keeps working.

import { html, attrs, toast } from "../../core/ui.js";
import { field, select, readForm, clearErrors, showError, busy } from "../../core/forms.js";
import { dateField } from "../../core/pickers.js";
import { uuid } from "../../core/api.js";
import { ensureStyles } from "./kit.js";
import { KINDS, PAGES } from "./signs-kit.js";

const DESTS = [{ value: "quote", label: "The quote page" }, { value: "page", label: "Another page of the website" }];

export function formBody(c = {}, { isNew = true, note = "" } = {}) {
  const page = c.dest && c.dest.kind === "page";
  return html`<form class="form" data-sign-form novalidate>
    <div class="err" data-form-err hidden></div>
    ${field({ label: "Name", name: "name", value: c.name || "", required: true, maxlength: 80, placeholder: "Yard sign, Maple Grove", hint: "Only the office sees it (and it prints under the code)." })}
    ${select({ label: "What it goes on", name: "kind", value: c.kind || "yard_sign", options: KINDS })}
    <div class="grid2">${field({ label: "Town or area (optional)", name: "area", value: c.area || "", maxlength: 60, placeholder: "Maple Grove" })}${dateField({ label: "Put up on (optional)", name: "placed_on", value: c.placed_on || "" })}</div>
    ${select({ label: "Where it sends people", name: "dest_kind", value: page ? "page" : "quote", options: DESTS, hint: "The quote page fills in the code as the lead's source." })}
    <div data-path ${attrs({ hidden: !page })}>
      <label class="field" data-field="dest.path"><span>Page</span><input ${attrs({ name: "dest_path", value: page ? c.dest.path : "/services/gutter-cleaning.html", list: "sg-pages", inputmode: "url", autocapitalize: "none", autocomplete: "off", maxlength: 120 })}><small>A page of bartawindowwashing.com, like /services/gutter-cleaning.html.</small><small class="why" hidden></small></label>
      <datalist id="sg-pages">${PAGES.map(([p, l]) => html`<option ${attrs({ value: p })}>${l}</option>`)}</datalist>
    </div>
    <label class="field" data-field="note"><span>Note (optional)</span><input ${attrs({ name: "note", value: note || "", maxlength: 300, placeholder: "On the corner of Maple and 5th" })}><small class="why" hidden></small></label>
    <button type="submit" class="btn primary block">${isNew ? "Make the code" : "Save"}</button>
  </form>`;
}

// The form's values → the API's body.
export function readCode(v) {
  return {
    name: v.name || "", kind: v.kind || "yard_sign", area: v.area || "", placed_on: v.placed_on || "", note: v.note || "",
    dest: v.dest_kind === "page" ? { kind: "page", path: (v.dest_path || "").trim() } : { kind: "quote" },
  };
}

export default {
  title: "New code",
  load: () => { ensureStyles(); return { clientId: uuid() }; },
  render: () => formBody({}, { isNew: true }),
  events: {
    "change [name=dest_kind]": (e, el) => { el.closest("form").querySelector("[data-path]").hidden = el.value !== "page"; },
    "submit [data-sign-form]": async (e, form, ctx) => {
      e.preventDefault(); clearErrors(form);
      const body = readCode(readForm(form));
      if (!body.name) { showError(form, { field: "name", message: "Give it a name you'll know it by." }); return; }
      const btn = form.querySelector("[type=submit]"); busy(btn, true);
      try {
        const r = await ctx.api("/qr-codes", { method: "POST", body: { ...body, client_id: ctx.state.clientId } });
        toast("Code made");
        ctx.go(`/signs/${encodeURIComponent(r.data.code.id)}`, { replace: true });
      } catch (err) { busy(btn, false); showError(form, err); }
    },
  },
};
