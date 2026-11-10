// Logs carry counts, codes and statuses only (design §0 rule 6, §11.4 M1.1):
// safeErr masks digit runs, emails and quoted substrings, and every CRM
// function's top-level wrapper logs only safeErr output. The "customer" in
// these errors is made up (example.com, 555).
import { test, beforeEach, afterEach, mock } from "node:test";
import assert from "node:assert/strict";
import { clearCrmStores, useCrmStores } from "../../helpers/crm-memory-store.mjs";

process.env.OFFICE_PASSWORD = "test-password";
const { safeErr, maskSensitive } = await import("../../../netlify/lib/referral-lib.mjs");
const { derive } = await import("../../../netlify/lib/lights-auth.mjs");
const probe = (await import("../../../netlify/functions/crm-probe.mjs")).default;
const cron = (await import("../../../netlify/functions/crm-cron.mjs")).default;
const worker = (await import("../../../netlify/functions/crm-worker-background.mjs")).default;
const crmImport = (await import("../../../netlify/functions/crm-import.mjs")).default;
const crmPage = (await import("../../../netlify/functions/crm.mjs")).default;

const cookie = "barta_office=" + derive("test-password");
const NAME = "Pat Example";
const EMAIL = "pat.example@example.com";
const PHONE = "(763) 555-0100";
const MSG = `write failed for "${NAME}" at ${EMAIL}, phone ${PHONE}, key ptr/phone/7635550100, note 'gate 4321'`;
const LEAKS = ["@", "555-0100", "7635550100", NAME, "4321", "Example"];

// A store whose every call fails with an error that names a customer.
function leakyStore() {
  const boom = async () => { throw new Error(MSG); };
  return { get: boom, getWithMetadata: boom, getMetadata: boom, set: boom, setJSON: boom, list: boom, delete: boom };
}

let logs, spies, savedFetch;
beforeEach(() => {
  const s = leakyStore();
  useCrmStores({ data: s, files: s, backups: s, probe: s });
  logs = [];
  spies = ["error", "log", "warn", "info"].map((m) => mock.method(console, m, (...a) => logs.push(a.map(String).join(" "))));
  savedFetch = globalThis.fetch;
  globalThis.fetch = async () => { throw new Error("tests never touch the network"); };
});
afterEach(() => {
  for (const s of spies) s.mock.restore();
  globalThis.fetch = savedFetch;
  clearCrmStores();
});

const assertClean = (what) => {
  assert.ok(logs.length > 0, `${what} logged its failure`);
  for (const line of logs) for (const leak of LEAKS) assert.ok(!line.includes(leak), `${what} leaked ${JSON.stringify(leak)} in: ${line}`);
};

test("safeErr masks emails, phone numbers, digit runs and quoted substrings", () => {
  const out = safeErr(new Error(MSG));
  for (const leak of LEAKS) assert.ok(!out.includes(leak), out);
  assert.match(out, /^Error: write failed for "…" at <email>, phone \(?####/);
  assert.equal(safeErr(new Error("key idx/phone/7635550101 missing")), "Error: key idx/phone/#### missing");
  assert.equal(safeErr(new Error("Unexpected token a, \"abc\" is not valid JSON")), 'Error: Unexpected token a, "…" is not valid JSON');
  assert.equal(safeErr(new Error("can't read 'x@example.com'")), 'Error: can\'t read "…"', "an apostrophe inside a word is not a quote");
  assert.equal(safeErr({ name: "TypeError" }), "TypeError");
  assert.equal(safeErr(null), "Error");
  assert.equal(maskSensitive("+1 763 555 0100 / 763.555.0100 / “Pat”"), '#### / #### / "…"');
  assert.ok(safeErr(new Error("x".repeat(500))).length <= 7 + 160);
});

test("crm-probe's wrapper logs only safeErr output", async () => {
  const res = await probe(new Request("http://localhost/api/crm-probe", { headers: { cookie } }), {});
  assert.equal(res.status, 500);
  assert.ok(!JSON.stringify(await res.json()).includes("Pat"));
  assertClean("crm-probe");
});

test("crm-cron's wrapper logs only safeErr output", async () => {
  const res = await cron(new Request("https://www.bartawindowwashing.com/.netlify/functions/crm-cron", { method: "POST" }), { deploy: { context: "production" } });
  assert.equal(res.status, 204);
  assertClean("crm-cron");
});

test("crm-worker-background's wrapper logs only safeErr output", async () => {
  const res = await worker(new Request("https://www.bartawindowwashing.com/.netlify/functions/crm-worker-background", { method: "POST", headers: { "x-crm-worker": "x" } }), {});
  assert.equal(res.status, 202);
  assertClean("crm-worker-background");
});

test("the first slice's functions (Customers page and import) log only safeErr output too", async () => {
  const imp = await crmImport(new Request("http://localhost/api/crm/import", { headers: { cookie } }));
  assert.equal(imp.status, 503);
  await crmPage(new Request("http://localhost/crm", { headers: { cookie } }));
  assertClean("crm-import and crm");
});
