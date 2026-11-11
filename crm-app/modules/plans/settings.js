// Settings → Plans catalog & perks (design §9.2, §5.4 cfg/plans_catalog,
// cfg/lights, D27, D29, D30; owners): each plan's visits a year, plan
// discount, renewal, billing, autopay and
// perks; the cancel notice and the late-cancel fee; the lights rebook date;
// and "Request signatures for N active plans" (imported plans have no
// signature on file: one bulk run, test send and confirm first, D10).

import { html, attrs, icon, toast, confirmSheet } from "../../core/ui.js";
import { busy, readMoney } from "../../core/forms.js";
import { ensureStyles, BILLING, PLAN_NAMES, waitRun } from "./kit.js";

const KEYS = ["biannual", "quarterly", "monthly", "lights_annual", "custom"];
const dollars = (c) => (Number.isInteger(c) ? (c / 100).toFixed(2) : "");

async function load(params, ctx) {
  ensureStyles();
  const [cat, lights, plans] = await Promise.all([
    ctx.api("/settings/plans_catalog", { cache: false }),
    ctx.api("/settings/lights", { cache: false }),
    ctx.api("/plans?status=active", { cache: false }),
  ]);
  const unsigned = (plans.data || []).filter((r) => r.ag !== "signed" && r.ag !== "sent" && r.ag !== "viewed");
  return { cat: cat.data.data, catEtag: cat.data.etag || "new", lights: lights.data.data, lightsEtag: lights.data.etag || "new", unsigned: unsigned.map((r) => r.id).slice(0, 500) };
}

const entry = (s, k) => (s.cat.plans || {})[k] || {};

export default {
  title: "Plans catalog & perks",
  load,
  render(s) {
    return html`<div class="stack">
      <form class="form stack" data-catalog novalidate>
        ${KEYS.map((k) => { const e = entry(s, k); return html`<section class="card"><h2>${e.name || PLAN_NAMES[k]}</h2>
          <div class="pl-grid">
            <label class="field"><span>Visits a year</span><input ${attrs({ name: `${k}.visits_per_year`, inputmode: "numeric", value: e.visits_per_year })}></label>
            <label class="field"><span>Discount a visit</span><input ${attrs({ name: `${k}.discount`, inputmode: "decimal", value: dollars(e.discount_per_visit_cents) })}></label>
            <label class="field"><span>Renews every (months)</span><input ${attrs({ name: `${k}.renews`, inputmode: "numeric", value: e.renews_every_months })}></label>
          </div>
          <label class="field"><span>Billing</span><select ${attrs({ name: `${k}.billing` })}>${Object.entries(BILLING).map(([v, l]) => html`<option ${attrs({ value: v, selected: v === e.billing })}>${l}</option>`)}</select></label>
          <label class="check"><input ${attrs({ type: "checkbox", name: `${k}.autopay`, checked: !!e.autopay })}><span>Autopay by default</span></label>
          ${k === "lights_annual" ? "" : html`<label class="check"><input ${attrs({ type: "checkbox", name: `${k}.touch_ups`, checked: !!(e.perks || {}).touch_ups })}><span>${s.cat.perk_names.touch_ups}</span></label>
          <label class="check"><input ${attrs({ type: "checkbox", name: `${k}.rain`, checked: (e.perks || {}).rain_guarantee_days > 0 })}><span>${s.cat.perk_names.rain_guarantee}</span></label>
          <label class="check"><input ${attrs({ type: "checkbox", name: `${k}.hard_water`, checked: !!(e.perks || {}).hard_water })}><span>${s.cat.perk_names.hard_water}</span></label>`}
        </section>`; })}
        <section class="card"><h2>Cancel policy</h2>
          <p class="small muted">Cancelling in the first term after the first visit is done: the customer pays back the plan discount that visit got (each plan's own, worked out from what it was sold with).</p><div class="pl-grid">
          <label class="field"><span>Notice (days)</span><input ${attrs({ name: "notice_days", inputmode: "numeric", value: s.cat.notice_days })}></label>
          <label class="field"><span>Late-cancel fee</span><input ${attrs({ name: "late_fee", inputmode: "decimal", value: dollars(s.cat.late_cancel_fee_cents) })}></label>
        </div><p class="small muted">The fee is charged only when an owner approves it. Never when we move a visit.</p></section>
        <section class="card"><h2>Christmas lights</h2><div class="pl-grid">
          <label class="field"><span>Rebook text (MM-DD)</span><input ${attrs({ name: "rebook_on", value: s.lights.rebook_on, maxlength: 5 })}></label>
          <label class="field"><span>Installs by (MM-DD)</span><input ${attrs({ name: "install_by", value: s.lights.install_by, maxlength: 5 })}></label>
        </div><p class="small muted">On the rebook date the CRM prepares one bulk text for last season's customers. Nothing goes out until you test and confirm it.</p></section>
        <p class="err" data-form-err hidden></p>
        <button type="submit" class="btn primary block">Save</button>
      </form>
      <section class="card"><h2>Signatures</h2>
        <p>${s.unsigned.length ? `${s.unsigned.length} active plan${s.unsigned.length === 1 ? " has" : "s have"} no signed agreement on file (plans from Rotor never do).` : "Every active plan has its agreement signed or on the way."}</p>
        ${s.unsigned.length ? html`<button type="button" class="btn block" data-request>${icon("send")}Request signatures for ${s.unsigned.length} plan${s.unsigned.length === 1 ? "" : "s"}</button>` : ""}
      </section>
    </div>`;
  },
  events: {
    "submit [data-catalog]": async (e, form, ctx) => {
      e.preventDefault();
      const s = ctx.state;
      const f = (n) => form.elements[n];
      const err = form.querySelector("[data-form-err]");
      const plans = {};
      for (const k of KEYS) {
        const p = {
          visits_per_year: Number(f(`${k}.visits_per_year`).value), discount_per_visit_cents: readMoney(f(`${k}.discount`).value || "0"),
          renews_every_months: Number(f(`${k}.renews`).value), billing: f(`${k}.billing`).value, autopay: f(`${k}.autopay`).checked,
        };
        if (k !== "lights_annual") p.perks = { touch_ups: f(`${k}.touch_ups`).checked, rain_guarantee_days: f(`${k}.rain`).checked ? (((s.cat.plans[k] || {}).perks || {}).rain_guarantee_days || 7) : 0, hard_water: f(`${k}.hard_water`).checked };
        plans[k] = p;
      }
      const btn = form.querySelector("[type=submit]");
      busy(btn, true);
      try {
        await ctx.api("/settings/plans_catalog", { method: "PUT", ifMatch: s.catEtag, body: { ...s.cat, plans: { ...s.cat.plans, ...Object.fromEntries(KEYS.map((k) => [k, { ...(s.cat.plans[k] || {}), ...plans[k] }])) }, notice_days: Number(f("notice_days").value), late_cancel_fee_cents: readMoney(f("late_fee").value || "0") } });
        await ctx.api("/settings/lights", { method: "PUT", ifMatch: s.lightsEtag, body: { ...s.lights, rebook_on: f("rebook_on").value.trim(), install_by: f("install_by").value.trim() } });
        toast("Saved"); ctx.refresh();
      } catch (er) { busy(btn, false); err.textContent = er.status === 412 ? "Someone else just saved these. Reload and try again." : er.message; err.hidden = false; }
    },
    "click [data-request]": async (e, el, ctx) => {
      const n = ctx.state.unsigned.length;
      if (!(await confirmSheet(`Each of the ${n} customers gets their agreement to sign. It goes out as one bulk text: you test it and confirm it under Approvals first.`, { title: "Request signatures?", yes: "Prepare it" }))) return;
      busy(el, true, "Preparing…");
      try {
        const r = await ctx.api("/plans/request-signatures", { method: "POST", body: { plan_ids: ctx.state.unsigned } });
        const run = await waitRun(ctx.api, r.data.run_id, { tries: 60 });
        const res = (run && run.result) || {};
        toast(res.bulk_run_id ? `Ready for ${res.requested}: test and confirm it under Approvals` : "Nothing to send: approve the agreement texts first", { bad: !res.bulk_run_id });
        ctx.refresh();
      } catch (err) { busy(el, false); toast(err.message, { bad: true }); }
    },
  },
};
