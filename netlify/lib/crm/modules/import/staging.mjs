// Staging (design §10.1 steps 3-5): what the pack made, received on the site.
//
// The pack (build/crm_import_pack.mjs) splits each entity file into chunks
// of at most ~2.9 MB of JSON, seals each with the office public key
// (X25519 + AES-256-GCM, netlify/lib/office-data.mjs) and writes a manifest
// (entity names, row counts, chunk names, SHA-256 of each sealed chunk; no
// personal data). On receipt the server:
//   - checks the chunk against the manifest (name, SHA-256 of the bytes it
//     got, row count), opens it with OFFICE_DATA_KEY and checks every row
//     with the normalize() of each phase that reads that entity (a row that
//     doesn't fit is counted, kept, and skipped later with its reason);
//   - writes the plaintext rows to imp/{runId}/raw/{entity}/{nnnn} (import
//     staging, design §0 rule 4: an unconditional write is allowed here);
//   - media bytes (message attachments, quote photos the integrator's fetch
//     script saved) go straight to crm-files as f/{fileId} with
//     fileId = idForRotor("file", url_sha256), and a small marker
//     imp/{runId}/media/{urlSha256} says this run has it. The site never
//     fetches a media URL itself: media are uploaded, never downloaded.
// Staging is deleted 30 days after the run (import.staging_gc).

import { createHash } from "node:crypto";
import { getRaw, putRaw, listKeys, getRecord, createRecord, putFileBytes, ExistsError } from "../../../crm-store.mjs";
import { open as openSealed, privateKey } from "../../../office-data.mjs";
import { InputError, ConflictError } from "../../core/errors.mjs";
import { idForRotor } from "../../core/ids.mjs";
import { nowIso } from "../../core/clock.mjs";
import { allModules } from "../../core/registry.mjs";
import { sniffType, STAFF_TYPES } from "../../core/files.mjs";
import { ENTITY_RE } from "./catalog.mjs";

export const CHUNK_RE = /^([a-z][a-z0-9_]{0,40})-(\d{4})$/;
export const SHA_RE = /^[0-9a-f]{64}$/;
export const MAX_CHUNK_BYTES = Math.floor(4.5 * 1024 * 1024);
export const MAX_MEDIA_BYTES = 4000000;
export const MAX_ROWS_PER_CHUNK = 100000;
export const MEDIA_SOURCES = Object.freeze(["message_attachment", "quote_photo"]);
const MAX_MANIFEST_ENTITIES = 60;
const MAX_CHUNKS_PER_ENTITY = 200;

export const sha256Hex = (bytes) => createHash("sha256").update(bytes).digest("hex");
export const rawPrefix = (runId) => `imp/${runId}/raw/`;
export const rawKey = (runId, entity, nnnn) => `imp/${runId}/raw/${entity}/${nnnn}`;
export const mediaPrefix = (runId) => `imp/${runId}/media/`;
export const mediaKey = (runId, urlSha) => `imp/${runId}/media/${urlSha}`;

// ------------------------------------------------------------ the manifest

// A manifest the pack wrote: { v: 1, kind, as_of, entities: { name: { rows,
// chunks: [{ name, rows, sha256 }] } }, media?: { count, bytes } }. → the
// cleaned manifest (unknown keys dropped), or InputError(field).
export function checkManifest(m) {
  if (!m || typeof m !== "object" || Array.isArray(m)) throw new InputError("That isn't an import manifest.", "manifest");
  if (m.v !== 1 || m.kind !== "barta-import-manifest") throw new InputError("That isn't an import manifest from the pack script.", "manifest.kind");
  if (typeof m.as_of !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(m.as_of)) throw new InputError("The manifest needs its export date.", "manifest.as_of");
  if (!m.entities || typeof m.entities !== "object" || Array.isArray(m.entities)) throw new InputError("The manifest lists no entities.", "manifest.entities");
  const names = Object.keys(m.entities);
  if (names.length > MAX_MANIFEST_ENTITIES) throw new InputError("The manifest lists too many entities.", "manifest.entities");
  const entities = {};
  for (const name of names) {
    if (!ENTITY_RE.test(name)) throw new InputError("The manifest names an entity the import doesn't know how to read.", `manifest.entities.${name.slice(0, 40)}`);
    const e = m.entities[name] || {};
    if (!Number.isSafeInteger(e.rows) || e.rows < 0) throw new InputError("A row count in the manifest isn't a number.", `manifest.entities.${name}.rows`);
    if (!Array.isArray(e.chunks) || e.chunks.length > MAX_CHUNKS_PER_ENTITY) throw new InputError("The manifest's chunk list doesn't fit.", `manifest.entities.${name}.chunks`);
    let sum = 0;
    const chunks = e.chunks.map((c, i) => {
      const mm = CHUNK_RE.exec(String(c && c.name));
      if (!mm || mm[1] !== name || Number(mm[2]) !== i + 1) throw new InputError("A chunk name in the manifest doesn't fit.", `manifest.entities.${name}.chunks.${i}`);
      if (!Number.isSafeInteger(c.rows) || c.rows < 0 || c.rows > MAX_ROWS_PER_CHUNK) throw new InputError("A chunk's row count doesn't fit.", `manifest.entities.${name}.chunks.${i}.rows`);
      if (!SHA_RE.test(String(c.sha256))) throw new InputError("A chunk's checksum is missing.", `manifest.entities.${name}.chunks.${i}.sha256`);
      sum += c.rows;
      return { name: c.name, rows: c.rows, sha256: c.sha256, ...(Number.isSafeInteger(c.bytes) ? { bytes: c.bytes } : {}) };
    });
    if (sum !== e.rows) throw new InputError("The manifest's row counts don't add up.", `manifest.entities.${name}.rows`);
    entities[name] = { rows: e.rows, chunks };
  }
  const media = m.media && typeof m.media === "object" ? { count: Number.isSafeInteger(m.media.count) ? m.media.count : 0, bytes: Number.isSafeInteger(m.media.bytes) ? m.media.bytes : 0 } : { count: 0, bytes: 0 };
  return { v: 1, kind: "barta-import-manifest", as_of: m.as_of, entities, media };
}

// The chunk the manifest says this name is, or null.
export function manifestChunk(manifest, name) {
  const mm = CHUNK_RE.exec(String(name || ""));
  if (!mm || !manifest || !manifest.entities[mm[1]]) return null;
  return manifest.entities[mm[1]].chunks.find((c) => c.name === name) || null;
}
export const manifestChunkNames = (manifest) => (manifest ? Object.values(manifest.entities).flatMap((e) => e.chunks.map((c) => c.name)) : []);

// ------------------------------------------------------------ rows

// The phases that read an entity (every registered module's importPhases).
export function phasesFor(entity) {
  return allModules().flatMap((m) => (m.importPhases || []).filter((p) => p.entity === entity));
}

// How many rows no phase that reads them would take. → [{ i, field }] (at most 50 kept)
export function checkRows(entity, rows) {
  const phases = phasesFor(entity).filter((p) => typeof p.normalize === "function");
  const bad = [];
  for (const [i, row] of rows.entries()) {
    let field = null;
    if (!row || typeof row !== "object" || Array.isArray(row)) field = "row";
    else {
      for (const p of phases) {
        try { p.normalize(row); } catch (e) { field = String((e && e.field) || "row").slice(0, 60); break; }
      }
    }
    if (field) bad.push({ i, field });
  }
  return bad;
}

// ------------------------------------------------------------ chunks

export class KeyMissing extends Error {}

// Opens a sealed chunk: the box the pack wrote → { entity, n, rows }.
// Throws KeyMissing (no OFFICE_DATA_KEY on the site), InputError otherwise.
export function openChunk(text, name, env = process.env) {
  const key = privateKey(env);
  if (!key) throw new KeyMissing("The site has no OFFICE_DATA_KEY yet.");
  if (key === "bad") throw new KeyMissing("The site's OFFICE_DATA_KEY isn't a usable key.");
  let box;
  try { box = JSON.parse(text); } catch { throw new InputError("That isn't a sealed chunk from the pack script.", "chunk"); }
  let payload;
  try { payload = openSealed(box, key); } catch { throw new InputError("That chunk was sealed for a different key, or it is damaged.", "chunk"); }
  const mm = CHUNK_RE.exec(name);
  if (!payload || payload.v !== 1 || payload.kind !== "barta-import-chunk" || payload.entity !== mm[1] || Number(payload.n) !== Number(mm[2]) || !Array.isArray(payload.rows)) {
    throw new InputError("That chunk isn't the one its name says.", "chunk");
  }
  if (payload.rows.length > MAX_ROWS_PER_CHUNK) throw new InputError("That chunk holds too many rows.", "chunk");
  return { entity: payload.entity, n: Number(payload.n), rows: payload.rows, as_of: payload.as_of || null };
}

// Stores one received chunk. ir: the import_run record. → { entity, rows, invalid }
export async function receiveChunk(ir, name, bytes, { sha256: claimed, env } = {}) {
  const mm = CHUNK_RE.exec(String(name || ""));
  if (!mm) throw new InputError("That chunk name doesn't fit (entity-0001).", "name");
  if (!bytes || !bytes.length) throw new InputError("That chunk is empty.", "chunk");
  const sha = sha256Hex(bytes);
  if (claimed && claimed.toLowerCase() !== sha) throw new InputError("The upload got damaged on the way (checksum). Send it again.", "x-content-sha256");
  // the manifest first: every chunk is then checked against its checksum
  const m = ir.manifest || null;
  if (!m) throw new ConflictError("Send the pack's manifest.json first.");
  const listed = manifestChunk(m, name);
  if (!listed) throw new InputError("That chunk isn't in this run's manifest.", "name");
  if (listed.sha256 !== sha) throw new ConflictError("That chunk isn't the one this run's manifest lists (a different pack?).");
  const chunk = openChunk(Buffer.from(bytes).toString("utf8"), name, env);
  if (listed.rows !== chunk.rows.length) throw new InputError("That chunk's rows don't match its manifest.", "chunk");
  const invalid = checkRows(chunk.entity, chunk.rows);
  await putRaw(rawKey(ir.id, chunk.entity, mm[2]), { entity: chunk.entity, n: chunk.n, rows: chunk.rows, sha256: sha, invalid: invalid.slice(0, 50), invalid_count: invalid.length, received_at: nowIso() });
  return { entity: chunk.entity, rows: chunk.rows.length, invalid: invalid.length };
}

// The staged chunks of a run: { entity: ["0001", ...] } (sorted).
export async function stagedChunks(runId, opts = {}) {
  const out = {};
  for (const k of await listKeys(rawPrefix(runId), {}, opts)) {
    const m = /^imp\/[a-z]{2}_[0-9a-z]{20}\/raw\/([a-z][a-z0-9_]{0,40})\/(\d{4})$/.exec(k);
    if (!m) continue;
    (out[m[1]] ||= []).push(m[2]);
  }
  for (const e of Object.keys(out)) out[e].sort();
  return out;
}

export async function readChunk(runId, entity, nnnn, opts = {}) {
  const got = await getRaw(rawKey(runId, entity, nnnn), opts);
  return got && got.data ? got.data : null;
}

// What the run has received: { chunks: ["customers-0001", ...], media: [urlSha256, ...] }.
export async function received(runId, opts = {}) {
  const staged = await stagedChunks(runId, opts);
  const chunks = Object.entries(staged).flatMap(([e, list]) => list.map((n) => `${e}-${n}`)).sort();
  const media = (await listKeys(mediaPrefix(runId), {}, opts)).map((k) => k.slice(k.lastIndexOf("/") + 1)).filter((h) => SHA_RE.test(h)).sort();
  return { chunks, media };
}

// ------------------------------------------------------------ media

export const mediaFileId = (urlSha) => idForRotor("file", urlSha);

// "message_attachment:<rotor id>" → { source, ref_id }.
export function parseMediaRef(v) {
  const m = /^([a-z_]{3,30}):([A-Za-z0-9_.-]{1,64})$/.exec(String(v || "").trim());
  if (!m || !MEDIA_SOURCES.includes(m[1])) throw new InputError("Say what the file belongs to (X-Media-Ref: message_attachment:<id>).", "x-media-ref");
  return { source: m[1], ref_id: m[2] };
}

// Stores one media file (§3.11: the content type comes from its magic
// bytes; anything outside JPEG/PNG/WebP/PDF is kept download-only).
// → { file_id, created }
export async function receiveMedia(ir, urlSha, bytes, { ref, ctx } = {}) {
  if (!SHA_RE.test(String(urlSha || ""))) throw new InputError("That isn't a media checksum.", "url_sha256");
  if (!bytes || !bytes.length) throw new InputError("That file is empty.", "file");
  if (bytes.length > MAX_MEDIA_BYTES) throw new InputError("That file is too big (4 MB at most).", "file");
  const { source, ref_id } = parseMediaRef(ref);
  const id = mediaFileId(urlSha);
  const marker = { file_id: id, bytes: bytes.length, at: nowIso() };
  const have = await getRecord("file", id);
  if (have) { await putRaw(mediaKey(ir.id, urlSha), marker); return { file_id: id, created: false }; }
  const sniffed = sniffType(bytes);
  const allowed = !!sniffed && STAFF_TYPES.includes(sniffed);
  const digest = sha256Hex(bytes);
  await putFileBytes(id, bytes, { ct: allowed ? sniffed : "application/octet-stream", bytes: bytes.length, sha256: digest });
  try {
    await createRecord("file", {
      id, kind: "import_media", content_type: sniffed || "application/octet-stream", bytes: bytes.length, sha256: digest,
      owner: { type: "import_run", id: ir.id }, customer_visible: false, has_thumb: false, source: "import",
      ...(allowed ? {} : { download_only: true }), rotor: { source, ref_id, url_sha256: urlSha },
    }, ctx);
  } catch (e) {
    if (!(e instanceof ExistsError)) throw e;
  }
  await putRaw(mediaKey(ir.id, urlSha), marker);
  return { file_id: id, created: true };
}
