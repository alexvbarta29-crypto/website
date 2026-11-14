// Import phase 31 (design §10.2): Rotor's payroll export → one paid
// pay_period per payroll run and a pay_line per paid line, line_key and type
// kept, no customer name in a label; estimated (unpaid) lines skipped; a
// member the team map doesn't know is skipped with a warning. Synthetic rows.
import { test } from "node:test";
import assert from "node:assert/strict";

await import("../../../netlify/lib/crm/modules/index.mjs");
const I = await import("../../../netlify/lib/crm/modules/payroll/import-rotor.mjs");
const T = await import("../../../netlify/lib/crm/modules/payroll/types.mjs");
const ids = await import("../../../netlify/lib/crm/core/ids.mjs");

const U = "us_0000000000000000000a";
const row = (extra) => ({
  id: "11111111-aaaa-4bbb-8ccc-000000000001", user_id: "member-1", line_type: "technician_commission", line_key: "technician:member-1:53963-job-1",
  line_label: "Pat Sample #0000516", line_detail: "Job #0000516", event_at: "2026-09-29T13:00:00+00:00", basis_amount_cents: 52500, amount_cents: 13125,
  rate_percent: 25, hours: null, rate_cents_per_hour: null, status: "paid", paid_at: "2026-10-01T01:59:35.907+00:00", paid_by_user_id: "member-1", job_id: "job-1", timesheet_id: null, ...extra,
});
const ctx = () => ({ users: new Map([["member-1", U]]), lookup: async () => null, prepared: null });

test("a paid run becomes one paid period; each paid line a pay_line with Rotor's key and type, never the customer's name", async () => {
  const rows = [row(), row({ id: "11111111-aaaa-4bbb-8ccc-000000000002", line_type: "hourly", line_key: "hourly:77:2026-09-29T12:42:00.000Z:2026-09-29T16:34:00.000Z", line_detail: "Sep 29, 7:42 AM - Sep 29, 11:34 AM", hours: 3.8594, rate_cents_per_hour: 2000, amount_cents: 7719, rate_percent: null, basis_amount_cents: null, timesheet_id: 77 })];
  const c = ctx();
  c.prepared = await I.preparePayroll(rows, c);
  const runs = Object.values(c.prepared.runs);
  assert.equal(runs.length, 1);
  assert.equal(runs[0].totals[U].total_cents, 13125 + 7719);
  const phase = I.payrollPhase;
  const out = await phase.map(phase.normalize(rows[0]), c);
  const [period, line] = out.records;
  assert.equal(period.type, "pay_period");
  assert.deepEqual([period.data.start_on, period.data.end_on, period.data.status], ["2026-09-27", "2026-10-03", "paid"]);
  assert.match(period.source, /^payroll:run-/);
  assert.equal(line.data.line_type, "technician_commission");
  assert.equal(line.data.line_key, "technician:member-1:53963-job-1");
  assert.equal(line.data.label, "Job #0000516");
  assert.doesNotMatch(JSON.stringify(out), /Pat Sample/);
  assert.deepEqual([line.data.amount_cents, line.data.rate_bp, line.data.status], [13125, 2500, "paid"]);
  assert.equal(line.data.id, ids.idForRotor("pay_line", rows[0].id));
  assert.equal(out.pointers[0].kind, "rotor/payline");
  // the records validate as the store would
  T.periodType.validate({ ...period.data }, { op: "create" });
  T.lineType.validate({ ...line.data }, { op: "create" });
  const second = await phase.map(phase.normalize(rows[1]), c);
  assert.equal(second.records[0].data.id, period.data.id, "the same run, the same period");
});

test("estimated lines and unknown members are skipped; a broken row is refused", async () => {
  const phase = I.payrollPhase;
  const est = await phase.map(phase.normalize(row({ status: "", line_type: undefined, estimated_amount_cents: 21533, paid_at: null })), ctx());
  assert.deepEqual(est.warnings, ["payroll_not_paid_skipped"]);
  const who = await phase.map(phase.normalize(row({ user_id: "member-9" })), ctx());
  assert.deepEqual(who.warnings, ["payroll_user_unknown"]);
  assert.throws(() => phase.normalize({ id: "../x" }), /id/);
  assert.throws(() => phase.normalize("nope"));
});
