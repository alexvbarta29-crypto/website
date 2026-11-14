// Automations module: running custom automations on the core engine.
//
// Nothing here sends, marks or logs on its own: every text and email goes
// through core/automations.mjs (actx.send → an "automation.send" queue item
// under the step's marker, re-checked by recheck() below when due, then the
// sender with consent, quiet hours, dry-run and the outbox); more than
// cfg/messaging.bulk_threshold people at once becomes a bulk run (test send
// and confirm, core/bulk.mjs); every change to a record goes through
// actx.mutate (the parallel-run guard: a would- row for a record Rotor still
// owns); the run log is alog/.
//
// The pieces:
// - Starting (startRun): an event's listener (onEvent) or the daily check
//   (scheduleSweep) makes one flow_run with an id derived from the flow and
//   the event (or the day), so a retried listener or sweep starts nothing
//   twice. Before that: the eligibility floor (cfg/automations.
//   effective_from), the conditions, the loop guard (an event a flow's own
//   step caused never starts that flow again; one flow starts at most
//   LOOP_MAX_PER_DAY times a day for one contact; more than
//   cfg/flows.max_runs_per_day starts in one day switches the flow off and
//   tells the owners) and the flow's per-contact limit (flowc/ rows).
// - Steps (runStep, queue kind "flow.step"): one item per step, marker
//   done/flow/{runId}--{i}, due at stepDue() (when.mjs). Each step first
//   reads the run's record and contact again: a stop condition that is now
//   true ends the run (recheck); while the flow or every automation is
//   paused the step waits (re-checked hourly, stopped after 14 days); a run
//   started before the switch-over that reaches a step after it stops
//   (like the core engine's dry-run sequences). Each effect is idempotent
//   (task ids derived from the run, tags as a set, the send's marker, a
//   claimed marker for a notice), so a step that crashed half way and runs
//   again does nothing twice; the next step is queued before the run
//   record moves on.
// - Caps at send time (recheck): no more than cfg/flows.max_texts_per_day
//   automated texts to one contact in a day, counting every automation's
//   (flowt/ claims for these, the Outbox's dry-run automation texts for the
//   built-in ones).
// - simulate(): what a test run on one record would do, step by step, with
//   no writes at all.

import { getRecord, getRecords, createRecord, updateRecord, listRel, listKeys, readIndex, getSetting, claimMarker, advanceMarker, deleteRaw } from "../../../crm-store.mjs";
import { now, nowIso, nowMs, localDate, localTime, localDow, tsKey, fromTsKey, startOfLocalDay, addLocalDays, zonedToUtc, nextAllowed, DEFAULT_HOURS, DEFAULT_CALENDAR } from "../../core/clock.mjs";
import { isId, deriveId } from "../../core/ids.mjs";
import { ExistsError, ParallelRunGuard, InputError, ConflictError, NotFoundError } from "../../core/errors.mjs";
import { keySafe } from "../../core/text.mjs";
import { enqueue } from "../../core/queue.mjs";
import { automationCtx, writeOnceRaw, logAutomation } from "../../core/activity.mjs";
import { automationDef, automationContext, settingsFor, readAutomationsCfg } from "../../core/automations.mjs";
import { bulkThreshold } from "../../core/bulk.mjs";
import { getTemplateByKey, renderTemplate, varsFor } from "../../core/templates.mjs";
import { addressOf, consentBlock, quietRule, allowedNow } from "../../core/send.mjs";
import { guardFor, sandboxed } from "../../core/context.mjs";
import { call, has } from "../../core/services.mjs";
import { formatCents } from "../../core/money.mjs";
import { contactShard } from "../../core/stats.mjs";
import { safeErr } from "../../../referral-lib.mjs";
import { TRIGGERS, SUBJECT_ID, STEP_TYPES, isSchedule, stepPhrase, conditionPhrase, DEAL_STAGES } from "./catalog.mjs";
import { loadFacts, factsFromRecords, factsFromRow, allHold, firstHolding, holds } from "./facts.mjs";
import { stepDue } from "./when.mjs";

export const LOOP_MAX_PER_DAY = 3;
export const HOLD_MAX_DAYS = 14;
export const HOLD_RECHECK_MIN = 60;
export const MAX_MEMBERS = 100;
export const FLOW_SETTINGS = Object.freeze({ max_texts_per_day: 2, max_runs_per_day: 200 });
const FINAL = new Set(["done", "stopped", "skipped", "failed"]);
const RUN_RE = /^(ar_[0-9a-hjkmnp-tv-z]{20})--/;

export const runIdFor = (flowId, key) => deriveId("flow_run", `${flowId}--${key}`, "automations.run", 1);
export const flowKey = (flowId) => `flow.${keySafe(flowId, 40)}`;
const memberKey = (m) => m.c || (m.s && m.s.id) || "none";

export async function flowSettings() {
  const s = await getSetting("flows").catch(() => ({}));
  return { ...FLOW_SETTINGS, ...(s || {}) };
}

async function env() {
  const [hours, calendar] = await Promise.all([getSetting("hours").catch(() => null), getSetting("calendar").catch(() => null)]);
  return { hours: hours && typeof hours === "object" ? { ...DEFAULT_HOURS, ...hours } : DEFAULT_HOURS, calendar: calendar || DEFAULT_CALENDAR };
}

const dataOf = async (type, id) => {
  if (!isId(id, type)) return null;
  const g = await getRecord(type, id).catch(() => null);
  return g ? g.data : null;
};

// The flows a trigger starts (enabled, not deleted).
export async function flowsFor(type, { all = false } = {}) {
  const rows = await listRel("flows-by-trigger", type, { limit: 200 });
  if (!rows.length) return [];
  const got = await getRecords("flow", rows.map((r) => r.id));
  return got.map((g) => g && g.data).filter((f) => f && !f.deleted_at && (all || f.enabled === true));
}

// ------------------------------------------------------------ history and caps

// When this flow last started for a contact, and how often in the last day.
async function contactHistory(flowId, contactId) {
  if (!isId(contactId, "contact")) return { last: null, day: 0 };
  const keys = await listKeys(`flowc/${flowId}/${contactId}/`);
  const times = keys.map((k) => fromTsKey(k.split("/").pop().split("--")[0])).filter(Boolean).map((d) => d.getTime());
  const dayAgo = nowMs() - 86400000;
  return { last: times.length ? Math.max(...times) : null, day: times.filter((t) => t > dayAgo).length };
}

// Every contact's last start of this flow (one listing). → Map(contactId → ms)
async function flowHistory(flowId) {
  const keys = await listKeys(`flowc/${flowId}/`);
  const out = new Map();
  for (const k of keys) {
    const parts = k.split("/");
    const t = fromTsKey((parts[3] || "").split("--")[0]);
    if (!t) continue;
    if (!out.has(parts[2]) || out.get(parts[2]) < t.getTime()) out.set(parts[2], t.getTime());
  }
  return out;
}

const tooSoon = (flow, lastMs) => {
  const days = (flow.limits && flow.limits.per_contact_days) || 0;
  return !!lastMs && days > 0 && nowMs() - lastMs < days * 86400000;
};

// Automated texts to a contact today: these flows' claims plus the built-in
// automations' dry-run texts in the Outbox. claim: this send's own key.
export async function textsToday(contactId, claim = null) {
  const date = localDate(now());
  const mine = await listKeys(`flowt/${date}/${contactId}/`);
  const own = mine.filter((k) => !claim || !k.endsWith(`/${keySafe(claim, 120)}`)).length;
  const rows = await listRel("contact-outbox", contactId, { from: tsKey(startOfLocalDay(now())), limit: 40 });
  const items = rows.length ? await getRecords("outbox", rows.map((r) => r.id)) : [];
  const builtIn = items.filter((g) => g && g.data && g.data.kind === "sms" && g.data.mode === "dry_run" && g.data.origin && g.data.origin.kind === "automation" && !String(g.data.origin.id || "").startsWith("flow.")).length;
  return own + builtIn;
}

async function claimText(contactId, claim, max) {
  const n = await textsToday(contactId, claim);
  if (n >= max) return { over: true, n };
  await writeOnceRaw(`flowt/${localDate(now())}/${contactId}/${keySafe(claim, 120)}`, { at: nowIso() });
  return { over: false, n: n + 1 };
}

// ------------------------------------------------------------ the engine's send defs

// recheck(item): when a queued text or email of a flow is due. → { skip? }
async function recheckSend(item) {
  const d = item.data || {};
  const m = RUN_RE.exec(String(d.step || ""));
  if (!m) return {};
  const run = await dataOf("flow_run", m[1]);
  if (!run) return { skip: "no_run" };
  if (["stopped", "skipped", "failed"].includes(run.status)) return { skip: "run_ended" };
  const flow = await dataOf("flow", run.flow_id);
  if (!flow || flow.deleted_at) return { skip: "deleted" };
  if (!flow.enabled && !run.test) return { skip: "flow_off" };
  const member = (run.members || [{ c: run.contact_id, s: run.subject }]).find((x) => x.c === d.contact_id) || { c: d.contact_id, s: run.subject };
  const f = await loadFacts({ subject: member.s, contact_id: d.contact_id });
  const hit = firstHolding(run.stop, factsFromRecords({ ...f, since: run.started_at }), now());
  if (hit) return { skip: `stop_${hit.field}` };
  if (d.channel === "sms") {
    const s = await flowSettings();
    const c = await claimText(d.contact_id, `${item.marker && item.marker.key}`, s.max_texts_per_day);
    if (c.over) return { skip: "daily_cap" };
  }
  return {};
}

const sendDef = (key, category, label) => ({
  key, label, trigger: "manual", category, imported: "no", mutates: false,
  defaults: { enabled: true, channels: ["sms"], template_keys: [] },
  async run() { return { result: "skipped:manual" }; },
  recheck: recheckSend,
});
export const SEND_DEFS = Object.freeze([
  sendDef("flow.service", "service", "Your automations: service texts and emails"),
  sendDef("flow.marketing", "marketing", "Your automations: marketing texts and emails"),
]);

// ------------------------------------------------------------ starting

const W8 = (ctx) => (ctx && typeof ctx.write === "function" ? ctx.write() : ctx || {});

// Creates the run once and queues its first step. input: { key, trigger,
// subject, contact_id, members?, by?, test? } → { run, created }
export async function startRun(flow, input, ctx, { mode } = {}) {
  const id = runIdFor(flow.id, input.key);
  const e = await env();
  const t = now();
  const plan = flow.steps.map((s) => ({ ...s }));
  const due = stepDue(t, plan[0], e);
  let run;
  let created = false;
  try {
    run = (await createRecord("flow_run", {
      id, flow_id: flow.id, flow_name: flow.name, flow_wv: flow.wv || 1, trigger: input.trigger, subject: input.subject || null,
      ...(input.contact_id ? { contact_id: input.contact_id } : {}), ...(input.members ? { members: input.members, out: {} } : {}),
      status: "running", started_at: t.toISOString(), next_at: due.toISOString(), plan, stop: (flow.stop || []).map((c) => ({ ...c })),
      steps: plan.map((s, i) => (i === 0 ? { status: "waiting", due_at: due.toISOString() } : { status: "pending" })), step: 0,
      pre_switch: !(mode && mode.system_of_record === "crm"), ...(input.by ? { by: String(input.by).slice(0, 80) } : {}), ...(input.test ? { test: true } : {}),
    }, W8(ctx))).data;
    created = true;
  } catch (err) {
    if (!(err instanceof ExistsError)) throw err;
    run = await dataOf("flow_run", id);
    if (!run) throw err;
  }
  if (run.step === 0 && !FINAL.has(run.status)) {
    await enqueue("flow.step", { type: "flow_run", id: run.id }, {}, new Date(run.next_at || due), { ns: "done", scope: "flow", key: `${run.id}--0` }, { data: { run_id: run.id, i: 0 } });
  }
  const at = tsKey(new Date(run.started_at));
  for (const m of run.members || [{ c: run.contact_id }]) {
    if (isId(m.c, "contact")) await writeOnceRaw(`flowc/${flow.id}/${m.c}/${at}--${run.id}`, { at: run.started_at });
  }
  return { run, created };
}

// The day's starts of a flow so far; over the limit the flow is switched
// off (once) and the owners told.
async function overDailyLimit(flow, ctx) {
  const s = await flowSettings();
  const today = await listRel("flow-runs", flow.id, { from: tsKey(startOfLocalDay(now())), limit: s.max_runs_per_day + 1 });
  if (today.length < s.max_runs_per_day) return false;
  const r = await updateRecord("flow", flow.id, (f) => (f.enabled ? { ...f, enabled: false, auto_paused: { at: nowIso(), reason: "too_many" } } : null), W8(ctx)).catch(() => null);
  if (r && r.changed && has("notify.users")) {
    const owners = (await readIndex("users", "")).rows.filter((u) => u.role === "owner" && u.status === "active").map((u) => u.id);
    await call("notify.users", owners, { kind: "system", title: "An automation was switched off", body: `"${flow.name}" started more than ${s.max_runs_per_day} times today, so it was paused. Check it before turning it back on.`, link: `/automations/flow/${flow.id}` }, W8(ctx)).catch(() => {});
  }
  return true;
}

// One event, one flow. → { started?, result }
export async function considerEvent(flow, event, h, cfg) {
  const p = event.payload || {};
  const key = flowKey(flow.id);
  const log = (subject, result) => logAutomation({ key, subject, result }).catch(() => {});
  const def = TRIGGERS[flow.trigger.type];
  const type = def.subject;
  const sid = type === "contact" ? p.contact_id : p[SUBJECT_ID[type]];
  if (!isId(sid, type)) { await log(p.id, "skipped:no_record"); return { result: "skipped:no_record" }; }
  // already started for this event (a retried listener): finish starting it
  const existing = await dataOf("flow_run", runIdFor(flow.id, event.event_id));
  if (existing) { await startRun(flow, { key: event.event_id }, h.ctx, { mode: h.mode }); return { result: "started", started: true }; }
  if (p.by === `system:${key}`) { await log(sid, "skipped:loop"); return { result: "skipped:loop" }; }
  if (flow.trigger.type === "contact.tagged" && !(p.tags || []).some((x) => String(x).toLowerCase() === String(flow.trigger.tag).toLowerCase())) return { result: "skipped:other_tag" };
  const floor = cfg && cfg.effective_from;
  if (floor && p.at && Date.parse(p.at) < Date.parse(floor)) { await log(sid, "skipped:before_floor"); return { result: "skipped:before_floor" }; }
  const subject = { type, id: sid };
  const f = await loadFacts({ subject, contact_id: p.contact_id });
  if (!f.contact) { await log(sid, "skipped:no_contact"); return { result: "skipped:no_contact" }; }
  if (type !== "contact" && !f.record) { await log(sid, "skipped:no_record"); return { result: "skipped:no_record" }; }
  if (!allHold(flow.conditions, factsFromRecords({ ...f, since: p.at }), now())) { await log(sid, "skipped:conditions"); return { result: "skipped:conditions" }; }
  const hist = await contactHistory(flow.id, f.contact.id);
  if (hist.day >= LOOP_MAX_PER_DAY) { await log(sid, "skipped:loop_guard"); return { result: "skipped:loop_guard" }; }
  if (tooSoon(flow, hist.last)) { await log(sid, "skipped:recently"); return { result: "skipped:recently" }; }
  if (await overDailyLimit(flow, h.ctx)) { await log(sid, "skipped:too_many"); return { result: "skipped:too_many" }; }
  await startRun(flow, { key: event.event_id, trigger: { kind: "event", event: event.name, event_id: event.event_id }, subject, contact_id: f.contact.id, by: p.by }, h.ctx, { mode: h.mode });
  return { result: "started", started: true };
}

// The listener every trigger event gets: (event, h) → { result }
export async function onEvent(event, h) {
  const flows = await flowsFor(event.name);
  if (!flows.length) return { result: "skipped:no_flows" };
  const cfg = await readAutomationsCfg();
  if (cfg.paused) return { result: "skipped:paused" };
  let started = 0;
  for (const flow of flows) {
    try {
      const r = await considerEvent(flow, event, h, cfg);
      if (r.started) started += 1;
    } catch (e) {
      console.error(`crm:automations: an automation could not start (${safeErr(e)})`);
      throw e;
    }
  }
  return { result: started ? `started:${started}` : "skipped:none" };
}

// ------------------------------------------------------------ the daily check

const dayCache = new Set();
export function clearDayCache() { dayCache.clear(); }

// Who a daily trigger is for today: [{ c, s }] (at most MAX_MEMBERS).
export async function membersFor(flow, { at = now() } = {}) {
  const t = flow.trigger;
  const today = localDate(at);
  const hist = await flowHistory(flow.id);
  const fresh = (cid) => !tooSoon(flow, hist.get(cid));
  const out = [];
  const more = (list) => { for (const m of list) { if (out.length >= MAX_MEMBERS) break; out.push(m); } };
  if (t.type === "schedule") {
    const ix = await readIndex("contacts", contactShard("ct_00000000000000000000"));
    const rows = ix.rows.filter((r) => r.lc !== "archived" && !(r.fl && (r.fl.spam || r.fl.vendor)) && fresh(r.id) && allHold(flow.conditions, factsFromRow(r), at));
    more(rows.map((r) => ({ c: r.id, s: { type: "contact", id: r.id } })));
    return out;
  }
  let cands = [];
  if (t.type === "invoice.overdue") {
    const ix = await readIndex("invoices", "open");
    const cutoff = addLocalDays(today, -(t.days ?? 1));
    cands = ix.rows.filter((r) => r.st === "open" && (r.bal || 0) > 0 && r.due && r.due <= cutoff && isId(r.c, "contact")).map((r) => ({ c: r.c, s: { type: "invoice", id: r.id } }));
  } else if (t.type === "plan.renewing") {
    const ix = await readIndex("plans", "");
    const until = addLocalDays(today, t.days ?? 30);
    cands = ix.rows.filter((r) => r.st === "active" && r.te && r.te >= today && r.te <= until && isId(r.c, "contact")).map((r) => ({ c: r.c, s: { type: "plan", id: r.id } }));
  } else if (t.type === "task.due") {
    const ix = await readIndex("tasks/open", "");
    cands = ix.rows.filter((r) => r.due && localDate(new Date(r.due)) === today).map((r) => ({ c: isId(r.c, "contact") ? r.c : null, s: { type: "task", id: r.id } }));
  }
  const seen = new Set();
  for (const m of cands) {
    if (out.length >= MAX_MEMBERS) break;
    if (m.c && (seen.has(m.c) || !fresh(m.c))) continue;
    if (flow.conditions.length) {
      const f = await loadFacts({ subject: m.s, contact_id: m.c });
      if (!allHold(flow.conditions, factsFromRecords({ ...f, since: at.toISOString() }), at)) continue;
    }
    if (m.c) seen.add(m.c);
    out.push(m);
  }
  return out;
}

export async function fireDaily(flow, date, sctx) {
  const members = await membersFor(flow);
  const key = flowKey(flow.id);
  if (!members.length) { await logAutomation({ key, subject: null, result: "skipped:nobody" }).catch(() => {}); return { result: "nobody" }; }
  if (await overDailyLimit(flow, sctx)) return { result: "too_many" };
  const one = members.length === 1 ? members[0] : null;
  await startRun(flow, {
    key: `day:${date}`, trigger: { kind: "schedule", date }, members,
    subject: one ? one.s : null, ...(one && one.c ? { contact_id: one.c } : {}),
  }, sctx, { mode: sctx.mode });
  return { result: `members:${members.length}` };
}

// Sweep "flows.daily" (fast lane, every pass): each daily flow once a day
// at its time on its days (claim done/flowday/{flowId}--{date}).
export async function dailySweep(sctx) {
  const cfg = await readAutomationsCfg();
  if (cfg.paused) return { progress: 0 };
  const keys = await listKeys("rel/flows-by-trigger/");
  const t = now();
  const date = localDate(t);
  const time = localTime(t);
  const dow = localDow(t);
  let progress = 0;
  const ids = [];
  for (const k of keys) {
    const [, , type, rest] = k.split("/");
    if (!isSchedule(type) || !rest) continue;
    const id = rest.split("--").pop();
    if (!dayCache.has(`${id}--${date}`)) ids.push(id);
  }
  if (!ids.length) return { progress: 0 };
  const flows = (await getRecords("flow", ids)).map((g) => g && g.data).filter((f) => f && f.enabled && !f.deleted_at);
  for (const flow of flows) {
    const tr = flow.trigger;
    if (!(tr.dows || []).includes(dow) || time < (tr.at || "10:00")) continue;
    const mk = `${flow.id}--${date}`;
    const claim = await claimMarker("done", "flowday", mk, { holder: sctx.holder || "worker", leaseMs: 5 * 60000 });
    if (!claim.ok) {
      const st = claim.marker && claim.marker.state;
      if (st === "done") dayCache.add(mk);
      continue;
    }
    try {
      const r = await fireDaily(flow, date, sctx);
      await advanceMarker(claim.marker, { state: "done", result: r.result });
      dayCache.add(mk);
      progress += 1;
    } catch (e) {
      console.error(`crm:automations: a daily automation failed (${safeErr(e)})`);
      await advanceMarker(claim.marker, { state: "failed", code: keySafe((e && (e.code || e.name)) || "error", 40), retry_at: new Date(nowMs() + 5 * 60000).toISOString() }).catch(() => {});
    }
  }
  if (dayCache.size > 5000) dayCache.clear();
  return { progress };
}

// Sweep "flows.prune" (bulk, daily): the daily text claims (flowt/) of days
// before yesterday go; they only count today's texts.
export async function pruneSweep() {
  const keep = addLocalDays(localDate(now()), -1);
  const { directories } = await listKeys("flowt/", { directories: true });
  let n = 0;
  for (const d of directories.map((x) => x.replace(/\/+$/, "").replace(/^flowt\//, "")).filter((x) => /^\d{4}-\d{2}-\d{2}$/.test(x) && x < keep)) {
    for (const k of await listKeys(`flowt/${d}/`)) { await deleteRaw(k); n += 1; }
  }
  return { result: `pruned:${n}`, progress: n ? 1 : 0 };
}

// ------------------------------------------------------------ steps

async function usersIndex() {
  const ix = await readIndex("users", "").catch(() => ({ rows: [] }));
  return ix.rows.filter((u) => u.status === "active");
}

// Who a task or notice is for → user ids.
export async function resolveWho(who, contact, users) {
  const list = users || await usersIndex();
  const owners = list.filter((u) => u.role === "owner").map((u) => u.id);
  if (who === "owner") return contact && isId(contact.owner_id, "user") && list.some((u) => u.id === contact.owner_id) ? [contact.owner_id] : owners.slice(0, 1);
  if (who === "owners") return owners;
  if (who === "office") { const office = list.filter((u) => u.role === "admin").map((u) => u.id); return office.length ? office : owners; }
  return isId(who, "user") && list.some((u) => u.id === who) ? [who] : [];
}

const fmtDate = (d) => (d ? new Date(`${d}T12:00:00Z`).toLocaleDateString("en-US", { weekday: "short", month: "short", day: "numeric", timeZone: "UTC" }) : null);
// Template variables a record can fill.
export function varsFrom(type, r) {
  const v = { season_year: String(new Date(now()).getUTCFullYear()) };
  if (!r) return v;
  if (type === "invoice") Object.assign(v, { invoice_number: r.number || null, balance_due: Number.isInteger(r.balance_cents) ? formatCents(r.balance_cents) : null, invoice_total: Number.isInteger(r.total_cents) ? formatCents(r.total_cents) : null, due_date: fmtDate(r.due_on) });
  if (type === "visit") Object.assign(v, { visit_date: fmtDate(r.date) });
  if (type === "plan") Object.assign(v, { plan_name: r.name || null });
  if ((type === "job" || type === "visit" || type === "quote") && (r.service_types || r.services)) {
    const words = [...new Set([...(r.service_types || []), ...(r.services || [])].map((s) => String(s).toLowerCase().replace(/^residential\s+/, "")))].slice(0, 2);
    if (words.length) v.service_list = words.join(" and ");
  }
  return v;
}
const relatedOf = (s) => (s && s.type && s.type !== "contact" ? { [`${s.type}_id`]: s.id } : {});

async function defForTemplate(key) {
  const t = await getTemplateByKey(key).catch(() => null);
  if (!t) return { template: null, def: null };
  return { template: t, def: automationDef(t.category === "marketing" ? "flow.marketing" : "flow.service") };
}

// One step for one member (not a send). → result string
async function doStep(step, m, f, run, actx, ctx) {
  const contact = f.contact;
  const subj = { record: f.record || contact, contact };
  const tag = (x) => `${run.id}--${run.step}--${memberKey(m)}`;
  switch (step.type) {
    case "task": {
      if (!has("sales.createTask")) return "skipped:no_sales";
      const users = await usersIndex();
      const to = await resolveWho(step.assign, contact, users);
      const due = step.due_days !== undefined ? zonedToUtc(addLocalDays(localDate(now()), step.due_days), "17:00").toISOString() : undefined;
      const data = { title: step.title, kind: "follow_up", priority: "medium", status: "open", assignee_ids: to, notes: `Made by the automation "${run.flow_name}".`, ...(contact ? { contact_id: contact.id } : {}), ...(due ? { due_at: due } : {}) };
      const r = await actx.mutate(subj, "create_task", () => call("sales.createTask", data, { seed: tag() }, ctx), { task: [null, step.title] });
      return r.would ? "would-create_task" : "done";
    }
    case "tag_add": case "tag_remove": {
      if (!contact || !has("contacts.tag")) return "skipped:no_contact";
      const add = step.type === "tag_add";
      const hasIt = (contact.tags || []).some((x) => x.toLowerCase() === step.tag.toLowerCase());
      if (add === hasIt) return "skipped:already";
      const r = await actx.mutate({ record: contact, contact }, add ? "add_tag" : "remove_tag", () => call("contacts.tag", contact.id, add ? { add: [step.tag] } : { remove: [step.tag] }, ctx), { tags: [add ? null : step.tag, add ? step.tag : null] });
      return r.would ? `would-${add ? "add_tag" : "remove_tag"}` : "done";
    }
    case "assign_owner": {
      if (!contact || !has("contacts.setOwner")) return "skipped:no_contact";
      if (contact.owner_id === step.user_id) return "skipped:already";
      const r = await actx.mutate({ record: contact, contact }, "assign_owner", () => call("contacts.setOwner", contact.id, step.user_id, ctx), { owner_id: [contact.owner_id || null, step.user_id] });
      return r.would ? "would-assign_owner" : "done";
    }
    case "deal_stage": {
      if (!contact || !has("sales.dealOf")) return "skipped:no_deal";
      const deal = await call("sales.dealOf", contact.id, ctx);
      if (!deal) return "skipped:no_deal";
      if (deal.status === step.stage) return "skipped:already";
      const r = await actx.mutate({ record: deal, contact }, `mark_${step.stage}`, () => call("sales.markDeal", deal.id, step.stage, { force: true, reason: "other" }, ctx), { status: [deal.status, step.stage] });
      return r.would ? `would-mark_${step.stage}` : "done";
    }
    case "cadence": {
      if (!contact || !has("sales.enroll")) return "skipped:no_sales";
      const r = await actx.mutate({ record: f.record || contact, contact }, "enroll", () => call("sales.enroll", contact.id, step.cadence_key, { ...(f.type === "quote" && f.record ? { quote_id: f.record.id } : {}) }, ctx), { cadence: [null, step.cadence_key] });
      return r.would ? "would-enroll" : r.result ? "done" : "skipped:not_enrolled";
    }
    case "notify": {
      if (!has("notify.users")) return "skipped:no_notify";
      const to = await resolveWho(step.to, contact, null);
      if (!to.length) return "skipped:nobody";
      const mk = `${run.id}--${run.step}--${memberKey(m)}`;
      const claim = await claimMarker("done", "flownote", mk, { holder: ctx.requestId || "worker", leaseMs: 120000 });
      if (!claim.ok) return claim.marker && claim.marker.state === "done" ? "done" : "skipped:busy";
      const who = contact ? contact.display_name || [contact.first_name, contact.last_name].filter(Boolean).join(" ") : "";
      await call("notify.users", to, { kind: "system", title: run.flow_name.slice(0, 80), body: `${step.message}${who ? ` (${who})` : ""}`, link: contact ? `/contacts/${contact.id}` : "/automations" }, ctx);
      await advanceMarker(claim.marker, { state: "done", result: "sent" });
      return "done";
    }
    default: return "skipped:unknown";
  }
}

async function finishRun(runId, status, extra = {}, ctx) {
  await updateRecord("flow_run", runId, (r) => (FINAL.has(r.status) ? null : { ...r, status, finished_at: nowIso(), next_at: null, ...extra }), W8(ctx));
  return { result: `${status}${extra.stop_reason ? `:${keySafe(extra.stop_reason, 30)}` : ""}` };
}

const tally = (results) => {
  const c = {};
  for (const r of results) { const k = r.startsWith("would-") ? "would" : r.split(":")[0]; c[k] = (c[k] || 0) + 1; }
  return c;
};

// Queue kind "flow.step": step i of a run.
export async function runStep(h) {
  const { run_id: runId, i } = h.item.data || {};
  const got = await getRecord("flow_run", runId).catch(() => null);
  if (!got) return { result: "skipped:no_run" };
  const run = got.data;
  if (FINAL.has(run.status)) return { result: "skipped:ended" };
  if ((run.step || 0) > i) return { result: "skipped:done" };
  const ctxBase = automationCtx({ mode: h.mode, key: flowKey(run.flow_id), requestId: h.ctx.requestId });
  const flow = await dataOf("flow", run.flow_id);
  if (!flow || flow.deleted_at) return finishRun(run.id, "stopped", { stop_reason: "deleted" }, ctxBase);
  const cfg = await readAutomationsCfg();
  if (!run.test && (!flow.enabled || cfg.paused)) {
    const since = run.held_since || nowIso();
    if (nowMs() - Date.parse(since) > HOLD_MAX_DAYS * 86400000) return finishRun(run.id, "stopped", { stop_reason: "paused_too_long" }, ctxBase);
    if (!run.held_since) await updateRecord("flow_run", run.id, (r) => ({ ...r, held_since: since, steps: r.steps.map((s, k) => (k === i ? { ...s, status: "held" } : s)) }), ctxBase.write()).catch(() => {});
    return { defer: new Date(nowMs() + HOLD_RECHECK_MIN * 60000), reason: "paused" };
  }
  if (run.pre_switch && h.mode && h.mode.system_of_record === "crm") return finishRun(run.id, "stopped", { stop_reason: "switch_over" }, ctxBase);
  const step = run.plan[i];
  const actx = { ...ctxBase, mutate: async (subject, action, fn, changes) => {
    if (!ctxBase.mayAct(subject)) { await ctxBase.would(subject, action, changes); return { done: false, would: true }; }
    return { done: true, result: await fn() };
  } };
  const members = (run.members || [{ c: run.contact_id || null, s: run.subject }]).filter((m) => !(run.out && run.out[memberKey(m)]));
  const out = {};
  const results = [];
  const live = [];
  for (const m of members) {
    const f = await loadFacts({ subject: m.s, contact_id: m.c });
    const facts = factsFromRecords({ ...f, since: run.started_at });
    const hit = firstHolding(run.stop, facts, now());
    if (hit) { out[memberKey(m)] = `stop_${hit.field}`; results.push(`stopped:${hit.field}`); continue; }
    if (step.type === "stop_if") {
      const s = firstHolding(step.conditions, facts, now());
      if (s) { out[memberKey(m)] = `stop_if_${s.field}`; results.push(`stopped:${s.field}`); } else results.push("done");
      continue;
    }
    live.push({ m, f });
  }
  let bulk = null;
  if ((step.type === "text" || step.type === "email") && live.length) {
    const { template, def } = await defForTemplate(step.template_key);
    if (!template || !def) for (const x of live) results.push("skipped:no_template");
    else {
      const sctx = automationContext(def, { mode: h.mode, settings: { ...settingsFor(def, cfg), channels: [step.type === "text" ? "sms" : "email"] }, cfg, requestId: h.ctx.requestId });
      const channel = step.type === "text" ? "sms" : "email";
      const withContact = live.filter((x) => x.f.contact);
      for (const x of live) if (!x.f.contact) results.push("skipped:no_contact");
      const sends = withContact.map((x) => ({
        contact_id: x.f.contact.id, contact: x.f.contact, subject: x.m.s || { type: "contact", id: x.f.contact.id }, channel, template_key: step.template_key, due_at: now(),
        key: run.members && run.members.length > 1 ? `${run.id}--${i}--${x.f.contact.id}` : `${run.id}--${i}`, vars: varsFrom(x.f.type, x.f.record), related: relatedOf(x.m.s),
      }));
      if (sends.length > await bulkThreshold()) {
        const r = await sctx.sendMany(sends, { channel, template_key: step.template_key, title: `${run.flow_name} (${localDate(now())})` });
        if (r.bulk) { bulk = r.bulk_run_id; for (const s of sends) results.push("bulk"); } else for (const s of sends) results.push(`skipped:${r.reason || "not_sent"}`);
      } else {
        for (const s of sends) {
          const r = await sctx.send(s);
          results.push(r.queued ? "queued" : `skipped:${r.reason || "done"}`);
        }
      }
    }
  } else if (step.type !== "stop_if") {
    for (const x of live) {
      try {
        results.push(await doStep(step, x.m, x.f, { ...run, step: i }, actx, actx.write()));
      } catch (e) {
        if (e instanceof ParallelRunGuard) { await ctxBase.would(x.m.c, step.type, undefined); results.push(`would-${step.type}`); continue; }
        // the record says no (merged away, a rule it keeps): this one is skipped, never retried
        if (e instanceof InputError || e instanceof ConflictError || e instanceof NotFoundError) { results.push(`skipped:${keySafe(e.name.replace(/Error$/, "").toLowerCase(), 20)}`); continue; }
        throw e;
      }
    }
  }
  // what this step did
  const single = !(run.members && run.members.length > 1);
  const res = single ? results[0] || "skipped:nobody" : null;
  const status = bulk ? "bulk" : single ? (res.startsWith("would-") ? "would" : res === "queued" ? "queued" : res.startsWith("skipped") ? "skipped" : res.startsWith("stopped") ? "done" : "done") : "done";
  const stepOut = { status, at: nowIso(), ...(single ? { result: res } : { counts: tally(results) }), ...(bulk ? { bulk_run_id: bulk } : {}) };
  const allOut = { ...(run.out || {}), ...out };
  const left = (run.members || [{ c: run.contact_id || null, s: run.subject }]).filter((m) => !allOut[memberKey(m)]);
  const e = await env();
  const next = i + 1 < run.plan.length && left.length ? stepDue(now(), run.plan[i + 1], e) : null;
  if (next) await enqueue("flow.step", { type: "flow_run", id: run.id }, {}, next, { ns: "done", scope: "flow", key: `${run.id}--${i + 1}` }, { data: { run_id: run.id, i: i + 1 } });
  const firstStop = Object.values(out)[0] || null;
  await updateRecord("flow_run", run.id, (r) => {
    if (FINAL.has(r.status) || (r.step || 0) > i) return null;
    const steps = r.steps.map((s, k) => (k === i ? stepOut : k === i + 1 && next ? { status: "waiting", due_at: next.toISOString() } : s));
    const base = { ...r, steps, step: i + 1, ...(r.members ? { out: allOut } : {}), held_since: undefined };
    delete base.held_since;
    if (next) return { ...base, status: "waiting", next_at: next.toISOString() };
    if (!left.length) return { ...base, status: "stopped", finished_at: nowIso(), next_at: null, stop_reason: single ? (firstStop || "stopped") : "everyone_stopped" };
    return { ...base, status: "done", finished_at: nowIso(), next_at: null };
  }, ctxBase.write());
  return { result: single ? String(res).slice(0, 60) : `members:${members.length}` };
}

// ------------------------------------------------------------ a test run

const subjectRel = { quote: "contact-quotes", invoice: "contact-invoices", plan: "contact-plans", job: "contact-jobs", task: "contact-tasks" };

// The record a test run uses for a contact: its newest one of the trigger's kind.
export async function subjectForTest(type, contactId) {
  if (type === "contact") return { type, id: contactId };
  if (subjectRel[type]) {
    const rows = await listRel(subjectRel[type], contactId, { limit: 1 });
    return rows.length ? { type, id: rows[0].id } : null;
  }
  if (type === "visit") {
    const jobs = await listRel("contact-jobs", contactId, { limit: 1 });
    if (!jobs.length) return null;
    const job = await dataOf("job", jobs[0].id);
    const v = job && (job.visit_ids || [])[job.visit_ids ? job.visit_ids.length - 1 : 0];
    return isId(v, "visit") ? { type, id: v } : null;
  }
  return null;
}

const nameOf = (c) => (c ? c.display_name || [c.first_name, c.last_name].filter(Boolean).join(" ") || "this customer" : "this customer");

// What would happen for one record, step by step. Reads only. labels: the
// catalog's names for templates, users, cadences.
export async function simulate(flow, { contact_id, subject: given } = {}, { mode, labels = {} } = {}) {
  const def = TRIGGERS[flow.trigger.type];
  const subject = given || (isId(contact_id, "contact") ? await subjectForTest(def.subject, contact_id) : null);
  const f = await loadFacts({ subject: subject || { type: "contact", id: contact_id }, contact_id });
  const contact = f.contact;
  const t = now();
  const out = { contact: contact ? { id: contact.id, name: nameOf(contact) } : null, subject: subject && f.record ? { type: subject.type, id: subject.id } : null, notes: [], conditions: [], steps: [] };
  if (!contact) { out.notes.push("That contact isn't here."); return out; }
  if (def.subject !== "contact" && !f.record) out.notes.push(`${nameOf(contact)} has no ${def.subject} yet, so this shows the contact's side only.`);
  const facts = factsFromRecords({ ...f, since: t.toISOString() });
  out.conditions = flow.conditions.map((c) => ({ phrase: conditionPhrase(c, { ...labels, subject: def.subject }), ok: holds(c, facts, t) }));
  out.starts = out.conditions.every((c) => c.ok);
  const guard = guardFor(mode);
  const mayAct = guard.mayAct({ record: f.record || contact, contact });
  out.guarded = !mayAct;
  if (!mayAct) out.notes.push("Rotor still owns this customer: changes would only be reported (\"would have\" rows) and texts go to the Outbox.");
  if (flow.id && isId(contact.id, "contact")) {
    const hist = await contactHistory(flow.id, contact.id);
    if (tooSoon(flow, hist.last)) out.notes.push(`It ran for ${nameOf(contact)} in the last ${flow.limits.per_contact_days} days, so it wouldn't start again yet.`);
  }
  const stopNow = firstHolding(flow.stop, facts, t);
  if (stopNow) out.notes.push(`It would stop right away: ${conditionPhrase(stopNow, { ...labels, subject: def.subject })}.`);
  const e = await env();
  const [messaging, company, calendar, s] = await Promise.all([getSetting("messaging").catch(() => ({})), getSetting("company").catch(() => ({})), getSetting("calendar").catch(() => DEFAULT_CALENDAR), flowSettings()]);
  let at = t;
  let texts = isId(contact.id, "contact") ? await textsToday(contact.id) : 0;
  const users = await usersIndex();
  const userName = (id) => (users.find((u) => u.id === id) || {}).name || "someone";
  for (const step of flow.steps) {
    at = stepDue(at, step, e);
    const row = { type: step.type, phrase: stepPhrase(step, { ...labels, subject: def.subject }), at: at.toISOString(), outcome: "", detail: null };
    if (step.type === "text" || step.type === "email") {
      const channel = step.type === "text" ? "sms" : "email";
      const tpl = await getTemplateByKey(step.template_key).catch(() => null);
      if (!tpl) { row.outcome = "blocked"; row.detail = "That template isn't there any more."; out.steps.push(row); continue; }
      const to = addressOf(contact, channel);
      const block = !to ? "no_address" : consentBlock(channel, tpl.category, contact);
      const vars = varsFor({ contact, company, extra: varsFrom(f.type, f.record) });
      const r = renderTemplate(tpl, vars, { company });
      if (block) { row.outcome = "blocked"; row.detail = block === "no_address" ? `No ${channel === "sms" ? "mobile number that takes texts" : "email address"}.` : tpl.category === "marketing" ? "No marketing consent (a marketing text needs a yes)." : "They said no to texts."; }
      else if (r.missing && r.missing.length) { row.outcome = "blocked"; row.detail = `The template needs ${r.missing.map((x) => `{{${x}}}`).join(", ")}, which this record can't fill.`; }
      else if (channel === "sms" && texts >= s.max_texts_per_day) { row.outcome = "skipped"; row.detail = `They'd already have ${texts} automated texts that day (the limit is ${s.max_texts_per_day}).`; }
      else {
        const rule = quietRule(tpl.category, "automation", (messaging && messaging.quiet) || {}, calendar || DEFAULT_CALENDAR);
        if (rule && !allowedNow(rule, at)) { try { at = nextAllowed(at, rule); row.at = at.toISOString(); row.quiet = true; } catch { /* no allowed time */ } }
        row.outcome = "outbox";
        row.detail = `${channel === "sms" ? "Text" : "Email"} to ${channel === "sms" ? "their mobile" : "their email"}: goes to the Outbox (dry run, nothing is sent).`;
        row.body = r.text || null;
        if (channel === "sms") texts += 1;
      }
    } else if (step.type === "stop_if") {
      const hit = firstHolding(step.conditions, facts, at);
      row.outcome = hit ? "stop" : "continue";
      row.detail = hit ? "True now, so it would stop here." : "Not true now, so it goes on.";
    } else if (step.type === "notify") {
      const to = await resolveWho(step.to, contact, users);
      row.outcome = to.length ? "notify" : "skipped";
      row.detail = to.length ? `Tells ${to.map(userName).join(", ")} (the bell, and push where they turned it on): "${step.message}"` : "Nobody to tell.";
    } else if (step.type === "task") {
      const to = await resolveWho(step.assign, contact, users);
      row.outcome = mayAct ? "change" : "would";
      row.detail = `${mayAct ? "Makes" : "Would make"} a task for ${to.map(userName).join(", ") || "nobody"}: "${step.title}"`;
    } else if (step.type === "deal_stage") {
      const deal = has("sales.dealOf") ? await call("sales.dealOf", contact.id, {}).catch(() => null) : null;
      const label = (DEAL_STAGES.find((d) => d.value === step.stage) || {}).label;
      if (!deal) { row.outcome = "skipped"; row.detail = "They have no deal to move."; }
      else { const ok = guard.mayAct({ record: deal, contact }); row.outcome = ok ? "change" : "would"; row.detail = `${ok ? "Moves" : "Would move"} the deal from ${deal.status} to ${label}.`; }
    } else {
      row.outcome = mayAct ? "change" : "would";
      row.detail = `${mayAct ? "Does it" : "Would only be reported"}: ${row.phrase}.`;
    }
    out.steps.push(row);
  }
  return out;
}

export { STEP_TYPES, sandboxed };
