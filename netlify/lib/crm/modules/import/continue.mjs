// "Bring in the rest": continuation runs (docs/CRM-IMPORT.md).
//
// A run leaves the phases of modules that aren't built yet "waiting"; its
// staged rows stay for 30 days. When such a module ships, nobody should
// have to upload the export again: a CONTINUATION is a new import run that
// reuses the staged rows of the latest finished run (no upload, no key)
// and runs only the phases that waited and are registered now (and
// whatever comes after them). Phases an earlier run of the chain finished
// are not read again; their pointers, import bases and the team map are
// what the new phases build on (runner.mjs initState). It is an ordinary
// run otherwise: one import at a time, resumable, idempotent, the same
// field ownership, conflicts and report.
//
//   rec/import_run/{id}  continues: the finished run it goes on from (the
//                        latest finished run, itself maybe a continuation)
//                        staging_run: the run whose imp/{id}/raw/ it reads
//                        auto: true when the hourly check started it
//
// Its id is derived from the run it continues (and how many continuations
// of that run exist), so two callers at once make one run.
//
// By itself (the setting cfg/import.auto_continue, on unless an owner turns
// it off in Settings → Data): the sweep import.continue (bulk lane, hourly;
// not while the CRM is paused) starts a continuation when the latest
// finished run has phases that can run now and its rows are still there,
// and tells the owners when it starts and when it is done. The Import
// screen's "Bring in the rest now" does the same on demand
// (POST /import/continue).
//
// The staged rows are kept 30 days from their last use: creating and
// finishing a continuation stamps `staging_used_at` on the run that holds
// them (index.mjs import.staging_gc reads it).

import { getRecord, createRecord, updateRecord, readIndex, listKeys, getSetting } from "../../../crm-store.mjs";
import { deriveId } from "../../core/ids.mjs";
import { nowIso, nowMs } from "../../core/clock.mjs";
import { ConflictError, InputError, ExistsError } from "../../core/errors.mjs";
import { notify, approvers } from "../../core/notify.mjs";
import { safeErr } from "../../../referral-lib.mjs";
import { phasePlan, phasesSignature, loadState, restOf, stagingRunOf, startLaneRun, onRunDone } from "./runner.mjs";
import { rawPrefix, rawKey } from "./staging.mjs";
import { phaseLabel, MODULE_LABELS } from "./catalog.mjs";

export const STAGING_KEEP_DAYS = 30;
export const CLEARED_MESSAGE = "That export's rows were cleared. Start a new import.";
export const NOTHING_MESSAGE = "Nothing new to bring in yet. The rest of the export waits for parts of the CRM that aren't built.";
const DAY = 86400000;
const ACTIVE = new Set(["queued", "running"]);
// an upload somebody made a key for in the last day: a new export is on its way
const UPLOAD_FRESH_MS = 24 * 3600 * 1000;

// ------------------------------------------------------------ the setting

export const IMPORT_SETTING_DEFAULTS = Object.freeze({ auto_continue: true });
export function validateImportSetting(v) {
  const d = v && typeof v === "object" && !Array.isArray(v) ? v : {};
  if (d.auto_continue !== undefined && typeof d.auto_continue !== "boolean") throw new InputError("Yes or no.", "auto_continue");
  return { auto_continue: d.auto_continue !== false };
}
export const autoContinue = async () => (await getSetting("import").catch(() => IMPORT_SETTING_DEFAULTS)).auto_continue !== false;

// ------------------------------------------------------------ what could run

// The newest finished run in the index: by when it finished, and never a
// run that a finished continuation already goes on from (that one is newer,
// whatever the clocks say).
export function latestDone(rows) {
  const done = rows.filter((r) => r.st === "done" && r.fin);
  const continued = new Set(done.map((r) => r.cont).filter(Boolean));
  return done.filter((r) => !continued.has(r.id)).sort((a, b) => (a.fin < b.fin ? 1 : a.fin > b.fin ? -1 : a.at < b.at ? 1 : a.at > b.at ? -1 : a.id < b.id ? 1 : -1))[0] || null;
}

// The part of the CRM a phase belongs to, in words: the part it waits for, else the one its name says ("money.invoices" → Money).
const moduleLabel = (x) => MODULE_LABELS[x.waiting_for] || MODULE_LABELS[String(x.waiting_for || "").split(".")[0]] || MODULE_LABELS[String(x.name).split(".")[0]] || MODULE_LABELS[x.module] || null;

// The phases a state leaves open, with the staged rows each would read:
// → { ready: [...], waiting: [...] } of { phase, label, module, module_label, entity, rows, waiting_for? }.
// A phase whose entity has no staged rows has nothing to bring in and is left out.
export function openPhases(state, plan = phasePlan()) {
  const ready = [], waiting = [];
  for (const x of restOf(plan, state)) {
    const chunks = ((state.chunks || {})[x.entity] || []).length;
    if (!chunks) continue;
    const row = { phase: x.name, label: phaseLabel(x.name), module: x.module, module_label: moduleLabel(x), entity: x.entity, rows: state.rows && state.rows[x.entity] != null ? state.rows[x.entity] : null };
    if (x.ready) ready.push(row); else waiting.push({ ...row, waiting_for: x.waiting_for });
  }
  return { ready, waiting };
}

// Whether the staged chunks these phases read are all still there.
export async function stagingHolds(rootId, state, phases) {
  const have = new Set(await listKeys(rawPrefix(rootId)));
  if (!have.size) return false;
  for (const entity of new Set(phases.map((p) => p.entity))) {
    for (const n of (state.chunks || {})[entity] || []) if (!have.has(rawKey(rootId, entity, n))) return false;
  }
  return true;
}

// For the Import screen: the latest finished run, what of its export can
// be brought in now and what still waits (and for which part), whether its
// rows are still there, and whether the CRM brings the rest in by itself.
export async function restView() {
  const [ix, auto] = await Promise.all([readIndex("import-runs", ""), autoContinue()]);
  const active = ix.rows.find((r) => ACTIVE.has(r.st)) || null;
  const row = latestDone(ix.rows);
  const out = { run: null, ready: [], waiting: [], staging: null, keep_until: null, active: active ? active.id : null, auto };
  if (!row) return out;
  out.run = { id: row.id, as_of: row.asof || null, finished_at: row.fin, continues: row.cont || null };
  const state = await loadState(row.id);
  if (!state) return out;
  const open = openPhases(state);
  out.ready = open.ready;
  out.waiting = open.waiting;
  if (!open.ready.length && !open.waiting.length) return out;
  const rootId = stagingRunOf(state);
  out.staging = (await stagingHolds(rootId, state, [...open.ready, ...open.waiting])) ? "ok" : "cleared";
  const root = ix.rows.find((r) => r.id === rootId);
  const last = root ? Math.max(Date.parse(root.fin || root.at) || 0, Date.parse(root.use || "") || 0) : 0;
  if (out.staging === "ok" && last) out.keep_until = new Date(last + STAGING_KEEP_DAYS * DAY).toISOString();
  return out;
}

// ------------------------------------------------------------ making one

const SYSTEM = { by: "import", origin: "import", actor_kind: "import", requestId: "import.continue" };

// Marks the run that holds the staged rows as used now (they are kept 30 days from here).
async function touchStaging(rootId) {
  await updateRecord("import_run", rootId, (r) => ({ ...r, staging_used_at: nowIso() }), SYSTEM).catch((e) => console.error(`crm:import: the staging's last use was not saved (${safeErr(e)})`));
}

// A continuation that was made but whose lane run never got queued (the
// function died in between): queue it now. → the record | null
async function healActive(rows, ctx) {
  for (const r of rows.filter((x) => ACTIVE.has(x.st) && x.cont)) {
    const got = await getRecord("import_run", r.id);
    const run = got && got.data;
    if (!run || !ACTIVE.has(run.status) || run.lane_run_id) continue;
    const lane = await startLaneRun(run, ctx, run.attempt || 0);
    return (await updateRecord("import_run", run.id, (x) => (x.lane_run_id ? null : { ...x, lane_run_id: lane.id }), ctx)).data;
  }
  return null;
}

// Starts a continuation of the latest finished run. → { run (the record), phases: [{ phase, label, rows }], existed }
// Throws ConflictError with a plain message when there is nothing to go on from.
export async function createContinuation({ auto = false, note = null } = {}, ctx = SYSTEM) {
  const ix = await readIndex("import-runs", "");
  if (ix.rows.some((r) => ACTIVE.has(r.st))) {
    const healed = await healActive(ix.rows, ctx);
    if (healed) return { run: healed, phases: [], existed: true };
    throw new ConflictError("An import is already running. Wait for it to finish first.");
  }
  const row = latestDone(ix.rows);
  if (!row) throw new ConflictError("No import has finished yet. Start one first.");
  const got = await getRecord("import_run", row.id);
  const prev = got && got.data;
  if (!prev || prev.status !== "done") throw new ConflictError("No import has finished yet. Start one first.");
  const state = await loadState(prev.id);
  if (!state) throw new ConflictError(CLEARED_MESSAGE);
  const { ready } = openPhases(state);
  if (!ready.length) throw new ConflictError(NOTHING_MESSAGE);
  const rootId = stagingRunOf(state);
  if (!(await stagingHolds(rootId, state, ready))) throw new ConflictError(CLEARED_MESSAGE);
  // one continuation per finished run at a time: the same id for everyone who asks now
  const id = deriveId("import_run", prev.id, "import.continue", ix.rows.filter((r) => r.cont === prev.id).length);
  let rec, existed = false;
  try {
    rec = (await createRecord("import_run", {
      id, status: "queued", queued_at: nowIso(), ...(prev.as_of ? { as_of: prev.as_of } : {}), continues: prev.id, staging_run: rootId, ...(auto ? { auto: true } : {}),
      ...(note ? { note: String(note).slice(0, 200) } : {}), user_map: {}, conflicts: { open: 0, resolved: 0 }, requested_by: (ctx && ctx.by) || "system", attempt: 0,
    }, ctx)).data;
  } catch (e) {
    if (!(e instanceof ExistsError)) throw e;
    const cur = await getRecord("import_run", id);
    if (!cur) throw e;
    rec = cur.data;
    existed = true;
  }
  await touchStaging(rootId);
  if (!rec.lane_run_id) {
    const lane = await startLaneRun(rec, ctx, rec.attempt || 0);
    rec = (await updateRecord("import_run", id, (x) => (x.lane_run_id === lane.id ? null : { ...x, lane_run_id: lane.id }), ctx)).data;
  }
  return { run: rec, phases: ready, existed };
}

// ------------------------------------------------------------ words for the owners

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
// "2026-11-10" → "Nov 10"
export function exportDay(asOf) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(asOf || ""));
  return m && MONTHS[Number(m[2]) - 1] ? `${MONTHS[Number(m[2]) - 1]} ${Number(m[3])}` : null;
}
const exportName = (asOf) => (exportDay(asOf) ? `your Rotor export of ${exportDay(asOf)}` : "your Rotor export");
// a label inside a sentence: "Invoices" → "invoices"; "Christmas lights seasons" and "STOP replies" stay
const inSentence = (label) => (/^(Christmas|Rotor|STOP)\b/.test(label) ? label : label.charAt(0).toLowerCase() + label.slice(1));
function listOf(labels, max = 4) {
  const shown = labels.length > max ? labels.slice(0, max - 1) : labels;
  const parts = shown.map((l, i) => (i ? inSentence(l) : l));
  if (labels.length > max) parts.push(`${labels.length - shown.length} more parts`);
  return parts.length <= 1 ? parts.join("") : `${parts.slice(0, -1).join(", ")} and ${parts[parts.length - 1]}`;
}
const count = (n) => Number(n || 0).toLocaleString("en-US");
// "are" for several parts or a plural one ("Messages are in"), "is" for a singular one ("Payroll is in")
const verb = (labels) => (labels.length > 1 || /s$/.test(labels[0] || "") ? "are" : "is");
// "712 invoices", "1 invoice", "6 payroll"
const counted = (n, label) => `${count(n)} ${n === 1 && /[^s]s$/.test(label) ? inSentence(label).slice(0, -1) : inSentence(label)}`;

// What the owners read when a continuation starts by itself. phases: [{ label }]
export function startNotice(run, phases) {
  const labels = phases.map((p) => p.label);
  return {
    kind: "system", title: "Bringing in more of your Rotor export",
    body: `${listOf(labels)} from ${exportName(run.as_of)} ${verb(labels)} being brought in now. Nothing to do: you get a note when it's done.`,
    link: `/import/${run.id}`,
  };
}

// What they read when it is done: "Invoices and payments from your Rotor
// export of Nov 10 are in: 712 invoices, 688 payments."
export function finishNotice(run, state) {
  const ran = (state.plan || []).map((p) => ({ label: phaseLabel(p.name), st: state.phases[p.name] || {} })).filter((x) => !x.st.earlier && x.st.status === "done");
  const rows = (st) => Math.max(0, (st.read || 0) - Object.values(st.skipped || {}).reduce((s, n) => s + n, 0));
  const withRows = ran.filter((x) => rows(x.st) > 0);
  const conflicts = (run.conflicts && run.conflicts.open) || 0;
  const settle = conflicts ? ` ${count(conflicts)} ${conflicts === 1 ? "field" : "fields"} to settle on the Import screen.` : "";
  if (!withRows.length) return { kind: "system", title: "Rotor export checked", body: `Nothing new was in ${exportName(run.as_of)} for the parts that just went live.${settle}`, link: `/import/${run.id}` };
  const labels = withRows.map((x) => x.label);
  const shown = withRows.slice(0, 4).map((x) => counted(rows(x.st), x.label));
  return {
    kind: "system", title: "More of your Rotor export is in",
    body: `${listOf(labels)} from ${exportName(run.as_of)} ${verb(labels)} in: ${shown.join(", ")}${withRows.length > 4 ? ", and more" : ""}.${settle}`,
    link: `/import/${run.id}`,
  };
}

// When a continuation is done: its staging was used now; the owners get a note.
onRunDone(async (run, state) => {
  if (!run.continues) return;
  await touchStaging(run.staging_run || stagingRunOf(state));
  const people = await approvers();
  if (people.length) await notify(people, finishNotice(run, state), SYSTEM);
});

// ------------------------------------------------------------ by itself (the hourly sweep)

// import.continue (bulk, hourly): starts one continuation when there is
// something to bring in. Cheap when there isn't: the index, the setting and
// at most the latest run's record.
export async function continueSweep(ctx = {}) {
  if (ctx.mode && ctx.mode.paused) return { result: "paused" };
  if (!(await autoContinue())) return { result: "off" };
  const ix = await readIndex("import-runs", "");
  const write = typeof ctx.write === "function" ? ctx.write() : SYSTEM;
  if (ix.rows.some((r) => ACTIVE.has(r.st))) return { result: (await healActive(ix.rows, write)) ? "requeued" : "busy" };
  if (ix.rows.some((r) => r.st === "uploading" && Date.parse(r.at) + UPLOAD_FRESH_MS > nowMs())) return { result: "upload_under_way" };
  const row = latestDone(ix.rows);
  if (!row) return { result: "no_run" };
  // a continuation of this run that someone cancelled is not started again by itself (the button still does)
  if (ix.rows.some((r) => r.cont === row.id && r.st === "cancelled")) return { result: "cancelled_before" };
  const got = await getRecord("import_run", row.id);
  const prev = got && got.data;
  if (!prev) return { result: "no_run" };
  if (Array.isArray(prev.waiting) && !prev.waiting.length) return { result: "complete" };
  if (prev.phases_sig && prev.phases_sig === phasesSignature()) return { result: "nothing_new" };
  let made;
  try {
    made = await createContinuation({ auto: true }, write);
  } catch (e) {
    if (e instanceof ConflictError) return { result: e.message === CLEARED_MESSAGE ? "cleared" : "nothing_ready" };
    throw e;
  }
  if (!made.existed) {
    const people = await approvers();
    if (people.length) await notify(people, startNotice(made.run, made.phases), SYSTEM).catch((e) => console.error(`crm:import: the owners were not told (${safeErr(e)})`));
  }
  return { progress: 1, result: `started:${made.run.id}` };
}
