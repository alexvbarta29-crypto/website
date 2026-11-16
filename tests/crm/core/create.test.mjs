// The create sheets' kit (core/create.js; Flyra's New Job / Estimate /
// Subscription, Nov 15): the money and date words, the job total (percent
// first, then amounts, never below 0: the server's math), typed prices,
// and every helper escapes what it's given. Synthetic data only.
import { test } from "node:test";
import assert from "node:assert/strict";

const C = await import("../../../crm-app/core/create.js");
const XSS = "</script><script>alert(1)</script>";

test("words: Flyra's date pill, times, typed money", () => {
  assert.equal(C.dayPill("2026-11-16"), "11/16/26");
  assert.equal(C.dayLong("2026-11-16"), "Nov 16, 2026");
  assert.equal(C.timePill("08:00"), "8:00 AM");
  assert.equal(C.timePill(""), "Anytime");
  assert.equal(C.addDays("2026-12-31", 1), "2027-01-01");
  assert.equal(C.fromMin(C.toMin("09:30") + 120), "11:30");
  assert.equal(C.moneyIn("$1,295.5"), 129550);
  assert.equal(C.moneyIn(""), 0);
  assert.equal(C.moneyIn("12.345"), null);
  assert.equal(C.moneyIn("abc"), null);
});

test("the total: lines, then percentages, then amounts; never below 0", () => {
  const lines = [{ unit_cents: 30000, qty_milli: 1000 }, { unit_cents: 500, qty_milli: 2500 }];
  assert.equal(C.totalOf(lines, []), 31250);
  assert.equal(C.totalOf(lines, [{ type: "percentage", value: 1000 }, { type: "fixed", value: 2500 }]), 31250 - 3125 - 2500);
  assert.equal(C.totalOf(lines, [{ type: "fixed", value: 99999999 }]), 0);
  assert.equal(C.lineRowOf({ title: "Screens", unit_cents: 500, qty_milli: 2500 }).sub, "2.5 × $5.00");
  assert.equal(C.lineRowOf({ title: "Typed", unit_cents: 0 }).sub, "Tap to set the price");
});

test("the markup escapes and keeps 44 px controls' hooks", () => {
  const page = String(C.createPage({ title: `New ${XSS}`, body: C.customerCard({ name: `Pat ${XSS}`, phone: "+17635550100" }, { address: { street1: `1 ${XSS} Ave`, city: "Delano", zip: "55328" } }), cta: { label: "Create Job", disabled: true }, form: { id: "wk-new-job" } }));
  assert.ok(!page.includes("<script>alert(1)"));
  assert.match(page, /<form class="cf" novalidate aria-labelledby="cf-title" id="wk-new-job">/);
  assert.match(page, /\(763\) 555-0100/);
  assert.match(page, /Delano, MN 55328/);
  assert.match(page, /data-cf-clear/);
  assert.match(page, /data-cf-prop/);
  assert.match(page, /data-cf-create disabled/);
  assert.match(String(C.customerCard(null)), /Add a customer/);
  assert.equal(String(C.mockupChip(false)), "");
  assert.match(String(C.mockupChip(true)), /href="#\/tools\/lights"/);
  assert.match(String(C.mockupChip(true, { auto: true })), /<button type="button" class="cf-chip" data-cf-mockup-auto>/, "New Quote makes the mockup itself");
  assert.match(String(C.pillDate("date", "2026-11-16", { label: "Starts" })), /<span aria-hidden="true">11\/16\/26<\/span><input type="date" name="date" value="2026-11-16" aria-label="Starts" data-cf-pill="date">/);
  assert.match(String(C.pickRow("Lead source", XSS, { data: { "cf-source": true } })), /data-cf-source=""/);
  assert.ok(!String(C.pickRow("Lead source", XSS)).includes("<script>"));
  assert.match(String(C.segIcons([["service", "Service", "service"], ["billing", "Billing", "card"]], "billing", { name: "p" })), /aria-selected="true" data-cf-seg="p" data-key="billing"/);
});
