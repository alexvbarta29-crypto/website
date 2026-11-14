// Settings → Payments → Client portal (the Rotor guide's ST1, ST6, ST27):
// the customers' portal address (fixed: the website's /p/ links), how long
// each kind of link stays open, how many opens a day lock a link, and the
// terms every quote, invoice and agreement page shows. settings:owner.
// (Which pages customers see, tips and bank or Klarna payments wait for the
// payments switch: guide-gaps S32.)

import { html, attrs, toast, formRow, formRows, sectionLabel } from "../../core/ui.js";
import { loadDoc, saveDoc } from "./kit.js";

const LIFE = [
  ["hub_days", "Their portal (days)", 365], ["quote_after_expiry_days", "A quote after it expires (days)", 365], ["quote_after_conversion_days", "A quote after it becomes a job (days)", 365],
  ["invoice_after_paid_days", "An invoice after it is paid (days)", 730], ["agreement_days", "An agreement (days)", 365], ["card_days", "Saving a card (days)", 60], ["present_minutes", "Showing a quote on your phone (minutes)", 240],
];

export default {
  title: "Client portal",
  async load(params, ctx) { return { doc: await loadDoc(ctx, "portal") }; },
  render(s) {
    const d = s.doc.data;
    const l = d.lifetimes || {};
    return html`<form class="stack" data-portal-f novalidate>
      ${sectionLabel("Address")}
      ${formRows([formRow("Customers open", html`<span class="mono">www.bartawindowwashing.com/p/...</span>`, { hint: "Each text or email carries its own private link" })])}
      ${sectionLabel("How long links stay open")}
      ${formRows(LIFE.map(([k, label, max]) => formRow(label, html`<input type="text" inputmode="numeric" maxlength="4" ${attrs({ name: k, value: String(l[k] ?? ""), "aria-label": label, "data-max": String(max) })}>`)))}
      ${formRows([formRow("Opens a day before a link locks", html`<input type="text" inputmode="numeric" maxlength="5" name="max_opens_per_day" ${attrs({ value: String(d.max_opens_per_day ?? 200) })}>`, { hint: "The owners are told when one locks" })])}
      ${sectionLabel("Terms on quotes, invoices and agreements")}
      <label class="field"><span class="sr">Terms</span><textarea name="terms" rows="8" maxlength="20000" placeholder="Our satisfaction guarantee: if anything isn't right, we come back and re-clean it free.">${d.terms || ""}</textarea></label>
      <button type="submit" class="btn primary block">Save</button>
    </form>`;
  },
  events: {
    "submit [data-portal-f]": async (e, form, ctx) => {
      e.preventDefault();
      const s = ctx.state;
      const n = (name) => { const v = form.querySelector(`[name=${name}]`).value.trim(); return v === "" ? undefined : Number(v); };
      const lifetimes = Object.fromEntries(LIFE.map(([k]) => [k, n(k)]).filter(([, v]) => v !== undefined));
      try {
        await saveDoc(ctx, s.doc, { ...s.doc.data, lifetimes: { ...(s.doc.data.lifetimes || {}), ...lifetimes }, max_opens_per_day: n("max_opens_per_day") ?? 200, terms: form.querySelector("[name=terms]").value });
        toast("Saved");
        ctx.rerender();
      } catch (err) { if (err.status !== 412) toast(err.message, { bad: true }); }
    },
  },
};
