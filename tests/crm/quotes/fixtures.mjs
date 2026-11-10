// Fixtures for the quotes module's tests (design §12.5): synthetic people
// only (made-up names, 555 numbers, example.com emails), a pinned clock
// (America/Chicago; Tuesday 2026-11-10 unless a test pins another time),
// fakes for the services of milestones not merged yet (§11.4 "Uses").

import { crmTest } from "../../helpers/crm-http.mjs";
import { fakeServices, BYTES } from "../../helpers/crm-fixtures.mjs";
import { pin, advance } from "../../helpers/crm-clock.mjs";

export const store = await import("../../../netlify/lib/crm-store.mjs");
await import("../../../netlify/lib/crm/modules/index.mjs");
export const P = await import("../../../netlify/lib/crm/modules/quotes/pricing.mjs");
export const Q = await import("../../../netlify/lib/crm/modules/quotes/quotes.mjs");
export const V = await import("../../../netlify/lib/crm/modules/quotes/versions.mjs");
export const A = await import("../../../netlify/lib/crm/modules/quotes/approve.mjs");
export const SEED = await import("../../../netlify/lib/crm/modules/quotes/seed.mjs");
export const T = await import("../../../netlify/lib/crm/core/templates.mjs");
export const PORTAL = await import("../../../netlify/lib/crm/portal/core.mjs");
export { pin, advance, fakeServices, BYTES };

export const AS = (user) => ({ by: user.id, origin: "api", actor_kind: "user", requestId: "test" });
export const AUTOMATION = { by: "system:test", origin: "worker", actor_kind: "automation", requestId: "test", mode: { system_of_record: "rotor", paused: false } };
export const IMPORT = { by: "import", origin: "import", actor_kind: "import", requestId: "test" };
export const scope = (fn) => store.withStoreScope({ requestId: "test" }, fn);
export const NOW = "2026-11-10T16:00:00Z";       // Tuesday 10:00 in Delano
export const IPHONE = "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 Safari/604.1";
export const PJSON = { "content-type": "application/json", "x-crm-portal": "1", origin: "https://www.bartawindowwashing.com", "user-agent": IPHONE };

export async function setup(now = NOW) {
  const t = await crmTest({ now });
  globalThis.__crmSleepScale = 0.01;
  const owner = await t.user("owner", { extra: { first_name: "Alex" } });
  const admin = await t.user("admin");
  const tech = await t.user("tech");
  await scope(() => SEED.seedPriceBook({ write: () => AUTOMATION }));
  await scope(() => T.seedTemplates(AUTOMATION));
  T.clearTemplateSeedCache();
  const done = t.done.bind(t);
  t.done = () => { delete globalThis.__crmSleepScale; done(); };
  return { t, owner, admin, tech };
}

let n = 0;
export async function makeContact(as, fields = {}) {
  n += 1;
  const r = await scope(() => store.createRecord("contact", {
    first_name: "Pat", last_name: `Sample${n}`, phones: [{ e164: `+1763555${String(300 + (n % 600)).padStart(4, "0")}`, sms: true, primary: true }],
    emails: [{ address: `pat.sample${n}@example.com`, primary: true }], lifecycle: "lead", source: { source: "Website quote form" },
    consent: { sms_service: { state: "granted", source: "website_form" } },
    billing_address: { street1: `${200 + n} Example Ave`, city: "Delano", state: "MN", zip: "55328" }, ...fields,
  }, AS(as)));
  return r.data;
}
export async function importedContact(fields = {}) {
  n += 1;
  const r = await scope(() => store.createRecord("contact", {
    first_name: "Robin", last_name: `Imported${n}`, phones: [{ e164: `+1763555${String(1300 + (n % 600)).padStart(4, "0")}`, sms: true }], lifecycle: "customer",
    source: { source: "Returning Customer" }, consent: { sms_service: { state: "granted" } }, import: { run_id: "ir_00000000000000000001", at: "2026-11-08T00:00:00.000Z", hash: "0".repeat(64) }, ...fields,
  }, IMPORT));
  return r.data;
}

export const line = (o = {}) => ({ title: "Exterior Window Cleaning", qty_milli: 1000, unit_cents: 29500, category: "windows_ext", service_type: "Residential Window Cleaning", ...o });
export const oneTime = (o = {}) => ({ name: "Exterior only", kind: "one_time", recommended: true, lines: [line()], discounts: [], ...o });
export const quarterly = (o = {}) => ({
  name: "Quarterly plan", kind: "plan", recommended: false,
  plan: { catalog_key: "quarterly", frequency: { interval: "month", count: 3 }, visits_per_year: 4, term_months: 12, billing: "barta_standard", autopay: true, auto_renew: true },
  lines: [line({ scope: { type: "specific", visits: [1, 3, 4] } }), line({ title: "Interior Window Cleaning", unit_cents: 16000, category: "windows_int", scope: { type: "specific", visits: [2] } })],
  discounts: [{ key: "plan_quarterly", name: "Quarterly plan discount", type: "fixed", value: 10000, scope: { type: "all" }, stack_group: "plan" }], ...o,
});

// A quote made and sent through the API (SMS). → { quote, version }
export async function sentQuote(t, as, { contact, options, channels = ["sms"], agreement } = {}) {
  const c = contact || await makeContact(as);
  const made = await t.api("/quotes", { method: "POST", as, body: { contact_id: c.id, options: options || [oneTime(), quarterly()], ...(agreement ? { agreement } : {}) } });
  if (made.status !== 201) throw new Error("create failed: " + JSON.stringify(made.body));
  const sent = await t.api(`/quotes/${made.body.data.id}/send`, { method: "POST", as, body: { channels } });
  if (sent.status !== 200) throw new Error("send failed: " + JSON.stringify(sent.body));
  const q = (await t.api(`/quotes/${made.body.data.id}`, { as })).body.data;
  return { contact: c, quote: q.quote, version: q.current_version };
}

// A portal session for a quote (link → POST open → the scoped cookie).
export async function portalCookie(t, quote) {
  const l = await scope(() => PORTAL.createPortalLink({ contact_id: quote.contact_id, scope: { kind: "quote", id: quote.id } }));
  const r = await t.portal("/api/portal/open", { method: "POST", headers: PJSON, body: { code: l.code } });
  const c = t.setCookies(r).find((x) => x.startsWith("barta_portal="));
  return c.split(";")[0];
}

export const signature = () => Buffer.from(BYTES.png()).toString("base64");
export const approveBody = (version, optionId, extra = {}) => ({ version_id: version.id, version_sha256: version.sha256, option_id: optionId, selected_line_ids: [], name_typed: "Pat Sample", signature_png_b64: signature(), agree: true, ...extra });

export const quoteOf = async (id) => (await scope(() => store.getRecord("quote", id))).data;
export const runOf = async (id) => (await scope(() => store.getRecord("run", id))).data;
export const outbox = (t) => t.stores.data.keys("rec/outbox/").map((k) => t.stores.data.json(k));
export const alog = (t) => t.stores.data.keys("alog/");
export const queued = (t, kind) => t.stores.data.keys("q/").map((k) => t.stores.data.json(k)).filter((x) => !kind || x.kind === kind || (x.data && x.data.name === kind));

// Fakes for Plans (M3b), Scheduling (M4a) and Money (M5): they record their
// calls. false: that module is not there (its real services are hidden too).
export function fakes({ plans = true, work = true, money = true } = {}) {
  const calls = { agreementForOption: [], fromQuoteOption: [], createJobs: [], deposit: [] };
  const map = {};
  if (plans) {
    map["plans.agreementForOption"] = async (quote, draft, option) => {
      const body = `Plan agreement for the ${option.name}. Visits ${option.plan.visits_per_year} times a year.`;
      calls.agreementForOption.push(option.id);
      return { template_id: "at_00000000000000000001", template_version: 2, body_rendered: body, body_sha256: (await import("node:crypto")).createHash("sha256").update(body).digest("hex") };
    };
    map["plans.fromQuoteOption"] = async (quote, version, option, opId, opts) => {
      calls.fromQuoteOption.push({ quote_id: quote.id, version_id: version.id, option_id: option.id, opId, signature: opts && opts.signature, lines: option.lines.map((l) => l.id) });
      return { plan_id: "pl_00000000000000000001", agreement_id: opts && opts.signature ? "ag_00000000000000000001" : null };
    };
  }
  else Object.assign(map, { "plans.agreementForOption": null, "plans.fromQuoteOption": null });
  if (work) map["work.createJobs"] = async (jobs, opId, scopeName) => { calls.createJobs.push({ jobs, opId, scope: scopeName }); return ["jb_00000000000000000001"]; };
  else map["work.createJobs"] = null;
  if (money) map["money.createDepositInvoice"] = async (quote, version, option, opId) => { calls.deposit.push({ quote_id: quote.id, opId }); return { invoice_id: "in_00000000000000000001", checkout_url: "https://checkout.stripe.com/c/pay/cs_test_example" }; };
  else map["money.createDepositInvoice"] = null;
  const restore = fakeServices(map);
  return { calls, restore };
}

// Runs the fast lane until the run is finished (or n passes).
export async function finishRun(t, runId, passes = 6) {
  for (let i = 0; i < passes; i++) {
    const r = await runOf(runId);
    if (r && ["done", "failed", "cancelled"].includes(r.status)) return r;
    await t.runWorker({ lane: "fast" });
  }
  return runOf(runId);
}
