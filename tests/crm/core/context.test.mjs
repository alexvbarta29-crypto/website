// Deploy-context isolation and the side-effect gate (design §3.10, §11.4
// M1.1): production needs both signals; other hosts get a 308; the store
// refuses production names outside production and anything without the
// branded deploy object.
import { test, afterEach } from "node:test";
import assert from "node:assert/strict";
import { clearCrmStores } from "../../helpers/crm-memory-store.mjs";

const {
  deployContext, isDeploy, storeNameFor, canonicalRedirect, sideEffectMode, setupStatus, CANONICAL_HOST, STORES,
} = await import("../../../netlify/lib/crm/core/context.mjs");
const { openStore } = await import("../../../netlify/lib/crm-store.mjs");
const { ProdStoreRefused, DeployContextRequired, SetupNeeded } = await import("../../../netlify/lib/crm/core/errors.mjs");

const req = (url = "https://www.bartawindowwashing.com/crm") => new Request(url);
const ctxOf = (context) => ({ deploy: { context, id: "dep1" } });
const PROD_ENV = { CRM_PRODUCTION: "1" };

afterEach(() => clearCrmStores());

test("production iff the deploy context says production AND CRM_PRODUCTION=1", () => {
  const both = deployContext(req(), ctxOf("production"), PROD_ENV);
  assert.equal(both.prod, true);
  assert.equal(both.signal, "both");
  assert.equal(both.setup_needed, false);

  const ctxOnly = deployContext(req(), ctxOf("production"), {});
  assert.equal(ctxOnly.prod, false);
  assert.equal(ctxOnly.signal, "context");
  assert.equal(ctxOnly.setup_needed, true, "a production deploy before the owner's setup");

  const preview = deployContext(req("https://deploy-preview-7--site.netlify.app/x"), ctxOf("deploy-preview"), PROD_ENV);
  assert.equal(preview.prod, false, "CRM_PRODUCTION leaking into a preview is not enough");
  assert.equal(preview.ctx, "deploy-preview");

  assert.equal(deployContext(req(), ctxOf("branch-deploy"), PROD_ENV).prod, false);
  assert.equal(deployContext(req(), ctxOf("something-new"), PROD_ENV).ctx, "dev");
});

test("a function kind without the context signal falls back to CRM_PRODUCTION alone, and says so", () => {
  const envOnly = deployContext(req(), {}, PROD_ENV);
  assert.equal(envOnly.prod, true);
  assert.equal(envOnly.signal, "env");
  const nothing = deployContext(req(), undefined, {});
  assert.equal(nothing.prod, false);
  assert.equal(nothing.signal, "none");
  assert.equal(nothing.ctx, "dev");
  const fromEnvContext = deployContext(req(), undefined, { CONTEXT: "production", CRM_PRODUCTION: "1" });
  assert.equal(fromEnvContext.prod, true);
  assert.equal(fromEnvContext.signal, "both");
});

test("the deploy object is frozen and branded; a hand-made { prod: true } is refused", () => {
  const d = deployContext(req(), ctxOf("production"), PROD_ENV);
  assert.ok(Object.isFrozen(d));
  assert.ok(isDeploy(d));
  assert.equal(isDeploy({ ...d }), false, "a copy loses the brand");
  assert.equal(isDeploy({ prod: true, ctx: "production" }), false);
  assert.throws(() => storeNameFor("data", { prod: true }), DeployContextRequired);
});

test("store names: production only for prod; scratch names elsewhere; the probe store everywhere", () => {
  const prod = deployContext(req(), ctxOf("production"), PROD_ENV);
  assert.deepEqual(["data", "files", "backups"].map((k) => storeNameFor(k, prod)), ["crm", "crm-files", "crm-backups"]);
  assert.deepEqual(STORES, { data: "crm", files: "crm-files", backups: "crm-backups" });
  assert.equal(storeNameFor("data", deployContext(req(), ctxOf("deploy-preview"), {})), "crm--deploy-preview");
  assert.equal(storeNameFor("files", deployContext(req(), ctxOf("branch-deploy"), {})), "crm-files--branch-deploy");
  assert.equal(storeNameFor("backups", deployContext(req("http://localhost:8888/"), ctxOf("dev"), {})), "crm-backups--dev");
  const setup = deployContext(req(), ctxOf("production"), {});
  assert.throws(() => storeNameFor("data", setup), SetupNeeded);
  assert.throws(() => storeNameFor("data", setup), ProdStoreRefused, "SetupNeeded is a ProdStoreRefused");
  assert.equal(storeNameFor("probe", setup), "crm-probe");
  assert.equal(storeNameFor("probe", prod), "crm-probe");
  assert.throws(() => storeNameFor("other", prod), TypeError);
});

test("openStore: ProdStoreRefused outside production, DeployContextRequired without the branded deploy", async () => {
  const saved = process.env.NETLIFY_BLOBS_CONTEXT;
  process.env.NETLIFY_BLOBS_CONTEXT = Buffer.from(JSON.stringify({ siteID: "s", token: "t", edgeURL: "https://e.test", uncachedEdgeURL: "https://e.test" })).toString("base64");
  try {
    await assert.rejects(openStore("data"), DeployContextRequired);
    await assert.rejects(openStore("data", { prod: true, ctx: "production" }), DeployContextRequired);
    await assert.rejects(openStore("data", deployContext(req(), ctxOf("production"), {})), ProdStoreRefused);
    assert.equal((await openStore("data", deployContext(req(), ctxOf("production"), PROD_ENV))).name, "site:crm");
    assert.equal((await openStore("data", deployContext(req(), ctxOf("deploy-preview"), PROD_ENV))).name, "site:crm--deploy-preview");
  } finally {
    if (saved === undefined) delete process.env.NETLIFY_BLOBS_CONTEXT; else process.env.NETLIFY_BLOBS_CONTEXT = saved;
  }
});

test("on the production deploy any other host gets a 308 to the canonical one (deploy permalinks too)", () => {
  for (const host of ["6730c3f2a1b2c3d4e5f60718--bartawindowwashing.netlify.app", "bartawindowwashing.netlify.app", "bartawindowwashing.com"]) {
    const r = req(`https://${host}/api/crm/contacts?q=x`);
    const res = canonicalRedirect(r, deployContext(r, ctxOf("production"), PROD_ENV));
    assert.equal(res.status, 308, host);
    assert.equal(res.headers.get("location"), `https://${CANONICAL_HOST}/api/crm/contacts?q=x`);
  }
  const canonical = req("https://www.bartawindowwashing.com/crm");
  assert.equal(canonicalRedirect(canonical, deployContext(canonical, ctxOf("production"), PROD_ENV)), null);
  const preview = req("https://deploy-preview-3--site.netlify.app/crm");
  assert.equal(canonicalRedirect(preview, deployContext(preview, ctxOf("deploy-preview"), {})), null);
  const setup = req("https://site.netlify.app/crm");
  assert.equal(canonicalRedirect(setup, deployContext(setup, ctxOf("production"), {})).status, 308, "before setup too");
});

test("side effects: live only in production, in live mode, with secrets, after cutover; otherwise test, dry_run or off", () => {
  const prod = deployContext(req(), ctxOf("production"), PROD_ENV);
  const preview = deployContext(req(), ctxOf("deploy-preview"), {});
  const live = { sms: { mode: "live" }, payments: { mode: "live" } };
  const crm = { system_of_record: "crm", paused: false };
  const rotor = { system_of_record: "rotor", paused: false };
  const secrets = { TWILIO_ACCOUNT_SID: "x", TWILIO_AUTH_TOKEN: "y", STRIPE_SECRET_KEY: "z" };
  assert.equal(sideEffectMode("sms", prod, live, secrets, crm), "live");
  assert.equal(sideEffectMode("sms", prod, {}, secrets, crm), "dry_run", "dry_run is the default");
  assert.equal(sideEffectMode("sms", preview, live, secrets, crm), "dry_run", "never from a non-production deploy");
  assert.equal(sideEffectMode("sms", prod, live, {}, crm), "dry_run", "no secrets, no sends");
  assert.equal(sideEffectMode("sms", prod, live, { ...secrets, CRM_FORCE_DRY_RUN: "1" }, crm), "dry_run");
  assert.equal(sideEffectMode("sms", prod, live, secrets, { ...crm, paused: true }), "off");
  assert.equal(sideEffectMode("sms", prod, live, secrets, rotor), "test", "before cutover live acts as test");
  assert.equal(sideEffectMode("payments", prod, live, secrets, rotor), "dry_run", "test needs the test key");
  assert.equal(sideEffectMode("payments", prod, live, { ...secrets, STRIPE_TEST_SECRET_KEY: "t" }, rotor), "test");
  assert.equal(sideEffectMode("sms", prod, { sms: { mode: "off" } }, secrets, crm), "off");
  assert.throws(() => sideEffectMode("fax", prod, live, secrets, crm), TypeError);
});

test("setupStatus reports which Production-only settings are missing, as booleans only", () => {
  const env = { CRM_PRODUCTION: "1", CRM_KEY_SALT: "a-secret-salt-value" };
  const s = setupStatus(deployContext(req(), ctxOf("production"), env), env);
  assert.deepEqual(s.missing, ["CRM_SETUP_CODE"]);
  assert.equal(s.present.CRM_KEY_SALT, true);
  assert.ok(!JSON.stringify(s).includes("a-secret-salt-value"));
  const before = setupStatus(deployContext(req(), ctxOf("production"), {}), {});
  assert.equal(before.setup_needed, true);
  assert.deepEqual(before.missing, ["CRM_PRODUCTION", "CRM_KEY_SALT", "CRM_SETUP_CODE"]);
  assert.deepEqual(setupStatus(deployContext(req(), ctxOf("dev"), {}), {}).missing, []);
});
