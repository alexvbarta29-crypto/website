// The off-site pull and the restore script (design §3.12): the pull reads
// the snapshot through the API with an owner's backup key and writes it
// sealed, outside the repository; the restore opens that copy, checks it
// in a scratch store, then restores paused with re-seated sequences. Both
// refuse a path inside any worktree.
import { test, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, readdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { crmTest, HOST } from "../../helpers/crm-http.mjs";
import { createCrmStores, useCrmStores } from "../../helpers/crm-memory-store.mjs";

const pullTool = await import("../../../build/crm_backup_pull.mjs");
const restoreTool = await import("../../../build/crm_restore.mjs");
const { newKeyPair, privateKey } = await import("../../../netlify/lib/office-data.mjs");
const L = await import("../../../netlify/lib/crm/core/lanes.mjs");
const store = await import("../../../netlify/lib/crm-store.mjs");
const crmApi = (await import("../../../netlify/functions/crm-api.mjs")).default;

const dirs = [];
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });
const tmp = () => { const d = mkdtempSync(path.join(tmpdir(), "crm-pull-")); dirs.push(d); return d; };

test("pull → sealed copy outside the repo → check → restore, paused, with sequences re-seated", async () => {
  const t = await crmTest({ now: "2026-11-17T07:00:00Z" });
  try {
    const owner = await t.user("owner");
    await t.user("tech");
    await store.withStoreScope({ requestId: "x" }, async () => {
      for (let i = 0; i < 3; i++) await store.nextNumber("job", { id: `jb_00000000000000000${i}0a` });
    });
    const run = await store.withStoreScope({ requestId: "x" }, () => L.createRun("backup.snapshot", { date: "2026-11-17" }, { by: "system" }, { kick: false }));
    for (let i = 0; i < 4; i++) await t.runWorker({ lane: "bulk" });
    assert.equal((await store.withStoreScope({ requestId: "x" }, () => L.getRun(run.id))).status, "done");
    const made = await t.api("/api-keys", { method: "POST", as: owner, body: { name: "Weekly pull", kind: "backup" } });
    const pair = newKeyPair();
    const out = tmp();
    const fetchFn = (url, init) => crmApi(new Request(url, init), {});
    const r = await pullTool.pull({ site: HOST, key: made.body.data.key, out, publicKeyPem: pair.publicKeyPem, fetchFn });
    assert.equal(r.date, "2026-11-17");
    assert.ok(r.parts >= 4);
    const files = readdirSync(path.join(out, "2026-11-17"), { recursive: true }).map(String);
    assert.ok(files.includes("manifest.sealed.json"));
    assert.ok(files.some((f) => /rec-user[\\/]part-0001\.sealed\.json$/.test(f)));
    const sample = readFileSync(path.join(out, "2026-11-17", "rec-user", "part-0001.sealed.json"), "utf8");
    assert.ok(!sample.includes(owner.login), "the copy is sealed, not readable");
    assert.ok(t.stores.data.json("sys/health").offsite_at, "the site knows the copy exists");

    // open it with the private key, check into a scratch store, then restore into a fresh one
    const key = privateKey({ OFFICE_DATA_KEY: pair.privateKey });
    const source = restoreTool.sourceFromDir(out, "2026-11-17", key);
    const scratch = useCrmStores(createCrmStores());
    await import("../../../netlify/lib/crm/modules/index.mjs");
    const check = await restoreTool.checkRestore(source);
    assert.equal(check.ok, true, JSON.stringify(check));
    assert.ok(scratch.data.has(`rec/user/${owner.id}`));
    const live = useCrmStores(createCrmStores());
    const applied = await restoreTool.applyRestore(source);
    assert.equal(live.data.calls.find((c) => c.op === "setJSON" || c.op === "set").key, "sys/mode");
    assert.equal(live.data.json("sys/mode").paused, true);
    assert.equal(live.data.json("seq/job").next, 3 + 100);
    assert.ok(applied.keys > 10);
  } finally {
    t.done();
  }
});

test("both scripts refuse a path inside the repository (exit 2) and need their secret from the environment", async () => {
  const errs = [];
  const io = { log: () => {}, error: (m) => errs.push(m) };
  assert.equal(await pullTool.main(["--site", HOST, "--out", "docs/backups"], { CRM_BACKUP_KEY: "bcrm_" + "a".repeat(32) }, io), 2);
  assert.equal(await pullTool.main(["--site", HOST, "--out", tmp()], {}, io), 1, "no key");
  assert.equal(await pullTool.main(["--site", "http://example.com", "--out", tmp()], { CRM_BACKUP_KEY: "bcrm_" + "a".repeat(32) }, io), 1, "https only");
  assert.equal(await restoreTool.main(["--site-id", "0123456789abcdef", "--date", "2026-11-17", "--check", "--from-dir", "tests"], { NETLIFY_AUTH_TOKEN: "x" }, io), 2);
  assert.equal(await restoreTool.main(["--site-id", "0123456789abcdef", "--date", "2026-11-17", "--check", "--apply"], { NETLIFY_AUTH_TOKEN: "x" }, io), 1, "one step at a time");
  assert.equal(await restoreTool.main(["--site-id", "0123456789abcdef", "--date", "2026-11-17", "--check"], {}, io), 1, "no token");
  assert.ok(pullTool.insideAnyWorktree(path.resolve("netlify")));
  assert.ok(!pullTool.insideAnyWorktree(tmp()));
  assert.ok(errs.every((m) => !/bcrm_a{32}/.test(m)), "a key is never printed");
});
