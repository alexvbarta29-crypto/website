// Contacts module: the website's dual-write (design §6.8 "dual-write until
// cutover"), called by lead.mjs, claim.mjs, giveaway-rotor.mjs and
// referral-notify.mjs AFTER their Rotor call, which stays first and exactly
// as it was.
//
// The live lead path is sacred, so this file is small, imports nothing heavy
// at load time (the CRM's modules load only when a write is really due) and
// never throws. What it does, by cfg/intake.mode (owner-only, Settings →
// Intake mode; read with a 60 s cache, a failed read counts as "rotor" for
// 15 s):
//
//   - production without its CRM settings (setup needed, no CRM_KEY_SALT),
//     or no store to write to: nothing at all, not even a read
//   - "rotor" (the default): nothing (one cached settings read, while Rotor
//     answers or after the answer when the platform lets work finish after it)
//   - "dual" / "crm": intakeLead() in process, with Rotor's lead id
//
// The answer the visitor gets: when Rotor accepted the lead, the answer is
// Rotor's and the CRM write runs after it (context.waitUntil; without it, a
// bounded wait). When Rotor failed, "dual" and "crm" try the CRM before
// answering: a lead the CRM kept is a success the office can recover. A
// Rotor that hangs (lead.mjs has no timeout of its own, and must keep it
// that way in "rotor" mode): in "dual"/"crm", watchRotor() starts the CRM
// write once Rotor has taken 5 s, without stopping Rotor's call, and at 9 s
// (the platform stops the function at 10) a lead the CRM kept is answered
// as kept. A write that fails on one side raises an owner alert listing the
// leads (contact id, intake event) and a notification per lead that opens
// the contact ("A website lead saved to the CRM but not Rotor", or the
// reverse).

import { deployContext } from "../../core/context.mjs";
import { nowMs, nowIso } from "../../core/clock.mjs";

export const MODE_CACHE_MS = 60 * 1000;
export const MODE_FAIL_CACHE_MS = 15 * 1000;
export const INTAKE_BUDGET_MS = 4000;
export const INTAKE_MAX_CALLS = 80;
export const MODE_WAIT_MS = 1500;
export const ROTOR_SLOW_MS = 5000;
export const ROTOR_GIVE_UP_MS = 9000;
export const ALERT_LEADS = 10;

let modeCache = null;   // { mode, at, ttl }
let modeRead = null;    // the read in flight
let modeGen = 0;        // a read that finishes after clearModeCache() doesn't fill the cache
export function clearModeCache() { modeCache = null; modeRead = null; modeGen += 1; }

const safe = (e) => (e && (e.code || e.name)) || "error";
const scaled = (ms) => Math.max(0, ms * (globalThis.__crmSleepScale ?? 1));
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

const cachedMode = () => (modeCache && nowMs() - modeCache.at < modeCache.ttl ? modeCache.mode : null);

// cfg/intake.mode, cached for a minute. "rotor" when it can't be read (and
// for a short while after, so a store that is down costs one slow read, not
// one per lead). One read at a time.
export async function intakeMode(deploy) {
  const hit = cachedMode();
  if (hit) return hit;
  if (modeRead) return modeRead;
  const gen = modeGen;
  const keep = (mode, ttl) => { if (gen === modeGen) modeCache = { mode, at: nowMs(), ttl }; };
  modeRead = (async () => {
    try {
      const store = await import("../../../crm-store.mjs");
      await import("../index.mjs");          // the registry: the intake settings' defaults
      const cfg = await store.withStoreScope({ deploy, budget: store.withBudget(MODE_WAIT_MS, 3, { strict: false }), requestId: "intake-mode" }, () => store.getSetting("intake"));
      const mode = ["rotor", "dual", "crm"].includes(cfg && cfg.mode) ? cfg.mode : "rotor";
      keep(mode, MODE_CACHE_MS);
      return mode;
    } catch (e) {
      console.error(`crm:intake: mode not read (${safe(e)}); treating as rotor`);
      keep("rotor", MODE_FAIL_CACHE_MS);
      return "rotor";
    } finally {
      if (gen === modeGen) modeRead = null;
    }
  })();
  return modeRead;
}

// Lets work finish after the answer when the platform allows it. → true when handed off.
export function later(promise, context) {
  const c = context && typeof context.waitUntil === "function" ? context : globalThis.Netlify && globalThis.Netlify.context;
  if (c && typeof c.waitUntil === "function") {
    try { c.waitUntil(promise); return true; } catch { /* fall through */ }
  }
  return false;
}

const ALERT_TEXT = {
  crm_only: (n, slow) => (n > 1
    ? `${n} website leads saved to the CRM but not Rotor. Add them in Rotor by hand.`
    : slow ? "A website lead saved to the CRM; Rotor didn't answer in time. Check Rotor and add it by hand if it's missing."
      : "A website lead saved to the CRM but not Rotor. Add it in Rotor by hand."),
  rotor_only: (n) => (n > 1 ? `${n} website leads saved to Rotor but not the CRM. The next import brings them in.` : "A website lead saved to Rotor but not the CRM. The next import brings it in."),
};

// The alert after one more lead reached one side only (pure): one alert per
// side, listing the latest leads with their contact and intake event.
export function withLeadAlert(health, lanes, which, lead = {}) {
  const key = `intake:${which}`;
  const prev = (health.alerts || []).find((a) => a.key === key);
  const leads = [...((prev && prev.leads) || []), {
    at: nowIso(), origin: lead.origin || null,
    ...(lead.contact_id ? { contact_id: lead.contact_id } : {}), ...(lead.event ? { event: lead.event } : {}), ...(lead.slow ? { rotor: "no_answer" } : {}),
  }].slice(-ALERT_LEADS);
  const count = ((prev && prev.count) || (prev ? 1 : 0)) + 1;
  const next = lanes.withAlert(health, key, ALERT_TEXT[which](count, !!lead.slow));
  const a = next.alerts.find((x) => x.key === key);
  a.leads = leads;
  a.count = count;
  return next;
}

// Owner alert + staff notification for a lead that reached only one side (best effort).
async function alertOneSide(which, deploy, lead = {}) {
  try {
    const store = await import("../../../crm-store.mjs");
    const lanes = await import("../../core/lanes.mjs");
    const notify = await import("../../core/notify.mjs");
    const text = ALERT_TEXT[which](1, !!lead.slow);
    await store.withStoreScope({ deploy, budget: store.withBudget(3000, 12, { strict: false }), requestId: "intake-alert" }, async () => {
      await lanes.updateHealth((h) => withLeadAlert(h, lanes, which, lead));
      const who = await notify.approvers();
      const link = lead.contact_id ? `/contacts/${lead.contact_id}` : "/contacts";
      if (who.length) await notify.notify(who, { kind: "new_lead", title: which === "crm_only" ? "Lead missing in Rotor" : "Lead missing in the CRM", body: text, link }, { by: "system", origin: "hook", actor_kind: "automation" });
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

// The CRM writes watchRotor started while Rotor was slow, by the input they wrote.
const early = new WeakMap();   // input → { mode, write: Promise<crm>, slow?: true }

export class RotorNoAnswer extends Error {
  constructor() { super("Rotor didn't answer in time."); this.name = "RotorNoAnswer"; }
}

// Wraps lead.mjs's Rotor call (already sent: the request itself is untouched).
// "rotor" mode, an unknown mode, or no CRM here: the call itself, as before.
// "dual"/"crm": once Rotor has taken ROTOR_SLOW_MS the CRM write starts
// (afterRotor uses it instead of writing again), and if Rotor still hasn't
// answered at ROTOR_GIVE_UP_MS while the CRM kept the lead, this rejects with
// RotorNoAnswer so the visitor gets the CRM's answer before the platform's
// timeout. The mode comes from the cache, or from the read afterRotor would
// make anyway, started alongside Rotor's call (never before it).
export function watchRotor(call, { req, context, input, origin, env = process.env } = {}) {
  const deploy = crmDeploy(req, context, env);
  if (!deploy || !input || typeof input !== "object") return call;
  const known = cachedMode();
  if (known === "rotor") return call;
  const mode = known ? Promise.resolve(known) : intakeMode(deploy).catch(() => "rotor");
  return new Promise((resolve, reject) => {
    let settled = false;
    const timers = [];
    const done = (fn, v) => { if (settled) return; settled = true; for (const t of timers) clearTimeout(t); fn(v); };
    call.then((r) => done(resolve, r), (e) => done(reject, e));
    const started = nowMs();
    timers.push(setTimeout(async () => {
      if (settled) return;
      const m = await mode;
      if (settled || (m !== "dual" && m !== "crm")) return;
      // Rotor is slow: the CRM gets the lead now; Rotor's answer still decides when it comes
      const entry = { mode: m, write: writeCrm(deploy, input, origin, null).catch((e) => ({ ok: false, error: safe(e) })) };
      early.set(input, entry);
      const crm = await entry.write;
      if (settled || !crm.ok) return;     // the CRM failed: wait for Rotor, as before
      const spent = Math.max(0, nowMs() - started - scaled(ROTOR_SLOW_MS));     // the write's own time
      const left = Math.max(0, scaled(ROTOR_GIVE_UP_MS - ROTOR_SLOW_MS) - spent);
      timers.push(setTimeout(() => { entry.slow = true; done(reject, new RotorNoAnswer()); }, left));
    }, scaled(ROTOR_SLOW_MS)));
  });
}

// After the Rotor call. rotorOk: did Rotor accept it; rotor: { lead_id? }, or
// a function giving it (read from Rotor's reply after the answer).
// → { mode, crm: null | { ok, contact_id?, created?, event?, error? }, later: boolean }
// Never throws, never takes longer than the mode read + the intake budget.
export async function afterRotor({ req, context, input, origin, rotorOk, rotor = null, env = process.env } = {}) {
  const deploy = crmDeploy(req, context, env);
  if (!deploy) return { mode: "off", crm: null, later: false };
  const pre = input && typeof input === "object" ? early.get(input) : null;
  if (pre) early.delete(input);
  const run = async () => {
    const mode = pre ? pre.mode : await intakeMode(deploy);
    if (mode === "rotor") return { mode, crm: null };
    let crm;
    try {
      if (pre) crm = await pre.write;            // written while Rotor was slow (no Rotor id: the import links it)
      else {
        const info = typeof rotor === "function" ? await rotor() : rotor;
        crm = await writeCrm(deploy, input, origin, info || null);
      }
    } catch (e) { crm = { ok: false, error: safe(e) }; }
    if (!crm.ok) console.error(`crm:intake: CRM write failed (${crm.error || "error"}, origin ${origin})`);
    if (rotorOk && !crm.ok) await alertOneSide("rotor_only", deploy, { origin });
    if (!rotorOk && crm.ok) {
      // the visitor is waiting here: the alert finishes after the answer when the platform allows it
      const a = alertOneSide("crm_only", deploy, { origin, contact_id: crm.contact_id, event: crm.event, slow: !!(pre && pre.slow) });
      if (!later(a, context)) await a;
    }
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
