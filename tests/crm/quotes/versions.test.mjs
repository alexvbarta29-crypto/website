// M3a acceptance: quote versions (design §5.3, §11.4 "versions.test.mjs"):
// each send freezes a version with its sha256; approving a version that is
// no longer current → 409; conversion uses the APPROVED version, never the
// live draft; a later legitimate approval is a new op, a double tap the same.
import { test } from "node:test";
import assert from "node:assert/strict";
import { setup, sentQuote, oneTime, quarterly, portalCookie, approveBody, PJSON, quoteOf, finishRun, fakes, scope, store, V, AS } from "./fixtures.mjs";

test("each send freezes a version with its sha256 over the canonical content; an unchanged re-send keeps it; a change makes the next", async () => {
  const { t, owner } = await setup();
  const f = fakes();
  try {
    const { quote, version } = await sentQuote(t, owner);
    assert.equal(version.n, 1);
    const v1 = t.stores.data.json(`rec/quote_version/${version.id}`);
    const content = V.versionContent({ options: v1.options, agreement: v1.agreement, client_notes: v1.client_notes, photo_ids: v1.photo_ids, mockup_file_ids: v1.mockup_file_ids }, { terms_text: v1.terms_text, plan_agreements: v1.plan_agreements, expires_on: v1.expires_on });
    assert.equal(V.versionHash(content), v1.sha256, "the hash covers exactly what was frozen");
    assert.match(v1.terms_text, /re-clean it free of charge/, "the general terms are on every quote");
    assert.doesNotMatch(v1.terms_text, /refund|licensed|—/i);
    assert.equal(V.canonicalJson({ b: 1, a: [2, { d: 1, c: 2 }] }), '{"a":[2,{"c":2,"d":1}],"b":1}');
    // the same quote sent again the same day: same version
    const again = await t.api(`/quotes/${quote.id}/send`, { method: "POST", as: owner, body: { channels: ["email"] } });
    assert.equal(again.body.data.version.id, version.id);
    assert.equal(again.body.data.new_version, false);
    // an edit and a send: version 2; version 1 stays as it was
    const cur = await t.api(`/quotes/${quote.id}`, { as: owner });
    const opts = cur.body.data.quote.options.map((o) => ({ ...o, name: o.kind === "plan" ? "Quarterly care" : o.name }));
    await t.api(`/quotes/${quote.id}`, { method: "PATCH", as: owner, ifMatch: cur.headers.get("etag"), body: { options: opts, client_notes: "Thanks for having us out!" } });
    const s2 = await t.api(`/quotes/${quote.id}/send`, { method: "POST", as: owner, body: { channels: ["sms"] } });
    assert.equal(s2.body.data.version.n, 2);
    assert.notEqual(s2.body.data.version.sha256, version.sha256);
    assert.deepEqual(t.stores.data.json(`rec/quote_version/${version.id}`).options, v1.options, "a sent version never changes");
    const list = await t.api(`/quotes/${quote.id}/versions`, { as: owner });
    assert.deepEqual(list.body.data.map((v) => v.n), [2, 1]);
    const q = await quoteOf(quote.id);
    assert.equal(q.current_version_id, s2.body.data.version.id);
    assert.equal(q.versions_n, 2);
  } finally { f.restore(); t.done(); }
});

test("conversion uses the approved version, never the live draft", async () => {
  const { t, owner } = await setup();
  const f = fakes();
  try {
    const { quote, version } = await sentQuote(t, owner);
    const plan = version.options.find((o) => o.kind === "plan");
    // the live record drifts (as if someone's change landed after the send)
    await scope(() => store.updateRecord("quote", quote.id, (q) => ({ ...q, options: q.options.map((o) => ({ ...o, lines: o.lines.map((l) => ({ ...l, unit_cents: 1, title: "Changed after sending" })) })) }), AS(owner)));
    const cookie = await portalCookie(t, quote);
    const r = await t.portal(`/api/portal/quotes/${quote.id}/approve`, { method: "POST", cookie, headers: PJSON, body: approveBody(version, plan.id) });
    await finishRun(t, r.body.data.run_id);
    const call = f.calls.fromQuoteOption[0];
    assert.equal(call.version_id, version.id);
    const got = await scope(() => V.approvedVersion(quote.id));
    assert.equal(got.id, version.id, "quotes.approvedVersion");
    assert.ok(got.options.every((o) => o.lines.every((l) => l.title !== "Changed after sending")));
  } finally { f.restore(); t.done(); }
});

test("a decline, a restore, an approval: a new op; approve, archive, restore and approve again: op n = 2 (a double tap stays one)", async () => {
  const { t, owner } = await setup();
  const f = fakes({ plans: false, work: false, money: false });
  try {
    const { quote, version } = await sentQuote(t, owner, { options: [oneTime()] });
    let cookie = await portalCookie(t, quote);
    assert.equal((await t.portal(`/api/portal/quotes/${quote.id}/decline`, { method: "POST", cookie, headers: PJSON, body: { reason: "Going with someone else" } })).status, 200);
    assert.equal((await quoteOf(quote.id)).status, "declined");
    assert.equal((await t.portal(`/api/portal/quotes/${quote.id}/approve`, { method: "POST", cookie, headers: PJSON, body: approveBody(version, version.options[0].id) })).status, 409, "a declined quote can't be approved");
    assert.equal((await t.api(`/quotes/${quote.id}/restore`, { method: "POST", as: owner, body: {} })).body.data.quote.status, "draft");
    await t.api(`/quotes/${quote.id}/send`, { method: "POST", as: owner, body: { channels: ["sms"] } });
    const v = (await t.api(`/quotes/${quote.id}`, { as: owner })).body.data.current_version;
    const r1 = await t.portal(`/api/portal/quotes/${quote.id}/approve`, { method: "POST", cookie, headers: PJSON, body: approveBody(v, v.options[0].id) });
    assert.equal((await finishRun(t, r1.body.data.run_id)).status, "done");
    assert.equal((await quoteOf(quote.id)).approvals_count, 1);
    assert.ok(t.stores.data.keys(`op/approve--${quote.id}--1`).length === 1);
    // back to the drawing board and approved again: a second op, a second run
    await t.api(`/quotes/${quote.id}/archive`, { method: "POST", as: owner, body: {} });
    await t.api(`/quotes/${quote.id}/restore`, { method: "POST", as: owner, body: {} });
    await t.api(`/quotes/${quote.id}/send`, { method: "POST", as: owner, body: { channels: ["sms"] } });
    const v2 = (await t.api(`/quotes/${quote.id}`, { as: owner })).body.data.current_version;
    const r2 = await t.portal(`/api/portal/quotes/${quote.id}/approve`, { method: "POST", cookie, headers: PJSON, body: approveBody(v2, v2.options[0].id) });
    const r2b = await t.portal(`/api/portal/quotes/${quote.id}/approve`, { method: "POST", cookie, headers: PJSON, body: approveBody(v2, v2.options[0].id) });
    assert.notEqual(r2.body.data.run_id, r1.body.data.run_id);
    assert.equal(r2b.body.data.run_id, r2.body.data.run_id);
    assert.equal((await finishRun(t, r2.body.data.run_id)).status, "done");
    assert.ok(t.stores.data.keys(`op/approve--${quote.id}--2`).length === 1);
    assert.equal((await quoteOf(quote.id)).approvals_count, 2);
  } finally { f.restore(); t.done(); }
});
