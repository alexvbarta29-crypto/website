// Budget samples for the work module's office routes (read by
// tests/crm/core/budget.test.mjs): "METHOD /path" → (fx) → the request.
// Each sample makes what it needs through the store first (synthetic
// people only). Busy days are the realistic case: 8 visits on the day.

const store = await import("../../../netlify/lib/crm-store.mjs");
const OFF = await import("../../../netlify/lib/crm/modules/work/office.mjs");
const W = (by = "system") => ({ by, origin: "api", actor_kind: "user", requestId: "budget" });
const scope = (fn) => store.withStoreScope({ requestId: "budget" }, fn);

let n = 0;
async function customer() {
  n += 1;
  return scope(async () => {
    const c = (await store.createRecord("contact", {
      first_name: "Budget", last_name: `Work${n}`, phones: [{ e164: `+1763555${String(700 + n).padStart(4, "0")}`, sms: true }], lifecycle: "customer",
      source: { source: "Website quote form" }, consent: { sms_service: { state: "granted" } }, billing_address: { street1: `${n} Example Ave`, city: "Delano", state: "MN", zip: "55328" },
    }, W())).data;
    const p = (await store.createRecord("property", { contact_id: c.id, label: "Home", address: { street1: `${n} Example Ave`, city: "Delano", state: "MN", zip: "55328", country: "US" }, access: {}, assets: {}, photo_ids: [], geo: { lat: 45.0 + n / 1000, lng: -93.8 + n / 1000, source: "manual", at: "2026-11-01T00:00:00.000Z" } }, W())).data;
    await store.updateRecord("contact", c.id, (x) => ({ ...x, primary_property_id: p.id }), W());
    return c;
  });
}
const LINES = [{ title: "Exterior window cleaning", unit_cents: 29500, service_type: "Residential Window Cleaning" }];
async function job(spec = {}) {
  const c = await customer();
  const [id] = await scope(() => OFF.createJobs([{ contact_id: c.id, kind: "standard", lines: LINES, ...spec }], `budget-job-${++n}`, "manual", W()));
  return (await store.getRecord("job", id)).data;
}
async function visit(fx, slot = {}) {
  const j = await job();
  return scope(async () => (await OFF.createVisit({ job_id: j.id, date: "2026-11-24", start: "08:00", end: "10:00", assignee_ids: [fx.tech.id], ...slot }, W(fx.owner.id))).visit);
}
async function busyDay(fx) {
  const out = [];
  for (let i = 0; i < 8; i++) out.push(await visit(fx, { start: `${String(8 + i).padStart(2, "0")}:00`, end: `${String(9 + i).padStart(2, "0")}:00` }));
  return out;
}
const etag = async (type, id) => (await store.getRecord(type, id)).etag;
let checklist = null;
const checklists = async () => { if (!checklist) { await scope(() => OFF.seedChecklists({ write: () => W() })); checklist = (await store.readIndex("checklists", "")).rows[0]; } return checklist; };

export default {
  // the heaviest read: the month view's whole grid with job totals; December 2026's runs Nov 29 to Jan 2 (three visit shards, two years)
  // the Visits list (the Nov 2026 layout): a busy day's cards
  "GET /visits": async (fx) => { await busyDay(fx); return { as: fx.owner, path: "/visits?date=2026-11-24" }; },
  "GET /schedule": async (fx) => {
    await busyDay(fx);
    for (const date of ["2026-11-29", "2026-12-01", "2026-12-01", "2026-12-15", "2027-01-02"]) await visit(fx, { date });
    return { as: fx.owner, path: "/schedule?month=2026-12&amounts=1" };
    // (a day with pay=1&sales=1 reads fewer shards than the month: weather.test / capacity.test cover it)
  },
  "GET /schedule/unscheduled": async (fx) => { await job(); return { as: fx.owner, path: "/schedule/unscheduled" }; },
  // the forecast: settings, the point and the grid from the cache (no call outside a Netlify deploy; weather.test.mjs runs the cold path with a mocked NWS)
  "GET /schedule/weather": async (fx) => ({ as: fx.owner, path: "/schedule/weather" }),
  "GET /schedule/check": async (fx) => ({ as: fx.owner, path: `/schedule/check?date=2026-11-24&start=09:00&end=11:00&users=${fx.tech.id}&town=Delano` }),
  "GET /schedule/route": async (fx) => ({ as: fx.owner, path: `/schedule/route?date=2026-11-24&user=${fx.tech.id}` }),
  "POST /schedule/route": async (fx) => { await busyDay(fx); return { as: fx.owner, path: "/schedule/route", body: { date: "2026-11-24", user_id: fx.tech.id } }; },
  "POST /schedule/move-day": async (fx) => ({ as: fx.owner, path: "/schedule/move-day", body: { from_date: "2026-11-24", to_date: "2026-11-27", filter: {}, notify: true } }),
  "GET /stale": async (fx) => ({ as: fx.owner, path: "/stale" }),
  "GET /jobs": async (fx) => ({ as: fx.owner, path: "/jobs" }),
  "POST /jobs": async (fx) => {
    const c = await customer();
    return { as: fx.owner, path: "/jobs", body: { contact_id: c.id, lines: LINES, crew_notes: "Dog in back", client_id: "budget-new-job-1", visit: { date: "2026-11-25", start: "08:00", end: "10:00", window: { type: "window", minutes: 120 }, assignee_ids: [fx.tech.id] } } };
  },
  "GET /jobs/:id": async (fx) => { const v = await visit(fx); return { as: fx.owner, path: `/jobs/${v.job_id}` }; },
  "PATCH /jobs/:id": async (fx) => { const j = await job(); return { as: fx.owner, path: `/jobs/${j.id}`, ifMatch: await etag("job", j.id), body: { crew_notes: "Ladder needed", lines: [...LINES, { title: "Screens", unit_cents: 500, qty_milli: 20000 }] } }; },
  "POST /jobs/:id/cancel": async (fx) => { const v = await visit(fx); await scope(() => OFF.createVisit({ job_id: v.job_id, date: "2026-11-30", start: "08:00", end: "10:00", assignee_ids: [fx.tech.id] }, W(fx.owner.id))); return { as: fx.owner, path: `/jobs/${v.job_id}/cancel`, body: { reason: "Moved away" } }; },
  "POST /jobs/:id/reopen": async (fx) => { const v = await visit(fx); await scope(() => OFF.completeJob(v.job_id, W(fx.owner.id))); return { as: fx.owner, path: `/jobs/${v.job_id}/reopen`, body: {} }; },
  "POST /jobs/:id/complete": async (fx) => { const v = await visit(fx); await scope(() => OFF.createVisit({ job_id: v.job_id, date: "2026-11-30", start: "08:00", end: "10:00", assignee_ids: [fx.tech.id] }, W(fx.owner.id))); return { as: fx.owner, path: `/jobs/${v.job_id}/complete`, body: {} }; },
  "POST /visits": async (fx) => { await busyDay(fx); const j = await job(); return { as: fx.owner, path: "/visits", body: { job_id: j.id, date: "2026-11-24", start: "16:00", end: "17:00", window: { type: "exact" }, assignee_ids: [fx.tech.id], client_id: "budget-visit-0001" } }; },
  "GET /visits/:id": async (fx) => { const v = await visit(fx); return { as: fx.owner, path: `/visits/${v.id}` }; },
  "PATCH /visits/:id": async (fx) => { const day = await busyDay(fx); const v = day[0]; return { as: fx.owner, path: `/visits/${v.id}`, ifMatch: await etag("visit", v.id), body: { date: "2026-11-25", assignee_ids: [fx.tech.id, fx.admin.id] } }; },
  "POST /visits/:id/cancel": async (fx) => { const v = await visit(fx); return { as: fx.owner, path: `/visits/${v.id}/cancel`, body: { reason: "Customer called", late: true } }; },
  "POST /visits/:id/mark-no-access": async (fx) => { const v = await visit(fx); return { as: fx.owner, path: `/visits/${v.id}/mark-no-access`, body: { note: "Gate locked" } }; },
  "POST /visits/:id/done": async (fx) => { const v = await visit(fx); return { as: fx.owner, path: `/visits/${v.id}/done`, body: {} }; },
  "POST /visits/:id/reopen": async (fx) => { const v = await visit(fx); await scope(() => OFF.changeVisit(v.id, "office_complete", { ctx: W(fx.owner.id) })); return { as: fx.owner, path: `/visits/${v.id}/reopen`, body: {} }; },
  "GET /time-off": async (fx) => ({ as: fx.owner, path: "/time-off" }),
  "POST /time-off": async (fx) => ({ as: fx.owner, path: "/time-off", body: { user_id: fx.tech.id, date: "2026-12-24", end_date: "2026-12-26", reason: "Holidays" } }),
  "PATCH /time-off/:id": async (fx) => { const r = await scope(() => store.createRecord("time_off", { user_id: fx.tech.id, start_at: "2026-12-01T14:00:00.000Z", end_at: "2026-12-01T18:00:00.000Z", reason: "Doctor" }, W())); return { as: fx.owner, path: `/time-off/${r.data.id}`, ifMatch: r.etag, body: { start_at: "2026-12-01T15:00:00.000Z", end_at: "2026-12-01T18:00:00.000Z", reason: "Doctor" } }; },
  "DELETE /time-off/:id": async (fx) => { const r = await scope(() => store.createRecord("time_off", { user_id: fx.tech.id, start_at: "2026-12-02T14:00:00.000Z", reason: "Off" }, W())); return { as: fx.owner, path: `/time-off/${r.data.id}` }; },
  "GET /checklists": async (fx) => { await checklists(); return { as: fx.owner, path: "/checklists" }; },
  "GET /checklists/:id": async (fx) => ({ as: fx.owner, path: `/checklists/${(await checklists()).id}` }),
  "POST /checklists": async (fx) => ({ as: fx.owner, path: "/checklists", body: { key: "budget_list", name: "Budget list", service_types: [], items: [{ key: "a_thing", label: "A thing", required: true }] } }),
  "PATCH /checklists/:id": async (fx) => { const c = await checklists(); return { as: fx.owner, path: `/checklists/${c.id}`, ifMatch: await etag("checklist_template", c.id), body: { name: "Exterior windows (edited)" } }; },
  "GET /work/contacts/:id": async (fx) => { const v = await visit(fx); for (let i = 0; i < 3; i++) await scope(() => OFF.createVisit({ job_id: v.job_id, date: `2026-12-0${i + 1}`, start: "08:00", end: "10:00" }, W(fx.owner.id))); return { as: fx.owner, path: `/work/contacts/${v.contact_id}` }; },
};
