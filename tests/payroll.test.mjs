// /payroll — crew pay sheets. Rotor is stubbed; nothing leaves the machine.
import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";

process.env.PAYROLL_PASSWORD = "test-password";
process.env.ROTOR_PAYROLL_API_KEY = "rotor_test_key";
const { derive } = await import("../netlify/lib/payroll-auth.mjs");
const { buildPayroll, readRates, readOwners, offsetFor } = await import("../netlify/lib/payroll-rotor.mjs");
const payroll = (await import("../netlify/functions/payroll.mjs")).default;
const cookie = "barta_payroll=" + derive("test-password");

const realFetch = globalThis.fetch;
let calls;
function rotor(routes) {
  calls = [];
  globalThis.fetch = async (url, init) => {
    const u = String(url);
    calls.push({ url: u, headers: init && init.headers });
    for (const [part, reply] of routes) if (u.includes(part)) return reply instanceof Response ? reply : Response.json(reply);
    throw new Error("unexpected " + u);
  };
}
beforeEach(() => { delete process.env.PAYROLL_RATES; delete process.env.PAYROLL_DEFAULT_RATE; delete process.env.PAYROLL_OWNERS; });
afterEach(() => { globalThis.fetch = realFetch; });

const req = (path, opts = {}) => new Request("https://www.bartawindowwashing.com" + path, opts);

test("pay per shift is exact clock time × rate, rounded per shift (matches Rotor's paid line: $77.19)", () => {
  const people = buildPayroll({
    timesheets: [{ id: 8000, user: { user_id: "g", name: "Gustov Huotari" }, start: "2026-09-29T12:42:43.504Z", end: "2026-09-29T16:34:17.428Z", duration_minutes: 231 }],
    rates: readRates({}),
  });
  assert.equal(people[0].shifts[0].amount_cents, 7719);
  assert.equal(people[0].shifts[0].rate_cents, 2000);
});

test("tips are split evenly between the job's technicians, dated to the service date", () => {
  const people = buildPayroll({
    jobs: [{
      id: "j1", service_date: "2026-09-29T13:00:00Z", customer: { first_name: "Whitney", last_name: "Schroeder" },
      technicians: [{ user_id: "a", name: "Alex Barta" }, { user_id: "g", name: "Gustov Huotari" }],
      payments: [{ status: "succeeded", amount: 550, tip: 25 }, { status: "failed", amount: 100, tip: 10 }],
    }],
    owners: readOwners({}),
  });
  const g = people.find((p) => p.name === "Gustov Huotari");
  assert.deepEqual(g.tips[0], { job_id: "j1", customer: "Whitney Schroeder", date: "2026-09-29T13:00:00Z", tip_cents: 2500, split: 2, share_cents: 1250 });
  assert.equal(people.find((p) => p.name === "Alex Barta").owner, true);
  assert.equal(g.owner, false);
});

test("rates come from PAYROLL_DEFAULT_RATE and per-person PAYROLL_RATES", () => {
  const rates = readRates({ PAYROLL_DEFAULT_RATE: "18", PAYROLL_RATES: '{"Bennett Halonen": 22.5}' });
  const people = buildPayroll({
    timesheets: [
      { id: 1, user: { user_id: "b", name: "Bennett Halonen" }, start: "2026-10-20T13:00:00Z", end: "2026-10-20T15:00:00Z" },
      { id: 2, user: { user_id: "g", name: "Gustov Huotari" }, start: "2026-10-20T13:00:00Z", end: "2026-10-20T15:00:00Z" },
    ],
    rates,
  });
  assert.equal(people.find((p) => p.name === "Bennett Halonen").shifts[0].amount_cents, 4500);
  assert.equal(people.find((p) => p.name === "Gustov Huotari").shifts[0].amount_cents, 3600);
});

test("pay periods are asked of Rotor in Central time", () => {
  assert.equal(offsetFor("2026-10-19"), "-05:00");
  assert.equal(offsetFor("2026-12-01"), "-06:00");
});

test("signed out: /payroll shows the sign-in page and /payroll/data refuses", async () => {
  const page = await payroll(req("/payroll"));
  assert.equal(page.status, 200);
  assert.match(await page.text(), /Enter the password/);
  assert.equal(page.headers.get("x-robots-tag"), "noindex, nofollow");
  const data = await payroll(req("/payroll/data?start=2026-10-19&end=2026-10-25"));
  assert.equal(data.status, 401);
});

test("the right password sets the cookie; the wrong one doesn't", async () => {
  const bad = await payroll(req("/payroll", { method: "POST", body: new URLSearchParams({ password: "nope" }) }));
  assert.equal(bad.status, 401);
  const ok = await payroll(req("/payroll", { method: "POST", body: new URLSearchParams({ password: "test-password" }) }));
  assert.equal(ok.status, 303);
  assert.match(ok.headers.get("set-cookie"), /^barta_payroll=[0-9a-f]{64}; Path=\/payroll; .*HttpOnly; Secure/);
  const page = await payroll(req("/payroll", { headers: { cookie } }));
  assert.match(await page.text(), /Payroll Sheets/);
});

test("signed in: /payroll/data reads timesheets and serviced jobs with the payroll key", async () => {
  rotor([
    ["/open-api/timesheets", { data: [{ id: 9151, user: { user_id: "g", name: "Gustov Huotari" }, start: "2026-10-19T12:39:33.383Z", end: "2026-10-20T01:39:41.36Z", duration_minutes: 780 }], pagination: { has_more: false } }],
    ["/open-api/serviced-jobs", { data: [], pagination: { has_more: false } }],
  ]);
  const res = await payroll(req("/payroll/data?start=2026-10-19&end=2026-10-25", { headers: { cookie } }));
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.people[0].shifts[0].amount_cents, 26004);
  const ts = calls.find((c) => c.url.includes("/timesheets"));
  assert.equal(ts.headers["x-api-key"], "rotor_test_key");
  assert.match(ts.url, /start_date=2026-10-19T00%3A00%3A00-05%3A00/);
});

test("a Rotor key without the right permissions says so", async () => {
  rotor([["/open-api/", new Response("{}", { status: 403 })]]);
  const res = await payroll(req("/payroll/data?start=2026-10-19&end=2026-10-25", { headers: { cookie } }));
  assert.equal(res.status, 502);
  assert.match((await res.json()).message, /timesheets:read and jobs:read/);
});

test("bad or too-long date ranges are refused", async () => {
  assert.equal((await payroll(req("/payroll/data?start=2026-10-25&end=2026-10-19", { headers: { cookie } }))).status, 400);
  assert.equal((await payroll(req("/payroll/data?start=2026-08-01&end=2026-10-25", { headers: { cookie } }))).status, 400);
});
