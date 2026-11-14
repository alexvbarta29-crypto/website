// Payroll's arithmetic (design §5.8, D3, barta-rules §5): pure, no I/O, no
// clock. periods.mjs gathers the inputs from the indexes and records and
// hands them here; the tests hand-work weeks against it.
//
//   computePeriod({ period, users, settings, sheets, jobs, tips, adjustments })
//     → { lines: [PayLine-like], totals: { [uid]: Totals }, people: [uid] }
//
// 1. Hours: closed, approved and locked shifts whose start falls in the
//    period, each in its Sunday to Saturday week (America/Chicago). One
//    hourly line per shift at its category's rate (straight time); a week
//    over 40 h adds one overtime line: the hours over 40 × the week's
//    weighted rate × (1.5 − 1), so the week pays the regular hours at their
//    rates and the overtime hours at 1.5 × the weighted rate (the regular
//    rate method). Minutes come from the instants, so a shift across a
//    daylight-saving change counts the real time.
// 2. Technician commission: each billable job finished in the period, its
//    total after discounts (tips are never in it), shared between the
//    people on it by timer minutes (by_hours), equally, or each at the full
//    job (each_full); share × the person's technician rate.
// 3. Salesman commission: the job's seller (its plan's or quote's sold_by) ×
//    their salesman rate. 4. Upsells: job lines with upsell_user_id × the
//    upsell rate. 5. Tips: each payment's tip split (a refund's split comes
//    off). 6. The model: hourly (hours, overtime, tips), commission
//    (commissions, tips), greater_of (per week the higher of hours +
//    overtime and the week's commissions, plus tips), hourly_plus_commission
//    (all of it). Lines a model does not pay are left out, except
//    greater_of's losing side, kept as void lines so the sheet shows the
//    comparison. 7. Adjustments and bonuses: the owner's lines (and late
//    time into a locked week), as they are.
//
// Amounts are whole cents, rounded half up at each line; shares of a job
// add up exactly to the job (largest remainder).

import { addLocalDays, dowOfDate, localDate, localTime } from "../../core/clock.mjs";
import { rateFor, commissionBp, modelOf, payrollConfig, goesOut } from "./settings.mjs";

export const COUNTED = Object.freeze(["closed", "approved", "locked"]);
export const LINE_TYPES = Object.freeze(["hourly", "overtime", "technician_commission", "salesman_commission", "upsell_commission", "tip", "adjustment", "bonus"]);
const COMMISSION = new Set(["technician_commission", "salesman_commission", "upsell_commission"]);
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

export const weekOf = (date) => addLocalDays(date, -dowOfDate(date));
const minutesOf = (s) => {
  if (Number.isFinite(s.minutes)) return Math.max(0, Math.round(s.minutes));
  const a = Date.parse(s.start_at), b = Date.parse(s.end_at);
  return Number.isFinite(a) && Number.isFinite(b) ? Math.max(0, Math.round((b - a) / 60000)) : 0;
};
const half = (n) => (n >= 0 ? Math.floor(n + 0.5) : -Math.floor(-n + 0.5));
const hours2 = (min) => Math.round((min / 60) * 100) / 100;
export const dayLabel = (date) => `${MONTHS[Number(date.slice(5, 7)) - 1]} ${Number(date.slice(8, 10))}`;
// "7:42 AM" in Delano time
export function clock12(iso) {
  const [h, m] = localTime(new Date(iso)).split(":").map(Number);
  return `${h % 12 || 12}:${String(m).padStart(2, "0")} ${h < 12 ? "AM" : "PM"}`;
}
const fmtMoney = (c) => `$${(Math.round(c) / 100).toFixed(2)}`;
const pct = (bp) => `${(bp / 100).toFixed(bp % 100 ? 2 : 0)}%`;

// Shares of `total` by weights, summing exactly (largest remainder; ties to the earlier).
export function shareBy(total, weights) {
  const sum = weights.reduce((a, w) => a + w, 0);
  if (!sum) return weights.map(() => 0);
  const raw = weights.map((w) => (total * w) / sum);
  const out = raw.map((x) => Math.floor(x));
  let rest = total - out.reduce((a, x) => a + x, 0);
  const order = raw.map((x, i) => [x - Math.floor(x), i]).sort((a, b) => b[0] - a[0] || a[1] - b[1]);
  for (let k = 0; rest > 0 && k < order.length; k++, rest--) out[order[k][1]] += 1;
  return out;
}

// The period's Sunday-to-Saturday weeks.
export function weeksOf(period) {
  const out = [];
  for (let w = weekOf(period.start_on); w <= period.end_on && out.length < 6; w = addLocalDays(w, 7)) out.push(w);
  return out;
}

const blankTotals = () => ({
  minutes: 0, regular_hours: 0, ot_hours: 0, hourly_cents: 0, ot_cents: 0, commission_cents: 0, tips_cents: 0, adjustments_cents: 0, total_cents: 0,
  pending_minutes: 0, model_applied: "hourly", rate_is_standard: false,
});

// Minutes per person from a job's timer segments; open segments and those
// shorter than the minimum (default 1 minute) are ignored.
export function minutesFromTimers(timers, minSegment = 1) {
  const out = {};
  for (const t of timers || []) {
    if (!t || t.deleted_at || !t.end_at) continue;
    const m = Number.isFinite(t.minutes) ? t.minutes : Math.round((Date.parse(t.end_at) - Date.parse(t.start_at)) / 60000);
    if (!(m > 0) || m < (minSegment || 0)) continue;
    for (const uid of t.user_ids || []) out[uid] = (out[uid] || 0) + m;
  }
  return out;
}

// The people a job's technician commission is shared between, and each one's weight.
export function jobShares(job, cfg) {
  const crew = [...new Set(job.assignee_ids || [])];
  if (!crew.length) return [];
  const basis = Number.isSafeInteger(job.total_cents) ? job.total_cents : 0;
  if (cfg.commission_split === "each_full") return crew.map((uid) => ({ uid, basis, minutes: (job.minutes || {})[uid] || 0 }));
  const minutes = crew.map((uid) => Math.max(0, (job.minutes || {})[uid] || 0));
  const byHours = cfg.commission_split === "by_hours" && minutes.some((m) => m > 0);
  const parts = shareBy(basis, byHours ? minutes : crew.map(() => 1));
  return crew.map((uid, i) => ({ uid, basis: parts[i], minutes: minutes[i] }));
}

export function computePeriod({ period, users = [], settings = {}, sheets = [], jobs = [], tips = [], adjustments = [] }) {
  const cfg = payrollConfig(settings);
  const byId = new Map(users.map((u) => [u.id, u]));
  const inPeriod = (d) => !!d && d >= period.start_on && d <= period.end_on;
  const lines = [];
  const add = (l) => { lines.push({ status: "draft", ...l, period_id: period.id || null }); };
  const otMin = cfg.ot_threshold_hours * 60;

  // 1. hours, per person per week
  const weekMin = new Map();          // uid|week → { minutes, minuteCents }
  const pendingMin = new Map();
  for (const s of sheets) {
    const u = byId.get(s.user_id);
    if (!u) continue;
    const d = localDate(new Date(s.start_at));
    if (!inPeriod(d)) continue;
    const m = minutesOf(s);
    if (s.status === "pending_approval") { pendingMin.set(u.id, (pendingMin.get(u.id) || 0) + m); continue; }
    if (!COUNTED.includes(s.status) || !s.end_at || m <= 0) continue;
    const cat = s.category || "service";
    const rate = rateFor(u, cat);
    const wk = weekOf(d);
    const k = `${u.id}|${wk}`;
    const w = weekMin.get(k) || { uid: u.id, week: wk, minutes: 0, minuteCents: 0, standard: false };
    w.minutes += m;
    w.minuteCents += m * rate.cents;
    w.standard = w.standard || rate.standard;
    weekMin.set(k, w);
    const day = localDate(new Date(s.end_at));
    add({
      user_id: u.id, type: "hourly", week: wk, line_key: `hourly:${s.id}:${new Date(s.start_at).toISOString()}:${new Date(s.end_at).toISOString()}`,
      label: cat === "service" ? "Hourly pay" : `Hourly pay (${cat})`,
      detail: `${dayLabel(d)}, ${clock12(s.start_at)} - ${day === d ? "" : `${dayLabel(day)}, `}${clock12(s.end_at)}`,
      hours: hours2(m), minutes: m, rate_cents_per_hour: rate.cents, amount_cents: half((m * rate.cents) / 60),
      source: { timesheet_id: s.id }, rate_is_standard: rate.standard,
    });
  }
  for (const w of weekMin.values()) {
    const u = byId.get(w.uid);
    const over = Math.max(0, w.minutes - otMin);
    if (!over || (u.pay && u.pay.overtime === false)) continue;
    const weighted = w.minuteCents / w.minutes;                      // cents an hour, unrounded
    const premium = half((over * weighted * (cfg.ot_multiplier - 1)) / 60);
    add({
      user_id: u.id, type: "overtime", week: w.week, line_key: `overtime:${u.id}:${w.week}`,
      label: "Overtime", detail: `${hours2(over).toFixed(2)} h over ${cfg.ot_threshold_hours} h, week of ${dayLabel(w.week)} (time and a half: ${cfg.ot_multiplier - 1}x on top of ${fmtMoney(weighted)} an hour)`,
      hours: hours2(over), minutes: over, rate_cents_per_hour: Math.round(weighted * cfg.ot_multiplier), amount_cents: premium,
      source: {},
    });
  }

  // 2-4. commissions on the jobs finished in the period
  for (const job of jobs) {
    const done = job.completed_at ? localDate(new Date(job.completed_at)) : null;
    if (!inPeriod(done) || job.billable === false || job.status === "cancelled") continue;
    const wk = weekOf(done);
    const label = `Job #${job.number_label || job.number || ""}`.trim();
    for (const sh of jobShares(job, cfg)) {
      const u = byId.get(sh.uid);
      const bp = commissionBp(u, "technician");
      if (!u || !bp || !sh.basis) continue;
      add({
        user_id: u.id, type: "technician_commission", week: wk, line_key: `technician:${u.id}:${job.first_visit_id ? `${job.first_visit_id}-` : ""}${job.id}`,
        label, detail: `${job.title || "Job"} · ${pct(bp)} of ${fmtMoney(sh.basis)}${sh.basis !== job.total_cents ? ` (their share of ${fmtMoney(job.total_cents)})` : ""}`,
        basis_cents: sh.basis, rate_bp: bp, amount_cents: half((sh.basis * bp) / 10000), source: { job_id: job.id, ...(job.first_visit_id ? { visit_id: job.first_visit_id } : {}) },
      });
    }
    const seller = job.sold_by && byId.get(job.sold_by);
    const sbp = commissionBp(seller, "salesman");
    if (seller && sbp && job.total_cents) {
      add({
        user_id: seller.id, type: "salesman_commission", week: wk, line_key: `salesman:${seller.id}:${job.plan_id || "-"}:${job.id}`,
        label, detail: `Sold by them · ${pct(sbp)} of ${fmtMoney(job.total_cents)}`, basis_cents: job.total_cents, rate_bp: sbp,
        amount_cents: half((job.total_cents * sbp) / 10000), source: { job_id: job.id },
      });
    }
    for (const ln of job.lines || []) {
      const up = ln.upsell_user_id && byId.get(ln.upsell_user_id);
      const ubp = commissionBp(up, "upsell");
      const total = Number.isSafeInteger(ln.total_cents) ? ln.total_cents : 0;
      if (!up || !ubp || total <= 0) continue;
      add({
        user_id: up.id, type: "upsell_commission", week: wk, line_key: `upsell:${up.id}:${job.id}:${ln.id || "line"}`,
        label, detail: `Upsell: ${ln.title || "added work"} · ${pct(ubp)} of ${fmtMoney(total)}`, basis_cents: total, rate_bp: ubp,
        amount_cents: half((total * ubp) / 10000), source: { job_id: job.id, line_id: ln.id || null },
      });
    }
  }

  // 5. tips, as money split them
  for (const t of tips) {
    if (!inPeriod(t.received_on)) continue;
    const sign = t.kind === "refund" ? -1 : 1;
    for (const part of t.split || []) {
      const u = byId.get(part.user_id);
      if (!u || !Number.isSafeInteger(part.cents) || !part.cents) continue;
      add({
        user_id: u.id, type: "tip", week: weekOf(t.received_on), line_key: `tip:${u.id}:${t.payment_id}`,
        label: sign < 0 ? "Tip refunded" : "Tip", detail: `${t.job_label ? `${t.job_label} · ` : ""}${dayLabel(t.received_on)}${(t.split || []).length > 1 ? ` · split ${t.split.length} ways of ${fmtMoney(t.tip_cents || 0)}` : ""}`,
        basis_cents: t.tip_cents || 0, amount_cents: sign * part.cents, source: { payment_id: t.payment_id, ...(t.job_id ? { job_id: t.job_id } : {}) },
      });
    }
  }

  // 6. the model, per person (greater_of per week)
  const keep = [];
  const applied = new Map();
  const people = new Set([...lines.map((l) => l.user_id), ...adjustments.filter((a) => a.status !== "void").map((a) => a.user_id), ...users.filter((u) => goesOut(u) && u.status !== "disabled").map((u) => u.id)]);
  for (const uid of people) {
    const u = byId.get(uid);
    if (!u) continue;
    const model = modelOf(u, cfg);
    const mine = lines.filter((l) => l.user_id === uid);
    const hourlyKind = (l) => l.type === "hourly" || l.type === "overtime";
    if (model === "hourly") { keep.push(...mine.filter((l) => !COMMISSION.has(l.type))); applied.set(uid, "hourly"); continue; }
    if (model === "commission") { keep.push(...mine.filter((l) => !hourlyKind(l))); applied.set(uid, "commission"); continue; }
    if (model === "hourly_plus_commission") { keep.push(...mine); applied.set(uid, "hourly_plus_commission"); continue; }
    // greater_of: per week
    const won = [];
    for (const wk of [...new Set(mine.filter((l) => hourlyKind(l) || COMMISSION.has(l.type)).map((l) => l.week))].sort()) {
      const h = mine.filter((l) => l.week === wk && hourlyKind(l)).reduce((a, l) => a + l.amount_cents, 0);
      const c = mine.filter((l) => l.week === wk && COMMISSION.has(l.type)).reduce((a, l) => a + l.amount_cents, 0);
      const commissionWins = c > h;
      won.push(commissionWins ? "commission" : "hourly");
      for (const l of mine.filter((x) => x.week === wk && (hourlyKind(x) || COMMISSION.has(x.type)))) {
        const lost = commissionWins ? hourlyKind(l) : COMMISSION.has(l.type);
        if (lost) { l.status = "void"; l.note = `Not paid: ${commissionWins ? "commission" : "hourly"} was higher the week of ${dayLabel(wk)} (${fmtMoney(Math.max(h, c))} against ${fmtMoney(Math.min(h, c))}).`; }
      }
    }
    keep.push(...mine);
    applied.set(uid, won.length ? `greater_of: ${[...new Set(won)].join(" and ")}` : "greater_of");
  }

  // 7. the owner's adjustments and bonuses, and late time
  for (const a of adjustments) {
    if (!byId.get(a.user_id)) continue;
    keep.push({ ...a, period_id: period.id || a.period_id || null });
  }

  // totals
  const totals = {};
  for (const uid of people) {
    const u = byId.get(uid);
    if (!u) continue;
    const t = blankTotals();
    t.model_applied = applied.get(uid) || modelOf(u, cfg);
    t.pending_minutes = pendingMin.get(uid) || 0;
    let min = 0, ot = 0;
    for (const w of weekMin.values()) if (w.uid === uid) { min += w.minutes; ot += Math.max(0, w.minutes - otMin); t.rate_is_standard = t.rate_is_standard || w.standard; }
    const otEff = u.pay && u.pay.overtime === false ? 0 : ot;
    t.minutes = min;
    t.ot_minutes = otEff;
    t.ot_hours = hours2(otEff);
    t.regular_hours = hours2(min - otEff);
    for (const l of keep) {
      if (l.user_id !== uid || l.status === "void") continue;
      if (l.type === "hourly") t.hourly_cents += l.amount_cents;
      else if (l.type === "overtime") t.ot_cents += l.amount_cents;
      else if (COMMISSION.has(l.type)) t.commission_cents += l.amount_cents;
      else if (l.type === "tip") t.tips_cents += l.amount_cents;
      else t.adjustments_cents += l.amount_cents;
    }
    t.total_cents = t.hourly_cents + t.ot_cents + t.commission_cents + t.tips_cents + t.adjustments_cents;
    totals[uid] = t;
  }
  const order = { hourly: 0, overtime: 1, technician_commission: 2, salesman_commission: 3, upsell_commission: 4, tip: 5, bonus: 6, adjustment: 7 };
  keep.sort((a, b) => String(a.user_id).localeCompare(String(b.user_id)) || (order[a.type] ?? 9) - (order[b.type] ?? 9) || String(a.line_key).localeCompare(String(b.line_key)));
  return { lines: keep, totals, people: Object.keys(totals) };
}

// What the same work would pay under the scoreboard's comparison
// (barta-rules §5: 20% of the jobs pooled and split by hours, +10% on
// upsells): information only, never pay.
export function poolComparison({ jobValueCents = 0, upsellCents = 0 }, cfg) {
  const c = payrollConfig(cfg);
  return half((jobValueCents * c.scoreboard_pool_bp) / 10000) + half((upsellCents * c.scoreboard_upsell_bp) / 10000);
}
