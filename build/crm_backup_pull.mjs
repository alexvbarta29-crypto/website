#!/usr/bin/env node
// The CRM's off-site backup copy, by hand (design §3.12 "Off-site copy").
//
//   CRM_BACKUP_KEY=bcrm_... node build/crm_backup_pull.mjs --site https://www.bartawindowwashing.com [--out DIR] [--date YYYY-MM-DD]
//
// A site deletion, a bad deleteAll or a stolen token could take the `crm`
// and `crm-backups` stores together, so once a week a copy leaves Netlify.
// Until the Google Drive upload exists (GOOGLE_DRIVE_REFRESH_TOKEN, owner
// action D43), the integrator runs this with an owner's BACKUP key
// (My account → API keys → kind "backup": it can read the nightly
// snapshots and nothing else). It:
//
//   1. lists the snapshots (GET /api/crm/admin/backups) and takes the
//      newest finished one (or --date);
//   2. downloads every part (GET /api/crm/admin/export?date=&partition=&part=),
//      seals each with the office public key (build/office-dashboard-public.pem,
//      the same X25519 + AES-256-GCM box as the dashboard snapshot) and
//      writes it under DIR/{date}/{partition}/part-{nnnn}.sealed.json,
//      with DIR/{date}/manifest.sealed.json;
//   3. tells the site the copy exists (POST /api/crm/admin/backups/{date}/pulled),
//      which clears the "no off-site copy" alert.
//
// DIR defaults to ~/barta-private/backups and must be OUTSIDE every
// worktree of this repository (exit 2 otherwise): the parts hold every
// customer record. Only the server's OFFICE_DATA_KEY opens them, so the
// owners keep that key and CRM_KEY_SALT in a password manager outside
// Netlify (D44). The key comes from the environment, never an argument
// (shell history), and is never printed. Output is counts only.

import { mkdirSync, writeFileSync, renameSync, unlinkSync, realpathSync, readFileSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { spawnSync } from "node:child_process";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { seal } from "../netlify/lib/office-data.mjs";

export const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
export const PUBLIC_KEY = path.join(ROOT, "build/office-dashboard-public.pem");
export const DEFAULT_OUT = path.join(os.homedir(), "barta-private", "backups");
const TIMEOUT_MS = 30000;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const NAME_RE = /^[a-z][a-z0-9_-]{0,60}$/;

// ------------------------------------------------------------ private paths

// Would `file` be inside `root` once symlinks are followed? The deepest
// ancestor that exists decides (a folder that doesn't exist yet is judged
// by where it would be).
export function insideRepo(file, root = ROOT) {
  const real = (p) => { try { return realpathSync.native(p); } catch { return null; } };
  const rootReal = real(root) || path.resolve(root);
  let p = path.resolve(file);
  let rest = "";
  for (;;) {
    const r = real(p);
    if (r) { p = path.join(r, rest); break; }
    const parent = path.dirname(p);
    if (parent === p) break;
    rest = path.join(path.basename(p), rest);
    p = parent;
  }
  return p === rootReal || p.startsWith(rootReal + path.sep);
}

// Every worktree of this repository (git worktree list --porcelain), plus this checkout.
export function worktreeRoots(root = ROOT) {
  const out = new Set([root]);
  const r = spawnSync("git", ["worktree", "list", "--porcelain"], { cwd: root, encoding: "utf8" });
  if (r.status === 0) for (const line of r.stdout.split("\n")) if (line.startsWith("worktree ")) out.add(line.slice(9).trim());
  return [...out];
}
export const insideAnyWorktree = (file, roots = worktreeRoots()) => roots.some((r) => insideRepo(file, r));

// Writes through a fresh temporary file renamed into place (never through
// a link), readable by its owner only.
export function writePrivate(target, text) {
  mkdirSync(path.dirname(target), { recursive: true, mode: 0o700 });
  const tmp = `${target}.${randomBytes(6).toString("hex")}.tmp`;
  writeFileSync(tmp, text, { flag: "wx", mode: 0o600 });
  try { renameSync(tmp, target); } catch (e) { try { unlinkSync(tmp); } catch {} throw e; }
}

// ------------------------------------------------------------ arguments

// The key only ever goes to the CRM's own site.
export const SITE = "https://www.bartawindowwashing.com";

export function parseArgs(args) {
  const out = { site: null, out: DEFAULT_OUT, date: null, mark: true, publicKey: PUBLIC_KEY, unknown: [] };
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === "--site") out.site = args[++i] || "";
    else if (a === "--out") out.out = args[++i] || "";
    else if (a === "--date") out.date = args[++i] || "";
    else if (a === "--no-mark") out.mark = false;
    else if (a === "--public-key") out.publicKey = args[++i] || "";
    else out.unknown.push(a);
  }
  return out;
}

// ------------------------------------------------------------ the pull

async function call(fetchFn, site, key, p, { method = "GET", json = true } = {}) {
  const res = await fetchFn(site.replace(/\/+$/, "") + "/api/crm" + p, {
    method,
    headers: { authorization: `Bearer ${key}`, ...(method === "POST" ? { "content-type": "application/json" } : {}) },
    ...(method === "POST" ? { body: "{}" } : {}),
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  if (!res.ok) {
    let code = "";
    try { code = (await res.json()).error.code; } catch { /* not JSON */ }
    throw new Error(`the site answered ${res.status}${code ? " " + code : ""} for ${p.split("?")[0]}`);
  }
  return json ? (await res.json()).data : res.text();
}

// → { date, partitions, parts, keys, bytes, dir }
export async function pull({ site, key, out, date, mark = true, publicKeyPem, fetchFn = globalThis.fetch, log = () => {} }) {
  const manifests = await call(fetchFn, site, key, "/admin/backups");
  const chosen = date ? manifests.find((m) => m.date === date) : manifests.find((m) => m.ok);
  if (!chosen || !chosen.ok) throw new Error(date ? `no finished snapshot for ${date}` : "no finished snapshot yet");
  const manifest = await call(fetchFn, site, key, `/admin/export?date=${chosen.date}`);
  if (!DATE_RE.test(manifest.date) || !Array.isArray(manifest.partitions)) throw new Error("the manifest isn't valid");
  const dir = path.join(out, manifest.date);
  let parts = 0;
  let bytes = 0;
  for (const p of manifest.partitions) {
    if (!NAME_RE.test(p.name)) throw new Error("the manifest names a partition it shouldn't");
    for (let n = 1; n <= (p.parts || 0); n++) {
      const text = await call(fetchFn, site, key, `/admin/export?date=${manifest.date}&partition=${p.name}&part=${n}`, { json: false });
      const box = seal({ v: 1, date: manifest.date, partition: p.name, part: n, text }, publicKeyPem);
      writePrivate(path.join(dir, p.name, `part-${String(n).padStart(4, "0")}.sealed.json`), JSON.stringify(box));
      parts += 1;
      bytes += Buffer.byteLength(text);
    }
    log(`${p.name}: ${p.parts || 0} part(s), ${p.keys || 0} keys`);
  }
  writePrivate(path.join(dir, "manifest.sealed.json"), JSON.stringify(seal({ v: 1, manifest }, publicKeyPem)));
  if (mark) await call(fetchFn, site, key, `/admin/backups/${manifest.date}/pulled`, { method: "POST" });
  return { date: manifest.date, partitions: manifest.partitions.length, parts, keys: manifest.keys, bytes, dir };
}

export async function main(argv = process.argv.slice(2), env = process.env, io = { log: console.log, error: console.error }) {
  const a = parseArgs(argv);
  if (a.unknown.length || !a.site || a.site.replace(/\/+$/, "") !== SITE || (a.date && !DATE_RE.test(a.date))) {
    io.error("usage: CRM_BACKUP_KEY=bcrm_... node build/crm_backup_pull.mjs --site https://www.bartawindowwashing.com [--out DIR] [--date YYYY-MM-DD] [--no-mark]");
    return 1;
  }
  const key = String(env.CRM_BACKUP_KEY || "");
  if (!/^bcrm_[0-9A-Za-z]{32}$/.test(key)) { io.error("Set CRM_BACKUP_KEY to an owner's backup key (My account → API keys)."); return 1; }
  if (!a.out || insideAnyWorktree(a.out)) { io.error("Refusing: the output folder is inside the repository. Use a folder outside every worktree, like ~/barta-private/backups."); return 2; }
  let publicKeyPem;
  try { publicKeyPem = readFileSync(a.publicKey, "utf8"); } catch { io.error("Can't read the office public key."); return 1; }
  try {
    const r = await pull({ site: a.site, key, out: a.out, date: a.date, mark: a.mark, publicKeyPem, log: io.log });
    io.log(`pulled ${r.date}: ${r.partitions} partitions, ${r.parts} parts, ${r.keys} keys, ${r.bytes} bytes, sealed`);
    return 0;
  } catch (e) {
    io.error(`pull failed: ${String(e && e.message).replace(/bcrm_[0-9A-Za-z]+/g, "bcrm_…")}`);
    return 1;
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main().then((code) => process.exit(code));
