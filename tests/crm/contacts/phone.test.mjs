// A customer's page on a phone (Rotor's phone app, the owner's Nov 15
// screenshots, with Flyra's quick row, Automations switch and foot buttons):
// Details | Service | Activity, the cards in Rotor's phone order, each
// module's phone rows (plans, Billing Cycles, the card on file, invoices,
// scheduled and pending jobs), and the desk, a lead and a technician left
// as they were. Synthetic data only.
import { test } from "node:test";
import assert from "node:assert/strict";

globalThis.window = globalThis.window || { __crm: { session: { perms: { "schedule:read": true } } } };
const C = await import("../../../crm-app/modules/contacts/contact.js");
const { MANIFESTS } = await import("../../../crm-app/modules/index.js");
const router = await import("../../../crm-app/core/router.js");
router.register(MANIFESTS);
const PLANS = (await import("../../../crm-app/modules/plans/contact-tab.js"));
const MONEY = (await import("../../../crm-app/modules/money/contact-tab.js"));
const WORK = (await import("../../../crm-app/modules/work/office-contact-tab.js"));
const text = (safe) => String(safe);
const NOW = "2026-11-17T15:00:00.000Z";
const contact = {
  id: "ct_00000000000000000001", display_name: "Pat Example", lifecycle: "customer", kind: "person", phones: [{ e164: "+17635550100", primary: true }], emails: [{ address: "pat@example.com" }],
  source: { source: "Referral" }, billing_address: { street1: "1 Example Ave", city: "Delano", state: "MN", zip: "55328" }, created_at: NOW, updated_at: NOW, consent: {},
};
const property = { id: "pr_00000000000000000001", label: "Home", address: { street1: "1 Example Ave", city: "Mound", state: "MN", zip: "55364" }, access: { gate_code: "4321" }, town_tier: "primary" };
const ctx = (perms = null) => ({ can: (p) => (perms ? perms.includes(p) : true), user: { id: "us_00000000000000000001", role: "owner" }, keep: {}, path: "/contacts/x", params: {} });
const mod = (key, module, extra = {}) => ({ def: { key, place: "more", label: key, module, load: () => {} }, key, loading: false, mod: { render: () => `${key.toUpperCase()}-OLD`, ...extra }, state: {}, ctx: {} });
const cards = (...list) => ({ cards: (st, c) => list.map((x) => ({ ...x, body: x.body === null ? null : `${x.body || x.key.toUpperCase()}${c.phone ? "-PHONE" : "-DESK"}` })) });

function page(extra = {}) {
  const secs = [
    mod("sales", "sales", cards({ key: "followups", tab: "details", title: "Follow-ups" }, { key: "deals", tab: "activity", title: "Deals" }, { key: "tasks", tab: "details", title: "Tasks" }, { key: "calls", tab: "activity", title: "Calls" })),
    mod("quotes", "quotes", cards({ key: "quotes", tab: "details", title: "Quotes", body: null, empty: "No quotes yet" })),
    mod("plans", "plans", { ...cards({ key: "plan", tab: "service", title: "Service Plan", add: { label: "New plan", short: "New Plan", href: "#/plans/new/x" } }, { key: "cycles", tab: "payments", title: "Billing Cycles", body: null, empty: "No billing cycles yet.", add: { label: "New plan", short: "New", href: "#/plans/new/x" } }), header: () => ({ sale_value: 138000, frequency: "Quarterly", service_type: "Window Cleaning" }) }),
    mod("work", "work", cards({ key: "visits", tab: "service", title: "Scheduled Jobs" }, { key: "pending", tab: "service", title: "Pending Jobs (2)" })),
    mod("money", "money", cards({ key: "invoices", tab: "details", title: "Invoices", count: 2 }, { key: "payment", tab: "details", title: "Payment" })),
    mod("messages", "comms", cards({ key: "messages", tab: "activity", title: "Messages" })),
  ];
  return { contact, stats: { money: { open_balance_cents: 0, lifetime_cents: 5000 }, work: {} }, properties: [property], users: [], secs, activity: [{ at: NOW, kind: "note", label: "Note added" }], files: [], tech: false, phone: true, ...extra };
}
const panes = (h) => [...h.matchAll(/data-seg="ctab" data-key="([a-z]+)"/g)].map((m) => m[1]);
const paneOf = (h, k) => { const i = h.indexOf(`data-pane="${k}"`); const rest = h.slice(i + 1); const j = rest.search(/data-pane="/); return h.slice(i, j < 0 ? undefined : i + 1 + j); };
const order = (h, ids) => ids.filter((id) => h.includes(`data-card="${id}"`)).sort((a, b) => h.indexOf(`data-card="${a}"`) - h.indexOf(`data-card="${b}"`));

test("a customer on a phone: Details | Service | Activity, Rotor's cards in Rotor's phone order", () => {
  const h = text(C.default.render(page(), ctx()));
  assert.deepEqual(panes(h), ["details", "service", "activity"]);
  assert.match(h, /class="ct-pane rs-page" data-pane="details"/, "Details first");
  const details = paneOf(h, "details");
  // the 2x2 summary: TYPE, SALE VALUE, FREQUENCY, SOURCE
  assert.deepEqual([...details.matchAll(/class="ct-sv-l">([^<]+)</g)].map((m) => m[1]), ["Type", "Sale value", "Frequency", "Source"]);
  assert.match(details, /Residential Window Cleaning[\s\S]*\$1,380<[\s\S]*Quarterly[\s\S]*Referral/);
  // CONTACT: copy on the phone and the email, text and call kept, the primary property in the same card
  assert.match(details, /class="rs-label">Contact</);
  assert.match(details, /data-copy="\(763\) 555-0100"[\s\S]*href="sms:\+17635550100"[\s\S]*href="tel:\+17635550100"/);
  assert.match(details, /data-copy="pat@example.com"/);
  assert.match(details, /Primary property[\s\S]*1 Example Ave[\s\S]*Mound, MN, 55364 · gate 4321/);
  // Flyra's quick row: Schedule, Estimate, Invoice, Plan, each a new one for them
  assert.deepEqual([...details.matchAll(/data-quick="([a-z]+)"/g)].map((m) => m[1]), ["job", "quote", "invoice", "plan"]);
  assert.match(details, /href="#\/jobs\/new\/ct_00000000000000000001"[\s\S]*href="#\/quotes\/new\/ct_00000000000000000001"[\s\S]*href="#\/invoices\/new\/ct_00000000000000000001"[\s\S]*href="#\/plans\/new\/ct_00000000000000000001"/);
  // PAYMENT, Customer notes, the compact rows, Properties, Files; Convert to Lead and Delete Customer at the foot
  assert.deepEqual(order(details, ["payment", "notes", "about", "properties", "files"]), ["payment", "notes", "about", "properties", "files"]);
  assert.match(details, /PAYMENT-PHONE/, "the module's phone rows");
  assert.match(details, /data-notes="ct-notes"/);
  assert.match(details, /data-portal/);
  assert.match(details, /data-to-lead[\s\S]*Convert to Lead[\s\S]*data-archive[\s\S]*Delete Customer/);
  assert.doesNotMatch(details, /class="ct-sv-l">Lifetime value/, "the lifetime value is under More details");
  // Service: SERVICE PLAN, SCHEDULED JOBS, PENDING JOBS, BILLING CYCLES, INVOICES (2), then Quotes; a caps label over each card
  const service = paneOf(h, "service");
  assert.deepEqual(order(service, ["plan", "visits", "pending", "cycles", "invoices", "quotes"]), ["plan", "visits", "pending", "cycles", "invoices", "quotes"]);
  assert.match(service, /class="rs-label">Invoices \(2\)</);
  assert.match(service, /class="rs-label">Pending Jobs \(2\)</, "a count already in the title isn't said twice");
  assert.match(service, /class="rs-label">Billing Cycles<\/h3><a href="#\/plans\/new\/x" class="rs-pb line" aria-label="New plan">[\s\S]*<span>New<\/span>/);
  assert.match(service, /No billing cycles yet\./);
  // Activity: the timeline, Messages, Calls, then Follow-ups, Deals, Tasks, Texts and email
  const act = paneOf(h, "activity");
  assert.deepEqual(order(act, ["activity", "messages", "calls", "followups", "deals", "tasks", "consent"]), ["activity", "messages", "calls", "followups", "deals", "tasks", "consent"]);
  assert.match(act, /Note added/);
});

test("the header on a phone: Automations (on: texts go out; off: Mute), the pencil; a desk, a lead and a tech keep their page", () => {
  const s = page();
  const tools = C.default.tools(s, ctx()).filter(Boolean);
  assert.deepEqual(tools.map((t) => t.label), ["Automations", "Edit"]);
  assert.equal(tools[0].switch, true);
  assert.equal(C.default.tools(page({ contact: { ...contact, automations_paused: { sms: { reason: "Call first" } } } }), ctx()).filter(Boolean)[0].switch, false, "paused: off");
  assert.deepEqual(C.default.tools(page(), ctx(["contacts:write"])).filter(Boolean).map((t) => t.label), ["Edit"], "no switch without consent:edit");
  assert.deepEqual(C.default.tools(page({ phone: false }), ctx()).filter(Boolean).map((t) => t.label), ["Edit"], "a desk: the pencil only");
  const sw = text(router.topSwitch(tools[0], 0));
  assert.match(sw, /Automations[\s\S]*role="switch" aria-checked="true" aria-label="Automations"/);
  assert.match(sw, /data-top-tool="0"/);
  // a desk: the two columns and Rotor's six tabs
  assert.deepEqual(panes(text(C.default.render(page({ phone: false }), ctx()))), ["service", "payments", "conversation", "opportunities", "activity", "files"]);
  assert.match(text(C.default.render(page({ phone: false }), ctx())), /PLAN-DESK/);
  // a lead on a phone keeps the lead page; a technician too
  assert.equal(C.phoneLayout(page({ contact: { ...contact, lifecycle: "lead" } })), false);
  assert.equal(C.phoneLayout(page({ tech: true })), false);
  assert.equal(C.phoneLayout(page({ contact: { ...contact, lifecycle: "former_customer" } })), true);
  // archived: Restore at the foot, no quick row, no Convert or Delete
  const ah = text(C.default.render(page({ contact: { ...contact, lifecycle: "archived" } }), ctx()));
  assert.match(ah, /data-restore/);
  assert.doesNotMatch(ah, /data-to-lead|data-archive|data-quick/);
  // someone who may not see money or write: no sale value, no quick row, no foot buttons
  const lim = text(C.default.render(page(), ctx(["contacts:read"])));
  assert.deepEqual([...lim.matchAll(/class="ct-sv-l">([^<]+)</g)].map((m) => m[1]), ["Type", "Next visit", "Frequency", "Source"]);
  assert.doesNotMatch(lim, /data-quick|data-to-lead|data-archive/);
  // an old ?tab= card lands on the phone's tab
  assert.equal(C.phonePaneOf({ key: "payment" }), "details");
  assert.equal(C.phonePaneOf({ key: "something", mod: "x", tab: "payments" }), "service");
  assert.equal(C.phonePaneOf({ key: "something", mod: "x", tab: "opportunities" }), "activity");
});

test("the modules' phone rows: plans and Billing Cycles, the card on file, invoices, scheduled and pending jobs", () => {
  // plans: Rotor's plan card; a billing cycle is a live plan billed on the 1st
  const r = { id: "pl_00000000000000000001", nm: "Quarterly plan", ck: "quarterly", st: "active", sv: 138000, tm: 12, ap: true, ar: 1, ag: "signed", nx: "2027-03" };
  const lights = { ...r, id: "pl_00000000000000000002", nm: "Christmas lights plan", ck: "lights_annual", ap: false };
  const row = text(PLANS.planPhoneRow(r, { billing: { mode: "first_of_month", autopay: true }, term: { initial_months: 12 } }));
  assert.match(row, /Quarterly plan[\s\S]*Quarterly[\s\S]*Duration:[\s\S]*12 months[\s\S]*Sale Value:[\s\S]*\$1,380[\s\S]*Start of Month[\s\S]*Auto-Pay/);
  assert.match(row, /<a href="#\/plans\/pl_00000000000000000001" class="rnd grey sm" aria-label="Agreement: Signed. Open the plan">/);
  assert.equal(PLANS.billingOf(lights), "after_visit", "a lights plan bills after its visit");
  assert.equal(PLANS.billingOf(r), "barta_standard", "the catalog's default");
  assert.deepEqual(PLANS.cyclePlans([r, lights, { ...r, id: "pl_3", st: "cancelled" }], {}).map((x) => x.nm), ["Quarterly plan"]);
  assert.deepEqual(PLANS.cyclePlans([r], { [r.id]: { billing: { mode: "after_visit" } } }), [], "billed after each visit: no cycle");
  const pc = PLANS.default.cards({ id: "ct_1", rows: [r], plans: {}, agreements: [] }, { can: () => true, phone: true });
  assert.deepEqual(pc.map((x) => [x.key, x.tab, x.title]), [["plan", "service", "Service Plan"], ["cycles", "payments", "Billing Cycles"]]);
  assert.match(text(pc[1].body), /Quarterly plan[\s\S]*Bills on the 1st after visit 1 · next/);
  assert.equal(pc[1].add.href, "#/plans/new/ct_1", "+ New: a new plan (a cycle belongs to a plan)");
  assert.equal(PLANS.default.cards({ id: "ct_1", rows: [], plans: {}, agreements: [] }, { can: () => false })[1].add, null, "no + New without plans:write");
  // money: the method on file; a bank account reads BANK, ACH; the black round button texts a new link
  const bank = text(MONEY.methodRow({ status: "on_file", pm: { kind: "us_bank_account", brand: "Example Bank", last4: "6789", added: "2026-09-07T15:00:00.000Z" } }, true));
  assert.match(bank, /ct-pm-tile bank"[^>]*>BANK<[\s\S]*EXAMPLE BANK ending in 6789[\s\S]*Bank account \(ACH\)[\s\S]*Added Sep 7, 2026[\s\S]*data-mn-card-link/);
  const card = text(MONEY.methodRow({ status: "expired", pm: { kind: "card", brand: "visa", last4: "4242", exp_month: 4, exp_year: 2026 } }, false));
  assert.match(card, />VISA<[\s\S]*Card · exp 04\/26[\s\S]*Expired/);
  assert.doesNotMatch(card, /data-mn-card-link/);
  const paid = text(MONEY.phoneInvoiceRow({ id: "in_1", n: "SINV-0002", st: "paid", tot: 39500, bal: 0, pd: "2026-09-08T15:00:00.000Z" }, [{ inv: "in_1", st: "succeeded", m: "check" }]));
  assert.match(paid, /#SINV-0002[\s\S]*\$395\.00[\s\S]*Paid Sep 8, 2026 via Check/);
  assert.match(text(MONEY.phoneInvoiceRow({ id: "in_2", n: "SINV-0003", st: "open", tot: 62500, bal: 62500, due: "2026-11-16" })), /\$625\.00[\s\S]*Due Nov 16, 2026/);
  // work: Scheduled Jobs is the last two done, then the booked ones, by date; Pending: Schedule on the next one, "..." on the others
  const v = (id, date) => ({ id, date });
  assert.deepEqual(WORK.phoneVisits([v("a", "2026-05-01"), v("b", "2026-08-31"), v("c", "2026-07-01")], [v("e", "2027-04-16"), v("d", "2026-11-16")]).map((x) => x.id), ["c", "b", "d", "e"]);
  const j = (id, m) => ({ id, target_month: m, number_label: "S-00000" + id.slice(-1), title: "Visit", totals: { total_cents: 34500 } });
  const first = text(WORK.phonePendingRow(j("jb_1", "2027-07"), true, true));
  const next = text(WORK.phonePendingRow(j("jb_2", "2027-09"), true, false));
  assert.match(first, /data-hold="" data-pend-hold="jb_1"[\s\S]*<i>Jul 2027<\/i>[\s\S]*Pending[\s\S]*\$345[\s\S]*Schedule/);
  assert.match(next, /data-pend-more="jb_2"/);
  assert.doesNotMatch(next, />Schedule</);
  assert.doesNotMatch(text(WORK.phonePendingRow(j("jb_3", "2027-09"), false, true)), /Schedule<|data-pend-more/, "no booking without schedule:write");
});
