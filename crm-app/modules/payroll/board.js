// The crew scoreboard (barta-rules §5): revenue per hour against the $125
// goal, reviews a week (goal 2), upsell share, callbacks (under 2%), and
// what the "20% pooled by hours, +10% on upsells" comparison would pay
// (information only, never pay). Shared by Payroll and Pay.
import { html, attrs } from "../../core/ui.js";
import { dollars } from "./kit.js";

const mark = (ok) => (ok === null ? "" : ok ? "ok" : "low");
export function boardTable(b, { title = "Crew scoreboard" } = {}) {
  const rows = (b && b.rows) || [];
  const g = (b && b.goals) || {};
  if (!rows.length) return html`<section class="card"><h2>${title}</h2><p>Nobody on the scoreboard yet. It lists the technicians (Settings → Payroll picks who).</p></section>`;
  return html`<section class="card"><h2>${title}</h2>
    <div class="py-scroll"><table class="py-board"><thead><tr><th>Who</th><th>Per hour</th><th>Hours</th><th>Job value</th><th>Reviews</th><th>Upsells</th><th>Callbacks</th></tr></thead>
    <tbody>${rows.map((r) => html`<tr>
      <td>${r.first_name || r.name}</td>
      <td ${attrs({ class: mark(r.revenue_per_hour_cents === null ? null : r.revenue_per_hour_cents >= (g.revenue_per_hour_cents || 12500)) })}>${r.revenue_per_hour_cents === null ? "-" : dollars(r.revenue_per_hour_cents)}</td>
      <td>${(r.hours || 0).toFixed(1)}</td>
      <td>${dollars(r.job_value_cents)}</td>
      <td ${attrs({ class: mark(r.reviews_per_week >= (g.reviews_per_week || 2)) })}>${String(r.reviews)}</td>
      <td>${dollars(r.upsell_cents)}${r.upsell_share_pct !== null && r.upsell_share_pct !== undefined ? html` <small>(${r.upsell_share_pct}%)</small>` : ""}</td>
      <td ${attrs({ class: mark(r.callbacks_pct === null ? null : r.callbacks_pct < (g.callbacks_pct || 2)) })}>${String(r.callbacks)}</td>
    </tr>`)}</tbody></table></div>
    <p class="py-note">Goals: ${dollars(g.revenue_per_hour_cents || 12500)} an hour, ${g.reviews_per_week || 2} reviews a week, callbacks under ${g.callbacks_pct || 2}%. Job value is shared by the hours each person ran the timer${b.split === "equal" ? " (equally over a long range)" : ""}. ${rows.some((r) => r.pool_comparison_cents) ? `The ${(b.pool_bp || 2000) / 100}% pooled + ${(b.upsell_bp || 1000) / 100}% upsell comparison would be ${rows.map((r) => `${r.first_name || r.name} ${dollars(r.pool_comparison_cents)}`).join(", ")} (information only).` : ""}</p>
  </section>`;
}
