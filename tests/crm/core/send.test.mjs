// The sender (design §5.7.1 "Sending", §5.7.2, §7.3, §7.5; §11.4 M1.3
// send.test.mjs): dry-run writes only an outbox item and a done-dry/
// marker, never a message, a conversation, contact stats or activity; the
// opt-out footer on the first text per sending number and on every
// marketing text; categories and consent (suppression beats consent);
// automations_paused; a quiet-hours block defers the SAME marker; the
// duplicate guard; test mode's allowlist; the parallel-run guard forcing
// dry-run. Synthetic contacts only (555 numbers, example.com).
import { test, beforeEach, afterEach, mock } from "node:test";
import assert from "node:assert/strict";
import { stores, clearCrmStores, devDeploy, recordKicks, seedContact, seedImportedContact, seedStats } from "../../helpers/crm-fixtures.mjs";
import { pin, unpin, advance, minutes, now } from "../../helpers/crm-clock.mjs";
import { crmTest } from "../../helpers/crm-http.mjs";

await import("../../../netlify/lib/crm/modules/index.mjs");
const store = await import("../../../netlify/lib/crm-store.mjs");
const S = await import("../../../netlify/lib/crm/core/send.mjs");
const Q = await import("../../../netlify/lib/crm/core/queue.mjs");
const W = await import("../../../netlify/lib/crm/core/worker.mjs");
const A = await import("../../../netlify/lib/crm/adapters/index.mjs");
const { deployContext } = await import("../../../netlify/lib/crm/core/context.mjs");
const { clearSweepCache } = await import("../../../netlify/lib/crm/core/sweeps.mjs");
const { clearTemplateSeedCache } = await import("../../../netlify/lib/crm/core/templates.mjs");

const HOST = "https://www.bartawindowwashing.com";
const W8 = { by: "system", origin: "api", actor_kind: "user", requestId: "test" };
const PROD_ENV = { CONTEXT: "production", CRM_PRODUCTION: "1", CRM_KEY_SALT: "test-salt-not-real" };

let D, kicks, quiet, deploy, savedEnv;
const scope = (fn, dep = deploy) => store.withStoreScope({ deploy: dep, requestId: "test" }, fn);
const send = (msg, ctx = {}, dep = deploy) => scope(() => S.sendMessage(msg, { ...W8, deploy: dep, ...ctx }), dep);
const template = (data) => scope(() => store.createRecord("template", { tags: [], active: true, built_in: false, ...data }, W8));
const keysOf = () => D.data.keys("");

function setEnv(env) {
  savedEnv = savedEnv || {};
  for (const [k, v] of Object.entries(env)) { if (!(k in savedEnv)) savedEnv[k] = process.env[k]; process.env[k] = v; }
}

beforeEach(async () => {
  D = stores();
  pin("2026-11-17T17:00:00Z");           // 11:00 in Delano: inside every window
  clearSweepCache();
  clearTemplateSeedCache();
  kicks = recordKicks();
  quiet = ["error", "log", "warn"].map((m) => mock.method(console, m, () => {}));
  deploy = devDeploy();
  savedEnv = null;
  await template({ key: "visit_note", name: "Visit note", channel: "sms", category: "service", body: "Hi {{first_name|there}}, see you {{visit_date}}." });
  await template({ key: "promo_note", name: "Promo", channel: "sms", category: "marketing", body: "{{first_name|Hi}}, fall special this week." });
  await template({ key: "promo_email", name: "Promo email", channel: "email", category: "marketing", subject: "Fall special", body: "Hi {{first_name|there}}, fall special this week." });
  await template({ key: "plain_note", name: "Plain", channel: "sms", category: "service", body: "Hi {{first_name|there}}, thanks from {{company_name}}." });
});
afterEach(() => {
  for (const q of quiet) q.mock.restore();
  kicks.restore();
  for (const [k, v] of Object.entries(savedEnv || {})) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
  A.__unregisterAdapterForTests("sms", "test");
  A.__unregisterAdapterForTests("sms", "live");
  clearCrmStores();
  unpin();
});

test("dry-run writes only an outbox item and a done-dry/ marker: no message, conversation, stats, activity or audit", async () => {
  const c = await scope(() => seedContact(1));
  const before = new Set(keysOf());
  const r = await send({ contact_id: c.id, channel: "sms", template_key: "visit_note", vars: { visit_date: "Wed, Nov 19" }, origin: { kind: "automation", id: "fixture" } });
  assert.equal(r.status, "dry_run");
  assert.equal(r.mode, "dry_run");
  const added = keysOf().filter((k) => !before.has(k));
  assert.ok(added.length > 0);
  for (const k of added) assert.match(k, /^(rec\/outbox\/|rel\/outbox-day\/|rel\/contact-outbox\/|done-dry\/)/, `unexpected write ${k}`);
  assert.ok(added.some((k) => k.startsWith("rec/outbox/")), "one outbox item");
  assert.equal(added.filter((k) => k.startsWith("rec/outbox/")).length, 1);
  assert.ok(added.some((k) => k.startsWith("done-dry/send/")), "its done-dry/ marker");
  for (const bad of ["rec/message/", "rec/conversation/", "rec/contact_stats/", "rel/contact-activity/", "aud/", "evt/", "done/"]) {
    assert.ok(!added.some((k) => k.startsWith(bad)), `nothing under ${bad}`);
  }
  const ob = D.data.json(added.find((k) => k.startsWith("rec/outbox/")));
  assert.equal(ob.mode, "dry_run");
  assert.equal(ob.kind, "sms");
  assert.equal(ob.to_masked, "(763) •••-0101");
  assert.match(ob.body, /^Hi Sam, see you Wed, Nov 19\./);
  assert.equal(D.data.json(added.find((k) => k.startsWith("done-dry/send/"))).state, "done");
});

test("on the production host every send is an outbox item and nothing reaches Twilio, Stripe or Postmark", async () => {
  const t = await crmTest({ env: PROD_ENV });
  try {
    const owner = await t.user("owner");
    const c = await store.withStoreScope({ requestId: "t" }, () => seedContact(4));
    await store.withStoreScope({ requestId: "t" }, () => store.createRecord("template", { key: "hello_note", name: "Hello", channel: "sms", category: "service", body: "Hi {{first_name|there}}.", tags: [], active: true }, W8));
    const res = await t.api("/messages", { method: "POST", as: owner, body: { contact_id: c.id, channel: "sms", template_key: "hello_note", client_id: "client-0001-abcd" } });
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.equal(res.body.data.status, "dry_run");
    assert.ok(res.body.data.outbox_id);
    const again = await t.api("/messages", { method: "POST", as: owner, body: { contact_id: c.id, channel: "sms", template_key: "hello_note", client_id: "client-0001-abcd" } });
    assert.equal(again.body.data.status, "already", "the same client id sends once");
    assert.ok(!t.fetchCalls().some((f) => /twilio\.com|api\.stripe\.com|postmarkapp\.com/.test(f.url)), "no provider call");
    assert.equal(t.stores.data.keys("rec/outbox/").length, 1);
  } finally {
    t.done();
  }
});

test("footer: the first text per sending number and every marketing text; templates never carry STOP text", async () => {
  const fresh = await scope(() => seedContact(2, { consent: { sms_marketing: { state: "granted", source: "giveaway_optin" } } }));
  const known = await scope(() => seedContact(3, { consent: { sms_marketing: { state: "granted", source: "giveaway_optin" } } }));
  await scope(() => seedStats(known.id, { comms: { first_sms: { [S.MAIN_NUMBER]: "2026-03-01T15:00:00.000Z" }, last_contacted_at: null, last_inbound_at: null } }));
  const body = async (r) => D.data.json(`rec/outbox/${r.outbox_id}`).body;

  const a = await send({ contact_id: fresh.id, channel: "sms", template_key: "plain_note", origin: { kind: "automation" } });
  assert.equal(a.footer_appended, true);
  assert.ok((await body(a)).endsWith(" Reply STOP to opt out."), "first text to that phone from the main number");
  const b = await send({ contact_id: known.id, channel: "sms", template_key: "plain_note", origin: { kind: "automation" } });
  assert.equal(b.footer_appended, false);
  assert.doesNotMatch(await body(b), /STOP/, "a service text after the first carries no footer");
  const m = await send({ contact_id: known.id, channel: "sms", template_key: "promo_note", origin: { kind: "campaign" } });
  assert.equal(m.footer_appended, true);
  assert.ok((await body(m)).endsWith(" Reply STOP to opt out."), "every marketing text");
  const p = await send({ contact_id: known.id, channel: "sms", body: "Running 10 min late, sorry!", origin: { kind: "user", user_id: "us_00000000000000000001" } });
  assert.equal(p.footer_appended, false, "a person's text after the first: no footer");

  // the first text from ANOTHER sending number (the pre-cutover test number) is identified again
  assert.equal(S.needsFooter({ category: "service", firstSms: { [S.MAIN_NUMBER]: "x" }, number: "+17635550150", footer: {} }), true);
  assert.equal(S.needsFooter({ category: "service", firstSms: { "+17635550150": "x" }, number: "+17635550150", footer: {} }), false);
  assert.equal(S.needsFooter({ category: "marketing", firstSms: { "+17635550150": "x" }, number: "+17635550150", footer: { marketing: false } }), false);

  // templates never contain STOP text (barta-rules §8): the sender adds it
  await assert.rejects(() => template({ key: "bad_one", name: "Bad", channel: "sms", category: "service", body: "Hi {{first_name}}. Reply STOP to opt out." }), (e) => e.name === "InputError" && /STOP/.test(e.message));
  await assert.rejects(() => template({ key: "bad_two", name: "Bad", channel: "sms", category: "marketing", body: "Deal! Text STOP to end." }), (e) => e.name === "InputError");
});

test("the footer's first-text rule follows the sending number in test mode, and a live send records the first text", async () => {
  setEnv({ ...PROD_ENV, TWILIO_ACCOUNT_SID: "AC-test-not-real", TWILIO_AUTH_TOKEN: "not-real" });
  const prod = deployContext(new Request(HOST + "/"), {});
  const sent = [];
  A.registerAdapter("sms", "test", { async send(a) { sent.push(a); return { status: "queued", provider_id: "SM" + sent.length }; } });
  const staff = await scope(() => seedContact(5, { flags: { test: true }, shadow: undefined }), prod);
  await scope(() => seedStats(staff.id, { comms: { first_sms: { [S.MAIN_NUMBER]: "2026-01-02T00:00:00.000Z" }, last_contacted_at: null, last_inbound_at: null } }), prod);
  await scope(async () => {
    await store.putSetting("integrations", { sms: { mode: "live", test_from: "+17635550150", test_allowlist: [staff.phones[0].e164] } }, { ...W8, origin: "worker" });
  }, prod);
  const r1 = await send({ contact_id: staff.id, channel: "sms", template_key: "plain_note", origin: { kind: "automation" } }, {}, prod);
  assert.equal(r1.mode, "test", "before cutover live acts as test");
  assert.equal(r1.status, "queued");
  assert.equal(sent.length, 1);
  assert.equal(sent[0].from, "+17635550150", "test sends go from the test number");
  assert.ok(sent[0].body.endsWith(" Reply STOP to opt out."), "the first text from the test number gets the footer");
  assert.equal(D.data.json(`rec/contact_stats/${staff.id}`).comms.first_sms["+17635550150"] !== undefined, true, "first_sms[test number] recorded");
  assert.equal(D.data.keys("rec/outbox/").length, 0, "a real send writes no outbox item");
  const r2 = await send({ contact_id: staff.id, channel: "sms", template_key: "visit_note", vars: { visit_date: "Thu, Nov 20" }, origin: { kind: "automation" } }, {}, prod);
  assert.equal(r2.status, "queued");
  assert.doesNotMatch(sent[1].body, /STOP/, "the second text from that number has none");
  const done = D.data.keys("done/send/").map((k) => D.data.json(k));
  assert.ok(done.every((m) => m.state === "done" && m.provider_ref), "live markers end done with the provider's id");

  // test mode sends only to the allowlist
  const other = await scope(() => seedContact(6, { flags: { test: true } }), prod);
  const r3 = await send({ contact_id: other.id, channel: "sms", template_key: "plain_note", origin: { kind: "user", user_id: "us_00000000000000000001" } }, {}, prod);
  assert.equal(r3.status, "blocked");
  assert.equal(r3.blocked_reason, "test_mode_recipient");
  assert.equal(sent.length, 2);

  // before cutover an automated send to a contact Rotor owns is dry-run, whatever the mode
  const imported = await scope(() => seedImportedContact(7), prod);
  await scope(() => store.putSetting("integrations", { sms: { mode: "live", test_from: "+17635550150", test_allowlist: [staff.phones[0].e164, imported.phones[0].e164] } }, { ...W8, origin: "worker" }), prod);
  const r4 = await send({ contact_id: imported.id, channel: "sms", template_key: "plain_note", origin: { kind: "automation" } }, {}, prod);
  assert.equal(r4.status, "dry_run");
  assert.equal(sent.length, 2, "the parallel-run guard keeps it in the outbox");
});

test("categories and consent: marketing SMS needs granted; service SMS and marketing email only not revoked; suppression beats consent", async () => {
  const unknown = await scope(() => seedContact(10));
  const granted = await scope(() => seedContact(11, { consent: { sms_marketing: { state: "granted" } } }));
  const revokedSvc = await scope(() => seedContact(12, { consent: { sms_service: { state: "revoked" } } }));
  const revokedMail = await scope(() => seedContact(13, { consent: { email_marketing: { state: "revoked" } } }));
  const auto = { kind: "campaign", id: "bk_test" };

  assert.equal((await send({ contact_id: unknown.id, channel: "sms", template_key: "promo_note", origin: auto })).blocked_reason, "no_consent");
  assert.equal((await send({ contact_id: granted.id, channel: "sms", template_key: "promo_note", origin: auto })).status, "dry_run");
  assert.equal((await send({ contact_id: unknown.id, channel: "sms", template_key: "plain_note", origin: auto })).status, "dry_run", "service SMS: unknown is fine");
  assert.equal((await send({ contact_id: revokedSvc.id, channel: "sms", template_key: "plain_note", origin: auto })).blocked_reason, "no_consent");
  assert.equal((await send({ contact_id: unknown.id, channel: "email", template_key: "promo_email", origin: auto })).status, "dry_run", "marketing email is opt-out");
  assert.equal((await send({ contact_id: revokedMail.id, channel: "email", template_key: "promo_email", origin: auto })).blocked_reason, "no_consent");

  // suppression beats consent (an inbound STOP writes sup/, never the contact)
  const hk = store.hk("phone", granted.phones[0].e164);
  await scope(() => store.settledWrite(`sup/sms/${hk}`, { state: "opted_out", at: now().toISOString(), source: "keyword", masked: "(763) •••-0111" }, { onlyIfNew: true }));
  const blocked = await send({ contact_id: granted.id, channel: "sms", template_key: "promo_note", origin: auto });
  assert.equal(blocked.status, "blocked");
  assert.equal(blocked.blocked_reason, "opted_out");
  const ob = D.data.json(`rec/outbox/${blocked.outbox_id}`);
  assert.equal(ob.mode, "blocked", "a blocked send is in the outbox with its reason");
  assert.equal(ob.blocked_reason, "opted_out");

  // no address, missing variable
  const noPhone = await scope(() => seedContact(14, { phones: [] }));
  assert.equal((await send({ contact_id: noPhone.id, channel: "sms", template_key: "plain_note", origin: auto })).blocked_reason, "no_address");
  assert.equal((await send({ contact_id: unknown.id, channel: "sms", template_key: "visit_note", origin: auto })).blocked_reason, "missing_variable", "{{visit_date}} has no fallback (B9)");
});

test("automations_paused: automated and cadence sends skip; a person's send still goes", async () => {
  const c = await scope(() => seedContact(20, { automations_paused: { sms: { reason: "call me", by: "us_00000000000000000001", at: "2026-11-01T00:00:00.000Z" } } }));
  assert.equal((await send({ contact_id: c.id, channel: "sms", template_key: "plain_note", origin: { kind: "automation" } })).blocked_reason, "paused_automations");
  assert.equal((await send({ contact_id: c.id, channel: "sms", template_key: "plain_note", origin: { kind: "cadence" } })).blocked_reason, "paused_automations");
  assert.equal((await send({ contact_id: c.id, channel: "sms", body: "Calling you in 5.", origin: { kind: "user", user_id: "us_00000000000000000001" } })).status, "dry_run");
  assert.equal((await send({ contact_id: c.id, channel: "email", template_key: "promo_email", origin: { kind: "automation" } })).status, "dry_run", "paused for texts only");
});

test("quiet hours: a queued step is deferred to 08:00 under the SAME marker, then sent once", async () => {
  pin("2026-11-17T04:00:00Z");               // 22:00 Nov 16 in Delano
  const c = await scope(() => seedContact(30));
  const marker = { ns: "done-dry", scope: "fixture.reminder", key: `${c.id}--1` };
  const key = await scope(() => Q.enqueue("send.message", { type: "contact", id: c.id }, {}, now(), marker, { kick: false, data: { msg: { contact_id: c.id, channel: "sms", template_key: "plain_note", origin: { kind: "automation", id: "fixture" }, category: "service" } } }));
  await scope(() => W.runPass("fast", { deploy, holder: "fast-1" }));
  const mk = D.data.json(`done-dry/fixture.reminder/${c.id}--1`);
  assert.equal(mk.state, "claimed");
  assert.equal(mk.deferred_until, "2026-11-17T14:00:00.000Z", "08:00 local the next morning");
  assert.equal(D.data.has(key), false, "the old queue key is gone");
  assert.equal(D.data.keys("q/2026-11-17/1400--").length, 1, "one item owns the marker, due 14:00 UTC");
  assert.equal(D.data.keys("rec/outbox/").length, 0, "nothing recorded while deferred");

  pin("2026-11-17T14:00:30Z");
  await scope(() => W.runPass("fast", { deploy, holder: "fast-2" }));
  const after = D.data.json(`done-dry/fixture.reminder/${c.id}--1`);
  assert.equal(after.state, "done");
  assert.deepEqual(D.data.keys("done-dry/fixture.reminder/"), [`done-dry/fixture.reminder/${c.id}--1`], "the same marker, never a second one");
  assert.ok(after.trail.filter((x) => x.state === "claimed").length >= 2, "claimed, deferred (claimed again), then done: one marker's history");
  assert.equal(D.data.keys("rec/outbox/").length, 1);
  assert.equal(D.data.keys("q/").length, 0);

  // a person's service send at night is scheduled, not sent
  pin("2026-11-17T04:30:00Z");
  const r = await send({ contact_id: c.id, channel: "sms", template_key: "visit_note", vars: { visit_date: "Wed, Nov 19" }, origin: { kind: "user", user_id: "us_00000000000000000001" } });
  assert.equal(r.status, "scheduled");
  assert.equal(r.send_at, "2026-11-17T14:00:00.000Z");
  // a person's own words go any time
  assert.equal((await send({ contact_id: c.id, channel: "sms", body: "Thanks again!", origin: { kind: "user", user_id: "us_00000000000000000001" } })).status, "dry_run");
  // marketing waits for 09:00 and never goes on a Sunday
  const granted = await scope(() => seedContact(31, { consent: { sms_marketing: { state: "granted" } } }));
  pin("2026-11-22T18:00:00Z");                 // Sunday noon
  const sun = await send({ contact_id: granted.id, channel: "sms", template_key: "promo_note", origin: { kind: "user", user_id: "us_00000000000000000001" } });
  assert.equal(sun.status, "scheduled");
  assert.equal(sun.send_at, "2026-11-23T15:00:00.000Z", "Monday 09:00");
});

test("duplicate guard: the same body to the same phone within 10 minutes is blocked", async () => {
  const c = await scope(() => seedContact(40));
  const msg = { contact_id: c.id, channel: "sms", body: "See you Wednesday!", origin: { kind: "user", user_id: "us_00000000000000000001" } };
  assert.equal((await send(msg)).status, "dry_run");
  const dup = await send(msg);
  assert.equal(dup.status, "blocked");
  assert.equal(dup.blocked_reason, "duplicate");
  assert.equal((await send({ ...msg, body: "See you Thursday!" })).status, "dry_run", "a different body is fine");
  advance(minutes(11));
  assert.equal((await send(msg)).status, "dry_run", "after the window it goes again");
});

test("paused after a restore: a person's send answers 409; automation skips without a trace", async () => {
  const c = await scope(() => seedContact(50));
  await scope(() => store.settledWrite("sys/mode", { system_of_record: "rotor", paused: true, cutover_n: 0 }, { onlyIfNew: true }));
  await assert.rejects(() => send({ contact_id: c.id, channel: "sms", body: "Hi", origin: { kind: "user", user_id: "us_00000000000000000001" } }), (e) => e.name === "ConflictError");
  const r = await send({ contact_id: c.id, channel: "sms", template_key: "plain_note", origin: { kind: "automation" } });
  assert.equal(r.status, "skipped");
  assert.equal(D.data.keys("rec/outbox/").length, 0);
});

test("the dry-run adapter's magic values: a filtered number fails with 30007", async () => {
  const c = await scope(() => seedContact(60, { phones: [{ e164: "+17635550199", label: "mobile", primary: true, sms: true }] }));
  const r = await send({ contact_id: c.id, channel: "sms", body: "Hi there", origin: { kind: "user", user_id: "us_00000000000000000001" } });
  assert.equal(r.status, "dry_run");
  assert.equal(r.simulated, "failed");
  assert.deepEqual(D.data.json(`rec/outbox/${r.outbox_id}`).simulated, { status: "failed", code: "30007" });
});

test("marketing email carries an unsubscribe link and RFC 8058 one-click headers when it really goes out", async () => {
  setEnv({ ...PROD_ENV, POSTMARK_SERVER_TOKEN: "not-real" });
  const prod = deployContext(new Request(HOST + "/"), {});
  const sent = [];
  A.registerAdapter("email", "test", { async send(a) { sent.push(a); return { status: "sent", provider_id: "pm-1" }; } });
  try {
    const staff = await scope(() => seedContact(70, { flags: { test: true } }), prod);
    await scope(() => store.putSetting("integrations", { email: { mode: "live", test_allowlist: [staff.emails[0].address] } }, { ...W8, origin: "worker" }), prod);
    const r = await send({ contact_id: staff.id, channel: "email", template_key: "promo_email", origin: { kind: "campaign" } }, {}, prod);
    assert.equal(r.status, "sent");
    assert.equal(sent.length, 1);
    assert.match(sent[0].headers["List-Unsubscribe"], /^<https:\/\/www\.bartawindowwashing\.com\/api\/portal\/unsubscribe\/[0-9A-Za-z]{10}>$/);
    assert.equal(sent[0].headers["List-Unsubscribe-Post"], "List-Unsubscribe=One-Click");
    assert.match(sent[0].text, /Unsubscribe: https:\/\/www\.bartawindowwashing\.com\/p\/unsubscribe\/[0-9A-Za-z]{10}$/);
    assert.match(sent[0].html, /Unsubscribe<\/a>/);
    assert.equal(sent[0].stream, "broadcast");
    // the dry-run outbox shows where the footer goes without making a link
    const plain = await scope(() => seedContact(71));
    const d = await send({ contact_id: plain.id, channel: "email", template_key: "promo_email", origin: { kind: "campaign" } });
    assert.match(D.data.json(`rec/outbox/${d.outbox_id}`).body, /Unsubscribe: https:\/\/www\.bartawindowwashing\.com\/p\/unsubscribe\/…$/);
  } finally {
    A.__unregisterAdapterForTests("email", "test");
  }
});

// ------------------------------------------------------------ M1.3 review: the sender fails closed

test("a staff-category send that reaches a customer follows the service rules: consent, quiet hours and the footer", async () => {
  // people can't make a "staff" template (it would skip every customer rule)
  await assert.rejects(() => template({ key: "promo_staff", name: "Staff promo", channel: "sms", category: "staff", body: "Fall special: 20% off this week!" }), (e) => e.name === "InputError" && e.field === "category");
  await template({ key: "staff_ping", name: "Staff ping", channel: "sms", category: "staff", body: "New lead waiting.", built_in: true });
  const revoked = await scope(() => seedContact(80, { consent: { sms_service: { state: "revoked" }, sms_marketing: { state: "unknown" } } }));
  const r = await send({ contact_id: revoked.id, channel: "sms", template_key: "staff_ping", origin: { kind: "user", user_id: "us_00000000000000000001" } });
  assert.equal(r.status, "blocked");
  assert.equal(r.blocked_reason, "no_consent", "a revoked contact never gets it");
  const ok = await scope(() => seedContact(81));
  const r2 = await send({ contact_id: ok.id, channel: "sms", template_key: "staff_ping", origin: { kind: "automation", id: "fixture" } });
  assert.equal(r2.footer_appended, true, "the first text to that phone gets the opt-out footer");
  assert.equal(D.data.json(`rec/outbox/${r2.outbox_id}`).category, "service");
  // quiet hours apply (22:00 in Delano): the person's send is scheduled, not sent
  pin("2026-11-18T04:00:00Z");
  const r3 = await send({ contact_id: ok.id, channel: "sms", template_key: "staff_ping", category: "staff", origin: { kind: "user", user_id: "us_00000000000000000001" }, marker_key: "m-staff-night" });
  assert.equal(r3.status, "scheduled");
  // an internal text to a staff phone (msg.to, no contact) stays "staff"
  const r4 = await send({ channel: "sms", category: "staff", to: "+17635550142", body: "New lead waiting.", origin: { kind: "system" } });
  assert.equal(r4.status, "dry_run");
  assert.equal(D.data.json(`rec/outbox/${r4.outbox_id}`).footer_appended, false);
});

test("a failed read of the suppression list never sends: no provider call, no outbox item", async () => {
  setEnv({ ...PROD_ENV, TWILIO_ACCOUNT_SID: "AC-test-not-real", TWILIO_AUTH_TOKEN: "not-real" });
  const prod = deployContext(new Request(HOST + "/"), {});
  const sent = [];
  A.registerAdapter("sms", "test", { async send(a) { sent.push(a); return { status: "queued", provider_id: "SM1" }; } });
  const staff = await scope(() => seedContact(82, { flags: { test: true } }), prod);
  await scope(() => store.putSetting("integrations", { sms: { mode: "live", test_from: "+17635550150", test_allowlist: [staff.phones[0].e164] } }, { ...W8, origin: "worker" }), prod);
  const hkey = store.hk("phone", staff.phones[0].e164);
  await scope(() => store.settledWrite(`sup/sms/${hkey}`, { state: "opted_out", at: "2026-11-16T00:00:00Z", source: "keyword", masked: "x" }, { onlyIfNew: true }), prod);
  const msg = (k) => ({ contact_id: staff.id, channel: "sms", template_key: "plain_note", origin: { kind: "user", user_id: "us_00000000000000000001" }, marker_key: k });
  assert.equal((await send(msg("m-control"), {}, prod)).blocked_reason, "opted_out", "control");
  D.data.fail({ op: ["get", "getWithMetadata"], key: `sup/sms/${hkey}`, kind: "timeout", times: 10 });
  await assert.rejects(() => send(msg("m-blink"), {}, prod), (e) => e.name === "BlobsTransientError", "a person's send answers 503 busy");
  D.data.clearHooks();
  assert.equal(sent.length, 0, "nothing reached the provider");
  assert.ok(!D.data.keys("rec/outbox/").map((k) => D.data.json(k)).some((o) => o.mode !== "blocked"), "no outbox item but the control's blocked one");
});

test("a failed read of sys/mode is never 'not paused': the sender and the adapters throw", async () => {
  setEnv({ ...PROD_ENV, TWILIO_ACCOUNT_SID: "AC-test-not-real", TWILIO_AUTH_TOKEN: "not-real" });
  const prod = deployContext(new Request(HOST + "/"), {});
  const sent = [];
  A.registerAdapter("sms", "test", { async send(a) { sent.push(a); return { status: "queued", provider_id: "SM1" }; } });
  const staff = await scope(() => seedContact(83, { flags: { test: true } }), prod);
  await scope(() => store.putSetting("integrations", { sms: { mode: "live", test_from: "+17635550150", test_allowlist: [staff.phones[0].e164] } }, { ...W8, origin: "worker" }), prod);
  await scope(() => store.settledWrite("sys/mode", { system_of_record: "rotor", paused: true, paused_reason: "restore", cutover_n: 0 }, { onlyIfNew: true }), prod);
  const msg = (k) => ({ contact_id: staff.id, channel: "sms", template_key: "plain_note", origin: { kind: "user", user_id: "us_00000000000000000001" }, marker_key: k });
  await assert.rejects(() => send(msg("m-control"), {}, prod), /paused/, "control: paused answers 409");
  D.data.fail({ op: ["get", "getWithMetadata"], key: "sys/mode", kind: "timeout", times: 20 });
  await assert.rejects(() => send(msg("m-blink"), {}, prod), (e) => e.name === "BlobsTransientError");
  await assert.rejects(() => scope(() => A.adapter("sms", { deploy: prod }), prod), (e) => e.name === "BlobsTransientError");
  D.data.clearHooks();
  assert.equal(sent.length, 0);
});

test("POST /messages: a retry after a failed send goes out; 'already' only for a step that finished", async () => {
  const t = await crmTest({ now: "2026-11-17T17:00:00Z" });
  try {
    const owner = await t.user("owner");
    const c = await store.withStoreScope({ requestId: "x" }, () => seedContact(84));
    const body = { contact_id: c.id, channel: "sms", body: "Running ten minutes late.", client_id: "client-0001-abcd" };
    t.stores.data.fail({ op: ["set", "setJSON"], key: /^rec\/outbox\//, kind: "timeout", times: 20 });
    const first = await t.api("/messages", { method: "POST", as: owner, body });
    t.stores.data.clearHooks();
    assert.equal(first.status, 503);
    const marker = t.stores.data.json(t.stores.data.keys("done-dry/send/")[0]);
    assert.equal(marker.state, "failed", "the claim was handed back");
    assert.ok(marker.retry_at);
    const retry = await t.api("/messages", { method: "POST", as: owner, body });
    assert.equal(retry.status, 200);
    assert.equal(retry.body.data.status, "dry_run", "the retry took the step over and recorded it");
    assert.equal(t.stores.data.keys("rec/outbox/").length, 1);
    const again = await t.api("/messages", { method: "POST", as: owner, body });
    assert.equal(again.body.data.status, "already");
    assert.equal(again.body.data.outbox_id, retry.body.data.outbox_id, "'already' names the outbox item it made");
    assert.equal(t.stores.data.keys("rec/outbox/").length, 1);
  } finally { t.done(); }
});

test("a direct send whose marker is still held answers busy (503), never 'already'", async () => {
  const c = await scope(() => seedContact(85));
  await scope(() => store.claimMarker("done-dry", "send", "msg-held-0001", { holder: "another-request", leaseMs: 60000 }));
  await assert.rejects(() => send({ contact_id: c.id, channel: "sms", body: "Hi", origin: { kind: "user", user_id: "us_00000000000000000001" }, marker_key: "msg-held-0001" }), (e) => e.name === "BlobsTransientError");
});

test("the footer counts by the number the text really goes out from (sms.from), and from must be a real number", async () => {
  setEnv({ ...PROD_ENV, TWILIO_ACCOUNT_SID: "AC-live-not-real", TWILIO_AUTH_TOKEN: "not-real" });
  const prod = deployContext(new Request(HOST + "/"), {});
  const sent = [];
  A.registerAdapter("sms", "live", { async send(a) { sent.push(a); return { status: "queued", provider_id: "SM1" }; } });
  await scope(() => store.settledWrite("sys/mode", { system_of_record: "crm", paused: false, cutover_n: 1 }, { onlyIfNew: true }), prod);
  const c = await scope(() => seedContact(86), prod);
  await scope(() => seedStats(c.id, { comms: { first_sms: { [S.MAIN_NUMBER]: "2026-01-02T00:00:00.000Z" }, last_contacted_at: null, last_inbound_at: null } }), prod);
  await assert.rejects(() => scope(() => store.putSetting("integrations", { sms: { mode: "live", from: "763-555-0177" } }, { ...W8, origin: "worker" }), prod), (e) => e.field === "sms.from");
  await scope(() => store.putSetting("integrations", { sms: { mode: "live", from: "+17635550177" } }, { ...W8, origin: "worker" }), prod);
  const r = await send({ contact_id: c.id, channel: "sms", template_key: "plain_note", origin: { kind: "user", user_id: "us_00000000000000000001" }, marker_key: "m-from-1" }, {}, prod);
  assert.equal(r.mode, "live");
  assert.equal(sent[0].from, "+17635550177");
  assert.match(sent[0].body, / Reply STOP to opt out\.$/, "the first text from the new number has the footer");
  assert.ok(D.data.json(`rec/contact_stats/${c.id}`).comms.first_sms["+17635550177"], "first_sms is keyed by the number used");
  assert.equal(S.sendingNumber({ sms: { number: "+17633143400", from: "+17635550177" } }, "live"), "+17635550177");
  assert.equal(S.sendingNumber({ sms: { number: "+17633143400", from: null, test_from: "+17635550150" } }, "test"), "+17635550150");
});

test("marketing quiet hours with no day saved: the setting is refused, and a window with no allowed minute blocks instead of throwing", async () => {
  await assert.rejects(() => scope(() => store.putSetting("messaging", { quiet: { marketing: { from: "09:00", to: "20:00", days: [] } } }, { ...W8, origin: "worker" })), (e) => e.name === "InputError" && /day/.test(e.message));
  // a stored value from before the check (written raw)
  await scope(() => store.settledWrite("cfg/messaging", { quiet: { marketing: { from: "09:00", to: "20:00", days: [] } } }, { onlyIfNew: true }));
  const c = await scope(() => seedContact(87, { consent: { sms_marketing: { state: "granted" } } }));
  const r = await send({ contact_id: c.id, channel: "sms", template_key: "promo_note", origin: { kind: "user", user_id: "us_00000000000000000001" } });
  assert.equal(r.status, "blocked");
  assert.equal(r.blocked_reason, "quiet_hours");
});
