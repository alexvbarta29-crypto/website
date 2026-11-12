// Barta CRM core: bulk runs, any send to many people (design §5.7.4 "Bulk
// sends", §5.7.5, barta-rules: any send to many people needs a test send
// and an owner's confirm).
//
// One action or seasonal trigger that addresses more than
// cfg/messaging.bulk_threshold recipients (default 5) never sends
// directly. It becomes a bulk run (rec/bulk_run/{id}, prefix bk, listed in
// ix/bulk-runs):
//
//   draft ──preview (bulk lane)──▶ ready ──test send──▶ tested ──confirm──▶ sending ──▶ sent
//     └──────────────────────────── cancel (any time before sent) ──────────────▶ cancelled
//
// - Preview: the count, exclusions by reason (no address, opted out, no
//   consent, a duplicate address, archived or test contacts) and 10 sample
//   renders, worked out in the bulk lane (run "bulk.preview").
// - Test send: the template rendered for the first included recipient goes
//   to the test contact (cfg/messaging_test.contact_id, owner-only, flagged
//   test), through the same sender; required before confirm (409 otherwise).
//   The run keeps the tested version of the template (test.template, and
//   its sha): confirm answers 409 and goes back to "ready" when the
//   template changed since, and the send renders the tested version.
// - Confirm (campaigns:send, owners and admins): starts run "bulk.send" in
//   the bulk lane: 25 recipients per step, each checked again for what the
//   preview left out (archived, test/vendor/spam, a second contact on the
//   same address, opted out, no consent) and then by the sender
//   (suppression, consent, quiet hours...) under its own marker
//   send/bulk-{bulkId}-{contactId}, paced at ~1 message a second when live.
// - Per-recipient results stay on the record ({ s, r?, ob?, a? }: status,
//   reason, outbox id, the address's key prefix for the duplicate rule),
//   bounded by MAX_RECIPIENTS.
// - Every step survives a write that failed half way: the preview and send
//   runs have ids derived from the bulk run (creating one twice returns the
//   first), confirm continues a "sending" run whose send run is missing,
//   and a test whose save failed counts once its marker shows it went out.
//
// bulk.create (the service, §11.3) is how modules start one:
//   ({ kind, recipients, template_key, channel?, vars?, per_recipient_vars?,
//      related?, title?, requested_by }, ctx) → bulk_run_id
// `audience` (a campaign audience) arrives with comms (M6).

import { createHash } from "node:crypto";
import { createRecord, updateRecord, getRecord, readIndex, getRecords, getRaw, getSetting, hk, isTransient } from "../../crm-store.mjs";
import { defineType } from "./registry.mjs";
import { nowIso } from "./clock.mjs";
import { isId, newId, deriveId } from "./ids.mjs";
import { InputError, ConflictError, NotFoundError } from "./errors.mjs";
import { shape, str, enumValue, int } from "./validate.mjs";
import { createRun, defineRun, cancelRun } from "./lanes.mjs";
import { getTemplateByKey, renderTemplate, varsFor, TEMPLATE_KEY_RE } from "./templates.mjs";
import { sendMessage, addressOf, consentBlock } from "./send.mjs";
import { truncate } from "./text.mjs";

export const STATUSES = Object.freeze(["draft", "ready", "tested", "sending", "sent", "cancelled", "failed"]);
export const MAX_RECIPIENTS = 2000;
export const BATCH = 25;
export const SAMPLES = 10;
export const DEFAULT_THRESHOLD = 5;
export const PACE_MS = 1000;

function validateBulk(data, { op } = {}) {
  const stored = op === "update";
  return shape(data, {
    kind: (v, f) => str(v, { field: f, max: 60, required: true }),
    title: (v, f) => str(v, { field: f, max: 120, required: true }),
    channel: (v, f) => enumValue(v, ["sms", "email"], { field: f, required: true, stored }),
    template_key: (v, f) => { if (!TEMPLATE_KEY_RE.test(String(v || ""))) throw new InputError("Pick a template.", f); return v; },
    status: (v, f) => enumValue(v, STATUSES, { field: f, required: true, stored }),
    recipients: (v, f) => {
      if (!Array.isArray(v) || !v.length) throw new InputError("Pick who it goes to.", f);
      if (v.length > MAX_RECIPIENTS) throw new InputError(`At most ${MAX_RECIPIENTS} people in one send.`, f);
      if (v.some((x) => !isId(x, "contact"))) throw new InputError("Every recipient must be a contact.", f);
      return [...new Set(v)];
    },
    requested_by: (v, f) => str(v, { field: f, max: 80, required: true }),
    threshold: (v, f) => int(v, { field: f, min: 1, max: 1000 }),
  });
}

export const bulkRow = (r) => ({ k: r.kind, t: r.title, st: r.status, ch: r.channel, n: (r.recipients || []).length, at: r.created_at, by: r.requested_by });

export const bulkRunType = defineType({
  type: "bulk_run",
  prefix: "bk",
  v: 1,
  validate: validateBulk,
  rotorFields: [],
  techFields: ["id", "kind", "title", "status"],
  readPerm: "campaigns:write",
  shadow: false,
  indexes: [{ name: "bulk-runs", shard: () => "", row: bulkRow }],
  summary: (r) => ({ id: r.id, title: r.title, status: r.status }),
  example: () => ({ kind: "manual", title: "Rain-day notice", channel: "sms", template_key: "sample_note", status: "draft", recipients: ["ct_0000000000000000000a"], requested_by: "us_0000000000000000000a", stats: {}, results: {} }),
});

export async function bulkThreshold() {
  const m = await getSetting("messaging").catch(() => ({}));
  return Number.isInteger(m.bulk_threshold) ? m.bulk_threshold : DEFAULT_THRESHOLD;
}

// The runs of a bulk run have ids derived from it: creating one twice
// (a retried request) returns the first.
export const previewRunId = (bulkId) => deriveId("run", bulkId, "bulk.preview", 1);
export const sendRunId = (bulkId) => deriveId("run", bulkId, "bulk.send", 1);

// What the test send covered: the template's channel, category and text.
const templateSnapshot = (t) => ({ key: t.key, name: t.name, channel: t.channel, category: t.category, subject: t.subject || "", body: t.body || "", ...(t.body_html ? { body_html: t.body_html } : {}), active: t.active !== false });
export const templateSha = (t) => createHash("sha256").update(JSON.stringify([t.channel, t.category, t.subject || "", t.body || "", t.body_html || ""])).digest("hex");

// Creates a bulk run (draft) and starts its preview. → the record.
export async function createBulkRun({ kind = "manual", title, recipients, audience, template_key, channel, vars, per_recipient_vars, related, requested_by } = {}, ctx = {}) {
  if (audience !== undefined && recipients === undefined) throw new InputError("Audiences arrive with Campaigns. Pass the list of contacts.", "audience");
  const t = await getTemplateByKey(template_key);
  if (!t) throw new InputError("That template doesn't exist.", "template_key");
  // staff templates are for staff phones, never a send to many customers
  if (t.category === "staff") throw new InputError("That template is for the team, not for customers.", "template_key");
  const ch = channel || t.channel;
  if (t.channel !== ch) throw new InputError("That template is for the other channel.", "template_key");
  const prv = per_recipient_vars && typeof per_recipient_vars === "object" ? per_recipient_vars : {};
  if (JSON.stringify(prv).length > 200000) throw new InputError("Too much per-person detail.", "per_recipient_vars");
  const id = newId("bulk_run");
  const rec = await createRecord("bulk_run", {
    id, kind: String(kind).slice(0, 60), title: title || t.name || "Bulk send", channel: ch, template_key: t.key, category: t.category,
    status: "draft", recipients, vars: vars || {}, per_recipient_vars: prv, related: related || {},
    requested_by: requested_by || (ctx && ctx.by) || "system", stats: {}, results: {}, preview: null, test: null, preview_run_id: previewRunId(id),
  }, { by: (ctx && ctx.by) || "system", origin: (ctx && ctx.origin) || "worker", actor_kind: (ctx && ctx.actor_kind) || "automation", requestId: ctx && ctx.requestId });
  await createRun("bulk.preview", { bulk_id: id }, ctx, { id: previewRunId(id) });
  return rec.data;
}

// A draft whose preview run was never created (the request died after the
// record): creates it now (same id, so at most one). → the bulk run.
export async function ensurePreview(b, ctx = {}) {
  if (!b || b.status !== "draft") return b;
  const rid = b.preview_run_id || previewRunId(b.id);
  if (await getRecord("run", rid)) return b;
  await createRun("bulk.preview", { bulk_id: b.id }, runCtx(ctx), { id: rid });
  return b;
}

// The bulk.create service (§11.3): → bulk_run_id.
export async function bulkCreate(spec, ctx) {
  const r = await createBulkRun(spec, ctx);
  return r.id;
}

const runCtx = (ctx) => ({ by: (ctx && ctx.by) || "system", origin: (ctx && ctx.origin) || "worker", actor_kind: (ctx && ctx.actor_kind) || "automation", requestId: (ctx && ctx.requestId) || "bulk" });

export async function getBulkRun(id) {
  if (!isId(id, "bulk_run")) throw new NotFoundError("That send isn't there.");
  const got = await getRecord("bulk_run", id);
  if (!got || got.data.deleted_at) throw new NotFoundError("That send isn't there.");
  return got.data;
}

export async function listBulkRuns({ status } = {}) {
  const ix = await readIndex("bulk-runs", "");
  return ix.rows
    .filter((r) => !status || r.st === status || (status === "waiting" && ["draft", "ready", "tested"].includes(r.st)))
    .sort((a, b) => (a.at < b.at ? 1 : -1))
    .map((r) => ({ id: r.id, kind: r.k, title: r.t, status: r.st, channel: r.ch, recipients: r.n, created_at: r.at, requested_by: r.by }));
}

// Waiting for a test or a confirm (Today → Approvals, /me/badges).
export async function waitingCount() {
  return (await listBulkRuns({ status: "waiting" })).length;
}

export const bulkView = (b) => ({
  id: b.id, kind: b.kind, title: b.title, channel: b.channel, template_key: b.template_key, category: b.category, status: b.status,
  recipients: (b.recipients || []).length, preview: b.preview || null, test: b.test || null, stats: b.stats || {},
  confirmed_by: b.confirmed_by || null, confirmed_at: b.confirmed_at || null, created_at: b.created_at, requested_by: b.requested_by,
  send_run_id: b.send_run_id || null, preview_run_id: b.preview_run_id || null,
});

// ------------------------------------------------------------ preview (bulk lane)

// Why a recipient is left out, before the sender's own checks: the same
// rules for the preview's count and for the send. seen holds the address
// keys already taken (one message per phone or email, §5.7.5); a failed
// read of the suppression list throws (never "not opted out").
// → { why: reason | null, a: the address key's prefix (for seen) | null }
const addrTag = (key) => key.slice(0, 16);
async function exclusion(contact, b, seen) {
  if (!contact || contact.deleted_at || contact.merged_into) return { why: "no_contact", a: null };
  if (contact.lifecycle === "archived") return { why: "archived", a: null };
  if (contact.flags && (contact.flags.test || contact.flags.vendor || contact.flags.spam)) return { why: "excluded_flag", a: null };
  const to = addressOf(contact, b.channel);
  if (!to) return { why: "no_address", a: null };
  let key;
  try { key = hk(b.channel === "sms" ? "phone" : "email", to); } catch { return { why: "no_address", a: null }; }
  const a = addrTag(key);
  if (seen.has(a)) return { why: "duplicate", a: null };
  seen.add(a);
  const sup = await getRaw(`sup/${b.channel}/${key}`);
  if (sup && sup.data && sup.data.state === "opted_out") return { why: "opted_out", a };
  const c = consentBlock(b.channel, b.category, contact);
  if (c) return { why: c, a };
  return { why: null, a };
}

async function previewStep(run, { budget }) {
  const b = await getBulkRun(run.input.bulk_id);
  if (b.status !== "draft" && b.status !== "ready") return { done: true, result: { skipped: b.status } };
  const t = await getTemplateByKey(b.template_key);
  const company = await getSetting("company").catch(() => ({}));
  const cp = run.checkpoint && Number.isInteger(run.checkpoint.i) ? { ...run.checkpoint, seen: new Set(run.checkpoint.seen || []) } : { i: 0, count: 0, excluded: {}, samples: [], seen: new Set() };
  const list = b.recipients || [];
  while (cp.i < list.length) {
    if (budget && budget.left() < 15000) return { checkpoint: { ...cp, seen: [...cp.seen] }, progress: { done: cp.i, total: list.length } };
    const chunk = list.slice(cp.i, cp.i + 16);
    const got = await getRecords("contact", chunk);
    for (let j = 0; j < chunk.length; j++) {
      const contact = got[j] && got[j].data;
      const { why } = await exclusion(contact, b, cp.seen);
      if (why) { cp.excluded[why] = (cp.excluded[why] || 0) + 1; continue; }
      cp.count += 1;
      if (cp.samples.length < SAMPLES && t) {
        const r = renderTemplate(t, varsFor({ contact, company, extra: { ...(b.vars || {}), ...((b.per_recipient_vars || {})[contact.id] || {}) } }), { company });
        cp.samples.push({ contact_id: contact.id, text: truncate(r.text, 400), subject: r.subject || null, missing: r.missing });
      }
    }
    cp.i += chunk.length;
  }
  const preview = { count: cp.count, excluded: cp.excluded, samples: cp.samples, at: nowIso() };
  await updateRecord("bulk_run", b.id, (x) => (x.status === "draft" || x.status === "ready" ? { ...x, status: "ready", preview } : null), runCtx());
  return { done: true, progress: { done: list.length, total: list.length }, result: { count: cp.count } };
}
defineRun("bulk.preview", { lane: "bulk", step: previewStep, label: "Bulk send preview" });

// ------------------------------------------------------------ test, confirm, cancel

// Sends the test to the test contact (cfg/messaging_test). Required before
// confirm. The run keeps the version of the template the test rendered.
const WENT_OUT = ["dry_run", "sent", "queued", "delivered"];
export async function testBulkRun(id, ctx) {
  const b = await ensurePreview(await getBulkRun(id), ctx.write());
  if (!["ready", "tested"].includes(b.status)) throw new ConflictError(b.status === "draft" ? "The preview isn't ready yet. Try again in a moment." : "This send can't be tested now.");
  const mt = await getSetting("messaging_test").catch(() => ({}));
  if (!isId(mt.contact_id, "contact")) throw new ConflictError("Pick the test contact first (Settings → Messaging, owners).");
  const testContact = await getRecord("contact", mt.contact_id);
  if (!testContact || testContact.data.deleted_at) throw new ConflictError("The test contact isn't there anymore. Pick another in Settings → Messaging.");
  const t = await getTemplateByKey(b.template_key);
  if (!t) throw new ConflictError("That template isn't there anymore.");
  const tpl = templateSnapshot(t);
  const sample = (b.preview && b.preview.samples && b.preview.samples[0]) || null;
  const extra = { ...(b.vars || {}), ...((sample && (b.per_recipient_vars || {})[sample.contact_id]) || {}) };
  const sysMode = await ctx.sysMode();
  let n = ((b.test && b.test.n) || 0) + 1;
  let r;
  // a test whose marker is final already went out (or failed): one that went
  // out counts (its save failed last time); one that failed is tried again
  // under the next number
  for (let i = 0; i < 3; i++, n++) {
    r = await sendMessage({
      contact_id: mt.contact_id, channel: b.channel, template_key: b.template_key, template: tpl, vars: extra, related: { ...(b.related || {}), bulk_run_id: b.id },
      origin: { kind: "campaign", id: b.id }, category: b.category, marker_key: `bulk-test-${b.id}-${n}`, test_send: true,
    }, { ...ctx.write(), deploy: ctx.deploy, sysMode });
    if (r.status !== "already") break;
    if (WENT_OUT.includes(r.result)) { r = { ...r, status: r.result }; break; }
  }
  if (!WENT_OUT.includes(r.status)) {
    throw new ConflictError(r.status === "blocked" ? `The test didn't go out (${String(r.blocked_reason).replace(/_/g, " ")}).` : r.status === "scheduled" ? "It's quiet hours: the test goes out in the morning. Confirm after it arrives." : "The test didn't go out. Try again.");
  }
  const by = ctx.user ? ctx.user.id : "system";
  const test = { n, contact_id: mt.contact_id, sent_at: nowIso(), by, outbox_id: r.outbox_id || null, mode: r.mode, template_sha: templateSha(tpl), template: tpl };
  const up = await updateRecord("bulk_run", b.id, (x) => (["ready", "tested"].includes(x.status) ? { ...x, status: "tested", test } : null), ctx.write());
  return { run: up.data, send: r };
}

// An owner or admin confirms: the bulk lane sends in batches, from the
// tested version of the template. A template changed since the test sends
// the run back to "ready" (test again). A confirm whose send run was not
// created (the request died) is finished by confirming again.
export async function confirmBulkRun(id, ctx) {
  const b = await getBulkRun(id);
  const by = ctx.user ? ctx.user.id : "system";
  if (b.status === "sending") {
    const rid = b.send_run_id || sendRunId(b.id);
    if (await getRecord("run", rid)) throw new ConflictError("This send already started.");
    await createRun("bulk.send", { bulk_id: b.id }, ctx.write(), { id: rid });
    const r = b.send_run_id ? null : await updateRecord("bulk_run", b.id, (x) => (x.send_run_id ? null : { ...x, send_run_id: rid }), ctx.write());
    return r ? r.data : b;
  }
  if (b.status !== "tested") throw new ConflictError(b.status === "sent" ? "This send already started." : "Send the test first, then confirm.");
  const t = await getTemplateByKey(b.template_key);
  if (!t || !b.test || !b.test.template_sha || templateSha(templateSnapshot(t)) !== b.test.template_sha) {
    await updateRecord("bulk_run", b.id, (x) => (x.status === "tested" ? { ...x, status: "ready", test: x.test ? { ...x.test, stale: true } : null } : null), ctx.write());
    throw new ConflictError("The template changed after the test. Send the test again.");
  }
  const rid = sendRunId(b.id);
  const up = await updateRecord("bulk_run", b.id, (x) => (x.status === "tested" ? { ...x, status: "sending", confirmed_by: by, confirmed_at: nowIso(), send_run_id: rid } : null), ctx.write());
  if (up.data.status !== "sending" || up.data.confirmed_by !== by) throw new ConflictError("Someone else just changed this send.");
  await createRun("bulk.send", { bulk_id: b.id }, ctx.write(), { id: rid });
  return up.data;
}

export async function cancelBulkRun(id, ctx) {
  const b = await getBulkRun(id);
  if (["sent", "cancelled", "failed"].includes(b.status)) throw new ConflictError("This send is already finished.");
  const up = await updateRecord("bulk_run", b.id, (x) => (["sent", "cancelled", "failed"].includes(x.status) ? null : { ...x, status: "cancelled", cancelled_at: nowIso(), cancelled_by: ctx.user ? ctx.user.id : "system" }), ctx.write());
  for (const rid of [b.send_run_id, b.preview_run_id]) if (rid) await cancelRun(rid, ctx.write()).catch(() => {});
  return up.data;
}

// ------------------------------------------------------------ the send (bulk lane)

let pace = (ms) => new Promise((r) => setTimeout(r, ms));
// Tests: replace the 1-message-a-second pacing (null restores it).
export function setPace(fn) { pace = fn || ((ms) => new Promise((r) => setTimeout(r, ms))); }

// A recipient whose step finished before (a step that died before saving
// the results) counts as what it was: its marker's result.
function alreadyAs(r) {
  const res = String(r.result || "");
  if (res.startsWith("blocked:")) return { ...r, status: "blocked", blocked_reason: res.slice(8) };
  if (["dry_run", "sent", "queued", "delivered"].includes(res)) return { ...r, status: res };
  return { ...r, status: "sent" };
}

// Comms (M6) wraps each batch so the conversations a batch of real sends
// touches are written to the inbox index once, not once per message (§5.7.5).
let batchScope = (fn) => fn();
export function setBatchScope(fn) { batchScope = typeof fn === "function" ? fn : (f) => f(); }
const sendStep = (run, rctx) => batchScope(() => sendBatch(run, rctx));

async function sendBatch(run, { budget, deploy, mode }) {
  const b = await getBulkRun(run.input.bulk_id);
  if (b.status === "cancelled") return { done: true, result: { cancelled: true } };
  if (b.status !== "sending") return { done: true, result: { skipped: b.status } };
  const results = { ...(b.results || {}) };
  // the addresses already taken: one message per phone or email (§5.7.5)
  const seen = new Set(Object.values(results).map((v) => v && v.a).filter(Boolean));
  const todo = (b.recipients || []).filter((cid) => !results[cid]);
  const batch = todo.slice(0, BATCH);
  const wctx = { by: b.confirmed_by || "system", origin: "worker", actor_kind: "automation", requestId: "bulk", ...(mode ? { mode } : {}) };
  const tpl = b.test && b.test.template && b.test.template.key === b.template_key ? b.test.template : null;
  const got = batch.length ? await getRecords("contact", batch) : [];
  let live = 0;
  let stopped = null;
  for (let j = 0; j < batch.length; j++) {
    const cid = batch[j];
    if (budget && budget.left() < 10000) break;
    let ex;
    let r;
    try {
      // what the preview left out stays out (archived, test/vendor/spam, a second contact on one address, ...)
      ex = await exclusion(got[j] && got[j].data, b, seen);
      r = ex.why ? { status: "skipped", reason: ex.why } : await sendMessage({
        contact_id: cid, channel: b.channel, template_key: b.template_key, ...(tpl ? { template: tpl } : {}), vars: { ...(b.vars || {}), ...((b.per_recipient_vars || {})[cid] || {}) },
        related: { ...(b.related || {}), bulk_run_id: b.id }, origin: { kind: "campaign", id: b.id }, category: b.category,
        marker_key: `bulk-${b.id}-${cid}`,
      }, { ...wctx, deploy, sysMode: mode });
    } catch (e) {
      // storage blinked (or the step is held elsewhere): stop here and come
      // back with backoff; the recipient is not marked
      if (isTransient(e)) { stopped = e; if (ex && ex.a) seen.delete(ex.a); break; }
      r = { status: "failed", error_code: (e && e.name) || "error" };
    }
    if (r.status === "already") r = alreadyAs(r);
    results[cid] = { s: r.status, ...(r.blocked_reason ? { r: r.blocked_reason } : r.reason ? { r: r.reason } : {}), ...(r.outbox_id ? { ob: r.outbox_id } : {}), ...(ex && ex.a ? { a: ex.a } : {}) };
    if (r.mode === "live" || r.mode === "test") { live += 1; await pace(PACE_MS); }
  }
  if (stopped && Object.keys(results).length === Object.keys(b.results || {}).length) throw stopped;
  const stats = { recipients: (b.recipients || []).length, sent: 0, dry_run: 0, failed: 0, scheduled: 0, skipped: {} };
  for (const v of Object.values(results)) {
    if (v.s === "dry_run") stats.dry_run += 1;
    else if (v.s === "sent" || v.s === "queued" || v.s === "delivered" || v.s === "already") stats.sent += 1;
    else if (v.s === "scheduled") stats.scheduled += 1;
    else if (v.s === "blocked" || v.s === "skipped") stats.skipped[v.r || "other"] = (stats.skipped[v.r || "other"] || 0) + 1;
    else stats.failed += 1;
  }
  const finished = Object.keys(results).length >= (b.recipients || []).length;
  await updateRecord("bulk_run", b.id, (x) => (x.status !== "sending" ? null : { ...x, results, stats, ...(finished ? { status: "sent", finished_at: nowIso() } : {}) }), wctx);
  return { checkpoint: { done: Object.keys(results).length, live }, progress: { done: Object.keys(results).length, total: (b.recipients || []).length }, ...(finished ? { done: true, result: stats } : {}) };
}
defineRun("bulk.send", { lane: "bulk", step: sendStep, label: "Bulk send" });

