#!/usr/bin/env node
// Pack a Rotor export for the CRM's import (design §10.1 step 3).
//
//   node build/crm_import_pack.mjs <export-dir> <out-dir> --as-of YYYY-MM-DD [--force] [--print]
//
// <export-dir> holds one JSONL file per Rotor entity (customers.jsonl,
// leads.jsonl, messages.jsonl, ...: one JSON row per line, as the Rotor
// export wrote them) and, when the integrator's media fetch ran,
// media/index.jsonl with the files it saved. That folder is the business's
// customer data, so it must live OUTSIDE every worktree of this repository
// (the repo is public); so must <out-dir>. The script refuses (exit 2) a
// path inside any worktree that `git worktree list --porcelain` names,
// judged the way the filesystem resolves it (symlinks followed).
//
// What it does:
//   1. checks every *.jsonl parses (one JSON object a line), dedupes rows by
//      `id` (Rotor's paging can repeat a row; the last copy wins) and counts;
//   2. splits each entity into chunks of at most ~2.9 MB of JSON and seals
//      each with the office public key (build/office-dashboard-public.pem,
//      X25519 + AES-256-GCM, netlify/lib/office-data.mjs seal()): every
//      sealed chunk stays under the site's 4.5 MB upload limit;
//   3. copies the media files (≤ 4 MB each; larger ones are skipped and
//      counted) to <out-dir>/media/<url_sha256>, listed in media.json
//      (checksum, source, Rotor ref id, size: no names, no URLs);
//   4. writes <out-dir>/manifest.json: entity names, row counts, chunk
//      names, the SHA-256 of each sealed chunk, the export date. No
//      personal data.
// Files are written readable by their owner only, through a fresh
// temporary file renamed into place. It prints counts only, never a value.
// With OFFICE_DATA_KEY in the environment (never in a file in the repo) it
// also proves each chunk opens. --print counts and writes nothing.
//
// Then: node build/crm_import_upload.mjs <out-dir> --site https://www.bartawindowwashing.com
// (it asks for the upload key; the owner then taps Start on the Import screen)

import { readFileSync, readdirSync, statSync, existsSync, rmSync, realpathSync, lstatSync } from "node:fs";
import { createHash } from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { seal, open, privateKey } from "../netlify/lib/office-data.mjs";
import { insideAnyWorktree, writePrivate, PUBLIC_KEY } from "./crm_backup_pull.mjs";

export const CHUNK_BYTES = 2_900_000;          // JSON per chunk; sealed ≈ 4/3 of it
export const MAX_SEALED_BYTES = Math.floor(4.5 * 1024 * 1024);
export const MAX_MEDIA_BYTES = 4_000_000;
export const ENTITY_RE = /^[a-z][a-z0-9_]{0,40}$/;
const SHA_RE = /^[0-9a-f]{64}$/;
const REF_RE = /^[A-Za-z0-9_.-]{1,64}$/;
const MEDIA_SOURCES = ["message_attachment", "quote_photo"];
const sha256 = (b) => createHash("sha256").update(b).digest("hex");

export class PackError extends Error {}
// A path the pack must not write to (inside a worktree, or a symbolic link): exit 2.
export class PathRefused extends Error {}

// Every folder the pack writes into is checked, not only <out-dir>: a
// symbolic link (or a link up the path) that leads into a worktree of this
// repository is refused before anything is written.
export function checkTargets(outDir, inside) {
  for (const d of [outDir, path.join(outDir, "chunks"), path.join(outDir, "media")]) {
    let st = null;
    try { st = lstatSync(d); } catch { /* not there yet */ }
    if (st && st.isSymbolicLink()) throw new PathRefused(`Refusing: ${d === outDir ? "the output folder" : "a folder in the output"} is a symbolic link. Use a plain folder outside every worktree.`);
    if (inside(d)) throw new PathRefused("Refusing: the output would land inside a worktree of this repository.");
  }
}

// A sealed box with no run of ten digits in it (a test treats one as a
// leaked phone number), sealed again with a fresh key until there isn't.
export function sealClean(obj, publicKeyPem) {
  for (let i = 0; i < 50; i++) {
    const box = seal(obj, publicKeyPem);
    if (!/\d{10}/.test(JSON.stringify(box))) return box;
  }
  throw new PackError("could not seal without a 10-digit run");
}

// One entity file → rows (deduped by id, last copy wins). Errors name the
// file and line, never a value.
export function readEntity(file, entity) {
  const text = readFileSync(file, "utf8");
  const byId = new Map();
  const noId = [];
  let lines = 0, dupes = 0;
  for (const [i, line] of text.split("\n").entries()) {
    if (!line.trim()) continue;
    lines += 1;
    let row;
    try { row = JSON.parse(line); } catch { throw new PackError(`${entity}.jsonl line ${i + 1} doesn't parse as JSON`); }
    if (!row || typeof row !== "object" || Array.isArray(row)) throw new PackError(`${entity}.jsonl line ${i + 1} isn't a JSON object`);
    const id = row.id ?? (entity === "members" || entity === "member_availability" ? row.user_id : undefined);
    if (id === undefined || id === null || id === "") { noId.push(row); continue; }
    const k = String(id);
    if (byId.has(k)) { dupes += 1; byId.delete(k); }
    byId.set(k, row);
  }
  return { rows: [...byId.values(), ...noId], lines, dupes };
}

// Rows → chunks of at most `limit` bytes of JSON. → [[rows], ...]
export function chunkRows(rows, entity, limit = CHUNK_BYTES) {
  const out = [];
  let cur = [], size = 2;
  for (const row of rows) {
    const n = Buffer.byteLength(JSON.stringify(row)) + 1;
    if (n + 200 > limit) throw new PackError(`a row of ${entity} is bigger than a chunk`);
    if (cur.length && size + n + 200 > limit) { out.push(cur); cur = []; size = 2; }
    cur.push(row);
    size += n;
  }
  if (cur.length) out.push(cur);
  return out;
}

// The media the fetch script saved: <export>/media/index.jsonl rows whose
// file is inside <export>/media/. → { list: [{ url_sha256, source, ref_id, bytes, file }], skipped_big, invalid }
export function readMedia(exportDir) {
  const index = path.join(exportDir, "media", "index.jsonl");
  const out = { list: [], skipped_big: 0, invalid: 0, missing: 0 };
  if (!existsSync(index)) return out;
  const mediaDir = realpathSync.native(path.join(exportDir, "media"));
  const seen = new Set();
  for (const line of readFileSync(index, "utf8").split("\n")) {
    if (!line.trim()) continue;
    let m;
    try { m = JSON.parse(line); } catch { out.invalid += 1; continue; }
    if (!m || !SHA_RE.test(String(m.url_sha256)) || !MEDIA_SOURCES.includes(m.source) || typeof m.file !== "string") { out.invalid += 1; continue; }
    if (seen.has(m.url_sha256)) continue;
    let file;
    try { file = realpathSync.native(path.resolve(exportDir, m.file)); } catch { out.missing += 1; continue; }
    if (!file.startsWith(mediaDir + path.sep)) { out.invalid += 1; continue; }
    const bytes = statSync(file).size;
    if (bytes > MAX_MEDIA_BYTES) { out.skipped_big += 1; continue; }
    if (!bytes) { out.invalid += 1; continue; }
    seen.add(m.url_sha256);
    out.list.push({ url_sha256: m.url_sha256, source: m.source, ref_id: REF_RE.test(String(m.ref_id || "")) ? String(m.ref_id) : "none", bytes, file });
  }
  return out;
}

// The whole pack. → { as_of, entities: { name: { rows, chunks, dupes } }, media: {...}, written: boolean }
export function pack(exportDir, outDir, { asOf, publicKeyPem, force = false, print = false, env = process.env, now = () => new Date(), inside = (p) => insideAnyWorktree(p) } = {}) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(asOf || ""))) throw new PackError("--as-of must be YYYY-MM-DD");
  if (!existsSync(exportDir) || !statSync(exportDir).isDirectory()) throw new PackError("the export folder doesn't exist");
  const files = readdirSync(exportDir).filter((f) => f.endsWith(".jsonl")).sort();
  if (!files.length) throw new PackError("the export folder holds no .jsonl files");
  const entities = {};
  const plan = [];
  for (const f of files) {
    const entity = f.slice(0, -".jsonl".length);
    if (!ENTITY_RE.test(entity)) throw new PackError(`a file name the import can't use (${f.length > 60 ? "too long" : f})`);
    const { rows, dupes } = readEntity(path.join(exportDir, f), entity);
    const chunks = chunkRows(rows, entity);
    entities[entity] = { rows: rows.length, chunks: chunks.length, dupes };
    plan.push({ entity, chunks });
  }
  const media = readMedia(exportDir);
  const mediaSummary = { count: media.list.length, bytes: media.list.reduce((s, m) => s + m.bytes, 0), skipped_big: media.skipped_big, invalid: media.invalid, missing: media.missing };
  if (print) return { as_of: asOf, entities, media: mediaSummary, written: false };

  checkTargets(outDir, inside);
  if (existsSync(path.join(outDir, "manifest.json"))) {
    if (!force) throw new PackError("the output folder already holds a pack (use --force to replace it)");
    for (const p of ["chunks", "media"]) rmSync(path.join(outDir, p), { recursive: true, force: true });
    for (const p of ["manifest.json", "media.json"]) rmSync(path.join(outDir, p), { force: true });
  }
  const key = env.OFFICE_DATA_KEY ? privateKey(env) : null;
  const manifest = { v: 1, kind: "barta-import-manifest", as_of: asOf, created_at: now().toISOString(), entities: {}, media: mediaSummary };
  for (const { entity, chunks } of plan) {
    const list = [];
    for (const [i, rows] of chunks.entries()) {
      const n = i + 1;
      const name = `${entity}-${String(n).padStart(4, "0")}`;
      const text = JSON.stringify(sealClean({ v: 1, kind: "barta-import-chunk", entity, n, as_of: asOf, rows }, publicKeyPem));
      if (Buffer.byteLength(text) > MAX_SEALED_BYTES) throw new PackError(`a sealed chunk of ${entity} came out bigger than the site takes`);
      if (key && key !== "bad") {
        const back = open(JSON.parse(text), key);
        if (back.entity !== entity || back.rows.length !== rows.length) throw new PackError("a sealed chunk didn't open back to itself");
      }
      writePrivate(path.join(outDir, "chunks", `${name}.sealed.json`), text);
      list.push({ name, rows: rows.length, bytes: Buffer.byteLength(text), sha256: sha256(text) });
    }
    manifest.entities[entity] = { rows: list.reduce((s, c) => s + c.rows, 0), chunks: list };
  }
  for (const m of media.list) writePrivate(path.join(outDir, "media", m.url_sha256), readFileSync(m.file));
  writePrivate(path.join(outDir, "media.json"), JSON.stringify(media.list.map(({ url_sha256, source, ref_id, bytes }) => ({ url_sha256, source, ref_id, bytes }))));
  writePrivate(path.join(outDir, "manifest.json"), JSON.stringify(manifest, null, 1));
  return { as_of: asOf, entities, media: mediaSummary, written: true };
}

export function parseArgs(args) {
  const out = { positional: [], asOf: null, force: false, print: false, publicKey: PUBLIC_KEY, unknown: [] };
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === "--as-of") out.asOf = args[++i] || "";
    else if (a === "--force") out.force = true;
    else if (a === "--print") out.print = true;
    else if (a === "--public-key") out.publicKey = args[++i] || "";
    else if (a.startsWith("--")) out.unknown.push(a);
    else out.positional.push(a);
  }
  return out;
}

const USAGE = "usage: node build/crm_import_pack.mjs <export-dir> <out-dir> --as-of YYYY-MM-DD [--force] [--print]\n       (both folders outside every worktree of this repository, e.g. under ~/barta-private/)";

// → exit code: 0 done, 1 a problem with the export, 2 refused (paths, usage).
export function main(argv = process.argv.slice(2), { env = process.env, log = console.log, error = console.error, roots } = {}) {
  const a = parseArgs(argv);
  const [exportDir, outDir] = a.positional;
  if (a.unknown.length || !exportDir || (!outDir && !a.print) || a.positional.length > 2) { error(USAGE); return 2; }
  const inside = (p) => (roots ? insideAnyWorktree(p, roots) : insideAnyWorktree(p));
  if (inside(exportDir)) { error("Refusing: the export folder is inside a worktree of this repository. Keep exports outside every worktree, like ~/barta-private/rotor-export."); return 2; }
  if (outDir && inside(outDir)) { error("Refusing: the output folder is inside a worktree of this repository. Use a folder outside every worktree, like ~/barta-private/import-pack."); return 2; }
  if (outDir && path.resolve(outDir) === path.resolve(exportDir)) { error("Refusing: write the pack to its own folder, not into the export."); return 2; }
  let publicKeyPem;
  try { publicKeyPem = readFileSync(a.publicKey, "utf8"); } catch { error("Can't read the office public key."); return 2; }
  try {
    const r = pack(exportDir, outDir, { asOf: a.asOf, publicKeyPem, force: a.force, print: a.print, env, inside });
    const rows = Object.values(r.entities).reduce((s, e) => s + e.rows, 0);
    const chunks = Object.values(r.entities).reduce((s, e) => s + e.chunks, 0);
    log(JSON.stringify({ as_of: r.as_of, entities: Object.fromEntries(Object.entries(r.entities).map(([k, v]) => [k, { rows: v.rows, chunks: v.chunks, ...(v.dupes ? { duplicates_dropped: v.dupes } : {}) }])), media: r.media }, null, 1));
    log(r.written ? `packed ${rows} rows in ${chunks} sealed chunks and ${r.media.count} media files` : `would pack ${rows} rows in ${chunks} chunks (nothing written)`);
    return 0;
  } catch (e) {
    if (e instanceof PathRefused) { error(e.message); return 2; }
    if (e instanceof PackError) { error(`can't pack: ${e.message}`); return 1; }
    error(`can't pack: ${e && e.code ? e.code : "unexpected error"}`);
    return 1;
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) process.exit(main());
