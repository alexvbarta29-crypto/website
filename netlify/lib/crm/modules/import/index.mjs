// Barta CRM module "import" (M2c; M8 adds the cutover): the Rotor import
// framework (design §10.1-10.8, §10.10). docs/CRM-IMPORT.md describes it.
//
// Files: types.mjs (import_run), catalog.mjs (the entity files and the
// phases the design expects from each module), staging.mjs (manifest,
// sealed chunks, media), ownership.mjs (field ownership and the three-way
// merge), runner.mjs (the phase runner on the bulk lane), users.mjs (the
// team phases, §10.2 rows 1-3), report.mjs (the reconciliation report and
// the id map), runs.mjs (runs, upload keys, the user map, conflicts),
// routes.mjs (the API).

import { defineModule } from "../../core/registry.mjs";
import { defineFileOwner } from "../../core/files.mjs";
import { readIndex, listKeys, deleteRaw, getRecord, updateRecord } from "../../../crm-store.mjs";
import { nowMs, nowIso } from "../../core/clock.mjs";
import { types } from "./types.mjs";
import { importRoutes } from "./routes.mjs";
import { userPhases } from "./users.mjs";
import "./runner.mjs";

export const STAGING_KEEP_DAYS = 30;

// Imported media belong to the run that brought them until a module's
// phase attaches them to a message or a quote: owners may look at them.
defineFileOwner("import_run", {
  canRead: (ctx) => ctx.can("import:run"),
  canEdit: () => false,
});

// import.staging_gc (bulk, daily): the plaintext rows of a run that
// finished more than 30 days ago are deleted (the run, its state, report,
// conflicts and id map stay); an upload nobody started whose key ran out
// more than 7 days ago is cancelled ("abandoned") and its rows deleted at once.
export const ABANDONED_AFTER_DAYS = 7;
async function stagingGc(ctx) {
  const ix = await readIndex("import-runs", "");
  const day = 86400000;
  let removed = 0;
  const drop = async (id) => {
    for (const k of await listKeys(`imp/${id}/raw/`)) {
      if (ctx.budget && ctx.budget.left() < 5000) return false;
      await deleteRaw(k);
      removed += 1;
    }
    return true;
  };
  for (const r of ix.rows.filter((x) => x.st === "uploading" && Date.parse(x.at) + (ABANDONED_AFTER_DAYS + 1) * day < nowMs())) {
    const got = await getRecord("import_run", r.id);
    const run = got && got.data;
    if (!run || run.status !== "uploading" || !run.upload || Date.parse(run.upload.expires_at) + ABANDONED_AFTER_DAYS * day > nowMs()) continue;
    await updateRecord("import_run", run.id, (x) => (x.status !== "uploading" ? null : { ...x, status: "cancelled", cancel_reason: "abandoned", finished_at: nowIso() }), { by: "import", origin: "import", actor_kind: "import", requestId: "staging_gc" });
    if (!(await drop(run.id))) return { done: false, progress: removed };
  }
  for (const r of ix.rows.filter((x) => x.fin && Date.parse(x.fin) + STAGING_KEEP_DAYS * day < nowMs())) {
    if (!(await drop(r.id))) return { done: false, progress: removed };
  }
  return { progress: removed };
}

async function conflictsWaiting() {
  const ix = await readIndex("import-runs", "");
  const last = ix.rows.filter((r) => r.st === "done").sort((a, b) => (a.at < b.at ? 1 : -1))[0];
  return last && last.sum ? last.sum.conflicts || 0 : 0;
}

export default defineModule({
  name: "import",
  types,
  routes: importRoutes,
  importPhases: userPhases,
  sweeps: [
    { key: "import.staging_gc", label: "Old import staging", lane: "bulk", every: "daily", at_local: "04:40", mutates: false, maintenance: true, run: stagingGc },
  ],
  attention: [{ key: "import.conflicts", label: "Import conflicts to settle", perm: "import:run", count: conflictsWaiting, link: "#/import" }],
  exportTypes: ["import_run"],
});
