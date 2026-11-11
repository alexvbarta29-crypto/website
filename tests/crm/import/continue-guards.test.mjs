// "Bring in the rest", the guards (docs/CRM-IMPORT.md): regression tests
// from the review of the continuation runs. What a continuation must never
// do, and what happens when things go wrong around it:
//   - it never goes on from an OLDER export once a newer import was started;
//   - the hourly check starts nothing when its setting can't be read;
//   - a run that stops for good says so, tells the owners, raises an alert,
//     lets new imports start, and its staged rows are cleaned up;
//   - a staged chunk that is gone fails the run, never "done with nothing";
//     the clean-up and the button can't cross;
//   - code from before continuations never steps one, and a continuation it
//     did step is not a base.
// Synthetic data only. Parts "go live" as in continue.test.mjs: a fixture
// phase registered mid-test, or one hidden from the first run's plan.
import { test } from "node:test";
import assert from "node:assert/strict";
import { setup as baseSetup, stageRun, runToEnd, importExport, store, runner, generate, ids } from "./fixtures.mjs";
import { fixtureModule, fixtureType } from "../../helpers/crm-fixtures.mjs";
import { advance, minutes, hours, days } from "../../helpers/crm-clock.mjs";

const { getModule } = await import("../../../netlify/lib/crm/core/registry.mjs");
const C = await import("../../../netlify/lib/crm/modules/import/continue.mjs");
const { deployContext } = await import("../../../netlify/lib/crm/core/context.mjs");
const lanes = await import("../../../netlify/lib/crm/core/lanes.mjs");
const sweepsCore = await import("../../../netlify/lib/crm/core/sweeps.mjs");

// every test has fresh stores: the sweeps' warm-instance cache of finished claims must not carry over
const setup = async (opts = { now: "2026-11-17T15:00:00Z" }) => { sweepsCore.clearSweepCache(); return baseSetup(opts); };
const sweepOf = (key) => getModule("import").sweeps.find((s) => s.key === key);
const DEPLOY = () => deployContext(new Request("https://www.bartawindowwashing.com/"), {});
const SWEEP_CTX = { mode: { paused: false }, budget: null, write: () => ({ by: "system:import.continue", origin: "worker", actor_kind: "automation", requestId: "sweep" }) };
const scope = (fn) => store.withStoreScope({ deploy: DEPLOY(), requestId: "sweep" }, fn);
const runSweep = (key = "import.continue", ctx = SWEEP_CTX) => scope(() => sweepOf(key).run(ctx));
const gc = () => runSweep("import.staging_gc", { budget: null });
const runsOf = (t) => t.stores.data.keys("rec/import_run/").map((k) => t.stores.data.json(k));
const continuations = (t) => runsOf(t).filter((r) => r.continues);
const notices = (t) => t.stores.data.keys("rec/notification/").map((k) => t.stores.data.json(k));
const rest = async (t, owner) => (await t.api("/import/rest", { as: owner })).body.data;
const go = (t, who) => t.api("/import/continue", { method: "POST", as: who, body: {} });
const drain = async (t) => { for (let i = 0; i < 4; i++) await t.runWorker({ lane: "fast" }); };
const run = async (id) => (await store.getRecord("import_run", id)).data;
const alerts = async () => ((await lanes.readHealth()).alerts || []).map((a) => a.key);
const SYS = { by: "import", origin: "import", actor_kind: "import", requestId: "t" };

let typed = false;
const types = () => { if (typed) return []; typed = true; return [fixtureType("fixture_late", "zl", { rotorFields: ["label", "rotor"], example: () => ({ label: "Sample" }) })]; };
const late = (kind) => async (r) => ({ records: [{ type: "fixture_late", data: { id: ids.idForRotor("fixture_late", `${kind}:${r.id}`), label: String(r.name || r.line_label || r.id), rotor: { [`${kind}_id`]: String(r.id) } } }] });
// a part of the CRM that isn't live at first: registered now, hidden from the plan until shown
const part = (name, entity, kind) => { fixtureModule({ types: types(), importPhases: [{ name, entity, after: ["system.users"], normalize: (r) => r, map: late(kind) }] }); runner.__hidePhasesForTests([name]); };
const live = () => runner.__hidePhasesForTests([]);
const lateRows = (t, kind) => t.stores.data.keys("rec/fixture_late/").map((k) => t.stores.data.json(k)).filter((r) => r.rotor[`${kind}_id`]);
// storage fails on an entity's staged rows until the lane gives up on the run
async function giveUp(t, id, rootId, entity) {
  t.stores.data.fail({ op: ["get", "getWithMetadata"], key: new RegExp(`^imp/${rootId}/raw/${entity}/`), times: 1000000 });
  for (let i = 0; i < 6 * lanes.RUN_MAX_ATTEMPTS; i++) {
    const ir = await run(id);
    const lane = ir.lane_run_id ? (await store.getRecord("run", ir.lane_run_id)).data : null;
    if (lane && lane.status === "failed") break;
    advance(61 * 60000);
    await t.runWorker({ lane: "bulk" });
  }
  t.stores.data.clearHooks();
}

// ------------------------------------------------------------ 1. never an older export

test("a newer export's import was started and cancelled: the rest of the OLDER export is not brought in, by itself or by the button", async () => {
  const { t, owner } = await setup();
  try {
    const ex = generate({ scale: 0.02, seed: 111 });
    part("fixture.g1", "message_templates", "g1");
    const r1 = await importExport(t, owner, ex, { as_of: "2026-11-10" });
    assert.equal(r1.run.status, "done");
    // the part goes live; before the hour is up an owner uploads a NEWER export (the templates were renamed in Rotor) and starts it
    live();
    advance(days(9));
    const ex2 = JSON.parse(JSON.stringify(ex));
    for (const m of ex2.message_templates) m.name = `${m.name} (new wording)`;
    const { ir } = await stageRun(t, owner, ex2, { as_of: "2026-11-19" });
    assert.equal((await t.api(`/import/runs/${ir.id}/start`, { method: "POST", as: owner, body: {} })).status, 200);
    runner.IMPORT_LIMITS.stepRows = 30;
    for (let i = 0; i < 400; i++) {
      await t.runWorker({ lane: "bulk" });
      const st = await runner.loadState(ir.id);
      if (st && st.phases["fixture.g1"] && st.phases["fixture.g1"].status === "done") break;
    }
    assert.notEqual((await run(ir.id)).status, "done", "half way");
    // they cancel it (the wrong pack, a mistake, anything): what it brought in so far stays
    assert.equal((await t.api(`/import/runs/${ir.id}/cancel`, { method: "POST", as: owner, body: {} })).status, 200);
    runner.IMPORT_LIMITS.stepRows = Infinity;
    for (let i = 0; i < 5; i++) await t.runWorker({ lane: "bulk" });
    const labels = () => lateRows(t, "g1").map((r) => r.label);
    assert.ok(labels().length > 0 && labels().every((l) => / \(new wording\)$/.test(l)), "the newer export's values are in");
    // the next hours: nothing of the older export is started
    for (let h = 0; h < 3; h++) { advance(hours(1)); await t.runWorker({ lane: "bulk" }); }
    assert.equal(continuations(t).length, 0);
    assert.equal((await runSweep()).result, "superseded");
    const res = await go(t, owner);
    assert.equal(res.status, 409);
    assert.equal(res.body.error.message, C.SUPERSEDED_MESSAGE);
    assert.ok(labels().every((l) => / \(new wording\)$/.test(l)), "nothing older was written over the newer values");
    const v = await rest(t, owner);
    assert.equal(v.blocked, "newer", "the screen says why");
    assert.equal(v.run.id, r1.ir.id);
    // a finished import of the newer export is the base from then on
    advance(days(1));
    const r3 = await importExport(t, owner, ex2, { as_of: "2026-11-19" });
    assert.equal(r3.run.status, "done");
    assert.equal((await rest(t, owner)).blocked, null);
    assert.equal((await rest(t, owner)).run.id, r3.ir.id);
  } finally { live(); runner.IMPORT_LIMITS.stepRows = Infinity; t.done(); }
});

test("which runs make an export the older one (pure): started after it and not of the same upload, or a later export date", () => {
  const root = { id: "ir_root", st: "done", at: "2026-11-10T10:00:00.000Z", s: "2026-11-10T10:05:00.000Z", fin: "2026-11-10T11:00:00.000Z", asof: "2026-11-10" };
  const cont = { id: "ir_cont", st: "done", at: "2026-11-12T10:00:00.000Z", s: "2026-11-12T10:00:05.000Z", fin: "2026-11-12T10:10:00.000Z", asof: "2026-11-10", cont: "ir_root", src: "ir_root" };
  const by = (extra, base = cont) => { const r = C.supersededBy([root, cont, ...extra], base); return r ? r.id : null; };
  assert.equal(by([]), null);
  assert.equal(by([{ id: "ir_up", st: "uploading", at: "2026-11-13T10:00:00.000Z", asof: "2026-11-19" }]), null, "an upload nobody started wrote nothing");
  assert.equal(by([{ id: "ir_ab", st: "cancelled", at: "2026-11-13T10:00:00.000Z", fin: "2026-11-21T10:00:00.000Z" }]), null, "an abandoned upload");
  assert.equal(by([{ id: "ir_new", st: "cancelled", at: "2026-11-13T10:00:00.000Z", s: "2026-11-13T10:30:00.000Z", fin: "2026-11-13T10:40:00.000Z", asof: "2026-11-19" }]), "ir_new", "started after it and cancelled");
  assert.equal(by([{ id: "ir_new", st: "failed", at: "2026-11-13T10:00:00.000Z", s: "2026-11-13T10:30:00.000Z", fin: "2026-11-13T10:40:00.000Z" }]), "ir_new", "started after it and stopped");
  assert.equal(by([{ id: "ir_new", st: "cancelled", at: "2026-11-11T10:00:00.000Z", s: "2026-11-11T10:30:00.000Z" }]), "ir_new", "started after the upload's import, though before its continuation");
  assert.equal(by([{ id: "ir_old", st: "cancelled", at: "2026-11-03T10:00:00.000Z", s: "2026-11-03T10:30:00.000Z", asof: "2026-11-03" }]), null, "an older import that was cancelled");
  assert.equal(by([{ id: "ir_odd", st: "cancelled", at: "2026-11-03T10:00:00.000Z", s: "2026-11-03T10:30:00.000Z", asof: "2026-11-19" }]), "ir_odd", "a later export date, whenever it ran");
  assert.equal(by([{ id: "ir_c2", st: "cancelled", at: "2026-11-14T10:00:00.000Z", s: "2026-11-14T10:00:05.000Z", cont: "ir_cont", src: "ir_root" }]), null, "a cancelled continuation of the same upload");
  assert.equal(by([], root), null);
  assert.equal(C.supersededBy([], null), null);
  // an upload under way: by its newest key's time, not by when the run was made
  const t0 = Date.parse("2026-11-17T15:00:00.000Z");
  assert.equal(C.uploadUnderWay([{ st: "uploading", at: "2026-11-15T15:00:00.000Z", kx: "2026-11-18T10:00:00.000Z" }], t0), true, "a key made today for a run made two days ago");
  assert.equal(C.uploadUnderWay([{ st: "uploading", at: "2026-11-17T14:00:00.000Z", kx: "2026-11-17T14:30:00.000Z" }], t0), false, "its key ran out");
  assert.equal(C.uploadUnderWay([{ st: "uploading", at: "2026-11-17T14:00:00.000Z" }], t0), true, "a row from before the key time was kept: a day from when it was made");
  assert.equal(C.uploadUnderWay([{ st: "cancelled", at: "2026-11-17T14:00:00.000Z", kx: "2026-11-18T14:00:00.000Z" }], t0), false);
});

test("a new export is being uploaded for more than a day with a fresh key: the hourly check leaves the old export alone", async () => {
  const { t, owner } = await setup();
  try {
    part("fixture.g2", "campaigns", "g2");
    await importExport(t, owner, generate({ scale: 0.02, seed: 102 }));
    live();
    const up = await t.api("/import/runs", { method: "POST", as: owner, body: {} });
    assert.equal((await runSweep()).result, "upload_under_way");
    advance(hours(25));
    const owner2 = await t.user("owner", { name: "Second Day", login: "secondday" });
    assert.equal((await runSweep()).result.split(":")[0], "started", "the key ran out: nobody is uploading");
    const c = continuations(t)[0];
    assert.equal((await t.api(`/import/runs/${c.id}/cancel`, { method: "POST", as: owner2, body: {} })).status, 200);
    for (let i = 0; i < 3; i++) await t.runWorker({ lane: "bulk" });
    await store.updateRecord("import_run", c.continues, (r) => { const n = { ...r }; delete n.auto_off_at; return n; }, SYS);
    assert.equal((await t.api(`/import/runs/${up.body.data.run.id}/key`, { method: "POST", as: owner2, body: {} })).status, 200);
    assert.equal((await runSweep()).result, "upload_under_way", "a new key made just now: the upload is under way again");
  } finally { live(); t.done(); }
});

// ------------------------------------------------------------ 2. the setting fails closed

test("the setting can't be read: the hourly check starts nothing that hour (whatever it says), and goes on the next", async () => {
  const { t, owner } = await setup();
  try {
    part("fixture.g3", "campaigns", "g3");
    await importExport(t, owner, generate({ scale: 0.02, seed: 61 }));
    live();
    assert.equal((await t.api("/settings/import", { method: "PUT", as: owner, ifMatch: "new", body: { auto_continue: false } })).status, 200);
    assert.equal((await runSweep()).result, "off");
    // a storage brown-out on that one key
    t.stores.data.fail({ op: ["get", "getWithMetadata"], key: "cfg/import", times: 3 });
    assert.equal((await runSweep()).result, "setting_unreadable");
    t.stores.data.clearHooks();
    assert.equal(continuations(t).length, 0, "off stays off when the read fails");
    // on, and the read fails: still nothing this hour; the next hour it starts
    const etag = (await t.api("/settings/import", { as: owner })).body.data.etag;
    assert.equal((await t.api("/settings/import", { method: "PUT", as: owner, ifMatch: etag, body: { auto_continue: true } })).status, 200);
    t.stores.data.fail({ op: ["get", "getWithMetadata"], key: "cfg/import", times: 3 });
    assert.equal((await runSweep()).result, "setting_unreadable");
    t.stores.data.clearHooks();
    assert.equal(continuations(t).length, 0);
    assert.match((await runSweep()).result, /^started:/);
    // the screen shows the default when it can't read it (it starts nothing)
    t.stores.data.fail({ op: ["get", "getWithMetadata"], key: "cfg/import", times: 3 });
    assert.equal((await scope(() => C.restView())).auto, true);
  } finally { t.stores.data.clearHooks(); live(); t.done(); }
});

// ------------------------------------------------------------ 3. a run that stops for good

test("a continuation the lane gives up on: it says so, the owners are told, an alert shows, new imports can start, its rows are cleaned up", async () => {
  const { t, owner } = await setup();
  try {
    const ex = generate({ scale: 0.02, seed: 62 });
    part("fixture.g4", "invoices", "g4");
    const r1 = await importExport(t, owner, ex);
    const root = r1.ir.id;
    live();
    advance(hours(1));
    await t.runWorker({ lane: "bulk" });           // the hourly check starts it
    const c = continuations(t)[0];
    assert.equal(c.auto, true);
    await giveUp(t, c.id, root, "invoices");
    let ir = await run(c.id);
    assert.equal(ir.status, "failed", "not \"running\" for ever");
    assert.equal(ir.stopped.code, "blobstransienterror");
    assert.ok(ir.finished_at);
    assert.equal((await store.getRecord("run", ir.lane_run_id)).data.status, "failed");
    await drain(t);
    const told = notices(t).filter((n) => n.user_id === owner.id && n.title === "Rotor import stopped");
    assert.equal(told.length, 1, "the owners are told");
    assert.match(told[0].body, /^Bringing in more of your Rotor export of Nov 10 stopped before it finished/);
    assert.equal(told[0].link, `/import/${c.id}`);
    assert.ok((await alerts()).includes(`import:${c.id}`), "Settings, Data shows it");
    const d = (await t.api(`/import/runs/${c.id}`, { as: owner })).body.data;
    assert.deepEqual([d.run.status, d.run.stopped.code], ["failed", "blobstransienterror"]);
    // it isn't started again by itself; the staged rows are still there for Resume
    for (let h = 0; h < 3; h++) { advance(hours(1)); await t.runWorker({ lane: "bulk" }); }
    assert.equal(continuations(t).length, 1);
    assert.equal((await runSweep()).result, "cancelled_before");
    assert.ok(t.stores.data.keys(`imp/${root}/raw/`).length > 0);
    // Resume: it goes on and finishes; the alert goes away
    assert.equal((await t.api(`/import/runs/${c.id}/resume`, { method: "POST", as: owner, body: {} })).status, 200);
    ir = await run(c.id);
    assert.deepEqual([ir.status, ir.stopped, ir.finished_at], ["running", undefined, undefined]);
    assert.ok(!(await alerts()).includes(`import:${c.id}`));
    assert.equal((await runToEnd(t, owner, c.id, { start: false })).run.status, "done");
    assert.equal(lateRows(t, "g4").length, ex.invoices.length);
  } finally { t.stores.data.clearHooks(); live(); t.done(); }
});

test("a stuck continuation nobody resumes: a new import can start, and its staged rows go 30 days after their last use", async () => {
  const { t, owner } = await setup();
  try {
    const ex = generate({ scale: 0.02, seed: 103 });
    part("fixture.g5", "invoices", "g5");
    const r1 = await importExport(t, owner, ex);
    const root = r1.ir.id;
    live();
    advance(hours(1));
    await t.runWorker({ lane: "bulk" });
    const c = continuations(t)[0];
    await giveUp(t, c.id, root, "invoices");
    assert.equal((await run(c.id)).status, "failed");
    const had = t.stores.data.keys(`imp/${root}/raw/`).length;
    assert.ok(had > 0);
    // months of hourly checks and nightly clean-ups
    const results = new Set();
    for (let d = 0; d < 200; d += 10) { advance(days(10)); results.add((await runSweep()).result); await gc(); }
    assert.deepEqual([...results], ["cancelled_before"]);
    assert.equal(t.stores.data.keys(`imp/${root}/raw/`).length, 0, "the plaintext rows are gone");
    assert.ok((await run(root)).staging_cleared_at);
    // nothing blocks the next import or the button (which says the rows are gone)
    const who = await t.user("owner", { name: "Later Owner", login: "later" });
    assert.equal((await go(t, who)).body.error.message, C.CLEARED_MESSAGE);
    assert.equal((await t.api(`/import/runs/${c.id}/resume`, { method: "POST", as: who, body: {} })).status, 200, "Resume is still offered; it stops again at once");
    for (let i = 0; i < 3; i++) await t.runWorker({ lane: "bulk" });
    const again = await run(c.id);
    assert.deepEqual([again.status, again.stopped.code], ["failed", "staging_gone"]);
    assert.equal((await t.api(`/import/runs/${c.id}/resume`, { method: "POST", as: who, body: {} })).body.error.message, C.CLEARED_MESSAGE, "then it says why");
    assert.equal((await t.api("/import/runs", { method: "POST", as: who, body: {} })).status, 201, "a new import can start");
  } finally { t.stores.data.clearHooks(); live(); t.done(); }
});

test("a first import the lane gives up on (and one whose lane run ended without telling it): marked stopped, told, cleaned up", async () => {
  const { t, owner } = await setup();
  try {
    const ex = generate({ scale: 0.02, seed: 104 });
    const { ir } = await stageRun(t, owner, ex);
    assert.equal((await t.api(`/import/runs/${ir.id}/start`, { method: "POST", as: owner, body: {} })).status, 200);
    await giveUp(t, ir.id, ir.id, "customers");
    let rec = await run(ir.id);
    assert.equal(rec.status, "failed");
    assert.ok(rec.finished_at, "it has an end, so the clean-up sees it");
    await drain(t);
    assert.match(notices(t).find((n) => n.user_id === owner.id && n.title === "Rotor import stopped").body, /^The import of your Rotor export of Nov 10 stopped before it finished/);
    assert.equal((await t.api("/import/runs", { method: "POST", as: owner, body: {} })).status, 201, "it doesn't block a new import");
    advance(days(31));
    await gc();
    assert.equal(t.stores.data.keys(`imp/${ir.id}/raw/`).length, 0, "its rows go 30 days after it stopped");

    // a run that says running although its lane run ended (cancelled or failed by another path): the checks notice
    const ex2 = generate({ scale: 0.02, seed: 105 });
    for (const r of runsOf(t).filter((x) => x.status === "uploading")) await t.api(`/import/runs/${r.id}/cancel`, { method: "POST", as: owner, body: {} });
    const b = await stageRun(t, owner, ex2);
    assert.equal((await t.api(`/import/runs/${b.ir.id}/start`, { method: "POST", as: owner, body: {} })).status, 200);
    runner.IMPORT_LIMITS.stepRows = 10;
    await t.runWorker({ lane: "bulk" });
    runner.IMPORT_LIMITS.stepRows = Infinity;
    rec = await run(b.ir.id);
    assert.equal(rec.status, "running");
    await store.updateRecord("run", rec.lane_run_id, (r) => ({ ...r, status: "failed", error: { code: "unknown_kind" }, finished_at: "2026-12-20T00:00:00.000Z" }), SYS);
    assert.equal((await t.api("/settings/import", { method: "PUT", as: owner, ifMatch: "new", body: { auto_continue: false } })).status, 200);
    assert.equal((await runSweep()).result, "stopped", "noticed by the hourly check, whatever the setting says");
    rec = await run(b.ir.id);
    assert.deepEqual([rec.status, rec.stopped.code], ["failed", "unknown_kind"]);
    assert.ok((await alerts()).includes(`import:${b.ir.id}`));
    // the nightly clean-up notices too (the CRM may be paused, the setting off)
    const c2 = await stageRun(t, owner, ex2);
    assert.equal((await t.api(`/import/runs/${c2.ir.id}/start`, { method: "POST", as: owner, body: {} })).status, 200);
    const queued = await run(c2.ir.id);
    await store.updateRecord("run", queued.lane_run_id, (r) => ({ ...r, status: "cancelled", finished_at: "2026-12-20T00:00:00.000Z" }), SYS);
    await gc();
    assert.equal((await run(c2.ir.id)).status, "failed");
    // cancelling a stopped run clears its alert
    assert.equal((await t.api(`/import/runs/${b.ir.id}/cancel`, { method: "POST", as: owner, body: {} })).status, 200);
    assert.ok(!(await alerts()).includes(`import:${b.ir.id}`));
  } finally { t.stores.data.clearHooks(); runner.IMPORT_LIMITS.stepRows = Infinity; t.done(); }
});

// ------------------------------------------------------------ 4. staged rows that are gone

test("a staged chunk that vanishes under a continuation: the run fails and says why; the phase is never done with nothing", async () => {
  const { t, owner } = await setup();
  try {
    const ex = generate({ scale: 0.02, seed: 64 });
    part("fixture.g6", "invoices", "g6");
    const r1 = await importExport(t, owner, ex);
    const root = r1.ir.id;
    live();
    const made = await go(t, owner);
    assert.equal(made.status, 201);
    const id = made.body.data.run.id;
    for (const k of t.stores.data.keys(`imp/${root}/raw/invoices/`)) await store.deleteRaw(k);
    for (let i = 0; i < 4; i++) await t.runWorker({ lane: "bulk" });
    const ir = await run(id);
    assert.deepEqual([ir.status, ir.stopped.code], ["failed", "staging_gone"], "failed at once: trying again can't help");
    const st = await runner.loadState(id);
    assert.notEqual(st.phases["fixture.g6"].status, "done");
    assert.equal(st.phases["fixture.g6"].read, 0);
    assert.equal(lateRows(t, "g6").length, 0);
    await drain(t);
    const note = notices(t).find((n) => n.user_id === owner.id && n.link === `/import/${id}`);
    assert.equal(note.body, "Bringing in more of your Rotor export of Nov 10 stopped: that export's rows were cleared. Start a new import to bring in the rest.");
    assert.equal(notices(t).filter((n) => /is in$|checked$/.test(n.title)).length, 0, "no \"nothing new\" note");
    // the phase is still open: a new import brings it in; this export can't
    const v = await rest(t, owner);
    assert.deepEqual(v.ready.map((x) => x.phase), ["fixture.g6"]);
    assert.equal(v.staging, "cleared");
    assert.equal((await go(t, owner)).body.error.message, C.CLEARED_MESSAGE);
    assert.equal((await t.api(`/import/runs/${id}/resume`, { method: "POST", as: owner, body: {} })).body.error.message, C.CLEARED_MESSAGE);
    advance(days(1));
    const r2 = await importExport(t, owner, ex);
    assert.equal(r2.run.status, "done");
    assert.equal(lateRows(t, "g6").length, ex.invoices.length);
  } finally { live(); t.done(); }
});

test("the clean-up and the button can't cross: whichever stamps the upload's run second gives way", async () => {
  const { t, owner } = await setup();
  const realDelete = t.stores.data.delete;
  try {
    const ex = generate({ scale: 0.02, seed: 101 });
    part("fixture.g7", "visits", "g7");
    const r1 = await importExport(t, owner, ex);
    const root = r1.ir.id;
    live();
    advance(days(31));                                   // the rows are due to go tonight
    const owner2 = await t.user("owner", { name: "Night Owl", login: "nightowl" });
    // (a) the clean-up has started deleting, and is slow for a moment; the owner taps the button
    let deleted = 0, release;
    const gate = new Promise((r) => { release = r; });
    t.stores.data.delete = async function (key, ...more) { if (String(key).startsWith(`imp/${root}/raw/`)) { deleted += 1; if (deleted === 3) await gate; } return realDelete.call(this, key, ...more); };
    const cleaning = gc();
    while (deleted < 3) await new Promise((r) => setImmediate(r));
    assert.ok(t.stores.data.keys(`imp/${root}/raw/visits/`).length > 0, "the chunk the continuation needs is still there at that moment");
    const res = await go(t, owner2);
    assert.equal(res.status, 409);
    assert.equal(res.body.error.message, C.CLEARED_MESSAGE, "the run is stamped cleared before the first delete");
    release();
    await cleaning;
    t.stores.data.delete = realDelete;
    assert.equal(t.stores.data.keys(`imp/${root}/raw/`).length, 0);
    assert.equal(continuations(t).length, 0);
    assert.equal((await rest(t, owner2)).staging, "cleared");

    // (b) the other way round: a continuation is made first; the clean-up (which read the index before) leaves the rows
    advance(days(1));
    const r2 = await importExport(t, owner2, ex);
    part("fixture.g8", "campaigns", "g8");
    live();
    advance(days(31));
    const owner3 = await t.user("owner", { name: "Early Bird", login: "earlybird" });
    const realGet = t.stores.data.getWithMetadata;
    let made = null, reads = 0;
    // right after the clean-up's first read of the runs index, the button is tapped
    t.stores.data.getWithMetadata = async function (key, ...more) {
      const out = await realGet.call(this, key, ...more);
      if (key === "ix/import-runs" && (reads += 1) === 1) { t.stores.data.getWithMetadata = realGet; made = await go(t, owner3); }
      return out;
    };
    await gc();
    t.stores.data.getWithMetadata = realGet;
    assert.equal(made.status, 201);
    assert.ok(t.stores.data.keys(`imp/${r2.ir.id}/raw/`).length > 0, "the rows stay: the continuation stamped its use first");
    assert.equal((await run(r2.ir.id)).staging_cleared_at, undefined);
    assert.equal((await runToEnd(t, owner3, made.body.data.run.id, { start: false })).run.status, "done");
    assert.equal(lateRows(t, "g8").length, ex.campaigns.length);
  } finally { t.stores.data.delete = realDelete; live(); t.done(); }
});

// ------------------------------------------------------------ 5. code from before continuations

test("a continuation has a lane run kind of its own, which older code doesn't step; one that older code did step is never a base", async () => {
  const { t, owner } = await setup();
  try {
    const ex = generate({ scale: 0.03, seed: 91 });
    runner.__hidePhasesForTests(["work.timesheets", "work.timers"]);
    const r1 = await importExport(t, owner, ex);
    const root = r1.ir.id;
    live();
    assert.match((await runSweep()).result, /^started:/);
    const c = continuations(t)[0];
    const lane = (await store.getRecord("run", c.lane_run_id)).data;
    assert.equal(lane.kind, "import.continue", "older code knows only \"import\": its lane leaves an unknown kind alone");
    assert.equal(runner.RUN_KIND, "import");
    assert.notEqual(runner.RUN_KIND_CONTINUE, runner.RUN_KIND);
    assert.ok(lanes.runKind("import.continue") && lanes.runKind("import.continue").lane === "bulk");

    // what older code leaves when it does step one (a rollback, then Resume there): "done", nothing imported, a state
    // made as for an upload (no staging run, no staged chunks), no phases_sig; its index row without the new fields
    const before = await runner.loadState(root);
    await store.putRaw(runner.stateKey(c.id), { v: 1, run_id: c.id, as_of: c.as_of, plan: before.plan, chunks: {}, rows: {}, phases: Object.fromEntries(before.plan.map((p) => [p.name, { status: p.registered ? "empty" : "waiting", read: 0, records: {}, skipped: {} }])), users: {}, types: [], finish: { step: "done" } });
    await store.updateRecord("import_run", c.id, (r) => ({ ...r, status: "done", finished_at: "2026-11-17T15:20:00.000Z", summary: { read: 0, created: 0, updated: 0, phases_done: before.plan.length } }), SYS);
    await store.updateRecord("run", c.lane_run_id, (r) => ({ ...r, status: "done", finished_at: "2026-11-17T15:20:00.000Z" }), SYS);
    const ix = t.stores.data.json("ix/import-runs");
    for (const k of ["cont", "src", "w"]) delete ix.rows[c.id].import_run.d[k];
    await t.stores.data.set("ix/import-runs", JSON.stringify(ix));
    assert.equal(t.stores.data.keys("rec/timesheet/").length + t.stores.data.keys("rec/timer/").length, 0, "nothing came in");

    // back on this code: that run is not the base; the upload's run is, and the rest still comes in
    advance(hours(2));
    const v = await rest(t, owner);
    assert.equal(v.run.id, root, "the screen goes by the upload's run too (and writes nothing)");
    assert.deepEqual(v.ready.map((x) => x.phase).sort(), ["work.timers", "work.timesheets"]);
    assert.equal((await run(c.id)).status, "done");
    assert.match((await runSweep()).result, /^started:/, "the hourly check retires it and starts a real one");
    assert.deepEqual([(await run(c.id)).status, (await run(c.id)).cancel_reason], ["cancelled", "old_version"]);
    const c2 = continuations(t).find((r) => r.id !== c.id);
    assert.equal(c2.continues, root);
    assert.equal(c2.staging_run, root);
    assert.equal((await runToEnd(t, owner, c2.id, { start: false })).run.status, "done");
    assert.equal(t.stores.data.keys("rec/timesheet/").length, ex.timesheets.length);
    assert.equal(t.stores.data.keys("rec/timer/").length, ex.visit_timers.length);
    const after = await rest(t, owner);
    assert.equal(after.run.id, c2.id);
    assert.deepEqual(after.ready, []);
  } finally { live(); t.done(); }
});

test("a continuation whose state older code began (no staging run) is started over by this code, with the upload's rows", async () => {
  const { t, owner } = await setup();
  try {
    const ex = generate({ scale: 0.02, seed: 92 });
    part("fixture.g9", "campaigns", "g9");
    const r1 = await importExport(t, owner, ex);
    live();
    const made = await go(t, owner);
    const id = made.body.data.run.id;
    const base = await runner.loadState(r1.ir.id);
    // older code made its state (as for an upload: this run has no staged chunks of its own) and died before the end
    await store.putRaw(runner.stateKey(id), { v: 1, run_id: id, plan: base.plan, chunks: {}, rows: {}, phases: Object.fromEntries(base.plan.map((p) => [p.name, { status: "pending", chunk: 0, row: 0, read: 0, skipped: {}, records: {}, kept_fields: 0, pointers: {}, extras: {}, warnings: {}, errors: [] }])), users: {}, types: [], finish: { step: "indexes", i: 0, cursor: 0 } });
    const done = await runToEnd(t, owner, id, { start: false });
    assert.equal(done.run.status, "done");
    const st = await runner.loadState(id);
    assert.equal(st.staging_run, r1.ir.id);
    assert.equal(st.phases["fixture.g9"].read, ex.campaigns.length);
    assert.equal(st.phases["contacts.customers"].earlier, r1.ir.id);
    assert.equal(lateRows(t, "g9").length, ex.campaigns.length);
    assert.ok(done.run.phases_sig);
  } finally { live(); t.done(); }
});

// ------------------------------------------------------------ the check's cost and its answers

test("an idle hour costs four reads, also for a run from before this feature and a phase with nothing staged; many callers at once make one run", async () => {
  const { t, owner } = await setup();
  try {
    const ex = generate({ scale: 0.02, seed: 63 });
    runner.__hidePhasesForTests(["work.timesheets", "work.timers"]);
    const r1 = await importExport(t, owner, ex);
    // as production's run was written by the code before this feature
    await store.updateRecord("import_run", r1.ir.id, (r) => { const n = { ...r }; delete n.waiting; delete n.phases_sig; delete n.noted_at; return n; }, SYS);
    const reads = async () => { const m = t.stores.data.calls.length; const res = await runSweep(); const calls = t.stores.data.calls.slice(m); return [res.result, calls.filter((c) => /^get/.test(c.op)).length, calls.length]; };
    assert.equal((await reads())[0], "nothing_ready", "the first hour looks at the run's state, and remembers");
    assert.ok((await run(r1.ir.id)).checked_sig);
    for (let h = 0; h < 3; h++) { advance(hours(1)); assert.deepEqual(await reads(), ["nothing_new", 4, 4], "then: the index (2), the setting, the record"); }
    // the tech app's phases are registered: the next check starts one; afterwards idle again
    live();
    advance(hours(1));
    assert.match((await runSweep()).result, /^started:/);
    const c = continuations(t)[0];
    assert.equal((await runToEnd(t, owner, c.id, { start: false })).run.status, "done");
    advance(hours(1));
    assert.deepEqual(await reads(), ["nothing_new", 4, 4]);
    // a phase is registered whose entity has no staged rows: one look, then idle
    fixtureModule({ types: types(), importPhases: [{ name: "fixture.g10_norows", entity: "no_such_rows", after: ["system.users"], normalize: (r) => r, map: late("g10") }] });
    advance(hours(1));
    assert.equal((await reads())[0], "nothing_ready");
    for (let h = 0; h < 3; h++) { advance(hours(1)); assert.deepEqual(await reads(), ["nothing_new", 4, 4]); }
    assert.equal(continuations(t).length, 1);

    // the button and the check at the same moment: one run, one lane run; only the caller that made it says "started"
    part("fixture.g11", "campaigns", "g11");
    live();
    advance(hours(1));
    await drain(t);
    for (const k of t.stores.data.keys("rec/notification/")) await store.deleteRaw(k);
    const res = await Promise.all([runSweep(), go(t, owner), runSweep(), go(t, owner), go(t, owner)]);
    assert.equal(continuations(t).length, 2);
    const c2 = continuations(t).find((r) => r.id !== c.id);
    assert.equal(t.stores.data.keys("rec/run/").map((k) => t.stores.data.json(k)).filter((r) => r.kind === "import.continue" && r.input.import_run_id === c2.id).length, 1);
    const sweeps = [res[0], res[2]];
    assert.ok(sweeps.filter((r) => /^started:/.test(r.result)).length <= 1);
    assert.ok(sweeps.every((r) => /^started:/.test(r.result) ? r.progress === 1 : r.progress === undefined), "\"already\" and \"busy\" report no progress");
    assert.ok([res[1], res[3], res[4]].filter((r) => r.status === 201).length <= 1);
    assert.equal((await runToEnd(t, owner, c2.id, { start: false })).run.status, "done");
    await drain(t);
    assert.ok(notices(t).filter((n) => n.user_id === owner.id && /Bringing in/.test(n.title)).length <= 1);
    assert.equal(sweepOf("import.continue").mutates, true, "it starts a run that writes");
  } finally { live(); t.done(); }
});
