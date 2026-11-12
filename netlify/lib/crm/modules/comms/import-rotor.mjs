// Comms module: the Rotor import phases (design §10.1 contract, §10.2 rows
// 16, 32, 33 and 35). The framework (staging, the runner on the bulk lane,
// field ownership, the report) is M2c's. Rotor stays exactly as it is: these
// phases read an export someone made, never Rotor itself.
//
//   row 16  message templates (45) → template: Barta's 26 (Rotor's 19
//           examples are skipped) under their own keys ("rotor_<name>_<id>"),
//           so a seeded or edited CRM template is never overwritten;
//           {first_name} → {{first_name}}; a typed "Reply STOP to opt out."
//           is stripped (the sender adds the footer, D5) and counted in the
//           report; Review 1/2/3 are service texts, everything else
//           marketing; the giveaway, referral and test ones arrive inactive;
//           the two HTML emails keep their HTML (sanitized, the hot-linked
//           image re-pointed to the site's copy).
//   row 33  campaigns (31) → campaign, status "sent", with Rotor's name,
//           description (the audience notes), template and number. Rotor
//           does not export who got what (D36): the messages are the record.
//   row 32  messages (10,927) → message + conversation (below).
//   row 35  map pin types (8) → cfg/pin_types, kept for a later knock map.
//
// Messages, and why this phase writes them itself.
// A message is written once and never edited, and there are many (about 33
// MB of bodies), so it does not go through the per-field ownership the
// other phases use (no ib/ base, no ptr/rotor pointer: the id is
// idForRotor("message", rotor id), a pure function). One write for the
// record, one for its place in the thread:
//
//   rec/message/{id}                      the message (email HTML sanitized, its text extracted)
//   rel/conv-messages/{convId}/{ts}--{id} its place in the thread
//
// A conversation is (contact, channel). prepare() looks at every staged row
// once, before the phase's first row: it groups the rows by Rotor contact
// and channel, finds each group's contact (ptr/rotor, following merges; a
// contact the export lacks becomes a placeholder) and its conversation, and
// saves one summary per group (imp/{runId}/raw/comms-conv/{nnnn}: staging,
// deleted with the staged rows): a digest of the group's message ids and
// statuses, its newest message, which row is its last in the staged order,
// and whether the conversation already holds exactly these messages. Those
// lookups run side by side, so a step that resumes later repeats none of
// them. map() then, per row:
//   - a group the conversation already holds is skipped without a single
//     storage call (an unchanged export writes nothing; a re-run costs three
//     reads per conversation, all in prepare());
//   - otherwise the message is created (onlyIfNew; one already there only
//     has its status moved forward), and on the group's last row the
//     conversation is created or brought up to date: last message, the
//     read/done rule of §5.7.1 (open and unread only when the last message
//     is inbound, under 14 days old and unanswered), Rotor's thread ids, the
//     group's digest; the contact's comms stats (first text from the main
//     number, last contact, last inbound) follow.
// Attachments become the files the upload already stored (the import never
// fetches a URL); one that was not uploaded is counted on the message.
// The contact's Activity gets one row per imported thread, not one per
// message (11,000 keys less; every message is in the thread).

import { createHash } from "node:crypto";
import { getRecord, createRecord, updateRecord, updateStats, getRaw, putRaw, readPointer, listRel, addRel, addActivity, putSetting, getSetting, ExistsError } from "../../../crm-store.mjs";
import { idForRotor, isId } from "../../core/ids.mjs";
import { nowIso, nowMs, tsKey } from "../../core/clock.mjs";
import { convertImportSyntax, parseTemplate, TEMPLATE_KEY_RE, SMS_MAX } from "../../core/templates.mjs";
import { RowError, placeholderContact, MAIN_NUMBER } from "../contacts/import-rotor.mjs";
import { rotorKey, fixMojibake, displayName } from "../contacts/display.mjs";
import { previewOf, statusMayMove, TEXT_MAX } from "./types.mjs";
import { convIdFor } from "./conversations.mjs";
import { looksLikeHtml, sanitizeHtml, htmlText, repointImages } from "./html-sanitize.mjs";

const str = (v) => (v == null ? "" : String(v)).trim();
const plain = (v) => !!v && typeof v === "object" && !Array.isArray(v);
const ROTOR_ID = /^(?!\.+$)[A-Za-z0-9_.-]{1,64}$/;
const sha = (s) => createHash("sha256").update(String(s)).digest("hex");
// Rotor's timestamps are UTC; one without an offset (campaign updated_at) is UTC too (§10.6)
const iso = (v) => {
  const s = str(v);
  if (!s) return null;
  const t = Date.parse(/[zZ]|[+-]\d\d:?\d\d$/.test(s) ? s : s + "Z");
  return Number.isNaN(t) ? null : new Date(t).toISOString();
};
function needId(row) {
  if (!plain(row)) throw new RowError("row");
  const id = str(row.id);
  if (!ROTOR_ID.test(id)) throw new RowError("id");
  return id;
}

// The import's own write context for the records this file writes itself:
// an import (exempt from the parallel-run guard), no index rows (the run
// rebuilds them), no per-record audit events.
export const ICTX = Object.freeze({ by: "import", origin: "import", actor_kind: "import", requestId: "import", bulk: true, audit: false });

// ------------------------------------------------------------ row 16: templates

// "Reply STOP to opt out." and Rotor's " Reply stop to opt-out." (D5: the sender adds the footer).
const STOP_TAIL = /\s*(?:reply|text|txt|send)\s+["'“”]?stop["'“”]?\s+to\s+(?:opt[\s-]?out|unsubscribe|unsub|end|quit|cancel)\s*[.!]?/gi;
export function stripStop(body) {
  const s = String(body ?? "");
  const out = s.replace(STOP_TAIL, "").replace(/[ \t]+$/gm, "").trimEnd();
  return { text: out, stripped: out !== s.trimEnd() };
}

const slug = (s) => str(s).toLowerCase().normalize("NFD").replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "");
export const templateKeyFor = (name, rotorId) => `rotor_${slug(name).slice(0, 26).replace(/_+$/, "") || "template"}_${sha(rotorId).slice(0, 6)}`;
// §5.7.3: Rotor's "Review 1/2/3" are service texts (a follow-up about the visit they just had); the rest is marketing.
export const templateCategory = (name) => (/^review\s*[123]\b/i.test(str(name)) ? "service" : "marketing");
const RETIRED = /giveaway|referral|test message/i;

export function normalizeTemplate(row) {
  const id = needId(row);
  const type = str(row.type || row.channel).toLowerCase();
  if (!["sms", "email"].includes(type)) throw new RowError("type");
  if (typeof row.content !== "string" || !row.content.trim()) throw new RowError("content");
  if (row.content.length > 100000) throw new RowError("content");
  return {
    id, name: fixMojibake(str(row.name)).slice(0, 80) || "Rotor template", channel: type, subject: row.subject == null ? "" : fixMojibake(str(row.subject)).slice(0, 150),
    content: fixMojibake(row.content), tags: Array.isArray(row.tags) ? row.tags.map((t) => str(t).slice(0, 40)).filter(Boolean).slice(0, 8) : [],
    is_example: row.is_example === true, created_at: iso(row.created_at), updated_at: iso(row.updated_at),
  };
}

export async function mapTemplate(t, ctx) {
  if (t.is_example) return { warnings: ["template_rotor_example_skipped"] };
  const warnings = [];
  const giveaway = t.tags.some((x) => /giveaway/i.test(x)) || /giveaway/i.test(t.name);
  const retired = giveaway || RETIRED.test(t.name);
  const data = {
    id: (await ctx.lookup("template", t.id)) || idForRotor("template", t.id),
    key: templateKeyFor(t.name, t.id), name: t.name, channel: t.channel, category: templateCategory(t.name),
    tags: [...new Set([...t.tags, "rotor", ...(giveaway ? ["archived"] : [])])].slice(0, 10), active: !retired, built_in: false,
    rotor: { template_id: t.id, is_example: false, ...(t.created_at ? { created_at: t.created_at } : {}), ...(t.updated_at ? { updated_at: t.updated_at } : {}) },
  };
  if (!TEMPLATE_KEY_RE.test(data.key)) return { warnings: ["template_bad_key"] };
  if (t.channel === "email" && looksLikeHtml(t.content)) {
    const c = stripStop(convertImportSyntax(repointImages(t.content)));
    data.body_html = c.text;
    data.body = "";
    data.subject = convertImportSyntax(t.subject) || t.name;
  } else {
    const c = stripStop(convertImportSyntax(t.content));
    if (c.stripped) warnings.push("template_stop_text_stripped");
    data.body = c.text;
    if (t.channel === "email") data.subject = convertImportSyntax(t.subject) || t.name;
    if (t.channel === "sms" && Array.from(data.body).length > SMS_MAX) return { warnings: ["template_too_long"] };
  }
  // what the template validator would refuse is left out, with its reason, never half-imported
  const problems = [...parseTemplate(data.body || "").errors, ...(data.subject ? parseTemplate(data.subject).errors : [])];
  if (problems.length) return { warnings: [`template_skipped_${problems[0].code}`] };
  return { records: [{ type: "template", data }], pointers: [{ kind: "rotor/template", key: rotorKey(t.id), value: { id: data.id } }], warnings };
}

// ------------------------------------------------------------ row 33: campaigns

export function normalizeCampaign(row) {
  const id = needId(row);
  const sp = plain(row.sms_provider) ? row.sms_provider : {};
  return {
    id, name: fixMojibake(str(row.name)).slice(0, 120) || `Rotor campaign ${id}`, description: fixMojibake(str(row.description)).slice(0, 2000), status_raw: str(row.status).slice(0, 20),
    template: str(row.messaging_template_id), number: /^\+1\d{10}$/.test(str(sp.number)) ? str(sp.number) : null, provider: str(sp.name).slice(0, 20) || null,
    created_at: iso(row.created_at), updated_at: iso(row.updated_at),
  };
}

export async function mapCampaign(c, ctx) {
  const warnings = [];
  let tpl = null;
  const tplId = c.template && ROTOR_ID.test(c.template) ? await ctx.lookup("template", c.template) : null;
  if (tplId) {
    const got = (ctx.cache.tpl ||= new Map()).has(tplId) ? ctx.cache.tpl.get(tplId) : await getRecord("template", tplId);
    ctx.cache.tpl.set(tplId, got);
    tpl = got ? got.data : null;
  }
  if (!tpl) warnings.push("campaign_template_missing");
  const id = (await ctx.lookup("campaign", c.id)) || idForRotor("campaign", c.id);
  const data = {
    id, name: c.name, description: c.description, channel: tpl ? tpl.channel : "sms", ...(tpl ? { template_id: tpl.id, template_key: tpl.key } : {}),
    audience: {}, status: "sent", test: {}, stats: {}, results: {},
    rotor: { campaign_id: /^\d+$/.test(c.id) ? Number(c.id) : c.id, ...(c.template ? { template_id: c.template } : {}), ...(c.status_raw ? { status_raw: c.status_raw } : {}), ...(c.number ? { number: c.number } : {}), ...(c.provider ? { provider: c.provider } : {}), ...(c.updated_at ? { updated_at: c.updated_at } : {}) },
    ...(c.created_at ? { created_at: c.created_at, finished_at: c.created_at } : {}),
  };
  return { records: [{ type: "campaign", data }], pointers: [{ kind: "rotor/campaign", key: rotorKey(c.id), value: { id } }], warnings };
}

// ------------------------------------------------------------ row 35: pin types

const pinOf = (row) => (plain(row) && str(row.label) ? { rotor_id: str(row.id).slice(0, 64), label: str(row.label).slice(0, 40), color: /^#[0-9a-f]{3,8}$/i.test(str(row.color)) ? str(row.color) : "", active: row.is_active !== false } : null);
const preparePins = (rows) => ({ types: rows.map(pinOf).filter(Boolean).slice(0, 50) });
async function finishPins(ctx) {
  const types = (ctx.prepared && ctx.prepared.types) || [];
  if (!types.length) return;
  const cur = await getSetting("pin_types");
  if (JSON.stringify(cur.types || []) === JSON.stringify(types)) return;
  await putSetting("pin_types", { types }, { by: "import", origin: "import", actor_kind: "import", requestId: "import" });
}

// ------------------------------------------------------------ row 32: messages

export const UNANSWERED_DAYS = 14;
export const SUMMARY_PART = 300;
const STATUS = { delivered: "delivered", sent: "sent", received: "received", failed: "failed", undelivered: "undelivered", blocked: "blocked", queued: "queued" };
// (under raw/, so the staging clean-up deletes it with the rows; the hyphen keeps it out of the entity list)
export const summaryKey = (runId, n) => `imp/${runId}/raw/comms-conv/${String(n).padStart(4, "0")}`;
export const PREPARE_PARALLEL = 12;

export function normalizeMessage(row) {
  const id = needId(row);
  const contact = str(row.contact_id);
  if (!ROTOR_ID.test(contact)) throw new RowError("contact_id");
  const channel = str(row.channel).toLowerCase();
  if (!["sms", "email"].includes(channel)) throw new RowError("channel");
  const dir = str(row.direction).toLowerCase();
  if (!["inbound", "outbound"].includes(dir)) throw new RowError("direction");
  const at = iso(row.created_at);
  if (!at) throw new RowError("created_at");
  if (row.content != null && typeof row.content !== "string") throw new RowError("content");
  const inbound = dir === "inbound";
  const raw = str(row.status).toLowerCase();
  return {
    id, contact, contact_type: str(row.contact_type).toLowerCase() === "customer" ? "customer" : "lead", channel, inbound, at,
    content: fixMojibake(row.content || ""), subject: row.subject == null ? "" : fixMojibake(str(row.subject)).slice(0, 300),
    status: STATUS[raw] || (inbound ? "received" : "sent"), status_raw: raw.slice(0, 30), read: row.read !== false,
    thread: str(row.thread_id).slice(0, 120), phone: /^\+1\d{10}$/.test(str(row.contact_phone)) ? str(row.contact_phone) : "", email: str(row.contact_email).toLowerCase().slice(0, 200),
    attachments: Array.isArray(row.attachments) ? row.attachments.filter((a) => plain(a) && typeof a.url === "string" && a.url).slice(0, 10).map((a) => ({ url: a.url, name: str(a.name).slice(0, 120) })) : [],
  };
}

// What Rotor's own system sent (rotor-comms §7.3), so the cutover can seed
// the matching done/ markers (§5.7.4) and the thread can say what it was.
export function classify(m) {
  const t = m.channel === "email" ? `${m.subject} ` : m.content;
  if (m.inbound) return null;
  if (/^REMINDER:/i.test(t)) return "reminder";
  if (/still outstanding|invoice from .* is (still )?(outstanding|overdue)/i.test(t)) return "overdue";
  if (/thanks for your payment|^your receipt from/i.test(t)) return "receipt";
  if (/awaiting your signature|please sign your agreement/i.test(t)) return "agreement";
  if (/thanks for reaching out to barta/i.test(t)) return "lead_ack";
  if (/^your quote from|here is your quote from/i.test(t)) return "quote";
  return null;
}
const originOf = (cls) => (cls === "lead_ack" ? { kind: "automation", id: "lead.ack" } : ["reminder", "overdue", "receipt", "agreement"].includes(cls) ? { kind: "system" } : { kind: "import" });

const textOf = (m) => (m.channel === "email" && looksLikeHtml(m.content) ? htmlText(m.content, { max: TEXT_MAX }) : Array.from(m.content).slice(0, TEXT_MAX).join(""));
const groupKey = (m) => `${m.contact}|${m.channel}`;

// The live contact behind an id (a contact merged away since points at the
// one that survives). → { id, data } | null
async function liveContact(id) {
  let cur = id;
  for (let i = 0; i < 6 && isId(cur, "contact"); i++) {
    const got = await getRecord("contact", cur);
    if (!got) return null;
    const next = got.data.merged_into || got.data.merging_into;
    if (!next || next === cur) return { id: cur, data: got.data };
    cur = next;
  }
  return null;
}
const srcKeyOf = (rid) => rotorKey(rid).replace(/\./g, "_");
const holds = (conv, src, g) => !!(conv && conv.rotor && conv.rotor.sources && conv.rotor.sources[src] && conv.rotor.sources[src].d === g.d && conv.rotor.sources[src].n === g.n);

// A group's contact and conversation: two reads when the conversation
// already holds the group, three for a new one (a merged contact a few more).
async function locate(rid, channel, g) {
  const src = srcKeyOf(rid);
  let ptr = await readPointer(`rotor/${g.type}`, rotorKey(rid));
  if (!ptr || !isId(ptr.id, "contact")) ptr = await readPointer(`rotor/${g.type === "lead" ? "customer" : "lead"}`, rotorKey(rid));
  let direct;
  if (ptr && isId(ptr.id, "contact")) {
    direct = await getRecord("conversation", convIdFor(ptr.id, channel));
    if (direct && holds(direct.data, src, g)) { g.cid = ptr.id; g.cv = direct.data.id; g.has = true; g.u = true; return; }
  }
  const live = ptr && isId(ptr.id, "contact") ? await liveContact(ptr.id) : null;
  if (live) {
    g.cid = live.id;
    g.name = live.data.display_name || displayName(live.data) || "";
    g.lc = live.data.lifecycle || "";
  } else {
    // a contact the export does not have (an archived lead): a placeholder under exactly idForRotor (§10.2 row 9)
    g.cid = placeholderContact(rid, { kind: g.type }).data.id;
    g.ph = true;
    g.name = "Rotor contact (missing)";
    g.lc = "archived";
  }
  g.cv = convIdFor(g.cid, channel);
  // (already read above unless the contact was merged into another)
  const conv = ptr && g.cid === ptr.id && direct !== undefined ? direct : await getRecord("conversation", g.cv);
  if (conv) { g.has = true; if (holds(conv.data, src, g)) g.u = true; }
}

async function inParallel(items, limit, fn) {
  let next = 0;
  const worker = async () => { while (next < items.length) { const i = next++; await fn(items[i]); } };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
}

// Looks at every staged row once (the runner calls it before the phase's
// first row) and saves one summary per (Rotor contact, channel).
export async function prepareMessages(rows, ctx) {
  const groups = new Map();
  let valid = 0;
  for (const raw of rows) {
    let m;
    try { m = normalizeMessage(raw); } catch { continue; }
    valid += 1;
    const k = groupKey(m);
    let g = groups.get(k);
    if (!g) { g = { n: 0, lines: [], seq: [], first: m.id, end: null, type: m.contact_type, threads: [], address: "", first_out: null, last_out: null, last_in: null }; groups.set(k, g); }
    g.n += 1;
    g.end = m.id;
    g.lines.push(`${m.id}:${m.status}:${m.read ? 1 : 0}`);
    g.seq.push([m.at, m.inbound ? 1 : 0, m.id]);
    if (m.thread && g.threads.length < 12 && !g.threads.includes(m.thread)) g.threads.push(m.thread);
    const addr = m.channel === "sms" ? m.phone : m.email;
    if (addr && (!g.addr_at || m.at >= g.addr_at)) { g.address = addr; g.addr_at = m.at; }
    if (m.inbound) { if (!g.last_in || m.at > g.last_in) g.last_in = m.at; } else {
      if (!g.last_out || m.at > g.last_out) g.last_out = m.at;
      if (m.channel === "sms" && (!g.first_out || m.at < g.first_out)) g.first_out = m.at;
    }
    if (!g.last || m.at >= g.last.at) g.last = { at: m.at, in: m.inbound, id: m.id, m };
  }
  const out = [];
  for (const [k, g] of groups) {
    g.seq.sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : a[2] < b[2] ? -1 : 1));
    let trailing = 0;
    for (let i = g.seq.length - 1; i >= 0 && g.seq[i][1] === 1; i--) trailing += 1;
    const lm = g.last.m;
    out.push([k, {
      n: g.n, d: sha(g.lines.sort().join("\n")).slice(0, 24), first: g.first, end: g.end, type: g.type, threads: g.threads, address: g.address, first_at: g.seq[0][0],
      first_out: g.first_out, last_out: g.last_out, last_in: g.last_in, trailing_in: trailing,
      last: { at: g.last.at, in: g.last.in, id: g.last.id, preview: previewOf(lm.channel === "email" && lm.subject ? lm.subject : textOf(lm)) },
    }]);
  }
  // each group's contact and conversation, side by side (the only reads a re-run makes)
  await inParallel(out, PREPARE_PARALLEL, ([k, g]) => locate(k.slice(0, k.lastIndexOf("|")), k.slice(k.lastIndexOf("|") + 1), g));
  // two Rotor ids of one contact (a lead and the customer it became) share a conversation
  const seen = new Map();
  for (const [, g] of out) seen.set(g.cv, (seen.get(g.cv) || 0) + 1);
  for (const [, g] of out) if (seen.get(g.cv) > 1) g.sh = true;
  let parts = 0;
  for (let i = 0; i < out.length; i += SUMMARY_PART) {
    parts += 1;
    await putRaw(summaryKey(ctx.runId, parts), { groups: Object.fromEntries(out.slice(i, i + SUMMARY_PART)) });
  }
  return { parts, groups: out.length, rows: valid, unchanged: out.filter(([, g]) => g.u).length };
}

async function summaries(ctx) {
  if (ctx.cache.sum) return ctx.cache.sum;
  const all = {};
  for (let n = 1; n <= ((ctx.prepared && ctx.prepared.parts) || 0); n++) {
    const got = await getRaw(summaryKey(ctx.runId, n));
    Object.assign(all, (got && got.data && got.data.groups) || {});
  }
  ctx.cache.sum = all;
  return all;
}

// The messages a changed conversation already holds (one listing per step).
async function existingIn(ctx, g) {
  if (!g.has) return null;
  const sets = (ctx.cache.existing ||= new Map());
  if (!sets.has(g.cv)) sets.set(g.cv, new Set((await listRel("conv-messages", g.cv, { limit: 100000 })).map((r) => r.id)));
  return sets.get(g.cv);
}

// One message record from a row (pure but for the attachment lookups).
async function messageData(m, g, ctx) {
  const id = idForRotor("message", m.id);
  const html = m.channel === "email" && looksLikeHtml(m.content);
  const cls = classify(m);
  const fileIds = [];
  let missing = 0;
  for (const a of m.attachments) {
    const fid = idForRotor("file", sha(a.url));
    const f = await getRecord("file", fid);
    if (!f || f.data.deleted_at) { missing += 1; continue; }
    fileIds.push(fid);
    // the upload left it with the run: it belongs to this message now
    if (f.data.owner && f.data.owner.type === "import_run") await updateRecord("file", fid, (x) => (x.owner && x.owner.type === "import_run" ? { ...x, owner: { type: "message", id }, contact_id: g.cid } : null), { ...ICTX, bulk: false }).catch(() => {});
  }
  if (missing) ctx.report.warn("message_attachment_not_uploaded");
  const them = m.channel === "sms" ? m.phone : m.email;
  const us = m.channel === "sms" ? MAIN_NUMBER : "office@bartawindowwashing.com";
  return {
    id, conversation_id: g.cv, contact_id: g.cid, channel: m.channel, direction: m.inbound ? "in" : "out",
    from: m.inbound ? them : us, to: m.inbound ? us : them, ...(m.subject ? { subject: m.subject } : {}),
    body_text: textOf(m), ...(html ? { body_html: sanitizeHtml(m.content) || undefined } : {}),
    status: m.status, provider: "rotor_import", origin: originOf(cls), related: {}, attachment_file_ids: fileIds,
    sent_at: m.at, ...(m.inbound && m.read ? { read_at: m.at } : {}), ...(m.status === "delivered" ? { delivered_at: m.at } : {}),
    rotor: { message_id: m.id, ...(m.thread ? { thread_id: m.thread } : {}), status_raw: m.status_raw, contact_type: m.contact_type, ...(cls ? { msg_class: cls } : {}), ...(missing ? { attachments_missing: missing } : {}) },
    created_at: m.at, import: { run_id: ctx.runId, at: nowIso() },
  };
}

// A message that is already there: only its status may move (sent → delivered between two exports).
async function moveStatus(id, m) {
  const r = await updateRecord("message", id, (x) => {
    const next = { ...x };
    if (x.status !== m.status && statusMayMove(x.status, m.status)) { next.status = m.status; if (m.status === "delivered") next.delivered_at = m.at; }
    if (m.inbound && m.read && !x.read_at) next.read_at = m.at;
    next.rotor = { ...(x.rotor || {}), status_raw: m.status_raw };
    return next;
  }, ICTX);
  return r.changed;
}

export async function mapMessage(m, ctx) {
  const k = groupKey(m);
  const g = (await summaries(ctx))[k];
  if (!g) return { warnings: ["message_without_summary"] };
  if (g.u) return {};                       // the conversation already holds this group: nothing to read or write
  const out = { records: [], pointers: [], patches: [], stats: [], warnings: [] };
  if (g.ph && m.id === g.first) {
    const ph = placeholderContact(m.contact, { kind: g.type });
    ph.data.source = { ...ph.data.source, captured_at: g.first_at };     // from the data, so every run maps the same record
    out.records.push(ph);
    out.pointers.push({ kind: `rotor/${g.type}`, key: rotorKey(m.contact), value: { id: g.cid } });
  }
  const id = idForRotor("message", m.id);
  const existing = await existingIn(ctx, g);
  let written = false;
  if (!(existing && existing.has(id))) {
    const data = await messageData(m, g, ctx);
    try {
      await createRecord("message", data, ICTX);
      written = true;
    } catch (e) {
      if (!(e instanceof ExistsError)) throw e;
      // written by a pass that died before its checkpoint: its place in the thread is asserted again
      await addRel("conv-messages", g.cv, tsKey(new Date(m.at)), id, {}, ICTX);
    }
  }
  if (written) ctx.report.warn("messages_written");
  else if (await moveStatus(id, m)) ctx.report.warn("message_status_moved");
  if (m.id === g.end) await finishGroup(m, g, out, ctx);
  return out;
}

// The group's last row: the conversation, the contact's comms stats, the timeline row.
async function finishGroup(m, g, out, ctx) {
  const src = srcKeyOf(m.contact);
  // a conversation that was there, or that another Rotor id of the same contact may have made meanwhile, is read now
  const cur = g.has || g.sh ? ((await getRecord("conversation", g.cv)) || { data: null }).data : null;
  const sources = { ...((cur && cur.rotor && cur.rotor.sources) || {}), [src]: { n: g.n, d: g.d } };
  const threads = [...new Set([...((cur && cur.rotor && cur.rotor.thread_ids) || []), ...g.threads])].slice(0, 12);
  const rotor = { ...((cur && cur.rotor) || {}), thread_ids: threads, sources };
  const newer = !cur || !cur.last_at || g.last.at >= cur.last_at;
  const count = Object.values(sources).reduce((s, x) => s + (x.n || 0), 0);
  const waiting = g.last.in && nowMs() - Date.parse(g.last.at) < UNANSWERED_DAYS * 86400000;
  const fresh = newer ? {
    last_at: g.last.at, last_preview: g.last.preview, last_direction: g.last.in ? "in" : "out",
    state: waiting ? "open" : "done", needs_reply: !!waiting, unread: waiting ? Math.max(1, g.trailing_in) : 0,
  } : {};
  if (!cur) {
    out.records.push({ type: "conversation", data: { id: g.cv, contact_id: g.cid, channel: m.channel, address: g.address || "", contact_name: g.name || "", lifecycle: g.lc || "", count, ...fresh, rotor, created_at: g.first_at } });
    await addActivity(g.cid, `${m.channel}.history`, g.cv, new Date(g.last.at), ICTX).catch(() => {});
  } else {
    out.patches.push({ type: "conversation", id: g.cv, set: { rotor, count: Math.max(cur.count || 0, count), ...(g.address && !cur.address ? { address: g.address } : {}), ...fresh } });
  }
  const mx = (a, b) => (!a ? b : !b ? a : a > b ? a : b);
  const r = await updateStats(g.cid, "comms", (p) => ({
    ...p,
    first_sms: g.first_out && !(p.first_sms && p.first_sms[MAIN_NUMBER]) ? { ...(p.first_sms || {}), [MAIN_NUMBER]: g.first_out } : p.first_sms || {},
    last_contacted_at: mx(p.last_contacted_at, g.last_out) || null, last_inbound_at: mx(p.last_inbound_at, g.last_in) || null,
  }), ICTX);
  // (an empty merge, once a step: it only tells the runner that the contacts list's stats columns need a rebuild at the end)
  if (r.changed && !ctx.cache.statsFlagged) { ctx.cache.statsFlagged = true; out.stats.push({ contact_id: g.cid, part: "comms", merge: {} }); }
}

// ------------------------------------------------------------ the phases

// People first: every comms phase runs after the contacts (the id map) and
// the STOP replies (row 12: suppressions before any comms phase).
export const phases = [
  { name: "comms.templates", entity: "message_templates", after: ["contacts.suppressions"], normalize: normalizeTemplate, map: mapTemplate },
  { name: "comms.campaigns", entity: "campaigns", after: ["comms.templates"], normalize: normalizeCampaign, map: mapCampaign },
  { name: "comms.messages", entity: "messages", after: ["contacts.customers", "contacts.leads", "contacts.suppressions", "comms.campaigns"], normalize: normalizeMessage, prepare: prepareMessages, map: mapMessage },
  { name: "comms.pin_types", entity: "map_pin_types", after: ["comms.messages"], normalize: (r) => r, prepare: preparePins, map: async () => ({}), finish: finishPins },
];
