// Payroll's and Reports' data for the phone checks (tests/e2e/payroll.spec.mjs,
// reports.spec.mjs): synthetic people only. On top of the shared seed, in
// the e2e server's process: pay rates (Theo $20/h, Tess $22/h, Olive 25% of
// jobs and hourly plus commission), last week's shifts (Theo 45 h, so
// overtime; Tess 20 h), a job they finished together, a card payment with a
// tip split between them, a quote won by Olive, and last week's pay period.

const store = await import("../../netlify/lib/crm-store.mjs");
const R = await import("../../netlify/lib/crm/core/registry.mjs");
const clock = await import("../../netlify/lib/crm/core/clock.mjs");

let made = null;
export function seedPayroll(seeded) {
  if (made) return made;
  made = store.withStoreScope({ requestId: "e2e-payroll" }, async () => {
    const O = { by: seeded.users.owner.id, origin: "api", actor_kind: "user", requestId: "e2e-payroll" };
    const mk = async (type, data) => (await store.createRecord(type, { ...R.getType(type).example(), ...data }, O)).data;
    const pay = (extra) => ({ model: "hourly", hourly_cents: { service: 2000, sales: 0, office: 0 }, commission_pct: { technician: 0, salesman: 0, upsell: 0 }, overtime: true, ...extra });
    const setPay = (id, p) => store.updateRecord("user", id, (u) => ({ ...u, pay: p }), O);
    const { owner, tech, tech2 } = seeded.users;
    await setPay(tech.id, pay());
    await setPay(tech2.id, pay({ hourly_cents: { service: 2200, sales: 0, office: 0 }, commission_pct: { technician: 0, salesman: 0, upsell: 1000 } }));
    await setPay(owner.id, pay({ model: "hourly_plus_commission", hourly_cents: { service: 0, sales: 0, office: 0 }, commission_pct: { technician: 2500, salesman: 0, upsell: 0 } }));
    const today = clock.localDate(clock.now());
    const week = clock.addLocalDays(today, -clock.dowOfDate(today));         // this Sunday
    const last = clock.addLocalDays(week, -7);
    const at = (day, h) => clock.zonedToUtc(day, `${String(h).padStart(2, "0")}:00`).toISOString();
    const shift = (uid, day, h, hours) => mk("timesheet", { user_id: uid, category: "service", start_at: at(day, h), end_at: new Date(Date.parse(at(day, h)) + hours * 3600000).toISOString(), status: "approved", notes: [], edits: [] });
    for (let i = 0; i < 5; i++) await shift(tech.id, clock.addLocalDays(last, i), 7, 9);
    for (let i = 1; i < 5; i++) await shift(tech2.id, clock.addLocalDays(last, i), 8, 5);
    await shift(tech.id, week, 8, 6);
    const c = await mk("contact", { first_name: "Paysheet", last_name: "Sample", lifecycle: "customer", source: { source: "Website" }, phones: [], emails: [] });
    await mk("job", { number: 88001, contact_id: c.id, status: "completed", completed_at: at(clock.addLocalDays(last, 3), 15), assignee_ids: [owner.id, tech.id], lines: [{ id: "ln_1", title: "Exterior window cleaning", qty_milli: 1000, unit_cents: 52500, scope: { type: "all" } }], service_types: ["Residential Window Cleaning"] });
    await mk("job", { number: 88002, contact_id: c.id, status: "completed", completed_at: at(clock.addLocalDays(last, 4), 15), assignee_ids: [tech2.id], lines: [{ id: "ln_a", title: "Gutter cleaning", qty_milli: 1000, unit_cents: 20000, scope: { type: "all" } }, { id: "ln_b", title: "Screens", qty_milli: 1000, unit_cents: 5000, scope: { type: "all" }, upsell_user_id: tech2.id }], service_types: ["Exterior Cleaning"] });
    await mk("payment", { contact_id: c.id, kind: "payment", method: "card", status: "succeeded", amount_cents: 52500, tip_cents: 2500, received_on: clock.addLocalDays(last, 3), tip_split: [{ user_id: tech.id, cents: 1250 }, { user_id: owner.id, cents: 1250 }] });
    await mk("quote", { contact_id: c.id, status: "approved", sold_by: owner.id, sent_at: at(clock.addLocalDays(last, 1), 10) });
    const P = await import("../../netlify/lib/crm/modules/payroll/periods.mjs");
    const lastPeriod = await P.ensurePeriod(last, O);
    const thisPeriod = await P.ensurePeriod(week, O);
    return { last, week, lastPeriod, thisPeriod };
  });
  return made;
}
