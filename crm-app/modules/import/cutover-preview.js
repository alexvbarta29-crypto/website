// The switch-over preview, in full (design §10.9 "Cutover preview";
// owners): per automation and day, the texts, emails, invoices and charges
// the CRM would send from the switch to 72 hours after it; sample texts;
// what Rotor already sent (seeded, so not sent again); what the floor keeps
// out (imported jobs never asked for a review, imported invoices never
// reminded); what waits in dry-run and is cancelled; the next numbers; the
// in-flight documents. Approve on the Switch from Rotor page.

import { html, attrs } from "../../core/ui.js";
import { dateTime } from "../../core/format.js";
import { ensureStyles } from "./kit.js";

const n = (x) => Number(x || 0).toLocaleString("en-US");
const DOW = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const MON = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
export const dayLabel = (d) => {
  const t = new Date(`${d}T12:00:00Z`);
  return Number.isFinite(t.getTime()) ? `${DOW[t.getUTCDay()]} ${MON[t.getUTCMonth()]} ${t.getUTCDate()}` : d;
};
const cell = (x) => {
  const parts = [];
  if (x.texts) parts.push(`${n(x.texts)} txt`);
  if (x.emails) parts.push(`${n(x.emails)} email`);
  if (x.invoices) parts.push(`${n(x.invoices)} inv`);
  if (x.charges) parts.push(`${n(x.charges)} chg`);
  return parts.length ? parts.join(" · ") : "None";
};

function dayTable(r) {
  return html`<table class="co-table"><thead><tr><th>Day</th><th>Texts</th><th>Emails</th><th>Charges</th></tr></thead><tbody>
    ${r.by_day.map((d) => html`<tr><td>${dayLabel(d.date)}</td><td>${n(d.texts)}</td><td>${n(d.emails)}</td><td>${n(d.charges)}</td></tr>`)}
    <tr class="co-sum"><td>All 72 hours</td><td>${n(r.totals.texts)}</td><td>${n(r.totals.emails)}</td><td>${n(r.totals.charges)}</td></tr>
  </tbody></table>`;
}

function automationCard(a, days) {
  const total = a.total.texts + a.total.emails + a.total.invoices + a.total.charges;
  return html`<section class="card">
    <div class="im-head"><h3>${a.label}</h3><span class="${"pill " + (a.enabled ? (total ? "blue" : "") : "amber")}">${a.enabled ? cell(a.total) : "Off"}</span></div>
    ${a.kind === "daily" && total ? html`<table class="co-table"><tbody>${days.map((d, i) => html`<tr><td>${dayLabel(d)}</td><td>${cell(a.by_day[i] || {})}</td></tr>`)}</tbody></table>` : ""}
    ${a.note ? html`<p class="small muted im-gap">${a.note}</p>` : ""}
    ${(a.samples || []).slice(0, 2).map((t) => html`<p class="co-sample">${t}</p>`)}
  </section>`;
}

export default {
  title: "Switch-over preview",
  async load(params, ctx) {
    ensureStyles();
    return (await ctx.api("/cutover/preview", { cache: false })).data;
  },
  render(s) {
    if (!s || !s.result) {
      return html`<div class="stack"><section class="card empty"><h2>${s && s.state && s.state.status === "running" ? "Working it out" : "No preview yet"}</h2><p>Make it on the Switch from Rotor page, right after the final import.</p><div class="btn-row"><a class="btn" href="#/cutover">Back</a></div></section></div>`;
    }
    const r = s.result;
    const active = r.automations.filter((a) => a.kind === "daily");
    const other = r.automations.filter((a) => a.kind !== "daily");
    const unmatched = Object.values(r.seeds.unmatched || {}).reduce((x, y) => x + y, 0);
    return html`<div class="stack">
      <section class="card">
        <h2>The first 72 hours</h2>
        <p class="small muted">For a switch at ${dateTime(r.at)}. Counts are before quiet hours and opt-outs: the CRM can only send fewer.</p>
        ${dayTable(r)}
        ${s.state && s.state.approved_at ? html`<p class="ok-box im-gap">Approved ${dateTime(s.state.approved_at)}.</p>` : ""}
      </section>
      <div class="section-h">Each automation</div>
      ${active.map((a) => automationCard(a, r.days))}
      <section class="card">
        <h2>What Rotor already sent</h2>
        <p class="small muted">Rotor's texts from the last 30 days, matched to their visit, invoice, payment or agreement: the CRM counts them as sent.</p>
        <dl class="kv"><dt>Visit reminders</dt><dd>${n(r.seeds.reminder)}</dd><dt>Overdue texts</dt><dd>${n(r.seeds.overdue)}</dd><dt>Receipts</dt><dd>${n(r.seeds.receipt)}</dd><dt>Agreement reminders</dt><dd>${n(r.seeds.agreement)}</dd>
          ${unmatched ? html`<dt>Not matched</dt><dd>${n(unmatched)} (no visit, invoice or agreement found for them)</dd>` : ""}</dl>
      </section>
      <section class="card">
        <h2>Kept out</h2>
        <dl class="kv"><dt>Review requests</dt><dd>${n(r.floor.imported_completed_jobs)} ${r.floor.imported_completed_jobs === 1 ? "job" : "jobs"} Rotor completed this past week: never asked</dd>
          <dt>Overdue reminders</dt><dd>${n(r.floor.imported_invoices)} open ${r.floor.imported_invoices === 1 ? "invoice" : "invoices"} from Rotor: never reminded (they go in the in-flight list)</dd>
          <dt>Waiting in dry-run</dt><dd>${n(r.sequences.dry_sends)} queued ${r.sequences.dry_sends === 1 ? "send" : "sends"} and ${n(r.sequences.follow_ups)} ${r.sequences.follow_ups === 1 ? "follow-up" : "follow-ups"}: cancelled at the switch, never resumed</dd></dl>
      </section>
      <section class="card">
        <h2>Numbers after the switch</h2>
        <dl class="kv"><dt>Next job</dt><dd>${String(r.numbers.job).padStart(7, "0")}</dd><dt>Next invoice</dt><dd>INV-${String(r.numbers.invoice).padStart(4, "0")}</dd><dt>Next quote</dt><dd>Q-${r.numbers.quote}</dd></dl>
      </section>
      <section class="card">
        <h2>Only on new activity</h2>
        <ul class="co-list">${other.map((a) => html`<li class="co-item"><span class="who"><span class="nm">${a.label}</span><span class="sub">${a.note || ""}</span></span>${a.enabled ? "" : html`<span class="end"><span class="pill amber">Off</span></span>`}</li>`)}</ul>
      </section>
      <div class="btn-row"><a class="btn primary" ${attrs({ href: "#/cutover" })}>Back to the switch</a></div>
    </div>`;
  },
};
