// The worker lanes (design §7.1, §7.2, §11.4 M1.3 worker.test.mjs):
// separate leases; the lease renewed after every pass; a no-progress pass
// ends the invocation; at most 3 self-kicks in a row; sleep-until-due runs a
// 5-minute lead.ack fixture at 5 min ± 1; UTC queue keys run correctly
// through 2026-11-01 01:00-01:59 (the hour that happens twice); the q/ key
// is deleted only after the marker is final.
import { test, beforeEach, afterEach, mock } from "node:test";
import assert from "node:assert/strict";
import { stores, clearCrmStores, devDeploy, fixtureModule, virtualSleep, recordKicks } from "../../helpers/crm-fixtures.mjs";
import { pin, unpin, advance, minutes, now } from "../../helpers/crm-clock.mjs";

await import("../../../netlify/lib/crm/modules/index.mjs");
const W = await import("../../../netlify/lib/crm/core/worker.mjs");
const Q = await import("../../../netlify/lib/crm/core/queue.mjs");
const L = await import("../../../netlify/lib/crm/core/lanes.mjs");
const store = await import("../../../netlify/lib/crm-store.mjs");
const { clearSweepCache } = await import("../../../netlify/lib/crm/core/sweeps.mjs");

// Fixture queue kinds: lead.ack-like, one that records when it ran, one that fails.
const ran = [];
let failNext = 0;
fixtureModule({
  queue: {
    "fixture.ack": { mutates: false, handler: async ({ item }) => { ran.push({ id: item.subject.id, at: now().toISOString() }); return { result: "sent" }; } },
    "fixture.flaky": { mutates: false, handler: async () => { if (failNext > 0) { failNext -= 1; throw new Error("provider down"); } ran.push({ id: "flaky", at: now().toISOString() }); return { result: "sent" }; } },
  },
});

let S, kicks, quiet;
const deploy = devDeploy();
const scope = (fn) => store.withStoreScope({ deploy, requestId: "test" }, fn);
const enqueue = (kind, id, dueAt) => scope(() => Q.enqueue(kind, { type: "contact", id }, {}, dueAt, { ns: "done", scope: "fixture", key: id }, { kick: false }));

beforeEach(() => {
  S = stores();
  pin("2026-11-17T15:00:00Z");
  ran.length = 0;
  failNext = 0;
  clearSweepCache();
  kicks = recordKicks();
  quiet = ["error", "log", "warn"].map((m) => mock.method(console, m, () => {}));
});
afterEach(() => {
  for (const q of quiet) q.mock.restore();
  kicks.restore();
  clearCrmStores();
  unpin();
});

test("separate leases: a second fast invocation exits at once; the bulk lane runs beside it", async () => {
  await scope(() => store.acquireLease("worker-fast", 5 * 60000, "someone-else"));
  const fast = await W.runLane("fast", { deploy, holder: "fast-2" });
  assert.equal(fast.ran, false);
  assert.equal(fast.ended, "busy");
  const bulk = await W.runLane("bulk", { deploy, holder: "bulk-1" });
  assert.equal(bulk.ran, true, "the bulk lane has its own lease");
  assert.equal(S.data.json("lock/worker-fast").holder, "someone-else");
  assert.equal(S.data.json("lock/worker-bulk").holder, null, "released (CAS to an expired value)");
  assert.ok(Date.parse(S.data.json("lock/worker-bulk").until) <= Date.parse(now().toISOString()));
});

test("the lease is renewed by CAS after every pass, and a no-progress pass ends the invocation", async () => {
  for (const id of ["ct_00000000000000000001", "ct_00000000000000000002", "ct_00000000000000000003"]) await enqueue("fixture.ack", id, now());
  const before = S.data.calls.length;
  const r = await W.runLane("fast", { deploy, holder: "fast-1" });
  assert.equal(r.ended, "idle");
  assert.equal(r.passes, 2, "one pass with work, then one that found nothing");
  assert.equal(ran.length, 3);
  const leaseWrites = S.data.calls.slice(before).filter((c) => c.key === "lock/worker-fast" && c.op === "setJSON");
  assert.equal(leaseWrites.length, 1 + r.passes + 1, "acquire, one renewal per pass, release");
  assert.ok(leaseWrites.every((c) => c.opts.onlyIfNew || c.opts.onlyIfMatch), "every lease write is conditional");

  const idle = await W.runLane("fast", { deploy, holder: "fast-3" });
  assert.equal(idle.passes, 1);
  assert.equal(idle.ended, "idle");
  assert.equal(kicks.list.length, 0, "no work left, no self-kick");
});

test("at most 3 self-kicks in a row; a cron kick resets the count", async () => {
  let fake = 0;
  // each item takes 5 (fake) minutes, so three of them run past the 13-minute mark
  fixtureModule({ queue: { "fixture.slow": { mutates: false, handler: async () => { fake += 5 * 60000; return { result: "done" }; } } } });
  const fill = async (n) => { for (let i = 0; i < n; i++) await scope(() => Q.enqueue("fixture.slow", null, {}, now(), { ns: "done", scope: "slow", key: `k${fake}-${n}-${i}-${Math.random().toString(36).slice(2)}` }, { kick: false })); };
  const invoke = async (reason) => { await fill(3); return W.runLane("fast", { deploy, reason, perfNow: () => fake }); };

  const first = await invoke("cron");
  assert.equal(first.ended, "time");
  assert.equal(first.self_kicked, true);
  for (let i = 0; i < 2; i++) assert.equal((await invoke("self")).self_kicked, true);
  assert.equal(S.data.json("sys/health").lanes.fast.self_kicks, 3);
  const fourth = await invoke("self");
  assert.equal(fourth.ended, "time");
  assert.equal(fourth.self_kicked, false, "the fourth in a row waits for cron");
  assert.deepEqual(kicks.list.map((k) => k.reason), ["self", "self", "self"]);
  const again = await invoke("cron");
  assert.equal(again.self_kicked, true, "a cron kick starts the count again");
  assert.equal(S.data.json("sys/health").lanes.fast.self_kicks, 1);
});

test("sleep-until-due: an item enqueued for 5 minutes later runs at 5 min ± 1 in the same invocation", async () => {
  const t0 = now().getTime();
  await enqueue("fixture.ack", "ct_0000000000000000lead", new Date(t0 + minutes(5)));
  const sleep = virtualSleep();
  const r = await W.runLane("fast", { deploy, sleep, holder: "fast-sleepy" });
  assert.equal(ran.length, 1, "it ran without waiting for the next cron");
  const at = Date.parse(ran[0].at) - t0;
  assert.ok(at >= minutes(4) && at <= minutes(6), `ran ${at / 60000} minutes after the lead`);
  assert.ok(sleep.log.every((ms) => ms <= 30000), "the queue head is re-checked every 30 s");
  assert.equal(r.ended, "idle");
  assert.equal(S.data.keys("q/").length, 0);
});

test("an item due beyond the budget is left for a later invocation (no sleeping through it)", async () => {
  await enqueue("fixture.ack", "ct_000000000000000later", new Date(now().getTime() + minutes(40)));
  const sleep = virtualSleep();
  const r = await W.runLane("fast", { deploy, sleep });
  assert.equal(r.ended, "idle");
  assert.equal(sleep.log.length, 0);
  assert.equal(ran.length, 0);
  assert.equal(S.data.keys("q/").length, 1);
});

test("UTC queue keys: the 01:00-01:59 hour of 2026-11-01 happens twice, and nothing runs early", async () => {
  // 06:30Z is 01:30 CDT (first time), 07:15Z is 01:15 CST (second time), 06:10Z is 01:10 CDT
  await enqueue("fixture.ack", "ct_000000000000000000a1", "2026-11-01T06:30:00Z");
  await enqueue("fixture.ack", "ct_000000000000000000b2", "2026-11-01T07:15:00Z");
  await enqueue("fixture.ack", "ct_000000000000000000c3", "2026-11-01T06:10:00Z");
  assert.deepEqual(S.data.keys("q/").map((k) => k.slice(0, 17)).sort(), ["q/2026-11-01/0610", "q/2026-11-01/0630", "q/2026-11-01/0715"]);
  pin("2026-11-01T06:45:00Z");   // 01:45 CDT: local time is past 01:15, but 01:15 CST hasn't happened yet
  await W.runOnce("fast", { deploy });
  assert.deepEqual(ran.map((r) => r.id), ["ct_000000000000000000c3", "ct_000000000000000000a1"], "in UTC order, and not the second 01:15");
  pin("2026-11-01T07:14:00Z");
  await W.runOnce("fast", { deploy });
  assert.equal(ran.length, 2, "01:14 CST is still before 01:15 CST");
  pin("2026-11-01T07:16:00Z");
  await W.runOnce("fast", { deploy });
  assert.deepEqual(ran.map((r) => r.id).slice(-1), ["ct_000000000000000000b2"]);
});

test("the q/ key is deleted only after the marker is final; a step that died is taken over after its lease", async () => {
  await enqueue("fixture.ack", "ct_0000000000000000die1", now());
  const qkey = S.data.keys("q/")[0];
  const mkey = "done/fixture/ct_0000000000000000die1";
  // the function dies right after the step: the marker's final write never happens
  const orig = S.data.setJSON;
  let died = false;
  S.data.setJSON = async function (key, value, opts) {
    if (!died && key === mkey && JSON.parse(JSON.stringify(value)).state === "done") {
      died = true;
      const e = new Error("Netlify Blobs refused the write (401 status code)");
      e.name = "BlobsInternalError";
      throw e;
    }
    return orig.call(this, key, value, opts);
  };
  await W.runOnce("fast", { deploy });
  assert.ok(died);
  assert.ok(S.data.has(qkey), "the queue key stays while the marker is not final");
  assert.equal(S.data.json(mkey).state, "claimed");
  await W.runOnce("fast", { deploy });
  assert.equal(S.data.json(mkey).state, "claimed", "busy until the claim's lease runs out");
  assert.equal(ran.length, 1);
  advance(minutes(3));
  const callsBefore = S.data.calls.length;
  await W.runOnce("fast", { deploy });
  assert.equal(S.data.json(mkey).state, "done");
  assert.equal(S.data.json(mkey).attempt, 2, "taken over: a claim that never reached sending did nothing");
  assert.ok(!S.data.has(qkey));
  const calls = S.data.calls.slice(callsBefore);
  const finalWrite = calls.findLastIndex((c) => c.op === "setJSON" && c.key === mkey);
  const del = calls.findIndex((c) => c.op === "delete" && c.key === qkey);
  assert.ok(finalWrite >= 0 && del > finalWrite, "marker final, then the key deleted");
  S.data.setJSON = orig;
});

test("a failing step retries with backoff 1, 5, 30, 120 minutes, keeps one marker, then stops and alerts", async () => {
  failNext = 99;
  await scope(() => Q.enqueue("fixture.flaky", { type: "contact", id: "ct_000000000000000flaky" }, {}, now(), { ns: "done", scope: "fixture", key: "flaky" }, { kick: false }));
  const waits = [];
  for (let i = 0; i < 5; i++) {
    const r = await scope(() => Q.drainQueue({ holder: "t", mode: { paused: false } }));
    assert.equal(S.data.keys("q/").length, i < 4 ? 1 : 0, "always exactly one item until it gives up");
    const m = S.data.json("done/fixture/flaky");
    if (i < 4) {
      assert.equal(m.state, "failed");
      waits.push(Math.round((Date.parse(m.retry_at) - now().getTime()) / 60000));
      pin(m.retry_at);
    } else {
      assert.equal(m.state, "failed");
      assert.equal(m.retry_at, undefined, "final");
    }
    assert.ok(r);
  }
  assert.deepEqual(waits, [1, 5, 30, 120]);
  assert.ok(S.data.json("sys/health").alerts.some((a) => a.key === "queue:fixture.flaky"));
  assert.ok(S.data.keys("alog/").some((k) => k.endsWith("--failed-error")));
});

test("a deferral (quiet hours) keeps the same marker and moves the item; a stale copy is dropped", async () => {
  let deferred = false;
  fixtureModule({ queue: { "fixture.quiet": { mutates: false, handler: async () => { if (!deferred) { deferred = true; return { defer: new Date(now().getTime() + minutes(60)), reason: "quiet_hours" }; } return { result: "sent" }; } } } });
  await scope(() => Q.enqueue("fixture.quiet", null, {}, now(), { ns: "done", scope: "fixture", key: "quiet" }, { kick: false }));
  await W.runOnce("fast", { deploy });
  const m = S.data.json("done/fixture/quiet");
  assert.equal(m.state, "claimed");
  assert.equal(m.attempt, 1);
  assert.ok(m.deferred_until);
  const keys = S.data.keys("q/");
  assert.deepEqual(keys, [m.queue_key], "exactly one item owns the marker");
  pin(m.deferred_until);
  await W.runOnce("fast", { deploy });
  assert.equal(S.data.json("done/fixture/quiet").state, "done");
  assert.deepEqual(S.data.keys("q/"), []);
});

test("paused: queue items wait; maintenance still runs", async () => {
  await enqueue("fixture.ack", "ct_00000000000000paused", now());
  await scope(() => store.settledWrite("sys/mode", { system_of_record: "rotor", paused: true }, { onlyIfNew: true }));
  await W.runOnce("fast", { deploy });
  assert.equal(ran.length, 0);
  assert.equal(S.data.keys("q/").length, 1);
});

test("the cron tick makes the worker secret once, notes the time and wakes both lanes", async () => {
  const posted = [];
  const r = await scope(() => W.cronTick({ kick: async (lane, secret) => { posted.push({ lane, secret }); return true; } }));
  assert.deepEqual(r.kicked, ["fast", "bulk"]);
  const secret = S.data.json("sys/worker-secret").secret;
  assert.match(secret, /^[0-9a-f]{64}$/);
  assert.deepEqual(posted.map((p) => p.secret), [secret, secret]);
  assert.equal(S.data.json("sys/health").cron_at, now().toISOString());
  await scope(() => W.cronTick({ kick: async () => true }));
  assert.equal(S.data.json("sys/worker-secret").secret, secret, "made once");
});
