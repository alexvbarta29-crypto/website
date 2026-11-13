// Work module, office part: the API (design §5.5 "Office endpoints", §4.5,
// §4.6, §9.2 Schedule, Route, Job, Visit, contact tab Work, Settings →
// Checklists).
//
// schedule:read (owners and the office; a technician holds it as "own"):
// the schedule, the tray, jobs and visits. List routes (subject "none")
// need the unscoped permission, so a technician gets 403 there and works
// from their own day (the tech app, M4b) and one visit at a time:
//   GET /visits/:id and GET /jobs/:id for a technician answer only for a
//   visit of theirs dated within [today − 7, today + 30] (§4.6; anything
//   else is 404, so ids can't be probed), with techFields only, the
//   contact's name and phones, the property, and line prices only while
//   they hold visits:prices for it (D11).
// schedule:write (owners and the office): book, move, assign, cancel,
// route order, the rain-day move, jobs, time off. settings:general:
// Settings → Checklists.

import { getRecord, getRecords, createRecord, updateRecord, readIndex, softDelete, getRaw, listRel } from "../../../crm-store.mjs";
import { isId, newId, deriveId } from "../../core/ids.mjs";
import { now, nowIso, localDate, addLocalDays, zonedToUtc, isLocalDate, isLocalTime } from "../../core/clock.mjs";
import { InputError, NotFoundError, ConflictError, ExistsError } from "../../core/errors.mjs";
import { techView, TECH_WINDOW } from "../../core/perms.mjs";
import { keySafe } from "../../core/text.mjs";
import { getSetting } from "../../../crm-store.mjs";
import { OPEN_JOB, OPEN_VISIT, VISIT_STATES } from "./states.mjs";
import { JOB_KINDS, WINDOW_TYPES, MAX_ASSIGNEES, DEFAULT_WINDOW } from "./types.mjs";
import {
  createJobs, createVisit, changeVisit, cancelJob, reopenJob, completeJob, syncJob, liveContact, placeOf, W, workSettings, typesOfLines, refreshVisits,
} from "./office.mjs";
import { titleFromLines } from "./types.mjs";
import { scheduleRange, checkSlot, routeOrder, windowEnd, visitRows, checkRange, calendarEnv, arrivalWindow, toMin, fromMin, toBookRows, monthGridRange, withAmounts, withPaid, capacityOf, crewOf } from "./office-schedule.mjs";
import { moveDayPreview, moveDayConfirm, runView } from "./office-moveday.mjs";
import { scheduleWeather } from "./weather.mjs";

const str = (v) => (v == null ? "" : String(v)).trim();
const view = (r) => { if (!r) return r; const { _w, _etag, ...rest } = r; return rest; };
const CLIENT_ID = /^[A-Za-z0-9-]{8,64}$/;
const clientId = (b) => (typeof b.client_id === "string" && CLIENT_ID.test(b.client_id) ? b.client_id.toLowerCase() : null);
const office = (ctx) => ctx.can("schedule:read");          // unscoped: owners and the office

async function rec(type, id, what) {
  if (!isId(id, type)) throw new NotFoundError(`That ${what} isn't there.`);
  const got = await getRecord(type, id);
  if (!got || got.data.deleted_at) throw new NotFoundError(`That ${what} isn't there.`);
  return got;
}

// A technician's own visit in the window (§4.6), else 404.
function inTechWindow(v) {
  const today = localDate(now());
  return v.date >= addLocalDays(today, -TECH_WINDOW.before) && v.date <= addLocalDays(today, TECH_WINDOW.after);
}
function techMayRead(ctx, v) {
  return !!ctx.user && ctx.can("schedule:read", { type: "visit", record: v }) && inTechWindow(v);
}

// Line prices for someone who may not see them (D11 "hidden"): titles and quantities only.
const noPrices = (lines = []) => lines.map(({ unit_cents, total_cents, engine_cents, override, ...l }) => l);

function jobView(ctx, job, { prices = true } = {}) {
  if (office(ctx)) return view(job);
  const j = techView("job", job);
  if (!prices) { j.lines = noPrices(j.lines); delete j.totals; delete j.discounts; }
  return j;
}

async function usersById() {
  const ix = await readIndex("users", "");
  return new Map(ix.rows.map((r) => [r.id, { id: r.id, name: r.name, first_name: r.first_name, color: r.color, is_technician: !!r.is_technician, status: r.status }]));
}

// A technician gets the contact's techFields only (display_name, first_name, phones).
const contactFor = (c, { tech }) => (c ? (tech ? { id: c.id, display_name: c.display_name, first_name: c.first_name, phones: c.phones || [] }
  : { id: c.id, display_name: c.display_name || [c.first_name, c.last_name].filter(Boolean).join(" "), first_name: c.first_name, phones: c.phones || [], emails: c.emails || [], lifecycle: c.lifecycle, flags: c.flags || {} }) : null);
const propertyFor = (p) => (p ? { id: p.id, label: p.label, address: p.address, access: p.access || {}, geo: p.geo || null, town_tier: p.town_tier || null } : null);

// ------------------------------------------------------------ input checks

function slotInput(b, { partial = false } = {}) {
  const out = {};
  if (b.date !== undefined || !partial) { if (!isLocalDate(b.date)) throw new InputError("Pick a date.", "date"); out.date = b.date; }
  if (b.start !== undefined || !partial) { if (!isLocalTime(b.start)) throw new InputError("Pick a start time.", "start"); out.start = b.start; }
  if (b.end !== undefined || !partial) { if (!isLocalTime(b.end)) throw new InputError("Pick an end time.", "end"); out.end = b.end; }
  if (b.window !== undefined) {
    const w = b.window || {};
    if (!WINDOW_TYPES.includes(w.type)) throw new InputError("Pick an arrival window.", "window");
    out.window = { type: w.type, minutes: w.type === "window" ? Number(w.minutes) || DEFAULT_WINDOW.minutes : 0 };
    if (w.type === "window" && !(Number.isInteger(out.window.minutes) && out.window.minutes >= 15 && out.window.minutes <= 720)) throw new InputError("Use a window from 15 minutes to 12 hours.", "window");
  }
  if (b.assignee_ids !== undefined) {
    if (!Array.isArray(b.assignee_ids) || b.assignee_ids.length > MAX_ASSIGNEES || b.assignee_ids.some((x) => !isId(x, "user"))) throw new InputError("Pick people on the team.", "assignee_ids");
    out.assignee_ids = [...new Set(b.assignee_ids)];
  }
  if (b.date_only !== undefined) out.date_only = b.date_only === true;
  if (out.start && out.end && out.end <= out.start) throw new InputError("The visit ends after it starts.", "end");
  return out;
}

async function activeUsers(ids) {
  if (!ids || !ids.length) return;
  const users = await usersById();
  for (const id of ids) {
    const u = users.get(id);
    if (!u || u.status !== "active") throw new InputError("Pick people on the team.", "assignee_ids");
  }
}

// ------------------------------------------------------------ the schedule

// ?from&to (a day, a week, two weeks), or ?month=yyyy-mm|now: the month
// view's whole grid in one read (Sunday first, the leading and trailing
// days too). ?amounts=1 adds each visit's job total for people who may see
// prices. `today` is the server's day (a phone's clock may be off).
// Every answer carries `capacity` (how many visits each day can take, for
// the fill bars) and `defaults` (a new visit's length and arrival window,
// for a booking dropped on a day); a month also carries `to_book` (the
// tray's count of jobs due by that month). ?pay=1 with amounts (not for a
// month) adds `pd` to finished visits: their job is paid (1) or not (0).
// ?sales=1 (not a month; with tasks:read) adds `sales`: the sales tasks
// with a time (the Day view's "Sales rep" columns).
const schedule = async (ctx) => {
  const today = localDate(now());
  let from = str(ctx.query.get("from")) || today;
  let to = str(ctx.query.get("to")) || from;
  const m = str(ctx.query.get("month"));
  const month = m === "now" ? today.slice(0, 7) : m || null;
  if (month) [from, to] = monthGridRange(month);
  const users = str(ctx.query.get("users")).split(",").filter((x) => isId(x, "user"));
  const data = await scheduleRange({ from, to, users, sales: ctx.query.get("sales") === "1" && !month && ctx.can("tasks:read") });
  const [usersIx, work, openIx] = await Promise.all([readIndex("users", ""), workSettings(), month ? readIndex("jobs", "open") : null]);
  const prices = ctx.query.get("amounts") === "1" && ctx.can("visits:prices");
  if (prices) data.visits = await withAmounts(data.visits, { from, to, today, openRows: openIx ? openIx.rows : undefined });
  // ?pay=1 (a day or three): whether each finished visit's job is paid, for the red $
  if (prices && ctx.query.get("pay") === "1" && !month) data.visits = await withPaid(data.visits, { today });
  const capacity = capacityOf(from, to, { perDay: work.visits_per_day, crew: crewOf(usersIx.rows), timeOff: data.time_off, hours: data.hours, calendar: data.calendar });
  const extra = { capacity, defaults: { duration_min: work.default_duration_min, window_min: work.default_window_minutes }, weather: work.weather !== false };
  if (month) extra.to_book = toBookRows(openIx.rows, month).length;
  return { data: { ...data, ...extra, from, to, today, ...(month ? { month } : {}) }, meta: { stale: data.stale || !!(openIx && openIx.stale) } };
};

// The next days' forecast for the schedule (weather.mjs): never an error.
const weather = async (ctx) => ({ data: await scheduleWeather({ deploy: ctx.deploy }) });

const unscheduled = async (ctx) => {
  const month = str(ctx.query.get("month")) || localDate(now()).slice(0, 7);
  if (!/^\d{4}-\d{2}$/.test(month)) throw new InputError("Use a month like 2026-11.", "month");
  const ix = await readIndex("jobs", "open");
  const rows = toBookRows(ix.rows, month);
  const later = ix.rows.filter((r) => r.st === "unscheduled" && r.tm && r.tm > month).length;
  return { data: { month, jobs: rows, later }, meta: { stale: ix.stale } };
};

const check = async (ctx) => {
  const q = ctx.query;
  const slot = {
    date: str(q.get("date")), start: str(q.get("start")), end: str(q.get("end")),
    assignee_ids: str(q.get("users")).split(",").filter((x) => isId(x, "user")).slice(0, MAX_ASSIGNEES),
    visit_id: isId(str(q.get("visit")), "visit") ? str(q.get("visit")) : undefined, town: str(q.get("town")).slice(0, 80),
  };
  if (!isLocalDate(slot.date) || !isLocalTime(slot.start) || !isLocalTime(slot.end)) return { data: { warnings: [], hints: [] } };
  return { data: await checkSlot(slot) };
};

// A stop's number on one person's route (route_order is { user id: n }, so
// two people sharing a visit each keep their own order; a plain number is
// an older record's, the same for everyone).
export const stopNo = (o, uid) => (typeof o === "number" ? o : o && typeof o === "object" && Number.isInteger(o[uid]) ? o[uid] : null);

// One tech's day in route order: index rows, with the map point taken from
// the property when the visit has none yet (it was geocoded after booking).
async function dayStops(date, userId) {
  const { rows } = await visitRows(date, date);
  const mine = rows.filter((r) => (r.a || []).includes(userId) && !["cancelled", "no_access"].includes(r.st))
    .sort((a, b) => (stopNo(a.o, userId) || 999) - (stopNo(b.o, userId) || 999) || String(a.s).localeCompare(String(b.s)));
  const need = [...new Set(mine.filter((r) => !r.geo && isId(r.pr, "property")).map((r) => r.pr))];
  if (!need.length) return mine;
  const props = new Map((await getRecords("property", need)).filter(Boolean).map((g) => [g.data.id, g.data]));
  return mine.map((r) => {
    const p = !r.geo && props.get(r.pr);
    return p && p.geo && Number.isFinite(p.geo.lat) && Number.isFinite(p.geo.lng) ? { ...r, geo: [p.geo.lat, p.geo.lng], geo_new: true } : r;
  });
}

const routeGet = async (ctx) => {
  const date = str(ctx.query.get("date"));
  const user = str(ctx.query.get("user"));
  if (!isLocalDate(date)) throw new InputError("Pick a day.", "date");
  if (!isId(user, "user")) throw new InputError("Pick someone.", "user");
  const [stops, company] = await Promise.all([dayStops(date, user), getSetting("company").catch(() => ({}))]);
  return { data: { date, user_id: user, stops: stops.map(({ geo_new, ...r }) => ({ ...r, o: stopNo(r.o, user) })), base: (company && company.base) || null } };
};

// POST /schedule/route { date, user_id, order? }: Optimize (no order) or the
// order someone moved. Writes this person's stop number on each visit that
// changed (and a map point the visit learned from its property).
const routePost = async (ctx) => {
  const b = ctx.body || {};
  if (!isLocalDate(b.date)) throw new InputError("Pick a day.", "date");
  if (!isId(b.user_id, "user")) throw new InputError("Pick someone.", "user_id");
  const [stops, company, env] = await Promise.all([dayStops(b.date, b.user_id), getSetting("company").catch(() => ({})), calendarEnv()]);
  if (!stops.length) return { data: { order: [], no_geo: [], miles: 0, changed: 0 } };
  let order;
  let result = { no_geo: [], miles: null };
  if (Array.isArray(b.order)) {
    const ids = new Set(stops.map((s) => s.id));
    if (b.order.length !== stops.length || b.order.some((x) => !ids.has(x)) || new Set(b.order).size !== b.order.length) throw new ConflictError("The day changed. Load it again.");
    order = b.order;
  } else {
    result = routeOrder(stops.map((s) => ({ id: s.id, geo: s.geo, start: s.s, wend: windowEnd({ date: s.d, start: s.s, window: { type: s.w && s.w.t, minutes: s.w && s.w.m }, date_only: s.do }, env.hours) })), company && company.base);
    order = result.order;
  }
  const geoOf = new Map(stops.filter((s) => s.geo_new).map((s) => [s.id, s.geo]));
  let changed = 0;
  const w = W(ctx);
  for (const [i, id] of order.entries()) {
    const want = i + 1;
    const r = await updateRecord("visit", id, (v) => {
      const cur = v.route_order && typeof v.route_order === "object" ? v.route_order : {};
      const geo = geoOf.get(id);
      if (cur[b.user_id] === want && !(geo && !v.geo)) return null;
      return { ...v, route_order: { ...cur, [b.user_id]: want }, ...(geo && !v.geo ? { geo } : {}) };
    }, w);
    if (r.changed) changed += 1;
  }
  return { data: { order, no_geo: result.no_geo, miles: result.miles, changed } };
};

const moveDay = async (ctx) => {
  const b = ctx.body || {};
  if (b.confirm !== true) return { data: await moveDayPreview(b) };
  const run = await moveDayConfirm(b, ctx);
  return { status: 202, data: { run_id: run.id, run: runView(run) } };
};

// ------------------------------------------------------------ jobs

const jobs = async (ctx) => {
  const status = str(ctx.query.get("status")) || "open";
  const contact = str(ctx.query.get("contact"));
  if (contact) {
    if (!isId(contact, "contact")) throw new InputError("That isn't a contact.", "contact");
    return { data: await contactJobs(contact) };
  }
  let rows;
  let stale = false;
  if (status === "open" || status === "stale") {
    const ix = await readIndex("jobs", "open");
    rows = ix.rows; stale = ix.stale;
    if (status === "stale" || ctx.query.get("stale") === "1") rows = rows.filter((r) => r.stale);
  } else {
    const year = str(ctx.query.get("year")) || localDate(now()).slice(0, 4);
    if (!/^\d{4}$/.test(year)) throw new InputError("Use a year like 2026.", "year");
    const ix = await readIndex("jobs", year);
    rows = ix.rows.filter((r) => (status === "done" ? r.st === "completed" : status === "cancelled" ? r.st === "cancelled" : true)); stale = ix.stale;
  }
  const order = { in_progress: 0, scheduled: 1, unscheduled: 2, completed: 3, cancelled: 4 };
  rows = rows.slice().sort((a, b) => (order[a.st] ?? 9) - (order[b.st] ?? 9) || String(a.nv || a.tm || "9999").localeCompare(String(b.nv || b.tm || "9999")) || String(b.u).localeCompare(String(a.u)));
  return { data: rows, meta: { total: rows.length, stale } };
};

async function contactJobs(contactId) {
  const rel = await listRel("contact-jobs", contactId, { limit: 40 });
  const got = (await getRecords("job", rel.map((r) => r.id))).filter(Boolean).map((g) => g.data).filter((j) => !j.deleted_at && j.contact_id === contactId);
  return got.map((j) => ({ id: j.id, number_label: j.number_label, title: j.title, kind: j.kind, status: j.status, totals: j.totals, schedule: j.schedule || {}, target_month: j.target_month || null, visit_ids: j.visit_ids || [], created_at: j.created_at, completed_at: j.completed_at || null }));
}

// GET /work/contacts/:id: the contact's Work tab: jobs and their visits.
const contactWork = async (ctx) => {
  const contact = await liveContact(ctx.params.id, ctx);
  if (!contact) throw new NotFoundError("That contact isn't there.");
  const list = await contactJobs(contact.id);
  const visitIds = list.flatMap((j) => j.visit_ids).slice(0, 60);
  const visits = (await getRecords("visit", visitIds)).filter(Boolean).map((g) => g.data).filter((v) => !v.deleted_at);
  const today = localDate(now());
  const upcoming = visits.filter((v) => OPEN_VISIT.includes(v.status) && v.date >= today).sort((a, b) => (a.date + a.start).localeCompare(b.date + b.start));
  const past = visits.filter((v) => !(OPEN_VISIT.includes(v.status) && v.date >= today)).sort((a, b) => (b.date + b.start).localeCompare(a.date + a.start)).slice(0, 20);
  const slim = (v) => ({ id: v.id, job_id: v.job_id, date: v.date, start: v.start, end: v.end, window: v.window, status: v.status, assignee_ids: v.assignee_ids || [], job_title: v.job_title, job_number: v.job_number, date_only: v.date_only === true });
  return { data: { contact: { id: contact.id, display_name: contact.display_name }, jobs: list.map(({ visit_ids, ...j }) => j), upcoming: upcoming.map(slim), past: past.map(slim) } };
};

// The lines a person typed on the New job / Edit job form: only what the
// form shows (title, price, quantity, service), never totals, overrides or
// scopes. → [{ id?, title, unit_cents, qty_milli, service_type? }]
function formLines(list) {
  if (list === undefined) return undefined;
  if (!Array.isArray(list) || list.length > 40) throw new InputError("Up to 40 lines.", "lines");
  return list.map((l, i) => {
    if (!l || typeof l !== "object") throw new InputError("Expected a line.", `lines.${i}`);
    const title = str(l.title);
    if (!title) throw new InputError("Name the work.", `lines.${i}.title`);
    const unit = Number.isSafeInteger(l.unit_cents) ? l.unit_cents : null;
    if (unit === null || unit < 0 || unit > 100000000) throw new InputError("Use a price in cents.", `lines.${i}.unit_cents`);
    const qty = l.qty_milli === undefined ? 1000 : l.qty_milli;
    if (!Number.isSafeInteger(qty) || qty < 0 || qty > 10000000) throw new InputError("Use a quantity.", `lines.${i}.qty_milli`);
    const id = str(l.id);
    return {
      ...(id && /^[A-Za-z0-9_.:-]{1,80}$/.test(id) ? { id } : {}), title: title.slice(0, 160), unit_cents: unit, qty_milli: qty,
      ...(str(l.service_type) ? { service_type: str(l.service_type).slice(0, 120) } : {}),
    };
  });
}

// The edited lines merged by id onto the stored ones (B1): a line keeps
// everything the form doesn't show (scope, override, optional, tier,
// upsell, show, rotor, its total) while its price and quantity stay as
// they were; a changed price or quantity is priced again; a new line gets
// a new id; a line left out is gone.
export function mergeLines(stored = [], edited = []) {
  const byId = new Map((stored || []).map((l) => [l.id, l]));
  const used = new Set();
  let n = Math.max(0, ...[...(stored || []), ...edited].map((l) => { const m = /^ln_(\d+)$/.exec(String(l.id || "")); return m ? Number(m[1]) : 0; }));
  return edited.map((e) => {
    const old = e.id ? byId.get(e.id) : null;
    if (old && !used.has(old.id)) {
      used.add(old.id);
      const next = { ...old, title: e.title };
      if (e.service_type) next.service_type = e.service_type; else delete next.service_type;
      if (old.unit_cents !== e.unit_cents || (old.qty_milli ?? 1000) !== e.qty_milli) {
        next.unit_cents = e.unit_cents; next.qty_milli = e.qty_milli;
        delete next.total_cents; delete next.override; delete next.engine_cents;
      }
      return next;
    }
    n += 1;
    return { id: `ln_${n}`, title: e.title, unit_cents: e.unit_cents, qty_milli: e.qty_milli, ...(e.service_type ? { service_type: e.service_type } : {}), scope: { type: "all" } };
  });
}

const newJob = async (ctx) => {
  const b = ctx.body || {};
  const contact = await liveContact(b.contact_id, ctx);
  if (!contact) throw new InputError("Pick the contact.", "contact_id");
  if (b.kind !== undefined && !JOB_KINDS.includes(b.kind)) throw new InputError("Pick a kind of job.", "kind");
  const lines = formLines(b.lines) || [];
  const spec = {
    contact_id: contact.id, ...(isId(b.property_id, "property") ? { property_id: b.property_id } : {}), kind: b.kind || "standard",
    ...(str(b.title) ? { title: str(b.title).slice(0, 160) } : {}), lines, discounts: [], ...(str(b.target_month) ? { target_month: str(b.target_month) } : {}),
    crew_notes: str(b.crew_notes).slice(0, 2000), office_notes: str(b.office_notes).slice(0, 4000), service_types: typesOfLines(lines),
    ...(b.billable !== undefined ? { billable: b.billable === true } : {}),
  };
  const cid = clientId(b) || newId("event").slice(3);
  const [id] = await createJobs([spec], `newjob--${cid}`, "manual", ctx);
  let visit = null;
  let warnings = [];
  if (b.visit && typeof b.visit === "object") {
    const slot = slotInput(b.visit);
    await activeUsers(slot.assignee_ids);
    visit = (await createVisit({ ...slot, job_id: id, client_id: cid + "-v1" }, ctx)).visit;
    warnings = (await checkSlot({ ...slot, visit_id: visit.id, town: visit.town }).catch(() => ({ warnings: [] }))).warnings;
  }
  const job = (await getRecord("job", id)).data;
  return { status: 201, data: { job: view(job), visit: visit ? view(visit) : null }, meta: { warnings } };
};

async function jobDetail(ctx, got) {
  const job = got.data;
  const visits = (await getRecords("visit", job.visit_ids || [])).filter(Boolean).map((g) => g.data).filter((v) => !v.deleted_at)
    .sort((a, b) => (a.ordering || 0) - (b.ordering || 0) || (a.date + a.start).localeCompare(b.date + b.start));
  const isOffice = office(ctx);
  let mine = visits;
  if (!isOffice) {
    mine = visits.filter((v) => techMayRead(ctx, v));
    if (!mine.length) throw new NotFoundError("That job isn't there.");
  }
  const prices = isOffice || mine.some((v) => ctx.can("visits:prices", { type: "visit", record: v }));
  const [contact, users] = await Promise.all([liveContact(job.contact_id, ctx), usersById()]);
  const prop = job.property_id ? await getRecord("property", job.property_id) : null;
  return {
    job: jobView(ctx, job, { prices }),
    visits: mine.map((v) => (isOffice ? view(v) : techView("visit", v))),
    contact: contactFor(contact, { tech: !isOffice }),
    property: prop && !prop.data.deleted_at ? propertyFor(prop.data) : null,
    people: Object.fromEntries([...new Set(visits.flatMap((v) => v.assignee_ids || []))].map((id) => [id, users.get(id) || { id, name: "Someone" }])),
    can: { write: ctx.can("schedule:write"), add_visit: ctx.can("schedule:write") && ["unscheduled", "scheduled", "in_progress"].includes(job.status), complete: ctx.can("schedule:write") && ["scheduled", "in_progress"].includes(job.status), cancel: ctx.can("schedule:write") && OPEN_JOB.includes(job.status), reopen: ctx.can("schedule:write") && job.status === "completed" },
  };
}

const jobGet = async (ctx) => {
  const got = await rec("job", ctx.params.id, "job");
  return { data: await jobDetail(ctx, got), etag: office(ctx) ? got.etag : undefined };
};

const JOB_EDITABLE = ["title", "kind", "crew_notes", "office_notes", "target_month", "property_id", "billable"];
const jobPatch = async (ctx) => {
  if (!ctx.ifMatch) throw new InputError("This change needs the version you edited (If-Match).", "if-match");
  const got = await rec("job", ctx.params.id, "job");
  const b = ctx.body || {};
  const patch = {};
  for (const k of JOB_EDITABLE) if (b[k] !== undefined) patch[k] = b[k] === "" || b[k] === null ? undefined : b[k];
  if (patch.kind !== undefined && !JOB_KINDS.includes(patch.kind)) throw new InputError("Pick a kind of job.", "kind");
  if (patch.property_id !== undefined) {
    const p = isId(patch.property_id, "property") ? await getRecord("property", patch.property_id) : null;
    if (!p || p.data.contact_id !== got.data.contact_id) throw new InputError("Pick one of the contact's properties.", "property_id");
  }
  const edited = formLines(b.lines);
  const closed = ["completed", "cancelled"].includes(got.data.status);
  if (closed && ((edited && JSON.stringify(mergeLines(got.data.lines, edited)) !== JSON.stringify(got.data.lines)) || (patch.kind !== undefined && patch.kind !== got.data.kind))) {
    throw new ConflictError("This job is closed. Reopen it to change its work.");
  }
  const r = await updateRecord("job", got.data.id, (j) => {
    const next = { ...j };
    for (const [k, v] of Object.entries(patch)) { if (v === undefined) delete next[k]; else next[k] = v; }
    if (edited) {
      next.lines = mergeLines(j.lines, edited);
      next.service_types = typesOfLines(next.lines);
      // the title follows the lines unless someone typed one
      if (b.title === undefined && j.title === titleFromLines(j.lines || [], j.kind)) delete next.title;
    }
    return JSON.stringify(next) === JSON.stringify(j) ? null : next;
  }, { ...W(ctx), ifMatch: ctx.ifMatch });
  // what the open visits copied of the job (title, services, place) follows it
  if (r.changed) await refreshVisits(r.data.id, ctx, { propertyFrom: got.data.property_id !== r.data.property_id ? got.data.property_id : undefined }).catch((e) => console.error(`crm:work: visits not refreshed (${String(e && e.name)})`));
  return { data: { job: view(r.data) }, etag: r.etag };
};

const jobCancel = async (ctx) => {
  const b = ctx.body || {};
  const reason = str(b.reason).slice(0, 300);
  if (!reason) throw new InputError("Say why it's cancelled.", "reason");
  const job = await cancelJob(ctx.params.id, reason, ctx, { ifMatch: ctx.ifMatch });
  return { data: { job: view(job) } };
};
const jobReopen = async (ctx) => ({ data: { job: view(await reopenJob(ctx.params.id, ctx)) } });
const jobComplete = async (ctx) => ({ data: { job: view(await completeJob(ctx.params.id, ctx)) } });

// ------------------------------------------------------------ visits

const visitNew = async (ctx) => {
  const b = ctx.body || {};
  const slot = slotInput(b);
  await activeUsers(slot.assignee_ids);
  const r = await createVisit({ ...slot, job_id: b.job_id, client_id: clientId(b) || undefined, ...(isId(b.property_id, "property") ? { property_id: b.property_id } : {}) }, ctx);
  const warn = await checkSlot({ ...slot, assignee_ids: r.visit.assignee_ids, visit_id: r.visit.id, town: r.visit.town }).catch(() => ({ warnings: [], hints: [] }));
  return { status: r.replay ? 200 : 201, data: { visit: view(r.visit), job: r.job ? view(r.job) : null }, meta: { warnings: warn.warnings } };
};

async function reminderStates(v) {
  const hhmm = String(v.start).replace(":", "");
  const keys = [["confirm", `visit.confirm/${v.id}--${v.date}-${hhmm}`], ["d14", `visit.reminder_14d/${v.id}--${v.date}`], ["d2", `visit.reminder_2d/${v.id}--${v.date}-${hhmm}`]];
  const out = {};
  await Promise.all(keys.map(async ([k, key]) => {
    const [live, dry] = await Promise.all([getRaw(`done/${key}`).catch(() => null), getRaw(`done-dry/${key}`).catch(() => null)]);
    const m = (live && live.data) || (dry && dry.data);
    out[k] = m ? { state: m.state, dry: !(live && live.data), at: m.updated_at || m.at || null, result: m.result || null } : null;
  }));
  return out;
}

const visitGet = async (ctx) => {
  const got = await rec("visit", ctx.params.id, "visit");
  const v = got.data;
  const isOffice = office(ctx);
  if (!isOffice && !techMayRead(ctx, v)) throw new NotFoundError("That visit isn't there.");
  const assignee = !!ctx.user && (v.assignee_ids || []).includes(ctx.user.id);
  const prices = isOffice || ctx.can("visits:prices", { type: "visit", record: v });
  const [job, contact, users, hours, s] = await Promise.all([getRecord("job", v.job_id), liveContact(v.contact_id, ctx), usersById(), getSetting("hours").catch(() => undefined), workSettings()]);
  const prop = v.property_id ? await getRecord("property", v.property_id) : null;
  const reminders = isOffice ? await reminderStates(v) : undefined;
  const reopenable = v.status === "completed" && Date.parse((v.completion && v.completion.at) || v.updated_at) > now().getTime() - (s.reopen_days || 7) * 86400000;
  return {
    data: {
      visit: isOffice ? view(v) : techView("visit", v),
      job: job ? jobView(ctx, job.data, { prices }) : null,
      contact: contactFor(contact, { tech: !isOffice }),
      property: prop && !prop.data.deleted_at ? propertyFor(prop.data) : null,
      people: (v.assignee_ids || []).map((id) => users.get(id) || { id, name: "Someone" }),
      arrival: arrivalWindow(v, hours),
      ...(reminders ? { reminders } : {}),
      can: {
        office: ctx.can("schedule:write"), assignee, prices, reopen: ctx.can("schedule:write") && reopenable,
        move: ctx.can("schedule:write") && v.status === "scheduled", cancel: ctx.can("schedule:write") && !["completed", "cancelled"].includes(v.status),
        no_access: ctx.can("schedule:write") && ["scheduled", "en_route"].includes(v.status), done: ctx.can("schedule:write") && OPEN_VISIT.includes(v.status),
      },
    },
    etag: got.etag,
  };
};

const SLOT_FIELDS = ["date", "start", "end", "window", "date_only"];
const visitPatch = async (ctx) => {
  if (!ctx.ifMatch) throw new InputError("This change needs the version you edited (If-Match).", "if-match");
  const got = await rec("visit", ctx.params.id, "visit");
  const v = got.data;
  const patch = slotInput(ctx.body || {}, { partial: true });
  if (patch.assignee_ids) await activeUsers(patch.assignee_ids);
  if (patch.date_only === false) patch.date_only = undefined;
  const moving = SLOT_FIELDS.some((k) => patch[k] !== undefined && JSON.stringify(patch[k]) !== JSON.stringify(v[k]));
  if (moving && v.status !== "scheduled") throw new ConflictError("Only a visit that hasn't started can be moved.");
  if (!moving && !canAssign(v.status)) throw new ConflictError("This visit is closed.");
  const event = moving ? "reschedule" : "assign";
  const next = { ...v, ...patch };
  if (next.end <= next.start) throw new InputError("The visit ends after it starts.", "end");
  const r = await changeVisit(v.id, event, { patch, ifMatch: ctx.ifMatch, ctx });
  const warn = await checkSlot({ date: r.visit.date, start: r.visit.start, end: r.visit.end, assignee_ids: r.visit.assignee_ids, visit_id: r.visit.id, town: r.visit.town }).catch(() => ({ warnings: [] }));
  const fresh = await getRecord("visit", v.id);
  return { data: { visit: view(r.visit), job: r.job ? view(r.job) : null }, etag: fresh ? fresh.etag : undefined, meta: { warnings: warn.warnings } };
};
const canAssign = (st) => Object.hasOwn(VISIT_STATES[st] || {}, "assign");

const visitCancel = async (ctx) => {
  const b = ctx.body || {};
  const reason = str(b.reason).slice(0, 300);
  if (!reason) throw new InputError("Say why it's cancelled.", "reason");
  await rec("visit", ctx.params.id, "visit");
  const r = await changeVisit(ctx.params.id, "cancel", { reason, late: b.late === true, ctx, ifMatch: ctx.ifMatch });
  return { data: { visit: view(r.visit), job: r.job ? view(r.job) : null } };
};
const visitNoAccess = async (ctx) => {
  await rec("visit", ctx.params.id, "visit");
  const r = await changeVisit(ctx.params.id, "no_access", { note: str((ctx.body || {}).note).slice(0, 500), ctx, ifMatch: ctx.ifMatch });
  return { data: { visit: view(r.visit), job: r.job ? view(r.job) : null } };
};
const visitDone = async (ctx) => {
  await rec("visit", ctx.params.id, "visit");
  const r = await changeVisit(ctx.params.id, "office_complete", { ctx, ifMatch: ctx.ifMatch });
  return { data: { visit: view(r.visit), job: r.job ? view(r.job) : null } };
};
const visitReopen = async (ctx) => {
  await rec("visit", ctx.params.id, "visit");
  const r = await changeVisit(ctx.params.id, "reopen", { ctx, ifMatch: ctx.ifMatch });
  return { data: { visit: view(r.visit), job: r.job ? view(r.job) : null } };
};

// ------------------------------------------------------------ time off

function timeOffInput(b) {
  const out = {};
  if (!isId(b.user_id, "user")) throw new InputError("Pick someone on the team.", "user_id");
  out.user_id = b.user_id;
  if (b.date !== undefined && (b.start !== undefined || b.end !== undefined)) {
    // part of one day, in Delano time
    const d = str(b.date), st = str(b.start), en = str(b.end);
    if (!isLocalDate(d)) throw new InputError("Pick the day.", "date");
    if (!isLocalTime(st)) throw new InputError("Pick when it starts.", "start");
    if (!isLocalTime(en) || en <= st) throw new InputError("Pick when it ends (after it starts).", "end");
    out.start_at = zonedToUtc(d, st).toISOString();
    out.end_at = zonedToUtc(d, en).toISOString();
    out.all_day = false;
  } else if (b.date !== undefined) {
    const d = str(b.date), e = str(b.end_date) || d;
    if (!isLocalDate(d)) throw new InputError("Pick the first day.", "date");
    if (!isLocalDate(e) || e < d) throw new InputError("Pick the last day (on or after the first).", "end_date");
    out.start_at = zonedToUtc(d, "00:00").toISOString();
    out.end_at = zonedToUtc(addLocalDays(e, 1), "00:00").toISOString();
    out.all_day = true;
  } else {
    if (!b.start_at || Number.isNaN(Date.parse(b.start_at))) throw new InputError("Pick when it starts.", "start_at");
    out.start_at = new Date(b.start_at).toISOString();
    if (b.end_at) out.end_at = new Date(b.end_at).toISOString();
  }
  out.available = b.available === true;
  out.reason = str(b.reason).slice(0, 120);
  return out;
}

const timeOffList = async (ctx) => {
  const user = str(ctx.query.get("user"));
  const from = str(ctx.query.get("from")) || addLocalDays(localDate(now()), -30);
  const ix = await readIndex("time-off", "");
  const after = zonedToUtc(isLocalDate(from) ? from : localDate(now()), "00:00").getTime();
  const rows = ix.rows.filter((r) => (!user || r.uid === user) && (!r.e || Date.parse(r.e) >= after)).sort((a, b) => String(a.s).localeCompare(String(b.s)));
  return { data: rows };
};
const timeOffNew = async (ctx) => {
  const b = ctx.body || {};
  const data = timeOffInput(b);
  await activeUsers([data.user_id]);
  const cid = clientId(b);
  try {
    const r = await createRecord("time_off", { ...data, ...(cid ? { id: deriveId("time_off", `c:${cid}`) } : {}) }, W(ctx));
    return { status: 201, data: { time_off: view(r.data) }, etag: r.etag };
  } catch (e) {
    if (!(e instanceof ExistsError) || !cid) throw e;
    const got = await getRecord("time_off", deriveId("time_off", `c:${cid}`));
    return { data: { time_off: view(got.data) }, etag: got.etag };
  }
};
const timeOffPatch = async (ctx) => {
  if (!ctx.ifMatch) throw new InputError("This change needs the version you edited (If-Match).", "if-match");
  const got = await rec("time_off", ctx.params.id, "time off");
  const data = timeOffInput({ user_id: got.data.user_id, ...(ctx.body || {}) });
  const r = await updateRecord("time_off", got.data.id, (t) => ({ ...t, ...data, ...(data.all_day ? {} : { all_day: undefined }) }), { ...W(ctx), ifMatch: ctx.ifMatch });
  return { data: { time_off: view(r.data) }, etag: r.etag };
};
const timeOffDelete = async (ctx) => {
  await rec("time_off", ctx.params.id, "time off");
  await softDelete("time_off", ctx.params.id, W(ctx));
  return { data: { ok: true } };
};

// ------------------------------------------------------------ checklists (Settings → Checklists)

const checklists = async () => {
  const ix = await readIndex("checklists", "");
  return { data: ix.rows.sort((a, b) => (a.o ?? 50) - (b.o ?? 50) || String(a.n).localeCompare(String(b.n))) };
};
const checklistGet = async (ctx) => {
  const got = await rec("checklist_template", ctx.params.id, "checklist");
  return { data: { checklist: view(got.data) }, etag: got.etag };
};
const CHECK_FIELDS = ["key", "name", "service_types", "job_kinds", "items", "active", "order"];
const pickCheck = (b) => Object.fromEntries(CHECK_FIELDS.filter((k) => b[k] !== undefined).map((k) => [k, b[k]]));
const checklistNew = async (ctx) => {
  try {
    const r = await createRecord("checklist_template", { active: true, ...pickCheck(ctx.body || {}) }, W(ctx));
    return { status: 201, data: { checklist: view(r.data) }, etag: r.etag };
  } catch (e) {
    if (e instanceof ExistsError) throw new ConflictError("A checklist with that key already exists.");
    throw e;
  }
};
const checklistPatch = async (ctx) => {
  if (!ctx.ifMatch) throw new InputError("This change needs the version you edited (If-Match).", "if-match");
  await rec("checklist_template", ctx.params.id, "checklist");
  const r = await updateRecord("checklist_template", ctx.params.id, (c) => ({ ...c, ...pickCheck(ctx.body || {}) }), { ...W(ctx), ifMatch: ctx.ifMatch });
  return { data: { checklist: view(r.data) }, etag: r.etag };
};

// ------------------------------------------------------------ stale jobs and timers

const stale = async () => {
  const [jobsIx, timersIx] = await Promise.all([readIndex("jobs", "open"), readIndex("timers", "active")]);
  return { data: { jobs: jobsIx.rows.filter((r) => r.stale), timers: timersIx.rows } };
};

// ------------------------------------------------------------ the table

const R = (method, path, perm, subject, handler, extra = {}) => ({ method, path, auth: "session", perm, subject, mode: "inline", handler, ...extra });

export const workRoutes = [
  R("GET", "/schedule", "schedule:read", "none", schedule, { maxCalls: 40 }),
  R("GET", "/schedule/unscheduled", "schedule:read", "none", unscheduled),
  R("GET", "/schedule/weather", "schedule:read", "none", weather, { maxCalls: 12 }),
  R("GET", "/schedule/check", "schedule:read", "none", check, { maxCalls: 30 }),
  R("GET", "/schedule/route", "schedule:read", "none", routeGet),
  R("POST", "/schedule/route", "schedule:write", "none", routePost, { maxCalls: 200, budgetMs: 8000 }),
  R("POST", "/schedule/move-day", "schedule:write", "none", moveDay, { mode: "run", maxCalls: 40 }),
  R("GET", "/stale", "schedule:read", "none", stale),
  R("GET", "/jobs", "schedule:read", "none", jobs, { maxCalls: 60 }),
  R("POST", "/jobs", "schedule:write", "none", newJob, { maxCalls: 160 }),
  R("GET", "/jobs/:id", "schedule:read", "required", jobGet, { maxCalls: 60 }),
  R("PATCH", "/jobs/:id", "schedule:write", "required", jobPatch, { maxCalls: 40 }),
  R("POST", "/jobs/:id/cancel", "schedule:write", "required", jobCancel, { maxCalls: 200 }),
  R("POST", "/jobs/:id/reopen", "schedule:write", "required", jobReopen, { maxCalls: 60 }),
  R("POST", "/jobs/:id/complete", "schedule:write", "required", jobComplete, { maxCalls: 200 }),
  R("POST", "/visits", "schedule:write", "required", visitNew, { maxCalls: 120 }),
  R("GET", "/visits/:id", "schedule:read", "required", visitGet, { maxCalls: 50 }),
  R("PATCH", "/visits/:id", "schedule:write", "required", visitPatch, { maxCalls: 120 }),
  R("POST", "/visits/:id/cancel", "schedule:write", "required", visitCancel, { maxCalls: 120 }),
  R("POST", "/visits/:id/mark-no-access", "schedule:write", "required", visitNoAccess, { maxCalls: 120 }),
  R("POST", "/visits/:id/done", "schedule:write", "required", visitDone, { maxCalls: 120 }),
  R("POST", "/visits/:id/reopen", "schedule:write", "required", visitReopen, { maxCalls: 120 }),
  R("GET", "/time-off", "schedule:read", "none", timeOffList),
  R("POST", "/time-off", "schedule:write", "none", timeOffNew),
  R("PATCH", "/time-off/:id", "schedule:write", "required", timeOffPatch),
  R("DELETE", "/time-off/:id", "schedule:write", "required", timeOffDelete),
  R("GET", "/checklists", "schedule:read", "none", checklists),
  R("GET", "/checklists/:id", "settings:general", "required", checklistGet),
  R("POST", "/checklists", "settings:general", "none", checklistNew),
  R("PATCH", "/checklists/:id", "settings:general", "required", checklistPatch),
  R("GET", "/work/contacts/:id", "schedule:read", "none", contactWork, { maxCalls: 120 }),
];

export { syncJob, placeOf, fromMin, toMin, checkRange, keySafe, nowIso };
