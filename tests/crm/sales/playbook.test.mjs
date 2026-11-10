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
  assert.equal(P.toPlaybookText("Hey {{first_name|}}, it's {{sender_first_name}} with {{company_name}}: {{review_count|150}} {{review_link}} {{town|your town}} {{quote_link}}"), "Hey {first}, it's {rep} with {co}: {reviews} {link} your town [Quote Link]");
  assert.equal(P.toPlaybookText("This is {{sender_first_name}} with BARTA Window Washing."), "This is {rep} with {co}.", "the company's name is the page's {co} fill-in");
  // markup never reaches the page: the step keeps its built-in text
  assert.equal(P.toPlaybookText("Hi {{first_name|}} </script><script>alert(1)</script>"), null);
  assert.equal(P.withTexts(PLAYBOOK_HTML, { cad_new_1: "Hi {first} </script><script>alert(1)</script>" }), PLAYBOOK_HTML);
  assert.equal(P.withTexts(PLAYBOOK_HTML, { cad_new_1: "Hi {first} <img src=x onerror=alert(1)>" }), PLAYBOOK_HTML);
  assert.equal(P.withTexts(PLAYBOOK_HTML, { cad_new_1: "Tom &amp; Jerry" }), PLAYBOOK_HTML);
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
    assert.match(page, /Hey \{first\}! \{rep\} here from \{co\}, returning your quote request\. Call me back anytime today!/);
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

// The page's own texts as its script holds them (evaluated, as the browser would).
function pageTexts(html) {
  const js = html.slice(html.indexOf("const V={"), html.indexOf("const ord="));
  const V = new Function(js + "; return V;")();
  const out = {};
  V.new.days.flatMap((d) => d[2]).forEach((t, i) => { out[`cad_new_${i + 1}`] = t; });
  V.estimate.days.flatMap((d) => d[2]).forEach((t, i) => { out[`cad_est_${i + 1}`] = t; });
  return out;
}
const page = async (cookie) => (await playbook(new Request("https://www.bartawindowwashing.com/playbook", { headers: { cookie } }), {})).text();
async function editTemplate(t, as, key, patch) {
  const row = (await store.readIndex("templates", "")).rows.find((r) => r.k === key);
  const got = await t.api(`/templates/${row.id}`, { as });
  const r = await t.api(`/templates/${row.id}`, { method: "PATCH", as, ifMatch: got.headers.get("etag"), body: patch });
  assert.equal(r.status, 200, JSON.stringify(r.body));
}

test("an admin's template with markup never runs on the Follow-ups page: that step keeps the page's own text", async () => {
  const { t, admin } = await setup();
  try {
    await editTemplate(t, admin, "cad_new_1", { body: `Hey {{first_name|}}! <img src=x onerror="document.title='XSS'"> Call me back.` });
    await editTemplate(t, admin, "cad_new_2", { body: "Hey {{first_name|}}, </script><script>alert(1)</script>" });
    await editTemplate(t, admin, "cad_est_1", { body: "Hey {{first_name|}}, Tom &lt;b&gt; & Jerry" });
    P.clearPlaybookCache();
    const html = await page(t.officeCookie());
    assert.ok(!html.includes("onerror"), "no handler in the page");
    assert.ok(!/<\/script><script>alert/.test(html));
    const texts = pageTexts(html);
    for (const [k, v] of Object.entries(texts)) assert.doesNotMatch(v, /[<>&]/, `${k}: no markup survives into the page`);
    assert.equal(texts.cad_new_1, P.BUILT_IN.cad_new_1);
    assert.equal(texts.cad_new_2, P.BUILT_IN.cad_new_2);
    assert.equal(texts.cad_est_1, P.BUILT_IN.cad_est_1);
    // what the page does with a text: its fill-ins become spans, nothing else is markup
    const vals = { first: "Pat", rep: "Alex", co: "BARTA Window Washing", reviews: "150", link: "https://example.com/r" };
    for (const v of Object.values(texts)) {
      const shown = v.replace(/\{(\w+)\}/g, (_, k) => `<span class="v">${vals[k] || ""}</span>`);
      assert.equal(shown.replace(/<span class="v">[^<]*<\/span>/g, "").includes("<"), false);
    }
  } finally { t.done(); P.clearPlaybookCache(); }
});

test("the seeded texts keep the page's fill-ins ({co}, {first}, {rep}): only the D25 texts differ from the page", async () => {
  const { t } = await setup();
  try {
    P.clearPlaybookCache();
    const texts = pageTexts(await page(t.officeCookie()));
    for (const k of P.KEYS) {
      if (k === "cad_new_5" || k === "cad_new_8") assert.notEqual(texts[k], P.BUILT_IN[k], `${k}: the D25 wording`);
      else assert.equal(texts[k], P.BUILT_IN[k], `${k}: the page's own words and fill-ins`);
    }
    assert.match(texts.cad_new_1, /with \{co\}\./);
    assert.match(texts.cad_new_4, /^Good morning \{first\}! This is \{rep\} with \{co\}/);
    assert.match(texts.cad_est_1, /it's \{rep\} with \{co\}\./);
  } finally { t.done(); P.clearPlaybookCache(); }
});

test("a template switched off shows the page's own text", async () => {
  const { t, owner } = await setup();
  try {
    await editTemplate(t, owner, "cad_new_8", { active: false });
    P.clearPlaybookCache();
    const texts = pageTexts(await page(t.officeCookie()));
    assert.equal(texts.cad_new_8, P.BUILT_IN.cad_new_8);
    assert.notEqual(texts.cad_new_5, P.BUILT_IN.cad_new_5, "the others still the CRM's");
  } finally { t.done(); P.clearPlaybookCache(); }
});

test("storage hanging: the page waits at most 1.5 s once, then the built-in page right away for a while", async () => {
  const { t } = await setup();
  try {
    P.clearPlaybookCache();
    t.stores.data.hang({ op: "read", key: /^ix\/templates/, times: 10 });
    let s = performance.now();
    assert.equal(await P.playbookHtml(new Request("https://www.bartawindowwashing.com/playbook"), {}), PLAYBOOK_HTML);
    const first = performance.now() - s;
    assert.ok(first <= 1500, `first ${Math.round(first)} ms`);
    s = performance.now();
    assert.equal(await P.playbookHtml(new Request("https://www.bartawindowwashing.com/playbook"), {}), PLAYBOOK_HTML);
    assert.ok(performance.now() - s < 100, "the failure is remembered");
  } finally { t.done(); P.clearPlaybookCache(); }
});
