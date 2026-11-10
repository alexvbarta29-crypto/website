// M3a acceptance: when a quote expires (design §5.3 expires_on, D30, §11.4
// "earlybird.test.mjs"): expires_on = min(sent + 30 days, the Early Bird
// deadline in effect when an Early Bird discount is on the quote).
import { test } from "node:test";
import assert from "node:assert/strict";
import { setup, sentQuote, oneTime, fakes, pin } from "./fixtures.mjs";

const lights = (extra = []) => oneTime({
  name: "Christmas lights", lines: [{ title: "Christmas Light Installation", qty_milli: 120000, unit_cents: 800, category: "lights", unit: "ft", service_type: "Christmas Lights" }],
  discounts: [{ key: "early_bird", name: "Early Bird", type: "percentage", value: 5000, scope: { type: "all" } }, ...extra],
});

test("expires_on: sent + 30 days, or the Early Bird deadline in effect when that is sooner", async () => {
  const { t, owner } = await setup("2026-11-10T16:00:00Z");
  const f = fakes();
  try {
    const plain = await sentQuote(t, owner, { options: [oneTime()] });
    assert.equal(plain.quote.expires_on, "2026-12-10", "sent Nov 10 + 30 days");
    assert.equal(plain.version.expires_on, "2026-12-10");
    const eb = await sentQuote(t, owner, { options: [lights()] });
    assert.equal(eb.quote.expires_on, "2026-12-01", "the Dec 1 deadline comes first");
    // the API's lights helper agrees on the deadline
    const l = await t.api("/pricing/lights", { method: "POST", as: owner, body: { runs: [{ label: "Roofline", feet: 120 }], early_bird: true, three_year: true } });
    assert.equal(l.body.data.early_bird_deadline, "2026-12-01");
    assert.deepEqual(l.body.data.discounts.map((d) => d.key), ["early_bird", "three_year"]);
    assert.equal(l.body.data.plan.term_months, 36, "3-year contract: a 36-month lights plan");
  } finally { f.restore(); t.done(); }
});

test("before Nov 1 the first deadline is in effect; after Dec 1 there is no Early Bird to offer", async () => {
  const { t, owner } = await setup("2026-10-15T16:00:00Z");
  const f = fakes();
  try {
    const eb = await sentQuote(t, owner, { options: [lights()] });
    assert.equal(eb.quote.expires_on, "2026-11-01");
    pin("2026-12-05T16:00:00Z");
    const late = await t.api("/pricing/lights", { method: "POST", as: owner, body: { runs: [{ label: "Roofline", feet: 120 }], early_bird: true } });
    assert.deepEqual(late.body.data.discounts, []);
    assert.ok(late.body.data.warnings.includes("early_bird_over"));
    // a quote sent after the deadline with an Early Bird line on it: 30 days (the deadline in effect is none)
    const after = await sentQuote(t, owner, { options: [lights()] });
    assert.equal(after.quote.expires_on, "2027-01-04");
  } finally { f.restore(); t.done(); }
});
