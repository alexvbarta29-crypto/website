// The crm-store contract (design §3.4, §3.14, §11.4 M1.1 acceptance):
// conditional writes settled by the writer nonce, never guessed. Runs
// against the memory double (tests/helpers/crm-memory-store.mjs) always;
// the "real client" part drives @netlify/blobs itself through guardedFetch
// with a mocked fetch (no network), and with CRM_IT=1 the same contract runs
// against a local BlobsServer. Every fixture is made up.
import { test, beforeEach, afterEach, describe } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { createCrmStores, useCrmStores, clearCrmStores } from "../../helpers/crm-memory-store.mjs";

const store = await import("../../../netlify/lib/crm-store.mjs");
const { defineType, registerType, registerModule } = await import("../../../netlify/lib/crm/core/registry.mjs");
const { setNow } = await import("../../../netlify/lib/crm/core/clock.mjs");
const { deployContext } = await import("../../../netlify/lib/crm/core/context.mjs");
const { contactStatsType } = await import("../../../netlify/lib/crm/modules/system/types.mjs");
const { InputError } = await import("../../../netlify/lib/crm/core/errors.mjs");
const {
  createRecord, updateRecord, patchRecord, softDelete, hardDelete, getRecord, claimPointer, readPointer, releasePointer,
  claimOpenPointer, updatePointerList, listRel, readIndex, applyIndexRow, rebuildIndex, listEvents, getEvent, nextNumber,
  claimMarker, advanceMarker, acquireLease, renewLease, releaseLease, idemBegin, idemFinish, getSetting, putSetting, updateStats,
  settledWrite, putRaw, withBudget, withStoreScope, K, putFileBytes, getFileStream, listKeys, forEachKey, addActivity, listActivity,
  ExistsError, StaleError, UnknownOutcome, SchemaTooNew, BudgetError, BlobsTransientError, ParallelRunGuard, guardedFetch, hk,
} = store;

// ---------------------------------------------------------------- test types

const gadget = defineType({
  type: "gadget", prefix: "gd", v: 2,
  validate(d) {
    if (d.name !== undefined && typeof d.name !== "string") throw new InputError("Name should be text.", "name");
    return d;
  },
  migrate: { 2: (r) => ({ ...r, size: r.size ?? "m" }) },
  rotorFields: ["name", "flags.vendor", "rotor"],
  techFields: ["id", "name"],
  example: () => ({ name: "Example gadget" }),
  indexes: [{ name: "gadgets", shard: (r) => r.bucket ?? "", row: (r) => ({ n: r.name, b: r.bucket ?? "" }) }],
  rels: [{ rel: "owner-gadgets", parent: (r) => r.owner_id || null, sort: (r) => r.day || "2026-01-01" }],
  pointers: [{ kind: "gadget-code", key: (r) => r.code || null }, { kind: "gadget-tag", list: true, keys: (r) => r.tags || [] }],
});
registerType(gadget, "test");
registerType(contactStatsType, "system");
registerModule({
  name: "testmod",
  statsParts: { testmod: { defaults: { visits: 0, last: null }, row: (p) => ({ tv: p.visits }) } },
  settings: { testcfg: { defaults: { hours: { open: "08:00", close: "18:00" }, list: [1, 2] }, validate: (v) => v, perm: "settings:general" } },
});

const ctx = (extra = {}) => ({ by: "us_test", origin: "api", actor_kind: "user", requestId: "req-test", ...extra });
const GID = "gd_000000000000000000a1";
const GID2 = "gd_000000000000000000a2";
const CID = "ct_000000000000000000c1";

let S;
beforeEach(() => {
  S = useCrmStores(createCrmStores());
  setNow("2026-11-17T15:00:00Z");
});
afterEach(async () => {
  await S.data.settle();
  clearCrmStores();
  setNow(null);
});

const raw = (key) => S.data.json(key);
const callsFor = (key, op) => S.data.calls.filter((c) => c.key === key && (!op || c.op === op));

// ---------------------------------------------------------------- records

test("create writes the envelope, pointers, relation, index row, event and activity row, then clears pend/", async () => {
  const r = await createRecord("gadget", { id: GID, name: "Blue", code: "b-1", tags: ["t1"], owner_id: CID, day: "2026-11-17" }, ctx());
  assert.equal(r.data.wv, 1);
  assert.equal(r.data.v, 2);
  assert.equal(r.data.shadow, true, "created in the CRM while Rotor is in charge");
  assert.equal(r.data.created_by, "us_test");
  assert.equal(r.data._w, undefined, "the nonce never leaves the store");
  assert.match(raw(K.rec("gadget", GID))._w, /^p[0-9a-f]{8}\.req-test\.\d+$/, "process id + request id + counter");
  assert.equal(r.etag, S.data.etagOf(K.rec("gadget", GID)));
  assert.deepEqual(await readPointer("gadget-code", "b-1"), { id: GID, at: "2026-11-17T15:00:00.000Z" });
  assert.deepEqual((await readPointer("gadget-tag", "t1")).ids, [GID]);
  assert.deepEqual(await listRel("owner-gadgets", CID), [{ sortKey: "2026-11-17", id: GID }]);
  const ix = await readIndex("gadgets", "");
  assert.deepEqual(ix.rows, [{ id: GID, n: "Blue", b: "" }]);
  assert.equal(ix.stale, false);
  assert.equal(S.data.keys("pend/").length, 0, "pend/ cleared after the side writes");
  const events = await listEvents("gadget", GID);
  assert.equal(events.length, 1);
  assert.equal(events[0].action, "create");
  assert.equal(events[0].actor, "us_test");
  assert.equal(S.data.keys("aud/2026-11-17/").length, 1);
});

test("create of an id that exists → ExistsError, and the pointer it holds stays (no fix marker)", async () => {
  await createRecord("gadget", { id: GID, name: "Blue", code: "b-1" }, ctx());
  await assert.rejects(createRecord("gadget", { id: GID, name: "Blue", code: "b-1" }, ctx()), ExistsError);
  assert.equal((await readPointer("gadget-code", "b-1")).id, GID);
  assert.equal(S.data.keys("fix/").length, 0);
});

test("a unique pointer held by another record stops the create before anything is written", async () => {
  await createRecord("gadget", { id: GID, name: "Blue", code: "b-1" }, ctx());
  await assert.rejects(createRecord("gadget", { id: GID2, name: "Red", code: "b-1" }, ctx()), ExistsError);
  assert.equal(raw(K.rec("gadget", GID2)), null);
  assert.equal((await readPointer("gadget-code", "b-1")).id, GID);
  assert.equal(S.data.keys("pend/").length, 0);
});

for (const as of ["throw", "unmodified", "blank"]) {
  test(`commitThenFail (${as}) on create → success, one record, never ExistsError`, async () => {
    S.data.commitThenFail({ op: "setJSON", key: K.rec("gadget", GID), as });
    const r = await createRecord("gadget", { id: GID, name: "Blue" }, ctx());
    assert.equal(r.data.name, "Blue");
    assert.equal(raw(K.rec("gadget", GID)).wv, 1);
    assert.equal(r.etag, S.data.etagOf(K.rec("gadget", GID)));
    assert.ok(callsFor(K.rec("gadget", GID), "getWithMetadata").length >= 1, "settled by a re-read");
  });

  test(`commitThenFail (${as}) on a CAS update → success, applied once`, async () => {
    await createRecord("gadget", { id: GID, name: "Blue", count: 1 }, ctx());
    S.data.commitThenFail({ op: "setJSON", key: K.rec("gadget", GID), as });
    const r = await updateRecord("gadget", GID, (g) => ({ ...g, count: g.count + 1 }), ctx());
    assert.equal(r.changed, true);
    assert.equal(raw(K.rec("gadget", GID)).count, 2);
    assert.equal(raw(K.rec("gadget", GID)).wv, 2);
  });

  test(`commitThenFail (${as}) on a pointer claim → ok, never "claim lost"`, async () => {
    S.data.commitThenFail({ op: "setJSON", key: K.ptr("gadget-code", "z-9"), as });
    const r = await claimPointer("gadget-code", "z-9", { id: GID }, ctx());
    assert.deepEqual(r, { ok: true });
    assert.equal((await readPointer("gadget-code", "z-9")).id, GID);
  });

  test(`commitThenFail (${as}) on a marker claim → ok`, async () => {
    S.data.commitThenFail({ op: "setJSON", key: "done/visit.reminder_2d/vs_1--2026-11-19", as });
    const r = await claimMarker("done", "visit.reminder_2d", "vs_1--2026-11-19", { holder: "worker-a", leaseMs: 60000 }, ctx());
    assert.equal(r.ok, true);
    assert.equal(r.marker.state, "claimed");
    assert.equal(r.marker.attempt, 1);
  });
}

test("slowCommit that lands before the settle read → settled by our nonce", async () => {
  S.data.slowCommit({ op: "setJSON", key: K.rec("gadget", GID), ms: 1, failAfter: 15 });
  const r = await createRecord("gadget", { id: GID, name: "Blue" }, ctx());
  assert.equal(r.data.name, "Blue");
  assert.equal(callsFor(K.rec("gadget", GID), "setJSON").length, 1, "no second write: the re-read found our nonce");
});

test("slowCommit that lands late → the retry wins and the late write is refused by its own condition", async () => {
  S.data.slowCommit({ op: "setJSON", key: K.rec("gadget", GID), ms: 40, failAfter: 1 });
  const r = await createRecord("gadget", { id: GID, name: "Blue" }, ctx());
  await S.data.settle();
  assert.equal(raw(K.rec("gadget", GID)).wv, 1);
  assert.equal(S.data.etagOf(K.rec("gadget", GID)), r.etag, "the late write changed nothing");
});

test("slowCommit on a CAS update → applied exactly once", async () => {
  await createRecord("gadget", { id: GID, name: "Blue", count: 1 }, ctx());
  S.data.slowCommit({ op: "setJSON", key: K.rec("gadget", GID), ms: 30, failAfter: 1 });
  await updateRecord("gadget", GID, (g) => ({ ...g, count: g.count + 1 }), ctx());
  await S.data.settle();
  assert.equal(raw(K.rec("gadget", GID)).count, 2);
  assert.equal(raw(K.rec("gadget", GID)).wv, 2);
});

for (const [label, ms, failAfter] of [["lands before the settle read", 1, 15], ["lands late", 40, 1]]) {
  test(`slowCommit on a pointer claim (${label}) → ok, one pointer`, async () => {
    S.data.slowCommit({ op: "setJSON", key: K.ptr("gadget-code", "s-1"), ms, failAfter });
    assert.deepEqual(await claimPointer("gadget-code", "s-1", { id: GID }, ctx()), { ok: true });
    await S.data.settle();
    assert.equal((await readPointer("gadget-code", "s-1")).id, GID);
  });

  test(`slowCommit on a marker claim (${label}) → ok, attempt 1`, async () => {
    S.data.slowCommit({ op: "setJSON", key: "done/review.sequence/jb_1--1", ms, failAfter });
    const r = await claimMarker("done", "review.sequence", "jb_1--1", { holder: "w1", leaseMs: 60000 }, ctx());
    await S.data.settle();
    assert.equal(r.ok, true);
    assert.equal(raw("done/review.sequence/jb_1--1").attempt, 1);
    assert.equal(raw("done/review.sequence/jb_1--1").holder, "w1");
  });
}

test("a transient 503 on a conditional write (seen as modified with no etag) is settled and retried", async () => {
  S.data.transient({ op: "setJSON", key: K.rec("gadget", GID), status: 503 });
  const r = await createRecord("gadget", { id: GID, name: "Blue" }, ctx());
  assert.equal(r.data.name, "Blue");
  assert.equal(callsFor(K.rec("gadget", GID), "setJSON").length, 2, "first attempt did not commit; the store wrote again");
});

test("a transient read is retried by the store", async () => {
  await createRecord("gadget", { id: GID, name: "Blue" }, ctx());
  S.data.transient({ op: "getWithMetadata", key: K.rec("gadget", GID), times: 2 });
  const got = await getRecord("gadget", GID);
  assert.equal(got.data.name, "Blue");
});

test("a read that keeps failing → BlobsTransientError after three attempts", async () => {
  S.data.fail({ op: "getWithMetadata", key: K.rec("gadget", GID), times: 3 });
  await assert.rejects(getRecord("gadget", GID), BlobsTransientError);
  assert.equal(callsFor(K.rec("gadget", GID), "getWithMetadata").length, 3);
});

test("when the settle read cannot complete → UnknownOutcome with a fix/ marker naming the key", async () => {
  S.data.commitThenFail({ op: "setJSON", key: K.rec("gadget", GID) });
  S.data.hang({ op: "getWithMetadata", key: K.rec("gadget", GID), times: 10 });
  const err = await createRecord("gadget", { id: GID, name: "Blue" }, ctx({ attemptMs: 30 })).catch((e) => e);
  assert.ok(err instanceof UnknownOutcome, String(err));
  assert.ok(err.fixKey && err.fixKey.startsWith("fix/"));
  const fix = raw(err.fixKey);
  assert.equal(fix.key, K.rec("gadget", GID));
  assert.match(fix.nonce, /^p[0-9a-f]{8}\.req-test\./);
  assert.equal(fix.name, undefined, "the marker names the key, never the value");
});

test("a storage failure writing pend/ (after the pointer claim) releases the pointer; the retry with a new id succeeds", async () => {
  S.data.fail({ op: "setJSON", key: /^pend\//, times: 3 });
  const err = await createRecord("gadget", { name: "Blue", code: "login-pat" }, ctx()).catch((e) => e);
  assert.ok(err instanceof BlobsTransientError, String(err && err.name));
  assert.equal(await readPointer("gadget-code", "login-pat"), null, "no orphan pointer");
  assert.deepEqual(S.data.keys("rec/gadget/"), []);
  const r = await createRecord("gadget", { name: "Blue", code: "login-pat" }, ctx());
  assert.equal((await readPointer("gadget-code", "login-pat")).id, r.data.id);
});

test("compensation never deletes a pointer whose record exists", async () => {
  await createRecord("gadget", { id: GID, name: "Blue", code: "b-1" }, ctx());
  assert.equal(await releasePointer("gadget-code", "b-1", GID, ctx()), false);
  assert.equal((await readPointer("gadget-code", "b-1")).id, GID);
  assert.equal(S.data.keys("fix/").length, 1, "left for the worker with a fix/ marker");
  // a create whose id exists with other data: the pointer it claimed is not deleted either
  await assert.rejects(createRecord("gadget", { id: GID, name: "Blue", code: "c-2" }, ctx()), ExistsError);
  assert.equal((await readPointer("gadget-code", "c-2")).id, GID);
  // once the record is really gone, the release goes through
  await S.data.delete(K.rec("gadget", GID));
  assert.equal(await releasePointer("gadget-code", "b-1", GID, ctx()), true);
  assert.equal(await readPointer("gadget-code", "b-1"), null);
});

test("CAS update re-applies the pure mutate after a racing writer; If-Match gives 412 with current", async () => {
  await createRecord("gadget", { id: GID, name: "Blue", count: 1, notes: "" }, ctx());
  S.data.beforeConditionalWrite(async (key, opts, s) => {
    const cur = s.json(key);
    await s.setJSON(key, { ...cur, notes: "racer", wv: cur.wv + 1, _w: "racer.1" });
  }, { key: K.rec("gadget", GID) });
  await updateRecord("gadget", GID, (g) => ({ ...g, count: g.count + 1 }), ctx());
  assert.equal(raw(K.rec("gadget", GID)).count, 2);
  assert.equal(raw(K.rec("gadget", GID)).notes, "racer", "the racer's change is kept");

  const { etag } = await getRecord("gadget", GID);
  await updateRecord("gadget", GID, (g) => ({ ...g, name: "Green" }), ctx());
  const err = await updateRecord("gadget", GID, (g) => ({ ...g, name: "Red" }), ctx({ ifMatch: etag })).catch((e) => e);
  assert.ok(err instanceof StaleError);
  assert.equal(err.current.name, "Green");
  assert.equal(err.current._w, undefined);
});

test("updateRecord gives up with StaleError after five racing writers", async () => {
  await createRecord("gadget", { id: GID, name: "Blue", count: 1 }, ctx());
  let n = 0;
  S.data.beforeConditionalWrite(async (key, opts, s) => { const cur = s.json(key); await s.setJSON(key, { ...cur, count: 100 + ++n, _w: "racer." + n }); }, { key: K.rec("gadget", GID), times: 5 });
  await assert.rejects(updateRecord("gadget", GID, (g) => ({ ...g, count: g.count + 1 }), ctx()), StaleError);
});

test("patchRecord needs If-Match and never touches the envelope", async () => {
  const r = await createRecord("gadget", { id: GID, name: "Blue" }, ctx());
  await assert.rejects(patchRecord("gadget", GID, { name: "Red" }, ctx()), InputError);
  const p = await patchRecord("gadget", GID, { name: "Red", wv: 99, id: GID2, created_by: "x" }, ctx({ ifMatch: r.etag }));
  assert.equal(p.data.name, "Red");
  assert.equal(p.data.wv, 2);
  assert.equal(p.data.id, GID);
  assert.equal(p.data.created_by, "us_test");
});

test("an update moves relations, index shards and pointers; old ones go", async () => {
  await createRecord("gadget", { id: GID, name: "Blue", code: "b-1", tags: ["t1"], owner_id: CID, day: "2026-11-17", bucket: "a" }, ctx());
  await updateRecord("gadget", GID, (g) => ({ ...g, code: "b-2", tags: ["t2"], day: "2026-11-20", bucket: "b" }), ctx());
  assert.deepEqual(await listRel("owner-gadgets", CID), [{ sortKey: "2026-11-20", id: GID }]);
  assert.deepEqual((await readIndex("gadgets", "a")).rows, []);
  assert.deepEqual((await readIndex("gadgets", "b")).rows.map((r) => r.id), [GID]);
  assert.equal(await readPointer("gadget-code", "b-1"), null);
  assert.equal((await readPointer("gadget-code", "b-2")).id, GID);
  assert.deepEqual((await readPointer("gadget-tag", "t1")).ids, []);
  assert.deepEqual((await readPointer("gadget-tag", "t2")).ids, [GID]);
  const ev = await listEvents("gadget", GID);
  assert.deepEqual(ev.map((e) => e.action), ["update", "create"]);
  const upd = await getEvent(ev[0].key);
  assert.ok(upd.changed.includes("code"));
  assert.deepEqual(upd.diff.code, ["b-1", "b-2"]);
});

test("event diffs never carry notes", async () => {
  await createRecord("gadget", { id: GID, name: "Blue", notes: "gate code 1234" }, ctx());
  await updateRecord("gadget", GID, (g) => ({ ...g, notes: "gate code 9999" }), ctx());
  const [last] = await listEvents("gadget", GID);
  const e = await getEvent(last.key);
  assert.deepEqual(e.changed, ["notes"]);
  assert.equal(e.diff.notes, undefined);
});

test("soft delete hides the record from indexes and keeps it readable; hard delete removes everything", async () => {
  await createRecord("gadget", { id: GID, name: "Blue", code: "b-1", tags: ["t1"], owner_id: CID }, ctx());
  await softDelete("gadget", GID, ctx());
  assert.deepEqual((await readIndex("gadgets", "")).rows, []);
  assert.ok((await getRecord("gadget", GID)).data.deleted_at);
  await hardDelete("gadget", GID, ctx({ origin: "worker" }));
  assert.equal(await getRecord("gadget", GID), null);
  assert.equal(await readPointer("gadget-code", "b-1"), null);
  assert.deepEqual((await readPointer("gadget-tag", "t1")).ids, []);
  assert.deepEqual(await listRel("owner-gadgets", CID), []);
});

test("a record written by newer code is refused (SchemaTooNew); older ones migrate in memory on read", async () => {
  await S.data.setJSON(K.rec("gadget", GID), { id: GID, type: "gadget", v: 3, wv: 1, name: "Future" });
  await assert.rejects(updateRecord("gadget", GID, (g) => ({ ...g, name: "x" }), ctx()), SchemaTooNew);
  await S.data.setJSON(K.rec("gadget", GID2), { id: GID2, type: "gadget", v: 1, wv: 1, name: "Old" });
  const got = await getRecord("gadget", GID2);
  assert.equal(got.data.size, "m");
  assert.equal(got.data.v, 2);
  assert.equal(S.data.json(K.rec("gadget", GID2)).v, 1, "the migration is not written back on read");
});

// ---------------------------------------------------------------- pointers

test("one-open pointers: an open target blocks, a closed one is replaced by CAS", async () => {
  assert.deepEqual(await claimOpenPointer("clock", "us_a", { id: "ts_000000000000000000t1" }, async () => true, ctx()), { ok: true });
  const busy = await claimOpenPointer("clock", "us_a", { id: "ts_000000000000000000t2" }, async () => true, ctx());
  assert.equal(busy.ok, false);
  assert.equal(busy.current.id, "ts_000000000000000000t1");
  const freed = await claimOpenPointer("clock", "us_a", { id: "ts_000000000000000000t2" }, async () => false, ctx());
  assert.equal(freed.ok, true);
  assert.equal(freed.replaced, "ts_000000000000000000t1");
  assert.equal((await readPointer("clock", "us_a")).id, "ts_000000000000000000t2");
});

test("lookup lists are CAS lists of ids", async () => {
  await updatePointerList("phone", "abc", (ids) => [...ids, "ct_1"], ctx());
  await updatePointerList("phone", "abc", (ids) => [...ids, "ct_2", "ct_1"], ctx());
  assert.deepEqual((await readPointer("phone", "abc")).ids, ["ct_1", "ct_2"]);
  await updatePointerList("phone", "abc", (ids) => ids.filter((x) => x !== "ct_1"), ctx());
  assert.deepEqual((await readPointer("phone", "abc")).ids, ["ct_2"]);
});

test("no key ever holds an address: hk() of a phone or email is a fixed-width hash", async () => {
  const a = hk("phone", "(763) 555-0100", {});
  assert.equal(a, hk("phone", "+17635550100", {}));
  assert.match(a, /^[0-9a-hjkmnp-tv-z]{26}$/);
  assert.notEqual(a, hk("phone", "(763) 555-0100", { CRM_KEY_SALT: "another-salt" }));
  assert.equal(hk("email", " Pat@Example.com ", {}), hk("email", "pat@example.com", {}));
  assert.throws(() => hk("phone", "763", {}));
  assert.throws(() => hk("phone", "(763) 555-0100", { CRM_PRODUCTION: "1" }), /CRM_KEY_SALT/);
  await assert.rejects(putRaw("ptr/phone/+17635550100", { id: "x" }, { onlyIfNew: true }), InputError);
  await assert.rejects(putRaw("ptr/Email/Pat", { id: "x" }, { onlyIfNew: true }), InputError);
});

test("rec/, ptr/, ix/, seq/ and cfg/ keys are never written unconditionally", async () => {
  for (const k of ["rec/gadget/x", "ptr/a/b", "ix/a", "seq/job", "cfg/company"]) {
    await assert.rejects(putRaw(k, { a: 1 }), TypeError, k);
  }
  await putRaw("imp/run1/part-0001", { a: 1 });
  for (const c of S.data.calls.filter((c) => c.op === "setJSON" && /^(rec|ptr|ix|seq|cfg)\//.test(c.key))) {
    assert.ok(c.opts.onlyIfNew || c.opts.onlyIfMatch, c.key);
  }
});

// ---------------------------------------------------------------- relations, events, activity

test("relations list newest first within a range; activity rows carry kind and ref", async () => {
  for (const [d, id] of [["2026-11-01", "jb_a"], ["2026-11-10", "jb_b"], ["2026-11-20", "jb_c"]]) await store.addRel("contact-jobs", CID, d, id, {}, ctx());
  assert.deepEqual((await listRel("contact-jobs", CID)).map((r) => r.id), ["jb_c", "jb_b", "jb_a"]);
  assert.deepEqual((await listRel("contact-jobs", CID, { from: "2026-11-05", to: "2026-11-15" })).map((r) => r.id), ["jb_b"]);
  assert.deepEqual((await listRel("contact-jobs", CID, { newestFirst: false, limit: 2 })).map((r) => r.id), ["jb_a", "jb_b"]);
  await addActivity(CID, "quote.sent", "qt_1", new Date("2026-11-17T15:00:00Z"), ctx());
  await addActivity(CID, "visit.completed", "vs_1", new Date("2026-11-18T15:00:00Z"), ctx());
  const act = await listActivity(CID);
  assert.deepEqual(act.map((a) => [a.kind, a.refId]), [["visit.completed", "vs_1"], ["quote.sent", "qt_1"]]);
  assert.equal(act[0].at, "2026-11-18T15:00:00.000Z");
});

// ---------------------------------------------------------------- indexes

test("index rows land in wv order; an older write never replaces a newer one", async () => {
  await applyIndexRow("gadgets", "", GID, "gadget", { n: "v5" }, 5, ctx());
  await applyIndexRow("gadgets", "", GID, "gadget", { n: "v4" }, 4, ctx());
  assert.deepEqual((await readIndex("gadgets", "")).rows, [{ id: GID, n: "v5" }]);
  await applyIndexRow("gadgets", "", GID, "gadget", null, 6, ctx());
  await applyIndexRow("gadgets", "", GID, "gadget", { n: "late" }, 5, ctx());
  assert.deepEqual((await readIndex("gadgets", "")).rows, [], "a removal is a tombstone a late add cannot undo");
});

test("racing index writers: the store marks the shard dirty and still succeeds; a rebuild repairs and clears it by CAS", async () => {
  await createRecord("gadget", { id: GID, name: "Blue" }, ctx());
  await createRecord("gadget", { id: GID2, name: "Red" }, ctx({ bulk: true }));   // bulk: no index row
  S.data.beforeConditionalWrite(async (key, opts, s) => { const cur = s.json(key); await s.setJSON(key, { ...cur, poke: Math.random() }); }, { key: K.ix("gadgets", ""), times: 5 });
  await applyIndexRow("gadgets", "", GID, "gadget", { n: "Blue!" }, 9, ctx());
  const before = await readIndex("gadgets", "");
  assert.equal(before.stale, true);
  await rebuildIndex("gadgets", {}, ctx({ origin: "worker" }));
  const after = await readIndex("gadgets", "");
  assert.equal(after.stale, false);
  assert.deepEqual(after.rows.map((r) => r.id).sort(), [GID, GID2]);
  assert.ok(raw(K.dirty("gadgets", "")).clean_at);
});

test("a rebuild keeps a row written while it ran (the record exists) and drops rows of records that are gone", async () => {
  await createRecord("gadget", { id: GID, name: "Blue" }, ctx());
  await applyIndexRow("gadgets", "", "gd_00000000000000000099", "gadget", { n: "ghost" }, 3, ctx());
  await rebuildIndex("gadgets", {}, ctx({ origin: "worker" }));
  assert.deepEqual((await readIndex("gadgets", "")).rows.map((r) => r.id), [GID]);
});

// ---------------------------------------------------------------- stats sidecar

test("updateStats creates the sidecar from the part's defaults, writes only its part, and feeds the contacts index", async () => {
  const r = await updateStats(CID, "testmod", (p) => ({ ...p, visits: p.visits + 1 }), ctx({ origin: "worker", actor_kind: "automation" }));
  assert.equal(r.changed, true);
  assert.deepEqual(r.data.testmod, { visits: 1, last: null });
  await updateStats(CID, "testmod", (p) => ({ ...p, visits: p.visits + 1 }), ctx());
  assert.equal(raw(K.rec("contact_stats", CID)).testmod.visits, 2);
  assert.equal(raw(K.rec("contact_stats", CID)).wv, 2);
  assert.deepEqual((await readIndex("contacts", "")).rows, [{ id: CID, tv: 2 }]);
  const same = await updateStats(CID, "testmod", () => null, ctx());
  assert.equal(same.changed, false);
  await assert.rejects(updateStats(CID, "nope", (p) => p, ctx()), InputError);
  await assert.rejects(updateStats("gd_x", "testmod", (p) => p, ctx()), InputError);
});

test("updateStats under commitThenFail is applied once", async () => {
  await updateStats(CID, "testmod", (p) => ({ ...p, visits: 5 }), ctx());
  S.data.commitThenFail({ op: "setJSON", key: K.rec("contact_stats", CID) });
  await updateStats(CID, "testmod", (p) => ({ ...p, visits: p.visits + 1 }), ctx());
  assert.equal(raw(K.rec("contact_stats", CID)).testmod.visits, 6);
});

// ---------------------------------------------------------------- counters, settings

test("nextNumber issues consecutive numbers and skips one already claimed", async () => {
  assert.equal(await nextNumber("job", { start: 885 }), 885);
  await claimPointer("job-no", "886", { id: "jb_imported" }, ctx());
  assert.equal(await nextNumber("job"), 887);
  assert.equal(await nextNumber("job"), 888);
  assert.equal(raw(K.seq("job")).next, 889);
});

test("parallel nextNumber calls never share a number", async () => {
  const got = await Promise.all(Array.from({ length: 8 }, () => nextNumber("quote", { start: 100 })));
  assert.equal(new Set(got).size, 8);
});

test("settings merge over their defaults; the API needs If-Match", async () => {
  assert.deepEqual(await getSetting("testcfg"), { hours: { open: "08:00", close: "18:00" }, list: [1, 2] });
  await assert.rejects(putSetting("testcfg", { hours: { close: "17:00" } }, ctx()), InputError);
  const r = await putSetting("testcfg", { hours: { close: "17:00" }, extra: "kept" }, ctx({ ifMatch: "new" }));
  assert.deepEqual(r.data, { hours: { open: "08:00", close: "17:00" }, list: [1, 2], extra: "kept", updated_at: "2026-11-17T15:00:00.000Z", updated_by: "us_test" });
  await assert.rejects(putSetting("testcfg", { list: [3] }, ctx({ ifMatch: '"nope"' })), StaleError);
  const ok = await putSetting("testcfg", { list: [3] }, ctx({ ifMatch: r.etag }));
  assert.deepEqual(ok.data.list, [3]);
  await assert.rejects(getSetting("unknown-doc"), InputError);
});

// ---------------------------------------------------------------- markers, leases, idempotency

test("advanceMarker: the holder moves it; a stale holder loses", async () => {
  const a = await claimMarker("done", "charge", "pa_1", { holder: "w1", leaseMs: 1000 }, ctx());
  const sending = await advanceMarker(a.marker, { state: "sending", provider: "stripe", idempotency_key: "charge:pa_1" }, ctx());
  assert.equal(sending.state, "sending");
  await assert.rejects(advanceMarker(a.marker, { state: "done", result: "ok" }, ctx()), StaleError);
  const done = await advanceMarker(sending, { state: "done", result: "ok", provider_ref: "pi_test" }, ctx());
  assert.equal(done.state, "done");
});

test("leases: one holder at a time, renewable, released to an expired value", async () => {
  assert.equal(await acquireLease("worker-fast", 300000, "inv-a", ctx()), true);
  assert.equal(await acquireLease("worker-fast", 300000, "inv-b", ctx()), false);
  assert.equal(await renewLease("worker-fast", 300000, "inv-a", ctx()), true);
  assert.equal(await renewLease("worker-fast", 300000, "inv-b", ctx()), false);
  setNow("2026-11-17T15:06:00Z");
  assert.equal(await acquireLease("worker-fast", 300000, "inv-b", ctx()), true, "an expired lease is free");
  await releaseLease("worker-fast", "inv-b", ctx());
  assert.equal(raw(K.lock("worker-fast")).holder, null);
  assert.equal(raw(K.lock("worker-fast")).until, "1970-01-01T00:00:00.000Z");
  assert.equal(await acquireLease("worker-fast", 300000, "inv-a", ctx()), true);
});

test("idempotency records: new → pending → done → replay; mismatch; 5xx deletes; a dead pending is taken over", async () => {
  const key = "0f8b1c2e-0000-4000-8000-000000000001";
  assert.deepEqual(await idemBegin("us_a", key, "h1", ctx()), { state: "new" });
  assert.deepEqual(await idemBegin("us_a", key, "h1", ctx()), { state: "pending" });
  await idemFinish("us_a", key, { status: 201, body: { ok: true, data: { id: "x" } } }, ctx());
  assert.deepEqual(await idemBegin("us_a", key, "h1", ctx()), { state: "done", response: { status: 201, body: { ok: true, data: { id: "x" } }, headers: {} } });
  assert.deepEqual(await idemBegin("us_a", key, "h2", ctx()), { state: "mismatch" });
  const k2 = "0f8b1c2e-0000-4000-8000-000000000002";
  await idemBegin("us_a", k2, "h1", ctx());
  await idemFinish("us_a", k2, { status: 503 }, ctx());
  assert.equal(raw(K.idem("us_a", k2)), null, "a 5xx deletes the record so the retry runs again");
  const k3 = "0f8b1c2e-0000-4000-8000-000000000003";
  await idemBegin("us_a", k3, "h1", ctx());
  setNow("2026-11-17T15:02:00Z");
  assert.deepEqual(await idemBegin("us_a", k3, "h1", ctx()), { state: "new" });
  await assert.rejects(idemBegin("us_a", "short", "h1", ctx()), InputError);
});

// ---------------------------------------------------------------- budget, scope, raw, files

test("the budget counts storage calls and refuses past maxCalls in tests", async () => {
  const budget = withBudget(8000, 3);
  await assert.rejects(withStoreScope({ budget }, async () => {
    for (let i = 0; i < 5; i++) await getRecord("gadget", GID);
  }), BudgetError);
  assert.equal(budget.calls(), 4);
});

test("forEachKey walks keys in order and resumes after lastKey", async () => {
  for (let i = 0; i < 7; i++) await putRaw(`imp/r1/k${i}`, { i });
  const seen = [];
  const first = await forEachKey("imp/r1/", async (k) => { seen.push(k); }, { concurrency: 3 });
  assert.equal(first.done, true);
  assert.deepEqual(seen, (await listKeys("imp/r1/")));
  const resumed = [];
  await forEachKey("imp/r1/", async (k) => { resumed.push(k); }, { afterKey: "imp/r1/k4" });
  assert.deepEqual(resumed, ["imp/r1/k5", "imp/r1/k6"]);
  const dirs = await listKeys("imp/", { directories: true });
  assert.deepEqual(dirs, { keys: [], directories: ["imp/r1"] });
});

test("file bytes: onlyIfNew with metadata, 304 on a matching etag", async () => {
  const bytes = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3]);
  const put = await putFileBytes("fl_000000000000000000f1", bytes, { ct: "image/jpeg", bytes: 7, sha256: "abc" }, {}, ctx());
  const got = await getFileStream("fl_000000000000000000f1");
  assert.equal(got.meta.ct, "image/jpeg");
  const body = new Uint8Array(await new Response(got.stream).arrayBuffer());
  assert.deepEqual([...body], [...bytes]);
  assert.deepEqual(await getFileStream("fl_000000000000000000f1", { ifNoneMatch: put.etag }), { notModified: true });
  // the same bytes again (a retry) settle by sha256; other bytes are refused
  assert.deepEqual(await putFileBytes("fl_000000000000000000f1", bytes, { sha256: "abc" }, {}, ctx()), { etag: put.etag });
  await assert.rejects(putFileBytes("fl_000000000000000000f1", bytes, { sha256: "other" }, {}, ctx()), ExistsError);
});

// ---------------------------------------------------------------- review regressions (M1.1)

// A type with two unique pointers and a status-sharded index.
registerType(defineType({
  type: "twokey", prefix: "wk", v: 1, validate: (d) => d,
  rotorFields: ["name"], techFields: ["id"], example: () => ({ name: "Example" }),
  indexes: [{ name: "twokeys/open", shard: (r) => (r.status === "open" ? "" : null), row: (r) => ({ n: r.name }) }],
  pointers: [{ kind: "twokey-a", key: (r) => r.a || null }, { kind: "twokey-b", key: (r) => r.b || null }],
}), "test");
const WK = "wk_000000000000000000a1";
const wk = (n) => `wk_${String(n).padStart(20, "0")}`;
const writes = () => S.data.calls.filter((c) => c.op === "setJSON" || c.op === "set").length;

test("a conditional write without onlyIfNew or a real etag is refused, never sent unconditionally", async () => {
  for (const cond of [{ onlyIfMatch: undefined }, { onlyIfMatch: "" }, { onlyIfMatch: null }, {}, { onlyIfNew: false }]) {
    await assert.rejects(settledWrite("seq/x", { next: 1 }, cond, ctx()), TypeError, JSON.stringify(cond));
  }
  assert.equal(callsFor("seq/x", "setJSON").length, 0);
  // a read that returns no etag (what @netlify/blobs/server answers a GET) cannot be the base of a CAS
  await createRecord("gadget", { id: GID, name: "Blue", code: "e-1" }, ctx());
  const realRead = S.data.getWithMetadata.bind(S.data);
  S.data.getWithMetadata = async (key, o) => { const r = await realRead(key, o); return r ? { ...r, etag: undefined } : r; };
  const before = writes();
  await assert.rejects(updateRecord("gadget", GID, (g) => ({ ...g, name: "Green", code: "e-2" }), ctx()), TypeError);
  assert.equal(writes(), before, "nothing written: no pointer, no pend/, no record");
  assert.equal(raw(K.rec("gadget", GID)).name, "Blue");
});

test("after an ambiguous attempt, a later non-transient failure is UnknownOutcome and the unique pointer stays", async () => {
  const key = K.rec("gadget", GID);
  S.data.slowCommit({ op: "setJSON", key, ms: 60, failAfter: 1 });      // attempt 1 times out, lands 60 ms later
  S.data.fail({ op: "getWithMetadata", key, kind: "denied" });           // the settle read is refused outright
  const err = await createRecord("gadget", { id: GID, name: "A", code: "c-1" }, ctx()).catch((e) => e);
  assert.ok(err instanceof UnknownOutcome, String(err && err.name));
  assert.equal(raw(err.fixKey).key, key);
  assert.equal((await readPointer("gadget-code", "c-1")).id, GID, "kept for the fix/ marker to settle");
  await S.data.settle();
  assert.equal(raw(key).code, "c-1", "the first attempt landed late");
  await assert.rejects(createRecord("gadget", { id: GID2, name: "B", code: "c-1" }, ctx()), ExistsError, "the key is still unique");
});

test("a clean 412 whose read-back fails is busy: no maybe_saved, no fix/ marker", async () => {
  await claimPointer("gadget-code", "taken", { id: GID2 }, ctx());
  S.data.fail({ op: "getWithMetadata", key: K.ptr("gadget-code", "taken"), times: 3 });
  const err = await claimPointer("gadget-code", "taken", { id: GID }, ctx()).catch((e) => e);
  assert.ok(err instanceof BlobsTransientError, String(err && err.name));
  assert.equal(S.data.keys("fix/").length, 0);
});

test("a failed second pointer claim releases the first; an unclear claim keeps its own fix/ marker", async () => {
  await claimPointer("twokey-b", "b-taken", { id: wk(99) }, ctx());
  await assert.rejects(createRecord("twokey", { id: WK, name: "x", a: "a-1", b: "b-taken" }, ctx()), ExistsError);
  assert.equal(await readPointer("twokey-a", "a-1"), null);
  S.data.fail({ op: "setJSON", key: K.ptr("twokey-b", "b-2"), kind: "timeout", times: 3 });
  const err = await createRecord("twokey", { id: WK, name: "x", a: "a-2", b: "b-2" }, ctx()).catch((e) => e);
  assert.ok(err instanceof UnknownOutcome, String(err && err.name));
  assert.equal(await readPointer("twokey-a", "a-2"), null, "the first claim is released");
  assert.equal(raw(err.fixKey).key, K.ptr("twokey-b", "b-2"));
  assert.equal(raw(K.rec("twokey", WK)), null);
  assert.deepEqual(S.data.keys("pend/"), []);
});

test("an update whose pend/ write fails releases the pointer it claimed and keeps the old one", async () => {
  await createRecord("twokey", { id: WK, name: "x", a: "a-1" }, ctx());
  S.data.fail({ op: "setJSON", key: /^pend\//, times: 3 });
  await assert.rejects(updateRecord("twokey", WK, (r) => ({ ...r, a: "a-9" }), ctx()), BlobsTransientError);
  assert.equal(await readPointer("twokey-a", "a-9"), null);
  assert.equal((await readPointer("twokey-a", "a-1")).id, WK);
  assert.equal(raw(K.rec("twokey", WK)).a, "a-1");
});

test("listings walk page by page: a hung page is retried on its own, nothing is skipped, each page is a call", async () => {
  const P = useCrmStores(createCrmStores({ pageSize: 3 }));
  for (let i = 0; i < 10; i++) await P.data.setJSON(`imp/r1/k${String(i).padStart(2, "0")}`, { i });
  const realList = P.data.list.bind(P.data);
  P.data.list = (o = {}) => {
    const iter = realList(o);
    if (!o.paginate) return iter;
    return { [Symbol.asyncIterator]() { const it = iter[Symbol.asyncIterator](); let n = 0; return { next() { if (++n === 2) P.data.hang({ op: "list" }); return it.next(); } }; } };
  };
  const all = Array.from({ length: 10 }, (_, i) => `imp/r1/k${String(i).padStart(2, "0")}`);
  assert.deepEqual(await listKeys("imp/r1/", {}, ctx({ attemptMs: 30 })), all);
  assert.equal(P.data.calls.filter((c) => c.op === "list").length, 5, "4 pages + the hung one");
  const seen = [];
  assert.deepEqual(await forEachKey("imp/r1/", async (k) => { seen.push(k); }, { afterKey: all[6] }, ctx()), { done: true, lastKey: all[9] });
  assert.deepEqual(seen, all.slice(7));
  await assert.rejects(withStoreScope({ budget: withBudget(8000, 3) }, () => listKeys("imp/r1/")), BudgetError, "every page counts against the budget");
});

test("rebuildIndex reads the dirty markers first: a dirty mark written while it runs keeps the shard dirty", async () => {
  await createRecord("twokey", { id: WK, name: "Old", status: "open" }, ctx());
  const realList = S.data.list.bind(S.data);
  let injected = false;
  S.data.list = (o = {}) => {
    if (!injected && (o.prefix || "").startsWith("ix/twokeys")) {
      injected = true;
      // a writer changes the record while the rebuild runs; its applyIndexRow gave up and marked the shard dirty
      S.data.setJSON(K.rec("twokey", WK), { ...raw(K.rec("twokey", WK)), name: "New", wv: 2 });
      S.data.setJSON(K.dirty("twokeys/open", ""), { dirty_at: "2026-11-17T15:00:01.000Z" });
    }
    return realList(o);
  };
  await rebuildIndex("twokeys/open", {}, ctx({ origin: "worker" }));
  const ix = await readIndex("twokeys/open", "");
  assert.deepEqual(ix.rows.map((r) => r.n), ["Old"], "the row built before the change");
  assert.equal(ix.stale, true, "and the shard stays dirty for the next rebuild");
  assert.equal(raw(K.dirty("twokeys/open", "")).clean_at, undefined);
  S.data.list = realList;
  await rebuildIndex("twokeys/open", {}, ctx({ origin: "worker" }));
  const again = await readIndex("twokeys/open", "");
  assert.deepEqual(again.rows.map((r) => r.n), ["New"]);
  assert.equal(again.stale, false);
});

test("rebuildIndex counts the rows of every shard", async () => {
  for (const [i, bucket] of ["a", "a", "a", "a", "b"].entries()) await createRecord("gadget", { id: `gd_${String(i).padStart(20, "0")}`, name: "G" + i, bucket }, ctx());
  assert.deepEqual(await rebuildIndex("gadgets", {}, ctx({ origin: "worker" })), { rows: 5, shards: 2 });
});

test("tombstones of rows that left a shard are pruned after a day, by writers and by rebuilds", async () => {
  for (let i = 1; i <= 6; i++) {
    await createRecord("twokey", { id: wk(i), name: "W" + i, status: "open" }, ctx());
    await updateRecord("twokey", wk(i), (r) => ({ ...r, status: "done" }), ctx());
  }
  const blob = () => raw(K.ix("twokeys/open", "")).rows;
  assert.equal(Object.keys(blob()).length, 6, "fresh tombstones stay (they order late writers)");
  assert.ok(Object.values(blob()).every((e) => e.twokey.d === null && e.twokey.at));
  setNow("2026-11-19T15:00:00Z");
  await createRecord("twokey", { id: wk(7), name: "W7", status: "open" }, ctx());
  assert.deepEqual(Object.keys(blob()), [wk(7)], "a writer prunes day-old tombstones");
  await updateRecord("twokey", wk(7), (r) => ({ ...r, status: "done" }), ctx());
  setNow("2026-11-21T15:00:00Z");
  await rebuildIndex("twokeys/open", {}, ctx({ origin: "worker" }));
  assert.deepEqual(blob(), {}, "and so does a rebuild");
  assert.deepEqual((await readIndex("twokeys/open", "")).rows, []);
});

test("a person's update does not read the contact (the guard has nothing to check)", async () => {
  await createRecord("gadget", { id: GID, name: "A", contact_id: CID }, ctx());
  const before = S.data.calls.length;
  await updateRecord("gadget", GID, (g) => ({ ...g, name: "B" }), ctx());
  assert.equal(S.data.calls.slice(before).filter((c) => c.key === K.rec("contact", CID)).length, 0);
});

test("two processes that share a request id never share a nonce", async () => {
  const procB = await import("../../../netlify/lib/crm-store.mjs?process-b");
  const procA = await import("../../../netlify/lib/crm-store.mjs?process-a");
  assert.deepEqual(await procB.claimPointer("gadget-code", "dup", { id: GID2 }, { requestId: "req-1" }), { ok: true });
  S.data.transient({ op: "setJSON", key: K.ptr("gadget-code", "dup") });   // A's write does not commit
  const a = await procA.claimPointer("gadget-code", "dup", { id: GID }, { requestId: "req-1" });
  assert.equal(a.ok, false, "B's commit is not mistaken for A's");
  assert.equal(a.current.id, GID2);
});

test("only the import sets import, shadow or deleted_at; an update keeps import and shadow", async () => {
  const importer = { by: "import", origin: "import", actor_kind: "import", requestId: "i" };
  const r = await createRecord("gadget", { id: GID, name: "A", import: { run_id: "x" }, deleted_at: "2026-01-01T00:00:00Z", deleted_by: "x", merged_into: GID2, shadow: false }, ctx());
  for (const k of ["import", "deleted_at", "deleted_by", "merged_into"]) assert.equal(r.data[k], undefined, k);
  assert.equal(r.data.shadow, true, "the store decides shadow, not the caller");
  assert.deepEqual((await readIndex("gadgets", "")).rows.map((x) => x.id), [GID]);
  const link = { run_id: "ir_1", at: "2026-11-01T00:00:00Z", hash: "h" };
  await createRecord("gadget", { id: GID2, name: "B", import: link }, importer);
  await updateRecord("gadget", GID2, (g) => { const { import: _drop, ...rest } = g; return { ...rest, notes: "crm-owned", shadow: true }; }, ctx({ origin: "worker", actor_kind: "automation" }));
  assert.deepEqual(raw(K.rec("gadget", GID2)).import, link, "an automation cannot unlink a record from the import");
  assert.equal(raw(K.rec("gadget", GID2)).notes, "crm-owned");
  await assert.rejects(updateRecord("gadget", GID2, (g) => ({ ...g, name: "Changed" }), ctx({ origin: "worker", actor_kind: "automation" })), ParallelRunGuard, "so its Rotor fields stay guarded");
  assert.equal(raw(K.rec("gadget", GID2)).shadow, undefined);
  assert.equal((await updateRecord("gadget", GID, (g) => ({ ...g, import: { run_id: "forged" } }), ctx())).changed, false);
  await updateRecord("gadget", GID, (g) => ({ ...g, import: { run_id: "ir_2" } }), importer);
  assert.deepEqual(raw(K.rec("gadget", GID)).import, { run_id: "ir_2" }, "the import itself links");
});

// ---------------------------------------------------------------- the real client, no network

describe("the real @netlify/blobs client through guardedFetch (mocked fetch)", () => {
  const ENV_KEY = "NETLIFY_BLOBS_CONTEXT";
  let savedEnv, savedFetch, seen;
  const deploy = deployContext(new Request("http://localhost/x"), { deploy: { context: "dev" } }, {});
  beforeEach(() => {
    clearCrmStores();
    savedEnv = process.env[ENV_KEY];
    savedFetch = globalThis.fetch;
    process.env[ENV_KEY] = Buffer.from(JSON.stringify({ siteID: "site-test", token: "tok-test", edgeURL: "https://blobs.test", uncachedEdgeURL: "https://blobs.test" })).toString("base64");
    seen = [];
  });
  afterEach(() => {
    if (savedEnv === undefined) delete process.env[ENV_KEY]; else process.env[ENV_KEY] = savedEnv;
    globalThis.fetch = savedFetch;
  });
  const mockFetch = (fn) => { globalThis.fetch = async (url, init = {}) => { seen.push({ url: String(url), method: init.method }); return fn(String(url), init, seen.length); }; };

  test("a synthetic 424 makes exactly one fetch per attempt (no 5-second client retries)", async () => {
    mockFetch(() => new Response(null, { status: 503 }));
    const { getStore } = await import("@netlify/blobs");
    const s = getStore({ name: "crm--dev", consistency: "strong", fetch: guardedFetch(withBudget(8000, 100, { strict: false })) });
    const t0 = performance.now();
    await assert.rejects(s.get("rec/gadget/x", { type: "json" }), (e) => e.name === "BlobsInternalError" && /424/.test(e.message));
    assert.equal(seen.length, 1);
    // a conditional write is reported as modified with no etag: the client's view of the 424
    const tracker = { transient: null };
    const s2 = getStore({ name: "crm--dev", consistency: "strong", fetch: guardedFetch(undefined, tracker) });
    assert.deepEqual(await s2.setJSON("rec/gadget/x", { a: 1 }, { onlyIfNew: true }), { etag: "", modified: true });
    assert.equal(tracker.transient, "server");
    assert.equal(seen.length, 2);
    mockFetch(() => { throw new TypeError("fetch failed"); });
    await assert.rejects(s.get("rec/gadget/x"), /424/);
    assert.equal(seen.length, 3);
    assert.ok(performance.now() - t0 < 1000, "no client-side sleeps");
  });

  test("crm-store retries a transient read itself: three attempts, one fetch each", async () => {
    mockFetch(() => new Response(null, { status: 500 }));
    await assert.rejects(getRecord("gadget", GID, { deploy }), BlobsTransientError);
    assert.equal(seen.length, 3);
    assert.ok(seen.every((c) => c.url.startsWith("https://blobs.test/site-test/site:crm--dev/rec/gadget/")));
  });

  test("a conditional write whose attempt hit a 503 is settled by a read, then written again", async () => {
    const data = new Map();
    mockFetch((url, init, n) => {
      const key = decodeURIComponent(url.split("/site:crm--dev/")[1] || "");
      if (init.method === "put" && n === 1) return new Response(null, { status: 503 });
      if (init.method === "put") { data.set(key, init.body); return new Response(null, { status: 200, headers: { etag: '"e1"' } }); }
      if (init.method === "get") return data.has(key) ? new Response(data.get(key), { status: 200, headers: { etag: '"e1"' } }) : new Response(null, { status: 404 });
      return new Response(null, { status: 404 });
    });
    const w = await settledWrite("seq/test", { next: 2 }, { onlyIfNew: true }, { deploy });
    assert.deepEqual(w, { ok: true, etag: '"e1"' });
    assert.deepEqual(seen.map((c) => c.method), ["put", "get", "put"]);
  });

  const keyOf = (url) => decodeURIComponent((url.split("/site:")[1] || "").replace(/^[^/?]*\/?/, "").split("?")[0]);
  // A tiny Blobs edge: PUT/GET/DELETE on a map; `put(key, n)` may answer instead.
  function edge(put = () => null) {
    const data = new Map();
    let n = 0;
    mockFetch((url, init) => {
      const key = keyOf(url);
      if (init.method === "put") {
        const answer = put(key, init);
        if (answer) return answer;
        if (init.headers["if-none-match"] === "*" && data.has(key)) return new Response(null, { status: 412 });
        data.set(key, init.body);
        return new Response(null, { status: 200, headers: { etag: `"e${++n}"` } });
      }
      if (init.method === "get") return data.has(key) ? new Response(data.get(key), { status: 200, headers: { etag: '"e0"' } }) : new Response(null, { status: 404 });
      if (init.method === "delete") { data.delete(key); return new Response(null, { status: 204 }); }
      return new Response(null, { status: 404 });
    });
    return data;
  }

  test("a write the service refuses (401/403) is definite: no settle retries, and the claimed pointer is released", async () => {
    const data = edge((key) => (key.startsWith("rec/") ? new Response(null, { status: 403 }) : null));
    const err = await createRecord("gadget", { id: GID, name: "Blue", code: "r-1" }, ctx({ deploy })).catch((e) => e);
    assert.equal(err && err.name, "BlobsInternalError");
    assert.match(err.message, /403/);
    assert.equal(seen.filter((c) => c.method === "put" && keyOf(c.url).startsWith("rec/")).length, 1, "a refused write is not retried");
    assert.equal(data.has("ptr/gadget-code/r-1"), false, "the pointer was released");
    assert.equal([...data.keys()].some((k) => k.startsWith("fix/")), false);
  });

  test("a refusal after an ambiguous attempt is UnknownOutcome: the pointer stays and a fix/ marker names the key", async () => {
    let recPuts = 0;
    const data = edge((key) => (key.startsWith("rec/") ? new Response(null, { status: ++recPuts === 1 ? 503 : 403 }) : null));
    const err = await createRecord("gadget", { id: GID, name: "Blue", code: "r-2" }, ctx({ deploy })).catch((e) => e);
    assert.ok(err instanceof UnknownOutcome, String(err && err.name));
    assert.ok(err.fixKey && data.has(err.fixKey));
    assert.ok(data.has("ptr/gadget-code/r-2"), "the first attempt may still land");
  });

  test("a listing longer than one attempt succeeds: every page is its own attempt", async () => {
    const PAGES = 5;
    mockFetch(async (url) => {
      const c = Number(new URL(url).searchParams.get("cursor") || 0);
      await new Promise((r) => setTimeout(r, 40));
      const blobs = Array.from({ length: 3 }, (_, i) => ({ key: `evt/x/${String(c * 3 + i).padStart(3, "0")}`, etag: '"e"' }));
      return Response.json({ blobs, directories: [], ...(c + 1 < PAGES ? { next_cursor: String(c + 1) } : {}) });
    });
    const keys = await listKeys("evt/", {}, { deploy, attemptMs: 100 });
    assert.equal(keys.length, 15);
    assert.deepEqual(keys, [...keys].sort());
    assert.equal(seen.length, PAGES, "one fetch per page, none repeated");
  });

  test("a streamed file body may take longer than the attempt: only its headers are timed", async () => {
    mockFetch((url, init) => {
      let timer;
      let n = 0;
      const body = new ReadableStream({
        start(controller) {
          init.signal?.addEventListener("abort", () => { clearInterval(timer); try { controller.error(init.signal.reason); } catch { /* closed */ } });
          timer = setInterval(() => {
            controller.enqueue(new Uint8Array(1024).fill(1));
            if (++n === 5) { clearInterval(timer); controller.close(); }
          }, 40);
        },
      });
      return new Response(body, { status: 200, headers: { etag: '"f1"' } });
    });
    const got = await getFileStream("fl_000000000000000000f1", {}, { deploy, attemptMs: 60 });
    let bytes = 0;
    for await (const chunk of got.stream) bytes += chunk.length;
    assert.equal(bytes, 5 * 1024, "the whole file, although it took about 200 ms against a 60 ms attempt");
  });

  test("openStore refuses the production store outside production and needs a branded deploy", async () => {
    await assert.rejects(store.openStore("data", { prod: true, ctx: "production" }), store.DeployContextRequired);
    const prodNoEnv = deployContext(new Request("https://www.bartawindowwashing.com/x"), { deploy: { context: "production" } }, {});
    await assert.rejects(store.openStore("data", prodNoEnv), store.ProdStoreRefused);
    const s = await store.openStore("data", deploy);
    assert.equal(s.name, "site:crm--dev");
    const probe = await store.openStore("probe", prodNoEnv);
    assert.equal(probe.name, "site:crm-probe", "the probe's scratch store opens even before setup");
  });
});

// ---------------------------------------------------------------- CRM_IT=1: a local BlobsServer

// BlobsServer answers a GET without an ETag header, so read-then-CAS
// (updateRecord, settings, leases, marker advances, index rows over an
// existing blob) cannot run against it: the store refuses such a CAS
// (TypeError) rather than sending it unconditionally. What it does prove:
// every write the store sends carries if-match or if-none-match, and the
// server itself answers 412 to a stale etag (taken from a write result).
describe("the same contract against a local BlobsServer (CRM_IT=1)", { skip: process.env.CRM_IT === "1" ? false : "set CRM_IT=1 to run against @netlify/blobs/server (binds a local port)" }, () => {
  let server, dir, savedEnv, savedFetch, puts;
  const deploy = deployContext(new Request("http://localhost/x"), { deploy: { context: "dev" } }, {});
  beforeEach(async () => {
    clearCrmStores();
    const { BlobsServer } = await import("@netlify/blobs/server");
    dir = mkdtempSync(path.join(os.tmpdir(), "crm-it-"));
    server = new BlobsServer({ directory: dir, token: "tok-it" });
    const { port } = await server.start();
    savedEnv = process.env.NETLIFY_BLOBS_CONTEXT;
    const url = `http://localhost:${port}`;
    process.env.NETLIFY_BLOBS_CONTEXT = Buffer.from(JSON.stringify({ siteID: "site-it", token: "tok-it", edgeURL: url, uncachedEdgeURL: url })).toString("base64");
    savedFetch = globalThis.fetch;
    puts = [];
    globalThis.fetch = async (u, init = {}) => {
      const res = await savedFetch(u, init);
      if (String(init.method).toLowerCase() === "put") {
        const h = init.headers || {};
        puts.push({ key: decodeURIComponent((String(u).split("/site:crm--dev/")[1] || "").split("?")[0]), ifMatch: h["if-match"] || null, ifNoneMatch: h["if-none-match"] || null, status: res.status });
      }
      return res;
    };
  });
  afterEach(async () => {
    globalThis.fetch = savedFetch;
    await server.stop();
    rmSync(dir, { recursive: true, force: true });
    if (savedEnv === undefined) delete process.env.NETLIFY_BLOBS_CONTEXT; else process.env.NETLIFY_BLOBS_CONTEXT = savedEnv;
  });

  test("create, pointer and marker claims, conditional headers on every write, a 412 from the server on a stale etag", async () => {
    const c = ctx({ deploy });
    await createRecord("gadget", { id: GID, name: "Blue", code: "it-1" }, c);
    await assert.rejects(createRecord("gadget", { id: GID, name: "Blue" }, c), ExistsError);
    assert.equal((await claimPointer("gadget-code", "it-1", { id: GID2 }, c)).ok, false);
    const m = await claimMarker("done", "it", "k1", { holder: "h1", leaseMs: 60000 }, c);
    assert.equal(m.ok, true);
    assert.equal((await claimMarker("done", "it", "k1", { holder: "h2", leaseMs: 60000 }, c)).ok, false);
    // read-then-CAS has no etag to send here: refused, nothing written
    const before = puts.length;
    await assert.rejects(updateRecord("gadget", GID, (g) => ({ ...g, name: "Green" }), c), TypeError);
    assert.equal(puts.length, before);
    // CAS from write-result etags: the server itself refuses the stale one
    const w1 = await settledWrite("seq/it", { next: 1 }, { onlyIfNew: true }, c);
    const w2 = await settledWrite("seq/it", { next: 2 }, { onlyIfMatch: w1.etag }, c);
    assert.equal(w2.ok, true);
    assert.notEqual(w2.etag, w1.etag);
    assert.equal((await settledWrite("seq/it", { next: 3 }, { onlyIfMatch: w1.etag }, c)).ok, false);
    assert.deepEqual(puts.filter((p) => p.key === "seq/it").map((p) => p.status), [200, 200, 412], "the 412 came from the server");
    assert.equal((await getRecord("gadget", GID, c)).data.name, "Blue");
    const guarded = puts.filter((p) => /^(rec|ptr|seq|cfg|ix|lock|done)\//.test(p.key));
    assert.ok(guarded.length >= 6, String(guarded.length));
    for (const p of guarded) assert.ok(p.ifMatch || p.ifNoneMatch, `${p.key} was written unconditionally`);
  });
});
