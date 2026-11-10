// Settings → Discounts (design §9.2, §5.3 DiscountDef, D15): the catalog
// the builder offers. Each discount: an amount or a percent, the visits it
// applies to by default, sellable or kept for history (Rotor's), and its
// stack group (two of one group can't be on one option: the plan discounts).
// Different discounts stack; never below $0; percentages first. Owners edit
// (pricebook:edit); the office reads.

import { html, attrs, sheet, toast } from "../../core/ui.js";
import { readMoney } from "../../core/forms.js";
import { money } from "../../core/format.js";
import { ensureStyles, scopeWords, parseVisits } from "./kit.js";

async function load(params, ctx) {
  ensureStyles();
  const r = await ctx.api("/discounts", { cache: false });
  return { defs: r.data || [], can: ctx.can("pricebook:edit") };
}

const amount = (d) => (d.typed_amount ? "Typed in" : d.type === "percentage" ? `${d.value / 100}% off` : `${money(d.value)} off`);

export default {
  title: "Discounts",
  load,
  render(s) {
    const sell = s.defs.filter((d) => d.sellable !== false);
    const hist = s.defs.filter((d) => d.sellable === false);
    const row = (d) => html`<li><button type="button" class="row" ${attrs({ "data-def": d.id, disabled: !s.can })}><span class="who"><span class="nm">${d.name}</span><span class="sub">${amount(d)} · ${scopeWords(d.default_scope)}${d.stack_group ? " · one per option" : ""}</span></span><span class="end">${d.active === false ? html`<span class="pill">Off</span>` : ""}${s.can ? html`<span class="chev" aria-hidden="true"></span>` : ""}</span></button></li>`;
    return html`<div class="stack">
      <p class="small muted">Different discounts stack, percentages first, and a visit never goes below $0.</p>
      <ul class="list">${sell.map(row)}</ul>
      ${s.can ? html`<button type="button" class="btn block" data-new>Add a discount</button>` : ""}
      ${hist.length ? html`<div class="section-h">Kept for history</div><ul class="list">${hist.map(row)}</ul>` : ""}
    </div>`;
  },
  events: {
    "click [data-def]": (e, el, ctx) => defSheet(ctx, el.dataset.def),
    "click [data-new]": (e, el, ctx) => defSheet(ctx, null),
  },
};

async function defSheet(ctx, id) {
  let d = { name: "", type: "fixed", value: 0, default_scope: { type: "initial" }, sellable: true, active: true };
  let etag = null;
  if (id) { const r = await ctx.api(`/discounts/${encodeURIComponent(id)}`, { cache: false }); d = { ...r.data, type: r.data.kind }; etag = r.etag; }
  const sc = d.default_scope ? d.default_scope.type : "all";
  const sh = sheet({
    title: id ? d.name : "New discount",
    body: html`<form class="form" data-def-f>
      <label class="field"><span>Name (the customer sees it)</span><input ${attrs({ name: "name", value: d.name, maxlength: 80 })}></label>
      <div class="grid2"><label class="field"><span>Kind</span><select name="type">${[["fixed", "Amount"], ["percentage", "Percent"]].map(([v, l]) => html`<option ${attrs({ value: v, selected: d.type === v })}>${l}</option>`)}</select></label>
      <label class="field"><span>Off</span><input ${attrs({ name: "value", inputmode: "decimal", value: d.type === "percentage" ? String(d.value / 100) : (d.value / 100).toFixed(2) })}></label></div>
      <label class="field"><span>Which visits</span><select name="scope">${[["all", "Every visit"], ["initial", "First visit only"], ["after_initial", "After the first visit"], ["specific", "Some visits…"]].map(([v, l]) => html`<option ${attrs({ value: v, selected: sc === v })}>${l}</option>`)}</select></label>
      <label class="field"><span>Visits (for "some visits")</span><input ${attrs({ name: "visits", inputmode: "numeric", value: d.default_scope && d.default_scope.visits ? d.default_scope.visits.join(", ") : "" })}></label>
      <label class="check"><input ${attrs({ type: "checkbox", name: "sellable", checked: d.sellable !== false })}><span>Offered in the builder</span></label>
      <label class="check"><input ${attrs({ type: "checkbox", name: "active", checked: d.active !== false })}><span>On</span></label>
      <p class="err" data-form-err hidden></p><button type="submit" class="btn primary block">Save</button></form>`,
    events: {
      "submit [data-def-f]": async (e, form) => {
        e.preventDefault();
        const f = form.elements;
        const type = f.type.value;
        const value = type === "percentage" ? Math.round(Math.min(100, Math.max(0, Number(f.value.value) || 0)) * 100) : Math.max(0, readMoney(f.value.value) || 0);
        const body = { name: f.name.value.trim(), type, value, default_scope: f.scope.value === "specific" ? (parseVisits(f.visits.value) || { type: "all" }) : { type: f.scope.value }, sellable: f.sellable.checked, active: f.active.checked };
        try {
          if (id) await ctx.api(`/discounts/${encodeURIComponent(id)}`, { method: "PATCH", body, ifMatch: etag });
          else await ctx.api("/discounts", { method: "POST", body });
          sh.close(); toast("Saved"); ctx.refresh();
        } catch (er) { const err = form.querySelector("[data-form-err]"); err.textContent = er.message; err.hidden = false; }
      },
    },
  });
}
