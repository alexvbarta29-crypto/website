// The M1.3 system routes and functions (design §4.9, §4.12, §7.1, §7.6):
// settings with If-Match and one permission each; health, runs, pause and
// resume; backups and export (and the owner-only backup key); API keys
// (the create route is secret, never kept in idem/); approvals and the
// badge; the audit feed and record history; the nightly auth sweep; the
// cron and both lanes once the CRM is set up.
import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { crmTest, HOST } from "../../helpers/crm-http.mjs";
import { pin } from "../../helpers/crm-clock.mjs";

const store = await import("../../../netlify/lib/crm-store.mjs");
const L = await import("../../../netlify/lib/crm/core/lanes.mjs");
const P = await import("../../../netlify/lib/crm/core/pending.mjs");
const { clearSweepCache } = await import("../../../netlify/lib/crm/core/sweeps.mjs");
const cronFn = (await import("../../../netlify/functions/crm-cron.mjs")).default;
const fastFn = (await import("../../../netlify/functions/crm-worker-background.mjs")).default;
const bulkFn = (await import("../../../netlify/functions/crm-bulk-background.mjs")).default;

let t, owner, admin, tech;
beforeEach(async () => {
  t = await crmTest({ now: "2026-11-17T15:00:00Z" });
  clearSweepCache();
  owner = await t.user("owner");
  admin = await t.user("admin");
  tech = await t.user("tech");
});
afterEach(() => t.done());

const scope = (fn) => store.withStoreScope({ requestId: "t" }, fn);

// ------------------------------------------------------------ settings

test("settings: each document opens for its own permission; owner-only ones stay owner-only", async () => {
  const mine = await t.api("/settings", { as: admin });
  const names = mine.body.data.map((s) => s.name);
  assert.ok(names.includes("company") && names.includes("messaging") && names.includes("automations"));
  assert.ok(!names.includes("permissions") && !names.includes("integrations") && !names.includes("messaging_test"));
  assert.equal((await t.api("/settings/company", { as: tech })).status, 403);
  assert.equal((await t.api("/settings/permissions", { as: admin })).status, 403);
  assert.equal((await t.api("/settings/nothing", { as: owner })).status, 404);
  const company = await t.api("/settings/company", { as: admin });
  assert.equal(company.status, 200);
  assert.equal(company.body.data.data.name, "Barta Window Washing");
  assert.equal(company.body.data.etag, null, "never saved yet");
  assert.equal(company.body.data.perm, "settings:general");
});

test("settings: PUT needs If-Match (\"new\" first), answers 412 with the current value when stale, and validates", async () => {
  const body = { name: "Barta Window Washing", phone: "(763) 314-3400" };
  assert.equal((await t.api("/settings/company", { method: "PUT", as: admin, body })).status, 400, "no If-Match");
  const first = await t.api("/settings/company", { method: "PUT", as: admin, ifMatch: "new", body });
  assert.equal(first.status, 200, JSON.stringify(first.body));
  const etag = first.body.data.etag;
  assert.ok(etag);
  const again = await t.api("/settings/company", { method: "PUT", as: owner, ifMatch: "new", body: { ...body, name: "Other" } });
  assert.equal(again.status, 412);
  assert.equal(again.body.error.details.current.name, "Barta Window Washing");
  const bad = await t.api("/settings/messaging", { method: "PUT", as: admin, ifMatch: "new", body: { bulk_threshold: 0 } });
  assert.equal(bad.status, 400);
  assert.equal(bad.body.error.field, "bulk_threshold");
  const noStop = await t.api("/settings/messaging", { method: "PUT", as: admin, ifMatch: "new", body: { footer: { text: "Thanks!" } } });
  assert.equal(noStop.status, 400, "the opt-out footer must say how to stop");
  const ok = await t.api("/settings/company", { method: "PUT", as: admin, ifMatch: etag, body: { ...body, legal_name: "BARTA WINDOW WASHING LLC" } });
  assert.equal(ok.status, 200);
  assert.ok(t.stores.data.keys("evt/cfg/company/").length >= 2, "audited");
});

test("settings: an owner edits cfg/permissions and cfg/auth; the auth epoch moves and the change applies at once", async () => {
  const epoch0 = t.stores.data.json("sys/auth-epoch");
  const before = await t.api("/me", { as: tech });
  assert.equal(before.body.data.perms["inbox:read"], "own");
  const put = await t.api("/settings/permissions", { method: "PUT", as: owner, ifMatch: "new", body: { roles: { tech: { "inbox:read": false } } } });
  assert.equal(put.status, 200, JSON.stringify(put.body));
  assert.ok((t.stores.data.json("sys/auth-epoch") || { n: 0 }).n > ((epoch0 && epoch0.n) || 0));
  const after = await t.api("/me", { as: tech });
  assert.equal(after.body.data.perms["inbox:read"], undefined);
  const owners = await t.api("/settings/permissions", { method: "PUT", as: owner, ifMatch: put.body.data.etag, body: { roles: { admin: { "settings:owner": true } } } });
  assert.equal(owners.status, 400, "owner-only permissions can't be given away");
  const auth = await t.api("/settings/auth", { method: "PUT", as: owner, ifMatch: "new", body: { office_cookie_roles: ["owner", "admin"] } });
  assert.equal(auth.status, 200);
  assert.deepEqual(auth.body.data.data.office_cookie_roles, ["owner", "admin"]);
  assert.equal((await t.api("/settings/auth", { method: "PUT", as: owner, ifMatch: auth.body.data.etag, body: { office_cookie_roles: ["boss"] } })).status, 400);
});

test("a failed read of cfg/permissions still answers 503 and never runs on the role defaults", async () => {
  t.stores.data.fail({ op: "getWithMetadata", key: "cfg/permissions", kind: "timeout", times: 10 });
  const { clearPermissionsCache } = await import("../../../netlify/lib/crm/core/auth.mjs");
  clearPermissionsCache();
  const res = await t.api("/settings/company", { as: owner });
  assert.equal(res.status, 503);
});

// ------------------------------------------------------------ health, runs, pause

test("health: lanes start at never, turn ok after a pass; tech gets 403", async () => {
  assert.equal((await t.api("/admin/health", { as: tech })).status, 403);
  const h0 = await t.api("/admin/health", { as: admin });
  assert.equal(h0.status, 200);
  assert.deepEqual(h0.body.data.status, { fast: "never", bulk: "never" });
  await scope(() => import("../../../netlify/lib/crm/core/worker.mjs").then((W) => W.runLane("fast", { deploy: undefined })));
  const h1 = await t.api("/admin/health", { as: admin });
  assert.equal(h1.body.data.status.fast, "ok");
});

test("runs: a reindex run answers 202 with its id; its starter or an owner can follow it", async () => {
  const r = await t.api("/admin/reindex", { method: "POST", as: owner, body: {} });
  assert.equal(r.status, 202);
  const id = r.body.data.run_id;
  assert.ok(t.kicks().some((k) => k.lane === "bulk" && k.reason === "run:reindex"));
  assert.equal((await t.api(`/runs/${id}`, { as: owner })).body.data.status, "queued");
  assert.equal((await t.api(`/runs/${id}`, { as: admin })).status, 404, "not theirs");
  assert.equal((await t.api("/admin/reindex", { method: "POST", as: admin, body: {} })).status, 403);
  assert.equal((await t.api("/admin/reindex", { method: "POST", as: owner, body: { names: ["nope"] } })).status, 400);
  await t.runWorker({ lane: "bulk" });
  const done = await t.api(`/runs/${id}`, { as: owner });
  assert.equal(done.body.data.status, "done");
  assert.ok(done.body.data.result.indexes >= 3);
});

test("pause and resume need the typed words; while paused the queue waits", async () => {
  assert.equal((await t.api("/admin/pause", { method: "POST", as: owner, body: {} })).status, 400);
  assert.equal((await t.api("/admin/pause", { method: "POST", as: admin, body: { confirm: "PAUSE" } })).status, 403);
  const p = await t.api("/admin/pause", { method: "POST", as: owner, body: { confirm: "PAUSE" } });
  assert.equal(p.status, 200);
  assert.equal(t.stores.data.json("sys/mode").paused, true);
  const r = await t.api("/admin/resume", { method: "POST", as: owner, body: { confirm: "RESUME" } });
  assert.equal(r.status, 200);
  assert.equal(t.stores.data.json("sys/mode").paused, false);
  assert.ok(t.stores.data.keys("evt/sys/mode/").length === 2, "both audited");
});

// ------------------------------------------------------------ backups and export

async function snapshot() {
  const run = await scope(() => L.createRun("backup.snapshot", { date: "2026-11-17" }, { by: "system" }, { kick: false }));
  for (let i = 0; i < 5; i++) await t.runWorker({ lane: "bulk" });
  return run;
}

test("backups and export: owners only, export audited, never a live listing", async () => {
  await snapshot();
  assert.equal((await t.api("/admin/backups", { as: admin })).status, 403);
  const list = await t.api("/admin/backups", { as: owner });
  assert.equal(list.status, 200);
  assert.equal(list.body.data[0].date, "2026-11-17");
  const manifest = await t.api("/admin/export", { as: owner });
  assert.equal(manifest.body.data.ok, true);
  const part = manifest.body.data.partitions.find((p) => p.name === "rec-user");
  const res = await t.api(`/admin/export?date=2026-11-17&partition=rec-user&part=1`, { as: owner });
  assert.equal(res.status, 200);
  assert.match(res.headers.get("content-type"), /^application\/x-ndjson/);
  assert.equal(res.text.trim().split("\n").length, part.keys);
  assert.ok(t.stores.data.keys("evt/backup/2026-11-17/").some((k) => k.includes("--export--")));
  assert.equal((await t.api(`/admin/export?date=2026-11-17&partition=rec-user&part=9`, { as: owner })).status, 404);
  const csv = await t.api("/admin/export.csv?type=user", { method: "POST", as: owner, body: {} });
  assert.equal(csv.status, 202);
  await t.runWorker({ lane: "bulk" });
  const file = await t.api(`/admin/export.csv/${csv.body.data.run_id}`, { as: owner });
  assert.equal(file.status, 200);
  assert.match(file.headers.get("content-type"), /^text\/csv/);
  assert.ok(file.text.startsWith("id,"));
  assert.ok(!/password|pbkdf2/.test(file.text), "no password hashes in a CSV");
  assert.equal(file.text.trim().split("\r\n").length, 1 + 3);
});

test("the backup key: owners only, export:all and nothing else; the pull marks the off-site copy", async () => {
  await snapshot();
  assert.equal((await t.api("/api-keys", { method: "POST", as: admin, body: { name: "pull", kind: "backup" } })).status, 400, "only an owner can make a backup key");
  assert.equal((await t.api("/api-keys", { method: "POST", as: owner, body: { name: "x", scopes: ["export:all"] } })).status, 400, "never on an ordinary key");
  const made = await t.api("/api-keys", { method: "POST", as: owner, body: { name: "Weekly pull", kind: "backup" } });
  assert.equal(made.status, 201, JSON.stringify(made.body));
  assert.deepEqual(made.body.data.scopes, ["export:all"]);
  assert.ok(made.body.data.expires_at);
  const bearer = { authorization: "Bearer " + made.body.data.key };
  assert.equal((await t.api("/admin/backups", { headers: bearer })).status, 200);
  assert.equal((await t.api("/admin/export?partition=cfg&part=1", { headers: bearer })).status, 404, "no cfg saved yet: no such part");
  assert.equal((await t.api("/admin/health", { headers: bearer })).status, 403, "nothing but export:all");
  assert.equal((await t.api("/me", { headers: bearer })).status, 401, "a key is not a session");
  const pulled = await t.api("/admin/backups/2026-11-17/pulled", { method: "POST", headers: bearer, csrf: false, body: {} });
  assert.equal(pulled.status, 200);
  assert.ok(t.stores.data.json("sys/health").offsite_at);
});

// ------------------------------------------------------------ API keys

test("API keys: the key is shown once and never kept in idem/; list and revoke", async () => {
  const made = await t.api("/api-keys", { method: "POST", as: admin, idem: "6d0c0b1e-1111-4a5b-9c8d-123456789abc", body: { name: "Claude" } });
  assert.equal(made.status, 201);
  assert.match(made.body.data.key, /^bcrm_[0-9A-Za-z]{32}$/);
  assert.deepEqual(t.stores.data.keys("idem/"), [], "a secret route is never stored for replay");
  assert.ok(made.body.data.scopes.includes("contacts:read_all") && !made.body.data.scopes.some((s) => /write|send/.test(s)), "read-only by default");
  const list = await t.api("/api-keys", { as: admin });
  assert.equal(list.body.data.length, 1);
  assert.equal(list.body.data[0].last4, made.body.data.key.slice(-4));
  assert.equal(list.body.data[0].key, undefined);
  assert.equal((await t.api("/api-keys", { as: tech })).status, 403);
  const bearer = { authorization: "Bearer " + made.body.data.key };
  assert.equal((await t.api("/audit", { headers: bearer })).status, 200);
  assert.equal((await t.api(`/api-keys/${made.body.data.id}`, { method: "DELETE", as: owner })).status, 404, "only your own");
  assert.equal((await t.api(`/api-keys/${made.body.data.id}`, { method: "DELETE", as: admin })).status, 200);
  assert.equal((await t.api("/audit", { headers: bearer })).status, 401);
});

// ------------------------------------------------------------ approvals

test("approvals: a phone's stale offline work becomes one pending action; the badge counts it for owners", async () => {
  const items = [{ method: "POST", path: "/visits/vs_00000000000000000001/checklist", queued_at: "2026-11-09T15:00:00Z", client_at: "2026-11-09T15:00:00Z", idempotency_key: "k-1", body: { item: "screens" } }];
  const r = await t.api("/outbox-review", { method: "POST", as: tech, body: { items } });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  assert.equal((await t.api("/me/badges", { as: owner })).body.data.approvals, 1);
  assert.equal((await t.api("/me/badges", { as: admin })).body.data.approvals, 0, "admins don't approve by default");
  assert.equal((await t.api("/pending-actions", { as: admin })).status, 403);
  const list = await t.api("/pending-actions", { as: owner });
  assert.equal(list.body.data.length, 1);
  const id = list.body.data[0].id;
  const one = await t.api(`/pending-actions/${id}`, { as: owner });
  assert.equal(one.body.data.items, 1);
  assert.equal(one.body.data.item_list[0].path, "/visits/vs_00000000000000000001/checklist", "the owner sees what the phone tried to do");
  const ok = await t.api(`/pending-actions/${id}/approve`, { method: "POST", as: owner, body: {} });
  assert.equal(ok.status, 200);
  assert.equal(ok.body.data.status, "done", "reviewed; the office acts on each item by hand");
  assert.equal((await t.api(`/pending-actions/${id}/approve`, { method: "POST", as: owner, body: {} })).status, 409);
  assert.equal((await t.api("/me/badges", { as: owner })).body.data.approvals, 0);
  assert.equal((await t.api("/outbox-review", { method: "POST", as: tech, body: { items: [{ path: "javascript:x" }] } })).status, 400);
});

test("approvals: an approved action runs once on the fast lane with the approver as the actor", async () => {
  const ran = [];
  P.definePendingKind("fixture.send", { label: "Text a customer", run: async (a, ctx) => { ran.push({ id: a.id, by: ctx.write().by, requested_by: ctx.write().requested_by }); return "sent"; } });
  const a = await scope(() => P.createPendingAction({ kind: "fixture.send", title: "Text Pat", args: { body: "hi" }, preview: { recipients: 1 }, requested_by: admin.id }, { by: admin.id, origin: "mcp", actor_kind: "user", requestId: "t" }));
  const approved = await t.api(`/pending-actions/${a.id}/approve`, { method: "POST", as: owner, body: {} });
  assert.equal(approved.body.data.status, "approved");
  await t.runWorker();
  await t.runWorker();
  assert.deepEqual(ran, [{ id: a.id, by: owner.id, requested_by: admin.id }]);
  assert.equal(t.stores.data.json(`rec/pending_action/${a.id}`).status, "done");
  const late = await scope(() => P.createPendingAction({ kind: "fixture.send", title: "Old", requested_by: admin.id, expires_hours: 1 }, { by: admin.id, origin: "mcp", requestId: "t" }));
  pin(new Date(Date.parse("2026-11-17T15:00:00Z") + 2 * 3600 * 1000));
  assert.equal((await t.api(`/pending-actions/${late.id}/approve`, { method: "POST", as: owner, body: {} })).status, 409, "expired");
});

// ------------------------------------------------------------ audit

test("audit: the day's feed from aud/ keys, one event with its diff, and record history by the type's permission", async () => {
  await t.api(`/users/${tech.id}`, { method: "PATCH", as: owner, ifMatch: tech.etag, body: { name: "Theo Renamed" } });
  const feed = await t.api("/audit?date=2026-11-17&type=user", { as: admin });
  assert.equal(feed.status, 200);
  assert.ok(feed.body.data.some((r) => r.id === tech.id && r.action === "update" && r.actor === owner.id));
  assert.equal((await t.api("/audit", { as: tech })).status, 403);
  const hist = await t.api(`/records/user/${tech.id}/history`, { as: owner });
  assert.equal(hist.status, 200);
  const upd = hist.body.data.find((e) => e.action === "update");
  const ev = await t.api(`/audit/event?key=${encodeURIComponent(upd.key)}`, { as: owner });
  assert.deepEqual(ev.body.data.diff.name[1], "Theo Renamed");
  assert.equal((await t.api(`/records/user/${tech.id}/history`, { as: admin })).status, 403, "users:manage reads a user's history");
  assert.equal((await t.api(`/records/user/${tech.id}/history`, { as: tech })).status, 403);
  assert.equal((await t.api(`/records/nothing/${tech.id}/history`, { as: owner })).status, 404);
});

// ------------------------------------------------------------ the nightly auth sweep

test("auth.sessions (03:15): expired sessions, day-old throttles, expired idempotency records and old claims go; live ones stay", async () => {
  const S = t.stores.data;
  const live = S.keys("ses/")[0];
  await scope(async () => {
    await store.settledWrite("ses/" + "e".repeat(64), { user_id: tech.id, created_at: "2026-01-01T00:00:00.000Z", idle_expires_at: "2026-03-01T00:00:00.000Z", absolute_expires_at: "2027-01-01T00:00:00.000Z" }, { onlyIfNew: true });
    await store.putRaw("thr/login/theo--new/f-20261115t150000000z-aaaa", { at: "x" });
    await store.putRaw("thr/login/theo--new/f-20261117t140000000z-bbbb", { at: "x" });
    await store.putRaw("idem/us_0000000000000000000a/old-request-0001", { state: "done", at: "2026-11-01T00:00:00.000Z" }, { onlyIfNew: true });
    await store.putRaw("idem/us_0000000000000000000a/new-request-0001", { state: "done", at: "2026-11-17T00:00:00.000Z" }, { onlyIfNew: true });
    await store.putRaw("done/sweep/x.old--2026-07-01", { state: "done" }, { onlyIfNew: true });
    await store.putRaw("lock/intake/abc", { holder: null, until: "2026-11-10T00:00:00.000Z" }, { onlyIfNew: true });
  });
  pin("2026-11-18T09:20:00Z");        // 03:20 local
  await t.runWorker();
  assert.ok(S.has(live), "a live session stays");
  assert.ok(!S.has("ses/" + "e".repeat(64)), "an expired one goes");
  assert.deepEqual(S.keys("thr/"), ["thr/login/theo--new/f-20261117t140000000z-bbbb"], "a day old goes; younger stays");
  assert.deepEqual(S.keys("idem/"), ["idem/us_0000000000000000000a/new-request-0001"]);
  assert.ok(!S.has("done/sweep/x.old--2026-07-01"));
  assert.ok(!S.has("lock/intake/abc"));
  assert.equal(S.json("done/sweep/auth.sessions--2026-11-18").state, "done");
});

// ------------------------------------------------------------ the functions, once set up

const PROD = { deploy: { context: "production", id: "dep1" } };
const SETUP = { CRM_PRODUCTION: "1", CRM_KEY_SALT: "test-salt-not-real" };
function withEnv(env, fn) {
  const saved = Object.fromEntries(Object.keys(env).map((k) => [k, process.env[k]]));
  Object.assign(process.env, env);
  return Promise.resolve().then(fn).finally(() => { for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; } });
}

test("once set up, the cron wakes both lanes with sys/worker-secret, and each lane runs only with it", async () => {
  const posted = [];
  const saved = globalThis.fetch;
  globalThis.fetch = async (url, init = {}) => { posted.push({ url: String(url), secret: init.headers["x-crm-worker"] }); return new Response(null, { status: 202 }); };
  try {
    await withEnv(SETUP, async () => {
      assert.equal((await cronFn(new Request(HOST + "/.netlify/functions/crm-cron", { method: "POST" }), PROD)).status, 204);
      const secret = t.stores.data.json("sys/worker-secret").secret;
      assert.deepEqual(posted.map((p) => p.url).sort(), [HOST + "/.netlify/functions/crm-bulk-background", HOST + "/.netlify/functions/crm-worker-background"]);
      assert.ok(posted.every((p) => p.secret === secret));
      assert.ok(t.stores.data.json("sys/health").cron_at);
      const call = (fn, s) => fn(new Request(HOST + "/.netlify/functions/x", { method: "POST", headers: { "x-crm-worker": s, "content-type": "application/json" }, body: JSON.stringify({ reason: "cron" }) }), PROD);
      assert.equal((await call(fastFn, "wrong")).status, 401);
      assert.equal((await call(bulkFn, "wrong")).status, 401);
      assert.equal((await call(fastFn, secret)).status, 202);
      assert.equal((await call(bulkFn, secret)).status, 202);
      const h = t.stores.data.json("sys/health");
      assert.equal(h.lanes.fast.last_invocation.reason, "cron");
      assert.ok(h.lanes.bulk.last_pass_at);
      const viaHook = await t.api("/hooks/cron", { method: "POST", headers: { "x-crm-worker": secret }, csrf: false });
      assert.equal(viaHook.status, 200);
      assert.equal((await t.api("/hooks/cron", { method: "POST", headers: { "x-crm-worker": "nope" }, csrf: false })).status, 403);
    });
  } finally {
    globalThis.fetch = saved;
  }
});

test("before setup the bulk lane does nothing and touches no store", async () => {
  const before = t.stores.data.calls.length;
  const res = await bulkFn(new Request(HOST + "/.netlify/functions/crm-bulk-background", { method: "POST", headers: { "x-crm-worker": "x" } }), PROD);
  assert.equal(res.status, 202);
  assert.equal(t.stores.data.calls.length, before);
});
