// Barta CRM: the adapter layer (design §6.1, §3.10 "Side effects", §0 rule 11).
//
// adapter(kind, { deploy, mode, settings, env }) returns the live, test or
// dry-run implementation of an integration (sms, email, payments, maps,
// reviews, meta, push) according to the side-effect gate, so callers never
// branch on mode:
//
//   { kind, mode: "live" | "test" | "dry_run" | "off", impl, fallback? }
//
// - Every integration but push follows sideEffectMode (core/context.mjs):
//   live only on the production deploy, with the integration's mode set to
//   live in cfg/integrations, its secrets present, CRM_FORCE_DRY_RUN unset,
//   not paused and after cutover; before cutover live acts as test (test
//   credentials, allowlisted staff recipients only). Anything else is
//   dry-run: the outbox records what would have gone out.
// - Push reaches staff phones only (§5.7.7), so it is live in production as
//   soon as the VAPID keys exist, before cutover too. Without them it is off
//   (in-app notifications still work); off the production deploy it is
//   dry-run.
// - Live and test drivers are registered by the module that owns them
//   (registerAdapter(kind, "live" | "test", impl): Twilio and Postmark in
//   M6, Stripe in M5, Google Maps in M2a). A mode whose driver is not
//   registered yet falls back to dry-run (`fallback: "no_driver"`), never
//   to an error and never to a real call.

import { sideEffectMode, isDeploy, INTEGRATION_SECRETS } from "../core/context.mjs";
import { getSetting, getRaw } from "../../crm-store.mjs";
import { dryRun } from "./dry-run.mjs";
import { webpushLive } from "./webpush.mjs";

export const KINDS = Object.freeze(["sms", "email", "payments", "maps", "reviews", "meta", "push"]);
const GATED = new Set(["sms", "email", "payments", "meta", "push"]);
const DEFAULT_MODE = Object.freeze({ system_of_record: "rotor", paused: false });

const drivers = new Map();   // "sms:live" → impl
export function registerAdapter(kind, mode, impl) {
  if (!KINDS.includes(kind)) throw new TypeError(`adapters: unknown kind ${kind}`);
  if (!["live", "test"].includes(mode)) throw new TypeError("adapters: register live or test drivers (dry-run is core's)");
  if (!impl || typeof impl !== "object") throw new TypeError("adapters: impl must be an object");
  drivers.set(`${kind}:${mode}`, impl);
}
export const hasDriver = (kind, mode) => drivers.has(`${kind}:${mode}`);
// Tests only.
export function __unregisterAdapterForTests(kind, mode) { drivers.delete(`${kind}:${mode}`); }

// Push (§5.7.7): live in production once the VAPID keys exist (staff only,
// so not held back until cutover); off without them; dry-run elsewhere.
export function pushMode(deploy, settings, env = process.env, mode = null) {
  if (mode && mode.paused) return "off";
  const want = (settings && settings.push && settings.push.mode) || "live";
  if (want === "off") return "off";
  if (!isDeploy(deploy) || !deploy.prod) return "dry_run";
  if (want === "dry_run" || env.CRM_FORCE_DRY_RUN === "1") return "dry_run";
  const keys = INTEGRATION_SECRETS.push.live;
  if (!keys.every((k) => typeof env[k] === "string" && env[k] !== "")) return "off";
  return "live";
}

// The mode an integration runs in now: "live" | "test" | "dry_run" | "off".
export function modeFor(kind, { deploy, settings, env = process.env, mode = DEFAULT_MODE } = {}) {
  if (kind === "push") return pushMode(deploy, settings, env, mode);
  if (!GATED.has(kind)) {
    // maps and reviews only read; they follow their own setting and the deploy
    if (mode && mode.paused) return "off";
    const want = (settings && settings[kind] && settings[kind].mode) || "dry_run";
    if (want === "off") return "off";
    return isDeploy(deploy) && deploy.prod && want === "live" ? "live" : "dry_run";
  }
  return sideEffectMode(kind, deploy, settings, env, mode);
}

// Reads cfg/integrations and sys/mode when the caller did not pass them.
export async function readGate({ settings, mode } = {}) {
  const [s, m] = await Promise.all([
    settings ? settings : getSetting("integrations").catch(() => ({})),
    mode ? mode : getRaw("sys/mode").then((g) => ({ ...DEFAULT_MODE, ...(g && g.data ? g.data : {}) })).catch(() => ({ ...DEFAULT_MODE, paused: false })),
  ]);
  return { settings: s || {}, mode: m || DEFAULT_MODE };
}

// The implementation for a kind in this deploy.
export async function adapter(kind, { deploy, settings, mode, env = process.env } = {}) {
  if (!KINDS.includes(kind)) throw new TypeError(`adapters: unknown kind ${kind}`);
  const gate = await readGate({ settings, mode });
  const m = modeFor(kind, { deploy, settings: gate.settings, env, mode: gate.mode });
  return resolve(kind, m, gate);
}

// The same without storage reads, when the caller already has the gate.
export function adapterSync(kind, { deploy, settings = {}, mode = DEFAULT_MODE, env = process.env } = {}) {
  return resolve(kind, modeFor(kind, { deploy, settings, env, mode }), { settings, mode });
}

function resolve(kind, m, gate) {
  if (m === "off") return { kind, mode: "off", impl: null, settings: gate.settings };
  if (m === "dry_run") return { kind, mode: "dry_run", impl: dryRun[kind], settings: gate.settings };
  if (kind === "push" && m === "live") return { kind, mode: "live", impl: drivers.get("push:live") || webpushLive, settings: gate.settings };
  const impl = drivers.get(`${kind}:${m}`);
  if (!impl) return { kind, mode: "dry_run", impl: dryRun[kind], fallback: "no_driver", wanted: m, settings: gate.settings };
  return { kind, mode: m, impl, settings: gate.settings };
}

// What Settings → Integrations shows: per integration, the mode it would
// run in now and whether each secret is set (names and yes/no only).
export function integrationsStatus({ deploy, settings = {}, mode = DEFAULT_MODE, env = process.env } = {}) {
  const out = {};
  for (const kind of KINDS) {
    const names = INTEGRATION_SECRETS[kind] ? [...new Set([...INTEGRATION_SECRETS[kind].live, ...INTEGRATION_SECRETS[kind].test])] : kind === "maps" ? ["GOOGLE_MAPS_API_KEY"] : kind === "reviews" ? ["GOOGLE_CLIENT_ID", "GOOGLE_CLIENT_SECRET", "GOOGLE_REFRESH_TOKEN"] : [];
    const m = modeFor(kind, { deploy, settings, env, mode });
    const r = m === "live" || m === "test" ? resolve(kind, m, { settings, mode }) : { mode: m };
    out[kind] = {
      setting: (settings[kind] && settings[kind].mode) || (kind === "push" ? "live" : "dry_run"),
      effective: r.mode,
      ...(r.fallback ? { waiting_for: "driver" } : {}),
      secrets: Object.fromEntries(names.map((n) => [n, typeof env[n] === "string" && env[n] !== ""])),
    };
  }
  if (env.CRM_VAPID_SUBJECT !== undefined) out.push.secrets.CRM_VAPID_SUBJECT = env.CRM_VAPID_SUBJECT !== "";
  return { integrations: out, force_dry_run: env.CRM_FORCE_DRY_RUN === "1", system_of_record: (mode && mode.system_of_record) || "rotor", paused: !!(mode && mode.paused) };
}
