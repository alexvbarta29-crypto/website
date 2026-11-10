// Barta CRM core: deploy-context isolation, the side-effect gate and the
// parallel-run guard predicate (design §3.10, §0 rules 11-13).
//
// Production needs two signals, in every function kind (request, scheduled,
// background): the deploy context says "production" AND the Production-only
// env var CRM_PRODUCTION is "1". A function kind that gets no context signal
// at all uses CRM_PRODUCTION alone, and `signal` records which signals were
// there (the M1.1 probe stores it per kind in the crm-probe store).
//
// The Deploy object is frozen and branded with a module-private Symbol, so a
// hand-made { prod: true } is never accepted by openStore() (crm-store).
//
// A production deploy whose CRM_PRODUCTION is missing (the owner has not
// finished the Netlify setup) is `setup_needed`: it may not open the
// production stores and may not open a scratch store either, so the new CRM
// answers "Setup needed" while the older office tools keep working.

import { hkdfSync } from "node:crypto";
import { DeployContextRequired, ProdStoreRefused, SetupNeeded } from "./errors.mjs";

// Automatic setup (the owner asked for no extra Netlify steps). A production
// deploy that already holds the office data key (OFFICE_DATA_KEY, the
// 32-byte key the dashboard and the import use) counts as set up: it is the
// second production signal, and the key salt is derived from it with HKDF.
// CRM_PRODUCTION and CRM_KEY_SALT still win when they are set; CRM_AUTO_SETUP=0
// turns the automatic path off. Never set CRM_KEY_SALT after data exists
// (the phone and email lookups would no longer match).
export function autoSetup(env = process.env) {
  if (env.CRM_AUTO_SETUP === "0") return false;
  const raw = String(env.OFFICE_DATA_KEY || "").trim();
  return raw !== "" && Buffer.from(raw, "base64").length === 32;
}
export const prodSignal = (env = process.env) => env.CRM_PRODUCTION === "1" || autoSetup(env);
let saltCache = null;
export function keySalt(env = process.env) {
  if (env.CRM_KEY_SALT) return env.CRM_KEY_SALT;
  if (!autoSetup(env)) return "";
  const raw = String(env.OFFICE_DATA_KEY).trim();
  if (!saltCache || saltCache.raw !== raw) {
    const ikm = Buffer.from(raw, "base64");
    saltCache = { raw, salt: Buffer.from(hkdfSync("sha256", ikm, Buffer.from("barta-crm"), Buffer.from("key-salt v1"), 32)).toString("hex") };
  }
  return saltCache.salt;
}

export const CANONICAL_HOST = "www.bartawindowwashing.com";
export const CANONICAL_ORIGIN = "https://" + CANONICAL_HOST;

// Store kinds and their production names (§3.1). `probe` is the M1.1
// scratch store: it carries no data and is open in every context.
export const STORES = Object.freeze({ data: "crm", files: "crm-files", backups: "crm-backups" });
export const SCRATCH_STORES = Object.freeze({ probe: "crm-probe" });
export const PROD_STORE_NAMES = Object.freeze(new Set(Object.values(STORES)));

const BRAND = Symbol("barta-crm-deploy");
const CONTEXTS = new Set(["production", "deploy-preview", "branch-deploy", "dev"]);

const hostOf = (req) => {
  try { return new URL(req.url).host.toLowerCase() || null; } catch { return null; }
};

// The deploy this function runs in. `context` is the Netlify context object
// (functions v2 second argument); env defaults to process.env.
export function deployContext(req, context, env = process.env) {
  const raw = (context && context.deploy && context.deploy.context) || env.CONTEXT || "";
  const hasCtx = typeof raw === "string" && raw !== "";
  // The automatic signal (the office data key) counts only next to a
  // context that says production; with no context at all CRM_PRODUCTION alone decides.
  const hasEnv = hasCtx ? prodSignal(env) : env.CRM_PRODUCTION === "1";
  let ctx, prod, signal;
  if (hasCtx) {
    ctx = CONTEXTS.has(raw) ? raw : "dev";
    prod = ctx === "production" && hasEnv;
    signal = hasEnv ? "both" : "context";
  } else {
    ctx = hasEnv ? "production" : "dev";
    prod = hasEnv;
    signal = hasEnv ? "env" : "none";
  }
  const host = req ? hostOf(req) : null;
  const deploy = {
    prod,
    ctx,
    host,
    canonical: host === CANONICAL_HOST,
    signal,
    setup_needed: ctx === "production" && !prod,
  };
  Object.defineProperty(deploy, BRAND, { value: true });
  return Object.freeze(deploy);
}

export const isDeploy = (d) => !!d && typeof d === "object" && d[BRAND] === true;

// The store name for a kind in this deploy; never a production name unless prod.
export function storeNameFor(kind, deploy) {
  if (!isDeploy(deploy)) throw new DeployContextRequired("crm-store: a branded deploy object is required");
  if (Object.hasOwn(SCRATCH_STORES, kind)) return SCRATCH_STORES[kind];
  if (!Object.hasOwn(STORES, kind)) throw new TypeError(`crm-store: unknown store kind ${kind}`);
  if (deploy.prod) return STORES[kind];
  if (deploy.setup_needed) throw new SetupNeeded("The CRM needs its Production settings in Netlify (CRM_PRODUCTION).");
  const name = `${STORES[kind]}--${deploy.ctx}`;
  if (PROD_STORE_NAMES.has(name)) throw new ProdStoreRefused("crm-store: production store outside production");
  return name;
}

// On the production deploy, a request to any other host (the apex domain,
// <site>.netlify.app, a deploy permalink) is sent to the canonical host
// instead of being served (308 keeps the method and body).
export function canonicalRedirect(req, deploy) {
  if (!isDeploy(deploy) || deploy.ctx !== "production" || !deploy.host || deploy.canonical) return null;
  let url;
  try { url = new URL(req.url); } catch { return null; }
  return new Response(null, {
    status: 308,
    headers: { Location: CANONICAL_ORIGIN + url.pathname + url.search, "Cache-Control": "no-store" },
  });
}

// Secrets each integration needs per mode (names only; values live in
// Netlify, Production context only).
export const INTEGRATION_SECRETS = Object.freeze({
  sms: { live: ["TWILIO_ACCOUNT_SID", "TWILIO_AUTH_TOKEN"], test: ["TWILIO_ACCOUNT_SID", "TWILIO_AUTH_TOKEN"] },
  email: { live: ["POSTMARK_SERVER_TOKEN"], test: ["POSTMARK_SERVER_TOKEN"] },
  payments: { live: ["STRIPE_SECRET_KEY"], test: ["STRIPE_TEST_SECRET_KEY"] },
  meta: { live: ["META_PAGE_TOKEN", "META_APP_SECRET"], test: ["META_PAGE_TOKEN", "META_APP_SECRET"] },
  push: { live: ["CRM_VAPID_PUBLIC", "CRM_VAPID_PRIVATE"], test: ["CRM_VAPID_PUBLIC", "CRM_VAPID_PRIVATE"] },
});

const hasAll = (names, env) => names.length > 0 && names.every((n) => typeof env[n] === "string" && env[n] !== "");

// "live" | "test" | "dry_run" | "off" for one integration (§3.10 "Side effects").
// settings = the cfg/integrations document; mode = sys/mode.
export function sideEffectMode(integration, deploy, settings, env = process.env, mode = null) {
  const secrets = INTEGRATION_SECRETS[integration];
  if (!secrets) throw new TypeError(`sideEffectMode: unknown integration ${integration}`);
  if (mode && mode.paused) return "off";
  const want = (settings && settings[integration] && settings[integration].mode) || "dry_run";
  if (want === "off") return "off";
  if (!isDeploy(deploy) || !deploy.prod) return "dry_run";
  if (env.CRM_FORCE_DRY_RUN === "1") return "dry_run";
  const sor = (mode && mode.system_of_record) || "rotor";
  if (want === "live") {
    if (sor === "crm") return hasAll(secrets.live, env) ? "live" : "dry_run";
    return hasAll(secrets.test, env) ? "test" : "dry_run";      // before cutover live acts as test
  }
  if (want === "test") return hasAll(secrets.test, env) ? "test" : "dry_run";
  return "dry_run";
}

// A record is sandboxed (automation may change it before cutover) when it
// was created in the CRM and never linked by the import, or when its contact
// is a test contact (§3.3).
export function sandboxed(record, contact) {
  if (record && record.shadow === true && !record.import) return true;
  if (contact && contact.flags && contact.flags.test === true) return true;
  if (record && record.type === "contact" && record.flags && record.flags.test === true) return true;
  return false;
}

// The parallel-run guard (§0 rule 12): mayAct(subject) is true when the CRM
// is the system of record, or when the subject is sandboxed. subject is a
// record or { record, contact }.
export function guardFor(mode) {
  const crm = !!mode && mode.system_of_record === "crm";
  return {
    crm,
    mayAct(subject) {
      if (crm) return true;
      if (!subject) return false;
      const record = subject.record !== undefined ? subject.record : subject;
      const contact = subject.contact !== undefined ? subject.contact : null;
      return sandboxed(record, contact);
    },
  };
}

// The Production-only settings the CRM needs (booleans only, never values).
export const SETUP_ENV = Object.freeze(["CRM_PRODUCTION", "CRM_KEY_SALT", "CRM_SETUP_CODE"]);
export function setupStatus(deploy, env = process.env) {
  const present = Object.fromEntries(SETUP_ENV.map((n) => [n, typeof env[n] === "string" && env[n] !== ""]));
  present.CRM_PRODUCTION = prodSignal(env);
  present.CRM_KEY_SALT = keySalt(env) !== "";
  if (autoSetup(env)) present.CRM_SETUP_CODE = true;   // the office password stands in for it
  const missing = deploy && deploy.ctx === "production" ? SETUP_ENV.filter((n) => !present[n]) : [];
  return { setup_needed: !!(deploy && deploy.setup_needed), ctx: deploy ? deploy.ctx : null, prod: !!(deploy && deploy.prod), present, missing };
}
