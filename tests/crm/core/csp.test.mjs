// CSP and safe markup (design §2.3, §0 rule 7; acceptance tests of M1.2):
// the exact CSP on every /crm page, no executable inline script anywhere
// in them, and html`` refusing handlers, javascript: and links that leave
// the CRM without openExternal().
import { test, afterEach } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { createHash } from "node:crypto";
import path from "node:path";
import { crmTest } from "../../helpers/crm-http.mjs";

const { CSP, inlineScriptHashes } = await import("../../../netlify/lib/crm/core/http.mjs");
const { html, raw, attrs, openExternal, isSafeUrl, UnsafeHtml, escapeHtml } = await import("../../../crm-app/core/ui.js");
const { writeCustomerIndex, buildCustomerIndex } = await import("../../../netlify/lib/crm-store.mjs");

const EXACT = "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; font-src 'self'; connect-src 'self'; worker-src 'self'; manifest-src 'self'; object-src 'none'; base-uri 'none'; form-action 'self'; frame-ancestors 'self'";

let t;
afterEach(() => { if (t) t.done(); t = null; });

// Every <script> must load a file or be non-executed JSON; no on*= attribute anywhere.
function assertNoInlineScript(page, where) {
  for (const m of page.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/gi)) {
    const attrs = m[1];
    const ok = /\ssrc="\/crm-app\/[^"]+\.js"/.test(attrs) ? m[2].trim() === "" : /type="application\/json"/.test(attrs);
    assert.ok(ok, `${where}: an executable inline <script${attrs}>`);
  }
  assert.doesNotMatch(page, /\son[a-z]+\s*=/i, `${where}: an inline handler`);
  assert.doesNotMatch(page, /javascript:/i, `${where}: a javascript: URL`);
}

test("the shell and every sign-in page send the exact CSP and carry no executable inline script", async () => {
  t = await crmTest({ env: { CRM_SETUP_CODE: "code-for-tests" } });
  assert.equal(CSP, EXACT);
  // before setup: the setup page (office cookie)
  let r = await t.page("/crm/setup", { office: true });
  assert.equal(r.status, 200);
  assert.equal(r.headers.get("content-security-policy"), EXACT);
  assertNoInlineScript(r.text, "setup");
  const o = await t.user("owner");
  await t.bootstrap(o);
  const pages = [
    ["/crm", { as: o }, "shell"],
    ["/crm/login", {}, "login"],
    ["/crm/nope", { as: o }, "404"],
    ["/crm/invite/us_00000000000000000000." + "a".repeat(43), {}, "expired invite"],
  ];
  for (const [p, opts, name] of pages) {
    r = await t.page(p, opts);
    assert.equal(r.headers.get("content-security-policy"), EXACT, name);
    assert.equal(r.headers.get("x-frame-options"), "SAMEORIGIN", name);
    assert.equal(r.headers.get("cache-control"), "private, no-store", name);
    assert.equal(r.headers.get("x-robots-tag"), "noindex, nofollow", name);
    assert.equal(r.headers.get("referrer-policy"), "same-origin", name);
    assert.match(r.text, /<meta name="robots" content="noindex, nofollow">/, name);
    assertNoInlineScript(r.text, name);
  }
  const shell = await t.page("/crm", { as: o });
  assert.match(shell.text, /<script type="module" src="\/crm-app\/main\.js"><\/script>/);
  assert.match(shell.text, /<link rel="modulepreload" href="\/crm-app\/core\/router\.js">/);
  assert.equal(shell.headers.get("x-crm-shell"), "1");
  // the shell holds the person, not data: no email, phone or hash
  const boot = JSON.parse(/<script type="application\/json" id="crm-boot">([\s\S]*?)<\/script>/.exec(shell.text)[1]);
  assert.deepEqual(Object.keys(boot.user).sort(), ["color", "first_name", "id", "is_technician", "name", "role"]);
  assert.doesNotMatch(shell.text, /pbkdf2|"hash"|@/);
});

test("the legacy Customers page allows exactly its own inline scripts, by hash", async () => {
  t = await crmTest();
  await writeCustomerIndex(buildCustomerIndex({ exported_at: "2026-11-08", members: [], customers: [{ id: "00000000-0000-4000-8000-000000000001", first_name: "Pat", last_name: "Sample", phone: "+15550100123", address: {} }] }, { now: new Date("2026-11-08T12:00:00Z") }));
  for (const url of ["/crm/legacy", "/crm/legacy?import=1"]) {
    const r = await t.page(url, { office: true });
    assert.equal(r.status, 200, url);
    const csp = r.headers.get("content-security-policy");
    const scriptSrc = /script-src ([^;]+)/.exec(csp)[1];
    assert.doesNotMatch(scriptSrc, /unsafe-inline|unsafe-eval/);
    const hashes = inlineScriptHashes(r.text);
    assert.ok(hashes.length >= 1);
    for (const h of hashes) assert.ok(scriptSrc.includes(h), `${url} lists ${h}`);
    for (const m of r.text.matchAll(/<script>([\s\S]*?)<\/script>/g)) {
      const h = `'sha256-${createHash("sha256").update(m[1]).digest("base64")}'`;
      assert.ok(scriptSrc.includes(h));
    }
    assert.equal(csp.replace(/script-src [^;]+/, "script-src 'self'"), EXACT, "everything else is the CRM's CSP");
  }
});

test("html`` escapes text and attributes", () => {
  const evil = `</script><script>alert(1)</script>"'<b>&`;
  const out = html`<p title="${evil}">${evil}</p>`.__html;
  assert.equal(out, `<p title="${escapeHtml(evil)}">${escapeHtml(evil)}</p>`);
  assert.doesNotMatch(out, /<script>/);
  assert.equal(html`<i>${raw("<b>ok</b>")}</i>`.__html, "<i><b>ok</b></i>");
  assert.equal(html`<ul>${["a", "<b>"].map((x) => html`<li>${x}</li>`)}</ul>`.__html, "<ul><li>a</li><li>&lt;b&gt;</li></ul>");
  assert.equal(html`<p>${null}${undefined}${false}${0}</p>`.__html, "<p>0</p>");
});

test("html`` refuses inline handlers, script tags and values outside text or quoted attributes", () => {
  assert.throws(() => html`<button onclick="go()">x</button>`, UnsafeHtml);
  assert.throws(() => html`<img src="/a.png" ONERROR="x">`, UnsafeHtml);
  assert.throws(() => html`<div ${"onclick=alert(1)"}>`, UnsafeHtml, "a string in attribute-name position");
  assert.throws(() => html`<div class=${"x onclick=alert(1)"}>`, UnsafeHtml, "an unquoted attribute value");
  assert.throws(() => html`<script>${"x"}</script>`, UnsafeHtml);
  assert.throws(() => html`<script src="/crm-app/x.js"></script>`, UnsafeHtml);
  assert.throws(() => html`<iframe srcdoc="${"<p>"}"></iframe>`, UnsafeHtml);
  assert.throws(() => attrs({ onclick: "x" }), UnsafeHtml);
  assert.throws(() => html`<a title="${raw("<b>")}">x</a>`, UnsafeHtml, "markup inside an attribute");
  assert.equal(html`<input ${attrs({ type: "checkbox", checked: true, disabled: false, value: '"q"' })}>`.__html, '<input type="checkbox" checked value="&quot;q&quot;">');
});

test("html`` refuses javascript:, data: and links that leave the CRM unless they come from openExternal()", () => {
  for (const bad of ["javascript:alert(1)", " JaVaScRiPt:alert(1)", "data:text/html,<b>", "vbscript:x", "https://evil.example", "//evil.example", "/p/abc123", "/p", "https://www.bartawindowwashing.com/p/x"]) {
    assert.throws(() => html`<a href="${bad}">x</a>`, UnsafeHtml, bad);
    assert.equal(isSafeUrl(bad), false, bad);
  }
  assert.throws(() => html`<a href="javascript:void(0)">x</a>`, UnsafeHtml, "a static javascript: too");
  assert.throws(() => html`<a href="https://example.com">x</a>`, UnsafeHtml, "a static external link too");
  assert.throws(() => html`<form action="${"https://evil.example"}"></form>`, UnsafeHtml);
  assert.throws(() => html`<img src="${"https://evil.example/x.png"}">`, UnsafeHtml);
  for (const ok of ["#/team", "/crm/legacy", "tel:+17635550100", "sms:+17635550100", "mailto:office@example.com", "team"]) {
    assert.ok(html`<a href="${ok}">x</a>`.__html.includes("href="), ok);
  }
  assert.ok(html`<img src="${"data:image/png;base64,AAAA"}">`.__html.includes("data:image/png"));
  const ext = html`<a ${openExternal("https://maps.google.com/?q=Delano")}>Directions</a>`.__html;
  assert.equal(ext, '<a href="https://maps.google.com/?q=Delano" target="_blank" rel="noopener">Directions</a>');
  assert.match(html`<a ${openExternal("/p/abc")}>Portal</a>`.__html, /target="_blank" rel="noopener"/);
  assert.match(html`<a ${openExternal("maps:?q=Delano")}>Maps</a>`.__html, /data-external="top"/);
  assert.throws(() => openExternal("javascript:alert(1)"), UnsafeHtml);
});

test("client code builds markup only through ui.js (no innerHTML, eval or inline handlers elsewhere)", () => {
  const files = [];
  const walk = (d) => { for (const n of readdirSync(d)) { const f = path.join(d, n); if (statSync(f).isDirectory()) walk(f); else if (f.endsWith(".js")) files.push(f); } };
  walk("crm-app");
  assert.ok(files.length > 10);
  for (const f of files) {
    const src = readFileSync(f, "utf8");
    if (!f.endsWith(path.join("core", "ui.js"))) assert.doesNotMatch(src, /\.innerHTML\s*=|insertAdjacentHTML|outerHTML\s*=/, f);
    assert.doesNotMatch(src, /\beval\(|new Function\(|document\.write\(/, f);
  }
});
