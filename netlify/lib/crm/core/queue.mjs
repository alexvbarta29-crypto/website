// Barta CRM core: the scheduled-work queue and the event dispatcher (design
// §7.2 step 1, §7.3, §11.3 "Events").
//
// Keys are UTC: q/{yyyy-mm-dd}/{HHMM}--{qid}, so the repeated 01:00-01:59
// hour of a fall-back day (2026-11-01) can never run an item early; local
// times live only in the payload. An item holds the subject reference and
// the state it expects, never a rendered body:
//   { v, kind, subject: { type, id }, expect, marker: { ns, scope, key }, attempts, due_at, data? }
//
// Running one (runQueueItem):
//   1. claim its marker with a lease (the queue key itself is not the claim);
//      a final marker means it already ran: the key is deleted;
//   2. the kind's handler re-reads the subject and acts on its current state
//      (a subject that changed → { result: "skipped:changed" });
//   3. { defer: at } (quiet hours) keeps the SAME marker (claimed,
//      deferred_until, queue_key) and moves the item to the new minute;
//      a throw (or { retry: true }) re-enqueues with backoff 1, 5, 30, 120
//      minutes, 5 attempts, then the marker is failed and the owners alerted;
//      a ParallelRunGuard from the store becomes a would-<action> row;
//   4. the q/ key is deleted only after the marker is final.
//
// Handlers: queue kinds from the manifests ({ handler, mutates }), called
// as handler(h) with h = { item, key, marker, advance(next), ctx, mode,
// budget }: ctx is the automation write context (activity.mjs
// automationCtx: mayAct, would, log, write). A sending handler advances the
// marker itself (claimed → sending → done); anything left `claimed` is
// moved to done with the handler's { result }.
//
// Events: emit() (core/events.mjs) hands each emission here: every
// listener becomes an "evt" item whose marker is done/evt/{event_id}--{module},
// and the fast lane is kicked. A listener is called as handler(event, h).

import { getRaw, deleteRaw, listKeys, claimMarker, advanceMarker, K } from "../../crm-store.mjs";
import { now, nowMs, nowIso } from "./clock.mjs";
import { newId } from "./ids.mjs";
import { InputError, ParallelRunGuard, SchemaTooNew, RegistryError } from "./errors.mjs";
import { queueKind, listenersFor } from "./registry.mjs";
import { setDispatcher, listenerMarker } from "./events.mjs";
import { NAMESPACES, FINAL_STATES } from "./markers.mjs";
import { automationCtx, wouldAct, logAutomation, writeOnceRaw } from "./activity.mjs";
import { kickWorker, updateHealth, withAlert } from "./lanes.mjs";
import { keySafe } from "./text.mjs";
import { safeErr } from "../../referral-lib.mjs";

export { kickWorker };

export const RETRY_MINUTES = Object.freeze([1, 5, 30, 120]);
export const MAX_ITEM_ATTEMPTS = 5;
export const ITEM_LEASE_MS = 2 * 60 * 1000;
export const KICK_WITHIN_MS = 12 * 60 * 1000;   // an item due this soon wakes the fast lane now (it sleeps until due)
export const EVT_KIND = "evt";

const toDate = (d) => (d instanceof Date ? new Date(d.getTime()) : new Date(d));
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const KEY_RE = /^q\/(\d{4}-\d{2}-\d{2})\/(\d{4})--([a-z0-9._-]+)$/;

// q/{utcDate}/{utcHHMM}--{qid} for a due time.
export function queueKey(dueAt, qid) {
  const d = toDate(dueAt);
  if (!Number.isFinite(d.getTime())) throw new InputError("A queue item needs a due time.", "due_at");
  const iso = d.toISOString();
  return K.q(iso.slice(0, 10), iso.slice(11, 13) + iso.slice(14, 16), keySafe(qid, 40));
}

// The UTC due minute a key names.
export function parseQueueKey(key) {
  const m = KEY_RE.exec(String(key));
  if (!m) return null;
  return { date: m[1], hhmm: m[2], qid: m[3], minute: new Date(`${m[1]}T${m[2].slice(0, 2)}:${m[2].slice(2)}:00.000Z`) };
}

// Writes one queue item (onlyIfNew under a fresh id) and, when it is due
// within KICK_WITHIN_MS, wakes the fast lane. → the key.
// opts: { qid, attempts, data, kick = true }.
export async function enqueue(kind, subject, expect, dueAt, marker, opts = {}) {
  if (kind !== EVT_KIND && !queueKind(kind)) throw new RegistryError(`queue kind ${kind} is not declared`);
  if (!marker || !NAMESPACES.includes(marker.ns) || typeof marker.scope !== "string" || typeof marker.key !== "string") throw new TypeError("enqueue: marker { ns, scope, key } is required");
  const at = toDate(dueAt ?? now());
  const key = queueKey(at, opts.qid || newId("queue_item"));
  const value = {
    v: 1, kind, subject: subject || null, expect: expect || {}, marker: { ns: marker.ns, scope: marker.scope, key: marker.key },
    attempts: opts.attempts || 0, due_at: at.toISOString(), enqueued_at: nowIso(), ...(opts.data !== undefined ? { data: opts.data } : {}),
  };
  await writeOnceRaw(key, value, opts.store || {});
  if (opts.kick !== false && at.getTime() - nowMs() <= KICK_WITHIN_MS) await kickWorker("fast", `queue:${kind}`);
  return key;
}

// What is due now, oldest first, plus the queue's depth and the next item
// not yet due. One listing for the dates, one per date up to the first
// future minute. → { due: [key], depth, next_due_at }
export async function scanQueue(opts = {}) {
  const t = now();
  const iso = t.toISOString();
  const today = iso.slice(0, 10);
  const hhmm = iso.slice(11, 13) + iso.slice(14, 16);
  const { directories } = await listKeys("q/", { directories: true }, opts);
  const dates = directories.map((d) => d.replace(/\/+$/, "").replace(/^q\//, "")).filter((d) => DATE_RE.test(d)).sort();
  const due = [];
  let depth = 0;
  let next = null;
  for (const date of dates) {
    const keys = await listKeys(`q/${date}/`, {}, opts);
    depth += keys.length;
    for (const k of keys) {
      const p = parseQueueKey(k);
      if (!p) continue;
      if (date < today || (date === today && p.hhmm <= hhmm)) due.push(k);
      else if (!next || k < next) next = k;
    }
    if (next || date > today) break;
  }
  const n = next ? parseQueueKey(next) : null;
  return { due: due.sort(), depth, next_due_at: n ? n.minute.toISOString() : null };
}

const isFinal = (m) => !!m && (FINAL_STATES.includes(m.state) || (m.state === "failed" && !m.retry_at));

const unknownKinds = new Set();   // logged once per warm instance, not every pass

// Thrown to end the invocation (a record written by newer code, §3.14 rule 2).
export class StopInvocation extends Error {}

// Runs one queue item (see the top of the file). → { outcome, ... } where
// outcome is "done" | "deferred" | "retry" | "failed" | "superseded" |
// "busy" | "sending" | "settling" | "not_due" | "gone".
export async function runQueueItem(key, { holder, mode, budget } = {}, opts = {}) {
  const got = await getRaw(key, opts);
  if (!got || !got.data) return { outcome: "gone" };
  const item = got.data;
  if (Date.parse(item.due_at) > nowMs()) return { outcome: "not_due", due_at: item.due_at };
  const def = item.kind === EVT_KIND ? { handler: runListener, mutates: true } : queueKind(item.kind);
  if (!def) {
    if (!unknownKinds.has(item.kind)) { unknownKinds.add(item.kind); console.error("crm:queue: no handler for a queue kind; its items wait for a deploy that has one"); }
    return { outcome: "busy" };
  }
  const m = item.marker || {};
  const claim = await claimMarker(m.ns, m.scope, m.key, { holder, leaseMs: ITEM_LEASE_MS }, opts);
  if (!claim.ok) {
    const mk = claim.marker;
    if (isFinal(mk)) { await deleteRaw(key, opts); return { outcome: "done", already: true }; }
    if (mk && (mk.state === "claimed" || mk.state === "failed") && mk.queue_key && mk.queue_key !== key) { await deleteRaw(key, opts); return { outcome: "superseded" }; }
    if (claim.settling) return { outcome: "settling" };
    return { outcome: mk && mk.state === "sending" ? "sending" : "busy" };
  }
  const actx = automationCtx({ mode, key: item.kind === EVT_KIND ? `evt:${(item.data && item.data.module) || "x"}` : item.kind, requestId: holder });
  const h = {
    item, key, marker: claim.marker, ctx: actx, mode, budget,
    async advance(next) { h.marker = await advanceMarker(h.marker, next, opts); return h.marker; },
  };
  let res;
  try {
    res = (await def.handler(h)) || {};
  } catch (e) {
    if (e instanceof SchemaTooNew) throw new StopInvocation("a record was written by newer code");
    if (e instanceof ParallelRunGuard) {
      await wouldAct({ key: item.kind, subject: e.subject || (item.subject && item.subject.id), action: e.action || "change", changes: e.fields ? { fields: e.fields } : undefined }, opts).catch(() => {});
      res = { result: `would-${keySafe(e.action || "change", 20)}` };
    } else {
      console.error(`crm:queue: a ${keySafe(item.kind, 30)} step failed (${safeErr(e)})`);
      res = { retry: true, code: keySafe(e.code || e.name || "error", 40) };
    }
  }
  let marker = h.marker;
  if (marker.state === "sending") return { outcome: "sending" };       // settled by fix.settle / the provider's settler; the key stays
  if (isFinal(marker)) { await deleteRaw(key, opts); return { outcome: marker.state === "failed" ? "failed" : "done", result: marker.result }; }

  if (res.defer) {
    const at = toDate(res.defer);
    const newKey = queueKey(at, newId("queue_item"));
    await writeOnceRaw(newKey, { ...item, due_at: at.toISOString(), deferred_from: key }, opts);
    await advanceMarker(marker, { state: "claimed", deferred_until: at.toISOString(), queue_key: newKey, reason: res.reason || "deferred" }, opts);
    await deleteRaw(key, opts);
    return { outcome: "deferred", until: at.toISOString(), key: newKey };
  }
  if (res.retry) {
    const attempts = (item.attempts || 0) + 1;
    const code = keySafe(res.code || "error", 40);
    if (attempts < MAX_ITEM_ATTEMPTS) {
      const at = new Date(nowMs() + RETRY_MINUTES[Math.min(attempts - 1, RETRY_MINUTES.length - 1)] * 60000);
      const newKey = queueKey(at, newId("queue_item"));
      await writeOnceRaw(newKey, { ...item, attempts, due_at: at.toISOString(), last_error: code }, opts);
      await advanceMarker(marker, { state: "failed", code, retry_at: at.toISOString(), queue_key: newKey }, opts);
      await deleteRaw(key, opts);
      return { outcome: "retry", attempts, retry_at: at.toISOString() };
    }
    marker = await advanceMarker(marker, { state: "failed", code }, opts);
    await logAutomation({ key: item.kind, subject: item.subject && item.subject.id, result: `failed:${code}` }, opts).catch(() => {});
    await updateHealth((hh) => withAlert(hh, `queue:${keySafe(item.kind, 40)}`, "A scheduled step kept failing and was stopped. Check the activity log."), opts);
    await deleteRaw(key, opts);
    return { outcome: "failed", code };
  }
  marker = await advanceMarker(marker, { state: "done", result: String(res.result || "done").slice(0, 80), ...(res.provider_ref ? { provider_ref: res.provider_ref } : {}) }, opts);
  await deleteRaw(key, opts);
  return { outcome: "done", result: marker.result };
}

// The fast lane's queue step: every due item, oldest first, while the
// pass budget lasts. → { finished, due, depth, next_due_at, more }.
export async function drainQueue({ holder, mode, budget, minLeftMs = 3000 } = {}, opts = {}) {
  const scan = await scanQueue(opts);
  let finished = 0;
  let next = scan.next_due_at;
  let more = false;
  for (const key of scan.due) {
    if (budget && budget.left() < minLeftMs) { more = true; break; }
    let r;
    try {
      r = await runQueueItem(key, { holder, mode, budget }, opts);
    } catch (e) {
      if (e instanceof StopInvocation) return { finished, due: scan.due.length, depth: scan.depth, next_due_at: next, more: true, stop: true };
      console.error(`crm:queue: an item could not run (${safeErr(e)})`);
      continue;
    }
    if (["done", "failed", "superseded"].includes(r.outcome)) finished += 1;
    if (r.outcome === "not_due" && (!next || r.due_at < next)) next = r.due_at;
  }
  return { finished, due: scan.due.length, depth: scan.depth, next_due_at: next, more };
}

// ------------------------------------------------------------ events

const refOf = (payload) => {
  for (const f of ["job_id", "visit_id", "quote_id", "invoice_id", "payment_id", "plan_id", "agreement_id", "review_id", "contact_id"]) {
    if (typeof payload[f] === "string") return { type: f.slice(0, -3), id: payload[f] };
  }
  return { type: null, id: payload.id };
};

// The dispatcher emit() calls: one "evt" item per listener (marker
// done/evt/{event_id}--{module}), then one kick of the fast lane.
export async function dispatchEvent(event, listeners, ctx = {}) {
  const keys = [];
  for (const l of listeners) {
    const marker = listenerMarker(event.event_id, l.module);
    keys.push(await enqueue(EVT_KIND, refOf(event.payload), { wv: event.payload.wv }, now(), marker, {
      data: { name: event.name, event_id: event.event_id, module: l.module, payload: event.payload }, kick: false,
    }));
  }
  if (keys.length) await kickWorker("fast", `event:${event.name}`);
  return { event, listeners: listeners.map((l) => l.module), queued: keys.length > 0, keys };
}

// The handler of "evt" items: the listener of that module for that event,
// called as handler(event, h). It re-reads the subject and acts on its
// current state (a job no longer completed → "skipped:changed").
export async function runListener(h) {
  const d = h.item.data || {};
  const l = listenersFor(d.name).find((x) => x.module === d.module);
  if (!l) return { result: "skipped:no_listener" };
  const event = { name: d.name, event_id: d.event_id, payload: d.payload || {} };
  return (await l.handler(event, h)) || { result: "done" };
}

setDispatcher(dispatchEvent);
