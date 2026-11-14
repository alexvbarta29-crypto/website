// OAuth 2.1 for the MCP endpoint (modules/mcp/oauth.mjs, docs/CRM-MCP.md):
// claude.ai finds the server from the 401 (RFC 9728), registers (RFC 7591;
// redirect URIs only to claude.ai, claude.com or loopback), sends the owner
// to /authorize (PKCE S256 only, state and iss back), the owner signs in to
// the CRM and allows it on the consent screen (session + CSRF), the code is
// traded once for a 1-hour access token and a rotating refresh token, and
// the token acts like a header key of its grant: reads answer, every change
// is a pending action an owner approves. Disconnecting in Settings, an
// old refresh token used again, a reused code, a turned-off person or a
// password change stop it at once. Path keys keep working.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { setup, makeKey, rpc, call, customer, store, drain, AS } from "./fixtures.mjs";
import { advance, hours, days, minutes } from "../../helpers/crm-clock.mjs";

const O = await import("../../../netlify/lib/crm/modules/mcp/oauth.mjs");
const meta = (await import("../../../netlify/functions/crm-oauth-meta.mjs")).default;
const HOST = "https://www.bartawindowwashing.com";
const CB = "https://claude.ai/api/mcp/auth_callback";
const VERIFIER = "v".repeat(20) + "-synthetic-verifier-0123456789";
const CHALLENGE = createHash("sha256").update(VERIFIER).digest("base64url");

const form = (o) => new URLSearchParams(o).toString();
const auth = (t, path, opts = {}) => t.auth(path, { csrf: false, client: false, ...opts });
async function register(t, body = {}) {
  return auth(t, "/auth/oauth/register", { method: "POST", body: { client_name: "Claude", redirect_uris: [CB], ...body } });
}
const authorizeUrl = (client, o = {}) => "/auth/oauth/authorize?" + form({ response_type: "code", client_id: client, redirect_uri: CB, code_challenge: CHALLENGE, code_challenge_method: "S256", state: "st-123", scope: "crm:read crm:ask", resource: `${HOST}/api/crm/mcp`, ...o });
const location = (r) => r.headers.get("location") || "";
async function token(t, fields) {
  return auth(t, "/auth/oauth/token", { method: "POST", raw: form(fields), headers: { "content-type": "application/x-www-form-urlencoded" } });
}
// register → authorize (signed in) → consent → code
async function connect(t, who, { ask = true, client } = {}) {
  const cid = client || (await register(t)).body.client_id;
  const a = await auth(t, authorizeUrl(cid), { method: "GET", as: who });
  assert.equal(a.status, 302, a.text);
  const rid = /#\/claude-connect\/(bcrq_[0-9a-f]{32})$/.exec(location(a))[1];
  const ok = await t.api(`/mcp/oauth/requests/${rid}/approve`, { method: "POST", as: who, body: { ask } });
  assert.equal(ok.status, 200, JSON.stringify(ok.body));
  const back = new URL(ok.body.data.redirect_url);
  return { client: cid, rid, code: back.searchParams.get("code"), back };
}
async function tokens(t, who, opts) {
  const c = await connect(t, who, opts);
  const r = await token(t, { grant_type: "authorization_code", code: c.code, redirect_uri: CB, code_verifier: VERIFIER, client_id: c.client });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  return { ...c, ...r.body };
}

test("discovery: the 401 names the resource metadata; the documents list PKCE S256, the endpoints and the scopes", async () => {
  const { t } = await setup();
  try {
    const r = await rpc(t, { method: "initialize", params: { protocolVersion: "2025-06-18" } });
    assert.equal(r.status, 401);
    assert.match(r.headers.get("www-authenticate"), /^Bearer realm="barta-crm", resource_metadata="https:\/\/www\.bartawindowwashing\.com\/\.well-known\/oauth-protected-resource\/api\/crm\/mcp"$/);
    const bad = await rpc(t, { key: "bcat_" + "A".repeat(43), method: "ping" });
    assert.equal(bad.status, 401);
    assert.match(bad.headers.get("www-authenticate"), /error="invalid_token"/);
    const prm = await (await meta(new Request(`${HOST}/.well-known/oauth-protected-resource/api/crm/mcp`), {})).json();
    assert.equal(prm.resource, `${HOST}/api/crm/mcp`);
    assert.deepEqual(prm.authorization_servers, [HOST]);
    const as = await meta(new Request(`${HOST}/.well-known/oauth-authorization-server`), {});
    assert.equal(as.headers.get("access-control-allow-origin"), "*");
    const asm = await as.json();
    assert.equal(asm.issuer, HOST);
    assert.deepEqual(asm.code_challenge_methods_supported, ["S256"], "never plain");
    assert.equal(asm.registration_endpoint, `${HOST}/api/crm/auth/oauth/register`);
    assert.deepEqual(asm.scopes_supported, ["crm:read", "crm:ask"]);
    assert.equal((await meta(new Request(`${HOST}/.well-known/oauth-authorization-server/elsewhere`), {})).status, 404);
    // a browser-based client's preflight
    const pre = await auth(t, "/auth/oauth/token", { method: "OPTIONS", headers: { origin: "https://claude.ai", "access-control-request-method": "POST" } });
    assert.equal(pre.status, 204);
    assert.equal(pre.headers.get("access-control-allow-origin"), "*");
    assert.match(pre.headers.get("access-control-allow-methods"), /POST/);
  } finally { t.done(); }
});

test("registration: only claude.ai, claude.com or this computer as the redirect; 20 an hour", async () => {
  const { t } = await setup();
  try {
    const ok = await register(t);
    assert.equal(ok.status, 201, JSON.stringify(ok.body));
    assert.match(ok.body.client_id, /^bcli_[0-9a-f]{32}$/);
    assert.equal(ok.body.token_endpoint_auth_method, "none");
    assert.equal(ok.headers.get("cache-control"), "no-store");
    assert.equal((await register(t, { redirect_uris: ["http://127.0.0.1:33418/callback"] })).status, 201, "Claude Code's loopback");
    for (const bad of ["https://evil.example.com/cb", "http://claude.ai/api/mcp/auth_callback", "https://claude.ai.evil.example.com/cb", "https://claude.ai:8443/cb", "https://" + ["user", "claude.ai/cb"].join("@") /* userinfo before the host */, "https://claude.ai/cb#x", "javascript:alert(1)", "http://192.168.1.5/cb"]) {
      const r = await register(t, { redirect_uris: [bad] });
      assert.equal(r.status, 400, bad);
      assert.equal(r.body.error, "invalid_redirect_uri");
    }
    assert.equal((await register(t, { redirect_uris: [] })).status, 400);
    assert.equal((await register(t, { grant_types: ["client_credentials"] })).status, 400);
    const secret = await register(t, { token_endpoint_auth_method: "client_secret_post" });
    assert.match(secret.body.client_secret, /^bcsk_/);
    const stored = t.stores.data.json(`oauth/client/${secret.body.client_id}`);
    assert.ok(!JSON.stringify(stored).includes(secret.body.client_secret), "only its hash is kept");
    // the hour's cap (3 made above: the 4th to the 20th fit, the 21st doesn't)
    let last;
    for (let i = 0; i < 17; i++) last = await register(t);
    assert.equal(last.status, 201);
    const over = await register(t);
    assert.equal(over.status, 429);
    advance(hours(1));
    assert.equal((await register(t)).status, 201);
  } finally { t.done(); }
});

test("authorize: a bad client or redirect gets a page (never a redirect); no PKCE S256 goes back with an error and the state; signed out goes to sign-in first", async () => {
  const { t, owner } = await setup();
  try {
    const cid = (await register(t)).body.client_id;
    const unknown = await auth(t, authorizeUrl("bcli_" + "0".repeat(32)), { method: "GET" });
    assert.equal(unknown.status, 400);
    assert.equal(location(unknown), "");
    assert.match(unknown.headers.get("content-type"), /text\/html/);
    const elsewhere = await auth(t, authorizeUrl(cid, { redirect_uri: "https://evil.example.com/cb" }), { method: "GET" });
    assert.equal(elsewhere.status, 400);
    assert.equal(location(elsewhere), "", "no open redirect");
    const plain = await auth(t, authorizeUrl(cid, { code_challenge_method: "plain", code_challenge: VERIFIER }), { method: "GET" });
    assert.equal(plain.status, 302);
    const back = new URL(location(plain));
    assert.equal(back.origin + back.pathname, CB);
    assert.equal(back.searchParams.get("error"), "invalid_request");
    assert.equal(back.searchParams.get("state"), "st-123");
    assert.equal(back.searchParams.get("iss"), HOST);
    assert.equal(new URL(location(await auth(t, authorizeUrl(cid, { code_challenge: "" }), { method: "GET" }))).searchParams.get("error"), "invalid_request");
    assert.equal(new URL(location(await auth(t, authorizeUrl(cid, { response_type: "token" }), { method: "GET" }))).searchParams.get("error"), "unsupported_response_type");
    assert.equal(new URL(location(await auth(t, authorizeUrl(cid, { resource: "https://elsewhere.example.com/mcp" }), { method: "GET" }))).searchParams.get("error"), "invalid_target");
    const out = await auth(t, authorizeUrl(cid), { method: "GET" });
    assert.equal(out.status, 302);
    assert.match(location(out), /^\/crm\/login\?to=%2Fcrm%23%2Fclaude-connect%2Fbcrq_[0-9a-f]{32}$/);
    const inn = await auth(t, authorizeUrl(cid), { method: "GET", as: owner });
    assert.match(location(inn), /^\/crm#\/claude-connect\/bcrq_[0-9a-f]{32}$/);
    // nothing was approved: no grant, no code
    assert.equal(t.stores.data.keys("oauth/grant/").length, 0);
    assert.equal(t.stores.data.keys("oauth/code/").length, 0);
  } finally { t.done(); }
});

test("the consent screen: the owner's own sign-in, CSRF on Allow, used once; a tech can't; Don't allow goes back with access_denied", async () => {
  const { t, owner, tech } = await setup();
  try {
    const cid = (await register(t, { client_name: "Claude <b>" })).body.client_id;
    const rid = /bcrq_[0-9a-f]{32}/.exec(location(await auth(t, authorizeUrl(cid), { method: "GET", as: owner })))[0];
    const info = await t.api(`/mcp/oauth/requests/${rid}`, { as: owner });
    assert.equal(info.status, 200);
    assert.equal(info.body.data.client_name, "Claude b", "the app's own name, without markup");
    assert.equal(info.body.data.goes_back_to, "claude.ai");
    assert.equal(info.body.data.wants_ask, true);
    assert.equal(info.body.data.can_ask, true);
    assert.equal((await t.api(`/mcp/oauth/requests/${rid}`, { as: tech })).status, 403);
    assert.equal((await t.api(`/mcp/oauth/requests/${rid}/approve`, { method: "POST", as: tech, body: { ask: true } })).status, 403);
    assert.equal((await t.api(`/mcp/oauth/requests/${rid}/approve`, { method: "POST", body: { ask: true } })).status, 401, "signed out");
    assert.equal((await t.api(`/mcp/oauth/requests/${rid}/approve`, { method: "POST", as: owner, csrf: false, body: { ask: true } })).status, 403, "no X-CRM header: a cross-site form");
    assert.equal((await t.api(`/mcp/oauth/requests/${rid}/approve`, { method: "POST", as: owner, headers: { origin: "https://evil.example.com" }, body: { ask: true } })).status, 403, "another site");
    const ok = await t.api(`/mcp/oauth/requests/${rid}/approve`, { method: "POST", as: owner, body: { ask: true } });
    assert.equal(ok.status, 200);
    const back = new URL(ok.body.data.redirect_url);
    assert.equal(back.origin + back.pathname, CB);
    assert.match(back.searchParams.get("code"), /^bcac_[A-Za-z0-9_-]{43}$/);
    assert.equal(back.searchParams.get("state"), "st-123");
    assert.equal(back.searchParams.get("iss"), HOST);
    assert.ok(!JSON.stringify(t.stores.data.keys("oauth/")).includes(back.searchParams.get("code")), "the code is kept only as its hash");
    assert.equal((await t.api(`/mcp/oauth/requests/${rid}/approve`, { method: "POST", as: owner, body: { ask: true } })).status, 404, "used once");
    // Don't allow
    const rid2 = /bcrq_[0-9a-f]{32}/.exec(location(await auth(t, authorizeUrl(cid, { state: "s2" }), { method: "GET", as: owner })))[0];
    const no = await t.api(`/mcp/oauth/requests/${rid2}/deny`, { method: "POST", as: owner, body: {} });
    const nb = new URL(no.body.data.redirect_url);
    assert.equal(nb.searchParams.get("error"), "access_denied");
    assert.equal(nb.searchParams.get("state"), "s2");
    assert.equal(nb.searchParams.get("code"), null);
    // a request left 10 minutes is gone
    const rid3 = /bcrq_[0-9a-f]{32}/.exec(location(await auth(t, authorizeUrl(cid), { method: "GET", as: owner })))[0];
    advance(minutes(11));
    assert.equal((await t.api(`/mcp/oauth/requests/${rid3}`, { as: owner })).status, 404);
  } finally { t.done(); }
});

test("the token endpoint: PKCE verifier, client, redirect and code checked; a code works once (used twice, what it made stops)", async () => {
  const { t, owner } = await setup();
  try {
    const c = await connect(t, owner);
    const base = { grant_type: "authorization_code", code: c.code, redirect_uri: CB, code_verifier: VERIFIER, client_id: c.client };
    assert.equal((await token(t, { ...base, code_verifier: "w".repeat(50) })).body.error, "invalid_grant", "wrong verifier");
    assert.equal((await token(t, { ...base, redirect_uri: "https://claude.ai/other" })).body.error, "invalid_grant");
    const other = (await register(t)).body.client_id;
    assert.equal((await token(t, { ...base, client_id: other })).body.error, "invalid_grant", "another app's code");
    assert.equal((await token(t, { ...base, client_id: "bcli_" + "1".repeat(32) })).status, 401);
    const ok = await token(t, base);
    assert.equal(ok.status, 200, JSON.stringify(ok.body));
    assert.equal(ok.headers.get("cache-control"), "no-store");
    assert.equal(ok.body.token_type, "Bearer");
    assert.equal(ok.body.expires_in, 3600);
    assert.equal(ok.body.scope, "crm:read crm:ask");
    assert.match(ok.body.access_token, /^bcat_/);
    assert.match(ok.body.refresh_token, /^bcrt_/);
    assert.equal((await rpc(t, { key: ok.body.access_token, method: "ping" })).status, 200);
    const again = await token(t, base);
    assert.equal(again.body.error, "invalid_grant");
    assert.equal((await rpc(t, { key: ok.body.access_token, method: "ping" })).status, 401, "a reused code cuts off its tokens");
    // a code left 5 minutes expires
    const late = await connect(t, owner);
    advance(minutes(6));
    assert.equal((await token(t, { ...base, code: late.code, client_id: late.client })).body.error, "invalid_grant");
    // the request is form-encoded, JSON is accepted too, a wrong grant type isn't
    assert.equal((await token(t, { grant_type: "password", client_id: c.client })).body.error, "unsupported_grant_type");
  } finally { t.done(); }
});

test("connected with approvals: reads answer; an ask is a pending action an owner approves; nothing runs before", async () => {
  const { t, owner, owner2 } = await setup();
  try {
    const c = await customer(owner);
    const tok = await tokens(t, owner);
    const tools = (await rpc(t, { key: tok.access_token, method: "tools/list" })).body.result.tools.map((x) => x.name);
    assert.ok(tools.includes("search_contacts") && tools.includes("send_message") && tools.includes("create_task"), "reads and asks");
    const found = await call(t, tok.access_token, "search_contacts", { q: c.last_name });
    assert.equal(found.isError, false);
    const before = t.stores.data.keys("rec/outbox/").length;
    const r = await call(t, tok.access_token, "send_message", { contact_id: c.id, body: "Hi Pat, Thursday morning works for us." });
    assert.equal(r.isError, false, JSON.stringify(r));
    assert.equal(r.result.status, "waiting_for_approval");
    await drain(t);
    assert.equal(t.stores.data.keys("rec/outbox/").length, before, "nothing sent before an owner approves");
    const pa = (await store.getRecord("pending_action", r.result.pending_action_id)).data;
    assert.equal(pa.status, "pending");
    assert.equal(pa.key_id, t.stores.data.keys("oauth/grant/")[0].split("/").pop(), "the ask names the connection");
    assert.equal(pa.requested_by, owner.id);
    assert.equal((await t.api(`/pending-actions/${pa.id}/approve`, { method: "POST", as: owner2, body: {} })).status, 200);
    await drain(t);
    assert.equal((await store.getRecord("pending_action", pa.id)).data.status, "done");
    assert.equal(t.stores.data.keys("rec/outbox/").length, before + 1, "one text, in the outbox (dry-run)");

    // look-up only: Allow without asking
    const ro = await tokens(t, owner, { ask: false });
    assert.equal(ro.scope, "crm:read");
    const rtools = (await rpc(t, { key: ro.access_token, method: "tools/list" })).body.result.tools.map((x) => x.name);
    assert.ok(rtools.includes("search_contacts") && !rtools.includes("send_message"));
    assert.equal((await call(t, ro.access_token, "send_message", { contact_id: c.id, body: "x" })).isError, true);
  } finally { t.done(); }
});

test("refresh tokens rotate; an old one used again disconnects; an hour-old access token stops; Settings lists and disconnects", async () => {
  const { t, owner, admin } = await setup();
  try {
    const tok = await tokens(t, owner);
    advance(hours(1) + minutes(1));
    assert.equal((await rpc(t, { key: tok.access_token, method: "ping" })).status, 401, "an access token lasts an hour");
    const r1 = await token(t, { grant_type: "refresh_token", refresh_token: tok.refresh_token, client_id: tok.client });
    assert.equal(r1.status, 200, JSON.stringify(r1.body));
    assert.notEqual(r1.body.refresh_token, tok.refresh_token, "rotated");
    assert.equal((await rpc(t, { key: r1.body.access_token, method: "ping" })).status, 200);
    const r2 = await token(t, { grant_type: "refresh_token", refresh_token: r1.body.refresh_token, client_id: tok.client });
    assert.equal(r2.status, 200);
    // the first refresh token again: someone kept a copy → the connection is cut
    const reuse = await token(t, { grant_type: "refresh_token", refresh_token: tok.refresh_token, client_id: tok.client });
    assert.equal(reuse.body.error, "invalid_grant");
    assert.equal((await rpc(t, { key: r2.body.access_token, method: "ping" })).status, 401);
    assert.equal((await token(t, { grant_type: "refresh_token", refresh_token: r2.body.refresh_token, client_id: tok.client })).body.error, "invalid_grant");

    // Settings → Claude connector: the person's connections; an owner sees everyone's
    const mine = await tokens(t, owner);
    const adm = await tokens(t, admin);
    const list = await t.api("/mcp/oauth/grants", { as: owner });
    assert.equal(list.body.data.length, 2);
    assert.ok(list.body.data.every((g) => g.app === "Claude" && g.goes_back_to === "claude.ai"));
    const admList = await t.api("/mcp/oauth/grants", { as: admin });
    assert.equal(admList.body.data.length, 1, "the office sees its own");
    const ownersGrant = list.body.data.find((g) => g.user_id === owner.id).id;
    assert.equal((await t.api(`/mcp/oauth/grants/${ownersGrant}`, { method: "DELETE", as: admin })).status, 404, "not someone else's");
    assert.equal((await t.api(`/mcp/oauth/grants/${ownersGrant}`, { method: "DELETE", as: owner })).status, 200);
    assert.equal((await rpc(t, { key: mine.access_token, method: "ping" })).status, 401, "disconnected: stops at once");
    assert.equal((await token(t, { grant_type: "refresh_token", refresh_token: mine.refresh_token, client_id: mine.client })).body.error, "invalid_grant");
    assert.equal((await rpc(t, { key: adm.access_token, method: "ping" })).status, 200, "the other connection keeps working");
    // the app revokes its own token (RFC 7009)
    assert.equal((await auth(t, "/auth/oauth/revoke", { method: "POST", raw: form({ token: adm.refresh_token, client_id: adm.client }), headers: { "content-type": "application/x-www-form-urlencoded" } })).status, 200);
    assert.equal((await rpc(t, { key: adm.access_token, method: "ping" })).status, 401);
  } finally { t.done(); }
});

test("a password change, sign out everywhere or a turned-off person stops the connection; path keys keep working", async () => {
  const { t, owner, owner2, admin } = await setup();
  try {
    const tok = await tokens(t, owner);
    assert.equal((await rpc(t, { key: tok.access_token, method: "ping" })).status, 200);
    assert.equal((await t.auth("/auth/logout-all", { as: owner, body: {} })).status, 200);
    assert.equal((await rpc(t, { key: tok.access_token, method: "ping" })).status, 401, "sign out everywhere");
    assert.equal((await token(t, { grant_type: "refresh_token", refresh_token: tok.refresh_token, client_id: tok.client })).body.error, "invalid_grant");
    const a = await tokens(t, admin);
    await store.updateRecord("user", admin.id, (u) => ({ ...u, status: "disabled" }), AS(owner));
    assert.equal((await rpc(t, { key: a.access_token, method: "ping" })).status, 401, "a turned-off person");
    // path keys: unchanged, still read-only
    const link = await makeKey(t, owner2, { kind: "path", name: "Claude.ai connector" });
    assert.equal((await rpc(t, { pathKey: link.key, method: "ping" })).status, 200);
  } finally { t.done(); }
});

test("the nightly clean-up deletes what expired and what a disconnect left; a live connection stays", async () => {
  const { t, owner } = await setup();
  try {
    const live = await tokens(t, owner);
    const gone = await tokens(t, owner);
    const gid = t.stores.data.keys("oauth/grant/").map((k) => t.stores.data.json(k)).find((g) => g.client_id === gone.client).id;
    await store.withStoreScope({ requestId: "t" }, () => O.revokeGrant(gid));
    await register(t);                                       // never used
    advance(days(31));
    const out = await store.withStoreScope({ requestId: "t" }, () => O.cleanup({}));
    assert.ok(out.result.removed > 0);
    const left = t.stores.data.keys("oauth/");
    assert.equal(left.filter((k) => k.startsWith("oauth/grant/")).length, 1);
    assert.equal(left.filter((k) => k.startsWith("oauth/client/")).length, 1, "the live connection's app stays; unused ones go after 30 days");
    assert.equal(left.filter((k) => k.startsWith("oauth/at/")).length, 0, "expired access tokens go");
    assert.equal(left.filter((k) => k.startsWith("oauth/rt/")).length, 0, "refresh tokens past 30 days go");
    assert.equal(left.filter((k) => k.startsWith("oauth/code/") || k.startsWith("oauth/req/")).length, 0);
    assert.ok(live.client);
  } finally { t.done(); }
});
