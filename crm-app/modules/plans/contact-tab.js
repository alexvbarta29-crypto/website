// The contact's plans (design §9.2 Contact; the "Service plan" section of
// the contact page since the Nov 2026 layout, kept apart from one-time
// jobs): this contact's plans, agreements waiting to be signed, Christmas
// lights seasons, and New plan. header() gives the contact page its plan
// badge ("Quarterly plan", "Christmas lights plan +1"). cards() and
// actions(): the contact page's Plan card and its "..." row (Nov 2026).

import { html, icon } from "../../core/ui.js";
import { ensureStyles, planRow, SEASON } from "./kit.js";

export default {
  async load(params, ctx) {
    ensureStyles();
    if (!ctx.can("plans:read")) return { denied: true };
    const [plans, ags] = await Promise.all([
      ctx.api(`/plans?contact=${encodeURIComponent(params.id)}`, { cache: false }),
      ctx.api(`/agreements?contact=${encodeURIComponent(params.id)}`, { cache: false }),
    ]);
    return { id: params.id, rows: plans.data || [], agreements: (ags.data || []).filter((a) => ["sent", "viewed", "draft"].includes(a.status)) };
  },
  // the plan badge: the live plan's name (a second one as "+1"), or the one waiting to be signed
  header(s) {
    const rows = s.rows || [];
    const live = rows.filter((r) => ["active", "cancelling", "paused"].includes(r.st));
    if (live.length) return { plan: `${live[0].nm || "Plan"}${live.length > 1 ? ` +${live.length - 1}` : ""}` };
    const waiting = rows.find((r) => r.st === "pending");
    return waiting ? { plan: `${waiting.nm || "Plan"}, not signed yet` } : {};
  },
  // The contact page's card (Rotor's): Plan with a round + (New plan); agreements waiting under it.
  cards(s, ctx) {
    if (!s || s.denied) return [];
    const id = encodeURIComponent(s.id);
    return [{ key: "plan", tab: "details", title: "Plan", count: s.rows.length > 1 ? `${s.rows.length} plans` : null, empty: "No plan yet",
      add: ctx.can("plans:write") ? { label: "New plan", href: "#/plans/new/" + id } : null,
      body: s.rows.length || s.agreements.length ? html`${s.rows.length ? html`<ul class="list">${s.rows.map(planRow)}</ul>` : ""}
        ${s.agreements.length ? html`<h4 class="ct-sub-h">Agreements to sign</h4><ul class="list">${s.agreements.map(agreementRow)}</ul>` : ""}` : null }];
  },
  actions(s, ctx) {
    if (!s || s.denied || !ctx.can("plans:write")) return [];
    return [{ key: "plan", label: "New plan", icon: "swap", href: "#/plans/new/" + encodeURIComponent(s.id) }];
  },
  render(s, ctx) {
    if (s.denied) return html`<div class="card empty"><h2>Not for this login</h2><p>Plans are for the office.</p></div>`;
    return html`<div class="stack">
      ${ctx.can("plans:write") ? html`<div class="btn-row" style="margin-top:0"><a class="btn primary" href="${"#/plans/new/" + encodeURIComponent(s.id)}">${icon("plus")}New plan</a></div>` : ""}
      ${s.rows.length ? html`<ul class="list">${s.rows.map(planRow)}</ul>` : html`<p class="muted small">No plans yet.</p>`}
      ${s.agreements.length ? html`<div class="section-h">Agreements to sign</div><ul class="list">${s.agreements.map(agreementRow)}</ul>` : ""}
    </div>`;
  },
};
export { SEASON };
const agreementRow = (a) => html`<li><a class="row" href="${a.plan_id ? "#/plans/" + encodeURIComponent(a.plan_id) : "#/plans"}"><span class="ico">${icon("doc")}</span><span class="who"><span class="nm">${a.title}</span><span class="sub">${a.status === "draft" ? "Not sent yet" : a.status === "viewed" ? "Opened, not signed" : "Sent, not signed"}</span></span><span class="chev" aria-hidden="true"></span></a></li>`;
