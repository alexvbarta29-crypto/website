// /dashboard — the office KPI dashboards and their sealed Rotor snapshot.
import { test } from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";

process.env.OFFICE_PASSWORD = "test-password";
const { seal, open, loadDashboard } = await import("../netlify/lib/office-data.mjs");
const { buildSnapshot } = await import("../build/office_dashboard.mjs");
const { dashboardHtml, setupHtml } = await import("../netlify/lib/dashboard-page.mjs");
const dashboard = (await import("../netlify/functions/dashboard.mjs")).default;
const { derive } = await import("../netlify/lib/lights-auth.mjs");
const { TOOLS } = await import("../netlify/lib/office-page.mjs");
const signedIn = { cookie: "barta_office=" + derive("test-password") };

const { newKeyPair } = await import("../netlify/lib/office-data.mjs");
const keys = newKeyPair();

const RAW = {
  as_of: "2026-11-08",
  payments_by_month: { buckets: [{ key: "2026-10", count: 10, sum_cents: 500000 }, { key: "2026-11", count: 2, sum_cents: 60000 }] },
  payments_by_month_prev: { buckets: [{ key: "2025-10", count: 4, sum_cents: 100000 }, { key: "2025-11", count: 3, sum_cents: 90000 }] },
  payments_ytd_by_type: { buckets: [{ key: "invoice", count: 12, sum_cents: 560000 }, { key: "refund", count: 1, sum_cents: 5000 }] },
  payments_ytd_by_type_prev: { buckets: [{ key: "invoice", count: 7, sum_cents: 190000 }] },
  payments_by_week: { buckets: [{ key: "2026-10-26", count: 5, sum_cents: 200000 }, { key: "2026-11-02", count: 2, sum_cents: 60000 }] },
  leads_by_week: { buckets: [{ key: "2026-10-26", count: 9 }, { key: "2026-11-02", count: 6 }] },
  leads_by_source: { totals: { count: 15 }, buckets: [{ key: "Website quote form", count: 8 }, { key: "Referral program", count: 3 }, { key: "Referral", count: 3 }, { key: "Email", count: 1 }] },
  customers_by_source: { buckets: [{ key: "Returning Customer", count: 400 }, { key: "Website", count: 5 }, { key: "Website quote form", count: 5 }, { key: "Facebook", count: 4 }] },
  invoices_by_status: { buckets: [{ key: "draft", count: 2, sum_cents: 50000 }, { key: "overdue", count: 1, sum_cents: 20000 }, { key: "open", count: 1, sum_cents: 30000 }, { key: "paid", count: 9, sum_cents: 400000 }] },
  jobs_by_status: { buckets: [{ key: "Pending", count: 4 }, { key: "Completed", count: 20 }] },
  visits_by_month: { buckets: [{ key: "2026-10", count: 12 }, { key: "2026-11", count: 3 }] },
  visits_next_weeks: { buckets: [{ key: "2026-11-09", count: 5 }, { key: "2026-11-16", count: 1 }] },
  plans_created_by_month: { buckets: [{ key: "2026-10", count: 3 }] },
  plan_cancellations: { totals: { count: 1 } },
  quotes_by_status: { draft: 2, sent: 10, approved: 1, converted: 8, rejected: 1, modification_requested: 0 },
  members: [{ user_id: "a", name: "Alex Barta" }, { user_id: "j", name: "Jacob Barta" }],
  service_plans_active: { data: [
    { service_frequency: "Semi-Annual", sale_value: 600, sold_by: "a" },
    { service_frequency: "Semi-Annual", sale_value: 700, sold_by: "j" },
    { service_frequency: "Quarterly", sale_value: 1000, sold_by: "a" },
    { service_frequency: "One-Time", sale_value: 295, sold_by: null },
  ] },
};

test("sealed snapshots open only with the matching private key", () => {
  const box = seal({ hello: "world" }, keys.publicKeyPem);
  assert.equal(box.v, 2);
  assert.doesNotMatch(JSON.stringify(box), /world/);
  const env = { OFFICE_DATA_KEY: keys.privateKey };
  assert.deepEqual(loadDashboard(env, box), { ok: true, data: { hello: "world" } });
  assert.deepEqual(loadDashboard({}, box), { ok: false, reason: "no-key" });
  assert.deepEqual(loadDashboard(env, null), { ok: false, reason: "no-data" });
  assert.deepEqual(loadDashboard({ OFFICE_DATA_KEY: newKeyPair().privateKey }, box), { ok: false, reason: "bad-key" });
  // The old, long key style is refused, not crashed on.
  assert.deepEqual(loadDashboard({ OFFICE_DATA_KEY: "x".repeat(3312) }, box), { ok: false, reason: "bad-key" });
});

test("the key fits Netlify's 4KB limit for all function settings with room to spare", () => {
  assert.equal(keys.privateKey.length, 44);
});

test("the committed snapshot is sealed with the committed public key", async () => {
  const { readFileSync } = await import("node:fs");
  const box = (await import("../netlify/data/office-dashboard.sealed.mjs")).default;
  assert.equal(box.v, 2);
  assert.ok(box.epk && box.iv && box.tag && box.data);
  // The plain numbers never appear in the repo.
  assert.doesNotMatch(readFileSync("netlify/data/office-dashboard.sealed.mjs", "utf8"), /collected|revenue|Rotor snapshot as of \d/);
});

test("the snapshot computes the KPIs from Rotor's reports", () => {
  const d = buildSnapshot(RAW);
  assert.equal(d.revenue.collected_ytd, 5600);
  assert.equal(d.revenue.collected_ytd_prev, 1900);
  assert.equal(d.revenue.avg_ticket, 467);
  assert.equal(d.revenue.this_month, 600);
  assert.equal(d.revenue.monthly[1].prev, 900);
  assert.equal(d.sales.close_rate, 45); // 9 won of 20 sent or answered
  assert.deepEqual(d.sales.lead_sources.map((x) => x.label), ["Website", "Referral", "Other"]);
  assert.deepEqual(d.sales.customer_sources[0], { label: "Website", value: 10 });
  assert.ok(!d.sales.customer_sources.some((x) => x.label === "Returning Customer"));
  assert.equal(d.plans.recurring, 3);
  assert.equal(d.plans.recurring_value, 2300);
  assert.equal(d.plans.recurring_share, 75);
  assert.deepEqual(d.plans.by_rep, [{ label: "Alex", value: 2 }, { label: "Jacob", value: 1 }, { label: "Not set", value: 1 }]);
  assert.deepEqual(d.ops.owed, { count: 2, amount: 500 });
  assert.match(d.todo[0].title, /2 invoices still in draft/);
  // No customer names or contact details leave the raw data.
  assert.doesNotMatch(JSON.stringify(d), /@|\+1\d{10}/);
});

test("the dashboard page shows the numbers and every view", () => {
  const html = dashboardHtml(buildSnapshot(RAW));
  for (const v of ["overview", "money", "sales", "plans", "jobs"]) assert.match(html, new RegExp(`data-view="${v}"`));
  assert.match(html, /\$5,600/);
  assert.match(html, /45%/);
  assert.match(html, /noindex, nofollow/);
  const evil = buildSnapshot({ ...RAW, members: [{ user_id: "a", name: "</script><script>alert(1)" }] });
  assert.doesNotMatch(dashboardHtml(evil), /<\/script><script>alert/);
});

test("signed out, /dashboard sends you to the office sign-in", async () => {
  const body = await (await dashboard(new Request("https://x.test/dashboard"))).text();
  assert.match(body, /\/office#dashboard/);
  assert.doesNotMatch(body, /Collected this year/);
});

test("signed in without the key, /dashboard explains the one setup step", async () => {
  delete process.env.OFFICE_DATA_KEY;
  const res = await dashboard(new Request("https://x.test/dashboard", { headers: signedIn }));
  assert.equal(res.headers.get("cache-control"), "private, no-store");
  assert.match(await res.text(), /OFFICE_DATA_KEY/);
  assert.match(setupHtml("bad-key"), /doesn't open/);
});

test("the dashboard views lead the office's one tab row", async () => {
  const { VIEWS } = await import("../netlify/lib/office-page.mjs");
  assert.equal(TOOLS[0].id, "dashboard");
  assert.equal(TOOLS[0].src, "/dashboard?embed=1");
  assert.deepEqual(VIEWS.map((v) => v.id), ["overview", "money", "sales", "plans", "jobs"]);
  // Inside the office, the dashboard hides its own title and tabs and follows #view.
  const html = dashboardHtml(buildSnapshot(RAW));
  assert.match(html, /embed=1/);
  assert.match(html, /hashchange/);
});
