// Fixtures for the money module's tests (design §12.5): synthetic people
// only (made-up names, 555 numbers, example.com emails), a pinned clock
// (America/Chicago; Tuesday 2026-11-17 09:00 unless a test pins another
// time). Nothing here ever reaches the network: payments are dry-run, and
// the Stripe driver's own tests use a mocked fetch.

import { crmTest } from "../../helpers/crm-http.mjs";
import { pin, advance, days, hours, minutes } from "../../helpers/crm-clock.mjs";
import { fakeServices } from "../../helpers/crm-fixtures.mjs";

export const store = await import("../../../netlify/lib/crm-store.mjs");
await import("../../../netlify/lib/crm/modules/index.mjs");
export const ids = await import("../../../netlify/lib/crm/core/ids.mjs");
export const clock = await import("../../../netlify/lib/crm/core/clock.mjs");
export const T = await import("../../../netlify/lib/crm/core/templates.mjs");
export const OFF = await import("../../../netlify/lib/crm/modules/work/office.mjs");
export const PORTAL = await import("../../../netlify/lib/crm/portal/core.mjs");
export const B = await import("../../../netlify/lib/crm/modules/money/balance.mjs");
export const U = await import("../../../netlify/lib/crm/modules/money/upsert.mjs");
export const INV = await import("../../../netlify/lib/crm/modules/money/invoices.mjs");
export const CH = await import("../../../netlify/lib/crm/modules/money/charge.mjs");
export const CO = await import("../../../netlify/lib/crm/modules/money/checkout.mjs");
export const RF = await import("../../../netlify/lib/crm/modules/money/refunds.mjs");
export const CR = await import("../../../netlify/lib/crm/modules/money/credits.mjs");
export const CARDS = await import("../../../netlify/lib/crm/modules/money/cards.mjs");
export const AP = await import("../../../netlify/lib/crm/modules/money/autopay.mjs");
export const REC = await import("../../../netlify/lib/crm/modules/money/reconcile.mjs");
export const GATE = await import("../../../netlify/lib/crm/modules/money/gate.mjs");
export const COMMON = await import("../../../netlify/lib/crm/modules/money/common.mjs");
const sweeps = await import("../../../netlify/lib/crm/core/sweeps.mjs");
export { pin, advance, days, hours, minutes, fakeServices };

export const AS = (user) => ({ by: user.id, origin: "api", actor_kind: "user", requestId: "test" });
export const ROTOR = { system_of_record: "rotor", paused: false };
export const AUTOMATION = { by: "system:test", origin: "worker", actor_kind: "automation", requestId: "test", mode: ROTOR };
export const HOOK = { by: "hook:stripe", origin: "hook", actor_kind: "automation", requestId: "test", mode: ROTOR };
export const IMPORT = { by: "import", origin: "import", actor_kind: "import", requestId: "test" };
export const scope = (fn) => store.withStoreScope({ requestId: "test" }, fn);
export const TUE_0900 = "2026-11-17T15:00:00Z";
export const IPHONE = "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 Safari/604.1";
export const PJSON = { "content-type": "application/json", "x-crm-portal": "1", origin: "https://www.bartawindowwashing.com", "user-agent": IPHONE };
export const uuid = (n) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;

export async function setup(now = TUE_0900, { env = {} } = {}) {
  const t = await crmTest({ now, env });
  globalThis.__crmSleepScale = 0.01;
  sweeps.clearSweepCache();
  sweeps.clearSeedCache();
  const owner = await t.user("owner", { extra: { first_name: "Olive" } });
  const owner2 = await t.user("owner", { extra: { first_name: "Otto" } });
  const admin = await t.user("admin");
  const tech = await t.user("tech", { extra: { first_name: "Theo" } });
  const tech2 = await t.user("tech", { extra: { first_name: "Tess" } });
  await scope(() => OFF.seedChecklists({ write: () => AUTOMATION }));
  await scope(() => T.seedTemplates(AUTOMATION));
  T.clearTemplateSeedCache();
  const done = t.done.bind(t);
  t.done = () => { delete globalThis.__crmSleepScale; done(); };
  return { t, owner, owner2, admin, tech, tech2 };
}

let n = 0;
// A customer the office typed in (a shadow contact while Rotor is in charge: sandboxed).
export async function customer(as, fields = {}) {
  n += 1;
  return scope(async () => {
    const w = as && as.id ? AS(as) : as;
    const c = (await store.createRecord("contact", {
      first_name: "Pat", last_name: `Sample${n}`, phones: [{ e164: `+1763555${String(300 + (n % 600)).padStart(4, "0")}`, sms: true, primary: true }],
      emails: [{ address: `pat.sample${n}@example.com`, primary: true }], lifecycle: "customer", source: { source: "Website quote form" },
      consent: { sms_service: { state: "granted", source: "website_form" } },
      billing_address: { street1: `${100 + n} Example Ave`, city: "Delano", state: "MN", zip: "55328" }, ...fields,
    }, w)).data;
    return c;
  });
}
// The office's test contact (flags.test): sandboxed whatever made it.
export const testContact = (as, fields = {}) => customer(as, { first_name: "Terry", flags: { test: true }, ...fields });
// A customer the Rotor import brought in (not sandboxed before cutover).
export async function importedCustomer(fields = {}) {
  n += 1;
  return scope(async () => (await store.createRecord("contact", {
    first_name: "Robin", last_name: `Imported${n}`, phones: [{ e164: `+1763555${String(1300 + (n % 600)).padStart(4, "0")}`, sms: true }], lifecycle: "customer",
    consent: { sms_service: { state: "granted", source: "import" } }, source: { source: "Returning Customer" },
    import: { run_id: "ir_00000000000000000001", at: "2026-11-08T00:00:00.000Z", hash: "0".repeat(64) }, ...fields,
  }, IMPORT)).data);
}

export const LINES = [{ title: "Exterior window cleaning", qty_milli: 1000, unit_cents: 29500, service_type: "Residential Window Cleaning" }];

// A job with one visit for the given techs (not finished).
export async function bookedJob(as, contact, { techs = [], lines = LINES, spec = {}, date = "2026-11-17" } = {}) {
  return scope(async () => {
    const [id] = await OFF.createJobs([{ contact_id: contact.id, kind: "standard", lines, ...spec }], `test-op-${++n}`, "manual", AS(as));
    const r = await OFF.createVisit({ job_id: id, date, start: "08:00", end: "10:00", window: { type: "window", minutes: 120 }, assignee_ids: techs.map((u) => u.id) }, AS(as));
    return { job: (await store.getRecord("job", id)).data, visit: r.visit };
  });
}
// ... and finished by the office (job.completed goes out; run the worker to let Money hear it).
export async function finishedJob(t, as, contact, opts = {}) {
  const { job, visit } = await bookedJob(as, contact, opts);
  const g = await scope(() => store.getRecord("visit", visit.id));
  const r = await t.api(`/visits/${visit.id}/done`, { method: "POST", as, body: {}, ifMatch: g.etag });
  if (r.status !== 200) throw new Error("done failed: " + JSON.stringify(r.body));
  return { job: (await scope(() => store.getRecord("job", job.id))).data, visit };
}

// An issued invoice made by hand through the API. → the invoice record
let c = 100;
export async function openInvoice(t, as, contact, { cents = 29500, job_ids, issue = true, lines } = {}) {
  const r = await t.api("/invoices", { method: "POST", as, body: { contact_id: contact.id, lines: lines || [{ description: "Exterior window cleaning", unit_cents: cents }], ...(job_ids ? { job_ids } : {}), issue, client_id: uuid(++c), use_credit: false } });
  if (r.status !== 201) throw new Error("invoice failed: " + JSON.stringify(r.body));
  return r.body.data.invoice;
}

// A finished job whose invoice the worker made and issued (job.completed → Money). → { job, visit, invoice }
export async function jobInvoice(t, as, contact, opts = {}) {
  const { job, visit } = await finishedJob(t, as, contact, opts);
  await drain(t);
  const invoice = recs(t, "invoice").find((i) => (i.job_ids || []).includes(job.id));
  if (!invoice) throw new Error("no invoice was made for the job");
  return { job, visit, invoice };
}

// A Checkout Session as Stripe hands it back once paid (the webhook's re-fetch, the return page).
export const sessionObject = (id, inv, pi, { tip = 0 } = {}) => ({
  id, object: "checkout.session", mode: "payment", status: "complete", payment_status: pi.status === "succeeded" ? "paid" : "unpaid",
  metadata: { crm_invoice_id: inv.id, crm_contact_id: inv.contact_id, tip_cents: String(tip) }, payment_intent: pi,
});

export const invoiceOf = async (id) => (await scope(() => store.getRecord("invoice", id))).data;
export const paymentOf = async (id) => { const g = await scope(() => store.getRecord("payment", id)); return g ? g.data : null; };
export const recs = (t, type) => t.stores.data.keys(`rec/${type}/`).map((k) => t.stores.data.json(k));
export const outbox = (t, kind) => recs(t, "outbox").filter((o) => !kind || o.kind === kind);
export const texts = (t, key) => recs(t, "outbox").filter((o) => o.kind === "sms" && (!key || o.template_key === key));
export const alog = (t) => t.stores.data.keys("alog/");
export const queued = (t, name) => t.stores.data.keys("q/").map((k) => t.stores.data.json(k)).filter((x) => !name || x.kind === name || (x.data && x.data.name === name));

// Runs the fast lane a few times (events, listeners, queued sends).
export async function drain(t, passes = 4) {
  for (let i = 0; i < passes; i++) await t.runWorker({ lane: "fast" });
}

// A portal session for a scope (link → POST open → the scoped cookie).
export async function portalCookie(t, contactId, scopeOf) {
  const l = await scope(() => PORTAL.createPortalLink({ contact_id: contactId, scope: scopeOf }));
  const r = await t.portal("/api/portal/open", { method: "POST", headers: PJSON, body: { code: l.code } });
  const ck = t.setCookies(r).find((x) => x.startsWith("barta_portal="));
  if (!ck) throw new Error("no portal cookie: " + JSON.stringify(r.body));
  return ck.split(";")[0];
}

// A PaymentIntent as Stripe would hand it back (for the handlers every path shares).
export const piObject = (id, inv, { status = "succeeded", amount, tip = 0, pm, attempt } = {}) => ({
  id, object: "payment_intent", status, amount: amount ?? inv.balance_cents + tip, amount_received: status === "succeeded" ? amount ?? inv.balance_cents + tip : 0,
  metadata: { crm_invoice_id: inv.id, crm_contact_id: inv.contact_id, tip_cents: String(tip), ...(attempt ? { crm_attempt_id: attempt } : {}) },
  latest_charge: status === "succeeded" ? { id: `ch_${id}`, balance_transaction: { fee: 886 } } : null,
  payment_method: pm || { id: "pm_test_card", type: "card", card: { brand: "visa", last4: "4242", exp_month: 12, exp_year: 2030 } },
});

// Puts a (dry-run) card on file for a contact, as a saved setup would.
export async function saveCard(contact, pmId = "dry_pm_card_ok", ctx = AUTOMATION) {
  return scope(() => CARDS.recordSavedMethod(contact.id, { id: pmId, kind: /ach/.test(pmId) ? "us_bank_account" : "card", brand: "visa", last4: "4242", exp_month: 12, exp_year: 2030 }, {}, { by: "portal", origin: "portal", actor_kind: "portal", requestId: "test", ...(ctx.mode ? { mode: ctx.mode } : {}) }));
}
