// Contacts module: the website's dual-write (design §6.8 "dual-write until
// cutover"), called by lead.mjs, claim.mjs, giveaway-rotor.mjs and
// referral-notify.mjs AFTER their Rotor call, which stays first and exactly
// as it was.
//
// The live lead path is sacred, so this file is small, imports nothing heavy
// at load time (the CRM's modules load only when a write is really due) and
// never throws. What it does, by cfg/intake.mode (owner-only, Settings →
// Intake mode; read with a 60 s cache):
//
//   - production without its CRM settings (setup needed, no CRM_KEY_SALT),
//     or no store to write to: nothing at all, not even a read
//   - "rotor" (the default): nothing (one cached settings read, after the
//     answer when the platform lets work finish after it)
//   - "dual" / "crm": intakeLead() in process, with Rotor's lead id
//
// The answer the visitor gets: when Rotor accepted the lead, the answer is
// Rotor's and the CRM write runs after it (context.waitUntil; without it, a
// bounded wait). When Rotor failed, "dual" and "crm" try the CRM before
// answering: a lead the CRM kept is a success the office can recover. A
// write that fails on one side raises an owner alert and a notification
// ("A website lead saved to the CRM but not Rotor", or the reverse).

import { deployContext } from "../../core/context.mjs";
import { nowMs } from "../../core/clock.mjs";

export const MODE_CACHE_MS = 60 * 1000;
export const INTAKE_BUDGET_MS = 4000;
export const INTAKE_MAX_CALLS = 80;
export const MODE_WAIT_MS = 1500;

let modeCache = null;   // { mode, at }
export function clearModeCache() { modeCache = null; }

const safe = (e) => (e && (e.code || e.name)) || "error";
const timeout = (p, ms) => Promise.race([p, new Promise((resolve) => { const t = setTimeout(() => resolve({ timedOut: true }), ms); t.unref?.(); })]);

// The deploy when the CRM may be written here, else null (never throws).
export function crmDeploy(req, context, env = process.env) {
  try {
    const deploy = deployContext(req || null, context || null, env);
    if (deploy.setup_needed) return null;
    if (deploy.ctx === "production" && !env.CRM_KEY_SALT) return null;
    // no store at all (a local run without Netlify, the first slice's tests): nothing to write to
    if (!deploy.prod && !globalThis.__crmStoreOverride && !env.NETLIFY_BLOBS_CONTEXT && !globalThis.netlifyBlobsContext) return null;
    return deploy;
  } catch {
    return null;
  }
}

// cfg/intake.mode, cached for a minute. "rotor" when it can't be read.
export async function intakeMode(deploy) {
  if (modeCache && nowMs() - modeCache.at < MODE_CACHE_MS) return modeCache.mode;
  try {
    const store = await import("../../../crm-store.mjs");
    await import("../index.mjs");          // the registry: the intake settings' defaults
    const cfg = await store.withStoreScope({ deploy, budget: store.withBudget(MODE_WAIT_MS, 3, { strict: false }), requestId: "intake-mode" }, () => store.getSetting("intake"));
    const mode = ["rotor", "dual", "crm"].includes(cfg && cfg.mode) ? cfg.mode : "rotor";
    modeCache = { mode, at: nowMs() };
    return mode;
  } catch (e) {
    console.error(`crm:intake: mode not read (${safe(e)}); treating as rotor`);
    return "rotor";
  }
}

// Lets work finish after the answer when the platform allows it. → true when handed off.
export function later(promise, context) {
  const c = context && typeof context.waitUntil === "function" ? context : globalThis.Netlify && globalThis.Netlify.context;
  if (c && typeof c.waitUntil === "function") {
    try { c.waitUntil(promise); return true; } catch { /* fall through */ }
  }
  return false;
}

// Owner alert + staff notification for a lead that reached only one side (best effort).
async function alertOneSide(which, deploy) {
  try {
    const store = await import("../../../crm-store.mjs");
    const lanes = await import("../../core/lanes.mjs");
    const notify = await import("../../core/notify.mjs");
    const text = which === "crm_only" ? "A website lead saved to the CRM but not Rotor. Add it in Rotor by hand." : "A website lead saved to Rotor but not the CRM. The next import brings it in.";
    await store.withStoreScope({ deploy, budget: store.withBudget(3000, 12, { strict: false }), requestId: "intake-alert" }, async () => {
      await lanes.updateHealth((h) => lanes.withAlert(h, `intake:${which}`, text));
      const who = await notify.approvers();
      if (who.length) await notify.notify(who, { kind: "new_lead", title: which === "crm_only" ? "Lead missing in Rotor" : "Lead missing in the CRM", body: text, link: "/contacts" }, { by: "system", origin: "hook", actor_kind: "automation" });
    });
  } catch (e) {
    console.error(`crm:intake: alert not saved (${safe(e)})`);
  }
}

// The CRM write itself, in its own store scope and budget. → intakeLead's answer.
async function writeCrm(deploy, input, origin, rotor) {
  const store = await import("../../../crm-store.mjs");
  await import("../index.mjs");
  const { intakeLead } = await import("./intake.mjs");
  return store.withStoreScope({ deploy, budget: store.withBudget(INTAKE_BUDGET_MS, INTAKE_MAX_CALLS, { strict: false }), requestId: `intake-${origin}` }, () => intakeLead(input, { origin, rotor }));
}

// After the Rotor call. rotorOk: did Rotor accept it; rotor: { lead_id? }, or
// a function giving it (read from Rotor's reply after the answer).
// → { mode, crm: null | { ok, contact_id?, created?, error? }, later: boolean }
// Never throws, never takes longer than the mode read + the intake budget.
export async function afterRotor({ req, context, input, origin, rotorOk, rotor = null, env = process.env } = {}) {
  const deploy = crmDeploy(req, context, env);
  if (!deploy) return { mode: "off", crm: null, later: false };
  const run = async () => {
    const mode = await intakeMode(deploy);
    if (mode === "rotor") return { mode, crm: null };
    let crm;
    try {
      const info = typeof rotor === "function" ? await rotor() : rotor;
      crm = await writeCrm(deploy, input, origin, info || null);
    } catch (e) { crm = { ok: false, error: safe(e) }; }
    if (!crm.ok) console.error(`crm:intake: CRM write failed (${crm.error || "error"}, origin ${origin})`);
    if (rotorOk && !crm.ok) await alertOneSide("rotor_only", deploy);
    if (!rotorOk && crm.ok) await alertOneSide("crm_only", deploy);
    return { mode, crm };
  };
  if (rotorOk) {
    // the visitor's answer is Rotor's: never wait for the CRM when the platform lets it finish later
    const p = run().catch((e) => { console.error(`crm:intake: background write failed (${safe(e)})`); return { mode: "error", crm: null }; });
    if (later(p, context)) return { mode: "later", crm: null, later: true };
    const r = await timeout(p, MODE_WAIT_MS + INTAKE_BUDGET_MS + 500);
    return r.timedOut ? { mode: "slow", crm: null, later: false } : { ...r, later: false };
  }
  const r = await timeout(run(), MODE_WAIT_MS + INTAKE_BUDGET_MS + 500).catch(() => ({ timedOut: true }));
  return r.timedOut ? { mode: "slow", crm: null, later: false } : { ...r, later: false };
}

// What the visitor should be told when Rotor failed: true when the CRM kept the lead.
export const crmRescued = (res) => !!(res && res.crm && res.crm.ok && (res.mode === "dual" || res.mode === "crm"));
