// M8: the automatic daily import key (design §10.9 "daily delta imports",
// §4.9; docs/CRM-IMPORT.md "Automatic daily import"). An owner makes one
// long-lived, revocable key; it can only create an import run (and through
// that run's own one-run key upload its pack and start it). Every other
// route refuses it; it is stored hashed and shown once; making, revoking,
// using and refused uses are audited; each automatic import tells the
// owners when it's done. The upload script takes it with --key-file and
// makes the run itself. A newer export updates and adds by the usual rules.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { setup, store, officeData, runToEnd, sha, manifestFor, chunked, staging, generate } from "./fixtures.mjs";
import { writeExport } from "../fixtures/rotor-synthetic.mjs";
import { advance, hours } from "../../helpers/crm-clock.mjs";

const pack = await import("../../../build/crm_import_pack.mjs");
const uploadCli = await import("../../../build/crm_import_upload.mjs");
const R = await import("../../../netlify/lib/crm/core/registry.mjs");
const AK = await import("../../../netlify/lib/crm/modules/import/autokey.mjs");
const crmApi = (await import("../../../netlify/functions/crm-api.mjs")).default;
const HOST = "https://www.bartawindowwashing.com";

const tmp = () => mkdtempSync(path.join(os.tmpdir(), "barta-autokey-test-"));
const quiet = () => { const lines = []; return { log: (s) => lines.push(String(s)), error: (s) => lines.push("ERR " + String(s)), lines }; };
const apiFetch = (calls = []) => async (url, init = {}) => { calls.push({ url: String(url), method: init.method || "GET" }); return crmApi(new Request(url, init), {}); };
const bearer = (k) => ({ authorization: `Bearer ${k}` });
const asKey = (t, k, p, o = {}) => t.api(p, { ...o, headers: { ...bearer(k), ...(o.headers || {}) }, csrf: false, client: false });
const events = (t, id) => t.stores.data.keys(`evt/import_key/${id}/`).map((k) => k.split("--")[1]);

test("the key: made once by an owner, shown once, stored hashed, audited; owners only", async () => {
  const { t, owner, admin } = await setup();
  try {
    assert.equal((await t.api("/import/auto-key", { method: "POST", as: admin, body: {} })).status, 403, "the office can't make one");
    const made = await t.api("/import/auto-key", { method: "POST", as: owner, body: { name: "Daily import" } });
    assert.equal(made.status, 201, JSON.stringify(made.body));
    const key = made.body.data.key;
    assert.match(key, /^bauto_[0-9A-Za-z]{40}$/);
    assert.equal(made.body.data.record.last4, key.slice(-4));
    // only its hash is kept: nowhere in the store is the key itself
    for (const k of t.stores.data.keys("")) assert.ok(!JSON.stringify(t.stores.data.json(k) ?? "").includes(key), `the key is not in ${k}`);
    assert.ok(t.stores.data.keys(`ptr/import-auto-key/${AK.autoKeyHash(key)}`).length === 1);
    const view = await t.api("/import/auto-key", { as: owner });
    assert.equal(view.status, 200);
    assert.equal(view.body.data.key.last4, key.slice(-4));
    assert.ok(!JSON.stringify(view.body).includes(AK.autoKeyHash(key)), "the hash never leaves the site");
    // audited: the record's create event and a row of the day's activity
    const id = made.body.data.record.id;
    assert.ok(t.stores.data.keys(`evt/import_key/${id}/`).length >= 1);
    assert.ok(t.stores.data.keys("aud/").some((k) => k.includes(`--import_key--${id}--`)), "on the Audit screen");
    // a second key replaces the first: the first stops working at once
    const second = (await t.api("/import/auto-key", { method: "POST", as: owner, body: {} })).body.data;
    const m = manifestFor(chunked({ customers: generate({ scale: 0.01, seed: 3 }).customers }));
    assert.equal((await asKey(t, key, "/import/auto/runs", { method: "POST", body: { manifest: m } })).status, 401, "the replaced key");
    assert.ok(events(t, id).includes("revoke"));
    const v2 = (await t.api("/import/auto-key", { as: owner })).body.data;
    assert.equal(v2.key.id, second.record.id);
    assert.equal(v2.earlier[0].id, id);
  } finally { t.done(); }
});

test("scoping: every other route refuses the key, and it reads nothing", async () => {
  const { t, owner } = await setup();
  try {
    const key = (await t.api("/import/auto-key", { method: "POST", as: owner, body: {} })).body.data.key;
    const fill = (p) => p.replace(/:([a-z_]+)/gi, (_, n) => (n === "id" ? "ir_00000000000000000001" : n === "key" ? "x" : "x"));
    const routes = R.allRoutes();
    assert.ok(routes.length > 100, "every registered route");
    const opened = [];
    for (const r of routes) {
      if (r.method === "POST" && r.path === "/import/auto/runs") continue;
      const res = await asKey(t, key, fill(r.path), { method: r.method, ...(r.method === "GET" || r.method === "DELETE" ? {} : { body: {} }) });
      if (res.status < 400) opened.push(`${r.method} ${r.path} → ${res.status}`);
      // whatever the refusal, the answer holds no record of the CRM's
      assert.ok(!/"(ct|in|jb|vs|pm|ms)_[0-9a-z]{20}"/.test(res.text || ""), `${r.method} ${r.path} answered with a record`);
    }
    assert.deepEqual(opened, [], "the key opens nothing else");
    // the upload routes of a run refuse it too (they take only that run's own bimp_ key)
    const m = manifestFor(chunked({ customers: generate({ scale: 0.01, seed: 3 }).customers }));
    const made = await asKey(t, key, "/import/auto/runs", { method: "POST", body: { manifest: m } });
    assert.equal(made.status, 201, JSON.stringify(made.body));
    const runId = made.body.data.run.id;
    for (const [method, p] of [["GET", "/import/upload"], ["PUT", `/import/runs/${runId}/manifest`], ["POST", `/import/runs/${runId}/start`], ["POST", `/import/runs/${runId}/media-check`], ["GET", `/import/runs/${runId}`]]) {
      const res = await asKey(t, key, p, { method, ...(method === "GET" ? {} : { body: method === "PUT" ? m : {} }) });
      assert.equal(res.status, 401, `${method} ${p}`);
    }
    // nothing but a well-formed key gets in; no key, someone else's kind of key
    assert.equal((await t.api("/import/auto/runs", { method: "POST", body: { manifest: m }, csrf: false, client: false })).status, 401);
    assert.equal((await asKey(t, "bauto_" + "A".repeat(40), "/import/auto/runs", { method: "POST", body: { manifest: m } })).status, 401);
    assert.equal((await asKey(t, made.body.data.upload_key, "/import/auto/runs", { method: "POST", body: { manifest: m } })).status, 401, "a one-run upload key can't make runs");
    assert.equal((await t.api("/import/auto/runs", { method: "POST", as: owner, body: { manifest: m } })).status, 401, "nor can an owner's session");
  } finally { t.done(); }
});

test("each use: one run a time, never an older export, at most a few a day, never while paused; refusals are audited", async () => {
  const { t, owner } = await setup();
  try {
    const made = (await t.api("/import/auto-key", { method: "POST", as: owner, body: {} })).body.data;
    const key = made.key, id = made.record.id;
    const m = (as_of) => manifestFor(chunked({ customers: generate({ scale: 0.01, seed: 3 }).customers }), as_of);
    const r1 = await asKey(t, key, "/import/auto/runs", { method: "POST", body: { manifest: m("2026-11-16") } });
    assert.equal(r1.status, 201);
    const run = (await store.getRecord("import_run", r1.body.data.run.id)).data;
    assert.equal(run.auto_key_id, id, "the run says which key made it");
    assert.equal(r1.body.data.run.automatic, true);
    const k = (await store.getRecord("import_key", id)).data;
    assert.equal(k.uses, 1);
    assert.equal(k.last_run_id, run.id);
    // one import at a time: a second while the first waits for its upload is fine (uploads), a running one blocks
    await store.updateRecord("import_run", run.id, (x) => ({ ...x, status: "running" }), { by: "import", origin: "import", actor_kind: "import" });
    assert.equal((await asKey(t, key, "/import/auto/runs", { method: "POST", body: { manifest: m("2026-11-17") } })).status, 409);
    await store.updateRecord("import_run", run.id, (x) => ({ ...x, status: "done", finished_at: new Date().toISOString() }), { by: "import", origin: "import", actor_kind: "import" });
    // never an export older than the newest finished import
    const old = await asKey(t, key, "/import/auto/runs", { method: "POST", body: { manifest: m("2026-11-15") } });
    assert.equal(old.status, 409);
    assert.match(old.body.error.message, /older than the newest import/);
    // a bad manifest is refused
    assert.equal((await asKey(t, key, "/import/auto/runs", { method: "POST", body: { manifest: { v: 1 } } })).status, 400);
    // paused: nothing starts
    await t.api("/admin/pause", { method: "POST", as: owner, body: { confirm: "PAUSE" } });
    assert.equal((await asKey(t, key, "/import/auto/runs", { method: "POST", body: { manifest: m("2026-11-17") } })).status, 409);
    await t.api("/admin/resume", { method: "POST", as: owner, body: { confirm: "RESUME" } });
    // at most AUTO_RUNS_PER_DAY a day
    let made2 = 1;
    for (let i = 0; i < AK.AUTO_RUNS_PER_DAY + 1; i++) {
      const r = await asKey(t, key, "/import/auto/runs", { method: "POST", body: { manifest: m("2026-11-17") } });
      if (r.status === 201) made2 += 1; else assert.equal(r.status, 409);
    }
    assert.equal(made2, AK.AUTO_RUNS_PER_DAY, "no more than the day's limit");
    advance(hours(24));
    assert.equal((await asKey(t, key, "/import/auto/runs", { method: "POST", body: { manifest: m("2026-11-18") } })).status, 201, "a new day");
    const evs = events(t, id);
    for (const why of ["refused"]) assert.ok(evs.includes(why), `a ${why} event`);
    const reasons = t.stores.data.keys(`evt/import_key/${id}/`).map((k) => t.stores.data.json(k)).filter((e) => e.action === "refused").map((e) => e.reason).sort();
    assert.deepEqual([...new Set(reasons)], ["bad_manifest", "busy", "older_export", "paused", "too_many_today"]);
    // revoked: refused at once
    assert.equal((await t.api(`/import/auto-key/${id}`, { method: "DELETE", as: owner })).status, 200);
    assert.equal((await asKey(t, key, "/import/auto/runs", { method: "POST", body: { manifest: m("2026-11-18") } })).status, 401);
    assert.equal((await t.api("/import/auto-key", { as: owner })).body.data.key, null);
  } finally { t.done(); }
});

test("the upload script with the key: makes the run, uploads, starts it; a newer export updates and adds; the owners are told", async () => {
  const keys = officeData.newKeyPair();
  const keyDir = tmp(), ex = tmp(), out = tmp(), ex2 = tmp(), out2 = tmp();
  writeFileSync(path.join(keyDir, "public.pem"), keys.publicKeyPem);
  const { t, owner } = await setup();
  const prevKey = process.env.OFFICE_DATA_KEY;
  // (the second owner is told too)
  process.env.OFFICE_DATA_KEY = keys.privateKey;
  try {
    const key = (await t.api("/import/auto-key", { method: "POST", as: owner, body: {} })).body.data.key;
    const keyFile = path.join(keyDir, "auto-key.txt");
    writeFileSync(keyFile, key + "\n");
    writeExport(ex, { scale: 0.02, seed: 5 });
    assert.equal(pack.main([ex, out, "--as-of", "2026-11-16", "--public-key", path.join(keyDir, "public.pem")], quiet()), 0);
    const calls = [];
    const io = quiet();
    const code = await uploadCli.main([out, "--site", HOST, "--key-file", keyFile, "--no-media"], { env: {}, ask: async () => { throw new Error("not asked"); }, fetch: apiFetch(calls), sleep: async () => {}, ...io });
    assert.equal(code, 0, io.lines.join("\n"));
    assert.ok(calls[0].url.endsWith("/import/auto/runs"), "the run is made first, with the key");
    assert.ok(calls.some((c) => c.url.endsWith("/start")), "and started: nobody needs to tap Start");
    assert.ok(io.lines.every((l) => !l.includes(key) && !/bimp_[0-9A-Za-z]{32}/.test(l)), "no key is printed");
    const runId = calls.find((c) => /\/import\/runs\/ir_[0-9a-z]{20}\/start$/.test(c.url)).url.match(/(ir_[0-9a-z]{20})/)[1];
    const r = await runToEnd(t, owner, runId, { start: false });
    assert.equal(r.run.status, "done");
    const created = r.run.summary.created;
    assert.ok(created > 0);
    for (let i = 0; i < 4; i++) await t.runWorker({ lane: "fast" });
    const notes = t.stores.data.keys("rec/notification/").map((k) => t.stores.data.json(k)).filter((n) => n.title === "Daily Rotor import done");
    assert.ok(notes.some((n) => n.user_id === owner.id), "the owners are told");
    const note = notes[0];
    assert.match(note.body, /Nov 16 is in: [\d,]+ added, [\d,]+ updated\. Nothing to settle\./);
    assert.equal(note.link, `/import/${runId}`);

    // the next day's export: one customer renamed in Rotor, one new: updated and added, nothing deleted
    advance(hours(24));
    const base = generate({ scale: 0.02, seed: 5 });
    const before = t.stores.data.keys("rec/contact/").length;
    writeExport(ex2, { scale: 0.02, seed: 5 });
    const file = path.join(ex2, "customers.jsonl");
    const rows = (await import("node:fs")).readFileSync(file, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l));
    rows[0].last_name = "Renamedson";
    rows.push({ ...rows[1], id: "cust-new-0001", first_name: "Newly", last_name: "Added", phone: "(763) 555-0177", email: "newly.added@example.com" });
    writeFileSync(file, rows.map((x) => JSON.stringify(x)).join("\n") + "\n");
    assert.equal(pack.main([ex2, out2, "--as-of", "2026-11-17", "--public-key", path.join(keyDir, "public.pem")], quiet()), 0);
    const calls2 = [];
    assert.equal(await uploadCli.main([out2, "--site", HOST, "--key-file", keyFile, "--no-media"], { env: {}, fetch: apiFetch(calls2), sleep: async () => {}, ...quiet() }), 0);
    const runId2 = calls2.find((c) => /\/start$/.test(c.url)).url.match(/(ir_[0-9a-z]{20})/)[1];
    const r2 = await runToEnd(t, owner, runId2, { start: false });
    assert.equal(r2.run.status, "done");
    assert.equal(r2.run.summary.created >= 1, true, "the new customer is added");
    assert.ok(r2.run.summary.updated >= 1, "Rotor's change is applied");
    assert.equal(r2.run.summary.conflicts_open, 0);
    assert.equal(t.stores.data.keys("rec/contact/").length, before + 1, "nothing deleted, one added");
    assert.ok(base.customers.length > 1);
    // --no-start leaves an automatic run for the owner
    const calls3 = [];
    assert.equal(await uploadCli.main([out2, "--site", HOST, "--key-file", keyFile, "--no-media", "--no-start"], { env: {}, fetch: apiFetch(calls3), sleep: async () => {}, ...quiet() }), 0);
    assert.ok(!calls3.some((c) => c.url.endsWith("/start")));
  } finally {
    if (prevKey === undefined) delete process.env.OFFICE_DATA_KEY; else process.env.OFFICE_DATA_KEY = prevKey;
    for (const d of [keyDir, ex, out, ex2, out2]) rmSync(d, { recursive: true, force: true });
    t.done();
  }
});

test("the script refuses a key file inside a worktree and a key that is neither kind", async () => {
  const io = quiet();
  const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), "../../..");
  const dir = tmp();
  try {
    assert.equal(await uploadCli.main([dir, "--site", HOST, "--key-file", path.join(ROOT, "package.json")], { env: {}, ...io }), 2);
    assert.equal(await uploadCli.main([dir, "--site", HOST], { env: { CRM_UPLOAD_KEY: "bcrm_" + "a".repeat(32) }, ...io }), 2, "an API key is not an import key");
    assert.equal(uploadCli.AUTO_KEY_RE.test(AK.newAutoKey()), true);
    assert.ok(!staging.SHA_RE.test(sha("x").slice(1)));
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
