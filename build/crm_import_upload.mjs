#!/usr/bin/env node
// Upload a pack to the CRM's import (design §10.1 step 4, §10.10).
//
//   node build/crm_import_upload.mjs <pack-dir> --site https://www.bartawindowwashing.com [--key-file FILE] [--start] [--no-media]
//
// <pack-dir> is what build/crm_import_pack.mjs wrote (manifest.json, the
// sealed chunks, media/ and media.json), outside every worktree of this
// repository. The key is the one-run upload key an owner made on the
// Import screen (More → Import from Rotor → Start an import; shown once,
// good for 24 hours, only for that run). It is asked for at a prompt that
// doesn't show what is typed (or pasted), so it never lands in the shell's
// history; --key-file FILE reads it from a file outside every worktree, and
// CRM_UPLOAD_KEY in the environment still works. It is never printed.
//
// It asks the site what the run already has, sends the manifest, then each
// sealed chunk the site doesn't have yet (PUT, with X-Content-SHA256, three
// tries on a network error or a 5xx), then each media file the site doesn't
// already hold. It does NOT start the run: the owner checks the team map on
// the Import screen and taps Start (--start starts it from here instead).
// Run it again after an interruption: it picks up where it stopped. Media
// are uploaded from here; the site never fetches a URL. Output is counts only.

import { readFileSync, existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { insideAnyWorktree } from "./crm_backup_pull.mjs";

export const SITE = "https://www.bartawindowwashing.com";
export const KEY_RE = /^bimp_[0-9A-Za-z]{32}$/;
const TIMEOUT_MS = 60000;
const TRIES = 3;
const realSleep = (ms) => new Promise((r) => setTimeout(r, ms));

export function parseArgs(args) {
  const out = { positional: [], site: null, start: false, media: true, keyFile: null, unknown: [] };
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === "--site") out.site = args[++i] || "";
    else if (a === "--start") out.start = true;
    else if (a === "--no-start") out.start = false;
    else if (a === "--key-file") out.keyFile = args[++i] || "";
    else if (a === "--no-media") out.media = false;
    else if (a.startsWith("--")) out.unknown.push(a);
    else out.positional.push(a);
  }
  return out;
}

// The production site, or a local test server (http://localhost:PORT).
export function siteOk(site) {
  const s = String(site || "").replace(/\/+$/, "");
  return s === SITE || /^http:\/\/(localhost|127\.0\.0\.1):\d{2,5}$/.test(s);
}

export class UploadError extends Error {
  constructor(message, status = 0) { super(message); this.status = status; }
}

// One call with retries on network errors, 429 and 5xx. → parsed JSON data (or null)
async function call(io, method, p, { body, headers = {}, raw = false } = {}) {
  let last = null;
  for (let i = 0; i < TRIES; i++) {
    let res;
    try {
      res = await io.fetch(io.site + "/api/crm" + p, {
        method,
        headers: { authorization: `Bearer ${io.key}`, ...(body !== undefined && !raw ? { "content-type": "application/json" } : {}), ...headers },
        ...(body !== undefined ? { body: raw ? body : JSON.stringify(body) } : {}),
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
    } catch (e) {
      last = new UploadError(`no answer from the site (${(e && e.name) || "network"})`);
      await io.sleep(1000 * 3 ** i);
      continue;
    }
    let json = null;
    try { json = await res.json(); } catch { /* not JSON */ }
    if (res.ok && json && json.ok) return json.data;
    const err = json && json.error ? json.error : {};
    last = new UploadError(`the site answered ${res.status}${err.code ? " " + err.code : ""}${err.message ? ": " + err.message : ""}`, res.status);
    if (res.status === 429 || res.status >= 500) { await io.sleep(1000 * 3 ** i); continue; }
    throw last;
  }
  throw last;
}

// → { run_id, chunks: { sent, had }, media: { sent, had, skipped }, started }
export async function upload(outDir, { site, key, start = false, media = true, fetch: fetchFn = globalThis.fetch, sleep = realSleep, log = () => {} }) {
  const io = { site: String(site).replace(/\/+$/, ""), key, fetch: fetchFn, sleep };
  const manifestFile = path.join(outDir, "manifest.json");
  if (!existsSync(manifestFile)) throw new UploadError("there is no manifest.json in that folder (run crm_import_pack.mjs first)");
  const manifest = JSON.parse(readFileSync(manifestFile, "utf8"));
  const info = await call(io, "GET", "/import/upload");
  const runId = info.run_id;
  if (info.status !== "uploading") {
    log(`run ${runId} is ${info.status}: nothing to upload`);
    return { run_id: runId, chunks: { sent: 0, had: 0 }, media: { sent: 0, had: 0, skipped: 0 }, started: false, status: info.status };
  }
  await call(io, "PUT", `/import/runs/${runId}/manifest`, { body: manifest });
  const have = new Set(info.received.chunks);
  const out = { run_id: runId, chunks: { sent: 0, had: 0 }, media: { sent: 0, had: 0, skipped: 0 }, started: false };
  const names = Object.values(manifest.entities).flatMap((e) => e.chunks.map((c) => c));
  for (const c of names) {
    if (have.has(c.name)) { out.chunks.had += 1; continue; }
    const bytes = readFileSync(path.join(outDir, "chunks", `${c.name}.sealed.json`));
    await call(io, "PUT", `/import/runs/${runId}/chunks/${c.name}`, { body: bytes, raw: true, headers: { "content-type": "application/json", "x-content-sha256": c.sha256 } });
    out.chunks.sent += 1;
    if (out.chunks.sent % 10 === 0) log(`${out.chunks.sent} chunks sent`);
  }
  log(`chunks: ${out.chunks.sent} sent, ${out.chunks.had} were already there`);
  if (media && existsSync(path.join(outDir, "media.json"))) {
    const list = JSON.parse(readFileSync(path.join(outDir, "media.json"), "utf8"));
    const onSite = new Set(info.received.media);
    for (let i = 0; i < list.length; i += 500) {
      const batch = list.slice(i, i + 500).map((m) => m.url_sha256);
      const r = await call(io, "POST", `/import/runs/${runId}/media-check`, { body: { hashes: batch } });
      for (const h of r.have) onSite.add(h);
    }
    for (const m of list) {
      if (onSite.has(m.url_sha256)) { out.media.had += 1; continue; }
      const file = path.join(outDir, "media", m.url_sha256);
      if (!existsSync(file)) { out.media.skipped += 1; continue; }
      await call(io, "PUT", `/import/runs/${runId}/media/${m.url_sha256}`, { body: readFileSync(file), raw: true, headers: { "content-type": "application/octet-stream", "x-media-ref": `${m.source}:${m.ref_id || "none"}` } });
      out.media.sent += 1;
    }
    log(`media: ${out.media.sent} sent, ${out.media.had} were already there, ${out.media.skipped} missing`);
  }
  if (start) {
    await call(io, "POST", `/import/runs/${runId}/start`, { body: {} });
    out.started = true;
  }
  return out;
}

const USAGE = "usage: node build/crm_import_upload.mjs <pack-dir> --site https://www.bartawindowwashing.com [--key-file FILE] [--start] [--no-media]\n       (it asks for the upload key the Import screen showed; CRM_UPLOAD_KEY also works)";

// Reads a line from the terminal without showing it (the key is pasted, not typed for others to see).
export function promptHidden(question, { input = process.stdin, output = process.stderr } = {}) {
  return new Promise((resolve) => {
    if (!input.isTTY) {
      // piped in: the first line
      let buf = "";
      input.setEncoding("utf8");
      input.on("data", (d) => { buf += d; });
      input.on("end", () => resolve(buf.split(/\r?\n/)[0].trim()));
      return;
    }
    output.write(question);
    input.setRawMode(true);
    input.resume();
    input.setEncoding("utf8");
    let value = "";
    const done = (v) => { input.setRawMode(false); input.pause(); input.removeListener("data", onData); output.write("\n"); resolve(v); };
    const onData = (chunk) => {
      for (const ch of chunk) {
        if (ch === "\r" || ch === "\n") return done(value.trim());
        if (ch === "\u0003") return done("");              // Ctrl-C
        if (ch === "\u007f" || ch === "\b") value = value.slice(0, -1);
        else value += ch;
      }
    };
    input.on("data", onData);
  });
}

// The key: --key-file, CRM_UPLOAD_KEY, else the hidden prompt.
async function readKey(a, env, { roots, ask }) {
  if (a.keyFile) {
    if (roots ? insideAnyWorktree(a.keyFile, roots) : insideAnyWorktree(a.keyFile)) return { refused: "Refusing: the key file is inside a worktree of this repository. Keep it outside, or let the script ask for the key." };
    try { return { key: readFileSync(a.keyFile, "utf8").trim() }; } catch { return { refused: "Can't read the key file." }; }
  }
  if (env.CRM_UPLOAD_KEY) return { key: String(env.CRM_UPLOAD_KEY).trim() };
  return { key: String(await ask("Upload key (from the Import screen; it won't show): ")).trim() };
}

export async function main(argv = process.argv.slice(2), { env = process.env, log = console.log, error = console.error, fetch: fetchFn, sleep, roots, ask = promptHidden } = {}) {
  const a = parseArgs(argv);
  const [dir] = a.positional;
  if (a.unknown.length || !dir || a.positional.length > 1 || !siteOk(a.site) || a.keyFile === "") { error(USAGE); return 2; }
  if (roots ? insideAnyWorktree(dir, roots) : insideAnyWorktree(dir)) { error("Refusing: the pack folder is inside a worktree of this repository. Keep it outside every worktree, like ~/barta-private/import-pack."); return 2; }
  const k = await readKey(a, env, { roots, ask });
  if (k.refused) { error(k.refused); return 2; }
  const key = k.key;
  if (!KEY_RE.test(key)) { error("That isn't an upload key (bimp_ and 32 letters and digits, from the Import screen)."); return 2; }
  try {
    const r = await upload(dir, { site: a.site, key, start: a.start, media: a.media, fetch: fetchFn || globalThis.fetch, sleep, log });
    log(JSON.stringify(r));
    log(r.started ? `run ${r.run_id} started: watch it on the Import screen` : r.status && r.status !== "uploading" ? `run ${r.run_id} is ${r.status}` : `run ${r.run_id}: uploaded. Check the team on the Import screen, then tap Start the import.`);
    return 0;
  } catch (e) {
    error(`upload stopped: ${String((e && e.message) || "unexpected error").replace(/bimp_[0-9A-Za-z]+/g, "bimp_…")}`);
    return 1;
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main().then((code) => process.exit(code));
