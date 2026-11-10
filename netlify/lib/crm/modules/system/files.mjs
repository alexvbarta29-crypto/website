// Core "system" module: files (design §3.11, §4.12).
//
//   POST   /files?owner_type=&owner_id=&kind=&tag=&client_id=   raw bytes ≤ 4,000,000 (JPEG, PNG, WebP, PDF;
//                                                     the type comes from the magic bytes) → { file }
//   POST   /files/:id/thumb                           raw JPEG ≤ 400 KB → { file }
//   GET    /files/:id[?thumb=1]                       the bytes: nosniff, CSP sandbox, inline images,
//                                                     attachment for PDFs and anything else, ETag/304
//   DELETE /files/:id                                 soft delete (the bytes stay 30 days)
//
// Who may: the edit or read right on the owner record, as its module
// declares it (core/files.mjs defineFileOwner). The route itself only needs
// a signed-in person.

import { uploadFile, uploadThumb, serveFile, deleteFile, fileView, MAX_UPLOAD_BYTES, MAX_THUMB_BYTES } from "../../core/files.mjs";
import { contentType } from "../../core/http.mjs";

async function upload(ctx) {
  const q = ctx.query;
  const file = await uploadFile(ctx, {
    ownerType: q.get("owner_type"), ownerId: q.get("owner_id"), kind: q.get("kind") || "photo", tag: q.get("tag") || undefined,
    caption: q.get("caption") || undefined, clientId: q.get("client_id") || undefined, takenAt: q.get("taken_at") || undefined,
    declaredType: contentType(ctx.req), bytes: ctx.raw,
  });
  return { status: 201, data: { file: fileView(file) } };
}

async function thumb(ctx) {
  const file = await uploadThumb(ctx, ctx.params.id, ctx.raw);
  return { data: { file: fileView(file) } };
}

const download = (ctx) => serveFile(ctx, ctx.params.id, { thumb: ctx.query.get("thumb") === "1" });

async function remove(ctx) {
  await deleteFile(ctx, ctx.params.id);
  return { data: { ok: true } };
}

const r = (method, path, handler, more = {}) => ({ method, path, auth: "session", perm: "account:own", subject: "required", mode: "inline", handler, ...more });
export const fileRoutes = [
  r("POST", "/files", upload, { body: "raw", maxBody: MAX_UPLOAD_BYTES, maxCalls: 30 }),
  r("POST", "/files/:id/thumb", thumb, { body: "raw", maxBody: MAX_THUMB_BYTES }),
  r("GET", "/files/:id", download),
  r("DELETE", "/files/:id", remove),
];
