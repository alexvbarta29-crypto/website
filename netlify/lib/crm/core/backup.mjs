// Barta CRM core: backups, restore and export (design §3.12).
//
// Nightly snapshot (the backup.nightly sweep creates the run
// "backup.snapshot", bulk lane, 03:00 local): the data store is copied into
// crm-backups partition by partition, in order: sys (sys/mode,
// sys/bootstrap), cfg/, seq/, ptr/, sup/, one partition per rec/{type}/,
// rel/, op/, plk/, apikey/, push/, done/, evt/, q/, alog/, idx/. Skipped:
// ses/, pses/, thr/, idem/, lock/, pend/, fix/, imp/, ib/, done-dry/ and the
// derivable ix/, ix-dirty/, aud/ (a reindex rebuilds them after a restore).
// Each partition is listed completely and sorted (list order is
// undocumented), read 16 keys at a time, and written as
// snap/{date}/{partition}/part-{nnnn}.jsonl (≤ 4 MB; lines
// {"k":key,"e":etag,"v":value}). After each part the run checkpoints
// { i, last_key, part_n }; the next invocation re-lists the partition and
// skips keys ≤ last_key (Blobs list cursors cannot be resumed). A part
// rewritten after a crash is the same part (unconditional, allowed for
// backup parts, §0 rule 4). snap/{date}/manifest.json ends the run.
// Kept: the newest 35 dailies and each 1st-of-month snapshot for 12 months.
//
// Restore (build/crm_restore.mjs; restoreSnapshot here so it is tested):
// sys/mode is written FIRST with paused: true (every side effect off,
// automations and sweeps stopped but maintenance), then every partition
// in manifest order with conditional writes; then reseatSequences() moves
// every seq/* past the highest number any pointer holds (+100), so no
// number a customer already has is issued again. The owner rebuilds the
// indexes (reindex + index.verify), reviews, and resumes with RESUME.

import { listKeys, getRaw, putRaw, deleteRaw, setSequence, readIndex } from "../../crm-store.mjs";
import { nowIso, localDate, nowMs, addLocalDays } from "./clock.mjs";
import { defineRun, updateHealth, withAlert, withoutAlert } from "./lanes.mjs";
import { InputError, NotFoundError } from "./errors.mjs";
import { DEFAULT_MODE, SYS_MODE_KEY } from "./settings.mjs";

export const SNAP = "snap/";
export const PART_MAX_BYTES = Math.floor(3.5 * 1024 * 1024);   // under the 4 MB part limit with room for a last line
export const KEEP_DAILY = 35;
export const KEEP_MONTHLY = 12;
export const SKIPPED = Object.freeze(["ses/", "pses/", "thr/", "idem/", "lock/", "pend/", "fix/", "imp/", "ib/", "done-dry/", "ix/", "ix-dirty/", "aud/"]);
export const TAIL_PREFIXES = Object.freeze(["rel/", "op/", "plk/", "apikey/", "push/", "done/", "evt/", "q/", "alog/", "idx/"]);
export const SYS_KEYS = Object.freeze([SYS_MODE_KEY, "sys/bootstrap"]);
const BATCH = 16;
const STOP_LEFT_MS = 15000;          // write the part and checkpoint when a chunk has this little left

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const PART_NAME_RE = /^[a-z][a-z0-9_-]{0,60}$/;
const pad4 = (n) => String(n).padStart(4, "0");
export const partKey = (date, partition, n) => `${SNAP}${date}/${partition}/part-${pad4(n)}.jsonl`;
export const manifestKey = (date) => `${SNAP}${date}/manifest.json`;
const B = { kind: "backups" };
const withKind = (opts, kind) => ({ ...opts, kind });

async function mapLimit(items, limit, fn) {
  const out = new Array(items.length);
  let next = 0;
  const worker = async () => { while (next < items.length) { const i = next++; out[i] = await fn(items[i], i); } };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return out;
}

// The partitions of a snapshot, in order: [{ name, prefix } | { name, keys }].
export async function planPartitions(opts = {}) {
  const { directories } = await listKeys("rec/", { directories: true }, opts);
  const types = directories.map((d) => d.replace(/\/+$/, "")).map((d) => (d.startsWith("rec/") ? d : `rec/${d}`)).filter((d) => /^rec\/[a-z_]+$/.test(d)).sort();
  return [
    { name: "sys", keys: [...SYS_KEYS] },
    { name: "cfg", prefix: "cfg/" }, { name: "seq", prefix: "seq/" }, { name: "ptr", prefix: "ptr/" }, { name: "sup", prefix: "sup/" },
    ...types.map((d) => ({ name: `rec-${d.slice(4)}`, prefix: d + "/" })),
    ...TAIL_PREFIXES.map((p) => ({ name: p.slice(0, -1).replace(/[^a-z0-9_-]/g, "-"), prefix: p })),
  ];
}

const skipped = (key) => SKIPPED.some((p) => key.startsWith(p));

// One line of a part. JSON values keep their shape; anything else is kept as text.
function lineOf(key, got) {
  let v;
  let text = null;
  try { v = JSON.parse(got.data); } catch { text = got.data; }
  return JSON.stringify(text === null ? { k: key, e: got.etag, v } : { k: key, e: got.etag, t: text });
}

// The run's step: as many keys as the chunk allows (see the top of the file).
async function snapshotStep(run, { budget }) {
  const date = run.input && run.input.date;
  if (!DATE_RE.test(String(date))) return { failed: "bad_date" };
  const cp = run.checkpoint && run.checkpoint.partitions ? { ...run.checkpoint } : { partitions: await planPartitions(), i: 0, last_key: null, part_n: 0, stats: [], keys: 0, bytes: 0, started_at: nowIso() };
  const left = () => (budget ? budget.left() : Infinity);
  while (cp.i < cp.partitions.length) {
    const P = cp.partitions[cp.i];
    const all = P.keys ? [...P.keys] : await listKeys(P.prefix);
    const todo = all.filter((k) => !skipped(k) && (cp.last_key === null || k > cp.last_key));
    let lines = [];
    let bytes = 0;
    let lastKey = cp.last_key;
    let stat = cp.stats.find((s) => s.name === P.name) || { name: P.name, prefix: P.prefix || null, parts: 0, keys: 0, bytes: 0 };
    const flush = async () => {
      if (!lines.length) return;
      const n = cp.part_n + 1;
      const text = lines.join("\n") + "\n";
      await putRaw(partKey(date, P.name, n), text, {}, B);
      cp.part_n = n;
      cp.last_key = lastKey;
      stat = { ...stat, parts: n, keys: stat.keys + lines.length, bytes: stat.bytes + Buffer.byteLength(text) };
      cp.stats = [...cp.stats.filter((s) => s.name !== P.name), stat];
      cp.keys += lines.length;
      cp.bytes += Buffer.byteLength(text);
      lines = [];
      bytes = 0;
    };
    for (let j = 0; j < todo.length; j += BATCH) {
      const batch = todo.slice(j, j + BATCH);
      const got = await mapLimit(batch, BATCH, (k) => getRaw(k, { type: "text" }));
      batch.forEach((k, x) => {
        if (!got[x] || got[x].data === null || got[x].data === undefined) return;
        const line = lineOf(k, got[x]);
        lines.push(line);
        bytes += Buffer.byteLength(line) + 1;
        lastKey = k;
      });
      if (bytes >= PART_MAX_BYTES) await flush();
      if (left() < STOP_LEFT_MS) {
        await flush();
        if (j + BATCH < todo.length) return { checkpoint: cp, progress: { done: cp.i, total: cp.partitions.length } };
      }
    }
    await flush();
    if (!cp.stats.find((s) => s.name === P.name)) cp.stats = [...cp.stats, stat];
    cp.i += 1;
    cp.last_key = null;
    cp.part_n = 0;
    if (left() < STOP_LEFT_MS && cp.i < cp.partitions.length) return { checkpoint: cp, progress: { done: cp.i, total: cp.partitions.length } };
  }
  const manifest = {
    v: 1, date, run_id: run.id, started_at: cp.started_at, finished_at: nowIso(), ok: true, keys: cp.keys, bytes: cp.bytes,
    partitions: cp.partitions.map((P) => { const s = cp.stats.find((x) => x.name === P.name) || { parts: 0, keys: 0, bytes: 0 }; return { name: P.name, prefix: P.prefix || null, parts: s.parts, keys: s.keys, bytes: s.bytes }; }),
  };
  await putRaw(manifestKey(date), manifest, {}, B);
  const pruned = await pruneSnapshots(date).catch(() => []);
  await updateHealth((h) => withoutAlert({ ...h, backup: { date, at: manifest.finished_at, ok: true, keys: manifest.keys, bytes: manifest.bytes } }, "backup"));
  return { done: true, checkpoint: { ...cp, partitions: undefined, stats: undefined }, progress: { done: cp.partitions.length, total: cp.partitions.length }, result: { date, keys: manifest.keys, bytes: manifest.bytes, partitions: manifest.partitions.length, pruned: pruned.length } };
}

defineRun("backup.snapshot", { lane: "bulk", step: snapshotStep, maintenance: true, label: "Nightly backup" });

// The snapshot dates in crm-backups, newest first.
export async function snapshotDates(opts = {}) {
  const { directories } = await listKeys(SNAP, { directories: true, kind: "backups" }, opts);
  return directories.map((d) => d.replace(/\/+$/, "").replace(/^snap\//, "")).filter((d) => DATE_RE.test(d)).sort().reverse();
}

export async function readManifest(date, opts = {}) {
  if (!DATE_RE.test(String(date))) throw new InputError("Pick a backup date.", "date");
  const got = await getRaw(manifestKey(date), withKind(opts, "backups"));
  return got && got.data ? got.data : null;
}

// Every finished snapshot's manifest, newest first (GET /admin/backups).
export async function listManifests({ limit = 40 } = {}, opts = {}) {
  const dates = (await snapshotDates(opts)).slice(0, limit);
  const out = await mapLimit(dates, 8, (d) => readManifest(d, opts).catch(() => null));
  return dates.map((d, i) => out[i] || { date: d, ok: false, partial: true });
}

// The text of one part, or null (GET /admin/export streams it).
export async function readPart(date, partition, n, opts = {}) {
  if (!DATE_RE.test(String(date)) || !PART_NAME_RE.test(String(partition)) || !Number.isSafeInteger(n) || n < 1 || n > 9999) throw new InputError("That backup part doesn't exist.", "part");
  const got = await getRaw(partKey(date, partition, n), { ...withKind(opts, "backups"), type: opts.type || "text" });
  return got ? got.data : null;
}

// Keeps the newest KEEP_DAILY snapshots and each 1st-of-month one for
// KEEP_MONTHLY months. → the dates deleted.
export async function pruneSnapshots(today = localDate(new Date(nowMs())), opts = {}) {
  const dates = (await snapshotDates(opts)).sort().reverse();
  const keepDaily = new Set(dates.slice(0, KEEP_DAILY));
  const monthlyFloor = addLocalDays(today, -KEEP_MONTHLY * 31);
  const gone = [];
  for (const d of dates) {
    if (keepDaily.has(d) || (d.endsWith("-01") && d >= monthlyFloor)) continue;
    for (const k of await listKeys(`${SNAP}${d}/`, { kind: "backups" }, opts)) await deleteRaw(k, withKind(opts, "backups"));
    gone.push(d);
  }
  return gone;
}

// ------------------------------------------------------------ restore

const parseLines = (text) => String(text || "").split("\n").filter((l) => l.trim()).map((l) => JSON.parse(l));
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);

// A conditional write of a restored value: onlyIfNew for a missing key,
// onlyIfMatch on the etag read for an existing one; an unclear answer is
// settled by reading the key back.
async function restoreWrite(key, line, opts) {
  const value = line.t !== undefined ? line.t : line.v;
  for (let i = 0; i < 4; i++) {
    const cur = await getRaw(key, { ...opts, type: "text" });
    const curVal = cur ? (line.t !== undefined ? cur.data : (() => { try { return JSON.parse(cur.data); } catch { return Symbol("x"); } })()) : undefined;
    if (cur && same(curVal, value)) return "same";
    // a counter never goes back: a store that already issued higher numbers keeps them
    if (cur && key.startsWith("seq/") && curVal && value && Number.isSafeInteger(curVal.next) && Number.isSafeInteger(value.next) && curVal.next >= value.next) return "same";
    const r = await putRaw(key, value, cur ? { onlyIfMatch: cur.etag } : { onlyIfNew: true }, opts);
    if (r.modified && r.etag && !r.ambiguous) return "written";
  }
  throw new Error("restore: a key kept changing");
}

// Restores a snapshot into the data store the scope points at.
// source: { manifest, readPart(partitionName, n) → text }.
// → { keys, written, same, sequences }
export async function restoreSnapshot(source, { onProgress, margin = 100 } = {}, opts = {}) {
  const { manifest } = source;
  if (!manifest || !Array.isArray(manifest.partitions)) throw new InputError("That backup has no manifest.");
  // 1. pause first: nothing may send or charge while the data comes back
  let snapMode = null;
  const sys = manifest.partitions.find((p) => p.name === "sys");
  if (sys && sys.parts) {
    for (let n = 1; n <= sys.parts; n++) for (const l of parseLines(await source.readPart("sys", n))) if (l.k === SYS_MODE_KEY) snapMode = l.v;
  }
  const paused = { ...DEFAULT_MODE, ...(snapMode && typeof snapMode === "object" ? snapMode : {}), paused: true, paused_reason: "restore", restored_from: manifest.date, paused_at: nowIso() };
  delete paused._w;
  await restoreWrite(SYS_MODE_KEY, { v: paused }, opts);
  const counts = { keys: 0, written: 0, same: 0 };
  // 2. every partition, in order
  for (const P of manifest.partitions) {
    for (let n = 1; n <= (P.parts || 0); n++) {
      const text = await source.readPart(P.name, n);
      if (text === null || text === undefined) throw new NotFoundError(`Backup part ${P.name} ${n} is missing.`);
      for (const line of parseLines(text)) {
        if (line.k === SYS_MODE_KEY || skipped(line.k)) continue;
        const r = await restoreWrite(line.k, line, opts);
        counts.keys += 1;
        counts[r === "same" ? "same" : "written"] += 1;
      }
      if (onProgress) onProgress({ partition: P.name, part: n, ...counts });
    }
  }
  // 3. numbers never go backwards
  const sequences = await reseatSequences({ margin }, opts);
  return { ...counts, sequences };
}

// Moves every sequence past the highest number its pointers hold
// (ptr/{seq}-no/{n}, digits only: imported numbers with a prefix are not
// this sequence's) and past its own stored next, plus `margin`.
// → { [seq]: next }
export async function reseatSequences({ margin = 100 } = {}, opts = {}) {
  const max = new Map();
  for (const k of await listKeys("ptr/", {}, opts)) {
    const m = /^ptr\/([a-z0-9_-]+)-no\/(\d+)$/.exec(k);
    if (!m) continue;
    max.set(m[1], Math.max(max.get(m[1]) || 0, parseInt(m[2], 10)));
  }
  for (const k of await listKeys("seq/", {}, opts)) {
    const name = k.slice(4);
    const got = await getRaw(k, opts);
    const next = got && got.data && Number.isSafeInteger(got.data.next) ? got.data.next : 1;
    max.set(name, Math.max(max.get(name) || 0, next - 1));
  }
  const out = {};
  for (const [name, n] of [...max].sort()) {
    const next = n + margin;
    await setSequence(name, next, { ...opts, by: "restore" });
    out[name] = next;
  }
  return out;
}

// ------------------------------------------------------------ export (owner)

// The runs index row of the latest snapshot run, for Settings → Data.
export async function lastSnapshot(opts = {}) {
  const ix = await readIndex("runs", "recent", opts);
  const rows = ix.rows.filter((r) => r.k === "backup.snapshot").sort((a, b) => (a.at < b.at ? 1 : -1));
  return rows[0] || null;
}

// A missed night raises an alert on Today (health), cleared by the next good snapshot.
// (A new system gets 36 hours from the bulk lane's first run before it warns.)
export const BACKUP_MAX_AGE_MS = 36 * 3600 * 1000;
export function checkBackupAge(health, t = nowMs()) {
  const b = health && health.backup;
  if (b && Date.parse(b.at) + BACKUP_MAX_AGE_MS > t) return health;
  const first = health && health.lanes && health.lanes.bulk && health.lanes.bulk.first_run_at;
  if (!b && !(Date.parse(first) + BACKUP_MAX_AGE_MS <= t)) return health;
  return withAlert(health, "backup", "No backup snapshot in the last 36 hours.");
}
