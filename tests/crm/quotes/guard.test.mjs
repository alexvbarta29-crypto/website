// M3a acceptance: the parallel-run guard (design §0 rule 12, §3.10, §11.4
// "guard.test.mjs"): quotes.expire and the cadence archive step (and the
// offer steps) are would- rows for imported quotes; on the CRM's own
// (shadow) quotes they act.
import { test } from "node:test";
import assert from "node:assert/strict";
import { setup, sentQuote, importedContact, oneTime, quoteOf, alog, fakes, scope, store, Q, AUTOMATION, IMPORT, pin } from "./fixtures.mjs";
import { idForRotor } from "../../../netlify/lib/crm/core/ids.mjs";

async function importedQuote(contact, extra = {}) {
  const id = idForRotor("quote", `rotor-q-${contact.id}`);
  const r = await scope(() => store.createRecord("quote", {
    id, number: 18001, contact_id: contact.id, contact_name: "Robin Imported", status: "sent", sent_at: "2026-10-01T15:00:00.000Z", expires_on: "2026-10-31",
    options: [{ id: "op_rotor", name: "One-time", kind: "one_time", recommended: true, lines: [{ id: "8c1f2b6e-0000-4000-8000-000000000001", title: "Exterior Window Cleaning", qty_milli: 1000, unit_cents: 0, override: { cents: 29500, reason: "imported" }, scope: { type: "all" } }], discounts: [], totals: { first_cents: 29500, per_visit_cents: [29500], term_cents: 29500, annual_cents: 29500 } }],
    agreement: { require_card: false, deposit: { type: "none", value: 0 } }, sent_via: [], approvals_count: 0, versions_n: 0, services: [], offers: [],
    import: { run_id: "ir_00000000000000000001", at: "2026-11-08T00:00:00.000Z", hash: "0".repeat(64) }, rotor: { quote_id: `rotor-q-${contact.id}`, quote_number: 18001 }, ...extra,
  }, IMPORT));
  return r.data;
}

test("quotes.expire: an imported quote past its date gets a would- row and stays; the CRM's own quote is archived", async () => {
  const { t, owner } = await setup();
  const f = fakes();
  try {
    const rc = await importedContact();
    const iq = await importedQuote(rc);
    const own = await sentQuote(t, owner, { options: [oneTime()] });
    assert.equal(own.quote.expires_on, "2026-12-10");
    pin("2026-12-11T09:00:00Z");          // 03:00 in Delano: the 02:10 sweep is due
    await t.runWorker({ lane: "fast" });
    assert.equal((await quoteOf(iq.id)).status, "sent", "Rotor's quote is untouched");
    assert.ok(alog(t).some((k) => k.includes("quotes.expire") && k.includes(iq.id) && k.endsWith("would-archive")), "a would-archive row");
    const mine = await quoteOf(own.quote.id);
    assert.equal(mine.status, "archived");
    assert.equal(mine.archive_reason, "expired");
    assert.ok(t.stores.data.keys("done/sweep/quotes.expire--2026-12-11").length === 1);
  } finally { f.restore(); t.done(); }
});

test("the cadence's offer and archive steps (Sales calls quotes.applyOffer / quotes.archive as automation): would- rows on imported quotes", async () => {
  const { t, owner } = await setup();
  const f = fakes();
  try {
    const rc = await importedContact();
    const iq = await importedQuote(rc);
    const would = { ...AUTOMATION, would: undefined };
    const a = await scope(() => Q.applyOffer(iq.id, "followup_50", {}, would));
    assert.equal(a.would, true);
    const b = await scope(() => Q.archiveForSales(iq.id, { reason: "no_response" }, would));
    assert.equal(b.would, true);
    const q = await quoteOf(iq.id);
    assert.equal(q.status, "sent");
    assert.deepEqual(q.offers, []);
    assert.ok(alog(t).some((k) => k.endsWith("would-archive")));
    assert.ok(alog(t).some((k) => k.endsWith("would-offer_followup_50")));
    // the CRM's own quote: the same calls act, and the portal sees the new price at once
    const own = await sentQuote(t, owner, { options: [oneTime()] });
    const r = await scope(() => Q.applyOffer(own.quote.id, "followup_50", {}, AUTOMATION));
    assert.equal(r.applied, true);
    assert.ok(r.version_id && r.version_id !== own.version.id, "a new version, nothing sent");
    const q2 = await quoteOf(own.quote.id);
    assert.equal(q2.options[0].totals.first_cents, 24500, "$295 − $50 on the first visit");
    assert.deepEqual(q2.offers, ["followup_50"]);
    assert.equal((await scope(() => Q.applyOffer(own.quote.id, "followup_50", {}, AUTOMATION))).already, true, "once");
    const screens = await scope(() => Q.applyOffer(own.quote.id, "ten_free_screens", {}, AUTOMATION));
    assert.equal(screens.applied, true);
    const q3 = await quoteOf(own.quote.id);
    assert.equal(q3.options[0].totals.first_cents, 24500, "10 screens added free: the price stays");
    assert.ok(q3.options[0].lines.some((l) => l.offer === "ten_free_screens"));
    const arch = await scope(() => Q.archiveForSales(own.quote.id, { reason: "no_response" }, AUTOMATION));
    assert.equal(arch.archived, true);
    const q4 = await quoteOf(own.quote.id);
    assert.equal(q4.archive_reason, "cadence_expired");
    assert.deepEqual(q4.offers, []);
    assert.equal(q4.options[0].totals.first_cents, 29500, "the offers end with the archive");
  } finally { f.restore(); t.done(); }
});

test("the store's backstop: automation can't create a quote for an imported customer", async () => {
  const { t } = await setup();
  try {
    const rc = await importedContact();
    await assert.rejects(scope(() => store.createRecord("quote", { number: 2, number_seq: "quote-shadow", contact_id: rc.id, status: "draft", options: [], sent_via: [] }, AUTOMATION)), /Rotor is still in charge/);
  } finally { t.done(); }
});
