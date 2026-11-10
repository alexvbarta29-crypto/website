// Core "system" module: health, runs, backups, export and the owner's
// switches (design §4.12, §3.12, §7.2 step 4).
//
//   GET  /admin/health                      audit:read   sys/health: lanes, cron, queue, verify, backups, alerts
//   GET  /runs/:id                          the person who started it, or an owner
//   GET  /admin/backups                     export:all   snapshot manifests, newest first
//   POST /admin/backups/:date/pulled        export:all   the off-site pull finished (build/crm_backup_pull.mjs)
//   GET  /admin/export?date=&partition=&part=   export:all, audited: one snapshot part (never a live listing);
//                                           without partition: that snapshot's manifest
//   POST /admin/export.csv?type=            export:all (run): one CSV of a record type from the latest snapshot
//   GET  /admin/export.csv/:id              export:all, audited: the CSV that run wrote
//   POST /admin/reindex {names?}            owner (run)
//   POST /admin/purge-shadow {confirm}      owner (run): "PURGE SHADOW" deletes shadow records the import never linked
//   POST /admin/pause · /admin/resume {confirm}   owner: "PAUSE" / "RESUME" (sys/mode.paused)
//   POST /hooks/cron                        x-crm-worker = sys/worker-secret: the cron's work when scheduled
//                                           functions are unavailable (D39)
//
// Owner-only routes use settings:owner, which is never grantable (§4.5).
// API keys may call the backup routes only with a "backup" key (scope
// export:all, owners only; core/apikeys.mjs), which is what the off-site
// pull script uses.

import { getRaw, putRaw, listKeys, hardDelete } from "../../../crm-store.mjs";
import { InputError, ForbiddenError, NotFoundError } from "../../core/errors.mjs";
import { nowIso } from "../../core/clock.mjs";
import { isId } from "../../core/ids.mjs";
import { allIndexes, allTypes, getType } from "../../core/registry.mjs";
import { createRun, defineRun, getRun, runView, readWorkerSecret, sameSecret, updateHealth, withoutAlert, WORKER_HEADER, kickWorker } from "../../core/lanes.mjs";
import { listManifests, readManifest, readPart, snapshotDates } from "../../core/backup.mjs";
import { setPaused } from "../../core/settings.mjs";
import { cronTick, healthReport } from "../../core/worker.mjs";
import { auditRead } from "../../core/audit.mjs";
import { csvCell } from "../../../referral-lib.mjs";

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

async function health() {
  const h = await healthReport();
  const dirty = (await listKeys("ix-dirty/")).length;
  return { data: { ...h, dirty_indexes: dirty } };
}

async function runStatus(ctx) {
  const run = await getRun(ctx.params.id);
  const mine = ctx.user && run.requested_by === ctx.user.id;
  if (!mine && !ctx.can("settings:owner")) throw new NotFoundError("That job isn't there.");
  return { data: runView(run) };
}

async function backups() {
  return { data: await listManifests() };
}

async function pulled(ctx) {
  const date = ctx.params.date;
  if (!DATE_RE.test(date) || !(await readManifest(date))) throw new NotFoundError("That backup isn't there.");
  const by = ctx.user ? ctx.user.id : "system";
  await updateHealth((h) => withoutAlert({ ...h, offsite_at: nowIso(), offsite: { date, at: nowIso(), by, via: ctx.apiKey ? "pull" : "app" } }, "offsite"));
  await auditRead(ctx, "backup", date, "offsite_pull");
  return { data: { ok: true } };
}

async function latestDate() {
  const dates = await snapshotDates();
  for (const d of dates) { const m = await readManifest(d); if (m && m.ok) return d; }
  return null;
}

async function exportPart(ctx) {
  const q = ctx.query;
  const date = q.get("date") || await latestDate();
  if (!date || !DATE_RE.test(date)) throw new NotFoundError("There is no finished backup yet.");
  const manifest = await readManifest(date);
  if (!manifest) throw new NotFoundError("That backup isn't there.");
  const partition = q.get("partition");
  if (!partition) return { data: manifest };
  const n = Number(q.get("part") || "1");
  const p = manifest.partitions.find((x) => x.name === partition);
  if (!p || !Number.isSafeInteger(n) || n < 1 || n > p.parts) throw new NotFoundError("That backup part isn't there.");
  const text = await readPart(date, partition, n, { type: "stream" });
  if (text === null) throw new NotFoundError("That backup part isn't there.");
  await auditRead(ctx, "backup", date, "export", { partition, part: n });
  return new Response(text, {
    status: 200,
    headers: { "Content-Type": "application/x-ndjson; charset=utf-8", "Content-Disposition": `attachment; filename="barta-crm-${date}-${partition}-${String(n).padStart(4, "0")}.jsonl"`, "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" },
  });
}

// ------------------------------------------------------------ CSV export (a run)

const DROP = new Set(["_w", "password", "invite"]);
const cell = (v) => csvCell(v === null || v === undefined ? "" : typeof v === "object" ? JSON.stringify(v) : v);
export const csvKey = (runId, type) => `exports/${runId}/${type}.csv`;

async function exportCsvStep(run) {
  const type = run.input && run.input.type;
  const date = run.input && run.input.date;
  if (!getType(type) || !DATE_RE.test(String(date))) return { failed: "bad_input" };
  const manifest = await readManifest(date);
  const p = manifest && manifest.partitions.find((x) => x.name === `rec-${type}`);
  const rows = [];
  for (let n = 1; p && n <= p.parts; n++) {
    const text = await readPart(date, p.name, n);
    for (const line of String(text || "").split("\n")) if (line.trim()) rows.push(JSON.parse(line).v || {});
  }
  const cols = [...new Set(rows.flatMap((r) => Object.keys(r)))].filter((c) => !DROP.has(c)).sort((a, b) => (a === "id" ? -1 : b === "id" ? 1 : a.localeCompare(b)));
  const lines = [cols.map(cell).join(","), ...rows.map((r) => cols.map((c) => cell(r[c])).join(","))];
  await putRaw(csvKey(run.id, type), lines.join("\r\n") + "\r\n", { metadata: { rows: rows.length } }, { kind: "backups" });
  return { done: true, progress: { done: rows.length, total: rows.length }, result: { type, date, rows: rows.length, download: `/api/crm/admin/export.csv/${run.id}` } };
}
defineRun("export.csv", { lane: "bulk", step: exportCsvStep, maintenance: true, label: "CSV export" });

async function startCsv(ctx) {
  const type = ctx.query.get("type") || (ctx.body && ctx.body.type);
  if (!getType(type) || type === "contact_stats") throw new InputError("Pick what to export.", "type");
  const date = await latestDate();
  if (!date) throw new NotFoundError("There is no finished backup to export from yet.");
  const run = await createRun("export.csv", { type, date }, ctx.write());
  await auditRead(ctx, "run", run.id, "export_csv", { type, date });
  return { status: 202, data: { run_id: run.id, run: runView(run) } };
}

async function downloadCsv(ctx) {
  const run = await getRun(ctx.params.id);
  if (run.kind !== "export.csv" || run.status !== "done") throw new NotFoundError("That export isn't ready.");
  const type = run.input.type;
  const got = await getRaw(csvKey(run.id, type), { kind: "backups", type: "stream" });
  if (!got) throw new NotFoundError("That export isn't there any more.");
  await auditRead(ctx, "run", run.id, "export_csv_download", { type });
  return new Response(got.data, {
    status: 200,
    headers: { "Content-Type": "text/csv; charset=utf-8", "Content-Disposition": `attachment; filename="barta-crm-${type}-${run.input.date}.csv"`, "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" },
  });
}

// ------------------------------------------------------------ owner switches

async function reindex(ctx) {
  const names = Array.isArray(ctx.body && ctx.body.names) ? ctx.body.names : [];
  const known = allIndexes();
  if (names.some((n) => !known.includes(n))) throw new InputError("Pick lists that exist.", "names");
  const run = await createRun("reindex", { names }, ctx.write());
  return { status: 202, data: { run_id: run.id, run: runView(run) } };
}

// Deletes every shadow record the import never linked (§3.9), type by type.
async function purgeShadowStep(run, { budget, write }) {
  const types = allTypes().filter((t) => t.shadow).map((t) => t.type).sort();
  const cp = run.checkpoint && Number.isInteger(run.checkpoint.i) ? { ...run.checkpoint } : { i: 0, after: null, deleted: 0 };
  const by = run.requested_by || "system";
  while (cp.i < types.length) {
    const type = types[cp.i];
    const keys = (await listKeys(`rec/${type}/`)).filter((k) => cp.after === null || k > cp.after);
    for (const k of keys) {
      if (budget && budget.left() < 10000) return { checkpoint: cp, progress: { done: cp.i, total: types.length } };
      const got = await getRaw(k);
      const r = got && got.data;
      if (r && r.shadow === true && !r.import) {
        await hardDelete(type, r.id, write({ by, origin: "api", actor_kind: "user" }));
        cp.deleted += 1;
      }
      cp.after = k;
    }
    cp.i += 1;
    cp.after = null;
  }
  return { done: true, checkpoint: cp, progress: { done: types.length, total: types.length }, result: { deleted: cp.deleted } };
}
defineRun("purge-shadow", { lane: "bulk", step: purgeShadowStep, label: "Purge shadow records" });

async function purgeShadow(ctx) {
  if (!ctx.body || ctx.body.confirm !== "PURGE SHADOW") throw new InputError("Type PURGE SHADOW to confirm.", "confirm");
  const run = await createRun("purge-shadow", {}, ctx.write());
  return { status: 202, data: { run_id: run.id, run: runView(run) } };
}

async function pause(ctx) {
  const mode = await setPaused(true, { by: ctx.user.id, confirm: ctx.body && ctx.body.confirm, reason: "owner" });
  return { data: { paused: !!mode.paused } };
}
async function resume(ctx) {
  const mode = await setPaused(false, { by: ctx.user.id, confirm: ctx.body && ctx.body.confirm });
  await kickWorker("fast", "resume");
  return { data: { paused: !!mode.paused } };
}

// D39: an outside scheduler calls this with the worker secret when
// scheduled functions are unavailable.
async function hookCron(ctx) {
  const secret = await readWorkerSecret({}, { fresh: true });
  if (!sameSecret(ctx.req.headers.get(WORKER_HEADER) || "", secret)) throw new ForbiddenError("Not allowed.");
  const r = await cronTick();
  return { data: { ok: true, kicked: r.kicked } };
}

const r = (method, path, auth, perm, handler, more = {}) => ({ method, path, auth, perm, subject: "none", mode: "inline", handler, ...more });
export const adminRoutes = [
  r("GET", "/admin/health", "session_or_key", "audit:read", health),
  r("GET", "/runs/:id", "session_or_key", "account:own", runStatus, { subject: "required" }),
  r("GET", "/admin/backups", "session_or_key", "export:all", backups),
  r("POST", "/admin/backups/:date/pulled", "session_or_key", "export:all", pulled, { idempotent: false }),
  r("GET", "/admin/export", "session_or_key", "export:all", exportPart),
  r("POST", "/admin/export.csv", "session", "export:all", startCsv, { mode: "run" }),
  r("GET", "/admin/export.csv/:id", "session", "export:all", downloadCsv),
  r("POST", "/admin/reindex", "session", "settings:owner", reindex, { mode: "run" }),
  r("POST", "/admin/purge-shadow", "session", "settings:owner", purgeShadow, { mode: "run" }),
  r("POST", "/admin/pause", "session", "settings:owner", pause),
  r("POST", "/admin/resume", "session", "settings:owner", resume),
  r("POST", "/hooks/cron", "hook", null, hookCron, { body: "none", idempotent: false }),
];
