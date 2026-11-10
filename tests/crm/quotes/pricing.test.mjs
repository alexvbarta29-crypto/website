// M3a acceptance: the Barta pricing engine (design §5.3, §11.4
// "pricing.test.mjs", barta-rules §1.9, D15, D26, D30): every tier
// boundary, the square-foot tiers 2499/2500 ... 7999/8000 → manual,
// integer math only, the .5 boundaries, scopes, stacking order, the floor.
import { test } from "node:test";
import assert from "node:assert/strict";

const P = await import("../../../netlify/lib/crm/modules/quotes/pricing.mjs");
const SEED = await import("../../../netlify/lib/crm/modules/quotes/seed.mjs");
const D = P.PRICING_DEFAULTS;
const book = SEED.SEED_PRICE_BOOK.map((i) => ({ ...i, id: SEED.seedItemId(i.key) }));
const defs = SEED.SEED_DISCOUNTS.map((d) => ({ ...d, id: SEED.seedDiscountId(d.key) }));

test("exterior tiers: every boundary, 41-60 is $395 (not $345), over 100 panes is priced by hand", () => {
  const cases = [[0, 27500], [1, 27500], [20, 27500], [21, 29500], [40, 29500], [41, 39500], [60, 39500], [61, 49500], [80, 49500], [81, 59500], [100, 59500]];
  for (const [panes, cents] of cases) assert.equal(P.exteriorCents(panes, D).cents, cents, `${panes} panes`);
  assert.deepEqual(P.exteriorCents(101, D), { manual: true, reason: "over_100_panes" });
  assert.equal(P.exteriorCents(40, D).tier, "Up to 40 Panes (2500 - 3499 Sqft)", "Rotor's tier label");
  assert.equal(P.exteriorCents(20, D).tier, "Up to 20 Panes (0 - 2499 Sqft)");
});

test("interior: $80 per 20-pane segment, over 100 by hand (the price table 80/160/240/320/400)", () => {
  const cases = [[0, 0], [1, 8000], [20, 8000], [21, 16000], [40, 16000], [41, 24000], [60, 24000], [61, 32000], [80, 32000], [81, 40000], [100, 40000]];
  for (const [panes, cents] of cases) assert.equal(P.interiorCents(panes, D).cents, cents, `${panes} panes`);
  assert.equal(P.interiorCents(101, D).manual, true);
});

test("square feet → the pane tier (phone quotes): every boundary, 8000 is by hand, 'confirm panes on site'", () => {
  const cases = [[0, 20], [2499, 20], [2500, 40], [3499, 40], [3500, 60], [4999, 60], [5000, 80], [6499, 80], [6500, 100], [7999, 100]];
  for (const [sqft, panes] of cases) {
    const t = P.tierFromSqft(sqft, D);
    assert.equal(t.max_panes, panes, `${sqft} sqft`);
    assert.equal(t.pane_estimate, panes);
    assert.equal(t.warning, "confirm panes on site");
  }
  assert.equal(P.tierFromSqft(8000, D).manual, true);
  assert.equal(P.tierFromSqft(7999.5, D).manual, true, "a fraction over the last tier is over it");
  assert.equal(P.tierFromSqft(-1, D).manual, true);
  assert.equal(P.tierFromSqft("abc", D).manual, true);
  assert.equal(P.tierFromSqft(3000, D).label, "Up to 40 Panes (2500 - 3499 Sqft)");
});

test("pane counting: Barta's weights, French panes × 0.4 rounded up, small garage panes free", () => {
  assert.deepEqual(P.paneCount([{ type: "standard", qty: 10 }, { type: "slider", qty: 3 }, { type: "large", qty: 1 }, { type: "sliding_door", qty: 1 }], D), { panes: 20, raw: 20 });
  assert.deepEqual(P.paneCount([{ type: "french", qty: 3 }], D), { panes: 2, raw: 1.2 }, "1.2 rounds up to 2 (D26)");
  assert.equal(P.paneCount([{ type: "french", qty: 5 }], D).panes, 2, "5 × 0.4 = exactly 2");
  assert.equal(P.paneCount([{ type: "garage_small", qty: 12 }, { type: "front_door", qty: 1 }], D).panes, 1);
  assert.equal(P.paneCount([{ type: "standard", qty: -3 }, { type: "standard", qty: 2.5 }], D).panes, 0, "only whole, positive counts");
  assert.equal(P.paneCount([{ type: "french", qty: 3 }], { ...D, pane_rounding: "floor" }).panes, 1);
});

test("integer math only: line totals and percentages round half up at the .5 boundary", () => {
  assert.equal(P.lineTotal({ qty_milli: 1500, unit_cents: 333 }), 500, "1.5 × $3.33 = 499.5 → 500");
  assert.equal(P.lineTotal({ qty_milli: 1500, unit_cents: 331 }), 497, "496.5 → 497");
  assert.equal(P.lineTotal({ qty_milli: 2500, unit_cents: 1 }), 3, "2.5 → 3");
  assert.equal(P.lineTotal({ qty_milli: 1000, unit_cents: 29500, override: { cents: 25000, reason: "neighbor" } }), 25000, "an override wins");
  assert.equal(P.pctOf(24310, 1500), 3647, "24310 at 15% → 3647 off");
  assert.equal(P.pctOf(5, 5000), 3, "2.5 → 3");
  assert.equal(P.pctOf(29500, 5000), 14750);
  const big = P.lineTotal({ qty_milli: 999999999, unit_cents: 99999999 });
  assert.ok(Number.isSafeInteger(big), "no float even for huge products");
});

test("visit prices: scopes per visit, percentages before fixed amounts, never below the floor", () => {
  const ext = { id: "ln_a", total_cents: 29500, scope: { type: "specific", visits: [1, 3, 4] } };
  const int = { id: "ln_b", total_cents: 16000, scope: { type: "specific", visits: [2] } };
  const plan = { type: "fixed", value: 10000, scope: { type: "all" } };
  const v = P.visitPrices({ lines: [ext, int], discounts: [plan] }, 4, D);
  assert.deepEqual(v.per_visit_cents, [19500, 6000, 19500, 19500], "Quarterly: the interior visit is ordinal 2 and gets the $100 too (D27)");
  assert.equal(v.first_cents, 19500);
  assert.equal(v.term_cents, 64500);
  // 50% then $100: $1,000 → $500 → $400 (D30)
  const lights = P.visitPrices({ lines: [{ total_cents: 100000 }], discounts: [{ type: "fixed", value: 10000 }, { type: "percentage", value: 5000 }] }, 1, D);
  assert.equal(lights.first_cents, 40000);
  // never below $0: an $80 interior visit with $100 off
  assert.equal(P.visitPrices({ lines: [{ total_cents: 8000 }], discounts: [{ type: "fixed", value: 10000 }] }, 1, D).first_cents, 0);
  // percentages cap at 100%
  assert.equal(P.visitPrices({ lines: [{ total_cents: 8000 }], discounts: [{ type: "percentage", value: 9000 }, { type: "percentage", value: 9000 }] }, 1, D).first_cents, 0);
  // first visit only (First Time Customer), after the first (a plan's later visits)
  const ft = P.visitPrices({ lines: [{ total_cents: 29500 }], discounts: [{ type: "fixed", value: 5000, scope: { type: "initial" } }, { type: "fixed", value: 1000, scope: { type: "after_initial" } }] }, 2, D);
  assert.deepEqual(ft.per_visit_cents, [24500, 28500]);
  // an optional line counts only when chosen
  const opt = { total_cents: 5000, optional: true };
  assert.equal(P.visitPrices({ lines: [{ total_cents: 29500 }, opt] }, 1, D).first_cents, 29500);
  assert.equal(P.visitPrices({ lines: [{ total_cents: 29500 }, { ...opt, selected: true }] }, 1, D).first_cents, 34500);
});

test("an option's totals: one-time is one visit; a plan its term (36 months of an annual plan = 3 installs), annual = a year", () => {
  const o = { kind: "plan", plan: { catalog_key: "biannual", visits_per_year: 2, term_months: 12 }, lines: [{ qty_milli: 1000, unit_cents: 29500, scope: { type: "all" } }], discounts: [{ type: "fixed", value: 5000, scope: { type: "all" } }] };
  assert.deepEqual(P.optionTotals(o, D), { first_cents: 24500, per_visit_cents: [24500, 24500], term_cents: 49000, annual_cents: 49000 });
  const three = { kind: "plan", plan: { visits_per_year: 1, term_months: 36 }, lines: [{ qty_milli: 1000, unit_cents: 80000 }], discounts: [] };
  const t3 = P.optionTotals(three, D);
  assert.equal(t3.per_visit_cents.length, 3);
  assert.equal(t3.term_cents, 240000);
  assert.equal(t3.annual_cents, 80000);
  assert.equal(P.optionTotals({ kind: "one_time", lines: [{ qty_milli: 1000, unit_cents: 29500 }] }, D).per_visit_cents.length, 1);
});

test("suggestions reproduce barta-rules §1.9: 40 panes in and out, screens estimated, tracks $8 (D26), gutters by hand", () => {
  const { lines, warnings } = P.suggestLines({ services: ["windows_ext", "windows_int", "screens", "tracks_standard", "tracks_premium", "gutters"], panes_ext: 40, panes_int: 38, tracks: { standard: 6, premium: 2 } }, D, book);
  const by = Object.fromEntries(lines.map((l) => [l.category + (l.title.includes("Premium") ? "_p" : ""), l]));
  assert.equal(by.windows_ext.total_cents, 29500);
  assert.equal(by.windows_ext.tier, "Up to 40 Panes (2500 - 3499 Sqft)");
  assert.equal(by.windows_ext.price_item_id, SEED.seedItemId("exterior"));
  assert.equal(by.windows_int.total_cents, 16000);
  assert.equal(by.screens.qty_milli, 20000, "screens ~ half the panes");
  assert.equal(by.screens.total_cents, 10000);
  assert.equal(by.tracks.total_cents, 4800, "6 × $8");
  assert.equal(by.tracks_p.total_cents, 3000, "2 × $15");
  assert.equal(by.gutters.total_cents, 0);
  assert.ok(warnings.includes("count_screens_on_site"));
  assert.ok(warnings.includes("price_gutters"));
  for (const l of lines) assert.ok(Number.isSafeInteger(l.total_cents) && Number.isSafeInteger(l.qty_milli));
  const over = P.suggestLines({ services: ["windows_ext"], panes_ext: 120 }, D, book);
  assert.ok(over.warnings.includes("over_100_panes"));
  assert.equal(over.lines[0].unit_cents, 0);
  assert.equal(over.lines[0].engine_cents, undefined, "nothing proposed over 100 panes");
});

test("a plan option: Quarterly scopes (exterior 1, 3, 4; interior 2) and its $100 per-visit discount; Biannual $50, Monthly $150", () => {
  const q = P.suggestOption({ services: ["windows_ext"], panes_ext: 40, plan: "quarterly" }, D, book, defs);
  const ext = q.lines.find((l) => l.category === "windows_ext");
  const int = q.lines.find((l) => l.category === "windows_int");
  assert.deepEqual(ext.scope, { type: "specific", visits: [1, 3, 4] });
  assert.deepEqual(int.scope, { type: "specific", visits: [2] }, "Quarterly always has its interior visit");
  assert.equal(q.discounts[0].value, 10000);
  assert.equal(q.discounts[0].stack_group, "plan");
  assert.equal(q.discounts[0].def_id, SEED.seedDiscountId("plan_quarterly"));
  assert.equal(q.plan.visits_per_year, 4);
  assert.equal(q.plan.billing, "barta_standard");
  assert.equal(P.suggestOption({ services: ["windows_ext"], panes_ext: 40, plan: "biannual" }, D, book, defs).discounts[0].value, 5000);
  assert.equal(P.suggestOption({ services: ["windows_ext"], panes_ext: 40, plan: "monthly" }, D, book, defs).discounts[0].value, 15000);
  assert.equal(P.suggestOption({ services: ["windows_ext"], panes_ext: 40 }, D, book, defs).discounts.length, 0, "one-time: no plan discount");
});

test("lights: $8 install + $2 materials per foot, or one package; Early Bird 50% only before the deadline in effect, then 3-year $100", () => {
  const lines = P.lightsLines({ runs: [{ label: "Roofline", feet: 120 }, { label: "Peaks", feet: 34.5 }], colors: ["warm_white", "red"] }, D, book);
  const inst = lines.find((l) => l.title === "Christmas Light Installation");
  const mat = lines.find((l) => l.title === "Christmas Light Materials");
  assert.equal(inst.qty_milli, 154500);
  assert.equal(inst.total_cents, 123600, "154.5 ft × $8");
  assert.equal(mat.total_cents, 30900, "154.5 ft × $2");
  assert.match(inst.description, /Roofline 120 ft, Peaks 34\.5 ft\. Colors: warm white, red/);
  assert.ok(lines.some((l) => l.title === "Takedown and Storage" && l.total_cents === 0), "storage is included in the price");
  const pkg = P.lightsLines({ package_cents: 120000, runs: [{ label: "House", feet: 90 }] }, D, book);
  assert.equal(pkg[0].total_cents, 120000);
  assert.equal(pkg.filter((l) => l.total_cents > 0).length, 1);
  assert.equal(P.earlyBirdDeadline("2026-10-15", D), "2026-11-01");
  assert.equal(P.earlyBirdDeadline("2026-11-10", D), "2026-12-01");
  assert.equal(P.earlyBirdDeadline("2026-12-01", D), "2026-12-01", "the deadline day still counts");
  assert.equal(P.earlyBirdDeadline("2026-12-02", D), null);
  assert.equal(P.earlyBirdDeadline("2026-08-31", D), null, "before the season starts");
  assert.equal(P.earlyBirdDeadline("2027-10-01", D), null, "no deadline set for that season yet");
  const ds = P.lightsDiscounts({ early_bird: true, three_year: true, on: "2026-11-10" }, D, defs);
  assert.deepEqual(ds.map((d) => [d.key, d.type, d.value]), [["early_bird", "percentage", 5000], ["three_year", "fixed", 10000]]);
  assert.equal(ds[0].offer_until, "2026-12-01");
  assert.deepEqual(P.lightsDiscounts({ early_bird: true, on: "2026-12-05" }, D, defs), [], "no Early Bird after the deadline");
  const total = P.visitPrices({ lines: [{ total_cents: inst.total_cents + mat.total_cents }], discounts: ds }, 1, D).first_cents;
  assert.equal(total, 67250, "$1,545 → 50% → $772.50 → −$100");
});

test("cfg/pricing: the validator keeps only what it checks and refuses nonsense", () => {
  assert.deepEqual(P.validatePricing({ tracks: { standard_cents: 500, premium_cents: 1500 }, junk: 1 }), { tracks: { standard_cents: 500, premium_cents: 1500 } }, "$5 standard tracks is one field (D26)");
  assert.throws(() => P.validatePricing({ exterior_tiers: [{ max_panes: 20, cents: -1 }] }), /cents/);
  assert.throws(() => P.validatePricing({ exterior_tiers: [{ max_panes: 20, cents: 100 }, { max_panes: 20, cents: 200 }] }), /same pane count/);
  assert.throws(() => P.validatePricing({ tax_bp: 600 }), /no sales tax/);
  assert.throws(() => P.validatePricing({ lights: { deadlines: { 2026: ["2027-01-01"] } } }), /in that season/);
  assert.throws(() => P.validatePricing({ lights: { colors: ["blue"] } }), /warm white/);
  assert.equal(P.validatePricing({ exterior_tiers: [{ max_panes: 40, cents: 1 }, { max_panes: 20, cents: 2 }] }).exterior_tiers[0].max_panes, 20, "sorted");
  // a changed tier is used at once
  const custom = P.pricingWith({ exterior_tiers: [{ max_panes: 20, cents: 30000 }] });
  assert.equal(P.exteriorCents(15, custom).cents, 30000);
  assert.equal(P.exteriorCents(25, custom).manual, true);
});
