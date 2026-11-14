// The client portal frame (design §8, §12.3 suite 11 "Portal", §12.2
// "portal"): a GET never sets a cookie, counts an open or unsubscribes;
// link → POST open → scoped cookie → page; a document link never opens
// another record or the hub; expired, revoked and over-used links get the
// friendly page; headers and CSP; no inline script; unsubscribe (RFC 8058
// one-click) writes the suppression; present links set no cookie and work
// once; nothing opens before the owner's setup. Synthetic data only.
import { test, afterEach } from "node:test";
import assert from "node:assert/strict";
import { crmTest } from "../../helpers/crm-http.mjs";
import { fixtureModule, seedContact } from "../../helpers/crm-fixtures.mjs";
import { advance, days } from "../../helpers/crm-clock.mjs";

const store = await import("../../../netlify/lib/crm-store.mjs");
const P = await import("../../../netlify/lib/crm/portal/core.mjs");
const S = await import("../../../netlify/lib/crm/core/send.mjs");

const EXACT_CSP = "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; connect-src 'self'; form-action 'self' https://checkout.stripe.com; frame-ancestors 'none'; base-uri 'none'; object-src 'none'";
const W8 = { by: "system", origin: "api", actor_kind: "user", requestId: "test" };
const scope = (fn) => store.withStoreScope({ requestId: "test" }, fn);
const viewed = [];

// A module's pages, as a later milestone registers them.
fixtureModule({
  portalRoutes: [
    { method: "GET", path: "/p/quote/:id", scope: "quote", handler: (p) => p.portalPage(p.layout({ title: "Your quote", company: p.company, beacon: { kind: "quote", id: p.params.id }, body: `<section class="card"><h1>Quote ${p.esc(p.params.id)}</h1><p>For ${p.esc(p.contact_id)}</p></section>` })) },
    { method: "GET", path: "/p/invoice/:id", scope: "invoice", handler: (p) => p.portalPage(p.layout({ title: "Invoice", body: "<p>invoice</p>" })) },
    { method: "GET", path: "/p/hub", scope: "hub", handler: (p) => p.portalPage(p.layout({ title: "Home", body: "<p>hub</p>" })) },
    { method: "POST", path: "/api/portal/quotes/:id/changes", scope: "quote", handler: (p) => p.json({ ok: true, data: { got: p.body.message } }) },
    { method: "GET", path: "/p/present/:token", scope: "present", handler: (p) => p.portalPage(p.layout({ title: "Present", body: `<p>present ${p.esc(p.link.scope.id)}</p>` })) },
  ],
});
P.definePortalBeacon("quote", async ({ id }) => { viewed.push(id); });
// sales and comms listen for consent.changed (§11.3): a stand-in listener
const consent = [];
fixtureModule({ events: { "consent.changed": { mutates: false, handler: async (event) => { consent.push(event.payload); return { result: "done" }; } } } });

let t;
afterEach(() => { if (t) t.done(); t = null; viewed.length = 0; consent.length = 0; });

const json = { "content-type": "application/json", "x-crm-portal": "1", origin: "https://www.bartawindowwashing.com" };
const cookieOf = (res) => (res.headers.getSetCookie ? res.headers.getSetCookie() : []).find((c) => c.startsWith("barta_portal=")) || null;

function assertPortalHeaders(r, where) {
  assert.equal(r.headers.get("content-security-policy"), EXACT_CSP, where);
  assert.equal(r.headers.get("referrer-policy"), "no-referrer", where);
  assert.equal(r.headers.get("x-frame-options"), "DENY", where);
  assert.equal(r.headers.get("cache-control"), "private, no-store", where);
  assert.equal(r.headers.get("x-robots-tag"), "noindex, nofollow", where);
  for (const m of r.text.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/gi)) {
    assert.match(m[1], /^\s+type="module" src="\/crm-app\/portal\/[a-z-]+\.js"$/, `${where}: only the portal's own files`);
    assert.equal(m[2].trim(), "");
  }
  assert.doesNotMatch(r.text, /\son[a-z]+\s*=/i, `${where}: no inline handler`);
}

async function link(kind, id, extra = {}) {
  const c = extra.contact || await scope(() => seedContact(extra.n || 1));
  const l = await scope(() => P.createPortalLink({ contact_id: c.id, scope: { kind, ...(id ? { id } : {}) }, created_by: "us_00000000000000000001", ...(extra.expires_at !== undefined ? { expires_at: extra.expires_at } : {}) }));
  return { ...l, contact: c };
}

test("a GET of the link opens nothing; the page's POST sets a cookie for that quote alone", async () => {
  t = await crmTest();
  const q = await link("quote", "qt_0000000000000000000a");
  assert.match(q.code, /^[0-9A-Za-z]{10}$/);
  assert.equal(q.url, `https://www.bartawindowwashing.com/p/${q.code}`);
  const page = await t.portal(`/p/${q.code}`);
  assert.equal(page.status, 200);
  assertPortalHeaders(page, "entry");
  assert.equal(cookieOf(page), null, "a GET never sets a cookie");
  assert.equal(t.stores.data.json(P.linkKey(q.code)).uses, 0, "a GET never counts an open");
  assert.match(page.text, new RegExp(`data-code="${q.code}"`));

  assert.equal((await t.portal("/api/portal/open", { method: "POST", headers: { "content-type": "application/json" }, body: { code: q.code } })).status, 403, "the fetch needs X-CRM-Portal");
  const bot = await t.portal("/api/portal/open", { method: "POST", headers: { ...json, "user-agent": "Mozilla/5.0 (compatible; Googlebot/2.1)" }, body: { code: q.code } });
  assert.equal(bot.status, 403, "known bots open nothing");
  const opened = await t.portal("/api/portal/open", { method: "POST", headers: { ...json, "user-agent": "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) Safari/604.1" }, body: { code: q.code } });
  assert.equal(opened.status, 200, JSON.stringify(opened.body));
  assert.equal(opened.body.data.location, "/p/quote/qt_0000000000000000000a");
  const set = cookieOf(opened);
  assert.match(set, /^barta_portal=ct_[0-9a-z]{20}\.[A-Za-z0-9_-]{43}; Path=\/; Max-Age=\d+; HttpOnly; Secure; SameSite=Lax$/);
  assert.equal(t.stores.data.json(P.linkKey(q.code)).uses, 1);
  assert.ok(t.stores.data.keys("pses/").length === 1);
  assert.ok(!t.logs().some((l) => l.includes(q.code)), "a code never reaches a log");

  const cookie = set.split(";")[0];
  const mine = await t.portal("/p/quote/qt_0000000000000000000a", { cookie });
  assert.equal(mine.status, 200);
  assertPortalHeaders(mine, "quote page");
  assert.match(mine.text, /data-beacon-kind="quote" data-beacon-id="qt_0000000000000000000a"/);
  for (const other of ["/p/quote/qt_0000000000000000000b", "/p/invoice/in_0000000000000000000c", "/p/hub"]) {
    const r = await t.portal(other, { cookie });
    assert.equal(r.status, 401, `${other}: a quote link opens that quote only`);
    assert.doesNotMatch(r.text, /hub|invoice/i);
  }
  // the beacon: a POST after load, scoped to the page
  assert.equal((await t.portal("/api/portal/beacon", { method: "POST", cookie, headers: json, body: { kind: "quote", id: "qt_0000000000000000000a" } })).status, 204);
  assert.deepEqual(viewed, ["qt_0000000000000000000a"]);
  assert.equal((await t.portal("/api/portal/beacon", { method: "POST", cookie, headers: json, body: { kind: "quote", id: "qt_0000000000000000000b" } })).status, 401);
  // a module API route: scope plus the CSRF header
  assert.equal((await t.portal("/api/portal/quotes/qt_0000000000000000000a/changes", { method: "POST", cookie, headers: { "content-type": "application/json" }, body: { message: "x" } })).status, 403);
  const ch = await t.portal("/api/portal/quotes/qt_0000000000000000000a/changes", { method: "POST", cookie, headers: json, body: { message: "Can you add screens?" } });
  assert.equal(ch.body.data.got, "Can you add screens?");
  // no cookie, no page
  assert.equal((await t.portal("/p/quote/qt_0000000000000000000a")).status, 401);
  // staff cookies mean nothing here
  const owner = await t.user("owner");
  assert.equal((await t.portal("/p/quote/qt_0000000000000000000a", { as: owner })).status, 401);
});

test("the no-script Continue form opens the link with a 303 to its page", async () => {
  t = await crmTest();
  const h = await link("hub");
  const r = await t.portal("/api/portal/open", { method: "POST", raw: `code=${h.code}`, headers: { "content-type": "application/x-www-form-urlencoded", origin: "https://www.bartawindowwashing.com" } });
  assert.equal(r.status, 303);
  assert.equal(r.headers.get("location"), "/p/hub");
  assert.ok(cookieOf(r));
  const foreign = await t.portal("/api/portal/open", { method: "POST", raw: `code=${h.code}`, headers: { "content-type": "application/x-www-form-urlencoded", origin: "https://evil.example" } });
  assert.equal(foreign.status, 403);
});

test("expired, revoked and over-used links get the friendly page; the owners hear about a locked one", async () => {
  t = await crmTest();
  await t.user("owner");
  const old = await link("invoice", "in_0000000000000000000d", { expires_at: "2026-11-01T00:00:00.000Z" });
  const r = await t.portal("/api/portal/open", { method: "POST", headers: json, body: { code: old.code } });
  assert.equal(r.status, 410);
  assert.equal(r.body.error.code, "expired");
  const nope = await t.portal("/api/portal/open", { method: "POST", headers: json, body: { code: "AAAAAAAAAA" } });
  assert.equal(nope.status, 404);
  const rev = await link("hub", null, { n: 2 });
  assert.equal(await scope(() => P.revokeLinks(rev.contact.id)), 1);
  assert.equal((await t.portal("/api/portal/open", { method: "POST", headers: json, body: { code: rev.code } })).body.error.code, "revoked");
  const formPage = await t.portal("/api/portal/open", { method: "POST", raw: `code=${rev.code}`, headers: { "content-type": "application/x-www-form-urlencoded" } });
  assert.equal(formPage.status, 410);
  assert.match(formPage.text, /no longer works/);

  // more opens a day than cfg/portal.max_opens_per_day: locked, owners told
  await scope(() => store.putSetting("portal", { max_opens_per_day: 10 }, { ...W8, origin: "worker" }));
  const busy = await link("quote", "qt_0000000000000000000e", { n: 3 });
  for (let i = 0; i < 10; i++) assert.equal((await t.portal("/api/portal/open", { method: "POST", headers: json, body: { code: busy.code } })).status, 200);
  const locked = await t.portal("/api/portal/open", { method: "POST", headers: json, body: { code: busy.code } });
  assert.equal(locked.status, 410);
  assert.equal(locked.body.error.code, "locked");
  assert.ok(t.stores.data.json(P.linkKey(busy.code)).locked_at);
  assert.equal(t.stores.data.keys("q/").length, 1, "one notification queued for the owners");
  // a session from a revoked link stops working
  const s = await link("quote", "qt_0000000000000000000f", { n: 4 });
  const op = await t.portal("/api/portal/open", { method: "POST", headers: json, body: { code: s.code } });
  const cookie = cookieOf(op).split(";")[0];
  assert.equal((await t.portal("/p/quote/qt_0000000000000000000f", { cookie })).status, 200);
  await scope(() => P.revokeLinks(s.contact.id));
  assert.equal((await t.portal("/p/quote/qt_0000000000000000000f", { cookie })).status, 401);
  // and a session ends with its link
  const short = await link("agreement", "ag_00000000000000000001", { n: 5, expires_at: "2026-11-18T00:00:00.000Z" });
  const op2 = await t.portal("/api/portal/open", { method: "POST", headers: json, body: { code: short.code } });
  assert.match(cookieOf(op2), /Max-Age=(\d+)/);
  assert.ok(Number(/Max-Age=(\d+)/.exec(cookieOf(op2))[1]) <= 9 * 3600 + 60, "never past the link's own expiry");
});

test("unsubscribe: the page asks; the one-click POST (RFC 8058) writes the suppression and marketing email stops", async () => {
  t = await crmTest();
  const c = await scope(() => seedContact(6));
  const u = await scope(() => P.unsubscribeLink({ contact_id: c.id, channel: "email", address: c.emails[0].address }));
  const again = await scope(() => P.unsubscribeLink({ contact_id: c.id, channel: "email", address: c.emails[0].address }));
  assert.equal(again.code, u.code, "one link per address");
  assert.equal(u.one_click, `https://www.bartawindowwashing.com/api/portal/unsubscribe/${u.code}`);
  const page = await t.portal(`/p/unsubscribe/${u.code}`);
  assert.equal(page.status, 200);
  assertPortalHeaders(page, "unsubscribe");
  assert.match(page.text, /Stop marketing emails\?/);
  assert.equal(t.stores.data.keys("sup/").length, 0, "the GET changed nothing");
  const one = await t.portal(`/api/portal/unsubscribe/${u.code}`, { method: "POST", raw: "List-Unsubscribe=One-Click", headers: { "content-type": "application/x-www-form-urlencoded" } });
  assert.equal(one.status, 200);
  const sup = t.stores.data.keys("sup/email/");
  assert.equal(sup.length, 1);
  assert.equal(t.stores.data.json(sup[0]).source, "portal");
  await scope(() => store.createRecord("template", { key: "promo_mail", name: "Promo", channel: "email", category: "marketing", subject: "Fall", body: "Hi {{first_name|there}}.", tags: [], active: true }, W8));
  const r = await scope(() => S.sendMessage({ contact_id: c.id, channel: "email", template_key: "promo_mail", origin: { kind: "campaign" } }, W8));
  assert.equal(r.blocked_reason, "opted_out");
  assert.equal((await t.portal(`/api/portal/unsubscribe/${u.code}`, { method: "POST", raw: "x=1", headers: { "content-type": "application/x-www-form-urlencoded", origin: "https://evil.example" } })).status, 403, "only the one-click body or the page itself");
});

test("present links set no cookie, open their module page by token, and work once", async () => {
  t = await crmTest();
  const c = await scope(() => seedContact(7));
  const p = await scope(() => P.createPresentLink({ contact_id: c.id, quote_id: "qt_0000000000000000000a", created_by: "us_00000000000000000001" }));
  const open = await t.portal("/api/portal/open", { method: "POST", headers: json, body: { code: p.code } });
  assert.equal(open.body.data.location, `/p/present/${p.code}`);
  assert.equal(cookieOf(open), null, "no cookie for a present link");
  const page = await t.portal(`/p/present/${p.code}`);
  assert.equal(page.status, 200);
  assert.match(page.text, /present qt_0000000000000000000a/);
  assert.equal(await scope(() => P.consumeLink(p.code)), true);
  assert.equal(await scope(() => P.consumeLink(p.code)), false, "single use");
  assert.equal((await t.portal(`/p/present/${p.code}`)).status, 410);
  const later = await scope(() => P.createPresentLink({ contact_id: c.id, quote_id: "qt_0000000000000000000b" }));
  advance(16 * 60000);
  assert.equal((await t.portal(`/p/present/${later.code}`)).status, 410, "15 minutes");
});

test("the return page, pages that don't exist yet, and an XSS probe in the path", async () => {
  t = await crmTest();
  const ret = await t.portal("/p/return?cs=cs_test_x");
  assert.equal(ret.status, 200);
  assert.match(ret.text, /confirming your payment/);
  // Money's card page needs its link's session; a page no module has yet is a 404
  assert.equal((await t.portal("/p/card")).status, 401, "the card page opens only from its link");
  // (/p/visits is the customer's account now, portal/account.mjs: tests/crm/plans/account.test.mjs)
  assert.equal((await t.portal("/p/visits")).status, 401, "the account's visits open only from a hub link");
  const missing = await t.portal("/p/nothing-here");
  assert.equal(missing.status, 404, "a page no module has");
  assertPortalHeaders(missing, "404");
  const xss = await t.portal("/p/%3C%2Fscript%3E%3Cscript%3Ealert(1)%3C%2Fscript%3E");
  assert.ok(!xss.text.includes("<script>alert(1)"));
  assert.equal((await t.portal("/api/portal/nothing")).status, 404);
  advance(days(1));
});

test("before the owner's setup the portal opens nothing", async () => {
  t = await crmTest({ env: { CONTEXT: "production", CRM_PRODUCTION: undefined, CRM_KEY_SALT: undefined } });
  const r = await t.portal("/p/AbC123xYz9");
  assert.equal(r.status, 503);
  assert.match(r.text, /isn&#39;t available right now/);
  assertPortalHeaders(r, "setup needed");
  assert.equal(t.stores.data.keys("").length, 0, "no store touched");
});

test("an unsubscribe link keeps working after the contact's links are revoked (opting out is always allowed)", async () => {
  t = await crmTest();
  const c = await scope(() => seedContact(8));
  const u = await scope(() => P.unsubscribeLink({ contact_id: c.id, channel: "email", address: c.emails[0].address }));
  const hub = await scope(() => P.createPortalLink({ contact_id: c.id, scope: { kind: "hub" } }));
  const n = await scope(() => P.revokeLinks(c.id));
  assert.equal(n, 1, "the hub link is revoked, the unsubscribe link is not");
  const link = (code) => scope(() => P.readLink(code));
  assert.ok((await link(hub.code)).revoked_at);
  assert.equal((await link(u.code)).revoked_at, null);
  assert.equal((await t.portal(`/p/unsubscribe/${u.code}`)).status, 200);
  // a link revoked before this rule still works, and the next email brings it back
  const cur = await link(u.code);
  const { _etag, _key, ...value } = cur;
  await scope(() => store.settledWrite(_key, { ...value, revoked_at: "2026-11-01T00:00:00.000Z" }, { onlyIfMatch: _etag }));
  assert.equal((await t.portal(`/p/unsubscribe/${u.code}`)).status, 200);
  const one = await t.portal(`/api/portal/unsubscribe/${u.code}`, { method: "POST", raw: "List-Unsubscribe=One-Click", headers: { "content-type": "application/x-www-form-urlencoded" } });
  assert.equal(one.status, 200);
  await scope(() => P.unsubscribeLink({ contact_id: c.id, channel: "email", address: c.emails[0].address }));
  assert.equal((await link(u.code)).revoked_at, null);
});

test("unsubscribing (portal) and a manual opt-out emit consent.changed once each, for the listeners", async () => {
  t = await crmTest();
  const owner = await t.user("owner");
  const c = await scope(() => seedContact(9));
  const u = await scope(() => P.unsubscribeLink({ contact_id: c.id, channel: "email", address: c.emails[0].address }));
  await t.portal(`/api/portal/unsubscribe/${u.code}`, { method: "POST", raw: "List-Unsubscribe=One-Click", headers: { "content-type": "application/x-www-form-urlencoded" } });
  await t.portal(`/api/portal/unsubscribe/${u.code}`, { method: "POST", raw: "List-Unsubscribe=One-Click", headers: { "content-type": "application/x-www-form-urlencoded" } });
  const m = await t.api("/suppressions", { method: "POST", as: owner, body: { channel: "sms", address: "+17635550123", state: "opted_out" } });
  assert.equal(m.status, 200);
  await t.runWorker();
  assert.equal(consent.length, 2, "one event per change (a second unsubscribe changes nothing)");
  const mail = consent.find((p) => p.channel === "email");
  assert.equal(mail.contact_id, c.id);
  assert.equal(mail.state, "opted_out");
  assert.equal(mail.address_hk, store.hk("email", c.emails[0].address));
  const sms = consent.find((p) => p.channel === "sms");
  assert.equal(sms.contact_id, null, "nobody has that number");
  assert.equal(sms.by, owner.id);
  // opting back in is a change too
  await t.api("/suppressions", { method: "POST", as: owner, body: { channel: "sms", address: "+17635550123", state: "active" } });
  await t.runWorker();
  assert.equal(consent.length, 3);
  assert.equal(consent[2].state, "active");
});
