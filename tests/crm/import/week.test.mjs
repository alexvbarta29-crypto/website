// M2c acceptance: a week of the parallel run (design §11.4 "week.test.mjs",
// §10.7 test 3, §3.10). Import, run every sweep on both lanes for a
// simulated week with the pinned clock (Rotor in charge: the parallel-run
// guard keeps automation report-only on imported records), re-import the
// unchanged export: 0 conflicts, every rotorField byte-identical, and no
// invoice, job or message record created.
import { test } from "node:test";
import assert from "node:assert/strict";
import { setup, importExport, store, rotorSnapshot, generate } from "./fixtures.mjs";
import { advance, hours } from "../../helpers/crm-clock.mjs";

const { allSweeps } = await import("../../../netlify/lib/crm/core/registry.mjs");

test("import, a simulated week of every sweep, the same export again: 0 conflicts, rotorFields byte-identical, nothing mirrored created", async () => {
  const { t, owner } = await setup({ now: "2026-11-16T14:00:00Z" });
  try {
    const ex = generate({ scale: 0.03, seed: 41 });
    const first = await importExport(t, owner, ex);
    assert.equal(first.run.status, "done");
    const snap = await rotorSnapshot(t.stores);
    assert.ok(Object.keys(snap).length > 40, "a real amount of imported records");
    const sweepKeys = allSweeps().map((s) => s.key);
    assert.ok(sweepKeys.includes("contacts.stats") && sweepKeys.includes("index.verify") && sweepKeys.includes("import.staging_gc"));

    // a week, hour by hour: one fast pass and one bulk pass each hour (every sweep comes due)
    for (let h = 0; h < 24 * 7; h++) {
      await t.runWorker({ lane: "fast" });
      await t.runWorker({ lane: "bulk" });
      advance(hours(1));
    }
    // the daily sweeps really ran every day (their exactly-once markers)
    for (const key of ["contacts.stats", "index.verify", "backup.nightly", "import.staging_gc"]) {
      assert.ok(t.stores.data.keys(`done/sweep/${key}--`).length >= 6, `${key} ran each day`);
    }
    assert.deepEqual(await rotorSnapshot(t.stores), snap, "a week of automation changed no Rotor-owned field");

    const again = await importExport(t, owner, ex);
    assert.equal(again.run.status, "done");
    assert.equal(again.run.summary.conflicts_open, 0);
    assert.equal(again.run.summary.conflicted, 0);
    assert.equal(again.run.summary.created, 0);
    assert.deepEqual(await rotorSnapshot(t.stores), snap, "every rotorField byte-identical");
    // nothing mirrored was created by automation: whatever exists came from the import
    for (const type of ["invoice", "job", "message", "conversation", "visit", "payment", "quote", "plan"]) {
      const made = t.stores.data.keys(`rec/${type}/`).filter((k) => t.stores.data.json(k).created_by !== "import");
      assert.deepEqual(made, [], `no ${type} record created`);
    }
    // Quotes (M3a) imports Rotor's quotes: every quote record is the import's, none made by automation
    const quotes = t.stores.data.keys("rec/quote/");
    assert.equal(quotes.length, ex.quotes.length, "one quote per Rotor quote");
    assert.ok(quotes.every((k) => t.stores.data.json(k).import && t.stores.data.json(k).created_by === "import"), "no quote record created by automation");
  } finally { t.done(); }
});
