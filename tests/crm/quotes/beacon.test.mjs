// M3a acceptance: viewed (design §8.1, §11.4 "beacon.test.mjs"): a GET of
// the quote page never sets `viewed` (email scanners and link previews
// fetch links first); the page's POST beacon does, ignoring bot user agents.
import { test } from "node:test";
import assert from "node:assert/strict";
import { setup, sentQuote, portalCookie, PJSON, quoteOf, queued, fakes } from "./fixtures.mjs";
import { fixtureModule } from "../../helpers/crm-fixtures.mjs";

// a stand-in listener (no shipped module listens for quote.viewed yet)
const heard = [];
fixtureModule({ events: { "quote.viewed": { mutates: false, handler: async (event) => { heard.push(event.payload.quote_id); return { result: "done" }; } } } });

test("a GET never sets viewed; the POST beacon does once; bots are ignored; a staff cookie opens nothing", async () => {
  const { t, owner } = await setup();
  const f = fakes();
  try {
    const { quote } = await sentQuote(t, owner);
    const cookie = await portalCookie(t, quote);
    for (let i = 0; i < 3; i++) {
      const page = await t.portal(`/p/quote/${quote.id}`, { cookie, headers: { "user-agent": "Mozilla/5.0 (compatible; Googlebot/2.1)" } });
      assert.equal(page.status, 200);
      assert.match(page.text, new RegExp(`data-beacon-kind="quote" data-beacon-id="${quote.id}"`));
    }
    assert.equal((await quoteOf(quote.id)).status, "sent", "GETs change nothing");
    assert.equal((await quoteOf(quote.id)).viewed_at, undefined);
    const bot = await t.portal("/api/portal/beacon", { method: "POST", cookie, headers: { ...PJSON, "user-agent": "Slackbot-LinkExpanding 1.0" }, body: { kind: "quote", id: quote.id } });
    assert.equal(bot.status, 204);
    assert.equal((await quoteOf(quote.id)).status, "sent", "a bot's beacon is ignored");
    const nocsrf = await t.portal("/api/portal/beacon", { method: "POST", cookie, headers: { "content-type": "application/json" }, body: { kind: "quote", id: quote.id } });
    assert.equal(nocsrf.status, 403);
    const r = await t.portal("/api/portal/beacon", { method: "POST", cookie, headers: PJSON, body: { kind: "quote", id: quote.id } });
    assert.equal(r.status, 204);
    const q = await quoteOf(quote.id);
    assert.equal(q.status, "viewed");
    assert.equal(q.viewed_at, "2026-11-10T16:00:00.000Z");
    assert.equal(queued(t).filter((x) => x.data && x.data.name === "quote.viewed").length, 1, "one quote.viewed event");
    const before = queued(t).length;
    await t.portal("/api/portal/beacon", { method: "POST", cookie, headers: PJSON, body: { kind: "quote", id: quote.id } });
    assert.equal(queued(t).length, before, "a second view is not a second event");
    assert.equal((await quoteOf(quote.id)).viewed_at, q.viewed_at, "viewed_at is the first time");
    // another quote's id, a staff session: nothing
    assert.equal((await t.portal("/api/portal/beacon", { method: "POST", cookie, headers: PJSON, body: { kind: "quote", id: "qt_0000000000000000000b" } })).status, 401);
    assert.equal((await t.portal(`/p/quote/${quote.id}`, { as: owner })).status, 401);
  } finally { f.restore(); t.done(); }
});
