// Automations module: when a step is due (pure; America/Chicago through
// core/clock.mjs, so DST is the clock's).
//
//   stepDue(from, step, { hours, calendar }) → Date
//
// From the moment the previous step ran (or the run started):
//   1. the wait: minutes and hours are elapsed time; days are calendar days
//      at the same wall-clock time ("3 days" from Saturday 10:00 before the
//      fall-back night is Tuesday 10:00, 73 hours later);
//   2. "at" a time of day: after a wait in days, that time on the day the
//      wait lands on; otherwise the next time the clock shows it;
//   3. business hours: moved forward into the next open hours of
//      cfg/hours, skipping holidays (cfg/calendar).
// The sender still applies quiet hours to texts and emails at send time.

import { localDate, localTime, zonedToUtc, addLocalDays, dowOfDate, isHoliday, isLocalTime, DEFAULT_HOURS, DEFAULT_CALENDAR } from "../../core/clock.mjs";

const UNIT_MS = { minutes: 60000, hours: 3600000 };

// The next instant at or after t inside open hours (null after 21 days of nothing open).
export function nextOpen(t, hours = DEFAULT_HOURS, calendar = DEFAULT_CALENDAR) {
  let date = localDate(t);
  for (let i = 0; i < 21; i++, date = addLocalDays(date, 1)) {
    if (isHoliday(date, calendar)) continue;
    const span = hours && hours[dowOfDate(date)];
    if (!Array.isArray(span) || !isLocalTime(span[0]) || !isLocalTime(span[1]) || span[0] >= span[1]) continue;
    const start = zonedToUtc(date, span[0]);
    const end = zonedToUtc(date, span[1]);
    if (t < start) return start;
    if (t < end) return new Date(t.getTime());
  }
  return null;
}

export function stepDue(from, step = {}, { hours = DEFAULT_HOURS, calendar = DEFAULT_CALENDAR } = {}) {
  let t = new Date(from instanceof Date ? from.getTime() : Date.parse(from));
  const w = step.wait;
  let landedDay = null;
  if (w && w.n > 0) {
    if (w.unit === "days") {
      landedDay = addLocalDays(localDate(t), w.n);
      t = zonedToUtc(landedDay, localTime(t));
    } else {
      t = new Date(t.getTime() + w.n * (UNIT_MS[w.unit] || 60000));
    }
  }
  if (step.at && isLocalTime(step.at)) {
    if (landedDay) t = zonedToUtc(landedDay, step.at);
    else {
      let at = zonedToUtc(localDate(t), step.at);
      if (at < t) at = zonedToUtc(addLocalDays(localDate(t), 1), step.at);
      t = at;
    }
  }
  if (step.business_hours) t = nextOpen(t, hours, calendar) || t;
  return t;
}
