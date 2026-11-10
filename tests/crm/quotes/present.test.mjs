// M3a acceptance: Present to customer (design §5.3, §8.1, §11.4
// "present.test.mjs"): single use, 15 minutes, no portal cookie set, the
// signature recorded in_person with the staff user.
import { test } from "node:test";
import assert from "node:assert/strict";
import { setup, sentQuote, makeContact, oneTime, quarterly, approveBody, PJSON, quoteOf, finishRun, fakes, advance, NOW } from "./fixtures.mjs";

const EXACT_CSP = "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; connect-src 'self'; form-action 'self' https://checkout.stripe.com; frame-ancestors 'none'; base-uri 'none'; object-src 'none'";
const cookies = (t, r) => t.setCookies(r).filter((c) => c.startsWith("barta_portal="));

test("present: a single-use 15-minute page on the staff phone, no cookie, signed in person by the staff user, then back to the office", async () => {
  const { t, owner, tech, admin } = await setup();
  const f = fakes();
  try {
    // a draft never sent: presenting freezes a version first (nothing is sent)
    const c = await makeContact(owner);
    const made = await t.api("/quotes", { method: "POST", as: owner, body: { contact_id: c.id, options: [oneTime(), quarterly()] } });
    const id = made.body.data.id;
    assert.equal((await t.api(`/quotes/${id}/present`, { method: "POST", as: tech, body: {} })).status, 403, "staff only");
    const pr = await t.api(`/quotes/${id}/present`, { method: "POST", as: admin, body: {} });
    assert.equal(pr.status, 200, JSON.stringify(pr.body));
    assert.match(pr.body.data.url, /^\/p\/present\/[0-9A-Za-z]{10}$/);
    assert.equal(Date.parse(pr.body.data.expires_at) - Date.parse(NOW), 15 * 60000);
    assert.equal(t.stores.data.keys("idem/").length, 0, "the link is never kept for a replay");
    const q0 = await quoteOf(id);
    assert.equal(q0.status, "sent");
    assert.deepEqual(q0.sent_via, [], "shown in person: no message");
    const token = pr.body.data.url.split("/").pop();

    const page = await t.portal(pr.body.data.url);
    assert.equal(page.status, 200);
    assert.equal(page.headers.get("content-security-policy"), EXACT_CSP);
    assert.equal(page.headers.get("referrer-policy"), "no-referrer");
    assert.equal(page.headers.get("x-frame-options"), "DENY");
    assert.deepEqual(cookies(t, page), [], "no portal cookie on the staff phone");
    assert.match(page.text, /Hand the phone to Pat/);
    assert.doesNotMatch(page.text, /Want something changed\?/, "present: approve only");
    for (const m of page.text.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/gi)) {
      assert.match(m[1], /^\s+type="module" src="\/crm-app\/portal\/[a-z-]+\.js"$/);
      assert.equal(m[2].trim(), "");
    }
    assert.doesNotMatch(page.text, /\son[a-z]+\s*=/i);

    const v = (await t.api(`/quotes/${id}`, { as: owner })).body.data.current_version;
    const plan = v.options.find((o) => o.kind === "plan");
    const r = await t.portal(`/api/portal/present/${token}/approve`, { method: "POST", headers: PJSON, body: approveBody(v, plan.id, { name_typed: "Pat Sample" }) });
    assert.equal(r.status, 202, JSON.stringify(r.body));
    assert.deepEqual(cookies(t, r), []);
    const poll = await t.portal(`/api/portal/present/${token}/runs/${r.body.data.run_id}`);
    assert.equal(poll.status, 200, "the page can follow its approval");
    const run = await finishRun(t, r.body.data.run_id);
    assert.equal(run.status, "done");
    const q = await quoteOf(id);
    assert.equal(q.approval.method, "in_person");
    assert.equal(q.approval.by, admin.id, "the staff member who presented it");
    assert.ok(q.approval.signature_id);
    assert.equal(f.calls.fromQuoteOption[0].signature.method, "in_person");
    assert.equal(f.calls.fromQuoteOption[0].signature.by, admin.id);

    // single use: once approved the link is spent
    assert.equal((await t.portal(pr.body.data.url)).status, 410);
    assert.equal((await t.portal(`/api/portal/present/${token}/approve`, { method: "POST", headers: PJSON, body: approveBody(v, plan.id) })).status, 410);
  } finally { f.restore(); t.done(); }
});

test("present: 15 minutes; a token can't open another quote's page; the quote link's cookie means nothing here", async () => {
  const { t, owner } = await setup();
  const f = fakes();
  try {
    const { quote } = await sentQuote(t, owner);
    const pr = await t.api(`/quotes/${quote.id}/present`, { method: "POST", as: owner, body: {} });
    assert.equal((await t.portal(pr.body.data.url)).status, 200);
    advance(16 * 60000);
    const late = await t.portal(pr.body.data.url);
    assert.equal(late.status, 410);
    assert.match(late.text, /expired/);
    assert.equal((await t.portal("/p/present/AAAAAAAAAA")).status, 404);
    // an approved quote can't be presented again
    const other = await sentQuote(t, owner, { options: [oneTime()] });
    const p2 = await t.api(`/quotes/${other.quote.id}/present`, { method: "POST", as: owner, body: {} });
    const token = p2.body.data.url.split("/").pop();
    const r = await t.portal(`/api/portal/present/${token}/approve`, { method: "POST", headers: PJSON, body: approveBody(other.version, other.version.options[0].id) });
    await finishRun(t, r.body.data.run_id);
    assert.equal((await t.api(`/quotes/${other.quote.id}/present`, { method: "POST", as: owner, body: {} })).status, 409);
  } finally { f.restore(); t.done(); }
});
