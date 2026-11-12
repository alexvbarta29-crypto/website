// Money module: which payments driver runs, and on what (design §6.1,
// §6.2, §3.10; the owner's Stripe rules override anything looser).
//
// payments(ctx) → { mode, impl, sor, refused?, wanted, settings, gate }
//   dry_run   the default until the owner connects keys: core's dry-run
//             driver (outbox rows, /p/dry-checkout), sandboxed subjects only
//   test      ONLY when cfg/integrations.payments.mode is "test" AND
//             STRIPE_TEST_SECRET_KEY is a test key (sk_test_ / rk_test_);
//             a live key there is refused (dry-run, `refused`)
//   live      ONLY after cutover (sys/mode.system_of_record = "crm") with a
//             live key in STRIPE_SECRET_KEY; "live" wanted while Rotor is in
//             charge stays dry-run (it is never quietly turned into test)
//   off       paused: no money moves at all
// The adapter layer's own gate (core/context.mjs sideEffectMode: production
// deploy, CRM_FORCE_DRY_RUN, secrets, paused) runs first; this one only
// narrows it.
//
// mayMoveMoney(invoice|contact) is the parallel-run rule for money: before
// cutover money moves (dry-run, test) only for a sandboxed CUSTOMER (a test
// contact, or a contact made in the CRM that the import never linked);
// everything else gets a would-charge row. An invoice typed into the CRM
// for a customer Rotor still bills is not enough: the store's own backstop
// (core/guard.mjs) would refuse the payment record anyway.

import { adapter, readGate, modeFor } from "../../adapters/index.mjs";
import { dryRun } from "../../adapters/dry-run.mjs";
import { sandboxed } from "../../core/context.mjs";
import { getRecord, currentScope } from "../../../crm-store.mjs";
import { keyKind, registerStripeDrivers } from "../../adapters/payments-stripe.mjs";

registerStripeDrivers();

// What Settings → Payments shows, and what every money path uses.
export function resolvePayments({ deploy, settings = {}, mode = {}, env = process.env } = {}) {
  const wanted = (settings.payments && settings.payments.mode) || "dry_run";
  const sor = (mode && mode.system_of_record) || "rotor";
  const base = modeFor("payments", { deploy, settings, env, mode });
  const keys = { live: keyKind(env.STRIPE_SECRET_KEY), test: keyKind(env.STRIPE_TEST_SECRET_KEY) };
  let m = base;
  if (m === "test" && wanted !== "test") m = "dry_run";        // core lets "live before cutover" act as test: never here
  if (m === "live" && sor !== "crm") m = "dry_run";
  if (m === "test" && keys.test !== "test") m = "dry_run";     // a live key in the test slot is never used
  if (m === "live" && keys.live !== "live") m = "dry_run";
  // why the mode the owner picked isn't the one that runs (Settings → Payments says it)
  let refused = null;
  if (m === "dry_run" && wanted === "live") refused = sor !== "crm" ? "live_waits_for_cutover" : keys.live === "test" ? "test_key_in_live_slot" : keys.live !== "live" ? "live_key_missing" : "not_production";
  if (m === "dry_run" && wanted === "test") refused = keys.test === "live" ? "live_key_in_test_slot" : keys.test !== "test" ? "test_key_missing" : "not_production";
  return { mode: m, wanted, sor, refused, keys, webhook: { live: !!env.STRIPE_WEBHOOK_SECRET, test: !!env.STRIPE_TEST_WEBHOOK_SECRET } };
}

// The payments driver for this call.
export async function payments({ deploy: given, settings, mode, env = process.env } = {}) {
  // the deploy of this request or worker pass (the store scope carries it): without one, dry-run
  const deploy = given || (currentScope() || {}).deploy || null;
  const gate = await readGate({ settings, mode });
  const r = resolvePayments({ deploy, settings: gate.settings, mode: gate.mode, env });
  if (r.mode === "off") return { ...r, impl: null, gate };
  if (r.mode === "dry_run") return { ...r, impl: dryRun.payments, gate };
  const a = await adapter("payments", { deploy, settings: gate.settings, mode: gate.mode, env });
  if (a.mode !== r.mode || !a.impl) return { ...r, mode: "dry_run", impl: dryRun.payments, gate, refused: r.refused || "no_driver" };
  return { ...r, impl: a.impl, gate };
}

// Before cutover money moves only for sandboxed subjects (§6.1 "Dry-run money
// touches only sandboxed subjects"; the owner's rules extend it to test mode).
export async function mayMoveMoney(record, { sor, contact } = {}) {
  if (sor === "crm") return true;
  if (!record) return false;
  let c = contact || (record.type === "contact" ? record : null);
  if (!c && record.contact_id) { const g = await getRecord("contact", record.contact_id).catch(() => null); c = g ? g.data : null; }
  return !!c && !c.deleted_at && sandboxed(c, c);
}
