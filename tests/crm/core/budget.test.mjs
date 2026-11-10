// Request budgets (design §2.2 "Request budget", §11.4 M1.3
// budget.test.mjs): every registered route stays under its maxCalls
// (default 25 Blobs calls) on fixtures. With the memory stores the budget
// is strict: one call too many throws BudgetError, which answers 503 busy,
// so a route over budget fails here, not in production.
//
// Every core (system) route needs a sample below. A module's routes get
// theirs from tests/crm/<module>/budget-samples.mjs (export default
// { "GET /contacts": async (ctx) => ({ as, path, ... }) }), read when the
// file exists; a module route without a sample is reported, not failed,
// until its module ships one.
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readdirSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { crmTest } from "../../helpers/crm-http.mjs";
import { fixtureModule, fixtureType, BYTES } from "../../helpers/crm-fixtures.mjs";

const store = await import("../../../netlify/lib/crm-store.mjs");
const R = await import("../../../netlify/lib/crm/core/registry.mjs");
const L = await import("../../../netlify/lib/crm/core/lanes.mjs");
const F = await import("../../../netlify/lib/crm/core/files.mjs");
const P = await import("../../../netlify/lib/crm/core/pending.mjs");
const { DEFAULT_MAX_CALLS } = await import("../../../netlify/lib/crm/core/router.mjs");

fixtureModule({ types: [fixtureType("budget_owner", "zb", { example: () => ({ assignee_ids: [] }) })] });
F.defineFileOwner("budget_owner", { canRead: () => true, canEdit: () => true });

const W = { by: "system", origin: "api", actor_kind: "user", requestId: "budget" };
const scope = (fn) => store.withStoreScope({ requestId: "budget" }, fn);

// What each core route is called with: (fx) → { as?, path, method?, body?, raw?, headers?, office?, ifMatch?, csrf? }.
const SAMPLES = {
  "GET /me": (fx) => ({ as: fx.tech, path: "/me" }),
  "GET /me/badges": (fx) => ({ as: fx.owner, path: "/me/badges" }),
  "GET /users": (fx) => ({ as: fx.owner, path: "/users" }),
  "POST /users": (fx) => ({ as: fx.owner, path: "/users", body: { name: "Pat Example", login: "pat.example", role: "tech" } }),
  "GET /users/:id": (fx) => ({ as: fx.owner, path: `/users/${fx.tech.id}` }),
  "PATCH /users/:id": (fx) => ({ as: fx.owner, path: `/users/${fx.patchme.id}`, ifMatch: fx.patchme.etag, body: { role: "admin" } }),
  "POST /users/:id/invite": (fx) => ({ as: fx.owner, path: `/users/${fx.invited.id}/invite`, body: {} }),
  "POST /users/:id/reset": (fx) => ({ as: fx.owner, path: `/users/${fx.admin.id}/reset`, body: {} }),
  "POST /users/:id/disable": (fx) => ({ as: fx.owner, path: `/users/${fx.spare.id}/disable`, body: {} }),
  "POST /users/:id/enable": (fx) => ({ as: fx.owner, path: `/users/${fx.spare.id}/enable`, body: {} }),
  "GET /users/:id/sessions": (fx) => ({ as: fx.owner, path: `/users/${fx.owner.id}/sessions` }),
  "DELETE /users/:id/sessions/:hash": (fx) => ({ as: fx.owner, path: `/users/${fx.signedIn.id}/sessions/${fx.signedInSession}` }),
  "GET /legacy/customers": (fx) => ({ as: fx.owner, path: "/legacy/customers" }),
  "GET /import": (fx) => ({ office: true, path: "/import" }),
  "POST /import": (fx) => ({ office: true, path: "/import", body: { v: 2 } }),
  "GET /settings": (fx) => ({ as: fx.owner, path: "/settings" }),
  "GET /settings/:name": (fx) => ({ as: fx.owner, path: "/settings/messaging" }),
  "PUT /settings/:name": (fx) => ({ as: fx.owner, path: "/settings/permissions", ifMatch: "new", body: { roles: { tech: { "inbox:read": "own" } } } }),
  "GET /admin/health": (fx) => ({ as: fx.owner, path: "/admin/health" }),
  "GET /runs/:id": (fx) => ({ as: fx.owner, path: `/runs/${fx.run.id}` }),
  "GET /admin/backups": (fx) => ({ as: fx.owner, path: "/admin/backups" }),
  "POST /admin/backups/:date/pulled": (fx) => ({ as: fx.owner, path: "/admin/backups/2026-11-17/pulled", body: {} }),
  "GET /admin/export": (fx) => ({ as: fx.owner, path: "/admin/export?date=2026-11-17&partition=rec-user&part=1" }),
  "POST /admin/export.csv": (fx) => ({ as: fx.owner, path: "/admin/export.csv?type=user", body: {} }),
  "GET /admin/export.csv/:id": (fx) => ({ as: fx.owner, path: `/admin/export.csv/${fx.run.id}` }),
  "POST /admin/reindex": (fx) => ({ as: fx.owner, path: "/admin/reindex", body: {} }),
  "POST /admin/purge-shadow": (fx) => ({ as: fx.owner, path: "/admin/purge-shadow", body: { confirm: "PURGE SHADOW" } }),
  "POST /admin/pause": (fx) => ({ as: fx.owner, path: "/admin/pause", body: { confirm: "PAUSE" } }),
  "POST /admin/resume": (fx) => ({ as: fx.owner, path: "/admin/resume", body: { confirm: "RESUME" } }),
  "POST /hooks/cron": (fx) => ({ path: "/hooks/cron", csrf: false, headers: { "x-crm-worker": fx.secret } }),
  "GET /audit": (fx) => ({ as: fx.owner, path: "/audit?date=2026-11-17" }),
  "GET /audit/event": (fx) => ({ as: fx.owner, path: `/audit/event?key=${encodeURIComponent(fx.eventKey)}` }),
  "GET /records/:type/:id/history": (fx) => ({ as: fx.owner, path: `/records/user/${fx.tech.id}/history` }),
  "POST /files": (fx) => ({ as: fx.owner, path: `/files?owner_type=budget_owner&owner_id=${fx.fileOwner.id}`, raw: BYTES.jpeg(), headers: { "content-type": "image/jpeg" } }),
  "POST /files/:id/thumb": (fx) => ({ as: fx.owner, path: `/files/${fx.file.id}/thumb`, raw: BYTES.jpeg(), headers: { "content-type": "image/jpeg" } }),
  "GET /files/:id": (fx) => ({ as: fx.owner, path: `/files/${fx.file.id}` }),
  "DELETE /files/:id": (fx) => ({ as: fx.owner, path: `/files/${fx.file.id}` }),
  "GET /pending-actions": (fx) => ({ as: fx.owner, path: "/pending-actions" }),
  "GET /pending-actions/:id": (fx) => ({ as: fx.owner, path: `/pending-actions/${fx.pending.id}` }),
  "POST /pending-actions/:id/approve": (fx) => ({ as: fx.owner, path: `/pending-actions/${fx.pending.id}/approve`, body: {} }),
  "POST /pending-actions/:id/reject": (fx) => ({ as: fx.owner, path: `/pending-actions/${fx.pending2.id}/reject`, body: {} }),
  "POST /outbox-review": (fx) => ({ as: fx.tech, path: "/outbox-review", body: { items: Array.from({ length: 20 }, (_, i) => ({ method: "POST", path: `/visits/x/${i}`, queued_at: "2026-11-09T15:00:00Z" })) } }),
  "GET /api-keys": (fx) => ({ as: fx.owner, path: "/api-keys" }),
  "POST /api-keys": (fx) => ({ as: fx.owner, path: "/api-keys", body: { name: "Budget key" } }),
  "DELETE /api-keys/:id": (fx) => ({ as: fx.owner, path: `/api-keys/${fx.apiKeyId}` }),
};

async function moduleSamples() {
  const out = {};
  const dir = new URL("../", import.meta.url);
  for (const d of readdirSync(dir, { withFileTypes: true })) {
    if (!d.isDirectory() || d.name === "core") continue;
    const f = new URL(`./${d.name}/budget-samples.mjs`, dir);
    if (existsSync(f)) Object.assign(out, (await import(pathToFileURL(f.pathname).href)).default || {});
  }
  return out;
}

test("every route stays under its maxCalls on fixtures (strict budget: one call too many answers 503)", async (tt) => {
  const t = await crmTest({ now: "2026-11-17T15:00:00Z" });
  try {
    const fx = {};
    fx.owner = await t.user("owner");
    fx.admin = await t.user("admin");
    fx.tech = await t.user("tech");
    fx.spare = await t.user("tech");
    fx.invited = await t.user("tech", { status: "invited" });
    fx.patchme = await t.user("tech");
    fx.signedIn = await t.user("tech");
    fx.signedInSession = t.stores.data.keys(`rel/user-sessions/${fx.signedIn.id}/`)[0].split("--").pop();
    await t.user("owner");                         // a second owner, so role changes are allowed
    fx.run = await scope(() => L.createRun("export.csv", { type: "user", date: "2026-11-17" }, W, { kick: false }));
    const snap = await scope(() => L.createRun("backup.snapshot", { date: "2026-11-17" }, W, { kick: false }));
    for (let i = 0; i < 6; i++) await t.runWorker({ lane: "bulk" });
    assert.equal((await scope(() => L.getRun(snap.id))).status, "done");
    fx.secret = await scope(() => L.ensureWorkerSecret());
    fx.fileOwner = (await store.createRecord("budget_owner", { assignee_ids: [] }, W)).data;
    fx.file = await scope(() => F.storeImportedFile({ bytes: BYTES.jpeg(), owner: { type: "budget_owner", id: fx.fileOwner.id } }, { ...W, origin: "import" }));
    fx.pending = await scope(() => P.createPendingAction({ kind: "outbox_review", title: "Review", requested_by: fx.tech.id, items: [] }, W));
    fx.pending2 = await scope(() => P.createPendingAction({ kind: "outbox_review", title: "Review", requested_by: fx.tech.id, items: [] }, W));
    fx.eventKey = t.stores.data.keys(`evt/user/${fx.tech.id}/`)[0];
    const key = await t.api("/api-keys", { method: "POST", as: fx.owner, body: { name: "Old key" } });
    fx.apiKeyId = key.body.data.id;

    const samples = { ...SAMPLES, ...(await moduleSamples()) };
    const routes = R.allRoutes();
    const missingCore = [];
    for (const r of routes) {
      const name = `${r.method} ${r.path}`;
      const sample = samples[name];
      if (!sample) {
        if (r.module === "system") missingCore.push(name);
        else tt.diagnostic(`no budget sample yet for ${r.module}: ${name}`);
        continue;
      }
      const s = await sample(fx);
      const res = await t.api(s.path, { method: s.method || r.method, as: s.as, body: s.body, raw: s.raw, headers: s.headers, office: s.office, ifMatch: s.ifMatch, csrf: s.csrf });
      const busy = res.status === 503 || (res.body && res.body.error && res.body.error.code === "busy");
      assert.ok(!busy, `${name} went over its budget of ${r.maxCalls || DEFAULT_MAX_CALLS} calls (${res.status} ${JSON.stringify(res.body && res.body.error)})`);
      assert.ok(res.status < 500, `${name} failed: ${res.status}`);
      if (process.env.CRM_BUDGET_DEBUG) tt.diagnostic(`${res.status} ${name}`);
    }
    assert.deepEqual(missingCore, [], "every core route has a budget sample");
  } finally {
    t.done();
  }
});
