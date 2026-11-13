// Budget samples for the map module's routes (read by
// tests/crm/core/budget.test.mjs): "METHOD /path" → (fx) → the request.
// The realistic heavy case: a season of pins (300, over two years), houses
// with map points, areas, the New lead cadence taking Door to Door (so a
// conversion starts a follow-up), and a team of ten sharing positions with
// a day of visits. Synthetic people only.

import { randomUUID } from "node:crypto";
const store = await import("../../../netlify/lib/crm-store.mjs");
const SEED = await import("../../../netlify/lib/crm/modules/sales/seed.mjs");
const WT = await import("../../../netlify/lib/crm/modules/work/timesheets.mjs");
const TEAM = await import("../../../netlify/lib/crm/modules/map/team.mjs");
const OFF = await import("../../../netlify/lib/crm/modules/work/office.mjs");
const W = (by = "system") => ({ by, origin: "api", actor_kind: "user", requestId: "budget" });
const AUTO = { by: "system:budget", origin: "worker", actor_kind: "automation", requestId: "budget" };
const SET = { by: "system", origin: "seed", actor_kind: "user", requestId: "budget" };
const scope = (fn) => store.withStoreScope({ requestId: "budget" }, fn);
const cid = () => randomUUID();

let made = null;
function world(fx) {
  if (made) return made;
  made = scope(async () => {
    const out = { pins: [], territories: [], team: [] };
    // houses with map points
    for (let i = 0; i < 40; i++) {
      const c = (await store.createRecord("contact", { first_name: "Budget", last_name: `Map${i}`, phones: [{ e164: `+1763555${String(5000 + i)}`, sms: true }], lifecycle: i % 4 ? "customer" : "lead", source: { source: "Referral" } }, W())).data;
      await store.createRecord("property", { contact_id: c.id, label: "Home", address: { street1: `${i} Example Ave`, city: "Delano", state: "MN", zip: "55328" }, access: {}, geo: { lat: 45.03 + i / 2000, lng: -93.79 + (i % 7) / 1000, source: "manual" } }, W());
    }
    // a season of pins, some knocked twice
    const who = [fx.owner.id, fx.admin.id];
    for (let i = 0; i < 300; i++) {
      const at = new Date(Date.parse("2026-11-17T15:00:00Z") - (i % 400) * 86400000).toISOString();
      const knocks = [{ at, by: who[i % 2], type_key: "not_home", outcome: "not_home" }, ...(i % 3 ? [] : [{ at: "2026-11-16T15:00:00.000Z", by: who[(i + 1) % 2], type_key: "interested", outcome: "interested" }])];
      out.pins.push((await store.createRecord("pin", { lat: 45.02 + (i % 50) / 2500, lng: -93.8 + Math.floor(i / 50) / 400, type_key: knocks[knocks.length - 1].type_key, outcome: knocks[knocks.length - 1].outcome, knocks, canvasser_id: who[i % 2], address: { street1: `${i} Sample St`, city: "Delano" }, address_source: "typed" }, W(who[i % 2]))).data.id);
    }
    for (let i = 0; i < 6; i++) out.territories.push((await store.createRecord("territory", { name: `Area ${i}`, color: "#2563eb", polygon: [[-93.81 + i / 100, 45.0], [-93.80 + i / 100, 45.0], [-93.80 + i / 100, 45.1], [-93.81 + i / 100, 45.1]], assignee_ids: [fx.owner.id] }, W(fx.owner.id))).data.id);
    // conversions start the New lead follow-up
    await SEED.seedCadences({ write: () => AUTO });
    const cad = (await store.getRecord("cadence", await SEED.seedCadenceId("new_lead"))).data;
    await store.updateRecord("cadence", cad.id, (x) => ({ ...x, entry: { ...x.entry, sources: [...new Set([...(x.entry.sources || []), "Door to Door"])] } }), W());
    // a team of ten sharing, each clocked in with a day of positions and visits
    const people = [fx.tech];
    for (let i = 0; i < 9; i++) people.push({ id: (await store.createRecord("user", { login: `budget.map${i}`, name: `Map Tech${i}`, role: "tech", status: "active", is_technician: true, password: null, session_epoch: 0, grants: [], denies: [] }, W())).data.id });
    await store.putSetting("map", { team_map: { enabled: true, people: people.map((p) => p.id), every_s: 120, retention_days: 30 } }, SET);
    const c = (await store.createRecord("contact", { first_name: "Budget", last_name: "Route", phones: [{ e164: "+17635550990", sms: true }], lifecycle: "customer", source: { source: "Referral" } }, W())).data;
    const [jobId] = await OFF.createJobs([{ contact_id: c.id, kind: "standard", lines: [{ title: "Exterior window cleaning", unit_cents: 29500 }] }], "budget-map-job", "manual", W());
    for (const [n, p] of people.entries()) {
      await WT.clockIn({ id: p.id }, { category: "service", time: { at: "2026-11-17T14:00:00.000Z", trusted: true, source: "server" } }, W(p.id));
      await store.settledWrite(TEAM.dayKey("2026-11-17", p.id), { uid: p.id, day: "2026-11-17", pts: Array.from({ length: TEAM.MAX_TRAIL }, (_, i) => [45 + i / 1e4, -93.8, 1763380000 + i * 60, 10, "i"]) }, { onlyIfNew: true });
      for (let v = 0; v < 3; v++) await OFF.createVisit({ job_id: jobId, date: "2026-11-17", start: `${String(8 + v * 2).padStart(2, "0")}:00`, end: `${String(9 + v * 2).padStart(2, "0")}:00`, assignee_ids: [p.id] }, W(fx.owner.id));
      void n;
    }
    out.team = people;
    return out;
  });
  return made;
}
const pinBody = (extra = {}) => ({ client_id: cid(), lat: 45.0419, lng: -93.7891, type_key: "not_home", ...extra });
const etag = async (type, id) => (await scope(() => store.getRecord(type, id))).etag;

export default {
  "GET /map/knock": async (fx) => { await world(fx); return { as: fx.owner, path: "/map/knock" }; },
  "GET /map/places": async (fx) => { await world(fx); return { as: fx.owner, path: "/map/places" }; },
  "GET /map/pins": async (fx) => { await world(fx); return { as: fx.owner, path: "/map/pins" }; },
  "POST /map/pins": async (fx) => { await world(fx); return { as: fx.owner, path: "/map/pins", body: pinBody({ note: "Budget", address: { street1: "1 Example Ave", city: "Delano" } }) }; },
  "GET /map/pins/:id": async (fx) => { const w = await world(fx); return { as: fx.owner, path: `/map/pins/${w.pins[0]}` }; },
  "PATCH /map/pins/:id": async (fx) => { const w = await world(fx); return { as: fx.owner, path: `/map/pins/${w.pins[1]}`, body: { client_id: cid(), type_key: "booked", knock: true, note: "Budget note", follow_up_on: "2026-11-20" } }; },
  "DELETE /map/pins/:id": async (fx) => { const w = await world(fx); return { as: fx.owner, path: `/map/pins/${w.pins[2]}` }; },
  "POST /map/pins/:id/convert": async (fx) => { const w = await world(fx); return { as: fx.owner, path: `/map/pins/${w.pins[3]}/convert`, body: { client_id: cid(), first_name: "Budget", last_name: "Convert", phone: "763-555-0991", email: "budget.convert@example.com", note: "Wants a quote.", sms_consent: true, address: { street1: "3 Sample St", city: "Delano", state: "MN", zip: "55328" } } }; },
  "GET /map/reverse": async (fx) => ({ as: fx.owner, path: "/map/reverse?lat=45.0419&lng=-93.7891" }),
  "GET /map/report": async (fx) => { await world(fx); return { as: fx.owner, path: "/map/report?from=2025-11-01&to=2026-11-17&group=week" }; },
  "GET /map/territories": async (fx) => { await world(fx); return { as: fx.owner, path: "/map/territories" }; },
  "POST /map/territories": async (fx) => ({ as: fx.owner, path: "/map/territories", body: { name: "Budget area", polygon: [[-93.8, 45.0], [-93.7, 45.0], [-93.7, 45.1]], assignee_ids: [fx.owner.id, fx.admin.id] } }),
  "GET /map/territories/:id": async (fx) => { const w = await world(fx); return { as: fx.owner, path: `/map/territories/${w.territories[0]}` }; },
  "PATCH /map/territories/:id": async (fx) => { const w = await world(fx); return { as: fx.owner, path: `/map/territories/${w.territories[1]}`, ifMatch: await etag("territory", w.territories[1]), body: { name: "Renamed", assignee_ids: [fx.admin.id] } }; },
  "DELETE /map/territories/:id": async (fx) => { const w = await world(fx); return { as: fx.owner, path: `/map/territories/${w.territories[2]}` }; },
  "GET /map/sharing": async (fx) => { await world(fx); return { as: fx.tech, path: "/map/sharing" }; },
  "POST /map/position": async (fx) => { await world(fx); return { as: fx.tech, path: "/map/position", body: { lat: 45.05, lng: -93.79, acc: 9, why: "visit_start" } }; },
  "GET /map/team": async (fx) => { await world(fx); return { as: fx.owner, path: "/map/team" }; },
  "POST /map/team/forget": async (fx) => ({ as: fx.owner, path: "/map/team/forget", body: {} }),
  "GET /map/geocode": async (fx) => ({ as: fx.owner, path: "/map/geocode" }),
  "POST /map/geocode": async (fx) => ({ as: fx.owner, path: "/map/geocode", body: {} }),
};
