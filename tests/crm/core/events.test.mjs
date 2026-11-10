// Events wiring (design §11.3 "Events", §11.4 M1.3 events.test.mjs):
// every listener becomes a queue item with marker
// done/evt/{event_id}--{module}; reopen + complete again → two
// job.completed events and two listener runs; a stale event is ignored
// after the listener re-reads its subject.
import { test, beforeEach, afterEach, mock } from "node:test";
import assert from "node:assert/strict";
import { stores, clearCrmStores, devDeploy, fixtureModule, fixtureType, recordKicks } from "../../helpers/crm-fixtures.mjs";
import { pin, unpin } from "../../helpers/crm-clock.mjs";

await import("../../../netlify/lib/crm/modules/index.mjs");
const store = await import("../../../netlify/lib/crm-store.mjs");
const { emit, eventId } = await import("../../../netlify/lib/crm/core/events.mjs");
const W = await import("../../../netlify/lib/crm/core/worker.mjs");

const acted = [];
const skipped = [];
let other = 0;
// A job-like fixture type (the work module's job arrives in M4a).
const jobType = fixtureType("fixture_job", "zj", { example: () => ({ status: "open", contact_id: "ct_0000000000000000000a" }) });
const listener = fixtureModule({
  types: [jobType],
  events: {
    "job.completed": {
      mutates: false,
      handler: async (event, h) => {
        const got = await store.getRecord("fixture_job", event.payload.job_id);
        if (!got || got.data.status !== "completed") { skipped.push(event.event_id); return { result: "skipped:changed" }; }
        acted.push({ event_id: event.event_id, wv: event.payload.wv, marker: h.marker.key });
        return { result: "done" };
      },
    },
  },
});
const second = fixtureModule({ events: { "job.completed": { mutates: false, handler: async () => { other += 1; throw new Error("second listener is down"); } } } });

let S, kicks, quiet;
const deploy = devDeploy();
const scope = (fn) => store.withStoreScope({ deploy, requestId: "test" }, fn);
const user = { by: "us_0000000000000000000a", origin: "api", actor_kind: "user", requestId: "test" };
const payload = (rec) => ({ id: rec.id, wv: rec.wv, job_id: rec.id, contact_id: rec.contact_id, kind: "one_time", billable: true, total_cents: 24310, assignee_ids: [] });
const setStatus = (id, status) => scope(() => store.updateRecord("fixture_job", id, (j) => ({ ...j, status }), user));

beforeEach(() => {
  S = stores();
  pin("2026-11-17T15:00:00Z");
  acted.length = 0; skipped.length = 0; other = 0;
  kicks = recordKicks();
  quiet = ["error", "log", "warn"].map((m) => mock.method(console, m, () => {}));
});
afterEach(() => {
  for (const q of quiet) q.mock.restore();
  kicks.restore();
  clearCrmStores();
  unpin();
});

test("each listener becomes a queue item with its own marker, and the fast lane is kicked", async () => {
  const job = (await scope(() => store.createRecord("fixture_job", { status: "open", contact_id: "ct_0000000000000000000a" }, user))).data;
  const done = (await setStatus(job.id, "completed")).data;
  const r = await scope(() => emit("job.completed", payload(done), user));
  assert.equal(r.queued, true);
  assert.ok(r.listeners.includes(listener.name) && r.listeners.includes(second.name));
  const items = S.data.keys("q/").map((k) => S.data.json(k)).filter((i) => i.data && [listener.name, second.name].includes(i.data.module));
  assert.equal(items.length, 2);
  for (const i of items) {
    assert.equal(i.kind, "evt");
    assert.equal(i.marker.ns, "done");
    assert.equal(i.marker.scope, "evt");
    assert.equal(i.marker.key, `${eventId(job.id, done.wv)}--${i.data.module}`);
    assert.deepEqual(i.subject, { type: "job", id: job.id });
  }
  assert.ok(kicks.list.some((k) => k.lane === "fast" && k.reason === "event:job.completed"));
  await W.runOnce("fast", { deploy });
  assert.equal(acted.length, 1);
  assert.equal(S.data.json(`done/evt/${eventId(job.id, done.wv)}--${listener.name}`).state, "done");
  // the failing listener retries on its own marker without touching the other one
  const m2 = S.data.json(`done/evt/${eventId(job.id, done.wv)}--${second.name}`);
  assert.equal(m2.state, "failed");
  assert.ok(m2.retry_at);
  assert.equal(other, 1);
});

test("reopen and complete again: two job.completed events, two listener runs", async () => {
  const job = (await scope(() => store.createRecord("fixture_job", { status: "open", contact_id: "ct_0000000000000000000a" }, user))).data;
  const first = (await setStatus(job.id, "completed")).data;
  await scope(() => emit("job.completed", payload(first), user));
  await W.runOnce("fast", { deploy });
  await setStatus(job.id, "open");                       // reopened
  const again = (await setStatus(job.id, "completed")).data;
  await scope(() => emit("job.completed", payload(again), user));
  await W.runOnce("fast", { deploy });
  assert.equal(acted.length, 2);
  assert.notEqual(acted[0].event_id, acted[1].event_id, "named by the write counter: a different event");
  assert.deepEqual(acted.map((a) => a.wv), [first.wv, again.wv]);
});

test("a stale event is ignored after the re-read", async () => {
  const job = (await scope(() => store.createRecord("fixture_job", { status: "open", contact_id: "ct_0000000000000000000a" }, user))).data;
  const done = (await setStatus(job.id, "completed")).data;
  await scope(() => emit("job.completed", payload(done), user));
  await setStatus(job.id, "open");                       // reopened before the worker got to it
  await W.runOnce("fast", { deploy });
  assert.equal(acted.length, 0);
  assert.equal(skipped.length, 1);
  const m = S.data.json(`done/evt/${eventId(job.id, done.wv)}--${listener.name}`);
  assert.equal(m.state, "done");
  assert.equal(m.result, "skipped:changed");
});

test("the same emission twice (a retried request) runs the listener once", async () => {
  const job = (await scope(() => store.createRecord("fixture_job", { status: "open", contact_id: "ct_0000000000000000000a" }, user))).data;
  const done = (await setStatus(job.id, "completed")).data;
  await scope(() => emit("job.completed", payload(done), user));
  await scope(() => emit("job.completed", payload(done), user));
  await W.runOnce("fast", { deploy });
  assert.equal(acted.length, 1);
  assert.equal(S.data.keys("q/").filter((k) => S.data.json(k).data.module === listener.name).length, 0, "the duplicate item was dropped once its marker was final");
});
