// Indexes (design §3.5, §11.4 M1.3 index.test.mjs): a crash between the
// record write and the index write is repaired from pend/; rows land in wv
// order under racing writers; a rebuild merges a row written during it; the
// dirty marker clears by CAS; index.verify repairs a planted mismatch.
import { test, beforeEach, afterEach, mock } from "node:test";
import assert from "node:assert/strict";
import { stores, clearCrmStores, devDeploy, fixtureModule, fixtureType, recordKicks } from "../../helpers/crm-fixtures.mjs";
import { pin, unpin, advance, now } from "../../helpers/crm-clock.mjs";

await import("../../../netlify/lib/crm/modules/index.mjs");
const store = await import("../../../netlify/lib/crm-store.mjs");
const W = await import("../../../netlify/lib/crm/core/worker.mjs");
const { tsKey } = await import("../../../netlify/lib/crm/core/clock.mjs");

const ITEMS = "fixture-items";
const BY_STATUS = "fixture-by-status";
fixtureModule({
  types: [fixtureType("fixture_item", "zi", {
    indexes: [
      { name: ITEMS, shard: (r) => "", row: (r) => ({ n: r.name, st: r.status }) },
      { name: BY_STATUS, shard: (r) => r.status || "open", row: (r) => ({ n: r.name }) },
    ],
    rels: [{ rel: "fixture-owner-items", parent: (r) => r.owner_id || null, sort: (r) => tsKey(new Date(r.created_at)) }],
  })],
});

let S, kicks, quiet;
const deploy = devDeploy();
const scope = (fn, requestId = "test") => store.withStoreScope({ deploy, requestId }, fn);
const user = { by: "us_0000000000000000000a", origin: "api", actor_kind: "user", requestId: "test" };
const OWNER = "us_00000000000000000own";
const create = (name, extra = {}) => scope(() => store.createRecord("fixture_item", { name, status: "open", owner_id: OWNER, ...extra }, user)).then((r) => r.data);
const rows = (name, shard = "") => scope(() => store.readIndex(name, shard)).then((r) => r.rows);
const deny = (key) => S.data.fail({ op: "getWithMetadata", key, kind: "denied", times: 20 });

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

test("a crash between the record write and the index write is repaired from pend/ (after 60 s)", async () => {
  deny(`ix/${ITEMS}`);
  const rec = await create("Sample One");
  S.data.clearHooks();
  assert.ok(S.data.has(`rec/fixture_item/${rec.id}`), "the record is safe");
  assert.deepEqual(await rows(ITEMS), [], "its row never landed");
  assert.ok(S.data.has(`pend/fixture_item/${rec.id}`), "the intent is still there");
  await W.runOnce("fast", { deploy });
  assert.deepEqual(await rows(ITEMS), [], "a pend/ younger than 60 s belongs to a write that may still be running");
  advance(61000);
  await W.runOnce("fast", { deploy });
  assert.deepEqual((await rows(ITEMS)).map((r) => [r.id, r.n]), [[rec.id, "Sample One"]]);
  assert.ok(!S.data.has(`pend/fixture_item/${rec.id}`));
});

test("an update that moved a row, cut off before its index writes, is moved by the repair (old shard emptied)", async () => {
  const rec = await create("Sample Two");
  assert.equal((await rows(BY_STATUS, "open")).length, 1);
  deny(new RegExp(`^ix/${BY_STATUS}/`));
  await scope(() => store.updateRecord("fixture_item", rec.id, (r) => ({ ...r, status: "done" }), user));
  S.data.clearHooks();
  assert.equal((await rows(BY_STATUS, "open")).length, 1, "the old row is still in the old shard");
  advance(61000);
  await W.runOnce("fast", { deploy });
  assert.deepEqual(await rows(BY_STATUS, "open"), []);
  assert.deepEqual((await rows(BY_STATUS, "done")).map((r) => r.id), [rec.id]);
  assert.equal((await rows(ITEMS))[0].st, "done");
});

test("a create whose record never landed releases what it claimed (repair of an absent record)", async () => {
  // the intent is written, then the record write fails for good
  const id = "zi_0000000000000000abcd";
  await scope(() => store.putRaw(`pend/fixture_item/${id}`, { wv: 1, at: now().toISOString(), names: [ITEMS], plan: { unique: [], lists: [], rels: [], ix: [{ name: ITEMS, part: "fixture_item", shard: "" }] } }));
  advance(61000);
  await W.runOnce("fast", { deploy });
  assert.ok(!S.data.has(`pend/fixture_item/${id}`));
  assert.deepEqual(await rows(ITEMS), []);
});

test("rows land in wv order under racing writers", async () => {
  const id = "zi_0000000000000000race";
  // while writer 1 (wv 1) is between its read and its write, writer 2 (wv 2) lands
  S.data.beforeConditionalWrite(async () => {
    await scope(() => store.applyIndexRow(ITEMS, "", id, "fixture_item", { n: "second" }, 2), "writer-2");
  }, { key: `ix/${ITEMS}` });
  await scope(() => store.applyIndexRow(ITEMS, "", id, "fixture_item", { n: "first" }, 1), "writer-1");
  assert.deepEqual((await rows(ITEMS)).map((r) => r.n), ["second"], "the lower wv never overwrites the higher");
  await scope(() => store.applyIndexRow(ITEMS, "", id, "fixture_item", { n: "stale" }, 2));
  assert.deepEqual((await rows(ITEMS)).map((r) => r.n), ["second"], "an equal wv is not newer");
});

test("a rebuild merges a row written during it, and leaves out rows of records removed meanwhile", async () => {
  const a = await create("Sample A");
  const b = await create("Sample B");
  let late = null;
  S.data.beforeConditionalWrite(async () => {
    late = await create("Sample Late");                              // lands while the rebuild is between read and write
    await scope(() => store.hardDelete("fixture_item", b.id, user));
  }, { key: `ix/${ITEMS}` });
  await scope(() => store.rebuildIndex(ITEMS));
  const ids = (await rows(ITEMS)).map((r) => r.id).sort();
  assert.deepEqual(ids, [a.id, late.id].sort());
});

test("the dirty marker clears by CAS; a mark written during the rebuild keeps the shard dirty", async () => {
  await create("Sample C");
  await scope(() => store.putRaw(`ix-dirty/${ITEMS}`, { dirty_at: now().toISOString() }));
  assert.equal((await scope(() => store.readIndex(ITEMS, ""))).stale, true);
  await scope(() => store.rebuildIndex(ITEMS));
  assert.equal((await scope(() => store.readIndex(ITEMS, ""))).stale, false);
  assert.ok(S.data.json(`ix-dirty/${ITEMS}`).clean_at);
  await scope(() => store.putRaw(`ix-dirty/${ITEMS}`, { dirty_at: now().toISOString() }));
  S.data.beforeConditionalWrite(async () => {
    await scope(() => store.putRaw(`ix-dirty/${ITEMS}`, { dirty_at: new Date(now().getTime() + 1).toISOString() }));
  }, { key: `ix/${ITEMS}` });
  await scope(() => store.rebuildIndex(ITEMS));
  assert.equal((await scope(() => store.readIndex(ITEMS, ""))).stale, true, "a newer dirty mark survives");
});

test("index.verify (the nightly run) repairs a planted mismatch in rows and relations, and reports it", async () => {
  const a = await create("Sample A");
  const b = await create("Sample B");
  const c = await create("Sample C");
  // plant: a row missing, a row for a record that doesn't exist, a corrupted row with a higher wv
  const blob = S.data.json(`ix/${ITEMS}`);
  delete blob.rows[a.id];
  blob.rows["zi_0000000000000000ghst"] = { fixture_item: { wv: 1, d: { n: "Ghost" } } };
  blob.rows[b.id] = { fixture_item: { wv: 99, d: { n: "Corrupted", st: "open" } } };
  await scope(() => store.putRaw(`ix/${ITEMS}`, blob, { onlyIfMatch: S.data.etagOf(`ix/${ITEMS}`) }));
  // and the relations: one missing, one extra
  const relC = S.data.keys(`rel/fixture-owner-items/${OWNER}/`).find((k) => k.endsWith(c.id));
  await scope(() => store.deleteRaw(relC));
  await scope(() => store.addRel("fixture-owner-items", OWNER, "20200101t000000000z", "zi_000000000000000000zz"));

  pin("2026-11-17T09:50:00Z");        // 03:50 local: index.verify (03:45) is due
  const r = await W.runLane("bulk", { deploy });
  assert.equal(r.ran, true);
  const v = S.data.json("sys/health").index_verify;
  assert.ok(v, "the run reported");
  assert.ok(v.missing >= 2 && v.extra >= 2 && v.stale >= 1, JSON.stringify(v));
  const now1 = (await rows(ITEMS)).map((x) => [x.id, x.n]).sort();
  assert.deepEqual(now1, [[a.id, "Sample A"], [b.id, "Sample B"], [c.id, "Sample C"]].sort());
  const rels = S.data.keys(`rel/fixture-owner-items/${OWNER}/`).map((k) => k.slice(k.lastIndexOf("--") + 2)).sort();
  assert.deepEqual(rels, [a.id, b.id, c.id].sort());
  const run = S.data.keys("rec/run/").map((k) => S.data.json(k)).find((x) => x.kind === "index.verify");
  assert.equal(run.status, "done");
  assert.equal(v.repairs_in_a_row, 1);
});
