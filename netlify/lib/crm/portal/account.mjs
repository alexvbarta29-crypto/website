// Barta CRM portal: the customer's account (design §8.1 /p/hub, /p/visits,
// /p/request, §8.5; gaps P1 "Portal extras"; docs/CRM.md "The customer's
// account"). Registered by the plans module, which owns the hub
// (plans/portal.mjs spreads accountRoutes into its portalRoutes); core
// (portal/core.mjs) checks the hub link's scope before any handler runs,
// sends the portal headers and CSP, and requires X-CRM-Portal: 1 on POSTs.
//
//   GET  /p/hub                               home: next visit, to pay, to sign, quotes, plan, what do you need
//   GET  /p/visits                            upcoming visits (date, arrival window, service, who)
//   GET  /p/history[?before=yyyy-mm]          past visits with the before/after photos the tech
//                                             marked customer-visible, invoices and receipts
//   GET  /p/plan                              the plan: what's included, next visit, perks, the rules
//   GET  /p/request · POST /api/portal/requests          request work → a task for the office
//   GET  /p/visits/:id/reschedule · POST /api/portal/visits/:id/reschedule-request
//                                             under the late-cancel hours: the fee and a call
//                                             button; otherwise → a task (nothing moves by itself)
//   GET  /p/account                           contact details (masked) and text/email choices
//   POST /api/portal/preferences {channel, on}   the contact's consent, source "portal"
//   POST /api/portal/contact-info {name?, phone?, email?, note?}   → a task (the office updates it)
//   GET  /api/portal/hub/files/:file[?thumb=1]   a customer-visible visit photo of this contact
//
// Every page and API answers for the hub session's contact only: a record
// of anyone else's is "not here" (404), never a hint that it exists. No
// page shows an address (a hub link can be forwarded); properties go by
// their label. GET pages never change anything. Requests are capped per
// contact (REQUEST_LIMITS) on top of the portal function's rate limit, and
// a double tap (the same client_id) lands once.

import { createHash, randomBytes } from "node:crypto";
import { getRecord, getRecords, createRecord, updateRecord, listRel, listKeys, putRaw, readIndex, getSetting, getFileStream, addActivity, hk, withStoreScope, withBudget } from "../../crm-store.mjs";
import { deriveId, isId } from "../core/ids.mjs";
import { now, nowMs, nowIso, localDate, addLocalDays, zonedToUtc, tsKey, fromTsKey, isLocalDate } from "../core/clock.mjs";
import { ConflictError, ExistsError, InputError, NotFoundError } from "../core/errors.mjs";
import { maskPhone, maskEmail } from "../core/text.mjs";
import { deliveryHeaders, defineFileOwner, uploadFile, INLINE_TYPES, sniffType } from "../core/files.mjs";
import { emit } from "../core/events.mjs";
import { notify } from "../core/notify.mjs";
import { has, call } from "../core/services.mjs";
import { keySalt } from "../core/context.mjs";
import { safeErr } from "../../referral-lib.mjs";
import { createPortalLink } from "./core.mjs";
import { arrivalText } from "./track.mjs";
import { loadCatalog, perksDetails } from "../modules/plans/catalog.mjs";
import { hubPage, visitsPage, historyPage, planPage, requestPage, reschedulePage, accountPage, REQUEST_SERVICES, TIMING, PREFS } from "./account-render.mjs";

const SCRIPT = "account.js";
export const REQUEST_LIMITS = Object.freeze({ per_day: 5, photos: 3, photo_bytes: 1500000 });
export const REQUEST_MAX_BODY = 4700000;
export const REQUEST_CALLS = 90;
const OPEN_VISIT = ["scheduled", "en_route", "in_progress", "paused"];
const sha = (s) => createHash("sha256").update(String(s)).digest("hex");
const clean = (s, max) => String(s ?? "").replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, "").trim().slice(0, max);

// Customer photos on a portal request belong to its task: the office reads
// them with the task (tasks:read); the customer only adds them.
defineFileOwner("task", {
  canRead: (ctx) => !!(ctx.can && ctx.can("tasks:read")),
  canEdit: (ctx, task) => (!!ctx.portalContactId && ctx.portalContactId === task.contact_id) || !!(ctx.can && ctx.can("tasks:write")),
});

// ------------------------------------------------------------ reading (each page stays under the portal's 30 storage calls)

const contactOf = async (id) => ((await getRecord("contact", id).catch(() => null)) || {}).data || null;
const ym = (date) => date.slice(0, 7);
function months(fromDate, n, dir = 1) {
  const [y, m] = fromDate.split("-").map(Number);
  return Array.from({ length: n }, (_, i) => { const d = new Date(Date.UTC(y, m - 1 + dir * i, 15)); return d.toISOString().slice(0, 7); });
}

// First names by user id (the users index: one read).
async function firstNames() {
  const ix = await readIndex("users", "").catch(() => ({ rows: [] }));
  return new Map(ix.rows.map((u) => [u.id, String(u.first_name || String(u.name || "").split(/\s+/)[0] || "").trim()]));
}

const serviceText = (r) => {
  const t = String(r.t || "").trim();
  if (t) return t;
  return (r.svc || []).join(", ");
};
const rowVisit = (r, names) => ({
  id: r.id, date: r.d, start: r.s, status: r.st, property_id: r.pr || null,
  window_text: arrivalText({ start: r.s, window: { type: (r.w && r.w.t) || "window", minutes: (r.w && r.w.m) || 0 }, date_only: r.do === true }),
  service: serviceText(r), techs: (r.a || []).map((id) => names.get(id)).filter(Boolean),
});

// The contact's visits from the visits index (one read a month).
async function visitRows(contactId, shards) {
  const out = [];
  for (const s of shards) {
    const ix = await readIndex("visits", s).catch(() => ({ rows: [] }));
    for (const r of ix.rows) if (r.c === contactId) out.push(r);
  }
  return out;
}

export async function upcomingVisits(contactId, { n = 3 } = {}) {
  const today = localDate(now());
  const [rows, names] = await Promise.all([visitRows(contactId, months(today, n)), firstNames()]);
  return rows.filter((r) => OPEN_VISIT.includes(r.st) && r.d >= today).sort((a, b) => `${a.d}${a.s}`.localeCompare(`${b.d}${b.s}`)).slice(0, 20).map((r) => rowVisit(r, names));
}

// Past visits (done), newest first: six months a page, the newest six read
// whole for their customer-visible photos.
export async function pastVisits(contactId, { before } = {}) {
  const today = localDate(now());
  const top = before && /^\d{4}-\d{2}$/.test(before) && before <= ym(today) ? before : ym(today);
  const shards = months(`${top}-15`, 6, -1);
  const [rows, names] = await Promise.all([visitRows(contactId, shards), firstNames()]);
  const done = rows.filter((r) => r.st === "completed" && r.d <= today).sort((a, b) => `${b.d}${b.s}`.localeCompare(`${a.d}${a.s}`)).slice(0, 12);
  const recs = await getRecords("visit", done.slice(0, 6).map((r) => r.id)).catch(() => []);
  const photos = new Map();
  for (const g of recs) {
    if (!g || g.data.deleted_at || g.data.contact_id !== contactId) continue;
    photos.set(g.data.id, (g.data.photos || []).filter((p) => p && p.customer_visible === true && ["before", "after"].includes(p.tag)).slice(0, 6).map((p) => ({ id: p.file_id, tag: p.tag, thumb: true })));
  }
  const oldest = shards[shards.length - 1];
  const prev = months(`${oldest}-15`, 2, -1)[1];
  return { past: done.map((r) => ({ ...rowVisit(r, names), photos: photos.get(r.id) || [] })), olderBefore: prev >= "2015-01" ? prev : null };
}

// Open invoices with something to pay (the invoices index's open shard: one read).
async function openInvoices(contactId) {
  const ix = await readIndex("invoices", "open").catch(() => ({ rows: [] }));
  return ix.rows.filter((r) => r.c === contactId && r.st === "open" && (r.bal || 0) > 0).sort((a, b) => String(a.due || "").localeCompare(String(b.due || "")))
    .slice(0, 6).map((r) => ({ id: r.id, number: r.n || "", balance_cents: r.bal || 0, due: r.due || null }));
}

const INV_STATUS = { open: "Due", paid: "Paid", void: "Voided", written_off: "Closed", draft: "Draft" };
async function invoiceList(contactId) {
  const rows = await listRel("contact-invoices", contactId, { limit: 8 }).catch(() => []);
  const recs = (await getRecords("invoice", rows.map((r) => r.id)).catch(() => [])).filter(Boolean).map((g) => g.data);
  return recs.filter((i) => !i.deleted_at && i.contact_id === contactId && ["open", "paid"].includes(i.status))
    .map((i) => ({ id: i.id, number: i.number_label || i.number || "", status: i.status, status_text: (i.status === "open" && (i.balance_cents || 0) > 0 ? "Due" : INV_STATUS[i.status]) || "", total_cents: i.total_cents || 0, balance_cents: i.balance_cents || 0, date: i.paid_at ? localDate(new Date(i.paid_at)) : i.issued_on || null }));
}

async function agreementsToSign(contactId) {
  const rows = await listRel("contact-agreements", contactId, { limit: 4 }).catch(() => []);
  return (await getRecords("agreement", rows.map((r) => r.id)).catch(() => [])).filter(Boolean).map((g) => g.data)
    .filter((a) => !a.deleted_at && a.contact_id === contactId && ["sent", "viewed"].includes(a.status)).map((a) => ({ id: a.id, title: a.title }));
}
async function openQuotes(contactId) {
  const rows = await listRel("contact-quotes", contactId, { limit: 4 }).catch(() => []);
  return (await getRecords("quote", rows.map((r) => r.id)).catch(() => [])).filter(Boolean).map((g) => g.data)
    .filter((q) => !q.deleted_at && q.contact_id === contactId && ["sent", "viewed"].includes(q.status) && q.current_version_id).map((q) => ({ id: q.id, number: q.number_label || "", expires_on: q.expires_on || null }));
}

const PLAN_STATUS = { active: "Active", pending: "Waiting for your signature", paused: "Paused", cancelling: "Ending soon" };
async function plansOf(contactId, { limit = 4 } = {}) {
  const rows = await listRel("contact-plans", contactId, { limit: 6 }).catch(() => []);
  return (await getRecords("plan", rows.map((r) => r.id).slice(0, limit)).catch(() => [])).filter(Boolean).map((g) => g.data)
    .filter((x) => !x.deleted_at && x.contact_id === contactId && x.kind !== "one_time_series" && PLAN_STATUS[x.status]);
}
const nextOrdinal = (p) => ((p.ordinals || []).filter((o) => ["unscheduled", "scheduled"].includes(o.status)).map((o) => (o.visit_date ? o.visit_date.slice(0, 7) : o.target_month)).filter(Boolean).sort()[0]) || null;
const planSummary = (p) => ({ id: p.id, name: p.name, status_text: PLAN_STATUS[p.status], next: nextOrdinal(p) });

// What a plan line covers, in the customer's words.
function whenWords(scope, perYear) {
  const s = scope || { type: "all" };
  if (s.type === "initial") return "Your first visit";
  if (s.type === "after_initial") return "Every visit after the first";
  if (s.type === "specific" && Array.isArray(s.visits) && s.visits.length) {
    if (s.visits.length === 1) return `Visit ${s.visits[0]} of each year`;
    return `Visits ${s.visits.slice(0, -1).join(", ")} and ${s.visits[s.visits.length - 1]} of each year`;
  }
  return perYear > 1 ? "Every visit" : "Each visit";
}

async function planDetails(p, names) {
  let first = null;
  let flat = true;
  if (has("quotes.totals")) {
    try {
      const t = await call("quotes.totals", { kind: "plan", lines: p.lines || [], discounts: p.discounts || [], plan: { visits_per_year: p.visits_per_year, term_months: (p.term && p.term.months) || 12, catalog_key: p.catalog_key } });
      first = t && Number.isSafeInteger(t.first_cents) ? t.first_cents : null;
      flat = !(t && Array.isArray(t.per_visit_cents) && new Set(t.per_visit_cents).size > 1);
    } catch (e) { first = null; }
  }
  const perks = perksDetails(p.perks || {}, names).split("\n").map((l) => l.replace(/^- /, "")).filter((l) => l && !/^This plan has no perks/.test(l))
    .map((l) => { const i = l.indexOf(": "); return { name: l.slice(0, i), text: l.slice(i + 2) }; });
  const next = nextOrdinal(p);
  const nextDay = (p.ordinals || []).filter((o) => o.status === "scheduled" && o.visit_date && o.visit_date >= localDate(now())).map((o) => o.visit_date).sort()[0];
  const { dayWords, monthWords } = await import("../modules/plans/render.mjs");
  return {
    ...planSummary(p), visits_per_year: p.visits_per_year, per_visit_cents: first, flat,
    next_text: nextDay ? dayWords(nextDay) : next ? `Around ${monthWords(next)}` : "", next: nextDay || next,
    term_end: (p.term && (p.term.current_end || p.term.end_on)) || null,
    lines: (p.lines || []).filter((l) => l && !l.optional).map((l) => ({ title: l.title || "Service", when: whenWords(l.scope, p.visits_per_year) })),
    perks,
  };
}

async function policy() {
  const [work, cat] = await Promise.all([getSetting("work").catch(() => ({})), loadCatalog().catch(() => null)]);
  return {
    lateHours: Number.isInteger(work && work.late_cancel_hours) ? work.late_cancel_hours : 24,
    lateFee: cat && Number.isSafeInteger(cat.late_cancel_fee_cents) ? cat.late_cancel_fee_cents : 5000,
    noticeDays: cat && Number.isInteger(cat.notice_days) ? cat.notice_days : 7,
    perkNames: cat ? cat.perk_names : undefined,
  };
}

// One of this contact's open visits (any one else's: null).
async function ownVisit(contactId, id) {
  if (!isId(id, "visit")) return null;
  const g = await getRecord("visit", id).catch(() => null);
  if (!g || g.data.deleted_at || g.data.contact_id !== contactId) return null;
  return g.data;
}
const visitView = (v, names) => ({ id: v.id, date: v.date, status: v.status, window_text: arrivalText(v), service: v.job_title || (v.service_types || []).join(", "), techs: (v.assignee_ids || []).map((u) => names.get(u)).filter(Boolean) });
// Hours until the visit's arrival starts (its window's start in Chicago).
const hoursUntil = (v) => ((Date.parse(v.start_utc || "") || zonedToUtc(v.date, v.start || "08:00").getTime()) - nowMs()) / 3600000;

// ------------------------------------------------------------ writing

// The office: owners and admins who are on (the request's task goes to them).
async function officeIds() {
  const ix = await readIndex("users", "").catch(() => ({ rows: [] }));
  return ix.rows.filter((u) => u.status === "active" && ["owner", "admin"].includes(u.role)).map((u) => u.id).slice(0, 6);
}
const nameOf = (c) => String(c.display_name || [c.first_name, c.last_name].filter(Boolean).join(" ") || "Customer").slice(0, 120);
const clientIdOf = (b) => (typeof b.client_id === "string" && /^[A-Za-z0-9-]{8,64}$/.test(b.client_id) ? b.client_id.toLowerCase() : null);

// At most REQUEST_LIMITS.per_day portal requests a contact a day (rolling): a keyed bucket like /p/login's.
const bucketOf = (contactId) => `thr/preq/${sha(`preq|${contactId}|${keySalt() || "dev-only"}`).slice(0, 32)}/`;
async function underCap(contactId) {
  const keys = await listKeys(bucketOf(contactId));
  const t = nowMs();
  const n = keys.map((k) => /(\d{8}t\d{9}z)-[0-9a-f]+$/.exec(k)).filter(Boolean).map((m) => fromTsKey(m[1])).filter((d) => d && d.getTime() > t - 86400000).length;
  return n < REQUEST_LIMITS.per_day;
}
const stampCap = (contactId) => putRaw(`${bucketOf(contactId)}${tsKey(now())}-${randomBytes(4).toString("hex")}`, { at: nowIso() }).catch(() => {});

// A task for the office, once per client id (a double tap or a retry finds it).
async function officeTask(contact, seed, data, w) {
  const id = deriveId("task", seed, "portal.task", 1);
  try {
    const rec = await createRecord("task", { id, kind: "follow_up", priority: "medium", status: "open", contact_id: contact.id, contact_name: nameOf(contact), due_at: nowIso(), assignee_ids: await officeIds(), source: "portal", ...data }, w);
    await addActivity(contact.id, "task", rec.data.id, now()).catch(() => {});
    return { task: rec.data, created: true };
  } catch (e) {
    if (!(e instanceof ExistsError)) throw e;
    const g = await getRecord("task", id);
    return { task: g ? g.data : null, created: false };
  }
}
async function tellOffice(title, body, taskId) {
  try { await notify(await officeIds(), { kind: "task", title, body, link: `/tasks/${taskId}` }, { by: "portal" }); } catch (e) { console.error(`crm:portal: the office wasn't told (${safeErr(e)})`); }
}

function photoBytes(s, i) {
  if (typeof s !== "string" || !s) throw new InputError("That photo didn't come through.", `photos.${i}`);
  const b64 = s.replace(/^data:image\/[a-z+]+;base64,/, "");
  if (!/^[A-Za-z0-9+/=\s]+$/.test(b64)) throw new InputError("That photo didn't come through.", `photos.${i}`);
  const bytes = Buffer.from(b64, "base64");
  if (!bytes.length) throw new InputError("That photo is empty.", `photos.${i}`);
  if (bytes.length > REQUEST_LIMITS.photo_bytes) throw new InputError("That photo is too big. Try a smaller one.", `photos.${i}`);
  if (!INLINE_TYPES.has(sniffType(bytes))) throw new InputError("Send a photo (JPEG, PNG or WebP).", `photos.${i}`);
  return bytes;
}

// POST /api/portal/requests { client_id, services[], timing?, notes?, property_id?, photos?[] }
export async function requestWork(p) {
  const b = p.body || {};
  const cid = clientIdOf(b);
  if (!cid) throw new InputError("Refresh the page and try again.", "client_id");
  const services = [...new Set((Array.isArray(b.services) ? b.services : []).filter((k) => REQUEST_SERVICES.some(([x]) => x === k)))];
  const notes = clean(b.notes, 2000);
  if (!services.length && !notes) throw new InputError("Pick what you need, or tell us in a note.", "services");
  const timing = TIMING.find(([k]) => k === b.timing) || TIMING[0];
  const photos = (Array.isArray(b.photos) ? b.photos : []).slice(0, REQUEST_LIMITS.photos + 1);
  if (photos.length > REQUEST_LIMITS.photos) throw new InputError(`Up to ${REQUEST_LIMITS.photos} photos.`, "photos");
  const bytes = photos.map(photoBytes);
  const contact = await contactOf(p.contact_id);
  if (!contact || contact.deleted_at) return p.fail("signed_out", "Open your link again.", 401);
  let propertyLabel = "";
  let propertyId;
  if (b.property_id !== undefined && b.property_id !== "") {
    const pr = isId(b.property_id, "property") ? await getRecord("property", b.property_id).catch(() => null) : null;
    if (!pr || pr.data.deleted_at || pr.data.contact_id !== contact.id) throw new InputError("Pick one of your places.", "property_id");
    propertyId = pr.data.id;
    propertyLabel = pr.data.label || "";
  } else if (isId(contact.primary_property_id, "property")) propertyId = contact.primary_property_id;
  const seed = `portal-request--${contact.id}--${cid}`;
  const had = await getRecord("task", deriveId("task", seed, "portal.task", 1)).catch(() => null);
  if (!had) {
    if (!(await underCap(contact.id))) return p.fail("rate_limited", "That's a lot of requests today. Call or text us and we'll help.", 429);
    await stampCap(contact.id);
  }
  const words = services.map((k) => REQUEST_SERVICES.find(([x]) => x === k)[1]);
  const title = `Work request: ${words.join(", ") || "see the note"}`.slice(0, 160);
  const body = [`From the customer's account (portal).`, words.length ? `Services: ${words.join(", ")}.` : "", `When: ${timing[1]}.`, propertyLabel ? `Where: ${propertyLabel}.` : "", notes ? `Note: ${notes}` : ""].filter(Boolean).join("\n");
  const w = p.write();
  const { task, created } = await officeTask(contact, seed, { title, notes: body, ...(propertyId ? { property_id: propertyId } : {}), request: { kind: "work", services, timing: timing[0] } }, w);
  // the photos ride on the task (owner "task"), each once (its client id)
  const ids = [];
  for (const [i, raw] of bytes.entries()) {
    const f = await uploadFile({ portalContactId: contact.id, write: () => w }, { ownerType: "task", ownerId: task.id, kind: "photo", declaredType: "image/jpeg", bytes: raw, clientId: `${cid}-p${i}` });
    ids.push(f.id);
  }
  if (ids.length) await updateRecord("task", task.id, (x) => { const have = new Set(x.photo_ids || []); return ids.every((id) => have.has(id)) ? null : { ...x, photo_ids: [...new Set([...(x.photo_ids || []), ...ids])].slice(0, 10) }; }, w);
  if (created) await tellOffice(`${nameOf(contact)} asked for work`, words.join(", ") || "See the note.", task.id);
  return p.json({ ok: true, data: { request_id: task.id, already: !created } }, created ? 201 : 200);
}

// POST /api/portal/visits/:id/reschedule-request { client_id, dates[], note? }
export async function rescheduleRequest(p) {
  const b = p.body || {};
  const cid = clientIdOf(b);
  if (!cid) throw new InputError("Refresh the page and try again.", "client_id");
  const v = await ownVisit(p.contact_id, p.params.id);
  if (!v || !OPEN_VISIT.includes(v.status)) return p.fail("not_found", "That visit isn't here.", 404);
  if (v.status !== "scheduled") throw new ConflictError("We're already on the way. Call us and we'll sort it out.", { code: "under_way" });
  const pol = await policy();
  if (hoursUntil(v) < pol.lateHours) {
    return p.json({ ok: false, error: { code: "late", message: `It's less than ${pol.lateHours} hours until this visit, so moving it now comes with a $${(pol.lateFee / 100).toFixed(2)} late fee. Give us a call and we'll see what we can do.` } }, 409);
  }
  const today = localDate(now());
  const dates = [...new Set((Array.isArray(b.dates) ? b.dates : []).filter((d) => isLocalDate(d)))].slice(0, 3);
  if (!dates.length) throw new InputError("Pick a day that works.", "dates");
  if (dates.some((d) => d <= today)) throw new InputError("Pick a day after today.", "dates");
  if (dates.some((d) => d > addLocalDays(today, 365))) throw new InputError("Pick a day in the next year.", "dates");
  const note = clean(b.note, 1000);
  const contact = await contactOf(p.contact_id);
  if (!contact) return p.fail("signed_out", "Open your link again.", 401);
  const seed = `portal-resched--${v.id}--${cid}`;
  const had = await getRecord("task", deriveId("task", seed, "portal.task", 1)).catch(() => null);
  if (!had) {
    if (!(await underCap(contact.id))) return p.fail("rate_limited", "That's a lot of requests today. Call or text us and we'll help.", 429);
    await stampCap(contact.id);
  }
  const { dayWords } = await import("../modules/plans/render.mjs");
  const title = `Reschedule request: ${dayWords(v.date)}`;
  const body = [`From the customer's account (portal). Nothing was moved.`, `The visit: ${dayWords(v.date)}, ${arrivalText(v)}.`, `Days that work: ${dates.map(dayWords).join(", ")}.`, note ? `Note: ${note}` : ""].filter(Boolean).join("\n");
  const { task, created } = await officeTask(contact, seed, { title, notes: body, visit_id: v.id, ...(v.job_id ? { job_id: v.job_id } : {}), request: { kind: "reschedule", dates } }, p.write());
  if (created) await tellOffice(`${nameOf(contact)} asked to move a visit`, `${dayWords(v.date)} → ${dates.map(dayWords).join(" or ")}`, task.id);
  return p.json({ ok: true, data: { request_id: task.id, already: !created } }, created ? 201 : 200);
}

// POST /api/portal/preferences { channel, on }: the customer's own choice (consent source "portal").
export async function setPreference(p) {
  const b = p.body || {};
  const channel = PREFS.some(([k]) => k === b.channel) ? b.channel : null;
  if (!channel) throw new InputError("Pick texts or emails.", "channel");
  if (typeof b.on !== "boolean") throw new InputError("On or off.", "on");
  const state = b.on ? "granted" : "revoked";
  const r = await updateRecord("contact", p.contact_id, (c) => {
    if (c.deleted_at || c.merged_into) return null;
    const cur = (c.consent || {})[channel] || {};
    if (cur.state === state) return null;
    return { ...c, consent: { ...(c.consent || {}), [channel]: { state, at: nowIso(), source: "portal", by: "portal" } } };
  }, p.write());
  if (r.changed) {
    const c = r.data;
    let addr = "none";
    try {
      if (channel.startsWith("sms")) { const ph = (c.phones || []).find((x) => x.primary) || (c.phones || [])[0]; if (ph) addr = hk("phone", ph.e164); }
      else { const e = (c.emails || []).find((x) => x.primary) || (c.emails || [])[0]; if (e) addr = hk("email", e.address); }
    } catch { addr = "none"; }
    await emit("consent.changed", { id: c.id, wv: c.wv, contact_id: c.id, channel, address_hk: addr, state }, p.write()).catch((e) => console.error(`crm:portal: consent.changed not queued (${safeErr(e)})`));
  }
  return p.json({ ok: true, data: { channel, on: b.on } });
}

// POST /api/portal/contact-info { client_id, name?, phone?, email?, note? }: a task; nothing on the
// contact changes by itself (a forwarded link must never be able to take the account's number).
export async function contactInfo(p) {
  const b = p.body || {};
  const cid = clientIdOf(b);
  if (!cid) throw new InputError("Refresh the page and try again.", "client_id");
  const name = clean(b.name, 120);
  const phone = clean(b.phone, 20);
  const email = clean(b.email, 120).toLowerCase();
  const note = clean(b.note, 1000);
  if (phone && String(phone).replace(/\D/g, "").replace(/^1(?=\d{10}$)/, "").length !== 10) throw new InputError("Enter a 10-digit number.", "phone");
  if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(email)) throw new InputError("That email doesn't look right.", "email");
  if (!name && !phone && !email && !note) throw new InputError("Tell us what changed.", "note");
  const contact = await contactOf(p.contact_id);
  if (!contact) return p.fail("signed_out", "Open your link again.", 401);
  const seed = `portal-info--${contact.id}--${cid}`;
  const had = await getRecord("task", deriveId("task", seed, "portal.task", 1)).catch(() => null);
  if (!had) {
    if (!(await underCap(contact.id))) return p.fail("rate_limited", "That's a lot of requests today. Call or text us and we'll help.", 429);
    await stampCap(contact.id);
  }
  const body = ["From the customer's account (portal). Check it with them before changing the contact.", name ? `Name: ${name}` : "", phone ? `Mobile: ${phone}` : "", email ? `Email: ${email}` : "", note ? `Note: ${note}` : ""].filter(Boolean).join("\n");
  const { task, created } = await officeTask(contact, seed, { title: "Update contact info", kind: "todo", notes: body, request: { kind: "contact_info" } }, p.write());
  if (created) await tellOffice(`${nameOf(contact)} sent new contact info`, "Check it and update the contact.", task.id);
  return p.json({ ok: true, data: { request_id: task.id } }, created ? 201 : 200);
}

// GET /api/portal/hub/files/:file: only a photo the tech marked customer-visible (before or
// after) on a finished visit of this contact. Anything else is 404.
export async function visitPhoto(p) {
  const id = p.params.file;
  const nf = () => p.fail("not_found", "Not found.", 404);
  if (!isId(id, "file")) return nf();
  const f = await getRecord("file", id).catch(() => null);
  if (!f || f.data.deleted_at || f.data.download_only || !f.data.owner || f.data.owner.type !== "visit" || !INLINE_TYPES.has(f.data.content_type)) return nf();
  const v = await getRecord("visit", f.data.owner.id).catch(() => null);
  if (!v || v.data.deleted_at || v.data.contact_id !== p.contact_id || v.data.status !== "completed") return nf();
  const shown = (v.data.photos || []).some((x) => x && x.file_id === id && x.customer_visible === true && ["before", "after"].includes(x.tag));
  if (!shown) return nf();
  const thumb = p.url.searchParams.get("thumb") === "1" && !!f.data.has_thumb;
  const ifNoneMatch = p.req.headers.get("if-none-match") || undefined;
  const got = await getFileStream(id, { thumb, ifNoneMatch });
  if (!got) return nf();
  const headers = { ...deliveryHeaders(f.data, { thumb, etag: got.etag || ifNoneMatch }), "Referrer-Policy": "no-referrer", "Cache-Control": "private, max-age=3600" };
  if (got.notModified) return new Response(null, { status: 304, headers });
  return new Response(got.stream, { status: 200, headers });
}

// ------------------------------------------------------------ pages

const page = (p, { title, body }, name) => p.portalPage(p.layout({ title, body, script: SCRIPT, company: p.company, page: name }));

export async function hubRoute(p) {
  const [contact, visits, invoices, agreements, quotes, plans] = await Promise.all([
    contactOf(p.contact_id), upcomingVisits(p.contact_id), openInvoices(p.contact_id), agreementsToSign(p.contact_id), openQuotes(p.contact_id), plansOf(p.contact_id, { limit: 3 }),
  ]);
  return page(p, hubPage({ contact, visits, invoices, agreements, quotes, plans: plans.map(planSummary) }), "hub");
}

const answer = (p, fn) => fn().catch((e) => {
  if (e instanceof ConflictError) return p.fail(e.code || "conflict", e.message, 409);
  if (e instanceof InputError) return p.json({ ok: false, error: { code: "invalid", message: e.message, field: e.field } }, 400);
  if (e instanceof NotFoundError) return p.fail("not_found", e.message || "Not found.", 404);
  throw e;
});

export const accountRoutes = [
  { method: "GET", path: "/p/hub", scope: "hub", handler: hubRoute },
  {
    method: "GET", path: "/p/visits", scope: "hub",
    handler: async (p) => { const [visits, pol] = await Promise.all([upcomingVisits(p.contact_id), policy()]); return page(p, visitsPage({ visits, lateHours: pol.lateHours }), "visits"); },
  },
  {
    method: "GET", path: "/p/history", scope: "hub",
    handler: async (p) => {
      const [h, invoices] = await Promise.all([pastVisits(p.contact_id, { before: p.url.searchParams.get("before") || "" }), invoiceList(p.contact_id)]);
      return page(p, historyPage({ ...h, invoices }), "history");
    },
  },
  {
    method: "GET", path: "/p/plan", scope: "hub",
    handler: async (p) => {
      const [plans, pol] = await Promise.all([plansOf(p.contact_id, { limit: 2 }), policy()]);
      const details = [];
      for (const x of plans) details.push(await planDetails(x, pol.perkNames));
      return page(p, planPage({ plans: details, lateFee: pol.lateFee, lateHours: pol.lateHours, noticeDays: pol.noticeDays }), "plan");
    },
  },
  {
    method: "GET", path: "/p/request", scope: "hub",
    handler: async (p) => {
      const rows = await listRel("contact-properties", p.contact_id, { limit: 6 }).catch(() => []);
      const props = (await getRecords("property", rows.map((r) => r.id)).catch(() => [])).filter(Boolean).map((g) => g.data)
        .filter((x) => !x.deleted_at && x.contact_id === p.contact_id).map((x) => ({ id: x.id, label: x.label || "Home", town: (x.address && x.address.city) || "" }));
      return page(p, requestPage({ properties: props, done: p.url.searchParams.get("sent") === "1" }), "request");
    },
  },
  // a request with photos writes the task, each photo and its file record: more than a page's 30 storage calls
  { method: "POST", path: "/api/portal/requests", scope: "hub", maxBody: REQUEST_MAX_BODY, handler: (p) => answer(p, () => withStoreScope({ budget: withBudget(9000, REQUEST_CALLS) }, () => requestWork(p))) },
  {
    method: "GET", path: "/p/visits/:id/reschedule", scope: "hub",
    handler: async (p) => {
      const v = await ownVisit(p.contact_id, p.params.id);
      if (!v || !OPEN_VISIT.includes(v.status)) return p.message("That visit isn't here", "Go back to your account, or call us.", { status: 404, company: p.company });
      const [pol, names] = await Promise.all([policy(), firstNames()]);
      const late = v.status !== "scheduled" || hoursUntil(v) < pol.lateHours;
      return page(p, reschedulePage({ visit: visitView(v, names), late, lateHours: pol.lateHours, lateFee: pol.lateFee, minDate: addLocalDays(localDate(now()), 1), done: p.url.searchParams.get("sent") === "1" }), "reschedule");
    },
  },
  { method: "POST", path: "/api/portal/visits/:id/reschedule-request", scope: "hub", handler: (p) => answer(p, () => rescheduleRequest(p)) },
  {
    method: "GET", path: "/p/account", scope: "hub",
    handler: async (p) => {
      const c = await contactOf(p.contact_id);
      if (!c) return p.message("Open your link again", "For your privacy this page opens only from the link we sent you.", { status: 401, company: p.company });
      const ph = (c.phones || []).find((x) => x && x.primary) || (c.phones || [])[0];
      const em = (c.emails || []).find((x) => x && x.primary) || (c.emails || [])[0];
      return page(p, accountPage({ contact: c, masked: { phone: ph ? maskPhone(ph.e164) : "", email: em ? maskEmail(em.address) : "" } }), "account");
    },
  },
  { method: "POST", path: "/api/portal/preferences", scope: "hub", handler: (p) => answer(p, () => setPreference(p)) },
  { method: "POST", path: "/api/portal/contact-info", scope: "hub", handler: (p) => answer(p, () => contactInfo(p)) },
  { method: "GET", path: "/api/portal/hub/files/:file", scope: "hub", handler: visitPhoto },
];

// POST /api/portal/hub/open {kind: "quote" | "invoice", id}: a short link to one of
// this contact's open quotes or invoices (the hub session gets a grant for it). → { location }
export async function hubOpen(p) {
  const b = p.body || {};
  const tomorrowEnd = zonedToUtc(addLocalDays(localDate(now()), 1), "23:59").toISOString();
  if (b.kind === "quote") {
    if (!isId(b.id, "quote")) throw new InputError("Open which quote?", "id");
    const g = await getRecord("quote", b.id).catch(() => null);
    if (!g || g.data.deleted_at || g.data.contact_id !== p.contact_id || !["sent", "viewed"].includes(g.data.status)) return p.fail("not_found", "That quote isn't here.", 404);
  } else if (b.kind === "invoice") {
    if (!isId(b.id, "invoice")) throw new InputError("Open which invoice?", "id");
    const g = await getRecord("invoice", b.id).catch(() => null);
    if (!g || g.data.deleted_at || g.data.contact_id !== p.contact_id || !["open", "paid"].includes(g.data.status)) return p.fail("not_found", "That invoice isn't here.", 404);
  } else throw new InputError("Open which one?", "kind");
  const link = await createPortalLink({ contact_id: p.contact_id, scope: { kind: b.kind, id: b.id }, expires_at: tomorrowEnd, created_by: "portal:hub" });
  return p.json({ ok: true, data: { location: `/p/${link.code}` } });
}
