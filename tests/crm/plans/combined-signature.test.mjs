// M3b acceptance: one signature for the quote and the plan (design §5.4
// "Plans sold through a quote are signed once", §11.4
// "combined-signature.test.mjs"): plans.fromQuoteOption with the quote's
// signature creates the agreement SIGNED, with the same body_sha256 as the
// text the customer saw (frozen in the quote version by
// plans.agreementForOption); without a signature, or with a text that
// doesn't match, the plan waits for its agreement. Only an owner-approved
// template is ever shown (D10).
import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { setup, customer, planOf, recOf, scope, store, AG, services, AS, drain } from "./fixtures.mjs";

const sha = (s) => createHash("sha256").update(s).digest("hex");
const option = (o = {}) => ({
  id: "op_plan", name: "Quarterly plan", kind: "plan",
  plan: { catalog_key: "quarterly", frequency: { interval: "month", count: 3 }, visits_per_year: 4, term_months: 12, billing: "barta_standard", autopay: false, auto_renew: true },
  lines: [{ id: "ln_ext", title: "Exterior Window Cleaning", qty_milli: 1000, unit_cents: 29500, total_cents: 29500, scope: { type: "specific", visits: [1, 3, 4] } },
    { id: "ln_int", title: "Interior Window Cleaning", qty_milli: 1000, unit_cents: 16000, total_cents: 16000, scope: { type: "specific", visits: [2] } },
    { id: "ln_scr", title: "Screen Cleaning", qty_milli: 20000, unit_cents: 500, total_cents: 10000, optional: true, selected: true, scope: { type: "specific", visits: [1, 3, 4] } },
    { id: "ln_trk", title: "Track Detailing", qty_milli: 8000, unit_cents: 800, total_cents: 6400, optional: true, selected: false, scope: { type: "specific", visits: [1, 3, 4] } }],
  discounts: [{ id: "dc_plan", key: "plan_quarterly", name: "Quarterly plan discount", type: "fixed", value: 10000, scope: { type: "all" }, stack_group: "plan" }], ...o,
});
const quoteOf = (c) => ({ id: "qt_0000000000000000000q", contact_id: c.id, contact_name: `${c.first_name} ${c.last_name}`, property_id: c.primary_property_id, agreement: { require_card: false }, number_label: "SQ-0001" });

async function frozenVersion(c, opt) {
  const shown = await scope(() => AG.agreementForOption(quoteOf(c), { options: [opt] }, opt));
  return { id: "qv_0000000000000000000v", sha256: "1".repeat(64), options: [opt], plan_agreements: { [opt.id]: shown } };
}
const signatureFor = (version, opt, extra = {}) => ({
  file_id: "fl_0000000000000000000s", name_typed: "Pat Sample", method: "portal", by: null, ip_hash: "abcd", ua: "iphone", at: "2026-11-17T15:00:00.000Z",
  version_id: version.id, version_sha256: version.sha256, body_sha256: version.plan_agreements[opt.id].body_sha256, template_id: version.plan_agreements[opt.id].template_id, template_version: 1, ...extra,
});
const portalCtx = { by: "portal", origin: "portal", actor_kind: "portal", requestId: "t", op: "convert--qt_0000000000000000000q--1" };

test("the approved text is frozen; fromQuoteOption with that signature makes the agreement signed, the same body_sha256, and the plan active", async () => {
  const { t, owner } = await setup();
  try {
    const c = await customer(owner);
    const opt = option();
    const version = await frozenVersion(c, opt);
    const shown = version.plan_agreements[opt.id];
    assert.ok(shown, "an approved template: text to show");
    assert.equal(shown.body_sha256, sha(shown.body_rendered));
    assert.match(shown.body_rendered, /Quarterly plan service agreement/);
    assert.match(shown.body_rendered, /Pat Sample\d+/, "the customer's name");
    assert.match(shown.body_rendered, /\$195\.00 a visit \(visit 2 of each year: \$60\.00\)/, "per-visit price without the optional add-ons");
    assert.match(shown.body_rendered, /Unlimited Touch-Ups, 7-Day Rain Guarantee and Free Hard Water Removal/);
    assert.match(shown.body_rendered, /plan discount of \$100\.00/);
    assert.match(shown.body_rendered, /BARTA WINDOW WASHING LLC/);
    assert.doesNotMatch(shown.body_rendered, /—|licensed|refund/i, "Barta's voice: no em dashes, insured not licensed, re-clean not refund");
    const out = await scope(() => services.call("plans.fromQuoteOption", quoteOf(c), version, opt, "convert--qt_0000000000000000000q--1", { signature: signatureFor(version, opt) }, portalCtx));
    assert.ok(out.plan_id && out.agreement_id);
    assert.equal(out.job_ids.length, 4, "a job per visit of the first term");
    const ag = await recOf("agreement", out.agreement_id);
    assert.equal(ag.status, "signed");
    assert.equal(ag.source, "quote_approval");
    assert.equal(ag.body_sha256, shown.body_sha256, "the same text the customer saw");
    assert.equal(ag.body_rendered, shown.body_rendered);
    assert.equal(ag.quote_version_id, version.id);
    assert.equal(ag.signature.name_typed, "Pat Sample");
    assert.equal(ag.signature.drawn_file_id, "fl_0000000000000000000s");
    assert.equal(ag.signature.method, "portal");
    const p = await planOf(out.plan_id);
    assert.equal(p.status, "active");
    assert.equal(p.agreement_id, ag.id);
    assert.equal(p.agreement_status, "signed");
    assert.deepEqual(p.lines.map((l) => l.id), ["ln_ext", "ln_int", "ln_scr"], "the chosen add-on stays, the one not picked goes; ids kept");
    assert.equal(p.quote_id, "qt_0000000000000000000q");
    // the same op again (a retried convert step): nothing twice
    const again = await scope(() => services.call("plans.fromQuoteOption", quoteOf(c), version, opt, "convert--qt_0000000000000000000q--1", { signature: signatureFor(version, opt) }, portalCtx));
    assert.deepEqual(again, out);
    assert.equal(t.stores.data.keys("rec/plan/").length, 1);
    assert.equal(t.stores.data.keys("rec/agreement/").length, 1);
    assert.equal(t.stores.data.keys("rec/job/").length, 4);
    await drain(t, 2);
    assert.equal((await planOf(out.plan_id)).status, "active");
  } finally { t.done(); }
});

test("in person on the staff phone: the signature records the staff member", async () => {
  const { t, owner } = await setup();
  try {
    const c = await customer(owner);
    const opt = option();
    const version = await frozenVersion(c, opt);
    const out = await scope(() => services.call("plans.fromQuoteOption", quoteOf(c), version, opt, "convert--qt_0000000000000000000q--1", { signature: signatureFor(version, opt, { method: "in_person", by: owner.id }) }, portalCtx));
    const ag = await recOf("agreement", out.agreement_id);
    assert.equal(ag.signature.method, "in_person");
    assert.equal(ag.signature.staff_user_id, owner.id);
  } finally { t.done(); }
});

test("approved by phone (no signature), or a text that doesn't match what was signed: the plan waits for its agreement", async () => {
  const { t, owner } = await setup();
  try {
    const c = await customer(owner);
    const opt = option();
    const version = await frozenVersion(c, opt);
    const phone = await scope(() => services.call("plans.fromQuoteOption", quoteOf(c), version, opt, "convert--qt_0000000000000000000q--1", {}, AS(owner)));
    assert.equal(phone.agreement_id, null);
    const p = await planOf(phone.plan_id);
    assert.equal(p.status, "pending");
    assert.deepEqual(p.pending_reasons, ["signature"]);
    const c2 = await customer(owner);
    const v2 = await frozenVersion(c2, opt);
    const bad = await scope(() => services.call("plans.fromQuoteOption", quoteOf(c2), v2, opt, "convert--qt_0000000000000000000r--1", { signature: signatureFor(v2, opt, { body_sha256: "0".repeat(64) }) }, portalCtx));
    assert.equal(bad.agreement_id, null, "a hash that isn't the shown text's signs nothing");
    assert.equal((await planOf(bad.plan_id)).status, "pending");
  } finally { t.done(); }
});

test("D10: an unapproved template is never shown on a quote; an edit after approval needs approving again", async () => {
  const { t, owner } = await setup(undefined, { approve: false });
  try {
    const c = await customer(owner);
    const opt = option();
    assert.equal(await scope(() => AG.agreementForOption(quoteOf(c), { options: [opt] }, opt)), null, "drafts aren't shown");
    const id = AG.seedTemplateId("quarterly");
    assert.equal((await t.api(`/agreement-templates/${id}/approve`, { method: "POST", as: (await t.user("admin")), body: {} })).status, 403, "owners approve");
    assert.equal((await t.api(`/agreement-templates/${id}/approve`, { method: "POST", as: owner, body: {} })).status, 200);
    const shown = await scope(() => AG.agreementForOption(quoteOf(c), { options: [opt] }, opt));
    assert.ok(shown);
    const g = await t.api(`/agreement-templates/${id}`, { as: owner });
    const edited = await t.api(`/agreement-templates/${id}`, { method: "PATCH", as: owner, ifMatch: g.headers.get("etag"), body: { body_md: `${g.body.data.body_md}\n\nOne more line.` } });
    assert.equal(edited.status, 200, JSON.stringify(edited.body));
    assert.equal(edited.body.data.version, 2);
    assert.equal(edited.body.data.approved, false);
    assert.equal(await scope(() => AG.agreementForOption(quoteOf(c), { options: [opt] }, opt)), null, "not shown until approved again");
    const bad = await t.api(`/agreement-templates/${id}`, { method: "PATCH", as: owner, ifMatch: edited.headers.get("etag"), body: { body_md: "Hi {{quote_link}}" } });
    assert.equal(bad.status, 400, "only the agreement's variables");
    // staff can't send an agreement from an unapproved text
    const { plan } = await (await import("./fixtures.mjs")).staffPlan(t, owner, { contact: c });
    const send = await t.api(`/plans/${plan.id}/send-agreement`, { method: "POST", as: owner, body: { channels: ["sms"] } });
    assert.equal(send.status, 409);
    assert.match(send.body.error.message, /An owner approves/);
  } finally { t.done(); }
});

test("the quote module's own fake contract is met: the frozen text and the plan come back in the shapes Quotes reads", async () => {
  const { t, owner } = await setup();
  try {
    const c = await customer(owner);
    const opt = option();
    const shown = await scope(() => services.call("plans.agreementForOption", quoteOf(c), { options: [opt] }, opt, {}));
    assert.deepEqual(Object.keys(shown).sort(), ["body_rendered", "body_sha256", "template_id", "template_version"]);
    assert.equal(await scope(() => services.call("plans.agreementForOption", quoteOf(c), { options: [opt] }, { ...opt, kind: "one_time" }, {})), null);
    const lightsOpt = option({ id: "op_lt", name: "Christmas lights plan", plan: { catalog_key: "lights_annual", frequency: { interval: "year", count: 1 }, visits_per_year: 1, term_months: 12, billing: "after_visit", auto_renew: true }, lines: [{ id: "ln_lt", title: "Christmas Lights", qty_milli: 1000, unit_cents: 90000, total_cents: 90000 }], discounts: [] });
    assert.match((await scope(() => AG.agreementForOption(quoteOf(c), { options: [lightsOpt] }, lightsOpt))).body_rendered, /Christmas light installation agreement|takedown/i);
    await scope(() => store.getRecord("plan", "pl_00000000000000000000"));
  } finally { t.done(); }
});
