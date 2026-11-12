// Comms: email (design §5.7.1 "Email", §5.7.3, §6.4; §11.4 M6 email.test and
// unsubscribe.test). Postmark is a mocked fetch; addresses are example.com.
import { test } from "node:test";
import assert from "node:assert/strict";
import { connected, staffContact, mockFetch, store, scope, seedContact, W } from "./fixtures.mjs";
import { crmTest } from "../../helpers/crm-http.mjs";

const { emailLayout } = await import("../../../netlify/lib/crm/modules/comms/email-layout.mjs");
const { renderTemplate } = await import("../../../netlify/lib/crm/core/templates.mjs");
const SAN = await import("../../../netlify/lib/crm/modules/comms/html-sanitize.mjs");
const P = await import("../../../netlify/lib/crm/portal/core.mjs");
const ok = () => Response.json({ To: "staff@example.com", SubmittedAt: "2026-11-17T15:00:00Z", MessageID: "0a1b2c3d-0000-4000-8000-00000000e001", ErrorCode: 0, Message: "OK" });

test("an HTML template is sanitized on save: no script, style, iframe or form; https links; images only from /assets/, the root email assets or customer-visible files", async () => {
  const t = await crmTest({});
  try {
    const owner = await t.user("owner");
    const html = `<html><head><style>p{color:red}</style></head><body><h1 onclick="x()">Thank you, {{first_name|neighbor}}!</h1><script>steal()</script><iframe src="https://evil.example"></iframe><form action="/x"><input name="a"></form>
      <p style="color:#16161b;background:url(https://evil.example/x.png)">We were voted Best of Delano.</p>
      <a href="http://www.bartawindowwashing.com/get-quote.html">Get your free quote</a> <a href="javascript:alert(1)">bad</a>
      <img src="https://evil.example/pixel.gif"><img src="/assets/img/email-logo-bww.png" alt="Barta"><img src="https://www.bartawindowwashing.com/IMG_4788.jpeg">
      <img src="https://www.bartawindowwashing.com/api/portal/files/fl_0123456789abcdefghjk"><img src="https://www.bartawindowwashing.com/api/crm/files/fl_0123456789abcdefghjk"></body></html>`;
    const res = await t.api("/templates", { method: "POST", as: owner, body: { key: "thanks_delano", name: "Thank you, Delano", channel: "email", category: "marketing", subject: "Thank you, Delano!", body: "", body_html: html } });
    assert.equal(res.status, 201);
    const h = res.body.data.body_html;
    assert.ok(!/<script|steal|<style|<iframe|<form|<input|onclick|javascript:|evil\.example|url\(/i.test(h), "nothing executable, no outside image, no CSS url()");
    assert.match(h, /href="https:\/\/www\.bartawindowwashing\.com\/get-quote\.html"/, "http links become https");
    assert.match(h, /src="https:\/\/www\.bartawindowwashing\.com\/assets\/img\/email-logo-bww\.png"/, "the site's /assets/");
    assert.match(h, /src="https:\/\/www\.bartawindowwashing\.com\/IMG_4788\.jpeg"/, "a root email asset");
    assert.match(h, /src="https:\/\/www\.bartawindowwashing\.com\/api\/portal\/files\/fl_0123456789abcdefghjk"/, "a customer-visible file");
    assert.ok(!/api\/crm\/files/.test(h), "never a staff-only file");
    assert.equal((h.match(/<img /g) || []).length, 3);
    assert.match(res.body.data.body, /Thank you, \{\{first_name\|neighbor\}\}!/, "the text part comes from the HTML");
    assert.deepEqual(res.body.data.variables, ["first_name"]);
    // an imported email's text and markup (what the thread shows and keeps)
    assert.equal(SAN.htmlText("<html><head><title>x</title><style>a{}</style></head><body><p>Hi Pat,</p><p>See <a href=\"http://example.com/q\">your quote</a></p></body></html>"), "Hi Pat,\nSee your quote (https://example.com/q)");
    assert.equal(SAN.sanitizeHtml("<script>x</script>"), null);
    assert.match(SAN.repointImages('<img src="https://raw.githubusercontent.com/someone/website/branch/IMG_4788.jpeg">'), /src="https:\/\/www\.bartawindowwashing\.com\/IMG_4788\.jpeg"/);
  } finally { t.done(); }
});

test("the branded layout: a link line is a button, a portal link gets View or print, every value is escaped", () => {
  const html = emailLayout("Hi Pat <b>,\n\nYour quote is ready.\n\nhttps://www.bartawindowwashing.com/p/AbC123xYz9\n\nQuestions? Call us.", { company: { name: "Barta Window Washing" } });
  assert.match(html, /Hi Pat &lt;b&gt;,/);
  assert.match(html, /<a href="https:\/\/www\.bartawindowwashing\.com\/p\/AbC123xYz9" style="[^"]*background:#fb4d3d[^"]*">View your quote<\/a>/);
  assert.match(html, />View or print \(Save as PDF\)<\/a>/);
  assert.match(html, /assets\/img\/email-logo-bww\.png/);
  assert.ok(!/<script/i.test(html));
  // core renders every text-only email template through it (setEmailLayout)
  const r = renderTemplate({ channel: "email", subject: "Your invoice", body: "Hi {{first_name}},\n\nYour invoice is ready.\n\n{{invoice_link}}" }, { first_name: "Pat", invoice_link: "https://www.bartawindowwashing.com/p/Inv0000001" });
  assert.match(r.html, />View and pay<\/a>/);
  assert.match(r.html, /View or print \(Save as PDF\)/);
  assert.equal(r.text, "Hi Pat,\n\nYour invoice is ready.\n\nhttps://www.bartawindowwashing.com/p/Inv0000001");
});

test("marketing email carries List-Unsubscribe and List-Unsubscribe-Post on the broadcast stream; service email does not; delivery and bounces come back", async () => {
  const { t, owner } = await connected();
  const net = mockFetch([{ match: "api.postmarkapp.com/email", respond: ok }]);
  try {
    const staff = await staffContact();
    await store.createRecord("template", { key: "fall_email", name: "Fall email", channel: "email", category: "marketing", subject: "Fall cleanings are open", body: "Hi {{first_name|there}},\n\nFall cleanings are open.", tags: [], active: true }, W(owner.id));
    await store.createRecord("template", { key: "visit_note", name: "Visit note", channel: "email", category: "service", subject: "Your visit", body: "Hi {{first_name|there}}, see you Wednesday.", tags: [], active: true }, W(owner.id));
    const sent = await t.api("/messages", { method: "POST", as: owner, body: { contact_id: staff.id, channel: "email", template_key: "fall_email" } });
    assert.equal(sent.status, 200);
    assert.equal(sent.body.data.mode, "test");
    assert.equal(net.calls.length, 1);
    assert.equal(net.calls[0].headers["x-postmark-server-token"], "pm-test-token");
    const body = JSON.parse(net.calls[0].body);
    assert.deepEqual([body.To, body.MessageStream, body.Tag, body.Subject], ["staff@example.com", "broadcast", "fall_email", "Fall cleanings are open"]);
    assert.equal(body.From, "Barta Window Washing <office@bartawindowwashing.com>");
    const hdr = Object.fromEntries(body.Headers.map((h) => [h.Name, h.Value]));
    assert.match(hdr["List-Unsubscribe"], /^<https:\/\/www\.bartawindowwashing\.com\/api\/portal\/unsubscribe\/[A-Za-z0-9]{10}>$/);
    assert.equal(hdr["List-Unsubscribe-Post"], "List-Unsubscribe=One-Click");
    assert.match(body.TextBody, /Unsubscribe: https:\/\/www\.bartawindowwashing\.com\/p\/unsubscribe\/[A-Za-z0-9]{10}$/);
    assert.match(body.HtmlBody, />Unsubscribe<\/a>/);
    assert.ok(body.Metadata.crm_marker, "the step's marker travels in the metadata (an unclear send can be found again)");
    // the thread has it
    const m = t.stores.data.json(`rec/message/${sent.body.data.message_id}`);
    assert.deepEqual([m.channel, m.direction, m.provider, m.status, m.subject], ["email", "out", "postmark", "sent", "Fall cleanings are open"]);
    assert.ok(m.body_html && /Fall cleanings are open/.test(m.body_html));

    // a service email: the transactional stream, no unsubscribe headers
    await t.api("/messages", { method: "POST", as: owner, body: { contact_id: staff.id, channel: "email", template_key: "visit_note" } });
    const b2 = JSON.parse(net.calls[1].body);
    assert.equal(b2.MessageStream, "outbound");
    assert.ok(!b2.Headers.some((h) => /List-Unsubscribe/.test(h.Name)));

    // anyone off the test list: held back, no request
    const other = await scope(() => seedContact(9, { flags: { test: true } }));
    const no = await t.api("/messages", { method: "POST", as: owner, body: { contact_id: other.id, channel: "email", template_key: "visit_note" } });
    assert.equal(no.body.data.blocked_reason, "test_mode_recipient");
    assert.equal(net.calls.length, 2);

    // Postmark's webhooks: the token, then delivery and a hard bounce
    const hookUrl = (tok) => `/hooks/email/postmark?token=${tok}`;
    const post = (tok, b) => t.api(hookUrl(tok), { method: "POST", body: b, csrf: false, client: false });
    assert.equal((await post("wrong", { RecordType: "Delivery", MessageID: "0a1b2c3d-0000-4000-8000-00000000e001" })).status, 403);
    assert.equal((await post("pm-hook-token", { RecordType: "Delivery", MessageID: "0a1b2c3d-0000-4000-8000-00000000e001", DeliveredAt: "2026-11-17T15:00:05Z" })).status, 200);
    const id = sent.body.data.message_id;
    // (both sends answered with the same made-up MessageID: the first one holds the pointer)
    assert.equal(t.stores.data.json(`rec/message/${id}`).status, "delivered");
    assert.equal((await post("pm-hook-token", { RecordType: "Bounce", Type: "HardBounce", MessageID: "0a1b2c3d-0000-4000-8000-00000000e001", Email: "staff@example.com" })).status, 200);
    assert.equal(t.stores.data.json(`rec/message/${id}`).status, "delivered", "a bounce after delivery does not undo it");
    assert.equal(t.stores.data.json(`sup/email/${store.hk("email", "staff@example.com")}`).state, "opted_out", "a hard bounce stops marketing to that address");
    assert.equal(t.stores.data.json(`rec/contact/${staff.id}`).emails[0].invalid, true, "and marks the address on the contact");
    const again = await t.api("/messages", { method: "POST", as: owner, body: { contact_id: staff.id, channel: "email", template_key: "fall_email" } });
    assert.equal(again.body.data.blocked_reason, "opted_out");
    assert.equal((await post("pm-hook-token", { RecordType: "SpamComplaint", Email: "someone@example.com" })).status, 200);
    assert.ok(t.stores.data.keys(`sup/email/${store.hk("email", "someone@example.com")}`).length === 1);
  } finally { net.restore(); t.done(); }
});
