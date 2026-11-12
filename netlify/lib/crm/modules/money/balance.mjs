// Money module: the pure money rules (design §5.6). No storage here: the
// record validators, the upsert paths and the tests all call these, so an
// invoice's paid, balance, excess and status are always worked out the same
// way from the same facts.
//
//   totalsOf(lines)            subtotal (service + fee lines), discount and
//                              credit (positive sums of the negative lines),
//                              total = max(0, subtotal − discount − credit)
//   derive(invoice, { at })    THE balance mutator: paid / refunded / tips /
//                              balance / excess / status from `applied`
//                              (only `succeeded` entries count), every CAS
//                              retry recomputes from the current map
//   forward(from, to)          a payment status only moves forward by rank;
//                              a terminal status never changes
//   computeTip(...)            the tip the server charges (0/10/15/20 % of
//                              the balance or a custom amount, capped)
//   splitTip(cents, users)     equal split, the leftover cent to the first tech (D3)
//   refundSplit(payment, n)    a refund comes out of the invoice amount first, then the tip
//
// Every amount is integer cents (core/money.mjs); no float touches money.

import { percentOfBps, splitCents, sumCents } from "../../core/money.mjs";
import { localDate, now, nowMs as clockMs } from "../../core/clock.mjs";

export const PAY_STATUSES = Object.freeze(["pending", "processing", "succeeded", "failed", "canceled"]);
export const TERMINAL = Object.freeze(["succeeded", "failed", "canceled"]);
const RANK = Object.freeze({ pending: 0, processing: 1, succeeded: 2, failed: 2, canceled: 2 });
export const rankOf = (s) => (Object.hasOwn(RANK, s) ? RANK[s] : -1);
export const isTerminal = (s) => TERMINAL.includes(s);

// The status a record moves to when `to` arrives while it is `from`:
// forward only, and a terminal status is final (events arrive out of order).
export function forward(from, to) {
  if (!from) return to;
  if (from === to || isTerminal(from)) return from;
  return rankOf(to) > rankOf(from) ? to : from;
}

export const LINE_KINDS = Object.freeze(["service", "discount", "credit", "deposit_credit", "fee"]);
export const INVOICE_KINDS = Object.freeze(["standard", "deposit", "plan_cycle", "fee"]);
export const INVOICE_STATUSES = Object.freeze(["draft", "open", "paid", "void", "uncollectible"]);
export const SET_BY_PEOPLE = Object.freeze(["draft", "void", "uncollectible"]);
export const DERIVED = Object.freeze(["open", "paid"]);

// The money of an invoice's lines. Discount and credit are positive sums of
// the (negative) discount, credit and deposit-credit lines.
export function totalsOf(lines = []) {
  const of = (kinds) => sumCents((lines || []).filter((l) => l && kinds.includes(l.kind || "service")).map((l) => (Number.isSafeInteger(l.total_cents) ? l.total_cents : 0)));
  const subtotal = of(["service", "fee"]);
  const discount = -of(["discount"]);
  const credit = -of(["credit", "deposit_credit"]);
  return { subtotal_cents: subtotal, discount_cents: discount, credit_cents: credit, tax_cents: 0, total_cents: Math.max(0, subtotal - discount - credit) };
}

const entries = (inv) => Object.entries((inv && inv.applied) || {}).map(([id, e]) => ({ id, ...(e || {}) }));
const ok = (e, kind) => e.kind === kind && e.status === "succeeded";

// Σ of the counted entries: { paid, refunded, tips }.
export function sums(inv) {
  const list = entries(inv);
  const paid = sumCents(list.filter((e) => ok(e, "payment")).map((e) => e.amount_cents || 0));
  const refunded = sumCents(list.filter((e) => ok(e, "refund")).map((e) => e.amount_cents || 0));
  const tipsIn = sumCents(list.filter((e) => ok(e, "payment")).map((e) => e.tip_cents || 0));
  const tipsOut = sumCents(list.filter((e) => ok(e, "refund")).map((e) => e.tip_cents || 0));
  return { paid, refunded, tips: tipsIn - tipsOut };
}

// The balance mutator (pure). → a copy of the invoice with paid_cents,
// refunded_cents, tips_cents, balance_cents, excess_cents and status (and
// paid_at) derived from `applied`. draft, void and uncollectible are set by
// people and stay; open/paid follow the money. A void invoice owes nothing:
// whatever was paid on it is excess (an overpayment, a credit).
export function derive(inv, { at } = {}) {
  const out = { ...inv };
  const { paid, refunded, tips } = sums(inv);
  const total = Number.isSafeInteger(inv.total_cents) ? inv.total_cents : 0;
  out.paid_cents = paid;
  out.refunded_cents = refunded;
  out.tips_cents = tips;
  const net = paid - refunded;
  if (inv.status === "void") {
    out.balance_cents = 0;
    out.excess_cents = Math.max(0, net);
  } else {
    out.balance_cents = Math.max(0, total - net);
    out.excess_cents = Math.max(0, net - total);
  }
  // open and paid follow the money; draft, void, uncollectible (and a status
  // newer code wrote that this code doesn't know) stay as they are
  if (DERIVED.includes(inv.status)) {
    // nothing left to collect: paid (a $0 invoice that was issued is paid too)
    out.status = out.balance_cents === 0 ? "paid" : "open";
  }
  if (out.status === "paid") { if (!out.paid_at) out.paid_at = at || inv.updated_at || inv.issued_at || null; }
  else delete out.paid_at;
  if (out.paid_at === null) delete out.paid_at;
  return out;
}

// Derived flags (the index row and the API).
export const isProcessing = (inv) => entries(inv).some((e) => e.status === "processing");
export const isOverdue = (inv, today = localDate(now())) => inv.status === "open" && !!inv.due_on && inv.due_on < today && (inv.balance_cents || 0) > 0;
export const isPartiallyPaid = (inv) => inv.status === "open" && (inv.paid_cents || 0) > 0 && (inv.paid_cents || 0) - (inv.refunded_cents || 0) < (inv.total_cents || 0);
export function autopayFailed(inv) {
  const at = (inv.autopay && inv.autopay.attempts) || [];
  const last = at[at.length - 1];
  return !!last && last.result === "failed" && inv.status === "open";
}
export const chargingLive = (inv, nowMs) => !!(inv.charging && Date.parse(inv.charging.until) > nowMs);

export function flags(inv, today, nowMs = clockMs()) {
  return { overdue: isOverdue(inv, today), partially_paid: isPartiallyPaid(inv), autopay_failed: autopayFailed(inv), processing: isProcessing(inv), charging: chargingLive(inv, nowMs) };
}

// ------------------------------------------------------------ tips

export const DEFAULT_TIP_OPTIONS_BP = Object.freeze([0, 1000, 1500, 2000]);
export const DEFAULT_TIP_CUSTOM_MAX = 50000;

// The tip the server charges (§5.6, §8.5): a choice of percent ("0", "10",
// "15", "20": whatever cfg/money.tip_options_bp allows) of the balance, or
// "custom" cents capped at the balance and at tip_custom_max_cents ($500).
// → { tip_cents } | throws a RangeError("tip_choice") for a choice the
// settings don't offer. Never trusts an amount the page computed.
export function computeTip(balanceCents, choice, customCents, { tip_options_bp = DEFAULT_TIP_OPTIONS_BP, tip_custom_max_cents = DEFAULT_TIP_CUSTOM_MAX } = {}) {
  const balance = Math.max(0, Number.isSafeInteger(balanceCents) ? balanceCents : 0);
  const c = String(choice ?? "0").trim();
  if (c === "custom") {
    const v = Number.isSafeInteger(customCents) ? customCents : Number.isSafeInteger(Number(customCents)) ? Number(customCents) : 0;
    const cap = Math.min(balance, Number.isSafeInteger(tip_custom_max_cents) ? tip_custom_max_cents : DEFAULT_TIP_CUSTOM_MAX);
    return { tip_cents: Math.max(0, Math.min(v, cap)), capped: v > cap };
  }
  if (!/^\d{1,2}$/.test(c)) throw new RangeError("tip_choice");
  const bp = Number(c) * 100;
  if (bp !== 0 && !(tip_options_bp || []).includes(bp)) throw new RangeError("tip_choice");      // no tip is always a choice
  return { tip_cents: bp ? percentOfBps(balance, bp) : 0, capped: false };
}

// Equal split across the visit's techs; the leftover cent goes to the first (D3, G12).
export function splitTip(tipCents, userIds = []) {
  const ids = [...new Set((userIds || []).filter(Boolean))];
  if (!(tipCents > 0) || !ids.length) return [];
  const parts = splitCents(tipCents, ids.length);
  return ids.map((user_id, i) => ({ user_id, cents: parts[i] }));
}

// How a refund of `amount` comes out of a payment: the invoice amount
// first, then the tip. → { amount_cents, tip_cents } | null when it would
// pass what the customer paid (amount + tip − already refunded).
export function refundSplit(payment, amount, already = { amount_cents: 0, tip_cents: 0 }) {
  if (!Number.isSafeInteger(amount) || amount <= 0) return null;
  const leftAmount = Math.max(0, (payment.amount_cents || 0) - (already.amount_cents || 0));
  const leftTip = Math.max(0, (payment.tip_cents || 0) - (already.tip_cents || 0));
  if (amount > leftAmount + leftTip) return null;
  const a = Math.min(amount, leftAmount);
  return { amount_cents: a, tip_cents: amount - a };
}

// What an off-session charge may not run on (§5.6 step 1). → a code or null.
export function chargeRefusal(inv, nowMs) {
  if (!inv || inv.deleted_at) return "missing";
  if (inv.status !== "open") return inv.status === "paid" ? "paid" : "not_open";
  if ((inv.balance_cents || 0) <= 0) return "paid";
  if (chargingLive(inv, nowMs)) return "charging";
  if (isProcessing(inv)) return "processing";
  return null;
}
