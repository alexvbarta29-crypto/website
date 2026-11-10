// Multi-record operations (design §3.6, §11.4 M1.3 ops.test.mjs):
// versioned ids; a crash after step 2 resumes only after the lease expires
// and creates nothing twice; journaled numbers are reused; a double tap
// runs one op.
import { test, beforeEach, afterEach, mock } from "node:test";
import assert from "node:assert/strict";
import { stores, clearCrmStores, devDeploy, fixtureModule, fixtureType } from "../../helpers/crm-fixtures.mjs";
import { pin, unpin, advance, minutes } from "../../helpers/crm-clock.mjs";

await import("../../../netlify/lib/crm/modules/index.mjs");
const O = await import("../../../netlify/lib/crm/core/ops.mjs");
const store = await import("../../../netlify/lib/crm-store.mjs");
const W = await import("../../../netlify/lib/crm/core/worker.mjs");
const { BlobsTransientError } = await import("../../../netlify/lib/crm/core/errors.mjs");

fixtureModule({ types: [fixtureType("fixture_child", "zc")] });

const calls = { a: 0, b: 0, c: 0 };
let crashOnce = false;
O.defineOp("fixture.approve", {
  lane: "fast",
  steps: (input) => [
    { name: "a", run: async (s) => { calls.a += 1; const r = await s.createOnce("fixture_child", "a", 1, { name: "first" }); return { id: r.data.id }; } },
    { name: "b", run: async (s) => { calls.b += 1; const id = s.deriveId("fixture_child", "b", 1); const n = await s.number(id, "fixture"); await s.createOnce("fixture_child", "b", 1, { name: "second", number: n }); return { id, n }; } },
    { name: "c", run: async (s) => {
      calls.c += 1;
      if (crashOnce) { crashOnce = false; throw new BlobsTransientError("storage blinked"); }
      const r = await s.createOnce("fixture_child", "c", 1, { name: "third", quote: input.quote });
      return { id: r.data.id, b: s.out.b };
    } },
  ],
});

let S, quiet;
const deploy = devDeploy();
const scope = (fn, requestId = "req-1") => store.withStoreScope({ deploy, requestId }, fn);
const ctx = (requestId) => ({ by: "us_0000000000000000000a", origin: "api", actor_kind: "user", requestId });

beforeEach(() => {
  S = stores();
  pin("2026-11-17T15:00:00Z");
  Object.assign(calls, { a: 0, b: 0, c: 0 });
  crashOnce = false;
  quiet = ["error", "log", "warn"].map((m) => mock.method(console, m, () => {}));
});
afterEach(() => {
  for (const q of quiet) q.mock.restore();
  clearCrmStores();
  unpin();
});

test("versioned ids: the same natural key and version is one op; the next version is another", () => {
  assert.equal(O.opIdFor("approve--qt_0000000000000000000a", 1), "approve--qt_0000000000000000000a--1");
  assert.equal(O.opIdFor("approve--qt_0000000000000000000a", 2), "approve--qt_0000000000000000000a--2");
  assert.equal(O.opIdFor("cutover", 0), "cutover--1", "versions start at 1");
});

test("an op runs its steps once, journals them, and a later run of the same id answers from the journal", async () => {
  const id = O.opIdFor("approve--qt_0000000000000000000a", 1);
  const r = await scope(() => O.runOp(id, "fixture.approve", { input: { quote: "qt_0000000000000000000a" }, holder: "req-1", ctx: ctx("req-1") }));
  assert.equal(r.status, "done");
  assert.equal(S.data.keys("rec/fixture_child/").length, 3);
  const again = await scope(() => O.runOp(id, "fixture.approve", { input: {}, holder: "req-2", ctx: ctx("req-2") }), "req-2");
  assert.equal(again.status, "done");
  assert.deepEqual(again.result, r.result);
  assert.deepEqual(calls, { a: 1, b: 1, c: 1 });
  const v2 = await scope(() => O.runOp(O.opIdFor("approve--qt_0000000000000000000a", 2), "fixture.approve", { input: {}, holder: "req-3", ctx: ctx("req-3") }), "req-3");
  assert.equal(v2.status, "done");
  assert.equal(S.data.keys("rec/fixture_child/").length, 6, "a new version makes new children");
  assert.deepEqual(S.data.keys("rel/op-running/"), [], "finished ops leave the running list");
});

test("a crash after step 2 resumes only after the lease expires, from step 3, and creates nothing twice; its number is reused", async () => {
  const id = O.opIdFor("approve--qt_0000000000000000000b", 1);
  crashOnce = true;
  await assert.rejects(scope(() => O.runOp(id, "fixture.approve", { input: { quote: "qt_0000000000000000000b" }, holder: "req-1", ctx: ctx("req-1") })), BlobsTransientError);
  const j = S.data.json(`op/${id}`);
  assert.equal(j.status, "running");
  assert.equal(j.step, 2);
  const n = j.numbers[Object.keys(j.numbers)[0]];
  assert.equal(n, 1);
  assert.equal(S.data.json("seq/fixture").next, 2);
  // the worker does not touch it while the lease is live
  await W.runOnce("fast", { deploy });
  assert.equal(S.data.json(`op/${id}`).status, "running");
  assert.deepEqual(calls, { a: 1, b: 1, c: 1 });
  // a double tap meanwhile never runs a step
  const tap = await scope(() => O.runOp(id, "fixture.approve", { input: {}, holder: "req-9", ctx: ctx("req-9") }), "req-9");
  assert.equal(tap.status, "running");
  advance(minutes(2) + 1000);
  await W.runOnce("fast", { deploy });
  const done = S.data.json(`op/${id}`);
  assert.equal(done.status, "done");
  assert.equal(done.attempts, 2);
  assert.deepEqual(calls, { a: 1, b: 1, c: 2 }, "steps 1 and 2 were not run again");
  assert.equal(S.data.keys("rec/fixture_child/").length, 3);
  assert.equal(done.result.b.n, 1, "the journaled number is the one the child carries");
  assert.equal(S.data.json("seq/fixture").next, 2, "no second number was taken");
});

test("a step that already made its child before dying finds it on resume (createOnce)", async () => {
  const id = O.opIdFor("approve--qt_0000000000000000000c", 1);
  // make step 3 crash after its own create: the child exists, the journal says step 2
  let first = true;
  O.defineOp("fixture.half", {
    steps: () => [
      { name: "make", run: async (s) => { const r = await s.createOnce("fixture_child", "x", 1, { name: "x" }); if (first) { first = false; throw new BlobsTransientError("died after the create"); } return { id: r.data.id }; } },
    ],
  });
  await assert.rejects(scope(() => O.runOp(id, "fixture.half", { holder: "req-1", ctx: ctx("req-1") })));
  advance(minutes(3));
  await W.runOnce("fast", { deploy });
  assert.equal(S.data.json(`op/${id}`).status, "done");
  assert.equal(S.data.keys("rec/fixture_child/").length, 1);
});

test("a double tap at the same moment runs one op", async () => {
  const id = O.opIdFor("approve--qt_0000000000000000000d", 1);
  const [x, y] = await Promise.all([
    scope(() => O.runOp(id, "fixture.approve", { input: {}, holder: "tap-1", ctx: ctx("tap-1") }), "tap-1"),
    scope(() => O.runOp(id, "fixture.approve", { input: {}, holder: "tap-2", ctx: ctx("tap-2") }), "tap-2"),
  ]);
  assert.deepEqual([x.status, y.status].sort(), ["done", "running"]);
  assert.deepEqual(calls, { a: 1, b: 1, c: 1 });
  assert.equal(S.data.keys("rec/fixture_child/").length, 3);
});

test("a definite failure fails the op; an op without a kind can't be resumed and is marked failed", async () => {
  const bad = await assert.rejects(scope(() => O.runOp("fixture--bad--1", [{ name: "x", run: async () => { throw new Error("nope"); } }], { holder: "r", ctx: ctx("r") })));
  assert.equal(bad, undefined);
  assert.equal(S.data.json("op/fixture--bad--1").status, "failed");
  await assert.rejects(scope(() => O.runOp("fixture--loose--1", [{ name: "x", run: async () => { throw new BlobsTransientError("blink"); } }], { holder: "r", ctx: ctx("r") })));
  advance(minutes(3));
  await W.runOnce("fast", { deploy });
  assert.equal(S.data.json("op/fixture--loose--1").status, "failed");
  assert.equal(S.data.json("op/fixture--loose--1").error.code, "not_resumable");
});
