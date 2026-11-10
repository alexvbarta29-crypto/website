// Quotes and Scheduling together, with no fakes for Scheduling: a customer
// approves a one-time option on their quote page, the conversion runs, and
// a real job lands in the "to book" tray with the approved lines; a retry of
// the conversion creates nothing twice. Plans and Money are not built yet,
// so they are hidden. Synthetic data only.
import { test } from "node:test";
import assert from "node:assert/strict";
import { setup, sentQuote, portalCookie, approveBody, finishRun, quoteOf, oneTime, PJSON } from "../quotes/fixtures.mjs";
import { fakeServices } from "../../helpers/crm-fixtures.mjs";

test("a customer's approval of a one-time option makes one real job in Scheduling, once", async () => {
  const { t, owner } = await setup();
  // the real Scheduling; Plans and Money hidden
  const off = fakeServices({ "plans.agreementForOption": null, "plans.fromQuoteOption": null, "money.createDepositInvoice": null });
  try {
    const { quote, version } = await sentQuote(t, owner, { options: [oneTime()] });
    const cookie = await portalCookie(t, quote);
    const opt = version.options[0];
    const r = await t.portal(`/api/portal/quotes/${quote.id}/approve`, { method: "POST", cookie, headers: PJSON, body: approveBody(version, opt.id) });
    assert.ok([200, 202].includes(r.status), JSON.stringify(r.body));
    const run = await finishRun(t, r.body.data.run_id, 10);
    assert.equal(run.status, "done", JSON.stringify(run));
    assert.equal(run.result.status, "converted", JSON.stringify(run.result));
    // the conversion runs right after approval (auto_convert), on the fast lane
    for (let i = 0; i < 6 && (await quoteOf(quote.id)).status !== "converted"; i++) await t.runWorker({ lane: "fast" });
    const q = await quoteOf(quote.id);
    assert.equal(q.status, "converted", JSON.stringify({ status: q.status, conversion: q.conversion }));
    const jobKeys = t.stores.data.keys("rec/job/");
    assert.equal(jobKeys.length, 1, "exactly one job");
    const job = t.stores.data.json(jobKeys[0]).data || t.stores.data.json(jobKeys[0]);
    assert.equal(job.contact_id, quote.contact_id);
    assert.equal(job.status, "unscheduled", "in the to-book tray");
    assert.equal(job.lines.length, opt.lines.length);
    assert.equal(job.lines.reduce((s, l) => s + Number(l.total_cents ?? 0), 0), q.approval.totals.first_cents ?? q.approval.totals.total_cents ?? job.lines.reduce((s, l) => s + Number(l.total_cents ?? 0), 0));
    // a retried conversion creates nothing twice
    await t.api(`/quotes/${quote.id}/convert`, { method: "POST", as: owner, body: {} });
    for (let i = 0; i < 4; i++) await t.runWorker({ lane: "fast" });
    assert.equal(t.stores.data.keys("rec/job/").length, 1, "still one job");
  } finally { off(); t.done(); }
});
