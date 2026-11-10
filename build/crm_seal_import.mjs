#!/usr/bin/env node
// Seal Rotor's customer export for Barta Office → Customers (docs/CRM.md).
//
//   node build/crm_seal_import.mjs <export-dir> <out.sealed.json> [--as-of YYYY-MM-DD]
//   node build/crm_seal_import.mjs <export-dir> --print
//
// <export-dir> holds customers.jsonl and members.jsonl: one JSON row per
// line, exactly as Rotor's list_customers / list_company_members returned
// them. That folder is the business's customer list, so it lives OUTSIDE the
// repo (the repo is public). This script checks and trims the rows exactly
// as the site will (normalizeBundle in netlify/lib/crm-data.mjs: the fields
// the page uses, within its limits; member emails and roles dropped), so a
// file that seals is a file the site takes. It encrypts the result with the
// office public key (build/office-dashboard-public.pem) and writes the
// sealed box as JSON to <out.sealed.json>, which must ALSO be outside the
// repo: customer data, even encrypted, is never committed (the script
// refuses, exit 2, also through symlinks). The owner then uploads that one
// file in the app (Customers → Import); the site opens it with
// OFFICE_DATA_KEY and keeps the rows in Netlify Blobs.
//
// --print writes counts and field names to stdout and seals nothing. Set
// OFFICE_DATA_KEY in the environment (never in a file in the repo) and the
// script also proves the sealed file opens with it. Output is counts only,
// never a name or a number.

import { readFileSync, writeFileSync, existsSync, realpathSync, lstatSync, renameSync, unlinkSync } from "node:fs";
import { randomBytes } from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { seal, open, privateKey } from "../netlify/lib/office-data.mjs";
import { normalizeBundle } from "../netlify/lib/crm-data.mjs";

export const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const PUBLIC_KEY = path.join(ROOT, "build/office-dashboard-public.pem");

export const readJsonl = (file) => readFileSync(file, "utf8").split("\n").filter((l) => l.trim()).map((l) => JSON.parse(l));

// Rotor hands back a few names double-encoded ("Oâ€™Connor": UTF-8 bytes read
// as Latin-1). Undo that when every character fits in a byte and the round
// trip decodes cleanly; leave everything else exactly as exported.
export function fixMojibake(s) {
  if (typeof s !== "string" || !/[Â-ô][\u0080-¿]/.test(s) || /[^\u0000-ÿ]/.test(s)) return s;
  const fixed = Buffer.from(s, "latin1").toString("utf8");
  return fixed.includes("�") ? s : fixed;
}

export function clean(v) {
  if (typeof v === "string") return fixMojibake(v);
  if (Array.isArray(v)) return v.map(clean);
  if (v && typeof v === "object") return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, clean(x)]));
  return v;
}

// An export the site would refuse; says why and where, never a value.
export class BundleError extends Error {
  constructor({ error, field }) { super(`the export doesn't fit what the site takes (${error}${field ? " at " + field : ""})`); this.code = error; this.field = field; }
}

export function buildBundle(customers, members, exportedAt) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(exportedAt)) throw new Error("--as-of must be YYYY-MM-DD");
  // Dedupe by id (Rotor's paging can repeat a row), then keep what the site keeps.
  const seen = new Set();
  const rows = [];
  for (const c of customers) { if (!c || !c.id || seen.has(c.id)) continue; seen.add(c.id); rows.push(clean(c)); }
  const checked = normalizeBundle({ v: 1, exported_at: exportedAt, customers: rows, members: (members || []).map(clean) });
  if (!checked.ok) throw new BundleError(checked);
  return checked.bundle;
}

// The sealed file is base64, so it can never hold an "@" sign, but a run of
// ten digits is possible by chance; tests treat that as a leaked phone
// number, so seal again (fresh random key and nonce) until there isn't one.
export function sealClean(bundle, publicKeyPem) {
  for (let i = 0; i < 50; i++) {
    const box = seal(bundle, publicKeyPem);
    if (!/\d{10}/.test(JSON.stringify(box))) return box;
  }
  throw new Error("could not seal without a 10-digit run");
}

// Would writing `file` put it inside the repo (symlinks followed)? The
// deepest ancestor that exists decides, so a path in a folder that doesn't
// exist yet is judged by where that folder would be.
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

// Where writing `out` really lands: its folder resolved by the filesystem
// (symlinks, then "..", the way the kernel walks a path; path.resolve would
// fold "link/.." away as text first) plus the file name. Null when the
// folder doesn't exist.
export function realTarget(out) {
  let dir;
  try { dir = realpathSync.native(path.dirname(out)); } catch { return null; }
  return path.join(dir, path.basename(out));
}

// Writes `text` to the real target without following anything at the end of
// the path: a fresh temporary file (O_EXCL, so not through a link) renamed
// over the target, which replaces a hard link's own entry instead of the
// file it shares. Then checks where the file really is.
export function writeOutside(target, text, root = ROOT) {
  const tmp = `${target}.${randomBytes(6).toString("hex")}.tmp`;
  writeFileSync(tmp, text, { flag: "wx", mode: 0o600 });
  try { renameSync(tmp, target); } catch (e) { try { unlinkSync(tmp); } catch {} throw e; }
  if (insideRepo(realpathSync.native(target), root)) { unlinkSync(target); return false; }
  return true;
}

export function parseArgs(args) {
  const out = { positional: [], asOf: null, print: false, unknown: [] };
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === "--as-of") out.asOf = args[++i] || "";
    else if (a === "--print") out.print = true;
    else if (a.startsWith("--")) out.unknown.push(a);
    else out.positional.push(a);
  }
  return out;
}

const USAGE = "usage: node build/crm_seal_import.mjs <export-dir with customers.jsonl and members.jsonl> <out.sealed.json, outside the repo> [--as-of YYYY-MM-DD]\n       node build/crm_seal_import.mjs <export-dir> --print";

export function main(argv, { env = process.env, log = console.log, error = console.error } = {}) {
  const { positional: [dir, out], asOf, print, unknown } = parseArgs(argv.slice(2));
  if (unknown.length) { error(`unknown option ${unknown[0]}\n${USAGE}`); return 2; }
  if (!dir || !existsSync(path.join(dir, "customers.jsonl"))) { error(USAGE); return 2; }
  const customers = readJsonl(path.join(dir, "customers.jsonl"));
  const membersFile = path.join(dir, "members.jsonl");
  const members = existsSync(membersFile) ? readJsonl(membersFile) : [];
  let bundle;
  try {
    bundle = buildBundle(customers, members, asOf || new Date().toISOString().slice(0, 10));
  } catch (e) {
    error(`can't seal: ${e.message}`);
    return 2;
  }
  if (print) {
    const fields = [...new Set(customers.flatMap((c) => Object.keys(c)))].sort();
    log(JSON.stringify({ v: bundle.v, exported_at: bundle.exported_at, customers: bundle.customers.length, members: bundle.members.length, fields }, null, 2));
    return 0;
  }
  if (!out) { error(USAGE); return 2; }
  const refuse = `refusing to write ${out}: it is inside the repo, and customer data (even sealed) is never committed. Write it somewhere outside, then upload it in the app (Customers → Import).`;
  const target = realTarget(out);
  if (!target) { error(`refusing to write ${out}: its folder doesn't exist`); return 2; }
  if (insideRepo(out) || insideRepo(target)) { error(refuse); return 2; }
  let link = false;
  try { link = lstatSync(target).isSymbolicLink(); } catch { /* not there yet */ }
  if (link) { error(`refusing to write ${out}: it is a symlink; give a plain file path outside the repo`); return 2; }
  const box = sealClean(bundle, readFileSync(PUBLIC_KEY, "utf8"));
  const text = JSON.stringify(box) + "\n";
  if (!writeOutside(target, text)) { error(refuse); return 2; }
  log(`sealed ${bundle.customers.length} customers and ${bundle.members.length} members (export of ${bundle.exported_at}) → ${out} (${Math.round(text.length / 1024)} KB)`);
  const key = privateKey(env);
  if (key && key !== "bad") {
    const back = open(box, key);
    log(back.customers.length === bundle.customers.length ? "verified: the file opens with OFFICE_DATA_KEY" : "WARNING: opened, but the row count differs");
  } else if (key === "bad") {
    log("WARNING: OFFICE_DATA_KEY is set but is not a usable key; not verified");
  }
  return 0;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) process.exit(main(process.argv));
