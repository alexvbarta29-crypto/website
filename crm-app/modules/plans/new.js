// New plan (the office, design §9.2): for a customer who signs up without a
// quote. Pick the customer, the plan (the catalog fills the visit and the
// plan discount: an owner's settings), the price of each visit, the start,
// autopay. The plan waits for its agreement; the jobs for its first term are
// made at once (once Scheduling is there). A retry never makes two (client id).

import { html, attrs, icon, toast } from "../../core/ui.js";
import { readForm, showError, clearErrors, busy, readMoney } from "../../core/forms.js";
import { dateField, pickContact } from "../../core/pickers.js";
import { localDate } from "../../core/format.js";
import { ensureStyles, PLAN_NAMES, waitRun } from "./kit.js";

const uuid = () => (typeof crypto !== "undefined" && crypto.randomUUID ? crypto.randomUUID() : `p${Date.now().toString(36)}${Math.random().toString(36).slice(2, 10)}`);
const KEYS = ["quarterly", "biannual", "monthly", "lights_annual", "custom"];

async function load(params, ctx) {
  ensureStyles();
  const set = await ctx.api("/plans/catalog", { cache: false }).catch(() => null);
  const cat = (set && set.data && set.data.catalog) || null;
  let contact = null;
  if (params.contact) {
    const c = await ctx.api(`/contacts/${encodeURIComponent(params.contact)}`, { cache: false }).catch(() => null);
    const d = c && c.data && (c.data.contact || c.data);
    contact = d ? { id: d.id || params.contact, name: d.display_name || [d.first_name, d.last_name].filter(Boolean).join(" ") } : { id: params.contact, name: "This contact" };
  }
  return { cat, contact, client_id: ctx.keep.client_id || (ctx.keep.client_id = uuid()), key: "quarterly" };
}

const entryOf = (s, key) => (s.cat && s.cat.plans && s.cat.plans[key]) || {};
const dollars = (c) => (Number.isInteger(c) ? (c / 100).toFixed(2) : "");

export default {
  title: "New plan",
  load,
  render(s) {
    const e = entryOf(s, s.key);
    const today = localDate();
    return html`<form class="form stack" data-new novalidate>
      <section class="card"><h2>Who</h2>
        ${s.contact ? html`<p><b>${s.contact.name}</b></p>` : html`<button type="button" class="btn block" data-pick>${icon("contacts")}Pick the customer</button>`}
        <p class="err" data-field="contact_id" hidden></p>
      </section>
      <section class="card"><h2>Plan</h2>
        <label class="field" data-field="catalog_key"><span>Plan</span><select name="catalog_key" data-key>${KEYS.map((k) => html`<option ${attrs({ value: k, selected: k === s.key })}>${(entryOf(s, k).name) || PLAN_NAMES[k]}</option>`)}</select></label>
        <p class="small muted">${e.visits_per_year || ""} visit${e.visits_per_year === 1 ? "" : "s"} a year${e.discount_per_visit_cents ? `, ${"$" + (e.discount_per_visit_cents / 100).toFixed(0)} off each visit` : ""}.</p>
        <div class="pl-grid">
          <label class="field" data-field="lines"><span>${s.key === "quarterly" ? "Exterior visit price" : s.key === "lights_annual" ? "Season price" : "Price a visit"}</span><input name="ext" inputmode="decimal" placeholder="295.00"></label>
          ${s.key === "quarterly" ? html`<label class="field"><span>Interior visit price (visit 2)</span><input name="int" inputmode="decimal" placeholder="160.00"></label>` : ""}
        </div>
        <label class="field"><span>Plan discount a visit</span><input name="disc" inputmode="decimal" ${attrs({ value: dollars(e.discount_per_visit_cents || 0) })}></label>
        ${dateField({ label: "Starts", name: "start_on", value: today })}
        <label class="field"><span>Term</span><select name="term_months">${[12, 24, 36].map((m) => html`<option ${attrs({ value: m })}>${m} months</option>`)}</select></label>
        <label class="check"><input ${attrs({ type: "checkbox", name: "autopay", checked: e.autopay !== false })}><span>Autopay (card on file)</span></label>
      </section>
      <p class="err" data-form-err hidden></p>
      <button type="submit" class="btn primary block">Set up the plan</button>
    </form>`;
  },
  events: {
    "change [data-key]": (e, el, ctx) => { ctx.state.key = el.value; ctx.rerender(); },
    "click [data-pick]": async (e, el, ctx) => {
      const c = await pickContact(ctx.api, { title: "Who is the plan for?" });
      if (c) { ctx.state.contact = c; ctx.rerender(); }
    },
    "submit [data-new]": async (e, form, ctx) => {
      e.preventDefault();
      clearErrors(form);
      const s = ctx.state;
      const v = readForm(form);
      if (!s.contact) { showError(form, { message: "Pick the customer first." }); return; }
      const ext = readMoney(v.ext);
      const int = s.key === "quarterly" ? readMoney(v.int) : null;
      const disc = readMoney(v.disc || "0");
      if (!Number.isInteger(ext) || ext <= 0) { showError(form, { field: "lines", message: "Add the price of a visit." }); return; }
      const svc = s.key === "lights_annual" ? "Christmas Lights" : "Residential Window Cleaning";
      const lines = s.key === "quarterly"
        ? [{ title: "Exterior Window Cleaning", unit_cents: ext, service_type: svc, scope: { type: "specific", visits: [1, 3, 4] } }, ...(Number.isInteger(int) && int > 0 ? [{ title: "Interior Window Cleaning", unit_cents: int, service_type: svc, scope: { type: "specific", visits: [2] } }] : [])]
        : [{ title: s.key === "lights_annual" ? "Christmas Lights" : "Exterior Window Cleaning", unit_cents: ext, service_type: svc }];
      const body = { contact_id: s.contact.id, catalog_key: s.key, lines, discounts: Number.isInteger(disc) && disc > 0 ? [{ name: "Plan discount", type: "fixed", value: disc, scope: { type: "all" } }] : [], start_on: v.start_on, term_months: Number(v.term_months), autopay: !!v.autopay, client_id: s.client_id };
      const btn = form.querySelector("[type=submit]");
      busy(btn, true, "Setting it up…");
      try {
        const r = await ctx.api("/plans", { method: "POST", body });
        if (r.data.run_id) await waitRun(ctx.api, r.data.run_id);
        delete ctx.keep.client_id;
        toast("Plan set up. Send the agreement next.");
        ctx.go(`/plans/${encodeURIComponent(r.data.plan_id)}`);
      } catch (err) { busy(btn, false); showError(form, err); }
    },
  },
};
