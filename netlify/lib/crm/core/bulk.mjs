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
// - Confirm (campaigns:send, owners and admins): starts run "bulk.send" in
//   the bulk lane: 25 recipients per step, each re-checked by the sender
//   (suppression, consent, quiet hours...) under its own marker
//   bulk/{bulkId}--{contactId}, paced at ~1 message a second when live.
// - Per-recipient results stay on the record ({ status, reason, outbox }),
//   bounded by MAX_RECIPIENTS.
//
// bulk.create (the service, §11.3) is how modules start one:
//   ({ kind, recipients, template_key, channel?, vars?, per_recipient_vars?,
//      related?, title?, requested_by }, ctx) → bulk_run_id
// `audience` (a campaign audience) arrives with comms (M6).

import { createRecord, updateRecord, getRecord, readIndex, getRecords, getRaw, getSetting, hk } from "../../crm-store.mjs";
import { defineType } from "./registry.mjs";
import { nowIso } from "./clock.mjs";
import { isId } from "./ids.mjs";
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

// Creates a bulk run (draft) and starts its preview. → the record.
export async function createBulkRun({ kind = "manual", title, recipients, audience, template_key, channel, vars, per_recipient_vars, related, requested_by } = {}, ctx = {}) {
  if (audience !== undefined && recipients === undefined) throw new InputError("Audiences arrive with Campaigns. Pass the list of contacts.", "audience");
  const t = await getTemplateByKey(template_key);
  if (!t) throw new InputError("That template doesn't exist.", "template_key");
  const ch = channel || t.channel;
  if (t.channel !== ch) throw new InputError("That template is for the other channel.", "template_key");
  const prv = per_recipient_vars && typeof per_recipient_vars === "object" ? per_recipient_vars : {};
  if (JSON.stringify(prv).length > 200000) throw new InputError("Too much per-person detail.", "per_recipient_vars");
  const rec = await createRecord("bulk_run", {
    kind: String(kind).slice(0, 60), title: title || t.name || "Bulk send", channel: ch, template_key: t.key, category: t.category,
    status: "draft", recipients, vars: vars || {}, per_recipient_vars: prv, related: related || {},
    requested_by: requested_by || (ctx && ctx.by) || "system", stats: {}, results: {}, preview: null, test: null,
  }, { by: (ctx && ctx.by) || "system", origin: (ctx && ctx.origin) || "worker", actor_kind: (ctx && ctx.actor_kind) || "automation", requestId: ctx && ctx.requestId });
  const run = await createRun("bulk.preview", { bulk_id: rec.data.id }, ctx);
  await updateRecord("bulk_run", rec.data.id, (x) => ({ ...x, preview_run_id: run.id }), runCtx(ctx));
  return { ...rec.data, preview_run_id: run.id };
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

// Why a recipient would be left out, before the sender's own checks.
async function exclusion(contact, b, seen) {
  if (!contact || contact.deleted_at || contact.merged_into) return "no_contact";
  if (contact.lifecycle === "archived") return "archived";
  if (contact.flags && (contact.flags.test || contact.flags.vendor || contact.flags.spam)) return "excluded_flag";
  const to = addressOf(contact, b.channel);
  if (!to) return "no_address";
  let key;
  try { key = hk(b.channel === "sms" ? "phone" : "email", to); } catch { return "no_address"; }
  if (seen.has(key)) return "duplicate";
  seen.add(key);
  const sup = await getRaw(`sup/${b.channel}/${key}`).catch(() => null);
  if (sup && sup.data && sup.data.state === "opted_out") return "opted_out";
  const c = consentBlock(b.channel, b.category, contact);
  if (c) return c;
  return null;
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
      const why = await exclusion(contact, b, cp.seen);
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

// Sends the test to the test contact (cfg/messaging_test). Required before confirm.
export async function testBulkRun(id, ctx) {
  const b = await getBulkRun(id);
  if (!["ready", "tested"].includes(b.status)) throw new ConflictError(b.status === "draft" ? "The preview isn't ready yet. Try again in a moment." : "This send can't be tested now.");
  const mt = await getSetting("messaging_test").catch(() => ({}));
  if (!isId(mt.contact_id, "contact")) throw new ConflictError("Pick the test contact first (Settings → Messaging, owners).");
  const testContact = await getRecord("contact", mt.contact_id);
  if (!testContact || testContact.data.deleted_at) throw new ConflictError("The test contact isn't there anymore. Pick another in Settings → Messaging.");
  const sample = (b.preview && b.preview.samples && b.preview.samples[0]) || null;
  const extra = { ...(b.vars || {}), ...((sample && (b.per_recipient_vars || {})[sample.contact_id]) || {}) };
  const n = ((b.test && b.test.n) || 0) + 1;
  const r = await sendMessage({
    contact_id: mt.contact_id, channel: b.channel, template_key: b.template_key, vars: extra, related: { ...(b.related || {}), bulk_run_id: b.id },
    origin: { kind: "campaign", id: b.id }, category: b.category, marker_key: `bulk-test-${b.id}-${n}`, test_send: true,
  }, { ...ctx.write(), deploy: ctx.deploy, sysMode: await ctx.sysMode() });
  if (!["dry_run", "sent", "queued", "delivered"].includes(r.status)) {
    throw new ConflictError(r.status === "blocked" ? `The test didn't go out (${String(r.blocked_reason).replace(/_/g, " ")}).` : r.status === "scheduled" ? "It's quiet hours: the test goes out in the morning. Confirm after it arrives." : "The test didn't go out. Try again.");
  }
  const by = ctx.user ? ctx.user.id : "system";
  const up = await updateRecord("bulk_run", b.id, (x) => (["ready", "tested"].includes(x.status) ? { ...x, status: "tested", test: { n, contact_id: mt.contact_id, sent_at: nowIso(), by, outbox_id: r.outbox_id || null, mode: r.mode } } : null), ctx.write());
  return { run: up.data, send: r };
}

// An owner or admin confirms: the bulk lane sends in batches.
export async function confirmBulkRun(id, ctx) {
  const b = await getBulkRun(id);
  if (b.status !== "tested") throw new ConflictError(b.status === "sending" || b.status === "sent" ? "This send already started." : "Send the test first, then confirm.");
  const by = ctx.user ? ctx.user.id : "system";
  const up = await updateRecord("bulk_run", b.id, (x) => (x.status === "tested" ? { ...x, status: "sending", confirmed_by: by, confirmed_at: nowIso() } : null), ctx.write());
  if (up.data.status !== "sending" || up.data.confirmed_by !== by) throw new ConflictError("Someone else just changed this send.");
  const run = await createRun("bulk.send", { bulk_id: b.id }, ctx.write());
  const r = await updateRecord("bulk_run", b.id, (x) => ({ ...x, send_run_id: run.id }), ctx.write());
  return r.data;
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

async function sendStep(run, { budget, deploy, mode }) {
  const b = await getBulkRun(run.input.bulk_id);
  if (b.status === "cancelled") return { done: true, result: { cancelled: true } };
  if (b.status !== "sending") return { done: true, result: { skipped: b.status } };
  const results = { ...(b.results || {}) };
  const todo = (b.recipients || []).filter((cid) => !results[cid]);
  const batch = todo.slice(0, BATCH);
  const wctx = { by: b.confirmed_by || "system", origin: "worker", actor_kind: "automation", requestId: "bulk" };
  let live = 0;
  for (const cid of batch) {
    if (budget && budget.left() < 10000) break;
    let r;
    try {
      r = await sendMessage({
        contact_id: cid, channel: b.channel, template_key: b.template_key, vars: { ...(b.vars || {}), ...((b.per_recipient_vars || {})[cid] || {}) },
        related: { ...(b.related || {}), bulk_run_id: b.id }, origin: { kind: "campaign", id: b.id }, category: b.category,
        marker_key: `bulk-${b.id}-${cid}`,
      }, { ...wctx, deploy, sysMode: mode });
    } catch (e) {
      r = { status: "failed", error_code: (e && e.name) || "error" };
    }
    results[cid] = { s: r.status, ...(r.blocked_reason ? { r: r.blocked_reason } : r.reason ? { r: r.reason } : {}), ...(r.outbox_id ? { ob: r.outbox_id } : {}) };
    if (r.mode === "live" || r.mode === "test") { live += 1; await pace(PACE_MS); }
  }
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

