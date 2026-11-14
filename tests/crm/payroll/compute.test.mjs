// Payroll's arithmetic, worked by hand (design §5.8, §12.2 "payroll", B15):
// 45 h across two categories (40 regular + 5 overtime at the weighted
// rate); a week spanning the daylight-saving change; commission splits
// by_hours / equal / each_full; greater_of; tips; timer segments under one
// minute ignored. Synthetic people only.
import { test } from "node:test";
import assert from "node:assert/strict";

const C = await import("../../../netlify/lib/crm/modules/payroll/compute.mjs");
const S = await import("../../../netlify/lib/crm/modules/payroll/settings.mjs");

const TECH = "us_000000000000000000t1", TECH2 = "us_000000000000000000t2", OWNER = "us_000000000000000000o1";
const pay = (extra = {}) => ({ model: "hourly", hourly_cents: { service: 2000, sales: 0, office: 1600 }, commission_pct: { technician: 0, salesman: 0, upsell: 0 }, overtime: true, ...extra });
const user = (id, role, p) => ({ id, name: `Sample ${id.slice(-2)}`, role, status: "active", pay: p });
const WEEK = { id: "pp_0000000000000000000a", start_on: "2026-11-08", end_on: "2026-11-14", weeks: 1 };
// a shift on a local day from hh:mm for h hours (America/Chicago is UTC-6 in November after the 1st)
const shift = (id, uid, day, startH, hours, category = "service", status = "approved") => {
  const s = new Date(`${day}T${String(startH).padStart(2, "0")}:00:00-06:00`);
  return { id, user_id: uid, category, start_at: s.toISOString(), end_at: new Date(s.getTime() + hours * 3600000).toISOString(), status };
};

test("45 hours across two categories: 40 regular and 5 overtime at the week's weighted rate", () => {
  const sheets = [
    ...["2026-11-08", "2026-11-09", "2026-11-10", "2026-11-11", "2026-11-12"].map((d, i) => shift(`ts_s${i}`, TECH, d, 7, 6)),          // 30 h service at $20
    ...["2026-11-12", "2026-11-13", "2026-11-14"].map((d, i) => shift(`ts_o${i}`, TECH, d, 14, 5, "office")),                       // 15 h office at $16
    shift("ts_p", TECH, "2026-11-14", 6, 2, "service", "pending_approval"),                                                       // waits: not counted
    shift("ts_r", TECH, "2026-11-13", 6, 2, "service", "rejected"),
  ];
  const out = C.computePeriod({ period: WEEK, users: [user(TECH, "tech", pay())], sheets });
  const t = out.totals[TECH];
  // straight time $600 + $240 = $840; weighted $840 / 45 h = $18.6667; 5 h × 18.6667 × 0.5 = $46.67
  assert.equal(t.hourly_cents, 84000);
  assert.equal(t.ot_cents, 4667);
  assert.equal(t.total_cents, 88667, "= 40 h × $18.67 + 5 h × $18.67 × 1.5");
  assert.deepEqual([t.regular_hours, t.ot_hours, t.minutes, t.pending_minutes], [40, 5, 45 * 60, 120]);
  const ot = out.lines.find((l) => l.type === "overtime");
  assert.equal(ot.line_key, `overtime:${TECH}:2026-11-08`);
  assert.equal(out.lines.filter((l) => l.type === "hourly").length, 8);
  assert.match(out.lines.find((l) => l.type === "hourly").line_key, /^hourly:ts_[a-z0-9]+:2026-11-\d\dT\d\d:00:00\.000Z:2026-11-\d\dT\d\d:00:00\.000Z$/);
  assert.equal(out.lines.find((l) => l.line_key.includes("ts_s0")).detail, "Nov 8, 7:00 AM - 1:00 PM");
});

test("overtime is per Sunday-Saturday week, not per period, and off for someone without overtime", () => {
  const two = { id: "pp_0000000000000000000b", start_on: "2026-11-08", end_on: "2026-11-21", weeks: 2 };
  const sheets = [
    ...["2026-11-08", "2026-11-09", "2026-11-10", "2026-11-11"].map((d, i) => shift(`ts_a${i}`, TECH, d, 6, 11)),   // 44 h week one
    ...["2026-11-15", "2026-11-16", "2026-11-17"].map((d, i) => shift(`ts_b${i}`, TECH, d, 6, 10)),                                                // 30 h week two
  ];
  const out = C.computePeriod({ period: two, users: [user(TECH, "tech", pay())], sheets });
  assert.deepEqual([out.totals[TECH].regular_hours, out.totals[TECH].ot_hours], [70, 4], "74 h over two weeks: only week one's 4 h are overtime");
  assert.equal(out.totals[TECH].ot_cents, 4 * 1000, "4 h × $20 × 0.5");
  const noOt = C.computePeriod({ period: two, users: [user(TECH, "tech", pay({ overtime: false }))], sheets });
  assert.equal(noOt.totals[TECH].ot_cents, 0);
  assert.equal(noOt.totals[TECH].total_cents, 74 * 2000);
});

test("a week spanning the daylight-saving change counts the real time, in the week the shift started", () => {
  // Sat Oct 31 10:00 PM CDT → Sun Nov 1 3:00 AM CST is 6 real hours (the clock falls back at 2 AM)
  const s = { id: "ts_dst", user_id: TECH, category: "service", start_at: "2026-11-01T03:00:00.000Z", end_at: "2026-11-01T09:00:00.000Z", status: "approved" };
  const s2 = { id: "ts_sun", user_id: TECH, category: "service", start_at: "2026-11-01T15:00:00.000Z", end_at: "2026-11-01T23:00:00.000Z", status: "closed" };   // Sun 9 AM - 5 PM CST
  const p = { id: "pp_0000000000000000000c", start_on: "2026-10-25", end_on: "2026-11-07", weeks: 2 };
  const out = C.computePeriod({ period: p, users: [user(TECH, "tech", pay())], sheets: [s, s2] });
  const lines = out.lines.filter((l) => l.type === "hourly");
  assert.deepEqual(lines.map((l) => [l.week, l.minutes]), [["2026-10-25", 360], ["2026-11-01", 480]]);
  assert.equal(lines[0].detail, "Oct 31, 10:00 PM - Nov 1, 3:00 AM");
  assert.equal(out.totals[TECH].total_cents, 14 * 2000);
  assert.deepEqual(C.weeksOf(p), ["2026-10-25", "2026-11-01"]);
});

test("technician commission splits: by hours (timer minutes), equally, or each at the full job", () => {
  const job = { id: "jb_0000000000000000000a", number: 516, title: "Exterior windows", total_cents: 50000, billable: true, status: "completed", completed_at: "2026-11-10T20:00:00.000Z", assignee_ids: [TECH, TECH2], minutes: { [TECH]: 120, [TECH2]: 60 }, first_visit_id: "vs_0000000000000000000a", lines: [] };
  const users = [user(TECH, "tech", pay({ model: "commission", commission_pct: { technician: 2000, salesman: 0, upsell: 0 } })), user(TECH2, "tech", pay({ model: "commission", commission_pct: { technician: 2000, salesman: 0, upsell: 0 } }))];
  const run = (split) => C.computePeriod({ period: WEEK, users, settings: { commission_split: split }, jobs: [job] });
  const byHours = run("by_hours");
  // $500 × 120/180 = $333.33, × 60/180 = $166.67 (the left-over cent to the larger remainder); 20% of each
  assert.deepEqual(byHours.lines.map((l) => [l.user_id, l.basis_cents, l.amount_cents]), [[TECH, 33333, 6667], [TECH2, 16667, 3333]]);
  assert.equal(byHours.lines[0].line_key, `technician:${TECH}:vs_0000000000000000000a-jb_0000000000000000000a`);
  assert.deepEqual(run("equal").lines.map((l) => [l.basis_cents, l.amount_cents]), [[25000, 5000], [25000, 5000]]);
  assert.deepEqual(run("each_full").lines.map((l) => [l.basis_cents, l.amount_cents]), [[50000, 10000], [50000, 10000]]);
  // no minutes at all: by_hours falls back to equal shares
  assert.deepEqual(C.computePeriod({ period: WEEK, users, jobs: [{ ...job, minutes: {} }] }).lines.map((l) => l.basis_cents), [25000, 25000]);
  // a job outside the period, a non-billable one and a cancelled one pay nothing
  const none = C.computePeriod({ period: WEEK, users, jobs: [{ ...job, completed_at: "2026-11-15T20:00:00.000Z" }, { ...job, id: "jb_b", billable: false }, { ...job, id: "jb_c", status: "cancelled" }] });
  assert.equal(none.lines.length, 0);
  // an hourly person earns no commission lines at all
  const hourly = C.computePeriod({ period: WEEK, users: [user(TECH, "tech", pay({ commission_pct: { technician: 2000, salesman: 0, upsell: 0 } }))], jobs: [job] });
  assert.equal(hourly.lines.length, 0);
});

test("timer segments under one minute are ignored when sharing by hours", () => {
  const m = C.minutesFromTimers([
    { user_ids: [TECH], start_at: "2026-11-10T15:00:00Z", end_at: "2026-11-10T17:00:00Z" },
    { user_ids: [TECH2], start_at: "2026-11-10T15:00:00Z", end_at: "2026-11-10T15:00:20Z" },      // 20 s: ignored
    { user_ids: [TECH, TECH2], start_at: "2026-11-10T17:00:00Z", end_at: "2026-11-10T18:00:00Z" },
    { user_ids: [TECH2], start_at: "2026-11-10T18:00:00Z" },                                      // still running: ignored
  ]);
  assert.deepEqual(m, { [TECH]: 180, [TECH2]: 60 });
});

test("greater_of pays, each week, the higher of hours + overtime and commission, plus tips", () => {
  const u = user(TECH, "tech", pay({ model: "greater_of", hourly_cents: { service: 1800, sales: 0, office: 0 }, commission_pct: { technician: 2000, salesman: 0, upsell: 0 } }));
  const sheets = [shift("ts_g1", TECH, "2026-11-09", 8, 5), shift("ts_g2", TECH, "2026-11-10", 8, 5)];   // 10 h × $18 = $180
  const job = (cents) => ({ id: "jb_g", number: 7, total_cents: cents, billable: true, status: "completed", completed_at: "2026-11-10T20:00:00.000Z", assignee_ids: [TECH], lines: [] });
  const tips = [{ payment_id: "pm_t1", kind: "payment", received_on: "2026-11-10", tip_cents: 1000, split: [{ user_id: TECH, cents: 1000 }] }];
  const big = C.computePeriod({ period: WEEK, users: [u], sheets, jobs: [job(120000)], tips });   // 20% of $1,200 = $240 > $180
  assert.equal(big.totals[TECH].total_cents, 24000 + 1000);
  assert.ok(big.lines.filter((l) => l.type === "hourly").every((l) => l.status === "void"), "the hours are shown struck out");
  assert.match(big.totals[TECH].model_applied, /greater_of: commission/);
  const small = C.computePeriod({ period: WEEK, users: [u], sheets, jobs: [job(50000)], tips });  // $100 < $180
  assert.equal(small.totals[TECH].total_cents, 18000 + 1000);
  assert.equal(small.lines.find((l) => l.type === "technician_commission").status, "void");
});

test("tips as money split them (a refunded tip comes off), salesman and upsell commission, adjustments", () => {
  const owner = user(OWNER, "owner", pay({ model: "hourly_plus_commission", hourly_cents: { service: 0, sales: 0, office: 0 }, commission_pct: { technician: 2500, salesman: 1000, upsell: 0 } }));
  const tech = user(TECH, "tech", pay({ commission_pct: { technician: 0, salesman: 0, upsell: 1000 }, model: "hourly_plus_commission" }));
  const tech2 = user(TECH2, "tech", pay());
  const jobs = [{
    id: "jb_s", number: 9, number_label: "0000009", total_cents: 52500, billable: true, status: "completed", completed_at: "2026-11-12T18:00:00.000Z", assignee_ids: [OWNER, TECH],
    sold_by: OWNER, plan_id: "pl_x", lines: [{ id: "ln_1", title: "Screens", total_cents: 4000, upsell_user_id: TECH }],
  }];
  const tips = [
    { payment_id: "pm_a", kind: "payment", received_on: "2026-11-12", tip_cents: 2501, split: [{ user_id: TECH, cents: 1251 }, { user_id: TECH2, cents: 1250 }] },
    { payment_id: "pm_r", kind: "refund", received_on: "2026-11-13", tip_cents: 500, split: [{ user_id: TECH2, cents: 500 }] },
    { payment_id: "pm_late", kind: "payment", received_on: "2026-11-15", tip_cents: 999, split: [{ user_id: TECH, cents: 999 }] },
  ];
  const adjustments = [
    { id: "py_1", user_id: TECH2, type: "bonus", line_key: "bonus:x", label: "Review bonus", amount_cents: 2000, status: "draft" },
    { id: "py_2", user_id: TECH2, type: "adjustment", line_key: "adj:y", label: "Struck", amount_cents: 9999, status: "void" },
  ];
  const out = C.computePeriod({ period: WEEK, users: [owner, tech, tech2], settings: { commission_split: "equal" }, jobs, tips, adjustments });
  const o = out.totals[OWNER];
  // technician 25% of half of $525 (equal split: $262.50) = $65.63; salesman 10% of $525 = $52.50
  assert.equal(o.commission_cents, 6563 + 5250);
  assert.ok(out.lines.some((l) => l.line_key === `salesman:${OWNER}:pl_x:jb_s`));
  assert.equal(out.totals[TECH].commission_cents, 400, "10% of the $40 upsell");
  assert.equal(out.totals[TECH].tips_cents, 1251, "the tip after the period isn't in it");
  assert.equal(out.totals[TECH2].tips_cents, 750, "$12.50 less the $5 refunded");
  assert.equal(out.totals[TECH2].adjustments_cents, 2000, "a void adjustment pays nothing");
  assert.equal(out.lines.find((l) => l.line_key === `tip:${TECH}:pm_a`).amount_cents, 1251);
});

test("rates: a technician with no rate gets D3's $20 for service; an owner only what is set", () => {
  assert.deepEqual(S.rateFor({ role: "tech", pay: {} }, "service"), { cents: 2000, standard: true });
  assert.deepEqual(S.rateFor({ role: "tech", pay: { hourly_cents: { service: 2200 } } }, "office"), { cents: 2200, standard: false });
  assert.deepEqual(S.rateFor({ role: "owner", pay: { hourly_cents: { service: 2000, office: 0 } } }, "office"), { cents: 0, standard: false });
  assert.equal(S.commissionBp({ pay: { commission_pct: { technician: 2500 } } }, "technician"), 2500);
  assert.deepEqual(C.shareBy(100, [1, 1, 1]), [34, 33, 33]);
  assert.equal(C.poolComparison({ jobValueCents: 100000, upsellCents: 10000 }, {}), 20000 + 1000, "20% pooled + 10% on upsells");
  assert.throws(() => S.validatePayroll({ commission_split: "whim" }), /Split/);
  assert.throws(() => S.validatePayroll({ period_weeks: 3 }), /one or two/);
  assert.equal(S.validatePayroll({ ot_threshold_hours: 40, extra: 1 }).extra, 1, "unknown fields are kept");
});
