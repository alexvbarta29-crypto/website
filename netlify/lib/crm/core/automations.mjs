// Barta CRM core: the automation engine (design §5.7.4, §7.3, §3.10).
//
// An automation is code (trigger, timing, conditions, action) declared by
// the module that owns its trigger, in its manifest:
//   automations: [{ key, trigger: "event:<name>" | "sweep" | "manual", category,
//                   imported: "no" | "eligible" | "yes", mutates, defaults, label, run(input, actx), recheck? }]
// This engine gives it settings, eligibility, markers, the guard and the run log:
//
// - Settings: cfg/automations.{key} = { enabled, channels, template_keys,
//   delay (minutes), at_local ("HH:MM"), max_per_contact_days?,
//   sender_user_id?, effective_from? } over the automation's defaults over
//   ENGINE_DEFAULTS. cfg/automations.paused stops them all.
// - Eligibility (§5.7.4): a subject is eligible only if its triggering
//   fact is at or after the floor (cfg/automations.effective_from, written
//   by cutover; a per-automation effective_from overrides it); it was not
//   created by the import, unless the automation says imported: "eligible"
//   (and then only for subjects still in the future: visit reminders) or
//   "yes"; and its step's marker is not final.
// - Sends: actx.send(step) never sends inline. It queues one
//   "automation.send" item per channel under the step's marker
//   ({ns}/{automation}/{step key}; done-dry/ while the channel is dry-run,
//   or always for a contact Rotor still owns before cutover), due after the
//   automation's delay / at its at_local. When it is due the fast lane
//   re-checks (enabled, the automation's recheck(), the sender's rules) and
//   sends; quiet hours defer the SAME marker.
// - Bulk: actx.sendMany(steps) with more recipients than
//   cfg/messaging.bulk_threshold (5) creates a bulk run instead (test send
//   and confirm required, core/bulk.mjs).
// - Guard: actx.mutate(subject, action, fn, changes) runs fn only when the
//   parallel-run guard allows (mayAct); otherwise it writes the
//   would-<action> row. A ParallelRunGuard from the store backstop becomes
//   the same row (core/queue.mjs, core/sweeps.mjs).
// - Run log: every outcome is an alog/ row (sent, dry_run, skipped:<reason>,
//   would-<action>, bulk_run, failed:<code>).
//
// Triggers: "event:<name>" automations are queued by the event dispatcher
// (core/queue.mjs, marker done/evt/{event_id}--auto.{key}, queue kind
// "automation.event"); "sweep" automations are run by their module's sweep
// per subject (runAutomation); "manual" ones by a person's action.

import { getSetting, getSettingWithEtag, getRaw, getRecord, putSetting, currentScope } from "../../crm-store.mjs";
import { allAutomations } from "./registry.mjs";
import { now, localDate, zonedToUtc, addLocalDays, isLocalTime } from "./clock.mjs";
import { isId } from "./ids.mjs";
import { InputError, NotFoundError, StaleError } from "./errors.mjs";
import { keySafe } from "./text.mjs";
import { automationCtx, logAutomation, listAutomationLog } from "./activity.mjs";
import { enqueue } from "./queue.mjs";
import { sendMessage, resultForQueue } from "./send.mjs";
import { getTemplateByKey } from "./templates.mjs";
import { bulkThreshold, createBulkRun } from "./bulk.mjs";
import { sandboxed } from "./context.mjs";
import { adapter } from "../adapters/index.mjs";

export const ENGINE_DEFAULTS = Object.freeze({ enabled: true, channels: ["sms"], template_keys: [], delay: 0, at_local: null, max_per_contact_days: null, sender_user_id: null, effective_from: null });
export const SETTING_FIELDS = Object.freeze(["enabled", "channels", "template_keys", "delay", "at_local", "max_per_contact_days", "sender_user_id", "effective_from"]);

// The built-in catalog (§5.7.4): what the Automations screen lists before
// the owning module ships (an automation not registered yet shows
// "arrives with ...", never a broken switch).
export const CATALOG = Object.freeze([
  { key: "lead.ack", label: "Thank a new lead by text", module: "sales", when: "5 min after a website lead with no call logged (right away after hours)", action: "Text lead_ack", on: true },
  { key: "lead.alert", label: "Tell the owners about a new lead", module: "sales", when: "Right away", action: "Push to owners", on: true },
  { key: "lead.attention", label: "Leads that need a call", module: "sales", when: "Hourly", action: "Today list + one push per lead per day", on: true },
  { key: "visit.confirm", label: "Confirm a booked visit", module: "work", when: "When a visit is scheduled", action: "Text visit_confirm", on: true },
  { key: "visit.reminder_14d", label: "Reminder 14 days before", module: "work", when: "10:00, 14 days before", action: "Text + email", on: true },
  { key: "visit.reminder_2d", label: "Reminder 2 days before", module: "work", when: "10:00, 2 days before", action: "Text", on: true },
  { key: "visit.on_my_way", label: "On my way", module: "work", when: "When a tech taps On my way", action: "Text", on: true },
  { key: "visit.running_late", label: "Running late", module: "work", when: "When a tech taps Running late", action: "Text", on: true },
  { key: "job.completed_note", label: "All done note", module: "comms", when: "When a job is completed", action: "Text with photos link", on: false },
  { key: "quote.sent", label: "Send the quote link", module: "quotes", when: "When a quote is sent", action: "Text + email", on: true },
  { key: "invoice.sent", label: "Send the invoice", module: "money", when: "When an invoice is issued", action: "Text + email", on: true },
  { key: "invoice.overdue", label: "Overdue reminders", module: "money", when: "10:00, the day after due, then every 3 days (5 times)", action: "Text", on: true },
  { key: "payment.receipt", label: "Payment receipt", module: "money", when: "When a payment succeeds", action: "Text + email", on: true },
  { key: "payment.failed", label: "Payment failed", module: "money", when: "When a charge fails", action: "Text with card link", on: true },
  { key: "agreement.sent", label: "Send the agreement", module: "plans", when: "When an agreement is sent", action: "Text / email", on: true },
  { key: "agreement.unsigned", label: "Unsigned agreement reminders", module: "plans", when: "10:00 daily, up to 7 times", action: "Text", on: true },
  { key: "review.sequence", label: "Review requests", module: "comms", when: "90 min after a job, then day 3 and day 8", action: "Texts review_1..3 from Alex", on: true },
  { key: "plan.renewal_notice", label: "Plan renewal notice", module: "plans", when: "30 days before the term ends", action: "Email + text", on: true },
  { key: "lights.rebook", label: "Christmas lights rebook", module: "plans", when: "On the rebook date", action: "A bulk send for the owner to test and confirm", on: true },
  { key: "card.expiring", label: "Card expiring", module: "money", when: "30 days before a card expires", action: "Text card_update", on: false },
  { key: "staff.daily_digest", label: "Morning digest", module: "comms", when: "07:00", action: "Push/email to owners", on: false },
]);
export const MODULE_LABELS = Object.freeze({ sales: "Sales", work: "Scheduling", quotes: "Quotes", plans: "Plans", money: "Money", comms: "Messages" });

export const automationDef = (key) => allAutomations().find((a) => a.key === key) || null;

export async function readAutomationsCfg() {
  return getSetting("automations").catch(() => ({ effective_from: null, paused: false }));
}

// The merged settings of one automation.
export function settingsFor(def, cfg = {}) {
  const own = cfg && typeof cfg[def.key] === "object" && cfg[def.key] ? cfg[def.key] : {};
  return { ...ENGINE_DEFAULTS, ...(def.defaults || {}), ...own };
}

// Eligibility (§5.7.4, pure). fact: { fact_at, record, future }.
export function checkEligible(def, settings, cfg, { fact_at, record, future } = {}) {
  const floor = settings.effective_from || (cfg && cfg.effective_from) || null;
  if (floor && fact_at && Date.parse(fact_at) < Date.parse(floor)) return { ok: false, reason: "before_floor" };
  const imported = !!record && (record.created_by === "import" || !!record.import);
  if (imported) {
    if (def.imported === "yes") return { ok: true };
    if (def.imported === "eligible") return future === true ? { ok: true } : { ok: false, reason: "imported_past" };
    return { ok: false, reason: "imported" };
  }
  return { ok: true };
}

// When a step is due: now + delay minutes, moved to the next at_local.
export function dueFor(settings, base = now()) {
  let t = new Date(base.getTime() + Math.max(0, Number(settings.delay) || 0) * 60000);
  if (settings.at_local && isLocalTime(settings.at_local)) {
    const d = localDate(t);
    let at = zonedToUtc(d, settings.at_local);
    if (at < t) at = zonedToUtc(addLocalDays(d, 1), settings.at_local);
    t = at;
  }
  return t;
}

async function contactOf(step) {
  if (step.contact && step.contact.id === step.contact_id) return step.contact;
  const got = await getRecord("contact", step.contact_id).catch(() => null);
  return got ? got.data : null;
}

// The context an automation's run() gets.
export function automationContext(def, { mode, settings, cfg, requestId, deploy } = {}) {
  const base = automationCtx({ mode, key: def.key, requestId });
  const actx = {
    // the deploy decides the marker namespace (done/ vs done-dry/): the worker's store scope has it
    ...base, automation: def.key, settings, cfg, deploy: deploy || (currentScope() || {}).deploy,
    eligible: (fact) => checkEligible(def, settings, cfg, fact),
    send: (step) => queueSend(def, actx, step),
    async sendMany(steps, opts = {}) {
      const list = (steps || []).filter((s) => s && isId(s.contact_id, "contact"));
      const threshold = await bulkThreshold();
      if (list.length > threshold) {
        const channel = opts.channel || (settings.channels || ["sms"])[0];
        const template_key = opts.template_key || await templateForChannel(settings.template_keys, channel);
        if (!template_key) { await base.log(null, "skipped:no_template"); return { bulk: false, reason: "no_template" }; }
        const per = {};
        for (const s of list) if (s.vars) per[s.contact_id] = s.vars;
        const run = await createBulkRun({ kind: def.key, title: opts.title || def.label || def.key, recipients: [...new Set(list.map((s) => s.contact_id))], template_key, channel, vars: opts.vars || {}, per_recipient_vars: per, related: opts.related || {}, requested_by: `automation:${def.key}` }, base.write());
        await base.log(run.id, "bulk_run", { recipients: list.length });
        return { bulk: true, bulk_run_id: run.id };
      }
      const out = [];
      for (const s of list) out.push(await queueSend(def, actx, s));
      return { bulk: false, queued: out.filter((x) => x.queued).length };
    },
    async mutate(subject, action, fn, changes) {
      if (!base.mayAct(subject)) { await base.would(subject, action, changes); return { done: false, would: true }; }
      return { done: true, result: await fn() };
    },
  };
  return actx;
}

async function templateForChannel(keys, channel) {
  for (const k of keys || []) {
    const t = await getTemplateByKey(k);
    if (t && t.channel === channel) return t.key;
  }
  return null;
}

// actx.send(step): queues one item per channel under the step's marker.
// step: { contact_id, contact?, subject?: { type, id }, key?, n?, channel?, template_key?, due_at?, vars?,
//         related?, expect?, fact_at?, record?, future? }
async function queueSend(def, actx, step = {}) {
  const s = actx.settings;
  if (!isId(step.contact_id, "contact")) throw new InputError("A send needs a contact.", "contact_id");
  const subject = step.subject && step.subject.id ? step.subject : { type: "contact", id: step.contact_id };
  if (step.fact_at !== undefined || step.record) {
    const e = checkEligible(def, s, actx.cfg, step);
    if (!e.ok) { await actx.log(subject.id, `skipped:${e.reason}`); return { queued: false, reason: e.reason }; }
  }
  const contact = await contactOf(step);
  if (!contact) { await actx.log(subject.id, "skipped:no_contact"); return { queued: false, reason: "no_contact" }; }
  const channels = step.channel ? [step.channel] : (Array.isArray(s.channels) && s.channels.length ? s.channels : ["sms"]);
  const stepKey = keySafe(step.key || `${subject.id}--${step.n || 1}`, 120);
  const due = step.due_at ? new Date(step.due_at) : dueFor(s);
  let queued = 0;
  for (const ch of channels) {
    const template_key = step.template_key && channels.length === 1 ? step.template_key : (await templateForChannel(step.template_key ? [step.template_key, ...(s.template_keys || [])] : s.template_keys, ch));
    if (!template_key) { await actx.log(subject.id, `skipped:no_template_${ch}`); continue; }
    const a = await adapter(ch, { deploy: actx.deploy, mode: actx.mode });
    const dry = a.mode === "dry_run" || a.mode === "off" || (!actx.guard.crm && !sandboxed(contact, contact));
    const ns = dry ? "done-dry" : "done";
    const markerKey = ch === channels[0] ? stepKey : `${stepKey}--${ch}`;
    const existing = await getRaw(`${ns}/${keySafe(def.key, 60)}/${markerKey}`).catch(() => null);
    const st = existing && existing.data && existing.data.state;
    if (st === "done" || st === "unknown" || (st === "failed" && !existing.data.retry_at)) { await actx.log(subject.id, "skipped:done"); continue; }
    if (st === "claimed" || st === "sending") continue;            // already queued or running
    await enqueue("automation.send", subject, step.expect || {}, due, { ns, scope: keySafe(def.key, 60), key: markerKey }, {
      data: { automation: def.key, contact_id: contact.id, channel: ch, template_key, vars: step.vars || {}, related: step.related || {}, step: stepKey },
    });
    queued += 1;
  }
  return { queued: queued > 0, n: queued };
}

// Runs an automation for one input (an event, a sweep's subject, a person's action).
export async function runAutomation(key, input, { mode, requestId, deploy } = {}) {
  const def = automationDef(key);
  if (!def) return { result: "skipped:no_automation" };
  const cfg = await readAutomationsCfg();
  const settings = settingsFor(def, cfg);
  if (cfg.paused) return { result: "skipped:paused" };
  if (!settings.enabled) return { result: "skipped:disabled" };
  const actx = automationContext(def, { mode, settings, cfg, requestId, deploy });
  const out = await def.run(input, actx);
  return out && typeof out === "object" ? out : { result: "done" };
}

// Queue kind "automation.event": an event an automation is triggered by.
export async function runEventAutomation(h) {
  const d = h.item.data || {};
  return runAutomation(d.automation, { event: { name: d.name, event_id: d.event_id, payload: d.payload || {} } }, { mode: h.mode, requestId: h.ctx.requestId });
}

// Queue kind "automation.send": one due step of one automation.
export async function runSendStep(h) {
  const d = h.item.data || {};
  const def = automationDef(d.automation);
  const log = (result) => logAutomation({ key: d.automation, subject: d.contact_id, result }).catch(() => {});
  if (!def) { await log("skipped:no_automation"); return { result: "skipped:no_automation" }; }
  const cfg = await readAutomationsCfg();
  const settings = settingsFor(def, cfg);
  if (cfg.paused || !settings.enabled) { const r = cfg.paused ? "skipped:paused" : "skipped:disabled"; await log(r); return { result: r }; }
  if (typeof def.recheck === "function") {
    const actx = automationContext(def, { mode: h.mode, settings, cfg, requestId: h.ctx.requestId });
    const rc = (await def.recheck(h.item, actx)) || {};
    if (rc.skip) { const r = `skipped:${keySafe(rc.skip, 30)}`; await log(r); return { result: r }; }
  }
  let sender = null;
  if (isId(settings.sender_user_id, "user")) {
    const u = await getRecord("user", settings.sender_user_id).catch(() => null);
    sender = u ? u.data : null;
  }
  const r = await sendMessage({
    contact_id: d.contact_id, channel: d.channel, template_key: d.template_key, vars: d.vars || {}, related: d.related || {},
    origin: { kind: "automation", id: def.key }, category: def.category === "staff" ? "staff" : def.category, sender,
  }, { h, by: `system:${keySafe(def.key, 40)}`, origin: "worker", actor_kind: "automation", requestId: h.ctx.requestId });
  const q = resultForQueue(r);
  if (!q.defer) await log(q.result);
  return q;
}

// ------------------------------------------------------------ the screen

// GET /automations: every registered automation with its settings and the
// last 7 days' results, plus the catalog entries still to come.
export async function automationsOverview({ days = 7 } = {}) {
  const cfg = await readAutomationsCfg();
  const today = localDate(now());
  const counts = {};
  for (let i = 0; i < days; i++) {
    const rows = await listAutomationLog(addLocalDays(today, -i), { limit: 2000 });
    for (const r of rows) {
      const c = counts[r.key] || (counts[r.key] = { sent: 0, dry_run: 0, skipped: 0, would: 0, failed: 0, other: 0, last_at: null });
      const k = r.result === "sent" ? "sent" : r.result === "dry_run" ? "dry_run" : r.result.startsWith("skipped") ? "skipped" : r.result.startsWith("would-") ? "would" : r.result.startsWith("failed") ? "failed" : "other";
      c[k] += 1;
      if (!c.last_at || r.at > c.last_at) c.last_at = r.at;
    }
  }
  const registered = allAutomations();
  const have = new Set(registered.map((a) => a.key));
  const list = registered.map((def) => {
    const s = settingsFor(def, cfg);
    const cat = CATALOG.find((c) => c.key === def.key);
    return {
      key: def.key, label: def.label || (cat && cat.label) || def.key, module: def.module, trigger: def.trigger, category: def.category, imported: def.imported,
      available: true, when: cat ? cat.when : null, action: cat ? cat.action : null, settings: pickSettings(s), last7: counts[keySafe(def.key, 60)] || null,
    };
  });
  for (const c of CATALOG) {
    if (have.has(c.key)) continue;
    list.push({ key: c.key, label: c.label, module: c.module, available: false, arrives_with: MODULE_LABELS[c.module] || c.module, when: c.when, action: c.action, default_on: c.on, settings: null, last7: counts[keySafe(c.key, 60)] || null });
  }
  return { paused: !!cfg.paused, effective_from: cfg.effective_from || null, automations: list };
}
const pickSettings = (s) => Object.fromEntries(SETTING_FIELDS.map((k) => [k, s[k] ?? null]));

function cleanPatch(def, body) {
  const out = {};
  if (body.enabled !== undefined) { if (typeof body.enabled !== "boolean") throw new InputError("On or off.", "enabled"); out.enabled = body.enabled; }
  if (body.channels !== undefined) {
    if (!Array.isArray(body.channels) || !body.channels.length || body.channels.some((c) => !["sms", "email"].includes(c))) throw new InputError("Pick text, email or both.", "channels");
    out.channels = [...new Set(body.channels)];
  }
  if (body.template_keys !== undefined) {
    if (!Array.isArray(body.template_keys) || body.template_keys.length > 6 || body.template_keys.some((k) => !/^[a-z][a-z0-9_]{1,39}$/.test(String(k)))) throw new InputError("Pick templates from the library.", "template_keys");
    out.template_keys = body.template_keys;
  }
  if (body.delay !== undefined) {
    if (!Number.isInteger(body.delay) || body.delay < 0 || body.delay > 60 * 24 * 30) throw new InputError("Use minutes, up to 30 days.", "delay");
    out.delay = body.delay;
  }
  if (body.at_local !== undefined) { if (body.at_local !== null && !isLocalTime(body.at_local)) throw new InputError("Use a time like 10:00.", "at_local"); out.at_local = body.at_local; }
  if (body.max_per_contact_days !== undefined) {
    if (body.max_per_contact_days !== null && !(Number.isInteger(body.max_per_contact_days) && body.max_per_contact_days >= 0 && body.max_per_contact_days <= 3650)) throw new InputError("Use a number of days.", "max_per_contact_days");
    out.max_per_contact_days = body.max_per_contact_days;
  }
  if (body.sender_user_id !== undefined) { if (body.sender_user_id !== null && !isId(body.sender_user_id, "user")) throw new InputError("Pick someone on the team.", "sender_user_id"); out.sender_user_id = body.sender_user_id; }
  if (body.effective_from !== undefined) {
    if (body.effective_from !== null && !Number.isFinite(Date.parse(body.effective_from))) throw new InputError("Use a date and time.", "effective_from");
    out.effective_from = body.effective_from === null ? null : new Date(Date.parse(body.effective_from)).toISOString();
  }
  return out;
}

// PATCH /automations/:key: merges into cfg/automations.{key} (CAS; audited
// by the settings write).
export async function patchAutomation(key, body, ctx) {
  const def = automationDef(key);
  if (!def) throw new NotFoundError("That automation isn't here yet.");
  const patch = cleanPatch(def, body || {});
  const saved = await mergeAutomationsCfg((cur) => ({ ...cur, [def.key]: { ...(cur[def.key] || {}), ...patch } }), ctx);
  return settingsFor(def, saved.data);
}

// POST /automations/pause|resume (the whole engine; automations:configure).
export async function setAutomationsPaused(paused, ctx) {
  const saved = await mergeAutomationsCfg((cur) => ({ ...cur, paused: !!paused }), ctx);
  return { paused: !!saved.data.paused };
}

// A read-modify-write of cfg/automations with the etag it read (audited
// with a diff by the settings write); a racing save is re-read and merged.
async function mergeAutomationsCfg(mutate, ctx) {
  for (let i = 0; ; i++) {
    const cur = await getSettingWithEtag("automations");
    const next = mutate({ ...cur.data });
    delete next.updated_at; delete next.updated_by;
    try {
      return await putSetting("automations", next, { ...ctx.write(), ifMatch: cur.etag || "new" });
    } catch (e) {
      if (!(e instanceof StaleError) || i >= 2) throw e;
    }
  }
}
