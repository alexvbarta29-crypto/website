// M2c acceptance: upload (design §11.4 "upload.test.mjs", §10.1 steps 3-5,
// §4.9 upload keys). An upload key works only for its own run (and only
// for 24 hours, and only on the upload routes); the pack script refuses a
// path inside any worktree of this repository; media are uploaded, never
// fetched by the site. End to end: a synthetic export is packed (sealed
// with a throwaway key pair) into a temp folder outside the repo, uploaded
// by the upload script through the real API handler, run on the bulk lane,
// and the report passes.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, readdirSync, readFileSync, writeFileSync, symlinkSync, existsSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { setup, store, officeData, runToEnd, sha } from "./fixtures.mjs";
import { writeExport } from "../fixtures/rotor-synthetic.mjs";
import { advance, hours } from "../../helpers/crm-clock.mjs";

const pack = await import("../../../build/crm_import_pack.mjs");
const uploadCli = await import("../../../build/crm_import_upload.mjs");
const crmApi = (await import("../../../netlify/functions/crm-api.mjs")).default;
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const HOST = "https://www.bartawindowwashing.com";

const tmp = () => mkdtempSync(path.join(os.tmpdir(), "barta-import-test-"));
const quiet = () => { const lines = []; return { log: (s) => lines.push(String(s)), error: (s) => lines.push("ERR " + String(s)), lines }; };
// The upload script's fetch, answered in process by the real API handler.
const apiFetch = (calls = []) => async (url, init = {}) => { calls.push({ url: String(url), method: init.method || "GET" }); return crmApi(new Request(url, init), {}); };

function keyPair() {
  const k = officeData.newKeyPair();
  const dir = tmp();
  writeFileSync(path.join(dir, "public.pem"), k.publicKeyPem);
  return { private: k.privateKey, pem: path.join(dir, "public.pem"), dir };
}

test("the pack script refuses a path inside any worktree (exit 2) and prints counts only", () => {
  const io = quiet();
  const ex = tmp(), linkDir = tmp(), other = tmp();
  try {
    writeExport(ex, { scale: 0.01, seed: 2 });
    // the output inside this checkout, in a folder that doesn't exist yet, and the export inside it
    assert.equal(pack.main([ex, path.join(ROOT, "tmp-pack-out"), "--as-of", "2026-11-10"], io), 2);
    assert.equal(pack.main([path.join(ROOT, "tests"), path.join(ex, "..", "x"), "--as-of", "2026-11-10"], io), 2);
    // a symlink outside the repo that points back into it
    const link = path.join(linkDir, "link");
    symlinkSync(ROOT, link);
    assert.equal(pack.main([ex, path.join(link, "out"), "--as-of", "2026-11-10"], io), 2);
    // every worktree counts, not just this checkout: a fake list of roots
    assert.equal(pack.main([ex, path.join(other, "out"), "--as-of", "2026-11-10"], { ...io, roots: [ROOT, other] }), 2);
    assert.ok(!existsSync(path.join(ROOT, "tmp-pack-out")), "nothing was written in the repo");
    // the upload script refuses a pack folder inside a worktree too
    return uploadCli.main([path.join(ROOT, "tests"), "--site", HOST], { env: { CRM_UPLOAD_KEY: "bimp_" + "a".repeat(32) }, ...io }).then((code) => {
      assert.equal(code, 2);
      assert.ok(io.lines.every((l) => !/@example\.com|\+1763555|Example Ave/.test(l)), "no value is ever printed");
    });
  } finally { for (const d of [ex, linkDir, other]) rmSync(d, { recursive: true, force: true }); }
});

test("pack → upload → run: sealed chunks under 4.5 MB, a key for one run only, media uploaded and never fetched", async () => {
  const keys = keyPair();
  const { t, owner } = await setup();
  const ex = tmp(), out = tmp();
  const prevKey = process.env.OFFICE_DATA_KEY;
  process.env.OFFICE_DATA_KEY = keys.private;
  try {
    writeExport(ex, { scale: 0.02, seed: 5, media: true });
    const io = quiet();
    assert.equal(pack.main([ex, out, "--as-of", "2026-11-10", "--public-key", keys.pem], { ...io, env: { OFFICE_DATA_KEY: keys.private } }), 0, io.lines.join("\n"));
    const manifest = JSON.parse(readFileSync(path.join(out, "manifest.json"), "utf8"));
    assert.equal(manifest.kind, "barta-import-manifest");
    assert.ok(manifest.entities.customers.rows > 0 && manifest.media.count > 0);
    const chunkFiles = readdirSync(path.join(out, "chunks"));
    assert.ok(chunkFiles.every((f) => /^[a-z_]+-\d{4}\.sealed\.json$/.test(f)));
    assert.ok(!/@|Example Ave|\+1763/.test(readFileSync(path.join(out, "manifest.json"), "utf8")), "the manifest holds no personal data");
    assert.ok(io.lines.every((l) => !/@example\.com|\+1763555|Example Ave/.test(l)), "the pack prints counts only");
    // packing again into the same folder needs --force
    assert.equal(pack.main([ex, out, "--as-of", "2026-11-10", "--public-key", keys.pem], quiet()), 1);

    // the owner makes two runs; each key works for its own only
    const a = await t.api("/import/runs", { method: "POST", as: owner, body: { note: "weekly" } });
    const b = await t.api("/import/runs", { method: "POST", as: owner, body: {} });
    assert.equal(a.status, 201);
    const keyA = a.body.data.upload_key, keyB = b.body.data.upload_key;
    assert.match(keyA, /^bimp_[0-9A-Za-z]{32}$/);
    assert.ok(!JSON.stringify(await store.getRecord("import_run", a.body.data.run.id)).includes(keyA), "only the key's hash is stored");
    const runA = a.body.data.run.id, runB = b.body.data.run.id;
    const bearer = (k) => ({ authorization: `Bearer ${k}` });
    const chunkName = manifest.entities.customers.chunks[0].name;
    const chunkBytes = readFileSync(path.join(out, "chunks", `${chunkName}.sealed.json`));
    const put = (run, k) => t.api(`/import/runs/${run}/chunks/${chunkName}`, { method: "PUT", headers: bearer(k), raw: chunkBytes, csrf: false, client: false });
    assert.equal((await put(runB, keyA)).status, 401, "A's key on B's run");
    assert.equal((await put(runA, "bimp_" + "Z".repeat(32))).status, 401, "a made-up key");
    assert.equal((await t.api("/import/runs", { headers: bearer(keyA), csrf: false, client: false })).status, 401, "the key opens no owner route");
    assert.equal((await t.api("/contacts", { headers: bearer(keyA), csrf: false, client: false })).status, 401, "nor any other CRM route");
    assert.equal((await t.api(`/import/runs/${runA}/start`, { method: "POST", headers: bearer(keyB), body: {}, csrf: false, client: false })).status, 401);

    // the upload script with key A: manifest, chunks, media, start
    const calls = [];
    const uio = quiet();
    const code = await uploadCli.main([out, "--site", HOST], { env: { CRM_UPLOAD_KEY: keyA }, fetch: apiFetch(calls), sleep: async () => {}, ...uio });
    assert.equal(code, 0, uio.lines.join("\n"));
    assert.ok(uio.lines.every((l) => !l.includes(keyA)), "the key is never printed");
    const media = JSON.parse(readFileSync(path.join(out, "media.json"), "utf8"));
    assert.equal(calls.filter((c) => c.url.includes("/media/")).length, media.length, "each media file is PUT once");
    assert.deepEqual(t.fetchCalls(), [], "the site fetched nothing: media arrive as uploads");
    // an HTML attachment is kept download-only; images keep their type
    const files = store.listKeys ? (await store.listKeys("rec/file/")) : [];
    const recs = await Promise.all(files.map(async (k) => (await store.getRaw(k)).data));
    assert.ok(recs.some((f) => f.download_only === true && f.kind === "import_media"));
    assert.ok(recs.some((f) => f.content_type === "image/jpeg" && !f.download_only));
    assert.ok(recs.every((f) => f.owner.type === "import_run" && f.owner.id === runA && /^[0-9a-f]{64}$/.test(f.rotor.url_sha256)));

    // the run, then a second upload of the same pack sends nothing again
    const r = await runToEnd(t, owner, runA, { start: false });
    assert.equal(r.run.status, "done");
    assert.equal(r.run.summary.pass, true);
    assert.ok(r.run.summary.created > 0);
    const again = quiet();
    assert.equal(await uploadCli.main([out, "--site", HOST], { env: { CRM_UPLOAD_KEY: keyA }, fetch: apiFetch(), sleep: async () => {}, ...again }), 0);
    assert.match(again.lines.join("\n"), /is done: nothing to upload/);

    // a key older than 24 hours stops working
    advance(hours(25));
    assert.equal((await put(runB, keyB)).status, 401);
    const fresh = await t.api(`/import/runs/${runB}/key`, { method: "POST", as: owner, body: {} });
    assert.equal(fresh.status, 200);
    assert.equal((await put(runB, keyB)).status, 401, "the old key stays dead");
    // run B has no manifest yet: no chunk before it (every chunk is checked against the manifest's checksum)
    const keyB2 = fresh.body.data.upload_key;
    const putB = () => t.api(`/import/runs/${runB}/chunks/${chunkName}`, { method: "PUT", headers: { ...bearer(keyB2), "x-content-sha256": sha(chunkBytes) }, raw: chunkBytes, csrf: false, client: false });
    const early = await putB();
    assert.equal(early.status, 409);
    assert.match(early.body.error.message, /manifest\.json first/);
    assert.equal((await t.api(`/import/runs/${runB}/manifest`, { method: "PUT", headers: bearer(keyB2), body: manifest, csrf: false, client: false })).status, 200);
    const okPut = await putB();
    assert.equal(okPut.status, 200);
    assert.equal(okPut.body.data.entity, "customers");
  } finally {
    if (prevKey === undefined) delete process.env.OFFICE_DATA_KEY; else process.env.OFFICE_DATA_KEY = prevKey;
    t.done();
    for (const d of [ex, out, keys.dir]) rmSync(d, { recursive: true, force: true });
  }
});

test("chunks are checked: manifest checksum, the key that sealed them, the name they carry, the site's OFFICE_DATA_KEY", async () => {
  const keys = keyPair();
  const other = officeData.newKeyPair();
  const { t } = await setup({ withTeam: false });
  const owner = await t.user("owner");
  const prevKey = process.env.OFFICE_DATA_KEY;
  try {
    const rows = [{ id: "00000000-0000-4000-8000-000000000001", first_name: "Pat", last_name: "Example", phone: "+17635550101", status: "active" }];
    const box = (payload, pem = readFileSync(keys.pem, "utf8")) => Buffer.from(JSON.stringify(pack.sealClean(payload, pem)));
    const good = box({ v: 1, kind: "barta-import-chunk", entity: "customers", n: 1, rows });
    const manifest = { v: 1, kind: "barta-import-manifest", as_of: "2026-11-10", entities: { customers: { rows: 1, chunks: [{ name: "customers-0001", rows: 1, sha256: sha(good) }] } } };
    const c = await t.api("/import/runs", { method: "POST", as: owner, body: { manifest } });
    const id = c.body.data.run.id, key = c.body.data.upload_key;
    const h = { authorization: `Bearer ${key}` };
    const putAs = (name, bytes, extra = {}) => t.api(`/import/runs/${id}/chunks/${name}`, { method: "PUT", headers: { ...h, ...extra }, raw: bytes, csrf: false, client: false });
    delete process.env.OFFICE_DATA_KEY;
    const noKey = await putAs("customers-0001", good);
    assert.equal(noKey.status, 503);
    assert.equal(noKey.body.error.code, "no_key");
    process.env.OFFICE_DATA_KEY = keys.private;
    assert.equal((await putAs("customers-0002", good)).status, 400, "not in the manifest");
    assert.equal((await putAs("customers-0001", box({ v: 1, kind: "barta-import-chunk", entity: "customers", n: 1, rows }))).status, 409, "other bytes than the manifest lists");
    assert.equal((await putAs("customers-0001", good, { "x-content-sha256": "0".repeat(64) })).status, 400, "damaged on the way");
    const ok = await putAs("customers-0001", good, { "x-content-sha256": sha(good) });
    assert.equal(ok.status, 200);
    assert.deepEqual(ok.body.data, { entity: "customers", rows: 1, invalid: 0 });
    // a chunk sealed for another key, or carrying another entity's name, is refused; a row no phase takes is counted
    const runWith = async (name, bytes, rows = 1) => {
      const ent = name.split("-")[0];
      const man = { v: 1, kind: "barta-import-manifest", as_of: "2026-11-10", entities: { [ent]: { rows, chunks: [{ name, rows, sha256: sha(bytes) }] } } };
      const r = await t.api("/import/runs", { method: "POST", as: owner, body: { manifest: man } });
      return t.api(`/import/runs/${r.body.data.run.id}/chunks/${name}`, { method: "PUT", headers: { authorization: `Bearer ${r.body.data.upload_key}` }, raw: bytes, csrf: false, client: false });
    };
    assert.equal((await runWith("customers-0001", box({ v: 1, kind: "barta-import-chunk", entity: "customers", n: 1, rows }, other.publicKeyPem))).status, 400, "sealed for another key");
    assert.equal((await runWith("leads-0001", good)).status, 400, "the name and the sealed entity must agree");
    const badBytes = box({ v: 1, kind: "barta-import-chunk", entity: "customers", n: 1, rows: [{ id: "bad id with spaces" }, ...rows] });
    const bad = await runWith("customers-0001", badBytes, 2);
    assert.equal(bad.status, 200);
    assert.equal(bad.body.data.invalid, 1, "a row no phase takes is counted, kept, and skipped later");
    // starting needs every chunk the manifest lists
    const m2 = { ...manifest, entities: { customers: { rows: 2, chunks: [manifest.entities.customers.chunks[0], { name: "customers-0002", rows: 1, sha256: "1".repeat(64) }] } } };
    const c2 = await t.api("/import/runs", { method: "POST", as: owner, body: { manifest: m2 } });
    const st = await t.api(`/import/runs/${c2.body.data.run.id}/start`, { method: "POST", as: owner, body: {} });
    assert.equal(st.status, 409);
    assert.match(st.body.error.message, /2 chunks are still missing/);
  } finally {
    if (prevKey === undefined) delete process.env.OFFICE_DATA_KEY; else process.env.OFFICE_DATA_KEY = prevKey;
    t.done();
    rmSync(keys.dir, { recursive: true, force: true });
  }
});

test("an owner's session uploads from the phone with the CSRF checks; a tech or an admin can't", async () => {
  const keys = keyPair();
  const { t, owner, admin, tech1 } = await setup();
  const prevKey = process.env.OFFICE_DATA_KEY;
  process.env.OFFICE_DATA_KEY = keys.private;
  try {
    const good = Buffer.from(JSON.stringify(pack.sealClean({ v: 1, kind: "barta-import-chunk", entity: "members", n: 1, rows: [] }, readFileSync(keys.pem, "utf8"))));
    const manifest = { v: 1, kind: "barta-import-manifest", as_of: "2026-11-10", entities: { members: { rows: 0, chunks: [{ name: "members-0001", rows: 0, sha256: sha(good) }] } } };
    const c = await t.api("/import/runs", { method: "POST", as: owner, body: { manifest } });
    const id = c.body.data.run.id;
    const put = (opts) => t.api(`/import/runs/${id}/chunks/members-0001`, { method: "PUT", raw: good, ...opts });
    assert.equal((await put({ as: owner, csrf: false })).status, 403, "a session write needs X-CRM");
    assert.equal((await put({ as: owner, headers: { origin: "https://evil.example" } })).status, 403);
    assert.equal((await put({ as: admin })).status, 403);
    assert.equal((await put({ as: tech1 })).status, 403);
    assert.equal((await put({})).status, 401);
    assert.equal((await put({ as: owner })).status, 200);
    for (const who of [admin, tech1]) assert.equal((await t.api("/import/runs", { as: who })).status, 403);
  } finally {
    if (prevKey === undefined) delete process.env.OFFICE_DATA_KEY; else process.env.OFFICE_DATA_KEY = prevKey;
    t.done();
    rmSync(keys.dir, { recursive: true, force: true });
  }
});

test("the import's server code never fetches anything", () => {
  const dir = path.join(ROOT, "netlify/lib/crm/modules/import");
  for (const f of readdirSync(dir)) {
    const src = readFileSync(path.join(dir, f), "utf8");
    assert.ok(!/\bfetch\s*\(/.test(src), `${f} calls fetch`);
  }
});
