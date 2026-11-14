// The mcp module's screens render with synthetic state through html``
// (design §2.3, §0 rule 7): Settings → Claude connector (a connector link
// for claude.ai, a key that can ask, the keys, the tools) and the Calendar
// feed (off, on, the link shown once with the ways to subscribe).
import { test } from "node:test";
import assert from "node:assert/strict";

const load = async (name) => (await import(`../../../crm-app/modules/mcp/${name}.js`)).default;
const ctx = () => ({ can: () => true, user: { id: "us_00000000000000000001", role: "owner" }, keep: {}, path: "/x", params: {} });
const text = (safe) => String(safe);
const NOW = "2026-11-17T15:00:00.000Z";
const INFO = { url: "https://www.bartawindowwashing.com/api/crm/mcp", path_url_template: "https://www.bartawindowwashing.com/api/crm/mcp/{key}", protocol: "2025-03-26", tools: { read: ["get_contact", "report_invoices"], ask: ["send_message", "create_task"] }, ask_scopes: ["messages:send", "tasks:write"] };
const KEY = "bcrm_" + "a1B2".repeat(8);

test("Claude connector: both ways in, the key shown once, the keys and the tools", async () => {
  const s = await load("claude");
  const base = { info: INFO, keys: [{ id: "ak_1", name: "Claude.ai connector", kind: "path", last4: "a1B2", created_at: NOW, last_used_at: null }, { id: "ak_2", name: "Backup", kind: "backup", last4: "zzzz", created_at: NOW }], scopes: { read: [], write: [], defaults: ["contacts:read"] }, made: null };
  const h = text(s.render(base, ctx()));
  assert.match(h, /Make a connector link/);
  assert.match(h, /Make a key that can ask/);
  assert.match(h, /waits for an owner's OK under Approvals/);
  assert.match(h, /Connector link · …a1B2 · never used/);
  assert.doesNotMatch(h, /Backup/, "a backup key isn't Claude's");
  assert.match(h, /report invoices/);
  const link = text(s.render({ ...base, made: { kind: "path", key: KEY } }, ctx()));
  assert.match(link, new RegExp(`value="https://www.bartawindowwashing.com/api/crm/mcp/${KEY}"`));
  assert.match(link, /shown only this once/);
  assert.match(link, /Add custom connector/);
  const hdr = text(s.render({ ...base, made: { kind: "header", key: KEY } }, ctx()));
  assert.match(hdr, /claude mcp add --transport http barta-crm https:\/\/www.bartawindowwashing.com\/api\/crm\/mcp --header &quot;Authorization: Bearer bcrm_/);
  const noAsk = text(s.render({ ...base, info: { ...INFO, ask_scopes: [] } }, ctx()));
  assert.doesNotMatch(noAsk, /Make a key that can ask/, "nothing to ask with: no asking key");
});

test("Calendar feed: off, on, and the link once with Google and Apple steps", async () => {
  const s = await load("calendar");
  const off = text(s.render({ feed: { on: false, scope: null, last4: null, created_at: null, can_all: false }, made: null }));
  assert.match(off, /Turn on/);
  assert.doesNotMatch(off, /Everyone(&#39;|')s visits/, "a tech has no choice");
  assert.match(off, /No phone numbers, addresses or notes/);
  const office = text(s.render({ feed: { on: false, scope: null, can_all: true }, made: null }));
  assert.match(office, /Everyone(&#39;|')s visits/);
  const url = "https://www.bartawindowwashing.com/api/crm/cal/bcal_" + "x".repeat(43) + ".ics";
  const on = text(s.render({ feed: { on: true, scope: "all", last4: "xxxx", created_at: NOW, can_all: true }, made: { url, webcal_url: url.replace("https:", "webcal:") } }));
  assert.match(on, /Everyone(&#39;|')s visits · link …xxxx/);
  assert.match(on, /New link/);
  assert.match(on, /Turn off/);
  assert.match(on, new RegExp(`value="${url.replace(/[.]/g, "\\.")}"`));
  assert.match(on, /href="https:\/\/calendar\.google\.com\/calendar\/r\?cid=webcal%3A%2F%2Fwww\.bartawindowwashing\.com/);
  assert.match(on, /target="_blank" rel="noopener"/);
  assert.match(on, /Add Subscribed Calendar/);
});

test("wrapUntrusted: free-text keys at any depth, once, and nothing else", async () => {
  const { wrapUntrusted } = await import("../../../netlify/lib/crm/modules/mcp/untrusted.mjs");
  const out = wrapUntrusted({ name: "Pat", notes: "hi", nested: [{ body_text: "x", n: 1 }], comment: { untrusted_customer_text: "y" }, message: "", answers: ["a", "b"] });
  assert.deepEqual(out, { name: "Pat", notes: { untrusted_customer_text: "hi" }, nested: [{ body_text: { untrusted_customer_text: "x" }, n: 1 }], comment: { untrusted_customer_text: "y" }, message: "", answers: [{ untrusted_customer_text: "a" }, { untrusted_customer_text: "b" }] });
  assert.deepEqual(Object.keys(wrapUntrusted(JSON.parse('{"__proto__":{"x":1},"a":1}'))), ["a"]);
});
