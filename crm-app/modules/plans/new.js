// New plan (Flyra's "New Subscription" sheet, the owner, Nov 15; design
// §9.2): the customer and their property, the Mockup chip (lights), "Start
// from a template" (the catalog: Quarterly fills exterior on visits 1, 3,
// 4 and interior on visit 2 with the plan discount), then Service |
// Agreement | Billing:
//   Service: line items, discounts, the total; "Initial visit" (the same
//     as the plan, or its own line items: those cover visit 1 only and the
//     plan's start after it); the service schedule: Frequency (every 1, 2,
//     3, 4, 6 or 12 months), Months (the year's visits, from the first
//     visit), First visit (the plan's start), Repeats (on that day of the
//     month, on that weekday of it, or any day: those wait on To book), Time;
//     "Schedule pending" (on: the visits wait on the To book list, as a plan
//     always did; off: this term's visits are booked as the rows say); View
//     schedule; lead source (the customer's own), salesperson, who goes;
//     notes for the office.
//   Agreement: how long, renews.
//   Billing: Auto-Pay, the billing mode.
// The plan waits for its agreement (Send it from the plan). A retry never
// makes two (client id); a retried booking is the same visit (client ids).

import { html, attrs, toast } from "../../core/ui.js";
import { busy } from "../../core/forms.js";
import { money, clock } from "../../core/format.js";
import {
  ensureCreateStyles, createPage, fieldLabel, customerCard, mockupChip, addRow, itemRows, lineRowOf, totalRow, pickRow, switchRow, pillDate, pillBtn, slotRow, scheduleLink,
  notesField, segIcons, setReady, pillChanged, openPill, deskPointer, redraw, loadCustomer, primaryOf, saveLeadSource, pickCustomer, pickProperty, pickItem,
  lineFromItem, lineSheet, discountSheet, discountWords, pickOne, pickMany, daySheet, addDays, today, toMin, fromMin, CF_ICONS,
} from "../../core/create.js";
import { uuid } from "../../core/api.js";
import { ensureStyles, PLAN_NAMES, BILLING, BILLING_SHORT, waitRun } from "./kit.js";
import { optionTotals } from "../quotes/kit.js";
import { SOURCES } from "../contacts/kit.js";

export const FREQS = [[1, "Monthly"], [2, "Every 2 months"], [3, "Quarterly"], [4, "Every 4 months"], [6, "Bi-annual"], [12, "Annual"]];
const KEY_OF = { 1: "monthly", 3: "quarterly", 6: "biannual" };
const TEMPLATES = ["quarterly", "biannual", "monthly", "lights_annual", "custom"];
const MON = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const ORD = ["1st", "2nd", "3rd", "4th", "last"];
const DOW = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
const SVC = "Residential Window Cleaning";
const ext = (o = {}) => ({ title: "Exterior Window Cleaning", qty_milli: 1000, unit_cents: 0, service_type: SVC, scope: { type: "all" }, ...o });

async function load(params, ctx) {
  ensureStyles();
  await ensureCreateStyles();
  const q = new URLSearchParams((typeof location !== "undefined" && location.hash.split("?")[1]) || "");
  const [cat, cx, users, contact] = await Promise.all([
    ctx.api("/plans/catalog", { cache: false }).then((r) => r.data.catalog).catch(() => null),
    ctx.can("quotes:read") ? ctx.api("/pricing/context").then((r) => r.data).catch(() => null) : null,
    ctx.api("/users").then((r) => (r.data || []).filter((u) => u.status === undefined || u.status === "active")).catch(() => []),
    params.contact ? loadCustomer(ctx.api, params.contact).catch(() => null) : null,
  ]);
  const me = ctx.user && users.some((u) => u.id === ctx.user.id) ? ctx.user.id : "";
  const s = {
    cat, book: (cx && cx.book) || [], defs: ((cx && cx.discounts) || []).filter((d) => d.active !== false && d.sellable !== false && d.stack_group !== "plan" && !d.plan_only), users,
    contact, property: primaryOf(contact, q.get("property") || ""), source: contact ? contact.source : "",
    template: "", key: "biannual", tab: "service", lines: [], discounts: [], initial: "same", initLines: [],
    pending: false, freq: 6, first: addDays(today(), 1), repeats: "day", time: "", sold_by: me, people: [],
    term_months: 12, renew: true, autopay: true, billing_mode: "barta_standard", notes: "", client_id: ctx.keep.client_id || (ctx.keep.client_id = uuid()),
  };
  // the plan the customer asked about (#/plans/new/<contact>?plan=quarterly), else Quarterly: Barta's usual
  applyTemplate(s, TEMPLATES.includes(q.get("plan")) ? q.get("plan") : "quarterly");
  return s;
}

const entry = (s, key) => (s.cat && s.cat.plans && s.cat.plans[key]) || {};
const lights = (s) => s.key === "lights_annual";
function applyTemplate(s, key) {
  const e = entry(s, key);
  s.template = key;
  s.key = key;
  s.freq = lights(s) ? 12 : (e.frequency && e.frequency.interval === "month" && e.frequency.count) || { quarterly: 3, biannual: 6, monthly: 1 }[key] || 6;
  const keep = (title) => (s.lines.find((l) => l.title === title) || {}).unit_cents || 0;
  s.lines = key === "quarterly"
    ? [ext({ unit_cents: keep("Exterior Window Cleaning"), scope: { type: "specific", visits: [1, 3, 4] } }), ext({ title: "Interior Window Cleaning", unit_cents: keep("Interior Window Cleaning"), scope: { type: "specific", visits: [2] } })]
    : key === "lights_annual" ? [ext({ title: "Christmas Lights", unit_cents: keep("Christmas Lights"), service_type: "Christmas Lights" })]
      : [ext({ unit_cents: keep("Exterior Window Cleaning") })];
  const per = e.discount_per_visit_cents || 0;
  s.discounts = [...s.discounts.filter((d) => !d.plan), ...(per > 0 ? [{ name: "Plan discount", type: "fixed", value: per, scope: { type: "all" }, plan: true }] : [])];
  s.autopay = e.autopay !== false;
  s.billing_mode = e.billing || (key === "lights_annual" ? "after_visit" : "barta_standard");
  if (lights(s)) s.pending = true;
}

// The visits of the first year: their dates, from the first visit and how often.
function visitMonths(s) {
  const n = Math.max(1, Math.round(12 / s.freq));
  return Array.from({ length: n }, (_, i) => addMonths(s.first, i * s.freq).slice(0, 7));
}
function addMonths(date, n) {
  const [y, m, d] = date.split("-").map(Number);
  const t = new Date(Date.UTC(y, m - 1 + n, 1));
  const last = new Date(Date.UTC(t.getUTCFullYear(), t.getUTCMonth() + 1, 0)).getUTCDate();
  return `${t.getUTCFullYear()}-${String(t.getUTCMonth() + 1).padStart(2, "0")}-${String(Math.min(d, last)).padStart(2, "0")}`;
}
const monthsText = (s) => visitMonths(s).map((m) => MON[Number(m.slice(5, 7)) - 1]).join(", ");
const dayOf = (date) => Number(date.slice(8, 10));
const dowOf = (date) => new Date(date + "T12:00:00Z").getUTCDay();
const nth = (date) => Math.min(4, Math.floor((dayOf(date) - 1) / 7));
const suffix = (n) => (n % 10 === 1 && n !== 11 ? "st" : n % 10 === 2 && n !== 12 ? "nd" : n % 10 === 3 && n !== 13 ? "rd" : "th");
const repeatsText = (s) => (s.repeats === "weekday" ? `On the ${ORD[nth(s.first)]} ${DOW[dowOf(s.first)]}` : s.repeats === "any" ? "Any day that month" : `On the ${dayOf(s.first)}${suffix(dayOf(s.first))}`);
// The day a later visit falls on, in its month (the Repeats rule).
function visitDay(s, month) {
  const [y, m] = month.split("-").map(Number);
  const last = new Date(Date.UTC(y, m, 0)).getUTCDate();
  if (s.repeats === "weekday") {
    const want = dowOf(s.first);
    const k = nth(s.first);
    const first = (want - new Date(Date.UTC(y, m - 1, 1)).getUTCDay() + 7) % 7 + 1;
    let d = first + 7 * k;
    if (d > last || k === 4) { d = first; while (d + 7 <= last) d += 7; }
    return `${month}-${String(d).padStart(2, "0")}`;
  }
  return `${month}-${String(Math.min(dayOf(s.first), last)).padStart(2, "0")}`;
}

// The lines as the plan keeps them: "Its own line items" for the first visit.
function planLines(s) {
  const strip = ({ price_item_id, plan, ...l }) => l;
  if (s.initial !== "own" || !s.initLines.length) return s.lines.map(strip);
  const later = s.lines.map((l) => {
    const sc = l.scope || { type: "all" };
    if (sc.type === "all") return { ...l, scope: { type: "after_initial" } };
    if (sc.type === "specific") { const v = sc.visits.filter((x) => x !== 1); return v.length ? { ...l, scope: { type: "specific", visits: v } } : null; }
    return sc.type === "initial" ? null : l;
  }).filter(Boolean).map(strip);
  return [...s.initLines.map((l) => ({ ...strip(l), scope: { type: "initial" } })), ...later];
}
const vpy = (s) => (lights(s) ? 1 : Math.max(1, Math.round(12 / s.freq)));
const totals = (s) => optionTotals({ kind: "plan", plan: { visits_per_year: vpy(s), term_months: s.term_months }, lines: planLines(s), discounts: s.discounts }, 0);
const ready = (s) => !!s.contact && s.lines.length > 0 && planLines(s).every((l) => (l.unit_cents || 0) > 0) && /^\d{4}-\d{2}-\d{2}$/.test(s.first);
const scopeText = (sc) => (!sc || sc.type === "all" ? "" : sc.type === "initial" ? "First visit only" : sc.type === "after_initial" ? "After the first visit" : sc.visits.length === 1 ? `Visit ${sc.visits[0]} of the year` : `Visits ${sc.visits.join(", ")} of the year`);
const userName = (s, id) => (s.users.find((u) => u.id === id) || {}).name || "";

function servicePane(s, ctx) {
  const t = totals(s);
  const flat = new Set(t.per_visit_cents).size <= 1;
  const linesRows = (list, key) => itemRows(list.map((l, i) => ({ ...lineRowOf(l, { [key]: String(i) }), sub: [lineRowOf(l).sub, scopeText(l.scope)].filter(Boolean).join(" · ") })));
  return html`
    ${fieldLabel("Line items", { required: true, field: "lines" })}
    ${linesRows(s.lines, "cf-line")}
    ${addRow("Add line item", { data: { "cf-addline": true } })}
    ${itemRows(s.discounts.map((d, i) => ({ title: d.name || "Discount", sub: discountWords(d) + (d.plan ? " each visit" : ""), cents: null, data: { "cf-disc": String(i) } })))}
    ${addRow("Add discount", { icon: "tag", data: { "cf-adddisc": true } })}
    ${totalRow(t.first_cents, { label: flat ? "Total a visit" : "First visit", sub: `${money(t.annual_cents)} a year`, data: "plan" })}
    ${fieldLabel(html`Initial visit <span class="cf-dotsep">·</span>`, { end: html`<button type="button" class="cf-lbl-link" data-cf-initial><span>${s.initial === "own" ? "Its own line items" : "Same as the plan"}</span>${CF_ICONS.chevdown}</button>` })}
    ${s.initial === "own" ? html`${linesRows(s.initLines, "cf-initline")}${addRow("Add a first-visit line item", { data: { "cf-addinit": true } })}` : ""}
    ${fieldLabel("Service schedule", { field: "start_on", end: html`<span class="cf-lbl-end">Schedule pending${html`<button type="button" ${attrs({ class: "switch", role: "switch", "aria-checked": s.pending ? "true" : "false", "aria-label": "Schedule pending", "data-cf-pending": "", disabled: lights(s) })}></button>`}</span>` })}
    <div class="cf-card">
      ${lights(s) ? pickRow("Frequency", "Every season", { data: null, chev: "updown", muted: true }) : pickRow("Frequency", (FREQS.find(([n]) => n === s.freq) || [0, `Every ${s.freq} months`])[1], { data: { "cf-freq": true } })}
      ${pickRow("Months", monthsText(s), { data: { "cf-months": true }, chev: "chevright" })}
      ${slotRow("First visit", pillDate("start_on", s.first, { label: "First visit", long: true, min: addDays(today(), -31) }))}
      ${s.pending ? "" : pickRow("Repeats", repeatsText(s), { data: { "cf-repeats": true } })}
      ${s.pending ? "" : slotRow("Time", pillBtn(s.time ? clock(s.time) : "Anytime", { data: { "cf-time": true }, label: "Time: " + (s.time ? clock(s.time) : "Anytime") }))}
    </div>
    ${s.pending ? html`<p class="cf-hint">${lights(s) ? "Lights installs are booked from the Lights season board." : "The visits wait on the To book list for their months."}</p>` : html`<p class="cf-hint">${s.repeats === "any" ? "The first visit is booked; the others wait on the To book list." : "This term's visits are booked on those days."}</p>`}
    ${scheduleLink()}
    <div class="cf-card">
      ${pickRow("Lead source", s.source || "None", { data: { "cf-source": true }, muted: !s.source })}
      ${pickRow("Salesperson", userName(s, s.sold_by) || "Nobody", { data: { "cf-seller": true }, muted: !s.sold_by })}
      ${s.pending ? "" : pickRow("Dispatched to", s.people.length ? s.people.map((id) => userName(s, id).split(" ")[0]).join(", ") : "Nobody yet", { data: { "cf-crew": true }, muted: !s.people.length })}
    </div>
    ${notesField("notes", s.notes, { placeholder: "Add a note", label: "Notes" })}`;
}

function agreementPane(s) {
  return html`${fieldLabel("Agreement")}
    <div class="cf-card">
      ${pickRow("Agreement length", `${s.term_months} months`, { data: { "cf-term": true } })}
      ${switchRow("Renews", s.renew, { data: { "cf-renew": true }, sub: s.renew ? "For another term when this one ends" : "Ends after this term" })}
    </div>
    <p class="cf-hint">The ${PLAN_NAMES[s.key] || "plan"} agreement goes out from the plan once it's set up: Send it to sign, or sign it on this phone.</p>`;
}

function billingPane(s) {
  return html`${fieldLabel("Billing")}
    <div class="cf-card">
      ${switchRow("Auto-Pay", s.autopay, { data: { "cf-autopay": true }, sub: "Card on file" })}
      ${pickRow("Billing", BILLING_SHORT[s.billing_mode] || "Standard", { data: { "cf-billing": true } })}
    </div>
    <p class="cf-hint">${BILLING[s.billing_mode] || ""}</p>`;
}

function render(s, ctx) {
  const body = html`
    ${fieldLabel("Customer")}
    ${customerCard(s.contact, s.property)}
    ${mockupChip(lights(s) && ctx.can("office:tools"))}
    ${fieldLabel("Template")}
    <div class="cf-card">${pickRow(s.template ? `${(entry(s, s.template).name) || PLAN_NAMES[s.template]}` : "Start from a template", "", { data: { "cf-template": true }, chev: "chevdown", muted: !s.template })}</div>
    ${segIcons([["service", "Service", "service"], ["agreement", "Agreement", "doc"], ["billing", "Billing", "card"]], s.tab, { name: "plan-new", label: "New plan" })}
    <div ${attrs({ hidden: s.tab !== "service" })} class="cf-pane">${servicePane(s, ctx)}</div>
    <div ${attrs({ hidden: s.tab !== "agreement" })} class="cf-pane">${agreementPane(s)}</div>
    <div ${attrs({ hidden: s.tab !== "billing" })} class="cf-pane">${billingPane(s)}</div>`;
  return createPage({ title: "New Plan", body, form: { id: "pl-new", "data-new": true }, cta: { label: "Create Plan", disabled: !ready(s) } });
}

async function save(form, ctx) {
  const s = ctx.state;
  const err = form.querySelector("[data-form-err]");
  err.hidden = true;
  if (!ready(s)) {
    err.textContent = !s.contact ? "Pick the customer first." : !s.lines.length ? "Add a line item." : "Set the price of each line item.";
    err.hidden = false; return;
  }
  const catalogKey = lights(s) ? "lights_annual" : s.template && s.template !== "custom" && ((entry(s, s.template).frequency || {}).count === s.freq) ? s.template : KEY_OF[s.freq] || "custom";
  const body = {
    contact_id: s.contact.id, ...(s.property ? { property_id: s.property.id } : {}), catalog_key: catalogKey, ...(lights(s) ? {} : { frequency: { interval: "month", count: s.freq } }),
    lines: planLines(s), discounts: s.discounts.map(({ plan, ...d }) => d), start_on: s.first, term_months: s.term_months, auto_renew: s.renew, autopay: s.autopay,
    billing_mode: s.billing_mode, ...(s.sold_by ? { sold_by: s.sold_by } : {}), notes: s.notes, client_id: s.client_id,
  };
  const btn = form.querySelector("[data-cf-create]");
  busy(btn, true, "Setting it up…");
  try {
    const r = await ctx.api("/plans", { method: "POST", body });
    const id = r.data.plan_id;
    if (r.data.run_id) await waitRun(ctx.api, r.data.run_id);
    await saveLeadSource(ctx.api, s.contact, s.source);
    const warns = s.pending ? [] : await book(ctx, id);
    delete ctx.keep.client_id;
    toast(warns.length ? `Plan set up. ${warns[0]}` : "Plan set up. Send the agreement next.", { ms: warns.length ? 5000 : 2600 });
    ctx.go(`/plans/${encodeURIComponent(id)}`, { replace: true });
  } catch (e) {
    busy(btn, false);
    err.textContent = e.message || "That didn't save.";
    err.hidden = false;
    err.scrollIntoView({ block: "nearest" });
  }
}

// Schedule pending off: this term's visits booked as Repeats and Time say
// (the first on the first visit's day; "Any day": only the first).
async function book(ctx, planId) {
  const s = ctx.state;
  const warns = [];
  let ords = [];
  try { ords = ((await ctx.api(`/plans/${encodeURIComponent(planId)}`, { cache: false })).data.plan.ordinals || []).filter((o) => (o.term || 1) === 1 && o.job_id && o.status === "unscheduled").sort((a, b) => a.n - b.n); } catch (e) { return [`The visits weren't booked: ${e.message}`]; }
  const start = s.time || "08:00";
  const slot = { start, end: fromMin(toMin(start) + 120), window: s.time ? { type: "window", minutes: 120 } : { type: "anytime", minutes: 0 }, ...(s.time ? {} : { date_only: true }), assignee_ids: s.people };
  for (const o of ords) {
    if (o.n > 1 && s.repeats === "any") break;
    const date = o.n === 1 ? s.first : visitDay(s, addMonths(s.first, (o.n - 1) * s.freq).slice(0, 7));
    try { await ctx.api("/visits", { method: "POST", body: { ...slot, job_id: o.job_id, date, client_id: `${s.client_id}-v${o.n}` } }); } catch (e) { warns.push(`Visit ${o.n} wasn't booked: ${e.message}`); }
  }
  return warns;
}

const TIMES = Array.from({ length: 21 }, (_, i) => fromMin(7 * 60 + i * 30));

export default {
  title: "New plan",
  load,
  render,
  events: {
    "click [data-cf-close]": (e, el, ctx) => ctx.back(),
    "click [data-cf-pick]": (e, el, ctx) => choose(ctx),
    "click [data-cf-clear]": (e, el, ctx) => choose(ctx),
    "click [data-cf-prop]": async (e, el, ctx) => {
      const s = ctx.state;
      const p = await pickProperty(ctx.api, s.contact, s.property && s.property.id);
      if (p) { s.property = p; redraw(ctx); }
    },
    "click [data-cf-seg]": (e, el, ctx) => { ctx.state.tab = el.dataset.key; redraw(ctx); },
    "click [data-cf-template]": async (e, el, ctx) => {
      const s = ctx.state;
      const v = await pickOne({ title: "Start from a template", current: s.template, items: TEMPLATES.map((k) => { const x = entry(s, k); return { value: k, label: x.name || PLAN_NAMES[k], sub: k === "quarterly" ? "Exterior on visits 1, 3, 4; interior on visit 2" : x.visits_per_year ? `${x.visits_per_year} visit${x.visits_per_year === 1 ? "" : "s"} a year${x.discount_per_visit_cents ? `, ${money(x.discount_per_visit_cents)} off each` : ""}` : "" }; }) });
      if (!v) return;
      applyTemplate(s, v);
      redraw(ctx);
    },
    "click [data-cf-addline]": (e, el, ctx) => addLine(ctx, ctx.state.lines),
    "click [data-cf-addinit]": (e, el, ctx) => addLine(ctx, ctx.state.initLines),
    "click [data-cf-line]": (e, el, ctx) => editLine(ctx, ctx.state.lines, Number(el.dataset.cfLine)),
    "click [data-cf-initline]": (e, el, ctx) => editLine(ctx, ctx.state.initLines, Number(el.dataset.cfInitline)),
    "click [data-cf-adddisc]": async (e, el, ctx) => {
      const d = await discountSheet(ctx.state.defs);
      if (d && d !== "remove") { ctx.state.discounts.push({ ...d, scope: d.scope || { type: "all" } }); redraw(ctx); }
    },
    "click [data-cf-disc]": async (e, el, ctx) => {
      const s = ctx.state;
      const i = Number(el.dataset.cfDisc);
      const d = await discountSheet([], s.discounts[i]);
      if (!d) return;
      if (d === "remove") s.discounts.splice(i, 1); else s.discounts[i] = d;
      redraw(ctx);
    },
    "click [data-cf-initial]": async (e, el, ctx) => {
      const s = ctx.state;
      const v = await pickOne({ title: "Initial visit", current: s.initial, items: [{ value: "same", label: "Same as the plan" }, { value: "own", label: "Its own line items", sub: "A first visit priced on its own (the plan's start after it)" }] });
      if (v) { s.initial = v; redraw(ctx); }
    },
    "click [data-cf-pending]": (e, el, ctx) => { if (!lights(ctx.state)) { ctx.state.pending = !ctx.state.pending; redraw(ctx); } },
    "click [data-cf-freq]": async (e, el, ctx) => {
      const v = await pickOne({ title: "Frequency", current: ctx.state.freq, items: FREQS.map(([n, l]) => ({ value: n, label: l, sub: `${Math.round(12 / n)} visit${n === 12 ? "" : "s"} a year` })) });
      if (v) { ctx.state.freq = v; redraw(ctx); }
    },
    "click [data-cf-months]": async (e, el, ctx) => {
      const s = ctx.state;
      const base = today().slice(0, 7);
      const items = Array.from({ length: 12 }, (_, i) => {
        const m = addMonths(base + "-01", i).slice(0, 7);
        const first = m === base ? (s.first.slice(0, 7) === base ? s.first : addDays(today(), 1)) : `${m}-${String(Math.min(dayOf(s.first), 28)).padStart(2, "0")}`;
        return { value: first, label: monthsText({ ...s, first }), sub: `First visit in ${MON[Number(m.slice(5, 7)) - 1]}` };
      });
      const v = await pickOne({ title: "Months", current: s.first, items });
      if (v) { s.first = v; redraw(ctx); }
    },
    "click .cf-pill": (e, el) => { if (deskPointer()) openPill(el); },
    "change [data-cf-pill]": (e, el, ctx) => { pillChanged(el); if (el.name === "start_on" && el.value) ctx.state.first = el.value; redraw(ctx); },
    "click [data-cf-repeats]": async (e, el, ctx) => {
      const s = ctx.state;
      const v = await pickOne({ title: "Repeats", current: s.repeats, items: [
        { value: "day", label: `On the ${dayOf(s.first)}${suffix(dayOf(s.first))}`, sub: "The same day of each visit's month" },
        { value: "weekday", label: `On the ${ORD[nth(s.first)]} ${DOW[dowOf(s.first)]}`, sub: "The same weekday of each visit's month" },
        { value: "any", label: "Any day that month", sub: "The later visits wait on the To book list" },
      ] });
      if (v) { s.repeats = v; redraw(ctx); }
    },
    "click [data-cf-time]": async (e, el, ctx) => {
      const v = await pickOne({ title: "Time", current: ctx.state.time || "any", items: [{ value: "any", label: "Anytime", sub: "The day, no time" }, ...TIMES.map((t) => ({ value: t, label: clock(t), sub: `Arrives ${clock(t)} to ${clock(fromMin(toMin(t) + 120))}` }))] });
      if (v) { ctx.state.time = v === "any" ? "" : v; redraw(ctx); }
    },
    "click [data-cf-day]": (e, el, ctx) => { const s = ctx.state; daySheet(ctx.api, { date: s.first, ...(s.time ? { start: s.time, end: fromMin(toMin(s.time) + 120) } : {}), users: s.people }); },
    "click [data-cf-source]": async (e, el, ctx) => {
      if (!ctx.state.contact) { toast("Pick the customer first.", { bad: true }); return; }
      const v = await pickOne({ title: "Lead source", current: ctx.state.source, items: SOURCES.map((x) => ({ value: x, label: x })) });
      if (v) { ctx.state.source = v; redraw(ctx); }
    },
    "click [data-cf-seller]": async (e, el, ctx) => {
      const s = ctx.state;
      const v = await pickOne({ title: "Salesperson", current: s.sold_by || "-", items: [{ value: "-", label: "Nobody" }, ...s.users.map((u) => ({ value: u.id, label: u.name }))] });
      if (v === null) return;
      s.sold_by = v === "-" ? "" : v;
      redraw(ctx);
    },
    "click [data-cf-crew]": async (e, el, ctx) => {
      const s = ctx.state;
      const v = await pickMany({ title: "Dispatched to", picked: s.people, items: s.users.map((u) => ({ value: u.id, label: u.name, color: u.color, sub: u.is_technician ? "Technician" : "" })) });
      if (v) { s.people = v; redraw(ctx); }
    },
    "click [data-cf-term]": async (e, el, ctx) => {
      const v = await pickOne({ title: "Agreement length", current: ctx.state.term_months, items: [12, 24, 36].map((m) => ({ value: m, label: `${m} months` })) });
      if (v) { ctx.state.term_months = v; redraw(ctx); }
    },
    "click [data-cf-renew]": (e, el, ctx) => { ctx.state.renew = !ctx.state.renew; redraw(ctx); },
    "click [data-cf-autopay]": (e, el, ctx) => { ctx.state.autopay = !ctx.state.autopay; redraw(ctx); },
    "click [data-cf-billing]": async (e, el, ctx) => {
      const v = await pickOne({ title: "Billing", current: ctx.state.billing_mode, items: Object.entries(BILLING_SHORT).map(([k, l]) => ({ value: k, label: l, sub: BILLING[k] })) });
      if (v) { ctx.state.billing_mode = v; redraw(ctx); }
    },
    "input [name=notes]": (e, el, ctx) => { ctx.state.notes = el.value; },
    "submit #pl-new": (e, form, ctx) => { e.preventDefault(); save(form, ctx); },
  },
  mount(el, s) { setReady(el, ready(s)); },
};

async function addLine(ctx, list) {
  const got = await pickItem({ book: ctx.state.book });
  if (!got) return;
  let line = got.item ? lineFromItem(got.item) : null;
  if (!line || !line.unit_cents) line = await lineSheet(line);
  if (!line || line === "remove") return;
  list.push({ ...line, scope: line.scope || { type: "all" } });
  redraw(ctx);
}
async function editLine(ctx, list, i) {
  const got = await lineSheet(list[i]);
  if (!got) return;
  if (got === "remove") list.splice(i, 1); else list[i] = got;
  redraw(ctx);
}

async function choose(ctx) {
  const s = ctx.state;
  const c = await pickCustomer(ctx.api, { title: "Customer", lifecycle: "customer" });
  if (!c) return;
  s.contact = c;
  s.property = primaryOf(c);
  s.source = c.source || "";
  redraw(ctx);
}
