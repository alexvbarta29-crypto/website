// The contact's plans (design §9.2 Contact; the "Service plan" section of
// the contact page since the Nov 2026 layout, kept apart from one-time
// jobs): this contact's plans, agreements waiting to be signed, Christmas
// lights seasons, and New plan. header() gives the contact page its plan
// badge ("Quarterly plan", "Christmas lights plan +1") and the values of
// Rotor's summary box (sale value, frequency, service type). cards() and
// actions(): the contact page's Service Plans card (Rotor's plan rows: a
// red edge, the plan, its frequency, term, Auto-Renew, signed, the value)
// and its "..." row (Nov 2026).
// On a phone (Rotor's phone app, Nov 15; ctx.phone): SERVICE PLAN cards (the
// plan, its frequency, Duration, Sale Value, how it bills, Auto-Pay, the
// agreement's round icon) and BILLING CYCLES: each live plan billed on the
// 1st (billing first_of_month, or barta_standard after its first visit),
// which Money's 1st-of-month run turns into one plan_cycle invoice a month;
// + New is New plan (a cycle belongs to a plan). On a desk the cycles card
// sits on Payments.

import { html, icon, rnd, statusPill as kitPill } from "../../core/ui.js";
import { money } from "../../core/format.js";
import { ensureStyles, SEASON, STATUS, AGREEMENT, monthLabel } from "./kit.js";

const LIVE = ["active", "cancelling", "paused"];
// Rotor's FREQUENCY and SERVICE TYPE, from the plan's catalog entry
export const FREQUENCY = Object.freeze({ biannual: "Biannual", quarterly: "Quarterly", monthly: "Monthly", lights_annual: "Annual", custom: "Custom" });
export const serviceType = (r) => (r.k === "lights_annual" || r.ck === "lights_annual" ? "Christmas Lights" : "Window Cleaning");
// How a plan bills (Rotor's "Start of Month"), and the modes Money's 1st-of-month run bills (money/autopay.mjs CYCLE_MODES).
export const BILLS = Object.freeze({ first_of_month: "Start of Month", barta_standard: "Start of Month after the first visit", after_visit: "After each visit" });
export const CYCLE_MODES = Object.freeze(["first_of_month", "barta_standard"]);
// the plan's billing mode: its own (from the plan), else its catalog entry's
export const billingOf = (r, plan) => (plan && plan.billing && plan.billing.mode) || (r.ck === "lights_annual" || r.k === "lights_annual" ? "after_visit" : "barta_standard");
const PILL_TONE = { active: "green", pending: "amber", paused: "blue", cancelling: "amber", cancelled: "red", draft: "grey", expired: "grey" };

// One plan as Rotor draws it on the profile: the plan and its frequency; the term, Auto-Renew and the agreement; the value.
export function planCardRow(r) {
  const signed = r.ag === "signed";
  return html`<li class="pl-row"><a class="row" href="${"#/plans/" + encodeURIComponent(r.id)}">
    <span class="who"><span class="nm">${r.nm || "Plan"}</span><span class="sub">${[FREQUENCY[r.ck] || "", r.nx ? `next ${monthLabel(r.nx)}` : ""].filter(Boolean).join(" · ")}</span>
      <span class="pl-facts"><span>${icon("clock")}${String(r.tm || 12)} mo</span>${r.ar ? kitPill("Auto-Renew", "green") : ""}<span>${icon("doc")}${AGREEMENT[r.ag] ? (signed ? "Signed" : AGREEMENT[r.ag]) : "Not sent"}</span>${r.ap ? html`<span>Autopay</span>` : ""}</span></span>
    <span class="end">${Number.isSafeInteger(r.sv) && r.sv > 0 ? html`<span class="num">${money(r.sv)}</span>` : ""}${kitPill(STATUS[r.st] || r.st, PILL_TONE[r.st] || "grey")}</span></a></li>`;
}

// Rotor's phone plan card: the plan and its frequency, Duration, Sale Value, how it bills and Auto-Pay; the
// agreement's round icon top right (it opens the plan, whose Agree tab holds the agreements).
export function planPhoneRow(r, plan = null) {
  const id = encodeURIComponent(r.id);
  const term = (plan && plan.term && plan.term.initial_months) || r.tm || 12;
  const auto = plan && plan.billing ? !!plan.billing.autopay : !!r.ap;
  return html`<li class="ct-plc"><a class="ct-plc-a" href="${"#/plans/" + id}">
      <span class="ct-plc-t">${r.nm || "Plan"}</span>
      <span class="ct-plc-f">${FREQUENCY[r.ck] || ""}${r.st !== "active" ? kitPill(STATUS[r.st] || r.st, PILL_TONE[r.st] || "grey") : ""}</span>
      <span class="ct-plc-kv"><span>Duration:</span><b>${term} months</b></span>
      ${Number.isSafeInteger(r.sv) && r.sv > 0 ? html`<span class="ct-plc-kv"><span>Sale Value:</span><b class="num">${money(r.sv).replace(/\.00$/, "")}</b></span>` : ""}
      <span class="ct-plc-b">${icon("money")}<span>${BILLS[billingOf(r, plan)]}</span>${auto ? html`<span class="ct-chip">${icon("bolt")}Auto-Pay</span>` : ""}${r.ar ? "" : html`<span class="ct-chip">Ends after the term</span>`}</span>
    </a>${rnd("doc", `Agreement: ${AGREEMENT[r.ag] || "Not sent"}. Open the plan`, { sm: true, tone: "grey", href: "#/plans/" + id })}</li>`;
}
// The plans with a billing cycle: live (active, cancelling, paused) and billed on the 1st.
export const cyclePlans = (rows = [], plans = {}) => rows.filter((r) => LIVE.includes(r.st) && CYCLE_MODES.includes(billingOf(r, plans[r.id])));
const cycleRow = (r, plan) => html`<li><a class="row ct-cyc" href="${"#/plans/" + encodeURIComponent(r.id)}"><span class="ico">${icon("cal12")}</span>
  <span class="who"><span class="nm">${r.nm || "Plan"}</span><span class="sub">${[billingOf(r, plan) === "first_of_month" ? "Bills on the 1st" : "Bills on the 1st after visit 1", r.nx ? `next ${monthLabel(r.nx)}` : "", r.st === "paused" ? "paused" : r.st === "cancelling" ? "ending" : ""].filter(Boolean).join(" · ")}</span></span>
  <span class="end">${(plan && plan.billing ? plan.billing.autopay : r.ap) ? kitPill("Auto-Pay", "green") : kitPill("Invoice only", "grey")}</span></a></li>`;

export default {
  async load(params, ctx) {
    ensureStyles();
    if (!ctx.can("plans:read")) return { denied: true };
    const [plans, ags] = await Promise.all([
      ctx.api(`/plans?contact=${encodeURIComponent(params.id)}`, { cache: false }),
      ctx.api(`/agreements?contact=${encodeURIComponent(params.id)}`, { cache: false }),
    ]);
    const rows = plans.data || [];
    // each live plan's own terms (how it bills, Auto-Pay, its length): the plan cards and Billing Cycles
    const full = {};
    await Promise.all(rows.filter((r) => [...LIVE, "pending"].includes(r.st)).slice(0, 4).map((r) => ctx.api(`/plans/${encodeURIComponent(r.id)}`, { cache: false })
      .then((x) => { if (x && x.data && x.data.plan) full[r.id] = { billing: x.data.plan.billing || null, term: x.data.plan.term || null }; }).catch(() => {})));
    return { id: params.id, rows, plans: full, agreements: (ags.data || []).filter((a) => ["sent", "viewed", "draft"].includes(a.status)) };
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
  // On a phone (ctx.phone) Rotor's plan cards; and Billing Cycles (Rotor's), on Payments on a desk.
  cards(s, ctx) {
    if (!s || s.denied) return [];
    const id = encodeURIComponent(s.id);
    const full = s.plans || {};
    const add = ctx.can("plans:write") ? { label: "New plan", short: "New Plan", href: "#/plans/new/" + id } : null;
    const rows = ctx.phone ? html`<ul class="ct-plcs">${s.rows.map((r) => planPhoneRow(r, full[r.id]))}</ul>` : html`<ul class="list pl-rows">${s.rows.map(planCardRow)}</ul>`;
    const cyc = cyclePlans(s.rows, full);
    return [{ key: "plan", tab: "service", title: ctx.phone ? "Service Plan" : "Service Plans", count: s.rows.length > 1 ? `${s.rows.length} plans` : null, empty: "No service plans yet", add,
      body: s.rows.length || s.agreements.length ? html`${s.rows.length ? rows : ""}
        ${s.agreements.length ? html`<h4 class="ct-sub-h">Agreements to sign</h4><ul class="list">${s.agreements.map(agreementRow)}</ul>` : ""}` : null },
    { key: "cycles", tab: "payments", title: "Billing Cycles", count: cyc.length || null, empty: "No billing cycles yet.",
      add: add ? { label: "New plan (a plan billed on the 1st starts a billing cycle)", short: "New", href: add.href } : null,
      body: cyc.length ? html`<ul class="list">${cyc.map((r) => cycleRow(r, full[r.id]))}</ul>` : null }];
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
