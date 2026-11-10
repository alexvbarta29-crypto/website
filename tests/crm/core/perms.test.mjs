// Permissions (design §4.5, §4.6; acceptance tests of M1.2): role defaults,
// grants and denies, the scope rule for "own", owner-only permissions, and
// the routes that need the unscoped permission.
import { test, afterEach } from "node:test";
import assert from "node:assert/strict";
import { crmTest } from "../../helpers/crm-http.mjs";

const { can, holds, permsFor, roleDefault, scopeFor, techView, ROLE_DEFAULTS, OWNER_ONLY, PERMISSION_KEYS } = await import("../../../netlify/lib/crm/core/perms.mjs");
const { systemSettings } = await import("../../../netlify/lib/crm/modules/system/settings.mjs");
const { allRoutes } = await import("../../../netlify/lib/crm/core/registry.mjs");

const U = (role, more = {}) => ({ id: "us_" + role.padEnd(20, "0").slice(0, 20), role, status: "active", grants: [], denies: [], ...more });
const owner = U("owner"), admin = U("admin"), tech = U("tech");

let t;
afterEach(() => { if (t) t.done(); t = null; });

test("a permission held only as 'own' is false without a subject", () => {
  assert.equal(holds(tech, "contacts:read"), "own");
  assert.equal(can(tech, "contacts:read"), false, "no subject: no");
  assert.equal(can(tech, "contacts:read", { type: "contact", visible: true }), true);
  assert.equal(can(tech, "contacts:read", { type: "contact", visible: false }), false);
  assert.equal(can(tech, "contacts:read_all"), false);
  assert.equal(can(admin, "contacts:read"), true);
  assert.equal(can(owner, "contacts:read_all"), true);
  // scope rules (§4.6)
  assert.equal(can(tech, "visits:work", { type: "visit", record: { assignee_ids: [tech.id] } }), true);
  assert.equal(can(tech, "visits:work", { type: "visit", record: { assignee_ids: ["us_someoneelse0000000"] } }), false);
  assert.equal(scopeFor(tech, { type: "job", record: {}, visits: [{ assignee_ids: [tech.id] }] }), true);
  assert.equal(scopeFor(tech, { type: "timesheet", record: { user_id: tech.id } }), true);
  assert.equal(scopeFor(tech, { type: "timesheet", record: { user_id: admin.id } }), false);
  assert.equal(scopeFor(tech, { type: "user", record: { id: tech.id } }), true);
  assert.equal(scopeFor(tech, { type: "something-new", record: {} }), false, "unknown subjects are not the tech's");
});

test("defaults ∪ grants − denies; inactive users hold nothing", () => {
  assert.equal(can(admin, "invoices:void"), false);
  assert.equal(can({ ...admin, grants: ["invoices:void"] }, "invoices:void"), true);
  assert.equal(can({ ...owner, denies: ["invoices:void"] }, "invoices:void"), false);
  assert.equal(can({ ...tech, grants: ["contacts:read"] }, "contacts:read"), true, "a grant is unscoped");
  assert.equal(can({ ...owner, status: "disabled" }, "account:own"), false);
  assert.equal(can({ ...owner, status: "invited" }, "account:own"), false);
  assert.equal(can(owner, "not:a_permission"), false);
  assert.equal(can(owner, "bogus"), false);
  for (const role of ["owner", "admin", "tech"]) for (const k of ["account:own", "leads:create", "incidents:create", "time:own", "payroll:read_own"]) assert.equal(ROLE_DEFAULTS[role][k], true, `${role} ${k}`);
  // every owner holds every permission in the table
  for (const k of PERMISSION_KEYS) assert.equal(can(owner, k), true, k);
  const p = permsFor(tech);
  assert.equal(p["contacts:read"], "own");
  assert.equal(p["contacts:read_all"], undefined);
  assert.equal(p["users:manage"], undefined);
});

test("settings:owner, users:manage and cutover:run can never be granted to anyone else", () => {
  for (const k of OWNER_ONLY) {
    assert.equal(can({ ...admin, grants: [k] }, k), false, `grant ${k}`);
    assert.equal(roleDefault("admin", k, { roles: { admin: { [k]: true } } }), false, `cfg/permissions ${k}`);
    assert.equal(roleDefault("tech", k, { roles: { tech: { [k]: true } } }), false);
  }
  assert.throws(() => systemSettings.permissions.validate({ roles: { admin: { "settings:owner": true } } }), /Owner-only/);
  assert.throws(() => systemSettings.permissions.validate({ roles: { owner: { "invoices:void": false } } }), /admin and tech/);
  const ok = systemSettings.permissions.validate({ roles: { admin: { "invoices:void": true }, tech: { "inbox:read": false } } });
  assert.equal(roleDefault("admin", "invoices:void", ok), true, "the owner can widen admin defaults");
  assert.equal(roleDefault("tech", "inbox:read", ok), false, "and narrow tech defaults");
  assert.equal(roleDefault("owner", "invoices:void", { roles: { owner: { "invoices:void": false } } }), true, "owner defaults never change");
});

test("routes with subject 'none' need the unscoped permission: techs get 403 on lists, the legacy list and Team", async () => {
  t = await crmTest();
  const o = await t.user("owner");
  const a = await t.user("admin");
  const te = await t.user("tech");
  for (const path of ["/legacy/customers", "/users", "/import"]) {
    const r = await t.api(path, { as: te });
    assert.equal(r.status, 403, `tech ${path}`);
    assert.equal(r.body.error.code, "forbidden");
  }
  assert.equal((await t.api("/legacy/customers", { as: a })).status, 200, "admin reads the legacy list");
  assert.equal((await t.api("/import", { as: a })).status, 403, "the import is owner-only");
  assert.equal((await t.api("/import", { as: o })).status, 200);
  const users = await t.api("/users", { as: a });
  assert.equal(users.status, 200);
  assert.deepEqual(Object.keys(users.body.data[0]).sort(), ["color", "id", "is_technician", "name"], "schedule:read sees names only");
  assert.ok(Object.keys((await t.api("/users", { as: o })).body.data[0]).includes("login"));
  // admins can't manage the team, and owner-only permissions can't be granted through PATCH
  assert.equal((await t.api("/users", { method: "POST", as: a, body: { name: "X Y", login: "xy", role: "tech" } })).status, 403);
  const rec = await t.api(`/users/${a.id}`, { as: o });
  const r = await t.api(`/users/${a.id}`, { method: "PATCH", as: o, ifMatch: rec.body.data && rec.headers.get("etag"), body: { grants: ["settings:owner"] } });
  assert.equal(r.status, 400);
  // a tech may read and edit only themself (scoped route), and only some fields
  assert.equal((await t.api(`/users/${a.id}`, { as: te })).status, 403);
  const mine = await t.api(`/users/${te.id}`, { as: te });
  assert.equal(mine.status, 200);
  assert.equal((await t.api(`/users/${te.id}`, { method: "PATCH", as: te, ifMatch: mine.headers.get("etag"), body: { role: "owner" } })).status, 403);
  const named = await t.api(`/users/${te.id}`, { method: "PATCH", as: te, ifMatch: mine.headers.get("etag"), body: { name: "Theo Renamed" } });
  assert.equal(named.status, 200);
  assert.equal(named.body.data.first_name, "Theo");
  assert.equal(named.body.data.last_name, "Renamed");
});

test("every registered route declares auth, perm, subject and mode", () => {
  for (const r of allRoutes()) {
    assert.ok(r.auth, `${r.method} ${r.path} auth`);
    assert.ok(Object.hasOwn(r, "perm"), `${r.method} ${r.path} perm`);
    assert.ok(["required", "none"].includes(r.subject), `${r.method} ${r.path} subject`);
    assert.ok(["inline", "run"].includes(r.mode), `${r.method} ${r.path} mode`);
  }
});

test("techView keeps only a type's techFields", () => {
  const u = { id: "us_x", type: "user", name: "N", first_name: "F", color: "#000000", is_technician: true, email: "n@example.com", phone: "+17635550100", password: { hash: "x" } };
  assert.deepEqual(Object.keys(techView("user", u)).sort(), ["color", "first_name", "id", "is_technician", "name"]);
  assert.deepEqual(techView("no-such-type", u), { id: "us_x" });
});
