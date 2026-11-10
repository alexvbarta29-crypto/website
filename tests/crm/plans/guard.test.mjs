// M3b acceptance: the parallel-run guard (design §0 rule 12, §3.10, §11.4
// "guard.test.mjs"): plans.ordinal_sync and plans.jobs_backfill (and the
// other automation on plans) are would- rows on imported plans Rotor still
// owns; on the CRM's own plans they act.
import { test } from "node:test";
import assert from "node:assert/strict";
import { setup, importedCustomer, importedPlan, staffPlan, planOf, recOf, drain, alog, pin, scope, store, ids, fakeServices, IMPORT, AS } from "./fixtures.mjs";

const would = (t, key, id, action) => alog(t).some((k) => k.includes(key) && k.includes(id) && k.endsWith(`would-${action}`));

async function importedJob(contact, plan, status) {
  const id = ids.idForRotor("job", `rotor-job-${plan.id}`);
  return scope(async () => (await store.createRecord("job", {
    id, number: 900 + Math.floor(Math.random() * 90), seq: "job", contact_id: contact.id, kind: "standard", title: "Exterior window cleaning", lines: [{ id: "rl1", title: "Exterior", qty_milli: 1000, unit_cents: 24500 }],
    discounts: [], status, plan_id: plan.id, plan_ordinal: { term: 1, n: 2 }, visit_ids: [], invoice_ids: [], assignee_ids: [], office_notes: "", crew_notes: "", review: {},
    ...(status === "completed" ? { completed_at: "2026-11-10T18:00:00.000Z" } : {}), rotor: { job_id: `rotor-job-${plan.id}` },
    import: { run_id: "ir_00000000000000000001", at: "2026-11-08T00:00:00.000Z", hash: "0".repeat(64) },
  }, IMPORT)).data);
}

test("plans.jobs_backfill: a would-create row for an imported plan's visit with no job; the CRM's own plan gets its jobs", async () => {
  const { t, owner } = await setup();
  try {
    const ip = await importedPlan(await importedCustomer());
    // the CRM's own plan, made while Scheduling was hidden: no jobs yet
    const off = fakeServices({ "work.createJobs": null });
    let own;
    try { own = (await staffPlan(t, owner)).plan; } finally { off(); }
    assert.ok(own.ordinals.every((o) => !o.job_id), "no jobs before Scheduling");
    pin("2026-11-17T16:05:00Z");
    await drain(t, 3);
    assert.ok(would(t, "plans.jobs_backfill", ip.id, "create"), "a would-create row for Rotor's plan");
    assert.ok(!(await planOf(ip.id)).ordinals[1].job_id, "Rotor's plan unchanged");
    assert.equal(t.stores.data.keys("rec/job/").filter((k) => t.stores.data.json(k).contact_id === ip.contact_id).length, 0, "no job for Rotor's customer");
    const mine = await planOf(own.id);
    assert.ok(mine.ordinals.every((o) => o.job_id), "the CRM's plan got a job per visit");
    assert.equal(new Set(mine.ordinals.map((o) => o.job_id)).size, 4);
    // the next hour: nothing twice
    pin("2026-11-17T17:05:00Z");
    await drain(t, 2);
    assert.equal(t.stores.data.keys("rec/job/").length, 4);
  } finally { t.done(); }
});

test("plans.ordinal_sync and the job listener: would-update rows for an imported plan; the CRM's plan follows its jobs", async () => {
  const { t, owner } = await setup();
  try {
    const c = await importedCustomer();
    const ip = await importedPlan(c);
    const job = await importedJob(c, ip, "completed");
    await scope(() => store.updateRecord("plan", ip.id, (p) => ({ ...p, ordinals: p.ordinals.map((o) => (o.n === 2 ? { ...o, job_id: job.id } : o)) }), IMPORT));
    pin("2026-11-17T16:05:00Z");
    await drain(t, 3);
    assert.ok(would(t, "plans.ordinal_sync", ip.id, "update"), "a would-update row");
    assert.equal((await planOf(ip.id)).ordinals[1].status, "unscheduled", "Rotor's plan unchanged");
    // the CRM's own plan: its job cancelled in Scheduling → the ordinal follows (listener), and the sync finds nothing left
    const { plan } = await staffPlan(t, owner);
    await scope(async () => (await import("../../../netlify/lib/crm/modules/work/office.mjs")).cancelJob(plan.ordinals[3].job_id, "customer asked", { write: () => AS(owner) }));
    await drain(t, 3);
    assert.equal((await planOf(plan.id)).ordinals[3].status, "cancelled");
  } finally { t.done(); }
});

test("plans.due: an imported plan whose cancel date came gets a would-cancel row; the CRM's own cancels", async () => {
  const { t, owner } = await setup();
  try {
    const ip = await importedPlan(await importedCustomer(), { status: "cancelling", cancel: { requested_on: "2026-11-01", effective_on: "2026-11-08", reason: "price", clawback_cents: 0, by: "import" } });
    const { plan } = await staffPlan(t, owner);
    await t.api(`/plans/${plan.id}/activate`, { method: "POST", as: owner, body: { override_reason: "Paper copy" } });
    await drain(t, 2);
    const cancel = await t.api(`/plans/${plan.id}/cancel`, { method: "POST", as: owner, body: { reason: "moving" } });
    await drain(t, 2);
    assert.equal((await planOf(plan.id)).status, "cancelling", JSON.stringify(cancel.body));
    pin("2026-11-25T13:00:00Z");
    await drain(t, 3);
    assert.ok(would(t, "plans.due", ip.id, "cancel"), "a would-cancel row");
    assert.equal((await planOf(ip.id)).status, "cancelling");
    assert.equal((await planOf(plan.id)).status, "cancelled");
  } finally { t.done(); }
});

test("the store's backstop: automation can't create a plan for an imported customer", async () => {
  const { t } = await setup();
  try {
    const c = await importedCustomer();
    const { AUTOMATION } = await import("./fixtures.mjs");
    await assert.rejects(scope(() => store.createRecord("plan", { contact_id: c.id, kind: "recurring", catalog_key: "biannual", name: "Biannual plan", term: { start_on: "2026-11-17" }, ordinals: [] }, AUTOMATION)), (e) => e.name === "ParallelRunGuard");
  } finally { t.done(); }
});
