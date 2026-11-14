// The contact page (Rotor's lead and customer page, Nov 2026): the stat
// card's numbers from the contact's stats (money only for someone who may
// see money: the server leaves it out too), the modules' cards on Details
// and Activity in Rotor's order (a module without cards() is one card of
// its own; denied ones left out), their rows in the "...", "About to be
// sent" from the modules, and the one read the page needs staying inside
// its budget.
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

test("the page: the modules' cards on Details and Activity in Rotor's order; their \"...\" rows; a denied one left out", () => {
  const order = C.contactSections(MANIFESTS, all).map((x) => [x.key, x.place]);
  assert.deepEqual(order, [["sales", "more"], ["quotes", "docs"], ["requests", "docs"], ["plans", "plan"], ["work", "visits"], ["money", "docs"], ["messages", "aside"]]);
  assert.deepEqual(C.contactSections(MANIFESTS, (p) => p !== "invoices:read_all").map((x) => x.key).includes("money"), false, "a section behind its permission");
  const mod = (key, place, extra = {}) => ({ def: { key, place, label: key, load: () => {} }, key, loading: false, mod: { render: () => `${key.toUpperCase()}-OLD`, ...extra }, state: {}, ctx: {} });
  const cards = (...list) => ({ cards: () => list });
  const secs = [
    mod("sales", "more", { ...cards({ key: "followups", tab: "details", title: "Follow-ups", body: "FOLLOW-BODY" }, { key: "deals", tab: "activity", title: "Deals", body: "DEALS-BODY" }), actions: () => [{ key: "call", label: "Log a call", href: "#/calls/log/x" }, { key: "lost", label: "Mark lost", danger: true, href: "#/deals/d" }] }),
    mod("quotes", "docs", { ...cards({ key: "quotes", tab: "details", title: "Quotes", body: null, empty: "No quotes yet" }), actions: () => [{ key: "quote", label: "New quote", href: "#/quotes/new/x" }] }),
    mod("plans", "plan", { ...cards({ key: "plan", tab: "details", title: "Plan", body: "PLAN-BODY" }), header: () => ({ plan: "Quarterly plan" }) }),
    mod("work", "visits", { ...cards({ key: "visits", tab: "details", title: "Visits", body: "WORK-BODY" }), queued: () => [{ at: "2099-02-01T16:00:00.000Z", label: "Visit reminder, 2 days before", icon: "text" }], actions: () => [{ key: "book", label: "Book a job", href: "#/jobs/new/x" }] }),
    mod("money", "docs"),
    mod("messages", "aside"),
    { ...mod("denied", "more"), state: { denied: true } },
  ];
  const s = { contact, stats: { money: { open_balance_cents: 0, lifetime_cents: 5000 }, work: {} }, properties: [property], users: [], secs, activity: [{ at: NOW, kind: "call.spoke", label: "Called and talked" }, { at: NOW, kind: "sms.in", label: "Text received" }], tech: false };
  const h = text(C.default.render(s, ctx()));
  const at = (x) => h.indexOf(x);
  const details = h.slice(at('data-pane="details"'), at('data-pane="activity"'));
  const activity = h.slice(at('data-pane="activity"'));
  // a customer's order: Visits, Plan, Quotes, Invoices (money's old section as one card), Properties, Follow-ups, notes
  const want = ["ct-mod-work", "ct-mod-plans", "ct-mod-quotes", "ct-mod-money", "ct-card-properties", "ct-mod-sales", "ct-card-notes"];
  for (const id of want) assert.ok(details.includes(`id="${id}"`), `${id} on Details`);
  assert.deepEqual([...want].sort((a, b) => details.indexOf(`id="${a}"`) - details.indexOf(`id="${b}"`)), want, "in Rotor's order for a customer");
  assert.match(details, /MONEY-OLD/, "a module without cards(): its old section as one card");
  assert.match(details, /No quotes yet/, "an empty card: one line");
  for (const x of ["DEALS-BODY", "MESSAGES-OLD", "Called and talked", "Marketing texts"]) assert.ok(activity.includes(x), `${x} on Activity`);
  assert.ok(!h.includes("DENIED-OLD"), "a denied section is left out");
  assert.match(h, /Quarterly plan/, "the plan pill from the plans section");
  assert.match(h, /About to be sent · <b>1 queued/, "About to be sent, one line");
  assert.match(h, /Gate 4321 · Dog in the yard · 2 stories/, "a property's access notes");
  assert.match(h, /href="tel:\+17635550100"[\s\S]*href="sms:\+17635550100"|href="sms:\+17635550100"[\s\S]*href="tel:\+17635550100"/, "Call and text");
  // the "...": a customer books first; the modules' rows, then the contact's own; Mark lost and Archive red
  const groups = C.default.more(s, ctx()).map((g) => g.filter(Boolean).map((r) => r.label));
  assert.deepEqual(groups[0], ["Book a job", "New quote"]);
  assert.deepEqual(groups[1], ["Log a call"]);
  assert.ok(groups.flat().includes("Mark lost") && groups.flat().includes("Archive"));
  // a lead: follow up first, Mark lost for an open deal, its stage pill
  const ls = { ...s, contact: { ...contact, lifecycle: "lead" } };
  assert.deepEqual(C.default.more(ls, ctx())[0].filter(Boolean).map((r) => r.label), ["Log a call"]);
  const lh = text(C.default.render(ls, ctx()));
  const ld = lh.slice(lh.indexOf('data-pane="details"'));
  assert.ok(ld.indexOf('id="ct-mod-quotes"') < ld.indexOf('id="ct-mod-sales"') && ld.indexOf('id="ct-mod-sales"') < ld.indexOf('id="ct-mod-work"'), "a lead's order: Quotes, Follow-ups, Visits");
  assert.match(lh, /class="pill blue">New</, "a lead without a deal: New");
  // someone who may not see money: no balance on the stat card
  const lim = text(C.default.render(s, ctx(["contacts:read"])));
  assert.doesNotMatch(lim, /Balance|Lifetime/, "no money for them");
  assert.doesNotMatch(lim, /data-notes="ct-notes"/, "the notes box needs contacts:write");
  // a technician: the name, the numbers to call, the properties; nothing else
  const t = text(C.default.render({ contact: { id: contact.id, display_name: "Pat Example", phones: contact.phones }, properties: [property], users: [], secs: [], activity: [], tech: true }, ctx(["contacts:read"])));
  assert.match(t, /ct-card-properties/);
  assert.doesNotMatch(t, /data-pane|Balance|Next visit/);
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
