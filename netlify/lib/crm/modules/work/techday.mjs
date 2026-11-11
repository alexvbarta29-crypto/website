// Work module, field part: the day payload (design §2.5 "Day payload",
// §9.3 Today). GET /tech/day?date= answers, in one response, everything a
// person needs for their visits that day, so the phone can keep it and
// work from it with no signal: the visits in their route order with the
// customer's name and phones, the address and map point, access notes and
// crew notes, the work (prices only with visits:prices, D11), the
// checklist, the badges (plan member, balance due, gate code, pets, first
// visit, lights), the timers running, the last visit's notes for the
// place, and the person's clock.
//
// Scoped to the signed-in person's own visits (rel/tech-visits) and to the
// [today − 7, today + 30] window (§4.6); every record goes out through its
// type's techFields (a technician never gets more, whatever they ask). No
// date given: the server's today (the phone's clock may be off).

import { getRecord, getRecords, listRel, getSetting } from "../../../crm-store.mjs";
import { now, localDate, addLocalDays, isLocalDate } from "../../core/clock.mjs";
import { isId } from "../../core/ids.mjs";
import { InputError } from "../../core/errors.mjs";
import { techView, TECH_WINDOW } from "../../core/perms.mjs";
import { getType } from "../../core/registry.mjs";
import { arrivalWindow } from "./office-schedule.mjs";
import { openSheetOf, sheetsInWeek, weekOf, payEstimate, payrollSettings, userRecord } from "./timesheets.mjs";
import { visitTimers } from "./timers.mjs";

const DEAD = ["cancelled"];
const noPrices = (lines = []) => lines.map(({ unit_cents, total_cents, engine_cents, override, ...l }) => l);
const stopNo = (o, uid) => (typeof o === "number" ? o : o && typeof o === "object" && Number.isInteger(o[uid]) ? o[uid] : null);

// "Pat Sample" → "Pat S." (how the day list names people).
export const shortName = (c) => {
  const parts = String((c && (c.display_name || c.first_name)) || "").trim().split(/\s+/).filter(Boolean);
  if (!parts.length) return "Customer";
  return parts.length > 1 ? `${parts[0]} ${parts[parts.length - 1][0].toUpperCase()}.` : parts[0];
};

// The badges of one stop (pure).
export function badgesFor({ visit, job, property, stats, plan, balance }) {
  const out = [];
  const access = (property && property.access) || {};
  if (visit.plan_id || (job && job.plan_id)) out.push({ key: "plan", label: plan && plan.perks && plan.perks.length ? `Plan member: ${plan.perks.slice(0, 2).join(", ")}` : "Plan member" });
  if (balance && balance > 0) out.push({ key: "balance", label: "Balance due" });
  if (access.gate_code) out.push({ key: "gate", label: "Gate code" });
  if (access.pets) out.push({ key: "pets", label: "Pets" });
  if (stats && stats.work && !stats.work.jobs_completed && !stats.work.last_service_on) out.push({ key: "first", label: "First visit" });
  if (String(visit.job_kind || (job && job.kind) || "").startsWith("lights")) out.push({ key: "lights", label: "Lights" });
  return out;
}

// The last visit's notes at this place (the newest finished visit before
// this one with notes, among the customer's recent jobs). → { date, text } | null
export async function lastNotes(visit, cache) {
  const rows = await listRel("contact-jobs", visit.contact_id, { limit: 6 }).catch(() => []);
  const jobIds = rows.map((r) => r.id);
  const jobs = (await getRecords("job", jobIds)).filter(Boolean).map((g) => g.data).filter((j) => !j.deleted_at);
  const vids = [...new Set(jobs.flatMap((j) => (j.visit_ids || []).slice(-4)))].filter((id) => id !== visit.id).slice(0, 12);
  const missing = vids.filter((id) => !cache.has(id));
  for (const g of (await getRecords("visit", missing)).filter(Boolean)) cache.set(g.data.id, g.data);
  const prior = vids.map((id) => cache.get(id)).filter((v) => v && !v.deleted_at && v.status === "completed" && v.tech_notes && v.date < visit.date
    && (!visit.property_id || !v.property_id || v.property_id === visit.property_id))
    .sort((a, b) => (b.date + b.start).localeCompare(a.date + a.start));
  return prior[0] ? { date: prior[0].date, text: String(prior[0].tech_notes).slice(0, 1000) } : null;
}

export async function techDay(ctx, dateParam) {
  const today = localDate(now());
  const date = dateParam ? String(dateParam).trim() : today;
  if (!isLocalDate(date)) throw new InputError("Use a date like 2026-11-17.", "date");
  if (date < addLocalDays(today, -TECH_WINDOW.before) || date > addLocalDays(today, TECH_WINDOW.after)) throw new InputError("Pick a day from a week back to a month ahead.", "date");
  const uid = ctx.user.id;
  const office = ctx.can("schedule:read");
  const [rows, user, hours] = await Promise.all([
    listRel("tech-visits", uid, { from: date, to: date, limit: 60 }),
    userRecord(uid),
    getSetting("hours").catch(() => undefined),
  ]);
  const visits = (await getRecords("visit", [...new Set(rows.map((r) => r.id))])).filter(Boolean).map((g) => g.data)
    .filter((v) => !v.deleted_at && v.date === date && (v.assignee_ids || []).includes(uid) && !DEAD.includes(v.status))
    .sort((a, b) => (stopNo(a.route_order, uid) || 999) - (stopNo(b.route_order, uid) || 999) || String(a.start).localeCompare(String(b.start)));
  const cache = new Map(visits.map((v) => [v.id, v]));
  const [jobs, contacts, props, stats] = await Promise.all([
    getRecords("job", [...new Set(visits.map((v) => v.job_id))]),
    getRecords("contact", [...new Set(visits.map((v) => v.contact_id))]),
    getRecords("property", [...new Set(visits.map((v) => v.property_id).filter((p) => isId(p, "property")))]),
    getRecords("contact_stats", [...new Set(visits.map((v) => v.contact_id))]),
  ]);
  const byId = (list) => new Map(list.filter(Boolean).map((g) => [g.data.id, g.data]));
  const J = byId(jobs), C = byId(contacts), P = byId(props), S = byId(stats);
  const plans = getType("plan") ? byId(await getRecords("plan", [...new Set(visits.map((v) => v.plan_id).filter((p) => isId(p, "plan")))])) : new Map();
  const stops = [];
  for (const [i, v] of visits.entries()) {
    const job = J.get(v.job_id) || null;
    const contact = C.get(v.contact_id) || null;
    const prop = v.property_id ? P.get(v.property_id) || null : null;
    const prices = office || ctx.can("visits:prices", { type: "visit", record: v });
    const [timers, notes] = await Promise.all([visitTimers(v.id).catch(() => []), lastNotes(v, cache).catch(() => null)]);
    const j = job ? techView("job", job) : null;
    if (j && !prices) { j.lines = noPrices(j.lines); delete j.totals; delete j.discounts; }
    const plan = v.plan_id ? plans.get(v.plan_id) : null;
    stops.push({
      n: stopNo(v.route_order, uid) || i + 1,
      visit: techView("visit", v),
      job: j,
      contact: contact ? techView("contact", contact) : null,
      name: shortName(contact),
      property: prop && !prop.deleted_at ? techView("property", prop) : null,
      arrival: arrivalWindow(v, hours),
      badges: badgesFor({ visit: v, job, property: prop, stats: S.get(v.contact_id), plan: plan ? { perks: Array.isArray(plan.perks) ? plan.perks.map((p) => String((p && p.label) || p)).slice(0, 4) : [] } : null }),
      timers: timers.map((t) => techView("timer", t)),
      last_notes: notes,
      prices,
    });
  }
  const open = await openSheetOf(uid);
  const week = weekOf(today);
  const est = payEstimate(await sheetsInWeek(uid, week), user || ctx.user, await payrollSettings());
  return {
    date, today, tomorrow: addLocalDays(today, 1), yesterday: addLocalDays(today, -1),
    user: { id: uid, first_name: (user && user.first_name) || null, is_technician: !!(user && user.is_technician) },
    clock: { open: open ? techView("timesheet", open) : null, week_minutes: est.minutes, open_minutes: est.open_min, near_ot: est.near_ot, over_ot: est.over_ot },
    stops,
    generated_at: new Date().toISOString(),
  };
}

export const techDayRoutes = [
  { method: "GET", path: "/tech/day", auth: "session", perm: "time:own", subject: "none", mode: "inline", maxCalls: 260, handler: async (ctx) => ({ data: await techDay(ctx, ctx.query.get("date")) }) },
];
