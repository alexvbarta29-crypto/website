// The leaderboard and My performance (the Nov 2026 layout): the service
// reports.leaderboard (Leaderboard, My performance and Home's card) ranks
// the people by what they sold (approved or converted quotes credited to
// their seller; an imported quote's Rotor rep matched by name; anyone else
// is Unassigned), counts the plans set up for their customers (signed, on
// autopay, the yearly money), and for the crew the jobs finished and their
// amount; it reads indexes only; a technician gets no list.
import { test } from "node:test";
import assert from "node:assert/strict";
import { crmTest } from "../../helpers/crm-http.mjs";

const store = await import("../../../netlify/lib/crm-store.mjs");
const R = await import("../../../netlify/lib/crm/core/registry.mjs");
const S = await import("../../../netlify/lib/crm/core/services.mjs");
const L = await import("../../../netlify/lib/crm/modules/reports/leaderboard.mjs");
const NOW = "2026-11-17T15:00:00.000Z";
const line = (cents) => [{ id: "ln_1", title: "Exterior window cleaning", qty_milli: 1000, unit_cents: cents, scope: { type: "all" } }];

async function world() {
  const t = await crmTest({ now: NOW });
  const olive = await t.user("owner", { extra: { name: "Olive Owner", first_name: "Olive" } });
  const ada = await t.user("admin", { extra: { name: "Ada Admin", first_name: "Ada" } });
  const theo = await t.user("tech", { extra: { name: "Theo Tech", first_name: "Theo", is_technician: true } });
  const W = { by: olive.id, origin: "api", actor_kind: "user", requestId: "t" };
  const mk = (type, data) => store.withStoreScope({ requestId: "t" }, () => store.createRecord(type, { ...R.getType(type).example(), ...data }, W)).then((r) => r.data);
  const contact = (n) => store.withStoreScope({ requestId: "t" }, () => store.createRecord("contact", { first_name: "Pat", last_name: `Sample${n}`, lifecycle: "customer", source: { source: "Other" } }, W)).then((r) => r.data);
  return { t, olive, ada, theo, mk, contact };
}
const plan = (amount) => ({ options: [{ id: "op_p", name: "Quarterly", kind: "plan", recommended: true, lines: [], discounts: [], plan: { catalog_key: "quarterly", frequency: { interval: "month", count: 3 }, visits_per_year: 4 }, totals: { first_cents: 19500, per_visit_cents: [19500], term_cents: amount, annual_cents: amount } }], selected_option_id: "op_p" });

test("revenue, sales and the average: sold quotes credited to their seller; an imported rep by name; the rest Unassigned", async () => {
  const { t, olive, ada, mk, contact } = await world();
  try {
    const [a, b, c] = [await contact(1), await contact(2), await contact(3)];
    await mk("quote", { contact_id: a.id, status: "approved", sold_by: olive.id });                    // $295 one-time
    await mk("quote", { contact_id: b.id, status: "approved", sold_by: olive.id, ...plan(78000) });    // a plan: $780 a year
    await mk("quote", { contact_id: c.id, status: "converted", converted_at: NOW, sold_by: "Ada", import: { source: "rotor" } });   // Rotor's rep "Ada"
    await mk("quote", { contact_id: c.id, status: "approved", sold_by: "Somebody Gone" });
    await mk("quote", { contact_id: c.id, status: "sent", sold_by: olive.id });                        // not sold
    const r = await t.api("/leaderboard?metric=revenue&period=month", { as: olive });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    const d = r.body.data;
    assert.deepEqual([d.from, d.to], ["2026-11-01", "2026-11-17"]);
    const by = Object.fromEntries(d.people.map((p) => [p.first_name, p]));
    assert.deepEqual([by.Olive.sales, by.Olive.sold_cents, by.Olive.rank], [2, 29500 + 78000, 1]);
    assert.deepEqual([by.Ada.sales, by.Ada.sold_cents], [1, 29500], "Rotor's rep name finds Ada");
    assert.equal(by.Olive.avg_cents, Math.round((29500 + 78000) / 2));
    assert.equal(d.unassigned.sales, 1, "a seller nobody is: Unassigned");
    assert.equal(d.me, olive.id);
    assert.ok(!d.people.some((p) => p.role === "tech" && !p.is_technician && p.sales === 0 && p.name === "Theo Tech" && false));
    const sales = (await t.api("/leaderboard?metric=sales&period=week", { as: olive })).body.data;
    assert.equal(sales.people[0].value, 2);
    assert.equal((await t.api("/leaderboard?metric=nope", { as: olive })).status, 400);
    assert.equal((await t.api("/leaderboard?metric=sales&period=decade", { as: olive })).status, 400);
    void ada;
  } finally { t.done(); }
});

test("agreements, autopay and % signed: plans set up for the seller's customers", async () => {
  const { t, olive, mk, contact } = await world();
  try {
    const [a, b] = [await contact(1), await contact(2)];
    await mk("quote", { contact_id: a.id, status: "converted", converted_at: NOW, sold_by: olive.id, ...plan(78000) });
    await mk("quote", { contact_id: b.id, status: "approved", sold_by: olive.id, ...plan(39000) });
    await mk("plan", { contact_id: a.id, status: "active", agreement_status: "signed", billing: { autopay: true } });
    await mk("plan", { contact_id: b.id, status: "pending", pending_reasons: ["signature"], agreement_status: "sent", billing: { autopay: false } });
    const d = (await t.api("/leaderboard?metric=agreements&period=year", { as: olive })).body.data;
    const o = d.people.find((p) => p.id === olive.id);
    assert.deepEqual([o.plans, o.signed, o.signed_pct, o.agreements, o.autopay, o.value], [2, 1, 50, 1, 1, 1]);
    assert.ok(o.arr_cents >= 0);
    const ap = (await t.api("/leaderboard?metric=autopay&period=year", { as: olive })).body.data;
    assert.equal(ap.people.find((p) => p.id === olive.id).value, 1);
  } finally { t.done(); }
});

test("Techs: jobs finished in the period and their amount, split between the people on them", async () => {
  const { t, olive, theo, mk, contact } = await world();
  try {
    const c = await contact(1);
    await mk("job", { number: 901, contact_id: c.id, status: "completed", completed_at: NOW, assignee_ids: [theo.id], lines: line(40000) });
    await mk("job", { number: 902, contact_id: c.id, status: "completed", completed_at: NOW, assignee_ids: [theo.id, olive.id], lines: line(20000) });
    await mk("job", { number: 903, contact_id: c.id, status: "scheduled", assignee_ids: [theo.id], lines: line(99900) });
    const d = (await t.api("/leaderboard?metric=techs&period=month", { as: olive })).body.data;
    const th = d.people.find((p) => p.id === theo.id);
    assert.deepEqual([th.jobs, th.done_cents, th.rank], [2, 40000 + 10000, 1]);
    assert.equal(d.people.find((p) => p.id === olive.id).done_cents, 10000);
  } finally { t.done(); }
});

test("the service for Home's card, the period ranges, and a technician gets no list", async () => {
  const { t, olive, theo } = await world();
  try {
    assert.equal(S.has("reports.leaderboard"), true);
    const d = await store.withStoreScope({ requestId: "t" }, () => S.call("reports.leaderboard", { metric: "sales", from: "2026-11-01", to: "2026-11-17" }));
    assert.equal(d.metric, "sales");
    assert.ok(Array.isArray(d.people));
    assert.deepEqual(L.periodRange("week", "2026-11-17"), { from: "2026-11-16", to: "2026-11-17" }, "a week starts on Monday");
    assert.deepEqual(L.periodRange("year", "2026-11-17"), { from: "2026-01-01", to: "2026-11-17" });
    assert.deepEqual(L.periodRange("today", "2026-11-17"), { from: "2026-11-17", to: "2026-11-17" });
    assert.equal((await t.api("/leaderboard", { as: theo })).status, 403, "a technician's own reports never open a list");
    assert.equal((await t.api("/me/performance", { as: theo })).status, 200, "their own performance, yes");
    void olive;
  } finally { t.done(); }
});

test("Home's card asks by board and month: rows with a name, a colour, a count, the money and a short note", async () => {
  const { t, olive, theo, mk, contact } = await world();
  try {
    const [a, b] = [await contact(1), await contact(2)];
    await mk("quote", { contact_id: a.id, status: "approved", sold_by: olive.id, ...plan(78000) });
    await mk("quote", { contact_id: b.id, status: "approved", sold_by: olive.id, ...plan(39000) });
    await mk("quote", { contact_id: b.id, status: "approved", sold_by: olive.id });
    await mk("job", { number: 911, contact_id: a.id, status: "completed", completed_at: NOW, assignee_ids: [theo.id], lines: line(40000) });
    const call = (input) => store.withStoreScope({ requestId: "t" }, () => S.call("reports.leaderboard", input));
    const s = await call({ board: "sales", period: "month", month: "2026-11" });
    assert.deepEqual([s.metric, s.from, s.to], ["revenue", "2026-11-01", "2026-11-17"], "this month: from the 1st to today");
    assert.equal(s.rows.length, 1, "only the people with something to show");
    const o = s.rows[0];
    assert.deepEqual([o.user_id, o.name, o.count, o.value_cents, o.note, o.rank], [olive.id, "Olive Owner", 3, 78000 + 39000 + 29500, "2 plans sold, 1 job sold", 1]);
    assert.ok("color" in o);
    const k = await call({ board: "techs", month: "2026-11" });
    assert.deepEqual([k.rows[0].user_id, k.rows[0].count, k.rows[0].value_cents, k.rows[0].note], [theo.id, 1, 40000, "1 job done"]);
    const oct = await call({ board: "sales", month: "2026-10" });
    assert.deepEqual([oct.from, oct.to, oct.rows.length], ["2026-10-01", "2026-10-31", 0], "a past month: the whole month, nobody sold");
    assert.deepEqual((await call({ board: "sales", from: "2026-11-02", to: "2026-11-03" })).from, "2026-11-02", "from and to win");
    await assert.rejects(() => call({ board: "nope" }), /sales or the techs/);
    await assert.rejects(() => call({ board: "sales", month: "2026-13" }), /month/);
  } finally { t.done(); }
});

test("My performance: what I sold by day from the 1st, jobs and plans, the average job, ARR, the streak and this month's days", async () => {
  const { t, olive, mk, contact } = await world();
  try {
    const [a, b] = [await contact(1), await contact(2)];
    await mk("quote", { contact_id: a.id, status: "approved", sold_by: olive.id });
    await mk("quote", { contact_id: b.id, status: "approved", sold_by: olive.id, ...plan(78000) });
    const d = (await t.api("/me/performance?period=month", { as: olive })).body.data;
    assert.deepEqual([d.from, d.to, d.sold_cents, d.count], ["2026-11-01", "2026-11-17", 29500 + 78000, 2]);
    assert.deepEqual([d.jobs.cents, d.jobs.count, d.plans.cents, d.plans.count, d.avg_cents, d.arr_cents], [29500, 1, 78000, 1, 29500, 78000]);
    assert.equal(d.series.length, 17);
    assert.equal(d.series[16].cents, 29500 + 78000);
    assert.equal(d.series[0].cents, 0);
    assert.deepEqual([d.streak.days, d.streak.with_sale, d.streak.grid.length], [1, 1, 17]);
    const none = (await t.api("/me/performance?period=week", { as: (await t.user("admin")) })).body.data;
    assert.deepEqual([none.sold_cents, none.streak.days, none.avg_cents], [0, 0, null]);
    assert.equal((await t.api("/me/performance?period=today", { as: olive })).status, 400);
  } finally { t.done(); }
});
