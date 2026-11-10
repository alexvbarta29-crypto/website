// The engine recovers from a write that failed half way (design §3.6,
// §3.9, §3.12, §6.9, §7.1-§7.3; M1.3 review): a seed a storage error
// stopped is finished later; the fast lane sleeps through due items it
// cannot run; a run step stopped by the parallel-run backstop leaves a
// would- row; an approval whose queue write failed still runs once; a
// restore never moves a step's marker back; records made after cutover are
// not shadows and purge-shadow keeps them; the nightly file backup reads no
// record for files it already copied. Synthetic data only.
import { test, beforeEach, afterEach, mock } from "node:test";
import assert from "node:assert/strict";
import { stores, clearCrmStores, devDeploy, fixtureModule, fixtureType, seedImportedContact, recordKicks, virtualSleep, BYTES } from "../../helpers/crm-fixtures.mjs";
import { pin, unpin, advance, minutes, hours, now } from "../../helpers/crm-clock.mjs";
import { crmTest } from "../../helpers/crm-http.mjs";

await import("../../../netlify/lib/crm/modules/index.mjs");
const store = await import("../../../netlify/lib/crm-store.mjs");
const W = await import("../../../netlify/lib/crm/core/worker.mjs");
const L = await import("../../../netlify/lib/crm/core/lanes.mjs");
const Q = await import("../../../netlify/lib/crm/core/queue.mjs");
const B = await import("../../../netlify/lib/crm/core/backup.mjs");
const F = await import("../../../netlify/lib/crm/core/files.mjs");
const P = await import("../../../netlify/lib/crm/core/pending.mjs");
const Sw = await import("../../../netlify/lib/crm/core/sweeps.mjs");
const { automationCtx } = await import("../../../netlify/lib/crm/core/activity.mjs");
const { BlobsTransientError } = await import("../../../netlify/lib/crm/core/errors.mjs");

// fixtures: a seed that blinks once, a queue kind, a mirrored and a shadow-capable type, a run, a file owner
let seedRuns = 0;
let seedFails = 0;
const seedMod = fixtureModule({ seeds: [{ v: 1, run: async () => { seedRuns += 1; if (seedFails > 0) { seedFails -= 1; throw new BlobsTransientError("storage blinked"); } return { ok: true }; } }] });
const handled = [];
fixtureModule({
  types: [fixtureType("rc_job", "zr", { mirrored: true }), fixtureType("rc_task", "zt", { shadow: true }), fixtureType("rc_owner", "zo")],
  queue: {
    "fixture.ack": { mutates: false, handler: async (h) => { handled.push(h.marker._key); return { result: "sent" }; } },
    "fixture.remind": { mutates: false, handler: async (h) => {
      if (!h.item.deferred_from && h.item.data && h.item.data.defer) return { defer: new Date(Date.parse(h.item.due_at) + hours(5)), reason: "quiet_hours" };
      handled.push(h.marker._key);
      return { result: "sent" };
    } },
  },
  routes: [{ method: "POST", path: "/rc-tasks", auth: "session", perm: "account:own", subject: "none", mode: "inline", handler: async (ctx) => { await ctx.sysMode(); return { status: 201, data: (await store.createRecord("rc_task", { name: "Call back" }, ctx.write())).data }; } }],
});
L.defineRun("fixture.backfill", { lane: "bulk", step: async (run, { write }) => {
  await store.createRecord("rc_job", { contact_id: run.input.contact_id, name: "Backfilled" }, write());
  return { done: true };
} });
F.defineFileOwner("rc_owner", { canRead: () => true, canEdit: () => true });

let S, kicks, quiet;
const deploy = devDeploy();
const scope = (fn) => store.withStoreScope({ deploy, requestId: "t" }, fn);

beforeEach(() => {
  S = stores();
  pin("2026-11-17T15:00:00Z");
  Sw.clearSeedCache();
  Sw.clearSweepCache();
  seedRuns = 0;
  seedFails = 0;
  handled.length = 0;
  kicks = recordKicks();
  quiet = ["error", "log", "warn"].map((m) => mock.method(console, m, () => {}));
});
afterEach(() => {
  for (const q of quiet) q.mock.restore();
  kicks.restore();
  clearCrmStores();
  unpin();
});

test("a seed a storage error stopped is finished on a later pass, and the seed set is marked done", async () => {
  seedFails = 1;
  await W.runOnce("fast", { deploy });
  const opKey = `op/${Sw.seedOpId(seedMod.name, 1)}`;
  assert.equal(S.data.json(opKey).status, "running", "left for a resume");
  assert.equal(S.data.json(opKey).kind, "system.seed", "a resumable kind, not a list of steps");
  for (let i = 0; i < 4; i++) { advance(minutes(15)); await W.runOnce("fast", { deploy }); }
  assert.equal(S.data.json(opKey).status, "done");
  assert.equal(seedRuns, 2, "run again once, not every pass");
  assert.equal(S.data.keys("done/seed/").filter((k) => !k.startsWith("done/seed/templates--")).length, 1, "the seed set is done");
});

test("a seed that fails for good raises one alert; the set stays open and nothing loops", async () => {
  seedFails = 99;
  for (let i = 0; i < 12; i++) { await W.runOnce("fast", { deploy }); advance(minutes(15)); }
  const j = S.data.json(`op/${Sw.seedOpId(seedMod.name, 1)}`);
  assert.equal(j.status, "failed");
  assert.ok(seedRuns <= 6, `ran ${seedRuns} times`);
  const alerts = (S.data.json("sys/health").alerts || []).filter((a) => a.key.startsWith("seed:"));
  assert.equal(alerts.length, 1);
  assert.equal(S.data.keys("done/seed/").filter((k) => !k.startsWith("done/seed/templates--")).length, 0);
});

test("the fast lane sleeps through due items it cannot run (no handler, held, waiting for a settler)", async () => {
  // a kind this deploy has no handler for, due ten minutes ago
  await scope(() => store.putRaw("q/2026-11-17/1450--stuck", { v: 1, kind: "fixture.retired", subject: null, expect: {}, marker: { ns: "done", scope: "fixture", key: "stuck" }, attempts: 0, due_at: "2026-11-17T14:50:00.000Z" }, { onlyIfNew: true }));
  await scope(() => Q.enqueue("fixture.ack", { type: "contact", id: "ct_00000000000000000001" }, {}, new Date(now().getTime() + minutes(10)), { ns: "done", scope: "fixture", key: "later" }, { kick: false }));
  const sleep = virtualSleep();
  const r = await W.runLane("fast", { deploy, sleep, holder: "fast-x" });
  assert.equal(handled.length, 1, "the item due in ten minutes ran");
  assert.ok(r.passes <= 5, `${r.passes} passes while waiting ten minutes`);
  assert.ok(sleep.log.length >= 10, "it slept in 30-second steps");
});

test("a run step stopped by the parallel-run backstop leaves a would- row and ends the run, never failed", async () => {
  const c = await scope(() => seedImportedContact(1));
  const run = await scope(() => L.createRun("fixture.backfill", { contact_id: c.id }, automationCtx({ mode: { system_of_record: "rotor" }, key: "fixture.backfill" }).write(), { kick: false }));
  const r = await scope(async () => L.stepRun(await L.getRun(run.id), { deploy, mode: { system_of_record: "rotor", paused: false } }));
  assert.equal(r.status, "done");
  const after = await scope(() => L.getRun(run.id));
  assert.equal(after.attempts || 0, 0, "no retries");
  assert.deepEqual(after.result, { would: "create" });
  assert.ok(S.data.keys("alog/").some((k) => k.includes("--fixture.backfill--") && k.includes("would-")), "a would- row in the run log");
  assert.equal(S.data.keys("rec/rc_job/").length, 0, "nothing written");
});

test("an approval whose queue write failed runs once: approving again queues it, and the hourly check does too", async () => {
  const t = await crmTest({ now: "2026-11-17T15:00:00Z" });
  try {
    const owner = await t.user("owner");
    const admin = await t.user("admin");
    const ran = [];
    P.definePendingKind("fixture.send", { label: "Text a customer", run: async (a) => { ran.push(a.id); return "sent"; } });
    const W8 = { by: admin.id, origin: "mcp", actor_kind: "user", requestId: "x" };
    const a = await store.withStoreScope({ requestId: "x" }, () => P.createPendingAction({ kind: "fixture.send", title: "Text Pat", args: { body: "hi" }, requested_by: admin.id }, W8));
    const b = await store.withStoreScope({ requestId: "x" }, () => P.createPendingAction({ kind: "fixture.send", title: "Text Sam", args: { body: "hi" }, requested_by: admin.id }, W8));
    await t.runWorker();
    // a: the queue write fails, the owner taps again
    t.stores.data.fail({ op: ["set", "setJSON"], key: /^q\//, kind: "timeout", times: 20 });
    const first = await t.api(`/pending-actions/${a.id}/approve`, { method: "POST", as: owner, body: {} });
    t.stores.data.clearHooks();
    assert.ok(first.status >= 500);
    assert.equal(t.stores.data.json(`rec/pending_action/${a.id}`).status, "approved");
    const again = await t.api(`/pending-actions/${a.id}/approve`, { method: "POST", as: owner, body: {} });
    assert.equal(again.status, 200, JSON.stringify(again.body));
    await t.runWorker();
    assert.deepEqual(ran, [a.id]);
    assert.equal((await t.api(`/pending-actions/${a.id}/approve`, { method: "POST", as: owner, body: {} })).status, 409, "once it ran: already decided");
    // b: the queue write fails and nobody taps again: the hourly check queues it
    t.stores.data.fail({ op: ["set", "setJSON"], key: /^q\//, kind: "timeout", times: 20 });
    await t.api(`/pending-actions/${b.id}/approve`, { method: "POST", as: owner, body: {} });
    t.stores.data.clearHooks();
    for (let i = 0; i < 3; i++) { advance(minutes(40)); await t.runWorker(); }
    assert.deepEqual(ran, [a.id, b.id], "each ran exactly once");
    assert.equal(t.stores.data.json(`rec/pending_action/${b.id}`).status, "done");
  } finally { t.done(); }
});

test("a restore never moves a step's marker back: a step done after the snapshot does not run again", async () => {
  pin("2026-11-17T09:00:00Z");     // 03:00 in Delano
  await scope(() => Q.enqueue("fixture.remind", { type: "contact", id: "ct_0000000000000000000a" }, {}, new Date(), { ns: "done", scope: "fixture.remind", key: "ct_0000000000000000000a--1" }, { data: { defer: true }, kick: false }));
  await W.runOnce("fast", { deploy });                       // deferred to 08:00: marker claimed
  const mk = "done/fixture.remind/ct_0000000000000000000a--1";
  assert.equal(S.data.json(mk).state, "claimed");
  const run = await scope(() => L.createRun("backup.snapshot", { date: "2026-11-17" }, { by: "system", origin: "worker", actor_kind: "automation", requestId: "t" }, { kick: false }));
  for (let i = 0; i < 10; i++) { const r = await scope(() => L.getRun(run.id)); if (r.status === "done") break; await scope(() => L.stepRun(r, { deploy })); }
  advance(hours(5) + minutes(1));
  await W.runOnce("fast", { deploy });
  assert.equal(handled.length, 1);
  assert.equal(S.data.json(mk).state, "done");
  advance(hours(4));
  const manifest = S.backups.json("snap/2026-11-17/manifest.json");
  const readPart = async (name, n) => { const k = B.partKey("2026-11-17", name, n); return S.backups.has(k) ? new TextDecoder().decode(S.backups.snapshot().get(k).bytes) : null; };
  const res = await scope(() => B.restoreSnapshot({ manifest, readPart }));
  assert.equal(S.data.json(mk).state, "done", "the live final marker is kept");
  assert.ok(res.kept >= 1);
  assert.equal(S.data.keys("q/").length, 0, "the snapshot's queue item for a finished step is not brought back");
  const cur = await scope(() => store.getRaw("sys/mode"));
  await scope(() => store.settledWrite("sys/mode", { ...cur.data, paused: false }, { onlyIfMatch: cur.etag }));
  for (let i = 0; i < 3; i++) await W.runOnce("fast", { deploy });
  assert.equal(handled.length, 1, "it ran once");
});

test("after cutover a person's new record is not a shadow, and purge-shadow deletes only shadows made before cutover", async () => {
  const t = await crmTest({ now: "2026-11-17T17:00:00Z" });
  try {
    const owner = await t.user("owner");
    // a native record made during the parallel run (a shadow), before cutover
    const old = await store.withStoreScope({ requestId: "x" }, () => store.createRecord("rc_task", { name: "Old shadow" }, { by: owner.id, origin: "api", actor_kind: "user", requestId: "x" }));
    assert.equal(old.data.shadow, true, "before cutover a native record is a shadow");
    advance(hours(1));
    await store.withStoreScope({ requestId: "x" }, () => store.settledWrite("sys/mode", { system_of_record: "crm", paused: false, cutover_n: 1, cutover_at: new Date(now().getTime() - minutes(5)).toISOString() }, { onlyIfNew: true }));
    const made = await t.api("/rc-tasks", { method: "POST", as: owner, body: {} });
    assert.equal(made.status, 201);
    assert.notEqual(t.stores.data.json(`rec/rc_task/${made.body.data.id}`).shadow, true, "made after cutover: not a shadow");
    // even a stray flag on a record created after cutover_at is kept
    const stray = await store.withStoreScope({ requestId: "x" }, () => store.createRecord("rc_task", { name: "Stray" }, { by: owner.id, origin: "api", actor_kind: "user", requestId: "x", mode: { system_of_record: "rotor" } }));
    assert.equal(stray.data.shadow, true);
    await t.api("/admin/purge-shadow", { method: "POST", as: owner, body: { confirm: "PURGE SHADOW" } });
    for (let i = 0; i < 3; i++) await t.runWorker({ lane: "bulk" });
    assert.ok(!t.stores.data.has(`rec/rc_task/${old.data.id}`), "the old shadow is gone");
    assert.ok(t.stores.data.has(`rec/rc_task/${made.body.data.id}`));
    assert.ok(t.stores.data.has(`rec/rc_task/${stray.data.id}`), "created after cutover_at: kept");
  } finally { t.done(); }
});

test("the nightly file backup copies what is missing and reads no record for files it already copied", async () => {
  const W8 = { by: "system", origin: "import", actor_kind: "import", requestId: "t" };
  const owner = (await scope(() => store.createRecord("rc_owner", { name: "x" }, { ...W8, origin: "api", actor_kind: "user" }))).data;
  for (let i = 0; i < 6; i++) await scope(() => F.storeImportedFile({ bytes: BYTES.jpeg(), owner: { type: "rc_owner", id: owner.id } }, W8));
  const night = async () => {
    const run = await scope(() => L.createRun("files.backup", {}, { by: "system" }, { kick: false }));
    await scope(async () => L.stepRun(await L.getRun(run.id), { deploy }));
    return scope(() => L.getRun(run.id));
  };
  const n1 = await night();
  assert.equal(n1.status, "done");
  assert.equal(n1.result.copied, 6);
  assert.equal(S.backups.keys("files/").length, 6, "originals only: these files have no thumbnail");
  const before = S.data.calls.filter((c) => /^rec\/file\//.test(c.key || "") && c.op.startsWith("get")).length;
  const n2 = await night();
  const reads = S.data.calls.filter((c) => /^rec\/file\//.test(c.key || "") && c.op.startsWith("get")).length - before;
  assert.equal(n2.result.copied, 0);
  assert.equal(reads, 0, "no file record read for files already copied");
});
