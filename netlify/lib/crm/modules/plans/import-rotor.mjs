// Plans module: the Rotor import phases (design §10.1 contract, §10.2 rows
// 17, 19, 20, 21, 25; decisions D9, D10). The framework (staging, the runner
// on the bulk lane, field ownership, the report) is M2c's; these phases only
// map rows. Rotor stays exactly as it is: they read an export someone made,
// never Rotor itself.
//
//   plans.agreement_templates (row 17)  Rotor's 5 templates by name onto the
//        seeded drafts (their bodies stay the CRM's drafts: Rotor exposes
//        none, G17); an unknown name becomes an inactive draft to paste
//   plans.plans (rows 19, 20)  after the jobs are in: recurring plans
//        (Semi-Annual, Quarterly, Monthly) and lights plans (Annual, and
//        One-Time containers of Christmas Lights) become plans; a One-Time
//        container with more than one job a hidden one_time_series plan;
//        any other One-Time container no plan (its jobs keep
//        rotor.service_plan_id). Lines per visit (custom price or unit ×
//        quantity, never the plan-wide total), ids kept; the five discount
//        shapes; billing (after_jobs → after_visit, start_of_month →
//        first_of_month), autopay, auto-renew; status (active, cancelled
//        with its date and reason, else expired); the term from the dates;
//        ordinals from jobs[] in order (target months from the jobs, which
//        get the plan's id and their ordinal); the quote by identical line
//        ids, else the same customer approved within 60 s. Row 20: the plan
//        template ids go to cfg/plans_catalog.rotor_template_ids. Row 21:
//        signed agreements aren't exposed: imported plans say
//        "imported_unknown" and Settings → Plans can request signatures.
//   plans.lights (row 25)  each lights plan's season: the year of its
//        install job, the status from that job, the feet from the per-foot
//        lines; for this season's installs a takedown job in January (D9).
//
// map() gives the same output for the same input, so an unchanged export
// changes nothing on a re-run (the takedown jobs come from an op whose id
// is the Rotor plan's: made once).

import { getRecord, getRecords, listRel, getRaw, putSetting } from "../../../crm-store.mjs";
import { idForRotor, isId } from "../../core/ids.mjs";
import { now, localDate, addLocalDays } from "../../core/clock.mjs";
import { has, call } from "../../core/services.mjs";
import { RowError, toCents, placeholderContact } from "../contacts/import-rotor.mjs";
import { rotorKey, fixMojibake } from "../contacts/display.mjs";
import { CATALOG_DEFAULTS, catalogWith } from "./catalog.mjs";
import { AGREEMENT_DRAFTS } from "./texts.mjs";
import { seedTemplateId } from "./agreements.mjs";
import { termEnd, addMonthsDate, monthOf, saleValue, visitsPerYearOf, monthsBetween } from "./machine.mjs";
import { TAKEDOWN_LINE } from "./lights.mjs";

const str = (v) => (v == null ? "" : String(v)).trim();
const plain = (v) => !!v && typeof v === "object" && !Array.isArray(v);
const ROTOR_ID = /^(?!\.+$)[A-Za-z0-9_.-]{1,64}$/;
const iso = (v) => (v && !Number.isNaN(Date.parse(v)) ? new Date(v).toISOString() : null);
const dayOf = (v) => (iso(v) ? localDate(new Date(iso(v))) : null);
const IMPORT = { by: "import", origin: "import", actor_kind: "import", requestId: "import" };

function needId(row, field = "id") {
  if (!plain(row)) throw new RowError("row");
  const id = str(row[field]);
  if (!ROTOR_ID.test(id)) throw new RowError(field);
  return id;
}

// ------------------------------------------------------------ row 17: agreement templates

export function templateKeyOf(name) {
  const n = str(name).toLowerCase();
  if (/christmas|light/.test(n)) return "lights";
  if (/one[ -]?time/.test(n)) return "one_time";
  if (/bi-?annual|semi/.test(n)) return "biannual";
  if (/quarter/.test(n)) return "quarterly";
  if (/month/.test(n)) return "monthly";
  return null;
}

export function normalizeTemplate(row) {
  const id = needId(row);
  const name = fixMojibake(str(row.name)).slice(0, 120);
  if (!name) throw new RowError("name");
  return { id, name, service_type: str(row.service_type).slice(0, 120), is_active: row.is_active !== false };
}

async function mapTemplate(r) {
  const key = templateKeyOf(r.name);
  const rotor = { template_id: r.id, name: r.name, service_type: r.service_type, is_active: r.is_active };
  const draft = key && AGREEMENT_DRAFTS.find((d) => d.key === key);
  const data = draft
    ? { id: seedTemplateId(key), ...draft, version: 1, active: true, seeded: true, rotor }
    : {
      id: idForRotor("agreement_template", r.id), key: `rotor_${rotorKey(r.id).replace(/[^a-z0-9_]/g, "_").slice(0, 30)}`, name: r.name,
      applies_to: { catalog_keys: [], service_types: r.service_type ? [r.service_type] : [] },
      body_md: `## ${r.name}\n\nPaste this agreement's text from Rotor here, then approve it.`, version: 1, active: false, rotor,
    };
  return { records: [{ type: "agreement_template", data }], pointers: [{ kind: "rotor/agreement-template", key: rotorKey(r.id), value: { id: data.id } }] };
}

// ------------------------------------------------------------ row 19: service plans

const FREQ = { "Semi-Annual": "biannual", Quarterly: "quarterly", Monthly: "monthly", Annual: "annual" };
const BILLING = { after_jobs: "after_visit", start_of_month: "first_of_month" };
const JOB_STATUS = { Pending: "unscheduled", Scheduled: "scheduled", "In Progress": "scheduled", Completed: "completed", Cancelled: "cancelled" };
const CANCEL_REASON = { price: "price", moving: "moving", service: "service", "not needed": "not_needed", other: "other" };

export function normalizePlan(row) {
  const id = needId(row);
  if (!plain(row.customer)) throw new RowError("customer");
  const customer = needId(row.customer, "id");
  const cfg = plain(row.jobs_config) ? row.jobs_config : {};
  const types = Array.isArray(row.service_types) ? row.service_types.map(str).filter(Boolean).slice(0, 20) : str(row.service_type) ? str(row.service_type).split(",").map((x) => x.trim()).filter(Boolean) : [];
  const interval = ["day", "week", "month", "year"].includes(str(row.interval)) ? str(row.interval) : null;
  const count = Number.isInteger(Number(row.interval_count)) && Number(row.interval_count) > 0 ? Number(row.interval_count) : null;
  if (row.jobs !== undefined && row.jobs !== null && !Array.isArray(row.jobs)) throw new RowError("jobs");
  const jobs = (row.jobs || []).filter((j) => plain(j) && ROTOR_ID.test(str(j.id))).slice(0, 60).map((j) => ({ id: str(j.id), status: str(j.status) }));
  if (cfg.line_items !== undefined && cfg.line_items !== null && !Array.isArray(cfg.line_items)) throw new RowError("jobs_config.line_items");
  return {
    id, customer, customer_name: [fixMojibake(str(row.customer.first_name)), fixMojibake(str(row.customer.last_name))].filter(Boolean).join(" ") || fixMojibake(str(row.customer.company_name)),
    frequency_name: str(row.service_frequency), interval, count, service_types: types, lights: types.some((t) => /christmas light/i.test(t)) || /christmas light/i.test(str(row.service_type)),
    active: row.active === true, cancelled: row.cancelled === true, cancelled_at: iso(row.cancelled_at), cancelled_reason: str(row.cancelled_reason),
    start_date: iso(row.start_date), end_date: iso(row.end_date), billing_mode: str(row.billing_mode), is_auto_pay: row.is_auto_pay === true, auto_renew: row.auto_renew === true,
    sold_by: row.sold_by ? str(row.sold_by) : null, sale_value: row.sale_value ?? null, lines_raw: (cfg.line_items || []).filter(plain).slice(0, 50), discounts_raw: cfg.discounts ?? [],
    property_id: cfg.property_id ?? null, plan_template_id: cfg.plan_template_id ? str(cfg.plan_template_id).slice(0, 64) : null, jobs, created_at: iso(row.created_at),
  };
}

const oneTimeOf = (r) => !r.interval || /one-?time/i.test(r.frequency_name);
export function catalogOf(r) {
  if (r.lights) return "lights_annual";
  const f = FREQ[r.frequency_name];
  if (f && f !== "annual") return f;
  if (r.interval === "month" && r.count === 6) return "biannual";
  if (r.interval === "month" && r.count === 3) return "quarterly";
  if (r.interval === "month" && r.count === 1) return "monthly";
  return "custom";
}

// One Rotor line → a plan Line: the price PER VISIT (custom price, or unit
// × quantity), never the plan-wide total; Rotor's price kept as an
// "imported" override, the id verbatim, jobSchedule → scope.
export function planLine(l, i) {
  const qtyN = Number(l.quantity);
  const qty = Number.isFinite(qtyN) && qtyN >= 0 ? Math.round(qtyN * 1000) : 1000;
  const unit = l.use_unit_pricing ? toCents(l.unit_price ?? 0) : toCents(l.custom_price ?? 0);
  const per = l.use_unit_pricing ? Math.round(((unit || 0) * qty) / 1000) : unit;
  const types = Array.isArray(l.service_type) ? l.service_type.map(str).filter(Boolean) : l.service_type ? [str(l.service_type)] : [];
  const parent = types.find((t) => !t.includes("::")) || (types[0] ? types[0].split("::")[0] : "");
  const id = str(l.id) && str(l.id).length <= 80 ? str(l.id) : `rotor_ln_${i + 1}`;
  return {
    id, title: (fixMojibake(str(l.title)) || "Service").slice(0, 160), ...(str(l.description) ? { description: str(l.description).slice(0, 1000) } : {}),
    qty_milli: l.use_unit_pricing ? qty : 1000, unit_cents: l.use_unit_pricing ? (unit || 0) : (unit || 0), override: { cents: per === null ? 0 : per, reason: "imported" },
    scope: scopeOf(l.jobSchedule), ...(l.client_optional === true ? { optional: true, selected: false } : {}), ...(parent ? { service_type: parent.slice(0, 120) } : {}),
    ...(l.use_unit_pricing && /ft|feet|foot/i.test(`${l.title} ${l.unit || ""}`) ? { unit: "ft" } : {}),
  };
}
export function scopeOf(js) {
  if (!js) return { type: "all" };
  if (typeof js === "string") return ["all", "initial", "after_initial"].includes(js) ? { type: js } : { type: "all" };
  if (!plain(js)) return { type: "all" };
  if (js.type === "specific" || Array.isArray(js.selectedJobs)) {
    const v = (js.selectedJobs || js.visits || []).map((x) => Number(x)).filter((x) => Number.isInteger(x) && x >= 1 && x <= 120);
    return v.length ? { type: "specific", visits: [...new Set(v)].sort((a, b) => a - b) } : { type: "all" };
  }
  return ["all", "initial", "after_initial"].includes(js.type) ? { type: js.type } : { type: "all" };
}

// The five discount shapes (rotor-ops §4.3) → AppliedDiscount[].
export function planDiscounts(raw) {
  let list = [];
  if (Array.isArray(raw)) list = raw;
  else if (plain(raw)) {
    if (Array.isArray(raw.multi) && raw.multi.length) list = raw.multi;
    else if (raw.enabled === true && raw.type && raw.value !== undefined) list = [{ name: "Discount", type: raw.type, value: raw.value, jobSchedule: { type: "all" } }];
  }
  return list.filter(plain).slice(0, 20).map((d, i) => {
    const type = d.type === "percentage" ? "percentage" : "fixed";
    const value = type === "percentage" ? Math.max(0, Math.min(10000, Math.round(Number(d.value) * 100) || 0)) : Math.max(0, toCents(d.value ?? 0) || 0);
    return { id: `dc_r${i + 1}`, name: (fixMojibake(str(d.name)) || "Discount").slice(0, 120), type, value, scope: scopeOf(d.jobSchedule) };
  });
}

async function contactFor(ctx, rid) {
  for (const kind of ["customer", "lead"]) {
    const id = ctx && typeof ctx.lookup === "function" ? await ctx.lookup(kind, rid) : null;
    if (id) return id;
  }
  return null;
}

// The quote the plan came from: the same line-item ids, else the same
// customer approved within 60 s of the plan's creation (rotor-money §7.1).
async function quoteFor(contactId, lines, createdAt) {
  const rows = await listRel("contact-quotes", contactId, { limit: 60 }).catch(() => []);
  if (!rows.length) return null;
  const quotes = (await getRecords("quote", rows.map((r) => r.id))).filter(Boolean).map((g) => g.data);
  const ids = new Set(lines.map((l) => l.id));
  const same = quotes.find((q) => (q.options || []).some((o) => (o.lines || []).length === ids.size && (o.lines || []).every((l) => ids.has(l.id))));
  if (same) return same.id;
  const t = Date.parse(createdAt || "");
  if (!Number.isFinite(t)) return null;
  const near = quotes.find((q) => q.approved_at && Math.abs(Date.parse(q.approved_at) - t) <= 60000);
  return near ? near.id : null;
}

// The term that holds `day` for a plan started on `start` (initial
// `months`, then renewals of `renew` months while it auto-renews).
export function termAt(start, months, renew, autoRenew, day) {
  const initialEnd = termEnd(start, months);
  if (!autoRenew || day <= initialEnd) return { n: 1, start, end: initialEnd, initialEnd };
  let n = 1;
  let s = addLocalDays(initialEnd, 1);
  let e = termEnd(s, renew);
  while (day > e && n < 500) { n += 1; s = addLocalDays(e, 1); e = termEnd(s, renew); }
  return { n: n + 1, start: s, end: e, initialEnd };
}

async function mapPlan(r, ctx) {
  const warnings = [];
  const out = { records: [], pointers: [], patches: [], stats: [], warnings };
  const oneTime = oneTimeOf(r);
  if (oneTime && !r.lights && r.jobs.length <= 1) return { warnings: ["one_time_container"] };
  let contactId = await contactFor(ctx, r.customer);
  if (!contactId) {
    const ph = placeholderContact(r.customer, { name: r.customer_name, kind: "customer" });
    out.records.push(ph);
    out.pointers.push({ kind: "rotor/customer", key: rotorKey(r.customer), value: { id: ph.data.id } });
    contactId = ph.data.id;
    warnings.push("plan_placeholder_contact");
  }
  const contact = ((await getRecord("contact", contactId)) || {}).data || null;
  const cat = catalogWith(ctx && ctx.settings ? await ctx.settings.get("plans_catalog").catch(() => ({})) : {});
  const key = oneTime && !r.lights ? "custom" : catalogOf(r);
  const entry = cat.plans[key];
  const frequency = r.interval && r.count ? { interval: r.interval, count: r.count } : entry.frequency;
  const vpy = key === "quarterly" ? 4 : visitsPerYearOf(frequency);
  const lines = r.lines_raw.map(planLine);
  const discounts = planDiscounts(r.discounts_raw);
  const start = dayOf(r.start_date) || dayOf(r.created_at) || localDate(now());
  let months = 12;
  const end = dayOf(r.end_date);
  if (end && end > start) months = Math.max(1, Math.min(60, Math.round(monthsBetween(monthOf(start), monthOf(end)) || 12)));
  const renew = key === "custom" ? Math.max(1, Math.min(60, frequency.interval === "month" ? frequency.count : frequency.interval === "year" ? 12 * frequency.count : 12)) : entry.renews_every_months;
  const day = localDate(now());
  const t = termAt(start, months, renew, r.auto_renew && !oneTime, day);
  const id = idForRotor("plan", r.id);
  // ordinals from jobs[] in order: target months from the jobs the jobs phase brought in
  const jobIds = [];
  for (const j of r.jobs) jobIds.push((ctx && typeof ctx.lookup === "function" ? await ctx.lookup("job", j.id) : null) || idForRotor("job", j.id));
  const jobs = await getRecords("job", jobIds);
  const ordinals = [];
  const termOf = (d) => (!d || d <= t.initialEnd ? 1 : termAt(start, months, renew, true, d).n);
  const perTerm = {};
  r.jobs.forEach((j, i) => {
    const job = jobs[i] && jobs[i].data;
    const date = job ? (job.schedule && (job.schedule.first_on || job.schedule.last_on)) || (job.completed_at ? localDate(new Date(job.completed_at)) : null) || (job.target_month ? `${job.target_month}-15` : null) : null;
    const target = date ? monthOf(date) : monthOf(addMonthsDate(start, Math.round((12 / vpy) * i)));
    const term = termOf(date || `${target}-15`);
    perTerm[term] = (perTerm[term] || 0) + 1;
    const status = JOB_STATUS[j.status] || (job ? ({ unscheduled: "unscheduled", scheduled: "scheduled", in_progress: "scheduled", completed: "completed", cancelled: "cancelled" })[job.status] : "unscheduled") || "unscheduled";
    ordinals.push({
      term, n: perTerm[term], k: i + 1, target_month: target, job_id: jobIds[i], status, gen: 0,
      ...(status === "completed" && date ? { completed_on: date } : {}), ...(status === "scheduled" && job && job.schedule && job.schedule.open_on ? { visit_date: job.schedule.open_on } : {}),
    });
    if (job) out.patches.push({ type: "job", id: jobIds[i], set: { plan_id: id, plan_ordinal: { term, n: perTerm[term] } } });
  });
  const status = r.cancelled ? "cancelled" : r.active ? "active" : "expired";
  const users = (ctx && ctx.users) || new Map();
  const soldBy = r.sold_by ? users.get(r.sold_by) : null;
  const propertyId = (r.property_id !== null && r.property_id !== undefined && ctx && typeof ctx.lookup === "function" ? await ctx.lookup("property", String(r.property_id)) : null) || (contact && isId(contact.primary_property_id, "property") ? contact.primary_property_id : null);
  const prop = propertyId ? await getRecord("property", propertyId) : null;
  const quoteId = await quoteFor(contactId, lines, r.created_at);
  const data = {
    id, contact_id: contactId, contact_name: (contact && (contact.display_name || [contact.first_name, contact.last_name].filter(Boolean).join(" "))) || r.customer_name || undefined,
    ...(prop ? { property_id: prop.data.id, town: (prop.data.address && prop.data.address.city) || undefined } : {}), ...(quoteId ? { quote_id: quoteId } : {}),
    kind: oneTime && !r.lights ? "one_time_series" : key === "lights_annual" ? "lights_annual" : "recurring", catalog_key: key,
    name: oneTime && !r.lights ? "One-time visits" : entry.name, frequency, visits_per_year: vpy, service_types: r.service_types, lines, discounts, status, pending_reasons: [],
    term: { start_on: start, initial_months: months, initial_end_on: t.initialEnd, current_term_n: t.n, current_term_start: t.start, current_term_end: t.end, renews_every_months: renew, auto_renew: r.auto_renew && !oneTime, price_locked_until: t.initialEnd },
    billing: { mode: BILLING[r.billing_mode] || "barta_standard", autopay: r.is_auto_pay, card_required: r.is_auto_pay },
    perks: { ...entry.perks }, policy: { early_cancel_clawback_cents: entry.clawback_cents, notice_days: cat.notice_days, late_cancel_fee_cents: cat.late_cancel_fee_cents },
    ordinals, cancelled_job_ids: [], agreement_status: status === "active" ? "imported_unknown" : "none", renewal: { next_on: t.end },
    ...(r.cancelled ? { cancel: { requested_on: dayOf(r.cancelled_at) || start, effective_on: dayOf(r.cancelled_at) || start, reason: CANCEL_REASON[r.cancelled_reason.toLowerCase()] || "other", clawback_cents: 0, by: "import" }, cancelled_at: r.cancelled_at || undefined } : {}),
    ...(status === "expired" ? { expired_at: r.end_date || undefined } : {}),
    ...(isId(soldBy, "user") ? { sold_by: soldBy } : {}), origin: "import",
    rotor: {
      service_plan_id: r.id, ...(r.plan_template_id ? { plan_template_id: r.plan_template_id } : {}), billing_mode_raw: r.billing_mode, is_auto_pay: r.is_auto_pay,
      sale_value_dollars: r.sale_value, service_frequency: r.frequency_name, active: r.active, job_ids: r.jobs.map((j) => j.id),
    },
    ...(r.created_at ? { created_at: r.created_at } : {}),
  };
  data.sale_value_cents = saleValue(data);
  out.records.push({ type: "plan", data });
  out.pointers.push({ kind: "rotor/plan", key: rotorKey(r.id), value: { id } });
  if (status === "active" && data.kind !== "one_time_series") {
    // only when the stats part lacks it (an unchanged re-run writes nothing)
    const st = await getRecord("contact_stats", contactId).catch(() => null);
    const have = st && st.data && st.data.plans && Array.isArray(st.data.plans.active_plan_ids) ? st.data.plans.active_plan_ids : [];
    if (!have.includes(id)) out.stats.push({ contact_id: contactId, part: "plans", merge: { active_plan_ids: [id] } });
  }
  if (!quoteId && !oneTime) warnings.push("plan_quote_unlinked");
  return out;
}

// Row 20: Rotor's plan template ids (names unknown), kept in the catalog for joins.
async function preparePlans(rows) {
  const ids = [...new Set(rows.map((x) => (plain(x) && plain(x.jobs_config) ? str(x.jobs_config.plan_template_id) : "")).filter((x) => ROTOR_ID.test(x)))].slice(0, 50);
  if (!ids.length) return { template_ids: 0 };
  const cur = await getRaw("cfg/plans_catalog").catch(() => null);
  const stored = cur && cur.data ? cur.data : {};
  const have = Array.isArray(stored.rotor_template_ids) ? stored.rotor_template_ids : [];
  const next = [...new Set([...have, ...ids])].slice(0, 50);
  if (next.length !== have.length) {
    const { _w, updated_at, updated_by, ...rest } = stored;
    await putSetting("plans_catalog", { ...rest, rotor_template_ids: next }, IMPORT).catch((e) => console.error(`crm:plans: template ids not kept (${e && e.name})`));
  }
  return { template_ids: next.length };
}

// ------------------------------------------------------------ row 25: lights seasons

export function footageOfRows(lines) {
  const ft = lines.filter((l) => l.use_unit_pricing && /light|install|ft|feet|foot/i.test(`${l.title} ${l.unit || ""}`)).map((l) => Number(l.quantity)).filter((x) => Number.isFinite(x) && x > 0);
  return ft.length ? Math.round(Math.max(...ft)) : 0;
}
const SEASON_OF_JOB = { completed: "installed", scheduled: "install_scheduled", in_progress: "install_scheduled", cancelled: "cancelled", unscheduled: "sold" };

// The season takedowns are made for: this year's installs (D9: the 2026 ones in January 2027).
export const takedownSeason = (day = localDate(now())) => (Number(day.slice(5, 7)) >= 7 ? Number(day.slice(0, 4)) : Number(day.slice(0, 4)) - 1);

async function mapLights(r, ctx) {
  if (!r.lights) return {};
  const planId = (ctx && typeof ctx.lookup === "function" ? await ctx.lookup("plan", r.id) : null) || idForRotor("plan", r.id);
  const pg = await getRecord("plan", planId);
  if (!pg) return { warnings: ["lights_no_plan"] };
  const plan = pg.data;
  const first = r.jobs[0];
  const jobId = first ? ((ctx && typeof ctx.lookup === "function" ? await ctx.lookup("job", first.id) : null) || idForRotor("job", first.id)) : null;
  const jg = jobId ? await getRecord("job", jobId) : null;
  const job = jg ? jg.data : null;
  const date = job ? (job.schedule && job.schedule.first_on) || (job.completed_at ? localDate(new Date(job.completed_at)) : null) || (job.target_month ? `${job.target_month}-15` : null) : null;
  const season = Number((date || dayOf(r.start_date) || localDate(now())).slice(0, 4));
  const status = job ? SEASON_OF_JOB[job.status] || "sold" : "sold";
  const id = idForRotor("season_install", `${r.id}:${season}`);
  const data = {
    id, contact_id: plan.contact_id, contact_name: plan.contact_name, ...(plan.property_id ? { property_id: plan.property_id } : {}), ...(plan.town ? { town: plan.town } : {}),
    season, plan_id: plan.id, status, ...(job ? { install_job_id: job.id } : {}), warranty_job_ids: [], footage_ft: footageOfRows(r.lines_raw), colors: [], design_file_ids: [],
    early_bird: (plan.discounts || []).some((d) => /early/i.test(d.name)), three_year: (plan.discounts || []).some((d) => /3-?\s?year/i.test(d.name)),
    ...(job && job.status === "completed" && job.completed_at ? { installed_on: localDate(new Date(job.completed_at)) } : {}),
    rotor: { service_plan_id: r.id, ...(first ? { install_job_id: first.id } : {}) },
  };
  const out = { records: [], pointers: [], warnings: [] };
  // D9: this season's installs get a takedown job in January (made once: the op id is the Rotor plan's)
  if (season === takedownSeason() && status !== "cancelled" && has("work.createJobs")) {
    const lights = { takedown_month: 1, ...((ctx && ctx.settings ? await ctx.settings.get("lights").catch(() => ({})) : {}) || {}) };
    const existing = await getRecord("season_install", id);
    const had = existing && existing.data.takedown_job_id;
    if (had) data.takedown_job_id = had;
    else {
      const [tj] = await call("work.createJobs", [{
        contact_id: plan.contact_id, ...(plan.property_id ? { property_id: plan.property_id } : {}), kind: "lights_takedown", title: `Christmas lights takedown ${season}`,
        lines: [{ ...TAKEDOWN_LINE }], discounts: [], target_month: `${season + 1}-${String(lights.takedown_month || 1).padStart(2, "0")}`, season_install_id: id, plan_id: plan.id, billable: false,
      }], `import-takedown--${rotorKey(r.id)}--${season}`, "lights", IMPORT);
      if (isId(tj, "job")) data.takedown_job_id = tj;
      out.warnings.push("takedown_created");
    }
  }
  out.records.push({ type: "season_install", data });
  return out;
}

// ------------------------------------------------------------ the phases

export const phases = [
  { name: "plans.agreement_templates", entity: "agreement_templates", after: [], normalize: normalizeTemplate, map: mapTemplate },
  { name: "plans.plans", entity: "service_plans", after: ["contacts.leads", "contacts.properties_plans", "quotes.quotes", "work.jobs"], normalize: normalizePlan, map: mapPlan, prepare: preparePlans },
  { name: "plans.lights", entity: "service_plans", after: ["plans.plans", "work.visits"], normalize: normalizePlan, map: mapLights },
];

export { CATALOG_DEFAULTS };
