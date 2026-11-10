// Backups (design §3.12, §11.4 M1.3 backup.test.mjs): a snapshot resumes
// from last_key across invocations; skipped families stay out; a restore
// starts paused and re-seats the sequences.
import { test, beforeEach, afterEach, mock } from "node:test";
import assert from "node:assert/strict";
import { stores, clearCrmStores, devDeploy, fixtureModule, fixtureType, recordKicks } from "../../helpers/crm-fixtures.mjs";
import { createCrmStores, useCrmStores } from "../../helpers/crm-memory-store.mjs";
import { pin, unpin } from "../../helpers/crm-clock.mjs";

await import("../../../netlify/lib/crm/modules/index.mjs");
const store = await import("../../../netlify/lib/crm-store.mjs");
const B = await import("../../../netlify/lib/crm/core/backup.mjs");
const L = await import("../../../netlify/lib/crm/core/lanes.mjs");
const W = await import("../../../netlify/lib/crm/core/worker.mjs");

fixtureModule({ types: [fixtureType("fixture_rec", "zr", { indexes: [{ name: "fixture-recs", shard: () => "", row: (r) => ({ n: r.name }) }] })] });

let S, kicks, quiet;
const deploy = devDeploy();
const scope = (fn) => store.withStoreScope({ deploy, requestId: "test" }, fn);
const user = { by: "us_0000000000000000000a", origin: "api", actor_kind: "user", requestId: "test" };
const DATE = "2026-11-17";

async function seed(n = 50) {
  await scope(async () => {
    for (let i = 0; i < n; i++) await store.createRecord("fixture_rec", { name: `Sample ${i}` }, user);
    await store.putSetting("company", { name: "Barta Window Washing" }, { ...user, ifMatch: "new" });
    for (let i = 0; i < 3; i++) await store.nextNumber("fixture", { id: `zr_00000000000000000${i}0a` });
    await store.settledWrite("sys/bootstrap", { state: "done", user_id: "us_0000000000000000000a" }, { onlyIfNew: true });
    // families a snapshot skips
    await store.settledWrite("ses/" + "a".repeat(64), { user_id: "us_0000000000000000000a" }, { onlyIfNew: true });
    await store.putRaw("thr/login/someone--new/f-20261117t150000000z-abc", { at: "2026-11-17T15:00:00Z" });
    await store.putRaw("idem/us_0000000000000000000a/abcdefgh-1234", { state: "done", at: "2026-11-17T15:00:00Z" }, { onlyIfNew: true });
    await store.putRaw("lock/intake/xyz", { holder: null, until: "2026-11-17T15:00:00Z" }, { onlyIfNew: true });
  });
}

// A budget that runs low after `calls` checks: the chunk stops early, like a function near its end.
const shortBudget = (calls) => { let n = 0; return { left: () => (++n > calls ? 1000 : 120000), calls: () => 0, tick() {}, check() {} }; };

async function snapshotInChunks() {
  const run = await scope(() => L.createRun("backup.snapshot", { date: DATE }, user, { kick: false }));
  let steps = 0;
  for (;;) {
    const cur = await scope(() => L.getRun(run.id));
    if (cur.status !== "running" && cur.status !== "queued") return { run: cur, steps };
    await scope(() => L.stepRun(cur, { budget: shortBudget(3), deploy }));
    steps += 1;
    assert.ok(steps < 200, "the snapshot finishes");
  }
}

const allLines = (st) => st.backups.keys(`snap/${DATE}/`).filter((k) => k.endsWith(".jsonl")).flatMap((k) => new TextDecoder().decode(st.backups.snapshot().get(k).bytes).split("\n").filter(Boolean).map((l) => JSON.parse(l)));

beforeEach(() => {
  S = stores();
  pin("2026-11-17T15:00:00Z");
  kicks = recordKicks();
  quiet = ["error", "log", "warn"].map((m) => mock.method(console, m, () => {}));
});
afterEach(() => {
  for (const q of quiet) q.mock.restore();
  kicks.restore();
  clearCrmStores();
  unpin();
});

test("a snapshot resumes from last_key across invocations: every key once, in order, nothing skipped", async () => {
  await seed();
  const { run, steps } = await snapshotInChunks();
  assert.equal(run.status, "done");
  assert.ok(steps > 3, `it took several chunks (${steps})`);
  const lines = allLines(S);
  const keys = lines.map((l) => l.k);
  assert.equal(new Set(keys).size, keys.length, "no key twice");
  const want = S.data.keys().filter((k) => !B.SKIPPED.some((p) => k.startsWith(p)) && !k.startsWith("sys/") && !k.startsWith("lock/"));
  for (const k of want) assert.ok(keys.includes(k), `${k} is in the snapshot`);
  assert.ok(keys.includes("sys/bootstrap"), "setup stays done after a restore");
  const recParts = S.backups.keys(`snap/${DATE}/rec-fixture_rec/`);
  assert.ok(recParts.length > 1, "a partition cut by the chunk budget continues in a new part");
  const manifest = S.backups.json(`snap/${DATE}/manifest.json`);
  assert.equal(manifest.ok, true);
  assert.equal(manifest.keys, lines.length);
  const p = manifest.partitions.find((x) => x.name === "rec-fixture_rec");
  assert.equal(p.keys, 50);
  assert.equal(p.parts, recParts.length);
  assert.equal(S.data.json("sys/health").backup.date, DATE);
});

test("skipped families never reach a snapshot: sessions, throttles, idempotency, leases, intents, indexes, the activity feed", async () => {
  await seed(5);
  await snapshotInChunks();
  const keys = allLines(S).map((l) => l.k);
  for (const p of ["ses/", "pses/", "thr/", "idem/", "lock/", "pend/", "fix/", "imp/", "ib/", "done-dry/", "ix/", "ix-dirty/", "aud/"]) {
    assert.ok(!keys.some((k) => k.startsWith(p)), `${p} skipped`);
  }
  assert.ok(S.data.keys("aud/").length > 0 && S.data.keys("ix/").length > 0, "the families existed");
});

test("the nightly sweep starts the snapshot at 03:00 local and the bulk lane finishes it", async () => {
  await seed(3);
  pin("2026-11-17T09:05:00Z");        // 03:05 CST
  const r = await W.runLane("bulk", { deploy });
  assert.equal(r.ran, true);
  const run = S.data.keys("rec/run/").map((k) => S.data.json(k)).find((x) => x.kind === "backup.snapshot");
  assert.equal(run.status, "done");
  assert.equal(run.input.date, "2026-11-17");
  assert.ok(S.backups.json("snap/2026-11-17/manifest.json").ok);
  await W.runLane("bulk", { deploy });
  assert.equal(S.data.keys("rec/run/").map((k) => S.data.json(k)).filter((x) => x.kind === "backup.snapshot").length, 1, "one snapshot a night");
});

test("a restore starts paused, brings every key back and re-seats the sequences past every number", async () => {
  await seed(12);
  await snapshotInChunks();
  const manifest = S.backups.json(`snap/${DATE}/manifest.json`);
  const parts = new Map();
  for (const k of S.backups.keys(`snap/${DATE}/`)) if (k.endsWith(".jsonl")) parts.set(k, new TextDecoder().decode(S.backups.snapshot().get(k).bytes));
  const before = S.data.snapshot();

  const S2 = useCrmStores(createCrmStores());
  const readPart = async (name, n) => parts.get(B.partKey(DATE, name, n)) ?? null;
  const r = await scope(() => B.restoreSnapshot({ manifest, readPart }));
  const firstWrite = S2.data.calls.find((c) => c.op === "setJSON" || c.op === "set");
  assert.equal(firstWrite.key, "sys/mode", "the pause is written first");
  assert.equal(S2.data.json("sys/mode").paused, true);
  assert.equal(S2.data.json("sys/mode").restored_from, DATE);
  for (const [k, v] of before) {
    if (B.SKIPPED.some((p) => k.startsWith(p)) || k.startsWith("lock/") || k === "sys/mode") continue;
    if (k.startsWith("sys/") && k !== "sys/bootstrap") continue;
    if (k.startsWith("seq/")) continue;
    assert.ok(S2.data.has(k), `${k} restored`);
    if (k.startsWith("rec/run/")) continue;      // the snapshot's own run kept changing after its partition was copied
    assert.deepEqual(S2.data.json(k), JSON.parse(new TextDecoder().decode(v.bytes)), `${k} unchanged`);
  }
  assert.equal(S2.data.json("seq/fixture").next, 3 + 100, "past the highest issued number, plus 100");
  assert.equal(r.sequences.fixture, 103);
  assert.ok(!S2.data.keys().some((k) => k.startsWith("ses/") || k.startsWith("thr/")));
  // writing the same snapshot again changes nothing (conditional writes, same values)
  const r2 = await scope(() => B.restoreSnapshot({ manifest, readPart }));
  assert.equal(r2.written, 0);
});

test("old snapshots are pruned: the newest 35 and each 1st of the month for a year", async () => {
  await scope(async () => {
    for (let i = 0; i < 70; i++) {
      const d = new Date(Date.UTC(2026, 10, 17) - i * 86400000).toISOString().slice(0, 10);
      await store.putRaw(B.manifestKey(d), { date: d, ok: true }, {}, { kind: "backups" });
    }
  });
  const gone = await scope(() => B.pruneSnapshots("2026-11-17"));
  const left = await scope(() => B.snapshotDates());
  assert.equal(left.length, 35 + 1, "35 dailies and 2026-10-01... plus 2026-09-01 if old enough");
  assert.ok(left.includes("2026-09-11") === false);
  assert.ok(left.includes("2026-10-01"));
  assert.ok(gone.length === 70 - left.length);
});
