// Barta CRM core: money in integer cents (design §5.3, §5.6, §10.5, §12.2).
//
// Every amount is an integer number of cents; quantities are integer
// thousandths (qty_milli: 1500 = 1.5). No float ever touches money: strings
// are parsed digit by digit, products go through BigInt when they could pass
// 2^53, and rounding is half away from zero ("half up" for positive amounts,
// the mirror for refunds and credits), so 24310 at 15% off is a 3647
// discount and a 20663 total.

import { InputError } from "./errors.mjs";

const MONEY_RE = /^([+-])?\$?\s*(\d{1,3}(?:,\d{3})+|\d+)?(?:\.(\d+))?$/;

const big = (n) => (typeof n === "bigint" ? n : BigInt(n));
const back = (b) => {
  const n = Number(b);
  if (!Number.isSafeInteger(n)) throw new RangeError("money: result is beyond 2^53 cents");
  return n;
};

// num / den rounded half away from zero, all integers (Number or BigInt in,
// Number out; use roundHalfUpBig to stay in BigInt).
export function roundHalfUpBig(num, den) {
  num = big(num); den = big(den);
  if (den === 0n) throw new RangeError("money: division by zero");
  if (den < 0n) { num = -num; den = -den; }
  const neg = num < 0n;
  const a = neg ? -num : num;
  const q = (a * 2n + den) / (den * 2n);
  return neg ? -q : q;
}
export const roundHalfUp = (num, den) => back(roundHalfUpBig(num, den));

// "243.1" → 24310, "$1,234.50" → 123450, "-5.5" → -550, 12.34 → 1234.
// More than two decimals are rounded half up on the third ("1.005" → 101).
export function toCents(value, field = "amount") {
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new InputError("That isn't an amount.", field);
    value = String(value);
    if (/e/i.test(value)) throw new InputError("That amount is out of range.", field);
  }
  if (typeof value !== "string") throw new InputError("That isn't an amount.", field);
  const m = MONEY_RE.exec(value.trim());
  if (!m || (m[2] === undefined && m[3] === undefined)) throw new InputError("That isn't an amount.", field);
  const whole = big((m[2] || "0").replace(/,/g, ""));
  const frac = m[3] || "";
  let cents = whole * 100n + big((frac + "00").slice(0, 2));
  if (frac.length > 2) {
    const rest = frac.slice(2);
    if (rest[0] >= "5") cents += 1n;                 // half up on the dropped digits
  }
  return back(m[1] === "-" ? -cents : cents);
}

// 24310 → "243.10" (no currency sign; the client formats for display).
export function fromCents(cents) {
  const b = big(cents);
  const neg = b < 0n;
  const a = neg ? -b : b;
  return `${neg ? "-" : ""}${a / 100n}.${String(a % 100n).padStart(2, "0")}`;
}

// Whole-dollar display used by docs and logs: 24310 → "$243.10".
export const formatCents = (cents) => {
  const s = fromCents(cents);
  const neg = s.startsWith("-");
  const [w, f] = (neg ? s.slice(1) : s).split(".");
  return `${neg ? "-" : ""}$${w.replace(/\B(?=(\d{3})+(?!\d))/g, ",")}.${f}`;
};

export const isCents = (v) => Number.isSafeInteger(v);

// unit_cents × qty_milli / 1000, rounded half up (one line of a quote or invoice).
export function lineTotal({ unit_cents, qty_milli = 1000 }) {
  if (!isCents(unit_cents)) throw new InputError("Price must be whole cents.", "unit_cents");
  if (!Number.isSafeInteger(qty_milli)) throw new InputError("Quantity must be whole thousandths.", "qty_milli");
  return roundHalfUp(big(unit_cents) * big(qty_milli), 1000n);
}

// A percentage discount in basis points (1500 = 15%) of an amount, rounded half up.
export function percentOfBps(cents, bps) {
  if (!isCents(cents) || !Number.isSafeInteger(bps)) throw new RangeError("money: integer cents and basis points only");
  return roundHalfUp(big(cents) * big(bps), 10000n);
}
// The same with a whole or decimal percent given as a string or number ("15", 12.5).
export function percentOf(cents, percent) {
  const bps = toCents(typeof percent === "number" ? String(percent) : percent, "percent");   // "15" → 1500
  return percentOfBps(cents, bps);
}
// amount − percent discount: { discount_cents, total_cents }.
export function applyPercent(cents, percent) {
  const discount_cents = percentOf(cents, percent);
  return { discount_cents, total_cents: cents - discount_cents };
}

// Sum of cents (exact; BigInt underneath so a long list can't drift).
export const sumCents = (list) => back(list.reduce((acc, c) => acc + big(c), 0n));

// Split cents into n parts that sum exactly; the leftover cents go to the first parts (tip split, §5.6).
export function splitCents(cents, n) {
  if (!isCents(cents) || !Number.isSafeInteger(n) || n <= 0) throw new RangeError("money: bad split");
  const b = big(cents), k = big(n);
  const base = b / k;
  let rest = b - base * k;
  const out = [];
  for (let i = 0; i < n; i++) {
    let part = base;
    if (rest > 0n) { part += 1n; rest -= 1n; } else if (rest < 0n) { part -= 1n; rest += 1n; }
    out.push(back(part));
  }
  return out;
}
