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
//   GET  /import/runs/:id/report · /report.csv · /idmap.csv   import:run (the id map download is audited)
//   GET  /import/runs/:id/conflicts         import:run   ?after=&status=
//   POST /import/conflicts/:key/resolve     import:run   { take: "rotor" | "crm" }

import { auditRead } from "../../core/audit.mjs";
import { InputError, ConflictError } from "../../core/errors.mjs";
import { fail } from "../../core/http.mjs";
import { readIndex } from "../../../crm-store.mjs";
import { safeErr } from "../../../referral-lib.mjs";
import { receiveChunk, receiveMedia, received, KeyMissing, SHA_RE, MAX_CHUNK_BYTES, MAX_MEDIA_BYTES } from "./staging.mjs";
import { readReport, reportCsv, idMapCsv } from "./report.mjs";
import {
  createImportRun, rekey, loadRun, runDetail, uploadAuth, setManifest, startRun, resumeRun, cancelImport, setUserMap,
  listConflicts, resolveConflict, mediaHave, missingChunks,
} from "./runs.mjs";

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
  return ok(rows.map((r) => ({ id: r.id, status: r.st, created_at: r.at, as_of: r.asof || null, started_at: r.s || null, finished_at: r.fin || null, summary: r.sum || null })));
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
  if (!["uploading", "queued", "running", "done"].includes(a.run.status)) throw new ConflictError("This import was cancelled.");
  const out = await receiveMedia(a.run, ctx.params.sha, ctx.raw, { ref: ctx.req.headers.get("x-media-ref"), ctx: a.write });
  return ok(out);
}

async function mediaCheck(ctx, a) {
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

// ------------------------------------------------------------ the table

const own = (method, path, handler, more = {}) => ({ method, path, auth: "session", perm: "import:run", subject: "none", mode: "inline", handler, ...more });
const hook = (method, path, handler, more = {}) => ({ method, path, auth: "hook", perm: null, subject: "required", mode: "inline", idempotent: false, handler, ...more });

export const importRoutes = [
  own("POST", "/import/runs", create, { secret: true, idempotent: false, maxCalls: 40 }),
  own("GET", "/import/runs", list),
  own("GET", "/import/runs/:id", detail, { maxCalls: 40 }),
  own("POST", "/import/runs/:id/key", newKey, { secret: true, idempotent: false, subject: "required", maxCalls: 40 }),
  own("POST", "/import/runs/:id/user-map", userMap, { subject: "required", maxCalls: 40 }),
  own("POST", "/import/runs/:id/resume", resume, { subject: "required", mode: "run", maxCalls: 50 }),
  own("POST", "/import/runs/:id/cancel", cancel, { subject: "required", maxCalls: 40 }),
  own("GET", "/import/runs/:id/report", report, { subject: "required" }),
  own("GET", "/import/runs/:id/report.csv", reportCsvRoute, { subject: "required" }),
  own("GET", "/import/runs/:id/idmap.csv", idmapCsvRoute, { subject: "required", maxCalls: 40 }),
  own("GET", "/import/runs/:id/conflicts", conflicts, { subject: "required", maxCalls: 40 }),
  own("POST", "/import/conflicts/:key/resolve", resolve, { subject: "required", maxCalls: 40 }),
  hook("GET", "/import/upload", upload(whoami, { session: false }), { body: "none" }),
  hook("PUT", "/import/runs/:id/manifest", upload(putManifest), { maxCalls: 40 }),
  hook("PUT", "/import/runs/:id/chunks/:name", upload(putChunk), { body: "raw", maxBody: MAX_CHUNK_BYTES, budgetMs: 9000 }),
  hook("PUT", "/import/runs/:id/media/:sha", upload(putMedia), { body: "raw", maxBody: MAX_MEDIA_BYTES, budgetMs: 9000 }),
  hook("POST", "/import/runs/:id/media-check", upload(mediaCheck), { maxCalls: 40 }),
  hook("POST", "/import/runs/:id/start", upload(start), { mode: "run", maxCalls: 50 }),
];

