// Comms: the Twilio, Postmark and Google Business Profile drivers against a
// mocked fetch (design §6.1, §6.3, §6.4, §6.6, §0 rule 11). Nothing here
// reaches a network. What must hold whatever the settings say:
//   - no secret → no request; off the production deploy → dry-run;
//   - test mode reaches only the staff allowlist, from the test number;
//   - live is refused while Rotor is the system of record;
//   - the drivers only send and look up messages: they never register a
//     webhook, a number or anything else with a provider; GBP only reads.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createHmac, createHash } from "node:crypto";
import { crmTest, HOST } from "../../helpers/crm-http.mjs";
import { connected, mockFetch, store, scope, staffContact, SID, TOKEN, STAFF, TEST_FROM, PROD_ENV, W } from "./fixtures.mjs";

const { twilioDriver, signatureFor, verifySignature, markerHash, STATUS_HOOK } = await import("../../../netlify/lib/crm/adapters/sms-twilio.mjs");
const { postmarkDriver } = await import("../../../netlify/lib/crm/adapters/email-postmark.mjs");
const { gbpDriver, cleanComment } = await import("../../../netlify/lib/crm/adapters/gbp.mjs");
const A = await import("../../../netlify/lib/crm/adapters/index.mjs");
const { deployContext } = await import("../../../netlify/lib/crm/core/context.mjs");
const { settleTwilio } = await import("../../../netlify/lib/crm/modules/comms/sink.mjs");
const ENV = { TWILIO_ACCOUNT_SID: SID, TWILIO_AUTH_TOKEN: TOKEN, POSTMARK_SERVER_TOKEN: "pm-test-token" };
const sha = (s) => createHash("sha256").update(s).digest("hex");

test("the adapter gate: dry-run off production and without secrets; live is capped to test before cutover; the drivers are registered", () => {
  const dev = deployContext(new Request(HOST + "/"), {}, {});
  const prod = deployContext(new Request(HOST + "/"), { deploy: { context: "production" } }, { CRM_PRODUCTION: "1" });
  const mode = (kind, deploy, set, env, sys) => A.adapterSync(kind, { deploy, settings: { [kind]: set }, env: { CRM_PRODUCTION: "1", ...env }, mode: sys || { system_of_record: "rotor", paused: false } }).mode;
  for (const kind of ["sms", "email"]) {
    assert.ok(A.hasDriver(kind, "test") && A.hasDriver(kind, "live"));
    assert.equal(mode(kind, dev, { mode: "live" }, ENV), "dry_run", "never off the production deploy");
    assert.equal(mode(kind, prod, { mode: "dry_run" }, ENV), "dry_run", "the default setting");
    assert.equal(mode(kind, prod, { mode: "live" }, {}), "dry_run", "no secrets: dry run");
    assert.equal(mode(kind, prod, { mode: "test" }, ENV), "test");
    assert.equal(mode(kind, prod, { mode: "live" }, ENV), "test", "before cutover live acts as test (the staff allowlist only)");
    assert.equal(mode(kind, prod, { mode: "live" }, ENV, { system_of_record: "crm", paused: false }), "live");
    assert.equal(mode(kind, prod, { mode: "live" }, { ...ENV, CRM_FORCE_DRY_RUN: "1" }, { system_of_record: "crm", paused: false }), "dry_run");
    assert.equal(mode(kind, prod, { mode: "live" }, ENV, { system_of_record: "crm", paused: true }), "off", "paused: nothing");
  }
  assert.ok(A.hasDriver("reviews", "live"));
});

test("Twilio's signature: HMAC-SHA1 over the URL and the sorted parameters, compared in constant time", () => {
  const url = "https://www.bartawindowwashing.com/api/crm/hooks/twilio/sms";
  const params = { To: TEST_FROM, From: STAFF, Body: "Hello there", MessageSid: "SM" + "1".repeat(32), AccountSid: SID };
  const want = createHmac("sha1", TOKEN).update(url + "AccountSid" + SID + "BodyHello thereFrom" + STAFF + "MessageSid" + params.MessageSid + "To" + TEST_FROM).digest("base64");
  assert.equal(signatureFor(url, params, TOKEN), want);
  assert.equal(verifySignature(url, params, want, TOKEN), true);
  assert.equal(verifySignature(url, { ...params, Body: "Hello there!" }, want, TOKEN), false, "a changed body");
  assert.equal(verifySignature(url + "?x=1", params, want, TOKEN), false, "another address");
  assert.equal(verifySignature(url, params, want, "other-token"), false);
  assert.equal(verifySignature(url, params, "", TOKEN), false);
  assert.equal(verifySignature(url, params, want, ""), false, "no secret: nothing verifies");
  assert.match(markerHash("done/send/m-1"), /^[0-9a-f]{32}$/);
});

test("the Twilio driver in test mode: only the allowlist, only from the test number; the request is a form POST to Messages with Basic auth and a timeout", async () => {
  const { t } = await connected();
  const net = mockFetch([
    { match: /Messages\.json$/, respond: () => Response.json({ sid: "SM" + "b".repeat(32), status: "queued", error_code: null }, { status: 201 }) },
    { match: /Messages\.json\?/, respond: () => Response.json({ messages: [{ sid: "SM" + "c".repeat(32), status: "delivered", direction: "outbound-api", body: "On our way!", date_created: "Tue, 17 Nov 2026 15:00:01 +0000" }, { sid: "SMx", status: "received", direction: "inbound", body: "On our way!" }] }) },
  ]);
  try {
    const d = twilioDriver("test", { env: ENV });
    const send = (o) => scope(() => d.send({ to: STAFF, body: "On our way!", from: TEST_FROM, markerKey: "done/send/m-1", ...o }));
    assert.deepEqual(await scope(() => twilioDriver("test", { env: {} }).send({ to: STAFF, body: "x", from: TEST_FROM })), { status: "failed", error_code: "not_configured", segments: 0 });
    assert.equal((await send({ to: "+17635550199" })).error_code, "test_mode_recipient");
    assert.equal((await send({ from: "+17633143400" })).error_code, "test_number_missing", "never from the business number in test mode");
    assert.equal((await send({ to: "7635550150" })).error_code, "bad_number");
    assert.equal(net.calls.length, 0, "none of those made a request");
    const ok = await send({});
    assert.deepEqual(ok, { status: "queued", provider_id: "SM" + "b".repeat(32), segments: 1 });
    const c = net.calls[0];
    assert.equal(c.url, `https://api.twilio.com/2010-04-01/Accounts/${SID}/Messages.json`);
    assert.equal(c.method, "POST");
    assert.equal(c.headers.authorization, "Basic " + Buffer.from(`${SID}:${TOKEN}`).toString("base64"));
    const form = new URLSearchParams(c.body);
    assert.deepEqual([...form.keys()].sort(), ["Body", "From", "StatusCallback", "To"]);
    assert.equal(form.get("StatusCallback"), `${STATUS_HOOK}?m=${markerHash("done/send/m-1")}`);
    // an unclear send is looked up by number, time and body hash; an inbound copy never counts
    const hit = await scope(() => d.findSent({ to: STAFF, since: "2026-11-17T15:00:00.000Z", bodySha256: sha("On our way!") }));
    assert.deepEqual(hit, { provider_id: "SM" + "c".repeat(32), status: "sent" });
    assert.equal(await scope(() => d.findSent({ to: STAFF, since: "2026-11-17T15:00:00.000Z", bodySha256: sha("something else") })), null);
    assert.ok(net.calls.every((x) => /^https:\/\/api\.twilio\.com\/2010-04-01\/Accounts\/[^/]+\/Messages\.json/.test(x.url)), "only the Messages resource: no number, service or webhook is ever touched");
    assert.equal(await d.fetchMedia("https://evil.example/a.jpg"), null, "media only from Twilio's hosts");
  } finally { net.restore(); t.done(); }
});

test("the Twilio driver in live mode is refused while Rotor is the system of record; after cutover it sends through the Messaging Service", async () => {
  const { t } = await connected();
  const net = mockFetch([{ match: "api.twilio.com", respond: () => Response.json({ code: 21610, message: "unsubscribed" }, { status: 400 }) }]);
  try {
    const d = twilioDriver("live", { env: ENV });
    const mg = "MG" + "0123456789abcdef".repeat(2);
    const r = await scope(() => d.send({ to: "+17635550123", body: "Hi", from: mg }));
    assert.deepEqual([r.status, r.error_code], ["blocked", "rotor_in_charge"]);
    assert.equal(net.calls.length, 0);
    await store.settledWrite("sys/mode", { system_of_record: "crm", paused: false }, { onlyIfNew: true });
    const r2 = await scope(() => d.send({ to: "+17635550123", body: "Hi", from: mg }));
    assert.deepEqual([r2.status, r2.error_code], ["failed", "21610"], "the provider's refusal comes back with its code");
    const form = new URLSearchParams(net.calls[0].body);
    assert.equal(form.get("MessagingServiceSid"), mg);
    assert.equal(form.get("From"), null);
  } finally { net.restore(); t.done(); }
});

test("the Postmark driver: the same gates; one POST to /email with the server token", async () => {
  const { t } = await connected();
  const net = mockFetch([
    { match: "api.postmarkapp.com/email", respond: () => Response.json({ MessageID: "0a1b2c3d-0000-4000-8000-00000000e002", ErrorCode: 0 }) },
    { match: "api.postmarkapp.com/messages/outbound", respond: () => Response.json({ Messages: [{ MessageID: "0a1b2c3d-0000-4000-8000-00000000e002" }] }) },
  ]);
  try {
    const d = postmarkDriver("test", { env: ENV });
    const msg = { to: "staff@example.com", from: "Barta Window Washing <office@bartawindowwashing.com>", replyTo: "office@bartawindowwashing.com", subject: "Hi", text: "Hello", html: "<p>Hello</p>", stream: "outbound", headers: { "X-Test": "1" }, tag: "note", metadata: { crm_marker: "done/send/m-2" } };
    assert.equal((await scope(() => postmarkDriver("test", { env: {} }).send(msg))).error_code, "not_configured");
    assert.equal((await scope(() => d.send({ ...msg, to: "customer@example.com" }))).error_code, "test_mode_recipient");
    assert.equal((await scope(() => postmarkDriver("live", { env: ENV }).send(msg))).error_code, "rotor_in_charge");
    assert.equal(net.calls.length, 0);
    assert.deepEqual(await scope(() => d.send(msg)), { status: "sent", provider_id: "0a1b2c3d-0000-4000-8000-00000000e002" });
    const c = net.calls[0];
    assert.deepEqual([c.url, c.method, c.headers["x-postmark-server-token"]], ["https://api.postmarkapp.com/email", "POST", "pm-test-token"]);
    const b = JSON.parse(c.body);
    assert.deepEqual([b.To, b.ReplyTo, b.MessageStream, b.Tag, b.Metadata.crm_marker, b.TrackOpens], ["staff@example.com", "office@bartawindowwashing.com", "outbound", "note", "done/send/m-2", false]);
    assert.deepEqual(await scope(() => d.findSent({ to: "staff@example.com", metadata: { crm_marker: "done/send/m-2" } })), { provider_id: "0a1b2c3d-0000-4000-8000-00000000e002", status: "sent" });
    assert.ok(net.calls.every((x) => /^https:\/\/api\.postmarkapp\.com\/(email|messages\/outbound)/.test(x.url)), "sending and looking up only: no domain, stream or webhook is changed");
  } finally { net.restore(); t.done(); }
});

test("Google reviews are only read: one token refresh, GETs of the reviews list, newest first, stopping at the last poll", async () => {
  const env = { GOOGLE_CLIENT_ID: "id", GOOGLE_CLIENT_SECRET: "secret", GOOGLE_REFRESH_TOKEN: "refresh", ACCOUNT_ID: "111", LOCATION_ID: "222" };
  const net = mockFetch([
    { match: "oauth2.googleapis.com/token", respond: () => Response.json({ access_token: "ya29.test" }) },
    { match: "mybusiness.googleapis.com/v4/accounts/111/locations/222/reviews", respond: () => Response.json({ reviews: [
      { reviewId: "r3", reviewer: { displayName: "Pat E." }, starRating: "FIVE", comment: "(Translated by Google) Great\n\n(Original)\nSpotless windows!", createTime: "2026-11-16T15:00:00Z", updateTime: "2026-11-16T15:00:00Z" },
      { reviewId: "r2", reviewer: { displayName: "Sam D" }, starRating: "FOUR", createTime: "2026-11-10T15:00:00Z", updateTime: "2026-11-10T15:00:00Z" },
      { reviewId: "r1", reviewer: { displayName: "Old One" }, starRating: "FIVE", createTime: "2026-10-01T15:00:00Z", updateTime: "2026-10-01T15:00:00Z" },
    ] }) },
  ]);
  try {
    assert.deepEqual(await gbpDriver({ env: {} }).listReviews({}), [], "no keys: nothing is asked");
    assert.equal(net.calls.length, 0);
    const list = await gbpDriver({ env }).listReviews({ since: "2026-11-01T00:00:00Z" });
    assert.deepEqual(list.map((r) => [r.id, r.reviewer, r.rating, r.comment]), [["r3", "Pat E.", 5, "Spotless windows!"], ["r2", "Sam D", 4, ""]]);
    assert.equal(cleanComment("(Translated by Google) Hello"), "Hello");
    const g = net.calls.filter((c) => c.url.includes("mybusiness"));
    assert.ok(g.length === 1 && g.every((c) => c.method === "GET" && /\/reviews\?/.test(c.url) && c.headers.authorization === "Bearer ya29.test"));
    assert.ok(!net.calls.some((c) => /reply|localPosts|media/.test(c.url)), "never a reply, never a post");
  } finally { net.restore(); }
});

test("a send whose answer never came is settled by looking it up, never by sending again", async () => {
  const { t } = await connected();
  const net = mockFetch([{ match: /Messages\.json\?/, respond: () => Response.json({ messages: [{ sid: "SM" + "d".repeat(32), status: "sent", direction: "outbound-api", body: "See you soon", date_created: "Tue, 17 Nov 2026 15:00:02 +0000" }] }) }]);
  try {
    const c = await staffContact();
    const marker = { provider: "twilio", at: "2026-11-17T15:00:00.000Z", body_sha256: sha("See you soon"), metadata: { crm_marker: "done/send/m-9", contact_id: c.id } };
    const prod = deployContext(new Request(HOST + "/"), {}, process.env);
    assert.deepEqual(await store.withStoreScope({ deploy: prod, requestId: "test" }, () => settleTwilio(marker)), { found: true, provider_ref: "SM" + "d".repeat(32) });
    assert.deepEqual(await store.withStoreScope({ deploy: prod, requestId: "test" }, () => settleTwilio({ ...marker, body_sha256: sha("other") })), { found: false });
    assert.equal(await store.withStoreScope({ deploy: prod, requestId: "test" }, () => settleTwilio({ ...marker, metadata: {} })), null, "no contact: can't tell");
    assert.ok(net.calls.every((x) => x.method === "GET"), "a lookup only");
  } finally { net.restore(); t.done(); }
});
