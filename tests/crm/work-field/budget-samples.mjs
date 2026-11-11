// Budget samples for the work module's field routes (read by
// tests/crm/core/budget.test.mjs): "METHOD /path" → (fx) → the request.
// Each sample makes what it needs through the store first (synthetic
// people only). A busy day is the realistic case: 8 visits for the tech,
// each with timers and a history.

import { randomUUID } from "node:crypto";
const store = await import("../../../netlify/lib/crm-store.mjs");
const OFF = await import("../../../netlify/lib/crm/modules/work/office.mjs");
const W = (by = "system") => ({ by, origin: "api", actor_kind: "user", requestId: "budget" });
const scope = (fn) => store.withStoreScope({ requestId: "budget" }, fn);
const cid = () => randomUUID();
const now = () => "2026-11-17T15:00:00.000Z";
const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00, 0x01, ...new Array(64).fill(7)]).toString("base64");

let n = 0;
async function customer() {
  n += 1;
  return scope(async () => {
    const c = (await store.createRecord("contact", {
      first_name: "Budget", last_name: `Field${n}`, phones: [{ e164: `+1763555${String(800 + n).padStart(4, "0")}`, sms: true }], lifecycle: "customer",
      source: { source: "Website quote form" }, consent: { sms_service: { state: "granted" } }, billing_address: { street1: `${n} Example Ave`, city: "Delano", state: "MN", zip: "55328" },
    }, W())).data;
    const p = (await store.createRecord("property", { contact_id: c.id, label: "Home", address: { street1: `${n} Example Ave`, city: "Delano", state: "MN", zip: "55328", country: "US" }, access: { gate_code: "1234" }, assets: {}, photo_ids: [], geo: { lat: 45.0 + n / 1000, lng: -93.8 + n / 1000, source: "manual", at: "2026-11-01T00:00:00.000Z" } }, W())).data;
    await store.updateRecord("contact", c.id, (x) => ({ ...x, primary_property_id: p.id }), W());
    return c;
  });
}
const LINES = [{ title: "Exterior window cleaning", unit_cents: 29500, service_type: "Residential Window Cleaning" }];
async function visit(fx, slot = {}) {
  const c = await customer();
  const [jobId] = await scope(() => OFF.createJobs([{ contact_id: c.id, kind: "standard", lines: LINES }], `budget-field-${++n}`, "manual", W()));
  return scope(async () => (await OFF.createVisit({ job_id: jobId, date: "2026-11-17", start: "08:00", end: "10:00", assignee_ids: [fx.tech.id], ...slot }, W(fx.owner.id))).visit);
}
// A history at the place: an earlier finished visit with notes (the day payload's "last time").
async function withHistory(fx, v) {
  const j = await scope(async () => (await store.getRecord("job", v.job_id)).data);
  const old = await scope(async () => (await OFF.createVisit({ job_id: j.id, date: "2026-11-10", start: "08:00", end: "10:00", assignee_ids: [fx.tech.id] }, W(fx.owner.id))).visit);
  await scope(() => store.updateRecord("visit", old.id, (x) => ({ ...x, status: "completed", tech_notes: "Synthetic: hard water.", completion: { at: "2026-11-10T16:00:00.000Z", by: fx.tech.id } }), W()));
}
async function busyDay(fx) {
  const out = [];
  for (let i = 0; i < 8; i++) {
    const v = await visit(fx, { start: `${String(8 + i).padStart(2, "0")}:00`, end: `${String(9 + i).padStart(2, "0")}:00` });
    await withHistory(fx, v);
    await scope(() => store.createRecord("timer", { visit_id: v.id, job_id: v.job_id, user_ids: [fx.tech.id], start_at: "2026-11-17T13:00:00.000Z", end_at: "2026-11-17T13:40:00.000Z" }, W(fx.tech.id)));
    out.push(v);
  }
  return out;
}
const req = (as, path, body, extra = {}) => ({ as, path, body: { client_id: cid(), client_at: now(), ...body }, ...extra });
const etag = async (type, id) => (await store.getRecord(type, id)).etag;
async function started(fx) {
  const v = await visit(fx);
  await scope(() => store.createRecord("timer", { visit_id: v.id, job_id: v.job_id, user_ids: [fx.tech.id], start_at: "2026-11-17T14:00:00.000Z" }, W(fx.tech.id)));
  await scope(() => store.updateRecord("visit", v.id, (x) => ({ ...x, status: "in_progress" }), W()));
  return v;
}
async function sheet(fx, extra = {}, who = fx.tech) {
  return scope(async () => (await store.createRecord("timesheet", { user_id: who.id, category: "service", start_at: "2026-11-16T14:00:00.000Z", end_at: "2026-11-16T22:00:00.000Z", status: "closed", notes: [], edits: [], ...extra }, W(who.id))).data);
}
let priceItem = null;
async function item() {
  if (!priceItem) priceItem = (await scope(() => store.createRecord("price_item", { key: "budget_screens", name: "Screen Cleaning", category: "screens", service_type: "Residential Window Cleaning", unit: "screen", unit_cents: 500, active: true, sellable: true }, W()))).data;
  return priceItem;
}

export default {
  "GET /tech/day": async (fx) => { await busyDay(fx); return { as: fx.tech, path: "/tech/day" }; },
  "POST /visits/:id/on-my-way": async (fx) => { const v = await visit(fx, { start: "11:00", end: "12:00" }); return req(fx.tech, `/visits/${v.id}/on-my-way`, { eta_min: 15, lat: 45.04, lng: -93.79 }); },
  "POST /visits/:id/running-late": async (fx) => { const v = await visit(fx, { start: "11:00", end: "12:00" }); return req(fx.tech, `/visits/${v.id}/running-late`, { eta_min: 20 }); },
  "POST /visits/:id/timer": async (fx) => { const v = await visit(fx); return req(fx.tech, `/visits/${v.id}/timer`, { action: "start" }); },
  "GET /visits/:id/field": async (fx) => { const [v] = await busyDay(fx); return { as: fx.tech, path: `/visits/${v.id}/field` }; },
  "PATCH /visits/:id/checklist": async (fx) => { const v = await visit(fx); return req(fx.tech, `/visits/${v.id}/checklist`, { key: "gate_closed", done: true }); },
  "POST /visits/:id/notes": async (fx) => { const v = await visit(fx); return req(fx.tech, `/visits/${v.id}/notes`, { text: "Synthetic: back gate sticks." }); },
  "POST /visits/:id/photos": async (fx) => { const v = await visit(fx); return req(fx.tech, `/visits/${v.id}/photos`, { data: JPEG, thumb: JPEG, tag: "before", item: "walkaround_photo" }); },
  "GET /visits/:id/pricebook": async (fx) => { const v = await visit(fx); await item(); return { as: fx.tech, path: `/visits/${v.id}/pricebook` }; },
  "POST /visits/:id/lines": async (fx) => { const v = await visit(fx); return req(fx.tech, `/visits/${v.id}/lines`, { price_item_id: (await item()).id, qty: 12 }); },
  "POST /visits/:id/complete": async (fx) => {
    const v = await started(fx);
    // two people working: both timers stop
    await scope(() => store.updateRecord("visit", v.id, (x) => ({ ...x, assignee_ids: [fx.tech.id, fx.admin.id], checklist: { ...x.checklist, items: x.checklist.items.map((i) => (i.required ? { ...i, done_at: now(), done_by: fx.tech.id, ...(i.kind === "photo" ? { value: "fl_00000000000000000001" } : {}) } : i)) } }), W()));
    await scope(() => store.createRecord("timer", { visit_id: v.id, job_id: v.job_id, user_ids: [fx.admin.id], start_at: "2026-11-17T14:10:00.000Z" }, W(fx.admin.id)));
    return req(fx.tech, `/visits/${v.id}/complete`, {});
  },
  "POST /visits/:id/no-access": async (fx) => { const v = await visit(fx); return req(fx.tech, `/visits/${v.id}/no-access`, { note: "Gate locked" }); },
  "POST /visits/:id/incident": async (fx) => { const v = await visit(fx); return req(fx.tech, `/visits/${v.id}/incident`, { text: "Synthetic: scuffed siding." }); },
  "POST /clock": async (fx) => {
    // clocking out pauses the person's running timers (three of them)
    for (let i = 0; i < 3; i++) await started(fx);
    await scope(() => store.createRecord("timesheet", { user_id: fx.tech.id, category: "service", start_at: "2026-11-17T13:30:00.000Z", status: "open", notes: [], edits: [] }, W(fx.tech.id)).then(async (r) => store.settledWrite(`ptr/clock/${fx.tech.id}`, { id: r.data.id }, { onlyIfNew: true }).catch(() => {})));
    return req(fx.tech, "/clock", { action: "out" });
  },
  "GET /me/timesheets": async (fx) => { for (let i = 0; i < 6; i++) await sheet(fx, { start_at: `2026-11-1${5 + Math.min(i, 2)}T1${i}:00:00.000Z`, end_at: `2026-11-1${5 + Math.min(i, 2)}T1${i}:30:00.000Z` }); await busyDay(fx); return { as: fx.tech, path: "/me/timesheets" }; },
  "POST /me/timesheets/:id/notes": async (fx) => { const s = await sheet(fx); return req(fx.tech, `/me/timesheets/${s.id}/notes`, { text: "Lunch 12:00-12:30" }); },
  "GET /me/pay": async (fx) => { for (let i = 0; i < 10; i++) await sheet(fx, { start_at: `2026-11-${String(2 + i).padStart(2, "0")}T14:00:00.000Z`, end_at: `2026-11-${String(2 + i).padStart(2, "0")}T23:00:00.000Z` }); return { as: fx.tech, path: "/me/pay" }; },
  "GET /timesheets": async (fx) => { for (let i = 0; i < 6; i++) await sheet(fx); await sheet(fx, { status: "pending_approval", pending: { reason: "queued_mismatch" } }); return { as: fx.owner, path: "/timesheets" }; },
  "GET /timesheets/:id": async (fx) => { const s = await sheet(fx); return { as: fx.owner, path: `/timesheets/${s.id}` }; },
  "PATCH /timesheets/:id": async (fx) => { const s = await sheet(fx); return { as: fx.owner, path: `/timesheets/${s.id}`, ifMatch: await etag("timesheet", s.id), body: { end_at: "2026-11-16T21:30:00.000Z", reason: "Left early" } }; },
  // a heavy week: two shifts a day, every day
  "POST /timesheets/approve": async (fx) => {
    for (let d = 0; d < 7; d++) for (const [a, b] of [["13", "17"], ["18", "22"]]) await sheet(fx, { start_at: `2026-11-${15 + d}T${a}:00:00.000Z`, end_at: `2026-11-${15 + d}T${b}:00:00.000Z` }, fx.spare);
    return { as: fx.owner, path: "/timesheets/approve", body: { user_id: fx.spare.id, week_start: "2026-11-15" } };
  },
  "POST /timesheets/:id/decide": async (fx) => { const s = await sheet(fx, { status: "pending_approval", pending: { reason: "queued_mismatch" } }); return { as: fx.owner, path: `/timesheets/${s.id}/decide`, body: { decision: "approve" } }; },
};
