// Automatic setup (the owner asked for no extra Netlify steps): on a
// production deploy the office data key (OFFICE_DATA_KEY) stands in for
// CRM_PRODUCTION and CRM_KEY_SALT, and the office password stands in for
// CRM_SETUP_CODE. Synthetic values only.
import { test, afterEach } from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { crmTest, OFFICE_PASSWORD } from "../../helpers/crm-http.mjs";

const { deployContext, autoSetup, prodSignal, keySalt, setupStatus } = await import("../../../netlify/lib/crm/core/context.mjs");
const { missingSetup } = await import("../../../netlify/lib/crm/core/auth.mjs");
const { hk } = await import("../../../netlify/lib/crm-store.mjs");

const KEY = randomBytes(32).toString("base64");
const PROD = { deploy: { context: "production" } };
const req = new Request("https://www.bartawindowwashing.com/crm");

let t;
afterEach(() => { if (t) t.done(); t = null; });

test("a production deploy with the office data key is set up; without a context it is not", () => {
  const env = { OFFICE_DATA_KEY: KEY };
  assert.equal(autoSetup(env), true);
  assert.equal(prodSignal(env), true);
  const d = deployContext(req, PROD, env);
  assert.equal(d.prod, true);
  assert.equal(d.setup_needed, false);
  assert.deepEqual(missingSetup(d, env, { bootstrapped: false }), []);
  assert.deepEqual(setupStatus(d, env).missing, []);
  // no context signal at all: the key alone never makes production
  const none = deployContext(null, null, env);
  assert.equal(none.prod, false);
  assert.equal(none.ctx, "dev");
  // previews and branch deploys stay out of production
  assert.equal(deployContext(req, { deploy: { context: "deploy-preview" } }, env).prod, false);
  assert.equal(deployContext(req, { deploy: { context: "branch-deploy" } }, env).prod, false);
});

test("a bad or missing key, or CRM_AUTO_SETUP=0, keeps 'Setup needed'", () => {
  for (const env of [{}, { OFFICE_DATA_KEY: "short" }, { OFFICE_DATA_KEY: KEY, CRM_AUTO_SETUP: "0" }]) {
    const d = deployContext(req, PROD, env);
    assert.equal(d.prod, false, JSON.stringify(Object.keys(env)));
    assert.equal(d.setup_needed, true);
  }
});

test("the key salt is derived from the office key, stable, never the key itself; CRM_KEY_SALT wins", () => {
  const env = { OFFICE_DATA_KEY: KEY };
  const s1 = keySalt(env), s2 = keySalt({ ...env });
  assert.match(s1, /^[0-9a-f]{64}$/);
  assert.equal(s1, s2);
  assert.notEqual(s1, KEY);
  assert.notEqual(s1, keySalt({ OFFICE_DATA_KEY: randomBytes(32).toString("base64") }));
  assert.equal(keySalt({ ...env, CRM_KEY_SALT: "explicit" }), "explicit");
  assert.equal(keySalt({}), "");
  // phone keys use it: same input, same key; different salts, different keys
  assert.equal(hk("phone", "(612) 555-0100", env), hk("phone", "6125550100", env));
  assert.notEqual(hk("phone", "6125550100", env), hk("phone", "6125550100", {}));
});

test("first-owner setup without CRM_SETUP_CODE takes the office password typed again, once", async () => {
  t = await crmTest({ env: { CRM_SETUP_CODE: undefined, OFFICE_DATA_KEY: KEY } });
  const body = { name: "Olive Owner", login: "olive", password: "a long first password" };
  const page = await t.page("/crm/setup", { office: true });
  assert.equal(page.status, 200);
  assert.match(page.text, /Office password/);
  assert.doesNotMatch(page.text, /CRM_SETUP_CODE/);
  let r = await t.auth("/auth/setup", { body: { ...body, setup_code: OFFICE_PASSWORD } });
  assert.equal(r.status, 403, "the office cookie is still required");
  r = await t.auth("/auth/setup", { body: { ...body, setup_code: "not the office password" }, office: true });
  assert.equal(r.status, 400);
  assert.equal(r.body.error.field, "setup_code");
  assert.match(r.body.error.message, /office password/);
  r = await t.auth("/auth/setup", { body: { ...body, setup_code: OFFICE_PASSWORD }, office: true });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  assert.equal(r.body.data.user.role, "owner");
  r = await t.auth("/auth/setup", { body: { ...body, login: "jake", setup_code: OFFICE_PASSWORD }, office: true });
  assert.equal(r.status, 410, "works once");
});

test("with CRM_SETUP_CODE set, the setup code is still what setup asks for", async () => {
  t = await crmTest({ env: { CRM_SETUP_CODE: "setup-code-for-tests", OFFICE_DATA_KEY: KEY } });
  const body = { name: "Olive Owner", login: "olive", password: "a long first password" };
  let r = await t.auth("/auth/setup", { body: { ...body, setup_code: OFFICE_PASSWORD }, office: true });
  assert.equal(r.status, 400);
  r = await t.auth("/auth/setup", { body: { ...body, setup_code: "setup-code-for-tests" }, office: true });
  assert.equal(r.status, 201);
});
