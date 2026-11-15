// The New plan form (Flyra's "New Subscription", Nov 15): what POST /plans
// takes from it beyond the catalog plan, lines, discounts, start and term:
// how often (a rhythm the catalog plan doesn't have makes a custom plan),
// the salesperson, the office's notes. Synthetic data only.
import { test } from "node:test";
import assert from "node:assert/strict";
import { setup, customer, staffPlan, EXT } from "./fixtures.mjs";

test("New plan: every 4 months is a custom plan with 3 visits a year; the salesperson and notes are kept", async () => {
  const { t, owner, admin } = await setup();
  try {
    const c = await customer(owner);
    const { plan } = await staffPlan(t, owner, { contact: c, catalog_key: "quarterly", lines: [EXT()], discounts: [], frequency: { interval: "month", count: 4 }, sold_by: admin.id, notes: "Gate code at the side door", start_on: "2026-11-20" });
    assert.equal(plan.catalog_key, "custom");
    assert.deepEqual(plan.frequency, { interval: "month", count: 4 });
    assert.equal(plan.visits_per_year, 3);
    assert.deepEqual(plan.ordinals.map((o) => o.target_month), ["2026-11", "2027-03", "2027-07"]);
    assert.equal(plan.sold_by, admin.id);
    assert.equal(plan.notes, "Gate code at the side door");

    // the catalog's own rhythm keeps the catalog plan
    const { plan: q } = await staffPlan(t, owner, { contact: c, catalog_key: "biannual", lines: [EXT()], discounts: [], frequency: { interval: "month", count: 6 }, start_on: "2026-11-20" });
    assert.equal(q.catalog_key, "biannual");
    assert.equal(q.visits_per_year, 2);
    assert.equal(q.sold_by, owner.id, "no salesperson picked: who made it");

    for (const bad of [{ frequency: { interval: "month", count: 5 } }, { frequency: { interval: "week", count: 2 } }, { sold_by: "us_00000000000000000000" }]) {
      const r = await t.api("/plans", { method: "POST", as: owner, body: { contact_id: c.id, catalog_key: "biannual", lines: [EXT()], ...bad } });
      assert.equal(r.status, 400, JSON.stringify(bad));
    }
  } finally { t.done(); }
});
