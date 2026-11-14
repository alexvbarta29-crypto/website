// Settings → Payroll (owners; design §5.8, D3): the pay rules (overtime
// over how many hours and at what rate, how a job's commission is shared,
// how long a pay period is, who is on the crew scoreboard) and each
// person's pay: the model (hourly, commission, the higher of the two, or
// both), hourly rates per kind of time, commission rates, and overtime.
// What Rotor pays was brought in by the import (pay rates); the open pay
// period works itself out again with any change.

import { html, attrs, toast, sheet } from "../../core/ui.js";
import { readForm, showError, clearErrors, busy, readMoney, select, field, checkbox } from "../../core/forms.js";
import { loadDoc, saveDoc } from "../system/kit.js";
import { ensureStyles, MODEL, dollars } from "./kit.js";

const SPLIT = { by_hours: "By the hours each person ran the timer", equal: "Equally", each_full: "Each at the full job (Rotor's way)" };
const pctText = (bp) => (bp ? `${(bp / 100).toFixed(bp % 100 ? 2 : 0)}%` : "0%");
const toBp = (s) => { const n = Number(String(s || "0").replace(/[%\s]/g, "")); return Number.isFinite(n) && n >= 0 && n <= 100 ? Math.round(n * 100) : null; };
const cents = (c) => (Number.isInteger(c) && c > 0 ? (c / 100).toFixed(2) : "");

async function load(params, ctx) {
  ensureStyles();
  const [doc, users] = await Promise.all([loadDoc(ctx, "payroll"), ctx.api("/users", { cache: false })]);
  const team = (users.data || []).filter((u) => u.status !== "disabled");
  const full = await Promise.all(team.map((u) => ctx.api(`/users/${encodeURIComponent(u.id)}`, { cache: false }).then((r) => ({ ...r.data, etag: r.etag })).catch(() => null)));
  return { doc, cfg: { ...(doc.defaults || {}), ...(doc.data || {}) }, people: full.filter(Boolean) };
}

function editPerson(ctx, u) {
  const p = u.pay || {};
  const h = p.hourly_cents || {}, c = p.commission_pct || {};
  const sh = sheet({
    title: `${u.name}'s pay`,
    body: html`<form class="py-form" novalidate data-person-form>
      ${select({ label: "Paid by", name: "model", value: p.model || "hourly", options: Object.entries(MODEL).map(([value, label]) => ({ value, label })) })}
      <div class="three">${field({ label: "Service $/h", name: "service", inputmode: "decimal", value: cents(h.service), placeholder: u.role === "tech" ? "20.00" : "0.00" })}${field({ label: "Sales $/h", name: "sales", inputmode: "decimal", value: cents(h.sales) })}${field({ label: "Office $/h", name: "office", inputmode: "decimal", value: cents(h.office) })}</div>
      <div class="three">${field({ label: "Job %", name: "technician", inputmode: "decimal", value: c.technician ? String(c.technician / 100) : "" })}${field({ label: "Sales %", name: "salesman", inputmode: "decimal", value: c.salesman ? String(c.salesman / 100) : "" })}${field({ label: "Upsell %", name: "upsell", inputmode: "decimal", value: c.upsell ? String(c.upsell / 100) : "" })}</div>
      ${checkbox({ label: "Overtime over the weekly hours", name: "overtime", checked: p.overtime !== false })}
      <p class="small muted">A technician with no service rate is paid the standard $20 an hour. Commission is a percent of the job total after discounts (tips never count).</p>
      <p class="err" data-form-err hidden></p>
      <button type="submit" class="btn primary">Save</button>
    </form>`,
    events: {
      "submit [data-person-form]": async (e, form) => {
        e.preventDefault();
        clearErrors(form);
        const v = readForm(form);
        const hourly = {};
        for (const k of ["service", "sales", "office"]) {
          const m = v[k] ? readMoney(v[k]) : 0;
          if (m === null || m < 0) return showError(form, { field: k, message: "Enter a rate like 20.00." });
          hourly[k] = m;
        }
        const pct = {};
        for (const k of ["technician", "salesman", "upsell"]) {
          const b = toBp(v[k]);
          if (b === null) return showError(form, { field: k, message: "A percent from 0 to 100." });
          pct[k] = b;
        }
        const btn = form.querySelector("button[type=submit]");
        busy(btn, true);
        try {
          await ctx.api(`/users/${encodeURIComponent(u.id)}`, { method: "PATCH", ifMatch: u.etag, body: { pay: { ...p, model: v.model, hourly_cents: hourly, commission_pct: pct, overtime: !!v.overtime } } });
          sh.close();
          toast("Saved.");
          ctx.refresh();
        } catch (err) {
          busy(btn, false);
          if (err.status === 412) { toast("Someone else just changed this person. Showing the latest.", { bad: true }); sh.close(); ctx.refresh(); return; }
          showError(form, err);
        }
      },
    },
  });
}

export default {
  load,
  render(s) {
    const c = s.cfg;
    const board = new Set(c.scoreboard_user_ids || []);
    return html`<div class="stack py-page">
      <form class="card py-form" novalidate data-rules>
        <h2>Pay rules</h2>
        <div class="two">${field({ label: "Overtime after (hours a week)", name: "ot_threshold_hours", inputmode: "decimal", value: c.ot_threshold_hours })}${field({ label: "Overtime rate (x)", name: "ot_multiplier", inputmode: "decimal", value: c.ot_multiplier })}</div>
        ${select({ label: "A job's commission is shared", name: "commission_split", value: c.commission_split, options: Object.entries(SPLIT).map(([value, label]) => ({ value, label })) })}
        ${select({ label: "A pay period is", name: "period_weeks", value: String(c.period_weeks || 1), options: [{ value: "1", label: "One week (Sunday to Saturday)" }, { value: "2", label: "Two weeks" }] })}
        <fieldset class="py-form"><legend class="small muted">On the crew scoreboard (none ticked: the technicians)</legend>
          ${s.people.map((u) => checkbox({ label: u.name, name: `board_${u.id}`, checked: board.has(u.id) }))}
        </fieldset>
        <p class="err" data-form-err hidden></p>
        <button type="submit" class="btn primary">Save the rules</button>
      </form>
      <div class="section-h">Each person's pay</div>
      <ul class="list">${s.people.map((u) => {
        const p = u.pay || {}, h = p.hourly_cents || {}, cm = p.commission_pct || {};
        const bits = [h.service ? `${dollars(h.service)}/h service` : u.role === "tech" ? "$20.00/h service (standard)" : "", h.sales ? `${dollars(h.sales)}/h sales` : "", h.office ? `${dollars(h.office)}/h office` : "", cm.technician ? `${pctText(cm.technician)} of jobs` : "", cm.salesman ? `${pctText(cm.salesman)} of sales` : "", cm.upsell ? `${pctText(cm.upsell)} of upsells` : ""].filter(Boolean);
        return html`<li><button type="button" class="row" ${attrs({ "data-edit": u.id })}><span class="who"><span class="nm">${u.name}</span><span class="sub">${MODEL[p.model || "hourly"]}${bits.length ? ` · ${bits.join(", ")}` : " · no rates set"}</span></span><span class="chev" aria-hidden="true"></span></button></li>`;
      })}</ul>
    </div>`;
  },
  events: {
    "click [data-edit]": (e, el, ctx) => { const u = ctx.state.people.find((x) => x.id === el.dataset.edit); if (u) editPerson(ctx, u); },
    "submit [data-rules]": async (e, form, ctx) => {
      e.preventDefault();
      clearErrors(form);
      const v = readForm(form);
      const ids = ctx.state.people.filter((u) => v[`board_${u.id}`]).map((u) => u.id);
      const value = { ...(ctx.state.doc.data || {}), ot_threshold_hours: Number(v.ot_threshold_hours), ot_multiplier: Number(v.ot_multiplier), commission_split: v.commission_split, period_weeks: Number(v.period_weeks), scoreboard_user_ids: ids };
      const btn = form.querySelector("button[type=submit]");
      busy(btn, true);
      try { await saveDoc(ctx, ctx.state.doc, value); busy(btn, false); toast("Saved."); } catch (err) { busy(btn, false); if (err.status !== 412) showError(form, err); }
    },
  },
};
