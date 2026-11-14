#!/usr/bin/env node
// The photo copy tool for switch day (design §10.1 step 2, §10.9 runbook
// step 1; docs/CRM-CUTOVER.md "Photos and attachments").
//
//   node build/crm_media_copy.mjs <export-dir> --urls <media-urls.jsonl> --switch-day [--allow-host HOST] [--max-mb 25]
//
// A build script, never runtime code: the site never fetches a URL. On
// switch day (or before Rotor's subscription ends) it downloads the photos
// and attachments Rotor keeps in its file storage into <export-dir>/media/,
// the folder build/crm_import_pack.mjs reads, so the last pack carries them:
//
//   - <media-urls.jsonl>: one JSON object a line, { url, source, ref_id,
//     name? } (source "message_attachment" or "quote_photo": what the pack
//     takes; ref_id the Rotor message or quote id), written by the export
//     next to the entity files;
//   - each file is saved as media/<url_sha256> (sha256 of the URL) and listed
//     in media/index.jsonl as { url_sha256, source, ref_id, name,
//     content_type, bytes, file, sha256 } (docs/CRM-IMPORT.md's shape plus
//     the content's own checksum);
//   - run it again after an interruption: a file already saved whose
//     content still matches its checksum is kept, everything else is fetched
//     again; 3 tries a file on a network error, a 429 or a 5xx; a failure is
//     counted and listed (by checksum), never fatal;
//   - https only, only file-storage hosts (*.supabase.co, *.supabase.in, or
//     each --allow-host), never Rotor's app or API (it is a plain download of
//     files Rotor's export points at: nothing Rotor could notice, nothing
//     sent but the GET), never more than --max-mb a file, 4 at a time;
//   - it REFUSES to run without --switch-day (exit 2), and refuses (exit 2)
//     an export folder or URL list inside any worktree of this repository;
//   - it prints counts only (never a URL, a name or a ref id).

import { readFileSync, existsSync, mkdirSync, statSync } from "node:fs";
import { createHash } from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { insideAnyWorktree, writePrivate } from "./crm_backup_pull.mjs";

export const SOURCES = Object.freeze(["message_attachment", "quote_photo"]);
export const DEFAULT_HOSTS = Object.freeze([/\.supabase\.co$/i, /\.supabase\.in$/i]);
const NEVER = /(^|\.)getrotor\.com$/i;
const REF_RE = /^[A-Za-z0-9_.-]{1,64}$/;
const SHA_RE = /^[0-9a-f]{64}$/;
const TIMEOUT_MS = 30000;
const TRIES = 3;
const CONCURRENCY = 4;
const realSleep = (ms) => new Promise((r) => setTimeout(r, ms));
export const sha256 = (b) => createHash("sha256").update(b).digest("hex");

export function parseArgs(args) {
  const out = { positional: [], urls: null, switchDay: false, hosts: [], maxMb: 25, unknown: [] };
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === "--urls") out.urls = args[++i] || "";
    else if (a === "--switch-day") out.switchDay = true;
    else if (a === "--allow-host") out.hosts.push(String(args[++i] || "").toLowerCase());
    else if (a === "--max-mb") out.maxMb = Number(args[++i]);
    else if (a.startsWith("--")) out.unknown.push(a);
    else out.positional.push(a);
  }
  return out;
}

// Whether a URL may be fetched: https, a file-storage host, never Rotor's own.
export function urlAllowed(url, extraHosts = []) {
  let u;
  try { u = new URL(String(url)); } catch { return false; }
  if (u.protocol !== "https:" || u.username || u.password) return false;
  const host = u.hostname.toLowerCase();
  if (NEVER.test(host)) return false;
  return DEFAULT_HOSTS.some((re) => re.test(host)) || extraHosts.includes(host);
}

// The URL list → [{ url, url_sha256, source, ref_id, name }] and the lines it couldn't use.
export function readUrlList(file, extraHosts = []) {
  const out = { list: [], invalid: 0, refused: 0 };
  const seen = new Set();
  for (const line of readFileSync(file, "utf8").split("\n")) {
    if (!line.trim()) continue;
    let m;
    try { m = JSON.parse(line); } catch { out.invalid += 1; continue; }
    if (!m || typeof m.url !== "string" || !SOURCES.includes(m.source)) { out.invalid += 1; continue; }
    if (!urlAllowed(m.url, extraHosts)) { out.refused += 1; continue; }
    const h = sha256(m.url);
    if (seen.has(h)) continue;
    seen.add(h);
    out.list.push({ url: m.url, url_sha256: h, source: m.source, ref_id: REF_RE.test(String(m.ref_id || "")) ? String(m.ref_id) : "none", name: typeof m.name === "string" ? m.name.slice(0, 120) : "" });
  }
  return out;
}

// media/index.jsonl as it is: url_sha256 → row.
function readIndexFile(file) {
  const rows = new Map();
  if (!existsSync(file)) return rows;
  for (const line of readFileSync(file, "utf8").split("\n")) {
    if (!line.trim()) continue;
    try { const r = JSON.parse(line); if (r && SHA_RE.test(String(r.url_sha256))) rows.set(r.url_sha256, r); } catch { /* a broken line is fetched again */ }
  }
  return rows;
}

// Reads a response body up to max bytes. → Buffer | null (too big)
async function readCapped(res, max) {
  const len = Number(res.headers.get("content-length"));
  if (Number.isFinite(len) && len > max) return null;
  const buf = Buffer.from(await res.arrayBuffer());
  return buf.length > max ? null : buf;
}

// One file, with retries. → { ok, bytes?, content_type?, sha256?, code? }
async function fetchOne(item, { fetch: fetchFn, sleep, max }) {
  let last = "network";
  for (let i = 0; i < TRIES; i++) {
    let res;
    try {
      res = await fetchFn(item.url, { method: "GET", redirect: "error", signal: AbortSignal.timeout(TIMEOUT_MS) });
    } catch (e) {
      last = (e && e.name) || "network";
      await sleep(1000 * 3 ** i);
      continue;
    }
    if (res.status === 429 || res.status >= 500) { last = `http_${res.status}`; await sleep(1000 * 3 ** i); continue; }
    if (!res.ok) return { ok: false, code: `http_${res.status}` };
    const buf = await readCapped(res, max);
    if (!buf) return { ok: false, code: "too_big" };
    if (!buf.length) return { ok: false, code: "empty" };
    return { ok: true, buf, bytes: buf.length, content_type: String(res.headers.get("content-type") || "application/octet-stream").split(";")[0].trim().slice(0, 80), sha256: sha256(buf) };
  }
  return { ok: false, code: last };
}

// → { saved, kept, failed, failures: [{ url_sha256, code }], invalid, refused }
export async function copyMedia(exportDir, list, { fetch: fetchFn = globalThis.fetch, sleep = realSleep, maxBytes = 25 * 1024 * 1024, log = () => {} } = {}) {
  const mediaDir = path.join(exportDir, "media");
  mkdirSync(mediaDir, { recursive: true, mode: 0o700 });
  const indexFile = path.join(mediaDir, "index.jsonl");
  const index = readIndexFile(indexFile);
  const out = { saved: 0, kept: 0, failed: 0, failures: [] };
  const todo = [];
  for (const item of list) {
    const row = index.get(item.url_sha256);
    const file = path.join(mediaDir, item.url_sha256);
    // kept: saved before, and the bytes still match their checksum
    if (row && row.sha256 && existsSync(file) && statSync(file).size === row.bytes && sha256(readFileSync(file)) === row.sha256) { out.kept += 1; continue; }
    todo.push(item);
  }
  let next = 0;
  const worker = async () => {
    while (next < todo.length) {
      const item = todo[next++];
      const r = await fetchOne(item, { fetch: fetchFn, sleep, max: maxBytes });
      if (!r.ok) { out.failed += 1; out.failures.push({ url_sha256: item.url_sha256, code: r.code }); continue; }
      writePrivate(path.join(mediaDir, item.url_sha256), r.buf);
      index.set(item.url_sha256, { url_sha256: item.url_sha256, source: item.source, ref_id: item.ref_id, name: item.name, content_type: r.content_type, bytes: r.bytes, file: `media/${item.url_sha256}`, sha256: r.sha256 });
      out.saved += 1;
      if (out.saved % 25 === 0) log(`${out.saved} files saved`);
    }
  };
  await Promise.all(Array.from({ length: Math.min(CONCURRENCY, todo.length) }, worker));
  writePrivate(indexFile, [...index.values()].map((r) => JSON.stringify(r)).join("\n") + "\n");
  return out;
}

const USAGE = "usage: node build/crm_media_copy.mjs <export-dir> --urls <media-urls.jsonl> --switch-day [--allow-host HOST] [--max-mb 25]";

export async function main(argv = process.argv.slice(2), { log = console.log, error = console.error, fetch: fetchFn, sleep, roots } = {}) {
  const a = parseArgs(argv);
  const [dir] = a.positional;
  if (a.unknown.length || !dir || a.positional.length > 1 || !a.urls || !(a.maxMb > 0 && a.maxMb <= 100)) { error(USAGE); return 2; }
  if (!a.switchDay) { error("Refusing: this downloads Rotor's files and is for switch day only. Add --switch-day when the runbook says so."); return 2; }
  const inside = (p) => (roots ? insideAnyWorktree(p, roots) : insideAnyWorktree(p));
  if (inside(dir) || inside(a.urls)) { error("Refusing: the export folder and the URL list must be outside every worktree of this repository, like ~/barta-private/rotor-export."); return 2; }
  if (!existsSync(a.urls)) { error("Can't read the URL list."); return 1; }
  const urls = readUrlList(a.urls, a.hosts);
  log(JSON.stringify({ urls: urls.list.length, invalid_lines: urls.invalid, refused_hosts: urls.refused }));
  const r = await copyMedia(dir, urls.list, { fetch: fetchFn || globalThis.fetch, sleep, maxBytes: Math.round(a.maxMb * 1024 * 1024), log });
  log(JSON.stringify({ saved: r.saved, kept: r.kept, failed: r.failed, failures_by_code: r.failures.reduce((m, f) => ({ ...m, [f.code]: (m[f.code] || 0) + 1 }), {}) }));
  log(r.failed ? `${r.failed} files failed: run it again later (saved files are kept)` : "every file is in: pack the export again to carry them");
  return 0;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main().then((code) => process.exit(code));
