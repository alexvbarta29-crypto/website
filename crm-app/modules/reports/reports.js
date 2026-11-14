// Reports (Menu → Reports; design §5.9, §9.2 "Reports"): the numbers a pro
// CRM gives, from the CRM's own records (imported Rotor history included):
// Revenue (collected, invoiced, by service, source and method), Sales
// (quotes sent and won, close rate by person and by source, average
// ticket), Leads (by source, time to first touch, plan adoption), Plans
// (active, MRR / ARR, started, cancelled, churn), Jobs (completed, revenue
// per tech-hour, callbacks), Team, Owed (aging) and Payroll. A date range
// (this week to the last 12 months, or any days), each number against the
// period before, a chart drawn like Home's, and every table as CSV.
// Practice (dry-run) payments and test contacts never count.

import { html, attrs, sheet, toast } from "../../core/ui.js";
import { money, localDate } from "../../core/format.js";
import { dateField } from "../../core/pickers.js";
import { readForm, showError } from "../../core/forms.js";
import { pairChart, srTable } from "../system/home-charts.js";
import { ensureStyles } from "./kit.js";

export const TABS = [["revenue", "Revenue"], ["sales", "Sales"], ["leads", "Leads"], ["plans", "Plans"], ["jobs", "Jobs"], ["team", "Team"], ["owed", "Owed"], ["payroll", "Payroll"]];
const RANGES = [["week", "This week"], ["month", "This month"], ["last_month", "Last month"], ["3m", "Last 3 months"], ["year", "This year"], ["12m", "Last 12 months"], ["custom", "Pick the days…"]];
const GROUPS = [["", "Auto"], ["day", "By day"], ["week", "By week"], ["month", "By month"]];
const addDays = (d, n) => new Date(Date.parse(d + "T12:00:00Z") + n * 86400000).toISOString().slice(0, 10);
const monthStart = (d) => `${d.slice(0, 7)}-01`;
const prevMonthStart = (d) => { const [y, m] = d.split("-").map(Number); return m === 1 ? `${y - 1}-12-01` : `${y}-${String(m - 1).padStart(2, "0")}-01`; };

export function rangeDates(key, today, keep = {}) {
  if (key === "week") return { from: addDays(today, -((new Date(today + "T12:00:00Z").getUTCDay() + 6) % 7)), to: today };
  if (key === "last_month") { const f = prevMonthStart(today); return { from: f, to: addDays(monthStart(today), -1) }; }
  if (key === "3m") return { from: prevMonthStart(prevMonthStart(today)), to: today };
  if (key === "year") return { from: `${today.slice(0, 4)}-01-01`, to: today };
  if (key === "12m") return { from: addDays(today, -364), to: today };
  if (key === "custom" && keep.from && keep.to) return { from: keep.from, to: keep.to };
  return { from: monthStart(today), to: today };
}

const dollars = (c) => money(c || 0).replace(/\.00$/, "");
const short = (v) => (v >= 1000000 ? `$${(v / 1000000).toFixed(1).replace(/\.0$/, "")}M` : v >= 1000 ? `$${(v / 1000).toFixed(v >= 10000 ? 0 : 1).replace(/\.0$/, "")}K` : `$${Math.round(v)}`);
export function fmt(v, unit) {
  if (v === null || v === undefined) return "-";
  if (unit === "cents") return dollars(v);
  if (unit === "pct") return `${v}%`;
  if (unit === "minutes") return v >= 120 ? `${Math.round(v / 6) / 10} h` : `${v} min`;
  if (unit === "hours") return `${v} h`;
  return Number(v).toLocaleString("en-US");
}
export function delta(t) {
  if (t.prev === null || t.prev === undefined || t.value === null || t.value === undefined) return null;
  if (t.unit === "pct") { const d = Math.round((t.value - t.prev) * 10) / 10; return { text: `${d > 0 ? "+" : ""}${d} pts`, up: d > 0, flat: d === 0 }; }
  if (!t.prev) return t.value ? { text: "new", up: true, flat: false } : { text: "same", flat: true };
  const d = Math.round(((t.value - t.prev) / Math.abs(t.prev)) * 100);
  return { text: `${d > 0 ? "+" : ""}${d}%`, up: d > 0, flat: d === 0 };
}
const cell = (t, i, v) => ((t.money || []).includes(i) ? (v === null || v === undefined ? "-" : dollars(v)) : (t.pctCols || []).includes(i) || (i > 0 && t.head[i] === "Share") ? (v === null || v === undefined ? "-" : `${v}%`) : v === null || v === undefined || v === "" ? "-" : String(v));
const LINK = { invoice: (id) => `#/invoices/${id}`, pay_period: (id) => `#/payroll/${id}` };

const hashQuery = (name) => { try { return new URLSearchParams(location.hash.split("?")[1] || "").get(name) || ""; } catch (e) { return ""; } };

async function load(params, ctx) {
  ensureStyles();
  const today = localDate();
  const k = ctx.keep;
  // #/reports?tab=revenue (Home's "See more") opens that report
  const asked = hashQuery("tab");
  if (asked && TABS.some(([x]) => x === asked) && asked !== k.asked) { k.tab = asked; k.asked = asked; }
  const tab = k.tab || "revenue";
  const range = k.range || "month";
  const { from, to } = rangeDates(range, today, k);
  const qs = `from=${from}&to=${to}${k.group ? `&group=${k.group}` : ""}`;
  const r = await ctx.api(`/reports/${tab}?${qs}`, { cache: false });
  return { rep: r.data, tab, range, group: k.group || "", qs, payroll: ctx.can("payroll:read_all"), office: ctx.can("office:tools") };
}

let chart = null;
export default {
  load,
  render(s) {
    const r = s.rep;
    const tabs = TABS.filter(([k]) => k !== "payroll" || s.payroll);
    const live = r.name === "owed";
    return html`<div class="stack rp-page rp-reports">
      <div class="chips rp-chips rp-tabs" role="tablist" aria-label="Report">${tabs.map(([k, l]) => html`<button type="button" class="chip" role="tab" ${attrs({ "data-tab": k, "aria-selected": String(s.tab === k), "aria-pressed": String(s.tab === k) })}>${l}</button>`)}</div>
      ${live ? html`<p class="rp-when">Right now · open invoices</p>` : html`<div class="rp-bar rp-range">
        <label class="rp-sel"><span class="sr">Dates</span><select data-range>${RANGES.map(([k, l]) => html`<option ${attrs({ value: k, selected: s.range === k })}>${k === "custom" && s.range === "custom" ? `${r.from} to ${r.to}` : l}</option>`)}</select></label>
        ${(r.series || []).length ? html`<label class="rp-sel"><span class="sr">Group</span><select data-group>${GROUPS.map(([k, l]) => html`<option ${attrs({ value: k, selected: s.group === k })}>${l}</option>`)}</select></label>` : ""}
      </div>
      <p class="rp-when">${r.from} to ${r.to} · against ${r.prev.from} to ${r.prev.to}</p>`}
      <div class="rp-tiles">${(r.tiles || []).map((t) => { const d = delta(t); const good = d && !d.flat ? (t.lower ? !d.up : d.up) : null; return html`<div class="rp-tile">
        <span class="l">${t.label}</span><b class="num">${fmt(t.value, t.unit)}</b>
        <span class="sub">${d ? html`<span ${attrs({ class: "dl " + (good === null ? "" : good ? "good" : "bad") })}>${d.up ? "▲" : d.flat ? "" : "▼"} ${d.text}</span> <span>was ${fmt(t.prev, t.unit)}</span>` : t.note ? t.note : t.target !== undefined ? `goal ${Array.isArray(t.target) ? `${t.target[0]}-${t.target[1]}%` : t.unit === "cents" ? dollars(t.target) : `${t.lower ? "under " : ""}${t.target}${t.unit === "pct" ? "%" : ""}`}` : ""}</span>
      </div>`; })}</div>
      ${(r.series || []).length && (r.keys || []).length > 1 ? html`<section class="card rp-chart">
        <div class="hc-read2" data-readout aria-live="polite"></div>
        <div class="hc hc-pair" data-chart tabindex="0" ${attrs({ "aria-label": `${r.series.map((x) => x.label).join(" and ")} by ${r.group}` })}></div>
        ${srTable(`${r.series.map((x) => x.label).join(" and ")}`, ["Period", ...r.series.map((x) => x.label)], r.keys.map((k, i) => [r.labels[i], ...r.series.map((x) => fmt(x.values[i], r.unit))]))}
      </section>` : ""}
      ${(r.tables || []).map((t) => html`<section class="card rp-table">
        <h2>${t.title}</h2>
        ${t.rows.length ? html`<div class="rp-scroll"><table><thead><tr>${t.head.map((h, i) => html`<th ${attrs({ class: i ? "n" : "" })}>${h}</th>`)}</tr></thead>
          <tbody>${t.rows.map((row, ri) => html`<tr>${row.map((v, i) => (i === 0 && t.links && t.links[0] && t.ids && t.ids[ri] && (t.links[0] !== "pay_period" || s.payroll) ? html`<td><a ${attrs({ href: LINK[t.links[0]](t.ids[ri]) })}>${cell(t, i, v)}</a></td>` : html`<td ${attrs({ class: i ? "n" : "" })}>${cell(t, i, v)}</td>`))}</tr>`)}</tbody></table></div>`
          : html`<p>Nothing in these dates.</p>`}
      </section>`)}
      <div class="btn-row"><a class="btn" ${attrs({ href: `/api/crm/reports/${r.name}.csv?${s.qs}`, download: "" })}>Export CSV</a>${s.office ? html`<a class="btn" href="#/dashboard" data-office-dashboard>Office dashboard</a>` : ""}</div>
      <p class="rp-foot">Collected is money in (payments and tips, less refunds) on the day it came in; practice payments and test customers never count. Work completed is billable jobs finished, after discounts.</p>
    </div>`;
  },
  mount(el, s) {
    if (chart) { chart.destroy(); chart = null; }
    const box = el.querySelector("[data-chart]");
    if (!box) return;
    const r = s.rep;
    const money = r.unit === "cents";
    const read = el.querySelector("[data-readout]");
    const series = r.series.slice(0, 2).map((x, i) => ({ cls: i ? "hc-line s" : "hc-line", dot: i ? "s" : "", values: x.values.map((v) => (v === null || v === undefined ? null : money ? v / 100 : v)) }));
    chart = pairChart(box, {
      keys: r.keys, label: (i) => r.labels[i], series, axis: (v) => (money ? short(v) : String(v)), height: 190,
      start: r.keys[r.keys.length - 1],
      onRead: (i) => {
        if (!read) return;
        read.textContent = "";
        const d = document.createElement("span"); d.className = "d"; d.textContent = r.labels[i]; read.appendChild(d);
        r.series.slice(0, 2).forEach((x, k) => { const sp = document.createElement("span"); sp.className = "k" + (k ? " s" : ""); sp.appendChild(document.createElement("i")); sp.appendChild(document.createTextNode(`${x.label} `)); const b = document.createElement("b"); b.textContent = fmt(x.values[i], r.unit); sp.appendChild(b); read.appendChild(sp); });
      },
    });
  },
  unmount() { if (chart) { chart.destroy(); chart = null; } },
  events: {
    "click [data-tab]": (e, el, ctx) => { ctx.keep.tab = el.dataset.tab; ctx.refresh(); },
    "change [data-group]": (e, el, ctx) => { ctx.keep.group = el.value; ctx.refresh(); },
    "change [data-range]": (e, el, ctx) => {
      if (el.value !== "custom") { ctx.keep.range = el.value; ctx.refresh(); return; }
      const today = localDate();
      const s = sheet({
        title: "Pick the days",
        body: html`<form class="form stack" novalidate data-days>
          ${dateField({ label: "First day", name: "from", value: ctx.keep.from || monthStart(today), max: today })}
          ${dateField({ label: "Last day", name: "to", value: ctx.keep.to || today, max: today })}
          <p class="small muted">Up to a year.</p><p class="err" data-form-err hidden></p>
          <button type="submit" class="btn primary">Show</button>
        </form>`,
        onClose: () => { if (ctx.keep.range !== "custom") el.value = ctx.keep.range || "month"; },
        events: {
          "submit [data-days]": (ev, form) => {
            ev.preventDefault();
            const v = readForm(form);
            if (!v.from || !v.to || v.to < v.from) return showError(form, { field: "to", message: "The last day comes after the first." });
            if ((Date.parse(v.to) - Date.parse(v.from)) / 86400000 > 399) return showError(form, { field: "from", message: "A year at most." });
            Object.assign(ctx.keep, { range: "custom", from: v.from, to: v.to });
            s.close();
            ctx.refresh();
          },
        },
      });
      void toast;
    },
  },
};
