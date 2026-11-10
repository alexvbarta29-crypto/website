// Schema compatibility across a deploy (design §3.14 "Schema rules", rule 4;
// §11.4 M1.3 schema-compat.test.mjs). Every push to the live branch
// deploys while an old background invocation may still run for 15
// minutes, so old and new code overlap. This loads the PREVIOUS commit's
// type definitions (git archive into a temp dir) and runs their
// validators over records written by the current ones: nothing dropped,
// nothing rejected. CRM_SCHEMA_BASE picks another base (default HEAD~1);
// without git history the test is skipped.
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, existsSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL, fileURLToPath } from "node:url";

await import("../../../netlify/lib/crm/modules/index.mjs");
const R = await import("../../../netlify/lib/crm/core/registry.mjs");
const { newId, prefixOf } = await import("../../../netlify/lib/crm/core/ids.mjs");

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const BASE = process.env.CRM_SCHEMA_BASE || "HEAD~1";

function previousTree() {
  const git = (args) => spawnSync("git", args, { cwd: ROOT, encoding: "buffer" });
  if (git(["rev-parse", "--verify", `${BASE}^{commit}`]).status !== 0) return null;
  if (git(["cat-file", "-e", `${BASE}:netlify/lib/crm/modules`]).status !== 0) return null;
  const dir = mkdtempSync(path.join(tmpdir(), "crm-schema-"));
  const archive = execFileSync("git", ["archive", "--format=tar", BASE, "netlify/lib"], { cwd: ROOT, maxBuffer: 64 * 1024 * 1024 });
  const untar = spawnSync("tar", ["-x", "-C", dir], { input: archive });
  if (untar.status !== 0) { rmSync(dir, { recursive: true, force: true }); return null; }
  return dir;
}

async function oldTypes(dir) {
  const mods = path.join(dir, "netlify/lib/crm/modules");
  const out = new Map();
  for (const d of readdirSync(mods, { withFileTypes: true })) {
    if (!d.isDirectory()) continue;
    for (const f of ["types.mjs", "types-field.mjs"]) {
      const file = path.join(mods, d.name, f);
      if (!existsSync(file)) continue;
      const m = await import(pathToFileURL(file).href);
      for (const t of m.types || []) out.set(t.type, t);
    }
  }
  return out;
}

const envelope = (def) => {
  const id = def.prefix ? newId(def.type) : newId(def.idType || "contact");
  return { id, type: def.type, v: def.v, wv: 3, created_at: "2026-11-17T15:00:00.000Z", created_by: "us_0000000000000000000a", updated_at: "2026-11-17T15:05:00.000Z", updated_by: "us_0000000000000000000a" };
};

test("the previous commit's validators accept what this commit writes: nothing dropped, nothing rejected", async (t) => {
  const dir = previousTree();
  if (!dir) { t.skip(`no ${BASE} with the CRM modules to compare with`); return; }
  try {
    const old = await oldTypes(dir);
    let compared = 0;
    for (const def of R.allTypes()) {
      if (def.module && def.module.startsWith("fixture-")) continue;
      const prev = old.get(def.type);
      if (!prev) { t.diagnostic(`${def.type} is new in this commit`); continue; }
      const env = envelope(def);
      const written = { ...def.validate({ ...def.example(), id: env.id }, { op: "create" }), ...env };
      // a field the old code has never heard of rides along unchanged (rule 1)
      written.added_later = { kept: true };
      let back;
      assert.doesNotThrow(() => { back = prev.validate(JSON.parse(JSON.stringify(written)), { op: "update", before: written }); }, `${def.type}: the old validator rejected a new record`);
      for (const [k, v] of Object.entries(written)) {
        assert.ok(Object.hasOwn(back, k), `${def.type}: the old validator dropped ${k}`);
        assert.deepEqual(back[k], v, `${def.type}: the old validator changed ${k}`);
      }
      assert.ok(prev.v <= def.v, `${def.type}: v went down (${prev.v} → ${def.v})`);
      if (prev.v < def.v) assert.ok(def.migrate[def.v], `${def.type}: v ${def.v} needs a migrate[${def.v}]`);
      if (def.prefix) assert.equal(prefixOf(def.type), def.prefix, `${def.type}: its id prefix never changes`);
      compared += 1;
    }
    assert.ok(compared >= 2, "at least the user and contact_stats types were compared");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("an unknown enum value already stored is kept, not rejected (schema rule 1)", async () => {
  for (const def of R.allTypes()) {
    if (def.module && def.module.startsWith("fixture-")) continue;
    const ex = def.example();
    for (const [k, v] of Object.entries(ex)) {
      if (typeof v !== "string" || !["status", "role", "kind", "lane"].includes(k)) continue;
      const rec = { ...ex, ...envelope(def), [k]: "from_the_future" };
      let out;
      assert.doesNotThrow(() => { out = def.validate({ ...rec }, { op: "update", before: rec }); }, `${def.type}.${k}`);
      assert.equal(out[k], "from_the_future", `${def.type}.${k} kept`);
    }
  }
});
