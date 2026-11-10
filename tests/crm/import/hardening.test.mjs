// Regression tests from the M2c review: the team map the screen shows is
// the one the run applies; an upload key takes nothing once the run has
// left "uploading"; an abandoned upload's plaintext staging is removed;
// Rotor ids "." and ".." never become key segments; a cancelled or
// given-up run still gets its records into the lists; the pack refuses
// symlinked sub-folders into a worktree; the no-data scan flags a pack's
// media files. Synthetic data only.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, readdirSync, writeFileSync, symlinkSync, existsSync, cpSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { setup, store, stageRun, runToEnd, generate, runner, officeData, sha } from "./fixtures.mjs";
import { writeExport } from "../fixtures/rotor-synthetic.mjs";
import { advance, days } from "../../helpers/crm-clock.mjs";

const pack = await import("../../../build/crm_import_pack.mjs");
const scan = await import("../../../build/no_data_scan.mjs");
const { getModule } = await import("../../../netlify/lib/crm/core/registry.mjs");
const { deployContext } = await import("../../../netlify/lib/crm/core/context.mjs");
const lanes = await import("../../../netlify/lib/crm/core/lanes.mjs");

const uuid = (n) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const bearer = (k) => ({ authorization: `Bearer ${k}` });
const tmp = () => mkdtempSync(path.join(os.tmpdir(), "barta-import-hard-"));
const quiet = () => { const lines = []; return { log: (s) => lines.push(String(s)), error: (s) => lines.push("ERR " + String(s)), lines }; };
function bare(seed = 21) {
  const ex = generate({ scale: 0.02, seed });
  const keep = new Set(["members", "member_availability", "rate_settings"]);
  for (const k of Object.keys(ex)) if (!keep.has(k)) ex[k] = [];
  return ex;
}

test("the team map is fixed when the run starts: what the screen shows is what the run applies (a choice, a name match taken, \"new\")", async () => {
  const { t, owner, tech1, tech2 } = await setup();
  try {
    const ex = bare();
    const base = ex.members[0];
    const m1 = { ...base, user_id: uuid(901), name: "Drew Example", first_name: "Drew", last_name: "Example", email: null, role: "member" };
    const m2 = { ...base, user_id: uuid(902), name: "Dru Samplewise", first_name: "Dru", last_name: "Samplewise", email: null, role: "member" };
    const m3 = { ...base, user_id: uuid(903), name: "Emery Example", first_name: "Emery", last_name: "Example", email: null, role: "member" };
    ex.members = [m1, m2, m3];
    ex.member_availability = []; ex.rate_settings = [];
    const { ir } = await stageRun(t, owner, ex);
    // the owner: Rotor's "Dru Samplewise" is our Drew; "Emery Example" is somebody new
    assert.equal((await t.api(`/import/runs/${ir.id}/user-map`, { method: "POST", as: owner, body: { map: { [m2.user_id]: tech1.id, [m3.user_id]: "new" } } })).status, 200);
    const shown = (await t.api(`/import/runs/${ir.id}`, { as: owner })).body.data.team.members;
    const byRid = Object.fromEntries(shown.map((m) => [m.rid, m.match ? m.match.id : null]));
    assert.equal(byRid[m2.user_id], tech1.id);
    assert.equal(byRid[m1.user_id], null, "Drew's CRM user is taken: Rotor's Drew Example shows as new");
    assert.equal(byRid[m3.user_id], null, "the owner's \"new\" shows as new, though the name matches Emery");
    const r = await runToEnd(t, owner, ir.id);
    assert.equal(r.run.status, "done");
    const st = await runner.loadState(ir.id);
    assert.equal(st.users[m2.user_id], tech1.id);
    assert.notEqual(st.users[m1.user_id], tech1.id, "the run applies the screen's map");
    assert.notEqual(st.users[m3.user_id], tech2.id);
    const invited = t.stores.data.keys("rec/user/").map((k) => t.stores.data.json(k)).filter((u) => u.status === "invited");
    assert.equal(invited.length, 2, "two new users, as the screen said");
    assert.deepEqual(new Set([st.users[m1.user_id], st.users[m3.user_id]]), new Set(invited.map((u) => u.id)));
    // the map can't change once the run has started
    assert.equal((await t.api(`/import/runs/${ir.id}/user-map`, { method: "POST", as: owner, body: { map: { [m1.user_id]: tech2.id } } })).status, 409);
  } finally { t.done(); }
});

test("an upload key takes nothing once its run has started: media and media-check are refused, whoami says only the status", async () => {
  const { t, owner } = await setup();
  try {
    const { ir, key } = await stageRun(t, owner, generate({ scale: 0.01, seed: 4 }));
    const r = await runToEnd(t, owner, ir.id);
    assert.equal(r.run.status, "done");
    const h = "d".repeat(64);
    const put = await t.api(`/import/runs/${ir.id}/media/${h}`, { method: "PUT", raw: Buffer.from("<html><script>alert(1)</script></html>"), csrf: false, client: false, headers: { ...bearer(key), "x-media-ref": "message_attachment:x1" } });
    assert.equal(put.status, 409);
    assert.deepEqual(await store.listKeys("rec/file/"), [], "no file was written");
    assert.equal((await t.api(`/import/runs/${ir.id}/media-check`, { method: "POST", body: { hashes: [h] }, csrf: false, client: false, headers: bearer(key) })).status, 409);
    const who = await t.api("/import/upload", { headers: bearer(key), csrf: false, client: false });
    assert.equal(who.status, 200);
    assert.deepEqual(Object.keys(who.body.data).sort(), ["as_of", "run_id", "status"]);
    assert.equal(who.body.data.status, "done");
  } finally { t.done(); }
});

test("an abandoned upload (never started, its key ran out) is cancelled and its plaintext staging removed a week later", async () => {
  const k = officeData.newKeyPair();
  const prev = process.env.OFFICE_DATA_KEY;
  process.env.OFFICE_DATA_KEY = k.privateKey;
  const { t, owner } = await setup();
  try {
    const rows = [{ id: uuid(1), first_name: "Pat", last_name: "Example", phone: "+17635550101", status: "active" }];
    const good = Buffer.from(JSON.stringify(pack.sealClean({ v: 1, kind: "barta-import-chunk", entity: "customers", n: 1, rows }, k.publicKeyPem)));
    const manifest = { v: 1, kind: "barta-import-manifest", as_of: "2026-11-10", entities: { customers: { rows: 2, chunks: [{ name: "customers-0001", rows: 1, sha256: sha(good) }, { name: "customers-0002", rows: 1, sha256: "e".repeat(64) }] } } };
    const c = (await t.api("/import/runs", { method: "POST", as: owner, body: { manifest } })).body.data;
    assert.equal((await t.api(`/import/runs/${c.run.id}/chunks/customers-0001`, { method: "PUT", raw: good, csrf: false, client: false, headers: bearer(c.upload_key) })).status, 200);
    assert.equal((await store.listKeys(`imp/${c.run.id}/raw/`)).length, 1);
    const gc = getModule("import").sweeps.find((s) => s.key === "import.staging_gc");
    const sweep = () => store.withStoreScope({ deploy: deployContext(new Request("https://www.bartawindowwashing.com/"), {}), requestId: "gc" }, () => gc.run({ budget: null }));
    advance(days(5));
    await sweep();
    assert.equal((await store.getRecord("import_run", c.run.id)).data.status, "uploading", "within the week after the key ran out: left alone");
    assert.equal((await store.listKeys(`imp/${c.run.id}/raw/`)).length, 1);
    advance(days(4));
    await sweep();
    const run = (await store.getRecord("import_run", c.run.id)).data;
    assert.equal(run.status, "cancelled");
    assert.equal(run.cancel_reason, "abandoned");
    assert.deepEqual(await store.listKeys(`imp/${c.run.id}/raw/`), [], "the plaintext rows are gone");
    assert.equal((await t.api(`/import/runs/${c.run.id}/chunks/customers-0002`, { method: "PUT", raw: good, csrf: false, client: false, headers: bearer(c.upload_key) })).status, 401);
  } finally {
    if (prev === undefined) delete process.env.OFFICE_DATA_KEY; else process.env.OFFICE_DATA_KEY = prev;
    t.done();
  }
});

test("Rotor ids \".\" and \"..\" are refused as rows, and the store refuses dot segments in any key", async () => {
  const { t, owner } = await setup();
  try {
    const ex = generate({ scale: 0.01, seed: 4 });
    for (const k of Object.keys(ex)) if (!["members", "member_availability", "rate_settings", "customers", "leads"].includes(k)) ex[k] = [];
    const base = ex.customers[0];
    ex.customers = [{ ...base, id: ".." }, { ...base, id: ".", phone: "+17635550177", email: "dot.one@example.com" }, { ...base, id: "...", phone: "+17635550178", email: "dot.three@example.com" }];
    ex.leads = [{ ...ex.leads[0], id: "..", phone: "+17635550179", email: "dot.lead@example.com" }];
    ex.members = [...ex.members, { ...ex.members[0], user_id: "..", name: "Dot Person" }];
    const { ir } = await stageRun(t, owner, ex);
    const r = await runToEnd(t, owner, ir.id);
    assert.equal(r.run.status, "done");
    const st = await runner.loadState(ir.id);
    assert.equal(st.phases["contacts.customers"].skipped.invalid, 3);
    assert.equal(st.phases["contacts.leads"].skipped.invalid, 1);
    assert.equal(st.phases["system.users"].skipped.invalid, 1);
    assert.ok(!t.stores.data.keys("").some((k) => /(^|\/)\.{1,3}(\/|$)/.test(k)), "no key has a dot segment");
    for (const key of ["ptr/rotor/customer/..", "ptr/rotor/customer/.", "imp/x/./b", "../x", "./"]) {
      await assert.rejects(store.getRaw(key), (e) => e.name === "InputError", key);
      await assert.rejects(store.deleteRaw(key), (e) => e.name === "InputError", key);
    }
    for (const rid of [".", ".."]) await assert.rejects(store.readPointer("rotor/customer", rid), (e) => e.name === "InputError", rid);
    for (const key of ["imp/x/..", "imp/x/.", "imp/./b"]) await assert.rejects(store.putRaw(key, { x: 1 }), (e) => e.name === "InputError", key);
    await store.putRaw("imp/x/a.b", { ok: 1 });
    assert.deepEqual((await store.getRaw("imp/x/a.b")).data, { ok: 1 }, "dots inside a segment are fine");
  } finally { t.done(); }
});

test("a run cancelled mid-way still gets its records into the lists", async () => {
  const { t, owner } = await setup();
  try {
    const { ir } = await stageRun(t, owner, generate({ scale: 0.05, seed: 17 }));
    runner.IMPORT_LIMITS.stepRows = 20;
    assert.equal((await t.api(`/import/runs/${ir.id}/start`, { method: "POST", as: owner, body: {} })).status, 200);
    for (let i = 0; i < 4; i++) await t.runWorker({ lane: "bulk" });
    assert.equal((await t.api(`/import/runs/${ir.id}/cancel`, { method: "POST", as: owner, body: {} })).status, 200);
    runner.IMPORT_LIMITS.stepRows = Infinity;
    for (let i = 0; i < 4; i++) await t.runWorker({ lane: "bulk" });
    const contacts = t.stores.data.keys("rec/contact/").length;
    assert.ok(contacts > 0);
    const ix = await store.readIndex("contacts", "");
    assert.equal(ix.rows.length, contacts, "every written contact is listed");
  } finally { runner.IMPORT_LIMITS.stepRows = Infinity; t.done(); }
});

test("a run the lane gives up on still gets its records into the lists", async () => {
  const { t, owner } = await setup();
  try {
    const { ir } = await stageRun(t, owner, generate({ scale: 0.05, seed: 18 }));
    runner.IMPORT_LIMITS.stepRows = 20;
    assert.equal((await t.api(`/import/runs/${ir.id}/start`, { method: "POST", as: owner, body: {} })).status, 200);
    for (let i = 0; i < 3; i++) await t.runWorker({ lane: "bulk" });
    // storage keeps failing for the staged rows: every try fails until the lane gives up
    t.stores.data.fail({ op: ["get", "getWithMetadata"], key: new RegExp(`^imp/${ir.id}/raw/`), times: 100000 });
    for (let i = 0; i < 4 * lanes.RUN_MAX_ATTEMPTS; i++) {
      const run = (await store.getRecord("import_run", ir.id)).data;
      const lane = run.lane_run_id ? (await store.getRecord("run", run.lane_run_id)).data : null;
      if (lane && ["failed", "done"].includes(lane.status)) break;
      advance(61 * 60000);                  // past the retry wait (at most an hour), well short of the nightly index check
      await t.runWorker({ lane: "bulk" });
    }
    t.stores.data.clearHooks();
    runner.IMPORT_LIMITS.stepRows = Infinity;
    const run = (await store.getRecord("import_run", ir.id)).data;
    assert.equal((await store.getRecord("run", run.lane_run_id)).data.status, "failed", "the lane gave up");
    for (let i = 0; i < 4; i++) await t.runWorker({ lane: "bulk" });
    const contacts = t.stores.data.keys("rec/contact/").length;
    assert.ok(contacts > 0);
    assert.equal((await store.readIndex("contacts", "")).rows.length, contacts, "every written contact is listed");
  } finally { t.stores.data.clearHooks(); runner.IMPORT_LIMITS.stepRows = Infinity; t.done(); }
});

test("the pack refuses an output whose chunks/ or media/ is a symlink (into a worktree or anywhere): nothing is written there", () => {
  const work = tmp();
  try {
    const k = officeData.newKeyPair();
    writeFileSync(path.join(work, "pub.pem"), k.publicKeyPem);
    const ex = path.join(work, "export");
    writeExport(ex, { scale: 0.02, seed: 3, media: true });
    const fakeRepo = path.join(work, "fake-repo");
    mkdirSync(path.join(fakeRepo, "netlify", "data"), { recursive: true });
    for (const sub of ["chunks", "media"]) {
      const out = path.join(work, `out-${sub}`);
      mkdirSync(out);
      symlinkSync(path.join(fakeRepo, "netlify", "data"), path.join(out, sub));
      const io = quiet();
      assert.equal(pack.main([ex, out, "--as-of", "2026-11-10", "--public-key", path.join(work, "pub.pem")], { ...io, roots: [fakeRepo] }), 2, sub);
      assert.match(io.lines.join("\n"), /symbolic link|inside a worktree/i);
      assert.deepEqual(readdirSync(path.join(fakeRepo, "netlify", "data")), [], `nothing written through ${sub}/`);
      assert.ok(!existsSync(path.join(out, "manifest.json")));
    }
    // a symlinked output folder pointing outside every worktree is refused too (lstat)
    const real = path.join(work, "real-out");
    mkdirSync(real);
    const linked = path.join(work, "linked-out");
    symlinkSync(real, linked);
    assert.equal(pack.main([ex, linked, "--as-of", "2026-11-10", "--public-key", path.join(work, "pub.pem")], { ...quiet(), roots: [fakeRepo] }), 2);
    assert.deepEqual(readdirSync(real), []);
    // and a plain folder packs
    const ok = path.join(work, "ok-out");
    assert.equal(pack.main([ex, ok, "--as-of", "2026-11-10", "--public-key", path.join(work, "pub.pem")], { ...quiet(), roots: [fakeRepo] }), 0);
    assert.ok(readdirSync(path.join(ok, "media")).length > 0);
  } finally { rmSync(work, { recursive: true, force: true }); }
});

test("the no-data scan flags a pack's media files copied anywhere outside assets/ (named by hash, or a photo/PDF under another name)", () => {
  const work = tmp();
  try {
    const k = officeData.newKeyPair();
    writeFileSync(path.join(work, "pub.pem"), k.publicKeyPem);
    const ex = path.join(work, "export");
    writeExport(ex, { scale: 0.02, seed: 3, media: true });
    const out = path.join(work, "out");
    assert.equal(pack.main([ex, out, "--as-of", "2026-11-10", "--public-key", path.join(work, "pub.pem")], quiet()), 0);
    const tree = path.join(work, "tree");
    mkdirSync(path.join(tree, "docs"), { recursive: true });
    cpSync(path.join(out, "media"), path.join(tree, "imported"), { recursive: true });
    const media = readdirSync(path.join(tree, "imported"));
    assert.ok(media.length > 0);
    // a photo saved under a text name, and a PDF without extension
    writeFileSync(path.join(tree, "docs", "notes.txt"), Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 16, 74, 70, 73, 70]));
    writeFileSync(path.join(tree, "docs", "scan"), Buffer.from("%PDF-1.7\n%synthetic\n"));
    const found = scan.scanTree(tree);
    for (const f of media) assert.ok(found.some((x) => x.file === `imported/${f}`), `media file ${f.slice(0, 8)}… flagged`);
    assert.ok(found.some((x) => x.file === "docs/notes.txt" && /image or PDF/.test(x.kind)));
    assert.ok(found.some((x) => x.file === "docs/scan" && /image or PDF/.test(x.kind)));
    // the site's own images under assets/ pass
    const clean = path.join(work, "clean");
    mkdirSync(path.join(clean, "assets"), { recursive: true });
    writeFileSync(path.join(clean, "assets", "a".repeat(64)), Buffer.from([0xff, 0xd8, 0xff, 0xe0]));
    writeFileSync(path.join(clean, "assets", "logo.bin"), Buffer.from([0x89, 0x50, 0x4e, 0x47, 13, 10]));
    assert.deepEqual(scan.scanTree(clean), []);
  } finally { rmSync(work, { recursive: true, force: true }); }
});
