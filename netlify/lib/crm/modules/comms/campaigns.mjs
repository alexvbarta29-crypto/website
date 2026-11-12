// Comms: campaigns (design §5.7.5, B4, barta-rules: any send to many people
// needs a test send to the test contact and an owner's or the office's
// confirm).
//
// A campaign is an audience and a template. Its send IS a core bulk run
// (core/bulk.mjs: the same machinery as a rain-day notice or the lights
// rebook), so the rules cannot drift apart:
//
//   draft ─preview─▶ draft ─"Send test"─▶ (the bulk run is made and prepared in the bulk lane)
//         ─"Send test" again─▶ tested ─"Send now" / schedule─▶ sending ─▶ sent
//
// - Preview (inline, from the contacts index only): the count, who is left
//   out and why, ten sample texts.
// - Test: the audience is fixed as the bulk run's recipient list; the bulk
//   lane checks consent and opt-outs contact by contact; then the test goes
//   to the test contact (cfg/messaging_test). A changed audience or
//   template needs a new test.
// - Send now or schedule (campaigns:send): the bulk run's confirm, now or
//   from a queue item at send_at (editable until it starts) as the person
//   who scheduled it. 25 at a time, about one a second when real, each
//   recipient re-checked at send time, one inbox index write per batch.
// - Results per recipient stay on the bulk run (at most 2,000 people).
// Refused before its test, always: "Send the test first, then confirm."
// Imported Rotor campaigns are history (status "sent"); they are never sent again.

import { createRecord, updateRecord, getRecord, getRecords, readIndex, listKeys, getSetting, hk, withStoreScope, currentScope } from "../../../crm-store.mjs";
import { isId } from "../../core/ids.mjs";
import { nowIso, nowMs } from "../../core/clock.mjs";
import { InputError, NotFoundError, ConflictError } from "../../core/errors.mjs";
import { truncate } from "../../core/text.mjs";
import { getTemplateByKey, renderTemplate, varsFor } from "../../core/templates.mjs";
import { createBulkRun, getBulkRun, testBulkRun, confirmBulkRun, cancelBulkRun, listBulkRuns, bulkView } from "../../core/bulk.mjs";
import { enqueue } from "../../core/queue.mjs";
import { cleanAudience, MAX_CAMPAIGN_RECIPIENTS, CHANNELS } from "./types.mjs";
import { evaluateAudience, audienceChoices } from "./audience.mjs";

export const RECENT_DAYS = 3;
const EDITABLE = ["draft", "tested", "scheduled"];
const memo = (fn) => (currentScope() && currentScope().ixMemo instanceof Map ? fn() : withStoreScope({ ixMemo: new Map() }, fn));

export async function getCampaign(id) {
  if (!isId(id, "campaign")) throw new NotFoundError("That campaign isn't there.");
  const got = await getRecord("campaign", id);
  if (!got || got.data.deleted_at) throw new NotFoundError("That campaign isn't there.");
  return got;
}

// Everyone a campaign reached in the last RECENT_DAYS days (their bulk runs' results).
async function recentlyReached(exceptId) {
  const ix = await readIndex("campaigns", "");
  const since = nowMs() - RECENT_DAYS * 86400000;
  const recent = ix.rows.filter((r) => r.id !== exceptId && !r.ro && ["sending", "sent"].includes(r.st) && r.fa && Date.parse(r.fa) >= since).slice(0, 5);
  const out = new Set();
  for (const r of recent) {
    const c = await getRecord("campaign", r.id);
    const b = c && isId(c.data.bulk_run_id, "bulk_run") ? await getRecord("bulk_run", c.data.bulk_run_id) : null;
    for (const [cid, v] of Object.entries((b && b.data.results) || {})) if (v && ["sent", "dry_run", "queued", "delivered"].includes(v.s)) out.add(cid);
  }
  return out;
}

// The opt-out list as address keys (one listing; rel/suppressions/{channel}/{ts}--{hk}).
async function suppressedKeys(channel) {
  const keys = await listKeys(`rel/suppressions/${channel}/`);
  return new Set(keys.map((k) => k.slice(k.lastIndexOf("--") + 2)));
}

// The audience of a campaign, from the contacts index. → evaluateAudience()'s answer plus rows.
export async function audienceOf(campaign) {
  return memo(async () => {
    const [ix, suppressed, recent] = await Promise.all([readIndex("contacts", ""), suppressedKeys(campaign.channel), recentlyReached(campaign.id)]);
    const addressKey = (addr) => { try { return hk(campaign.channel === "sms" ? "phone" : "email", addr); } catch { return null; } };
    return { ...evaluateAudience(ix.rows, campaign.audience, { channel: campaign.channel, suppressed, recent, addressKey }), rows: ix.rows };
  });
}

const FIELDS = ["name", "description", "channel", "template_key", "audience"];
async function clean(b, base = {}) {
  const out = { ...base };
  for (const f of FIELDS) if (b[f] !== undefined) out[f] = b[f];
  if (!CHANNELS.includes(out.channel)) throw new InputError("Pick text or email.", "channel");
  out.audience = cleanAudience(out.audience);
  if (out.template_key) {
    const t = await getTemplateByKey(String(out.template_key));
    if (!t) throw new InputError("That template doesn't exist.", "template_key");
    if (t.channel !== out.channel) throw new InputError("That template is for the other channel.", "template_key");
    if (t.category === "staff") throw new InputError("That template is for the team, not for customers.", "template_key");
    if (t.active === false) throw new InputError("That template is switched off.", "template_key");
    out.template_key = t.key;
    if (t.id) out.template_id = t.id; else delete out.template_id;
  }
  return out;
}

export async function createCampaign(body, ctx) {
  const b = body || {};
  const data = await clean({ channel: "sms", description: "", audience: {}, ...b });
  const rec = await createRecord("campaign", { ...data, status: "draft", test: {}, stats: {}, created_by_name: ctx.user ? ctx.user.name : "" }, ctx.write());
  return rec;
}

// An edit: anything that changes who gets it or what it says needs a new test.
export async function patchCampaign(id, body, ctx) {
  const got = await getCampaign(id);
  const c = got.data;
  if (c.rotor) throw new ConflictError("This campaign came from Rotor. It is history and can't be changed.");
  if (!EDITABLE.includes(c.status)) throw new ConflictError("This campaign already started.");
  const next = await clean(body || {}, { name: c.name, description: c.description, channel: c.channel, template_key: c.template_key, audience: c.audience });
  const changed = next.channel !== c.channel || next.template_key !== c.template_key || JSON.stringify(next.audience) !== JSON.stringify(c.audience || {});
  if (changed && c.status === "scheduled") throw new ConflictError("Take it off the schedule first, then change it.");
  const r = await updateRecord("campaign", id, (x) => ({ ...x, ...next, ...(changed ? { status: "draft", test: {}, audience_preview: null, bulk_run_id: null } : {}) }), { ...ctx.write(), ifMatch: ctx.ifMatch });
  if (changed && isId(c.bulk_run_id, "bulk_run")) await cancelBulkRun(c.bulk_run_id, ctx).catch(() => {});
  return r;
}

// The preview: count, exclusions by reason, ten sample texts. Index only, plus ten contacts for the samples.
export async function previewCampaign(id, ctx) {
  const c = (await getCampaign(id)).data;
  const a = await audienceOf(c);
  const t = c.template_key ? await getTemplateByKey(c.template_key) : null;
  const samples = [];
  if (t) {
    const company = await getSetting("company").catch(() => ({}));
    const got = await getRecords("contact", a.ids.slice(0, 10));
    for (const g of got) {
      if (!g || !g.data) continue;
      const r = renderTemplate(t, varsFor({ contact: g.data, company, sender: ctx.user }), { company });
      samples.push({ contact_id: g.data.id, name: g.data.display_name || "", text: truncate(r.text, 400), subject: r.subject || null, missing: r.missing });
    }
  }
  const preview = { count: a.count, matched: a.matched, at: nowIso(), excluded: a.excluded, unsupported: a.unsupported, over_limit: a.count > MAX_CAMPAIGN_RECIPIENTS };
  if (EDITABLE.includes(c.status) && !c.rotor) await updateRecord("campaign", id, (x) => ({ ...x, audience_preview: preview }), { ...ctx.write(), audit: false });
  return { ...preview, samples, category: t ? t.category : null, consent_note: t && t.category === "marketing" && c.channel === "sms" ? "Only people who agreed to marketing texts get this one. They are counted when the test is prepared." : null, choices: audienceChoices(a.rows) };
}

// "Send test": fixes the audience as a bulk run, lets the bulk lane prepare
// it, then sends the test to the test contact. → { status: "preparing" | "tested", ... }
export async function testCampaign(id, ctx) {
  const c = (await getCampaign(id)).data;
  if (c.rotor) throw new ConflictError("This campaign came from Rotor. It is history and is never sent again.");
  if (!["draft", "tested"].includes(c.status)) throw new ConflictError("This campaign can't be tested now.");
  if (!c.template_key) throw new InputError("Pick a template first.", "template_key");
  let b = isId(c.bulk_run_id, "bulk_run") ? await getBulkRun(c.bulk_run_id).catch(() => null) : null;
  if (b && !["draft", "ready", "tested"].includes(b.status)) b = null;
  if (!b) {
    const a = await audienceOf(c);
    if (!a.count) throw new ConflictError("Nobody matches this audience yet.");
    if (a.count > MAX_CAMPAIGN_RECIPIENTS) throw new ConflictError(`That is ${a.count} people. One campaign reaches at most ${MAX_CAMPAIGN_RECIPIENTS}: narrow the audience.`);
    b = await createBulkRun({ kind: "campaign", title: c.name, recipients: a.ids, template_key: c.template_key, channel: c.channel, related: { campaign_id: c.id }, requested_by: ctx.user.id }, ctx.write());
    await updateRecord("campaign", id, (x) => ({ ...x, bulk_run_id: b.id, status: "draft", test: {}, audience_preview: { ...(x.audience_preview || {}), count: a.count, excluded: a.excluded, at: nowIso() } }), ctx.write());
  }
  if (b.status === "draft") return { status: "preparing", bulk_run_id: b.id };
  const out = await testBulkRun(b.id, ctx);
  const test = { contact_id: out.run.test.contact_id, sent_at: out.run.test.sent_at, outbox_id: out.run.test.outbox_id || null, mode: out.send.mode, by: ctx.user.id };
  const r = await updateRecord("campaign", id, (x) => ({ ...x, status: "tested", test, audience_preview: { ...(x.audience_preview || {}), prepared: out.run.preview ? { count: out.run.preview.count, excluded: out.run.preview.excluded } : null } }), ctx.write());
  return { status: "tested", campaign: r.data, send: { status: out.send.status, mode: out.send.mode, outbox_id: out.send.outbox_id || null } };
}

// The bulk run's confirm. A run that had already started (the request or the
// queue item died between the confirm and the campaign's own update) is not
// an error and is never started twice: the campaign only catches up.
async function confirmRun(runId, ctx) {
  try {
    return await confirmBulkRun(runId, ctx);
  } catch (e) {
    if (!(e instanceof ConflictError)) throw e;
    const b = await getBulkRun(runId).catch(() => null);
    if (b && ["sending", "sent"].includes(b.status)) return b;
    throw e;
  }
}

// Send now ({ send_at: null }) or at a time. Refused before the test send.
export async function scheduleCampaign(id, body, ctx) {
  const c = (await getCampaign(id)).data;
  if (c.rotor) throw new ConflictError("This campaign came from Rotor. It is history and is never sent again.");
  if (!["tested", "scheduled"].includes(c.status) || !isId(c.bulk_run_id, "bulk_run")) throw new ConflictError("Send the test first, then confirm.");
  const raw = body ? body.send_at : null;
  if (raw === "unschedule") {
    return (await updateRecord("campaign", id, (x) => (x.status === "scheduled" ? { ...x, status: "tested", send_at: null } : null), ctx.write())).data;
  }
  if (raw === null || raw === undefined || raw === "") {
    const b = await confirmRun(c.bulk_run_id, ctx);
    return (await updateRecord("campaign", id, (x) => ({ ...x, status: "sending", send_at: null, started_at: b.confirmed_at || nowIso(), confirmed_by: b.confirmed_by || ctx.user.id, stats: { recipients: (b.recipients || []).length } }), ctx.write())).data;
  }
  const at = Date.parse(raw);
  if (!Number.isFinite(at) || at <= nowMs() + 60000 || at > nowMs() + 90 * 86400000) throw new InputError("Pick a time in the next 90 days.", "send_at");
  const b = await getBulkRun(c.bulk_run_id);
  if (b.status !== "tested") throw new ConflictError("Send the test first, then confirm.");
  const sendAt = new Date(at).toISOString();
  const n = (c.schedule_n || 0) + 1;
  const r = await updateRecord("campaign", id, (x) => ({ ...x, status: "scheduled", send_at: sendAt, schedule_n: n, scheduled_by: ctx.user.id }), ctx.write());
  await enqueue("campaign.start", { type: "campaign", id }, {}, new Date(at), { ns: "done", scope: "campaign", key: `${id}--${n}` }, { data: { campaign_id: id, send_at: sendAt, by: ctx.user.id } });
  return r.data;
}

// Queue kind "campaign.start": the scheduled time came. It confirms the
// bulk run as the person who scheduled it, if the schedule still stands.
export async function startCampaign(h) {
  const d = h.item.data || {};
  const got = isId(d.campaign_id, "campaign") ? await getRecord("campaign", d.campaign_id) : null;
  if (!got) return { result: "skipped:no_campaign" };
  const c = got.data;
  if (c.status !== "scheduled" || c.send_at !== d.send_at) return { result: "skipped:changed" };
  const by = c.scheduled_by || d.by;
  const u = isId(by, "user") ? await getRecord("user", by) : null;
  if (!u || u.data.status !== "active") return { result: "skipped:no_user" };
  const write = () => ({ by, origin: "api", actor_kind: "user", requestId: h.ctx.requestId, mode: h.mode });
  try {
    await confirmRun(c.bulk_run_id, { user: u.data, write });
  } catch (e) {
    if (!(e instanceof ConflictError)) throw e;
    // the template changed since the test (or the run is gone): back to a draft, never a blind send
    await updateRecord("campaign", c.id, (x) => (x.status === "scheduled" ? { ...x, status: "draft", send_at: null, test: {} } : null), write());
    return { result: "skipped:needs_test" };
  }
  await updateRecord("campaign", c.id, (x) => (x.status === "scheduled" ? { ...x, status: "sending", started_at: nowIso(), confirmed_by: by } : null), write());
  return { result: "started" };
}

export async function cancelCampaign(id, ctx) {
  const c = (await getCampaign(id)).data;
  if (c.rotor) throw new ConflictError("This campaign came from Rotor. It is history.");
  if (["sent", "cancelled"].includes(c.status)) throw new ConflictError("This campaign is already finished.");
  if (isId(c.bulk_run_id, "bulk_run")) await cancelBulkRun(c.bulk_run_id, ctx).catch((e) => { if (!(e instanceof ConflictError)) throw e; });
  return (await updateRecord("campaign", id, (x) => ({ ...x, status: "cancelled", send_at: null, finished_at: nowIso() }), ctx.write())).data;
}

// A campaign with its bulk run's progress; a finished run closes the campaign.
export async function campaignWithRun(id, ctx) {
  const got = await getCampaign(id);
  let c = got.data;
  let etag = got.etag;
  const b = isId(c.bulk_run_id, "bulk_run") ? await getBulkRun(c.bulk_run_id).catch(() => null) : null;
  // a run that started while the campaign still says "tested" (its own update never landed): catch up
  if (b && ["tested", "scheduled"].includes(c.status) && ["sending", "sent"].includes(b.status)) {
    const r = await updateRecord("campaign", id, (x) => (["tested", "scheduled"].includes(x.status) ? { ...x, status: "sending", send_at: null, started_at: b.confirmed_at || nowIso(), confirmed_by: b.confirmed_by || null } : null), { ...ctx.write(), audit: false });
    c = r.data; etag = r.etag;
  }
  if (b && c.status === "sending" && ["sent", "failed", "cancelled"].includes(b.status)) {
    const r = await updateRecord("campaign", id, (x) => (x.status === "sending" ? { ...x, status: b.status === "sent" ? "sent" : "cancelled", finished_at: b.finished_at || nowIso(), stats: b.stats || {} } : null), { ...ctx.write(), audit: false });
    c = r.data; etag = r.etag;
  }
  return { campaign: c, etag, run: b ? bulkView(b) : null, results: b ? b.results || {} : {} };
}

export const campaignView = (c, run) => ({
  id: c.id, name: c.name, description: c.description || "", channel: c.channel, template_key: c.template_key || null, audience: c.audience || {}, audience_preview: c.audience_preview || null,
  status: c.status, test: c.test || {}, send_at: c.send_at || null, started_at: c.started_at || null, finished_at: c.finished_at || null,
  stats: run && run.stats && Object.keys(run.stats).length ? run.stats : c.stats || {}, imported: !!c.rotor, rotor: c.rotor ? { number: c.rotor.number || null, campaign_id: c.rotor.campaign_id } : null,
  created_at: c.created_at, run: run ? { id: run.id, status: run.status, preview: run.preview, recipients: run.recipients } : null,
});

// Drafts and tested campaigns waiting for someone (Home's approvals row).
export async function campaignsWaiting() {
  const ix = await readIndex("campaigns", "");
  return ix.rows.filter((r) => r.st === "tested").length;
}

// ------------------------------------------------------------ routes

const r = (method, path, perm, subject, handler, more = {}) => ({ method, path, auth: "session", perm, subject, mode: "inline", handler, ...more });

async function list() {
  const [ix, runs] = await Promise.all([readIndex("campaigns", ""), listBulkRuns({ status: "waiting" })]);
  const rows = ix.rows.map((x) => ({ id: x.id, name: x.n, status: x.st, channel: x.ch, created_at: x.at, send_at: x.sa, finished_at: x.fa, recipients: x.rc, sent: x.se, imported: !!x.ro }))
    .sort((a, b) => String(b.send_at || b.finished_at || b.created_at || "").localeCompare(String(a.send_at || a.finished_at || a.created_at || "")));
  // other bulk sends waiting for a test or a confirm (rain-day notices, rebooks): listed beside the campaigns (§9.2)
  return { data: rows, meta: { bulk_runs: runs.filter((b) => b.kind !== "campaign") } };
}
const create = async (ctx) => { const rec = await createCampaign(ctx.body, ctx); return { status: 201, data: campaignView(rec.data, null), etag: rec.etag }; };
const one = async (ctx) => { const x = await campaignWithRun(ctx.params.id, ctx); return { data: campaignView(x.campaign, x.run), etag: x.etag }; };
const patch = async (ctx) => { const rec = await patchCampaign(ctx.params.id, ctx.body, ctx); return { data: campaignView(rec.data, null), etag: rec.etag }; };
const preview = async (ctx) => ({ data: await previewCampaign(ctx.params.id, ctx) });
async function test(ctx) {
  const out = await testCampaign(ctx.params.id, ctx);
  if (out.status === "preparing") return { status: 202, data: { status: "preparing" } };
  return { data: { status: "tested", campaign: campaignView(out.campaign, null), send: out.send } };
}
const schedule = async (ctx) => ({ data: campaignView(await scheduleCampaign(ctx.params.id, ctx.body || {}, ctx), null) });
const cancel = async (ctx) => ({ data: campaignView(await cancelCampaign(ctx.params.id, ctx), null) });
async function recipients(ctx) {
  const x = await campaignWithRun(ctx.params.id, ctx);
  const want = ctx.query.get("status") || "";
  const names = new Map((await memo(() => readIndex("contacts", ""))).rows.map((row) => [row.id, row.n]));
  const ids = x.run ? (await getBulkRun(x.run.id)).recipients || [] : [];
  const rows = ids.map((cid) => { const v = x.results[cid] || null; return { contact_id: cid, name: names.get(cid) || "", status: v ? v.s : "waiting", reason: v && v.r ? v.r : null }; })
    .filter((row) => !want || row.status === want || (want === "skipped" && ["blocked", "skipped"].includes(row.status)));
  return { data: rows.slice(0, 500), meta: { total: rows.length } };
}

export const campaignRoutes = [
  r("GET", "/campaigns", "campaigns:write", "none", list),
  r("POST", "/campaigns", "campaigns:write", "none", create),
  r("GET", "/campaigns/:id", "campaigns:write", "required", one, { maxCalls: 40 }),
  r("PATCH", "/campaigns/:id", "campaigns:write", "required", patch, { maxCalls: 40 }),
  r("POST", "/campaigns/:id/preview", "campaigns:write", "required", preview, { maxCalls: 70 }),
  r("POST", "/campaigns/:id/test", "campaigns:send", "required", test, { maxCalls: 90, idempotent: false }),
  r("POST", "/campaigns/:id/schedule", "campaigns:send", "required", schedule, { maxCalls: 60 }),
  r("POST", "/campaigns/:id/cancel", "campaigns:write", "required", cancel, { maxCalls: 60 }),
  r("GET", "/campaigns/:id/recipients", "campaigns:write", "required", recipients, { maxCalls: 40 }),
];
