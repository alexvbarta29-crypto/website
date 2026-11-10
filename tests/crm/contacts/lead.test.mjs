// M2a acceptance: the website's dual-write (design §11.4 "lead.test.mjs",
// §6.8): in dual mode lead.mjs calls Rotor first, then the CRM; either
// success answers 200; a failed side raises an alert. And the sacred part:
// with intake off (the default), or before the CRM's setup, nothing at all
// reaches the CRM and the visitor's answer is exactly Rotor's.
import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { fresh, store, contactKeys, hook } from "./fixtures.mjs";

process.env.ROTOR_API_KEY = "test-dummy-key-not-real";
const handler = (await import("../../../netlify/functions/lead.mjs")).default;
const claimHandler = (await import("../../../netlify/functions/claim.mjs")).default;

const SYS = { by: "system", origin: "worker", actor_kind: "automation", requestId: "t" };
const body = (n = 70) => ({
  first_name: "Test", last_name: "Person", phone: `(763) 555-01${n}`, email: `test.person${n}@example.com`,
  address_street: `${n} Example Ave`, address_city: "Delano", address_state: "MN", address_zip: "55328",
  services: ["Exterior Window Cleaning"], plan: "quarterly", referral_source: "Yard Sign", notes: "Dog in the yard.", reminders: "on",
});
const post = (b, context) => handler(new Request("http://localhost/api/lead", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(b) }), context);

let env;
let calls;
let rotor;
beforeEach(() => {
  env = fresh();
  calls = [];
  rotor = { status: 201, body: { id: "rl-0000-0001" } };
  globalThis.fetch = async (url, options) => {
    calls.push({ url: String(url), at: calls.length });
    if (String(url).includes("getrotor.com")) {
      if (rotor.status === "throw") throw new TypeError("fetch failed");
      return new Response(JSON.stringify(rotor.body), { status: rotor.status });
    }
    throw new TypeError("unexpected request");
  };
});
afterEach(() => env.done());

const setMode = (mode) => store.putSetting("intake", { mode }, SYS);
// a Netlify context whose waitUntil collects the work done after the answer
const ctxWait = () => { const list = []; return { list, context: { waitUntil: (p) => list.push(p) } }; };

test("intake off (the default): Rotor only, the answer is Rotor's, and the CRM is never written", async () => {
  const res = await post(body());
  assert.equal(res.status, 200);
  assert.equal(calls.length, 1);
  assert.equal(contactKeys(env.S).length, 0);
  assert.deepEqual(env.S.data.keys("").filter((k) => !k.startsWith("cfg/")), [], "nothing written at all");
  rotor.status = 500;
  assert.equal((await post(body())).status, 502, "a Rotor failure still answers 502");
});

test("before the CRM's Netlify setup: nothing at all, not even a read", async () => {
  await setMode("dual");
  const saved = { CONTEXT: process.env.CONTEXT, CRM_PRODUCTION: process.env.CRM_PRODUCTION };
  process.env.CONTEXT = "production";
  delete process.env.CRM_PRODUCTION;
  try {
    const before = env.S.data.calls.length;
    const res = await post(body());
    assert.equal(res.status, 200);
    assert.equal(env.S.data.calls.length, before, "no store call");
  } finally {
    if (saved.CONTEXT === undefined) delete process.env.CONTEXT; else process.env.CONTEXT = saved.CONTEXT;
    if (saved.CRM_PRODUCTION !== undefined) process.env.CRM_PRODUCTION = saved.CRM_PRODUCTION;
  }
});

test("dual: Rotor first (byte-identical payload), then the CRM after the answer, with Rotor's lead id", async () => {
  await setMode("dual");
  const w = ctxWait();
  let rotorPayload = null;
  const plain = globalThis.fetch;
  globalThis.fetch = async (url, options) => { rotorPayload = JSON.parse(options.body); return plain(url, options); };
  const res = await post(body(71), w.context);
  assert.equal(res.status, 200);
  assert.equal(contactKeys(env.S).length, 0, "the answer didn't wait for the CRM");
  assert.equal(w.list.length, 1);
  await Promise.all(w.list);
  assert.equal(contactKeys(env.S).length, 1);
  const p = await store.readPointer("rotor/lead", "rl-0000-0001");
  const c = (await store.getRecord("contact", p.id)).data;
  assert.equal(c.source.source, "Website quote form");
  assert.equal(c.source.channel, "Yard Sign");
  assert.ok(c.notes.includes("Dog in the yard.") && c.notes.includes("Plan: Quarterly"), "the same note block Rotor got");
  assert.equal(c.consent.sms_service.state, "granted");
  assert.deepEqual(c.tags, ["Website", "Yard Sign"]);
  assert.deepEqual(Object.keys(rotorPayload).sort(), ["address_city", "address_country", "address_state", "address_street1", "address_zip", "email", "name", "notes", "phone", "service_type", "source", "tags"]);
});

test("dual: either success answers 200; a failed side raises an owner alert", async () => {
  await setMode("dual");
  // Rotor down, the CRM keeps it: 200, and the owners hear that Rotor is missing it
  rotor.status = 503;
  const a = await post(body(72));
  assert.equal(a.status, 200);
  assert.equal(contactKeys(env.S).length, 1);
  let health = (await store.getRaw("sys/health")).data;
  assert.ok(health.alerts.some((x) => x.key === "intake:crm_only"));
  // Rotor unreachable (a thrown fetch): the CRM still keeps it
  rotor.status = "throw";
  assert.equal((await post(body(73))).status, 200);
  // Rotor up, the CRM failing: 200 (Rotor's answer), and an alert the other way
  rotor.status = 201;
  env.S.data.fail({ op: "setJSON", key: /^rec\/contact\//, times: 50, kind: "internal" });
  const w = ctxWait();
  const b = await post(body(74), w.context);
  assert.equal(b.status, 200);
  await Promise.all(w.list);
  health = (await store.getRaw("sys/health")).data;
  assert.ok(health.alerts.some((x) => x.key === "intake:rotor_only"));
});

test("dual: both sides failing still answers 502 (the visitor calls instead)", async () => {
  await setMode("dual");
  rotor.status = 500;
  env.S.data.fail({ op: "setJSON", key: /^(rec\/contact\/|lock\/intake\/)/, times: 50, kind: "internal" });
  assert.equal((await post(body(75))).status, 502);
});

test("two simultaneous website submissions for one phone → one contact (B2 through lead.mjs)", async () => {
  await setMode("dual");
  const w = ctxWait();
  const [x, y] = await Promise.all([post(body(76), w.context), post(body(76), w.context)]);
  assert.equal(x.status, 200);
  assert.equal(y.status, 200);
  await Promise.all(w.list);
  assert.equal(contactKeys(env.S).length, 1);
});

test("a referral claim goes to the CRM after Rotor too, and a CRM-kept claim counts as delivered", async () => {
  await setMode("dual");
  hook.clearModeCache();
  rotor.status = 500;
  // the referral store is unavailable here (no override): only Rotor and the CRM decide
  const res = await claimHandler(new Request("http://localhost/api/claim", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ first_name: "Riley", last_name: "Sample", phone: "7635550177", email: "riley.sample@example.com", code: "BARTA-ZZZZZ", services: ["Gutter Cleaning"], consent: true }) }));
  const out = await res.json();
  assert.equal(res.status, 200, JSON.stringify(out));
  assert.equal(out.delivered, false, "delivered stays Rotor's answer");
  assert.equal(contactKeys(env.S).length, 1, "the CRM kept the claim");
  const c = (await store.getRecord("contact", env.S.data.keys("rec/contact/")[0].split("/").pop())).data;
  assert.equal(c.source.source, "Referral");
});

test("a giveaway entry reaches the CRM after Rotor's two steps: tags and the coupon opt-in only, never the cadence", async () => {
  await setMode("dual");
  const { upsertGiveawayLead, rotorEntryPayload } = await import("../../../netlify/lib/giveaway-rotor.mjs");
  const w = ctxWait();
  globalThis.Netlify = { context: w.context };
  try {
    const e = { phone: "7635550178", first_name: "Casey", last_name: "Placeholder", code: "SAMPLE1", offers_opt_in: true, address: { street: "178 Example Ave", city: "Delano", state: "MN", zip: "55328" }, area: { ok: true } };
    const r = await upsertGiveawayLead(rotorEntryPayload(e));
    assert.equal(r.delivered, true);
    assert.equal(calls.filter((c) => c.url.includes("getrotor.com")).length, 2, "Rotor's two steps, unchanged");
    await Promise.all(w.list);
    const c = (await store.getRecord("contact", env.S.data.keys("rec/contact/")[0].split("/").pop())).data;
    assert.ok(c.tags.includes("Giveaway - Coupon Opt-In"));
    assert.equal(c.consent.sms_marketing.state, "granted");
    assert.equal(c.source.source, "Holiday Lights Giveaway");
    assert.equal(env.S.data.keys("q/").length, 0, "no lead.created: no cadence for a giveaway entry");
  } finally { delete globalThis.Netlify; }
});
