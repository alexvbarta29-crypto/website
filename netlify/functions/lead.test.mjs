// Mocked tests for the /api/lead → Rotor field mapping. Run with:
//   node --test netlify/functions/
// globalThis.fetch is replaced with a capture stub, so no request ever
// leaves the machine and no real API key is involved — ROTOR_API_KEY is a
// clearly fake placeholder.

import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";

process.env.ROTOR_API_KEY = "test-dummy-key-not-real";
const handler = (await import("./lead.mjs")).default;

let captured;
beforeEach(() => {
  captured = null;
  globalThis.fetch = async (url, options) => {
    captured = { url, options, payload: JSON.parse(options.body) };
    return new Response("{}", { status: 201 });
  };
});

const post = (body) => handler(new Request("http://localhost/api/lead", {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify(body),
}));

test("wizard submission maps to Rotor structured fields exactly", async () => {
  const res = await post({
    first_name: "Test", last_name: "Person",
    phone: "(763) 555-0100", email: "test@example.com",
    address_street: "123 Main St", address_city: "Delano",
    address_state: "MN", address_zip: "55328", address_country: "US",
    address_verified: "yes",
    services: ["Exterior Window Cleaning", "Gutter Cleaning"],
    plan: "quarterly", promo_code: "FALL10",
    notes: "Please call after 5pm.\nDog in the yard.",
    reminders: "on", page: "/get-quote.html",
    subject: "New quote request", access_key: "",
  });
  assert.equal(res.status, 200);
  assert.equal(captured.url, "https://api.getrotor.com/open-api/leads");
  assert.equal(captured.options.headers["rotor-api-version"], "1.1.0");
  assert.equal(captured.options.headers["x-api-key"], "test-dummy-key-not-real");
  assert.deepEqual(captured.payload, {
    source: "Website quote form",
    tags: ["website-lead", "Exterior Window Cleaning", "Gutter Cleaning", "plan: quarterly"],
    name: "Test Person",
    phone: "(763) 555-0100",
    email: "test@example.com",
    address_street1: "123 Main St",
    address_city: "Delano",
    address_state: "MN",
    address_zip: "55328",
    address_country: "US",
    service_type: "Exterior Window Cleaning, Gutter Cleaning",
    notes: "Customer notes:\nPlease call after 5pm.\nDog in the yard.\n\n"
         + "Additional submission details:\n"
         + "Plan interest: quarterly\n"
         + "Promo code: FALL10\n"
         + "Wants seasonal reminders: yes\n"
         + "Submitted from: /get-quote.html",
  });
  assert.ok(!("address" in captured.payload), "combined address field must not be sent");
});

test("blank notes: no Customer notes block, no empty properties", async () => {
  const res = await post({
    name: "Solo Field", phone: "7635550101",
    address: "456 Oak Ave", address_city: "Delano", address_zip: "55328",
    services: ["House Washing"], notes: "", email: "",
    page: "/services/house-washing.html",
  });
  assert.equal(res.status, 200);
  const p = captured.payload;
  assert.equal(p.address_street1, "456 Oak Ave");
  assert.equal(p.address_state, "MN", "server fallback state");
  assert.equal(p.address_country, "US", "server fallback country");
  assert.equal(p.service_type, "House Washing");
  assert.equal(p.notes, "Additional submission details:\nSubmitted from: /services/house-washing.html");
  for (const [k, v] of Object.entries(p))
    assert.notEqual(v, "", `empty optional property sent: ${k}`);
  assert.ok(!("email" in p), "blank email must be omitted");
  assert.ok(!("address" in p));
});

test("service_type respects the 100-character limit, tags keep everything", async () => {
  const services = ["Exterior Window Cleaning", "Interior Window Cleaning",
    "Hard Water Stain Removal", "Christmas Light Installation", "Screen Cleaning"];
  await post({ phone: "7635550102", services });
  const p = captured.payload;
  assert.ok(p.service_type.length <= 100, `service_type too long: ${p.service_type.length}`);
  const kept = p.service_type.split(", ");
  assert.deepEqual(kept, services.slice(0, kept.length), "must keep whole leading services");
  for (const s of services) assert.ok(p.tags.includes(s), `tag missing: ${s}`);
});

test("customer message survives truncation ahead of details", async () => {
  const longMsg = "x".repeat(480);
  await post({
    phone: "7635550103",
    notes: longMsg, promo_code: "y".repeat(480), referral_source: "z".repeat(480),
    preferred_date: "w".repeat(480), preferred_time: "v".repeat(480), page: "/x",
  });
  const p = captured.payload;
  assert.ok(p.notes.length <= 2000, "notes over Rotor limit");
  assert.ok(p.notes.startsWith("Customer notes:\n" + longMsg), "customer message truncated before details");
});

test("phone-or-email validation still rejects uncontactable submissions", async () => {
  const res = await post({ name: "No Contact", address_city: "Delano" });
  assert.equal(res.status, 400);
  assert.equal(captured, null, "no Rotor request for invalid submissions");
});
