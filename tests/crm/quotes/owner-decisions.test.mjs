// The owner's answers of Nov 12 in the quote engine and the seeded prices:
//   1. track detailing: standard $5 a track, premium $15;
//   2. Christmas lights: the 50% Early Bird and the 3-year $200 count every
//      season, the same price all three seasons;
//   3. plan add-ons (screens, tracks, gutters) only on the visit the
//      customer asked for, never carried onto every visit;
//   4. Quarterly visit 2 is inside glass only, with the $100 off like the others;
//   and seed v2, the one-time upgrade of the live CRM's seeded prices: an
//   untouched seeded value moves once, an owner's edit stays (one notice),
//   a second run changes nothing, imported quotes are never touched.
import { test } from "node:test";
import assert from "node:assert/strict";
import { setup, scope, store, P, SEED, AS, AUTOMATION, IMPORT, makeContact, importedContact, queued, oneTime } from "./fixtures.mjs";

const book = () => SEED.SEED_PRICE_BOOK.map((i) => ({ ...i, id: SEED.seedItemId(i.key) }));
const defs = () => SEED.SEED_DISCOUNTS.map((d) => SEED.seedDiscount(d.key));
const D = P.PRICING_DEFAULTS;

test("tracks: standard $5 a track, premium $15 (the book, and cfg's fallback without one)", () => {
  const s = P.suggestLines({ services: ["tracks_standard", "tracks_premium"], tracks: { standard: 8, premium: 3 } }, D, book());
  assert.deepEqual(s.lines.map((l) => [l.title, l.unit_cents, l.total_cents]), [["Track Detailing", 500, 4000], ["Premium Track Detailing", 1500, 4500]]);
  assert.match(s.lines[0].description, /brushed, vacuumed and wiped if they need it/);
  assert.match(s.lines[1].description, /soap solution and a deep scrub brush, wet\/dry vacuumed and wiped/);
  assert.equal(P.suggestLines({ services: ["tracks_standard"], tracks: { standard: 2 } }, D, []).lines[0].unit_cents, 500, "no book: cfg's $5");
  assert.equal(D.tracks.standard_cents, 500);
  assert.doesNotMatch(JSON.stringify(SEED.SEED_PRICE_BOOK), /—|licensed/i);
});

test("lights: a 3-year plan is the same price all three seasons: list per foot, 50% Early Bird, then $200 off, every season", () => {
  // 150 ft: $1,200 install + $300 bulbs = $1,500 list → 50% = $750 → −$200 = $550, three times
  const lines = P.lightsLines({ runs: [{ label: "Roofline", feet: 150 }], colors: ["warm_white"] }, D, book());
  const discounts = P.lightsDiscounts({ early_bird: true, three_year: true, on: "2026-11-10" }, D, defs());
  assert.ok(lines.every((l) => !l.scope || l.scope.type === "all"), "nothing is for the first season only");
  assert.deepEqual(discounts.map((d) => [d.key, d.value, d.scope.type]), [["early_bird", 5000, "all"], ["three_year", 20000, "all"]]);
  const plan = { kind: "plan", plan: { catalog_key: "lights_annual", visits_per_year: 1, term_months: 36 }, lines, discounts };
  const t = P.optionTotals(plan, D);
  assert.deepEqual(t.per_visit_cents, [55000, 55000, 55000]);
  assert.equal(t.term_cents, 165000);
  // an every-season plan without the contract: the Early Bird every season too ($750 a season)
  const annual = P.optionTotals({ ...plan, plan: { ...plan.plan, term_months: 24 }, discounts: discounts.filter((d) => d.key === "early_bird") }, D);
  assert.deepEqual(annual.per_visit_cents, [75000, 75000]);
  // a package price works the same way: $1,400 → $700 → $500 every season
  const pkg = P.lightsLines({ package_cents: 140000 }, D, book());
  assert.deepEqual(P.optionTotals({ ...plan, lines: pkg }, D).per_visit_cents, [50000, 50000, 50000]);
  // the Early Bird is still sold only before the deadline in effect
  assert.deepEqual(P.lightsDiscounts({ early_bird: true, on: "2026-12-02" }, D, defs()), []);
});

test("Quarterly visit 2: inside glass only, and the $100 off like every other visit", () => {
  const q = P.suggestOption({ services: ["windows_ext"], panes_ext: 40, plan: "quarterly" }, D, book(), defs());
  const int = q.lines.filter((l) => l.category === "windows_int");
  assert.equal(int.length, 1);
  assert.deepEqual(int[0].scope, { type: "specific", visits: [2] }, "the interior line is visit 2's only line");
  assert.deepEqual(q.lines.find((l) => l.category === "windows_ext").scope, { type: "specific", visits: [1, 3, 4] });
  assert.deepEqual(q.discounts.map((d) => [d.value, d.scope.type]), [[10000, "all"]]);
  const t = P.optionTotals({ kind: "plan", plan: q.plan, lines: q.lines, discounts: q.discounts }, D);
  assert.deepEqual(t.per_visit_cents, [19500, 6000, 19500, 19500], "$295 − $100 outside; $160 − $100 inside on visit 2");
});

test("plan add-ons: screens, tracks and gutters only on the visit the customer asked for, never carried onto the others", () => {
  const input = { services: ["windows_ext", "screens", "tracks_standard", "gutters"], panes_ext: 40, screens: 20, tracks: { standard: 6 }, gutters_cents: 15000 };
  for (const plan of ["biannual", "quarterly", "monthly"]) {
    const o = P.suggestOption({ ...input, plan }, D, book(), defs());
    for (const l of o.lines.filter((x) => ["screens", "tracks", "gutters"].includes(x.category))) assert.deepEqual(l.scope, { type: "initial" }, `${plan}: ${l.title}`);
    const t = P.optionTotals({ kind: "plan", plan: o.plan, lines: o.lines, discounts: o.discounts }, D);
    const addOns = 10000 + 3000 + 15000;
    assert.equal(t.per_visit_cents[0] - t.per_visit_cents[t.per_visit_cents.length - 1], addOns, `${plan}: only the first visit carries the $280 of add-ons`);
  }
  const b = P.optionTotals({ kind: "plan", plan: { visits_per_year: 2, term_months: 12 }, ...P.suggestOption({ ...input, plan: "biannual" }, D, book(), defs()) }, D);
  assert.deepEqual(b.per_visit_cents, [29500 + 28000 - 5000, 24500]);
  // a one-time quote is unchanged: everything on its one visit
  const one = P.suggestOption(input, D, book(), defs());
  assert.ok(one.lines.every((l) => l.scope.type === "all"));
});

// The live CRM as the first seed left it (Nov 10): the old values, an owner's edits on top.
async function asOfNov10(owner, { edits = false } = {}) {
  await scope(async () => {
    const old = { by: "system:seed", origin: "worker", actor_kind: "automation", requestId: "seed-v1" };
    await store.updateRecord("price_item", SEED.seedItemId("tracks_standard"), (x) => ({ ...x, ...SEED.V1_ITEMS.tracks_standard }), old);
    await store.updateRecord("price_item", SEED.seedItemId("tracks_premium"), (x) => ({ ...x, ...SEED.V1_ITEMS.tracks_premium }), old);
    await store.updateRecord("discount_def", SEED.seedDiscountId("early_bird"), (x) => ({ ...x, ...SEED.V1_DISCOUNTS.early_bird }), old);
    await store.updateRecord("discount_def", SEED.seedDiscountId("three_year"), (x) => ({ ...x, ...SEED.V1_DISCOUNTS.three_year }), old);
    // the owner saved Settings → Pricing once (the page holds every number)
    const page = JSON.parse(JSON.stringify(D));
    page.tracks.standard_cents = 800;
    page.lights.three_year_off_cents = edits ? 15000 : 10000;
    await store.putSetting("pricing", page, { ...AS(owner), ifMatch: "new" });
    if (edits) {
      await store.updateRecord("price_item", SEED.seedItemId("tracks_premium"), (x) => ({ ...x, description: "Our own words for premium tracks." }), AS(owner));
      await store.updateRecord("discount_def", SEED.seedDiscountId("three_year"), (x) => ({ ...x, value: 15000 }), AS(owner));
    }
  });
}
const rec = async (type, id) => (await scope(() => store.getRecord(type, id))).data;
const notices = (t) => queued(t, "notify.deliver").filter((x) => x.data && x.data.note && x.data.note.title === "New suggested prices");

test("seed v2: an untouched seeded value moves once (audited), a second run changes nothing", async () => {
  const { t, owner } = await setup();
  try {
    await asOfNov10(owner);
    const before = await rec("price_item", SEED.seedItemId("tracks_standard"));
    assert.equal(before.unit_cents, 800);
    const out = await scope(() => SEED.upgradeOwnerDecisions({ write: () => AUTOMATION }));
    assert.equal(out.kept, 0);
    const ts = await rec("price_item", SEED.seedItemId("tracks_standard"));
    assert.equal(ts.unit_cents, 500);
    assert.equal(ts.description, SEED.SEED_PRICE_BOOK.find((x) => x.key === "tracks_standard").description);
    assert.equal(ts.wv, before.wv + 1, "one write");
    assert.match((await rec("price_item", SEED.seedItemId("tracks_premium"))).description, /soap solution/);
    const eb = await rec("discount_def", SEED.seedDiscountId("early_bird"));
    const ty = await rec("discount_def", SEED.seedDiscountId("three_year"));
    assert.deepEqual([eb.default_scope, ty.default_scope, ty.value], [{ type: "all" }, { type: "all" }, 20000]);
    const cfg = await scope(() => store.getSetting("pricing"));
    assert.equal(cfg.tracks.standard_cents, 500);
    assert.equal(cfg.lights.three_year_off_cents, 20000);
    assert.equal(cfg.lights.deadlines["2026"].length, 2, "the rest of the page is the owner's, untouched");
    // audited like any settings change and any record write
    assert.ok(t.stores.data.keys("evt/cfg/pricing/").some((k) => /update/.test(k)), "the pricing change is in the settings journal");
    assert.ok(t.stores.data.keys(`evt/price_item/${ts.id}/`).length >= 2);
    assert.equal(notices(t).length, 0, "nothing was left to the owners: no notice");
    // a second run: nothing
    const again = await scope(() => SEED.upgradeOwnerDecisions({ write: () => AUTOMATION }));
    assert.deepEqual([again.upgraded, again.kept], [0, 0]);
    assert.equal((await rec("price_item", SEED.seedItemId("tracks_standard"))).wv, ts.wv);
    // a new quote prices with the new values
    const s = P.suggestLines({ services: ["tracks_standard"], tracks: { standard: 4 } }, cfg, [ts]);
    assert.equal(s.lines[0].total_cents, 2000);
  } finally { t.done(); }
});

test("seed v2: what an owner changed stays theirs (one notice with the suggestion); imported quotes are never repriced", async () => {
  const { t, owner } = await setup();
  try {
    await asOfNov10(owner, { edits: true });
    // an imported Rotor quote with the old first-season lights discounts
    const ic = await importedContact();
    const q = await scope(() => store.createRecord("quote", {
      contact_id: ic.id, contact_name: "Robin Imported", number: "4242", status: "sent", rotor_id: "rq_example_1",
      options: [oneTime({ id: "op_r", lines: [{ id: "ln_r", title: "Christmas Light Installation", qty_milli: 150000, unit_cents: 800, category: "lights", unit: "ft", scope: { type: "all" }, override: { cents: 120000, reason: "imported" } }], discounts: [{ id: "dc_r", key: "three_year", name: "3-year contract", type: "fixed", value: 10000, scope: { type: "initial" } }] })],
      import: { run_id: "ir_00000000000000000001", at: "2026-11-08T00:00:00.000Z", hash: "0".repeat(64) },
    }, IMPORT));
    const out = await scope(() => SEED.upgradeOwnerDecisions({ write: () => AUTOMATION }));
    assert.ok(out.kept >= 3, JSON.stringify(out));
    // untouched fields moved
    assert.equal((await rec("price_item", SEED.seedItemId("tracks_standard"))).unit_cents, 500);
    const ty = await rec("discount_def", SEED.seedDiscountId("three_year"));
    assert.equal(ty.value, 15000, "the owner's $150 stays");
    assert.deepEqual(ty.default_scope, { type: "all" }, "the field nobody changed still moves");
    assert.equal((await rec("price_item", SEED.seedItemId("tracks_premium"))).description, "Our own words for premium tracks.");
    const cfg = await scope(() => store.getSetting("pricing"));
    assert.equal(cfg.lights.three_year_off_cents, 15000, "the owner's typed 3-year discount stays");
    assert.equal(cfg.tracks.standard_cents, 500, "the untouched fallback moves");
    // one notice for the owners, naming the suggestions
    const n = notices(t);
    assert.equal(n.length, 1);
    assert.match(n[0].data.note.body, /3-year contract \(\$200\.00\)/);
    assert.match(n[0].data.note.body, /Premium Track Detailing \(new wording\)/);
    assert.equal(n[0].data.note.link, "/settings/pricing");
    // a second run: nothing written, nobody told again
    const wv = (await rec("discount_def", SEED.seedDiscountId("three_year"))).wv;
    const again = await scope(() => SEED.upgradeOwnerDecisions({ write: () => AUTOMATION }));
    assert.equal(again.upgraded, 0);
    assert.equal((await rec("discount_def", SEED.seedDiscountId("three_year"))).wv, wv);
    assert.equal(notices(t).length, 1, "told once");
    // the imported quote is exactly as the import left it
    {
      const iq = await rec("quote", q.data.id);
      assert.deepEqual(iq.options[0].discounts[0], { id: "dc_r", key: "three_year", name: "3-year contract", type: "fixed", value: 10000, scope: { type: "initial" } });
      assert.equal(iq.wv, q.data.wv);
    }
  } finally { t.done(); }
});

test("seed v2 runs where seeds run (system.seed on the fast lane), once", async () => {
  const { t, owner } = await setup();
  try {
    await asOfNov10(owner);
    for (let i = 0; i < 4; i++) await t.runWorker({ lane: "fast" });
    const j = t.stores.data.json("op/seed--quotes--v2");
    assert.equal(j.status, "done", JSON.stringify(j));
    assert.equal((await rec("price_item", SEED.seedItemId("tracks_standard"))).unit_cents, 500);
    assert.equal((await rec("discount_def", SEED.seedDiscountId("three_year"))).value, 20000);
    const wv = (await rec("price_item", SEED.seedItemId("tracks_standard"))).wv;
    for (let i = 0; i < 2; i++) await t.runWorker({ lane: "fast" });
    assert.equal((await rec("price_item", SEED.seedItemId("tracks_standard"))).wv, wv, "the next passes leave it");
  } finally { t.done(); }
});
