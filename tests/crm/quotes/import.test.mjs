// The quotes import phases (design §10.2 rows 4, 5, 18; §11.4 M3a gate:
// "every imported quote's stored totals are unchanged and engine-vs-stored
// differences are in the report"), on the synthetic Rotor export through
// M2c's real runner. Pure helpers first.
import { test } from "node:test";
import assert from "node:assert/strict";
import { setup, importExport, generate, rotorSnapshot, ids } from "../import/fixtures.mjs";

const I = await import("../../../netlify/lib/crm/modules/quotes/import-rotor.mjs");
const SEED = await import("../../../netlify/lib/crm/modules/quotes/seed.mjs");

test("pure: titles → price items, Rotor's spelling → the discount catalog, the five discount shapes, frequencies → options", () => {
  assert.equal(I.itemKeyFor("Exterior Window Cleaning "), "exterior");
  assert.equal(I.itemKeyFor("Interior Window Cleaning"), "interior");
  assert.equal(I.itemKeyFor("Premium Track Detailing"), "tracks_premium");
  assert.equal(I.itemKeyFor("Christmas Light Materials (Gutter Line)"), "lights_materials");
  assert.equal(I.itemKeyFor("Christmas Light Installation - Chimney"), "lights_install");
  assert.equal(I.itemKeyFor("FREE Takedown + FREE Storage"), "lights_takedown");
  assert.equal(I.itemKeyFor("Soft Wash House and Shed"), "soft_wash");
  assert.equal(I.discountKeyFor("Bi-Annuall"), "plan_biannual");
  assert.equal(I.discountKeyFor("EARLY Bird Discount"), "early_bird");
  assert.equal(I.discountKeyFor("Early Brid"), "early_bird");
  assert.equal(I.discountKeyFor("First Time Customer "), "first_time");
  assert.equal(I.discountKeyFor("3-Year Contract"), "three_year");
  assert.equal(I.discountKeyFor("Google Review & Local Post"), "google_review");
  assert.equal(I.discountKeyFor("Something brand new"), null);
  assert.deepEqual(I.discountEntries(null), []);
  assert.deepEqual(I.discountEntries([]), []);
  assert.deepEqual(I.discountEntries({}), []);
  assert.deepEqual(I.discountEntries({ type: "fixed", value: 0, enabled: false }), []);
  assert.deepEqual(I.discountEntries({ enabled: true, type: "fixed", value: 50 }).map((d) => [d.type, d.value_raw]), [["fixed", 50]]);
  assert.equal(I.discountEntries({ multi: [{ name: "Quarterly Discount", type: "fixed", value: 100, jobSchedule: { type: "all" } }, { type: "percentage", value: 50 }] }).length, 2);
  // `enabled` switches the old single discount only: Rotor takes every multi entry off (the 2026-11-13 export)
  assert.deepEqual(I.discountEntries({ multi: [{ name: "x", type: "fixed", value: 50 }], enabled: false }).map((d) => [d.name, d.type, d.value_raw]), [["x", "fixed", 50]]);
  assert.deepEqual(I.discountEntries({ enabled: false, type: "fixed", value: 50 }), []);
  assert.deepEqual(I.discountEntries({ enabled: false, multi: [{ name: "Zero", type: "fixed", value: 0 }], type: "fixed", value: 0 }), []);
  assert.equal(I.toMilli("1.5"), 1500);
  assert.equal(I.toMilli(154.5), 154500);
  assert.equal(I.toMilli("0.0005"), 1);
  const opt = (name, extra = {}) => I.optionShape({ frequency: name ? { name, interval: name === "One-Time" ? null : "month", count: 1 } : null, service_types: [], ...extra });
  assert.equal(opt("One-Time").kind, "one_time");
  assert.equal(opt(null).kind, "one_time");
  assert.equal(I.optionShape({ frequency: { name: "Semi-Annual", interval: "month", count: 6 }, service_types: [] }).plan.catalog_key, "biannual");
  assert.equal(I.optionShape({ frequency: { name: "Quarterly", interval: "month", count: 3 }, service_types: [], billing_mode: "start_of_month" }).plan.billing, "first_of_month");
  assert.equal(I.optionShape({ frequency: { name: "Annual", interval: "year", count: 1 }, service_types: ["Christmas Lights"], service_length_months: 36 }).plan.catalog_key, "lights_annual");
  assert.equal(I.optionShape({ frequency: { name: "Annual", interval: "year", count: 1 }, service_types: ["Christmas Lights"], service_length_months: 36 }).plan.term_months, 36);
  assert.equal(I.optionShape({ frequency: { name: "Annual", interval: "year", count: 1 }, service_types: ["Residential Window Cleaning"] }).plan.catalog_key, "custom");
});

test("the synthetic export: every quote imported with Rotor's number and prices, line ids kept, overrides 'imported'; the price book and discounts learn Rotor's ids and names; a re-run changes nothing", async () => {
  const { t, owner } = await setup();
  try {
    const ex = generate({ scale: 0.05, seed: 7 });
    const r = await importExport(t, owner, ex);
    assert.equal(r.run.status, "done");
    const quotes = t.stores.data.keys("rec/quote/").map((k) => t.stores.data.json(k));
    assert.equal(quotes.length, ex.quotes.length);
    for (const row of ex.quotes) {
      const q = t.stores.data.json(`rec/quote/${ids.idForRotor("quote", row.id)}`);
      assert.ok(q, "every Rotor quote");
      assert.equal(q.number, row.quote_number);
      assert.equal(q.number_label, `Q-${row.quote_number}`);
      assert.equal(t.stores.data.json(`ptr/quote-no/${row.quote_number}`).id, q.id);
      assert.equal(q.created_by, "import");
      assert.ok(q.import);
      const st = { draft: "draft", sent: row.viewed_at ? "viewed" : "sent", approved: "approved", rejected: "declined", modification_requested: "changes_requested", converted: "converted" }[row.status];
      assert.equal(q.status, st);
      const o = q.options[0];
      const lines = row.jobs_config.line_items;
      assert.deepEqual(o.lines.map((l) => l.id), lines.map((l) => l.id), "Rotor line ids kept verbatim");
      for (const [i, l] of lines.entries()) {
        const m = o.lines[i];
        if (l.use_custom_price) {
          assert.equal(m.override.reason, "imported");
          assert.equal(m.total_cents, Math.round(l.custom_price * 100), "dollars → cents, the legacy total_price × visits ignored");
        } else assert.equal(m.total_cents, Math.round(l.quantity * l.unit_price * 100));
        if (l.jobSchedule.type === "specific") assert.deepEqual(m.scope, { type: "specific", visits: l.jobSchedule.selectedJobs });
        if (l.client_optional) { assert.equal(m.optional, true); assert.equal(m.selected, true, "Rotor's total counts an optional line"); }
      }
      // the quote's own totals are Rotor's `total` (visit 1: its lines less its discounts)
      assert.equal(o.totals.first_cents, Math.round(row.total * 100), `Q-${row.quote_number} totals Rotor's`);
      const entries = I.discountEntries(row.jobs_config.discounts);
      assert.equal(o.discounts.length, entries.length, "every discount Rotor takes off");
    }
    assert.ok(ex.quotes.some((q) => q.jobs_config.discounts && q.jobs_config.discounts.enabled === false && (q.jobs_config.discounts.multi || []).length), "the export has a multi discount with enabled: false");
    // the report: no engine-vs-Rotor difference left
    const rep = (await t.api(`/import/runs/${r.ir.id}/report`, { as: owner })).body.data;
    const ph = rep.phases.find((p) => p.name === "quotes.quotes");
    assert.ok(ph, JSON.stringify(rep.phases.map((p) => p.name)));
    assert.equal(ph.warnings.quote_total_differs || 0, 0, "every quote totals Rotor's");
    // price book: template ids attached to the seeded items, each id to one item
    const book = t.stores.data.keys("rec/price_item/").map((k) => t.stores.data.json(k));
    const attached = book.flatMap((i) => i.rotor_template_ids || []);
    assert.ok(attached.length > 0);
    assert.equal(new Set(attached).size, attached.length);
    for (const tid of attached.slice(0, 5)) assert.ok(t.stores.data.json(`ptr/rotor/template/${tid}`));
    // discounts: Rotor's spellings on the catalog
    const defs = t.stores.data.keys("rec/discount_def/").map((k) => t.stores.data.json(k));
    const seen = new Set(ex.quotes.flatMap((q) => I.discountEntries(q.jobs_config.discounts).map((e) => e.name || "Discount")));
    for (const name of seen) assert.ok(defs.some((d) => (d.rotor_names || []).includes(name) || d.name === name), `${name} is on the catalog`);
    assert.ok(defs.filter((d) => d.key.startsWith("rotor_")).every((d) => d.sellable === false), "a name nothing matched is kept, not sellable");
    // a re-run of the same export: nothing written
    const snap = await rotorSnapshot(t.stores, ["quote", "price_item", "discount_def"]);
    const again = await importExport(t, owner, ex);
    assert.equal(again.run.status, "done");
    assert.equal(again.run.summary.created, 0);
    assert.equal(again.run.summary.conflicted, 0);
    assert.deepEqual(await rotorSnapshot(t.stores, ["quote", "price_item", "discount_def"]), snap, "byte-identical");
  } finally { t.done(); }
});
