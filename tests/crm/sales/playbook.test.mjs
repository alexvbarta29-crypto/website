// M2b acceptance: the office Follow-ups page (/playbook) shows the CRM's
// edited wording (design §11.4 "playbook.test.mjs"). Before the CRM is set
// up it is exactly the page it always was.
import { test } from "node:test";
import assert from "node:assert/strict";
import { setup, store, T } from "./fixtures.mjs";

const P = await import("../../../netlify/lib/crm/modules/sales/playbook.mjs");
const { PLAYBOOK_HTML } = await import("../../../netlify/lib/playbook-page.mjs");
const playbook = (await import("../../../netlify/functions/playbook.mjs")).default;

test("every built-in text is in the page as the page holds it (the swap can find it)", () => {
  for (const key of P.KEYS) assert.ok(PLAYBOOK_HTML.includes(P.jsLiteral(P.BUILT_IN[key])), `${key} is in playbook-page.mjs`);
  assert.equal(P.withTexts(PLAYBOOK_HTML, {}), PLAYBOOK_HTML);
  assert.equal(P.toPlaybookText("Hey {{first_name|there}}, it's {{sender_first_name}} with {{company_name}}: {{review_count|150}} {{review_link}} {{town|your town}} {{quote_link}}"), "Hey {first}, it's {rep} with {co}: {reviews} {link} your town [Quote Link]");
  const evil = P.withTexts(PLAYBOOK_HTML, { cad_new_1: "Hi {first} </script><script>alert(1)</script>" });
  assert.ok(!evil.includes("</script><script>alert(1)"), "no way out of the page's script");
  assert.ok(evil.includes("\\u003c/script>"));
});

test("the Follow-ups page shows the CRM's edited wording once the CRM has its templates", async () => {
  const { t, owner } = await setup();
  try {
    P.clearPlaybookCache();
    const cookie = t.officeCookie();
    // the seeded wording (texts 5 and 8 reworded, D25)
    let page = await (await playbook(new Request("https://www.bartawindowwashing.com/playbook", { headers: { cookie } }), {})).text();
    assert.match(page, /fully insured so you and your property are protected/);
    assert.doesNotMatch(page, /fully licensed and insured/);
    assert.match(page, /come back and re-clean it free of charge/);
    assert.match(page, /phone tag/, "the rest as before");
    // an owner edits text 1 in the CRM
    const row = (await store.readIndex("templates", "")).rows.find((r) => r.k === "cad_new_1");
    const got = await t.api(`/templates/${row.id}`, { as: owner });
    const edit = await t.api(`/templates/${row.id}`, { method: "PATCH", as: owner, ifMatch: got.headers.get("etag"), body: { body: "Hey {{first_name|there}}! {{sender_first_name}} here from BARTA Window Washing, returning your quote request. Call me back anytime today!" } });
    assert.equal(edit.status, 200, JSON.stringify(edit.body));
    P.clearPlaybookCache();
    page = await (await playbook(new Request("https://www.bartawindowwashing.com/playbook", { headers: { cookie } }), {})).text();
    assert.match(page, /Hey \{first\}! \{rep\} here from BARTA Window Washing, returning your quote request\. Call me back anytime today!/);
    assert.doesNotMatch(page, /I saw you requested a quote to get your windows cleaned/);
    assert.match(page, /addEventListener\('hashchange',route\)/, "the page still works the same way");
  } finally { t.done(); P.clearPlaybookCache(); }
});

test("before setup (no CRM store, or production without CRM_PRODUCTION) the page is exactly the built-in one", async () => {
  P.clearPlaybookCache();
  // no store on this deploy at all
  assert.equal(await P.crmTexts(new Request("https://www.bartawindowwashing.com/playbook"), {}, {}), null);
  assert.equal(await P.playbookHtml(new Request("https://www.bartawindowwashing.com/playbook"), {}, {}), PLAYBOOK_HTML);
  // production, setup needed
  const prod = { CONTEXT: "production" };
  assert.equal(await P.crmTexts(new Request("https://www.bartawindowwashing.com/playbook"), { deploy: { context: "production" } }, prod), null);
  // a store that fails: the built-in page, quickly
  const { t } = await setup();
  try {
    P.clearPlaybookCache();
    t.stores.data.fail({ op: "read", key: /^ix\/templates/, times: 50, kind: "internal" });
    const html = await P.playbookHtml(new Request("https://www.bartawindowwashing.com/playbook"), {});
    assert.equal(html, PLAYBOOK_HTML);
  } finally { t.done(); P.clearPlaybookCache(); }
  void T;
});
