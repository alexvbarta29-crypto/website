// Payroll's storage side (design §5.8): pay periods, the inputs a pay sheet
// is worked out from, lock / unlock / paid, the owner's adjustments, late
// time into a locked week, the person's own pay and the crew scoreboard.
// The arithmetic is compute.mjs (pure).
//
// Inputs of a period (indexes first, records only where an index row is not
// enough; about 20 to 60 storage calls for a week):
//   users          ix/users, then each active person's record (pay rates)
//   time           ix/timesheets/{month} rows (minutes, category, status)
//   jobs           ix/jobs/{year}: billable jobs finished in the period, then
//                  their records (lines with upsells, visits, plan/quote);
//                  timer minutes (rel/visit-timers) only for a job with more
//                  than one person when the split is by hours and someone on
//                  it earns a technician commission
//   sellers        the job's plan or quote sold_by, only when someone earns a
//                  salesman commission
//   tips           ix/payments/{month} rows with a tip (never simulated), then
//                  those payments for their tip_split
//   adjustments    rel/period-lines/{periodId} → pay_line records
//
// A period is open (lines worked out live, `totals` cached by recompute),
// locked (lines and totals frozen in the record by one write; its shifts
// then become locked a batch at a time) or paid. Late time, a replayed
// clock-out or an approval that touches a locked or paid week never changes
// it: payroll.addAdjustment makes an adjustment line in the next open
// period, and the work module tells the owners.

import {
  getRecord, getRecords, createRecord, updateRecord, readIndex, readPointer, listRel, getSetting,
} from "../../../crm-store.mjs";
import { now, nowIso, localDate, addLocalDays, dowOfDate } from "../../core/clock.mjs";
import { deriveId, isId } from "../../core/ids.mjs";
import { InputError, NotFoundError, ConflictError, ExistsError } from "../../core/errors.mjs";
import { lineTotal } from "../../core/money.mjs";
import { safeErr } from "../../../referral-lib.mjs";
import { computePeriod, weekOf, weeksOf, jobShares, poolComparison, minutesFromTimers, COUNTED, dayLabel } from "./compute.mjs";
import { payrollConfig, commissionBp, modelOf, isTechRole, rateFor } from "./settings.mjs";
import { lineKeyPtr, MAX_FROZEN_LINES } from "./types.mjs";

export const W = (ctx = {}) => (ctx && typeof ctx.write === "function" ? ctx.write() : { ...(ctx || {}) });
const view = (r) => { if (!r) return r; const { _w, _etag, ...rest } = r; return rest; };
const rows = async (name, shard) => { try { return (await readIndex(name, shard)).rows || []; } catch { return []; } };
const monthsOf = (from, to) => {
  const out = [];
  for (let m = from.slice(0, 7); m <= to.slice(0, 7) && out.length < 14;) {
    out.push(m);
    const [y, mm] = m.split("-").map(Number);
    m = mm === 12 ? `${y + 1}-01` : `${y}-${String(mm + 1).padStart(2, "0")}`;
  }
  return out;
};
const yearsOf = (from, to) => [...new Set([from.slice(0, 4), to.slice(0, 4)])];
const dayOf = (iso) => (iso ? localDate(new Date(iso)) : null);
export const today = () => localDate(now());
export const LOCK_BATCH = 30;

export async function payrollSettings() {
  return payrollConfig(await getSetting("payroll").catch(() => null));
}

// ------------------------------------------------------------ periods

export const periodEnd = (start, weeks = 1) => addLocalDays(start, 7 * weeks - 1);
export function startParam(v, field = "start_on") {
  if (typeof v !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(v)) throw new InputError("Pick the Sunday the period starts on.", field);
  if (dowOfDate(v) !== 0) throw new InputError("A pay period starts on a Sunday.", field);
  return v;
}

async function periodById(id) {
  const got = isId(id, "pay_period") ? await getRecord("pay_period", id) : null;
  if (!got || got.data.deleted_at) throw new NotFoundError("That pay period isn't there.");
  return got;
}

// The period holding a local date (a 2-week period may have started the week before).
export async function periodFor(date) {
  const ws = weekOf(date);
  for (const start of [ws, addLocalDays(ws, -7)]) {
    const p = await readPointer("period", start);
    if (!p || !isId(p.id, "pay_period")) continue;
    const got = await getRecord("pay_period", p.id);
    if (got && !got.data.deleted_at && got.data.start_on <= date && got.data.end_on >= date) return got.data;
  }
  return null;
}

// Makes (or finds) the period starting on a Sunday. Racing creators land on the same id.
export async function ensurePeriod(start, ctx = {}, { weeks } = {}) {
  startParam(start);
  const p = await readPointer("period", start);
  if (p && isId(p.id, "pay_period")) {
    const got = await getRecord("pay_period", p.id);
    if (got && !got.data.deleted_at) return got.data;
  }
  const cfg = await payrollSettings();
  const w = weeks || cfg.period_weeks || 1;
  // the week must not sit inside a period that started a week earlier
  const before = await periodFor(addLocalDays(start, -1));
  if (before && before.end_on >= start) throw new ConflictError("That week is already in another pay period.");
  const id = deriveId("pay_period", `period:${start}`, "payroll", 0);
  try {
    return (await createRecord("pay_period", { id, start_on: start, end_on: periodEnd(start, w), weeks: w, status: "open", totals: {} }, W(ctx))).data;
  } catch (e) {
    if (!(e instanceof ExistsError)) throw e;
    const got = await getRecord("pay_period", id);
    if (got) return got.data;
    throw e;
  }
}

export async function listPeriods() {
  const list = (await rows("pay-periods", "")).sort((a, b) => String(b.s).localeCompare(String(a.s)));
  const t = today();
  const ws = weekOf(t);
  const current = list.find((r) => r.s <= t && r.e >= t) || null;
  return {
    periods: list.map((r) => ({ id: r.id, start_on: r.s, end_on: r.e, weeks: r.w, status: r.st, total_cents: r.tot, hours: r.hrs, tips_cents: r.tips, people: r.n, imported: !!r.im, computed_at: r.ca })),
    current_start: current ? current.s : ws, current_id: current ? current.id : null, today: t,
  };
}

// ------------------------------------------------------------ the inputs

async function teamUsers() {
  const list = (await rows("users", "")).filter((u) => u.status !== "disabled");
  const recs = (await getRecords("user", list.map((u) => u.id))).filter(Boolean).map((g) => g.data).filter((u) => !u.deleted_at);
  return recs.map((u) => ({ id: u.id, name: u.name || u.login, first_name: u.first_name || String(u.name || "").split(/\s+/)[0], role: u.role, is_technician: !!u.is_technician, status: u.status, color: u.color || null, pay: u.pay || {}, login: u.login }));
}

// Who a sold_by names: a user id, or an imported quote's Rotor rep name.
function sellerResolver(users) {
  const byName = new Map();
  for (const u of users) for (const n of [u.name, u.first_name, u.login]) if (n) byName.set(String(n).trim().toLowerCase(), u.id);
  return (by) => {
    if (!by) return null;
    if (users.some((u) => u.id === by)) return by;
    const k = String(by).trim().toLowerCase();
    return byName.get(k) || byName.get(k.split(/\s+/)[0]) || null;
  };
}

const lineCents = (l) => {
  if (Number.isSafeInteger(l.total_cents)) return l.total_cents;
  try { return lineTotal({ unit_cents: l.unit_cents || 0, qty_milli: Number.isSafeInteger(l.qty_milli) ? l.qty_milli : 1000 }); } catch { return 0; }
};

// Timer minutes per person on a job's visits (segments under the minimum ignored).
export async function jobMinutes(job, cfg) {
  const all = [];
  for (const vid of (job.visit_ids || []).slice(0, 6)) {
    const rel = await listRel("visit-timers", vid, { limit: 120 }).catch(() => []);
    all.push(...(await getRecords("timer", rel.map((r) => r.id))).filter(Boolean).map((g) => g.data));
  }
  return minutesFromTimers(all, cfg.min_segment_minutes);
}

// The billable jobs finished between two dates, as compute.mjs takes them.
export async function finishedJobs(from, to, users, cfg, { records = true, maxRecords = 150, onlyUser = null, touchUps = false } = {}) {
  const all = (await Promise.all(yearsOf(from, to).map((y) => rows("jobs", y)))).flat();
  const seen = new Set();
  let list = all.filter((j) => j.st === "completed" && (j.bill !== false || (touchUps && j.k === "touch_up")) && dayOf(j.done) >= from && dayOf(j.done) <= to && (seen.has(j.id) ? false : seen.add(j.id)));
  const fromRow = (j) => ({ id: j.id, number: j.num, number_label: j.n, title: j.t, total_cents: j.tot || 0, billable: j.bill !== false, status: j.st, kind: j.k, completed_at: j.done, assignee_ids: j.a || [], plan_id: j.pl || null, lines: [], minutes: {}, contact_id: j.c, services: j.svc || [] });
  if (!records) return { jobs: list.map(fromRow), partial: false };
  const partial = list.length > maxRecords;
  if (onlyUser) list.sort((a, b) => Number((b.a || []).includes(onlyUser)) - Number((a.a || []).includes(onlyUser)));
  const recs = new Map((await getRecords("job", list.slice(0, maxRecords).map((j) => j.id))).filter(Boolean).map((g) => [g.data.id, g.data]));
  const byId = new Map(users.map((u) => [u.id, u]));
  const anyTech = (crew) => crew.some((uid) => commissionBp(byId.get(uid), "technician") > 0);
  const jobs = [];
  for (const row of list) {
    const r = recs.get(row.id);
    const j = fromRow(row);
    if (r) {
      Object.assign(j, {
        total_cents: r.totals ? r.totals.total_cents : j.total_cents, kind: r.kind || j.kind, quote_id: r.quote_id || null, plan_id: r.plan_id || null,
        assignee_ids: [...new Set([...(r.assignee_ids || []), ...j.assignee_ids])], first_visit_id: (r.visit_ids || [])[0] || null, visit_ids: r.visit_ids || [],
        lines: (r.lines || []).filter((l) => !l.optional || l.selected).map((l) => ({ id: l.id, title: l.title, total_cents: lineCents(l), upsell_user_id: l.upsell_user_id || null })),
      });
      if (cfg.commission_split === "by_hours" && j.assignee_ids.length > 1 && anyTech(j.assignee_ids)) j.minutes = await jobMinutes(j, cfg);
    }
    jobs.push(j);
  }
  return { jobs, partial };
}

// Sellers for salesman commission: only read when someone earns one.
async function attachSellers(jobs, users) {
  if (!users.some((u) => commissionBp(u, "salesman") > 0)) return;
  const who = sellerResolver(users);
  const planIds = [...new Set(jobs.map((j) => j.plan_id).filter((x) => isId(x, "plan")))].slice(0, 80);
  const quoteIds = [...new Set(jobs.filter((j) => !j.plan_id).map((j) => j.quote_id).filter((x) => isId(x, "quote")))].slice(0, 80);
  const plans = new Map((await getRecords("plan", planIds)).filter(Boolean).map((g) => [g.data.id, g.data.sold_by]));
  const quotes = new Map((await getRecords("quote", quoteIds)).filter(Boolean).map((g) => [g.data.id, g.data.sold_by]));
  for (const j of jobs) j.sold_by = who(j.plan_id ? plans.get(j.plan_id) : quotes.get(j.quote_id)) || null;
}

// Tips paid in a date range (never simulated, never an imported Rotor line's own).
export async function tipsIn(from, to, { onlyUser = null } = {}) {
  const list = (await Promise.all(monthsOf(from, to).map((m) => rows("payments", m)))).flat()
    .filter((p) => p.st === "succeeded" && !p.sim && p.tip && p.on >= from && p.on <= to && (p.k === "payment" || p.k === "refund"));
  const recs = (await getRecords("payment", list.slice(0, 120).map((p) => p.id))).filter(Boolean).map((g) => g.data);
  return recs.filter((p) => !p.simulated && !p.deleted_at && (!onlyUser || (p.tip_split || []).some((x) => x.user_id === onlyUser)))
    .map((p) => ({ payment_id: p.id, kind: p.kind, received_on: p.received_on, tip_cents: p.tip_cents || 0, split: (p.tip_split || []).map((x) => ({ user_id: x.user_id, cents: x.cents })), job_id: p.job_id || null, job_label: p.invoice_number ? `Invoice ${p.invoice_number}` : "" }));
}

// A pay_line record as a pay sheet line (its kind is line_type; the record's own type is "pay_line").
const LINE_KEYS = ["id", "user_id", "period_id", "line_type", "line_key", "label", "detail", "basis_cents", "rate_bp", "hours", "rate_cents_per_hour", "amount_cents", "status", "paid_at", "note", "created_at"];
export const asLine = (r) => ({ ...Object.fromEntries(LINE_KEYS.filter((k) => r[k] !== undefined).map((k) => [k, r[k]])), type: r.line_type, record: true, ...(r.rotor ? { rotor: true } : {}) });
async function adjustmentsOf(periodId) {
  const rel = await listRel("period-lines", periodId, { limit: 300, newestFirst: false }).catch(() => []);
  return (await getRecords("pay_line", rel.map((r) => r.id))).filter(Boolean).map((g) => g.data).filter((l) => !l.deleted_at && l.period_id === periodId).map(asLine);
}

// Everything a period's pay sheets are worked out from. → compute.mjs's input
export async function inputsFor(period, { onlyUser = null } = {}) {
  const [users, cfg] = await Promise.all([teamUsers(), payrollSettings()]);
  const months = monthsOf(period.start_on, period.end_on);
  const sheetRows = (await Promise.all(months.map((m) => rows("timesheets", m)))).flat().filter((r) => !onlyUser || r.uid === onlyUser);
  const sheets = sheetRows.map((r) => ({ id: r.id, user_id: r.uid, category: r.cat, start_at: r.s, end_at: r.e, minutes: r.min, status: r.st }));
  const { jobs } = await finishedJobs(period.start_on, period.end_on, users, cfg, { onlyUser });
  const mine = onlyUser ? jobs.filter((j) => j.assignee_ids.includes(onlyUser) || j.lines.some((l) => l.upsell_user_id === onlyUser) || commissionBp(users.find((u) => u.id === onlyUser), "salesman") > 0) : jobs;
  await attachSellers(mine, users);
  const [tips, adjustments] = await Promise.all([tipsIn(period.start_on, period.end_on, { onlyUser }), period.id ? adjustmentsOf(period.id) : Promise.resolve([])]);
  return { period, users, settings: cfg, sheets, jobs: mine, tips, adjustments: onlyUser ? adjustments.filter((a) => a.user_id === onlyUser) : adjustments };
}

// The period's pay: live while open, frozen once locked.
export async function sheetOf(period, opts = {}) {
  if (period.status !== "open" && Array.isArray(period.lines)) {
    const lines = opts.onlyUser ? period.lines.filter((l) => l.user_id === opts.onlyUser) : period.lines;
    const totals = opts.onlyUser ? Object.fromEntries(Object.entries(period.totals || {}).filter(([k]) => k === opts.onlyUser)) : period.totals || {};
    return { lines, totals, frozen: true };
  }
  if (period.status !== "open" && period.id) {
    // a paid run imported from Rotor: its lines are pay_line records
    const all = await adjustmentsOf(period.id);
    const lines = opts.onlyUser ? all.filter((l) => l.user_id === opts.onlyUser) : all;
    const totals = opts.onlyUser ? Object.fromEntries(Object.entries(period.totals || {}).filter(([k]) => k === opts.onlyUser)) : period.totals || {};
    return { lines, totals, frozen: true };
  }
  const input = await inputsFor(period, opts);
  const out = computePeriod(input);
  if (opts.onlyUser) {
    out.lines = out.lines.filter((l) => l.user_id === opts.onlyUser);
    out.totals = Object.fromEntries(Object.entries(out.totals).filter(([k]) => k === opts.onlyUser));
  }
  return { ...out, frozen: false, users: input.users };
}

const peopleOf = (users, totals) => users.filter((u) => totals[u.id]).map((u) => ({ id: u.id, name: u.name, first_name: u.first_name, role: u.role, color: u.color, model: u.pay && u.pay.model ? u.pay.model : "hourly" }));

// GET /payroll/periods/:id → the period with everyone's totals and lines.
export async function periodDetail(id) {
  const { data: period, etag } = await periodById(id);
  const s = await sheetOf(period);
  const users = s.users || await teamUsers();
  const pending = s.frozen ? null : await pendingIn(period);
  return {
    period: { ...view(period), lines: undefined }, etag, lines: s.lines, totals: s.totals, people: peopleOf(users, s.totals), frozen: s.frozen,
    warnings: pending, ended: period.end_on < today(),
  };
}

// Shifts in the period that would not count yet (open, or waiting for the office).
async function pendingIn(period) {
  const rs = (await Promise.all(monthsOf(period.start_on, period.end_on).map((m) => rows("timesheets", m)))).flat()
    .filter((r) => r.d >= period.start_on && r.d <= period.end_on);
  return { open_shifts: rs.filter((r) => r.st === "open").length, pending: rs.filter((r) => r.st === "pending_approval").length, to_approve: rs.filter((r) => r.st === "closed").length };
}

// ------------------------------------------------------------ recompute, lock, unlock, paid

export async function recompute(id, ctx) {
  const { data: period } = await periodById(id);
  if (period.status !== "open") return { period: view(period), changed: false };
  const s = await sheetOf(period);
  const r = await updateRecord("pay_period", period.id, (x) => (x.status !== "open" ? null : { ...x, totals: s.totals, computed_at: nowIso() }), W(ctx));
  return { period: view(r.data), changed: r.changed };
}

// POST /payroll/periods/:id/lock: the lines and totals frozen in one write,
// then the period's shifts locked a batch at a time (more: true asks again).
export async function lockPeriod(id, ctx) {
  const { data: period } = await periodById(id);
  if (period.status === "paid") throw new ConflictError("That period is paid.");
  if (period.status === "open") {
    if (period.end_on >= today()) throw new ConflictError(`This period runs to ${dayLabel(period.end_on)}. Lock it once it's over.`);
    const s = await sheetOf(period);
    if (s.lines.length > MAX_FROZEN_LINES) throw new ConflictError("This period has more lines than one pay run holds. Split it into weeks.");
    const by = ctx.user ? ctx.user.id : "office";
    const at = nowIso();
    const frozen = s.lines.map((l) => ({ ...l, period_id: period.id, status: l.status === "void" ? "void" : "approved" }));
    const r = await updateRecord("pay_period", period.id, (x) => (x.status !== "open" ? null : { ...x, status: "locked", locked_at: at, locked_by: by, lines: frozen, totals: s.totals, computed_at: at }), W(ctx));
    if (!r.changed) return lockPeriod(id, ctx);
    for (const a of await adjustmentsOf(period.id)) {
      if (a.status === "draft") await updateRecord("pay_line", a.id, (x) => (x.status !== "draft" ? null : { ...x, status: "approved" }), W(ctx)).catch((e) => console.error(`crm:payroll: an adjustment not approved (${safeErr(e)})`));
    }
  }
  const more = await lockSheets(id, ctx);
  const { data: after } = await periodById(id);
  return { period: { ...view(after), lines: undefined }, more };
}

// The period's counted shifts → locked (the lock's second half; the sweep finishes what a request didn't).
export async function lockSheets(id, ctx, { batch = LOCK_BATCH } = {}) {
  const { data: period } = await periodById(id);
  if (period.status === "open" || period.timesheets_locked) return false;
  const rs = (await Promise.all(monthsOf(period.start_on, period.end_on).map((m) => rows("timesheets", m)))).flat()
    .filter((r) => r.d >= period.start_on && r.d <= period.end_on && ["closed", "approved"].includes(r.st));
  const by = ctx.user ? ctx.user.id : "payroll";
  for (const r of rs.slice(0, batch)) {
    await updateRecord("timesheet", r.id, (x) => (!["closed", "approved"].includes(x.status) ? null : { ...x, status: "locked", ...(x.approved_at ? {} : { approved_at: nowIso(), approved_by: by }) }), W(ctx))
      .catch((e) => console.error(`crm:payroll: a shift not locked (${safeErr(e)})`));
  }
  if (rs.length > batch) return true;
  await updateRecord("pay_period", period.id, (x) => (x.status === "open" || x.timesheets_locked ? null : { ...x, timesheets_locked: true }), W(ctx));
  return false;
}

export async function unlockPeriod(id, ctx) {
  const { data: period } = await periodById(id);
  if (period.status === "paid") throw new ConflictError("A paid period stays as it was paid. Add an adjustment to the next one.");
  if (period.status === "open") return { period: view(period), more: false };
  const by = ctx.user ? ctx.user.id : "office";
  const reason = String((ctx.body && ctx.body.reason) || "").trim().slice(0, 300);
  await updateRecord("pay_period", period.id, (x) => (x.status !== "locked" ? null : {
    ...x, status: "open", lines: undefined, timesheets_locked: undefined, locked_at: undefined, locked_by: undefined,
    unlocks: [...(x.unlocks || []), { at: nowIso(), by, ...(reason ? { reason } : {}), total_cents: Object.values(x.totals || {}).reduce((a, t) => a + (t.total_cents || 0), 0) }],
  }), W(ctx));
  for (const a of await adjustmentsOf(period.id)) {
    if (a.status === "approved") await updateRecord("pay_line", a.id, (x) => (x.status !== "approved" ? null : { ...x, status: "draft" }), W(ctx)).catch(() => {});
  }
  // its shifts go back to approved (a batch at a time)
  const rs = (await Promise.all(monthsOf(period.start_on, period.end_on).map((m) => rows("timesheets", m)))).flat()
    .filter((r) => r.d >= period.start_on && r.d <= period.end_on && r.st === "locked");
  for (const r of rs.slice(0, LOCK_BATCH)) await updateRecord("timesheet", r.id, (x) => (x.status !== "locked" ? null : { ...x, status: "approved" }), W(ctx)).catch(() => {});
  const { data: after } = await periodById(id);
  return { period: view(after), more: rs.length > LOCK_BATCH };
}

export async function markPaid(id, ctx) {
  const { data: period } = await periodById(id);
  if (period.status === "open") throw new ConflictError("Lock the period first.");
  if (period.status === "paid") return { period: { ...view(period), lines: undefined } };
  const by = ctx.user ? ctx.user.id : "office";
  const at = nowIso();
  const r = await updateRecord("pay_period", period.id, (x) => (x.status !== "locked" ? null : {
    ...x, status: "paid", paid_at: at, paid_by: by, lines: (x.lines || []).map((l) => (l.status === "void" ? l : { ...l, status: "paid", paid_at: at, paid_by: by })),
  }), W(ctx));
  for (const a of await adjustmentsOf(period.id)) {
    if (["draft", "approved"].includes(a.status)) await updateRecord("pay_line", a.id, (x) => (x.status === "paid" || x.status === "void" ? null : { ...x, status: "paid", paid_at: at, paid_by: by }), W(ctx)).catch(() => {});
  }
  return { period: { ...view(r.data), lines: undefined } };
}

// ------------------------------------------------------------ adjustments

const ADJ_TYPES = ["adjustment", "bonus"];
export async function addAdjustment(id, body, ctx) {
  const { data: period } = await periodById(id);
  if (period.status !== "open") throw new ConflictError("That period is locked. Add it to the next open period.");
  const b = body || {};
  if (!isId(b.user_id, "user")) throw new InputError("Who is it for?", "user_id");
  const u = await getRecord("user", b.user_id);
  if (!u || u.data.deleted_at) throw new InputError("Pick a person on the team.", "user_id");
  if (!Number.isSafeInteger(b.amount_cents) || !b.amount_cents || Math.abs(b.amount_cents) > 1000000) throw new InputError("Enter an amount (up to $10,000).", "amount_cents");
  const type = ADJ_TYPES.includes(b.type) ? b.type : "adjustment";
  const note = String(b.note || "").trim().slice(0, 500);
  if (!note) throw new InputError("Say what it's for (the person sees it on their pay sheet).", "note");
  const cid = typeof b.client_id === "string" && /^[A-Za-z0-9-]{8,64}$/.test(b.client_id) ? b.client_id.toLowerCase() : null;
  const key = `${type}:${b.user_id}:${period.id}:${cid || nowIso()}`;
  const label = String(b.label || "").trim().slice(0, 120) || (type === "bonus" ? "Bonus" : "Adjustment");
  return createLine({ user_id: b.user_id, period_id: period.id, line_type: type, line_key: key, label, detail: note, amount_cents: b.amount_cents, status: "draft", note, source: {}, created_for: "owner" }, ctx);
}

async function createLine(data, ctx) {
  const ptr = await readPointer("payline", lineKeyPtr(data.line_key));
  if (ptr && isId(ptr.id, "pay_line")) {
    const got = await getRecord("pay_line", ptr.id);
    if (got) return asLine(got.data);
  }
  const id = deriveId("pay_line", `line:${data.line_key}`, "payroll", 0);
  try {
    return asLine((await createRecord("pay_line", { ...data, id }, W(ctx))).data);
  } catch (e) {
    if (!(e instanceof ExistsError)) throw e;
    const got = await getRecord("pay_line", id);
    if (got) return asLine(got.data);
    throw e;
  }
}

// POST /payroll/lines/:id/void: an adjustment of an open period, struck out.
export async function voidLine(id, ctx) {
  const got = isId(id, "pay_line") ? await getRecord("pay_line", id) : null;
  if (!got || got.data.deleted_at) throw new NotFoundError("That line isn't there.");
  const { data: period } = await periodById(got.data.period_id);
  if (period.status !== "open") throw new ConflictError("That period is locked.");
  if (got.data.rotor) throw new ConflictError("Rotor's lines stay as Rotor paid them.");
  const r = await updateRecord("pay_line", id, (x) => (x.status === "void" ? null : { ...x, status: "void" }), W(ctx));
  return asLine(r.data);
}

// payroll.addAdjustment (the work module, §5.8): a shift that closed into a
// locked week → an adjustment line in the next open period. Idempotent by
// the shift (line_key late:{timesheetId}). → the line
export async function lateAdjustment(input, ctx = {}) {
  const i = input || {};
  if (!isId(i.user_id, "user")) throw new InputError("Whose time is it?", "user_id");
  const minutes = Number.isFinite(i.minutes) ? Math.max(0, Math.round(i.minutes)) : 0;
  const when = i.start_at && !Number.isNaN(Date.parse(i.start_at)) ? localDate(new Date(i.start_at)) : today();
  const locked = await periodFor(when);
  const target = await nextOpenPeriod(locked ? addLocalDays(locked.end_on, 1) : weekOf(today()), ctx);
  const u = await getRecord("user", i.user_id);
  const rate = rateFor(u ? u.data : null, i.category || "service");
  const amount = Math.round((minutes * rate.cents) / 60);
  const key = i.timesheet_id ? `late:${i.timesheet_id}` : `late:${i.user_id}:${i.start_at || when}`;
  return createLine({
    user_id: i.user_id, period_id: target.id, line_type: "adjustment", line_key: key, label: "Late time",
    detail: `${(minutes / 60).toFixed(2)} h on ${dayLabel(when)} at ${(rate.cents / 100).toFixed(2)} an hour (that week was already locked)`,
    hours: Math.round((minutes / 60) * 100) / 100, rate_cents_per_hour: rate.cents, amount_cents: amount, status: "draft",
    note: String(i.note || "").slice(0, 500) || undefined, source: i.timesheet_id ? { timesheet_id: i.timesheet_id } : {}, created_for: "late_time",
  }, ctx);
}

// The first open period on or after a date: an existing one, else this
// week's (made when there is none; a past week nobody opened is skipped).
export async function nextOpenPeriod(fromDate, ctx = {}) {
  const thisWeek = weekOf(today());
  let start = weekOf(fromDate);
  for (let i = 0; i < 16; i++) {
    const have = await periodFor(start);
    if (have && have.status === "open") return have;
    if (have) { start = addLocalDays(have.end_on, 1); continue; }
    if (start < thisWeek) { start = thisWeek; continue; }
    return ensurePeriod(start, ctx);
  }
  throw new ConflictError("No open pay period in the next weeks.");
}

// payroll.periodStatus (the work module): the status of the period holding an instant, or null.
export async function periodStatus(input) {
  const at = input && input.at;
  if (!at || Number.isNaN(Date.parse(at))) return null;
  const p = await periodFor(localDate(new Date(at)));
  return p ? p.status : null;
}

// ------------------------------------------------------------ the person's own pay (GET /me/pay)

// A line as its person sees it (a pay_line record's tech fields; never the sources behind it).
const OWN_KEYS = ["id", "type", "line_type", "user_id", "period_id", "label", "detail", "basis_cents", "rate_bp", "hours", "rate_cents_per_hour", "amount_cents", "status", "paid_at", "note", "line_key", "week", "minutes"];
const ownLine = (l) => Object.fromEntries(OWN_KEYS.filter((k) => l[k] !== undefined && !(l.record && (k === "week" || k === "minutes"))).map((k) => [k, k === "type" && l.record ? "pay_line" : l[k]]).concat(l.record ? [["line_type", l.type]] : []));

export async function myPay(input, ctx = {}) {
  const uid = input.user_id;
  const date = typeof input.period === "string" && /^\d{4}-\d{2}-\d{2}$/.test(input.period) ? input.period : today();
  const cfg = await payrollSettings();
  const stored = await periodFor(date);
  const ws = weekOf(date);
  const period = stored || { id: null, start_on: ws, end_on: periodEnd(ws, 1), weeks: 1, status: "open", totals: {} };
  const s = await sheetOf(period, { onlyUser: uid });
  const t = s.totals[uid] || null;
  // the four weeks before: a stored period's totals (frozen once locked; the
  // last recompute while open), else the hours alone from the time index
  const users = s.users || await teamUsers();
  const user = users.find((u) => u.id === uid) || null;
  const stored4 = (await rows("pay-periods", "")).filter((r) => r.s < period.start_on && r.e >= addLocalDays(period.start_on, -28));
  const recs = new Map((await getRecords("pay_period", stored4.map((r) => r.id))).filter(Boolean).map((g) => [g.data.id, g.data]));
  const first = addLocalDays(period.start_on, -28);
  const sheetRows = (await Promise.all(monthsOf(first, addLocalDays(period.start_on, -1)).map((m) => rows("timesheets", m)))).flat().filter((r) => r.uid === uid);
  const past = [];
  const seenP = new Set();
  for (let i = 1; i <= 4; i++) {
    const w = addLocalDays(period.start_on, -7 * i);
    const row = stored4.find((r) => r.s <= w && r.e >= w);
    const p = row ? recs.get(row.id) : null;
    if (p) {
      if (seenP.has(p.id)) continue;
      seenP.add(p.id);
      const mine = (p.totals || {})[uid] || null;
      past.push({ id: p.id, week_start: p.start_on, week_end: p.end_on, status: p.status, total_cents: mine ? mine.total_cents : 0, minutes: mine ? mine.minutes || 0 : 0, ot_min: mine ? mine.ot_minutes || Math.round((mine.ot_hours || 0) * 60) : 0, tips_cents: mine ? mine.tips_cents || 0 : 0 });
      continue;
    }
    const wk = { id: null, start_on: w, end_on: addLocalDays(w, 6), weeks: 1 };
    const est = user ? computePeriod({ period: wk, users: [user], settings: cfg, sheets: sheetRows.map((r) => ({ id: r.id, user_id: r.uid, category: r.cat, start_at: r.s, end_at: r.e, minutes: r.min, status: r.st })) }).totals[uid] : null;
    past.push({ id: null, week_start: w, week_end: wk.end_on, status: null, hours_only: true, total_cents: est ? est.total_cents : 0, minutes: est ? est.minutes : 0, ot_min: est ? est.ot_minutes || 0 : 0, tips_cents: 0 });
  }
  const estimate = t ? {
    total_cents: t.total_cents, minutes: t.minutes, regular_min: t.minutes - (t.ot_minutes || 0), ot_min: t.ot_minutes || 0, pending_min: t.pending_minutes || 0,
    regular_cents: t.hourly_cents, ot_cents: t.ot_cents, rate_is_default: t.rate_is_standard,
  } : { total_cents: 0, minutes: 0, regular_min: 0, ot_min: 0, pending_min: 0, regular_cents: 0, ot_cents: 0 };
  const board = user && (await scoreboardUsers(cfg, [user])).length ? await scoreboard({ from: period.start_on, to: period.end_on < today() ? period.end_on : today(), onlyUser: uid }).catch(() => null) : null;
  return {
    payroll: true,
    period: { id: period.id, start_on: period.start_on, end_on: period.end_on, weeks: period.weeks || 1, status: period.status, paid_at: period.paid_at || null },
    estimate, totals: t, lines: s.lines.map(ownLine), past,
    model: user ? modelOf(user, cfg) : "hourly", ot_threshold_hours: cfg.ot_threshold_hours, ot_multiplier: cfg.ot_multiplier,
    scoreboard: board && board.rows[0] ? board.rows[0] : null, goals: cfg.goals,
    note: period.status === "open" ? "Worked out from your approved time, jobs and tips so far. It's final once the office locks the week." : period.status === "locked" ? "Locked by the office: this is your pay for the period." : "Paid.",
  };
}

// ------------------------------------------------------------ the crew scoreboard (barta-rules §5)

async function scoreboardUsers(cfg, users) {
  const ids = cfg.scoreboard_user_ids || [];
  return ids.length ? users.filter((u) => ids.includes(u.id)) : users.filter((u) => isTechRole(u) && u.status !== "disabled");
}

// → { from, to, rows: [{ user_id, name, jobs, job_value_cents, minutes, revenue_per_hour_cents, reviews, upsell_cents, callbacks, ... }], goals }
export async function scoreboard({ from, to, onlyUser = null }) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(from || "") || !/^\d{4}-\d{2}-\d{2}$/.test(to || "") || to < from) throw new InputError("Pick the dates.", "from");
  const days = Math.round((Date.parse(to) - Date.parse(from)) / 86400000) + 1;
  if (days > 370) throw new InputError("A year at most.", "to");
  const [users, cfg] = await Promise.all([teamUsers(), payrollSettings()]);
  let board = await scoreboardUsers(cfg, users);
  if (onlyUser) board = board.filter((u) => u.id === onlyUser);
  const ids = new Set(board.map((u) => u.id));
  const small = days <= 31;
  const { jobs, partial } = await finishedJobs(from, to, users, { ...cfg, commission_split: small ? "by_hours" : "equal" }, { records: small, maxRecords: 80, touchUps: true });
  // by_hours needs every multi-person job's minutes, not only commission earners'
  if (small) for (const j of jobs) if (j.assignee_ids.length > 1 && !Object.keys(j.minutes || {}).length && j.visit_ids && j.assignee_ids.some((x) => ids.has(x))) j.minutes = await jobMinutes(j, cfg);
  const sheetRows = (await Promise.all(monthsOf(from, to).map((m) => rows("timesheets", m)))).flat();
  const reviews = await rows("reviews", "");
  const out = board.map((u) => {
    const mine = jobs.filter((j) => j.assignee_ids.includes(u.id));
    let value = 0, upsell = 0, callbacks = 0, billable = 0;
    for (const j of mine) {
      if (j.kind === "touch_up") callbacks += 1; else billable += 1;
      const sh = jobShares(j, { ...cfg, commission_split: small ? "by_hours" : "equal" }).find((x) => x.uid === u.id);
      value += sh ? sh.basis : 0;
    }
    for (const j of jobs) for (const l of j.lines || []) if (l.upsell_user_id === u.id) upsell += l.total_cents || 0;
    const minutes = sheetRows.filter((r) => r.uid === u.id && (r.cat || "service") === "service" && COUNTED.includes(r.st) && r.d >= from && r.d <= to).reduce((a, r) => a + (r.min || 0), 0);
    const rv = reviews.filter((r) => (r.t || []).includes(u.id) && dayOf(r.at) >= from && dayOf(r.at) <= to).length;
    const weeks = Math.max(1, days / 7);
    return {
      user_id: u.id, name: u.name, first_name: u.first_name, color: u.color, jobs: billable, callbacks, job_value_cents: value, minutes, hours: Math.round((minutes / 60) * 100) / 100,
      revenue_per_hour_cents: minutes ? Math.round((value * 60) / minutes) : null, reviews: rv, reviews_per_week: Math.round((rv / weeks) * 10) / 10,
      upsell_cents: upsell, upsell_share_pct: value ? Math.round((upsell / value) * 1000) / 10 : null,
      callbacks_pct: billable + callbacks ? Math.round((callbacks / (billable + callbacks)) * 1000) / 10 : null,
      pool_comparison_cents: poolComparison({ jobValueCents: value, upsellCents: upsell }, cfg),
    };
  });
  return { from, to, rows: out, goals: cfg.goals, partial, split: small ? "by_hours" : "equal", pool_bp: cfg.scoreboard_pool_bp, upsell_bp: cfg.scoreboard_upsell_bp };
}

// ------------------------------------------------------------ the payroll.recompute sweep (daily 04:00)

// Makes this week's period, recomputes the open ones that are not over a
// month old, and finishes locking shifts a lock left. CRM-only records.
export async function recomputeSweep(ctx = {}) {
  const w = typeof ctx.write === "function" ? ctx.write() : ctx;
  let progress = 0;
  try { await ensurePeriod(weekOf(today()), w); } catch (e) { if (!(e instanceof ConflictError)) console.error(`crm:payroll: this week's period not made (${safeErr(e)})`); }
  const list = (await rows("pay-periods", "")).filter((r) => r.s >= addLocalDays(today(), -42));
  for (const r of list) {
    if (ctx.budget && ctx.budget.left && ctx.budget.left() < 4000) return { done: false, progress };
    try {
      if (r.st === "open") { await recompute(r.id, w); progress += 1; }
      else if (await lockSheets(r.id, w, { batch: 60 })) return { done: false, progress };
    } catch (e) { console.error(`crm:payroll: a period not recomputed (${safeErr(e)})`); }
  }
  return { done: true, progress, result: `${progress} periods` };
}

export { weeksOf, rateFor };
