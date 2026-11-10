#!/usr/bin/env node
// Restore the CRM from a nightly snapshot (design §3.12 "Restore procedure").
//
//   NETLIFY_AUTH_TOKEN=... node build/crm_restore.mjs --site-id SITE_ID --date YYYY-MM-DD --check
//   NETLIFY_AUTH_TOKEN=... node build/crm_restore.mjs --site-id SITE_ID --date YYYY-MM-DD --apply
//   ... --from-dir ~/barta-private/backups    (the sealed off-site copy; needs OFFICE_DATA_KEY)
//
// Run on Claude's machine with the owner's Netlify token, one step at a
// time, each with the owner's yes:
//
//   1. --check restores the snapshot into the scratch store
//      `crm-restore-check` (emptied first) and compares what landed with the
//      snapshot's manifest: keys per partition, and the money sums of the
//      invoice and payment partitions. Nothing in `crm` changes.
//   2. --apply restores into `crm`: sys/mode is written FIRST with
//      paused: true (every side effect off; automations and sweeps stopped,
//      maintenance only; human sends refused), then every partition in
//      manifest order with conditional writes (a key that is already the
//      same is left alone; a counter never goes back), then every seq/*
//      is re-seated past the highest number any pointer holds, + 100.
//      It asks you to type RESTORE first (or pass --yes once the owner has
//      said yes in writing).
//   3. Then, in the app (owner): Settings → Data → Rebuild lists (or
//      POST /api/crm/admin/reindex), let the nightly check run (or run it),
//      review, and resume with the typed confirmation RESUME.
//      Stripe/Twilio/Postmark reconciliation since the snapshot
//      (restore.reconcile) arrives with those integrations (M5, M6).
//
// The token and OFFICE_DATA_KEY come from the environment, never from
// arguments, and are never printed. --from-dir must be outside every
// worktree of this repository (exit 2). Output is counts only.

import { readFileSync, existsSync } from "node:fs";
import path from "node:path";
import { createInterface } from "node:readline/promises";
import { fileURLToPath } from "node:url";
import { open, privateKey as officeKey } from "../netlify/lib/office-data.mjs";
import { insideAnyWorktree } from "./crm_backup_pull.mjs";

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const NAME_RE = /^[a-z][a-z0-9_-]{0,60}$/;
export const CHECK_STORE = "crm-restore-check";
const MONEY = { "rec-invoice": "total_cents", "rec-payment": "amount_cents" };

export function parseArgs(args) {
  const out = { siteId: null, date: null, check: false, apply: false, fromDir: null, yes: false, margin: 100, unknown: [] };
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === "--site-id") out.siteId = args[++i] || "";
    else if (a === "--date") out.date = args[++i] || "";
    else if (a === "--check") out.check = true;
    else if (a === "--apply") out.apply = true;
    else if (a === "--from-dir") out.fromDir = args[++i] || "";
    else if (a === "--yes") out.yes = true;
    else if (a === "--margin") out.margin = Number(args[++i]);
    else out.unknown.push(a);
  }
  return out;
}

// ------------------------------------------------------------ sources

// The sealed copy crm_backup_pull.mjs wrote: DIR/{date}/manifest.sealed.json
// and DIR/{date}/{partition}/part-{nnnn}.sealed.json, opened with the key.
export function sourceFromDir(dir, date, key) {
  const base = path.join(dir, date);
  const read = (p) => open(JSON.parse(readFileSync(p, "utf8")), key);
  const m = read(path.join(base, "manifest.sealed.json"));
  if (!m || !m.manifest || m.manifest.date !== date) throw new Error("that copy's manifest is for another date");
  return {
    manifest: m.manifest,
    async readPart(name, n) {
      if (!NAME_RE.test(name)) throw new Error("bad partition name");
      const f = path.join(base, name, `part-${String(n).padStart(4, "0")}.sealed.json`);
      if (!existsSync(f)) return null;
      const box = read(f);
      if (box.partition !== name || box.part !== n || box.date !== date) throw new Error("a part doesn't match its place");
      return box.text;
    },
  };
}

// The snapshot in the site's crm-backups store (through crm-store, whose
// override points at it).
export async function sourceFromBackups(date) {
  const B = await import("../netlify/lib/crm/core/backup.mjs");
  const manifest = await B.readManifest(date);
  if (!manifest || !manifest.ok) throw new Error(`no finished snapshot for ${date}`);
  return { manifest, readPart: (name, n) => B.readPart(date, name, n) };
}

// ------------------------------------------------------------ steps

// Counts and money sums of a source, straight from its parts.
export async function sourceReport(source) {
  const out = { partitions: {}, money: {} };
  for (const p of source.manifest.partitions) {
    let keys = 0;
    let sum = 0;
    for (let n = 1; n <= (p.parts || 0); n++) {
      for (const line of String((await source.readPart(p.name, n)) || "").split("\n")) {
        if (!line.trim()) continue;
        keys += 1;
        const f = MONEY[p.name];
        if (f) { const v = JSON.parse(line).v; if (v && Number.isSafeInteger(v[f])) sum += v[f]; }
      }
    }
    out.partitions[p.name] = { manifest: p.keys, parts: keys };
    if (MONEY[p.name]) out.money[p.name] = sum;
  }
  return out;
}

// Step 1: restore into the scratch store the override points at as "data"
// and compare. → { ok, partitions: { name: { manifest, parts, restored } }, money: { name: { snapshot, restored } } }
export async function checkRestore(source, { margin = 100 } = {}) {
  const B = await import("../netlify/lib/crm/core/backup.mjs");
  const store = await import("../netlify/lib/crm-store.mjs");
  const report = await sourceReport(source);
  await B.restoreSnapshot(source, { margin });
  let ok = true;
  for (const p of source.manifest.partitions) {
    const r = report.partitions[p.name];
    if (p.prefix) r.restored = (await store.listKeys(p.prefix)).length;
    else r.restored = r.parts;
    if (r.manifest !== r.parts || (p.prefix && r.restored < r.parts)) ok = false;
  }
  const money = {};
  for (const [name, field] of Object.entries(MONEY)) {
    const p = source.manifest.partitions.find((x) => x.name === name);
    if (!p) continue;
    let restored = 0;
    for (const k of await store.listKeys(p.prefix)) { const g = await store.getRaw(k); if (g && g.data && Number.isSafeInteger(g.data[field])) restored += g.data[field]; }
    money[name] = { snapshot: report.money[name] || 0, restored };
    if (money[name].snapshot !== restored) ok = false;
  }
  return { ok, partitions: report.partitions, money };
}

// Step 2: the real thing (into whatever the override points at as "data").
export async function applyRestore(source, { margin = 100, onProgress } = {}) {
  const B = await import("../netlify/lib/crm/core/backup.mjs");
  return B.restoreSnapshot(source, { margin, onProgress });
}

// ------------------------------------------------------------ the command

async function blobsStores(siteID, token, dataName) {
  const { getStore } = await import("@netlify/blobs");
  const s = (name) => getStore({ name, siteID, token, consistency: "strong" });
  return { data: s(dataName), files: s("crm-files"), backups: s("crm-backups") };
}

export async function main(argv = process.argv.slice(2), env = process.env, io = { log: console.log, error: console.error, ask: null }) {
  const a = parseArgs(argv);
  const usage = "usage: NETLIFY_AUTH_TOKEN=... node build/crm_restore.mjs --site-id SITE_ID --date YYYY-MM-DD (--check | --apply) [--from-dir DIR] [--yes]";
  if (a.unknown.length || !a.siteId || !/^[0-9a-f-]{8,64}$/i.test(a.siteId) || !DATE_RE.test(String(a.date)) || a.check === a.apply || !Number.isSafeInteger(a.margin) || a.margin < 1) { io.error(usage); return 1; }
  if (a.fromDir !== null && (!a.fromDir || insideAnyWorktree(a.fromDir))) { io.error("Refusing: --from-dir is inside the repository. Keep backups outside every worktree, like ~/barta-private/backups."); return 2; }
  const token = String(env.NETLIFY_AUTH_TOKEN || "");
  if (!token) { io.error("Set NETLIFY_AUTH_TOKEN (the owner's Netlify token) in the environment."); return 1; }
  let key = null;
  if (a.fromDir) {
    key = officeKey(env);
    if (!key || key === "bad") { io.error("Set OFFICE_DATA_KEY to open the sealed copy."); return 1; }
  }
  try {
    const stores = await blobsStores(a.siteId, token, a.check ? CHECK_STORE : "crm");
    globalThis.__crmStoreOverride = stores;
    await import("../netlify/lib/crm/modules/index.mjs");
    const source = a.fromDir ? sourceFromDir(path.resolve(a.fromDir), a.date, key) : await sourceFromBackups(a.date);
    if (a.check) {
      await stores.data.deleteAll();
      const r = await checkRestore(source, { margin: a.margin });
      for (const [name, p] of Object.entries(r.partitions)) io.log(`${name.padEnd(28)} manifest ${p.manifest}  in parts ${p.parts}  restored ${p.restored}`);
      for (const [name, m] of Object.entries(r.money)) io.log(`${name.padEnd(28)} money ${m.snapshot === m.restored ? "matches" : "DIFFERS"}`);
      io.log(r.ok ? "check passed: the snapshot restores completely" : "CHECK FAILED: do not apply this snapshot");
      return r.ok ? 0 : 3;
    }
    if (!a.yes) {
      const ask = io.ask || (async (q) => { const rl = createInterface({ input: process.stdin, output: process.stdout }); try { return await rl.question(q); } finally { rl.close(); } });
      const typed = await ask(`This writes the ${a.date} snapshot into the live crm store and pauses the CRM. Type RESTORE to go on: `);
      if (String(typed).trim() !== "RESTORE") { io.error("Not restored."); return 1; }
    }
    const r = await applyRestore(source, { margin: a.margin, onProgress: (p) => io.log(`${p.partition} part ${p.part}: ${p.keys} keys so far`) });
    io.log(`restored ${r.keys} keys (${r.written} written, ${r.same} already the same); the CRM is PAUSED`);
    io.log(`sequences re-seated: ${Object.keys(r.sequences).length}`);
    io.log("Next: Settings → Data → Rebuild lists, let the nightly check run, review, then resume with RESUME.");
    return 0;
  } catch (e) {
    io.error(`restore failed: ${String((e && e.message) || e).slice(0, 200)}`);
    return 1;
  } finally {
    delete globalThis.__crmStoreOverride;
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main().then((code) => process.exit(code));
