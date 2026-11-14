// New plan (the office, design §9.2; Rotor's form rows, Nov 2026): for a customer who signs up without a
// quote. Pick the customer, the plan (the catalog fills the visit and the
// plan discount: an owner's settings), the price of each visit, the start,
// autopay. The plan waits for its agreement; the jobs for its first term are
// made at once (once Scheduling is there). A retry never makes two (client id).

import { html, attrs, icon, toast, sectionLabel, formRow, formRows, toggle, personCard, pillBtn } from "../../core/ui.js";
import { readForm, showError, clearErrors, busy, readMoney } from "../../core/forms.js";
import { dateField, pickContact } from "../../core/pickers.js";
import { localDate } from "../../core/format.js";
import { ensureStyles, PLAN_NAMES, BILLING, BILLING_SHORT, waitRun } from "./kit.js";

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
    const sw = (on, name, label) => html`${toggle(on, { data: { sw: name }, label })}<input type="hidden" ${attrs({ name, value: on ? "1" : "" })}>`;
    return html`<form class="rs-page pl-new-form" data-new novalidate>
      ${sectionLabel("Customer")}
      ${s.contact ? personCard({ name: s.contact.name, sub: "The plan is for them", actions: [{ icon: "edit", label: "Pick someone else", data: { pick: true } }] }) : html`<div class="rs-card">${pillBtn("Pick the customer", { icon: "contacts", wide: true, tone: "solid", data: { pick: true } })}</div>`}
      <p class="err" data-field="contact_id" hidden></p>
      ${sectionLabel("Details")}
      ${formRows([
        formRow("Plan", html`<select name="catalog_key" data-key aria-label="Plan">${KEYS.map((k) => html`<option ${attrs({ value: k, selected: k === s.key })}>${(entryOf(s, k).name) || PLAN_NAMES[k]}</option>`)}</select>`, { hint: `${e.visits_per_year || ""} visit${e.visits_per_year === 1 ? "" : "s"} a year` }),
        formRow("Agreement length", html`<select name="term_months" aria-label="Agreement length">${[12, 24, 36].map((m) => html`<option ${attrs({ value: m })}>${m} months</option>`)}</select>`),
        formRow("Renews", sw(s.renew !== false, "auto_renew", "Renews")),
        html`<label class="rs-frow" data-field="start_on"><span class="rs-fl">Start date</span><span class="rs-fc"><input type="date" name="start_on" ${attrs({ value: today })} aria-label="Start date"></span></label>`,
      ])}
      ${sectionLabel("Pricing")}
      ${formRows([
        html`<label class="rs-frow" data-field="lines"><span class="rs-fl">${s.key === "quarterly" ? "Exterior visit" : s.key === "lights_annual" ? "Season price" : "Price a visit"}</span><span class="rs-fc"><input name="ext" inputmode="decimal" placeholder="295.00" aria-label="Price a visit"></span></label>`,
        s.key === "quarterly" ? formRow("Interior visit", html`<input name="int" inputmode="decimal" placeholder="160.00" aria-label="Interior visit price (visit 2)">`, { hint: "visit 2" }) : null,
        formRow("Plan discount", html`<input name="disc" inputmode="decimal" ${attrs({ value: dollars(e.discount_per_visit_cents || 0) })} aria-label="Plan discount a visit">`, { hint: "off each visit" }),
      ])}
      ${sectionLabel("Billing")}
      ${formRows([
        formRow("Auto-Pay", sw(s.autopay !== undefined ? s.autopay : e.autopay !== false, "autopay", "Auto-Pay"), { hint: "card on file" }),
        formRow("Billing mode", html`<select name="billing_mode" aria-label="Billing mode">${Object.entries(BILLING_SHORT).map(([k, l]) => html`<option ${attrs({ value: k, selected: (e.billing || "barta_standard") === k })}>${l}</option>`)}</select>`, { hint: BILLING[e.billing || "barta_standard"] }),
      ])}
      <p class="err" data-form-err hidden></p>
      <button type="submit" class="rs-pb red wide">Set up the plan</button>
    </form>`;
  },
  events: {
    "change [data-key]": (e, el, ctx) => { ctx.state.key = el.value; ctx.rerender(); },
    "click [data-sw]": (e, el) => {
      const on = el.getAttribute("aria-checked") !== "true";
      el.setAttribute("aria-checked", on ? "true" : "false");
      const h = el.parentElement.querySelector(`input[name="${el.dataset.sw}"]`);
      if (h) h.value = on ? "1" : "";
    },
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
      const body = { contact_id: s.contact.id, catalog_key: s.key, lines, discounts: Number.isInteger(disc) && disc > 0 ? [{ name: "Plan discount", type: "fixed", value: disc, scope: { type: "all" } }] : [], start_on: v.start_on, term_months: Number(v.term_months), autopay: !!v.autopay, auto_renew: !!v.auto_renew, billing_mode: v.billing_mode, client_id: s.client_id };
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
