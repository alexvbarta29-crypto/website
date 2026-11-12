// Core "system" module: the messaging routes every module shares (design
// §5.7.7 "Endpoints, core"):
//
//   GET    /templates[?channel=&category=]        messages:send (techs: active service/personal ones)
//   GET    /templates/:id                         messages:send
//   POST   /templates                             templates:edit      { key, name, channel, category, subject?, body, body_html?, tags?, active? }
//   PATCH  /templates/:id                         templates:edit      If-Match
//   POST   /templates/preview                     messages:send       { template_id | template_key | body..., contact_id?, vars? }
//   GET    /automations                           automations:configure   the catalog, settings, last 7 days
//   PATCH  /automations/:key                      automations:configure   { enabled, channels, template_keys, delay, at_local, ... }
//   POST   /automations/pause · /resume           automations:configure
//   GET    /automations/log?date=&key=            outbox:read         sent, dry-run, skipped and would- rows
//   GET    /notifications · POST /notifications/read    yourself
//   GET    /outbox?date=&contact=&kind=&before=   outbox:read
//   GET    /suppressions?channel=&before= · POST /suppressions  consent:edit  { channel, address, state }
//                                                  (newest first; core/suppressions.mjs, which emits consent.changed)
//   GET/POST /bulk-runs[/:id], POST /bulk-runs/:id/test|confirm|cancel  campaigns:write / campaigns:send
//   POST   /messages                              messages:send       → the messages.sink service
//   GET/POST /push/subscriptions, DELETE /push/subscriptions/:hash, POST /push/test   yourself

import { createRecord, patchRecord, hk } from "../../../crm-store.mjs";
import { InputError, ForbiddenError, NotFoundError } from "../../core/errors.mjs";
import { isId } from "../../core/ids.mjs";
import { nowMs } from "../../core/clock.mjs";
import { maskPhone, maskEmail, keySafe } from "../../core/text.mjs";
import { techView, techVisibleContacts } from "../../core/perms.mjs";
import { call } from "../../core/services.mjs";
import { listTemplates, getTemplate, getTemplateByKey, previewFor, parseTemplate, sanitizeEmailHtml, VARIABLES, CHANNELS } from "../../core/templates.mjs";
import { automationsOverview, patchAutomation, setAutomationsPaused } from "../../core/automations.mjs";
import { listAutomationLog } from "../../core/activity.mjs";
import { listNotifications, markRead, savePushSubscription, listPushSubscriptions, deletePushSubscription, notify } from "../../core/notify.mjs";
import { listOutbox } from "../../core/outbox.mjs";
import { listBulkRuns, getBulkRun, bulkView, createBulkRun, testBulkRun, confirmBulkRun, cancelBulkRun, ensurePreview } from "../../core/bulk.mjs";
import { enqueue } from "../../core/queue.mjs";
import { adapter } from "../../adapters/index.mjs";
import { setSuppression as writeSuppression, listSuppressions, SUP_CHANNELS } from "../../core/suppressions.mjs";
import { localDate, now, isLocalDate } from "../../core/clock.mjs";

const r = (method, path, perm, subject, handler, more = {}) => ({ method, path, auth: "session", perm, subject, mode: "inline", handler, ...more });
const isTech = (ctx) => ctx.user && ctx.user.role === "tech";

// ------------------------------------------------------------ templates

async function templates(ctx) {
  const channel = ctx.query.get("channel") || undefined;
  const category = ctx.query.get("category") || undefined;
  if (channel && !CHANNELS.includes(channel)) throw new InputError("Pick text or email.", "channel");
  let rows = await listTemplates({ channel, category });
  // a tech gets the template's techFields only, as from GET /templates/:id
  if (isTech(ctx)) rows = rows.filter((t) => t.active && ["service", "personal"].includes(t.category)).map((t) => techView("template", t));
  const variables = Object.entries(VARIABLES).map(([name, v]) => ({ name, label: v.label, group: v.group, sample: v.sample }));
  return { data: rows, meta: { variables } };
}

async function template(ctx) {
  const got = await getTemplate(ctx.params.id);
  const t = got.data;
  if (isTech(ctx) && !(t.active !== false && ["service", "personal"].includes(t.category))) throw new NotFoundError("That template isn't there.");
  return { data: isTech(ctx) ? techView("template", t) : t, etag: got.etag };
}

const TEMPLATE_FIELDS = ["key", "name", "channel", "category", "subject", "body", "body_html", "tags", "active"];
const pickFields = (b, fields) => Object.fromEntries(fields.filter((f) => b[f] !== undefined).map((f) => [f, b[f]]));

async function createTemplate(ctx) {
  const b = ctx.body || {};
  if (await getTemplateByKey(String(b.key || "")).then((t) => t && t.id).catch(() => null)) throw new InputError("A template already uses that key.", "key");
  const rec = await createRecord("template", { ...pickFields(b, TEMPLATE_FIELDS), built_in: false }, ctx.write());
  return { status: 201, data: rec.data, etag: rec.etag };
}

async function updateTemplate(ctx) {
  const b = ctx.body || {};
  const patch = pickFields(b, TEMPLATE_FIELDS.filter((f) => f !== "key"));
  const rec = await patchRecord("template", ctx.params.id, patch, { ...ctx.write(), ifMatch: ctx.ifMatch });
  return { data: rec.data, etag: rec.etag };
}

// A preview for the editor: a saved template, or what is being typed (its
// problems come back as warnings, not as an error).
async function preview(ctx) {
  const b = ctx.body || {};
  let t;
  if (b.template_id) t = (await getTemplate(b.template_id)).data;
  else if (b.template_key) { t = await getTemplateByKey(b.template_key); if (!t) throw new NotFoundError("That template isn't there."); }
  else {
    if (!CHANNELS.includes(b.channel)) throw new InputError("Pick text or email.", "channel");
    t = { channel: b.channel, subject: b.subject || "", body: String(b.body || ""), body_html: b.body_html ? sanitizeEmailHtml(b.body_html) : undefined };
  }
  const problems = [...parseTemplate(t.body || "").errors, ...(t.subject ? parseTemplate(t.subject, { field: "subject" }).errors : []), ...(t.body_html ? parseTemplate(t.body_html, { field: "body_html" }).errors : [])];
  // a tech previews only for a contact on their own visits (a preview shows the name and town)
  let contactId = isId(b.contact_id, "contact") ? b.contact_id : undefined;
  if (contactId && isTech(ctx) && !(await techVisibleContacts(ctx.user.id)).has(contactId)) throw new ForbiddenError("You don't have access to that.");
  const p = await previewFor(t, contactId, { extra: b.vars && typeof b.vars === "object" ? b.vars : undefined, sender: ctx.user });
  return { data: { ...p, problems, variables: parseTemplate([t.body, t.subject, t.body_html].filter(Boolean).join("\n")).variables } };
}

// ------------------------------------------------------------ automations

const automations = async () => ({ data: await automationsOverview() });
const patchAuto = async (ctx) => ({ data: await patchAutomation(ctx.params.key, ctx.body, ctx) });
const pauseAll = (paused) => async (ctx) => ({ data: await setAutomationsPaused(paused, ctx) });

async function automationLog(ctx) {
  const date = ctx.query.get("date") || localDate(now());
  if (!isLocalDate(date)) throw new InputError("Use a date like 2026-11-17.", "date");
  const key = ctx.query.get("key") || undefined;
  return { data: await listAutomationLog(date, { key, limit: 500 }) };
}

// ------------------------------------------------------------ notifications

async function notifications(ctx) {
  const before = ctx.query.get("before") || undefined;
  const r2 = await listNotifications(ctx.user.id, { limit: 30, before });
  return { data: r2.items, meta: { next_cursor: r2.next } };
}
async function readNotifications(ctx) {
  const b = ctx.body || {};
  return { data: await markRead(ctx.user.id, { ids: b.ids, all: b.all === true }, ctx.write()) };
}

// ------------------------------------------------------------ outbox

async function outbox(ctx) {
  const contact = ctx.query.get("contact") || undefined;
  const kind = ctx.query.get("kind") || undefined;
  const r2 = await listOutbox({ date: ctx.query.get("date") || undefined, contact_id: contact, kind, before: ctx.query.get("before") || undefined, limit: 30 });
  return { data: r2.items, meta: { next_cursor: r2.next } };
}

// ------------------------------------------------------------ suppressions

async function suppressions(ctx) {
  const channel = ctx.query.get("channel") || "sms";
  if (!SUP_CHANNELS.includes(channel)) throw new InputError("Pick text or email.", "channel");
  const r2 = await listSuppressions(channel, { limit: 40, before: ctx.query.get("before") || undefined });
  return { data: r2.items, meta: { next_cursor: r2.next } };
}

async function setSuppression(ctx) {
  const b = ctx.body || {};
  if (!SUP_CHANNELS.includes(b.channel)) throw new InputError("Pick text or email.", "channel");
  if (!["opted_out", "active"].includes(b.state)) throw new InputError("Opted out or active.", "state");
  let key;
  try { key = hk(b.channel === "sms" ? "phone" : "email", b.address); } catch (e) { throw new InputError(b.channel === "sms" ? "That phone number doesn't look right." : "That email doesn't look right.", "address"); }
  const masked = b.channel === "sms" ? maskPhone(b.address) : maskEmail(b.address);
  await writeSuppression({ channel: b.channel, address_hk: key, state: b.state, source: "manual", masked, by: ctx.user.id });
  return { data: { channel: b.channel, masked, state: b.state } };
}

// ------------------------------------------------------------ bulk runs

async function bulkRuns(ctx) {
  const status = ctx.query.get("status") || undefined;
  return { data: await listBulkRuns({ status }) };
}
// (a draft whose preview run was never created gets it now)
const bulkRun = async (ctx) => ({ data: bulkView(await ensurePreview(await getBulkRun(ctx.params.id), ctx.write())) });
async function newBulkRun(ctx) {
  const b = ctx.body || {};
  const run = await createBulkRun({ kind: "manual", title: b.title, recipients: b.recipients, template_key: b.template_key, channel: b.channel, vars: b.vars, related: b.related, requested_by: ctx.user.id }, ctx.write());
  return { status: 201, data: bulkView(run) };
}
async function testBulk(ctx) {
  const out = await testBulkRun(ctx.params.id, ctx);
  return { data: { ...bulkView(out.run), send: { status: out.send.status, outbox_id: out.send.outbox_id || null, mode: out.send.mode } } };
}
const confirmBulk = async (ctx) => ({ data: bulkView(await confirmBulkRun(ctx.params.id, ctx)) });
const cancelBulk = async (ctx) => ({ data: bulkView(await cancelBulkRun(ctx.params.id, ctx)) });

// ------------------------------------------------------------ messages

const MAX_SCHEDULE_MS = 30 * 86400000;
async function sendMessageRoute(ctx) {
  const b = ctx.body || {};
  if (!isId(b.contact_id, "contact")) throw new InputError("Pick who it goes to.", "contact_id");
  if (isTech(ctx)) {
    const visible = await techVisibleContacts(ctx.user.id);
    if (!visible.has(b.contact_id)) throw new ForbiddenError("You don't have access to that.");
  }
  if (!["sms", "email"].includes(b.channel)) throw new InputError("Pick text or email.", "channel");
  if (!b.template_key && !(typeof b.body === "string" && b.body.trim())) throw new InputError("Write a message or pick a template.", "body");
  if (typeof b.body === "string" && b.body.length > 1600) throw new InputError("Keep a text under 1,600 characters.", "body");
  const clientId = typeof b.client_id === "string" && /^[A-Za-z0-9-]{8,64}$/.test(b.client_id) ? b.client_id : null;
  const message = {
    contact_id: b.contact_id, channel: b.channel, ...(b.template_key ? { template_key: String(b.template_key) } : { body: b.body }),
    ...(b.subject ? { subject: String(b.subject).slice(0, 150) } : {}), vars: b.vars && typeof b.vars === "object" ? b.vars : undefined,
    related: b.related && typeof b.related === "object" ? b.related : {}, origin: { kind: "user", user_id: ctx.user.id },
    ...(clientId ? { marker_key: `msg-${keySafe(clientId, 64)}` } : {}),
  };
  const sysMode = await ctx.sysMode();      // a failed read answers 503 busy (never "not paused")
  const sendCtx = { ...ctx.write(), deploy: ctx.deploy, sysMode };
  if (b.send_at) {
    const at = Date.parse(b.send_at);
    if (!Number.isFinite(at) || at <= nowMs() || at > nowMs() + MAX_SCHEDULE_MS) throw new InputError("Pick a time in the next 30 days.", "send_at");
    if (sendCtx.sysMode.paused) throw new InputError("The CRM is paused after a restore.", "send_at");
    const a = await adapter(b.channel, { deploy: ctx.deploy, mode: sendCtx.sysMode });
    const ns = a.mode === "dry_run" ? "done-dry" : "done";
    await enqueue("send.message", { type: "contact", id: b.contact_id }, {}, new Date(at), { ns, scope: "send", key: keySafe(message.marker_key || `sched-${ctx.requestId}`, 100) }, { data: { msg: message } });
    return { status: 202, data: { status: "scheduled", send_at: new Date(at).toISOString() } };
  }
  const out = await call("messages.sink", message, sendCtx);
  return { status: out.status === "scheduled" ? 202 : 200, data: out };
}

// ------------------------------------------------------------ push

async function pushSubs(ctx) {
  const a = await adapter("push", { deploy: ctx.deploy });
  return { data: { vapid_public: a.mode === "live" ? process.env.CRM_VAPID_PUBLIC || null : null, mode: a.mode, subscriptions: await listPushSubscriptions(ctx.user.id) } };
}
async function addPushSub(ctx) {
  const b = ctx.body || {};
  const ua = String(b.ua || ctx.req.headers.get("user-agent") || "");
  const label = /iPhone|iPad/.test(ua) ? "iPhone" : /Android/.test(ua) ? "Android phone" : /Mac/.test(ua) ? "Mac" : /Windows/.test(ua) ? "Windows computer" : "Phone";
  return { status: 201, data: await savePushSubscription(ctx.user.id, b.subscription || b, { ua: label }) };
}
async function removePushSub(ctx) {
  await deletePushSubscription(ctx.user.id, ctx.params.hash);
  return { data: { ok: true } };
}
async function testPush(ctx) {
  const a = await adapter("push", { deploy: ctx.deploy });
  const out = await notify([ctx.user.id], { kind: "system", title: "Test notification", body: "Notifications work on this phone.", link: "/me" }, ctx.write());
  return { data: { queued: out.queued, mode: a.mode } };
}

export const commsRoutes = [
  r("GET", "/templates", "messages:send", "required", templates),
  r("GET", "/templates/:id", "messages:send", "required", template),
  r("POST", "/templates", "templates:edit", "none", createTemplate),
  r("PATCH", "/templates/:id", "templates:edit", "required", updateTemplate),
  r("POST", "/templates/preview", "messages:send", "required", preview),
  r("GET", "/automations", "automations:configure", "none", automations, { maxCalls: 40 }),
  r("PATCH", "/automations/:key", "automations:configure", "required", patchAuto),
  r("POST", "/automations/pause", "automations:configure", "none", pauseAll(true)),
  r("POST", "/automations/resume", "automations:configure", "none", pauseAll(false)),
  r("GET", "/automations/log", "outbox:read", "none", automationLog),
  r("GET", "/notifications", "account:own", "none", notifications, { maxCalls: 40 }),
  r("POST", "/notifications/read", "account:own", "none", readNotifications, { maxCalls: 60 }),
  r("GET", "/outbox", "outbox:read", "none", outbox, { maxCalls: 40 }),
  r("GET", "/suppressions", "consent:edit", "none", suppressions, { maxCalls: 50 }),
  r("POST", "/suppressions", "consent:edit", "none", setSuppression),
  r("GET", "/bulk-runs", "campaigns:write", "none", bulkRuns),
  r("POST", "/bulk-runs", "campaigns:write", "none", newBulkRun),
  r("GET", "/bulk-runs/:id", "campaigns:write", "required", bulkRun),
  r("POST", "/bulk-runs/:id/test", "campaigns:send", "required", testBulk, { maxCalls: 40 }),
  r("POST", "/bulk-runs/:id/confirm", "campaigns:send", "required", confirmBulk),
  r("POST", "/bulk-runs/:id/cancel", "campaigns:write", "required", cancelBulk),
  // (a send that really goes out is also recorded as a message in its thread: comms' recorder, M6)
  r("POST", "/messages", "messages:send", "required", sendMessageRoute, { maxCalls: 90 }),
  r("GET", "/push/subscriptions", "account:own", "none", pushSubs),
  r("POST", "/push/subscriptions", "account:own", "none", addPushSub),
  r("DELETE", "/push/subscriptions/:hash", "account:own", "required", removePushSub),
  r("POST", "/push/test", "account:own", "none", testPush),
];
