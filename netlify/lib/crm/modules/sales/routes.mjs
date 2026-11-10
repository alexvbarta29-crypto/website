// Sales module: the API (design §5.2 "Endpoints", §4.5).
//
// sales:work (owners and the office): the call list, calls, follow-ups and
// deals. tasks:read / tasks:write: owners and the office see every task; a
// technician holds them as "own": the tasks assigned to them (the list of
// their own tasks, one of theirs, marking it done), and sees a task's
// contact only when that contact has a visit of theirs in the window (§4.6).
// cadences:configure: Settings → Cadences. List routes need the unscoped
// permission (subject "none"); techs get 403 there.

import { getRecord, getRecords, createRecord, updateRecord, readIndex } from "../../../crm-store.mjs";
import { deriveId, isId } from "../../core/ids.mjs";
import { nowIso, now } from "../../core/clock.mjs";
import { InputError, NotFoundError, ConflictError, ExistsError, ForbiddenError, BlobsTransientError, BudgetError, TimeoutError, UnknownOutcome } from "../../core/errors.mjs";
import { techVisibleContacts, techView } from "../../core/perms.mjs";
import { fail } from "../../core/http.mjs";
import { withDefaults } from "../../core/stats.mjs";
import { DEAL_STATUSES, LOST_REASONS, OPEN_TASK, TASK_KINDS } from "./types.mjs";
import { stepFor, logStep, noteStep, setStatus, isOpen, smsHref } from "./cadence.mjs";
import {
  enroll, changeEnrollment, pauseEnrollment, resumeEnrollment, stopEnrollment, cadenceById, enrollmentsOf, previewStep, enrollmentView,
} from "./enroll.mjs";
import { markDeal, dealFor } from "./deals.mjs";
import { logCall, sentByHand, sendStep, callList, callSummary, attention, smsMode, textWindow } from "./calls.mjs";
import { keepAttention } from "./automations.mjs";
import { createTask, cleanTaskInput, completeTask } from "./tasks.mjs";
import { contactOf, nameOf, primaryPhone, relRecords, W, loadEnv } from "./common.mjs";

const str = (v) => (v == null ? "" : String(v)).trim();
const view = (r) => { if (!r) return r; const { _w, _etag, ...rest } = r; return rest; };
const CLIENT_ID = /^[A-Za-z0-9-]{8,64}$/;
const clientId = (b) => (typeof b.client_id === "string" && CLIENT_ID.test(b.client_id) ? b.client_id.toLowerCase() : null);

async function record(type, id, what) {
  if (!isId(id, type)) throw new NotFoundError(`That ${what} isn't there.`);
  const got = await getRecord(type, id);
  if (!got || got.data.deleted_at) throw new NotFoundError(`That ${what} isn't there.`);
  return got;
}

// ------------------------------------------------------------ the call list

const callListRoute = async (ctx) => {
  const date = str(ctx.query.get("date")) || undefined;
  const data = await callList({ date });
  await keepAttention({ count: data.counts.attention, items: data.attention }).catch(() => {});
  return { data };
};
const summaryRoute = async () => ({ data: await callSummary() });
const attentionRoute = async () => {
  const a = await attention();
  await keepAttention(a).catch(() => {});
  return { data: a };
};

const callsRoute = async (ctx) => logCall(ctx.body || {}, ctx);

const stepN = (ctx) => {
  const n = Number(ctx.params.n);
  if (!Number.isSafeInteger(n) || n < 1 || n > 100) throw new NotFoundError("That step isn't there.");
  return n;
};
const sentByHandRoute = async (ctx) => {
  await record("enrollment", ctx.params.id, "follow-up");
  return sentByHand(ctx.params.id, stepN(ctx), (ctx.body || {}).how, ctx);
};
const sendStepRoute = async (ctx) => {
  await record("enrollment", ctx.params.id, "follow-up");
  const b = ctx.body || {};
  if (b.body !== undefined && typeof b.body !== "string") throw new InputError("Write the text.", "body");
  if (typeof b.body === "string" && b.body.length > 1600) throw new InputError("Keep a text under 1,600 characters.", "body");
  return sendStep(ctx.params.id, stepN(ctx), { body: b.body, hand: b.hand === "sms_link" ? "sms_link" : b.hand === "copy" ? "copy" : undefined }, ctx);
};

// ------------------------------------------------------------ deals

const dealsRoute = async (ctx) => {
  const status = str(ctx.query.get("status"));
  const contact = str(ctx.query.get("contact"));
  if (contact) {
    if (!isId(contact, "contact")) throw new InputError("That isn't a contact.", "contact");
    const list = await relRecords("contact-deals", "deal", contact, { limit: 30 });
    return { data: list.filter((d) => !status || d.status === status).map(view) };
  }
  const ix = await readIndex("deals/open", "");
  return { data: ix.rows.filter((r) => !status || r.st === status).sort((a, b) => String(b.op || "").localeCompare(String(a.op || ""))), meta: { total: ix.rows.length, stale: ix.stale } };
};

const dealRoute = async (ctx) => {
  const got = await record("deal", ctx.params.id, "deal");
  const [contact, list, cads] = await Promise.all([contactOf(got.data.contact_id, ctx), enrollmentsOf(got.data.contact_id), readIndex("cadences", "")]);
  const cadName = new Map(cads.rows.map((r) => [r.id, r.n]));
  const enrollments = list.filter((e) => e.deal_id === got.data.id).map((e) => ({ ...view(e), cadence_name: cadName.get(e.cadence_id) || e.cadence_key }));
  return { data: { deal: view(got.data), contact: contact ? { id: contact.id, name: nameOf(contact), phone: primaryPhone(contact), lifecycle: contact.lifecycle } : null, enrollments }, etag: got.etag };
};

const DEAL_EDITABLE = ["title", "services", "value_cents", "owner_id", "property_id", "lost_note"];
const patchDealRoute = async (ctx) => {
  if (!ctx.ifMatch) throw new InputError("This change needs the version you edited (If-Match).", "if-match");
  const b = ctx.body || {};
  const patch = {};
  for (const k of DEAL_EDITABLE) if (b[k] !== undefined) patch[k] = b[k] === "" ? undefined : b[k];
  if (b.status !== undefined && !DEAL_STATUSES.includes(b.status)) throw new InputError("Pick open, quoted, won, lost or abandoned.", "status");
  if (b.lost_reason !== undefined && b.lost_reason !== null && !LOST_REASONS.includes(b.lost_reason)) throw new InputError("Pick why it was lost.", "lost_reason");
  await record("deal", ctx.params.id, "deal");
  const r = await updateRecord("deal", ctx.params.id, (d) => {
    let next = { ...d, ...patch };
    for (const k of Object.keys(patch)) if (patch[k] === undefined) delete next[k];
    if (b.status && b.status !== d.status) next = dealFor(next, b.status, { reason: b.lost_reason || d.lost_reason, note: b.lost_note, force: true }) || next;
    return next;
  }, { ...ctx.write(), ifMatch: ctx.ifMatch });
  return { data: { deal: view(r.data) }, etag: r.etag };
};

const loseDealRoute = async (ctx) => {
  const b = ctx.body || {};
  if (!LOST_REASONS.includes(b.reason)) throw new InputError("Pick why it was lost.", "reason");
  await record("deal", ctx.params.id, "deal");
  const r = await markDeal(ctx.params.id, "lost", { reason: b.reason, note: str(b.note).slice(0, 500), force: true }, ctx);
  return { data: { deal: view(r.deal) } };
};

// ------------------------------------------------------------ enrollments

const enrollmentsRoute = async (ctx) => {
  const status = str(ctx.query.get("status"));
  const cadence = str(ctx.query.get("cadence"));
  const contact = str(ctx.query.get("contact"));
  if (contact) {
    if (!isId(contact, "contact")) throw new InputError("That isn't a contact.", "contact");
    const list = await enrollmentsOf(contact);
    return { data: list.filter((e) => (!status || e.status === status) && (!cadence || e.cadence_key === cadence)).map(view) };
  }
  if (status && !["active", "paused"].includes(status)) throw new InputError("The list holds open follow-ups; open a contact for the rest.", "status");
  const ix = await readIndex("enrollments/active", "");
  return { data: ix.rows.filter((r) => (!status || r.st === status) && (!cadence || r.cad === cadence)), meta: { total: ix.rows.length, stale: ix.stale } };
};

async function enrollmentDetail(id, ctx) {
  const got = await record("enrollment", id, "follow-up");
  const e = got.data;
  const [cadence, contact, mode, win] = await Promise.all([cadenceById(e.cadence_id), contactOf(e.contact_id, ctx), smsMode(), textWindow()]);
  const step = stepFor(cadence, e);
  // past the sender's hours: a waiting text waits for the morning (shown, not stored)
  if (e.pending && !win.ok && win.until && mode !== "live" && mode !== "test" && !(e.pending.hold_until && Date.parse(e.pending.hold_until) > now().getTime())) e.pending = { ...e.pending, hold_until: win.until };
  let preview = null;
  if (isOpen(e) && step && step.template_key) {
    const p = e.pending && e.pending.text ? { text: e.pending.text } : await previewStep(e, step, { sender: ctx.user });
    preview = { text: p.text, ...(contact ? { sms_href: smsHref(primaryPhone(contact), p.text) } : {}) };
  }
  return {
    data: {
      enrollment: view(e), preview, sms_mode: mode,
      cadence: cadence ? { id: cadence.id, key: cadence.key, name: cadence.name, steps: cadence.steps, on_reply: cadence.on_reply, unattended: cadence.unattended } : null,
      contact: contact ? { id: contact.id, name: nameOf(contact), phone: primaryPhone(contact), lifecycle: contact.lifecycle } : null,
    },
    etag: got.etag,
  };
}
const enrollmentRoute = (ctx) => enrollmentDetail(ctx.params.id, ctx);

const enrollRoute = async (ctx) => {
  const b = ctx.body || {};
  if (!isId(b.contact_id, "contact")) throw new InputError("Pick a contact.", "contact_id");
  if (!/^[a-z][a-z0-9_]{1,39}$/.test(str(b.cadence_key))) throw new InputError("Pick a cadence.", "cadence_key");
  await ctx.sysMode();
  const id = await enroll(b.contact_id, str(b.cadence_key), { quote_id: isId(b.quote_id, "quote") ? b.quote_id : undefined }, ctx);
  if (!id) throw new ConflictError("That cadence can't take this contact (it is off, a board only, or the contact is archived).");
  const out = await enrollmentDetail(id, ctx);
  return { status: 201, ...out };
};

const enrollmentAction = (fn) => async (ctx) => {
  await record("enrollment", ctx.params.id, "follow-up");
  const r = await fn(ctx.params.id, ctx);
  if (r && r.would) return fail("parallel_run", "Rotor is still in charge of this follow-up.", 409);
  return enrollmentDetail(ctx.params.id, ctx);
};
const pauseRoute = enrollmentAction((id, ctx) => pauseEnrollment(id, "manual", ctx));
const resumeRoute = enrollmentAction((id, ctx) => resumeEnrollment(id, ctx));
const stopRoute = enrollmentAction((id, ctx) => stopEnrollment(id, "manual", ctx));
// The current step done by hand (a call made outside the list, a text sent elsewhere).
const advanceRoute = enrollmentAction((id, ctx) => changeEnrollment(id, (e, c, env) => logStep(e, c, e.step_n, { action: "done_by_hand", by: W(ctx).by }, env), ctx, { action: "advance" }));
// The current step skipped (no call, no text).
const skipRoute = enrollmentAction((id, ctx) => changeEnrollment(id, (e, c, env) => logStep(e, c, e.step_n, { action: "skipped", by: W(ctx).by, touch: false }, env), ctx, { action: "skip" }));

export const BULK_RESUME_MAX = 15;
const bulkResumeRoute = async (ctx) => {
  const list = Array.isArray((ctx.body || {}).ids) ? ctx.body.ids : [];
  if (!list.length) throw new InputError("Pick the follow-ups to resume.", "ids");
  if (list.length > BULK_RESUME_MAX) throw new InputError(`Resume at most ${BULK_RESUME_MAX} at a time.`, "ids");
  if (list.some((x) => !isId(x, "enrollment"))) throw new InputError("That isn't a follow-up.", "ids");
  let resumed = 0;
  const skipped = [];
  const failed = [];
  const env = await loadEnv();
  const cadences = new Map();
  for (const id of [...new Set(list)]) {
    try {
      const r = await resumeEnrollment(id, ctx, { env, cadences });
      if (r.changed) resumed += 1; else skipped.push(id);
    } catch (e) {
      if (e instanceof NotFoundError) { skipped.push(id); continue; }
      // one follow-up that can't resume doesn't stop the others; storage trouble does
      if (e instanceof BlobsTransientError || e instanceof BudgetError || e instanceof TimeoutError || e instanceof UnknownOutcome) throw e;
      console.error(`crm:sales: a follow-up did not resume (${(e && (e.code || e.name)) || "error"})`);
      failed.push({ id, error: e instanceof InputError || e instanceof ConflictError ? e.message : "It couldn't resume." });
    }
  }
  return { data: { resumed, skipped, failed } };
};

// ------------------------------------------------------------ cadences

const cadenceView = (c) => view(c);
const cadencesRoute = async () => {
  const ix = await readIndex("cadences", "");
  return { data: ix.rows.map((r) => ({ id: r.id, key: r.k, name: r.n, active: r.act, board_only: r.bo, steps: r.s, unattended: r.ua, entry_on: r.on })).sort((a, b) => Number(b.active) - Number(a.active) || a.name.localeCompare(b.name)) };
};
const cadenceRoute = async (ctx) => {
  const got = await record("cadence", ctx.params.id, "cadence");
  return { data: { cadence: cadenceView(got.data) }, etag: got.etag };
};
const CADENCE_EDITABLE = ["name", "description", "active", "entry", "exit_on", "on_reply", "unattended", "steps", "board_stages"];
const newCadenceRoute = async (ctx) => {
  const b = ctx.body || {};
  const data = { key: str(b.key), board_only: b.board_only === true };
  for (const k of CADENCE_EDITABLE) if (b[k] !== undefined) data[k] = b[k];
  try {
    const r = await createRecord("cadence", { ...data, id: deriveId("cadence", "key", "sales.cadence", data.key) }, ctx.write());
    return { status: 201, data: { cadence: cadenceView(r.data) }, etag: r.etag };
  } catch (e) {
    if (e instanceof ExistsError) throw new ConflictError("A cadence with that key is already there.");
    throw e;
  }
};
const patchCadenceRoute = async (ctx) => {
  if (!ctx.ifMatch) throw new InputError("This change needs the version you edited (If-Match).", "if-match");
  const b = ctx.body || {};
  const patch = {};
  for (const k of CADENCE_EDITABLE) if (b[k] !== undefined) patch[k] = b[k];
  await record("cadence", ctx.params.id, "cadence");
  const r = await updateRecord("cadence", ctx.params.id, (c) => ({ ...c, ...patch }), { ...ctx.write(), ifMatch: ctx.ifMatch });
  return { data: { cadence: cadenceView(r.data) }, etag: r.etag };
};

// ------------------------------------------------------------ tasks

// A tech sees a task's contact only when it is one of their visits' contacts (§4.6).
async function taskFor(ctx, t) {
  if (ctx.can("tasks:read_all") || (ctx.holds("tasks:read") === true)) return view(t);
  const v = techView("task", t);
  if (t.contact_id) {
    const visible = (await techVisibleContacts(ctx.user.id)).has(t.contact_id);
    if (visible) { v.contact_id = t.contact_id; v.contact_name = t.contact_name || ""; }
  }
  return v;
}
const isOwnTask = (ctx, t) => ctx.can("tasks:read", { type: "task", record: t });

const rowView = (r) => ({ id: r.id, title: r.t, kind: r.k, priority: r.pr, status: r.st, due_at: r.due, end_at: r.end, contact_id: r.c, contact_name: r.cn, assignee_ids: r.a || [], reported_on: r.rep, enrollment_id: r.en, updated_at: r.u });

const tasksRoute = async (ctx) => {
  const assignee = str(ctx.query.get("assignee"));
  const kind = str(ctx.query.get("kind"));
  const status = str(ctx.query.get("status"));
  const contact = str(ctx.query.get("contact"));
  if (kind && !TASK_KINDS.includes(kind)) throw new InputError("Pick a kind of task.", "kind");
  if (contact) {
    if (!isId(contact, "contact")) throw new InputError("That isn't a contact.", "contact");
    const list = await relRecords("contact-tasks", "task", contact, { limit: 50 });
    return { data: list.filter((t) => (!kind || t.kind === kind) && (!status || t.status === status)).map(view) };
  }
  const ix = await readIndex("tasks/open", "");
  const me = assignee === "me" ? ctx.user.id : assignee;
  const rows = ix.rows.filter((r) => (!me || (r.a || []).includes(me)) && (!kind || r.k === kind) && (!status || r.st === status));
  return { data: rows.map(rowView), meta: { total: rows.length, stale: ix.stale } };
};

// A person's own open tasks (techs: theirs only, contacts as §4.6 allows).
const myTasksRoute = async (ctx) => {
  const ix = await readIndex("tasks/open", "");
  const rows = ix.rows.filter((r) => (r.a || []).includes(ctx.user.id)).map(rowView);
  if (ctx.holds("tasks:read") === true) return { data: rows };
  const visible = rows.some((r) => r.contact_id) ? await techVisibleContacts(ctx.user.id) : new Set();
  return { data: rows.map((r) => (r.contact_id && visible.has(r.contact_id) ? r : { ...r, contact_id: null, contact_name: "" })) };
};

const taskRoute = async (ctx) => {
  const got = await record("task", ctx.params.id, "task");
  if (!isOwnTask(ctx, got.data)) throw new NotFoundError("That task isn't there.");
  return { data: { task: await taskFor(ctx, got.data) }, etag: got.etag };
};

async function contactNameFor(id) {
  if (!isId(id, "contact")) return undefined;
  const g = await getRecord("contact", id);
  return g ? nameOf(g.data) : undefined;
}

const newTaskRoute = async (ctx) => {
  const b = ctx.body || {};
  const data = cleanTaskInput(b);
  if (!str(data.title)) throw new InputError("Say what needs doing.", "title");
  if (data.contact_id) data.contact_name = await contactNameFor(data.contact_id);
  const cid = clientId(b);
  const t = await createTask({ status: "open", ...data, ...(cid ? { id: deriveId("task", `c:${cid}`) } : {}) }, ctx.write());
  return { status: 201, data: { task: view(t) } };
};

const patchTaskRoute = async (ctx) => {
  const got = await record("task", ctx.params.id, "task");
  if (!isOwnTask(ctx, got.data)) throw new NotFoundError("That task isn't there.");
  const b = ctx.body || {};
  const office = ctx.holds("tasks:write") === true;
  if (!office) {
    // a technician moves their own task along; the office edits the rest
    const status = b.status;
    if (status === undefined || !["open", "in_progress", "waiting", "done"].includes(status)) throw new ForbiddenError("Ask the office to change this task.");
    const r = await updateRecord("task", ctx.params.id, (t) => (t.status === status ? null : { ...t, status, ...(status === "done" ? { done_at: nowIso(), done_by: ctx.user.id } : {}) }), ctx.write());
    return { data: { task: await taskFor(ctx, r.data) } };
  }
  if (!ctx.ifMatch) throw new InputError("This change needs the version you edited (If-Match).", "if-match");
  const patch = cleanTaskInput(b);
  if (patch.contact_id && patch.contact_id !== got.data.contact_id) patch.contact_name = await contactNameFor(patch.contact_id);
  const r = await updateRecord("task", ctx.params.id, (t) => {
    const next = { ...t };
    for (const [k, v] of Object.entries(patch)) { if (v === undefined) delete next[k]; else next[k] = v; }
    if (patch.status === "done" && t.status !== "done") { next.done_at = nowIso(); next.done_by = ctx.user.id; }
    if (patch.status && patch.status !== "done") { delete next.done_at; delete next.done_by; }
    return next;
  }, { ...ctx.write(), ifMatch: ctx.ifMatch });
  return { data: { task: view(r.data) }, etag: r.etag };
};

const doneTaskRoute = async (ctx) => {
  const got = await record("task", ctx.params.id, "task");
  if (!isOwnTask(ctx, got.data)) throw new NotFoundError("That task isn't there.");
  const r = await completeTask(ctx.params.id, ctx);
  return { data: { task: await taskFor(ctx, r.data) } };
};

// "Add an incident" (barta-rules §8): high priority, no due date, reported today.
const incidentRoute = async (ctx) => {
  const b = ctx.body || {};
  const title = str(b.title);
  if (!title) throw new InputError("Say what happened.", "title");
  let contactId;
  if (b.contact_id) {
    if (!isId(b.contact_id, "contact")) throw new InputError("That isn't a contact.", "contact_id");
    const own = ctx.can("contacts:read_all") || (await techVisibleContacts(ctx.user.id)).has(b.contact_id);
    if (!own) throw new NotFoundError("That contact isn't there.");
    contactId = b.contact_id;
  }
  const { approvers } = await import("../../core/notify.mjs");
  const cid = clientId(b);
  const t = await createTask({
    title: `Incident: ${title}`.slice(0, 160), kind: "incident", priority: "high", status: "open", ...(contactId ? { contact_id: contactId, contact_name: await contactNameFor(contactId) } : {}),
    ...(isId(b.visit_id, "visit") ? { visit_id: b.visit_id } : {}), notes: str(b.notes).slice(0, 4000), assignee_ids: (await approvers().catch(() => [])).slice(0, 3),
    ...(cid ? { id: deriveId("task", `c:${cid}`) } : {}),
  }, ctx.write());
  return { status: 201, data: ctx.can("tasks:read_all") || ctx.holds("tasks:read") === true ? { task: view(t) } : { task_id: t.id } };
};

// ------------------------------------------------------------ one contact's sales (the contact tab)

const contactSalesRoute = async (ctx) => {
  const contact = await contactOf(ctx.params.id, ctx);
  if (!contact) throw new NotFoundError("That contact isn't there.");
  const [deals, enrollments, tasks, stats, cads] = await Promise.all([
    relRecords("contact-deals", "deal", contact.id, { limit: 20 }),
    enrollmentsOf(contact.id, { limit: 20 }),
    relRecords("contact-tasks", "task", contact.id, { limit: 20 }),
    getRecord("contact_stats", contact.id),
    readIndex("cadences", ""),
  ]);
  const cadName = new Map(cads.rows.map((r) => [r.id, r.n]));
  const order = (s) => ({ active: 0, paused: 1, completed: 2, stopped: 3, archived: 4 })[s] ?? 5;
  return {
    data: {
      contact: { id: contact.id, name: nameOf(contact), phone: primaryPhone(contact), lifecycle: contact.lifecycle },
      deals: deals.map(view),
      enrollments: enrollments.map((e) => ({ ...view(e), cadence_name: cadName.get(e.cadence_id) || e.cadence_key })).sort((a, b) => order(a.status) - order(b.status) || String(b.started_at).localeCompare(String(a.started_at))),
      tasks: tasks.map(view).sort((a, b) => Number(!OPEN_TASK.includes(a.status)) - Number(!OPEN_TASK.includes(b.status))),
      sales: withDefaults(stats ? stats.data : {}).sales || {},
      cadences: cads.rows.filter((r) => r.act && !r.bo && r.s > 0).map((r) => ({ key: r.k, name: r.n })),
    },
  };
};

// ------------------------------------------------------------ the table

const R = (method, path, perm, subject, handler, extra = {}) => ({ method, path, auth: "session", perm, subject, mode: "inline", handler, ...extra });

export const salesRoutes = [
  R("GET", "/calls/list", "sales:work", "none", callListRoute, { maxCalls: 30 }),
  R("GET", "/calls/summary", "sales:work", "none", summaryRoute),
  R("POST", "/calls", "sales:work", "required", callsRoute, { maxCalls: 90 }),
  R("POST", "/cadence-steps/:id/:n/sent-by-hand", "sales:work", "required", sentByHandRoute, { maxCalls: 60 }),
  R("POST", "/cadence-steps/:id/:n/send", "sales:work", "required", sendStepRoute, { maxCalls: 80 }),
  R("GET", "/attention", "sales:work", "none", attentionRoute),
  R("GET", "/deals", "sales:work", "none", dealsRoute, { maxCalls: 40 }),
  R("GET", "/deals/:id", "sales:work", "required", dealRoute, { maxCalls: 40 }),
  R("PATCH", "/deals/:id", "sales:work", "required", patchDealRoute),
  R("POST", "/deals/:id/lose", "sales:work", "required", loseDealRoute),
  R("GET", "/enrollments", "sales:work", "none", enrollmentsRoute, { maxCalls: 40 }),
  R("POST", "/enrollments", "sales:work", "required", enrollRoute, { maxCalls: 70 }),
  R("POST", "/enrollments/bulk-resume", "sales:work", "none", bulkResumeRoute, { maxCalls: 180, budgetMs: 8000 }),
  R("GET", "/enrollments/:id", "sales:work", "required", enrollmentRoute),
  R("POST", "/enrollments/:id/pause", "sales:work", "required", pauseRoute, { maxCalls: 40 }),
  R("POST", "/enrollments/:id/resume", "sales:work", "required", resumeRoute, { maxCalls: 40 }),
  R("POST", "/enrollments/:id/stop", "sales:work", "required", stopRoute, { maxCalls: 40 }),
  R("POST", "/enrollments/:id/advance", "sales:work", "required", advanceRoute, { maxCalls: 40 }),
  R("POST", "/enrollments/:id/skip", "sales:work", "required", skipRoute, { maxCalls: 40 }),
  R("GET", "/cadences", "sales:work", "none", cadencesRoute),
  R("GET", "/cadences/:id", "sales:work", "required", cadenceRoute),
  R("POST", "/cadences", "cadences:configure", "none", newCadenceRoute),
  R("PATCH", "/cadences/:id", "cadences:configure", "required", patchCadenceRoute),
  R("GET", "/tasks", "tasks:read", "none", tasksRoute, { maxCalls: 60 }),
  R("GET", "/tasks/mine", "tasks:read", "required", myTasksRoute, { maxCalls: 60 }),
  R("GET", "/tasks/:id", "tasks:read", "required", taskRoute),
  R("POST", "/tasks", "tasks:write", "none", newTaskRoute),
  R("PATCH", "/tasks/:id", "tasks:write", "required", patchTaskRoute),
  R("POST", "/tasks/:id/done", "tasks:write", "required", doneTaskRoute),
  R("POST", "/incidents", "incidents:create", "none", incidentRoute, { maxCalls: 60 }),
  R("GET", "/sales/contacts/:id", "sales:work", "required", contactSalesRoute, { maxCalls: 80 }),
];

export { noteStep, setStatus, getRecords, now };
