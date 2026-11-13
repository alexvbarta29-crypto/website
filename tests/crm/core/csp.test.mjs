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

const { CSP, inlineScriptHashes, scriptHash } = await import("../../../netlify/lib/crm/core/http.mjs");
const { LEGACY_SCRIPTS } = await import("../../../netlify/lib/crm-page.mjs");
const { html, raw, attrs, openExternal, isSafeUrl, UnsafeHtml, escapeHtml } = await import("../../../crm-app/core/ui.js");
const { writeCustomerIndex, buildCustomerIndex } = await import("../../../netlify/lib/crm-store.mjs");

// connect-src: the map hosts of core/map-sources.mjs's defaults (OpenFreeMap's streets, USGS aerial), exactly (docs/CRM-MAP.md)
const EXACT = "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; font-src 'self'; connect-src 'self' https://tiles.openfreemap.org https://basemap.nationalmap.gov; worker-src 'self'; manifest-src 'self'; object-src 'none'; base-uri 'none'; form-action 'self'; frame-ancestors 'self'";

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
  // vendored third-party code (crm-app/vendor/: MapLibre GL JS, byte for byte as published,
  // its hashes pinned in tests/crm/map/client.test.mjs) is not ours to rewrite
  for (const f of files.filter((x) => !x.split(path.sep).includes("vendor"))) {
    const src = readFileSync(f, "utf8");
    if (!f.endsWith(path.join("core", "ui.js"))) assert.doesNotMatch(src, /\.innerHTML\s*=|insertAdjacentHTML|outerHTML\s*=/, f);
    assert.doesNotMatch(src, /\beval\(|new Function\(|document\.write\(/, f);
  }
});

test("html`` judges a path by where the browser really goes: backslashes, dot segments and encodings can't leave the CRM or open a portal page", () => {
  // Regression (M1.2 review): anything starting with "/" was trusted, so
  // "/\\evil.example/x" (a browser reads "\\" as "/") went off-site and
  // "/./p/abc" reached a portal page inside the frame.
  const bad = [
    "/\\evil.example/x", "\\\\evil.example", "/\\/evil.example", "\\/evil.example",
    "/./p/abc", "/crm/../p/abc", "/%2e/p/abc", "/%2E%2E/p/abc", "p/abc", "./p/abc", "../p/abc", "/P/abc", "/%70/abc", "/%2fp/abc",
    "/crm/../../p/x", "//evil.example/x", "///evil.example/x", "/\t/evil.example", "java\tscript:alert(1)",
  ];
  for (const u of bad) {
    assert.equal(isSafeUrl(u), false, u);
    assert.throws(() => html`<a href="${u}">x</a>`, UnsafeHtml, u);
    assert.throws(() => attrs({ href: u }), UnsafeHtml, u);
  }
  // what the CRM really links stays fine
  for (const ok of ["#/team", "#/team/us_00000000000000000000", "/crm/legacy", "/crm/legacy?import=1", "/office#crm", "/crm-app/x.png", "team", "?q=1", "/pricing", "/photos/p.png"]) {
    assert.equal(isSafeUrl(ok), true, ok);
  }
  // the portal still opens through openExternal (a new tab)
  assert.match(html`<a ${openExternal("/p/abc")}>Portal</a>`.__html, /target="_blank"/);
});

test("the legacy page's CSP allows only its own fixed scripts: one injected into a row is not covered", async () => {
  // Regression (M1.2 review): the CSP hashed every inline script in the
  // rendered output, so an injected <script> was allowed too.
  t = await crmTest();
  const injected = "fetch('/api/crm/users')";
  await writeCustomerIndex(buildCustomerIndex({ exported_at: "2026-11-08", members: [], customers: [{ id: "00000000-0000-4000-8000-000000000001", first_name: "<script>" + injected + "</script>", last_name: "Sample", phone: "+15550100123", address: {} }] }, { now: new Date("2026-11-08T12:00:00Z") }));
  const r = await t.page("/crm/legacy", { office: true });
  assert.equal(r.status, 200);
  const scriptSrc = /script-src ([^;]+)/.exec(r.headers.get("content-security-policy"))[1];
  assert.ok(!scriptSrc.includes(scriptHash(injected)), "an injected script's hash is never listed");
  const fixed = LEGACY_SCRIPTS.map(scriptHash);
  assert.equal(scriptSrc, "'self' " + fixed.join(" "), "exactly the page's own scripts");
  // the same list on every legacy page, whatever it shows
  const imp = await t.page("/crm/legacy?import=1", { office: true });
  assert.equal(imp.headers.get("content-security-policy"), r.headers.get("content-security-policy"));
});

test("a POST to a /crm page answers 405 with the private headers", async () => {
  // Regression (M1.2 review): the 405s carried no Cache-Control or X-Robots-Tag.
  t = await crmTest();
  for (const p of ["/crm", "/crm/legacy", "/crm/login", "/crm/setup"]) {
    const r = await t.page(p, { method: "POST", body: {} });
    assert.equal(r.status, 405, p);
    assert.equal(r.headers.get("cache-control"), "private, no-store", p);
    assert.equal(r.headers.get("x-robots-tag"), "noindex, nofollow", p);
    assert.equal(r.headers.get("referrer-policy"), "same-origin", p);
    assert.equal(r.headers.get("allow"), "GET, HEAD", p);
  }
});

test("Team sign-in with the office cookie leaves out the optional office password and links the Customers list", async () => {
  // Regression (M1.2 review): someone with only the office password had no
  // way to the Customers list once the CRM was set up.
  t = await crmTest();
  const o = await t.user("owner");
  await t.bootstrap(o);
  const inOffice = await t.page("/crm/login", { office: true });
  assert.equal(inOffice.status, 200);
  assert.match(inOffice.text, /<a class="btn block" href="\/crm\/legacy">Open the Customers list<\/a>/);
  assert.doesNotMatch(inOffice.text, /office_password/);
  assertNoInlineScript(inOffice.text, "login in office");
  const plain = await t.page("/crm/login");
  assert.match(plain.text, /name="office_password"/, "elsewhere D14's optional field is there");
  assert.doesNotMatch(plain.text, /\/crm\/legacy/);
  // the setup page's way to the list is a full-size button, not a small inline link
  const t2setup = (await import("../../../netlify/lib/crm/core/shell-html.mjs")).setupHtml();
  assert.match(t2setup, /<a class="btn block" href="\/crm\/legacy">Open the Customers list<\/a>/);
});
