// The plans module's import phases (design §10.2 rows 17, 19-21, 25;
// decision D9) through the M2c runner on a synthetic export: Rotor's
// agreement templates link to the seeded drafts; recurring and lights
// plans become plans (ids from Rotor's, ordinals from their jobs, the jobs
// learn their plan), a One-Time container with several jobs a hidden
// series, one with a single job nothing; lights plans get their season and
// this season's installs a January takedown job; a second run changes
// nothing and makes nothing twice.
import { test } from "node:test";
import assert from "node:assert/strict";
import { setup, importExport, generate, store } from "../import/fixtures.mjs";

const { idForRotor } = await import("../../../netlify/lib/crm/core/ids.mjs");
const { rotorKey } = await import("../../../netlify/lib/crm/modules/contacts/display.mjs");
const AG = await import("../../../netlify/lib/crm/modules/plans/agreements.mjs");
const IMP = await import("../../../netlify/lib/crm/modules/plans/import-rotor.mjs");
const AUTO = { by: "system:test", origin: "worker", actor_kind: "automation", requestId: "test" };

test("the pure mapping: lines per visit, the five discount shapes, scopes, catalog keys, terms", () => {
  const unit = IMP.planLine({ id: "a1", title: "Christmas Lights", quantity: 120, unit_price: 10, use_unit_pricing: true, total_price: 99999 }, 0);
  assert.equal(unit.override.cents, 120000, "unit × quantity, never the plan-wide total");
  const flat = IMP.planLine({ id: "a2", title: "Exterior Window Cleaning", custom_price: 245, total_price: 490, jobSchedule: { type: "specific", selectedJobs: [1, 3] }, client_optional: true }, 1);
  assert.equal(flat.override.cents, 24500);
  assert.deepEqual(flat.scope, { type: "specific", visits: [1, 3] });
  assert.equal(flat.optional, true);
  assert.equal(flat.id, "a2", "the id kept verbatim");
  assert.deepEqual(IMP.planDiscounts([]), []);
  assert.deepEqual(IMP.planDiscounts({ multi: [{ name: "Bi-Annual Discount", type: "fixed", value: 50, jobSchedule: { type: "all" } }] }).map((d) => [d.name, d.type, d.value]), [["Bi-Annual Discount", "fixed", 5000]]);
  assert.deepEqual(IMP.planDiscounts({ enabled: true, type: "percentage", value: 50 }).map((d) => [d.type, d.value]), [["percentage", 5000]]);
  assert.deepEqual(IMP.planDiscounts({ enabled: false, type: "fixed", value: 50 }), []);
  assert.equal(IMP.planDiscounts({ enabled: true, multi: [{ type: "fixed", value: 100 }], type: "fixed", value: 50 })[0].value, 10000, "multi wins");
  assert.equal(IMP.planDiscounts({ enabled: true, multi: [{ name: "Google Review & Local Post", type: "fixed", value: 50, jobSchedule: { type: "initial" } }] })[0].scope.type, "initial");
  assert.equal(IMP.catalogOf({ frequency_name: "Semi-Annual", interval: "month", count: 6 }), "biannual");
  assert.equal(IMP.catalogOf({ frequency_name: "Quarterly", interval: "month", count: 3 }), "quarterly");
  assert.equal(IMP.catalogOf({ frequency_name: "Annual", interval: "year", count: 1, lights: true }), "lights_annual");
  assert.equal(IMP.catalogOf({ frequency_name: "Every 2 weeks", interval: "week", count: 2 }), "custom");
  assert.equal(IMP.templateKeyOf("Bi-Annual Service Agreement "), "biannual");
  assert.equal(IMP.templateKeyOf("Christmas Light Installation Agreement"), "lights");
  assert.equal(IMP.templateKeyOf("One Time Service Agreement"), "one_time");
  const t = IMP.termAt("2025-06-01", 12, 6, true, "2026-11-17");
  assert.deepEqual([t.n, t.start, t.end], [2, "2026-06-01", "2026-11-30"], "an auto-renewing plan's current term");
  assert.equal(IMP.takedownSeason("2026-11-17"), 2026);
  assert.equal(IMP.takedownSeason("2027-01-10"), 2026);
});

test("templates, plans, series and lights from a Rotor export, twice", async () => {
  const { t, owner } = await setup();
  try {
    await store.withStoreScope({ requestId: "t" }, () => AG.seedAgreementTemplates(AUTO));
    const ex = generate({ scale: 0.06, seed: 31 });
    const first = await importExport(t, owner, ex);
    assert.equal(first.run.status, "done", JSON.stringify(first.run.summary));

    // row 17: Rotor's 5 templates onto the seeded drafts
    for (const r of ex.agreement_templates) {
      const key = IMP.templateKeyOf(r.name);
      const rec = t.stores.data.json(`rec/agreement_template/${AG.seedTemplateId(key)}`);
      assert.equal(rec.rotor.template_id, r.id, `${r.name} linked`);
      assert.equal(rec.approved_version, undefined, "still a draft for the owner to approve (D10)");
      assert.equal(t.stores.data.json(`ptr/rotor/agreement-template/${rotorKey(r.id)}`).id, rec.id);
    }
    assert.equal(t.stores.data.keys("rec/agreement_template/").length, 6, "no duplicates (the five Rotor names and the CRM's Custom text)");

    // row 19: which Rotor plans became plans
    const plans = t.stores.data.keys("rec/plan/").map((k) => t.stores.data.json(k));
    let recurring = 0, series = 0, lights = 0, none = 0;
    for (const r of ex.service_plans) {
      const oneTime = !r.interval || r.service_frequency === "One-Time";
      const isLights = (r.service_types || []).includes("Christmas Lights");
      const p = plans.find((x) => x.rotor && x.rotor.service_plan_id === r.id);
      if (oneTime && !isLights && r.jobs.length <= 1) { assert.equal(p, undefined, "a one-job One-Time container is no plan"); none += 1; continue; }
      assert.ok(p, `plan for ${r.service_frequency}`);
      assert.equal(p.id, idForRotor("plan", r.id));
      assert.equal(p.created_by, "import");
      assert.ok(p.import);
      if (oneTime && !isLights) { assert.equal(p.kind, "one_time_series"); series += 1; } else if (isLights) { assert.equal(p.kind, "lights_annual"); lights += 1; } else { assert.equal(p.kind, "recurring"); recurring += 1; }
      assert.equal(p.ordinals.length, r.jobs.length, "an ordinal per job, in order");
      p.ordinals.forEach((o, i) => assert.equal(o.job_id, idForRotor("job", r.jobs[i].id)));
      assert.equal(p.status, r.cancelled ? "cancelled" : r.active ? "active" : "expired");
      assert.equal(p.billing.mode, r.billing_mode === "after_jobs" ? "after_visit" : "first_of_month");
      assert.equal(p.billing.autopay, r.is_auto_pay);
      assert.equal(p.agreement_status, p.status === "active" ? "imported_unknown" : "none", "no signature on file (G18)");
      assert.equal(p.lines.length, (r.jobs_config.line_items || []).length);
      // the jobs learned their plan
      for (const [i, j] of r.jobs.entries()) {
        const job = t.stores.data.json(`rec/job/${idForRotor("job", j.id)}`);
        if (!job) continue;
        assert.equal(job.plan_id, p.id);
        assert.equal(job.plan_ordinal.n, p.ordinals[i].n);
      }
    }
    assert.ok(recurring > 0 && lights > 0 && series > 0 && none > 0, JSON.stringify({ recurring, lights, series, none }));
    const cancelled = plans.find((p) => p.status === "cancelled");
    if (cancelled) assert.ok(["price", "other"].includes(cancelled.cancel.reason));
    // the index (rebuilt by the run) lists recurring and lights plans, never the hidden series
    const ix = await store.withStoreScope({ requestId: "t" }, () => store.readIndex("plans", ""));
    assert.equal(ix.rows.length, recurring + lights);
    assert.ok(ix.rows.every((r) => r.k !== "one_time_series"));
    // row 20: plan template ids kept for joins
    const cat = t.stores.data.json("cfg/plans_catalog");
    assert.ok(cat && cat.rotor_template_ids.length > 0);

    // row 25: a season per lights plan; this season's installs get a January takedown (D9)
    const seasons = t.stores.data.keys("rec/season_install/").map((k) => t.stores.data.json(k));
    assert.equal(seasons.length, lights);
    const takedowns = t.stores.data.keys("rec/job/").map((k) => t.stores.data.json(k)).filter((j) => j.kind === "lights_takedown" && !j.rotor);
    const thisSeason = seasons.filter((s) => s.season === 2026 && s.status !== "cancelled");
    assert.equal(takedowns.length, thisSeason.length, "one takedown per 2026 install");
    for (const s of thisSeason) {
      const tj = t.stores.data.json(`rec/job/${s.takedown_job_id}`);
      assert.equal(tj.target_month, "2027-01");
      assert.equal(tj.status, "unscheduled");
      assert.equal(tj.billable, false);
      assert.equal(tj.created_by, "import", "made by the import, not by automation");
      assert.equal(tj.season_install_id, s.id);
    }

    // a second run of the same export: nothing new, nothing changed
    const snap = Object.fromEntries(["plan", "season_install", "agreement_template"].flatMap((type) => t.stores.data.keys(`rec/${type}/`).map((k) => [k, JSON.stringify(t.stores.data.json(k))])));
    const jobs = t.stores.data.keys("rec/job/").length;
    const again = await importExport(t, owner, ex);
    assert.equal(again.run.status, "done");
    assert.equal(again.run.summary.created, 0);
    assert.equal(again.run.summary.conflicted, 0);
    assert.equal(t.stores.data.keys("rec/job/").length, jobs, "no takedown twice");
    for (const [k, v] of Object.entries(snap)) assert.equal(JSON.stringify(t.stores.data.json(k)), v, `${k} unchanged`);
  } finally { t.done(); }
});
