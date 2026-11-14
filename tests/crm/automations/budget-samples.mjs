// Budget samples for the automation builder's routes (read by
// tests/crm/core/budget.test.mjs): "METHOD /path" → (fx) → the request.
// The list is sampled with 12 automations, each with 40 runs, over a
// 200-contact list, so it stays inside its budget at Barta's size.

const store = await import("../../../netlify/lib/crm-store.mjs");
const C = await import("../../../netlify/lib/crm/modules/automations/catalog.mjs");
const W = { by: "system", origin: "api", actor_kind: "user", requestId: "budget" };
const scope = (fn) => store.withStoreScope({ requestId: "budget" }, fn);

let made = null;
const flows = () => scope(async () => {
  if (made) return made;
  made = [];
  for (let i = 0; i < 12; i++) {
    const r = C.RECIPES[i % C.RECIPES.length];
    const f = (await store.createRecord("flow", { ...C.cleanFlow(r.flow), name: `${r.label} ${i + 1}` }, W)).data;
    made.push(f);
  }
  for (let k = 0; k < 40; k++) {
    await store.createRecord("flow_run", {
      flow_id: made[0].id, flow_name: made[0].name, status: "done", trigger: { kind: "event", event: "quote.sent" }, subject: { type: "contact", id: "ct_00000000000000000001" },
      started_at: new Date(Date.UTC(2026, 10, 1, 12, k)).toISOString(), plan: made[0].steps, stop: [], steps: made[0].steps.map(() => ({ status: "done" })), step: made[0].steps.length,
    }, W);
  }
  for (let i = 0; i < 200; i++) {
    await store.createRecord("contact", { first_name: "Budget", last_name: `Flow${i}`, phones: [{ e164: `+1763555${String(3000 + i).padStart(4, "0")}` }], lifecycle: "customer", tags: [i % 3 ? "Gutters" : "Lights 2025"], source: { source: i % 2 ? "Referral" : "Meta Ads" } }, W);
  }
  return made;
});
const etag = (id) => scope(async () => (await store.getRecord("flow", id)).etag);
const DRAFT = C.RECIPES[0].flow;

export default {
  "GET /automations/flows": async (fx) => { await flows(); return { as: fx.owner, path: "/automations/flows" }; },
  "POST /automations/flows": (fx) => ({ as: fx.owner, path: "/automations/flows", body: { recipe: "quote_followup" } }),
  "POST /automations/flows/check": (fx) => ({ as: fx.owner, path: "/automations/flows/check", body: { flow: DRAFT } }),
  "POST /automations/flows/test": (fx) => ({ as: fx.owner, path: "/automations/flows/test", body: { flow: C.RECIPES[2].flow, contact_id: fx.contact.id } }),
  "GET /automations/flows/:id": async (fx) => ({ as: fx.owner, path: `/automations/flows/${(await flows())[0].id}` }),
  "PATCH /automations/flows/:id": async (fx) => { const f = (await flows())[1]; return { as: fx.owner, path: `/automations/flows/${f.id}`, ifMatch: await etag(f.id), body: { name: "Renamed" } }; },
  "POST /automations/flows/:id/pause": async (fx) => ({ as: fx.owner, path: `/automations/flows/${(await flows())[2].id}/pause`, body: {} }),
  "POST /automations/flows/:id/resume": async (fx) => ({ as: fx.owner, path: `/automations/flows/${(await flows())[3].id}/resume`, body: {} }),
  "POST /automations/flows/:id/duplicate": async (fx) => ({ as: fx.owner, path: `/automations/flows/${(await flows())[4].id}/duplicate`, body: {} }),
  "DELETE /automations/flows/:id": async (fx) => ({ as: fx.owner, path: `/automations/flows/${(await flows())[11].id}` }),
  "GET /automations/flows/:id/runs": async (fx) => ({ as: fx.owner, path: `/automations/flows/${(await flows())[0].id}/runs` }),
  "GET /automations/flows/:id/runs/:run": async (fx) => {
    const f = (await flows())[0];
    const run = await scope(async () => (await store.listRel("flow-runs", f.id, { limit: 1 }))[0].id);
    return { as: fx.owner, path: `/automations/flows/${f.id}/runs/${run}` };
  },
};
