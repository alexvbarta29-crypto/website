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
// them (index.mjs import.staging_gc reads it). The clean-up stamps
// `staging_cleared_at` on that run BEFORE it deletes, and a continuation
// stamps its use before it is made, both on the same record: whichever
// comes second sees the other and gives way.
//
// What it never goes on from (the base is checked by both the hourly check
// and the button):
//   - an OLDER export: when any import that isn't of the same upload was
//     started after it (finished, cancelled or stopped: it may have brought
//     newer values in), or names a later export date, the rest of the older
//     export is not brought in ("superseded"): a new import does it;
//   - a continuation that code from before this feature stepped (a
//     rollback): it shows "done" with nothing imported and has no
//     `phases_sig`; it is retired (cancelled, "old_version") and the run it
//     continued is the base again.
//
// A run that stops for good (the lane gave up after 8 tries, or its rows
// were cleared under it) is marked failed by the runner; here the owners
// are told, Settings → Data shows an alert, and the hourly check also
// catches a run whose lane run ended without that (reconcile).

import { getRecord, createRecord, updateRecord, readIndex, listKeys, getSetting } from "../../../crm-store.mjs";
import { deriveId } from "../../core/ids.mjs";
import { nowIso, nowMs } from "../../core/clock.mjs";
import { ConflictError, InputError, ExistsError } from "../../core/errors.mjs";
import { notify, approvers } from "../../core/notify.mjs";
import { getRun, updateHealth, withAlert, withoutAlert } from "../../core/lanes.mjs";
import { safeErr } from "../../../referral-lib.mjs";
import { phasePlan, phasesSignature, loadState, restOf, stagingRunOf, startLaneRun, onRunDone, onRunStopped, stopped } from "./runner.mjs";
import { rawPrefix, rawKey } from "./staging.mjs";
import { phaseLabel, MODULE_LABELS } from "./catalog.mjs";

export const STAGING_KEEP_DAYS = 30;
export const CLEARED_MESSAGE = "That export's rows were cleared. Start a new import.";
export const NOTHING_MESSAGE = "Nothing new to bring in yet. The rest of the export waits for parts of the CRM that aren't built.";
export const SUPERSEDED_MESSAGE = "A newer import was started after that export's and isn't what this would go on from. Start a new import to bring in the rest.";
const DAY = 86400000;
const ACTIVE = new Set(["queued", "running"]);
// an uploading run with no key time in its index row (written before the row carried it): a day from when it was made
const UPLOAD_FRESH_MS = 24 * 3600 * 1000;
// a queued run with no lane run is given this long before the check queues one (a start in progress has both within seconds)
const HEAL_AFTER_MS = 10 * 60 * 1000;

// ------------------------------------------------------------ the setting

export const IMPORT_SETTING_DEFAULTS = Object.freeze({ auto_continue: true });
export function validateImportSetting(v) {
  const d = v && typeof v === "object" && !Array.isArray(v) ? v : {};
  if (d.auto_continue !== undefined && typeof d.auto_continue !== "boolean") throw new InputError("Yes or no.", "auto_continue");
  return { auto_continue: d.auto_continue !== false };
}
// The setting as saved. A read that fails THROWS: "on" is never assumed (the hourly check then starts nothing this hour).
export const autoContinue = async () => (await getSetting("import")).auto_continue !== false;
// For the screen only: a failed read shows the default.
const autoContinueShown = async () => autoContinue().catch(() => IMPORT_SETTING_DEFAULTS.auto_continue);

// ------------------------------------------------------------ what could run

// The newest finished run in the index: by when it finished, and never a
// run that a finished continuation already goes on from (that one is newer,
// whatever the clocks say).
export function latestDone(rows) {
  const done = rows.filter((r) => r.st === "done" && r.fin);
  const continued = new Set(done.map((r) => r.cont).filter(Boolean));
  return done.filter((r) => !continued.has(r.id)).sort((a, b) => (a.fin < b.fin ? 1 : a.fin > b.fin ? -1 : a.at < b.at ? 1 : a.at > b.at ? -1 : a.id < b.id ? 1 : -1))[0] || null;
}

// The run that makes `base` an OLDER export, if any: an import that isn't
// of the same upload (not the upload run, not one of its continuations) and
// was started after that upload's import, whatever became of it (it may
// have brought newer values in before it was cancelled or stopped), or one
// that names a later export date. Pure, over the index rows.
export function supersededBy(rows, base) {
  if (!base) return null;
  const rootId = base.src || base.id;
  const root = rows.find((r) => r.id === rootId) || base;
  const rootStart = root.s || root.at || "";
  for (const r of rows) {
    if (r.id === rootId || r.src === rootId || r.id === base.id || !r.s) continue;      // the same upload; an upload nobody started
    if (r.s > rootStart) return r;
    if (r.asof && base.asof && r.asof > base.asof) return r;
  }
  return null;
}

// Whether a new export is being uploaded: an uploading run whose newest key still works.
export function uploadUnderWay(rows, t = nowMs()) {
  return rows.some((r) => r.st === "uploading" && (r.kx ? Date.parse(r.kx) > t : Date.parse(r.at) + UPLOAD_FRESH_MS > t));
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

const SYSTEM = { by: "import", origin: "import", actor_kind: "import", requestId: "import.continue" };

// A continuation that shows "done" but was stepped by code from before
// continuations existed (no phases_sig; its state names no staging run):
// nothing was imported. It is retired, so the run it continued is the base again.
async function retire(rec) {
  await updateRecord("import_run", rec.id, (r) => (r.status !== "done" ? null : { ...r, status: "cancelled", cancel_reason: "old_version" }), SYSTEM);
}

// The run a continuation would go on from: the latest finished run that is
// a real base. → { row, rec } | null. Reads one record in the usual case.
// repair: false only skips a run older code stepped (the screen never writes).
async function loadBase(rows, { repair = true } = {}) {
  const skip = new Set();
  for (let i = 0; i < 6; i++) {
    const row = latestDone(rows.filter((r) => !skip.has(r.id)));
    if (!row) return null;
    const got = await getRecord("import_run", row.id);
    const rec = got && got.data;
    if (rec && rec.status === "done" && !(rec.continues && !rec.phases_sig)) return { row: { ...row, cont: rec.continues || row.cont, src: rec.staging_run || row.src }, rec };
    if (rec && rec.status === "done" && repair) await retire(rec);
    skip.add(row.id);
  }
  return null;
}

// For the Import screen: the latest finished run, what of its export can
// be brought in now and what still waits (and for which part), whether its
// rows are still there, whether a newer import stands in the way, and
// whether the CRM brings the rest in by itself.
export async function restView() {
  const [ix, auto] = await Promise.all([readIndex("import-runs", ""), autoContinueShown()]);
  const active = ix.rows.find((r) => ACTIVE.has(r.st)) || null;
  const base = await loadBase(ix.rows, { repair: false });
  const out = { run: null, ready: [], waiting: [], staging: null, keep_until: null, active: active ? active.id : null, auto, blocked: null };
  if (!base) return out;
  const row = base.row;
  out.run = { id: row.id, as_of: row.asof || null, finished_at: row.fin, continues: row.cont || null };
  const state = await loadState(row.id);
  if (!state) return out;
  const open = openPhases(state);
  out.ready = open.ready;
  out.waiting = open.waiting;
  if (!open.ready.length && !open.waiting.length) return out;
  if (supersededBy(ix.rows, row)) out.blocked = "newer";
  const rootId = stagingRunOf(state);
  const root = ix.rows.find((r) => r.id === rootId);
  out.staging = root && root.clr ? "cleared" : (await stagingHolds(rootId, state, [...open.ready, ...open.waiting])) ? "ok" : "cleared";
  const last = root ? Math.max(Date.parse(root.fin || root.at) || 0, Date.parse(root.use || "") || 0) : 0;
  if (out.staging === "ok" && last) out.keep_until = new Date(last + STAGING_KEEP_DAYS * DAY).toISOString();
  return out;
}

// ------------------------------------------------------------ runs that are stuck

const alertKey = (id) => `import:${id}`;
export const clearStoppedAlert = (id) => updateHealth((h) => ((h.alerts || []).some((a) => a.key === alertKey(id)) ? withoutAlert(h, alertKey(id)) : null)).catch(() => null);

// Queued or running import runs whose lane run isn't: one whose lane run
// never got queued (the function died in between) is queued now; one whose
// lane run ended failed or cancelled without the run being told is marked
// stopped (the owners get the note). → { requeued, stopped } (counts)
export async function reconcile(rows, ctx = SYSTEM) {
  const out = { requeued: 0, stopped: 0 };
  for (const r of rows.filter((x) => ACTIVE.has(x.st))) {
    const got = await getRecord("import_run", r.id);
    const run = got && got.data;
    if (!run || !ACTIVE.has(run.status)) continue;
    if (!run.lane_run_id) {
      if (Date.parse(run.queued_at || run.created_at) + HEAL_AFTER_MS > nowMs()) continue;
      const lane = await startLaneRun(run, ctx, run.attempt || 0);
      await updateRecord("import_run", run.id, (x) => (x.lane_run_id ? null : { ...x, lane_run_id: lane.id }), ctx);
      out.requeued += 1;
      continue;
    }
    const lane = await getRun(run.lane_run_id).catch(() => null);
    if (lane && (lane.status === "failed" || lane.status === "cancelled")) {
      await stopped(run, (lane.error && lane.error.code) || lane.status, ctx.requestId || "import");
      out.stopped += 1;
    }
  }
  return out;
}

// ------------------------------------------------------------ making one

// Stamps the run that holds the staged rows as used now (they are kept 30
// days from here). Refuses when the clean-up has already taken them: the
// same record carries both stamps, so one of the two always sees the other.
async function claimStaging(rootId) {
  await updateRecord("import_run", rootId, (r) => {
    if (r.staging_cleared_at) throw new ConflictError(CLEARED_MESSAGE);
    return { ...r, staging_used_at: nowIso() };
  }, SYSTEM);
}

// Starts a continuation of the latest finished run. → { run (the record), phases: [{ phase, label, rows }], existed }
// Throws ConflictError with a plain message when there is nothing to go on from.
// opts.rows: the runs index the caller already read.
export async function createContinuation({ auto = false, note = null, rows = null } = {}, ctx = SYSTEM) {
  const all = rows || (await readIndex("import-runs", "")).rows;
  if (all.some((r) => ACTIVE.has(r.st))) throw new ConflictError("An import is already running. Wait for it to finish first.");
  const base = await loadBase(all);
  if (!base) throw new ConflictError("No import has finished yet. Start one first.");
  if (supersededBy(all, base.row)) throw new ConflictError(SUPERSEDED_MESSAGE);
  const prev = base.rec;
  const state = await loadState(prev.id);
  if (!state || (prev.continues && !state.staging_run)) throw new ConflictError(CLEARED_MESSAGE);
  const { ready } = openPhases(state);
  if (!ready.length) throw new ConflictError(NOTHING_MESSAGE);
  const rootId = stagingRunOf(state);
  const root = all.find((r) => r.id === rootId);
  if ((root && root.clr) || !(await stagingHolds(rootId, state, ready))) throw new ConflictError(CLEARED_MESSAGE);
  await claimStaging(rootId);
  // one continuation per finished run at a time: the same id for everyone who asks now
  // (the next number when that id belongs to one that was cancelled or stopped)
  let rec = null, existed = false;
  for (let n = all.filter((r) => r.cont === prev.id).length, tries = 0; !rec && tries < 8; n++, tries++) {
    const id = deriveId("import_run", prev.id, "import.continue", n);
    try {
      rec = (await createRecord("import_run", {
        id, status: "queued", queued_at: nowIso(), ...(prev.as_of ? { as_of: prev.as_of } : {}), continues: prev.id, staging_run: rootId, ...(auto ? { auto: true } : {}),
        ...(note ? { note: String(note).slice(0, 200) } : {}), user_map: {}, conflicts: { open: 0, resolved: 0 }, requested_by: (ctx && ctx.by) || "system", attempt: 0,
      }, ctx)).data;
    } catch (e) {
      if (!(e instanceof ExistsError)) throw e;
      const cur = await getRecord("import_run", id);
      if (!cur) throw e;
      if (ACTIVE.has(cur.data.status)) { rec = cur.data; existed = true; }      // someone else made it a moment ago
    }
  }
  if (!rec) throw new ConflictError("An import is already running. Wait for it to finish first.");
  if (!rec.lane_run_id) {
    const lane = await startLaneRun(rec, ctx, rec.attempt || 0);
    rec = (await updateRecord("import_run", rec.id, (x) => (x.lane_run_id ? null : { ...x, lane_run_id: lane.id }), ctx)).data;
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
  const parts = shown.map((l, i) => (i ? inSentence(l) : l.charAt(0).toUpperCase() + l.slice(1)));
  if (labels.length > max) parts.push(`${labels.length - shown.length} more parts`);
  return parts.length <= 1 ? parts.join("") : `${parts.slice(0, -1).join(", ")} and ${parts[parts.length - 1]}`;
}
const count = (n) => Number(n || 0).toLocaleString("en-US");
// "are" for several parts or a plural one ("Messages are in"), "is" for a singular one ("Payroll is in")
const verb = (labels) => (labels.length > 1 || /s$/.test(labels[0] || "") ? "are" : "is");

// What the owners read when a continuation starts by itself. phases: [{ label }]
export function startNotice(run, phases) {
  const labels = phases.map((p) => p.label);
  return {
    kind: "system", title: "Bringing in more of your Rotor export",
    body: `${listOf(labels)} from ${exportName(run.as_of)} ${verb(labels)} being brought in now. Nothing to do: you get a note when it's done.`,
    link: `/import/${run.id}`,
  };
}

// A record type in words: "timesheet" → "timesheets", "property" → "properties", "map_pin_type" → "map pin types".
const pluralOf = (w) => (/(s|x|ch|sh)$/.test(w) ? `${w}es` : /[^aeiou]y$/.test(w) ? `${w.slice(0, -1)}ies` : `${w}s`);
const made = (n, type) => `${count(n)} ${n === 1 ? String(type).replace(/_/g, " ") : pluralOf(String(type).replace(/_/g, " "))}`;

// What they read when it is done, in records made: "Invoices and payments
// from your Rotor export of Nov 10 are in: 712 invoices, 688 payments."
// Rows that made nothing (skipped, or mapped to nothing but a warning:
// runner.mjs `none`) are mentioned only when there are some.
export function finishNotice(run, state) {
  const ran = (state.plan || []).map((p) => ({ label: phaseLabel(p.name), st: state.phases[p.name] || {} })).filter((x) => !x.st.earlier && x.st.status === "done" && (x.st.read || 0) > 0);
  const conflicts = (run.conflicts && run.conflicts.open) || 0;
  const settle = conflicts ? ` ${count(conflicts)} ${conflicts === 1 ? "field" : "fields"} to settle on the Import screen.` : "";
  const link = `/import/${run.id}`;
  if (!ran.length) return { kind: "system", title: "Rotor export checked", body: `Nothing new was in ${exportName(run.as_of)} for the parts that just went live.${settle}`, link };
  const byType = new Map();
  let updated = 0, none = 0;
  for (const x of ran) {
    none += x.st.none || 0;
    for (const [type, c] of Object.entries(x.st.records || {})) {
      if (c.created) byType.set(type, (byType.get(type) || 0) + c.created);
      updated += (c.updated || 0) + (c.linked || 0);
    }
  }
  const labels = ran.map((x) => x.label);
  const nothing = none ? ` ${count(none)} ${none === 1 ? "row" : "rows"} made nothing (the report says why).` : "";
  if (!byType.size) {
    return { kind: "system", title: "Rotor export checked", body: `${listOf(labels)} from ${exportName(run.as_of)} ${verb(labels)} checked: nothing new${updated ? `, ${count(updated)} updated` : ""}.${nothing}${settle}`, link };
  }
  const types = [...byType.entries()];
  return {
    kind: "system", title: "More of your Rotor export is in",
    body: `${listOf(labels)} from ${exportName(run.as_of)} ${verb(labels)} in: ${types.slice(0, 4).map(([type, n]) => made(n, type)).join(", ")}${types.length > 4 ? ", and more" : ""}.${nothing}${settle}`,
    link,
  };
}

// When a continuation is done: its staging was used now; the owners get a note.
onRunDone(async (run, state) => {
  await clearStoppedAlert(run.id);
  if (!run.continues) return;
  await updateRecord("import_run", run.staging_run || stagingRunOf(state), (r) => (r.staging_cleared_at ? null : { ...r, staging_used_at: nowIso() }), SYSTEM)
    .catch((e) => console.error(`crm:import: the staging's last use was not saved (${safeErr(e)})`));
  const people = await approvers();
  if (people.length) await notify(people, finishNotice(run, state), SYSTEM);
});

// When a run stops for good: an alert on Settings → Data, a note to the
// owners, and (a continuation) the run it continued isn't continued again
// by itself.
export function stoppedNotice(run) {
  const gone = run.stopped && run.stopped.code === "staging_gone";
  const what = run.continues ? `Bringing in more of ${exportName(run.as_of)}` : `The import of ${exportName(run.as_of)}`;
  return {
    kind: "system", title: "Rotor import stopped",
    body: gone ? `${what} stopped: that export's rows were cleared. Start a new import to bring in the rest.` : `${what} stopped before it finished (storage kept failing). Open it and tap Resume: nothing done is done again.`,
    link: `/import/${run.id}`,
  };
}
onRunStopped(async (run) => {
  if (run.continues) await updateRecord("import_run", run.continues, (r) => (r.auto_off_at ? null : { ...r, auto_off_at: nowIso() }), SYSTEM).catch(() => null);
  await updateHealth((h) => withAlert(h, alertKey(run.id), "An import from Rotor stopped before it finished. Open Import from Rotor to resume it or start a new one.", "warn")).catch(() => null);
  const people = await approvers();
  if (people.length) await notify(people, stoppedNotice(run), SYSTEM);
});

// ------------------------------------------------------------ by itself (the hourly sweep)

// import.continue (bulk, hourly): starts one continuation when there is
// something to bring in. Cheap when there isn't: the runs index, the
// setting and the latest finished run's record (which remembers the
// registered phases it was last checked against).
export async function continueSweep(ctx = {}) {
  if (ctx.mode && ctx.mode.paused) return { result: "paused" };
  const ix = await readIndex("import-runs", "");
  const write = typeof ctx.write === "function" ? ctx.write() : SYSTEM;
  if (ix.rows.some((r) => ACTIVE.has(r.st))) {
    const fixed = await reconcile(ix.rows, write);
    return { result: fixed.stopped ? "stopped" : fixed.requeued ? "requeued" : "busy" };
  }
  let on;
  try { on = await autoContinue(); } catch (e) {
    // the setting couldn't be read: an owner may have turned this off, so nothing is started this hour
    console.error(`crm:import: the import setting was not read (${safeErr(e)}); nothing is started by itself this hour`);
    return { result: "setting_unreadable" };
  }
  if (!on) return { result: "off" };
  if (uploadUnderWay(ix.rows)) return { result: "upload_under_way" };
  const base = await loadBase(ix.rows);
  if (!base) return { result: "no_run" };
  if (supersededBy(ix.rows, base.row)) return { result: "superseded" };
  const prev = base.rec;
  // a continuation of this run that someone cancelled, or that stopped, is not started again by itself (the button still does)
  if (prev.auto_off_at) return { result: "cancelled_before" };
  // (a run that left nothing waiting is looked at too when the registered phases changed: a phase added
  // since, for rows it staged, can run now)
  const sig = phasesSignature();
  if (prev.phases_sig === sig || prev.checked_sig === sig) return { result: "nothing_new" };
  let made;
  try {
    made = await createContinuation({ auto: true, rows: ix.rows }, write);
  } catch (e) {
    if (!(e instanceof ConflictError)) throw e;
    const result = e.message === CLEARED_MESSAGE ? "cleared" : e.message === SUPERSEDED_MESSAGE ? "superseded" : "nothing_ready";
    // nothing can come in with the phases registered today: remembered on the record, so the next hours don't read its state again
    if (result !== "superseded") await updateRecord("import_run", prev.id, (r) => (r.checked_sig === sig ? null : { ...r, checked_sig: sig }), SYSTEM).catch(() => null);
    return { result };
  }
  if (made.existed) return { result: `already:${made.run.id}` };
  const people = await approvers();
  if (people.length) await notify(people, startNotice(made.run, made.phases), SYSTEM).catch((e) => console.error(`crm:import: the owners were not told (${safeErr(e)})`));
  return { progress: 1, result: `started:${made.run.id}` };
}
