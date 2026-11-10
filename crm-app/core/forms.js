// Barta CRM client: form fields and how errors show (design §2.3, §9.4).
// Inputs are 16 px (no iOS zoom) with the right inputmode/autocomplete;
// one primary action per form; a server InputError (400 with `field`)
// lands under its field. Quantities are integer thousandths and money is
// integer cents; moneyInput()/readMoney() convert at the edge.

import { html, attrs } from "./ui.js";

// field({ label, name, type, value, hint, ...input attributes })
export function field({ label, name, type = "text", value = "", hint = "", required = false, ...rest }) {
  const extra = { ...rest };
  if (type === "tel") Object.assign(extra, { inputmode: "tel", autocomplete: rest.autocomplete || "tel" });
  if (type === "email") Object.assign(extra, { inputmode: "email", autocomplete: rest.autocomplete || "email", autocapitalize: "none" });
  return html`<label class="field" data-field="${name}"><span>${label}</span><input ${attrs({ name, type, value: value ?? "", required, ...extra })}>${hint ? html`<small>${hint}</small>` : ""}<small class="why" hidden></small></label>`;
}

export function select({ label, name, value = "", options = [], hint = "" }) {
  return html`<label class="field" data-field="${name}"><span>${label}</span><select ${attrs({ name })}>${options.map((o) => html`<option ${attrs({ value: o.value, selected: String(o.value) === String(value) })}>${o.label}</option>`)}</select>${hint ? html`<small>${hint}</small>` : ""}<small class="why" hidden></small></label>`;
}

export function checkbox({ label, name, checked = false }) {
  return html`<label class="check" data-field="${name}"><input ${attrs({ type: "checkbox", name, checked })}><span>${label}</span></label>`;
}

// The form's values: checkboxes as booleans, everything else trimmed text.
export function readForm(form) {
  const out = {};
  for (const el of form.elements) {
    if (!el.name || el.disabled) continue;
    if (el.type === "checkbox") out[el.name] = el.checked;
    else if (el.type === "radio") { if (el.checked) out[el.name] = el.value; }
    else out[el.name] = typeof el.value === "string" && el.type !== "password" ? el.value.trim() : el.value;
  }
  return out;
}

export function clearErrors(form) {
  form.querySelectorAll(".field.bad").forEach((f) => f.classList.remove("bad"));
  form.querySelectorAll(".why").forEach((w) => { w.hidden = true; w.textContent = ""; });
  const box = form.querySelector("[data-form-err]");
  if (box) { box.hidden = true; box.textContent = ""; }
}

// Shows an error under its field (or at the top of the form).
export function showError(form, err) {
  const name = err && err.field;
  const msg = (err && err.message) || "That didn't work. Try again.";
  const f = name ? form.querySelector(`[data-field="${CSS && CSS.escape ? CSS.escape(name) : name}"]`) : null;
  if (f) {
    f.classList.add("bad");
    const why = f.querySelector(".why");
    if (why) { why.textContent = msg; why.hidden = false; }
    const input = f.querySelector("input,select,textarea");
    if (input) input.focus();
    return;
  }
  const box = form.querySelector("[data-form-err]");
  if (box) { box.textContent = msg; box.hidden = false; }
}

// "$1,234.50" / "1234.5" → 123450 (cents), or null.
export function readMoney(s) {
  const t = String(s || "").replace(/[$,\s]/g, "");
  if (!/^-?\d+(\.\d{0,2})?$/.test(t)) return null;
  const [d, c = ""] = t.replace("-", "").split(".");
  const cents = Number(d) * 100 + Number((c + "00").slice(0, 2));
  return t.startsWith("-") ? -cents : cents;
}

export const busy = (btn, on, label) => {
  if (!btn) return;
  if (on) { btn.dataset.label = btn.textContent; btn.textContent = label || "Saving…"; btn.disabled = true; }
  else { btn.textContent = btn.dataset.label || btn.textContent; btn.disabled = false; }
};
