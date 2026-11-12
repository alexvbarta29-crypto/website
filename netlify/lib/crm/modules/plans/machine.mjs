// Plans module: the plan state machine and the arithmetic of terms,
// ordinals, scopes, re-spacing, pauses, cancellations and renewals (design
// §5.4). Pure: no I/O, no clock (callers pass "today"), so every rule is a
// unit test (plan-machine.test.mjs).
//
// Ordinals are the plan's visits: { term, n, k, target_month, job_id?,
// status, visit_date?, completed_on?, gen }. n counts inside its term, k
// across the whole plan (1 = the plan's first visit). Line and discount
// scopes refer to ordinals within a term (§5.4): in the initial term that
// is n, exactly as the quote engine priced it; a renewal term (often one
// visit) continues the yearly cycle, so a Quarterly plan's interior visit
// stays every fourth visit after renewal ((k − 1) mod visits_per_year + 1).
// "initial" covers only the plan's first visit, "after_initial" every other.

import { InputError } from "../../core/errors.mjs";
import { addLocalDays } from "../../core/clock.mjs";
import { roundHalfUp, sumCents } from "../../core/money.mjs";
import { OPEN_ORDINAL } from "./types.mjs";

const pad2 = (n) => String(n).padStart(2, "0");

// ------------------------------------------------------------ the state machine

// { [status]: { [event]: next } } (§5.4 "Plan state machine"). Any pair not
// in the table throws: a plan is never moved by an event that doesn't apply.
export const PLAN_STATES = Object.freeze({
  draft: Object.freeze({ submit: "pending", activate: "active", cancel: "cancelled" }),
  pending: Object.freeze({ activate: "active", cancel: "cancelled", confirm_season: "pending" }),
  active: Object.freeze({
    schedule: "active", skip: "active", pause: "paused", cancel: "cancelling", renewal_notice: "active", renew: "active", expire: "expired", change_price: "active", confirm_season: "active",
  }),
  paused: Object.freeze({ resume: "active", cancel: "cancelling", schedule: "paused", confirm_season: "paused" }),
  cancelling: Object.freeze({ cancel_effective: "cancelled", withdraw: "active", schedule: "cancelling" }),
  cancelled: Object.freeze({}),
  expired: Object.freeze({ renew: "active" }),
});

export function planNext(status, event) {
  const row = PLAN_STATES[status];
  const next = row && row[event];
  if (!next) {
    const e = new InputError(`A ${status || "new"} plan can't ${String(event).replace(/_/g, " ")}.`, "transition");
    e.code = "transition";
    throw e;
  }
  return next;
}
export const canDo = (status, event) => !!(PLAN_STATES[status] && PLAN_STATES[status][event]);

// Why a plan waits (§5.4 pending_reasons): its agreement unsigned, and a
// card it needs not on file. The card is known only once Money exists
// (money.cardStatus); before that "card required" is recorded, not enforced.
export function pendingReasons({ signed = false, card_required = false, money = false, card_on_file = false } = {}) {
  const out = [];
  if (!signed) out.push("signature");
  if (card_required && money && !card_on_file) out.push("card");
  return out;
}

// ------------------------------------------------------------ dates and months

export function addMonthsDate(date, n) {
  const [y, m, d] = String(date).split("-").map(Number);
  const t = y * 12 + (m - 1) + n;
  const yy = Math.floor(t / 12);
  const mm = (t % 12 + 12) % 12 + 1;
  const last = new Date(Date.UTC(yy, mm, 0)).getUTCDate();
  return `${yy}-${pad2(mm)}-${pad2(Math.min(d, last))}`;
}
export function addMonthsYm(ym, n) {
  const [y, m] = String(ym).split("-").map(Number);
  const t = y * 12 + (m - 1) + n;
  return `${Math.floor(t / 12)}-${pad2((t % 12 + 12) % 12 + 1)}`;
}
export const monthOf = (date) => String(date).slice(0, 7);
export function monthsBetween(a, b) {
  const [ay, am] = String(a).split("-").map(Number);
  const [by, bm] = String(b).split("-").map(Number);
  return (by * 12 + bm) - (ay * 12 + am);
}
// The last day of a term that starts on `start` and lasts `months`.
export const termEnd = (start, months) => addLocalDays(addMonthsDate(start, months), -1);

// The date `times` intervals after `date`.
export function addInterval(date, freq, times) {
  const f = freq || { interval: "month", count: 1 };
  if (f.interval === "month") return addMonthsDate(date, f.count * times);
  if (f.interval === "year") return addMonthsDate(date, 12 * f.count * times);
  return addLocalDays(date, (f.interval === "week" ? 7 : 1) * f.count * times);
}

// Visits a year for a frequency (Quarterly's catalog says 4 explicitly).
export function visitsPerYearOf(freq) {
  const f = freq || { interval: "month", count: 6 };
  const per = f.interval === "month" ? 12 / f.count : f.interval === "year" ? 1 / f.count : f.interval === "week" ? 52 / f.count : 365 / f.count;
  return Math.max(1, Math.round(per));
}
// How many visits a term of `months` holds.
export const visitsInTerm = (vpy, months) => Math.max(1, Math.round((vpy * months) / 12));

// ------------------------------------------------------------ terms and ordinals

// Term 1 of a plan starting `start_on`.
export function firstTerm({ start_on, initial_months = 12, renews_every_months = 12, auto_renew = true }) {
  const end = termEnd(start_on, initial_months);
  return {
    start_on, initial_months, initial_end_on: end, current_term_n: 1, current_term_start: start_on, current_term_end: end,
    renews_every_months, auto_renew: auto_renew !== false, price_locked_until: end,
  };
}

// The ordinals of one term: count visits from `start`, one interval apart.
export function termOrdinals({ frequency, visits_per_year }, { term, start, months, kStart = 1 }) {
  const count = visitsInTerm(visits_per_year || visitsPerYearOf(frequency), months);
  return Array.from({ length: count }, (_, i) => ({ term, n: i + 1, k: kStart + i, target_month: monthOf(addInterval(start, frequency, i)), status: "unscheduled", gen: 0 }));
}

export const maxK = (ordinals = []) => ordinals.reduce((m, o) => Math.max(m, o.k || 0), 0);

// The visit position a scope is checked against (see the header).
export function coverPos(plan, o) {
  if ((o.term || 1) === 1) return o.n;
  const vpy = Math.max(1, plan.visits_per_year || visitsPerYearOf(plan.frequency));
  return (((o.k || o.n) - 1) % vpy) + 1;
}
export function covers(scope, plan, o) {
  const s = scope || { type: "all" };
  const k = o.k || o.n;
  if (s.type === "initial") return k === 1;
  if (s.type === "after_initial") return k > 1;
  if (s.type === "specific") return Array.isArray(s.visits) && s.visits.includes(coverPos(plan, o));
  return true;
}
const chosen = (l) => !(l.optional && l.selected !== true);

// What one ordinal's job carries: the lines and discounts that cover it,
// each then covering its one job ("all").
export const ordinalLines = (plan, o) => (plan.lines || []).filter((l) => chosen(l) && covers(l.scope, plan, o)).map((l) => {
  const { selected, ...rest } = l;
  return { ...rest, optional: false, scope: { type: "all" } };
});
export const ordinalDiscounts = (plan, o) => (plan.discounts || []).filter((d) => covers(d.scope, plan, o)).map((d) => ({ ...d, scope: { type: "all" } }));

// One ordinal's price (the engine's rule: percentages first, then fixed amounts, never below $0).
export function ordinalTotals(plan, o, floor = 0) {
  const lines = ordinalLines(plan, o);
  const subtotal = sumCents(lines.map((l) => (Number.isSafeInteger(l.total_cents) ? l.total_cents : 0)));
  const ds = ordinalDiscounts(plan, o);
  const bp = Math.min(10000, ds.filter((d) => d.type === "percentage").reduce((s, d) => s + (d.value || 0), 0));
  const pct = subtotal > 0 ? roundHalfUp(subtotal * bp, 10000) : 0;
  const fixed = ds.filter((d) => d.type === "fixed").reduce((s, d) => s + (d.value || 0), 0);
  const total = Math.max(Math.min(floor, subtotal), subtotal - pct - fixed);
  return { subtotal_cents: subtotal, discount_cents: subtotal - total, total_cents: total };
}

// Σ the current term's visit prices (§5.4 sale_value_cents, derived).
export function saleValue(plan) {
  const n = (plan.term && plan.term.current_term_n) || 1;
  return sumCents((plan.ordinals || []).filter((o) => (o.term || 1) === n && o.status !== "skipped" && o.status !== "cancelled").map((o) => ordinalTotals(plan, o).total_cents));
}

// The per-visit prices of the plan's first year (visit 1 carries what's
// "initial" only: a first-visit discount; a lights plan made before Nov 12
// also had its materials, Early Bird and 3-year discount there).
export function cyclePrices(plan) {
  const vpy = Math.max(1, plan.visits_per_year || visitsPerYearOf(plan.frequency));
  return Array.from({ length: vpy }, (_, i) => ordinalTotals(plan, { term: 1, n: i + 1, k: i + 1 }).total_cents);
}
// The per-visit prices of a later year (a renewal term: nothing "initial").
export function regularPrices(plan) {
  const vpy = Math.max(1, plan.visits_per_year || visitsPerYearOf(plan.frequency));
  return Array.from({ length: vpy }, (_, i) => ordinalTotals(plan, { term: 2, n: i + 1, k: vpy + i + 1 }).total_cents);
}

// A plan discount (the per-visit discount the plan is sold with, §5.4) as
// opposed to a first-visit offer, Early Bird or the 3-year discount: the
// quote engine's stack group "plan" or key plan_*, else its name.
const NOT_PLAN = /first[\s-]*time|early[\s-]*bird|3[\s-]*year|three[\s-]*year|referral|coupon|giveaway/i;
export function isPlanDiscount(d) {
  if (!d || typeof d !== "object") return false;
  const key = String(d.key || "");
  if (NOT_PLAN.test(key) || NOT_PLAN.test(String(d.name || ""))) return false;
  return d.stack_group === "plan" || /^plan_/.test(key) || /\bplan\b|bi-?annual|semi-?annual|quarterly|monthly/i.test(String(d.name || ""));
}

// The early-cancel clawback (§5.4): the plan discount the plan's first visit
// actually got, whatever the catalog says (a plan sold with $80 off pays
// back $80; one sold with none pays back nothing).
export function clawbackCents(plan) {
  const o = { term: 1, n: 1, k: 1 };
  const subtotal = sumCents(ordinalLines(plan, o).map((l) => (Number.isSafeInteger(l.total_cents) ? l.total_cents : 0)));
  if (subtotal <= 0) return 0;
  const ds = ordinalDiscounts(plan, o).filter(isPlanDiscount);
  const bp = Math.min(10000, ds.filter((d) => d.type === "percentage").reduce((s, d) => s + (d.value || 0), 0));
  const fixed = ds.filter((d) => d.type === "fixed").reduce((s, d) => s + (d.value || 0), 0);
  return Math.min(subtotal, roundHalfUp(subtotal * bp, 10000) + fixed);
}

// A Christmas lights contract (the 3-year plan: an initial term of 36 months
// or more) and its early-exit storage fee (the owner, Nov 12: $400 when the
// customer cancels inside the initial term). The plan carries the figure it
// was sold with (policy.storage_fee_cents); a plan without one (imported, or
// made before Nov 12) uses the owner's $400. Calculator, cancel and the
// agreement text all read it here.
export const LIGHTS_STORAGE_FEE_CENTS = 40000;
export const isLightsContract = (plan) => !!plan && (plan.kind === "lights_annual" || plan.catalog_key === "lights_annual") && ((plan.term && plan.term.initial_months) || plan.term_months || 12) >= 36;
export function storageFeeCents(plan) {
  if (!isLightsContract(plan)) return 0;
  const c = plan.policy && plan.policy.storage_fee_cents;
  return Number.isSafeInteger(c) && c >= 0 ? c : LIGHTS_STORAGE_FEE_CENTS;
}

// The season of a lights ordinal (its install's year).
export const seasonOf = (o) => Number(String((o && o.target_month) || "").slice(0, 4)) || null;
// A lights season after the plan's first waits for the customer to confirm
// it (the September rebook text): no install is made before (§5.4, D30).
export const seasonConfirmed = (plan, o) => plan.kind !== "lights_annual" || (o.k || o.n) <= 1 || (plan.confirmed_seasons || []).includes(seasonOf(o));

// ------------------------------------------------------------ transitions' arithmetic

// "active, ordinal k scheduled": later unscheduled ordinals of the term are
// re-spaced from the actual date by the interval (Rotor's behaviour).
export function respace(plan, ord, actualDate) {
  return (plan.ordinals || []).map((o) => {
    if (o.term !== ord.term || o.n <= ord.n || o.status !== "unscheduled") return o;
    return { ...o, target_month: monthOf(addInterval(actualDate, plan.frequency, o.n - ord.n)) };
  });
}

// "paused → active": target months of the unscheduled ordinals shift by the paused length.
export function shiftUnscheduled(ordinals, months, fromMonth = null) {
  if (!months) return ordinals;
  return ordinals.map((o) => (o.status === "unscheduled" && (!fromMonth || o.target_month >= fromMonth) ? { ...o, target_month: addMonthsYm(o.target_month, months) } : o));
}
export const pausedMonths = (from, resumeOn) => Math.max(0, monthsBetween(monthOf(from), monthOf(resumeOn)));

// The ordinals a pause takes off the schedule: open ones due from the pause
// month on (until the pause's end month, when it has one).
export function pausedOrdinals(plan, from, until = null) {
  const a = monthOf(from);
  const b = until ? monthOf(until) : null;
  return (plan.ordinals || []).filter((o) => OPEN_ORDINAL.includes(o.status) && (o.visit_date ? o.visit_date >= from : o.target_month >= a) && (!b || (o.visit_date ? monthOf(o.visit_date) : o.target_month) <= b));
}

// The cancel policy calculator (§5.4; GET /plans/:id/cancel-quote). Inside
// the initial term: effective after notice_days, and the first visit's plan
// discount comes back when that visit was done; a lights contract left inside
// its initial term adds its storage fee (both a draft for the owner, never
// charged by itself; clawback_cents is the total, storage_fee_cents the
// fee's part); after it: effective at the end of the current term, visits up
// to then still happen and bill.
export function cancelQuote(plan, requestedOn) {
  const t = plan.term || {};
  const policy = plan.policy || {};
  const inside = requestedOn <= (t.initial_end_on || requestedOn);
  const effective_on = inside ? addLocalDays(requestedOn, Number.isInteger(policy.notice_days) ? policy.notice_days : 7) : (t.current_term_end || requestedOn);
  const first = (plan.ordinals || []).find((o) => (o.k || 0) === 1) || (plan.ordinals || [])[0];
  const fee = inside ? storageFeeCents(plan) : 0;
  const clawback_cents = (inside && first && first.status === "completed" ? clawbackCents(plan) : 0) + fee;
  const open = (plan.ordinals || []).filter((o) => OPEN_ORDINAL.includes(o.status));
  const happen = open.filter((o) => o.status === "scheduled" && o.visit_date && o.visit_date <= effective_on);
  return {
    inside_initial_term: inside, requested_on: requestedOn, effective_on, clawback_cents, ...(fee ? { storage_fee_cents: fee } : {}), notice_days: policy.notice_days ?? 7,
    visits_still_happen: happen.length, visits_cancelled: open.length - happen.length, immediate: effective_on <= requestedOn,
  };
}

// What "cancelling → cancelled" stops: every open ordinal except a booked
// visit on or before the effective date.
export const ordinalsToStop = (plan, effectiveOn) => (plan.ordinals || []).filter((o) => OPEN_ORDINAL.includes(o.status) && !(o.status === "scheduled" && o.visit_date && o.visit_date <= effectiveOn));

// "current_term_end reached, auto_renew": the next term and its ordinals.
// A price change whose effective date has come replaces the lines.
export function nextTerm(plan) {
  const t = plan.term;
  const start = addLocalDays(t.current_term_end, 1);
  const months = t.renews_every_months || 12;
  const n = (t.current_term_n || 1) + 1;
  const pc = plan.renewal && plan.renewal.price_change;
  const lines = pc && pc.effective_on && pc.effective_on <= start && Array.isArray(pc.new_lines) && pc.new_lines.length ? pc.new_lines : plan.lines;
  const ordinals = termOrdinals({ frequency: plan.frequency, visits_per_year: plan.visits_per_year }, { term: n, start, months, kStart: maxK(plan.ordinals) + 1 });
  return {
    term: { ...t, current_term_n: n, current_term_start: start, current_term_end: termEnd(start, months) },
    ordinals, lines, price_changed: lines !== plan.lines,
  };
}

// When a term-end event is due (today > the term's last day), and whether
// the renewal notice is (30 days before the end).
export const termOver = (plan, today) => !!(plan.term && plan.term.current_term_end && today > plan.term.current_term_end);
export const noticeDue = (plan, today, days = 30) => !!(plan.term && plan.term.current_term_end && plan.term.auto_renew !== false && today >= addLocalDays(plan.term.current_term_end, -days) && today <= plan.term.current_term_end);

// A price change needs 30 days' notice and can't land inside the locked period.
export function checkPriceChange(plan, effectiveOn, today) {
  if (!effectiveOn || !/^\d{4}-\d{2}-\d{2}$/.test(effectiveOn)) throw new InputError("When does the new price start?", "effective_on");
  if (effectiveOn < addLocalDays(today, 30)) throw new InputError("A new price needs 30 days' notice.", "effective_on");
  const lock = plan.term && plan.term.price_locked_until;
  if (lock && effectiveOn <= lock) throw new InputError(`The price is locked until ${lock}.`, "effective_on");
}

// The status an ordinal should have for its job's status (plans.ordinal_sync).
export function ordinalStatusForJob(o, jobStatus) {
  if (o.status === "skipped") return "skipped";
  switch (jobStatus) {
    case "unscheduled": return "unscheduled";
    case "scheduled": case "in_progress": return "scheduled";
    case "completed": return "completed";
    case "cancelled": return "cancelled";
    default: return o.status;
  }
}

// ------------------------------------------------------------ one transition (pure)

const OPEN = (o) => OPEN_ORDINAL.includes(o.status);
const sameOrd = (a, b) => (a.term || 1) === (b.term || 1) && a.n === b.n;

// applyAction(plan, action, args, { today, at, by }) → { next, to_cancel,
// event, notice }: the plan after one event of the state machine, the jobs
// to cancel (work.cancelJobs), the event to emit and whether the customer
// is told (a booked visit taken off by a pause). Throws InputError for an
// event the plan's status doesn't take, or bad arguments.
export function applyAction(plan, action, args = {}, { today, at, by = "" } = {}) {
  const to = planNext(plan.status, action);
  let next = { ...plan, status: to };
  let to_cancel = [];
  let event = null;
  let notice = false;
  const ords = (plan.ordinals || []).map((o) => ({ ...o }));
  switch (action) {
    case "submit":
      next.pending_reasons = plan.pending_reasons && plan.pending_reasons.length ? plan.pending_reasons : ["signature"];
      break;
    case "activate":
      next.pending_reasons = [];
      next.activated_at = at;
      if (args.override_reason) next.activated_override = { by, at, reason: String(args.override_reason).slice(0, 300) };
      event = "plan.activated";
      break;
    case "pause": {
      const from = args.from || today;
      const until = args.until || null;
      if (!/^\d{4}-\d{2}-\d{2}$/.test(from)) throw new InputError("Pause from which day?", "from");
      if (from < today) throw new InputError("A pause starts today or later.", "from");
      if (until && (!/^\d{4}-\d{2}-\d{2}$/.test(until) || until <= from)) throw new InputError("The pause ends after it starts.", "until");
      const hit = pausedOrdinals(plan, from, until);
      next.ordinals = ords.map((o) => {
        if (!hit.some((h) => sameOrd(h, o))) return o;
        if (o.job_id) to_cancel.push(o.job_id);
        if (o.status === "scheduled") notice = true;
        const { job_id, visit_date, ...rest } = o;
        return { ...rest, status: "unscheduled", gen: (o.gen || 0) + 1 };
      });
      next.cancelled_job_ids = [...new Set([...(plan.cancelled_job_ids || []), ...to_cancel])].slice(-200);
      next.pause = { from, ...(until ? { until } : {}), reason: String(args.reason || "").slice(0, 300), by };
      event = "plan.paused";
      break;
    }
    case "resume": {
      const p = plan.pause || { from: today };
      const months = pausedMonths(p.from, today);
      next.ordinals = shiftUnscheduled(ords, months, monthOf(p.from));
      next.pauses = [...(plan.pauses || []), { ...p, resumed_on: today }].slice(-20);
      delete next.pause;
      event = "plan.activated";
      break;
    }
    case "skip": {
      const o = ords.find((x) => (x.term || 1) === (args.term || 1) && x.n === args.n);
      if (!o || !OPEN(o)) throw new InputError("Pick a visit that's still to come.", "n");
      o.status = "skipped";
      if (o.job_id) to_cancel.push(o.job_id);
      next.ordinals = ords;
      break;
    }
    case "cancel": {
      const reason = args.reason || "other";
      if (plan.status === "pending" || plan.status === "draft") {
        next.ordinals = ords.map((o) => (OPEN(o) ? (o.job_id && to_cancel.push(o.job_id), { ...o, status: "cancelled" }) : o));
        next.cancel = { requested_on: today, effective_on: today, reason, ...(args.note ? { note: String(args.note).slice(0, 500) } : {}), clawback_cents: 0, by };
        next.cancelled_at = at;
        next.billing = { ...(plan.billing || {}), autopay: false };
        next.pending_reasons = [];
        event = "plan.cancelled";
        break;
      }
      const requested = args.requested_on || today;
      if (!/^\d{4}-\d{2}-\d{2}$/.test(requested) || requested > addLocalDays(today, 60)) throw new InputError("When did they ask to cancel?", "requested_on");
      const q = cancelQuote(plan, requested);
      next.cancel = {
        requested_on: requested, effective_on: q.effective_on, reason, ...(args.note ? { note: String(args.note).slice(0, 500) } : {}),
        clawback_cents: q.clawback_cents, ...(q.storage_fee_cents ? { storage_fee_cents: q.storage_fee_cents } : {}), ...(q.clawback_cents > 0 ? { clawback_state: "to_bill" } : {}), inside_initial_term: q.inside_initial_term, by,
      };
      if (q.effective_on <= today) {
        const fin = applyAction(next, "cancel_effective", {}, { today, at, by });
        return { ...fin, to_cancel: [...to_cancel, ...fin.to_cancel] };
      }
      break;
    }
    case "cancel_effective": {
      const eff = (plan.cancel && plan.cancel.effective_on) || today;
      const stop = ordinalsToStop(plan, eff);
      next.ordinals = ords.map((o) => (stop.some((h) => sameOrd(h, o)) ? (o.job_id && to_cancel.push(o.job_id), { ...o, status: "cancelled" }) : o));
      next.cancelled_at = at;
      next.billing = { ...(plan.billing || {}), autopay: false };
      event = "plan.cancelled";
      break;
    }
    case "withdraw":
      next.cancels = [...(plan.cancels || []), { ...(plan.cancel || {}), withdrawn_on: today }].slice(-10);
      delete next.cancel;
      break;
    case "renew": {
      let nt;
      if (plan.status === "expired") {
        const t = plan.term;
        const months = t.renews_every_months || 12;
        const n = (t.current_term_n || 1) + 1;
        nt = { term: { ...t, current_term_n: n, current_term_start: today, current_term_end: termEnd(today, months), auto_renew: args.auto_renew === undefined ? t.auto_renew : args.auto_renew === true },
          ordinals: termOrdinals({ frequency: plan.frequency, visits_per_year: plan.visits_per_year }, { term: n, start: today, months, kStart: maxK(ords) + 1 }), lines: plan.lines, price_changed: false };
        delete next.expired_at;
      } else {
        if (!termOver(plan, today) && args.early !== true) throw new InputError("This plan's term hasn't ended yet.", "term");
        nt = nextTerm(plan);
      }
      next.term = nt.term;
      next.ordinals = [...ords, ...nt.ordinals];
      next.lines = nt.lines;
      next.renewal = { ...(plan.renewal || {}), next_on: nt.term.current_term_end, renewed_on: today };
      if (nt.price_changed) delete next.renewal.price_change;
      delete next.renewal.notice_term;
      event = "plan.renewed";
      break;
    }
    case "expire":
      next.expired_at = at;
      break;
    case "change_price": {
      checkPriceChange(plan, args.effective_on, today);
      if (!Array.isArray(args.new_lines) || !args.new_lines.length) throw new InputError("Add the new prices.", "new_lines");
      next.renewal = { ...(plan.renewal || {}), price_change: { new_lines: args.new_lines, effective_on: args.effective_on, set_by: by, set_at: at } };
      break;
    }
    case "confirm_season": {
      // the customer said yes to a lights season (the rebook text): its install can be made
      if (plan.kind !== "lights_annual") throw new InputError("Only a Christmas lights plan has seasons to confirm.", "season");
      const season = Number(args.season);
      if (!Number.isSafeInteger(season) || season < 2020 || season > 2100) throw new InputError("Which season?", "season");
      next.confirmed_seasons = [...new Set([...(plan.confirmed_seasons || []), season])].sort((a, b) => a - b).slice(-6);
      next.ordinals = ords.map((o) => ((o.k || o.n) > 1 && seasonOf(o) === season && !o.confirmed_on ? { ...o, confirmed_on: today } : o));
      break;
    }
    case "schedule":
      break;
    default:
      throw new InputError("Unknown plan action.", "action");
  }
  next.sale_value_cents = saleValue(next);
  return { next, to_cancel: [...new Set(to_cancel)], event, notice };
}
