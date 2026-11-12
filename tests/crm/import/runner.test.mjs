// M2c gate: a full synthetic export imports across repeated passes without
// redoing finished phases (design §11.4 M2c "Gate", §12.7). In npm test the
// export is ~10% of the real counts with steps cut to 40 rows (so a run
// takes dozens of bulk passes); CRM_IMPORT_FULL=1 runs --scale 1.
// Also: a crash mid-phase resumes at the row that failed (and a lost
// checkpoint only redoes rows idempotently), phases of modules that are
// not built wait (and say how many rows wait), cancel and resume, the
// report's money sums and the audited id map download.
import { test } from "node:test";
import assert from "node:assert/strict";
import { setup, stageRun, runToEnd, importExport, store, runner, rotorSnapshot, generate } from "./fixtures.mjs";
import { fixtureModule } from "../../helpers/crm-fixtures.mjs";
import { advance, minutes } from "../../helpers/crm-clock.mjs";

const { getModule } = await import("../../../netlify/lib/crm/core/registry.mjs");
const FULL = process.env.CRM_IMPORT_FULL === "1";

// A rotorFields snapshot with user ids written as logins (two harnesses mint different user ids).
async function bySnapshot(t) {
  const snap = await rotorSnapshot(t.stores, ["contact", "property"]);
  const logins = new Map(t.stores.data.keys("rec/user/").map((k) => { const u = t.stores.data.json(k); return [u.id, u.login]; }));
  return Object.fromEntries(Object.entries(snap).map(([k, v]) => [k, v.replace(/us_[0-9a-z]{20}/g, (id) => logins.get(id) || id)]));
}

// Counts map() calls per (phase, row id) on every registered phase.
function spyMaps() {
  const calls = new Map();
  const undo = [];
  for (const name of ["import", "contacts"]) {
    for (const p of getModule(name).importPhases) {
      const orig = p.map;
      p.map = async (row, ctx) => { const k = `${p.name}|${row && (row.id ?? row.rid ?? JSON.stringify(row))}`; calls.set(k, (calls.get(k) || 0) + 1); return orig(row, ctx); };
      undo.push(() => { p.map = orig; });
    }
  }
  return { calls, restore: () => undo.forEach((f) => f()) };
}

test(`the gate: a synthetic export (scale ${FULL ? 1 : 0.1}) imports across repeated passes; no finished phase or row is done twice`, async () => {
  const { t, owner } = await setup();
  const spy = spyMaps();
  try {
    const ex = generate({ scale: FULL ? 1 : 0.1, seed: 7 });
    runner.IMPORT_LIMITS.stepRows = FULL ? 600 : 40;
    const { ir } = await stageRun(t, owner, ex, { per: FULL ? 1000 : 120 });
    const finishedAt = {};
    const t0 = performance.now();
    const r = await runToEnd(t, owner, ir.id, {
      maxPasses: 2000,
      async onPass() {
        const st = await runner.loadState(ir.id);
        if (!st) return;
        for (const [name, p] of Object.entries(st.phases)) {
          if (p.finished_at) {
            if (finishedAt[name]) assert.equal(p.finished_at, finishedAt[name], `${name} was not run again`);
            finishedAt[name] = p.finished_at;
          }
        }
      },
    });
    const ms = Math.round(performance.now() - t0);
    assert.equal(r.run.status, "done", JSON.stringify(r.lane && r.lane.error));
    assert.ok(r.passes > (FULL ? 20 : 15), `many passes (${r.passes})`);
    assert.deepEqual([...spy.calls.values()].filter((n) => n !== 1), [], "every row mapped exactly once");
    const st = await runner.loadState(ir.id);
    const read = Object.values(st.phases).reduce((s, p) => s + p.read, 0);
    // every phase that ran read its entity's rows (an entity two phases take, like leads, is read by each)
    const ran = st.plan.filter((p) => !["waiting", "empty"].includes(st.phases[p.name].status));
    assert.ok(ran.some((p) => p.name === "sales.opportunities") && ran.filter((p) => p.entity === "leads").length >= 2);
    const staged = ran.reduce((s, p) => s + (ex[p.entity] || []).length, 0);
    assert.equal(read, staged, "every staged row of every running phase was read once");
    assert.equal(r.run.summary.pass, true);
    assert.equal(st.phases["contacts.customers"].records.contact.created, ex.customers.length);
    if (FULL) process.stdout.write(`# full scale: ${r.passes} passes, ${ms} ms, ${read} rows\n`);
    // the same export again (a weekly run): nothing created, nothing in conflict
    runner.IMPORT_LIMITS.stepRows = Infinity;
    spy.calls.clear();
    const again = await importExport(t, owner, ex, { per: FULL ? 1000 : 120 });
    assert.equal(again.run.summary.created, 0);
    assert.equal(again.run.summary.updated, 0, "nothing rewritten (records folded from many rows share one base)");
    assert.equal(again.run.summary.conflicts_open, 0);
  } finally { spy.restore(); runner.IMPORT_LIMITS.stepRows = Infinity; t.done(); }
});

test("a crash mid-phase resumes at the row that failed; a lost checkpoint redoes rows without duplicates", async () => {
  const ex = generate({ scale: 0.04, seed: 8 });
  // a clean run for comparison
  const clean = await setup();
  let cleanSnap;
  try { await importExport(clean.t, clean.owner, ex); cleanSnap = await bySnapshot(clean.t); } finally { clean.t.done(); }

  const { t, owner } = await setup();
  const spy = spyMaps();
  try {
    runner.IMPORT_LIMITS.stepRows = 5;
    const { ir } = await stageRun(t, owner, ex, { per: 50 });
    assert.equal((await t.api(`/import/runs/${ir.id}/start`, { method: "POST", as: owner, body: {} })).status, 200);
    let failedOnce = false, rewound = false, saved = null;
    for (let pass = 0; pass < 600; pass++) {
      const cur = (await store.getRecord("import_run", ir.id)).data;
      if (cur.status === "done") break;
      const st = await runner.loadState(ir.id);
      // storage dies while the customers phase writes a contact (every retry of that call fails)
      if (!failedOnce && st && st.phases["contacts.customers"].status === "running" && st.phases["contacts.customers"].read > 5) {
        t.stores.data.fail({ op: ["set", "setJSON"], key: /^rec\/contact\//, times: 4, kind: "timeout" });
        failedOnce = true;
      }
      // the function is killed after a step and its checkpoints of that step are lost: the state goes back one pass
      if (saved && !rewound) { await store.putRaw(runner.stateKey(ir.id), saved); rewound = true; }
      else if (!saved && st && st.phases["contacts.leads"].status === "running" && st.phases["contacts.leads"].read >= 3) saved = JSON.parse(JSON.stringify(st));
      await t.runWorker({ lane: "bulk" });
      advance(minutes(10));            // past any retry_at the lane set
    }
    const done = (await store.getRecord("import_run", ir.id)).data;
    assert.equal(done.status, "done");
    assert.ok(failedOnce && rewound);
    assert.deepEqual(await bySnapshot(t), cleanSnap, "the same records and values as a run that never crashed");
    const twice = [...spy.calls.entries()].filter(([, n]) => n > 1).map(([k]) => k.split("|")[0]);
    assert.ok(twice.filter((p) => p === "contacts.customers").length <= 1, "after the storage error only the row that failed was mapped again");
    assert.ok(twice.every((p) => p === "contacts.customers" || p === "contacts.leads"), "only the interrupted phases redid rows");
    assert.equal(twice.filter((p) => p === "contacts.customers").length, 1);
  } finally { spy.restore(); runner.IMPORT_LIMITS.stepRows = Infinity; t.done(); }
});

test("phases of modules not built yet wait (and say how many rows wait); a phase after a waiting one waits too", async () => {
  // a module that registers a phase depending on Payroll's (which isn't there)
  fixtureModule({ importPhases: [{ name: "fixture.after_payroll", entity: "payroll", after: ["payroll.payroll"], normalize: (r) => r, map: async () => ({}) }] });
  const plan = runner.phasePlan();
  assert.ok(plan.findIndex((p) => p.name === "system.users") < plan.findIndex((p) => p.name === "contacts.customers"), "after: system.users");
  assert.ok(plan.findIndex((p) => p.name === "contacts.leads") < plan.findIndex((p) => p.name === "contacts.suppressions"));
  const { t, owner } = await setup();
  try {
    const ex = generate({ scale: 0.02, seed: 12 });
    const r = await importExport(t, owner, ex);
    assert.equal(r.run.status, "done");
    const rep = (await t.api(`/import/runs/${r.ir.id}/report`, { as: owner })).body.data;
    const w = Object.fromEntries(rep.waiting.map((x) => [x.phase, x]));
    assert.equal(w["money.invoices"].waiting_for, "money");
    assert.equal(w["money.invoices"].rows, ex.invoices.length, "the report says how many rows wait");
    assert.ok(!w["comms.messages"] && !w["comms.templates"] && !w["comms.campaigns"] && !w["comms.pin_types"], "Messages (M6) runs its phases");
    assert.equal(w["fixture.after_payroll"].waiting_for, "payroll.payroll", "after a phase that isn't there: waits");
    // every phase the design expects from a module that hasn't registered it yet waits
    const { EXPECTED_PHASES } = await import("../../../netlify/lib/crm/modules/import/catalog.mjs");
    const registered = new Set(runner.phasePlan().filter((p) => p.registered).map((p) => p.name));
    for (const p of EXPECTED_PHASES) if (!registered.has(p.name)) assert.ok(w[p.name], `${p.name} waits`);
    assert.ok(w["payroll.payroll"]);
    assert.ok(!w["plans.plans"] && !w["plans.lights"] && !w["plans.agreement_templates"], "Plans (M3b) runs its phases");
    assert.ok(!w["work.jobs"] && !w["work.visits"], "Scheduling's phases run");
    assert.ok(!w["quotes.quotes"] && !w["quotes.price_book"] && !w["quotes.discounts"], "Quotes (M3a) runs its phases");
    assert.ok(!w["contacts.customers"]);
    assert.ok(!w["sales.pipelines"] && !w["sales.opportunities"] && !w["sales.tasks"], "a module that shipped runs its phases");
    // the run's money: Rotor's side from the staged rows
    const inv = rep.money.rotor.invoices;
    assert.equal(inv.count, ex.invoices.length);
    assert.equal(inv.total_cents, ex.invoices.reduce((s, x) => s + x.total_cents, 0));
    const refunds = ex.payments.filter((p) => p.payment_type === "refund" && p.status !== "failed").reduce((s, p) => s + p.total_amount_cents, 0);
    assert.equal(rep.money.rotor.payments.refunds_cents, refunds);
    assert.equal(rep.money.crm, null);
    assert.ok(rep.integrity.timers_running >= 1);
    assert.ok(rep.quality.warnings.phone_twelve_digits >= 1, "data quality: the 12-digit phone");
    assert.ok(JSON.stringify(rep).indexOf("@example.com") === -1, "the report holds no email (counts only)");
    // the CSVs
    const csv = await t.api(`/import/runs/${r.ir.id}/report.csv`, { as: owner });
    assert.equal(csv.status, 200);
    assert.match(csv.headers.get("content-type"), /text\/csv/);
    assert.match(csv.text, /^section,phase,metric,value/);
    const idmap = await t.api(`/import/runs/${r.ir.id}/idmap.csv`, { as: owner });
    assert.equal(idmap.status, 200);
    const lines = idmap.text.trim().split("\r\n");
    assert.equal(lines[0], "rotor_type,rotor_id,crm_id,crm_type");
    assert.ok(lines.some((l) => l.startsWith(`customer,${ex.customers[1].id},ct_`)));
    assert.ok(lines.some((l) => l.startsWith("user,") && l.endsWith(",user")));
    const evts = t.stores.data.keys(`evt/import_run/${r.ir.id}/`);
    assert.ok(evts.some((k) => k.includes("--idmap_download--")), "the download is audited");
    assert.ok(evts.some((k) => k.includes("--phase_done--")), "one summary event per phase");
  } finally { t.done(); }
});

test("cancel, and resume after the lane gave up; only one import at a time; the screen's run detail", async () => {
  const { t, owner, owner2 } = await setup();
  try {
    const ex = generate({ scale: 0.02, seed: 13 });
    runner.IMPORT_LIMITS.stepRows = 10;
    const { ir } = await stageRun(t, owner, ex);
    // before the start: the team map, proposed by name
    const d0 = (await t.api(`/import/runs/${ir.id}`, { as: owner })).body.data;
    assert.equal(d0.upload.chunks, d0.upload.expected);
    assert.equal(d0.team.members.length, 5);
    assert.ok(d0.team.members.every((m) => m.match && m.match.how === "name"));
    // the owner says the second Rotor owner is someone else
    const m = await t.api(`/import/runs/${ir.id}/user-map`, { method: "POST", as: owner, body: { map: { [ex.members[1].user_id]: owner.id } } });
    assert.equal(m.status, 200);
    const d1 = (await t.api(`/import/runs/${ir.id}`, { as: owner })).body.data;
    assert.deepEqual(d1.team.members[1].match.how, "override");
    await t.api(`/import/runs/${ir.id}/user-map`, { method: "POST", as: owner, body: { map: { [ex.members[1].user_id]: null } } });
    assert.equal((await t.api(`/import/runs/${ir.id}/start`, { method: "POST", as: owner, body: {} })).status, 200);
    const again = await t.api("/import/runs", { method: "POST", as: owner2, body: {} });
    assert.equal(again.status, 409, "one import at a time");
    await t.runWorker({ lane: "bulk" });
    // the lane gives up (storage kept failing): the run shows it, and resume picks up at the cursor
    const run = (await store.getRecord("import_run", ir.id)).data;
    await store.updateRecord("run", run.lane_run_id, (x) => ({ ...x, status: "failed", error: { code: "BlobsTransientError" } }), { by: "system", origin: "worker", actor_kind: "automation" });
    const d2 = (await t.api(`/import/runs/${ir.id}`, { as: owner })).body.data;
    assert.equal(d2.lane.status, "failed");
    const before = (await runner.loadState(ir.id)).phases;
    const res = await t.api(`/import/runs/${ir.id}/resume`, { method: "POST", as: owner, body: {} });
    assert.equal(res.status, 200);
    const r = await runToEnd(t, owner, ir.id, { start: false });
    assert.equal(r.run.status, "done");
    assert.notEqual(r.run.lane_run_id, run.lane_run_id, "a fresh lane run");
    assert.ok(Object.values(before).some((p) => p.read > 0), "it had made progress before");
    // cancel: a run that hasn't started its phases stops, and its staging can't take more
    advance(minutes(1));
    const { ir: ir2, key } = await stageRun(t, owner, ex);
    assert.equal((await t.api(`/import/runs/${ir2.id}/cancel`, { method: "POST", as: owner, body: {} })).body.data.status, "cancelled");
    const put = await t.api(`/import/runs/${ir2.id}/chunks/members-0001`, { method: "PUT", headers: { authorization: `Bearer ${key}` }, raw: Buffer.from("{}"), csrf: false, client: false });
    assert.equal(put.status, 409);
    const list = (await t.api("/import/runs", { as: owner })).body.data;
    assert.deepEqual(list.map((x) => x.status), ["cancelled", "done"]);
  } finally { runner.IMPORT_LIMITS.stepRows = Infinity; t.done(); }
});
