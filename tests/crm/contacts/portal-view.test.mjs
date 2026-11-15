// "Open their portal" (guide-gaps S12): a link marked office_view opens the
// customer's pages, but its beacon counts nothing as their view and every
// POST (pay, approve, ask for changes) is refused.
import { test } from "node:test";
import assert from "node:assert/strict";
import { setup, sentQuote, PJSON, quoteOf, scope } from "../quotes/fixtures.mjs";

const PORTAL = await import("../../../netlify/lib/crm/portal/core.mjs");

test("an office_view session: pages open, the beacon is ignored, POSTs are refused", async () => {
  const { t, owner } = await setup();
  try {
    const { quote } = await sentQuote(t, owner);
    const l = await scope(() => PORTAL.createPortalLink({ contact_id: quote.contact_id, scope: { kind: "quote", id: quote.id }, office_view: true, single_use: true }));
    const r = await t.portal("/api/portal/open", { method: "POST", headers: PJSON, body: { code: l.code } });
    assert.equal(r.status, 200);
    const cookie = t.setCookies(r).find((x) => x.startsWith("barta_portal=")).split(";")[0];
    assert.equal((await t.portal(`/p/quote/${quote.id}`, { cookie })).status, 200, "the page opens as they see it");
    const b = await t.portal("/api/portal/beacon", { method: "POST", cookie, headers: PJSON, body: { kind: "quote", id: quote.id } });
    assert.equal(b.status, 204);
    assert.equal((await quoteOf(quote.id)).status, "sent", "not counted as their view");
    const ch = await t.portal(`/api/portal/quotes/${quote.id}/changes`, { method: "POST", cookie, headers: PJSON, body: { note: "From the office" } });
    assert.equal(ch.status, 403);
    assert.equal(ch.body.error.code, "office_view");
  } finally { t.done(); }
});
