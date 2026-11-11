// Autopay (design §9.2 "Autopay runs", §5.6 Autopay): what the run on the
// 1st would bill, plan by plan (the preview the owner checks before the
// switch from Rotor), and the runs that happened. While Rotor still bills
// a plan the run only reports it: nothing is charged.

import { html, icon } from "../../core/ui.js";
import { money, plural } from "../../core/format.js";
import { ensureStyles, monthLabel, addMonth, emptyCard } from "./kit.js";

export const WOULD = {
  charge: ["green", "Card charged"], invoice_only: ["", "Invoice only"], skipped_no_card: ["red", "No card"], skipped_paused: ["", "Paused"],
  would_charge: ["amber", "Billed by Rotor"], succeeded: ["green", "Paid"], failed: ["red", "Failed"], processing: ["blue", "Clearing"],
  pending: ["", "Waiting"], nothing_due: ["", "Nothing due"], unknown: ["amber", "Check Stripe"],
};
export const wouldPill = (k) => { const [cls, words] = WOULD[k] || ["", k]; return html`<span class="${"pill " + cls}">${words}</span>`; };

async function load(params, ctx) {
  ensureStyles();
  const month = ctx.keep.month || "";
  const [p, runs] = await Promise.all([
    ctx.api(`/autopay/preview${month ? `?month=${encodeURIComponent(month)}` : ""}`, { cache: false }),
    ctx.api("/autopay/runs", { cache: false }).catch(() => ({ data: [] })),
  ]);
  return { preview: p.data, runs: runs.data || [] };
}

export default {
  load,
  render(s) {
    const p = s.preview, t = p.totals || {};
    return html`<div class="stack">
      <div class="mn-month"><button type="button" class="btn" data-month="-1" aria-label="The month before">‹</button><b>${monthLabel(p.month)}</b><button type="button" class="btn" data-month="1" aria-label="The month after">›</button></div>
      <section class="card"><h2>What the 1st would bill</h2>
        ${p.items.length ? html`<div class="mn-tot">
          <div class="stat"><b>${money(t.amount_cents || 0)}</b><small>${plural(t.plans || 0, "plan")}</small></div>
          <div class="stat"><b>${money(t.charge_cents || 0)}</b><small>charged to cards on file</small></div>
          ${t.would_charge_cents ? html`<div class="stat"><b>${money(t.would_charge_cents)}</b><small>still billed by Rotor (reported only)</small></div>` : ""}
          ${t.no_card ? html`<div class="stat bad"><b>${t.no_card}</b><small>on autopay with no card that works</small></div>` : ""}
        </div>
        <p class="foot-note">A plan from Rotor is only reported here until the switch: the CRM makes no invoice for it and charges nothing.</p>` : html`<p class="muted">No plan has a visit to bill in ${monthLabel(p.month)}.</p>`}
      </section>
      ${p.items.length ? html`<ul class="list">${p.items.map((i) => html`<li><a class="row" href="${"#/plans/" + encodeURIComponent(i.plan_id)}">
        <span class="ico">${icon("money")}</span>
        <span class="who"><span class="nm">${i.contact_name || "No name"}</span><span class="sub">${[i.plan_name, plural(i.visits.length, "visit"), i.autopay ? null : "pays by invoice"].filter(Boolean).join(" · ")}</span></span>
        <span class="end mn-end"><span class="num mn-amt">${money(i.amount_cents)}</span>${wouldPill(i.would)}</span></a></li>`)}</ul>` : ""}
      <div class="section-h">Runs</div>
      ${s.runs.length ? html`<ul class="list">${s.runs.map((r) => html`<li><a class="row" href="${"#/autopay/" + encodeURIComponent(r.id)}">
        <span class="ico">${icon("clock")}</span>
        <span class="who"><span class="nm">${monthLabel(r.m)}</span><span class="sub">${r.st === "planned" ? "Not run yet" : `${plural(r.n || 0, "plan")}${r.f ? ` · ${r.f} failed` : ""}${r.w ? ` · ${money(r.w)} reported only` : ""}`}</span></span>
        <span class="end mn-end"><span class="num mn-amt">${money(r.ok || 0)}</span><span class="${"pill " + (r.st === "done" ? "green" : r.st === "running" ? "blue" : "")}">${r.st === "done" ? "Done" : r.st === "running" ? "Running" : "Planned"}</span></span></a></li>`)}</ul>` : emptyCard("No runs yet", "The run happens on the 1st at 9 AM. The preview above is what it would do.")}
    </div>`;
  },
  events: {
    "click [data-month]": (e, el, ctx) => { ctx.keep.month = addMonth(ctx.state.preview.month, Number(el.dataset.month)); ctx.refresh(); },
  },
};
