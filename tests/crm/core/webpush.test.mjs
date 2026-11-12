// Web push (design §5.7.7; §11.4 M1.3 webpush.test.mjs): the RFC 8291
// Appendix A test vector byte for byte; a round trip through the user
// agent's side; the VAPID JWT (RFC 8292) verifies with the public key;
// the push gate (off without VAPID keys, live in production with them,
// dry-run elsewhere); notifications land in the bell and on every phone of
// a person; a 410 deletes the subscription; only real push services are
// ever called. Keys are generated in the test, never stored.
import { test, afterEach } from "node:test";
import assert from "node:assert/strict";
import { generateKeyPairSync, randomBytes, createECDH } from "node:crypto";
import { crmTest } from "../../helpers/crm-http.mjs";
import { strictFetch } from "../../helpers/crm-fetch.mjs";

const WP = await import("../../../netlify/lib/crm/core/webpush.mjs");
const A = await import("../../../netlify/lib/crm/adapters/index.mjs");
const { deployContext } = await import("../../../netlify/lib/crm/core/context.mjs");
const N = await import("../../../netlify/lib/crm/core/notify.mjs");
const store = await import("../../../netlify/lib/crm-store.mjs");

const HOST = "https://www.bartawindowwashing.com";

// RFC 8291 Appendix A.
const V = {
  plaintext: "V2hlbiBJIGdyb3cgdXAsIEkgd2FudCB0byBiZSBhIHdhdGVybWVsb24",
  asPrivate: "yfWPiYE-n46HLnH0KqZOF1fJJU3MYrct3AELtAQ-oRw",
  asPublic: "BP4z9KsN6nGRTbVYI_c7VJSPQTBtkgcy27mlmlMoZIIgDll6e3vCYLocInmYWAmS6TlzAC8wEqKK6PBru3jl7A8",
  uaPrivate: "q1dXpw3UpT5VOmu_cf_v6ih07Aems3njxI-JWgLcM94",
  uaPublic: "BCVxsr7N_eNgVRqvHtD0zTZsEc6-VV-JvLexhqUzORcxaOzi6-AYWXvTBHm4bjyPjs7Vd8pZGH6SRpkNtoIAiw4",
  salt: "DGv6ra1nlYgDCS1FRnbzlw",
  auth: "BTBZMqHH6r4Tts7J_aSIgg",
  body: "DGv6ra1nlYgDCS1FRnbzlwAAEABBBP4z9KsN6nGRTbVYI_c7VJSPQTBtkgcy27mlmlMoZIIgDll6e3vCYLocInmYWAmS6TlzAC8wEqKK6PBru3jl7A_yl95bQpu6cVPTpK4Mqgkf1CXztLVBSt2Ks3oZwbuwXPXLWyouBWLVWGNWQexSgSxsj_Qulcy4a-fN",
};

function vapidPair() {
  const { privateKey, publicKey } = generateKeyPairSync("ec", { namedCurve: "P-256" });
  const pub = publicKey.export({ format: "jwk" });
  const priv = privateKey.export({ format: "jwk" });
  const raw = Buffer.concat([Buffer.from([4]), WP.fromB64u(pub.x), WP.fromB64u(pub.y)]);
  return { publicKey: WP.b64u(raw), privateKey: priv.d };
}
function phoneKeys() {
  const ecdh = createECDH("prime256v1");
  ecdh.generateKeys();
  const auth = randomBytes(16);
  return { p256dh: WP.b64u(ecdh.getPublicKey()), auth: WP.b64u(auth), uaPrivate: ecdh.getPrivateKey(), authBytes: auth };
}

let t;
afterEach(() => { if (t) t.done(); t = null; });

test("RFC 8291 Appendix A: the aes128gcm body matches the test vector byte for byte", () => {
  const r = WP.encryptPayload({ p256dh: V.uaPublic, auth: V.auth }, WP.fromB64u(V.plaintext), { salt: WP.fromB64u(V.salt), asPrivate: WP.fromB64u(V.asPrivate) });
  assert.equal(WP.b64u(r.asPublic), V.asPublic);
  assert.equal(WP.b64u(r.body), V.body);
  // the header: salt, rs = 4096, idlen = 65, the server's public key
  assert.equal(r.body.readUInt32BE(16), 4096);
  assert.equal(r.body[20], 65);
  const back = WP.decryptPayload(r.body, { uaPrivate: WP.fromB64u(V.uaPrivate), auth: WP.fromB64u(V.auth) });
  assert.equal(back.toString("utf8"), "When I grow up, I want to be a watermelon");
});

test("a fresh payload round-trips through the user agent's side, with a new key and salt each time", () => {
  const ua = phoneKeys();
  const msg = JSON.stringify({ title: "New lead", body: "Pat in Delano", link: "/today" });
  const a = WP.encryptPayload(ua, msg);
  const b = WP.encryptPayload(ua, msg);
  assert.notEqual(WP.b64u(a.body), WP.b64u(b.body), "random salt and server key per message");
  assert.equal(WP.decryptPayload(a.body, { uaPrivate: ua.uaPrivate, auth: ua.authBytes }).toString(), msg);
  assert.throws(() => WP.encryptPayload({ p256dh: "AAAA", auth: ua.auth }, "x"), /p256dh/);
});

test("the VAPID JWT (RFC 8292) is ES256, aimed at the push service, expires within 24 h and verifies", () => {
  const keys = vapidPair();
  const jwt = WP.vapidJwt({ audience: "https://fcm.googleapis.com", subject: "mailto:office@bartawindowwashing.com", ...keys });
  const [h, c, s] = jwt.split(".");
  assert.deepEqual(JSON.parse(WP.fromB64u(h).toString()), { typ: "JWT", alg: "ES256" });
  const claims = JSON.parse(WP.fromB64u(c).toString());
  assert.equal(claims.aud, "https://fcm.googleapis.com");
  assert.equal(claims.sub, "mailto:office@bartawindowwashing.com");
  const left = claims.exp * 1000 - Date.parse("2026-11-17T15:00:00Z");
  assert.equal(WP.fromB64u(s).length, 64, "raw r||s, not DER");
  assert.equal(WP.verifyVapidJwt(jwt, keys.publicKey), true);
  assert.equal(WP.verifyVapidJwt(jwt, vapidPair().publicKey), false, "another key does not verify");
  const tampered = `${h}.${WP.b64u(JSON.stringify({ ...claims, aud: "https://evil.example" }))}.${s}`;
  assert.equal(WP.verifyVapidJwt(tampered, keys.publicKey), false);
  const req = WP.pushRequest({ endpoint: "https://fcm.googleapis.com/fcm/send/abc", keys: phoneKeys() }, { title: "x" }, { vapid: { ...keys, subject: "mailto:office@bartawindowwashing.com" } });
  assert.match(req.headers.Authorization, /^vapid t=[\w-]+\.[\w-]+\.[\w-]+, k=[\w-]+$/);
  assert.equal(req.headers["Content-Encoding"], "aes128gcm");
  assert.ok(Number.isFinite(left));
});

test("only real push services are accepted as endpoints", () => {
  for (const ok of ["https://fcm.googleapis.com/fcm/send/abc", "https://web.push.apple.com/QGt", "https://updates.push.services.mozilla.com/wpush/v2/x", "https://wns2-par02p.notify.windows.com/w/?token=x"]) assert.equal(WP.isPushEndpoint(ok), true, ok);
  for (const bad of ["http://fcm.googleapis.com/x", "https://evil.example/push", "https://fcm.googleapis.com.evil.example/x", ["https://user:pw", "fcm.googleapis.com/x"].join(String.fromCharCode(64)), "https://localhost/x", "https://169.254.169.254/x", "javascript:alert(1)",
    // other Google and Apple APIs are not push services: no VAPID-signed POST ever goes there
    "https://storage.googleapis.com/upload/storage/v1/b/x/o?uploadType=media&name=y", "https://www.googleapis.com/anything", "https://oauth2.googleapis.com/token", "https://api.push.apple.com/3/device/x"]) assert.equal(WP.isPushEndpoint(bad), false, bad);
});

test("the push gate: dry-run off production, off without the VAPID keys, live with them (before cutover too), off when paused", () => {
  const dev = deployContext(new Request(HOST + "/"), {}, {});
  const prod = deployContext(new Request(HOST + "/"), { deploy: { context: "production" } }, { CRM_PRODUCTION: "1" });
  assert.equal(A.pushMode(dev, {}, {}), "dry_run");
  assert.equal(A.pushMode(prod, {}, { CRM_PRODUCTION: "1" }), "off");
  const env = { CRM_PRODUCTION: "1", CRM_VAPID_PUBLIC: "x", CRM_VAPID_PRIVATE: "y" };
  assert.equal(A.pushMode(prod, {}, env), "live");
  assert.equal(A.pushMode(prod, { push: { mode: "off" } }, env), "off");
  assert.equal(A.pushMode(prod, { push: { mode: "dry_run" } }, env), "dry_run");
  assert.equal(A.pushMode(prod, {}, { ...env, CRM_FORCE_DRY_RUN: "1" }), "dry_run");
  assert.equal(A.pushMode(prod, {}, env, { paused: true }), "off");
  // an integration stays in the outbox until its driver exists, whatever the mode says (Meta has none yet)
  const a = A.adapterSync("meta", { deploy: prod, settings: { meta: { mode: "live" } }, env: { CRM_PRODUCTION: "1", META_PAGE_TOKEN: "x", META_APP_SECRET: "y" }, mode: { system_of_record: "crm", paused: false } });
  assert.equal(a.mode, "dry_run");
  assert.equal(a.fallback, "no_driver");
  // texts have their driver since Messages (M6): live only after cutover, capped to test before it, dry-run without the keys
  const sms = (mode, env) => A.adapterSync("sms", { deploy: prod, settings: { sms: { mode: "live" } }, env: { CRM_PRODUCTION: "1", ...env }, mode }).mode;
  const keys = { TWILIO_ACCOUNT_SID: "x", TWILIO_AUTH_TOKEN: "y" };
  assert.equal(sms({ system_of_record: "crm", paused: false }, keys), "live");
  assert.equal(sms({ system_of_record: "rotor", paused: false }, keys), "test");
  assert.equal(sms({ system_of_record: "crm", paused: false }, {}), "dry_run");
});

test("a notification reaches the bell and every phone; a 410 deletes that phone's subscription", async () => {
  const keys = vapidPair();
  t = await crmTest({ env: { CONTEXT: "production", CRM_PRODUCTION: "1", CRM_KEY_SALT: "test-salt-not-real", CRM_VAPID_PUBLIC: keys.publicKey, CRM_VAPID_PRIVATE: keys.privateKey } });
  const owner = await t.user("owner");
  const phoneA = phoneKeys();
  const phoneB = phoneKeys();
  const subA = { endpoint: "https://fcm.googleapis.com/fcm/send/phone-a", keys: { p256dh: phoneA.p256dh, auth: phoneA.auth } };
  const subB = { endpoint: "https://web.push.apple.com/phone-b", keys: { p256dh: phoneB.p256dh, auth: phoneB.auth } };
  const info = await t.api("/push/subscriptions", { as: owner });
  assert.equal(info.body.data.mode, "live");
  assert.equal(info.body.data.vapid_public, keys.publicKey, "the public key the shell subscribes with");
  for (const s of [subA, subB]) assert.equal((await t.api("/push/subscriptions", { method: "POST", as: owner, body: { subscription: s } })).status, 201);
  const bad = await t.api("/push/subscriptions", { method: "POST", as: owner, body: { subscription: { endpoint: "https://evil.example/x", keys: subA.keys } } });
  assert.equal(bad.status, 400);
  assert.equal((await t.api("/push/subscriptions", { as: owner })).body.data.subscriptions.length, 2);

  // the push services answer: Google takes it, Apple says the phone is gone
  const got = [];
  const saved = globalThis.fetch;
  const net = strictFetch([
    { match: /fcm\.googleapis\.com/, respond: (url, init) => { got.push({ url, init }); return new Response(null, { status: 201 }); } },
    { match: /web\.push\.apple\.com/, respond: () => new Response(null, { status: 410 }) },
  ]);
  try {
    const sent = await t.api("/push/test", { method: "POST", as: owner, body: {} });
    assert.equal(sent.status, 200);
    assert.equal(sent.body.data.mode, "live");
    await t.runWorker({ lane: "fast" });
  } finally {
    net.restore();
    globalThis.fetch = saved;
  }
  assert.equal(got.length, 1);
  assert.match(got[0].init.headers.Authorization, /^vapid t=/);
  const plain = JSON.parse(WP.decryptPayload(Buffer.from(got[0].init.body), { uaPrivate: phoneA.uaPrivate, auth: phoneA.authBytes }).toString());
  assert.equal(plain.title, "Test notification");
  assert.equal(plain.link, "/me");
  const left = (await t.api("/push/subscriptions", { as: owner })).body.data.subscriptions;
  assert.equal(left.length, 1, "the gone phone's subscription was deleted");
  const bell = await t.api("/notifications", { as: owner });
  assert.equal(bell.body.data.length, 1);
  assert.equal(bell.body.data[0].title, "Test notification");
  assert.equal((await t.api("/me/badges", { as: owner })).body.data.notifications, 1);
  const read = await t.api("/notifications/read", { method: "POST", as: owner, body: { all: true } });
  assert.equal(read.body.data.read, 1);
  assert.equal((await t.api("/me/badges", { as: owner })).body.data.notifications, 0);
  // a delivery that runs again makes no second notification
  assert.equal(t.stores.data.keys("rec/notification/").length, 1);
});

test("off production a push is a dry-run outbox item; nothing is fetched", async () => {
  t = await crmTest();
  const owner = await t.user("owner");
  const ua = phoneKeys();
  await t.api("/push/subscriptions", { method: "POST", as: owner, body: { subscription: { endpoint: "https://fcm.googleapis.com/fcm/send/dev", keys: { p256dh: ua.p256dh, auth: ua.auth } } } });
  await store.withStoreScope({ requestId: "t" }, () => N.notify([owner.id], { kind: "approval", title: "Waiting for your OK", body: "2 offline changes", link: "/approvals" }));
  await t.runWorker({ lane: "fast" });
  const ob = t.stores.data.keys("rec/outbox/").map((k) => t.stores.data.json(k));
  assert.equal(ob.length, 1);
  assert.equal(ob[0].kind, "push");
  assert.equal(ob[0].staff, true);
  assert.equal(t.fetchCalls().length, 0);
});
