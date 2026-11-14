// Pieces the payroll screens share: the stylesheet, words for statuses,
// models and line kinds, and money/hours formats.
import { html, attrs } from "../../core/ui.js";
import { money } from "../../core/format.js";

let styled = false;
export function ensureStyles() {
  if (styled || typeof document === "undefined") return;
  styled = true;
  const l = document.createElement("link");
  l.rel = "stylesheet";
  l.href = "/crm-app/modules/payroll/payroll.css";
  document.head.appendChild(l);
}
export const STATUS = { open: ["Open", "amber"], locked: ["Locked", "blue"], paid: ["Paid", "green"] };
export const statusPill = (st) => { const [l, c] = STATUS[st] || [st || "-", ""]; return html`<span ${attrs({ class: "pill " + c })}>${l}</span>`; };
export const MODEL = { hourly: "Hourly", commission: "Commission", greater_of: "Higher of hourly or commission", hourly_plus_commission: "Hourly plus commission" };
export const KIND = { hourly: "Hours", overtime: "Overtime", technician_commission: "Job commission", salesman_commission: "Sales commission", upsell_commission: "Upsell", tip: "Tip", adjustment: "Adjustment", bonus: "Bonus" };
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
export const day = (d) => (d ? `${MONTHS[Number(d.slice(5, 7)) - 1]} ${Number(d.slice(8, 10))}` : "");
export const span = (a, b) => (a && b ? (a.slice(0, 7) === b.slice(0, 7) ? `${day(a)} – ${Number(b.slice(8, 10))}` : `${day(a)} – ${day(b)}`) : "");
export const dollars = (c) => money(c || 0);
export const hrs = (h) => `${(Math.round((Number(h) || 0) * 100) / 100).toFixed(2)} h`;
export const kindOf = (l) => l.line_type || l.type;
export const addDays = (date, n) => new Date(Date.parse(date + "T12:00:00Z") + n * 86400000).toISOString().slice(0, 10);

// One pay line: what it is, its detail (and why it isn't paid), the amount.
export function lineRow(l, { voidable = false } = {}) {
  const off = l.status === "void";
  return html`<li ${attrs({ class: "py-line" + (off ? " void" : "") })}>
    <span class="who"><span class="nm">${KIND[kindOf(l)] || kindOf(l)}${l.label && l.label !== KIND[kindOf(l)] ? html` · ${l.label}` : ""}</span><span class="sub">${l.detail || ""}${l.note && l.note !== l.detail ? html`<br>${l.note}` : ""}</span></span>
    <span class="end"><b class="num">${dollars(l.amount_cents)}</b>${voidable && !off && l.record && !l.rotor ? html`<button type="button" class="icon-btn sm" ${attrs({ "data-void": l.id, "aria-label": "Strike this out" })}>✕</button>` : ""}</span>
  </li>`;
}

// The totals as a few labelled numbers.
export function totalsGrid(t) {
  const x = t || {};
  return html`<dl class="py-grid">
    <div><dt>Hours</dt><dd>${hrs(x.regular_hours)}</dd></div>
    <div><dt>Overtime</dt><dd>${hrs(x.ot_hours)}</dd></div>
    <div><dt>Commission</dt><dd>${dollars(x.commission_cents)}</dd></div>
    <div><dt>Tips</dt><dd>${dollars(x.tips_cents)}</dd></div>
  </dl>`;
}
