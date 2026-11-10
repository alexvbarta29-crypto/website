// The phase runner (design §10.1 step 6-7): one import run, stepped by the
// bulk lane (a lane run of kind "import", core/lanes.mjs), checkpointed so
// it survives the 15-minute limit, a crash or a deploy.
//
// The plan. Every registered module's `importPhases` (this module's
// system.* phases, contacts' rows 6-12 and 36, later sales, quotes, ...),
// ordered by their `after` lists (a phase runs after the phases it names).
// A phase the design expects from a module that hasn't registered it yet
// (catalog.mjs) is listed as "waiting" (the report says for which module
// and how many staged rows wait); so is a phase whose `after` names a phase
// that is waiting or unknown. The plan is fixed when the run starts.
//
// One step (≤ the bulk chunk's 2 minutes): the next unfinished phase reads
// its entity's staged chunks from its cursor (chunk + row), and per row:
// normalize() (a RowError skips the row with its field), map(row, ctx),
// then the output is written: records with field ownership
// (ownership.mjs), then pointers (unique ones claimed onlyIfNew, lookup
// lists through updatePointerList), then the extras (patches, stats parts,
// suppressions, merge candidates: contacts' applyExtras). Records first so
// a crash leaves no pointer to a record that isn't there; a row redone
// after a crash lands on the same ids and changes nothing twice.
//   - The cursor is saved every 5 seconds (or 50 rows), at the end of the step, and
//     before an error is passed on, so a resumed run starts at the row that
//     failed: finished rows and finished phases are never done again.
//   - A storage error after some rows ends the step quietly (the next pass
//     goes on); with no row done it is thrown, so the lane backs off.
//   - Anything else wrong with one row (a mapper bug, a value the type
//     refuses, a taken pointer) skips that row with a code, never the run.
// The finish steps: rebuild every index and relation family of the types
// written (bulk writes skip index rows), the id map CSV, the report.
//
// ctx for map(): { runId, idForRotor, lookup(type, rotorId) → crmId | null
// (ptr/rotor/{type}/{rotorKey}, following merges for contacts), users:
// Map<rotorUserId, crmUserId>, settings: { get(name) }, report: { warn(code) },
// cache: {} (per phase and step), phase, prepared }.
//
// Sources (field ownership keeps an import base per source, ownership.mjs):
// a record a row writes has the source "<entity>:<row id>" (a second phase
// of the same entity adds "~<phase name>", so two phases never share one
// base). A record that map() folds from many rows (it reads the record and
// returns its whole new state, like Sales' deal from all of a contact's
// opportunities) names its source itself: { type, data, source: "deal" }
// gives "<entity>:deal" for every row of the entity, so they share one base
// and an unchanged export writes nothing; a source with ":" is taken as it
// is (two phases folding one record give the same name). The rank comes
// from the part before ":".

import { getRecord, updateRecord, getRaw, putRaw, readPointer, claimPointer, updatePointerList, rebuildIndex, verifyRels, appendEvent, getSetting, listKeys } from "../../../crm-store.mjs";
import { defineRun, createRun, RUN_MAX_ATTEMPTS } from "../../core/lanes.mjs";
import { allModules, getType } from "../../core/registry.mjs";
import { idForRotor, deriveId, typeOf, isId } from "../../core/ids.mjs";
import { nowIso, nowMs } from "../../core/clock.mjs";
import { has as hasService, call as callService } from "../../core/services.mjs";
import { InputError, ExistsError, RegistryError, BlobsTransientError, TimeoutError, UnknownOutcome, BudgetError, StaleError, SchemaTooNew } from "../../core/errors.mjs";
import { keySafe } from "../../core/text.mjs";
import { safeErr } from "../../../referral-lib.mjs";
import { rotorKey } from "../contacts/display.mjs";
import { applyExtras } from "../contacts/import-rotor.mjs";
import { EXPECTED_PHASES, MODULE_LABELS, phaseLabel } from "./catalog.mjs";
import { writeMapped } from "./ownership.mjs";
import { stagedChunks, readChunk } from "./staging.mjs";
import { buildReport, buildIdMapPart, IDMAP_BATCH } from "./report.mjs";

// Tests turn these down to force many small steps.
export const IMPORT_LIMITS = { minLeftMs: 25000, checkpointRows: 50, checkpointMs: 5000, stepRows: Infinity };
export const RUN_KIND = "import";
export const stateKey = (runId) => `imp/${runId}/state`;

// The import's write context: an import (exempt from the parallel-run
// guard), bulk (no index rows), one summary event per phase instead of one
// per record.
export const importCtx = (holder = "import", mode) => ({ by: "import", origin: "import", actor_kind: "import", requestId: holder, bulk: true, audit: false, ...(mode ? { mode } : {}) });
// What the run itself writes about the run (status, summary): a normal write.
const runCtx = (holder = "import") => ({ by: "import", origin: "import", actor_kind: "import", requestId: holder });

// ------------------------------------------------------------ the plan

// Every registered phase, with its module.
export function registeredPhases() {
  return allModules().flatMap((m) => (m.importPhases || []).map((p) => ({ ...p, module: m.name })));
}

// The order phases run in: registered ones sorted by `after` (stable:
// manifest order breaks ties), then the expected-but-missing ones.
// → [{ name, module, entity, after, registered, row? }]
export function phasePlan(registered = registeredPhases()) {
  const byName = new Map();
  for (const p of registered) if (!byName.has(p.name)) byName.set(p.name, p);
  const list = [...byName.values()];
  const done = new Set();
  const order = [];
  let progress = true;
  while (order.length < list.length && progress) {
    progress = false;
    for (const p of list) {
      if (done.has(p.name)) continue;
      const deps = (p.after || []).filter((d) => byName.has(d));
      if (deps.every((d) => done.has(d))) { done.add(p.name); order.push(p); progress = true; }
    }
  }
  for (const p of list) if (!done.has(p.name)) order.push({ ...p, cycle: true });   // a cycle: listed, never run
  const out = order.map((p) => ({ name: p.name, module: p.module, entity: p.entity, after: p.after || [], registered: !p.cycle }));
  for (const e of EXPECTED_PHASES) if (!byName.has(e.name)) out.push({ name: e.name, module: e.module, entity: e.entity, after: [], registered: false, row: e.row });
  return out;
}

const phaseByName = (name) => registeredPhases().find((p) => p.name === name) || null;

// ------------------------------------------------------------ state

const emptyPhase = () => ({ status: "pending", chunk: 0, row: 0, read: 0, skipped: {}, records: {}, kept_fields: 0, pointers: { claimed: 0, listed: 0, taken: 0 }, extras: { patched: 0, stats: 0, suppressed: 0, candidates: 0 }, warnings: {}, errors: [] });

export async function loadState(runId, opts = {}) {
  const got = await getRaw(stateKey(runId), opts);
  return got && got.data ? got.data : null;
}
async function saveState(state) {
  state.updated_at = nowIso();
  await putRaw(stateKey(state.run_id), state);
}

async function initState(ir) {
  const plan = phasePlan();
  const chunks = await stagedChunks(ir.id);
  const rows = Object.fromEntries(Object.entries((ir.manifest && ir.manifest.entities) || {}).map(([e, x]) => [e, x.rows]));
  const state = { v: 1, run_id: ir.id, as_of: ir.as_of || null, plan, chunks, rows, phases: {}, users: {}, types: [], finish: { step: "indexes", i: 0, cursor: 0 }, started_at: nowIso() };
  for (const p of plan) state.phases[p.name] = emptyPhase();
  await saveState(state);
  return state;
}

const inc = (o, k, n = 1) => { o[k] = (o[k] || 0) + n; };

// ------------------------------------------------------------ lookups for map()

async function resolveContact(id) {
  if (!hasService("contacts.resolve")) return id;
  try { return (await callService("contacts.resolve", id)) || id; } catch { return id; }
}

export function mapCtx(state, { runId, phase, settingsCache = {} } = {}) {
  const users = new Map(Object.entries(state.users || {}));
  const ph = state.phases[phase.name];
  return {
    runId, phase: phase.name, idForRotor, users, cache: {},
    async lookup(type, rid) {
      if (rid === undefined || rid === null || String(rid) === "") return null;
      const p = await readPointer(`rotor/${type}`, rotorKey(rid));
      if (!p || !isId(p.id)) return null;
      return typeOf(p.id) === "contact" ? resolveContact(p.id) : p.id;
    },
    settings: { get: async (name) => (settingsCache[name] ||= await getSetting(name)) },
    report: { warn: (code) => inc(ph.warnings, keySafe(String(code || "warning"), 60)) },
    // the team phase records each member's user as it goes
    setUser(rid, uid) { users.set(String(rid), uid); state.users[String(rid)] = uid; },
  };
}

// ------------------------------------------------------------ one row

// Errors that end the step (storage, time); anything else skips the row.
export function isStorageError(e) {
  return e instanceof BlobsTransientError || e instanceof TimeoutError || e instanceof UnknownOutcome || e instanceof BudgetError || e instanceof StaleError || e instanceof SchemaTooNew
    || (e && (e.name === "BlobsInternalError" || e.name === "TimeoutError" || e.name === "AbortError"));
}
const rowCode = (e) => (e && e.name === "RowError" ? "invalid" : e instanceof InputError ? "invalid" : e instanceof ExistsError ? "taken" : e instanceof RegistryError ? "unknown_type" : "error");

const rowIdOf = (raw) => (raw && (typeof raw.id === "string" || typeof raw.id === "number") ? String(raw.id) : raw && raw.user_id ? String(raw.user_id) : null);

// Types whose records this run really wrote (their indexes and relation
// families are rebuilt at the end; an unchanged run rebuilds nothing).
const WROTE = new Set(["created", "updated", "linked", "conflicted"]);
const touch = (state, t) => { if (t && !state.types.includes(t)) state.types.push(t); };

// Writes one map() output. → nothing; tallies into ph. rank: the phase's
// own rank for the field ownership (else SOURCE_RANK by entity).
export async function applyOutput(out, { runId, ph, ctx, source, state, rank, entity = null }) {
  for (const rec of out.records || []) {
    const r = await writeMapped(rec, { runId, source: recordSource(rec, source, entity), ctx, rank });
    const t = r.type || (rec && rec.type) || "unknown";
    const row = (ph.records[t] ||= {});
    inc(row, r.outcome);
    if (r.kept && r.kept.length) ph.kept_fields += r.kept.length;
    if (r.outcome === "invalid") inc(ph.warnings, `invalid_${t}${r.field ? "_" + keySafe(String(r.field), 30) : ""}`);
    if (WROTE.has(r.outcome)) touch(state, t);
  }
  for (const p of out.pointers || []) {
    if (!p || !p.kind || !p.key || !p.value || !isId(p.value.id)) continue;
    if (p.list) {
      await updatePointerList(p.kind, p.key, (ids) => (ids.includes(p.value.id) ? ids : [...ids, p.value.id]), ctx);
      ph.pointers.listed += 1;
      continue;
    }
    const c = await claimPointer(p.kind, p.key, p.value, ctx);
    if (c.ok) { ph.pointers.claimed += 1; continue; }
    const cur = c.current && c.current.id;
    const same = cur === p.value.id || (cur && typeOf(cur) === "contact" && (await resolveContact(cur)) === (await resolveContact(p.value.id)));
    if (!same) { ph.pointers.taken += 1; inc(ph.warnings, "pointer_taken"); }
  }
  if ((out.patches && out.patches.length) || (out.stats && out.stats.length) || (out.suppressions && out.suppressions.length) || (out.mergeCandidates && out.mergeCandidates.length)) {
    const x = await applyExtras(out, ctx);
    ph.extras.patched += x.patched; ph.extras.stats += x.stats; ph.extras.suppressed += x.suppressed; ph.extras.candidates += x.candidates;
    if (x.stats) touch(state, "contact_stats");
    if (x.candidates) touch(state, "merge_candidate");
    if (x.patched) for (const p of out.patches || []) if (p && p.type) touch(state, p.type);
  }
  for (const w of out.warnings || []) inc(ph.warnings, keySafe(String(w), 60));
}

// The source of one mapped record: the row's, or the one the record names
// (a record folded from many rows; see the header).
const SOURCE_NAME = /^[a-z0-9_.-]{1,40}(:[A-Za-z0-9_.~-]{1,120})?$/;
export function recordSource(rec, rowSource, entity) {
  const named = rec && typeof rec.source === "string" ? rec.source : null;
  if (!named) return rowSource;
  if (!SOURCE_NAME.test(named)) throw new InputError("a record's import source is a short name", "source");
  return named.includes(":") ? named : `${entity || String(rowSource || "row").split(":")[0]}:${named}`;
}

// The row source of a phase: "<entity>:<row id>", plus "~<phase>" for a
// phase that isn't the first of its entity in the plan.
export function rowSource(plan, p, rid) {
  if (!rid) return null;
  const first = plan.find((x) => x.entity === p.entity);
  return `${p.entity}:${String(rid).slice(0, 80)}${first && first.name !== p.name ? `~${p.name}` : ""}`;
}

// The index names of the types a run wrote.
export const indexNamesOf = (types) => [...new Set((types || []).flatMap((t) => { const d = getType(t); return d ? d.indexes.map((x) => x.name) : t === "contact_stats" ? ["contacts"] : []; }))].sort();

// ------------------------------------------------------------ the step

const settled = (st) => ["done", "empty", "waiting"].includes(st.status);

// Why a planned phase can't run now: null, or { waiting_for } (a module, or a phase).
function blockedBy(p, state) {
  if (!p.registered) return { waiting_for: p.module };
  for (const d of p.after || []) {
    const ds = state.phases[d];
    const planned = state.plan.find((x) => x.name === d);
    if (!ds || !planned || !planned.registered) return { waiting_for: d };     // a phase nobody registered (yet)
    if (ds.status === "waiting") return { waiting_for: ds.waiting_for || d };
  }
  return null;
}

// Runs one phase from its cursor while the budget lasts.
// → { finished: boolean, rows: number } (rows done in this call)
async function runPhase(p, state, { runId, budget, ctx, ir, startedRows }) {
  const st = state.phases[p.name];
  const phase = phaseByName(p.name);
  if (!phase) { st.status = "waiting"; st.waiting_for = p.module; return { finished: true, rows: 0 }; }
  const chunks = (state.chunks[p.entity] || []).slice();
  const mctx = mapCtx(state, { runId, phase: p });
  mctx.userOverrides = (ir && ir.user_map) || {};
  if (st.status === "pending") {
    // a phase may look at all its rows once before the first one (the team map)
    if (typeof phase.prepare === "function") {
      const all = [];
      for (const n of chunks) { const c = await readChunk(runId, p.entity, n); for (const row of (c && c.rows) || []) all.push(row); }
      st.prepared = (await phase.prepare(all, mctx)) || null;
    }
    st.status = "running"; st.started_at = nowIso();
  }
  mctx.prepared = st.prepared || null;
  let rows = 0;
  let lastSave = nowMs();
  for (; st.chunk < chunks.length; st.chunk += 1, st.row = 0) {
    const chunk = await readChunk(runId, p.entity, chunks[st.chunk]);
    const list = chunk && Array.isArray(chunk.rows) ? chunk.rows : [];
    for (; st.row < list.length; st.row += 1) {
      if ((budget && budget.left() < IMPORT_LIMITS.minLeftMs) || startedRows + rows >= IMPORT_LIMITS.stepRows) return { finished: false, rows };
      const raw = list[st.row];
      try {
        let row;
        try { row = typeof phase.normalize === "function" ? phase.normalize(raw) : raw; } catch (e) {
          if (isStorageError(e)) throw e;
          inc(st.skipped, "invalid");
          if (st.errors.length < 20) st.errors.push({ chunk: chunks[st.chunk], row: st.row, code: "invalid", field: e && e.field ? String(e.field).slice(0, 60) : null });
          st.read += 1; rows += 1;
          continue;
        }
        const out = (await phase.map(row, mctx)) || {};
        const rid = rowIdOf(raw);
        await applyOutput(out, { runId, ph: st, ctx, source: rowSource(state.plan, p, rid), entity: p.entity, state, rank: Number.isInteger(phase.rank) ? phase.rank : undefined });
      } catch (e) {
        if (isStorageError(e)) { e.rowsDone = rows; throw e; }        // the cursor still points at this row
        const code = rowCode(e);
        inc(st.skipped, code);
        if (st.errors.length < 20) st.errors.push({ chunk: chunks[st.chunk], row: st.row, code, field: e && e.field ? String(e.field).slice(0, 60) : null });
        if (code === "error") console.error(`crm:import: a ${p.name} row failed (${safeErr(e)})`);
      }
      st.read += 1;
      rows += 1;
      if (rows % IMPORT_LIMITS.checkpointRows === 0 || nowMs() - lastSave > IMPORT_LIMITS.checkpointMs) {
        st.row += 1;                     // the row just done is behind the saved cursor
        try { await saveState(state); } finally { st.row -= 1; }
        lastSave = nowMs();
      }
    }
  }
  if (typeof phase.finish === "function") await phase.finish(mctx);
  st.status = "done";
  st.finished_at = nowIso();
  await appendEvent("import_run", runId, {
    action: "phase_done", by: "import", origin: "import", phase: p.name, read: st.read,
    records: st.records, skipped: st.skipped, conflicts: Object.values(st.records).reduce((s, r) => s + (r.conflicted || 0), 0),
  }).catch(() => {});
  return { finished: true, rows };
}

// The finish steps after every phase settled. → true when everything is done.
async function runFinish(state, { runId, budget, ctx }) {
  const f = state.finish;
  const low = () => budget && budget.left() < IMPORT_LIMITS.minLeftMs;
  if (f.step === "indexes") {
    const names = indexNamesOf(state.types);
    for (; f.i < names.length; f.i += 1) {
      if (low()) return false;
      await rebuildIndex(names[f.i]);
      await saveState(state);
    }
    f.step = "rels"; f.i = 0;
  }
  if (f.step === "rels") {
    const types = state.types.filter((t) => { const d = getType(t); return d && d.rels.length; }).sort();
    for (; f.i < types.length; f.i += 1) {
      if (low()) return false;
      await verifyRels(types[f.i], { repair: true });
      await saveState(state);
    }
    f.step = "idmap"; f.i = 0; f.cursor = 0;
  }
  if (f.step === "idmap") {
    const keys = (await listKeys("ptr/rotor/")).sort();
    while (f.cursor < keys.length) {
      if (low()) return false;
      const batch = keys.slice(f.cursor, f.cursor + IDMAP_BATCH);
      await buildIdMapPart(runId, f.i + 1, batch);
      f.i += 1;
      f.cursor += batch.length;
      await saveState(state);
    }
    f.parts = f.i;
    f.step = "report";
  }
  if (f.step === "report") {
    if (low()) return false;
    const report = await buildReport(runId, state);
    f.step = "done";
    await saveState(state);
    state.report = report.summary;
  }
  return f.step === "done";
}

async function importStep(run, rctx) {
  const runId = run.input && run.input.import_run_id;
  if (!isId(runId, "import_run")) return { failed: "no_import_run" };
  const holder = rctx.holder || "import";
  let got = await getRecord("import_run", runId);
  if (!got) return { failed: "no_import_run" };
  let ir = got.data;
  if (ir.status === "cancelled") return { done: true, result: { cancelled: true } };
  if (ir.status === "queued") {
    ir = (await updateRecord("import_run", runId, (r) => (r.status !== "queued" ? null : { ...r, status: "running", started_at: r.started_at || nowIso() }), runCtx(holder))).data;
  }
  if (ir.status !== "running") return { done: true, result: { status: ir.status } };
  const state = (await loadState(runId)) || (await initState(ir));
  const ctx = importCtx(holder, rctx.mode);
  const budget = rctx.budget;
  const total = state.plan.length + 1;
  const progress = () => ({ done: state.plan.filter((p) => settled(state.phases[p.name])).length, total });
  let rows = 0;
  try {
    for (const p of state.plan) {
      const st = state.phases[p.name];
      if (settled(st)) continue;
      const blocked = blockedBy(p, state);
      if (blocked) { st.status = "waiting"; st.waiting_for = blocked.waiting_for; continue; }
      if (!(state.chunks[p.entity] || []).length) { st.status = "empty"; st.finished_at = nowIso(); continue; }
      const r = await runPhase(p, state, { runId, budget, ctx, ir, startedRows: rows });
      rows += r.rows;
      if (!r.finished) { await saveState(state); return { progress: progress(), checkpoint: { phase: p.name, chunk: st.chunk, row: st.row } }; }
      await saveState(state);
    }
    const finished = await runFinish(state, { runId, budget, ctx });
    await saveState(state);
    if (!finished) return { progress: progress(), checkpoint: { phase: "finish", step: state.finish.step } };
  } catch (e) {
    rows += e.rowsDone || 0;
    try { await saveState(state); } catch { /* the last saved cursor stands */ }
    if (isStorageError(e) && rows > 0) {
      console.error(`crm:import: storage stopped a step after ${rows} rows; the next pass goes on (${safeErr(e)})`);
      return { progress: progress(), checkpoint: { stopped: true } };
    }
    // the lane gives up after this try: the records written so far still get their lists
    if ((run.attempts || 0) + 1 >= RUN_MAX_ATTEMPTS) await queueReindex(state.types, holder).catch(() => {});
    throw e;
  }
  const summary = state.report || {};
  await updateRecord("import_run", runId, (r) => (r.status === "cancelled" ? null : { ...r, status: "done", finished_at: nowIso(), summary, conflicts: { open: summary.conflicts_open || 0, resolved: (r.conflicts && r.conflicts.resolved) || 0 } }), runCtx(holder));
  return { done: true, progress: { done: total, total }, result: summary };
}
defineRun(RUN_KIND, { lane: "bulk", step: importStep, label: "Import from Rotor" });

// A bulk "reindex" run for the indexes of the types a run wrote (a run
// that stops before its finish steps: cancelled, or given up).
export async function queueReindex(types, holder = "import") {
  const names = indexNamesOf(types);
  if (!names.length) return null;
  return createRun("reindex", { names }, runCtx(holder));
}

// Queues the lane run for an import run (attempt n gives a fresh lane run on resume).
export function startLaneRun(ir, ctx, attempt = 0) {
  return createRun(RUN_KIND, { import_run_id: ir.id }, ctx, { id: deriveId("run", ir.id, "import.lane", attempt) });
}

// For the Import screen: the plan with each phase's state (counts only).
export function phaseView(state) {
  if (!state) return [];
  return state.plan.map((p) => {
    const st = state.phases[p.name] || emptyPhase();
    const rows = (state.chunks[p.entity] || []).length;
    const sum = (k) => Object.values(st.records || {}).reduce((s, r) => s + (r[k] || 0), 0);
    return {
      name: p.name, label: phaseLabel(p.name), module: p.module, entity: p.entity, status: st.status, waiting_for: st.waiting_for || null, waiting_label: MODULE_LABELS[st.waiting_for] || MODULE_LABELS[String(st.waiting_for || "").split(".")[0]] || null,
      chunks: rows, read: st.read, created: sum("created"), updated: sum("updated"), unchanged: sum("unchanged"), linked: sum("linked") + sum("relinked"),
      conflicted: sum("conflicted"), skipped: Object.values(st.skipped || {}).reduce((s, n) => s + n, 0), started_at: st.started_at || null, finished_at: st.finished_at || null,
    };
  });
}
