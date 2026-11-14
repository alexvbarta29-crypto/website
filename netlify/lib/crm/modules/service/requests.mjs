// Service module: requests and assessments (guide-gaps S4, SR1-SR5).
//
// A request is made by the office (POST /requests: phone, office), by the
// customer's account (/p/request: portal.mjs keeps its office task and adds
// the request beside it, photos and all), or by hand from the website's
// lead. The office books an assessment (an estimate_visit task with a time
// for that person, so it sits on the Schedule's Sales rep column), marks it
// assessed, then converts it to a draft quote or an unscheduled job (the
// new record's id comes back for the screen to open), or closes it with a
// reason. Every write is a person's (the routes): no sweep or listener
// changes a request, so the parallel-run guard has nothing to stop here.

import { getRecord, createRecord, updateRecord, readIndex } from "../../../crm-store.mjs";
import { deriveId, isId } from "../../core/ids.mjs";
import { now, nowIso, localDate, addLocalDays, zonedToUtc, isLocalDate, isLocalTime } from "../../core/clock.mjs";
import { InputError, NotFoundError, ConflictError, ExistsError } from "../../core/errors.mjs";
import { has, call } from "../../core/services.mjs";
import { OPEN_REQUEST, REQUEST_SOURCES, CLOSE_REASONS } from "./types.mjs";

const W = (ctx = {}) => (ctx && typeof ctx.write === "function" ? ctx.write() : { ...(ctx || {}) });
const s = (v) => (v == null ? "" : String(v)).replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, "").trim();
const view = (r) => { if (!r) return r; const { _w, _etag, ...rest } = r; return rest; };
const CLIENT_ID = /^[A-Za-z0-9-]{8,64}$/;
const nameOf = (c) => String(c.display_name || [c.first_name, c.last_name].filter(Boolean).join(" ") || "Customer").slice(0, 120);

export const REQUEST_TILES = Object.freeze([["open", "Open"], ["assess_week", "Assessments this week"], ["unassigned", "Unassigned"], ["converted", "Became work"], ["closed", "Closed"]]);

async function liveContact(id) {
  if (!isId(id, "contact")) throw new InputError("Pick a customer or lead.", "contact_id");
  const g = await getRecord("contact", id);
  if (!g || g.data.deleted_at) throw new InputError("Pick a customer or lead.", "contact_id");
  return g.data;
}
async function theirProperty(id, contact) {
  if (id === undefined || id === null || id === "") return isId(contact.primary_property_id, "property") ? contact.primary_property_id : undefined;
  const p = isId(id, "property") ? await getRecord("property", id) : null;
  if (!p || p.data.deleted_at || p.data.contact_id !== contact.id) throw new InputError("Pick one of their places.", "property_id");
  return p.data.id;
}
async function activeUser(id, field = "user_id") {
  if (!isId(id, "user")) throw new InputError("Pick someone on the team.", field);
  const g = await getRecord("user", id);
  if (!g || g.data.status !== "active") throw new InputError("Pick someone on the team.", field);
  return g.data;
}
async function rec(id) {
  if (!isId(id, "request")) throw new NotFoundError("That request isn't there.");
  const g = await getRecord("request", id);
  if (!g || g.data.deleted_at) throw new NotFoundError("That request isn't there.");
  return g;
}
const services = (list) => [...new Set((Array.isArray(list) ? list : []).map((x) => s(x).slice(0, 60)).filter(Boolean))].slice(0, 12);

// ------------------------------------------------------------ the list

// The Monday-to-Sunday week of a day (Rotor's weeks start on Monday).
export function weekOf(today) {
  const dow = (new Date(today + "T12:00:00Z").getUTCDay() + 6) % 7;
  const from = addLocalDays(today, -dow);
  return { from, to: addLocalDays(from, 6) };
}

// → { tiles, rows } for one tile (pure). open: the open shard's rows; closed: this year's.
export function requestTiles(open, closed, today, tile = "open") {
  const wk = weekOf(today);
  const by = {
    open: open,
    assess_week: open.filter((r) => r.ad && r.ad >= wk.from && r.ad <= wk.to),
    unassigned: open.filter((r) => !r.as && !r.au),
    converted: closed.filter((r) => r.st === "converted"),
    closed: closed.filter((r) => r.st === "closed"),
  };
  const done = by.converted.length + by.closed.length;
  const tiles = REQUEST_TILES.map(([key, label]) => ({ key, label, count: by[key].length, ...(key === "converted" ? { pct: done ? Math.round((by.converted.length / done) * 100) : null } : {}) }));
  const rows = (by[tile] || by.open).slice().sort((a, b) => String(b.at).localeCompare(String(a.at)));
  return { tiles, rows };
}

export async function listRequests({ tile = "open", q = "", today = localDate(now()) } = {}) {
  const none = { rows: [], stale: false };
  const [open, closed] = await Promise.all([readIndex("requests", "open").catch(() => none), readIndex("requests", today.slice(0, 4)).catch(() => none)]);
  const out = requestTiles(open.rows, closed.rows, today, REQUEST_TILES.some(([k]) => k === tile) ? tile : "open");
  const w = s(q).toLowerCase();
  const rows = w ? out.rows.filter((r) => `${r.cn} ${(r.svc || []).join(" ")}`.toLowerCase().includes(w)) : out.rows;
  return { tiles: out.tiles, rows: rows.slice(0, 300), stale: !!(open.stale || closed.stale) };
}

// ------------------------------------------------------------ one

export async function requestDetail(id) {
  const g = await rec(id);
  const r = g.data;
  const [c, p, task, assessor] = await Promise.all([
    getRecord("contact", r.contact_id).catch(() => null), r.property_id ? getRecord("property", r.property_id).catch(() => null) : null,
    r.assessment && r.assessment.task_id ? getRecord("task", r.assessment.task_id).catch(() => null) : null,
    r.assessment && r.assessment.user_id ? getRecord("user", r.assessment.user_id).catch(() => null) : null,
  ]);
  const contact = c && !c.data.deleted_at ? { id: c.data.id, display_name: nameOf(c.data), phones: c.data.phones || [], emails: c.data.emails || [], lifecycle: c.data.lifecycle } : null;
  const property = p && !p.data.deleted_at ? { id: p.data.id, label: p.data.label, address: p.data.address } : null;
  return {
    data: {
      request: view(r), contact, property,
      assessment: r.assessment ? { ...r.assessment, user_name: assessor ? assessor.data.name : null, task_status: task ? task.data.status : null } : null,
    },
    etag: g.etag,
  };
}

// ------------------------------------------------------------ writes

// POST /requests { client_id, contact_id, property_id?, services[], timing?, notes?, source? }: once per client id.
export async function createRequest(body = {}, ctx = {}) {
  const b = body || {};
  if (typeof b.client_id !== "string" || !CLIENT_ID.test(b.client_id)) throw new InputError("Refresh and try again.", "client_id");
  const id = deriveId("request", `office--${b.client_id.toLowerCase()}`, "service.request", 1);
  const had = await getRecord("request", id);
  if (had) return { request: view(had.data), etag: had.etag, existed: true };
  const contact = await liveContact(b.contact_id);
  const list = services(b.services);
  const notes = s(b.notes).slice(0, 4000);
  if (!list.length && !notes) throw new InputError("Pick what they need, or add a note.", "services");
  const source = REQUEST_SOURCES.includes(b.source) && b.source !== "import" && b.source !== "portal" ? b.source : "office";
  const data = {
    id, contact_id: contact.id, contact_name: nameOf(contact), property_id: await theirProperty(b.property_id, contact), source, services: list,
    timing: s(b.timing).slice(0, 60) || undefined, notes, photo_ids: [], status: "new",
    ...(b.assignee_id ? { assignee_id: (await activeUser(b.assignee_id, "assignee_id")).id } : {}),
  };
  try {
    const r = await createRecord("request", data, W(ctx));
    return { request: view(r.data), etag: r.etag, existed: false };
  } catch (e) {
    if (!(e instanceof ExistsError)) throw e;
    const g = await getRecord("request", id);
    return { request: view(g.data), etag: g.etag, existed: true };
  }
}

// The customer's account: a request beside the office task portal.mjs makes (the photos ride on the task). Once per task.
export async function requestFromPortal({ contact, task, services: list = [], timing = "", notes = "", property_id, photo_ids = [] }, w) {
  const id = deriveId("request", `portal--${task.id}`, "service.request", 1);
  const data = {
    id, contact_id: contact.id, contact_name: nameOf(contact), ...(property_id ? { property_id } : {}), source: "portal", services: services(list),
    timing: s(timing).slice(0, 60) || undefined, notes: s(notes).slice(0, 4000), photo_ids: (photo_ids || []).filter((x) => isId(x, "file")).slice(0, 10), status: "new", task_id: task.id,
  };
  try {
    return (await createRecord("request", data, w)).data;
  } catch (e) {
    if (!(e instanceof ExistsError)) throw e;
    const g = await getRecord("request", id);
    // a retry that brought the photos keeps them
    if (g && (photo_ids || []).some((x) => !(g.data.photo_ids || []).includes(x))) {
      return (await updateRecord("request", id, (x) => ({ ...x, photo_ids: [...new Set([...(x.photo_ids || []), ...photo_ids])].slice(0, 10) }), w)).data;
    }
    return g ? g.data : null;
  }
}

const EDITABLE = ["services", "timing", "notes", "assignee_id", "property_id"];
export async function patchRequest(id, body = {}, ctx = {}) {
  if (!ctx.ifMatch) throw new InputError("This change needs the version you edited (If-Match).", "if-match");
  const g = await rec(id);
  const b = body || {};
  const patch = {};
  if (b.services !== undefined) patch.services = services(b.services);
  if (b.timing !== undefined) patch.timing = s(b.timing).slice(0, 60) || null;
  if (b.notes !== undefined) patch.notes = s(b.notes).slice(0, 4000);
  if (b.assignee_id !== undefined) patch.assignee_id = b.assignee_id ? (await activeUser(b.assignee_id, "assignee_id")).id : null;
  if (b.property_id !== undefined) patch.property_id = (await theirProperty(b.property_id, await liveContact(g.data.contact_id))) || null;
  const r = await updateRecord("request", g.data.id, (x) => {
    const next = { ...x };
    for (const k of EDITABLE) if (patch[k] !== undefined) { if (patch[k] === null) delete next[k]; else next[k] = patch[k]; }
    return JSON.stringify(next) === JSON.stringify(x) ? null : next;
  }, { ...W(ctx), ifMatch: ctx.ifMatch });
  return { request: view(r.data), etag: r.etag };
}

const assertOpen = (r) => { if (!OPEN_REQUEST.includes(r.status)) throw new ConflictError(r.status === "converted" ? "This request already became work." : "This request is closed."); };

// POST /requests/:id/assessment { date, start, end, user_id }: an estimate visit task with that time (moving it again moves the task).
export async function bookAssessment(id, body = {}, ctx = {}) {
  const g = await rec(id);
  assertOpen(g.data);
  const b = body || {};
  if (!isLocalDate(b.date)) throw new InputError("Pick a day.", "date");
  if (!isLocalTime(b.start)) throw new InputError("Pick a start time.", "start");
  if (!isLocalTime(b.end) || b.end <= b.start) throw new InputError("Pick an end after the start.", "end");
  if (b.date < localDate(now())) throw new InputError("Pick today or a day ahead.", "date");
  const user = await activeUser(b.user_id);
  const r0 = g.data;
  const due_at = zonedToUtc(b.date, b.start).toISOString();
  const end_at = zonedToUtc(b.date, b.end).toISOString();
  const words = (r0.services || []).join(", ");
  const task = { kind: "estimate_visit", title: `Assessment: ${r0.contact_name || "customer"}${words ? ` (${words})` : ""}`.slice(0, 160), status: "open", priority: "medium",
    due_at, end_at, assignee_ids: [user.id], contact_id: r0.contact_id, contact_name: r0.contact_name, ...(r0.property_id ? { property_id: r0.property_id } : {}),
    notes: [`From request (${r0.source}).`, r0.timing ? `When they'd like it: ${r0.timing}.` : "", r0.notes || ""].filter(Boolean).join("\n").slice(0, 4000) };
  const w = W(ctx);
  let taskId = r0.assessment && r0.assessment.task_id;
  const old = taskId ? await getRecord("task", taskId).catch(() => null) : null;
  if (old && !old.data.deleted_at && old.data.status !== "done") {
    await updateRecord("task", taskId, (x) => ({ ...x, due_at, end_at, assignee_ids: [user.id], title: task.title }), w);
  } else {
    taskId = deriveId("task", `request-assessment--${r0.id}--${r0.wv}`, "service.assessment", 1);
    try { await createRecord("task", { id: taskId, ...task }, w); } catch (e) { if (!(e instanceof ExistsError)) throw e; }
  }
  const r = await updateRecord("request", r0.id, (x) => ({ ...x, status: "assessment_booked", assessment: { date: b.date, start: b.start, end: b.end, user_id: user.id, task_id: taskId }, assignee_id: x.assignee_id || user.id }), w);
  return { request: view(r.data), etag: r.etag };
}

// POST /requests/:id/assessed: the look is done (its task is done too).
export async function markAssessed(id, ctx = {}) {
  const g = await rec(id);
  assertOpen(g.data);
  const w = W(ctx);
  const tid = g.data.assessment && g.data.assessment.task_id;
  if (tid) await updateRecord("task", tid, (x) => (x.status === "done" ? null : { ...x, status: "done", done_at: nowIso(), done_by: w.by }), w).catch(() => null);
  const r = await updateRecord("request", g.data.id, (x) => ({ ...x, status: "assessed", assessment: x.assessment ? { ...x.assessment, done_at: nowIso() } : undefined }), w);
  return { request: view(r.data), etag: r.etag };
}

// POST /requests/:id/convert { to: "quote" | "job" } → the draft's id. Once: a second tap finds what the first made.
export async function convertRequest(id, body = {}, ctx = {}) {
  const g = await rec(id);
  const r0 = g.data;
  if (r0.status === "converted" && r0.converted) return { request: view(r0), quote_id: r0.converted.quote_id || null, job_id: r0.converted.job_id || null, existed: true };
  assertOpen(r0);
  const to = (body || {}).to;
  if (!["quote", "job"].includes(to)) throw new InputError("Make a quote or a job.", "to");
  const notes = [`From a request (${r0.source}).`, (r0.services || []).length ? `Asked for: ${r0.services.join(", ")}.` : "", r0.timing ? `When: ${r0.timing}.` : "", r0.notes || ""].filter(Boolean).join("\n").slice(0, 2000);
  const out = { quote_id: null, job_id: null };
  if (to === "quote") {
    if (!(ctx.can && ctx.can("quotes:write"))) throw new InputError("Making quotes isn't open to this login.", "to");
    const { createQuote } = await import("../quotes/quotes.mjs");
    const q = await createQuote({ contact_id: r0.contact_id, ...(r0.property_id ? { property_id: r0.property_id } : {}), client_id: `request-${r0.id}`, internal_notes: notes }, ctx);
    out.quote_id = q.data.id;
  } else {
    if (!(ctx.can && ctx.can("schedule:write"))) throw new InputError("Making jobs isn't open to this login.", "to");
    if (!has("work.createJobs")) throw new ConflictError("Jobs aren't set up here yet.");
    const lines = ((r0.services || []).length ? r0.services : ["Work request"]).map((t) => ({ title: t, unit_cents: 0, qty_milli: 1000 }));
    const [jobId] = await call("work.createJobs", [{ contact_id: r0.contact_id, ...(r0.property_id ? { property_id: r0.property_id } : {}), kind: "standard", lines, office_notes: notes }], `request-convert--${r0.id}`, "service.request", W(ctx));
    out.job_id = jobId;
  }
  const r = await updateRecord("request", r0.id, (x) => ({ ...x, status: "converted", converted: { ...(out.quote_id ? { quote_id: out.quote_id } : {}), ...(out.job_id ? { job_id: out.job_id } : {}), at: nowIso() } }), W(ctx));
  return { request: view(r.data), ...out, existed: false };
}

// POST /requests/:id/close { reason, note? }
export async function closeRequest(id, body = {}, ctx = {}) {
  const g = await rec(id);
  assertOpen(g.data);
  const b = body || {};
  if (!CLOSE_REASONS.includes(b.reason)) throw new InputError("Pick why.", "reason");
  const w = W(ctx);
  const tid = g.data.assessment && g.data.assessment.task_id;
  if (tid && g.data.status === "assessment_booked") await updateRecord("task", tid, (x) => (x.status === "done" ? null : { ...x, status: "done", done_at: nowIso(), done_by: w.by }), w).catch(() => null);
  const r = await updateRecord("request", g.data.id, (x) => ({ ...x, status: "closed", closed_reason: b.reason, closed_note: s(b.note).slice(0, 300) || undefined, closed_at: nowIso() }), w);
  return { request: view(r.data), etag: r.etag };
}

// POST /requests/:id/reopen: a closed one back to new (not one that became work).
export async function reopenRequest(id, ctx = {}) {
  const g = await rec(id);
  if (g.data.status !== "closed") throw new ConflictError("Only a closed request reopens.");
  const r = await updateRecord("request", g.data.id, (x) => { const n = { ...x, status: x.assessment && x.assessment.done_at ? "assessed" : "new" }; delete n.closed_reason; delete n.closed_note; delete n.closed_at; return n; }, W(ctx));
  return { request: view(r.data), etag: r.etag };
}

// The contact's requests (the contact's Service tab card): newest first.
export async function contactRequests(contactId) {
  const { listRel, getRecords } = await import("../../../crm-store.mjs");
  const rel = await listRel("contact-requests", contactId, { limit: 20 });
  return (await getRecords("request", rel.map((r) => r.id))).filter(Boolean).map((x) => x.data).filter((r) => !r.deleted_at && r.contact_id === contactId)
    .map((r) => ({ id: r.id, status: r.status, source: r.source, services: r.services || [], timing: r.timing || null, created_at: r.created_at, assessment: r.assessment || null, converted: r.converted || null }));
}

// service.dueToday (Home's Due today, guide-gaps S1): the assessments booked for today (and before, still open).
export async function assessmentsDue(date = localDate(now())) {
  const ix = await readIndex("requests", "open").catch(() => ({ rows: [] }));
  const live = ix.rows.filter((r) => r.st === "assessment_booked" && r.ad);
  return { key: "assessments", count: live.filter((r) => r.ad === date).length, overdue: live.filter((r) => r.ad < date).length };
}

