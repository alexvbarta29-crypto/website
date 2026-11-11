// Plans module: the settings documents it owns (design §3.3, §4.12, §5.4,
// decisions D27, D29, D30): cfg/plans_catalog (the plan catalog, perks,
// terms, the cancel policy, Rotor's plan template ids) and cfg/lights (the
// rebook date, the install-by date, the client cap). Both are owner-only
// (settings:owner). Validators keep only the fields they know.
//
// Barta's catalog (barta-rules §2): Biannual 2 exterior a year, $50 off a
// visit, no perks; Quarterly 3 exterior + 1 interior (visit 2), $100 off,
// Unlimited Touch-Ups, 7-Day Rain Guarantee, Free Hard Water Removal;
// Monthly 12 exterior, $150 off, the same perks; Christmas lights annual
// (install + takedown, billed after the install); Custom. Initial term 12
// months, renewing every 6 / 3 / 1 / 12 months (Custom: as often as it
// comes); the early-cancel clawback is the plan discount the first visit
// actually got (machine.mjs clawbackCents; clawback_cents here is only the
// catalog's figure for reference); 7 days' notice; a $50 late-cancel fee.

import { InputError } from "../../core/errors.mjs";
import { isPlainObject } from "../../core/validate.mjs";
import { getSetting } from "../../../crm-store.mjs";
import { CATALOG_KEYS, BILLING_MODES, INTERVALS } from "./types.mjs";

const PERKS = Object.freeze({ touch_ups: true, rain_guarantee_days: 7, hard_water: true });
const NO_PERKS = Object.freeze({ touch_ups: false, rain_guarantee_days: 0, hard_water: false });

export const CATALOG_DEFAULTS = Object.freeze({
  plans: {
    biannual: { name: "Biannual plan", short: "Biannual", visits_per_year: 2, frequency: { interval: "month", count: 6 }, discount_per_visit_cents: 5000, perks: { ...NO_PERKS }, initial_months: 12, renews_every_months: 6, billing: "barta_standard", autopay: true, template_key: "biannual", clawback_cents: 5000, active: true },
    quarterly: { name: "Quarterly plan", short: "Quarterly", visits_per_year: 4, frequency: { interval: "month", count: 3 }, discount_per_visit_cents: 10000, perks: { ...PERKS }, initial_months: 12, renews_every_months: 3, billing: "barta_standard", autopay: true, template_key: "quarterly", clawback_cents: 10000, interior_visits: [2], active: true },
    monthly: { name: "Monthly plan", short: "Monthly", visits_per_year: 12, frequency: { interval: "month", count: 1 }, discount_per_visit_cents: 15000, perks: { ...PERKS }, initial_months: 12, renews_every_months: 1, billing: "barta_standard", autopay: true, template_key: "monthly", clawback_cents: 15000, active: true },
    lights_annual: { name: "Christmas lights plan", short: "Christmas lights", visits_per_year: 1, frequency: { interval: "year", count: 1 }, discount_per_visit_cents: 0, perks: { ...NO_PERKS }, initial_months: 12, renews_every_months: 12, billing: "after_visit", autopay: false, template_key: "lights", clawback_cents: 0, active: true },
    custom: { name: "Custom plan", short: "Custom", visits_per_year: 2, frequency: { interval: "month", count: 6 }, discount_per_visit_cents: 0, perks: { ...NO_PERKS }, initial_months: 12, renews_every_months: 6, billing: "barta_standard", autopay: false, template_key: "custom", clawback_cents: 0, active: true },
  },
  notice_days: 7,
  late_cancel_fee_cents: 5000,
  perk_names: { touch_ups: "Unlimited Touch-Ups", rain_guarantee: "7-Day Rain Guarantee", hard_water: "Free Hard Water Removal" },
  // §10.2 row 20: Rotor's plan template ids (names unknown), kept for joins
  rotor_template_ids: [],
});

export const LIGHTS_DEFAULTS = Object.freeze({
  rebook_on: "09-01",          // the September rebook bulk run (lights.rebook)
  install_by: "12-15",         // install jobs are due before this date of the season
  takedown_month: 1,           // takedown jobs: January of the next year (D9)
  client_cap: null,            // empty until Alex sets it (D30)
});

const fail = (msg, field) => { throw new InputError(msg, field); };
const isInt = (v) => Number.isSafeInteger(v);
const cents = (v, f, max = 10000000) => { if (!isInt(v) || v < 0 || v > max) fail(`Use whole cents from 0 to ${max}.`, f); return v; };
const MMDD = /^(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])$/;

function validateEntry(key, v, f) {
  if (!isPlainObject(v)) fail("Expected the plan's settings.", f);
  const out = {};
  const d = CATALOG_DEFAULTS.plans[key];
  if (v.name !== undefined) { if (typeof v.name !== "string" || !v.name.trim() || v.name.length > 60) fail("A name up to 60 characters.", `${f}.name`); out.name = v.name.trim(); }
  if (v.short !== undefined) { if (typeof v.short !== "string" || v.short.length > 40) fail("Up to 40 characters.", `${f}.short`); out.short = v.short.trim(); }
  if (v.visits_per_year !== undefined) { if (!isInt(v.visits_per_year) || v.visits_per_year < 1 || v.visits_per_year > 52) fail("From 1 to 52 visits.", `${f}.visits_per_year`); out.visits_per_year = v.visits_per_year; }
  if (v.frequency !== undefined) {
    if (!isPlainObject(v.frequency) || !INTERVALS.includes(v.frequency.interval) || !isInt(v.frequency.count) || v.frequency.count < 1 || v.frequency.count > 52) fail("How often: a month, week, day or year count.", `${f}.frequency`);
    out.frequency = { interval: v.frequency.interval, count: v.frequency.count };
  }
  if (v.discount_per_visit_cents !== undefined) out.discount_per_visit_cents = cents(v.discount_per_visit_cents, `${f}.discount_per_visit_cents`, 100000);
  if (v.clawback_cents !== undefined) out.clawback_cents = cents(v.clawback_cents, `${f}.clawback_cents`, 100000);
  for (const k of ["initial_months", "renews_every_months"]) {
    if (v[k] === undefined) continue;
    const min = k === "initial_months" ? 12 : 1;
    if (!isInt(v[k]) || v[k] < min || v[k] > 60) fail(`From ${min} to 60 months.`, `${f}.${k}`);
    out[k] = v[k];
  }
  if (v.billing !== undefined) { if (!BILLING_MODES.includes(v.billing)) fail("Pick a billing mode.", `${f}.billing`); out.billing = v.billing; }
  for (const k of ["autopay", "active"]) if (v[k] !== undefined) { if (typeof v[k] !== "boolean") fail("Yes or no.", `${f}.${k}`); out[k] = v[k]; }
  if (v.template_key !== undefined) { if (typeof v.template_key !== "string" || !/^[a-z][a-z0-9_]{1,39}$/.test(v.template_key)) fail("An agreement template key.", `${f}.template_key`); out.template_key = v.template_key; }
  if (v.perks !== undefined) {
    if (!isPlainObject(v.perks)) fail("Expected the perks.", `${f}.perks`);
    const p = { ...(d ? d.perks : NO_PERKS) };
    for (const k of ["touch_ups", "hard_water"]) if (v.perks[k] !== undefined) { if (typeof v.perks[k] !== "boolean") fail("Yes or no.", `${f}.perks.${k}`); p[k] = v.perks[k]; }
    if (v.perks.rain_guarantee_days !== undefined) { if (!isInt(v.perks.rain_guarantee_days) || v.perks.rain_guarantee_days < 0 || v.perks.rain_guarantee_days > 30) fail("From 0 to 30 days.", `${f}.perks.rain_guarantee_days`); p.rain_guarantee_days = v.perks.rain_guarantee_days; }
    out.perks = p;
  }
  if (v.interior_visits !== undefined) {
    if (!Array.isArray(v.interior_visits) || v.interior_visits.some((x) => !isInt(x) || x < 1 || x > 52)) fail("Visit numbers.", `${f}.interior_visits`);
    out.interior_visits = [...new Set(v.interior_visits)].sort((a, b) => a - b);
  }
  return out;
}

// The cfg/plans_catalog validator (owners; known fields only).
export function validateCatalog(v) {
  const src = isPlainObject(v) ? v : {};
  const out = {};
  if (src.plans !== undefined) {
    if (!isPlainObject(src.plans)) fail("Expected the plans.", "plans");
    out.plans = {};
    for (const [k, e] of Object.entries(src.plans)) {
      if (!CATALOG_KEYS.includes(k)) fail("Unknown plan.", `plans.${k}`);
      out.plans[k] = validateEntry(k, e, `plans.${k}`);
    }
  }
  if (src.notice_days !== undefined) { if (!isInt(src.notice_days) || src.notice_days < 0 || src.notice_days > 90) fail("From 0 to 90 days.", "notice_days"); out.notice_days = src.notice_days; }
  if (src.late_cancel_fee_cents !== undefined) out.late_cancel_fee_cents = cents(src.late_cancel_fee_cents, "late_cancel_fee_cents", 100000);
  if (src.perk_names !== undefined) {
    if (!isPlainObject(src.perk_names)) fail("Expected the perk names.", "perk_names");
    out.perk_names = {};
    for (const k of ["touch_ups", "rain_guarantee", "hard_water"]) {
      const s = src.perk_names[k];
      if (s === undefined) continue;
      if (typeof s !== "string" || !s.trim() || s.length > 60) fail("A name up to 60 characters.", `perk_names.${k}`);
      out.perk_names[k] = s.trim();
    }
  }
  if (src.rotor_template_ids !== undefined) {
    if (!Array.isArray(src.rotor_template_ids) || src.rotor_template_ids.length > 50 || src.rotor_template_ids.some((x) => typeof x !== "string" || !/^[A-Za-z0-9_.-]{1,64}$/.test(x))) fail("Rotor template ids.", "rotor_template_ids");
    out.rotor_template_ids = [...new Set(src.rotor_template_ids)];
  }
  return out;
}

// The cfg/lights validator (owners).
export function validateLights(v) {
  const src = isPlainObject(v) ? v : {};
  const out = {};
  for (const k of ["rebook_on", "install_by"]) {
    if (src[k] === undefined) continue;
    if (typeof src[k] !== "string" || !MMDD.test(src[k])) fail("A date like 09-01.", k);
    out[k] = src[k];
  }
  if (src.takedown_month !== undefined) { if (!isInt(src.takedown_month) || src.takedown_month < 1 || src.takedown_month > 4) fail("January to April.", "takedown_month"); out.takedown_month = src.takedown_month; }
  if (src.client_cap !== undefined) {
    if (src.client_cap !== null && (!isInt(src.client_cap) || src.client_cap < 1 || src.client_cap > 10000)) fail("A number of clients, or empty.", "client_cap");
    out.client_cap = src.client_cap;
  }
  return out;
}

// The catalog with every plan's defaults under the owner's values.
export function catalogWith(stored = {}) {
  const s = isPlainObject(stored) ? stored : {};
  const plans = {};
  for (const k of CATALOG_KEYS) plans[k] = { ...CATALOG_DEFAULTS.plans[k], ...((s.plans && s.plans[k]) || {}), perks: { ...CATALOG_DEFAULTS.plans[k].perks, ...(((s.plans && s.plans[k]) || {}).perks || {}) } };
  // Custom once borrowed the Biannual text (a saved catalog may still say so): it has its own
  if (plans.custom.template_key === "biannual") plans.custom.template_key = "custom";
  return {
    ...CATALOG_DEFAULTS, ...s, plans,
    perk_names: { ...CATALOG_DEFAULTS.perk_names, ...(s.perk_names || {}) },
    notice_days: isInt(s.notice_days) ? s.notice_days : CATALOG_DEFAULTS.notice_days,
    late_cancel_fee_cents: isInt(s.late_cancel_fee_cents) ? s.late_cancel_fee_cents : CATALOG_DEFAULTS.late_cancel_fee_cents,
  };
}
export async function loadCatalog() {
  return catalogWith(await getSetting("plans_catalog").catch(() => ({})));
}
export async function loadLights() {
  const s = await getSetting("lights").catch(() => ({}));
  return { ...LIGHTS_DEFAULTS, ...(isPlainObject(s) ? s : {}) };
}

// "Unlimited Touch-Ups, 7-Day Rain Guarantee and Free Hard Water Removal" (or "")
export function perksList(perks = {}, names = CATALOG_DEFAULTS.perk_names) {
  const list = [];
  if (perks.touch_ups) list.push(names.touch_ups);
  if (perks.rain_guarantee_days > 0) list.push(perks.rain_guarantee_days === 7 ? names.rain_guarantee : `${perks.rain_guarantee_days}-Day Rain Guarantee`);
  if (perks.hard_water) list.push(names.hard_water);
  if (list.length <= 1) return list.join("");
  return `${list.slice(0, -1).join(", ")} and ${list[list.length - 1]}`;
}
