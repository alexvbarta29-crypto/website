// Settings → Dashboard numbers (owners; design §5.9 "Dashboard feed"):
// where the Dashboard tab's numbers come from. Rotor's snapshot (sealed,
// refreshed by hand, the default until the switch from Rotor) or the CRM
// (worked out live from its own records, imported history included). The
// owner can flip it early to compare the two.

import { html, attrs, toast } from "../../core/ui.js";
import { loadDoc, saveDoc } from "../system/kit.js";

export default {
  async load(params, ctx) { const doc = await loadDoc(ctx, "dashboard"); return { doc, source: (doc.data && doc.data.source) || "rotor" }; },
  render(s) {
    return html`<div class="stack">
      <section class="card"><h2>Dashboard numbers</h2>
        <p>Where the Dashboard's revenue, sales, plans and jobs come from.</p>
        <div class="btn-row" role="group" aria-label="Source">
          ${[["rotor", "Rotor's snapshot"], ["crm", "The CRM, live"]].map(([k, l]) => html`<button type="button" ${attrs({ class: "btn" + (s.source === k ? " primary" : ""), "data-source": k, "aria-pressed": String(s.source === k) })}>${l}</button>`)}
        </div>
        <p class="small muted">${s.source === "crm" ? "Worked out from the CRM's own payments, leads, quotes, plans, jobs and visits (kept for 10 minutes). Practice payments never count." : "The sealed picture of Rotor from its last refresh. Switch to the CRM at cutover, or now to compare."}</p>
      </section>
      <a class="btn" href="#/dashboard">Open the Dashboard</a>
      <a class="btn" href="#/reports">Open Reports</a>
    </div>`;
  },
  events: {
    "click [data-source]": async (e, el, ctx) => {
      try { await saveDoc(ctx, ctx.state.doc, { ...(ctx.state.doc.data || {}), source: el.dataset.source }); ctx.state.source = el.dataset.source; ctx.rerender(); toast("Saved."); }
      catch (err) { if (err.status !== 412) toast(err.message || "That didn't save.", { bad: true }); }
    },
  },
};
