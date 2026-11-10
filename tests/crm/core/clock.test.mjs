// The one clock and the calendar (design §7.4, §7.5, §12.2): America/Chicago
// across the DST changes of 2026-11-01, 2027-03-14 and 2027-11-07, quiet
// hours, Sundays and holidays. The clock is always pinned here.
import { test, afterEach } from "node:test";
import assert from "node:assert/strict";

const C = await import("../../../netlify/lib/crm/core/clock.mjs");
const iso = (d) => d.toISOString();

afterEach(() => C.setNow(null));

test("now() is pinnable and returns copies", () => {
  C.setNow("2026-11-17T15:00:00Z");
  const a = C.now();
  a.setFullYear(1999);
  assert.equal(iso(C.now()), "2026-11-17T15:00:00.000Z");
  assert.equal(C.nowMs(), Date.parse("2026-11-17T15:00:00Z"));
  assert.equal(C.isPinned(), true);
  C.setNow(null);
  assert.equal(C.isPinned(), false);
  assert.throws(() => C.setNow("not a time"), TypeError);
});

test("2026-11-01 (fall back): 01:00-01:59 happens twice; the first one (CDT) is used", () => {
  assert.equal(iso(C.zonedToUtc("2026-11-01", "00:30")), "2026-11-01T05:30:00.000Z");
  assert.equal(iso(C.zonedToUtc("2026-11-01", "01:30")), "2026-11-01T06:30:00.000Z");
  assert.equal(iso(C.zonedToUtc("2026-11-01", "02:30")), "2026-11-01T08:30:00.000Z");
  for (const utc of ["2026-11-01T06:30:00Z", "2026-11-01T07:30:00Z"]) {
    assert.equal(C.localDate(utc), "2026-11-01");
    assert.equal(C.localTime(utc), "01:30");
  }
  assert.equal(C.offsetMinutes(Date.parse("2026-11-01T06:30:00Z")), -300);
  assert.equal(C.offsetMinutes(Date.parse("2026-11-01T07:30:00Z")), -360);
});

test("2027-03-14 (spring forward): 02:00-02:59 never happens and moves forward by the gap", () => {
  assert.equal(iso(C.zonedToUtc("2027-03-14", "01:30")), "2027-03-14T07:30:00.000Z");
  assert.equal(iso(C.zonedToUtc("2027-03-14", "02:30")), "2027-03-14T08:30:00.000Z");
  assert.equal(C.localTime(C.zonedToUtc("2027-03-14", "02:30")), "03:30");
  assert.equal(iso(C.zonedToUtc("2027-03-14", "03:30")), "2027-03-14T08:30:00.000Z");
  assert.equal(iso(C.zonedToUtc("2027-03-14", "10:00")), "2027-03-14T15:00:00.000Z");
});

test("2027-11-07 (fall back again)", () => {
  assert.equal(iso(C.zonedToUtc("2027-11-07", "01:30")), "2027-11-07T06:30:00.000Z");
  assert.equal(iso(C.zonedToUtc("2027-11-07", "03:00")), "2027-11-07T09:00:00.000Z");
  assert.equal(C.localDate("2027-11-07T05:59:00Z"), "2027-11-07");
  assert.equal(C.localDate("2027-11-07T04:59:00Z"), "2027-11-06");
});

test("local dates, days of week and day starts", () => {
  assert.equal(C.localDate("2026-11-18T05:30:00Z"), "2026-11-17", "23:30 CST is still the 17th");
  assert.equal(C.localDow("2026-11-22T18:00:00Z"), 0, "a Sunday");
  assert.equal(C.dowOfDate("2026-11-23"), 1);
  assert.equal(iso(C.startOfLocalDay("2026-11-17T15:00:00Z")), "2026-11-17T06:00:00.000Z");
  assert.equal(C.addLocalDays("2026-12-31", 1), "2027-01-01");
  assert.equal(C.addLocalDays("2027-03-15", -2), "2027-03-13");
  assert.equal(C.isLocalDate("2026-02-30"), false);
  assert.throws(() => C.zonedToUtc("2026-11-01", "25:00"), TypeError);
});

test("tsKey is sortable lowercase UTC and round-trips", () => {
  const k = C.tsKey(new Date("2026-11-17T15:04:05.123Z"));
  assert.equal(k, "20261117t150405123z");
  assert.equal(iso(C.fromTsKey(k)), "2026-11-17T15:04:05.123Z");
  assert.ok(C.tsKey(new Date("2026-11-17T15:04:05.124Z")) > k);
  assert.equal(C.fromTsKey("nope"), null);
});

test("holidays: Thanksgiving is the 4th Thursday of November; Christmas; owner dates", () => {
  assert.equal(C.thanksgiving(2026), "2026-11-26");
  assert.equal(C.thanksgiving(2027), "2027-11-25");
  assert.equal(C.isHoliday("2026-11-26"), true);
  assert.equal(C.isHoliday("2026-12-25"), true);
  assert.equal(C.isHoliday("2026-12-24"), false);
  assert.equal(C.isHoliday("2026-12-24", { rules: [], dates: ["2026-12-24"] }), true);
});

test("business hours follow the website (Mon-Fri 8-6, Sat 8-5, Sun closed)", () => {
  assert.equal(C.isBusinessOpen("2026-11-17T14:00:00Z"), true, "Tue 08:00");
  assert.equal(C.isBusinessOpen("2026-11-17T13:59:00Z"), false, "Tue 07:59");
  assert.equal(C.isBusinessOpen("2026-11-21T22:59:00Z"), true, "Sat 16:59");
  assert.equal(C.isBusinessOpen("2026-11-21T23:00:00Z"), false, "Sat 17:00");
  assert.equal(C.isBusinessOpen("2026-11-22T18:00:00Z"), false, "Sunday");
  assert.equal(C.isBusinessOpen("2026-11-26T18:00:00Z"), false, "Thanksgiving");
});

test("nextAllowed: service 08:00-21:00 every day; marketing 09:00-20:00 Mon-Sat, never Sundays or holidays", () => {
  const service = { from: "08:00", to: "21:00" };
  const marketing = { from: "09:00", to: "20:00", days: [1, 2, 3, 4, 5, 6], skipHolidays: true };
  assert.equal(iso(C.nextAllowed("2026-11-17T15:00:00Z", service)), "2026-11-17T15:00:00.000Z", "inside the window: now");
  assert.equal(iso(C.nextAllowed("2026-11-18T04:00:00Z", service)), "2026-11-18T14:00:00.000Z", "22:00 → 08:00 next day");
  assert.equal(iso(C.nextAllowed("2026-11-22T03:00:00Z", marketing)), "2026-11-23T15:00:00.000Z", "Sat 21:00 → Mon 09:00, Sunday skipped");
  assert.equal(iso(C.nextAllowed("2026-11-26T15:00:00Z", marketing)), "2026-11-27T15:00:00.000Z", "Thanksgiving skipped");
  assert.equal(iso(C.nextAllowed("2026-11-01T05:00:00Z", service)), "2026-11-01T14:00:00.000Z", "midnight on the fall-back day");
});
