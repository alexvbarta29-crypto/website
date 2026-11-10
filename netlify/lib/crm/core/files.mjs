// Barta CRM core: files (design §3.11, §4.12).
//
// Bytes live in crm-files at f/{fileId} (original) and t/{fileId}
// (thumbnail), written once (onlyIfNew) with small metadata
// { ct, bytes, sha256 }. The record rec/file/{id} = { kind, content_type
// (from the magic bytes), bytes, sha256, owner: { type, id }, contact_id?,
// customer_visible, download_only?, caption?, tag?, taken_at?, has_thumb,
// source, deleted_at? } is listed under rel/owner-files/{ownerId}.
//
// - The content type comes from the file's MAGIC BYTES (JPEG, PNG, WebP,
//   PDF), never from the uploader's header. Staff uploads outside those
//   four are refused. Imported media and MMS outside the image/PDF
//   allowlist (HTML, SVG, anything unknown) are stored download_only and
//   always served as application/octet-stream attachments, so a file can
//   never run script on the site's origin.
// - Download: the magic-byte Content-Type, X-Content-Type-Options: nosniff,
//   Content-Security-Policy: sandbox, Content-Disposition inline for
//   JPEG/PNG/WebP and attachment for PDFs and everything else, ETag,
//   Cache-Control: private, max-age=31536000, immutable, 304 on
//   If-None-Match. Staff downloads of originals are audited.
// - Access follows the owner record: the module that owns a type says who
//   may read and edit its files (defineFileOwner). An owner type nobody
//   declared cannot hold files.
// - Delete is soft; files.purge removes the bytes 30 days later, and only
//   once files.backup has copied them into crm-backups (files/{id},
//   files/{id}.t).

import { createHash } from "node:crypto";
import {
  putFileBytes, getFileStream, deleteFileBytes, createRecord, updateRecord, getRecord, softDelete,
  addRel, removeRel, listRel, listKeys, getRaw, putRaw,
} from "../../crm-store.mjs";
import { newId, deriveId, isId, typeOf } from "./ids.mjs";
import { nowIso, nowMs, tsKey } from "./clock.mjs";
import { InputError, ForbiddenError, NotFoundError, RegistryError } from "./errors.mjs";
import { defineRun, updateHealth } from "./lanes.mjs";
import { auditRead } from "./audit.mjs";
import { keySafe } from "./text.mjs";

export const STAFF_TYPES = Object.freeze(["image/jpeg", "image/png", "image/webp", "application/pdf"]);
export const INLINE_TYPES = Object.freeze(new Set(["image/jpeg", "image/png", "image/webp"]));
export const MAX_UPLOAD_BYTES = 4000000;
export const MAX_THUMB_BYTES = 400 * 1024;
export const PURGE_AFTER_DAYS = 30;
export const FILE_KINDS = Object.freeze(["photo", "signature", "attachment", "mockup", "document", "import_media"]);
export const FILE_TAGS = Object.freeze(["before", "after", "issue", "other"]);
const EXT = { "image/jpeg": "jpg", "image/png": "png", "image/webp": "webp", "application/pdf": "pdf", "image/gif": "gif" };

const startsWith = (b, sig, at = 0) => sig.every((x, i) => b[at + i] === x);
const ascii = (b, from, to) => String.fromCharCode(...b.subarray(from, Math.min(to, b.length)));

// The type a file really is, from its first bytes: "image/jpeg",
// "image/png", "image/webp", "application/pdf", "image/gif", "text/html",
// "image/svg+xml", or null (unknown).
export function sniffType(bytes) {
  const b = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes || []);
  if (b.length >= 3 && startsWith(b, [0xff, 0xd8, 0xff])) return "image/jpeg";
  if (b.length >= 8 && startsWith(b, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) return "image/png";
  if (b.length >= 12 && ascii(b, 0, 4) === "RIFF" && ascii(b, 8, 12) === "WEBP") return "image/webp";
  if (b.length >= 5 && ascii(b, 0, 5) === "%PDF-") return "application/pdf";
  if (b.length >= 6 && /^GIF8[79]a$/.test(ascii(b, 0, 6))) return "image/gif";
  const head = ascii(b, 0, 512).replace(/^﻿/, "").trimStart().toLowerCase();
  if (head.startsWith("<svg") || (head.startsWith("<?xml") && head.includes("<svg"))) return "image/svg+xml";
  if (/^<(!doctype html|html|head|body|script|iframe|div|p|a |a>|meta|title|style)/.test(head)) return "text/html";
  return null;
}

// What every file answer carries (§3.11): the type it really is (or a
// plain byte stream for download-only files), never sniffed by the
// browser, never able to run script, never framed.
export function deliveryHeaders(file, { thumb = false, etag } = {}) {
  const ct = thumb ? "image/jpeg" : file.download_only ? "application/octet-stream" : file.content_type || "application/octet-stream";
  const inline = thumb || (!file.download_only && INLINE_TYPES.has(ct));
  const ext = thumb ? "jpg" : EXT[file.content_type] && !file.download_only ? EXT[file.content_type] : "bin";
  return {
    "Content-Type": ct,
    "X-Content-Type-Options": "nosniff",
    "Content-Security-Policy": "sandbox",
    "Content-Disposition": inline ? "inline" : `attachment; filename="file-${file.id}${thumb ? "-thumb" : ""}.${ext}"`,
    "Cache-Control": "private, max-age=31536000, immutable",
    "Referrer-Policy": "same-origin",
    "X-Robots-Tag": "noindex, nofollow",
    ...(etag ? { ETag: etag } : {}),
  };
}

// ------------------------------------------------------------ owners

const owners = new Map();
// The module that owns a record type declares who may read and edit its
// files: { canRead(ctx, ownerRecord), canEdit(ctx, ownerRecord), attach?(owner, file, ctx) }.
export function defineFileOwner(type, spec = {}) {
  if (typeof type !== "string" || !/^[a-z][a-z_]{1,30}$/.test(type)) throw new RegistryError(`file owner ${type}: bad type`);
  if (typeof spec.canRead !== "function" || typeof spec.canEdit !== "function") throw new RegistryError(`file owner ${type}: canRead and canEdit are required`);
  owners.set(type, { type, ...spec });
}
export const fileOwner = (type) => owners.get(type) || null;

async function loadOwner(type, id) {
  const spec = fileOwner(type);
  if (!spec) throw new InputError("Files can't be attached to that.", "owner_type");
  if (!isId(id) || typeOf(id) !== type) throw new NotFoundError("That record isn't there.");
  const got = await getRecord(type, id);
  if (!got || !got.data || got.data.deleted_at) throw new NotFoundError("That record isn't there.");
  return { spec, record: got.data };
}

const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");
const asBytes = (raw) => (raw instanceof Uint8Array ? raw : new Uint8Array(raw || []));

// What the API shows of a file record.
export const fileView = (f) => ({
  id: f.id, kind: f.kind, content_type: f.download_only ? "application/octet-stream" : f.content_type, bytes: f.bytes,
  owner: f.owner, contact_id: f.contact_id || null, customer_visible: !!f.customer_visible, download_only: !!f.download_only,
  caption: f.caption || null, tag: f.tag || null, taken_at: f.taken_at || null, has_thumb: !!f.has_thumb, created_at: f.created_at,
  url: `/api/crm/files/${f.id}`, ...(f.has_thumb ? { thumb_url: `/api/crm/files/${f.id}?thumb=1` } : {}),
});

// POST /files: a staff upload (photo, signature, attachment, document).
export async function uploadFile(ctx, { ownerType, ownerId, kind = "photo", tag, caption, declaredType, bytes, clientId, takenAt } = {}) {
  const raw = asBytes(bytes);
  if (!raw.length) throw new InputError("That file is empty.", "file");
  if (raw.length > MAX_UPLOAD_BYTES) throw new InputError("That file is too big (4 MB at most).", "file");
  if (!STAFF_TYPES.includes(String(declaredType || "").toLowerCase())) throw new InputError("Upload a photo (JPEG, PNG or WebP) or a PDF.", "content-type");
  if (!FILE_KINDS.includes(kind) || kind === "import_media") throw new InputError("Pick what kind of file this is.", "kind");
  if (tag !== undefined && tag !== null && tag !== "" && !FILE_TAGS.includes(tag)) throw new InputError("Pick before, after, issue or other.", "tag");
  const type = sniffType(raw);
  if (!type || !STAFF_TYPES.includes(type)) throw new InputError("That file isn't a JPEG, PNG, WebP or PDF.", "file");
  const { spec, record } = await loadOwner(ownerType, ownerId);
  if (!(await spec.canEdit(ctx, record))) throw new ForbiddenError("You don't have access to that.");
  const id = clientId ? deriveId("file", `c:${keySafe(clientId, 80)}`) : newId("file");
  const existing = clientId ? await getRecord("file", id) : null;
  if (existing && existing.data) return existing.data;           // an offline replay or a double tap
  const digest = sha256(raw);
  await putFileBytes(id, raw, { ct: type, bytes: raw.length, sha256: digest });
  const rec = await createRecord("file", {
    id, kind, content_type: type, bytes: raw.length, sha256: digest, owner: { type: ownerType, id: ownerId },
    ...(record.contact_id ? { contact_id: record.contact_id } : ownerType === "contact" ? { contact_id: ownerId } : {}),
    customer_visible: false, has_thumb: false, source: "staff",
    ...(tag ? { tag } : {}), ...(caption ? { caption: String(caption).slice(0, 200) } : {}), ...(takenAt ? { taken_at: takenAt } : {}),
  }, ctx.write());
  if (typeof spec.attach === "function") await spec.attach(record, rec.data, ctx);
  return rec.data;
}

// Imported media (M2c) and MMS (M6): anything outside the image/PDF
// allowlist is kept download-only. → the file record.
export async function storeImportedFile({ bytes, owner, kind = "import_media", contactId, source = "import", id } = {}, ctx = {}) {
  const raw = asBytes(bytes);
  if (!raw.length || raw.length > MAX_UPLOAD_BYTES * 5) throw new InputError("That file is empty or too big.", "file");
  const sniffed = sniffType(raw);
  const allowed = sniffed && STAFF_TYPES.includes(sniffed);
  const fid = id || newId("file");
  const digest = sha256(raw);
  await putFileBytes(fid, raw, { ct: allowed ? sniffed : "application/octet-stream", bytes: raw.length, sha256: digest });
  const rec = await createRecord("file", {
    id: fid, kind, content_type: sniffed || "application/octet-stream", bytes: raw.length, sha256: digest, owner,
    ...(contactId ? { contact_id: contactId } : {}), customer_visible: false, has_thumb: false, source,
    ...(allowed ? {} : { download_only: true }),
  }, ctx);
  return rec.data;
}

async function loadFile(id) {
  if (!isId(id, "file")) throw new NotFoundError("That file isn't there.");
  const got = await getRecord("file", id);
  if (!got || !got.data || got.data.deleted_at) throw new NotFoundError("That file isn't there.");
  return got.data;
}

// POST /files/:id/thumb: a JPEG thumbnail the phone made (≤ 400 KB).
export async function uploadThumb(ctx, id, bytes) {
  const raw = asBytes(bytes);
  if (!raw.length || raw.length > MAX_THUMB_BYTES) throw new InputError("The thumbnail must be a JPEG under 400 KB.", "file");
  if (sniffType(raw) !== "image/jpeg") throw new InputError("The thumbnail must be a JPEG.", "file");
  const file = await loadFile(id);
  const { spec, record } = await loadOwner(file.owner.type, file.owner.id);
  if (!(await spec.canEdit(ctx, record))) throw new ForbiddenError("You don't have access to that.");
  await putFileBytes(id, raw, { ct: "image/jpeg", bytes: raw.length, sha256: sha256(raw) }, { thumb: true });
  const r = await updateRecord("file", id, (f) => (f.has_thumb ? null : { ...f, has_thumb: true }), ctx.write());
  return r.data;
}

// GET /files/:id[?thumb=1]: the bytes, with the headers above.
export async function serveFile(ctx, id, { thumb = false } = {}) {
  const file = await loadFile(id);
  const { spec, record } = await loadOwner(file.owner.type, file.owner.id);
  if (!(await spec.canRead(ctx, record))) throw new ForbiddenError("You don't have access to that.");
  if (thumb && !file.has_thumb) throw new NotFoundError("That file has no thumbnail.");
  const ifNoneMatch = ctx.req.headers.get("if-none-match") || undefined;
  const got = await getFileStream(id, { thumb, ifNoneMatch });
  if (!got) throw new NotFoundError("That file's bytes aren't there.");
  if (got.notModified) return new Response(null, { status: 304, headers: deliveryHeaders(file, { thumb, etag: ifNoneMatch }) });
  if (!thumb && ctx.user) await auditRead(ctx, "file", file.id, "download");
  return new Response(got.stream, { status: 200, headers: deliveryHeaders(file, { thumb, etag: got.etag }) });
}

// DELETE /files/:id: soft delete; the bytes stay 30 days (files.purge).
export async function deleteFile(ctx, id) {
  const file = await loadFile(id);
  const { spec, record } = await loadOwner(file.owner.type, file.owner.id);
  if (!(await spec.canEdit(ctx, record))) throw new ForbiddenError("You don't have access to that.");
  const r = await softDelete("file", id, ctx.write());
  await addRel("files-deleted", "all", tsKey(new Date(Date.parse(r.data.deleted_at) || nowMs())), id);
  return r.data;
}

// The files of one owner record, newest first.
export async function filesOf(ownerId, { limit = 100 } = {}) {
  const rows = await listRel("owner-files", ownerId, { limit });
  const recs = await Promise.all(rows.map((r) => getRecord("file", r.id)));
  return recs.filter((g) => g && g.data && !g.data.deleted_at).map((g) => fileView(g.data));
}

// ------------------------------------------------------------ files.backup and files.purge (bulk lane runs)

const backupKey = (id, thumb) => `files/${id}${thumb ? ".t" : ""}`;

async function copyBytes(id, thumb) {
  const got = await getRaw(`${thumb ? "t" : "f"}/${id}`, { kind: "files", type: "arrayBuffer" });
  if (!got || !got.data) return false;
  await putRaw(backupKey(id, thumb), got.data, { metadata: got.metadata || {} }, { kind: "backups" });
  return true;
}

// Copies every file the backups store does not have yet (originals and
// thumbnails). Two listings decide what is missing, so imported files with
// hashed ids are never skipped.
async function filesBackupStep(run, { budget }) {
  const ids = (await listKeys("rec/file/")).map((k) => k.slice("rec/file/".length));
  const have = new Set(await listKeys("files/", { kind: "backups" }));
  const todo = ids.filter((id) => !have.has(backupKey(id, false)) || !have.has(backupKey(id, true)));
  const cp = run.checkpoint || { copied: 0 };
  for (const id of todo) {
    if (budget && budget.left() < 10000) return { checkpoint: cp, progress: { done: cp.copied, total: cp.copied + todo.length } };
    const rec = await getRecord("file", id);
    if (!have.has(backupKey(id, false)) && (await copyBytes(id, false))) cp.copied += 1;
    if (rec && rec.data && rec.data.has_thumb && !have.has(backupKey(id, true))) await copyBytes(id, true);
  }
  await updateHealth((h) => ({ ...h, files_backup: { at: nowIso(), copied: cp.copied, files: ids.length } }));
  return { done: true, checkpoint: cp, progress: { done: cp.copied, total: cp.copied }, result: { copied: cp.copied, files: ids.length } };
}

// Deletes the bytes of files soft-deleted more than 30 days ago, but only
// those files.backup has copied.
async function filesPurgeStep(run, { budget, write }) {
  const cutoff = tsKey(new Date(nowMs() - PURGE_AFTER_DAYS * 86400000));
  const rows = await listRel("files-deleted", "all", { to: cutoff, limit: 500, newestFirst: false });
  const cp = run.checkpoint || { purged: 0, kept: 0 };
  for (const r of rows) {
    if (budget && budget.left() < 10000) return { checkpoint: cp, progress: { done: cp.purged, total: null } };
    const got = await getRecord("file", r.id);
    const f = got && got.data;
    if (!f || !f.deleted_at) { await removeRel("files-deleted", "all", r.sortKey, r.id); continue; }   // restored meanwhile
    const backedUp = (await listKeys(backupKey(r.id, false), { kind: "backups" })).includes(backupKey(r.id, false));
    if (!backedUp) { cp.kept += 1; continue; }
    await deleteFileBytes(r.id);
    await updateRecord("file", r.id, (x) => (x.purged_at ? null : { ...x, purged_at: nowIso(), has_thumb: false }), write());
    await removeRel("files-deleted", "all", r.sortKey, r.id);
    cp.purged += 1;
  }
  return { done: true, checkpoint: cp, result: { purged: cp.purged, kept_without_backup: cp.kept } };
}

defineRun("files.backup", { lane: "bulk", step: filesBackupStep, maintenance: true, label: "File backup" });
defineRun("files.purge", { lane: "bulk", step: filesPurgeStep, maintenance: true, label: "Deleted files clean-up" });
