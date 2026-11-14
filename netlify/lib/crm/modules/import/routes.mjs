// The import's API (design §10.10). Owners (import:run) see and steer runs;
// the upload routes also take the run's one-run upload key (auth "hook":
// the handler checks the key, or an owner's session with the CSRF checks,
// see runs.mjs uploadAuth). Nothing here ever fetches a URL: media arrive
// as uploaded bytes.
//
//   POST /import/runs                       import:run   { manifest?, note? } → { run, upload_key } (shown once)
//   GET  /import/runs                       import:run   the runs, newest first
//   GET  /import/runs/:id                   import:run   run, upload status, phases, team map, lane
//   POST /import/runs/:id/key               import:run   a fresh upload key (the old one stops working)
//   GET  /import/upload                     upload key   { run_id, status, manifest, received } (the upload script)
//   PUT  /import/runs/:id/manifest          key/owner    the pack's manifest.json
//   PUT  /import/runs/:id/chunks/:name      key/owner    one sealed chunk, ≤ 4.5 MB, X-Content-SHA256 → { entity, rows, invalid }
//   PUT  /import/runs/:id/media/:urlSha256  key/owner    raw bytes ≤ 4 MB, X-Media-Ref → { file_id }
//   POST /import/runs/:id/media-check       key/owner    { hashes } → { have } (media the site already holds)
//   POST /import/runs/:id/user-map          import:run   { map: { rotorUserId: crmUserId | null } }
//   POST /import/runs/:id/start             key/owner    → { run } (all chunks must be there)
//   POST /import/runs/:id/resume · /cancel  import:run   → { run }
//   GET  /import/rest                       import:run   the latest finished run: what can be brought in now, what still waits
//   POST /import/continue                   import:run   "bring in the rest now": a continuation of that run → { run, phases }
//   GET  /import/runs/:id/report · /report.csv · /idmap.csv   import:run (the id map download is audited)
//   GET  /import/runs/:id/conflicts         import:run   ?after=&status=
//   POST /import/conflicts/:key/resolve     import:run   { take: "rotor" | "crm" }
//
// The automatic daily import (autokey.mjs):
//   GET    /import/auto-key                 import:run   the key that works (never its value), earlier ones, the latest automatic imports
//   POST   /import/auto-key                 import:run   { name? } → { key (shown once), record }; the one before stops working
//   DELETE /import/auto-key/:id             import:run   revokes it
//   POST   /import/auto/runs                the automatic import key ONLY   { manifest, note? } → { run, upload_key } (201)
//
// The switch from Rotor (cutover.mjs, cutover-preview.mjs; cutover:run, owners):
//   GET  /cutover · POST /cutover/check     the checklist, the preview's state, history, rollback window
//   POST /cutover/ticks                     { key, done } an item only the owner can confirm
//   POST /cutover/preview                   { at? } → { run_id } (a bulk-lane run)
//   GET  /cutover/preview                   the latest preview: counts per automation and day, samples
//   POST /cutover/approve-preview
//   POST /cutover/run                       { confirm: "SWITCH TO CRM" } → { run_id, op_id } (op/cutover--{n})
//   POST /cutover/rollback                  { confirm: "SWITCH BACK TO ROTOR" } → { run_id, op_id } (first 48 hours)
//   GET  /cutover/in-flight · POST /cutover/in-flight/:kind   quotes | invoices | agreements → a bulk run
//   POST /cutover/manual-live               { on } rollback texting: a person's hand-typed texts go live (only while rolled back)

import { auditRead } from "../../core/audit.mjs";
import { InputError, ConflictError } from "../../core/errors.mjs";
import { fail } from "../../core/http.mjs";
import { readIndex } from "../../../crm-store.mjs";
import { safeErr } from "../../../referral-lib.mjs";
import { receiveChunk, receiveMedia, received, KeyMissing, SHA_RE, MAX_CHUNK_BYTES, MAX_MEDIA_BYTES } from "./staging.mjs";
import { readReport, reportCsv, idMapCsv } from "./report.mjs";
import {
  createImportRun, rekey, loadRun, runDetail, runView, uploadAuth, setManifest, startRun, resumeRun, cancelImport, setUserMap,
  listConflicts, resolveConflict, mediaHave, missingChunks,
} from "./runs.mjs";
import { restView, createContinuation } from "./continue.mjs";
import { autoKeyView, createAutoKey, revokeAutoKey, autoRun } from "./autokey.mjs";
import { cutoverView, setTick, setManualLive, startCutover, startRollback, inFlightView, makeInFlightRun } from "./cutover.mjs";
import { startPreview, readPreview, approvePreview } from "./cutover-preview.mjs";

const ok = (data, extra = {}) => ({ data, ...extra });
const notDone = () => new ConflictError("The report is ready when the import finishes.");

// ------------------------------------------------------------ owners

async function create(ctx) {
  const b = ctx.body || {};
  const out = await createImportRun({ manifest: b.manifest || null, note: b.note || null }, ctx.write());
  return ok(out, { status: 201 });
}

async function list(ctx) {
  const ix = await readIndex("import-runs", "");
  const rows = ix.rows.slice().sort((a, b) => (a.at < b.at ? 1 : a.at > b.at ? -1 : a.id < b.id ? 1 : -1)).slice(0, 50);
  return ok(rows.map((r) => ({ id: r.id, status: r.st, created_at: r.at, as_of: r.asof || null, started_at: r.s || null, finished_at: r.fin || null, summary: r.sum || null, continues: r.cont || null })));
}

async function detail(ctx) {
  return ok(await runDetail(await loadRun(ctx.params.id)));
}

async function newKey(ctx) {
  return ok(await rekey(await loadRun(ctx.params.id), ctx.write()));
}

async function userMap(ctx) {
  const b = ctx.body || {};
  return ok(await setUserMap(await loadRun(ctx.params.id), b.map, ctx.write()));
}

// What of the latest finished run's export can be brought in now, and what still waits.
async function rest() {
  return ok(await restView());
}

// "Bring in the rest now": a continuation of the latest finished run (no upload, no key).
async function continueNow(ctx) {
  const mode = await ctx.sysMode();
  if (mode.paused) throw new ConflictError("The CRM is paused. Resume it in Settings, Data first.");
  const made = await createContinuation({ auto: false }, ctx.write());
  return ok({ run: runView(made.run), phases: made.phases.map((p) => ({ phase: p.phase, label: p.label, rows: p.rows })) }, { status: made.existed ? 200 : 201 });
}

async function resume(ctx) { return ok(await resumeRun(await loadRun(ctx.params.id), ctx.write())); }
async function cancel(ctx) { return ok(await cancelImport(await loadRun(ctx.params.id), ctx.write())); }

async function report(ctx) {
  const ir = await loadRun(ctx.params.id);
  const r = await readReport(ir.id);
  if (!r) throw notDone();
  return ok(r);
}

const csvResponse = (text, name) => new Response(text, {
  status: 200,
  headers: { "Content-Type": "text/csv; charset=utf-8", "Content-Disposition": `attachment; filename="${name}"`, "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" },
});

async function reportCsvRoute(ctx) {
  const ir = await loadRun(ctx.params.id);
  const r = await readReport(ir.id);
  if (!r) throw notDone();
  return csvResponse(reportCsv(r), `barta-import-${ir.as_of || "run"}-report.csv`);
}

async function idmapCsvRoute(ctx) {
  const ir = await loadRun(ctx.params.id);
  if (ir.status !== "done") throw notDone();
  const out = await idMapCsv(ir.id);
  await auditRead(ctx, "import_run", ir.id, "idmap_download", { rows: out.rows });
  return csvResponse(out.csv, `barta-import-${ir.as_of || "run"}-idmap.csv`);
}

async function conflicts(ctx) {
  const ir = await loadRun(ctx.params.id);
  const after = ctx.query.get("after");
  const status = ctx.query.get("status");
  const page = await listConflicts(ir.id, { after: after && /^[a-z0-9_.-]{1,200}$/.test(after) ? after : null, status: ["open", "resolved"].includes(status) ? status : null });
  return ok(page.rows, { meta: { next_cursor: page.next, total: page.total } });
}

async function resolve(ctx) {
  const b = ctx.body || {};
  return ok(await resolveConflict(ctx.params.key, b.take, ctx.write()));
}

// ------------------------------------------------------------ upload (key or owner)

// Runs an upload handler after uploadAuth; errors keep their envelope.
const upload = (fn, opts) => async (ctx) => {
  const a = await uploadAuth(ctx, opts);
  if (a.res) return a.res;
  return fn(ctx, a);
};

async function whoami(ctx, a) {
  // once the run has left "uploading" its key only says so (nothing is taken any more)
  if (a.run.status !== "uploading") return ok({ run_id: a.run.id, status: a.run.status, as_of: a.run.as_of || null });
  const got = await received(a.run.id);
  const { missing } = a.run.manifest ? await missingChunks(a.run) : { missing: [] };
  return ok({ run_id: a.run.id, status: a.run.status, as_of: a.run.as_of || null, manifest: !!a.run.manifest, expires_at: a.run.upload.expires_at, received: got, missing });
}

async function putManifest(ctx, a) {
  return ok(await setManifest(a.run, ctx.body, a.write));
}

async function putChunk(ctx, a) {
  if (a.run.status !== "uploading") throw new ConflictError("This import has started; it takes no more uploads.");
  try {
    const out = await receiveChunk(a.run, ctx.params.name, ctx.raw, { sha256: ctx.req.headers.get("x-content-sha256") || null });
    return ok(out);
  } catch (e) {
    if (e instanceof KeyMissing) return fail("no_key", `${e.message} Set it in Netlify (Production only), redeploy, then upload again.`, 503);
    throw e;
  }
}

async function putMedia(ctx, a) {
  if (a.run.status !== "uploading") throw new ConflictError("This import has started; it takes no more uploads.");
  const out = await receiveMedia(a.run, ctx.params.sha, ctx.raw, { ref: ctx.req.headers.get("x-media-ref"), ctx: a.write });
  return ok(out);
}

async function mediaCheck(ctx, a) {
  if (a.run.status !== "uploading") throw new ConflictError("This import has started; it takes no more uploads.");
  const hashes = Array.isArray(ctx.body && ctx.body.hashes) ? ctx.body.hashes.filter((h) => SHA_RE.test(String(h))).slice(0, 1000) : null;
  if (!hashes) throw new InputError("Send the media checksums.", "hashes");
  return ok({ have: await mediaHave(hashes), run_id: a.run.id });
}

async function start(ctx, a) {
  const ir = a.run;
  try {
    return ok(await startRun(ir, a.write));
  } catch (e) {
    if (!(e instanceof ConflictError)) console.error("crm:import: a run did not start (" + safeErr(e) + ")");
    throw e;
  }
}

// ------------------------------------------------------------ the automatic daily import

async function autoKeyGet() { return ok(await autoKeyView()); }
async function autoKeyMake(ctx) {
  const b = ctx.body || {};
  return ok(await createAutoKey({ name: b.name }, ctx.write()), { status: 201 });
}
async function autoKeyRevoke(ctx) { return ok(await revokeAutoKey(ctx.params.id, ctx.write())); }

// ------------------------------------------------------------ the switch from Rotor

const cutView = async (ctx) => ok(await cutoverView(ctx));
async function tick(ctx) {
  const b = ctx.body || {};
  await setTick(b.key, b.done, ctx.write());
  return ok(await cutoverView(ctx));
}
async function manualLiveRoute(ctx) {
  await setManualLive(ctx.body && ctx.body.on, ctx.write());
  return ok(await cutoverView(ctx));
}
async function preview(ctx) {
  const mode = await ctx.sysMode();
  if (mode.system_of_record === "crm") throw new ConflictError("The CRM is in charge already: the preview is for before the switch.");
  return ok(await startPreview({ at: ctx.body && ctx.body.at }, ctx.write()), { status: 202 });
}
async function previewGet() {
  const p = await readPreview();
  return ok(p);
}
async function approve(ctx) {
  await approvePreview(ctx.write());
  return ok(await cutoverView(ctx));
}
async function runSwitch(ctx) { return ok(await startCutover({ confirm: ctx.body && ctx.body.confirm }, { ...ctx.write(), deploy: ctx.deploy }), { status: 202 }); }
async function runRollback(ctx) { return ok(await startRollback({ confirm: ctx.body && ctx.body.confirm }, ctx.write()), { status: 202 }); }
async function inFlight() { return ok(await inFlightView()); }
async function inFlightMake(ctx) {
  const out = await makeInFlightRun(ctx.params.kind, ctx.write());
  return ok(out, { status: out.existed ? 200 : 201 });
}

// ------------------------------------------------------------ the table

const own = (method, path, handler, more = {}) => ({ method, path, auth: "session", perm: "import:run", subject: "none", mode: "inline", handler, ...more });
const cut = (method, path, handler, more = {}) => ({ method, path, auth: "session", perm: "cutover:run", subject: "none", mode: "inline", handler, ...more });
const hook = (method, path, handler, more = {}) => ({ method, path, auth: "hook", perm: null, subject: "required", mode: "inline", idempotent: false, handler, ...more });

export const importRoutes = [
  own("POST", "/import/runs", create, { secret: true, idempotent: false, maxCalls: 40 }),
  own("GET", "/import/runs", list),
  own("GET", "/import/rest", rest, { maxCalls: 40 }),
  own("POST", "/import/continue", continueNow, { mode: "run", idempotent: false, maxCalls: 60 }),
  own("GET", "/import/runs/:id", detail, { maxCalls: 40 }),
  own("POST", "/import/runs/:id/key", newKey, { secret: true, idempotent: false, subject: "required", maxCalls: 40 }),
  own("POST", "/import/runs/:id/user-map", userMap, { subject: "required", maxCalls: 40 }),
  own("POST", "/import/runs/:id/resume", resume, { subject: "required", mode: "run", maxCalls: 50 }),
  own("POST", "/import/runs/:id/cancel", cancel, { subject: "required", maxCalls: 40 }),
  own("GET", "/import/runs/:id/report", report, { subject: "required" }),
  own("GET", "/import/runs/:id/report.csv", reportCsvRoute, { subject: "required" }),
  own("GET", "/import/runs/:id/idmap.csv", idmapCsvRoute, { subject: "required", maxCalls: 40 }),
  own("GET", "/import/runs/:id/conflicts", conflicts, { subject: "required", maxCalls: 60 }),
  own("POST", "/import/conflicts/:key/resolve", resolve, { subject: "required", maxCalls: 40 }),
  own("GET", "/import/auto-key", autoKeyGet),
  own("POST", "/import/auto-key", autoKeyMake, { secret: true, idempotent: false, maxCalls: 40 }),
  own("DELETE", "/import/auto-key/:id", autoKeyRevoke, { subject: "required", maxCalls: 40 }),
  // the automatic import key, and only it (autokey.mjs checks it): makes a run and answers its one-run upload key
  hook("POST", "/import/auto/runs", autoRun, { subject: "none", secret: true, maxCalls: 50 }),
  cut("GET", "/cutover", cutView, { maxCalls: 30 }),
  cut("POST", "/cutover/check", cutView, { maxCalls: 30 }),
  cut("POST", "/cutover/ticks", tick, { maxCalls: 40 }),
  cut("POST", "/cutover/manual-live", manualLiveRoute, { maxCalls: 45 }),
  cut("POST", "/cutover/preview", preview, { mode: "run", idempotent: false, maxCalls: 40 }),
  cut("GET", "/cutover/preview", previewGet),
  cut("POST", "/cutover/approve-preview", approve, { maxCalls: 40 }),
  cut("POST", "/cutover/run", runSwitch, { mode: "run", idempotent: false, maxCalls: 60 }),
  cut("POST", "/cutover/rollback", runRollback, { mode: "run", idempotent: false, maxCalls: 40 }),
  cut("GET", "/cutover/in-flight", inFlight),
  cut("POST", "/cutover/in-flight/:kind", inFlightMake, { subject: "required", idempotent: false, maxCalls: 50 }),
  hook("GET", "/import/upload", upload(whoami, { session: false }), { body: "none" }),
  hook("PUT", "/import/runs/:id/manifest", upload(putManifest), { maxCalls: 40 }),
  hook("PUT", "/import/runs/:id/chunks/:name", upload(putChunk), { body: "raw", maxBody: MAX_CHUNK_BYTES, budgetMs: 9000 }),
  hook("PUT", "/import/runs/:id/media/:sha", upload(putMedia), { body: "raw", maxBody: MAX_MEDIA_BYTES, budgetMs: 9000 }),
  hook("POST", "/import/runs/:id/media-check", upload(mediaCheck), { maxCalls: 40 }),
  hook("POST", "/import/runs/:id/start", upload(start), { mode: "run", maxCalls: 50 }),
];

