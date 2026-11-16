// Mocked tests for /api/lead on Rotor API 2026-11-14 (ROTOR_API_TOKEN set).
// Run with:  node --test tests/lead-v2.test.mjs
// globalThis.fetch is a capture stub: nothing leaves the machine and the
// keys are clearly fake placeholders.

import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";

process.env.ROTOR_API_KEY = "test-dummy-key-not-real";
const handler = (await import("../netlify/functions/lead.mjs")).default;

const LEAD_ID = "3c90c3cc-0d44-4b50-8888-8dd25736052a";
let calls;
let createStatus;
beforeEach(() => {
  process.env.ROTOR_API_TOKEN = "test-dummy-token-not-real";
  calls = [];
  createStatus = [201];
  globalThis.fetch = async (url, options) => {
    calls.push({ url, options, payload: JSON.parse(options.body) });
    if (url.endsWith("/note/append"))
      return Response.json({ body: "x", created_at: null, updated_at: null }, { status: 200 });
    const status = createStatus.shift() ?? 201;
    return Response.json(status < 300 ? { id: LEAD_ID, matched: status === 200 } : { error: { code: "invalid_request" } }, { status });
  };
});
afterEach(() => { delete process.env.ROTOR_API_TOKEN; });

const post = (body) => handler(new Request("http://localhost/api/lead", {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify(body),
}));

test("v2: new format, bearer auth, version header, note appended after", async () => {
  const res = await post({
    first_name: "Test", last_name: "Person",
    phone: "(763) 555-0100", email: "test@example.com",
    address_street: "123 Main St", address_city: "Delano",
    address_state: "MN", address_zip: "55328", address_country: "US",
    services: ["Exterior Window Cleaning", "Gutter Cleaning"],
    plan: "quarterly", referral_source: "Yard Sign",
    notes: "Please call after 5pm.",
  });
  assert.equal(res.status, 200);
  assert.equal(calls.length, 2);
  const [create, note] = calls;
  assert.equal(create.url, "https://api.getrotor.com/leads");
  assert.equal(create.options.headers.Authorization, "Bearer test-dummy-token-not-real");
  assert.equal(create.options.headers["Rotor-Version"], "2026-11-14");
  assert.ok(!("x-api-key" in create.options.headers), "legacy header must not be sent");
  assert.deepEqual(create.payload, {
    name: "Test Person",
    phone: "+17635550100",
    source: "Website quote form",
    tags: ["Website", "Yard Sign"],
    match_on: ["phone", "email"],
    on_match: "merge",
    email: "test@example.com",
    property: { address: { street1: "123 Main St", city: "Delano", state: "MN", zip: "55328", country: "US" } },
    service_types: ["Exterior Window Cleaning", "Gutter Cleaning"],
  });
  assert.ok(!("note" in create.payload) && !("notes" in create.payload), "note goes in the append, not the create");
  assert.equal(note.url, `https://api.getrotor.com/leads/${LEAD_ID}/note/append`);
  assert.deepEqual(note.payload, {
    text: "Customer notes:\nPlease call after 5pm.\n\nServices: Exterior Window Cleaning, Gutter Cleaning\nPlan: Quarterly",
    separator: "\n\n",
  });
});

test("v2: matched existing lead (200) is a success too", async () => {
  createStatus = [200];
  const res = await post({ name: "Repeat Visitor", phone: "7635550101", services: ["Gutter Cleaning"] });
  assert.equal(res.status, 200);
  assert.equal(calls[1].url, `https://api.getrotor.com/leads/${LEAD_ID}/note/append`);
});

test("v2: picklist mismatch (400) retries once without service_types", async () => {
  createStatus = [400, 201];
  const res = await post({ name: "Picky List", phone: "7635550102", services: ["Christmas Light Installation"] });
  assert.equal(res.status, 200);
  assert.equal(calls.length, 3);
  assert.ok("service_types" in calls[0].payload);
  assert.ok(!("service_types" in calls[1].payload), "retry drops service_types");
  assert.deepEqual(calls[1].payload.tags, ["Website", "Christmas Lights"]);
  assert.ok(calls[2].payload.text.includes("Services: Christmas Light Installation"), "services still in the note");
});

test("v2: a 400 with no service types is not retried, and the visitor sees the fallback", async () => {
  createStatus = [400];
  const res = await post({ name: "Bad Phone", phone: "12" });
  assert.equal(res.status, 502);
  assert.equal(calls.length, 1);
});

test("v2: a failed note append never fails the lead", async () => {
  globalThis.fetch = async (url, options) => {
    calls.push({ url, options, payload: JSON.parse(options.body) });
    if (url.endsWith("/note/append")) throw new TypeError("fetch failed");
    return Response.json({ id: LEAD_ID, matched: false }, { status: 201 });
  };
  const res = await post({ name: "Note Fail", phone: "7635550103", notes: "hello" });
  assert.equal(res.status, 200);
});

test("v2: no name falls back, no address or services sends neither", async () => {
  const res = await post({ phone: "7635550104" });
  assert.equal(res.status, 200);
  const p = calls[0].payload;
  assert.equal(p.name, "Website lead");
  assert.ok(!("property" in p) && !("service_types" in p) && !("email" in p));
  assert.equal(calls.length, 1, "no note to append");
});

test("v2: email-only submissions are refused (Rotor requires a phone)", async () => {
  const res = await post({ name: "Email Only", email: "a@example.com" });
  assert.equal(res.status, 400);
  assert.equal(calls.length, 0);
});

test("without ROTOR_API_TOKEN the legacy path runs unchanged", async () => {
  delete process.env.ROTOR_API_TOKEN;
  const res = await post({ name: "Legacy Path", phone: "7635550105" });
  assert.equal(res.status, 200);
  assert.equal(calls[0].url, "https://api.getrotor.com/open-api/leads");
  assert.equal(calls[0].options.headers["x-api-key"], "test-dummy-key-not-real");
});
