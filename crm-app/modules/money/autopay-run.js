// One autopay run (design §9.2 "Autopay runs"): each plan it looked at and
// what happened: paid, failed (the card), no card, invoice only, or only
// reported because Rotor still bills that plan.

import { html, icon } from "../../core/ui.js";
import { money, plural, dateTime } from "../../core/format.js";
import { ensureStyles, monthLabel } from "./kit.js";
import { wouldPill } from "./autopay.js";

export default {
  async load(params, ctx) {
    ensureStyles();
    const r = await ctx.api(`/autopay/runs/${encodeURIComponent(params.id)}`, { cache: false });
    return { run: r.data.run, names: r.data.names || {} };
  },
  title: (s) => (s && s.run ? `Autopay, ${monthLabel(s.run.month)}` : "Autopay run"),
  render(s) {
    const run = s.run, t = run.totals || {};
    const items = run.status === "planned" ? ((run.preview && run.preview.items) || []).map((i) => ({ ...i, result: i.would })) : run.items || [];
    return html`<div class="stack">
      <section class="card"><h2>${monthLabel(run.month)}</h2>
        <p>${run.status === "planned" ? "Not run yet. This is the preview from the 28th." : run.status === "running" ? "Running now." : `Finished${run.finished_at ? ` ${dateTime(run.finished_at)}` : ""}${run.late ? " (it ran late)" : ""}.`}</p>
        ${run.status === "planned" ? "" : html`<div class="mn-tot">
          <div class="stat"><b>${money(t.succeeded_cents || 0)}</b><small>charged</small></div>
          <div class="${"stat" + (t.failed ? " bad" : "")}"><b>${t.failed || 0}</b><small>failed</small></div>
          ${t.processing ? html`<div class="stat"><b>${t.processing}</b><small>clearing</small></div>` : ""}
          ${t.would_charge_cents ? html`<div class="stat"><b>${money(t.would_charge_cents)}</b><small>reported only (Rotor bills these)</small></div>` : ""}
        </div>`}
      </section>
      ${items.length ? html`<ul class="list">${items.map((i) => { const n = s.names[i.plan_id] || {}; const href = i.invoice_id ? `#/invoices/${encodeURIComponent(i.invoice_id)}` : `#/plans/${encodeURIComponent(i.plan_id)}`; return html`<li><a class="row" href="${href}">
        <span class="ico">${icon("money")}</span>
        <span class="who"><span class="nm">${i.contact_name || n.contact_name || "No name"}</span><span class="sub">${[i.plan_name || n.plan_name, i.code ? String(i.code).replace(/_/g, " ") : null].filter(Boolean).join(" · ")}</span></span>
        <span class="end mn-end"><span class="num mn-amt">${money(i.amount_cents || 0)}</span>${wouldPill(i.result)}</span></a></li>`; })}</ul>` : html`<p class="muted">${plural(0, "plan")} had a visit to bill.</p>`}
    </div>`;
  },
};
