// Budget samples for the expenses routes and the Financials tab's reports
// (read by tests/crm/core/budget.test.mjs). Synthetic data only.
const store = await import("../../../netlify/lib/crm-store.mjs");
const scope = (fn) => store.withStoreScope({ requestId: "budget" }, fn);

let made = null;
async function setup(fx) {
  if (made) return made;
  const w = { by: fx.owner.id, origin: "api", actor_kind: "user", requestId: "budget" };
  made = await scope(async () => {
    const list = [];
    for (let i = 0; i < 30; i++) list.push((await store.createRecord("expense", { date: `2026-11-${String(1 + (i % 16)).padStart(2, "0")}`, amount_cents: 1000 + i, category: i % 2 ? "fuel" : "supplies", vendor: `Vendor ${i}` }, w)).data);
    const one = await store.getRecord("expense", list[0].id);
    const gone = list[1];
    const period = (await store.createRecord("pay_period", { start_on: "2026-09-06", end_on: "2026-09-12", weeks: 1, status: "paid", totals: {}, lines: [] }, w)).data;
    return { one, gone, period };
  });
  return made;
}

export default {
  "GET /expenses": async (fx) => { await setup(fx); return { as: fx.owner, path: "/expenses?from=2026-01-01&to=2026-11-30" }; },
  "POST /expenses": async (fx) => { await setup(fx); return { as: fx.owner, path: "/expenses", body: { client_id: "00000000-0000-4000-8000-000000000888", date: "2026-11-17", amount_cents: 2500, category: "fuel" } }; },
  "GET /expenses/:id": async (fx) => ({ as: fx.owner, path: `/expenses/${(await setup(fx)).one.data.id}` }),
  "PATCH /expenses/:id": async (fx) => { const m = await setup(fx); return { as: fx.owner, path: `/expenses/${m.one.data.id}`, ifMatch: m.one.etag, body: { note: "Budget" } }; },
  "DELETE /expenses/:id": async (fx) => ({ as: fx.owner, path: `/expenses/${(await setup(fx)).gone.id}` }),
  "GET /payments/tips.csv": async (fx) => { await setup(fx); return { as: fx.owner, path: "/payments/tips.csv?month=2026-11" }; },
  "GET /invoices/tax.csv": async (fx) => { await setup(fx); return { as: fx.owner, path: "/invoices/tax.csv?from=2026-01-01&to=2026-11-17" }; },
  "GET /payouts": async (fx) => { await setup(fx); return { as: fx.owner, path: "/payouts" }; },
  "POST /payroll/periods/:id/close": async (fx) => ({ as: fx.owner, path: `/payroll/periods/${(await setup(fx)).period.id}/close`, body: {} }),
};
