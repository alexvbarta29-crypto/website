// Money in integer cents (design §5.3, §12.2): parsing without floats,
// half-up rounding at every .5, the 15% example, quantities in thousandths,
// BigInt past 2^53.
import { test } from "node:test";
import assert from "node:assert/strict";

const M = await import("../../../netlify/lib/crm/core/money.mjs");
const { InputError } = await import("../../../netlify/lib/crm/core/errors.mjs");

test("toCents parses dollars digit by digit", () => {
  assert.equal(M.toCents("243.1"), 24310);
  assert.equal(M.toCents("216.75"), 21675);
  assert.equal(M.toCents("0.1"), 10);
  assert.equal(M.toCents(".5"), 50);
  assert.equal(M.toCents("-5.5"), -550);
  assert.equal(M.toCents("$1,234.50"), 123450);
  assert.equal(M.toCents("1.005"), 101, "half up on the dropped digits");
  assert.equal(M.toCents("1.0049"), 100);
  assert.equal(M.toCents("-1.005"), -101);
  assert.equal(M.toCents(12.34), 1234);
  assert.equal(M.toCents(0.1 + 0.2), 30, "a float input is read through its shortest string");
  assert.equal(M.toCents("90071992547409.91"), 9007199254740991);
  for (const bad of ["", "abc", "1.2.3", "1,23", "$", null, NaN, Infinity, 1e21, "92233720368547758.08"]) {
    assert.throws(() => M.toCents(bad), (e) => e instanceof InputError || e instanceof RangeError, String(bad));
  }
});

test("roundHalfUp at every .5 boundary rounds away from zero; other values round to nearest", () => {
  for (let n = -20; n <= 20; n++) {
    const half = n + (n >= 0 ? 0.5 : -0.5);                 // n.5 or -n.5
    const expected = n >= 0 ? n + 1 : n - 1;
    assert.equal(M.roundHalfUp(2 * n + (n >= 0 ? 1 : -1), 2), expected, `${half}`);
  }
  assert.equal(M.roundHalfUp(5, 10), 1);
  assert.equal(M.roundHalfUp(15, 10), 2);
  assert.equal(M.roundHalfUp(25, 10), 3);
  assert.equal(M.roundHalfUp(-25, 10), -3);
  assert.equal(M.roundHalfUp(14, 10), 1);
  assert.equal(M.roundHalfUp(16, 10), 2);
  assert.equal(M.roundHalfUp(-14, 10), -1);
  assert.equal(M.roundHalfUp(7, -2), -4, "a negative divisor flips the sign");
  assert.throws(() => M.roundHalfUp(1, 0), RangeError);
});

test("24310 minus 15% is 20663: the discount rounds half up to 3647", () => {
  assert.equal(M.percentOf(24310, 15), 3647);
  assert.equal(M.percentOf(24310, "15"), 3647);
  assert.equal(M.percentOfBps(24310, 1500), 3647);
  assert.deepEqual(M.applyPercent(24310, 15), { discount_cents: 3647, total_cents: 20663 });
  assert.equal(M.percentOf(10000, "12.5"), 1250);
});

test("lineTotal multiplies by quantity in thousandths and rounds half up", () => {
  assert.equal(M.lineTotal({ unit_cents: 1999, qty_milli: 1500 }), 2999);   // 2998.5
  assert.equal(M.lineTotal({ unit_cents: 1000, qty_milli: 333 }), 333);
  assert.equal(M.lineTotal({ unit_cents: 8000 }), 8000);
  assert.equal(M.lineTotal({ unit_cents: 1, qty_milli: 500 }), 1);
  assert.equal(M.lineTotal({ unit_cents: -1999, qty_milli: 1500 }), -2999);
  assert.throws(() => M.lineTotal({ unit_cents: 19.99, qty_milli: 1000 }), InputError);
  assert.throws(() => M.lineTotal({ unit_cents: 100, qty_milli: 1.5 }), InputError);
});

test("products past 2^53 go through BigInt; a result past 2^53 is refused, never rounded silently", () => {
  const max = Number.MAX_SAFE_INTEGER;
  assert.equal(M.lineTotal({ unit_cents: max, qty_milli: 1000 }), max, "max × 1000 is past 2^53, the result is not");
  assert.equal(M.lineTotal({ unit_cents: 4503599627370497, qty_milli: 1999 }), 9002695655113624);   // …623.503 rounds up
  assert.equal(M.roundHalfUpBig(2n ** 60n + 1n, 2n), 2n ** 59n + 1n);
  assert.throws(() => M.lineTotal({ unit_cents: max, qty_milli: 2000 }), RangeError);
  assert.equal(M.sumCents([max - 10, 5, 5]), max);
  assert.throws(() => M.sumCents([max, 1]), RangeError);
});

test("formatting and exact splits", () => {
  assert.equal(M.fromCents(24310), "243.10");
  assert.equal(M.fromCents(-5), "-0.05");
  assert.equal(M.formatCents(123450), "$1,234.50");
  assert.equal(M.formatCents(-123450), "-$1,234.50");
  assert.deepEqual(M.splitCents(1001, 3), [334, 334, 333], "the leftover cent goes to the first tech");
  assert.deepEqual(M.splitCents(-1001, 3), [-334, -334, -333]);
  assert.equal(M.splitCents(12345, 7).reduce((a, b) => a + b, 0), 12345);
});
