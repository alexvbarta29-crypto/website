// Import runs: create, upload keys, manifest, start / resume / cancel, the
// owner's user map, conflicts (design §10.10, §4.9 "Upload keys").
//
// Upload keys. Creating a run (owners: import:run) answers a key bound to
// that one run, shown once: "bimp_" + 32 base62 characters, valid 24 hours.
// The site keeps only its SHA-256: on the run (`upload.key_hash`) and as the
// pointer ptr/import-key/{sha256} → { id: runId, expires_at }, so the upload
// script needs nothing but the key. A key works only for its own run, only
// for uploading (manifest, chunks, media) and starting it, and never on
// any other CRM route (it is not an API key: the dispatcher's key check
// doesn't know it). Its routes say auth "hook" and check it here; an
// owner's session works on the same routes (the Import screen uploads a
// small run from a phone) with the usual CSRF checks.

import { createHash, randomInt, timingSafeEqual } from "node:crypto";
import {
  getRecord, getRecords, createRecord, updateRecord, readPointer, claimPointer, readIndex, getRaw, putRaw, listKeys,
} from "../../../crm-store.mjs";
import { newId, isId, idForRotor } from "../../core/ids.mjs";
import { nowIso, nowMs } from "../../core/clock.mjs";
import { InputError, ConflictError, NotFoundError } from "../../core/errors.mjs";
import { getType } from "../../core/registry.mjs";
import { cancelRun as cancelLaneRun, getRun } from "../../core/lanes.mjs";
import { authenticate, loadPermissions } from "../../core/auth.mjs";
import { can } from "../../core/perms.mjs";
import { fail } from "../../core/http.mjs";
import { checkManifest, manifestChunkNames, received, stagedChunks, readChunk } from "./staging.mjs";
import { startLaneRun, loadState, phaseView, queueReindex } from "./runner.mjs";
import { conflictsPrefix } from "./report.mjs";
import { conflictKey, ibKey, setPath } from "./ownership.mjs";
import { normalizeMember, proposeMap, userRows, memberPointers, NEW_USER } from "./users.mjs";
import { restView, clearStoppedAlert, CLEARED_MESSAGE } from "./continue.mjs";

export const UPLOAD_KEY_RE = /^bimp_[0-9A-Za-z]{32}$/;
export const KEY_TTL_MS = 24 * 3600 * 1000;
const B62 = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz";
export const keyHash = (key) => createHash("sha256").update(String(key)).digest("hex");
export function newUploadKey() {
  let s = "bimp_";
  for (let i = 0; i < 32; i++) s += B62[randomInt(62)];
  return s;
}
const ACTIVE = new Set(["queued", "running"]);

// ------------------------------------------------------------ views

// What the API shows of a run: never the key's hash.
export function runView(ir) {
  if (!ir) return null;
  const m = ir.manifest || null;
  return {
    id: ir.id, status: ir.status, as_of: ir.as_of || (m && m.as_of) || null, note: ir.note || null, requested_by: ir.requested_by || null,
    created_at: ir.created_at, started_at: ir.started_at || null, finished_at: ir.finished_at || null,
    manifest: m ? { as_of: m.as_of, entities: Object.fromEntries(Object.entries(m.entities).map(([e, x]) => [e, { rows: x.rows, chunks: x.chunks.length }])), media: m.media || { count: 0, bytes: 0 } } : null,
    upload: ir.upload ? { last4: ir.upload.last4, expires_at: ir.upload.expires_at, expired: !(Date.parse(ir.upload.expires_at) > nowMs()) } : null,
    user_map: ir.user_map || {}, conflicts: ir.conflicts || { open: 0, resolved: 0 }, summary: ir.summary || null, lane_run_id: ir.lane_run_id || null,
    // a continuation ("bring in the rest"): the finished run it goes on from; it has no upload of its own
    continues: ir.continues || null, auto: ir.auto === true,
    // a run that stopped for good (the lane gave up; its rows were cleared): why
    stopped: ir.status === "failed" && ir.stopped ? { code: ir.stopped.code || "error", at: ir.stopped.at || null } : null,
  };
}

export async function loadRun(id) {
  if (!isId(id, "import_run")) throw new NotFoundError("That import isn't there.");
  const got = await getRecord("import_run", id);
  if (!got) throw new NotFoundError("That import isn't there.");
  return got.data;
}

// ------------------------------------------------------------ create

export async function createImportRun({ manifest, note } = {}, ctx) {
  const m = manifest ? checkManifest(manifest) : null;
  const ix = await readIndex("import-runs", "");
  if (ix.rows.some((r) => ACTIVE.has(r.st))) throw new ConflictError("An import is already running. Wait for it to finish (or cancel it) first.");
  const id = newId("import_run");
  const key = newUploadKey();
  const hash = keyHash(key);
  const expires_at = new Date(nowMs() + KEY_TTL_MS).toISOString();
  const rec = await createRecord("import_run", {
    id, status: "uploading", ...(m ? { as_of: m.as_of, manifest: m } : {}), ...(note ? { note: String(note).slice(0, 200) } : {}),
    upload: { key_hash: hash, last4: key.slice(-4), expires_at }, user_map: {}, conflicts: { open: 0, resolved: 0 }, requested_by: ctx.by || "system", attempt: 0,
  }, ctx);
  await claimPointer("import-key", hash, { id, expires_at });
  return { run: runView(rec.data), upload_key: key };
}

// A fresh key for a run whose key ran out (the old one stops working).
export async function rekey(ir, ctx) {
  if (!["uploading"].includes(ir.status)) throw new ConflictError("Only an import that is still uploading needs a key.");
  const key = newUploadKey();
  const hash = keyHash(key);
  const expires_at = new Date(nowMs() + KEY_TTL_MS).toISOString();
  const r = await updateRecord("import_run", ir.id, (x) => ({ ...x, upload: { key_hash: hash, last4: key.slice(-4), expires_at } }), ctx);
  await claimPointer("import-key", hash, { id: ir.id, expires_at });
  return { run: runView(r.data), upload_key: key };
}

// ------------------------------------------------------------ who may upload

const BEARER = /^Bearer\s+(\S+)$/i;
const sameHash = (a, b) => typeof a === "string" && typeof b === "string" && a.length === b.length && timingSafeEqual(Buffer.from(a), Buffer.from(b));

// The upload routes (auth "hook"): the run's upload key, or an owner's
// session (import:run) with the CSRF checks a session write needs.
// → { kind: "key" | "session", run, user?, write } | { res: Response }
export async function uploadAuth(ctx, { session = true } = {}) {
  const m = BEARER.exec(ctx.req.headers.get("authorization") || "");
  if (m) {
    const key = m[1];
    if (!UPLOAD_KEY_RE.test(key)) return { res: fail("signed_out", "That upload key doesn't work.", 401) };
    const hash = keyHash(key);
    const p = await readPointer("import-key", hash);
    if (!p || !isId(p.id, "import_run")) return { res: fail("signed_out", "That upload key doesn't work.", 401) };
    if (ctx.params.id && ctx.params.id !== p.id) return { res: fail("signed_out", "That upload key is for another import.", 401) };
    const got = await getRecord("import_run", p.id);
    const run = got && got.data;
    if (!run || !run.upload || !sameHash(run.upload.key_hash, hash)) return { res: fail("signed_out", "That upload key doesn't work any more.", 401) };
    if (!(Date.parse(run.upload.expires_at) > nowMs())) return { res: fail("signed_out", "That upload key ran out (24 hours). Make a new one on the Import screen.", 401) };
    return { kind: "key", run, write: { by: "import", origin: "import", actor_kind: "import", requestId: ctx.requestId } };
  }
  if (!session) return { res: fail("signed_out", "Send the upload key.", 401) };
  const who = await authenticate(ctx.req, "session");
  if (!who || !who.user) return { res: fail("signed_out", "Sign in again.", 401) };
  if (ctx.req.method !== "GET") {
    const origin = ctx.req.headers.get("origin");
    if (ctx.req.headers.get("x-crm") !== "1" || (origin && origin !== ctx.url.origin)) return { res: fail("csrf", "That request came from another site.", 403) };
  }
  const perms = await loadPermissions();
  if (!can(who.user, "import:run", undefined, perms)) return { res: fail("forbidden", "You don't have access to that.", 403) };
  const run = ctx.params.id ? await loadRun(ctx.params.id) : null;
  return { kind: "session", run, user: who.user, write: { by: who.user.id, origin: "api", actor_kind: "user", requestId: ctx.requestId } };
}

// ------------------------------------------------------------ manifest, start, resume, cancel

export async function setManifest(ir, manifest, ctx) {
  if (ir.status !== "uploading") throw new ConflictError("This import has started; its manifest can't change.");
  const m = checkManifest(manifest);
  if (ir.manifest) {
    if (JSON.stringify(ir.manifest) === JSON.stringify(m)) return runView(ir);
    const got = await received(ir.id);
    if (got.chunks.length) throw new ConflictError("This import already has chunks from another pack. Start a new import for this one.");
  }
  const r = await updateRecord("import_run", ir.id, (x) => (x.status !== "uploading" ? null : { ...x, manifest: m, as_of: m.as_of }), ctx);
  return runView(r.data);
}

// What is still missing: chunk names the manifest lists that weren't received.
export async function missingChunks(ir) {
  const got = await received(ir.id);
  const have = new Set(got.chunks);
  return { missing: manifestChunkNames(ir.manifest).filter((n) => !have.has(n)), received: got };
}

export async function startRun(ir, ctx) {
  if (ACTIVE.has(ir.status)) return runView(ir);
  if (ir.status !== "uploading") throw new ConflictError("This import has finished. Start a new one.");
  if (!ir.manifest) throw new ConflictError("Upload the pack first (its manifest is missing).");
  const { missing } = await missingChunks(ir);
  if (missing.length) throw new ConflictError(`${missing.length} ${missing.length === 1 ? "chunk is" : "chunks are"} still missing. Finish the upload first.`);
  const ix = await readIndex("import-runs", "");
  if (ix.rows.some((r) => r.id !== ir.id && ACTIVE.has(r.st))) throw new ConflictError("Another import is running. Wait for it to finish first.");
  const r = await updateRecord("import_run", ir.id, (x) => (x.status !== "uploading" ? null : { ...x, status: "queued", queued_at: nowIso() }), ctx);
  const lane = await startLaneRun(r.data, ctx, r.data.attempt || 0);
  const r2 = await updateRecord("import_run", ir.id, (x) => (x.lane_run_id === lane.id ? null : { ...x, lane_run_id: lane.id }), ctx);
  return runView(r2.data);
}

// A run whose lane run gave up (storage kept failing) or was cancelled
// before it finished: a fresh lane run picks up at the saved cursors.
export async function resumeRun(ir, ctx) {
  if (!ACTIVE.has(ir.status) && ir.status !== "failed") throw new ConflictError("Only a stopped import can be resumed.");
  if (ir.stopped && ir.stopped.code === "staging_gone") throw new ConflictError(CLEARED_MESSAGE);
  const lane = ir.lane_run_id ? await getRun(ir.lane_run_id).catch(() => null) : null;
  if (ACTIVE.has(ir.status) && lane && (lane.status === "queued" || lane.status === "running")) return runView(ir);
  const ix = await readIndex("import-runs", "");
  if (ix.rows.some((r) => r.id !== ir.id && ACTIVE.has(r.st))) throw new ConflictError("Another import is running. Wait for it to finish first.");
  const attempt = (ir.attempt || 0) + 1;
  const r = await updateRecord("import_run", ir.id, (x) => { const n = { ...x, status: "running", attempt }; delete n.stopped; delete n.finished_at; return n; }, ctx);
  await clearStoppedAlert(ir.id);
  const run = await startLaneRun(r.data, ctx, attempt);
  const r2 = await updateRecord("import_run", ir.id, (x) => ({ ...x, lane_run_id: run.id }), ctx);
  return runView(r2.data);
}

export async function cancelImport(ir, ctx) {
  if (["done", "cancelled"].includes(ir.status)) return runView(ir);
  const r = await updateRecord("import_run", ir.id, (x) => (["done", "cancelled"].includes(x.status) ? null : { ...x, status: "cancelled", finished_at: x.finished_at || nowIso() }), ctx);
  if (ir.lane_run_id) await cancelLaneRun(ir.lane_run_id, ctx).catch(() => null);
  await clearStoppedAlert(ir.id);
  // a continuation someone cancelled: the run it continued is not continued again by itself (the button still does)
  if (ir.continues) await updateRecord("import_run", ir.continues, (x) => (x.auto_off_at ? null : { ...x, auto_off_at: nowIso() }), ctx).catch(() => null);
  // what the run wrote so far (bulk: no index rows) gets its lists back in the background
  const state = await loadState(ir.id).catch(() => null);
  if (state && state.types && state.types.length) await queueReindex(state.types, ctx.requestId).catch(() => null);
  return runView(r.data);
}

// ------------------------------------------------------------ the team map

// The members of a run (from its staged members chunks) with the CRM user
// each one maps to. → { members: [{ rid, name, role, match }], users: [{ id, name }] } | null
export async function memberMap(ir, state = null) {
  const staged = await stagedChunks(ir.id);
  const chunks = staged.members || [];
  if (!chunks.length) return null;
  const members = [];
  for (const n of chunks) {
    const c = await readChunk(ir.id, "members", n);
    for (const row of (c && c.rows) || []) { try { members.push(normalizeMember(row)); } catch { /* counted at staging */ } }
  }
  const users = await userRows();
  const named = (id) => { const u = users.find((x) => x.id === id); return u ? u.name : null; };
  if (state && state.phases && state.phases["system.users"] && state.phases["system.users"].status === "done") {
    return { members: members.map((m) => ({ rid: m.rid, name: m.name, role: m.role, match: state.users[m.rid] ? { id: state.users[m.rid], how: "imported", name: named(state.users[m.rid]) } : null })), users: users.map((u) => ({ id: u.id, name: u.name, status: u.status })), done: true };
  }
  const pointers = await memberPointers(members.map((m) => m.rid));
  const map = proposeMap(members, users, { overrides: ir.user_map || {}, pointers });
  return { members: map.map((x) => ({ ...x, match: x.match ? { ...x.match, name: named(x.match.id) } : null })), users: users.map((u) => ({ id: u.id, name: u.name, status: u.status })), done: false };
}

// The owner's choices before the run starts: { [rotorUserId]: crmUserId |
// "new" (make a new invited user) | null (drop the choice: match by name) }.
// Once the run has started the map it applies is fixed.
export async function setUserMap(ir, map, ctx) {
  if (ir.status !== "uploading") throw new ConflictError("This import has started; change the team on the next import.");
  if (!map || typeof map !== "object" || Array.isArray(map)) throw new InputError("Send who each Rotor member is.", "map");
  const entries = Object.entries(map).slice(0, 50);
  for (const [rid, uid] of entries) {
    if (!/^(?!\.+$)[A-Za-z0-9_.-]{1,64}$/.test(rid)) throw new InputError("That isn't a Rotor member.", "map");
    if (uid !== null && uid !== NEW_USER && !isId(uid, "user")) throw new InputError("That isn't someone on the team.", `map.${rid}`);
  }
  const ids = entries.map(([, u]) => u).filter((u) => u && u !== NEW_USER);
  const found = await getRecords("user", ids);
  if (found.some((g) => !g)) throw new InputError("That isn't someone on the team.", "map");
  const r = await updateRecord("import_run", ir.id, (x) => {
    const next = { ...(x.user_map || {}) };
    for (const [rid, uid] of entries) { if (uid === null) delete next[rid]; else next[rid] = uid; }
    return { ...x, user_map: next };
  }, ctx);
  return runView(r.data);
}

// ------------------------------------------------------------ conflicts

const CONFLICT_ID_RE = /^(ir_[0-9a-z]{20})--([a-z_]{2,31})--([a-z]{2}_[0-9a-z]{20})--([a-z0-9_.-]{1,80})$/;
export const conflictId = (runId, c) => `${runId}--${c.type}--${c.id}--${c.field}`;

const label = (rec) => rec ? (rec.display_name || rec.name || [rec.first_name, rec.last_name].filter(Boolean).join(" ") || rec.title || rec.id) : null;

// One page of a run's conflicts: { rows: [{ key, type, id, field, label, base, crm, rotor, status, resolution? }], next, total }
// With a status, keys are read in small batches until a page of matches
// (or 30 reads), so settled ones don't leave a page empty.
export async function listConflicts(runId, { after = null, limit = 12, status = null } = {}) {
  const prefix = conflictsPrefix(runId);
  const keys = (await listKeys(prefix)).filter((k) => !after || k > prefix + after);
  const rows = [];
  let i = 0;
  while (i < keys.length && rows.length < limit && i < 30) {
    const batch = keys.slice(i, i + Math.min(limit, 30 - i));
    i += batch.length;
    const vals = await Promise.all(batch.map((k) => getRaw(k)));
    for (const g of vals) if (g && g.data && (!status || g.data.status === status)) rows.push(g.data);
  }
  const withLabels = await Promise.all(rows.map(async (c) => {
    const rec = getType(c.type) ? await getRecord(c.type, c.id).catch(() => null) : null;
    return { key: conflictId(runId, c), type: c.type, id: c.id, field: c.field, label: label(rec && rec.data), base: c.base, crm: c.crm, rotor: c.rotor, status: c.status, resolution: c.resolution || null, at: c.at };
  }));
  return { rows: withLabels, next: i < keys.length ? keys[i - 1].slice(prefix.length) : null, total: keys.length };
}

// Settles one conflict: "rotor" writes Rotor's value (as the person: a
// human action), "crm" keeps the CRM's; either way the import base takes
// Rotor's value, so the field stays quiet until Rotor changes it again.
export async function resolveConflict(id, take, ctx) {
  if (take !== "rotor" && take !== "crm") throw new InputError("Pick Rotor's value or the CRM's.", "take");
  const m = CONFLICT_ID_RE.exec(String(id || ""));
  if (!m) throw new NotFoundError("That conflict isn't there.");
  const [, runId, type, recId, field] = m;
  const def = getType(type);
  if (!def || !def.rotorFields.includes(field)) throw new NotFoundError("That conflict isn't there.");
  const key = conflictKey(runId, type, recId, field);
  const got = await getRaw(key);
  const c = got && got.data;
  if (!c) throw new NotFoundError("That conflict isn't there.");
  if (c.status === "resolved") return { ok: true, already: true, resolution: c.resolution };
  if (take === "rotor") {
    await updateRecord(type, recId, (rec) => { const next = JSON.parse(JSON.stringify(rec)); setPath(next, field, c.rotor === null ? undefined : c.rotor); return next; }, ctx);
  }
  // the conflict's source's base takes Rotor's value (its version tag stays: the next
  // run sees Rotor = base for the field, keeps the CRM's value and re-tags the record)
  const ib = await getRaw(ibKey(type, recId));
  const setField = (fields) => { const f = { ...(fields || {}) }; if (c.rotor === null || c.rotor === undefined) delete f[field]; else f[field] = c.rotor; return f; };
  if (ib && ib.data && ib.data.sources && typeof ib.data.sources === "object") {
    const srcKey = c.source && ib.data.sources[c.source] ? c.source : ib.data.primary;
    if (srcKey && ib.data.sources[srcKey]) {
      const sources = { ...ib.data.sources, [srcKey]: { ...ib.data.sources[srcKey], fields: setField(ib.data.sources[srcKey].fields) } };
      await putRaw(ibKey(type, recId), { ...ib.data, sources, at: nowIso() });
    }
  } else if (ib && ib.data && ib.data.fields) {
    await putRaw(ibKey(type, recId), { ...ib.data, fields: setField(ib.data.fields), at: nowIso() });
  }
  await putRaw(key, { ...c, status: "resolved", resolution: take, resolved_by: ctx.by, resolved_at: nowIso() });
  await updateRecord("import_run", runId, (x) => ({ ...x, conflicts: { open: Math.max(0, ((x.conflicts && x.conflicts.open) || 0) - 1), resolved: ((x.conflicts && x.conflicts.resolved) || 0) + 1 } }), ctx).catch(() => null);
  return { ok: true, resolution: take, value: take === "rotor" ? c.rotor : c.crm };
}

// ------------------------------------------------------------ media already on the site

// Which of these media checksums the site already has (from any run). → [urlSha256]
export async function mediaHave(hashes) {
  const want = new Map(hashes.map((h) => [idForRotor("file", h), h]));
  const keys = await listKeys("rec/file/");
  const out = [];
  for (const k of keys) { const id = k.slice("rec/file/".length); if (want.has(id)) out.push(want.get(id)); }
  return out.sort();
}

// The run's screen in one answer: the run, upload status, phases, team map,
// lane; for the latest finished run also `rest` (what of its export can be
// brought in now, what still waits and for which part: continue.mjs).
export async function runDetail(ir) {
  const [state, got, lane, rest] = await Promise.all([
    loadState(ir.id),
    ir.continues ? { chunks: [], media: [] } : received(ir.id),
    ir.lane_run_id ? getRun(ir.lane_run_id).catch(() => null) : null,
    ir.status === "done" ? restView().catch(() => null) : null,
  ]);
  const expected = manifestChunkNames(ir.manifest);
  const have = new Set(got.chunks);
  const team = ir.continues ? null : await memberMap(ir, state).catch(() => null);
  return {
    run: runView(ir),
    upload: ir.continues ? null : { chunks: got.chunks.length, expected: expected.length, missing: expected.filter((n) => !have.has(n)).slice(0, 20), missing_count: expected.filter((n) => !have.has(n)).length, media: got.media.length, media_expected: (ir.manifest && ir.manifest.media && ir.manifest.media.count) || 0 },
    phases: phaseView(state),
    finish: state ? state.finish.step : null,
    lane: lane ? { status: lane.status, attempts: lane.attempts || 0, retry_at: lane.retry_at || null, error: lane.error || null, progress: lane.progress || null } : null,
    team,
    rest: rest && rest.run && rest.run.id === ir.id ? rest : null,
  };
}

