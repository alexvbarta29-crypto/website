// Pieces the quotes screens share (M3a): the module's stylesheet, words
// for statuses, scopes and plans, the option totals the builder shows while
// you type (the same integer math as the server's engine, which recomputes
// everything on save), and the line and discount rows. No data here, only
// how things read (design §2.3).

import { html, icon } from "../../core/ui.js";
import { money, dateShort, ago } from "../../core/format.js";

let styled = false;
export function ensureStyles() {
  if (styled || typeof document === "undefined") return;
  styled = true;
  const l = document.createElement("link");
  l.rel = "stylesheet";
  l.href = "/crm-app/modules/quotes/quotes.css";
  document.head.appendChild(l);
}

// ------------------------------------------------------------ words

export const STATUS = { draft: "Draft", sent: "Sent", viewed: "Viewed", changes_requested: "Changes asked", approved: "Approved", converted: "Booked", declined: "Declined", archived: "Archived" };
const STATUS_CLASS = { draft: "", sent: "blue", viewed: "blue", changes_requested: "amber", approved: "green", converted: "green", declined: "red", archived: "" };
export const statusPill = (st) => html`<span class="${"pill " + (STATUS_CLASS[st] || "")}">${STATUS[st] || st}</span>`;
export const CHIPS = [["open", "Open"], ["draft", "Draft"], ["sent", "Sent"], ["viewed", "Viewed"], ["changes_requested", "Changes"], ["approved", "Approved"], ["converted", "Booked"], ["declined", "Declined"], ["archived", "Archived"]];
export const OPEN = ["draft", "sent", "viewed", "changes_requested", "approved"];

export const PLAN_NAMES = { biannual: "Biannual", quarterly: "Quarterly", monthly: "Monthly", lights_annual: "Christmas lights", custom: "Custom" };
export const PLAN_FREQ = { biannual: "2 visits a year", quarterly: "3 exterior + 1 interior a year", monthly: "12 visits a year", lights_annual: "Every season", custom: "" };
export const BILLING = [{ value: "barta_standard", label: "First visit when done, then the 1st of each month" }, { value: "after_visit", label: "After each visit" }, { value: "first_of_month", label: "The 1st of each visit's month" }];
export const WINDOW_TYPES = [["standard", "Standard pane"], ["slider", "Slider (2)"], ["large", "Large pane (2)"], ["sliding_door", "Sliding door (2)"], ["french", "French pane (0.4)"], ["front_door", "Front door"], ["garage_small", "Small garage pane (free)"]];
export const SERVICES = [["windows_ext", "Exterior windows"], ["windows_int", "Interior windows"], ["screens", "Screens"], ["tracks_standard", "Track detailing"], ["tracks_premium", "Premium tracks"], ["gutters", "Gutters"]];
export const WARNINGS = {
  count_screens_on_site: "Screens are estimated at half the panes: count them on site.",
  confirm_panes_on_site: "Priced from square feet: confirm the panes on site.",
  over_100_panes: "Over 100 panes: price the exterior by hand.",
  over_100_panes_interior: "Over 100 panes: price the interior by hand.",
  over_sqft_price_by_hand: "Over 7,999 sq ft: price it by hand.",
  price_gutters: "Gutters are priced by hand ($100 to $299 is typical).",
  count_tracks: "Add how many tracks.",
  early_bird_over: "The Early Bird deadline has passed.",
  add_runs_or_package: "Add the runs in feet, or a package price.",
};
export const warningText = (w) => WARNINGS[w] || w;

export function scopeWords(scope) {
  if (!scope || scope.type === "all") return "Every visit";
  if (scope.type === "initial") return "First visit only";
  if (scope.type === "after_initial") return "After the first visit";
  const v = scope.visits || [];
  return v.length === 1 ? `Visit ${v[0]} only` : `Visits ${v.join(", ")}`;
}
// "1, 3, 4" → { type: "specific", visits: [1,3,4] } (or null)
export function parseVisits(text) {
  const v = [...new Set(String(text || "").split(/[^0-9]+/).filter(Boolean).map(Number).filter((n) => n >= 1 && n <= 120))].sort((a, b) => a - b);
  return v.length ? { type: "specific", visits: v } : null;
}

export const qtyText = (milli) => { const q = (milli || 0) / 1000; return Number.isInteger(q) ? String(q) : String(Math.round(q * 1000) / 1000); };
export const toMilli = (s) => { const n = Number(String(s || "").replace(/,/g, "")); return Number.isFinite(n) && n >= 0 ? Math.round(n * 1000) : null; };

// ------------------------------------------------------------ the engine's arithmetic (integer cents)

const rhu = (num, den) => { const neg = num < 0; const a = Math.abs(num); const q = Math.floor((a * 2 + den) / (den * 2)); return neg ? -q : q; };
export const lineTotal = (l) => (l && l.override && Number.isInteger(l.override.cents) ? l.override.cents : rhu((l.unit_cents || 0) * (Number.isInteger(l.qty_milli) ? l.qty_milli : 1000), 1000));
export const covers = (scope, k) => { const t = scope && scope.type; if (!t || t === "all") return true; if (t === "initial") return k === 1; if (t === "after_initial") return k > 1; if (t === "specific") return (scope.visits || []).includes(k); return false; };
const selected = (l) => (l.optional ? l.selected === true : true);
export function visitsOf(o) {
  if (!o || o.kind !== "plan" || !o.plan) return { term: 1, year: 1 };
  const year = Math.max(1, Math.min(52, o.plan.visits_per_year || 1));
  const months = Math.max(1, Math.min(60, o.plan.term_months || 12));
  return { term: Math.max(1, Math.round((year * months) / 12)), year };
}
export function optionTotals(o, floor = 0) {
  const v = visitsOf(o);
  const per = [];
  for (let k = 1; k <= v.term; k++) {
    const base = (o.lines || []).filter((l) => selected(l) && covers(l.scope, k)).reduce((s, l) => s + lineTotal(l), 0);
    let bp = 0, fixed = 0;
    for (const d of o.discounts || []) { if (!covers(d.scope, k)) continue; if (d.type === "percentage") bp += d.value || 0; else fixed += d.value || 0; }
    bp = Math.min(10000, bp);
    per.push(Math.max(Math.min(floor, base), base - rhu(base * bp, 10000) - fixed));
  }
  return { first_cents: per[0], per_visit_cents: per, term_cents: per.reduce((a, b) => a + b, 0), annual_cents: per.slice(0, v.year).reduce((a, b) => a + b, 0) };
}

// The headline price of an option.
export function headline(o) {
  const t = o.totals || optionTotals(o);
  if (o.kind !== "plan") return { main: money(t.first_cents), unit: "total" };
  const per = t.per_visit_cents || [];
  const flat = per.length > 0 && per.every((x) => x === per[0]);
  return flat ? { main: money(per[0]), unit: "a visit", sub: `${money(t.annual_cents)} a year` } : { main: money(t.first_cents), unit: "first visit", sub: `${money(t.annual_cents)} a year` };
}

export const discountText = (d) => (d.type === "percentage" ? `${d.value / 100}% off` : `−${money(d.value)}`);

// ------------------------------------------------------------ rows

export const optionSummary = (o) => html`<section class="card qt-opt">
  <div class="qt-opt-h"><div class="who"><span class="nm">${o.recommended ? html`<span class="qt-rec">Recommended</span>` : ""}${o.name}</span>${o.kind === "plan" && o.plan ? html`<span class="sub">${PLAN_FREQ[o.plan.catalog_key] || ""}${o.plan.term_months ? ` · ${o.plan.term_months} months` : ""}</span>` : ""}</div>
  <div class="qt-price num"><b>${headline(o).main}</b><small>${headline(o).unit}</small></div></div>
  <ul class="qt-lines">${(o.lines || []).map((l) => html`<li><span class="t">${l.title}${l.optional ? html` <small>(add-on)</small>` : ""}${l.scope && l.scope.type !== "all" ? html`<small class="sc">${scopeWords(l.scope)}</small>` : ""}${l.override ? html`<small class="ov">${l.override.reason}</small>` : ""}</span><span class="p num">${lineTotal(l) === 0 ? "Included" : money(lineTotal(l))}</span></li>`)}
  ${(o.discounts || []).map((d) => html`<li class="d"><span class="t">${d.name}${d.scope && d.scope.type !== "all" ? html`<small class="sc">${scopeWords(d.scope)}</small>` : ""}</span><span class="p num">${discountText(d)}</span></li>`)}</ul>
  ${o.kind === "plan" && o.totals && o.totals.per_visit_cents && new Set(o.totals.per_visit_cents).size > 1 ? html`<p class="small muted qt-visits">${o.totals.per_visit_cents.slice(0, visitsOf(o).year).map((c, i) => `Visit ${i + 1}: ${money(c)}`).join(" · ")}</p>` : ""}
</section>`;

export function quoteRow(r) {
  const bits = [r.cn || "No name"];
  return html`<li><a class="row" href="${"#/quotes/" + encodeURIComponent(r.id)}">
    <span class="ico">${icon("doc")}</span>
    <span class="who"><span class="nm">${bits[0]}</span><span class="sub">${r.n}${r.sent ? ` · sent ${ago(r.sent)}` : ` · made ${dateShort(r.at || r.u)}`}${r.viewed ? ` · viewed ${ago(r.viewed)}` : ""}</span></span>
    <span class="end"><span class="qt-amt num">${r.first !== null && r.first !== undefined ? money(r.first) : ""}</span>${statusPill(r.st)}<span class="chev" aria-hidden="true"></span></span></a></li>`;
}

export const emptyCard = (title, text) => html`<div class="card empty"><div class="art">${icon("doc")}</div><h2>${title}</h2><p>${text}</p></div>`;

// Follows a run until it finishes (GET /runs/:id). → the run, or null after ~30 s.
export async function waitRun(api, id, { tries = 30, every = 1000 } = {}) {
  for (let i = 0; i < tries; i++) {
    try {
      const r = await api(`/runs/${encodeURIComponent(id)}`, { cache: false });
      if (r.data && ["done", "failed", "cancelled"].includes(r.data.status)) return r.data;
    } catch (e) { if (e.status && e.status !== 503) throw e; }
    await new Promise((ok) => setTimeout(ok, every));
  }
  return null;
}
