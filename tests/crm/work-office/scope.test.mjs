// M4a acceptance (design §11.4 "scope.test.mjs", §11.3 work.createJobs):
// plans and quotes calling createJobs in one op never collide; ids derive
// from the op and the scope; numbers are journaled (a crash in the middle
// and a re-run make nothing twice and leave no gap); the parallel-run guard
// holds for automation; cancelJobs is safe to repeat.
import { test } from "node:test";
import assert from "node:assert/strict";
import { setup, customer, importedCustomer, store, ids, ops, services, OFF, AS, AUTOMATION, LINES } from "./fixtures.mjs";
import { fixtureModule } from "../../helpers/crm-fixtures.mjs";

// a listener (as Money, Plans or Sales would have) so job.created events are queued and countable
const heard = [];
fixtureModule({ events: { "job.created": { handler: async (e) => { heard.push(e.payload.job_id); return { result: "done" }; }, mutates: false } } });

const spec = (c, extra = {}) => ({ contact_id: c.id, kind: "standard", lines: LINES, ...extra });

test("plans and quotes calling createJobs in one op never collide, and a re-run makes nothing twice", async () => {
  const { t, owner } = await setup();
  try {
    const c = await customer(owner);
    const opId = "approve--qt_00000000000000000001--1";
    const ctx = AS(owner);
    const steps = [
      { name: "plan", run: async (s) => services.call("work.createJobs", [spec(c, { plan_ordinal: { term: 1, n: 1 }, target_month: "2026-12" }), spec(c, { plan_ordinal: { term: 1, n: 2 }, target_month: "2027-03" })], s.opId, "plans", s.ctx) },
      { name: "quote", run: async (s) => services.call("work.createJobs", [spec(c, { title: "Gutters" })], s.opId, "quotes", s.ctx) },
    ];
    const out = await ops.runOp(opId, steps, { ctx, holder: "test" });
    assert.equal(out.status, "done");
    const j = await ops.readOp(opId);
    const planIds = j.out.plan, quoteIds = j.out.quote;
    assert.equal(planIds.length, 2);
    assert.equal(quoteIds.length, 1);
    assert.equal(new Set([...planIds, ...quoteIds]).size, 3, "three different jobs");
    assert.equal(planIds[0], ids.deriveId("job", opId, "work.createJobs@plans", 1));
    assert.equal(quoteIds[0], ids.deriveId("job", opId, "work.createJobs@quotes", 1));
    const jobs = await Promise.all([...planIds, ...quoteIds].map(async (id) => (await store.getRecord("job", id)).data));
    assert.deepEqual(jobs.map((x) => x.number_label).sort(), ["S-000001", "S-000002", "S-000003"], "shadow numbers while Rotor is in charge, no gaps");
    assert.ok(jobs.every((x) => x.status === "unscheduled" && x.shadow === true));
    assert.equal(jobs[0].plan_ordinal.n, 1);
    assert.equal(jobs[0].totals.total_cents, 29500);
    // the same calls again (a retried op step): the same ids, nothing new
    const again = await services.call("work.createJobs", [spec(c, { plan_ordinal: { term: 1, n: 1 } }), spec(c, { plan_ordinal: { term: 1, n: 2 } })], opId, "plans", ctx);
    assert.deepEqual(again, planIds);
    assert.equal(t.stores.data.keys("rec/job/").length, 3);
    assert.equal(t.stores.data.keys("ptr/job-shadow-no/").length, 3);
    // each job announced once
    const created = t.stores.data.keys("q/").map((k) => t.stores.data.json(k)).filter((q) => q.data && q.data.name === "job.created");
    assert.equal(created.length, 3);
    assert.equal(new Set(created.map((q) => q.data.payload.job_id)).size, 3);
  } finally { t.done(); }
});

test("a crash half way: the retry finishes with the numbers the journal kept, no gap, nothing twice", async () => {
  const { t, owner } = await setup();
  try {
    const c = await customer(owner);
    const opId = "lights--pl_00000000000000000001--1";
    const second = ids.deriveId("job", opId, "work.createJobs@lights", 2);
    t.stores.data.fail({ op: "setJSON", key: new RegExp(`^rec/job/${second}$`), times: 1, kind: "internal" });
    t.stores.data.fail({ op: "setJSON", key: new RegExp(`^rec/job/${second}$`), times: 3, kind: "internal" });
    await assert.rejects(OFF.createJobs([spec(c, { kind: "lights_install" }), spec(c, { kind: "lights_takedown", lines: [], target_month: "2027-01" })], opId, "lights", AS(owner)));
    t.stores.data.clearHooks();
    // the worker's ops.resume could finish it too; here the caller retries
    const sub = ops.opIdFor(`jobs--${opId}--lights`, 1);
    const j = await ops.readOp(sub);
    assert.equal(j.status, "running", "the sub-op waits to be resumed");
    await store.settledWrite(ops.opKey(sub), { ...j, etag: undefined, lease_until: "2026-11-17T14:00:00.000Z" }, { onlyIfMatch: j.etag });
    const idsOut = await OFF.createJobs([spec(c, { kind: "lights_install" }), spec(c, { kind: "lights_takedown", lines: [], target_month: "2027-01" })], opId, "lights", AS(owner));
    const jobs = await Promise.all(idsOut.map(async (id) => (await store.getRecord("job", id)).data));
    assert.deepEqual(jobs.map((x) => x.number), [1, 2], "the first number kept, the next one used, no gap");
    assert.equal(jobs[1].billable, false, "takedowns aren't billed");
    assert.equal(jobs[1].title, "Christmas lights takedown");
    assert.deepEqual(t.stores.data.keys("ptr/job-shadow-no/").map((k) => k.split("/").pop()).sort(), ["1", "2"]);
  } finally { t.done(); }
});

test("the parallel-run guard: automation makes jobs only for sandboxed contacts; people and the import may", async () => {
  const { t, owner } = await setup();
  try {
    const imported = await importedCustomer();
    await assert.rejects(OFF.createJobs([spec(imported)], "backfill--1", "plans", AUTOMATION), (e) => e.name === "ParallelRunGuard");
    assert.equal(await ops.readOp(ops.opIdFor("jobs--backfill--1--plans", 1)), null, "refused before any journal");
    const shadow = await customer(owner);
    const [id] = await OFF.createJobs([spec(shadow)], "backfill--2", "plans", AUTOMATION);
    assert.ok((await store.getRecord("job", id)).data.shadow);
    const [mine] = await OFF.createJobs([spec(imported)], "office--1", "manual", AS(owner));
    assert.ok(await store.getRecord("job", mine), "a person may");
    // bad input stops before anything is written
    await assert.rejects(OFF.createJobs([{ contact_id: shadow.id, kind: "spaceship" }], "bad--1", "plans", AS(owner)), (e) => e.name === "InputError");
    await assert.rejects(OFF.createJobs([spec(shadow)], "", "plans", AS(owner)), (e) => e.name === "InputError");
    assert.equal(await ops.readOp(ops.opIdFor("jobs--bad--1--plans", 1)), null);
  } finally { t.done(); }
});

test("cancelJobs cancels open jobs and their visits, skips closed ones, and is safe to repeat", async () => {
  const { t, owner, tech } = await setup();
  try {
    const c = await customer(owner);
    const [a, b] = await OFF.createJobs([spec(c), spec(c)], "plan--x--1", "plans", AS(owner));
    const v = (await OFF.createVisit({ job_id: a, date: "2026-11-24", start: "08:00", end: "10:00", assignee_ids: [tech.id] }, AS(owner))).visit;
    const r1 = await services.call("work.cancelJobs", [a, b, "jb_00000000000000000000"], "plan cancelled", "cancel--pl_1--1", AS(owner));
    assert.deepEqual(r1.cancelled.sort(), [a, b].sort());
    assert.deepEqual(r1.skipped, ["jb_00000000000000000000"]);
    assert.equal((await store.getRecord("visit", v.id)).data.status, "cancelled");
    const ja = (await store.getRecord("job", a)).data;
    assert.equal(ja.status, "cancelled");
    assert.equal(ja.cancel_reason, "plan cancelled");
    const r2 = await services.call("work.cancelJobs", [a, b], "plan cancelled", "cancel--pl_1--1", AS(owner));
    assert.deepEqual(r2.cancelled, []);
    assert.equal((await store.getRecord("job", a)).data.wv, ja.wv, "nothing written twice");
  } finally { t.done(); }
});
