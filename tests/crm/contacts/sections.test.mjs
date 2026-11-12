// The contact page (the Nov 2026 layout: "Customer pages should answer a
// phone call at a glance"): the header's three numbers from the contact's
// stats (money only for someone who may see money: the server leaves it
// out too), its buttons, the sections in the report's order (each module's
// contactTabs entry a section; denied ones left out), old tab links
// scrolling to a section, "About to be sent" from the modules, and the one
// read the header needs staying inside its budget.
import { test } from "node:test";
import assert from "node:assert/strict";
import { crmTest } from "../../helpers/crm-http.mjs";

globalThis.window = globalThis.window || { __crm: { session: { perms: { "schedule:read": true } } } };
const C = await import("../../../crm-app/modules/contacts/contact.js");
const { MANIFESTS } = await import("../../../crm-app/modules/index.js");
const router = await import("../../../crm-app/core/router.js");
router.register(MANIFESTS);
const store = await import("../../../netlify/lib/crm-store.mjs");
const text = (safe) => String(safe);
const all = (p) => p !== "never";
const NOW = "2026-11-17T15:00:00.000Z";
const contact = {
  id: "ct_00000000000000000001", display_name: "Pat Example", lifecycle: "customer", phones: [{ e164: "+17635550100", primary: true }], emails: [{ address: "pat@example.com" }],
  billing_address: { street1: "1 Example Ave", city: "Delano", state: "MN", zip: "55328" }, created_at: NOW, updated_at: NOW, consent: {},
};
const property = { id: "pr_00000000000000000001", label: "Home", address: { street1: "1 Example Ave", city: "Mound", state: "MN", zip: "55364" }, access: { gate_code: "4321", pets: "Dog in the yard" }, assets: { stories: 2 }, town_tier: "primary" };
const ctx = (perms = null) => ({ can: (p) => (perms ? perms.includes(p) : true), user: { id: "us_00000000000000000001", role: "owner" }, keep: {}, path: "/contacts/x", params: {} });

test("the header: balance owed, lifetime spend, next visit; '-' when not known; no money for someone who may not see it", () => {
  const s = { stats: { money: { open_balance_cents: 12500, lifetime_cents: 98000 }, work: { next_visit_on: "2099-03-04" } } };
  assert.deepEqual(C.headerNumbers(s, all).map((n) => [n.key, n.value]), [["balance", "$125.00"], ["lifetime", "$980.00"], ["next", "Wed, Mar 4"]]);
  assert.equal(C.headerNumbers(s, all)[0].bad, true, "owed money reads in coral");
  assert.deepEqual(C.headerNumbers({ stats: {} }, all).map((n) => n.value), ["-", "-", "-"], "nothing known");
  assert.deepEqual(C.headerNumbers({ stats: { work: { next_visit_on: "2020-01-01" } } }, all).map((n) => n.value).pop(), "-", "a next visit that went by isn't next");
  assert.deepEqual(C.headerNumbers({ stats: {} }, all, { next_visit: "2099-01-05" }).pop().value, "Mon, Jan 5", "the work section's nearer date");
  const noMoney = C.headerNumbers(s, (p) => p !== "invoices:read_all");
  assert.deepEqual(noMoney.map((n) => n.key), ["next"], "no money tiles without invoices:read_all");
});

test("the page: one scroll of headed sections in the report's order; each module a section; a denied one left out", () => {
  const order = C.contactSections(MANIFESTS, all).map((x) => [x.key, x.place]);
  assert.deepEqual(order, [["sales", "more"], ["quotes", "docs"], ["plans", "plan"], ["work", "visits"], ["money", "docs"], ["messages", "aside"]]);
  assert.deepEqual(C.contactSections(MANIFESTS, (p) => p !== "invoices:read_all").map((x) => x.key).includes("money"), false, "a section behind its permission");
  const mod = (key, place, body, extra = {}) => ({ def: { key, place, label: key, load: () => {} }, key, loading: false, mod: { render: () => body, ...extra }, state: {}, ctx: {} });
  const secs = [
    mod("sales", "more", "SALES-BODY"), mod("quotes", "docs", "QUOTES-BODY"), mod("plans", "plan", "PLAN-BODY", { header: () => ({ plan: "Quarterly plan" }) }),
    mod("work", "visits", "WORK-BODY", { queued: () => [{ at: "2099-02-01T16:00:00.000Z", label: "Visit reminder, 2 days before", icon: "text" }] }),
    mod("money", "docs", "MONEY-BODY"), mod("messages", "aside", "MSG-BODY"), { ...mod("denied", "more", "NOPE"), state: { denied: true } },
  ];
  const s = { contact, stats: { money: { open_balance_cents: 0, lifetime_cents: 5000 }, work: {} }, properties: [property], users: [], secs, activity: [{ at: NOW, kind: "call.spoke", label: "Called and talked" }, { at: NOW, kind: "sms.in", label: "Text received" }], tech: false };
  const h = text(C.default.render(s, ctx()));
  const at = (x) => h.indexOf(x);
  const want = ["ct-sec-visits", "ct-sec-plan", "ct-sec-docs", "ct-sec-properties", "ct-sec-queued", "ct-sec-mod-sales", "ct-sec-details", "ct-sec-aside", "ct-sec-activity"];
  for (const id of want) assert.ok(at(`id="${id}"`) > 0, `${id} is there`);
  assert.deepEqual([...want].sort((a, b) => at(`id="${a}"`) - at(`id="${b}"`)), want, "in the report's order");
  assert.ok(at("QUOTES-BODY") < at("MONEY-BODY") && at("QUOTES-BODY") > at('id="ct-sec-docs"'), "quotes then invoices, under one heading");
  assert.ok(!h.includes("NOPE"), "a denied section is left out");
  assert.match(h, /Quarterly plan/, "the plan badge from the plans section");
  assert.match(h, /Visit reminder, 2 days before/, "About to be sent");
  assert.match(h, /Gate 4321 · Dog in the yard · 2 stories/, "a property's access notes");
  assert.match(h, /Called and talked[\s\S]*Text received/, "calls and texts in one activity list");
  assert.match(h, /href="tel:\+17635550100"[\s\S]*href="sms:\+17635550100"[\s\S]*href="#\/quotes\/new\/ct_00000000000000000001"[\s\S]*href="#\/jobs\/new\/ct_00000000000000000001"/, "Call · Text · Quote · Book");
  assert.doesNotMatch(h, /role="tablist"|data-tab=/, "no sideways tabs");
  // someone who may not quote or book: Email and Directions fill the row
  const lim = text(C.default.render(s, ctx(["contacts:read"])));
  assert.doesNotMatch(lim, /#\/quotes\/new|#\/jobs\/new/);
  assert.match(lim, /href="mailto:pat@example.com"/);
  assert.doesNotMatch(lim, /Balance owed|Lifetime spend/, "no money for them");
  // a technician: the name, the numbers to call, the properties; nothing else
  const t = text(C.default.render({ contact: { id: contact.id, display_name: "Pat Example", phones: contact.phones }, properties: [property], users: [], secs: [], activity: [], tech: true }, ctx(["contacts:read"])));
  assert.match(t, /ct-sec-properties/);
  assert.doesNotMatch(t, /ct-sec-activity|ct-sec-details|Balance owed|Next visit/);
});

test("the header's numbers come with the contact (one stats read, inside the budget); money only for someone who may see it", async () => {
  const t = await crmTest({ now: NOW });
  try {
    const owner = await t.user("owner");
    const admin = await t.user("admin", { extra: { denies: ["invoices:read_all"] } });
    const W = { by: owner.id, origin: "api", actor_kind: "user", requestId: "t" };
    const c = (await store.withStoreScope({ requestId: "t" }, () => store.createRecord("contact", { first_name: "Pat", last_name: "Example", lifecycle: "customer", phones: [{ e164: "+17635550100" }], source: { source: "Other" } }, W))).data;
    await store.withStoreScope({ requestId: "t" }, () => store.updateStats(c.id, "money", () => ({ lifetime_cents: 4200, open_balance_cents: 1500, stripe: { customer_ids: [], card_status: "none" } }), W));
    const r = await t.api(`/contacts/${c.id}`, { as: owner });
    assert.equal(r.status, 200);
    assert.deepEqual([r.body.data.stats.money.open_balance_cents, r.body.data.stats.money.lifetime_cents], [1500, 4200]);
    // (its budget: tests/crm/core/budget.test.mjs runs GET /contacts/:id under the strict 25-call budget)
    const a = await t.api(`/contacts/${c.id}`, { as: admin });
    assert.equal(a.status, 200);
    assert.equal(a.body.data.stats.money, undefined, "no money for someone denied invoices");
    assert.ok(a.body.data.stats.work, "the rest of the stats stay");
  } finally { t.done(); }
});
