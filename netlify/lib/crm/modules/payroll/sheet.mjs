// The printable pay sheet (one page per person, the "visual pay sheet" the
// owner prints today; design §5.8) and the period's CSV export. Server HTML
// escapes every value (esc); no script, styles only (the CRM's CSP).

import { esc } from "../../core/text.mjs";
import { csvCell } from "../../../referral-lib.mjs";
import { HTML_HEADERS, currentCsp } from "../../core/http.mjs";
import { dayLabel } from "./compute.mjs";

const money = (c) => `${c < 0 ? "-" : ""}$${(Math.abs(c || 0) / 100).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const TYPE = {
  hourly: "Hours", overtime: "Overtime", technician_commission: "Job commission", salesman_commission: "Sales commission",
  upsell_commission: "Upsell commission", tip: "Tips", adjustment: "Adjustment", bonus: "Bonus",
};
const STATUS = { open: "Open (not final)", locked: "Locked", paid: "Paid" };
export const span = (p) => `${dayLabel(p.start_on)} – ${dayLabel(p.end_on)}, ${p.end_on.slice(0, 4)}`;

export function sheetHtml({ period, user, lines, totals, company = "Barta Window Washing" }) {
  const t = totals || {};
  const rows = (lines || []).map((l) => `<tr class="${l.status === "void" ? "void" : ""}"><td>${esc(TYPE[l.type] || l.type)}</td><td>${esc(l.label)}<small>${esc(l.detail || "")}${l.note ? ` · ${esc(l.note)}` : ""}</small></td><td class="n">${l.hours !== undefined && l.hours !== null ? esc(Number(l.hours).toFixed(2)) : ""}</td><td class="n">${esc(money(l.amount_cents))}</td></tr>`).join("");
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover"><meta name="robots" content="noindex, nofollow">
<title>Pay sheet · ${esc(user.name || "")} · ${esc(span(period))}</title>
<style>
:root{color-scheme:light}
body{margin:0;padding:24px;font:15px/1.45 -apple-system,BlinkMacSystemFont,"SF Pro Text","Segoe UI",Roboto,sans-serif;color:#16161b;background:#fff}
main{max-width:760px;margin:0 auto}
header{display:flex;justify-content:space-between;align-items:flex-start;gap:16px;border-bottom:2px solid #16161b;padding-bottom:12px}
h1{margin:0;font-size:26px;letter-spacing:-.02em}
h1 small,header p{display:block;margin:4px 0 0;font-size:15px;font-weight:500;color:#5b5b66}
.big{font-size:34px;font-weight:700;text-align:right}
.big small{display:block;font-size:13px;font-weight:500;color:#5b5b66}
dl{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:10px;margin:16px 0}
dl div{border:1px solid #ececee;border-radius:14px;padding:10px 12px}
dt{font-size:12px;text-transform:uppercase;letter-spacing:.08em;color:#5b5b66}
dd{margin:2px 0 0;font-size:18px;font-weight:600}
table{width:100%;border-collapse:collapse;margin-top:8px}
th,td{text-align:left;padding:8px 6px;border-bottom:1px solid #ececee;vertical-align:top}
th{font-size:12px;text-transform:uppercase;letter-spacing:.08em;color:#5b5b66}
td small{display:block;color:#5b5b66;font-size:13px}
.n{text-align:right;white-space:nowrap;font-variant-numeric:tabular-nums}
tr.void td{color:#9a9aa3;text-decoration:line-through}
tfoot td{font-weight:700;border-bottom:0;font-size:17px}
footer{margin-top:18px;color:#5b5b66;font-size:13px}
@media print{body{padding:0}@page{margin:14mm}}
@media (max-width:560px){dl{grid-template-columns:repeat(2,minmax(0,1fr))}header{flex-direction:column}.big{text-align:left}}
</style></head><body><main>
<header><div><h1>${esc(user.name || "")}<small>Pay sheet · ${esc(span(period))}</small></h1><p>${esc(company)} · ${esc(STATUS[period.status] || period.status)}${period.paid_at ? ` on ${esc(dayLabel(String(period.paid_at).slice(0, 10)))}` : ""}</p></div>
<div class="big">${esc(money(t.total_cents || 0))}<small>total pay</small></div></header>
<dl><div><dt>Hours</dt><dd>${esc((t.regular_hours || 0).toFixed(2))}</dd></div><div><dt>Overtime</dt><dd>${esc((t.ot_hours || 0).toFixed(2))} h</dd></div><div><dt>Tips</dt><dd>${esc(money(t.tips_cents || 0))}</dd></div><div><dt>Commission</dt><dd>${esc(money(t.commission_cents || 0))}</dd></div></dl>
<table><thead><tr><th>Kind</th><th>What</th><th class="n">Hours</th><th class="n">Amount</th></tr></thead><tbody>${rows || `<tr><td colspan="4">Nothing in this period.</td></tr>`}</tbody>
<tfoot><tr><td colspan="3">Total</td><td class="n">${esc(money(t.total_cents || 0))}</td></tr></tfoot></table>
<footer>Hourly ${esc(money(t.hourly_cents || 0))} · Overtime ${esc(money(t.ot_cents || 0))} · Commission ${esc(money(t.commission_cents || 0))} · Tips ${esc(money(t.tips_cents || 0))} · Adjustments ${esc(money(t.adjustments_cents || 0))}. Pay model: ${esc(String(t.model_applied || "hourly").replace(/_/g, " "))}. Struck-out lines are not paid.</footer>
</main></body></html>`;
}

export const htmlResponse = (body) => new Response(body, { status: 200, headers: { ...HTML_HEADERS, "Content-Security-Policy": currentCsp() } });
export const csvResponse = (text, name) => new Response(text, {
  status: 200,
  headers: { "Content-Type": "text/csv; charset=utf-8", "Content-Disposition": `attachment; filename="${name}"`, "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff", "X-Robots-Tag": "noindex, nofollow" },
});
export const csv = (head, rows) => [head, ...rows].map((r) => r.map((c) => csvCell(c)).join(",")).join("\r\n") + "\r\n";

// One row per line, then one per person (the totals).
export function periodCsv({ period, people, lines, totals }) {
  const name = new Map((people || []).map((p) => [p.id, p.name]));
  const head = ["period_start", "period_end", "status", "person", "kind", "label", "detail", "hours", "rate_cents_per_hour", "basis_cents", "rate_percent", "amount", "line_status", "line_key"];
  const out = (lines || []).map((l) => [period.start_on, period.end_on, period.status, name.get(l.user_id) || l.user_id, l.type, l.label, l.detail, l.hours ?? "", l.rate_cents_per_hour ?? "", l.basis_cents ?? "", l.rate_bp ? l.rate_bp / 100 : "", ((l.amount_cents || 0) / 100).toFixed(2), l.status, l.line_key]);
  for (const [uid, t] of Object.entries(totals || {})) {
    out.push([period.start_on, period.end_on, period.status, name.get(uid) || uid, "total", "Total", `hours ${t.regular_hours} + overtime ${t.ot_hours}; model ${t.model_applied}`, (t.regular_hours || 0) + (t.ot_hours || 0), "", "", "", ((t.total_cents || 0) / 100).toFixed(2), "", ""]);
  }
  return csv(head, out);
}
