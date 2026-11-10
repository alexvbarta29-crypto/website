// Work module, office part: the Rotor import phases (design §10.1 contract,
// §10.2 rows 3, 22, 23). The framework (staging, the runner on the bulk
// lane, field ownership, the report) is M2c's; these phases only map rows.
// Rotor stays exactly as it is: these phases read an export someone made,
// never Rotor itself.
//
//   row 3   availability exceptions → time_off (Rotor has none today; crews
//           have none either, and the crew id on a visit is kept as
//           visit.crew_rotor_id)
//   row 22  jobs (792) + lines → job: Rotor's number kept (seq "job"),
//           status map, per-job lines (the job line's total_price is per
//           job: kept as total_cents), kind from the service types
//           (Christmas Lights → lights_install), $0 lines kept as $0, notes
//           (gate codes, pets) → crew_notes, Rotor's job-level assigned_to
//           and due amount kept in `rotor` only (import-only fields,
//           rotor-ops §1.3), the plan linked when the plans module already
//           imported it (ptr/rotor/plan)
//   row 23  visits (623) → visit: UTC → local date and times; placeholders
//           (12:00Z, or 00:00/01:00 local with 60 minutes on jobs from the
//           2026-08-18..21 import) → date_only (R19); arrival_window 0 →
//           exact, 60/120 → window, is_anytime → anytime; assignees from
//           the visit's job.assigned_to (authoritative); ordering; status
//           map; the address matched to the contact's property (the
//           contacts phase made it from the same address); crew id kept.
//           Each visit also brings its job's derived summary up to date
//           (visit ids, schedule, people: a patch the runner applies).
//
// map() gives the same output for the same input, so an unchanged export
// changes nothing on a re-run.

import { getRecord, getRecords } from "../../../crm-store.mjs";
import { idForRotor, isId } from "../../core/ids.mjs";
import { localDate, localTime, nowIso } from "../../core/clock.mjs";
import { RowError, placeholderContact, toCents } from "../contacts/import-rotor.mjs";
import { rotorKey, normalizeAddress, addressKey, fixMojibake } from "../contacts/display.mjs";
import { propertiesOf } from "../contacts/properties.mjs";
import { jobSchedule, jobAssignees } from "./states.mjs";
import { titleFromLines } from "./types.mjs";
import { checklistFor, checklistCopy, placeOf, typesOfLines } from "./office.mjs";

const str = (v) => (v == null ? "" : String(v)).trim();
const plain = (v) => !!v && typeof v === "object" && !Array.isArray(v);
const ROTOR_ID = /^(?!\.+$)[A-Za-z0-9_.-]{1,64}$/;
const iso = (v) => (v && !Number.isNaN(Date.parse(v)) ? new Date(v).toISOString() : null);

function needId(row, field = "id") {
  if (!plain(row)) throw new RowError("row");
  const id = str(row[field]);
  if (!ROTOR_ID.test(id)) throw new RowError(field);
  return id;
}
const optStr = (row, k, max = 400) => {
  const v = row[k];
  if (v === undefined || v === null || v === "") return null;
  if (typeof v !== "string" && typeof v !== "number") throw new RowError(k);
  const s = String(v).trim();
  if (s.length > max) throw new RowError(k);
  return s;
};
const names = (list) => (Array.isArray(list) ? list.map(str).filter((x) => ROTOR_ID.test(x)) : []);
const nameOf = (c) => (c ? c.display_name || [c.first_name, c.last_name].filter(Boolean).join(" ").trim() || c.company_name || "" : "");

async function contactFor(ctx, rid) {
  for (const kind of ["customer", "lead"]) {
    const id = ctx && typeof ctx.lookup === "function" ? await ctx.lookup(kind, rid) : null;
    if (id) return id;
  }
  return null;
}

// ------------------------------------------------------------ row 3: availability exceptions

export function normalizeTimeOff(row) {
  const id = needId(row);
  const user = str(row.user_id);
  if (!ROTOR_ID.test(user)) throw new RowError("user_id");
  const start = iso(row.start);
  if (!start) throw new RowError("start");
  const end = row.end === "" || row.end === null || row.end === undefined ? null : iso(row.end);
  if (row.end && !end) throw new RowError("end");
  return { id, user_id: user, start, end, available: row.available === true, reason: str(row.reason).slice(0, 120) };
}

async function mapTimeOff(r, ctx) {
  const uid = ((ctx && ctx.users) || new Map()).get(r.user_id);
  if (!isId(uid, "user")) return { warnings: ["time_off_user_unknown"] };
  const id = idForRotor("time_off", r.id);
  return {
    records: [{ type: "time_off", data: { id, user_id: uid, start_at: r.start, ...(r.end && Date.parse(r.end) >= Date.parse(r.start) ? { end_at: r.end } : {}), available: r.available, reason: r.reason, rotor: { exception_id: r.id } } }],
    pointers: [{ kind: "rotor/time_off", key: rotorKey(r.id), value: { id } }],
  };
}

// ------------------------------------------------------------ row 22: jobs

export const JOB_STATUS = Object.freeze({ Pending: "unscheduled", Scheduled: "scheduled", "In Progress": "in_progress", Completed: "completed", Cancelled: "cancelled" });

export function normalizeJob(row) {
  const id = needId(row);
  const number = str(row.job_number);
  if (!/^\d{1,9}$/.test(number)) throw new RowError("job_number");
  const status = str(row.status);
  if (!JOB_STATUS[status]) throw new RowError("status");
  if (!plain(row.customer)) throw new RowError("customer");
  const customer = needId(row.customer, "id");
  if (row.line_items !== undefined && row.line_items !== null && !Array.isArray(row.line_items)) throw new RowError("line_items");
  if ((row.line_items || []).length > 60) throw new RowError("line_items");
  if (row.assigned_to !== undefined && row.assigned_to !== null && !Array.isArray(row.assigned_to)) throw new RowError("assigned_to");
  return {
    id, number, status, start_date: iso(row.start_date), end_date: iso(row.end_date), customer,
    customer_name: [fixMojibake(str(row.customer.first_name)), fixMojibake(str(row.customer.last_name))].filter(Boolean).join(" ") || fixMojibake(str(row.customer.company_name)),
    service_plan_id: row.service_plan_id ? needId(row, "service_plan_id") : null, line_items: (row.line_items || []).filter(plain),
    due_amount: typeof row.due_amount === "number" || typeof row.due_amount === "string" ? row.due_amount : null,
    notes: row.notes == null ? "" : String(row.notes).slice(0, 2000), assigned_to: names(row.assigned_to), created_at: iso(row.created_at),
  };
}

// One Rotor job line → a Line (§5.3): cents, thousandths, the line id kept.
export function mapLine(l, i, users = new Map()) {
  const types = Array.isArray(l.service_type) ? l.service_type.map(str).filter(Boolean) : l.service_type ? [str(l.service_type)] : [];
  const parent = types.find((t) => !t.includes("::")) || (types[0] ? types[0].split("::")[0] : "");
  const tier = (types.find((t) => t.includes("::")) || "").split("::")[1] || "";
  const qtyN = Number(l.quantity);
  const qty = Number.isFinite(qtyN) && qtyN >= 0 ? Math.round(qtyN * 1000) : 1000;
  const unit = l.use_unit_pricing ? toCents(l.unit_price ?? 0) : toCents(l.custom_price ?? l.total_price ?? 0);
  const total = toCents(l.total_price ?? 0);
  const upsell = l.upsell_user_id ? users.get(str(l.upsell_user_id)) : null;
  const id = str(l.id) && str(l.id).length <= 80 ? str(l.id) : `rotor_ln_${i + 1}`;
  return {
    id, title: (fixMojibake(str(l.title)) || "Service").slice(0, 160), ...(str(l.description) ? { description: str(l.description).slice(0, 1000) } : {}),
    qty_milli: qty, unit_cents: unit === null ? 0 : unit, total_cents: total === null ? 0 : total, scope: { type: "all" },
    ...(parent ? { service_type: parent.slice(0, 120) } : {}), ...(tier ? { tier: tier.slice(0, 120) } : {}),
    ...(isId(upsell, "user") ? { upsell_user_id: upsell } : {}),
    show: { qty: l.show_quantity !== false, unit: l.show_unit_price !== false, description: l.show_description === true },
    ...(l.template_id ? { rotor: { template_id: str(l.template_id).slice(0, 64) } } : {}),
  };
}

export function jobKindOf(lines) {
  return lines.some((l) => /christmas light/i.test(l.service_type || "") || /christmas light/i.test(l.title)) ? "lights_install" : "standard";
}

async function mapJob(r, ctx) {
  const warnings = [];
  const out = { records: [], pointers: [], warnings };
  let contactId = await contactFor(ctx, r.customer);
  let contact = null;
  if (!contactId) {
    const ph = placeholderContact(r.customer, { name: r.customer_name, kind: "customer" });
    out.records.push(ph);
    out.pointers.push({ kind: "rotor/customer", key: rotorKey(r.customer), value: { id: ph.data.id } });
    contactId = ph.data.id;
    contact = ph.data;
    warnings.push("job_placeholder_contact");
  } else {
    const got = await getRecord("contact", contactId);
    contact = got ? got.data : null;
  }
  const users = (ctx && ctx.users) || new Map();
  const lines = r.line_items.map((l, i) => mapLine(l, i, users));
  const kind = jobKindOf(lines);
  const status = JOB_STATUS[r.status];
  const planId = r.service_plan_id && ctx && typeof ctx.lookup === "function" ? await ctx.lookup("plan", r.service_plan_id) : null;
  const id = idForRotor("job", r.id);
  const data = {
    id, number: Number(r.number), seq: "job", number_label: r.number.padStart(7, "0"), contact_id: contactId, contact_name: nameOf(contact) || r.customer_name || undefined,
    kind, title: titleFromLines(lines, kind), service_types: typesOfLines(lines), lines, discounts: [], status,
    ...(status === "unscheduled" && r.start_date ? { target_month: localDate(new Date(r.start_date)).slice(0, 7) } : {}),
    crew_notes: r.notes, office_notes: "", visit_ids: [], invoice_ids: [], assignee_ids: [], review: {},
    ...(contact && isId(contact.primary_property_id, "property") ? { property_id: contact.primary_property_id } : {}),
    ...(isId(planId, "plan") ? { plan_id: planId } : {}),
    ...(status === "completed" ? { completed_at: r.end_date || r.start_date || r.created_at || nowIso(), completed_by: "import" } : {}),
    rotor: { job_id: r.id, job_number: r.number, service_plan_id: r.service_plan_id, status_raw: r.status, due_amount_dollars: r.due_amount, assigned_to_raw: r.assigned_to },
    ...(r.created_at ? { created_at: r.created_at } : {}), origin: "import",
  };
  out.records.push({ type: "job", data });
  out.pointers.push({ kind: "rotor/job", key: rotorKey(r.id), value: { id } });
  return out;
}

// ------------------------------------------------------------ row 23: visits

// Rotor's four values (rotor-ops §2.2); "scheduled" is read as not_started too (older exports and the synthetic one say it)
export const VISIT_STATUS = Object.freeze({ not_started: "scheduled", scheduled: "scheduled", in_progress: "in_progress", paused: "paused", finished: "completed" });
const IMPORT_FROM = Date.parse("2026-08-18T00:00:00Z");
const IMPORT_TO = Date.parse("2026-08-22T12:00:00Z");

// A placeholder slot (R19): 12:00Z, or 00:00/01:00 local lasting 60 minutes
// on a job from the 2026-08-18..21 onboarding import.
export function isPlaceholder(startIso, endIso, jobCreatedAt) {
  const s = new Date(startIso), e = new Date(endIso);
  if (s.getUTCHours() === 12 && s.getUTCMinutes() === 0 && s.getUTCSeconds() === 0) return true;
  const lt = localTime(s);
  const created = Date.parse(jobCreatedAt || "");
  return (lt === "00:00" || lt === "01:00") && (e - s) === 3600000 && created >= IMPORT_FROM && created <= IMPORT_TO;
}

export function normalizeVisit(row) {
  if (!plain(row)) throw new RowError("row");
  const id = str(row.id);
  if (!ROTOR_ID.test(id)) throw new RowError("id");
  const jobId = needId(row, "job_id");
  const start = iso(row.start), end = iso(row.end);
  if (!start) throw new RowError("start");
  const status = str(row.status);
  if (!VISIT_STATUS[status]) throw new RowError("status");
  const aw = row.arrival_window === null || row.arrival_window === undefined ? 0 : Number(row.arrival_window);
  if (!Number.isFinite(aw) || aw < 0 || aw > 720) throw new RowError("arrival_window");
  const job = plain(row.job) ? row.job : {};
  return {
    id, job_id: jobId, start, end: end && Date.parse(end) > Date.parse(start) ? end : new Date(Date.parse(start) + 3600000).toISOString(),
    status, crew_id: Number.isFinite(Number(row.crew_id)) && row.crew_id !== null && row.crew_id !== "" ? Number(row.crew_id) : null,
    is_anytime: row.is_anytime === true, ordering: Number.isInteger(row.ordering) && row.ordering > 0 ? row.ordering : 1, arrival_window: Math.round(aw),
    assigned_to: names(job.assigned_to), customer: plain(row.customer) && row.customer.id ? str(row.customer.id) : null,
    address: plain(row.address) ? row.address : null, service_type: str(row.service_type).slice(0, 120),
  };
}

// The contact's property at the visit's address (the contacts phase made it
// from the same address), else the fallback. → { id, property? }
async function propertyFor(contactId, address, fallback) {
  const a = address ? normalizeAddress(address) : null;
  const list = await propertiesOf(contactId);
  const key = a && a.street1 ? addressKey(a) : null;
  const found = (key && list.find((p) => addressKey(p.address) === key)) || list.find((p) => p.id === fallback) || null;
  return found ? { id: found.id, property: found } : { id: fallback || null };
}

async function mapVisit(r, ctx) {
  const jobId = (ctx && typeof ctx.lookup === "function" ? await ctx.lookup("job", r.job_id) : null) || idForRotor("job", r.job_id);
  const jg = await getRecord("job", jobId);
  if (!jg) return { warnings: ["visit_no_job"] };
  const job = jg.data;
  const contactG = await getRecord("contact", job.contact_id);
  const contact = contactG ? contactG.data : null;
  const users = (ctx && ctx.users) || new Map();
  const assignees = r.assigned_to.map((u) => users.get(u)).filter((u) => isId(u, "user"));
  const warnings = assignees.length < r.assigned_to.length ? ["visit_assignee_unknown"] : [];
  const placeholder = isPlaceholder(r.start, r.end, job.created_at);
  const s = new Date(r.start), e = new Date(r.end);
  const date = placeholder && s.getUTCHours() === 12 ? r.start.slice(0, 10) : localDate(s);
  let start = placeholder ? "08:00" : localTime(s);
  let end = placeholder ? "09:00" : localDate(e) === date ? localTime(e) : "23:59";
  if (end <= start) end = start < "23:00" ? `${String(Number(start.slice(0, 2)) + 1).padStart(2, "0")}:${start.slice(3)}` : "23:59";
  const window = placeholder || r.is_anytime ? { type: "anytime", minutes: 0 } : r.arrival_window > 0 ? { type: "window", minutes: Math.max(15, r.arrival_window) } : { type: "exact", minutes: 0 };
  const status = VISIT_STATUS[r.status];
  const prop = contact ? await propertyFor(contact.id, r.address, job.property_id || contact.primary_property_id) : { id: job.property_id };
  const place = await placeOf(prop.id, contact, { property: prop.property });
  const template = status === "scheduled" ? await checklistFor(job, {}, ctx && ctx.cache) : null;
  const id = idForRotor("visit", r.id);
  const data = {
    id, job_id: job.id, contact_id: job.contact_id, ordering: r.ordering, date, start, end, window, ...(placeholder ? { date_only: true } : {}),
    assignee_ids: [...new Set(assignees)].slice(0, 8), status, checklist: checklistCopy(template), photos: [], tech_notes: "",
    ...(r.crew_id !== null ? { crew_rotor_id: r.crew_id } : {}),
    ...(status === "completed" ? { completion: { at: r.end, by: "import" } } : {}),
    job_number: job.number_label, job_kind: job.kind, job_title: job.title, service_types: job.service_types && job.service_types.length ? job.service_types : r.service_type ? [r.service_type] : [],
    ...(job.plan_id ? { plan_id: job.plan_id } : {}), contact_name: nameOf(contact) || job.contact_name || undefined, ...place,
    rotor: { visit_id: r.id, status_raw: r.status, arrival_window: r.arrival_window, is_anytime: r.is_anytime, ...(r.crew_id !== null ? { crew_id: r.crew_id } : {}) },
  };
  // the job's derived summary with this visit as mapped (the others as stored)
  const others = (await getRecords("visit", (job.visit_ids || []).filter((x) => x !== id))).filter(Boolean).map((g) => g.data);
  const all = [...others, data];
  const patch = {
    type: "job", id: job.id,
    set: { visit_ids: [...new Set([...(job.visit_ids || []), id])], schedule: jobSchedule(all), assignee_ids: jobAssignees(all) },
    ...(place.property_id && (!job.property_id || (contact && job.property_id === contact.primary_property_id && place.property_id !== job.property_id && (job.visit_ids || []).length === 0)) ? { set_property: true } : {}),
  };
  if (patch.set_property) { patch.set.property_id = place.property_id; }
  delete patch.set_property;
  return { records: [{ type: "visit", data }], pointers: [{ kind: "rotor/visit", key: rotorKey(r.id), value: { id } }], patches: [patch], warnings };
}

// ------------------------------------------------------------ the phases

export const phases = [
  { name: "work.time_off", entity: "availability_exceptions", after: ["system.users"], normalize: normalizeTimeOff, map: mapTimeOff },
  { name: "work.jobs", entity: "jobs", after: ["contacts.leads"], normalize: normalizeJob, map: mapJob },
  { name: "work.visits", entity: "visits", after: ["work.jobs", "contacts.properties_visits"], normalize: normalizeVisit, map: mapVisit },
];
