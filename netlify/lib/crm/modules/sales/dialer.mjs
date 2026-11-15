// Sales module: the Power Dialer (guide-gaps S9, D1-D13, Rotor's Dialer · Queue · Call logs).
//
//   call_log (cl_)    one row per logged call (written by POST /calls):
//                     { contact_id, contact_name, by, outcome, direction, at,
//                     dur_s? (only with business-line calling, S10), src }.
//                     Index "calls" by month (yyyy-mm).
//   dial_queue (dq_)  a person's named queue: { user_id, name, source: { kind:
//                     followups | leads | pipeline | manual, stage?, cadence? },
//                     ids (at most 500 contacts), cursor }. Index "dial-queues"
//                     by person. The built-in "Follow-up calls" queue is today's
//                     call list (calls.mjs callList), not stored.
//   cfg/call_scripts  { scripts: [{ id, name, sections: [{ key, title, body }] }] }
//                     (settings:messaging), one script with Rotor's 6 sections by default.
//
// Calls go out by tel: from the person's own phone until Twilio Voice (S10):
// nothing here dials, texts or sends.

import { getRecord, createRecord, updateRecord, softDelete, readIndex, getSetting } from "../../../crm-store.mjs";
import { deriveId, isId } from "../../core/ids.mjs";
import { nowIso, localDate, now, addLocalDays, isLocalDate, zonedToUtc } from "../../core/clock.mjs";
import { InputError, NotFoundError, ExistsError } from "../../core/errors.mjs";
import { shape, str, enumValue, arr, int, isoTime } from "../../core/validate.mjs";
import { defineType } from "../../core/registry.mjs";
import { contactShard } from "../../core/stats.mjs";
import { callList } from "./calls.mjs";
import { leadRows } from "./board.mjs";
import { CALL_OUTCOMES } from "./types.mjs";
import { W } from "./common.mjs";

export const QUEUE_MAX = 500;
export const QUEUES_PER_PERSON = 20;
export const SOURCE_KINDS = Object.freeze(["leads", "pipeline", "manual"]);
const SHARD = () => contactShard("ct_00000000000000000000");
const view = (r) => { const { _w, ...rest } = r; return rest; };

// ------------------------------------------------------------ types

const reqId = (type, msg) => (v, f) => { if (!isId(v, type)) throw new InputError(msg, f); return v; };
export const callLogRow = (r) => ({ c: r.contact_id, cn: r.contact_name || "", by: r.by || "", out: r.outcome, dir: r.direction, at: r.at, ...(Number.isSafeInteger(r.dur_s) ? { dur: r.dur_s } : {}), src: r.src || "phone" });
export const callLogType = defineType({
  type: "call_log",
  prefix: "cl",
  v: 1,
  validate: (data) => shape(data, {
    contact_id: reqId("contact", "A call is with a contact."),
    contact_name: (v, f) => str(v, { field: f, max: 120 }) || "",
    by: (v, f) => str(v, { field: f, max: 80 }) || "",
    outcome: (v, f) => enumValue(v, CALL_OUTCOMES, { field: f, stored: true }),
    direction: (v, f) => enumValue(v ?? "out", ["in", "out"], { field: f }),
    at: (v, f) => isoTime(v, { field: f, required: true }),
    dur_s: (v, f) => (v === undefined || v === null ? undefined : int(v, { field: f, min: 0, max: 86400 })),
    src: (v, f) => enumValue(v ?? "phone", ["phone", "business_line"], { field: f }),
  }),
  rotorFields: [],
  techFields: ["id"],
  readPerm: "sales:work",
  indexes: [{ name: "calls", shard: (r) => String(r.at || "").slice(0, 7) || null, row: callLogRow }],
  summary: (r) => ({ id: r.id, outcome: r.outcome }),
  example: () => ({ contact_id: "ct_0000000000000000000a", contact_name: "Pat Example", by: "us_0000000000000000000a", outcome: "spoke", direction: "out", at: "2026-11-17T15:00:00.000Z", src: "phone" }),
});

function validateSource(v, f) {
  if (!v || typeof v !== "object") return { kind: "manual" };
  const kind = enumValue(v.kind || "manual", SOURCE_KINDS, { field: `${f}.kind` });
  return { kind, ...(kind === "leads" && v.stage ? { stage: str(v.stage, { field: `${f}.stage`, max: 30 }) } : {}), ...(kind === "pipeline" ? { cadence: str(v.cadence, { field: `${f}.cadence`, max: 40 }), ...(Number.isSafeInteger(v.step) ? { step: v.step } : {}) } : {}) };
}
export const queueRow = (r) => ({ uid: r.user_id, n: r.name, k: (r.source && r.source.kind) || "manual", len: (r.ids || []).length, cur: r.cursor || 0, u: r.updated_at });
export const dialQueueType = defineType({
  type: "dial_queue",
  prefix: "dq",
  v: 1,
  validate: (data) => {
    const out = shape(data, {
      user_id: reqId("user", "A queue is someone's."),
      name: (v, f) => str(v, { field: f, max: 60, required: true }),
      source: (v, f) => validateSource(v, f),
      ids: (v, f) => [...new Set(arr(v ?? [], (x, ff) => reqId("contact", "That isn't a contact.")(x, ff), { field: f, max: QUEUE_MAX }))],
      cursor: (v, f) => int(v ?? 0, { field: f, min: 0, max: QUEUE_MAX }),
    });
    if (out.cursor > Math.max(0, out.ids.length - 1)) out.cursor = Math.max(0, out.ids.length - 1);
    return out;
  },
  rotorFields: [],
  techFields: ["id"],
  readPerm: "sales:work",
  indexes: [{ name: "dial-queues", shard: (r) => (r.deleted_at ? null : r.user_id), row: queueRow }],
  summary: (r) => ({ id: r.id, name: r.name }),
  example: () => ({ user_id: "us_0000000000000000000a", name: "New leads", source: { kind: "leads", stage: "new" }, ids: [], cursor: 0 }),
});
export const dialerTypes = [callLogType, dialQueueType];

// ------------------------------------------------------------ the call log

// After POST /calls (calls.mjs logCall) answered: one row (a replay of the same client id is the same row).
export async function recordCall(out, body, ctx) {
  const call = out && out.data && out.data.call;
  if (!call || !call.id || call.outcome === "calling") return null;
  const contact = await getRecord("contact", call.contact_id).catch(() => null);
  const id = deriveId("call_log", `call:${call.id}`);
  try {
    await createRecord("call_log", { id, contact_id: call.contact_id, contact_name: (contact && contact.data.display_name) || "", by: (ctx.user && ctx.user.id) || W(ctx).by, outcome: call.outcome, direction: call.direction || "out", at: call.at || nowIso(), src: "phone" }, W(ctx));
  } catch (e) { if (!(e instanceof ExistsError)) console.error(`crm:sales: call log row not written (${(e && e.code) || "error"})`); }
  return id;
}

function months(from, to) {
  const out = [];
  let m = from.slice(0, 7);
  for (let i = 0; i < 25 && m <= to.slice(0, 7); i++) { out.push(m); const [y, mo] = m.split("-").map(Number); m = mo === 12 ? `${y + 1}-01` : `${y}-${String(mo + 1).padStart(2, "0")}`; }
  return out;
}
async function callsBetween(q) {
  const today = localDate(now());
  const from = isLocalDate(q.get("from")) ? q.get("from") : addLocalDays(today, -29);
  const to = isLocalDate(q.get("to")) ? q.get("to") : today;
  if (to < from) throw new InputError("Pick the dates.", "from");
  const shards = await Promise.all(months(from, to).map((m) => readIndex("calls", m)));
  const lo = zonedToUtc(from, "00:00").toISOString(), hi = zonedToUtc(addLocalDays(to, 1), "00:00").toISOString();
  const by = str(q.get("by")), out = str(q.get("out")), w = str(q.get("q")).toLowerCase();
  const rows = shards.flatMap((x) => x.rows).filter((r) => r.at >= lo && r.at < hi && (!by || r.by === by) && (!out || r.out === out) && (!w || String(r.cn).toLowerCase().includes(w)))
    .sort((a, b) => String(b.at).localeCompare(String(a.at)));
  return { from, to, rows };
}

const ANSWERED = ["spoke", "booked", "not_interested"];
// The Call logs tiles (pure): total, answered, voicemails, completed (any final outcome), today, avg duration
// (only rows with one: business-line calling), calls per hour (calls ÷ the distinct clock hours that had one).
export function callStats(rows, today) {
  const durs = rows.map((r) => r.dur).filter(Number.isSafeInteger);
  const hours = new Set(rows.map((r) => String(r.at).slice(0, 13)));
  const per = {};
  for (const r of rows) { const p = per[r.by] || (per[r.by] = { total: 0, answered: 0, booked: 0, not_interested: 0 }); p.total += 1; if (ANSWERED.includes(r.out)) p.answered += 1; if (r.out === "booked") p.booked += 1; if (r.out === "not_interested") p.not_interested += 1; }
  return {
    total: rows.length, answered: rows.filter((r) => ANSWERED.includes(r.out)).length, voicemails: rows.filter((r) => r.out === "voicemail").length,
    completed: rows.filter((r) => r.out !== "calling").length, today: rows.filter((r) => localDate(new Date(r.at)) === today).length,
    avg_duration_s: durs.length ? Math.round(durs.reduce((a, b) => a + b, 0) / durs.length) : null,
    per_hour: hours.size ? Math.round((rows.length / hours.size) * 10) / 10 : 0, by_person: per,
  };
}

async function logsRoute(ctx) {
  const { from, to, rows } = await callsBetween(ctx.query);
  return { data: rows.slice(0, 500), meta: { from, to, total: rows.length } };
}
async function statsRoute(ctx) {
  const { from, to, rows } = await callsBetween(ctx.query);
  return { data: { from, to, ...callStats(rows, localDate(now())) } };
}

// ------------------------------------------------------------ queues

// The contacts a source names (pure over what the server read). followups: today's call list order.
export function sourceIds(source, { calls = null, leads = [], enrollments = [] } = {}) {
  if (!source) return [];
  if (source.kind === "followups") return [...new Set([...(calls ? [...calls.due, ...calls.later] : [])].map((r) => r.contact_id).filter(Boolean))];
  if (source.kind === "leads") return leads.filter((r) => !source.stage || r.stage === source.stage).sort((a, b) => String(b.ca || "").localeCompare(String(a.ca || ""))).map((r) => r.id);
  if (source.kind === "pipeline") return [...new Set(enrollments.filter((e) => e.cad === source.cadence && (!source.step || e.n === source.step)).map((e) => e.c))];
  return [];
}
async function fillIds(source) {
  if (source.kind === "leads") {
    const [ix, deals, enr] = await Promise.all([readIndex("contacts", SHARD()), readIndex("deals/open", ""), readIndex("enrollments/active", "")]);
    return sourceIds(source, { leads: leadRows(ix.rows, deals.rows, enr.rows) }).slice(0, QUEUE_MAX);
  }
  if (source.kind === "pipeline") return sourceIds(source, { enrollments: (await readIndex("enrollments/active", "")).rows }).slice(0, QUEUE_MAX);
  return [];
}

async function mine(ctx, id) {
  if (!isId(id, "dial_queue")) throw new NotFoundError("That queue isn't there.");
  const got = await getRecord("dial_queue", id);
  if (!got || got.data.deleted_at || got.data.user_id !== ctx.user.id) throw new NotFoundError("That queue isn't there.");
  return got;
}
// Rows for a list of contact ids, in that order (from the contacts index: no extra reads).
async function rowsFor(ids) {
  const ix = await readIndex("contacts", SHARD());
  const by = new Map(ix.rows.map((r) => [r.id, r]));
  return ids.map((id) => by.get(id)).filter((r) => r && r.lc !== "archived").map((r) => ({ id: r.id, n: r.n || "", p: (r.p || [])[0] || null, lc: r.lc, src: r.src || "", c: r.c || "" }));
}

async function queuesRoute(ctx) {
  const ix = await readIndex("dial-queues", ctx.user.id);
  return { data: [{ id: "followups", name: "Follow-up calls", kind: "followups", builtin: true }, ...ix.rows.map((r) => ({ id: r.id, name: r.n, kind: r.k, n: r.len, cursor: r.cur }))] };
}
async function newQueueRoute(ctx) {
  const b = ctx.body || {};
  const ix = await readIndex("dial-queues", ctx.user.id);
  if (ix.rows.length >= QUEUES_PER_PERSON) throw new InputError(`Keep it to ${QUEUES_PER_PERSON} queues.`, "name");
  const source = validateSource(b.source, "source");
  if (source.kind === "pipeline" && !/^[a-z][a-z0-9_]{1,39}$/.test(source.cadence || "")) throw new InputError("Pick a pipeline.", "source.cadence");
  const ids = Array.isArray(b.ids) && source.kind === "manual" ? b.ids.slice(0, QUEUE_MAX) : await fillIds(source);
  const r = await createRecord("dial_queue", { user_id: ctx.user.id, name: b.name, source, ids, cursor: 0 }, ctx.write());
  return { status: 201, data: { queue: view(r.data) }, etag: r.etag };
}
async function queueRoute(ctx) {
  if (ctx.params.id === "followups") {
    const calls = await callList();
    const ids = sourceIds({ kind: "followups" }, { calls });
    return { data: { queue: { id: "followups", name: "Follow-up calls", source: { kind: "followups" }, ids, cursor: 0, builtin: true }, rows: await rowsFor(ids) } };
  }
  const got = await mine(ctx, ctx.params.id);
  return { data: { queue: view(got.data), rows: await rowsFor(got.data.ids) }, etag: got.etag };
}
async function patchQueueRoute(ctx) {
  if (!ctx.ifMatch) throw new InputError("This change needs the version you edited (If-Match).", "if-match");
  const got = await mine(ctx, ctx.params.id);
  const b = ctx.body || {};
  const r = await updateRecord("dial_queue", got.data.id, (q) => ({
    ...q, ...(b.name !== undefined ? { name: b.name } : {}), ...(Array.isArray(b.ids) ? { ids: b.ids } : {}), ...(Number.isSafeInteger(b.cursor) ? { cursor: b.cursor } : {}),
  }), { ...ctx.write(), ifMatch: ctx.ifMatch });
  return { data: { queue: view(r.data) }, etag: r.etag };
}
// Call next / Previous / Skip: the cursor moves (Skip leaves the contact in the queue, at the end).
export function stepQueue(q, dir) {
  const n = (q.ids || []).length;
  if (!n) return null;
  const cur = Math.min(q.cursor || 0, n - 1);
  if (dir === "prev") return cur === 0 ? null : { ...q, cursor: cur - 1 };
  if (dir === "skip") { const ids = [...q.ids]; const [x] = ids.splice(cur, 1); ids.push(x); return n === 1 ? null : { ...q, ids, cursor: cur >= n - 1 ? 0 : cur }; }
  return cur >= n - 1 ? null : { ...q, cursor: cur + 1 };
}
async function stepRoute(ctx) {
  const dir = str((ctx.body || {}).dir);
  if (!["next", "prev", "skip"].includes(dir)) throw new InputError("Next, previous or skip.", "dir");
  const got = await mine(ctx, ctx.params.id);
  const r = await updateRecord("dial_queue", got.data.id, (q) => stepQueue(q, dir), ctx.write());
  return { data: { queue: view(r.data) }, etag: r.etag };
}
async function clearRoute(ctx) {
  const got = await mine(ctx, ctx.params.id);
  const r = await updateRecord("dial_queue", got.data.id, (q) => (q.ids.length ? { ...q, ids: [], cursor: 0 } : null), ctx.write());
  return { data: { queue: view(r.data) }, etag: r.etag };
}
async function deleteQueueRoute(ctx) {
  const got = await mine(ctx, ctx.params.id);
  await softDelete("dial_queue", got.data.id, ctx.write());
  return { data: { deleted: true } };
}

// ------------------------------------------------------------ scripts

export const DEFAULT_SCRIPT = Object.freeze({
  id: "default", name: "New lead call",
  sections: [
    { key: "opening", title: "Opening", body: "Hi, this is [your name] with Barta Window Washing. You asked about getting your windows cleaned. Is now a good time for a quick minute?" },
    { key: "purpose", title: "Purpose", body: "I want to get you a price and find a day that works." },
    { key: "discovery", title: "Discovery questions", body: "How many stories is the house? Inside and out, or just outside? Screens and tracks too? Any gutters that need a look?" },
    { key: "value", title: "Value", body: "We're local, insured, and if anything isn't right we come back and re-clean it free." },
    { key: "next", title: "Next steps", body: "I can text you a quote right now, and we have openings next week." },
    { key: "closing", title: "Closing", body: "Thanks so much. You'll get a text from us with the details." },
  ],
});
export const SCRIPTS_DEFAULTS = Object.freeze({ scripts: [DEFAULT_SCRIPT] });
export function validateScripts(v) {
  const scripts = arr(v && v.scripts, (s, f) => ({
    id: str(s && s.id, { field: `${f}.id`, max: 40 }) || `s${Math.random().toString(36).slice(2, 8)}`,
    name: str(s && s.name, { field: `${f}.name`, max: 60, required: true }),
    sections: arr(s && s.sections, (x, ff) => ({ key: str(x && x.key, { field: `${ff}.key`, max: 30 }) || "part", title: str(x && x.title, { field: `${ff}.title`, max: 60, required: true }), body: str(x && x.body, { field: `${ff}.body`, max: 2000, trim: false }) || "" }), { field: `${f}.sections`, max: 12 }),
  }), { field: "scripts", max: 20 });
  return { scripts };
}
async function scriptsRoute(ctx) {
  const cfg = await getSetting("call_scripts").catch(() => null);
  return { data: (cfg && Array.isArray(cfg.scripts) && cfg.scripts.length ? cfg.scripts : SCRIPTS_DEFAULTS.scripts) };
}

const R = (method, path, perm, subject, handler, extra = {}) => ({ method, path, auth: "session", perm, subject, mode: "inline", handler, ...extra });
export const dialerRoutes = [
  R("GET", "/calls/logs", "sales:work", "none", logsRoute, { maxCalls: 30 }),
  R("GET", "/calls/stats", "sales:work", "none", statsRoute, { maxCalls: 30 }),
  R("GET", "/dialer/queues", "sales:work", "none", queuesRoute),
  R("POST", "/dialer/queues", "sales:work", "none", newQueueRoute, { maxCalls: 30 }),
  R("GET", "/dialer/queues/:id", "sales:work", "none", queueRoute, { maxCalls: 40 }),
  R("PATCH", "/dialer/queues/:id", "sales:work", "none", patchQueueRoute),
  R("POST", "/dialer/queues/:id/step", "sales:work", "none", stepRoute),
  R("POST", "/dialer/queues/:id/clear", "sales:work", "none", clearRoute),
  R("DELETE", "/dialer/queues/:id", "sales:work", "none", deleteQueueRoute),
  R("GET", "/dialer/scripts", "sales:work", "none", scriptsRoute),
];
