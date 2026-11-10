// Templates and the closed variable set (design §5.7.3, §12.2 "templates"):
// the closed set, {{x|fallback}}, a missing variable blocks, Rotor's and the
// playbook's single-brace aliases convert on import, SMS unescaped and
// email escaped, STOP text refused, HTML emails sanitized (no script, style,
// iframe or form; https links; images only from the site).
import { test } from "node:test";
import assert from "node:assert/strict";

const T = await import("../../../netlify/lib/crm/core/templates.mjs");

test("the closed variable set: unknown names, open braces and single braces are errors", () => {
  assert.deepEqual(T.parseTemplate("Hi {{first_name}}, {{ company_name | Barta }}!").variables, ["company_name", "first_name"]);
  assert.equal(T.parseTemplate("Hi {{nickname}}").errors[0].code, "unknown_variable");
  assert.equal(T.parseTemplate("Hi {{first_name").errors[0].code, "braces");
  assert.equal(T.parseTemplate("Hi {first_name}").errors[0].code, "old_syntax");
  for (const stop of ["Reply STOP to opt out.", "reply stop to unsubscribe", "Text STOP to end", "STOP to quit"]) {
    assert.equal(T.parseTemplate(`Deal! ${stop}`).errors.at(-1).code, "stop_text", stop);
  }
  assert.equal(T.parseTemplate("We'll stop by Tuesday.").errors.length, 0, "the word stop alone is fine");
});

test("render: fallbacks fill gaps, a missing variable without one is reported (and the sender blocks it)", () => {
  const sms = { channel: "sms", body: "Hi {{first_name|there}}, see you {{visit_date}}." };
  assert.deepEqual(T.renderTemplate(sms, { first_name: "Pat", visit_date: "Wed, Nov 19" }), { text: "Hi Pat, see you Wed, Nov 19.", missing: [] });
  const r = T.renderTemplate(sms, { first_name: "" });
  assert.equal(r.text, "Hi there, see you .");
  assert.deepEqual(r.missing, ["visit_date"]);
});

test("SMS is plain text; email HTML escapes every value", () => {
  const evil = "</script><script>alert(1)</script>";
  const s = T.renderTemplate({ channel: "sms", body: "Hi {{first_name}}" }, { first_name: evil });
  assert.equal(s.text, `Hi ${evil}`, "a text message is not HTML");
  const e = T.renderTemplate({ channel: "email", subject: "For {{first_name}}", body: "Hi {{first_name}}\n\nhttps://www.bartawindowwashing.com/p/AbC123xYz9" }, { first_name: evil });
  assert.ok(!e.html.includes("<script>"), "escaped in the HTML part");
  assert.ok(e.html.includes("&lt;/script&gt;"));
  assert.match(e.html, /href="https:\/\/www\.bartawindowwashing\.com\/p\/AbC123xYz9"/, "a line that is only a link becomes the button");
  const h = T.renderTemplate({ channel: "email", subject: "x", body: "x", body_html: "<p>Hi {{first_name}}</p>" }, { first_name: evil });
  assert.equal(h.html, "<p>Hi &lt;/script&gt;&lt;script&gt;alert(1)&lt;/script&gt;</p>");
});

test("imports: Rotor's {first_name} and the playbook's {first}, {rep}, {co}, {reviews}, {link} convert", () => {
  assert.equal(T.convertImportSyntax("Hi {first}, it's {rep} from {co}. {reviews} reviews! {link} {first_name} {unknown}"),
    "Hi {{first_name}}, it's {{sender_first_name}} from {{company_name}}. {{review_count}} reviews! {{portal_link}} {{first_name}} {unknown}");
});

test("HTML email templates are sanitized on save", () => {
  const dirty = `<div style="color:red;background:url(x)"><script>alert(1)</script><style>p{}</style><iframe src="https://evil.example"></iframe>
    <form action="https://evil.example"><input name="x"></form><a href="javascript:alert(1)" onclick="x()">bad</a>
    <a href="http://www.bartawindowwashing.com/reviews.html" target="_blank">good</a><a href="{{review_link}}">review</a>
    <img src="/assets/img/email-logo-bww.png" onerror="x()"><img src="https://evil.example/t.gif"><img src="/IMG_4788.jpeg">
    <!-- a comment --><svg><script>alert(2)</script></svg><b>ok</b></div>`;
  const clean = T.sanitizeEmailHtml(dirty);
  for (const bad of ["<script", "<style", "<iframe", "<form", "<input", "javascript:", "onclick", "onerror", "evil.example", "<svg", "url(", "comment"]) assert.ok(!clean.includes(bad), bad);
  assert.match(clean, /<a href="https:\/\/www\.bartawindowwashing\.com\/reviews\.html" target="_blank" rel="noopener">good<\/a>/, "links forced to https");
  assert.match(clean, /<a href="\{\{review_link\}\}">review<\/a>/);
  assert.match(clean, /<img src="https:\/\/www\.bartawindowwashing\.com\/assets\/img\/email-logo-bww\.png">/);
  assert.match(clean, /<img src="https:\/\/www\.bartawindowwashing\.com\/IMG_4788\.jpeg">/);
  assert.match(clean, /<b>ok<\/b>/);
  assert.equal(T.htmlToText('<p>Hi <a href="https://x.example.com/a">there</a></p><p>Bye</p>'), "Hi there (https://x.example.com/a)\nBye");
});

test("tidyName capitalizes names typed all lower or all upper and leaves mixed case alone", () => {
  assert.equal(T.tidyName("pat"), "Pat");
  assert.equal(T.tidyName("MARY-ANN"), "Mary-Ann");
  assert.equal(T.tidyName("McKay"), "McKay");
  assert.equal(T.tidyName("o'brien"), "O'Brien");
  const v = T.varsFor({ contact: { first_name: "sam", last_name: "SAMPLE", billing_address: { city: "Delano" } }, company: {} });
  assert.equal(v.first_name, "Sam");
  assert.equal(v.full_name, "Sam Sample");
  assert.equal(v.town, "Delano");
  assert.equal(v.company_phone, "(763) 314-3400");
});
