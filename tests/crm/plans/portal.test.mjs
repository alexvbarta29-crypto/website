// M3b acceptance: the customer's pages (design §8.1-§8.5, §11.4
// "portal.test.mjs"): /p/login texts at most 1 link per 10 minutes and 3 a
// day per phone (and 20 tries an hour per IP), always with the same
// answer; a quote link cannot open the hub; the hub needs a hub link or a
// login code. The agreement page: a GET changes nothing, the beacon marks
// it viewed, signing checks the text's hash, name and "I agree", and the
// signature activates the plan; in person on the staff phone, once.
import { test } from "node:test";
import assert from "node:assert/strict";
import { setup, customer, staffPlan, planOf, recOf, outbox, portalCookie, signature, drain, pin, advance, scope, PJSON, IPHONE } from "./fixtures.mjs";

const codeIn = (text) => (String(text).match(/\/p\/([0-9A-Za-z]{10})/) || [])[1];
const loginTexts = (t) => outbox(t).filter((o) => o.template_key === "portal_login");
const login = (t, phone, ip = "203.0.113.7") => t.portal("/api/portal/login", { method: "POST", headers: { ...PJSON, "x-nf-client-connection-ip": ip }, body: { phone } });
const pretty = (e164) => `(${e164.slice(2, 5)}) ${e164.slice(5, 8)}-${e164.slice(8)}`;

test("/p/login: the same answer always; a text only for a number on file; 1 per 10 minutes and 3 a day per phone", async () => {
  const { t, owner } = await setup();
  try {
    const c = await customer(owner);
    const page = await t.portal("/p/login");
    assert.equal(page.status, 200);
    assert.match(page.text, /Text me a link/);
    assert.match(page.headers.get("content-security-policy"), /script-src 'self'/);
    assert.doesNotMatch(page.text, /<script>(?!<\/script>)/, "no inline script");
    const phone = pretty(c.phones[0].e164);
    const first = await login(t, phone);
    assert.equal(first.status, 200, JSON.stringify(first.body));
    assert.equal(first.body.data.message, "If that number is on file, we texted you a link.");
    assert.equal(loginTexts(t).length, 1, "a text with a hub link (the Outbox: dry-run)");
    const unknown = await login(t, "(763) 555-0142");
    assert.equal(unknown.body.data.message, first.body.data.message, "an unknown number gets the same answer");
    assert.equal(loginTexts(t).length, 1, "and no text");
    assert.equal((await login(t, "12")).status, 400, "not a phone number");
    // again within 10 minutes: same answer, no second text
    advance(5 * 60 * 1000);
    assert.equal((await login(t, phone)).status, 200);
    assert.equal(loginTexts(t).length, 1, "1 per 10 minutes");
    advance(11 * 60 * 1000);
    await login(t, phone);
    advance(11 * 60 * 1000);
    await login(t, phone);
    assert.equal(loginTexts(t).length, 3);
    advance(11 * 60 * 1000);
    assert.equal((await login(t, phone)).body.data.message, first.body.data.message);
    assert.equal(loginTexts(t).length, 3, "3 a day");
    // the next day it works again
    pin("2026-11-18T15:00:00Z");
    await login(t, phone, "203.0.113.8");
    assert.equal(loginTexts(t).length, 4);
  } finally { t.done(); }
});

test("/p/login: 20 tries an hour per IP, then 429", async () => {
  const { t } = await setup();
  try {
    for (let i = 0; i < 20; i++) assert.equal((await login(t, `(763) 555-0${String(100 + i)}`, "198.51.100.9")).status, 200);
    const r = await login(t, "(763) 555-0199", "198.51.100.9");
    assert.equal(r.status, 429);
    assert.equal((await login(t, "(763) 555-0199", "198.51.100.10")).status, 200, "another IP is fine");
  } finally { t.done(); }
});

test("the hub needs a hub link or a login code; a quote or agreement link never opens it", async () => {
  const { t, owner } = await setup();
  try {
    const { contact, plan } = await staffPlan(t, owner);
    const sent = await t.api(`/plans/${plan.id}/send-agreement`, { method: "POST", as: owner, body: { channels: ["sms"] } });
    const ag = sent.body.data.agreement;
    // no cookie, a quote link's cookie, an agreement link's cookie: the hub stays shut
    assert.equal((await t.portal("/p/hub")).status, 401);
    const quoteCookie = await portalCookie(t, contact.id, { kind: "quote", id: "qt_00000000000000000001" });
    assert.equal((await t.portal("/p/hub", { cookie: quoteCookie })).status, 401, "a quote link can't open the hub");
    const agCookie = await portalCookie(t, contact.id, { kind: "agreement", id: ag.id });
    assert.equal((await t.portal("/p/hub", { cookie: agCookie })).status, 401);
    assert.equal((await t.portal("/api/portal/hub/open", { method: "POST", cookie: agCookie, headers: PJSON, body: { kind: "quote", id: "qt_00000000000000000001" } })).status, 401);
    // a login code (the texted hub link) opens it
    await login(t, pretty(contact.phones[0].e164));
    const code = codeIn(loginTexts(t)[0].body);
    assert.ok(code, "the text carries the link");
    const open = await t.portal("/api/portal/open", { method: "POST", headers: PJSON, body: { code } });
    assert.equal(open.status, 200);
    assert.equal(open.body.data.location, "/p/hub");
    const hubCookie = t.setCookies(open).find((x) => x.startsWith("barta_portal=")).split(";")[0];
    const hub = await t.portal("/p/hub", { cookie: hubCookie });
    assert.equal(hub.status, 200);
    assert.match(hub.text, /Hi Pat!/);
    assert.match(hub.text, /To sign/);
    assert.match(hub.text, new RegExp(`/p/hub/agreements/${ag.id}`));
    assert.match(hub.text, /Quarterly plan/);
    assert.doesNotMatch(hub.text, /Example Ave/, "no address on the hub");
    // the agreement opens and signs from the hub (same contact only)
    const page = await t.portal(`/p/hub/agreements/${ag.id}`, { cookie: hubCookie });
    assert.equal(page.status, 200);
    const s = await t.portal(`/api/portal/hub/agreements/${ag.id}/sign`, { method: "POST", cookie: hubCookie, headers: PJSON, body: { body_sha256: ag.body_sha256, name_typed: "Pat Sample", agree: true } });
    assert.equal(s.status, 200, JSON.stringify(s.body));
    await drain(t, 2);
    assert.equal((await planOf(plan.id)).status, "active", "agreement.signed activates the plan");
    // someone else's agreement isn't there
    const other = await staffPlan(t, owner);
    const oag = (await t.api(`/plans/${other.plan.id}/send-agreement`, { method: "POST", as: owner, body: { channels: ["sms"] } })).body.data.agreement;
    assert.equal((await t.portal(`/p/hub/agreements/${oag.id}`, { cookie: hubCookie })).status, 404);
  } finally { t.done(); }
});

test("the agreement page: a GET changes nothing, the beacon marks it viewed; signing checks the text, the name and I agree; the plan activates; signed once", async () => {
  const { t, owner } = await setup();
  try {
    const { contact, plan } = await staffPlan(t, owner);
    const ag = (await t.api(`/plans/${plan.id}/send-agreement`, { method: "POST", as: owner, body: { channels: ["sms", "email"] } })).body.data.agreement;
    await drain(t, 2);
    const texts = outbox(t).filter((o) => o.template_key === "agreement_sent");
    assert.equal(texts.length, 1);
    assert.ok(outbox(t).some((o) => o.template_key === "agreement_sent_email"));
    const code = codeIn(texts[0].body);
    const open = await t.portal("/api/portal/open", { method: "POST", headers: PJSON, body: { code } });
    assert.equal(open.body.data.location, `/p/agreement/${ag.id}`);
    const cookie = t.setCookies(open).find((x) => x.startsWith("barta_portal=")).split(";")[0];
    const page = await t.portal(`/p/agreement/${ag.id}`, { cookie, headers: { "user-agent": IPHONE } });
    assert.equal(page.status, 200);
    assert.match(page.text, /Quarterly plan service agreement/);
    assert.match(page.text, /data-sig/);
    assert.match(page.headers.get("referrer-policy"), /no-referrer/);
    assert.equal((await recOf("agreement", ag.id)).status, "sent", "a GET changes nothing");
    assert.equal((await t.portal("/api/portal/beacon", { method: "POST", cookie, headers: PJSON, body: { kind: "agreement", id: ag.id } })).status, 204);
    assert.equal((await recOf("agreement", ag.id)).status, "viewed");
    const post = (body) => t.portal(`/api/portal/agreements/${ag.id}/sign`, { method: "POST", cookie, headers: PJSON, body });
    const ok = { body_sha256: ag.body_sha256, name_typed: "Pat Sample", agree: true, signature_png_b64: signature() };
    assert.equal((await post({ ...ok, body_sha256: "0".repeat(64) })).body.error.code, "updated", "the text changed: 409");
    assert.equal((await post({ ...ok, name_typed: " " })).body.error.field, "name_typed");
    assert.equal((await post({ ...ok, agree: false })).body.error.field, "agree");
    assert.equal((await post({ ...ok, signature_png_b64: "bm90IGEgcG5n" })).status, 400, "a PNG only");
    assert.equal((await t.portal(`/api/portal/agreements/${ag.id}/sign`, { method: "POST", cookie, headers: { ...PJSON, "x-crm-portal": "" }, body: ok })).status, 403, "the portal header (CSRF)");
    assert.equal((await recOf("agreement", ag.id)).status, "viewed", "nothing written");
    const r = await post(ok);
    assert.equal(r.status, 200, JSON.stringify(r.body));
    const a = await recOf("agreement", ag.id);
    assert.equal(a.status, "signed");
    assert.equal(a.signature.name_typed, "Pat Sample");
    assert.ok(a.signature.drawn_file_id && a.signature.ip_hash && a.signature.user_agent);
    assert.equal(a.signature.method, "portal");
    assert.equal((await recOf("file", a.signature.drawn_file_id)).kind, "signature");
    await drain(t, 2);
    assert.equal((await planOf(plan.id)).status, "active", "the signature activates the plan");
    assert.equal((await post(ok)).body.data.already, true, "a double tap signs once");
    const signedPage = await t.portal(`/p/agreement/${ag.id}`, { cookie });
    assert.match(signedPage.text, /Signed by Pat Sample/);
    assert.doesNotMatch(signedPage.text, /data-sign\b/, "no second signature form");
    // another contact's agreement with this cookie: not here
    const other = await customer(owner);
    assert.equal((await t.portal(`/p/agreement/${ag.id}`, { cookie: await portalCookie(t, other.id, { kind: "agreement", id: ag.id }) })).status, 404);
    assert.equal(contact.id, a.contact_id);
  } finally { t.done(); }
});

test("in person on the staff phone: one use, the staff member recorded; then the link is spent", async () => {
  const { t, owner, admin } = await setup();
  try {
    const { plan } = await staffPlan(t, owner);
    const ag = (await t.api("/agreements", { method: "POST", as: admin, body: { plan_id: plan.id } })).body.data;
    assert.equal(ag.status, "draft");
    const pres = await t.api(`/agreements/${ag.id}/present`, { method: "POST", as: admin, body: {} });
    assert.equal(pres.status, 200, JSON.stringify(pres.body));
    const url = pres.body.data.url;
    assert.match(url, /^\/p\/sign\/[0-9A-Za-z]{10}$/);
    const page = await t.portal(url);
    assert.equal(page.status, 200);
    assert.match(page.text, /Hand the phone to Pat/);
    assert.equal(t.setCookies(page).length, 0, "no portal cookie");
    const token = url.split("/").pop();
    const r = await t.portal(`/api/portal/sign/${token}`, { method: "POST", headers: PJSON, body: { body_sha256: ag.body_sha256, name_typed: "Pat Sample", agree: true, signature_png_b64: signature() } });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    const a = await recOf("agreement", ag.id);
    assert.equal(a.signature.method, "in_person");
    assert.equal(a.signature.staff_user_id, admin.id);
    assert.equal((await t.portal(url)).status, 410, "single use");
    await drain(t, 2);
    assert.equal((await planOf(plan.id)).status, "active");
  } finally { t.done(); }
});
