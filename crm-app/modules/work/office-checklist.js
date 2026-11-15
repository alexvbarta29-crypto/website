// One checklist (Settings → Checklists): its name, whether it's on, which
// jobs get it (kinds of job, or services), and its items in order (Rotor's
// kinds: a checkbox, pick one, a number, photos with the fewest and most, a
// group of checkboxes, notes; required ones must be done before a visit is
// finished; a checkbox may also text On my way or start the visit). Saving changes only new visits; booked visits keep the copy
// they got.

import { html, icon, attrs, toast, render } from "../../core/ui.js";
import { busy } from "../../core/forms.js";
import { ensureStyles, JOB_KINDS, SERVICE_TYPES } from "./office-kit.js";
import { keyOf } from "./office-checklists.js";
import { KINDS, HOOKS, readItem } from "./checklist-kit.js";

// what each kind asks for besides its label (Rotor's kinds, Nov 2026)
const NEEDS = { select: ["options"], multi: ["options", "min"], photo: ["min", "max"], count: ["placeholder"], text: ["placeholder"], check: ["hook"] };
const shown = (kind, f) => (NEEDS[kind] || []).includes(f);

function itemRow(it, i) {
  const k = it.kind || "check";
  const extra = (f, body) => html`<div class="wk-item-x" ${attrs({ "data-x": f, hidden: !shown(k, f) })}>${body}</div>`;
  return html`<li class="wk-item" ${attrs({ "data-item": String(i), "data-key": it.key || "" })}>
    <label class="field"><span>Item ${i + 1}</span><input name="label" maxlength="120" ${attrs({ value: it.label || "" })}></label>
    <div class="wk-item-row">
      <label class="field"><span class="sr">Kind</span><select name="kind" data-ikind>${KINDS.map(([v, l]) => html`<option ${attrs({ value: v, selected: k === v })}>${l}</option>`)}</select></label>
      <label class="check"><input type="checkbox" name="required" ${attrs({ checked: it.required === true })}><span>Required</span></label>
      <button type="button" class="icon-btn wk-x" data-unitem aria-label="Remove this item">${icon("plus")}</button>
    </div>
    ${extra("options", html`<label class="field"><span>Choices, one a line</span><textarea name="options" rows="3" maxlength="1700">${(it.options || []).join("\n")}</textarea></label>`)}
    <div class="wk-item-nums">
      ${extra("min", html`<label class="field"><span data-minl>${k === "photo" ? "Fewest photos" : "Boxes to tick"}</span><input name="min" type="number" inputmode="numeric" min="1" max="20" ${attrs({ value: it.min ?? "" , placeholder: "1" })}></label>`)}
      ${extra("max", html`<label class="field"><span>Most photos</span><input name="max" type="number" inputmode="numeric" min="1" max="20" ${attrs({ value: it.max ?? "", placeholder: "10" })}></label>`)}
    </div>
    ${extra("placeholder", html`<label class="field"><span>Hint in the box</span><input name="placeholder" maxlength="80" ${attrs({ value: it.placeholder || "" })}></label>`)}
    ${extra("hook", html`<label class="field"><span>Ticking it also</span><select name="hook">${HOOKS.map(([v, l]) => html`<option ${attrs({ value: v, selected: (it.hook || "") === v })}>${l}</option>`)}</select></label>`)}
  </li>`;
}

// The form → the items (keys kept, new ones made from the label, never twice), or { error }.
function readItems(form) {
  const used = new Set();
  const out = [];
  for (const li of form.querySelectorAll("[data-item]")) {
    const val = (n) => { const x = li.querySelector(`[name=${n}]`); return x ? x.value : ""; };
    const label = val("label").trim();
    if (!label) continue;
    const key = li.dataset.key || keyOf(label).slice(0, 36).replace(/^list_/, "item_");
    let k = key, n = 2;
    while (used.has(k)) k = `${key.slice(0, 36)}_${n++}`;
    used.add(k);
    const kind = val("kind");
    const it = readItem({ key: k, label, kind, required: li.querySelector("[name=required]").checked, options: val("options"), min: shown(kind, "min") ? val("min") : "", max: shown(kind, "max") ? val("max") : "", placeholder: shown(kind, "placeholder") ? val("placeholder") : "", hook: shown(kind, "hook") ? val("hook") : "" });
    if (it && it.error) return { error: it.error };
    if (it) out.push(it);
  }
  return { items: out };
}

export default {
  title: (s) => (s && s.c ? s.c.name : "Checklist"),
  async load(params, ctx) {
    ensureStyles();
    const r = await ctx.api(`/checklists/${encodeURIComponent(params.id)}`, { cache: false });
    return { c: r.data.checklist, etag: r.etag, kinds: [...(r.data.checklist.job_kinds || [])], svc: [...(r.data.checklist.service_types || [])] };
  },
  render(s) {
    const c = s.c;
    const items = c.items || [];
    return html`<form class="form stack wk" id="wk-cl" novalidate>
      <div class="err" data-form-err hidden></div>
      <label class="field" data-field="name"><span>Name</span><input name="name" maxlength="80" ${attrs({ value: c.name })}><small class="why" hidden></small></label>
      <label class="check"><input type="checkbox" name="active" ${attrs({ checked: c.active !== false })}><span>On (new visits get it)</span></label>
      <div class="field"><span>Jobs of these kinds get it</span><div class="wk-people">${JOB_KINDS.map((k) => html`<button type="button" class="chip" ${attrs({ "data-kind": k.value, "aria-pressed": String(s.kinds.includes(k.value)) })}>${k.label}</button>`)}</div></div>
      <div class="field"><span>Or jobs with these services</span><div class="wk-people">${SERVICE_TYPES.map((t) => html`<button type="button" class="chip" ${attrs({ "data-svc": t, "aria-pressed": String(s.svc.includes(t)) })}>${t}</button>`)}</div></div>
      <div class="field" data-field="items"><span>Items</span><ul class="wk-items" data-items>${(items.length ? items : [{}]).map(itemRow)}</ul><small class="why" hidden></small>
        <button type="button" class="btn" data-additem>${icon("plus")}Add an item</button></div>
      <button type="submit" class="btn primary block">Save</button>
      <p class="foot-note">Key ${c.key}. Visits already booked keep the list they got.</p>
    </form>`;
  },
  events: {
    "click [data-kind]": (e, b, ctx) => { const s = ctx.state; const k = b.dataset.kind; s.kinds = s.kinds.includes(k) ? s.kinds.filter((x) => x !== k) : [...s.kinds, k]; b.setAttribute("aria-pressed", String(s.kinds.includes(k))); },
    "click [data-svc]": (e, b, ctx) => { const s = ctx.state; const k = b.dataset.svc; s.svc = s.svc.includes(k) ? s.svc.filter((x) => x !== k) : [...s.svc, k]; b.setAttribute("aria-pressed", String(s.svc.includes(k))); },
    "click [data-additem]": (e, b) => {
      const ul = b.closest("form").querySelector("[data-items]");
      const tmp = document.createElement("ul");
      render(tmp, itemRow({}, ul.children.length));
      ul.appendChild(tmp.firstElementChild);
      const i = ul.lastElementChild.querySelector("[name=label]");
      if (i) i.focus();
    },
    // the kind picks which extra fields show (choices, how many, a hint, what a tick also does)
    "change [data-ikind]": (e, sel) => {
      const li = sel.closest("[data-item]");
      for (const x of li.querySelectorAll("[data-x]")) x.hidden = !shown(sel.value, x.dataset.x);
      const ml = li.querySelector("[data-minl]");
      if (ml) ml.textContent = sel.value === "photo" ? "Fewest photos" : "Boxes to tick";
    },
    "click [data-unitem]": (e, b) => { const li = b.closest("[data-item]"); if (li && li.parentElement.children.length > 1) li.remove(); else if (li) li.querySelector("[name=label]").value = ""; },
    "submit #wk-cl": async (e, form, ctx) => {
      e.preventDefault();
      const s = ctx.state;
      const err = form.querySelector("[data-form-err]");
      err.hidden = true;
      const name = form.querySelector("[name=name]").value.trim();
      if (!name) { err.textContent = "Name it."; err.hidden = false; return; }
      const got = readItems(form);
      if (got.error) { err.textContent = got.error; err.hidden = false; return; }
      const body = { name, active: form.querySelector("[name=active]").checked, job_kinds: s.kinds, service_types: s.svc, items: got.items };
      const btn = form.querySelector("[type=submit]");
      busy(btn, true);
      try {
        const r = await ctx.api(`/checklists/${encodeURIComponent(s.c.id)}`, { method: "PATCH", body, ifMatch: s.etag });
        s.c = r.data.checklist; s.etag = r.etag; toast("Saved");
        ctx.rerender();
      } catch (x) {
        busy(btn, false);
        err.textContent = x.status === 412 ? "Someone else just changed this list. Go back and open it again." : x.message || "That didn't save.";
        err.hidden = false;
      }
    },
  },
};
