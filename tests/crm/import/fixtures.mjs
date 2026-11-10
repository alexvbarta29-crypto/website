// Fixtures for the import's tests (design §12.5): synthetic Rotor exports
// only (tests/crm/fixtures/rotor-synthetic.mjs), the API harness with fresh
// memory stores and a pinned clock, and helpers that stage an export the
// way the upload would (or seal it with a throwaway key) and step the bulk
// lane until the run is done.

import { createHash } from "node:crypto";
import { crmTest } from "../../helpers/crm-http.mjs";
import { generate } from "../fixtures/rotor-synthetic.mjs";

export const store = await import("../../../netlify/lib/crm-store.mjs");
export const runner = await import("../../../netlify/lib/crm/modules/import/runner.mjs");
export const staging = await import("../../../netlify/lib/crm/modules/import/staging.mjs");
export const runs = await import("../../../netlify/lib/crm/modules/import/runs.mjs");
export const ownership = await import("../../../netlify/lib/crm/modules/import/ownership.mjs");
export const ids = await import("../../../netlify/lib/crm/core/ids.mjs");
export const officeData = await import("../../../netlify/lib/office-data.mjs");
export { generate };

export const IMPORT = { by: "import", origin: "import", actor_kind: "import", requestId: "test" };
export const AUTOMATION = { by: "system", origin: "worker", actor_kind: "automation", requestId: "test" };
export const sha = (s) => createHash("sha256").update(s).digest("hex");

// The CRM users Alex made in M1.2, named like the synthetic export's five
// Rotor members (the import maps each to one of them by name).
export async function team(t) {
  const out = {};
  out.owner = await t.user("owner", { name: "Avery Sample", login: "avery" });
  out.owner2 = await t.user("owner", { name: "Blake Sample", login: "blake" });
  out.admin = await t.user("admin", { name: "Casey Specimen", login: "casey" });
  out.tech1 = await t.user("tech", { name: "Drew Example", login: "drew" });
  out.tech2 = await t.user("tech", { name: "Emery Example", login: "emery" });
  return out;
}

// A fresh harness (pinned clock, memory stores) with the team.
export async function setup({ now = "2026-11-17T15:00:00Z", withTeam = true } = {}) {
  const t = await crmTest({ now });
  const people = withTeam ? await team(t) : {};
  runner.IMPORT_LIMITS.stepRows = Infinity;
  return { t, ...people };
}

// Rows → chunks of `per` rows: { entity: [[rows], ...] }.
export function chunked(ex, per = 200) {
  const out = {};
  for (const [entity, rows] of Object.entries(ex)) {
    out[entity] = [];
    for (let i = 0; i < rows.length; i += per) out[entity].push(rows.slice(i, i + per));
  }
  return out;
}

// The manifest the pack would write for these chunks (checksums of the plaintext stand in for the sealed bytes).
export function manifestFor(chunks, as_of = "2026-11-10") {
  const entities = {};
  for (const [entity, list] of Object.entries(chunks)) {
    entities[entity] = { rows: list.reduce((s, c) => s + c.length, 0), chunks: list.map((rows, i) => ({ name: `${entity}-${String(i + 1).padStart(4, "0")}`, rows: rows.length, sha256: sha(JSON.stringify(rows)) })) };
  }
  return { v: 1, kind: "barta-import-manifest", as_of, entities, media: { count: 0, bytes: 0 } };
}

// A run with the export staged straight into imp/{runId}/raw/ (what the
// upload leaves there), as an owner. → { ir, key }
export async function stageRun(t, owner, ex, { per = 200, as_of = "2026-11-10" } = {}) {
  const chunks = chunked(ex, per);
  const res = await t.api("/import/runs", { method: "POST", as: owner, body: { manifest: manifestFor(chunks, as_of) } });
  if (res.status !== 201) throw new Error("run not created: " + JSON.stringify(res.body));
  const ir = res.body.data.run;
  for (const [entity, list] of Object.entries(chunks)) {
    for (const [i, rows] of list.entries()) await store.putRaw(staging.rawKey(ir.id, entity, String(i + 1).padStart(4, "0")), { entity, n: i + 1, rows, sha256: sha(JSON.stringify(rows)), invalid: [], invalid_count: 0 });
  }
  return { ir, key: res.body.data.upload_key };
}

// Starts a staged run and steps the bulk lane until it is done (or maxPasses).
// → { passes, run: the import_run, lane: the lane run }
export async function runToEnd(t, owner, irId, { maxPasses = 400, start = true, onPass } = {}) {
  if (start) {
    const s = await t.api(`/import/runs/${irId}/start`, { method: "POST", as: owner, body: {} });
    if (s.status !== 200) throw new Error("start failed: " + JSON.stringify(s.body));
  }
  let passes = 0;
  for (; passes < maxPasses; passes++) {
    const ir = (await store.getRecord("import_run", irId)).data;
    if (["done", "cancelled", "failed"].includes(ir.status)) break;
    await t.runWorker({ lane: "bulk" });
    if (onPass) await onPass(passes);
  }
  const ir = (await store.getRecord("import_run", irId)).data;
  const lane = ir.lane_run_id ? (await store.getRecord("run", ir.lane_run_id)).data : null;
  return { passes, run: ir, lane };
}

// One complete import of an export: stage, start, run. → { ir, passes, run }
export async function importExport(t, owner, ex, opts = {}) {
  const { ir } = await stageRun(t, owner, ex, opts);
  const r = await runToEnd(t, owner, ir.id, opts);
  return { ir, ...r };
}

// Every imported record's rotorFields, by key (for byte-identical checks).
export async function rotorSnapshot(S, types = ["contact", "property", "user"]) {
  const reg = await import("../../../netlify/lib/crm/core/registry.mjs");
  const out = {};
  for (const type of types) {
    const def = reg.getType(type);
    for (const k of S.data.keys(`rec/${type}/`)) {
      const rec = S.data.json(k);
      if (!rec.import) continue;
      out[k] = JSON.stringify(ownership.canon(ownership.pickFields(rec, def.rotorFields)));
    }
  }
  return out;
}

// A small export: the generator at a small scale (~2-5% of the real counts).
export const smallExport = (scale = 0.03, seed = 3) => generate({ scale, seed });
