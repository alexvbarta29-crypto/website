// Sales module: calls and the call list (design §5.2 "How a step runs",
// "Calls", "Needs attention"; §9.2 Leads & calls).
//
// logCall() is POST /calls. Tapping Call on the list first logs a
// provisional "calling" (stats.sales.calling_until = now + 30 min, which
// holds lead.ack off, D20); the outcome comes when the phone returns to the
// app:
//   no_answer / voicemail  the step's text goes out (one text; the footer
//                          rule applies) and the step moves on. While texting
//                          is in dry-run the text lands in the Outbox and the
//                          list shows Copy text / Open in Messages and asks
//                          "Did you send it?" before moving on (sent_by_hand).
//                          A review-before-send step (the estimate follow-up)
//                          opens the compose sheet prefilled instead.
//   spoke                  the enrollment pauses; a "Follow up after call" task
//   booked                 the enrollment completes (booked); the deal turns
//                          won when the job or quote is approved
//   not_interested         the enrollment stops; the deal is lost
//   wrong_number           the enrollment stops; the number is flagged and no
//                          longer texted
// A double dial is one touch (D8). An inbound call (a lead calling back,
// which the texts ask them to do) is never an outbound touch: it pauses the
// contact's cadences like a reply does and makes a task.
// Every call writes a timeline row (call.<outcome> or call.in), the sales
// stats part and the call.logged event.

import { getRecord, updateRecord, updateStats, addActivity, readIndex } from "../../../crm-store.mjs";
import { deriveId, newId, isId } from "../../core/ids.mjs";
import { now, nowIso, localDate, addLocalDays } from "../../core/clock.mjs";
import { InputError, NotFoundError, ConflictError } from "../../core/errors.mjs";
import { emit } from "../../core/events.mjs";
import { adapter } from "../../adapters/index.mjs";
import { contactShard } from "../../core/stats.mjs";
import { safeErr } from "../../../referral-lib.mjs";
import { CALL_OUTCOMES } from "./types.mjs";
import { stepOf, logStep, noteStep, setStatus, isOpen, textsOn, windowsOf, windowsMissed, isOverdue, smsHref } from "./cadence.mjs";
import {
  changeEnrollment, openEnrollmentsOf, cadenceById, sendStepText, previewStep, stepEffects, enrollmentView,
} from "./enroll.mjs";
import { markDeal, touchDeal } from "./deals.mjs";
import { followUpTask, tomorrowAt } from "./tasks.mjs";
import { W, loadEnv, contactOf, nameOf, firstNameOf, primaryPhone, leadPeople } from "./common.mjs";

const MAX_NOTE = 1000;
const CLIENT_ID = /^[A-Za-z0-9-]{8,64}$/;

// ------------------------------------------------------------ stats

export const SALES_STATS = Object.freeze({ last_called_at: null, calling_until: null, last_touch_at: null, last_inbound_call_at: null });

export function setCalling(contactId, minutes = 30, ctx = {}) {
  const until = new Date(now().getTime() + minutes * 60000).toISOString();
  return updateStats(contactId, "sales", (p) => ({ ...p, calling_until: until }), W(ctx)).then(() => until);
}

// ------------------------------------------------------------ a step's text after a call

// What the person sees next: the text went out ("sent"), a text to send by
// hand ("hand"), the compose sheet ("compose"), held back ("blocked"), or
// nothing to text ("none").
async function textAfterCall(enr, step, { callId, user, ctx, env, contact }) {
  const by = W(ctx).by;
  if (step.review_before_send) {
    const p = await previewStep(enr, step, { sender: user });
    const r = await changeEnrollment(enr.id, (e) => (e.step_n === enr.step_n ? { ...e, pending: { n: enr.step_n, kind: "compose", at: nowIso() } } : null), ctx, { env });
    return { next: { kind: "compose", n: enr.step_n, text: p.text, missing: p.missing, template_key: p.template_key, ...(contact ? { sms_href: smsHref(primaryPhone(contact), p.text) } : {}) }, enrollment: r.data };
  }
  const sent = await sendStepText(enr, step, { user, ctx });
  if (sent.status === "dry_run" || (sent.status === "already" && sent.result === "dry_run") || (sent.status === "scheduled" && sent.mode === "dry_run")) {
    const r = await changeEnrollment(enr.id, (e) => (e.step_n === enr.step_n ? { ...e, pending: { n: enr.step_n, kind: "hand", ...(sent.outbox_id ? { outbox_id: sent.outbox_id } : {}), text: sent.text, at: nowIso() } } : null), ctx, { env });
    return { next: { kind: "hand", n: enr.step_n, text: sent.text, outbox_id: sent.outbox_id || null, ...(contact ? { sms_href: smsHref(primaryPhone(contact), sent.text) } : {}) }, enrollment: r.data };
  }
  if (sent.status === "blocked" || sent.status === "skipped") {
    const reason = sent.blocked_reason || sent.reason || "blocked";
    if (reason === "opted_out") {
      const r = await changeEnrollment(enr.id, (e, c, en) => setStatus(noteStep(e, e.step_n, { action: "text_blocked", reason, by, touch: false }, en), "stopped", { reason: "opted_out", now: en.now }), ctx, { env });
      return { next: { kind: "blocked", reason }, enrollment: r.data };
    }
    const r = await changeEnrollment(enr.id, (e, c, en) => logStep(e, c, enr.step_n, { action: "text_blocked", reason, by, cid: `${callId}-t` }, en), ctx, { env });
    return { next: { kind: "blocked", reason }, enrollment: r.data };
  }
  // sent (test/live), scheduled for after quiet hours, or already sent before
  const effects = await stepEffects(enr, step, ctx);
  const r = await changeEnrollment(enr.id, (e, c, en) => logStep(e, c, enr.step_n, {
    action: "text", by, cid: `${callId}-t`, ...(sent.outbox_id ? { outbox_id: sent.outbox_id } : {}), ...(sent.provider_id ? { message_id: sent.provider_id } : {}),
    ...(sent.status === "scheduled" ? { send_at: sent.send_at } : {}), ...effects,
  }, en), ctx, { env });
  return { next: { kind: "sent", status: sent.status, ...(sent.send_at ? { send_at: sent.send_at } : {}) }, enrollment: r.data };
}

// ------------------------------------------------------------ POST /calls

// body: { contact_id, direction: "out" | "in", outcome, double_dial?, note?, enrollment_id?, client_id? }
// → { call, enrollment?, enrollments?, next, task? }
export async function logCall(body = {}, ctx) {
  const direction = body.direction === "in" ? "in" : "out";
  const outcome = direction === "in" ? (body.outcome || "spoke") : body.outcome;
  if (!CALL_OUTCOMES.includes(outcome)) throw new InputError("Pick how the call went.", "outcome");
  if (direction === "in" && outcome === "calling") throw new InputError("Pick how the call went.", "outcome");
  const contact = await contactOf(body.contact_id, ctx);
  if (!contact) throw new NotFoundError("That contact isn't there.");
  const note = String(body.note || "").trim().slice(0, MAX_NOTE);
  const doubleDial = body.double_dial === true;
  const clientId = typeof body.client_id === "string" && CLIENT_ID.test(body.client_id) ? body.client_id.toLowerCase() : null;
  const callId = clientId ? deriveId("event", `call:${clientId}`) : newId("event");
  const user = ctx.user || null;
  const by = W(ctx).by;
  const env = await loadEnv();

  let enr = null;
  if (body.enrollment_id) {
    if (!isId(body.enrollment_id, "enrollment")) throw new NotFoundError("That follow-up isn't there.");
    const got = await getRecord("enrollment", body.enrollment_id);
    if (!got || got.data.contact_id !== contact.id) throw new NotFoundError("That follow-up isn't there.");
    enr = got.data;
  }

  if (outcome === "calling") {
    const until = await setCalling(contact.id, env.sales.calling_minutes, ctx);
    return { data: { call: { outcome, calling_until: until, contact_id: contact.id } } };
  }

  // the person and the timeline
  await Promise.all([
    updateStats(contact.id, "sales", (p) => (direction === "in"
      ? { ...p, last_inbound_call_at: nowIso() }
      : { ...p, last_called_at: nowIso(), last_touch_at: nowIso(), calling_until: null }), W(ctx)),
    addActivity(contact.id, direction === "in" ? "call.in" : `call.${outcome}`, enr ? enr.id : contact.id, now()),
  ]);
  const entry = { action: "call", outcome, ...(doubleDial ? { double_dial: true } : {}), ...(note ? { note: note.slice(0, 200) } : {}), by, cid: callId };
  const out = { call: { id: callId, at: nowIso(), direction, outcome, double_dial: doubleDial, contact_id: contact.id }, next: { kind: "none" } };

  if (direction === "in") {
    const res = await inboundOnEnrollments(contact, "inbound_call", { note, ctx, env, by });
    out.enrollments = res.enrollments;
    if (res.task) out.task = res.task;
  } else if (enr) {
    const cadence = await cadenceById(enr.cadence_id);
    const step = stepOf(cadence, enr.step_n);
    const res = await outcomeOnEnrollment(enr, cadence, step, { outcome, entry, contact, user, ctx, env, callId, note });
    out.enrollment = res.enrollment ? enrollmentView(res.enrollment) : null;
    out.next = res.next || out.next;
    if (res.task) out.task = res.task;
  } else if (["spoke", "booked", "not_interested", "wrong_number"].includes(outcome)) {
    // a call logged on the contact itself: it decides for every open follow-up of theirs
    const res = [];
    for (const e of await openEnrollmentsOf(contact.id)) {
      const cadence = await cadenceById(e.cadence_id);
      const r = await outcomeOnEnrollment(e, cadence, stepOf(cadence, e.step_n), { outcome, entry: { ...entry, cid: `${callId}-${e.id.slice(-6)}` }, contact, user, ctx, env, callId, note, noTask: res.length > 0 });
      res.push(r);
    }
    out.enrollments = res.map((r) => r.enrollment && enrollmentView(r.enrollment)).filter(Boolean);
    if (!res.length) await outcomeOnContact(contact, outcome, { note, ctx, out, user });
    const t = res.find((r) => r.task);
    if (t) out.task = t.task;
  }
  if (outcome === "wrong_number" && direction === "out") await flagWrongNumber(contact, ctx);

  await emit("call.logged", { id: callId, wv: 1, contact_id: contact.id, direction, outcome, ...(enr ? { enrollment_id: enr.id } : {}) }, W(ctx))
    .catch((e) => console.error(`crm:sales: call.logged not queued (${safeErr(e)})`));
  return { data: out };
}

// An outbound call's outcome on one enrollment.
async function outcomeOnEnrollment(enr, cadence, step, { outcome, entry, contact, user, ctx, env, callId, note, noTask = false }) {
  const n = enr.step_n;
  if (["no_answer", "voicemail"].includes(outcome)) {
    if (enr.status !== "active" || !step) {
      const r = await changeEnrollment(enr.id, (e, c, en) => noteStep(e, e.step_n, entry, en), ctx, { env });
      return { enrollment: r.data, next: { kind: "none" } };
    }
    if (textsOn(step)) {
      // the call itself first (once), then its text
      const r = await changeEnrollment(enr.id, (e, c, en) => (e.step_n === n ? noteStep(e, n, entry, en) : null), ctx, { env });
      return textAfterCall(r.data || enr, step, { callId, user, ctx, env, contact });
    }
    const r = await changeEnrollment(enr.id, (e, c, en) => logStep(e, c, n, entry, en), ctx, { env });
    return { enrollment: r.data, next: { kind: "none" } };
  }
  if (outcome === "spoke") {
    const r = await changeEnrollment(enr.id, (e, c, en) => {
      const noted = noteStep(e, e.step_n, entry, en);
      return noted ? (setStatus(noted, "paused", { reason: "spoke", now: en.now }) || noted) : null;
    }, ctx, { env, action: "pause" });
    const task = noTask ? null : (await followUpTask(contact, {
      title: `Follow up after call: ${nameOf(contact)}`, kind: "follow_up", due_at: tomorrowAt("10:00"), notes: note,
      assignee_ids: user && isId(user.id, "user") ? [user.id] : (enr.owner_id ? [enr.owner_id] : []), enrollment_id: enr.id, deal_id: enr.deal_id,
      seed: `${callId}--followup`, dedupe: false,
    }, ctx)).task;
    return { enrollment: r.data, task, next: { kind: "none" } };
  }
  if (outcome === "booked") {
    const r = await changeEnrollment(enr.id, (e, c, en) => setStatus(noteStep(e, e.step_n, entry, en) || e, "completed", { reason: "booked", now: en.now }), ctx, { env, action: "complete" });
    return { enrollment: r.data, next: { kind: "none" } };
  }
  if (outcome === "not_interested") {
    const r = await changeEnrollment(enr.id, (e, c, en) => setStatus(noteStep(e, e.step_n, entry, en) || e, "stopped", { reason: "lost", now: en.now }), ctx, { env, action: "stop" });
    if (enr.deal_id) await markDeal(enr.deal_id, "lost", { reason: "other", note: note || "Not interested (call)." }, ctx).catch(() => {});
    return { enrollment: r.data, next: { kind: "none" } };
  }
  if (outcome === "wrong_number") {
    const r = await changeEnrollment(enr.id, (e, c, en) => setStatus(noteStep(e, e.step_n, entry, en) || e, "stopped", { reason: "wrong_number", now: en.now }), ctx, { env, action: "stop" });
    return { enrollment: r.data, next: { kind: "none" } };
  }
  return { enrollment: enr, next: { kind: "none" } };
}

// A call on a contact with no open follow-up.
async function outcomeOnContact(contact, outcome, { note, ctx, out, user }) {
  if (outcome === "spoke" && note) {
    out.task = (await followUpTask(contact, { title: `Follow up after call: ${nameOf(contact)}`, kind: "follow_up", due_at: tomorrowAt("10:00"), notes: note, assignee_ids: user && isId(user.id, "user") ? [user.id] : [], dedupe: false }, ctx)).task;
  }
  if (outcome === "not_interested") {
    const { openDealOf } = await import("./deals.mjs");
    const d = await openDealOf(contact.id);
    if (d) await markDeal(d.id, "lost", { reason: "other", note: note || "Not interested (call)." }, ctx).catch(() => {});
  }
}

// An inbound call or a reply: each open enrollment follows its cadence's
// on_reply (pause, or stop), and one task asks someone to get back to them.
export async function inboundOnEnrollments(contact, reason, { note = "", ctx = {}, env, by, kind = "call" } = {}) {
  const e2 = env || await loadEnv();
  const changed = [];
  for (const e of await openEnrollmentsOf(contact.id)) {
    const cadence = await cadenceById(e.cadence_id);
    const stop = cadence && cadence.on_reply === "stop";
    const r = await changeEnrollment(e.id, (x, c, en) => {
      const noted = noteStep(x, x.step_n, { action: reason === "inbound_call" ? "inbound_call" : "reply", by: by || W(ctx).by, touch: false, ...(note ? { note: note.slice(0, 200) } : {}) }, en);
      if (!noted) return null;
      if (x.status === "paused" && !stop) return null;     // already waiting for a person
      return setStatus(noted, stop ? "stopped" : "paused", { reason, now: en.now }) || noted;
    }, ctx, { env: e2, action: stop ? "stop" : "pause" });
    if (r.changed || r.would) changed.push(r.data);
  }
  let task = null;
  if (changed.length) {
    const people = await leadPeople(contact);
    const title = kind === "call" ? `Called in: ${nameOf(contact)}` : `Reply from ${firstNameOf(contact)}: ${nameOf(contact)}`;
    task = (await followUpTask(contact, {
      title, kind: kind === "call" ? "call" : "follow_up", notes: note, assignee_ids: people.slice(0, 3),
      ...(changed[0] ? { enrollment_id: changed[0].id, deal_id: changed[0].deal_id } : {}),
    }, ctx)).task;
  }
  return { enrollments: changed.map(enrollmentView), task };
}

// A wrong number: that phone is flagged and no longer texted (a person's call log).
async function flagWrongNumber(contact, ctx) {
  const phone = primaryPhone(contact);
  if (!phone) return;
  await updateRecord("contact", contact.id, (c) => {
    if (c.merged_into || c.merging_into) return null;
    let hit = false;
    const phones = (c.phones || []).map((p) => {
      if (p.e164 !== phone || (p.flag === "wrong_number" && p.sms === false)) return p;
      hit = true;
      return { ...p, sms: false, flag: "wrong_number" };
    });
    return hit ? { ...c, phones } : null;
  }, W(ctx)).catch((e) => console.error(`crm:sales: wrong number not flagged (${safeErr(e)})`));
}

// ------------------------------------------------------------ the hand-sent text and the compose sheet

// POST /cadence-steps/:enrollmentId/:n/sent-by-hand { how }: the person sent
// the step's text themselves (pasted into Rotor's inbox, or Messages).
export async function sentByHand(enrollmentId, n, how, ctx) {
  const via = how === "sms_link" ? "sms_link" : "copy";
  const got = await getRecord("enrollment", enrollmentId);
  if (!got) throw new NotFoundError("That follow-up isn't there.");
  const e0 = got.data;
  const done = (e0.history || []).some((h) => h.n === n && h.action === "text" && h.sent_by_hand);
  if (done) return { data: { enrollment: enrollmentView(e0), already: true } };
  if (!isOpen(e0) || e0.step_n !== n) throw new ConflictError("That step has moved on. Pull to refresh.");
  const cadence = await cadenceById(e0.cadence_id);
  const step = stepOf(cadence, n);
  const effects = await stepEffects(e0, step, ctx);
  const r = await changeEnrollment(enrollmentId, (e, c, en) => {
    if (e.step_n !== n) return null;
    return logStep(e, c, n, { action: "text", sent_by_hand: via, ...(e.pending && e.pending.outbox_id ? { outbox_id: e.pending.outbox_id } : {}), by: W(ctx).by, ...effects }, en);
  }, ctx);
  await addActivity(e0.contact_id, "cadence.text_by_hand", enrollmentId, now()).catch(() => {});
  await updateStats(e0.contact_id, "sales", (p) => ({ ...p, last_touch_at: nowIso() }), W(ctx)).catch(() => {});
  return { data: { enrollment: enrollmentView(r.data) } };
}

// POST /cadence-steps/:enrollmentId/:n/send { body?, hand? }: the compose
// sheet's Send (a review-before-send step), or a text-only step's Send.
// While texting is dry-run the edited words land in the Outbox; with
// `hand` the person also says they sent them by hand, and the step moves on.
export async function sendStep(enrollmentId, n, { body, hand } = {}, ctx) {
  const got = await getRecord("enrollment", enrollmentId);
  if (!got) throw new NotFoundError("That follow-up isn't there.");
  const e0 = got.data;
  if (!isOpen(e0) || e0.step_n !== n) throw new ConflictError("That step has moved on. Pull to refresh.");
  const cadence = await cadenceById(e0.cadence_id);
  const step = stepOf(cadence, n);
  if (!textsOn(step)) throw new ConflictError("That step doesn't send a text.");
  const words = typeof body === "string" && body.trim() ? body.trim().slice(0, 1600) : null;
  const contact = await contactOf(e0.contact_id, ctx);
  const env = await loadEnv();
  const sent = await sendStepText(e0, step, { body: words, user: ctx.user || null, ctx });
  const by = W(ctx).by;
  const dry = sent.status === "dry_run" || (sent.status === "already" && sent.result === "dry_run") || (sent.status === "scheduled" && sent.mode === "dry_run");
  if (sent.status === "blocked" || sent.status === "skipped") {
    return { data: { enrollment: enrollmentView(e0), next: { kind: "blocked", reason: sent.blocked_reason || sent.reason || "blocked" } } };
  }
  if (dry && !hand) {
    const r = await changeEnrollment(enrollmentId, (e) => (e.step_n === n ? { ...e, pending: { n, kind: "hand", ...(sent.outbox_id ? { outbox_id: sent.outbox_id } : {}), text: sent.text, at: nowIso() } } : null), ctx, { env });
    return { data: { enrollment: enrollmentView(r.data), next: { kind: "hand", n, text: sent.text, outbox_id: sent.outbox_id || null, ...(contact ? { sms_href: smsHref(primaryPhone(contact), sent.text) } : {}) } } };
  }
  const effects = await stepEffects(e0, step, ctx);
  const r = await changeEnrollment(enrollmentId, (e, c, en) => (e.step_n === n ? logStep(e, c, n, {
    action: "text", by, ...(sent.outbox_id ? { outbox_id: sent.outbox_id } : {}), ...(words ? { edited: true } : {}), ...(dry ? { sent_by_hand: hand === "sms_link" ? "sms_link" : "copy" } : {}),
    ...(sent.status === "scheduled" ? { send_at: sent.send_at } : {}), ...effects,
  }, en) : null), ctx, { env });
  if (dry) await addActivity(e0.contact_id, "cadence.text_by_hand", enrollmentId, now()).catch(() => {});
  await updateStats(e0.contact_id, "sales", (p) => ({ ...p, last_touch_at: nowIso() }), W(ctx)).catch(() => {});
  return { data: { enrollment: enrollmentView(r.data), next: { kind: "sent", status: sent.status } } };
}

// ------------------------------------------------------------ the call list

const SHARD = () => contactShard("ct_00000000000000000000");
const e164 = (digits) => (digits && /^\d{10}$/.test(digits) ? `+1${digits}` : null);

// The rows of the call list (pure): each open enrollment with its contact's
// phone and name from the contacts index, grouped by when it is due.
export function buildCallList({ rows, contacts, cadences, now: t, date, env }) {
  const byContact = new Map(contacts.map((r) => [r.id, r]));
  const byCad = new Map(cadences.map((c) => [c.k, c]));
  const today = localDate(t);
  const day = date || today;
  const out = { due: [], later: [], upcoming: [], paused: [] };
  for (const r of rows) {
    const c = byContact.get(r.c) || {};
    const cad = byCad.get(r.cad) || {};
    const row = {
      id: r.id, contact_id: r.c, name: c.n || r.cn || "No name", phone: e164((c.p || [])[0]), town: c.c || "", cadence: cad.n || r.cad, cadence_key: r.cad,
      n: r.n, label: r.lbl, action: r.act, rbs: !!r.rbs, due: r.due, due_end: r.de, status: r.st, pending: r.pd || null, started_at: r.sa, last_touch_at: r.lt,
      paused_at: r.ps, paused_reason: r.pr, deal_id: r.dl,
    };
    row.overdue = r.st === "active" && isOverdue(r, t);
    if (r.st === "paused") { out.paused.push(row); continue; }
    if (r.pd) { out.due.push(row); continue; }
    if (!r.due) { out.due.push(row); continue; }
    const dueDay = localDate(r.due);
    if (Date.parse(r.due) <= t.getTime() || dueDay < day) out.due.push(row);
    else if (dueDay === day) out.later.push(row);
    else out.upcoming.push(row);
  }
  const byDue = (a, b) => String(a.due || "").localeCompare(String(b.due || "")) || String(a.started_at || "").localeCompare(String(b.started_at || ""));
  out.due.sort((a, b) => (b.overdue - a.overdue) || byDue(a, b));
  out.later.sort(byDue);
  out.upcoming.sort(byDue);
  out.paused.sort((a, b) => String(a.paused_at || "").localeCompare(String(b.paused_at || "")));
  return out;
}

async function smsMode() {
  try { const a = await adapter("sms", {}); return a.mode; } catch { return "dry_run"; }
}

// GET /calls/list?date= → { now, date, sms_mode, due, later, upcoming, paused, attention, counts }
export async function callList({ date } = {}) {
  const t = now();
  const [ix, cx, cads, env, mode] = await Promise.all([readIndex("enrollments/active", ""), readIndex("contacts", SHARD()), readIndex("cadences", ""), loadEnv(t), smsMode()]);
  const list = buildCallList({ rows: ix.rows, contacts: cx.rows, cadences: cads.rows, now: t, date, env });
  const att = attentionFrom({ rows: ix.rows, contacts: cx.rows, env, now: t });
  return {
    now: t.toISOString(), date: date || localDate(t), sms_mode: mode, ...list, attention: att.items,
    counts: { due: list.due.length, overdue: list.due.filter((r) => r.overdue).length, later: list.later.length, upcoming: list.upcoming.length, paused: list.paused.length, attention: att.count },
    stale: ix.stale,
  };
}

// ------------------------------------------------------------ needs attention

// The seeded cadences' windows: "overdue by more than a window" counts these.
const DEFAULT_WINDOWS = Object.freeze([{ start: "09:00", end: "10:00" }, { start: "12:00", end: "13:00" }, { start: "16:00", end: "17:00" }]);

// Open leads with no call, text or email in 24 h (cfg/sales.attention_hours),
// enrollments paused more than 2 days, steps overdue by more than a window.
// Pure over the index rows. → { count, items: [{ contact_id, name, reasons, enrollment_id }] }
export function attentionFrom({ rows, contacts = [], env, now: t }) {
  const s = env.sales || {};
  const hoursMs = (s.attention_hours || 24) * 3600000;
  const pausedMs = (s.paused_attention_days || 2) * 86400000;
  const byContact = new Map(contacts.map((r) => [r.id, r]));
  const items = new Map();
  const add = (r, reason) => {
    const c = byContact.get(r.c) || {};
    const it = items.get(r.c) || { contact_id: r.c, name: c.n || r.cn || "No name", reasons: [], enrollment_id: r.id, owner_id: r.ow || null };
    if (!it.reasons.includes(reason)) it.reasons.push(reason);
    items.set(r.c, it);
  };
  for (const r of rows) {
    const touched = Date.parse(r.lt || r.sa || 0);
    if (r.st === "active" && Number.isFinite(touched) && t.getTime() - touched > hoursMs) add(r, "untouched");
    if (r.st === "paused" && r.ps && t.getTime() - Date.parse(r.ps) > pausedMs) add(r, "paused");
    if (r.st === "active" && r.de && Date.parse(r.de) <= t.getTime() && windowsMissed(r.de, t, DEFAULT_WINDOWS, env) >= 1) add(r, "overdue");
  }
  const list = [...items.values()];
  return { count: list.length, items: list.slice(0, 100) };
}
export const ATTENTION_KEY = "ix/sales-attention";

// GET /attention: computed now (and kept for the badge count).
export async function attention() {
  const t = now();
  const [ix, cx, env] = await Promise.all([readIndex("enrollments/active", ""), readIndex("contacts", SHARD()), loadEnv(t)]);
  return attentionFrom({ rows: ix.rows, contacts: cx.rows, env, now: t });
}

// The Today card and the badge: due now, overdue, needs attention (two index reads).
export async function callSummary() {
  const t = now();
  const [ix, env] = await Promise.all([readIndex("enrollments/active", ""), loadEnv(t)]);
  let due = 0, overdue = 0;
  for (const r of ix.rows) {
    if (r.st !== "active") continue;
    if (r.pd || !r.due || Date.parse(r.due) <= t.getTime()) due += 1;
    if (isOverdue(r, t)) overdue += 1;
  }
  const att = attentionFrom({ rows: ix.rows, env, now: t });
  return { due, overdue, attention: att.count, active: ix.rows.filter((r) => r.st === "active").length, paused: ix.rows.filter((r) => r.st === "paused").length };
}

export { addLocalDays, touchDeal, windowsOf };
