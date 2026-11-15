// Budget samples for the service module's routes (read by
// tests/crm/core/budget.test.mjs): a busy Jobs index, a done job, and
// requests (one new, one booked for an assessment). Synthetic people only.
const store = await import("../../../netlify/lib/crm-store.mjs");
const OFF = await import("../../../netlify/lib/crm/modules/work/office.mjs");
const W = (fx) => ({ by: fx.owner.id, origin: "api", actor_kind: "user", requestId: "budget" });
const scope = (fn) => store.withStoreScope({ requestId: "budget" }, fn);
const LINES = [{ title: "Exterior window cleaning", unit_cents: 29500, service_type: "Residential Window Cleaning" }];

let made = null;
async function setup(fx) {
  if (made) return made;
  const w = W(fx);
  made = await scope(async () => {
    const ids = await OFF.createJobs(Array.from({ length: 12 }, () => ({ contact_id: fx.contact.id, kind: "standard", lines: LINES })), "budget-service-jobs", "manual", w);
    for (const [i, id] of ids.slice(0, 8).entries()) await OFF.createVisit({ job_id: id, date: `2026-11-${String(17 + (i % 6)).padStart(2, "0")}`, start: "08:00", end: "10:00", window: { type: "window", minutes: 120 }, assignee_ids: [] }, w);
    const done = (await store.updateRecord("job", ids[11], (j) => ({ ...j, status: "completed", completed_at: "2026-11-16T20:00:00.000Z" }), w)).data;
    const mk = (n, extra = {}) => store.createRecord("request", { contact_id: fx.contact.id, contact_name: "Budget", source: "phone", services: ["Exterior windows"], notes: "", photo_ids: [], status: "new", ...extra }, w).then((r) => r.data);
    const fresh = await mk(1);
    const conv = await mk(2);
    const closing = await mk(3);
    const closed = await mk(4, { status: "closed", closed_reason: "spam", closed_at: "2026-11-16T20:00:00.000Z" });
    const patchme = await store.getRecord("request", (await mk(5)).id);
    const { planType } = await import("../../../netlify/lib/crm/modules/plans/types.mjs");
    const ex = planType.example();
    const plan = (await store.createRecord("plan", { ...ex, contact_id: fx.contact.id, status: "active", pending_reasons: [] }, w)).data;
    const asked = (await store.createRecord("plan", { ...ex, contact_id: fx.contact.id, status: "active", pending_reasons: [], cancel_request: { at: "2026-11-16T20:00:00.000Z", by: fx.owner.id, reason: "price", priority: "normal", status: "open", steps_done: [] } }, w)).data;
    return { done, fresh, conv, closing, closed, patchme, plan, asked };
  });
  return made;
}

export default {
  "GET /jobs/stats": async (fx) => { await setup(fx); return { as: fx.owner, path: "/jobs/stats?tile=next_week" }; },
  "POST /jobs/:id/review-ask": async (fx) => ({ as: fx.owner, path: `/jobs/${(await setup(fx)).done.id}/review-ask`, body: {} }),
  "POST /jobs/:id/tip-ask": async (fx) => ({ as: fx.owner, path: `/jobs/${(await setup(fx)).done.id}/tip-ask`, body: {} }),
  "POST /jobs/:id/callback": async (fx) => ({ as: fx.owner, path: `/jobs/${(await setup(fx)).done.id}/callback`, body: { note: "Streaks" } }),
  "GET /requests": async (fx) => { await setup(fx); return { as: fx.owner, path: "/requests?tile=open" }; },
  "POST /requests": async (fx) => { await setup(fx); return { as: fx.owner, path: "/requests", body: { client_id: "00000000-0000-4000-8000-000000000777", contact_id: fx.contact.id, services: ["Gutters"], notes: "Budget" } }; },
  "GET /requests/contacts/:id": async (fx) => { await setup(fx); return { as: fx.owner, path: `/requests/contacts/${fx.contact.id}` }; },
  "GET /requests/:id": async (fx) => ({ as: fx.owner, path: `/requests/${(await setup(fx)).fresh.id}` }),
  "PATCH /requests/:id": async (fx) => { const m = await setup(fx); return { as: fx.owner, path: `/requests/${m.patchme.data.id}`, ifMatch: m.patchme.etag, body: { notes: "Budget note" } }; },
  "POST /requests/:id/assessment": async (fx) => ({ as: fx.owner, path: `/requests/${(await setup(fx)).fresh.id}/assessment`, body: { date: "2026-11-19", start: "10:00", end: "10:30", user_id: fx.admin.id } }),
  "POST /requests/:id/assessed": async (fx) => ({ as: fx.owner, path: `/requests/${(await setup(fx)).fresh.id}/assessed`, body: {} }),
  "POST /requests/:id/convert": async (fx) => ({ as: fx.owner, path: `/requests/${(await setup(fx)).conv.id}/convert`, body: { to: "job" } }),
  "POST /requests/:id/close": async (fx) => ({ as: fx.owner, path: `/requests/${(await setup(fx)).closing.id}/close`, body: { reason: "no_answer" } }),
  "GET /plans/save": async (fx) => { await setup(fx); return { as: fx.owner, path: "/plans/save" }; },
  "POST /plans/:id/cancel-request": async (fx) => ({ as: fx.admin, path: `/plans/${(await setup(fx)).plan.id}/cancel-request`, body: { reason: "price" } }),
  "PATCH /plans/:id/cancel-request": async (fx) => ({ as: fx.admin, path: `/plans/${(await setup(fx)).asked.id}/cancel-request`, body: { steps_done: ["call"] } }),
  "POST /requests/:id/reopen": async (fx) => ({ as: fx.owner, path: `/requests/${(await setup(fx)).closed.id}/reopen`, body: {} }),
};
