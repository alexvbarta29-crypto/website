// Comms: campaign stats and the text blast (the Rotor guide's K4, K5, K13
// to K15, K18; S26 and S50).
//
// Stats (Rotor's Campaigns tiles), per campaign and in total, worked out
// when asked from the indexes (no per-recipient reads):
//   sent       the bulk run's results that went out (or, in a dry run, went to the Outbox)
//   delivered  the provider's word; "-" (null) until texting is live
//   bounce     the ones the provider refused
//   response   recipients whose thread on the campaign's channel had an inbound
//              message as its last word, or waits for a reply, after the start
//              and within 72 hours of it (the inbox index keeps a thread's last
//              message: a reply someone already answered later still counts
//              when its thread's last word came within the window)
//   job revenue    payments recipients made in the 30 days after the start (paid only)
//   attributed ARR the year value of plans recipients started in those 30 days (live ones)
//   open, click    email tracking (Postmark): "-" (null) until it is connected
//
// The text blast (Flyra's SMS Blast) is a campaign of kind "blast": its words
// are typed here (kept as its own marketing template, blast_{id}, so the
// bulk run, the test send and the confirm are exactly a campaign's), the
// people come from the filters or a CSV with a consent column, the cost
// line uses cfg/sms_pricing, a picture waits on the campaign until picture
// texts are set up, and a follow-up to the people who didn't reply becomes
// its own bulk run when it is due: it waits for a test send and a confirm
// like any other (Approvals). Nothing leaves the site while texting is a
// dry run.

import { readIndex, getRecord, getRecords, createRecord, patchRecord, updateRecord } from "../../../crm-store.mjs";
import { isId } from "../../core/ids.mjs";
import { localDate, addLocalDays } from "../../core/clock.mjs";
import { InputError } from "../../core/errors.mjs";
import { smsSegments } from "../../core/text.mjs";
import { getTemplateByKey } from "../../core/templates.mjs";
import { getBulkRun, createBulkRun } from "../../core/bulk.mjs";
import { MAX_CAMPAIGN_RECIPIENTS } from "./types.mjs";
import { SMS_PRICING_DEFAULTS } from "./inboxes.mjs";

export const RESPONSE_HOURS = 72;
export const ATTRIBUTION_DAYS = 30;
const SENT = new Set(["sent", "queued", "delivered", "already"]);
const LIVE_PLAN = new Set(["active", "paused", "cancelling"]);

// ------------------------------------------------------------ stats (pure)

// → { recipients, sent, dry_run, delivered, failed, responses, response_pct, bounce_pct, job_revenue_cents, arr_cents, open_pct, click_pct }
export function statsFor({ channel = "sms", started_at = null, results = {}, recipients = [] }, { inboxRows = [], payRows = [], planRows = [] } = {}) {
  const vals = Object.entries(results || {});
  const sentIds = vals.filter(([, v]) => v && (SENT.has(v.s) || v.s === "dry_run")).map(([cid]) => cid);
  const sent = vals.filter(([, v]) => v && SENT.has(v.s)).length;
  const dry = vals.filter(([, v]) => v && v.s === "dry_run").length;
  const failed = vals.filter(([, v]) => v && v.s === "failed").length;
  const delivered = vals.some(([, v]) => v && v.s === "delivered") ? vals.filter(([, v]) => v && v.s === "delivered").length : null;
  const who = new Set(sentIds);
  const t0 = started_at ? Date.parse(started_at) : NaN;
  let responses = 0;
  let jobCents = 0;
  let arrCents = 0;
  if (Number.isFinite(t0) && who.size) {
    const end = t0 + RESPONSE_HOURS * 3600000;
    const replied = new Set();
    for (const r of inboxRows) {
      if (!who.has(r.c) || r.ch !== channel) continue;
      const at = Date.parse(r.la || 0);
      if (at > t0 && at <= end && (r.ld === "in" || r.nr)) replied.add(r.c);
    }
    responses = replied.size;
    const from = localDate(new Date(t0));
    const to = addLocalDays(from, ATTRIBUTION_DAYS);
    for (const p of payRows) {
      if (!who.has(p.c) || p.k !== "payment" || p.st !== "succeeded" || p.sim || p.im || p.sh) continue;
      if (p.on && p.on >= from && p.on <= to) jobCents += Math.max(0, (p.a || 0) - (p.tip || 0) - (p.rf || 0));
    }
    for (const p of planRows) {
      if (!who.has(p.c) || !LIVE_PLAN.has(p.st) || p.im) continue;
      const at = Date.parse(p.at || 0);
      if (at >= t0 && at <= t0 + ATTRIBUTION_DAYS * 86400000) arrCents += p.ay || 0;
    }
  }
  const base = sent + dry;
  const pct = (n, d) => (d ? Math.round((n / d) * 1000) / 10 : null);
  return {
    recipients: (recipients || []).length, sent: base, dry_run: dry, delivered, failed, responses,
    response_pct: pct(responses, base), bounce_pct: sent ? pct(failed, sent + failed) : null,
    job_revenue_cents: jobCents, arr_cents: arrCents, open_pct: null, click_pct: null, channel,
  };
}

// The indexes a campaign's window needs: the inbox (open + the start's year), the payments' months, the plans.
async function windowRows(startedAt) {
  const t0 = Date.parse(startedAt);
  const y = localDate(new Date(t0)).slice(0, 4);
  const months = new Set();
  for (let d = 0; d <= ATTRIBUTION_DAYS; d += 10) months.add(localDate(new Date(t0 + d * 86400000)).slice(0, 7));
  months.add(localDate(new Date(t0 + ATTRIBUTION_DAYS * 86400000)).slice(0, 7));
  const [open, year, plans, ...pays] = await Promise.all([
    readIndex("inbox", "open").catch(() => ({ rows: [] })), readIndex("inbox", `y${y}`).catch(() => ({ rows: [] })), readIndex("plans", "").catch(() => ({ rows: [] })),
    ...[...months].map((m) => readIndex("payments", m).catch(() => ({ rows: [] }))),
  ]);
  return { inboxRows: [...open.rows, ...year.rows], planRows: plans.rows, payRows: pays.flatMap((p) => p.rows) };
}

export async function campaignStats(c) {
  if (!isId(c.bulk_run_id, "bulk_run") || !c.started_at) return statsFor({ channel: c.channel });
  const b = await getBulkRun(c.bulk_run_id).catch(() => null);
  if (!b) return statsFor({ channel: c.channel });
  return statsFor({ channel: c.channel, started_at: c.started_at, results: b.results || {}, recipients: b.recipients || [] }, await windowRows(c.started_at));
}

// Totals over the campaigns sent in the last year (at most 40 of them).
export function totalsOf(list) {
  const sum = (k) => list.reduce((t, s) => t + (s[k] || 0), 0);
  const sent = sum("sent");
  const real = list.reduce((t, s) => t + (s.sent - s.dry_run), 0);
  const failed = sum("failed");
  const split = { sms: list.filter((s) => s.channel === "sms").reduce((t, s) => t + s.job_revenue_cents, 0), email: list.filter((s) => s.channel === "email").reduce((t, s) => t + s.job_revenue_cents, 0) };
  return {
    campaigns: list.length, sent, responses: sum("responses"), response_pct: sent ? Math.round((sum("responses") / sent) * 1000) / 10 : null,
    bounce_pct: real ? Math.round((failed / (real + failed)) * 1000) / 10 : null, job_revenue_cents: sum("job_revenue_cents"), arr_cents: sum("arr_cents"),
    revenue_by_channel: split, open_pct: null, click_pct: null,
  };
}

// ------------------------------------------------------------ the text blast

export const blastKey = (campaignId) => `blast_${String(campaignId).slice(3).toLowerCase()}`;
export const followupKey = (campaignId) => `blastfu_${String(campaignId).slice(3).toLowerCase()}`;
export const MAX_BLAST = 1600;

// Its words as its own marketing template (made or changed): the campaign's template_key.
export async function upsertBlastTemplate(key, name, body, ctx) {
  const text = String(body ?? "").trim();
  if (!text) throw new InputError("Write the text first.", "body");
  if (text.length > MAX_BLAST) throw new InputError(`Keep it under ${MAX_BLAST} characters.`, "body");
  if (/reply\s+stop/i.test(text)) throw new InputError("Leave out the opt-out line: it is added for you.", "body");
  const had = await getTemplateByKey(key);
  if (had && had.id) {
    if (had.body !== text) await patchRecord("template", had.id, { body: text, name: String(name).slice(0, 80) }, ctx);
    return key;
  }
  await createRecord("template", { key, name: String(name).slice(0, 80), channel: "sms", category: "marketing", body: text, tags: ["blast"], active: true, built_in: false }, ctx);
  return key;
}

// The cost line (Flyra's "N characters left at this price, about $X"): per person and in all.
export function costOf(body, count, pricing = SMS_PRICING_DEFAULTS, { picture = false } = {}) {
  const segs = Math.max(1, smsSegments(String(body || "") + " Reply STOP to opt out."));
  const each = picture ? pricing.mms_cents : segs * pricing.per_segment_cents;
  return { segments: segs, per_person_cents: Math.round(each * 100) / 100, total_cents: Math.round(each * (count || 0)) };
}

// CSV → the people it names who agreed: a header row with a phone or email column and a consent column.
const TRUE = new Set(["yes", "y", "true", "1", "x", "agreed", "opted in", "opt in", "ok"]);
function csvRows(text) {
  const out = [];
  let row = [];
  let cur = "";
  let q = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (q) { if (ch === '"' && text[i + 1] === '"') { cur += '"'; i++; } else if (ch === '"') q = false; else cur += ch; continue; }
    if (ch === '"') q = true;
    else if (ch === ",") { row.push(cur); cur = ""; }
    else if (ch === "\n" || ch === "\r") { if (ch === "\r" && text[i + 1] === "\n") i++; row.push(cur); out.push(row); row = []; cur = ""; }
    else cur += ch;
  }
  if (cur || row.length) { row.push(cur); out.push(row); }
  return out.filter((r) => r.some((x) => String(x).trim()));
}
const digits = (s) => { const d = String(s || "").replace(/\D/g, ""); return d.length === 11 && d[0] === "1" ? d.slice(1) : d; };
export function parseCsvAudience(text, contactRows) {
  if (typeof text !== "string" || !text.trim()) throw new InputError("Pick a CSV file.", "csv");
  if (text.length > 400000) throw new InputError("That file is too big (2,000 rows at most).", "csv");
  const rows = csvRows(text.replace(/^﻿/, ""));
  const head = (rows.shift() || []).map((h) => String(h).trim().toLowerCase());
  const col = (re) => head.findIndex((h) => re.test(h));
  const ph = col(/phone|mobile|cell|number/);
  const em = col(/e-?mail/);
  const cs = col(/consent|opt(?:ed)?[\s_-]?in|agreed|marketing|subscribed/);
  if (ph < 0 && em < 0) throw new InputError("The file needs a phone or email column.", "csv");
  if (cs < 0) throw new InputError("The file needs a consent column (yes or no for each person): only people who agreed get a text blast.", "csv");
  if (rows.length > MAX_CAMPAIGN_RECIPIENTS) throw new InputError(`At most ${MAX_CAMPAIGN_RECIPIENTS} rows.`, "csv");
  const byPhone = new Map();
  const byEmail = new Map();
  for (const r of contactRows) {
    for (const p of r.p || []) if (!byPhone.has(digits(p))) byPhone.set(digits(p), r.id);
    for (const e of r.e || []) if (!byEmail.has(String(e).toLowerCase())) byEmail.set(String(e).toLowerCase(), r.id);
  }
  const ids = new Set();
  const left = { no_consent: 0, unknown: 0 };
  for (const r of rows) {
    if (!TRUE.has(String(r[cs] || "").trim().toLowerCase())) { left.no_consent += 1; continue; }
    const id = (ph >= 0 && byPhone.get(digits(r[ph]))) || (em >= 0 && byEmail.get(String(r[em] || "").trim().toLowerCase())) || null;
    if (!id) { left.unknown += 1; continue; }
    ids.add(id);
  }
  return { ids: [...ids], rows: rows.length, used: ids.size, left };
}

// Past winners (Flyra's proven drafts, our own): sent campaigns ranked by response.
export async function winners(campaignRows, limit = 5) {
  const sent = campaignRows.filter((r) => r.st === "sent" && !r.ro).slice(0, 20);
  const got = await getRecords("campaign", sent.map((r) => r.id));
  const out = [];
  for (const g of got) {
    const c = g && g.data;
    if (!c || !c.template_key) continue;
    const st = await campaignStats(c);
    const t = await getTemplateByKey(c.template_key).catch(() => null);
    out.push({ id: c.id, name: c.name, response_pct: st.response_pct, sent: st.sent, job_revenue_cents: st.job_revenue_cents, body: t ? t.body : "" });
  }
  return out.sort((a, b) => (b.response_pct || 0) - (a.response_pct || 0)).slice(0, limit);
}

// A follow-up to the people who didn't reply (queue kind "campaign.followup", due
// after_hours after the start): its own bulk run with the follow-up words,
// waiting for a test send and a confirm (nothing goes without them).
export async function startFollowup(h) {
  const d = h.item.data || {};
  const got = isId(d.campaign_id, "campaign") ? await getRecord("campaign", d.campaign_id) : null;
  if (!got) return { result: "skipped:no_campaign" };
  const c = got.data;
  const fu = c.followup || {};
  if (!fu.on || !fu.body || !c.started_at || c.followup_run_id) return { result: "skipped:off" };
  const b = isId(c.bulk_run_id, "bulk_run") ? await getBulkRun(c.bulk_run_id).catch(() => null) : null;
  if (!b) return { result: "skipped:no_run" };
  const rows = await windowRows(c.started_at);
  const t0 = Date.parse(c.started_at);
  const replied = new Set(rows.inboxRows.filter((r) => r.ch === c.channel && Date.parse(r.la || 0) > t0 && (r.ld === "in" || r.nr)).map((r) => r.c));
  const to = Object.entries(b.results || {}).filter(([cid, v]) => v && (SENT.has(v.s) || v.s === "dry_run") && !replied.has(cid)).map(([cid]) => cid);
  if (!to.length) return { result: "skipped:everyone_replied" };
  const by = c.confirmed_by || c.scheduled_by || d.by;
  const write = () => ({ by: by || "system", origin: "worker", actor_kind: "automation", requestId: h.ctx.requestId, mode: h.mode });
  const key = await upsertBlastTemplate(followupKey(c.id), `Follow-up: ${c.name}`, fu.body, write());
  const run = await createBulkRun({ kind: "campaign_followup", title: `Follow-up: ${c.name}`, recipients: to, template_key: key, channel: c.channel, related: { campaign_id: c.id }, requested_by: by || "system" }, write());
  await updateRecord("campaign", c.id, (x) => ({ ...x, followup_run_id: run.id }), write());
  return { result: `ready:${to.length}` };
}

