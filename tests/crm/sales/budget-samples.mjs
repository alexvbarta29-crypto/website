// Budget samples for the sales routes (read by tests/crm/core/budget.test.mjs):
// "METHOD /path" → (fx) → the request. Each sample makes what it needs
// through the store first (synthetic people only).

const store = await import("../../../netlify/lib/crm-store.mjs");
const SEED = await import("../../../netlify/lib/crm/modules/sales/seed.mjs");
const T = await import("../../../netlify/lib/crm/core/templates.mjs");
const E = await import("../../../netlify/lib/crm/modules/sales/enroll.mjs");
const W = { by: "system", origin: "api", actor_kind: "user", requestId: "budget" };
const AUTO = { by: "system:budget", origin: "worker", actor_kind: "automation", requestId: "budget", mode: { system_of_record: "rotor", paused: false } };
const scope = (fn) => store.withStoreScope({ requestId: "budget" }, fn);

let seeded = false;
const seeds = () => scope(async () => {
  if (seeded) return;
  seeded = true;
  await SEED.seedCadences({ write: () => AUTO });
  await T.seedTemplates(AUTO);
  T.clearTemplateSeedCache();
});
let n = 0;
const lead = () => scope(async () => {
  await seeds();
  n += 1;
  return (await store.createRecord("contact", {
    first_name: "Budget", last_name: `Lead${n}`, phones: [{ e164: `+1763555${String(500 + n).padStart(4, "0")}` }], emails: [{ address: `budget.lead${n}@example.com` }],
    lifecycle: "lead", source: { source: "Website quote form" }, consent: { sms_service: { state: "granted" } },
  }, W)).data;
});
const enrolled = async (key = "new_lead", opts = {}) => {
  const c = await lead();
  const id = await scope(() => E.enroll(c.id, key, opts, W));
  return { c, id };
};
const etagOf = (type, id) => scope(async () => (await store.getRecord(type, id)).etag);
const task = async (fx, extra = {}) => scope(async () => (await store.createRecord("task", { title: "Budget task", kind: "todo", priority: "medium", status: "open", assignee_ids: [fx.tech.id], ...extra }, W)).data);
const cadenceId = async (key) => { await seeds(); return SEED.seedCadenceId(key); };
// Signs & flyers: codes with scans and leads (a season's worth: 24 codes, a few leads each)
const SIGNS = await import("../../../netlify/lib/crm/modules/sales/signs.mjs");
let codes = null;
const signCodes = () => scope(async () => {
  if (codes) return codes;
  codes = [];
  for (let i = 0; i < 24; i++) {
    const c = (await store.createRecord("qr_code", { name: `Yard sign ${i + 1}`, kind: i % 3 ? "yard_sign" : "door_hanger", area: "Delano", slug: SIGNS.newSlug(), dest: { kind: "quote" } }, W)).data;
    for (let k = 0; k < 3; k++) await SIGNS.countScan(c.id, k % 2 ? "ios" : "android");
    codes.push(c);
  }
  for (let k = 0; k < 6; k++) await SIGNS.qrLead({ code_id: codes[0].id, contact_id: (await lead()).id });
  return codes;
});

export default {
  "GET /calls/list": async (fx) => { await enrolled(); return { as: fx.owner, path: "/calls/list" }; },
  "GET /calls/summary": (fx) => ({ as: fx.owner, path: "/calls/summary" }),
  "POST /calls": async (fx) => { const { c, id } = await enrolled(); return { as: fx.owner, path: "/calls", body: { contact_id: c.id, enrollment_id: id, outcome: "no_answer", double_dial: true } }; },
  "POST /cadence-steps/:id/:n/sent-by-hand": async (fx) => {
    const { c, id } = await enrolled();
    const { logCall } = await import("../../../netlify/lib/crm/modules/sales/calls.mjs");
    await scope(() => logCall({ contact_id: c.id, enrollment_id: id, outcome: "no_answer" }, { write: () => W, user: null }));
    return { as: fx.owner, path: `/cadence-steps/${id}/1/sent-by-hand`, body: { how: "sms_link" } };
  },
  "POST /cadence-steps/:id/:n/send": async (fx) => { const { id } = await enrolled("estimate_followup", { quote_id: "qt_00000000000000000001" }); return { as: fx.owner, path: `/cadence-steps/${id}/1/send`, body: { body: "Hi Budget, any questions on the estimate?", hand: "copy" } }; },
  "GET /attention": (fx) => ({ as: fx.owner, path: "/attention" }),
  "GET /deals": async (fx) => { await enrolled(); return { as: fx.owner, path: "/deals" }; },
  "GET /deals/:id": async (fx) => { const { id } = await enrolled(); const e = await scope(() => store.getRecord("enrollment", id)); return { as: fx.owner, path: `/deals/${e.data.deal_id}` }; },
  "PATCH /deals/:id": async (fx) => { const { id } = await enrolled(); const e = await scope(() => store.getRecord("enrollment", id)); return { as: fx.owner, path: `/deals/${e.data.deal_id}`, ifMatch: await etagOf("deal", e.data.deal_id), body: { value_cents: 24310, status: "quoted" } }; },
  "POST /deals/:id/lose": async (fx) => { const { id } = await enrolled(); const e = await scope(() => store.getRecord("enrollment", id)); return { as: fx.owner, path: `/deals/${e.data.deal_id}/lose`, body: { reason: "price", note: "Too far." } }; },
  "GET /enrollments": async (fx) => { await enrolled(); return { as: fx.owner, path: "/enrollments?status=active" }; },
  "POST /enrollments": async (fx) => ({ as: fx.owner, path: "/enrollments", body: { contact_id: (await lead()).id, cadence_key: "new_lead" } }),
  "POST /enrollments/bulk-resume": async (fx) => {
    const ids = [];
    for (let i = 0; i < 15; i++) { const { id } = await enrolled(); await scope(() => E.pauseEnrollment(id, "manual", W)); ids.push(id); }
    return { as: fx.owner, path: "/enrollments/bulk-resume", body: { ids } };
  },
  "GET /enrollments/:id": async (fx) => ({ as: fx.owner, path: `/enrollments/${(await enrolled()).id}` }),
  "POST /enrollments/:id/pause": async (fx) => ({ as: fx.owner, path: `/enrollments/${(await enrolled()).id}/pause`, body: {} }),
  "POST /enrollments/:id/resume": async (fx) => { const { id } = await enrolled(); await scope(() => E.pauseEnrollment(id, "manual", W)); return { as: fx.owner, path: `/enrollments/${id}/resume`, body: {} }; },
  "POST /enrollments/:id/stop": async (fx) => ({ as: fx.owner, path: `/enrollments/${(await enrolled()).id}/stop`, body: {} }),
  "POST /enrollments/:id/advance": async (fx) => ({ as: fx.owner, path: `/enrollments/${(await enrolled()).id}/advance`, body: {} }),
  "POST /enrollments/:id/skip": async (fx) => ({ as: fx.owner, path: `/enrollments/${(await enrolled()).id}/skip`, body: {} }),
  "GET /cadences": async (fx) => { await seeds(); return { as: fx.owner, path: "/cadences" }; },
  "GET /cadences/:id": async (fx) => ({ as: fx.owner, path: `/cadences/${await cadenceId("new_lead")}` }),
  "POST /cadences": async (fx) => { await seeds(); return { as: fx.owner, path: "/cadences", body: { key: "budget_cadence", name: "Budget cadence", entry: { on: "manual" }, steps: [{ day: 1, window: { start: "09:00", end: "10:00" }, action: "call", label: "Call" }] } }; },
  "PATCH /cadences/:id": async (fx) => { const id = await cadenceId("estimate_followup"); return { as: fx.owner, path: `/cadences/${id}`, ifMatch: await etagOf("cadence", id), body: { name: "Estimate sent - not scheduled (budget)" } }; },
  "GET /tasks": async (fx) => { await task(fx); return { as: fx.owner, path: "/tasks?assignee=me" }; },
  "GET /tasks/mine": async (fx) => { await task(fx); return { as: fx.tech, path: "/tasks/mine" }; },
  "GET /tasks/:id": async (fx) => ({ as: fx.tech, path: `/tasks/${(await task(fx)).id}` }),
  "POST /tasks": async (fx) => ({ as: fx.owner, path: "/tasks", body: { title: "Budget new task", kind: "call", contact_id: (await lead()).id, assignee_ids: [fx.owner.id] } }),
  "PATCH /tasks/:id": async (fx) => { const t = await task(fx); return { as: fx.owner, path: `/tasks/${t.id}`, ifMatch: await etagOf("task", t.id), body: { priority: "high", notes: "Budget." } }; },
  "POST /tasks/:id/done": async (fx) => ({ as: fx.tech, path: `/tasks/${(await task(fx)).id}/done`, body: {} }),
  "POST /incidents": (fx) => ({ as: fx.tech, path: "/incidents", body: { title: "Cracked storm window", notes: "Seen on arrival." } }),
  "GET /sales/contacts/:id": async (fx) => { const { c } = await enrolled(); await task(fx, { contact_id: c.id }); return { as: fx.owner, path: `/sales/contacts/${c.id}` }; },
  "GET /qr-codes": async (fx) => { await signCodes(); return { as: fx.owner, path: "/qr-codes" }; },
  "POST /qr-codes": (fx) => ({ as: fx.owner, path: "/qr-codes", body: { client_id: "00000000-0000-4000-8000-000000700001", name: "Door hanger, Nov", kind: "door_hanger", area: "Mound", placed_on: "2026-11-10" } }),
  "GET /qr-codes/:id": async (fx) => ({ as: fx.owner, path: `/qr-codes/${(await signCodes())[0].id}` }),
  "PATCH /qr-codes/:id": async (fx) => { const c = (await signCodes())[1]; return { as: fx.owner, path: `/qr-codes/${c.id}`, ifMatch: await etagOf("qr_code", c.id), body: { area: "Delano East", dest: { kind: "page", path: "/services/gutter-cleaning.html" } } }; },
  "POST /qr-codes/:id/archive": async (fx) => ({ as: fx.owner, path: `/qr-codes/${(await signCodes())[2].id}/archive`, body: {} }),
  "POST /qr-codes/:id/restore": async (fx) => ({ as: fx.owner, path: `/qr-codes/${(await signCodes())[2].id}/restore`, body: {} }),
};
