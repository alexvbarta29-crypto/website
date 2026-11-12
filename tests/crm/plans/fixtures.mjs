// Fixtures for the plans module's tests (design §12.5): synthetic people
// only (made-up names, 555 numbers, example.com emails), a pinned clock
// (America/Chicago; Tuesday 2026-11-17 09:00 unless a test pins another
// time), the module's seeds (agreement drafts), the quotes price book and
// the core templates. Scheduling (M4a) is merged, so plan jobs are real.

import { crmTest } from "../../helpers/crm-http.mjs";
import { pin, advance, days, hours } from "../../helpers/crm-clock.mjs";
import { fakeServices, BYTES } from "../../helpers/crm-fixtures.mjs";

export const store = await import("../../../netlify/lib/crm-store.mjs");
await import("../../../netlify/lib/crm/modules/index.mjs");
export const ids = await import("../../../netlify/lib/crm/core/ids.mjs");
export const clock = await import("../../../netlify/lib/crm/core/clock.mjs");
export const T = await import("../../../netlify/lib/crm/core/templates.mjs");
export const M = await import("../../../netlify/lib/crm/modules/plans/machine.mjs");
export const PL = await import("../../../netlify/lib/crm/modules/plans/plans.mjs");
export const AG = await import("../../../netlify/lib/crm/modules/plans/agreements.mjs");
export const LT = await import("../../../netlify/lib/crm/modules/plans/lights.mjs");
export const CAT = await import("../../../netlify/lib/crm/modules/plans/catalog.mjs");
export const IMP = await import("../../../netlify/lib/crm/modules/plans/import-rotor.mjs");
export const PORTAL = await import("../../../netlify/lib/crm/portal/core.mjs");
export const QSEED = await import("../../../netlify/lib/crm/modules/quotes/seed.mjs");
export const WORK = await import("../../../netlify/lib/crm/modules/work/office.mjs");
export const services = await import("../../../netlify/lib/crm/core/services.mjs");
export const ops = await import("../../../netlify/lib/crm/core/ops.mjs");
const sweeps = await import("../../../netlify/lib/crm/core/sweeps.mjs");
export { pin, advance, days, hours, fakeServices, BYTES };

export const AS = (user) => ({ by: user.id, origin: "api", actor_kind: "user", requestId: "test" });
export const AUTOMATION = { by: "system:test", origin: "worker", actor_kind: "automation", requestId: "test", mode: { system_of_record: "rotor", paused: false } };
export const IMPORT = { by: "import", origin: "import", actor_kind: "import", requestId: "test" };
export const scope = (fn) => store.withStoreScope({ requestId: "test" }, fn);
export const TUE_0900 = "2026-11-17T15:00:00Z";
export const IPHONE = "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 Safari/604.1";
export const PJSON = { "content-type": "application/json", "x-crm-portal": "1", origin: "https://www.bartawindowwashing.com", "user-agent": IPHONE };

export async function setup(now = TUE_0900, { approve = true, money = false } = {}) {
  const t = await crmTest({ now });
  globalThis.__crmSleepScale = 0.01;
  sweeps.clearSweepCache();
  sweeps.clearSeedCache();
  const owner = await t.user("owner", { extra: { first_name: "Olive" } });
  const admin = await t.user("admin");
  const tech = await t.user("tech", { extra: { first_name: "Theo" } });
  await scope(() => QSEED.seedPriceBook({ write: () => AUTOMATION }));
  await scope(() => T.seedTemplates(AUTOMATION));
  T.clearTemplateSeedCache();
  await scope(() => WORK.seedChecklists({ write: () => AUTOMATION }));
  await scope(() => AG.seedAgreementTemplates(AUTOMATION));
  if (approve) await approveAll(owner);
  // Plans on its own: "a card on file" is Money's gate (money.cardStatus), so
  // it is hidden here unless a test asks for Money (tests/crm/money covers
  // a plan that waits for its card and activates when one is saved)
  const hide = money ? () => {} : fakeServices({ "money.cardStatus": null, "money.createDepositInvoice": null });
  const done = t.done.bind(t);
  t.done = () => { hide(); delete globalThis.__crmSleepScale; done(); };
  return { t, owner, admin, tech };
}

// What an owner does in Settings → Agreement templates: reads each draft,
// settles its "Owner check" lines (here: keeps the wording, deletes the
// checks) and approves it.
export async function approveDraft(key, owner) {
  const id = AG.seedTemplateId(key);
  await scope(async () => {
    const g = await store.getRecord("agreement_template", id);
    const body = AG.withoutOwnerChecks(g.data.body_md);
    if (body !== g.data.body_md) await AG.patchTemplate(id, { body_md: body }, { write: () => AS(owner), ifMatch: g.etag });
    await AG.approveTemplate(id, { write: () => AS(owner) });
  });
}
export async function approveAll(owner) {
  for (const key of ["biannual", "quarterly", "monthly", "custom", "lights", "one_time"]) await approveDraft(key, owner);
}

let n = 0;
// A customer the office typed in (a shadow while Rotor is in charge), with a property.
export async function customer(as, fields = {}, { town = "Delano" } = {}) {
  n += 1;
  return scope(async () => {
    const w = as && as.id ? AS(as) : as;
    const c = (await store.createRecord("contact", {
      first_name: "Pat", last_name: `Sample${n}`, phones: [{ e164: `+1763555${String(300 + (n % 600)).padStart(4, "0")}`, sms: true, primary: true }],
      emails: [{ address: `pat.sample${n}@example.com`, primary: true }], lifecycle: "customer", source: { source: "Website quote form" },
      consent: { sms_service: { state: "granted", source: "website_form" } },
      billing_address: { street1: `${100 + n} Example Ave`, city: town, state: "MN", zip: "55328" }, ...fields,
    }, w)).data;
    const p = (await store.createRecord("property", { contact_id: c.id, label: "Home", address: { street1: `${100 + n} Example Ave`, city: town, state: "MN", zip: "55328", country: "US" }, access: {}, assets: {}, photo_ids: [] }, w)).data;
    await store.updateRecord("contact", c.id, (x) => ({ ...x, primary_property_id: p.id }), w);
    return { ...c, primary_property_id: p.id, property: p };
  });
}

// A customer the Rotor import brought in (not sandboxed before cutover).
export async function importedCustomer(fields = {}) {
  n += 1;
  return scope(async () => (await store.createRecord("contact", {
    first_name: "Robin", last_name: `Imported${n}`, phones: [{ e164: `+1763555${String(1300 + (n % 600)).padStart(4, "0")}`, sms: true }], lifecycle: "customer",
    consent: { sms_service: { state: "granted", source: "import" } }, source: { source: "Returning Customer" }, billing_address: { street1: `${200 + n} Example Ave`, city: "Mound", state: "MN", zip: "55364" },
    import: { run_id: "ir_00000000000000000001", at: "2026-11-08T00:00:00.000Z", hash: "0".repeat(64) }, ...fields,
  }, IMPORT)).data);
}

export const EXT = (o = {}) => ({ title: "Exterior Window Cleaning", qty_milli: 1000, unit_cents: 29500, service_type: "Residential Window Cleaning", ...o });
export const QUARTERLY_LINES = [EXT({ scope: { type: "specific", visits: [1, 3, 4] } }), EXT({ title: "Interior Window Cleaning", unit_cents: 16000, scope: { type: "specific", visits: [2] } })];
export const QUARTERLY_DISCOUNTS = [{ name: "Quarterly plan discount", type: "fixed", value: 10000, scope: { type: "all" } }];

// A plan the office sets up (POST /plans, then the worker runs the op). → the plan record
export async function staffPlan(t, as, { contact, catalog_key = "quarterly", lines = QUARTERLY_LINES, discounts = QUARTERLY_DISCOUNTS, ...rest } = {}) {
  const c = contact || await customer(as);
  const r = await t.api("/plans", { method: "POST", as, body: { contact_id: c.id, catalog_key, lines, discounts, ...rest } });
  if (r.status !== 202) throw new Error("plan create failed: " + JSON.stringify(r.body));
  await finishRun(t, r.body.data.run_id);
  return { contact: c, plan: await planOf(r.body.data.plan_id) };
}

// An imported plan straight in the store (the import's write), with its jobs.
export async function importedPlan(contact, extra = {}) {
  const id = ids.idForRotor("plan", `rotor-pl-${contact.id}`);
  return scope(async () => (await store.createRecord("plan", {
    id, contact_id: contact.id, contact_name: `${contact.first_name} ${contact.last_name}`, kind: "recurring", catalog_key: "biannual", name: "Biannual plan",
    frequency: { interval: "month", count: 6 }, visits_per_year: 2, service_types: ["Residential Window Cleaning"], lines: [{ id: "rotor-line-1", title: "Exterior Window Cleaning", qty_milli: 1000, unit_cents: 29500, override: { cents: 29500, reason: "imported" } }],
    discounts: [{ id: "dc_r1", name: "Bi-Annual Discount", type: "fixed", value: 5000, scope: { type: "all" } }], status: "active", pending_reasons: [],
    term: { start_on: "2026-06-01", initial_months: 12, initial_end_on: "2027-05-31", current_term_n: 1, current_term_start: "2026-06-01", current_term_end: "2027-05-31", renews_every_months: 6, auto_renew: true, price_locked_until: "2027-05-31" },
    billing: { mode: "first_of_month", autopay: true, card_required: true }, perks: { touch_ups: false, rain_guarantee_days: 0, hard_water: false },
    policy: { early_cancel_clawback_cents: 5000, notice_days: 7, late_cancel_fee_cents: 5000 },
    ordinals: [{ term: 1, n: 1, k: 1, target_month: "2026-06", status: "completed", completed_on: "2026-06-10", gen: 0 }, { term: 1, n: 2, k: 2, target_month: "2026-12", status: "unscheduled", gen: 0 }],
    cancelled_job_ids: [], agreement_status: "imported_unknown", renewal: {}, origin: "import",
    import: { run_id: "ir_00000000000000000001", at: "2026-11-08T00:00:00.000Z", hash: "0".repeat(64) }, rotor: { service_plan_id: `rotor-pl-${contact.id}` }, ...extra,
  }, IMPORT)).data);
}

export const planOf = async (id) => (await scope(() => store.getRecord("plan", id))).data;
export const recOf = async (type, id) => { const g = await scope(() => store.getRecord(type, id)); return g ? g.data : null; };
export const runOf = async (id) => recOf("run", id);
export const outbox = (t) => t.stores.data.keys("rec/outbox/").map((k) => t.stores.data.json(k));
export const alog = (t) => t.stores.data.keys("alog/");
export const queued = (t, name) => t.stores.data.keys("q/").map((k) => t.stores.data.json(k)).filter((x) => !name || (x.data && x.data.name === name) || x.kind === name);

// Runs the fast lane until the run is finished (or n passes).
export async function finishRun(t, runId, passes = 8) {
  for (let i = 0; i < passes; i++) {
    const r = await runOf(runId);
    if (r && ["done", "failed", "cancelled"].includes(r.status)) return r;
    await t.runWorker({ lane: "fast" });
  }
  return runOf(runId);
}
// Runs the fast lane n times (queue items, listeners, sweeps).
export async function drain(t, n = 3) { for (let i = 0; i < n; i++) await t.runWorker({ lane: "fast" }); }

// A portal session for a scope (link → POST open → the scoped cookie).
export async function portalCookie(t, contactId, scopeObj) {
  const l = await scope(() => PORTAL.createPortalLink({ contact_id: contactId, scope: scopeObj }));
  const r = await t.portal("/api/portal/open", { method: "POST", headers: PJSON, body: { code: l.code } });
  const c = t.setCookies(r).find((x) => x.startsWith("barta_portal="));
  return c ? c.split(";")[0] : null;
}
export const signature = () => Buffer.from(BYTES.png()).toString("base64");
