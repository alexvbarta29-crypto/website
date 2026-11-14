// The automatic daily import key (design §10.9 "daily delta imports",
// §4.9; docs/CRM-IMPORT.md "Automatic daily import").
//
// An owner makes it once (Settings → Import & data → Import from Rotor →
// Automatic daily import). A scheduled job OUTSIDE this repository exports
// Rotor read-only, packs it and runs build/crm_import_upload.mjs with this
// key every day. The key can do exactly one thing: POST /import/auto/runs,
// which creates an import run for the pack's manifest and answers that
// run's ordinary one-run upload key (bimp_, 24 hours, upload routes only).
// It reads nothing of the CRM's data and opens no other route: it is not an
// API key (bcrm_) and not an upload key (bimp_), so every other route's
// credential check refuses it.
//
//   - "bauto_" + 40 base62 characters, shown once; stored only as its
//     SHA-256: rec/import_key/{id} (key_hash, last4) and the pointer
//     ptr/import-auto-key/{sha256} → { id } while it works.
//   - One works at a time: making a new one revokes the one before.
//     Revoking (DELETE /import/auto-key/:id) stops it at once.
//   - Every make, revoke and use is a record write (audited: the Audit
//     screen and the record's history), and each run it made carries
//     `auto_key_id`. A refused use (revoked, paused, an import already
//     running, an older export, too many today) is an audit event too.
//   - The owners get a note when each automatic import is done (and, like
//     every import, when one stops).
//   - At most AUTO_RUNS_PER_DAY runs a day (a leaked key can't flood the
//     CRM with imports); never an export older than the newest finished
//     import (a newer export updates and adds by the usual rules; an older
//     one could only take values back).

import { createHash, randomInt, timingSafeEqual } from "node:crypto";
import { createRecord, updateRecord, getRecord, readPointer, readIndex, appendEvent } from "../../../crm-store.mjs";
import { defineType } from "../../core/registry.mjs";
import { newId, isId } from "../../core/ids.mjs";
import { nowIso, nowMs, localDate } from "../../core/clock.mjs";
import { InputError, NotFoundError, ConflictError } from "../../core/errors.mjs";
import { shape, str, int } from "../../core/validate.mjs";
import { fail } from "../../core/http.mjs";
import { readSysMode } from "../../core/settings.mjs";
import { notify, approvers } from "../../core/notify.mjs";
import { safeErr } from "../../../referral-lib.mjs";
import { checkManifest } from "./staging.mjs";
import { createImportRun, runView } from "./runs.mjs";
import { onRunDone } from "./runner.mjs";
import { exportDay } from "./continue.mjs";

export const AUTO_KEY_PREFIX = "bauto_";
export const AUTO_KEY_RE = /^bauto_[0-9A-Za-z]{40}$/;
export const AUTO_RUNS_PER_DAY = 4;
const B62 = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz";
const HEX64 = /^[0-9a-f]{64}$/;
export const autoKeyHash = (key) => createHash("sha256").update(String(key)).digest("hex");
export function newAutoKey() {
  let s = AUTO_KEY_PREFIX;
  for (let i = 0; i < 40; i++) s += B62[randomInt(62)];
  return s;
}
const sameHash = (a, b) => typeof a === "string" && typeof b === "string" && a.length === b.length && timingSafeEqual(Buffer.from(a), Buffer.from(b));
const timeOrNull = (v, f) => {
  if (v === undefined || v === null || v === "") return undefined;
  if (typeof v !== "string" || !Number.isFinite(Date.parse(v))) throw new InputError("That isn't a time.", f);
  return v;
};

// ------------------------------------------------------------ the record

function validateImportKey(data) {
  return shape(data, {
    name: (v, f) => str(v, { field: f, max: 60, required: true }),
    key_hash: (v, f) => { if (typeof v !== "string" || !HEX64.test(v)) throw new InputError("A key hash.", f); return v; },
    last4: (v, f) => { if (typeof v !== "string" || !/^[0-9A-Za-z]{4}$/.test(v)) throw new InputError("The key's last four.", f); return v; },
    created_by: (v, f) => str(v, { field: f, max: 80 }) || "system",
    revoked_at: (v, f) => timeOrNull(v, f),
    revoked_by: (v, f) => str(v, { field: f, max: 80 }) || undefined,
    last_used_at: (v, f) => timeOrNull(v, f),
    last_run_id: (v, f) => { if (v === undefined || v === null || v === "") return undefined; if (!isId(v, "import_run")) throw new InputError("That isn't an import.", f); return v; },
    uses: (v, f) => int(v, { field: f, min: 0, max: 1000000 }) ?? 0,
  });
}

export const importKeyRow = (r) => ({ n: r.name, l4: r.last4, at: r.created_at, by: r.created_by || "system", ...(r.revoked_at ? { rv: r.revoked_at } : {}), ...(r.last_used_at ? { lu: r.last_used_at } : {}), u: r.uses || 0 });

export const importKeyType = defineType({
  type: "import_key",
  prefix: "ik",
  v: 1,
  validate: validateImportKey,
  rotorFields: [],
  techFields: ["id"],
  readPerm: "import:run",
  shadow: false,
  indexes: [{ name: "import-keys", shard: () => "", row: importKeyRow }],
  // the key's hash finds it while it works; a revoked key has no pointer
  pointers: [{ kind: "import-auto-key", key: (r) => (r.revoked_at ? null : r.key_hash) }],
  summary: (r) => ({ id: r.id, name: r.name, last4: r.last4 }),
  example: () => ({ name: "Daily import", key_hash: "0".repeat(64), last4: "abcd", created_by: "us_0000000000000000000a", uses: 0 }),
});

// What the screen shows of a key: never its hash.
export const keyView = (k) => (k ? {
  id: k.id, name: k.name, last4: k.last4, created_at: k.created_at, created_by: k.created_by || null,
  revoked_at: k.revoked_at || null, last_used_at: k.last_used_at || null, last_run_id: k.last_run_id || null, uses: k.uses || 0, active: !k.revoked_at,
} : null);

// ------------------------------------------------------------ owners

// → { key: active key view | null, earlier: [revoked keys], runs: [the latest automatic imports] }
export async function autoKeyView() {
  const [ix, runs] = await Promise.all([readIndex("import-keys", ""), readIndex("import-runs", "")]);
  const rows = ix.rows.slice().sort((a, b) => (a.at < b.at ? 1 : -1));
  const active = rows.find((r) => !r.rv);
  const got = active ? await getRecord("import_key", active.id) : null;
  const auto = runs.rows.filter((r) => r.ak).sort((a, b) => (a.at < b.at ? 1 : -1)).slice(0, 7)
    .map((r) => ({ id: r.id, status: r.st, as_of: r.asof || null, created_at: r.at, finished_at: r.fin || null, summary: r.sum || null }));
  return {
    key: got && !got.data.revoked_at ? keyView(got.data) : null,
    earlier: rows.filter((r) => r.rv).slice(0, 5).map((r) => ({ id: r.id, name: r.n, last4: r.l4, created_at: r.at, revoked_at: r.rv, uses: r.u || 0 })),
    runs: auto,
    per_day: AUTO_RUNS_PER_DAY,
  };
}

// Makes the key (shown once). The key that worked before stops working.
export async function createAutoKey({ name } = {}, ctx) {
  const label = String(name || "Daily import").trim().slice(0, 60) || "Daily import";
  const ix = await readIndex("import-keys", "");
  for (const r of ix.rows.filter((x) => !x.rv)) await revokeAutoKey(r.id, ctx, { reason: "replaced" });
  const key = newAutoKey();
  const rec = await createRecord("import_key", { id: newId("import_key"), name: label, key_hash: autoKeyHash(key), last4: key.slice(-4), created_by: ctx.by || "system", uses: 0 }, ctx);
  return { key, record: keyView(rec.data) };
}

export async function revokeAutoKey(id, ctx, { reason = "owner" } = {}) {
  if (!isId(id, "import_key")) throw new NotFoundError("That key isn't there.");
  const got = await getRecord("import_key", id);
  if (!got) throw new NotFoundError("That key isn't there.");
  const r = await updateRecord("import_key", id, (k) => (k.revoked_at ? null : { ...k, revoked_at: nowIso(), revoked_by: ctx.by || "system" }), ctx);
  if (r.changed) await appendEvent("import_key", id, { action: "revoke", by: ctx.by || "system", origin: ctx.origin || "api", reason }).catch(() => {});
  return keyView(r.data);
}

// ------------------------------------------------------------ the one thing the key does

const KEY_CTX = (keyId, requestId) => ({ by: `import_key:${keyId}`, origin: "import", actor_kind: "import", requestId: requestId || "auto-import" });
const BEARER = /^Bearer\s+(\S+)$/i;
const refuse = (msg, status = 401, code = "signed_out") => ({ res: fail(code, msg, status) });

// The key on a request, checked. → { key: the record } | { res }
export async function autoKeyAuth(req) {
  const m = BEARER.exec(req.headers.get("authorization") || "");
  if (!m || !AUTO_KEY_RE.test(m[1])) return refuse("Send the automatic import key.");
  const hash = autoKeyHash(m[1]);
  const p = await readPointer("import-auto-key", hash);
  if (!p || !isId(p.id, "import_key")) return refuse("That import key doesn't work.");
  const got = await getRecord("import_key", p.id);
  const k = got && got.data;
  if (!k || k.revoked_at || !sameHash(k.key_hash, hash)) return refuse("That import key doesn't work any more.");
  return { key: k };
}

async function refused(k, why) {
  await appendEvent("import_key", k.id, { action: "refused", by: `import_key:${k.id}`, origin: "import", reason: why }).catch(() => {});
}

// POST /import/auto/runs (the key): { manifest, note? } → { run, upload_key }.
// The upload script then sends the pack with that one-run key and starts it.
export async function autoRun(ctx) {
  const a = await autoKeyAuth(ctx.req);
  if (a.res) return a.res;
  const k = a.key;
  const b = ctx.body && typeof ctx.body === "object" ? ctx.body : {};
  let manifest;
  try { manifest = checkManifest(b.manifest); } catch (e) { await refused(k, "bad_manifest"); throw e; }
  const mode = await readSysMode();
  if (mode.paused) { await refused(k, "paused"); throw new ConflictError("The CRM is paused. No import starts until an owner resumes it."); }
  const ix = await readIndex("import-runs", "");
  const today = localDate(new Date(nowMs()));
  if (ix.rows.filter((r) => r.ak === k.id && localDate(new Date(Date.parse(r.at))) === today).length >= AUTO_RUNS_PER_DAY) {
    await refused(k, "too_many_today");
    throw new ConflictError(`This key already made ${AUTO_RUNS_PER_DAY} imports today. Try again tomorrow.`);
  }
  // never an export older than the newest one already brought in
  const newest = ix.rows.filter((r) => r.st === "done" && r.asof).map((r) => r.asof).sort().pop() || null;
  if (newest && manifest.as_of < newest) {
    await refused(k, "older_export");
    throw new ConflictError(`That export (${manifest.as_of}) is older than the newest import (${newest}). Export again.`);
  }
  let made;
  try {
    made = await createImportRun({ manifest, note: String(b.note || "Automatic daily import").slice(0, 200) }, KEY_CTX(k.id, ctx.requestId), { auto_key_id: k.id });
  } catch (e) {
    if (e instanceof ConflictError) await refused(k, "busy");
    throw e;
  }
  await updateRecord("import_key", k.id, (x) => ({ ...x, last_used_at: nowIso(), last_run_id: made.run.id, uses: (x.uses || 0) + 1 }), KEY_CTX(k.id, ctx.requestId));
  return { status: 201, data: { run: made.run, upload_key: made.upload_key } };
}

// ------------------------------------------------------------ the owners' note

const SYSTEM = { by: "import", origin: "import", actor_kind: "import", requestId: "auto-import" };
const count = (n) => Number(n || 0).toLocaleString("en-US");

export function autoDoneNotice(run) {
  const s = run.summary || {};
  const conflicts = (run.conflicts && run.conflicts.open) || 0;
  const day = exportDay(run.as_of);
  return {
    kind: "system", title: "Daily Rotor import done",
    body: `Rotor's export${day ? ` of ${day}` : ""} is in: ${count(s.created)} added, ${count(s.updated)} updated.${conflicts ? ` ${count(conflicts)} ${conflicts === 1 ? "field" : "fields"} to settle on the Import screen.` : " Nothing to settle."}`,
    link: `/import/${run.id}`,
  };
}
onRunDone(async (run) => {
  if (!run.auto_key_id) return;
  const people = await approvers();
  if (people.length) await notify(people, autoDoneNotice(run), SYSTEM).catch((e) => console.error(`crm:import: the owners were not told (${safeErr(e)})`));
});
// (a run that stops is told to the owners for every import: continue.mjs stoppedNotice)

export { runView };
