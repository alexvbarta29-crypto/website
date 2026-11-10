// Quotes module: the Barta pricing engine (design §5.3, barta-rules §1.9,
// decisions D15, D26, D30). Pure: no I/O, integer cents only, every number
// a setting (Settings → Pricing & price book), so an owner's change is a
// setting, never a code change. One source per number: the tiers, plan
// discounts and lights offers live in cfg/pricing; the add-ons priced per
// unit (screens, standard and premium tracks, lights install and materials
// per foot) are their price-book items (cfg's copies are only a fallback
// for a book without that item).
//
// The engine PROPOSES; people OVERRIDE (one tap with a reason, prices:override)
// and nothing imported is ever repriced (C3, R7).
//
//   paneCount(windows, pricing)            window types × counts → panes (Barta weights, rounded up)
//   exteriorCents(panes, pricing)          the exterior tier, or { manual } over 100 panes
//   interiorCents(panes, pricing)          $80 per 20-pane segment, or { manual } over 100 panes
//   tierFromSqft(sqft, pricing)            phone quotes: square feet → the pane tier ("confirm panes on site")
//   suggestLines(input, pricing, book)     a service checklist → engine-priced lines (+ warnings)
//   suggestOption(input, pricing, book, defs)  the same for an option, with a plan's scopes and discount
//   lightsLines(input, pricing)            per foot (install $8 + materials $2) or one package line
//   lightsDiscounts(input, pricing)        Early Bird 50% before the deadline in effect, then 3-year $100
//   lineTotal(line)                        override, else roundHalfUp(qty_milli × unit_cents, 1000)
//   visitPrices(option, n, pricing)        per-visit prices of a term: percentages first, then fixed, never below the floor
//   optionTotals(option, pricing)          visitPrices for an option (one-time: 1 visit; plan: its term)
//   covers(scope, k), planDiscountFor(key, pricing), earlyBirdDeadline(on, pricing)
//   addOnUnit(book, key, pricing)          an add-on's unit price: its price-book item (cfg only without one)
//   earlyBirdOver(discount, today, pricing) an Early Bird discount whose deadline has passed
//   checkSizes(option)                     refuses amounts no quote has (a 400, never an overflow)

import { roundHalfUp, sumCents } from "../../core/money.mjs";
import { InputError } from "../../core/errors.mjs";
import { isPlainObject } from "../../core/validate.mjs";

// ------------------------------------------------------------ settings (cfg/pricing)

export const PRICING_DEFAULTS = Object.freeze({
  exterior_tiers: [{ max_panes: 20, cents: 27500 }, { max_panes: 40, cents: 29500 }, { max_panes: 60, cents: 39500 }, { max_panes: 80, cents: 49500 }, { max_panes: 100, cents: 59500 }],
  over_100_panes: "manual",
  sqft_tiers: [{ max_sqft: 2499, max_panes: 20 }, { max_sqft: 3499, max_panes: 40 }, { max_sqft: 4999, max_panes: 60 }, { max_sqft: 6499, max_panes: 80 }, { max_sqft: 7999, max_panes: 100 }],
  over_7999_sqft: "manual",
  interior: { segment_panes: 20, per_segment_cents: 8000, max_panes: 100 },
  screens: { each_cents: 500, estimate_ratio: 0.5 },
  tracks: { standard_cents: 800, premium_cents: 1500 },
  gutters: { mode: "manual", hint_cents: [10000, 29900] },
  pane_weights: { standard: 1, slider: 2, large: 2, sliding_door: 2, french: 0.4, front_door: 1, garage_small: 0 },
  pane_rounding: "ceil",
  plan_discount_per_visit_cents: { biannual: 5000, quarterly: 10000, monthly: 15000 },
  lights: {
    install_per_ft_cents: 800, materials_per_ft_cents: 200, early_bird_bp: 5000, season_start: "09-01",
    deadlines: { 2026: ["2026-11-01", "2026-12-01"] }, three_year_off_cents: 10000, colors: ["warm_white", "red", "green"], client_cap: null,
  },
  discount_floor_cents: 0,
  tax_bp: 0,
  // the quote's own settings (design §5.3 "sent + 30 days (setting)" and cfg/portal.auto_convert, kept here: see docs)
  quote_expiry_days: 30,
  auto_convert: true,
});

export const WINDOW_TYPES = Object.freeze(["standard", "slider", "large", "sliding_door", "french", "front_door", "garage_small"]);
export const PLAN_CATALOG = Object.freeze({
  biannual: { name: "Biannual plan", frequency: { interval: "month", count: 6 }, visits_per_year: 2, term_months: 12 },
  quarterly: { name: "Quarterly plan", frequency: { interval: "month", count: 3 }, visits_per_year: 4, term_months: 12 },
  monthly: { name: "Monthly plan", frequency: { interval: "month", count: 1 }, visits_per_year: 12, term_months: 12 },
  lights_annual: { name: "Christmas lights plan", frequency: { interval: "year", count: 1 }, visits_per_year: 1, term_months: 12 },
  custom: { name: "Custom plan", frequency: { interval: "month", count: 6 }, visits_per_year: 2, term_months: 12 },
});
export const PLAN_KEYS = Object.freeze(Object.keys(PLAN_CATALOG));
export const COLORS = Object.freeze({ warm_white: "warm white", red: "red", green: "green" });

const isInt = (v) => Number.isSafeInteger(v);
const posInt = (v) => (isInt(v) && v > 0 ? v : 0);
const fail = (msg, field) => { throw new InputError(msg, field); };
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

// The cfg/pricing validator: known fields only, every number checked.
export function validatePricing(v) {
  const src = isPlainObject(v) ? v : {};
  const out = {};
  const cents = (x, f, max = 10000000) => { if (!isInt(x) || x < 0 || x > max) fail(`Use whole cents from 0 to ${max}.`, f); return x; };
  if (src.exterior_tiers !== undefined) {
    if (!Array.isArray(src.exterior_tiers) || !src.exterior_tiers.length || src.exterior_tiers.length > 12) fail("Between 1 and 12 tiers.", "exterior_tiers");
    out.exterior_tiers = src.exterior_tiers.map((t, i) => {
      if (!isPlainObject(t) || !isInt(t.max_panes) || t.max_panes < 1 || t.max_panes > 1000) fail("Each tier needs its top pane count.", `exterior_tiers.${i}.max_panes`);
      return { max_panes: t.max_panes, cents: cents(t.cents, `exterior_tiers.${i}.cents`) };
    }).sort((a, b) => a.max_panes - b.max_panes);
    if (new Set(out.exterior_tiers.map((t) => t.max_panes)).size !== out.exterior_tiers.length) fail("Two tiers have the same pane count.", "exterior_tiers");
  }
  if (src.sqft_tiers !== undefined) {
    if (!Array.isArray(src.sqft_tiers) || !src.sqft_tiers.length || src.sqft_tiers.length > 12) fail("Between 1 and 12 tiers.", "sqft_tiers");
    out.sqft_tiers = src.sqft_tiers.map((t, i) => {
      if (!isPlainObject(t) || !isInt(t.max_sqft) || t.max_sqft < 1 || t.max_sqft > 100000 || !isInt(t.max_panes) || t.max_panes < 1 || t.max_panes > 1000) fail("Each tier needs its top square feet and panes.", `sqft_tiers.${i}`);
      return { max_sqft: t.max_sqft, max_panes: t.max_panes };
    }).sort((a, b) => a.max_sqft - b.max_sqft);
  }
  if (src.interior !== undefined) {
    const x = isPlainObject(src.interior) ? src.interior : fail("Expected the interior settings.", "interior");
    if (!isInt(x.segment_panes) || x.segment_panes < 1 || x.segment_panes > 200) fail("Panes per segment: 1 to 200.", "interior.segment_panes");
    if (!isInt(x.max_panes) || x.max_panes < 1 || x.max_panes > 1000) fail("Most panes: 1 to 1000.", "interior.max_panes");
    out.interior = { segment_panes: x.segment_panes, per_segment_cents: cents(x.per_segment_cents, "interior.per_segment_cents"), max_panes: x.max_panes };
  }
  if (src.screens !== undefined) {
    const x = isPlainObject(src.screens) ? src.screens : fail("Expected the screen settings.", "screens");
    if (typeof x.estimate_ratio !== "number" || !(x.estimate_ratio >= 0 && x.estimate_ratio <= 2)) fail("A ratio from 0 to 2.", "screens.estimate_ratio");
    out.screens = { each_cents: cents(x.each_cents, "screens.each_cents", 100000), estimate_ratio: x.estimate_ratio };
  }
  if (src.tracks !== undefined) {
    const x = isPlainObject(src.tracks) ? src.tracks : fail("Expected the track settings.", "tracks");
    out.tracks = { standard_cents: cents(x.standard_cents, "tracks.standard_cents", 100000), premium_cents: cents(x.premium_cents, "tracks.premium_cents", 100000) };
  }
  if (src.gutters !== undefined) {
    const x = isPlainObject(src.gutters) ? src.gutters : fail("Expected the gutter settings.", "gutters");
    const hint = Array.isArray(x.hint_cents) && x.hint_cents.length === 2 ? x.hint_cents.map((c, i) => cents(c, `gutters.hint_cents.${i}`)) : [10000, 29900];
    out.gutters = { mode: "manual", hint_cents: hint };
  }
  if (src.pane_weights !== undefined) {
    const x = isPlainObject(src.pane_weights) ? src.pane_weights : fail("Expected the pane weights.", "pane_weights");
    out.pane_weights = {};
    for (const k of WINDOW_TYPES) {
      if (x[k] === undefined) continue;
      if (typeof x[k] !== "number" || !(x[k] >= 0 && x[k] <= 10)) fail("A weight from 0 to 10.", `pane_weights.${k}`);
      out.pane_weights[k] = Math.round(x[k] * 1000) / 1000;
    }
  }
  if (src.pane_rounding !== undefined) {
    if (!["ceil", "round", "floor"].includes(src.pane_rounding)) fail("Round up, to the nearest, or down.", "pane_rounding");
    out.pane_rounding = src.pane_rounding;
  }
  if (src.plan_discount_per_visit_cents !== undefined) {
    const x = isPlainObject(src.plan_discount_per_visit_cents) ? src.plan_discount_per_visit_cents : fail("Expected the plan discounts.", "plan_discount_per_visit_cents");
    out.plan_discount_per_visit_cents = {};
    for (const k of ["biannual", "quarterly", "monthly"]) if (x[k] !== undefined) out.plan_discount_per_visit_cents[k] = cents(x[k], `plan_discount_per_visit_cents.${k}`, 100000);
  }
  if (src.lights !== undefined) {
    const x = isPlainObject(src.lights) ? src.lights : fail("Expected the lights settings.", "lights");
    const l = {};
    for (const k of ["install_per_ft_cents", "materials_per_ft_cents", "three_year_off_cents"]) if (x[k] !== undefined) l[k] = cents(x[k], `lights.${k}`, 1000000);
    if (x.early_bird_bp !== undefined) { if (!isInt(x.early_bird_bp) || x.early_bird_bp < 0 || x.early_bird_bp > 10000) fail("Basis points from 0 to 10000 (5000 = 50%).", "lights.early_bird_bp"); l.early_bird_bp = x.early_bird_bp; }
    if (x.season_start !== undefined) { if (!/^(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])$/.test(String(x.season_start))) fail("Use a month and day like 09-01.", "lights.season_start"); l.season_start = x.season_start; }
    if (x.deadlines !== undefined) {
      if (!isPlainObject(x.deadlines)) fail("Expected deadlines per season.", "lights.deadlines");
      l.deadlines = {};
      for (const [year, list] of Object.entries(x.deadlines)) {
        if (!/^\d{4}$/.test(year) || !Array.isArray(list) || list.length > 6) fail("Deadlines are listed per season year.", "lights.deadlines");
        l.deadlines[year] = list.map((d, i) => { if (!DATE_RE.test(String(d)) || !String(d).startsWith(year)) fail("Use dates like 2026-12-01 in that season.", `lights.deadlines.${year}.${i}`); return d; }).sort();
      }
    }
    if (x.colors !== undefined) {
      if (!Array.isArray(x.colors) || !x.colors.length || x.colors.some((c) => !Object.hasOwn(COLORS, c))) fail("Pick from warm white, red and green.", "lights.colors");
      l.colors = [...new Set(x.colors)];
    }
    if (x.client_cap !== undefined) { if (x.client_cap !== null && (!isInt(x.client_cap) || x.client_cap < 0 || x.client_cap > 10000)) fail("A whole number, or empty.", "lights.client_cap"); l.client_cap = x.client_cap; }
    out.lights = l;
  }
  if (src.discount_floor_cents !== undefined) out.discount_floor_cents = cents(src.discount_floor_cents, "discount_floor_cents", 1000000);
  if (src.tax_bp !== undefined) { if (src.tax_bp !== 0) fail("Barta charges no sales tax.", "tax_bp"); out.tax_bp = 0; }
  if (src.quote_expiry_days !== undefined) { if (!isInt(src.quote_expiry_days) || src.quote_expiry_days < 1 || src.quote_expiry_days > 365) fail("A whole number of days from 1 to 365.", "quote_expiry_days"); out.quote_expiry_days = src.quote_expiry_days; }
  if (src.auto_convert !== undefined) { if (typeof src.auto_convert !== "boolean") fail("Yes or no.", "auto_convert"); out.auto_convert = src.auto_convert; }
  for (const k of ["over_100_panes", "over_7999_sqft"]) if (src[k] !== undefined) { if (src[k] !== "manual") fail("Above the last tier is priced by hand.", k); out[k] = "manual"; }
  return out;
}

// cfg/pricing merged over the defaults (the store already merges; this keeps the engine safe with a partial object).
export function pricingWith(p) {
  const d = PRICING_DEFAULTS;
  const x = isPlainObject(p) ? p : {};
  return {
    ...d, ...x,
    interior: { ...d.interior, ...(x.interior || {}) }, screens: { ...d.screens, ...(x.screens || {}) }, tracks: { ...d.tracks, ...(x.tracks || {}) },
    gutters: { ...d.gutters, ...(x.gutters || {}) }, pane_weights: { ...d.pane_weights, ...(x.pane_weights || {}) },
    plan_discount_per_visit_cents: { ...d.plan_discount_per_visit_cents, ...(x.plan_discount_per_visit_cents || {}) },
    lights: { ...d.lights, ...(x.lights || {}), deadlines: { ...((x.lights && x.lights.deadlines) || d.lights.deadlines) } },
  };
}

// ------------------------------------------------------------ panes and tiers

// window types × counts → panes. Weights are kept as thousandths so 0.4 × 3
// is exactly 1.2; fractional counts round up (D26, barta-rules Q4).
export function paneCount(windows, pricing) {
  const p = pricingWith(pricing);
  let milli = 0;
  for (const w of Array.isArray(windows) ? windows : []) {
    const qty = posInt(w && w.qty);
    if (!qty) continue;
    const weight = Object.hasOwn(p.pane_weights, w.type) ? p.pane_weights[w.type] : 1;
    milli += Math.round(Number(weight) * 1000) * qty;
  }
  const r = p.pane_rounding;
  const panes = r === "floor" ? Math.floor(milli / 1000) : r === "round" ? roundHalfUp(milli, 1000) : Math.ceil(milli / 1000);
  return { panes, raw: milli / 1000 };
}

const extTiers = (p) => [...p.exterior_tiers].sort((a, b) => a.max_panes - b.max_panes);
const sqftTiers = (p) => [...p.sqft_tiers].sort((a, b) => a.max_sqft - b.max_sqft);

// "Up to 40 Panes (2500 - 3499 Sqft)": Rotor's tier labels (rotor-money §2).
export function tierLabel(maxPanes, pricing) {
  const p = pricingWith(pricing);
  const sq = sqftTiers(p);
  const i = sq.findIndex((t) => t.max_panes === maxPanes);
  if (i < 0) return `Up to ${maxPanes} Panes`;
  const lo = i === 0 ? 0 : sq[i - 1].max_sqft + 1;
  return `Up to ${maxPanes} Panes (${lo} - ${sq[i].max_sqft} Sqft)`;
}

export function exteriorCents(panes, pricing) {
  const p = pricingWith(pricing);
  const n = Math.max(0, isInt(panes) ? panes : Math.ceil(Number(panes) || 0));
  const tier = extTiers(p).find((t) => n <= t.max_panes);
  if (!tier) return { manual: true, reason: "over_100_panes" };
  return { cents: tier.cents, tier: tierLabel(tier.max_panes, p), max_panes: tier.max_panes };
}

// $80 per 20-pane segment (barta-rules §1.1): 8000 × ceil(panes / 20).
export function interiorCents(panes, pricing) {
  const p = pricingWith(pricing);
  const n = Math.max(0, isInt(panes) ? panes : Math.ceil(Number(panes) || 0));
  if (n > p.interior.max_panes) return { manual: true, reason: "over_100_panes" };
  const segments = Math.ceil(n / p.interior.segment_panes);
  return { cents: segments * p.interior.per_segment_cents, tier: `Up to ${segments * p.interior.segment_panes} Panes`, segments };
}

// Phone quotes (§5.3 "By square feet"): 0-2499 → 20 panes ... 6500-7999 → 100; larger → manual.
export function tierFromSqft(sqft, pricing) {
  const p = pricingWith(pricing);
  const n = Number(sqft);
  if (!Number.isFinite(n) || n < 0) return { manual: true, reason: "no_sqft" };
  const s = Math.ceil(n);
  const tier = sqftTiers(p).find((t) => s <= t.max_sqft);
  if (!tier) return { manual: true, reason: "over_sqft" };
  return { max_panes: tier.max_panes, pane_estimate: tier.max_panes, label: tierLabel(tier.max_panes, p), warning: "confirm panes on site" };
}

export function screenEstimate(panesExt, pricing) {
  const p = pricingWith(pricing);
  const ratioMilli = Math.round(Number(p.screens.estimate_ratio) * 1000);
  return roundHalfUp(Math.max(0, posInt(panesExt)) * ratioMilli, 1000);
}

// ------------------------------------------------------------ lines and scopes

export const covers = (scope, k) => {
  const t = scope && scope.type;
  if (!t || t === "all") return true;
  if (t === "initial") return k === 1;
  if (t === "after_initial") return k > 1;
  if (t === "specific") return Array.isArray(scope.visits) && scope.visits.includes(k);
  return false;
};

export function lineTotal(line) {
  if (line && line.override && isInt(line.override.cents)) return line.override.cents;
  const unit = isInt(line && line.unit_cents) ? line.unit_cents : 0;
  const qty = isInt(line && line.qty_milli) ? line.qty_milli : 1000;
  return roundHalfUp(BigInt(unit) * BigInt(qty), 1000n);
}

// Optional lines count only when chosen; every other line counts.
export const isSelected = (line) => (line && line.optional ? line.selected === true : !(line && line.selected === false && line.optional));

// pctOf(c, bp) = roundHalfUp(c × bp, 10000): 24310 at 15% → 3647 off.
export const pctOf = (c, bp) => roundHalfUp(BigInt(c) * BigInt(bp), 10000n);

// Per-visit prices of a term (verified against Rotor: quote.total = visit_1,
// plan sale_value = Σ visits). → { per_visit_cents, first_cents, term_cents, annual_cents }
export function visitPrices({ lines = [], discounts = [] } = {}, visitsInTerm = 1, pricing = {}, { per_year } = {}) {
  const p = pricingWith(pricing);
  const N = Math.max(1, Math.min(120, posInt(visitsInTerm) || 1));
  const floor = isInt(p.discount_floor_cents) ? p.discount_floor_cents : 0;
  const per = [];
  for (let k = 1; k <= N; k++) {
    const base = sumCents(lines.filter((l) => isSelected(l) && covers(l.scope, k)).map((l) => (isInt(l.total_cents) ? l.total_cents : lineTotal(l))));
    let bp = 0;
    let fixed = 0;
    for (const d of discounts || []) {
      if (!d || !covers(d.scope, k)) continue;
      // a discount tied to a line (10 free screens on an add-on) counts only when that line does
      if (d.line_id && !lines.some((l) => l.id === d.line_id && isSelected(l) && covers(l.scope, k))) continue;
      if (d.type === "percentage") bp += posInt(d.value);
      else fixed += posInt(d.value);
    }
    bp = Math.min(10000, bp);
    per.push(Math.max(Math.min(floor, base), base - pctOf(base, bp) - fixed));
  }
  const yearN = Math.max(1, Math.min(N, posInt(per_year) || N));
  return { per_visit_cents: per, first_cents: per[0], term_cents: sumCents(per), annual_cents: sumCents(per.slice(0, yearN)) };
}

// How many visits an option's term holds, and how many fall in a year.
export function visitsOf(option) {
  if (!option || option.kind !== "plan" || !option.plan) return { term: 1, year: 1 };
  const year = Math.max(1, Math.min(52, posInt(option.plan.visits_per_year) || 1));
  const months = Math.max(1, Math.min(60, posInt(option.plan.term_months) || 12));
  return { term: Math.max(1, Math.round((year * months) / 12)), year };
}

export function optionTotals(option, pricing) {
  const v = visitsOf(option);
  const lines = (option.lines || []).map((l) => ({ ...l, total_cents: lineTotal(l) }));
  const t = visitPrices({ lines, discounts: option.discounts || [] }, v.term, pricing, { per_year: v.year });
  return { first_cents: t.first_cents, per_visit_cents: t.per_visit_cents, term_cents: t.term_cents, annual_cents: t.annual_cents };
}

// ------------------------------------------------------------ discounts

export function planDiscountFor(planKey, pricing, defs = []) {
  const p = pricingWith(pricing);
  const cents = p.plan_discount_per_visit_cents[planKey];
  if (!isInt(cents) || cents <= 0) return null;
  const def = (defs || []).find((d) => d && d.key === `plan_${planKey}`);
  const name = def ? def.name : `${PLAN_CATALOG[planKey] ? PLAN_CATALOG[planKey].name.replace(/ plan$/, "") : "Plan"} discount`;
  return { id: `dc_plan_${planKey}`, ...(def ? { def_id: def.id, key: def.key } : { key: `plan_${planKey}` }), name, type: "fixed", value: cents, scope: { type: "all" }, stack_group: "plan" };
}

// The Early Bird deadline in effect on a date (§5.3 expires_on, D30): the
// first season deadline on or after it, from the season start. Else null.
export function earlyBirdDeadline(on, pricing) {
  const p = pricingWith(pricing);
  const d = String(on || "").slice(0, 10);
  if (!DATE_RE.test(d)) return null;
  const year = d.slice(0, 4);
  if (d < `${year}-${p.lights.season_start}`) return null;
  const list = (p.lights.deadlines && p.lights.deadlines[year]) || [];
  return [...list].sort().find((x) => x >= d) || null;
}

// Early Bird 50% (before the deadline in effect `on`), then 3-year $100
// (percentages apply first, then fixed: the engine's order, D30).
export function lightsDiscounts({ early_bird = false, three_year = false, on } = {}, pricing = {}, defs = []) {
  const p = pricingWith(pricing);
  const out = [];
  const def = (k) => (defs || []).find((d) => d && d.key === k);
  if (early_bird) {
    const deadline = earlyBirdDeadline(on, p);
    if (deadline && p.lights.early_bird_bp > 0) {
      const d = def("early_bird");
      out.push({ id: "dc_early_bird", ...(d ? { def_id: d.id } : {}), key: "early_bird", name: d ? d.name : "Early Bird", type: "percentage", value: p.lights.early_bird_bp, scope: { type: "initial" }, offer_until: deadline });
    }
  }
  if (three_year && p.lights.three_year_off_cents > 0) {
    const d = def("three_year");
    out.push({ id: "dc_three_year", ...(d ? { def_id: d.id } : {}), key: "three_year", name: d ? d.name : "3-year contract", type: "fixed", value: p.lights.three_year_off_cents, scope: { type: "initial" } });
  }
  return out;
}

// An Early Bird discount (key early_bird, or one with offer_until) whose
// deadline has passed on `today`: its own offer_until, or no deadline in
// effect any more (barta-rules: "Deal Ends December 1st").
export const isEarlyBird = (d) => !!d && (d.key === "early_bird" || !!d.offer_until);
export function earlyBirdOver(d, today, pricing) {
  if (!isEarlyBird(d)) return false;
  const day = String(today || "").slice(0, 10);
  if (d.offer_until && d.offer_until < day) return true;
  return !earlyBirdDeadline(day, pricing);
}

// The 3-year contract discount is for a lights plan (several seasons), never one season.
export const isThreeYear = (d) => !!d && d.key === "three_year";

// Amounts no quote has: a line over $1,000,000, an option over $10,000,000 a
// visit. Checked before any sum, so a hostile body is a 400, not an overflow.
export const MAX_LINE_CENTS = 100000000;
export function checkSizes(option, field = "option") {
  let visit = 0;
  const lines = option && Array.isArray(option.lines) ? option.lines : [];
  for (const [i, l] of lines.entries()) {
    const unit = Math.abs(Number(l && l.unit_cents) || 0);
    const qty = Math.abs(Number((l && l.qty_milli) ?? 1000) || 0);
    const ov = l && l.override && Number.isFinite(Number(l.override.cents)) ? Math.abs(Number(l.override.cents)) : null;
    const t = ov !== null ? ov : (unit * qty) / 1000;
    if (!Number.isFinite(t) || t > MAX_LINE_CENTS) throw new InputError("That line is more than a quote holds. Check the quantity and price.", `${field}.lines.${i}`);
    visit += t;
  }
  if (visit > MAX_LINE_CENTS * 10) throw new InputError("That option is more than a quote holds.", `${field}.lines`);
}

// ------------------------------------------------------------ suggestions

// An add-on's unit price (one source, D26): the active price-book item's,
// cfg/pricing's copy only when the book has no such item.
const ADDON_CFG = Object.freeze({
  screens: (p) => p.screens.each_cents, tracks_standard: (p) => p.tracks.standard_cents, tracks_premium: (p) => p.tracks.premium_cents,
  lights_install: (p) => p.lights.install_per_ft_cents, lights_materials: (p) => p.lights.materials_per_ft_cents,
});
export const ADDON_KEYS = Object.freeze(Object.keys(ADDON_CFG));
export function addOnUnit(book, key, pricing) {
  const item = (book || []).find((i) => i && i.active !== false && i.key === key);
  if (item && isInt(item.unit_cents) && item.unit_cents > 0) return item.unit_cents;
  return ADDON_CFG[key] ? ADDON_CFG[key](pricingWith(pricing)) : 0;
}

const itemFor = (book, key, fallback) => (book || []).find((i) => i && i.active !== false && i.key === key) || (fallback ? (book || []).find((i) => i && i.active !== false && fallback(i)) : null) || null;
const SHOW_FLAT = Object.freeze({ qty: false, unit: false, description: true });
const SHOW_UNIT = Object.freeze({ qty: true, unit: true, description: true });

function lineFrom(item, { id, title, qty_milli = 1000, unit_cents, engine_cents, tier, scope, description, category, unit, service_type } = {}) {
  const l = {
    id, price_item_id: item ? item.id : undefined, title: title || (item && item.name) || "Line", description: description ?? ((item && item.show && item.show.description !== false && item.description) || ""),
    qty_milli, unit_cents: isInt(unit_cents) ? unit_cents : (item && isInt(item.unit_cents) ? item.unit_cents : 0),
    scope: scope || { type: "all" }, service_type: service_type || (item && item.service_type) || undefined,
    category: category || (item && item.category) || "other", unit: unit || (item && item.unit) || "flat",
    show: (item && item.show) || (unit && unit !== "flat" ? SHOW_UNIT : SHOW_FLAT),
  };
  if (isInt(engine_cents)) l.engine_cents = engine_cents;
  if (tier) l.tier = tier;
  if (!l.price_item_id) delete l.price_item_id;
  if (!l.service_type) delete l.service_type;
  l.total_cents = lineTotal(l);
  return l;
}

// input = { services: [...], panes_ext, panes_int, screens?, tracks?: { standard, premium },
//           gutters_cents?, lights?: { runs, package_cents, colors }, plan?: catalog key }
// → { lines, warnings }
export function suggestLines(input = {}, pricing = {}, book = [], { lineId } = {}) {
  const p = pricingWith(pricing);
  let n = 0;
  const id = (k) => (typeof lineId === "function" ? lineId(k) : `ln_${k}${++n}`);
  const services = new Set(Array.isArray(input.services) ? input.services : []);
  const lines = [];
  const warnings = [];
  const panesExt = posInt(input.panes_ext);
  const panesInt = posInt(input.panes_int) || panesExt;
  if (services.has("windows_ext")) {
    const item = itemFor(book, "exterior", (i) => i.engine === "exterior_tiers");
    const ex = exteriorCents(panesExt, p);
    if (ex.manual) { warnings.push("over_100_panes"); lines.push(lineFrom(item, { id: id("ext"), title: "Exterior Window Cleaning", unit_cents: 0, category: "windows_ext", service_type: "Residential Window Cleaning", tier: `${panesExt} Panes` })); }
    else lines.push(lineFrom(item, { id: id("ext"), unit_cents: ex.cents, engine_cents: ex.cents, tier: ex.tier, category: "windows_ext", service_type: "Residential Window Cleaning", title: (item && item.name) || "Exterior Window Cleaning" }));
  }
  if (services.has("windows_int")) {
    const item = itemFor(book, "interior", (i) => i.engine === "interior_segments");
    const inn = interiorCents(panesInt, p);
    if (inn.manual) { warnings.push("over_100_panes_interior"); lines.push(lineFrom(item, { id: id("int"), title: "Interior Window Cleaning", unit_cents: 0, category: "windows_int", service_type: "Residential Window Cleaning" })); }
    else lines.push(lineFrom(item, { id: id("int"), unit_cents: inn.cents, engine_cents: inn.cents, tier: inn.tier, category: "windows_int", service_type: "Residential Window Cleaning", title: (item && item.name) || "Interior Window Cleaning" }));
  }
  if (services.has("screens")) {
    const item = itemFor(book, "screens", (i) => i.category === "screens");
    let count = posInt(input.screens);
    if (!count) { count = screenEstimate(panesExt, p); warnings.push("count_screens_on_site"); }
    const unit = item && isInt(item.unit_cents) && item.unit_cents > 0 ? item.unit_cents : addOnUnit(book, "screens", p);
    lines.push(lineFrom(item, { id: id("scr"), qty_milli: count * 1000, unit_cents: unit, engine_cents: count * unit, category: "screens", unit: "screen", title: (item && item.name) || "Screen Cleaning" }));
  }
  const tr = isPlainObject(input.tracks) ? input.tracks : {};
  if (services.has("tracks_standard") && posInt(tr.standard)) {
    const item = itemFor(book, "tracks_standard", (i) => i.category === "tracks" && !/premium/i.test(i.name));
    const unit = item && isInt(item.unit_cents) && item.unit_cents > 0 ? item.unit_cents : addOnUnit(book, "tracks_standard", p);
    lines.push(lineFrom(item, { id: id("trk"), qty_milli: posInt(tr.standard) * 1000, unit_cents: unit, engine_cents: posInt(tr.standard) * unit, category: "tracks", unit: "track", title: (item && item.name) || "Track Detailing" }));
  } else if (services.has("tracks_standard")) warnings.push("count_tracks");
  if (services.has("tracks_premium") && posInt(tr.premium)) {
    const item = itemFor(book, "tracks_premium", (i) => i.category === "tracks" && /premium/i.test(i.name));
    const unit = item && isInt(item.unit_cents) && item.unit_cents > 0 ? item.unit_cents : addOnUnit(book, "tracks_premium", p);
    lines.push(lineFrom(item, { id: id("trp"), qty_milli: posInt(tr.premium) * 1000, unit_cents: unit, engine_cents: posInt(tr.premium) * unit, category: "tracks", unit: "track", title: (item && item.name) || "Premium Track Detailing" }));
  } else if (services.has("tracks_premium")) warnings.push("count_tracks");
  if (services.has("gutters")) {
    const item = itemFor(book, "gutters", (i) => i.category === "gutters");
    const cents = isInt(input.gutters_cents) && input.gutters_cents > 0 ? input.gutters_cents : 0;
    if (!cents) warnings.push("price_gutters");
    lines.push(lineFrom(item, { id: id("gut"), unit_cents: cents, category: "gutters", service_type: "Exterior Cleaning", title: (item && item.name) || "Gutter Cleaning" }));
  }
  if (services.has("lights") && isPlainObject(input.lights)) {
    for (const l of lightsLines(input.lights, p, book, { lineId: () => id("lt") })) lines.push(l);
  }
  return { lines, warnings };
}

// An option's lines, scoped for a plan (D27: the Quarterly interior visit is
// ordinal 2; exterior on 1, 3 and 4), with the plan's per-visit discount.
// → { lines, discounts, warnings, plan? }
export function suggestOption(input = {}, pricing = {}, book = [], defs = [], opts = {}) {
  const planKey = input.plan && Object.hasOwn(PLAN_CATALOG, input.plan) ? input.plan : null;
  const services = new Set(Array.isArray(input.services) ? input.services : []);
  if (planKey === "quarterly") services.add("windows_int");
  const { lines, warnings } = suggestLines({ ...input, services: [...services] }, pricing, book, opts);
  if (!planKey) return { lines, discounts: [], warnings };
  const cat = PLAN_CATALOG[planKey];
  if (planKey === "quarterly") {
    // the interior visit (2) is interior only: screens, tracks and gutters go with the exterior visits (owner to confirm, barta-rules Q2/Q3)
    for (const l of lines) {
      if (["windows_ext", "screens", "tracks", "gutters"].includes(l.category)) l.scope = { type: "specific", visits: [1, 3, 4] };
      if (l.category === "windows_int") l.scope = { type: "specific", visits: [2] };
    }
  }
  const d = planDiscountFor(planKey, pricing, defs);
  return {
    lines, discounts: d ? [d] : [], warnings,
    plan: { catalog_key: planKey, frequency: { ...cat.frequency }, visits_per_year: cat.visits_per_year, term_months: cat.term_months, billing: planKey === "lights_annual" ? "after_visit" : "barta_standard", autopay: planKey !== "lights_annual", auto_renew: true },
  };
}

// Christmas lights: install $8/ft + materials $2/ft (or one package price),
// plus the included takedown, storage and in-season warranty lines (D30).
export function lightsLines({ runs = [], package_cents, colors = [] } = {}, pricing = {}, book = [], { lineId } = {}) {
  const p = pricingWith(pricing);
  let n = 0;
  const id = () => (typeof lineId === "function" ? lineId() : `ln_lt${++n}`);
  const clean = (Array.isArray(runs) ? runs : []).map((r) => ({ label: String((r && r.label) || "Run").trim().slice(0, 40) || "Run", milli: Math.max(0, Math.round(Number(r && r.feet) * 1000) || 0) })).filter((r) => r.milli > 0);
  const totalMilli = clean.reduce((s, r) => s + r.milli, 0);
  const feet = (m) => (m % 1000 === 0 ? String(m / 1000) : (m / 1000).toFixed(1));
  const desc = clean.length ? clean.map((r) => `${r.label} ${feet(r.milli)} ft`).join(", ") : "";
  const colorText = (Array.isArray(colors) ? colors : []).filter((c) => Object.hasOwn(COLORS, c)).map((c) => COLORS[c]).join(", ");
  const description = [desc, colorText ? `Colors: ${colorText}` : ""].filter(Boolean).join(". ");
  const out = [];
  if (isInt(package_cents) && package_cents > 0) {
    const item = itemFor(book, "lights_package", (i) => i.category === "lights" && i.unit === "flat" && i.engine === "manual");
    out.push(lineFrom(item, { id: id(), title: (item && item.name) || "Christmas Lights", unit_cents: package_cents, category: "lights", service_type: "Christmas Lights", description }));
  } else if (totalMilli > 0) {
    const inst = itemFor(book, "lights_install", (i) => i.engine === "lights_install_ft");
    const mat = itemFor(book, "lights_materials", (i) => i.engine === "lights_materials_ft");
    const iu = inst && isInt(inst.unit_cents) && inst.unit_cents > 0 ? inst.unit_cents : addOnUnit(book, "lights_install", p);
    const mu = mat && isInt(mat.unit_cents) && mat.unit_cents > 0 ? mat.unit_cents : addOnUnit(book, "lights_materials", p);
    out.push(lineFrom(inst, { id: id(), title: (inst && inst.name) || "Christmas Light Installation", qty_milli: totalMilli, unit_cents: iu, engine_cents: roundHalfUp(BigInt(totalMilli) * BigInt(iu), 1000n), category: "lights", unit: "ft", service_type: "Christmas Lights", description }));
    out.push(lineFrom(mat, { id: id(), title: (mat && mat.name) || "Christmas Light Materials", qty_milli: totalMilli, unit_cents: mu, engine_cents: roundHalfUp(BigInt(totalMilli) * BigInt(mu), 1000n), category: "lights", unit: "ft", service_type: "Christmas Lights", description: "Commercial-grade C9 LED bulbs on a dark green strand.", scope: { type: "initial" } }));
  }
  if (out.length) {
    const td = itemFor(book, "lights_takedown", (i) => i.category === "lights" && /takedown/i.test(i.name));
    out.push(lineFrom(td, { id: id(), title: (td && td.name) || "Takedown and Storage", unit_cents: 0, category: "lights", service_type: "Christmas Lights" }));
    const wr = itemFor(book, "lights_warranty", (i) => i.category === "warranty");
    out.push(lineFrom(wr, { id: id(), title: (wr && wr.name) || "In-Season Material Warranty", unit_cents: 0, category: "warranty", service_type: "Christmas Lights" }));
  }
  return out;
}
