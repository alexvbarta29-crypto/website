// Pure pieces of the work module's office part (design §12.2 "work"):
// arrival-window wording, template variables, warnings, route order (keeps
// windows feasible), totals, stale flags, the Rotor mapping helpers.
import { test } from "node:test";
import assert from "node:assert/strict";
import { SCH, TY, AU, IMP } from "./fixtures.mjs";

const { arrivalWindow, visitVars, slotWarnings, routeOrder, windowEnd, serviceList, monthsOf, betweenText, taskSlot, townHints } = SCH;

test("arrival windows in the customer's words (§5.5, D16)", () => {
  const v = (window, extra = {}) => ({ date: "2026-11-19", start: "08:00", end: "10:00", window, ...extra });
  assert.equal(arrivalWindow(v({ type: "exact", minutes: 0 })), "at 8:00 AM");
  assert.equal(arrivalWindow(v({ type: "window", minutes: 120 })), "arriving between 8:00 and 10:00 AM");
  assert.equal(arrivalWindow(v({ type: "window", minutes: 120 }, { start: "11:00" })), "arriving between 11:00 AM and 1:00 PM");
  assert.equal(arrivalWindow(v({ type: "window", minutes: 60 }, { start: "12:30" })), "arriving between 12:30 and 1:30 PM");
  assert.equal(arrivalWindow(v({ type: "anytime", minutes: 0 })), "anytime between 8:00 AM and 6:00 PM", "that day's business hours, not Rotor's 9 PM");
  assert.equal(arrivalWindow(v({ type: "anytime", minutes: 0 }, { date: "2026-11-21" })), "anytime between 8:00 AM and 5:00 PM", "Saturday closes at 5");
  assert.equal(arrivalWindow(v({ type: "window", minutes: 120 }, { date_only: true })), "anytime between 8:00 AM and 6:00 PM", "a date-only import reads as anytime");
  assert.equal(betweenText("09:00", "09:00"), "9:00 and 9:00 AM");
});

test("visit variables for templates", () => {
  const vars = visitVars({ date: "2026-11-19", start: "13:00", end: "15:00", window: { type: "window", minutes: 120 }, town: "Mound", service_types: ["Residential Window Cleaning", "Exterior Cleaning::Gutters"] });
  assert.deepEqual(vars, { visit_date: "Thu, Nov 19", visit_time: "1:00 PM", arrival_window: "arriving between 1:00 and 3:00 PM", town: "Mound", service_list: "window cleaning and exterior cleaning" });
  assert.equal(serviceList([]), "your service");
  assert.equal(serviceList(["Christmas Lights"]), "Christmas lights");
  assert.equal(visitVars({ date: "2026-11-19", start: "08:00", date_only: true, window: {} }).visit_time, null);
});

test("warnings: holiday, closed, outside hours, not working, time off, overlaps (never on a cancelled visit)", () => {
  const users = new Map([["us_a", { first_name: "Sam", availability: [{ dow: 4, start: "08:00", end: "12:00" }] }]]);
  const base = { date: "2026-11-19", start: "09:00", end: "11:00", assignee_ids: ["us_a"] };
  assert.deepEqual(slotWarnings(base, { users }), []);
  assert.deepEqual(slotWarnings({ ...base, start: "11:00", end: "13:00" }, { users }).map((w) => w.code), ["unavailable"]);
  assert.deepEqual(slotWarnings({ ...base, date: "2026-12-25" }, { users }).map((w) => w.code), ["holiday", "unavailable"]);
  assert.deepEqual(slotWarnings({ ...base, start: "07:00", end: "08:30" }, { users }).map((w) => w.code), ["outside_hours", "unavailable"]);
  const visits = [{ id: "vs_x", d: "2026-11-19", s: "10:00", e: "12:00", a: ["us_a"], st: "scheduled" }, { id: "vs_y", d: "2026-11-19", s: "09:00", e: "10:00", a: ["us_a"], st: "cancelled" }];
  assert.deepEqual(slotWarnings(base, { users, visits }).map((w) => w.ref), ["vs_x"]);
  assert.deepEqual(slotWarnings({ ...base, visit_id: "vs_x" }, { users, visits }), [], "a visit doesn't clash with itself");
  const timeOff = [{ id: "to_1", uid: "us_a", s: "2026-11-19T14:00:00.000Z", e: "2026-11-19T16:00:00.000Z", av: false, r: "Doctor" }];
  assert.deepEqual(slotWarnings(base, { users, timeOff }).map((w) => w.message), ["Sam is off (Doctor)."], "09:00-11:00 CST overlaps 08:00-10:00 CST");
  assert.deepEqual(slotWarnings({ ...base, start: "10:00", end: "11:00" }, { users, timeOff }), [], "starts as the time off ends");
  const tasks = [taskSlot({ id: "tk_1", k: "meeting", t: "Supplier", due: "2026-11-19T16:30:00.000Z", end: "2026-11-19T17:30:00.000Z", a: ["us_a"] })];
  assert.deepEqual(slotWarnings(base, { users, tasks }).map((w) => w.code), ["overlap_task"]);
  assert.equal(taskSlot({ k: "call", due: "2026-11-19T16:30:00.000Z", end: "2026-11-19T17:30:00.000Z" }), null, "calls aren't calendar blocks");
  assert.deepEqual(townHints({ date: "2026-11-19", town: "mound" }, [{ id: "v1", d: "2026-11-19", town: "Mound", st: "scheduled" }]).map((h) => h.code), ["crew_in_town"]);
});

test("route order keeps windows feasible and drives the shortest way inside each window", () => {
  const base = { lat: 0, lng: 0 };
  const stop = (id, lng, wend, start = "08:00") => ({ id, geo: [0, lng], wend, start });
  // a 9:00 exact visit far away comes before the 8-10 ones however far it is
  const r = routeOrder([stop("near", 0.1, 600), stop("far", 0.9, 600), stop("exact", 2.0, 540), stop("mid", 0.5, 600), stop("pm", 0.05, 900)], base);
  assert.deepEqual(r.order, ["exact", "far", "mid", "near", "pm"], "after the 9:00 the path comes back toward the shop");
  // never place a visit after one whose window ends earlier
  const ends = new Map([["near", 600], ["far", 600], ["exact", 540], ["mid", 600], ["pm", 900]]);
  for (let i = 1; i < r.order.length; i++) assert.ok(ends.get(r.order[i - 1]) <= ends.get(r.order[i]));
  // 2-opt untangles a crossing nearest-neighbour leaves
  const zig = routeOrder([stop("a", 1, 600), stop("b", 2, 600), stop("c", 3, 600), stop("d", 1.5, 600)], base);
  assert.deepEqual(zig.order, ["a", "d", "b", "c"]);
  const blind = routeOrder([{ id: "x", geo: null, wend: 600, start: "09:00" }, { id: "w", geo: null, wend: 600, start: "08:00" }, stop("y", 1, 600)], base);
  assert.deepEqual(blind.order, ["y", "w", "x"]);
  assert.deepEqual(blind.no_geo, ["w", "x"]);
  assert.equal(windowEnd({ date: "2026-11-19", start: "08:00", window: { type: "window", minutes: 120 } }), 600);
  assert.equal(windowEnd({ date: "2026-11-21", start: "08:00", window: { type: "anytime" } }), 17 * 60);
});

test("job totals: lines by ordinal scope, optional lines, percentage then fixed discounts, never below $0", () => {
  const l = (id, cents, scope, extra = {}) => TY.validateLine({ id, title: id, unit_cents: cents, scope, ...extra }, "l");
  const lines = [l("ext", 29500, { type: "all" }), l("int", 8000, { type: "specific", visits: [2] }), l("screens", 500, { type: "initial" }, { qty_milli: 12000 }), l("opt", 1000, { type: "all" }, { optional: true })];
  assert.deepEqual(TY.jobTotals(lines, [], 1), { subtotal_cents: 35500, discount_cents: 0, total_cents: 35500 });
  assert.deepEqual(TY.jobTotals(lines, [], 2), { subtotal_cents: 37500, discount_cents: 0, total_cents: 37500 });
  const d = [{ type: "percentage", value: 1500, scope: { type: "all" } }, { type: "fixed", value: 5000, scope: { type: "after_initial" } }];
  assert.deepEqual(TY.jobTotals(lines, d, 1), { subtotal_cents: 35500, discount_cents: 5325, total_cents: 30175 });
  assert.deepEqual(TY.jobTotals([l("small", 1000, { type: "all" })], [{ type: "fixed", value: 5000, scope: { type: "all" } }], 1), { subtotal_cents: 1000, discount_cents: 1000, total_cents: 0 });
  assert.equal(TY.jobNumberLabel(885), "0000885");
  assert.equal(TY.jobNumberLabel(12, "job-shadow"), "S-000012");
  assert.throws(() => TY.validateVisit({ job_id: "jb_00000000000000000001", contact_id: "ct_00000000000000000001", date: "2026-11-19", start: "10:00", end: "09:00" }), /ends after/);
  const v = TY.validateVisit({ job_id: "jb_00000000000000000001", contact_id: "ct_00000000000000000001", date: "2027-03-14", start: "08:00", end: "10:00" });
  assert.equal(v.start_utc, "2027-03-14T13:00:00.000Z", "the spring-forward day, CDT");
  assert.equal(TY.validateVisit({ ...v, date: "2026-11-01" }).start_utc, "2026-11-01T14:00:00.000Z", "the fall-back day, CST");
});

test("stale flags and the index months", () => {
  const now = Date.parse("2026-11-17T15:00:00Z");
  assert.equal(AU.staleOf({ st: "scheduled", lv: "2026-11-16" }, "2026-11-17", now), "scheduled_past");
  assert.equal(AU.staleOf({ st: "scheduled", lv: "2026-11-17" }, "2026-11-17", now), null);
  assert.equal(AU.staleOf({ st: "in_progress", sa: "2026-11-15T14:00:00Z" }, "2026-11-17", now), "in_progress_stuck");
  assert.equal(AU.staleOf({ st: "in_progress", sa: "2026-11-16T14:00:00Z" }, "2026-11-17", now), null);
  assert.deepEqual(monthsOf("2026-11-28", "2027-01-03"), ["2026-11", "2026-12", "2027-01"]);
  assert.equal(AU.daysBetween("2026-11-17", "2026-12-01"), 14);
  assert.equal(AU.daysBetween("2026-10-31", "2026-11-02"), 2, "across the DST change");
});

test("Rotor mapping: placeholders, lines, kinds, statuses", () => {
  assert.equal(IMP.isPlaceholder("2026-05-01T12:00:00.000Z", "2026-05-01T13:00:00.000Z", "2026-03-01T00:00:00Z"), true, "12:00Z");
  assert.equal(IMP.isPlaceholder("2026-05-01T05:00:00.000Z", "2026-05-01T06:00:00.000Z", "2026-08-20T17:18:04Z"), true, "00:00 local, 60 min, from the onboarding import");
  assert.equal(IMP.isPlaceholder("2026-05-01T05:00:00.000Z", "2026-05-01T06:00:00.000Z", "2026-09-20T17:18:04Z"), false, "a real job made later");
  assert.equal(IMP.isPlaceholder("2026-05-01T13:00:00.000Z", "2026-05-01T15:00:00.000Z", "2026-08-20T17:18:04Z"), false);
  const unit = IMP.mapLine({ id: "rl1", title: "Screen Cleaning ", quantity: 12, unit_price: 5, custom_price: null, total_price: 60, use_unit_pricing: true, service_type: ["Residential Window Cleaning", "Residential Window Cleaning::Up to 40 Panes (2500 - 3499 Sqft)"], show_quantity: true }, 0);
  assert.deepEqual([unit.title, unit.qty_milli, unit.unit_cents, unit.total_cents, unit.service_type, unit.tier], ["Screen Cleaning", 12000, 500, 6000, "Residential Window Cleaning", "Up to 40 Panes (2500 - 3499 Sqft)"]);
  const custom = IMP.mapLine({ id: "rl2", title: "Christmas Light Installation", quantity: 1, custom_price: "243.1", total_price: "243.1", use_custom_price: true, service_type: ["Christmas Lights"] }, 1);
  assert.equal(custom.total_cents, 24310);
  assert.equal(IMP.jobKindOf([unit]), "standard");
  assert.equal(IMP.jobKindOf([unit, custom]), "lights_install");
  assert.throws(() => IMP.normalizeJob({ id: "j1", job_number: "abc", status: "Completed", customer: { id: "c1" } }), (e) => e.field === "job_number");
  assert.throws(() => IMP.normalizeVisit({ id: 1, job_id: "j1", start: "2026-05-01T13:00:00Z", status: "done" }), (e) => e.field === "status");
});
