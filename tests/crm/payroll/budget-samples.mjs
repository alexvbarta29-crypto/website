// Budget samples for the payroll module's routes (read by
// tests/crm/core/budget.test.mjs): a week with shifts, a finished job two
// people did and a tip, the period over it (worked out, locked, paid, the
// sheet, the CSV) and the scoreboard over a month.
const store = await import("../../../netlify/lib/crm-store.mjs");
const R = await import("../../../netlify/lib/crm/core/registry.mjs");

let made = null;
async function setup(fx) {
  if (made) return made;
  const W = { by: fx.owner.id, origin: "api", actor_kind: "user", requestId: "budget" };
  const mk = (type, data) => store.withStoreScope({ requestId: "budget" }, () => store.createRecord(type, { ...R.getType(type).example(), ...data }, W)).then((r) => r.data);
  const at = (day, h) => new Date(`${day}T${String(h).padStart(2, "0")}:00:00-06:00`).toISOString();
  for (const d of ["2026-11-08", "2026-11-09", "2026-11-10", "2026-11-11", "2026-11-12"]) {
    await mk("timesheet", { user_id: fx.tech.id, category: "service", start_at: at(d, 7), end_at: at(d, 16), status: "approved", notes: [], edits: [] });
  }
  const job = await mk("job", { number: 9001, contact_id: fx.contact.id, status: "completed", completed_at: at("2026-11-12", 15), assignee_ids: [fx.tech.id, fx.owner.id], lines: [{ id: "ln_1", title: "Windows", qty_milli: 1000, unit_cents: 40000, scope: { type: "all" } }] });
  await mk("payment", { contact_id: fx.contact.id, kind: "payment", method: "card", status: "succeeded", amount_cents: 40000, tip_cents: 2000, received_on: "2026-11-12", tip_split: [{ user_id: fx.tech.id, cents: 1000 }, { user_id: fx.owner.id, cents: 1000 }] });
  const open = await mk("pay_period", { start_on: "2026-11-01", end_on: "2026-11-07", weeks: 1, status: "open", totals: {} });
  const week = await mk("pay_period", { start_on: "2026-11-08", end_on: "2026-11-14", weeks: 1, status: "open", totals: {} });
  const locked = await mk("pay_period", { start_on: "2026-10-25", end_on: "2026-10-31", weeks: 1, status: "locked", totals: {}, lines: [] });
  const paidLater = await mk("pay_period", { start_on: "2026-10-18", end_on: "2026-10-24", weeks: 1, status: "locked", totals: {}, lines: [] });
  const line = await mk("pay_line", { user_id: fx.tech.id, period_id: open.id, line_type: "bonus", line_key: "bonus:budget", amount_cents: 1000 });
  made = { job, open, week, locked, paidLater, line };
  return made;
}

export default {
  "GET /payroll/periods": async (fx) => { await setup(fx); return { as: fx.owner, path: "/payroll/periods" }; },
  "POST /payroll/periods": async (fx) => { await setup(fx); return { as: fx.owner, path: "/payroll/periods", body: { start_on: "2026-11-15" } }; },
  "GET /payroll/periods/:id": async (fx) => ({ as: fx.owner, path: `/payroll/periods/${(await setup(fx)).week.id}` }),
  "GET /payroll/periods/:id/sheet/:userId": async (fx) => ({ as: fx.owner, path: `/payroll/periods/${(await setup(fx)).week.id}/sheet/${fx.tech.id}` }),
  "GET /payroll/periods/:id/export.csv": async (fx) => ({ as: fx.owner, path: `/payroll/periods/${(await setup(fx)).week.id}/export.csv` }),
  "POST /payroll/periods/:id/recompute": async (fx) => ({ as: fx.owner, path: `/payroll/periods/${(await setup(fx)).week.id}/recompute`, body: {} }),
  "POST /payroll/periods/:id/lock": async (fx) => ({ as: fx.owner, path: `/payroll/periods/${(await setup(fx)).week.id}/lock`, body: {} }),
  "POST /payroll/periods/:id/unlock": async (fx) => ({ as: fx.owner, path: `/payroll/periods/${(await setup(fx)).locked.id}/unlock`, body: { reason: "budget" } }),
  "POST /payroll/periods/:id/paid": async (fx) => ({ as: fx.owner, path: `/payroll/periods/${(await setup(fx)).paidLater.id}/paid`, body: {} }),
  "POST /payroll/periods/:id/adjustments": async (fx) => ({ as: fx.owner, path: `/payroll/periods/${(await setup(fx)).open.id}/adjustments`, body: { user_id: fx.tech.id, amount_cents: 1500, note: "Gas" } }),
  "POST /payroll/lines/:id/void": async (fx) => ({ as: fx.owner, path: `/payroll/lines/${(await setup(fx)).line.id}/void`, body: {} }),
  "GET /payroll/scoreboard": async (fx) => { await setup(fx); return { as: fx.owner, path: "/payroll/scoreboard?from=2026-10-20&to=2026-11-17" }; },
  "GET /me/pay/sheet": async (fx) => { await setup(fx); return { as: fx.tech, path: "/me/pay/sheet?period=2026-11-10" }; },
};
