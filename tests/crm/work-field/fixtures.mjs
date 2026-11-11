// Fixtures for the work module's field tests (M4b; design §12.5): the
// office part's fixtures (synthetic people, a pinned clock on Tuesday
// 2026-11-17 09:00 in Delano) plus what the tech app sends: client ids,
// device times, offline replays.
import { randomUUID } from "node:crypto";

export * from "../work-office/fixtures.mjs";
import { store, clock } from "../work-office/fixtures.mjs";

export const TS = await import("../../../netlify/lib/crm/modules/work/timesheets.mjs");
export const TM = await import("../../../netlify/lib/crm/modules/work/timers.mjs");
export const TF = await import("../../../netlify/lib/crm/modules/work/types-field.mjs");
export const VA = await import("../../../netlify/lib/crm/modules/work/visit-actions.mjs");
export const DAY = await import("../../../netlify/lib/crm/modules/work/techday.mjs");
export const FIELD = (await import("../../../netlify/lib/crm/modules/work/field.mjs")).default;

export const cid = () => randomUUID();

// A change the phone makes now, online: a client id and its device time.
export const live = (body = {}) => ({ client_id: cid(), client_at: clock.nowIso(), ...body });

// A change the phone made offline at `at` (device time) and replays now.
export function offline(body = {}, at = clock.nowIso(), { queuedAt } = {}) {
  return { client_id: cid(), client_at: at, queued_at: queuedAt || at, queued_offline: true, ...body };
}

export const rec = async (type, id) => (await store.getRecord(type, id)).data;
export const sheets = (t) => t.stores.data.keys("rec/timesheet/").map((k) => t.stores.data.json(k));
export const timers = (t) => t.stores.data.keys("rec/timer/").map((k) => t.stores.data.json(k));

// POST through the API as a person.
export const post = (t, as, path, body = {}, opts = {}) => t.api(path, { method: "POST", as, body, ...opts });
export const patch = (t, as, path, body = {}, opts = {}) => t.api(path, { method: "PATCH", as, body, ...opts });
