// Reports (design §5.9, §11.4 M7b): a fixture day's rollup equals hand
// totals; simulated (dry-run) payments and test contacts are excluded; the
// Sales report's sold_by breakdown; compare to the period before; CSV;
// money owed by age; dashboard-raw fed to buildSnapshot() renders, and
// /dashboard follows cfg/dashboard.source; only the owners and the office
// read reports. Synthetic data only.
import { test } from "node:test";
import assert from "node:assert/strict";
import { crmTest, officeCookie } from "../../helpers/crm-http.mjs";

const store = await import("../../../netlify/lib/crm-store.mjs");
const R = await import("../../../netlify/lib/crm/core/registry.mjs");
const S = await import("../../../netlify/lib/crm/core/services.mjs");
const RU = await import("../../../netlify/lib/crm/modules/reports/rollup.mjs");
const { buildSnapshot } = await import("../../../build/office_dashboard.mjs");
const { dashboardHtml } = await import("../../../netlify/lib/dashboard-page.mjs");
const dash = await import("../../../netlify/functions/dashboard.mjs");
const NOW = "2026-11-17T15:00:00.000Z";
const at = (day, h) => new Date(`${day}T${String(h).padStart(2, "0")}:00:00-06:00`).toISOString();
const line = (cents, extra = {}) => [{ id: "ln_1", title: "Exterior window cleaning", qty_milli: 1000, unit_cents: cents, scope: { type: "all" }, ...extra }];
const planQuote = (annual) => ({ options: [{ id: "op_p", name: "Quarterly", kind: "plan", recommended: true, lines: [], discounts: [], plan: { catalog_key: "quarterly", frequency: { interval: "month", count: 3 }, visits_per_year: 4 }, totals: { first_cents: 19500, per_visit_cents: [19500], term_cents: annual, annual_cents: annual } }], selected_option_id: "op_p" });

async function world() {
  const t = await crmTest({ now: NOW });
  const olive = await t.user("owner", { extra: { name: "Olive Owner", first_name: "Olive" } });
  const ada = await t.user("admin", { extra: { name: "Ada Admin", first_name: "Ada" } });
  const theo = await t.user("tech", { extra: { name: "Theo Tech", first_name: "Theo" } });
  const W = { by: olive.id, origin: "api", actor_kind: "user", requestId: "t" };
  const scope = (fn) => store.withStoreScope({ requestId: "t" }, fn);
  const mk = (type, data) => scope(() => store.createRecord(type, { ...R.getType(type).example(), ...data }, W)).then((r) => r.data);
  const contact = (n, extra = {}) => mk("contact", { first_name: "Pat", last_name: `Sample${n}`, lifecycle: "lead", source: { source: "Website" }, ...extra });
  return { t, olive, ada, theo, mk, contact, scope };
}

// The fixture day, Tuesday Nov 17 2026 (today) (hand totals below):
//   payments  $295 card + $20 tip; $500 check; a refund of $50; a simulated $999 card (never counts);
//             a test contact's $77 cash (never counts)
//   jobs      one billable $295 job (Theo and Olive), one touch-up (a callback), one non-billable
//   visits    two completed, one cancelled; invoices issued: $295 and $500
//   quotes    one sent ($295), one approved by Olive (a $780 plan), one declined
//   leads     two new contacts (Website, Referral) and the test contact
//   time      Theo 6 h of service
async function fixtureDay(w) {
  const { mk, contact, olive, theo } = w;
  const a = await contact(1, { created_at: at("2026-11-17", 9), lifecycle: "customer" });
  const b = await contact(2, { created_at: at("2026-11-17", 10), source: { source: "Referral" } });
  const testc = await contact(3, { created_at: at("2026-11-17", 11), flags: { test: true } });
  const pay = (data) => mk("payment", { contact_id: a.id, kind: "payment", status: "succeeded", received_on: "2026-11-17", tip_split: [], ...data });
  await pay({ method: "card", amount_cents: 29500, tip_cents: 2000, tip_split: [{ user_id: theo.id, cents: 2000 }] });
  await pay({ method: "check", amount_cents: 50000, tip_cents: 0 });
  await pay({ kind: "refund", method: "card", amount_cents: 5000, tip_cents: 0 });
  await pay({ method: "card", amount_cents: 99900, tip_cents: 0, simulated: true });
  await pay({ contact_id: testc.id, method: "cash", amount_cents: 7700, tip_cents: 0 });
  await pay({ method: "card", amount_cents: 12300, tip_cents: 0, received_on: "2026-11-16" });          // the day before
  await mk("job", { number: 701, contact_id: a.id, status: "completed", completed_at: at("2026-11-17", 14), assignee_ids: [theo.id, olive.id], lines: line(29500), service_types: ["Residential Window Cleaning"] });
  await mk("job", { number: 702, kind: "touch_up", contact_id: a.id, status: "completed", completed_at: at("2026-11-17", 15), assignee_ids: [theo.id], billable: false, lines: [] });
  await mk("job", { number: 703, contact_id: a.id, status: "completed", completed_at: at("2026-11-17", 16), assignee_ids: [theo.id], billable: false, lines: line(1000) });
  for (const st of ["completed", "completed", "cancelled"]) await mk("visit", { job_id: "jb_0000000000000000000a", contact_id: a.id, date: "2026-11-17", status: st, assignee_ids: [theo.id] });
  const inv = (cents) => [{ id: "l1", kind: "service", description: "Exterior window cleaning", qty_milli: 1000, unit_cents: cents }];
  await mk("invoice", { contact_id: a.id, status: "open", issued_on: "2026-11-17", lines: inv(29500), due_on: "2026-11-01" });
  await mk("invoice", { contact_id: a.id, status: "open", issued_on: "2026-11-17", lines: inv(50000), due_on: "2026-11-30", number: "SINV-0002", n: 2 });
  await mk("quote", { contact_id: a.id, status: "sent", sent_at: at("2026-11-17", 9) });
  await mk("quote", { contact_id: a.id, status: "approved", sold_by: olive.id, ...planQuote(78000) });
  await mk("quote", { contact_id: b.id, status: "declined", sold_by: olive.id, declined_at: at("2026-11-17", 12) });
  await mk("timesheet", { user_id: theo.id, category: "service", start_at: at("2026-11-17", 8), end_at: at("2026-11-17", 14), status: "approved", notes: [], edits: [] });
  return { a, b, testc };
}

test("a fixture day's rollup equals the hand totals; simulated payments and test contacts never count", async () => {
  const w = await world();
  const { t, scope, theo, olive } = w;
  try {
    await fixtureDay(w);
    const [d] = await scope(() => RU.daysIn("2026-11-17", "2026-11-17"));
    // $295 + $20 tip + $500 − $50 refund
    assert.equal(d.revenue_cents, 29500 + 2000 + 50000 - 5000);
    assert.deepEqual([d.payments, d.refunds_cents, d.tips_cents], [2, 5000, 2000]);
    assert.deepEqual(d.payments_by_method, { card: 31500, check: 50000 });
    assert.equal(d.work_completed_cents, 29500, "billable jobs only");
    assert.deepEqual([d.jobs_completed, d.billable_jobs, d.callbacks], [2, 1, 1]);
    assert.equal(d.visits_completed, 2);
    assert.deepEqual([d.invoices_issued, d.invoices_issued_cents], [2, 79500]);
    assert.deepEqual([d.quotes_sent, d.quotes_won, d.quotes_won_cents, d.quotes_lost], [1, 1, 78000, 1]);
    assert.equal(d.sold_by[olive.id].won, 1);
    assert.deepEqual(d.leads_new, { Website: 1, Referral: 1 }, "the test contact isn't a lead");
    assert.deepEqual(d.customers_new, { Website: 1 });
    assert.equal(d.tech[theo.id].minutes, 360);
    assert.equal(d.tech[theo.id].job_value_cents + d.tech[olive.id].job_value_cents, 29500, "split between the crew, exactly");
    assert.equal(d.tech[theo.id].callbacks, 1);
    const [before] = await scope(() => RU.daysIn("2026-11-16", "2026-11-16"));
    assert.equal(before.revenue_cents, 12300);
    // the month is kept, and served from the copy while fresh
    assert.ok(t.stores.data.keys("ix/reports/daily/").includes("ix/reports/daily/2026-11"));
  } finally { t.done(); }
});

test("the reports: revenue, sales by person and source, leads, plans, jobs, team, owed; compare; CSV; payroll", async () => {
  const w = await world();
  const { t, olive, ada, theo } = w;
  try {
    await fixtureDay(w);
    const rev = await t.api("/reports/revenue?from=2026-11-17&to=2026-11-17", { as: olive });
    assert.equal(rev.status, 200, JSON.stringify(rev.body));
    const tile = (r, k) => r.body.data.tiles.find((x) => x.key === k);
    assert.deepEqual([tile(rev, "collected").value, tile(rev, "collected").prev], [76500, 12300], "compared with the day before");
    assert.equal(tile(rev, "invoiced").value, 79500);
    assert.equal(rev.body.data.group, "day");
    const sales = (await t.api("/reports/sales?from=2026-11-01&to=2026-11-17", { as: ada })).body.data;
    const person = sales.tables.find((x) => x.key === "by_person").rows.find((r) => r[0] === "Olive Owner");
    assert.deepEqual(person.slice(0, 5), ["Olive Owner", 0, 1, 78000, 50]);
    assert.equal(sales.tiles.find((x) => x.key === "close").value, 50);
    assert.equal(sales.tiles.find((x) => x.key === "avg").value, 29500);
    const leads = (await t.api("/reports/leads?from=2026-11-17&to=2026-11-17", { as: olive })).body.data;
    assert.equal(leads.tiles.find((x) => x.key === "leads").value, 2);
    const jobs = (await t.api("/reports/ops?from=2026-11-17&to=2026-11-17", { as: olive })).body.data;
    assert.equal(jobs.name, "jobs");
    assert.equal(jobs.tiles.find((x) => x.key === "callbacks").value, 50, "one touch-up for one billable job");
    const team = (await t.api("/reports/team?from=2026-11-17&to=2026-11-17", { as: olive })).body.data;
    const th = team.tables[0].rows.find((r) => r[0] === "Theo Tech");
    assert.equal(th[1], 6);
    const owed = (await t.api("/reports/owed", { as: olive })).body.data;
    assert.equal(owed.tiles.find((x) => x.key === "open").value, 79500);
    assert.equal(owed.tiles.find((x) => x.key === "overdue").value, 29500);
    assert.equal(owed.tables.find((x) => x.key === "aging").rows[1][2], 29500, "16 days late");
    const plans = (await t.api("/reports/plans?from=2026-11-01&to=2026-11-17", { as: olive }));
    assert.equal(plans.status, 200);
    const csv = await t.api("/reports/sales.csv?from=2026-11-01&to=2026-11-17", { as: olive });
    assert.equal(csv.status, 200);
    assert.match(csv.headers.get("content-type"), /text\/csv/);
    assert.match(csv.text, /Olive Owner,0,1,780\.00,50/);
    const sum = (await t.api("/reports/summary?from=2026-11-17&to=2026-11-17", { as: olive })).body.data;
    assert.ok(sum.tiles.length >= 6);
    assert.equal((await t.api("/reports/payroll?from=2026-11-01&to=2026-11-17", { as: olive })).status, 200);
    // who may read them
    assert.equal((await t.api("/reports/revenue", { as: theo })).status, 403, "a technician never opens a report");
    assert.equal((await t.api("/reports/dashboard-raw", { as: theo })).status, 403);
    assert.equal((await t.api("/reports/nope", { as: olive })).status, 404);
    assert.equal((await t.api("/reports/revenue?from=2025-01-01&to=2026-11-17", { as: olive })).status, 400, "a year at most");
  } finally { t.done(); }
});

test("dashboard-raw fed to buildSnapshot() renders with the expected tiles, and /dashboard follows cfg/dashboard.source", async () => {
  const w = await world();
  const { t, olive } = w;
  try {
    await fixtureDay(w);
    const r = await t.api("/reports/dashboard-raw?as_of=2026-11-17", { as: olive });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    const raw = r.body.data;
    for (const k of ["payments_by_month", "payments_by_month_prev", "payments_ytd_by_type", "payments_ytd_by_type_prev", "payments_by_week", "leads_by_week", "leads_by_source", "customers_by_source", "invoices_by_status", "jobs_by_status", "visits_by_month", "visits_next_weeks", "plans_created_by_month", "plan_cancellations", "quotes_by_status", "members", "service_plans_active"]) assert.ok(raw[k] !== undefined, k);
    const snap = buildSnapshot(raw);
    assert.equal(snap.as_of, "2026-11-17");
    assert.equal(snap.revenue.this_month, (76500 + 12300) / 100);
    assert.equal(snap.revenue.collected_ytd, (29500 + 2000 + 50000 + 12300) / 100, "the invoice payments, gross");
    assert.equal(snap.revenue.refunds_ytd, 50);
    assert.equal(snap.sales.leads_total, 2);
    assert.deepEqual([snap.sales.quotes.sent, snap.sales.quotes.won, snap.sales.quotes.rejected], [1, 1, 1]);
    assert.equal(snap.ops.owed.amount, 795);
    const html = dashboardHtml(snap);
    assert.match(html, /Revenue|revenue/);
    assert.doesNotMatch(JSON.stringify(raw), /Sample1|example\.com/, "aggregates only: no customer names");
    // /dashboard: Rotor's sealed snapshot by default, the CRM's numbers once the owner switches
    const req = () => new Request("https://www.bartawindowwashing.com/dashboard", { headers: { cookie: officeCookie() } });
    dash.__clearDashboardCache();
    assert.equal(await dash.crmSnapshot(req(), {}), null, "source rotor: the sealed snapshot");
    assert.equal((await t.api("/settings/dashboard", { method: "PUT", as: olive, ifMatch: "new", body: { source: "crm" } })).status, 200);
    const live = await dash.crmSnapshot(req(), {});
    assert.ok(live && live.as_of === "2026-11-17", "built from the CRM");
    const page = await dash.default(req(), {});
    assert.equal(page.status, 200);
    assert.match(await page.text(), /<html/i);
    assert.equal((await t.api("/settings/dashboard", { method: "PUT", as: olive, ifMatch: "new", body: { source: "nope" } })).status >= 400, true);
    dash.__clearDashboardCache();
  } finally { t.done(); }
});

test("the night's rollup keeps the active plans and each new lead's time to first touch (business hours)", async () => {
  const w = await world();
  const { t, scope, mk } = w;
  try {
    const { a } = await fixtureDay(w);
    await mk("plan", { contact_id: a.id, status: "active", sale_value_cents: 78000 });
    // a lead from 4:30 PM Monday first texted 9:15 AM Tuesday: 90 + 75 business minutes
    assert.equal(RU.businessMinutes(at("2026-11-16", 16).replace(":00:00", ":30:00"), new Date(Date.parse(at("2026-11-17", 9)) + 15 * 60000).toISOString()), 90 + 75);
    assert.equal(RU.firstTouchOf("2026-11-16T15:00:00.000Z", { system: { first_sms: { main: "2026-11-16T15:05:00.000Z" }, last_contacted_at: "2026-11-16T20:00:00.000Z" } }), "2026-11-16T15:05:00.000Z");
    const r = await scope(() => RU.rollupSweep({}));
    assert.equal(r.done, true);
    const [d] = await scope(() => RU.daysIn("2026-11-16", "2026-11-16"));
    assert.equal(d.active_plans_eod, 1);
    assert.equal(d.mrr_cents_eod, 6500);
    assert.ok(Array.isArray(d.first_touch_minutes));
    // a rebuild keeps what only the night knew
    await scope(() => RU.rebuild("2026-11-01", "2026-11-30"));
    const [again] = await scope(() => RU.daysIn("2026-11-16", "2026-11-16"));
    assert.equal(again.active_plans_eod, 1);
    const RP = await import("../../../netlify/lib/crm/modules/reports/reports.mjs");
    const series = await scope(() => RP.seriesFor({ metric: "collected", group: "month", keys: ["2026-10", "2026-11"] }));
    assert.deepEqual(series.values, { "2026-10": 0, "2026-11": 76500 + 12300 });
    void t;
  } finally { t.done(); }
});
