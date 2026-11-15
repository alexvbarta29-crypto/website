// The contact's plans (design §9.2 Contact; the "Service plan" section of
// the contact page since the Nov 2026 layout, kept apart from one-time
// jobs): this contact's plans, agreements waiting to be signed, Christmas
// lights seasons, and New plan. header() gives the contact page its plan
// badge ("Quarterly plan", "Christmas lights plan +1") and the values of
// Rotor's summary box (sale value, frequency, service type). cards() and
// actions(): the contact page's Service Plans card (Rotor's plan rows: a
// red edge, the plan, its frequency, term, Auto-Renew, signed, the value)
// and its "..." row (Nov 2026).

import { html, icon, statusPill as kitPill } from "../../core/ui.js";
import { money } from "../../core/format.js";
import { ensureStyles, SEASON, STATUS, AGREEMENT, monthLabel } from "./kit.js";

const LIVE = ["active", "cancelling", "paused"];
// Rotor's FREQUENCY and SERVICE TYPE, from the plan's catalog entry
export const FREQUENCY = Object.freeze({ biannual: "Biannual", quarterly: "Quarterly", monthly: "Monthly", lights_annual: "Annual", custom: "Custom" });
export const serviceType = (r) => (r.k === "lights_annual" || r.ck === "lights_annual" ? "Christmas Lights" : "Window Cleaning");
const PILL_TONE = { active: "green", pending: "amber", paused: "blue", cancelling: "amber", cancelled: "red", draft: "grey", expired: "grey" };

// One plan as Rotor draws it on the profile: the plan and its frequency; the term, Auto-Renew and the agreement; the value.
export function planCardRow(r) {
  const signed = r.ag === "signed";
  return html`<li class="pl-row"><a class="row" href="${"#/plans/" + encodeURIComponent(r.id)}">
    <span class="who"><span class="nm">${r.nm || "Plan"}</span><span class="sub">${[FREQUENCY[r.ck] || "", r.nx ? `next ${monthLabel(r.nx)}` : ""].filter(Boolean).join(" · ")}</span>
      <span class="pl-facts"><span>${icon("clock")}${String(r.tm || 12)} mo</span>${r.ar ? kitPill("Auto-Renew", "green") : ""}<span>${icon("doc")}${AGREEMENT[r.ag] ? (signed ? "Signed" : AGREEMENT[r.ag]) : "Not sent"}</span>${r.ap ? html`<span>Autopay</span>` : ""}</span></span>
    <span class="end">${Number.isSafeInteger(r.sv) && r.sv > 0 ? html`<span class="num">${money(r.sv)}</span>` : ""}${kitPill(STATUS[r.st] || r.st, PILL_TONE[r.st] || "grey")}</span></a></li>`;
}

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
  // and Rotor's summary box: the live plans' sale value, the first one's frequency and service type
  header(s) {
    const rows = s.rows || [];
    const live = rows.filter((r) => LIVE.includes(r.st));
    const box = (list) => (list.length ? { sale_value: list.reduce((a, r) => a + (Number.isSafeInteger(r.sv) ? r.sv : 0), 0), frequency: FREQUENCY[list[0].ck] || null, service_type: serviceType(list[0]) } : {});
    if (live.length) return { plan: `${live[0].nm || "Plan"}${live.length > 1 ? ` +${live.length - 1}` : ""}`, ...box(live) };
    const waiting = rows.find((r) => r.st === "pending");
    return waiting ? { plan: `${waiting.nm || "Plan"}, not signed yet`, ...box([waiting]) } : {};
  },
  // The contact page's card (Rotor's Service tab): Service Plans with + New Plan; agreements waiting under it.
  cards(s, ctx) {
    if (!s || s.denied) return [];
    const id = encodeURIComponent(s.id);
    return [{ key: "plan", tab: "service", title: "Service Plans", count: s.rows.length > 1 ? `${s.rows.length} plans` : null, empty: "No service plans yet",
      add: ctx.can("plans:write") ? { label: "New plan", short: "New Plan", href: "#/plans/new/" + id } : null,
      body: s.rows.length || s.agreements.length ? html`${s.rows.length ? html`<ul class="list pl-rows">${s.rows.map(planCardRow)}</ul>` : ""}
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
      ${s.rows.length ? html`<ul class="list">${s.rows.map(planCardRow)}</ul>` : html`<p class="muted small">No plans yet.</p>`}
      ${s.agreements.length ? html`<div class="section-h">Agreements to sign</div><ul class="list">${s.agreements.map(agreementRow)}</ul>` : ""}
    </div>`;
  },
};
export { SEASON };
const agreementRow = (a) => html`<li><a class="row" href="${a.plan_id ? "#/plans/" + encodeURIComponent(a.plan_id) : "#/plans"}"><span class="ico">${icon("doc")}</span><span class="who"><span class="nm">${a.title}</span><span class="sub">${a.status === "draft" ? "Not sent yet" : a.status === "viewed" ? "Opened, not signed" : "Sent, not signed"}</span></span><span class="chev" aria-hidden="true"></span></a></li>`;
