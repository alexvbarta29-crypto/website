// Payroll settings (cfg/payroll, design §5.8; owner-only, §4.12) and the
// pay rates every pay sheet uses (D3: what Rotor actually pays).
//
//   week_starts          "sunday" (Barta's pay weeks are Sunday to Saturday)
//   period_weeks         1 or 2 (a period is one week by default)
//   ot_threshold_hours   40, ot_multiplier 1.5 (time and a half over 40 h a week)
//   commission_basis     "job_total_after_discounts" (tips are never in it)
//   commission_split     how a job's technician commission is shared:
//                        by_hours (timer minutes, Barta's scoreboard rule),
//                        equal, each_full (each at the full job: Rotor's)
//   tip_split            "equal" (money splits tips when they come in; payroll reads the split)
//   min_segment_minutes  timer segments shorter than this are ignored
//   model_default        the model for anyone whose own is not set
//   scoreboard_user_ids  [] = the people with the technician role
//   scoreboard_pool_bp   2000 and scoreboard_upsell_bp 1000: the scoreboard's
//                        "20% pooled by hours, +10% on upsells" comparison
//                        (information only, never pay; barta-rules §5)
//   goals                revenue per hour, reviews a week, callbacks (the scoreboard's targets)

import { InputError } from "../../core/errors.mjs";
import { isId } from "../../core/ids.mjs";

export const PAY_MODELS = Object.freeze(["hourly", "commission", "greater_of", "hourly_plus_commission"]);
export const SPLITS = Object.freeze(["by_hours", "equal", "each_full"]);
export const CATEGORIES = Object.freeze(["service", "sales", "office"]);
export const D3_SERVICE_CENTS = 2000;   // $20 an hour for service when a technician has no rate (D3)

export const PAYROLL_DEFAULTS = Object.freeze({
  week_starts: "sunday", period_weeks: 1, ot_threshold_hours: 40, ot_multiplier: 1.5,
  commission_basis: "job_total_after_discounts", commission_split: "by_hours", tip_split: "equal",
  min_segment_minutes: 1, model_default: "hourly", scoreboard_user_ids: [],
  scoreboard_pool_bp: 2000, scoreboard_upsell_bp: 1000,
  goals: { revenue_per_hour_cents: 12500, reviews_per_week: 2, callbacks_pct: 2 },
});

const num = (v, f, min, max) => {
  if (typeof v !== "number" || !Number.isFinite(v) || v < min || v > max) throw new InputError(`Pick a number from ${min} to ${max}.`, f);
  return v;
};

// Keeps unknown fields (§3.14); checks the ones it knows.
export function validatePayroll(v) {
  if (!v || typeof v !== "object" || Array.isArray(v)) throw new InputError("Expected the payroll settings.");
  const out = { ...v };
  if (out.week_starts !== undefined && out.week_starts !== "sunday") throw new InputError("Pay weeks start on Sunday.", "week_starts");
  if (out.period_weeks !== undefined && ![1, 2].includes(out.period_weeks)) throw new InputError("A pay period is one or two weeks.", "period_weeks");
  if (out.ot_threshold_hours !== undefined) num(out.ot_threshold_hours, "ot_threshold_hours", 1, 80);
  if (out.ot_multiplier !== undefined) num(out.ot_multiplier, "ot_multiplier", 1, 3);
  if (out.commission_split !== undefined && !SPLITS.includes(out.commission_split)) throw new InputError("Split by hours, equally, or each at the full job.", "commission_split");
  if (out.tip_split !== undefined && out.tip_split !== "equal") throw new InputError("Tips are split equally.", "tip_split");
  if (out.min_segment_minutes !== undefined) num(out.min_segment_minutes, "min_segment_minutes", 0, 30);
  if (out.model_default !== undefined && !PAY_MODELS.includes(out.model_default)) throw new InputError("Pick a pay model.", "model_default");
  if (out.scoreboard_user_ids !== undefined) {
    if (!Array.isArray(out.scoreboard_user_ids) || out.scoreboard_user_ids.length > 20 || out.scoreboard_user_ids.some((x) => !isId(x, "user"))) throw new InputError("Pick people on the team.", "scoreboard_user_ids");
    out.scoreboard_user_ids = [...new Set(out.scoreboard_user_ids)];
  }
  for (const k of ["scoreboard_pool_bp", "scoreboard_upsell_bp"]) if (out[k] !== undefined) num(out[k], k, 0, 10000);
  if (out.goals !== undefined && (!out.goals || typeof out.goals !== "object" || Array.isArray(out.goals))) throw new InputError("Expected the goals.", "goals");
  return out;
}

export const payrollConfig = (stored) => ({ ...PAYROLL_DEFAULTS, ...(stored || {}), goals: { ...PAYROLL_DEFAULTS.goals, ...((stored && stored.goals) || {}) } });

// Whether a person goes out on visits (the scoreboard's default: the technician role only).
export const isTechRole = (u) => !!u && u.role === "tech";
export const goesOut = (u) => !!u && (u.role === "tech" || u.is_technician === true);

// A person's hourly rate for a category, in cents. Their own rate when set;
// a technician with no rate at all gets their service rate, else D3's $20;
// an owner or the office is paid only the rates set for them.
export function rateFor(user, category) {
  const h = (user && user.pay && user.pay.hourly_cents) || {};
  const own = Number.isSafeInteger(h[category]) && h[category] > 0 ? h[category] : 0;
  if (own) return { cents: own, standard: false };
  if (!isTechRole(user)) return { cents: 0, standard: false };
  const service = Number.isSafeInteger(h.service) && h.service > 0 ? h.service : 0;
  return service ? { cents: service, standard: false } : { cents: D3_SERVICE_CENTS, standard: true };
}

// Commission rates in basis points (2500 = 25%).
export function commissionBp(user, kind) {
  const c = (user && user.pay && user.pay.commission_pct) || {};
  return Number.isSafeInteger(c[kind]) && c[kind] > 0 ? Math.min(c[kind], 10000) : 0;
}

export const modelOf = (user, cfg) => {
  const m = user && user.pay && user.pay.model;
  return PAY_MODELS.includes(m) ? m : cfg.model_default || "hourly";
};
