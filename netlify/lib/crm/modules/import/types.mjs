// Record types of the import module: import_run (design §3.3, §10.10).
//
// rec/import_run/{id} is one import of a Rotor export: what the pack said
// it holds (the manifest: entity names, row counts, chunk names and their
// SHA-256, no personal data), the one-run upload key (its hash only), the
// owner's user map overrides, which lane run steps it, and a short summary
// once it is done. The rows themselves live under imp/{runId}/ (staging,
// phase state, conflicts, the report, the id map), never in this record.

import { defineType } from "../../core/registry.mjs";
import { InputError } from "../../core/errors.mjs";
import { isId } from "../../core/ids.mjs";
import { shape, str, enumValue, int } from "../../core/validate.mjs";

export const IMPORT_STATUSES = Object.freeze(["uploading", "queued", "running", "done", "failed", "cancelled"]);
const AS_OF_RE = /^\d{4}-\d{2}-\d{2}$/;

function validateImportRun(data, { op } = {}) {
  const stored = op === "update";
  return shape(data, {
    status: (v, f) => enumValue(v, IMPORT_STATUSES, { field: f, required: true, stored }),
    as_of: (v, f) => {
      if (v === undefined || v === null || v === "") return undefined;
      if (typeof v !== "string" || !AS_OF_RE.test(v)) throw new InputError("Use a date like 2026-11-10.", f);
      return v;
    },
    note: (v, f) => str(v, { field: f, max: 200 }) || undefined,
    requested_by: (v, f) => str(v, { field: f, max: 80 }) || "system",
    lane_run_id: (v, f) => {
      if (v === undefined || v === null || v === "") return undefined;
      if (!isId(v, "run")) throw new InputError("That isn't a run.", f);
      return v;
    },
    attempt: (v, f) => int(v, { field: f, min: 0, max: 1000 }) ?? 0,
  });
}

// ix/import-runs: what the Import screen lists (no personal data: counts only).
export const importRunRow = (r) => ({
  st: r.status, at: r.created_at, by: r.requested_by || "system", asof: r.as_of || null,
  ...(r.started_at ? { s: r.started_at } : {}), ...(r.finished_at ? { fin: r.finished_at } : {}),
  ...(r.summary ? { sum: { created: r.summary.created || 0, updated: r.summary.updated || 0, conflicts: r.conflicts ? r.conflicts.open || 0 : r.summary.conflicts_open || 0 } } : {}),
});

export const importRunType = defineType({
  type: "import_run",
  prefix: "ir",
  v: 1,
  validate: validateImportRun,
  rotorFields: [],
  techFields: ["id", "status"],
  readPerm: "import:run",
  shadow: false,
  indexes: [{ name: "import-runs", shard: () => "", row: importRunRow }],
  example: () => ({
    status: "uploading", as_of: "2026-11-10", requested_by: "us_0000000000000000000a", attempt: 0,
    manifest: { v: 1, kind: "barta-import-manifest", as_of: "2026-11-10", entities: { customers: { rows: 2, chunks: [{ name: "customers-0001", rows: 2, sha256: "0".repeat(64) }] } } },
    upload: { key_hash: "0".repeat(64), last4: "abcd", expires_at: "2026-11-11T15:00:00.000Z" }, user_map: {}, conflicts: { open: 0, resolved: 0 },
  }),
});

export const types = [importRunType];
