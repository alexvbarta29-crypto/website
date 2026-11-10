// Sign-in, setup, invites and sessions (design §4.2-§4.4, §4.8, §4.11,
// §2.4 D14; acceptance tests of M1.2). Synthetic people only.
import { test, afterEach } from "node:test";
import assert from "node:assert/strict";
import { crmTest, officeCookie, PASSWORD } from "../../helpers/crm-http.mjs";
import { advance, minutes, hours, days } from "../../helpers/crm-clock.mjs";

const { stats } = await import("../../../netlify/lib/crm/core/passwords.mjs");
const { derive } = await import("../../../netlify/lib/lights-auth.mjs");
const { getRaw, settledWrite, getRecord } = await import("../../../netlify/lib/crm-store.mjs");
const { AUTH_EPOCH_KEY, SESSION_COOKIE } = await import("../../../netlify/lib/crm/core/sessions.mjs");
const { delayAfter, LOGIN_FREE_FAILS, IP_LIMIT } = await import("../../../netlify/lib/crm/core/throttle.mjs");
const { safeTo } = await import("../../../netlify/lib/crm/core/http.mjs");

let t;
afterEach(() => { if (t) t.done(); t = null; });

const SETUP = { setup_code: "setup-code-for-tests", name: "Olive Owner", login: "olive", password: "a long first password" };
const dump = (t) => [...t.stores.data.snapshot()].map(([k, v]) => k + " " + new TextDecoder().decode(v.bytes)).join("\n");

test("setup needs the office cookie AND CRM_SETUP_CODE, works once even when two run together, then 410", async () => {
  t = await crmTest({ env: { CRM_SETUP_CODE: SETUP.setup_code } });
  // no office cookie
  let r = await t.auth("/auth/setup", { body: SETUP });
  assert.equal(r.status, 403);
  // wrong code
  r = await t.auth("/auth/setup", { body: { ...SETUP, setup_code: "nope" }, office: true });
  assert.equal(r.status, 400);
  assert.equal(r.body.error.field, "setup_code");
  // two phones at once: one owner
  const [a, b] = await Promise.all([
    t.auth("/auth/setup", { body: SETUP, office: true }),
    t.auth("/auth/setup", { body: { ...SETUP, login: "jake", name: "Jake Owner" }, office: true }),
  ]);
  const statuses = [a.status, b.status].sort();
  assert.equal(statuses[0], 201, JSON.stringify([a.body, b.body]));
  assert.ok([409, 410].includes(statuses[1]), String(statuses[1]));
  const won = a.status === 201 ? a : b;
  assert.equal(won.body.data.user.role, "owner");
  assert.equal(won.body.data.to, "/office#crm");
  assert.ok(t.cookieFrom(won, SESSION_COOKIE), "the new owner is signed in");
  const users = await t.api("/users", { cookie: t.cookieFrom(won, SESSION_COOKIE) });
  assert.equal(users.status, 200);
  assert.equal(users.body.data.length, 1, "exactly one owner");
  // afterwards: 410, and the page says so
  r = await t.auth("/auth/setup", { body: { ...SETUP, login: "late" }, office: true });
  assert.equal(r.status, 410);
  const page = await t.page("/crm/setup", { office: true });
  assert.equal(page.status, 410);
  // nothing about the office password or its token is stored
  const all = dump(t);
  assert.ok(!all.includes(derive(process.env.OFFICE_PASSWORD)), "no office token in the store");
  assert.ok(!all.includes(SETUP.setup_code), "no setup code in the store");
  assert.ok(!all.includes(SETUP.password), "no password in the store");
});

test("setup refuses without CRM_SETUP_CODE in the environment", async () => {
  t = await crmTest({ env: { CRM_SETUP_CODE: undefined } });
  const r = await t.auth("/auth/setup", { body: SETUP, office: true });
  assert.equal(r.status, 503);
  assert.equal(r.body.error.code, "setup_needed");
  const page = await t.page("/crm/setup", { office: true });
  assert.equal(page.status, 503);
  assert.match(page.text, /CRM_SETUP_CODE/);
});

test("an unknown login runs PBKDF2 against the dummy hash and gets the same answer as a wrong password", async () => {
  t = await crmTest();
  const owner = await t.user("owner", { login: "olive" });
  await t.bootstrap(owner);
  const before = stats.derivations;
  const unknown = await t.auth("/auth/login", { body: { login: "nobody", password: "whatever it is" } });
  assert.equal(stats.derivations - before, 1, "one PBKDF2 run for an unknown login");
  const wrong = await t.auth("/auth/login", { body: { login: "olive", password: "not the password" } });
  assert.equal(unknown.status, 401);
  assert.equal(wrong.status, 401);
  assert.deepEqual(unknown.body, wrong.body);
  assert.equal(unknown.body.error.message, "That login or password isn't right.");
  const good = await t.auth("/auth/login", { body: { login: "Olive", password: PASSWORD } });
  assert.equal(good.status, 200);
  assert.equal(good.body.data.user.login, "olive");
  assert.equal(good.body.data.perms["users:manage"], true);
  assert.equal(good.body.data.user.password, undefined, "never the hash");
  const c = t.setCookies(good).find((x) => x.startsWith("barta_crm="));
  assert.match(c, /HttpOnly/);
  assert.match(c, /Secure/);
  assert.match(c, /SameSite=Lax/);
  assert.match(c, /Max-Age=31536000/);
  assert.ok(t.setCookies(good).some((x) => x.startsWith("barta_dev=")), "a new browser gets its device id");
});

test("progressive delay per login and device, the shared bucket for new browsers, and the IP limit", async () => {
  t = await crmTest();
  const owner = await t.user("owner", { login: "olive" });
  await t.bootstrap(owner);
  const dev = t.device();
  const tryLogin = (password, opts = {}) => t.auth("/auth/login", { body: { login: "olive", password }, cookie: dev, ...opts });
  for (let i = 0; i < LOGIN_FREE_FAILS; i++) assert.equal((await tryLogin("wrong password " + i)).status, 401);
  let r = await tryLogin(PASSWORD);
  assert.equal(r.status, 429, "after 5 failures even the right password waits");
  assert.equal(r.headers.get("retry-after"), "30");
  assert.ok(r.body.error.details.retry_after_s <= 30);
  // another phone of the same person is not locked out
  const other = await t.auth("/auth/login", { body: { login: "olive", password: PASSWORD }, cookie: t.device() });
  assert.equal(other.status, 200);
  advance(31 * 1000);
  assert.equal((await tryLogin("wrong again")).status, 401);
  r = await tryLogin(PASSWORD);
  assert.equal(r.status, 429);
  assert.equal(r.headers.get("retry-after"), "60", "the delay doubles");
  assert.equal(delayAfter(5), 30000);
  assert.equal(delayAfter(30), 15 * 60 * 1000, "capped at 15 minutes");
  advance(61 * 1000);
  assert.equal((await tryLogin(PASSWORD)).status, 200, "a good sign-in after the wait works and clears the bucket");
  assert.equal((await tryLogin("wrong once more")).status, 401);
  assert.equal((await tryLogin(PASSWORD)).status, 200);

  // the IP limit: 30 failures an hour from one address, whatever the login
  for (let i = 0; i < IP_LIMIT; i++) await t.auth("/auth/login", { body: { login: "x" + i, password: "nope nope nope" }, headers: { "x-nf-client-connection-ip": "198.51.100.7" }, cookie: t.device() });
  r = await t.auth("/auth/login", { body: { login: "olive", password: PASSWORD }, headers: { "x-nf-client-connection-ip": "198.51.100.7" }, cookie: dev });
  assert.equal(r.status, 429);
  assert.ok(r.body.error.details.retry_after_s > 3000, "refused for about an hour");
  advance(hours(1) + minutes(1));
  assert.equal((await t.auth("/auth/login", { body: { login: "olive", password: PASSWORD }, headers: { "x-nf-client-connection-ip": "198.51.100.7" }, cookie: dev })).status, 200);
});

test("a browser without a device id shares the 'new' bucket, which locks for an hour after 20 failures", async () => {
  t = await crmTest();
  const owner = await t.user("owner", { login: "olive" });
  await t.bootstrap(owner);
  for (let i = 0; i < 20; i++) await t.auth("/auth/login", { body: { login: "olive", password: "wrong " + i }, headers: { "x-nf-client-connection-ip": "203.0.113." + (i % 200) } });
  const r = await t.auth("/auth/login", { body: { login: "olive", password: PASSWORD }, headers: { "x-nf-client-connection-ip": "203.0.113.250" } });
  assert.equal(r.status, 429);
  assert.ok(r.body.error.details.retry_after_s > 3000);
  const phone = await t.auth("/auth/login", { body: { login: "olive", password: PASSWORD }, cookie: t.device() });
  assert.equal(phone.status, 200, "Alex's own phone still signs in");
});

test("`to` must stay on /office or /crm; anything else becomes /office#crm", async () => {
  for (const bad of ["https://evil.example", "//evil.example/office", "/office/../evil", "javascript:alert(1)", "/p/abc", "/officex", "", null, "/office\\@evil"]) {
    assert.equal(safeTo(bad), "/office#crm", String(bad));
  }
  for (const ok of ["/office", "/office#crm", "/crm", "/crm#/team", "/crm/legacy"]) assert.equal(safeTo(ok), ok);
  t = await crmTest();
  const owner = await t.user("owner", { login: "olive" });
  const r = await t.auth("/auth/login", { body: { login: "olive", password: PASSWORD, to: "https://evil.example" } });
  assert.equal(r.status, 200);
  assert.equal(r.body.data.to, "/office#crm");
  assert.ok(owner);
});

test("D14: the office password on Team sign-in sets barta_office only for an allowed role and the right password", async () => {
  t = await crmTest();
  const owner = await t.user("owner", { login: "olive" });
  const tech = await t.user("tech", { login: "theo" });
  await t.bootstrap(owner);
  const office = process.env.OFFICE_PASSWORD;
  // owner + right office password
  let r = await t.auth("/auth/login", { body: { login: "olive", password: PASSWORD, office_password: office } });
  assert.equal(r.status, 200);
  assert.equal(r.body.data.office_cookie, true);
  assert.equal(t.cookieFrom(r, "barta_office"), officeCookie(), "the same cookie POST /office sets");
  // owner + wrong office password: CRM sign-in only
  r = await t.auth("/auth/login", { body: { login: "olive", password: PASSWORD, office_password: "not it" } });
  assert.equal(r.status, 200);
  assert.equal(r.body.data.office_cookie, false);
  assert.equal(t.cookieFrom(r, "barta_office"), null);
  // a tech with the right office password: not allowed
  r = await t.auth("/auth/login", { body: { login: "theo", password: PASSWORD, office_password: office } });
  assert.equal(r.status, 200);
  assert.equal(r.body.data.office_cookie, false);
  assert.equal(t.cookieFrom(r, "barta_office"), null);
  // no office password: nothing about it
  r = await t.auth("/auth/login", { body: { login: "olive", password: PASSWORD } });
  assert.equal(r.body.data.office_cookie, null);
  // the owner may allow admins too (cfg/auth); nothing about the token is stored
  assert.ok(!dump(t).includes(derive(office)));
  assert.ok(!dump(t).includes(office));
  assert.ok(tech);
});

test("sessions: idle and absolute expiry with the pinned clock; disabled users are signed out", async () => {
  t = await crmTest();
  const owner = await t.user("owner");
  assert.equal((await t.api("/me", { as: owner })).status, 200);
  advance(days(59));
  assert.equal((await t.api("/me", { as: owner })).status, 200, "inside 60 days idle");
  advance(hours(7));
  assert.equal((await t.api("/me", { as: owner })).status, 200, "that use slid the idle window");
  advance(days(59));
  assert.equal((await t.api("/me", { as: owner })).status, 200);
  advance(days(61));
  assert.equal((await t.api("/me", { as: owner })).status, 401, "60 days without use");

  const a = await t.user("owner");
  for (let i = 0; i < 7; i++) { advance(days(50)); assert.equal((await t.api("/me", { as: a })).status, 200, "day " + (i + 1) * 50); }
  advance(days(20));
  assert.equal((await t.api("/me", { as: a })).status, 401, "a year is the absolute limit");

  const b = await t.user("tech");
  const c = await t.user("owner");
  assert.equal((await t.api("/me", { as: b })).status, 200);
  const off = await t.api(`/users/${b.id}/disable`, { method: "POST", as: c, body: {} });
  assert.equal(off.status, 200);
  advance(6000);
  assert.equal((await t.api("/me", { as: b })).status, 401, "disabled: signed out within seconds");
});

test("an epoch bump and sys/auth-epoch invalidate a cached session; sign out and sign out everywhere", async () => {
  t = await crmTest();
  const owner = await t.user("owner");
  const r1 = await t.auth("/auth/login", { body: { login: owner.login, password: PASSWORD } });
  const phone2 = t.cookieFrom(r1, SESSION_COOKIE);
  assert.equal((await t.api("/me", { cookie: phone2 })).status, 200);
  assert.equal((await t.api("/me", { as: owner })).status, 200);   // both cached now
  // bump the user's epoch behind the cache's back, then sys/auth-epoch
  const cur = await getRecord("user", owner.id);
  const next = { ...cur.data, session_epoch: 1 };
  await settledWrite(`rec/user/${owner.id}`, next, { onlyIfMatch: cur.etag });
  assert.equal((await t.api("/me", { as: owner })).status, 200, "still cached: auth-epoch hasn't moved");
  const ep = await getRaw(AUTH_EPOCH_KEY);
  await settledWrite(AUTH_EPOCH_KEY, { n: (ep && ep.data ? ep.data.n : 0) + 1 }, ep ? { onlyIfMatch: ep.etag } : { onlyIfNew: true });
  advance(6000);
  assert.equal((await t.api("/me", { as: owner })).status, 401, "re-verified within 5 s");
  assert.equal((await t.api("/me", { cookie: phone2 })).status, 401);

  const b = await t.user("admin");
  const s2 = t.cookieFrom(await t.auth("/auth/login", { body: { login: b.login, password: PASSWORD } }), SESSION_COOKIE);
  const out = await t.auth("/auth/logout", { as: b, body: {} });
  assert.equal(out.status, 200);
  assert.match(t.setCookies(out).join(";"), /barta_crm=; Path=\/; Max-Age=0/);
  assert.equal((await t.api("/me", { as: b })).status, 401, "that phone is signed out");
  assert.equal((await t.api("/me", { cookie: s2 })).status, 200, "the other one isn't");
  const all = await t.auth("/auth/logout-all", { cookie: s2, body: {} });
  assert.equal(all.status, 200);
  assert.equal((await t.api("/me", { cookie: s2 })).status, 401);
});

test("invites and resets: single use, 7 days, and a reset signs the person out", async () => {
  t = await crmTest();
  const owner = await t.user("owner");
  await t.bootstrap(owner);
  const add = await t.api("/users", { method: "POST", as: owner, body: { name: "Gus Tech", login: "gus", role: "tech", is_technician: true } });
  assert.equal(add.status, 201);
  assert.equal(add.body.data.status, "invited");
  const dup = await t.api("/users", { method: "POST", as: owner, body: { name: "Other Gus", login: "gus", role: "tech" } });
  assert.equal(dup.status, 409, "logins are unique");
  const inv = await t.api(`/users/${add.body.data.id}/invite`, { method: "POST", as: owner, body: {} });
  assert.equal(inv.status, 200);
  const link = inv.body.data.link;
  assert.match(link, /\/crm\/invite\/us_[0-9a-z]{20}\.[A-Za-z0-9_-]{43}$/);
  const token = link.split("/crm/invite/")[1];
  assert.ok(!dump(t).includes(token.split(".")[1]), "only the token's hash is stored");
  const info = await t.api(`/auth/invite/${token}`, {}).catch(() => null);
  assert.equal(info.status, 404, "invite info lives on crm-auth, not crm-api");
  const page = await t.page(`/crm/invite/${token}`);
  assert.equal(page.status, 200);
  assert.match(page.text, /Welcome, Gus/);
  assert.doesNotMatch(page.text, /<script>(?!\s*$)/, "no inline script");
  const weak = await t.auth("/auth/invite", { body: { token, password: "short" } });
  assert.equal(weak.status, 400);
  assert.equal(weak.body.error.field, "password");
  const ok = await t.auth("/auth/invite", { body: { token, password: "gus has a long password" } });
  assert.equal(ok.status, 200);
  assert.equal(ok.body.data.user.status, "active");
  const gus = t.cookieFrom(ok, SESSION_COOKIE);
  assert.equal((await t.api("/me", { cookie: gus })).body.data.user.login, "gus");
  const again = await t.auth("/auth/invite", { body: { token, password: "gus has a long password" } });
  assert.equal(again.status, 410, "single use");
  assert.equal((await t.page(`/crm/invite/${token}`)).status, 410);
  // a link older than 7 days
  const add2 = await t.api("/users", { method: "POST", as: owner, body: { name: "Ben Tech", login: "ben", role: "tech" } });
  const inv2 = await t.api(`/users/${add2.body.data.id}/invite`, { method: "POST", as: owner, body: {} });
  advance(days(7) + 1000);
  assert.equal((await t.auth("/auth/invite", { body: { token: inv2.body.data.link.split("/crm/invite/")[1], password: "ben has a long password" } })).status, 410);
  // a reset signs Gus out until he picks a new password
  const reset = await t.api(`/users/${add.body.data.id}/reset`, { method: "POST", as: owner, body: {} });
  assert.equal(reset.status, 200);
  advance(6000);
  assert.equal((await t.api("/me", { cookie: gus })).status, 401);
  const rt = reset.body.data.link.split("/crm/invite/")[1];
  const done = await t.auth("/auth/invite", { body: { token: rt, password: "a brand new long one" } });
  assert.equal(done.status, 200);
  const login = await t.auth("/auth/login", { body: { login: "gus", password: "a brand new long one" } });
  assert.equal(login.status, 200);
});

test("password change: checks the current one and the rules, keeps this phone, signs out the others", async () => {
  t = await crmTest();
  const owner = await t.user("owner");
  const other = t.cookieFrom(await t.auth("/auth/login", { body: { login: owner.login, password: PASSWORD } }), SESSION_COOKIE);
  let r = await t.auth("/auth/password", { as: owner, body: { current: "wrong", next: "a fresh long password" } });
  assert.equal(r.status, 400);
  assert.equal(r.body.error.field, "current");
  r = await t.auth("/auth/password", { as: owner, body: { current: PASSWORD, next: "password123" } });
  assert.equal(r.status, 400);
  assert.equal(r.body.error.field, "password");
  r = await t.auth("/auth/password", { as: owner, body: { current: PASSWORD, next: "a fresh long password" } });
  assert.equal(r.status, 200);
  const mine = t.cookieFrom(r, SESSION_COOKIE);
  advance(6000);
  assert.equal((await t.api("/me", { cookie: mine })).status, 200, "this phone stays in");
  assert.equal((await t.api("/me", { cookie: other })).status, 401, "the other phone is out");
  assert.equal((await t.auth("/auth/login", { body: { login: owner.login, password: "a fresh long password" } })).status, 200);
});

test("the sign-in routes refuse cross-site posts (CSRF) and a production deploy without its settings", async () => {
  t = await crmTest();
  const owner = await t.user("owner");
  let r = await t.auth("/auth/login", { body: { login: owner.login, password: PASSWORD }, csrf: false });
  assert.equal(r.status, 403);
  assert.equal(r.body.error.code, "csrf");
  r = await t.auth("/auth/login", { body: { login: owner.login, password: PASSWORD }, headers: { origin: "https://evil.example" } });
  assert.equal(r.status, 403);
  r = await t.auth("/auth/login", { raw: "login=x&password=y", headers: { "content-type": "application/x-www-form-urlencoded" } });
  assert.equal(r.status, 403);
  r = await t.auth("/auth/login", { body: { login: owner.login, password: PASSWORD }, context: { deploy: { context: "production" } } });
  assert.equal(r.status, 503, "production without CRM_PRODUCTION: setup needed");
  assert.equal(r.body.error.code, "setup_needed");
});

// ------------------------------------------------------------ M1.2 review regressions

test("a reset link signs the person out AND stops the old password until the link sets a new one", async () => {
  t = await crmTest();
  const owner = await t.user("owner", { login: "olive" });
  await t.bootstrap(owner);
  const tech = await t.user("tech", { login: "gus" });
  assert.equal((await t.auth("/auth/login", { body: { login: "gus", password: PASSWORD } })).status, 200, "before: the password works");
  const r = await t.api(`/users/${tech.id}/reset`, { method: "POST", as: owner, body: {} });
  assert.equal(r.status, 200);
  assert.equal(r.body.data.user.has_password, false);
  const old = await t.auth("/auth/login", { body: { login: "gus", password: PASSWORD } });
  assert.equal(old.status, 401, "the old password no longer signs in");
  assert.equal(old.body.error.message, "That login or password isn't right.");
  const token = r.body.data.link.split("/crm/invite/")[1];
  assert.equal((await t.auth("/auth/invite", { body: { token, password: "gus picks a new one" } })).status, 200);
  assert.equal((await t.auth("/auth/login", { body: { login: "gus", password: "gus picks a new one" } })).status, 200);
  assert.equal((await t.auth("/auth/login", { body: { login: "gus", password: PASSWORD } })).status, 401);
});

test("invite and reset links are never stored in clear, even when the request carries an Idempotency-Key", async () => {
  t = await crmTest();
  const owner = await t.user("owner", { login: "olive" });
  await t.bootstrap(owner);
  const add = await t.api("/users", { method: "POST", as: owner, idem: "11111111-2222-4333-8444-555555555555", body: { name: "Gus Tech", login: "gus", role: "tech" } });
  assert.equal(add.status, 201);
  const inv = await t.api(`/users/${add.body.data.id}/invite`, { method: "POST", as: owner, idem: "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee", body: {} });
  assert.equal(inv.status, 200);
  const token = inv.body.data.link.split(".").pop();
  assert.ok(!dump(t).includes(token), "the invite token is nowhere in Blobs");
  // a retry with the same key is a fresh link (and voids the first), never a replay of the stored one
  const again = await t.api(`/users/${add.body.data.id}/invite`, { method: "POST", as: owner, idem: "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee", body: {} });
  assert.equal(again.status, 200);
  assert.equal(again.headers.get("idempotent-replay"), null);
  assert.notEqual(again.body.data.link, inv.body.data.link);
  assert.equal((await t.auth("/auth/invite", { body: { token: inv.body.data.link.split("/crm/invite/")[1], password: "a brand new password" } })).status, 410, "the first link is void");
  const tech = await t.user("tech", { login: "ben" });
  const reset = await t.api(`/users/${tech.id}/reset`, { method: "POST", as: owner, idem: "bbbbbbbb-bbbb-4ccc-8ddd-eeeeeeeeeeee", body: {} });
  assert.equal(reset.status, 200);
  assert.ok(!dump(t).includes(reset.body.data.link.split(".").pop()), "nor the reset token");
  assert.ok(!dump(t).includes(again.body.data.link.split(".").pop()));
});

test("setup: a too-long name is refused before the claim, so the corrected retry goes straight through", async () => {
  t = await crmTest({ env: { CRM_SETUP_CODE: SETUP.setup_code } });
  // the form caps what can be typed
  const form = await t.page("/crm/setup", { office: true });
  assert.match(form.text, /name="name"[^>]*maxlength="60"/);
  assert.match(form.text, /name="login"[^>]*maxlength="32"/);
  const first = await t.auth("/auth/setup", { body: { ...SETUP, name: "Olive " + "x".repeat(70) }, office: true });
  assert.equal(first.status, 400);
  assert.equal(first.body.error.field, "name");
  assert.equal(await getRaw("sys/bootstrap"), null, "nothing claimed");
  const retry = await t.auth("/auth/setup", { body: SETUP, office: true });
  assert.equal(retry.status, 201, JSON.stringify(retry.body));
  assert.equal((await t.page("/crm/setup", { office: true })).status, 410);
});

test("setup: a failure after the claim hands the claim back at once", async () => {
  t = await crmTest({ env: { CRM_SETUP_CODE: SETUP.setup_code } });
  // the login pointer is taken (an emergency re-setup over existing accounts, §4.4 step 4)
  await t.user("tech", { login: "olive" });
  const r = await t.auth("/auth/setup", { body: SETUP, office: true });
  assert.equal(r.status, 400);
  assert.equal(r.body.error.field, "login");
  const boot = await getRaw("sys/bootstrap");
  assert.equal(boot.data.released, true);
  const retry = await t.auth("/auth/setup", { body: { ...SETUP, login: "olive.b" }, office: true });
  assert.equal(retry.status, 201, "no 2-minute wait: " + JSON.stringify(retry.body));
  assert.equal((await getRaw("sys/bootstrap")).data.state, "done");
});

test("setup: when the final 'done' write is lost, the CRM is still set up for everyone and sys/bootstrap is repaired", async () => {
  t = await crmTest({ env: { CRM_SETUP_CODE: SETUP.setup_code } });
  // the claim lands; every later write of sys/bootstrap times out (one bad moment of Blobs)
  t.stores.data.beforeConditionalWrite((key, opts, store) => { store.fail({ op: ["set", "setJSON"], key: "sys/bootstrap", kind: "timeout", times: 10 }); }, { key: "sys/bootstrap" });
  const r = await t.auth("/auth/setup", { body: SETUP, office: true });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  t.stores.data.clearHooks();
  assert.equal((await getRaw("sys/bootstrap")).data.state, "pending", "the lost write");
  advance(minutes(30));
  const login = await t.page("/crm/login");
  assert.equal(login.status, 200);
  assert.match(login.text, /Team sign-in/, "the sign-in page, not 'Not set up yet'");
  assert.equal((await getRaw("sys/bootstrap")).data.state, "done", "repaired");
  const again = await t.auth("/auth/setup", { body: { ...SETUP, login: "jake" }, office: true });
  assert.equal(again.status, 410);
  assert.match((await t.office("/office")).text, /const TEAM = true;/);
  // and before the repair, a pending claim whose owner exists already counts as done
  await settledWrite("sys/bootstrap", { state: "pending", user_id: r.body.data.user.id, at: new Date().toISOString() }, { onlyIfMatch: (await getRaw("sys/bootstrap")).etag });
  assert.match((await t.office("/office")).text, /const TEAM = true;/);
  assert.equal((await t.auth("/auth/setup", { body: { ...SETUP, login: "jake" }, office: true })).status, 410);
});

test("failures that land at the same moment are all counted: 30 at once lock that IP", async () => {
  t = await crmTest();
  const { recordFailure, checkThrottle } = await import("../../../netlify/lib/crm/core/throttle.mjs");
  const ip = "198.51.100.9";
  await Promise.all(Array.from({ length: IP_LIMIT }, (_, i) => recordFailure({ login: "olive", device: ("d" + i).padEnd(24, "x"), ip })));
  const th = await checkThrottle({ login: "olive", device: "z".repeat(24), ip });
  assert.equal(th.ok, false, "the IP that just failed 30 times is refused");
  assert.equal(th.why, "ip");
  assert.ok(th.retry_after_s > 3000);
  // and through the sign-in route: 30 wrong passwords at once, then the right one waits
  const owner = await t.user("owner", { login: "olive" });
  await t.bootstrap(owner);
  const ip2 = { "x-nf-client-connection-ip": "198.51.100.10" };
  await Promise.all(Array.from({ length: IP_LIMIT }, (_, i) => t.auth("/auth/login", { body: { login: "olive", password: "guess " + i }, headers: ip2, cookie: t.device() })));
  assert.equal((await t.auth("/auth/login", { body: { login: "olive", password: PASSWORD }, headers: ip2, cookie: t.device() })).status, 429);
});

test("a barta_dev the server didn't issue is no device: made-up ids share the 'new' bucket", async () => {
  t = await crmTest();
  const owner = await t.user("owner", { login: "olive" });
  await t.bootstrap(owner);
  const statuses = [];
  for (let i = 0; i < 21; i++) {
    const forged = "barta_dev=" + ("f" + i).padEnd(24, "q") + (i % 2 ? "" : "." + "0".repeat(20));
    const r = await t.auth("/auth/login", { body: { login: "olive", password: "guess number " + i }, cookie: forged, headers: { "x-nf-client-connection-ip": "203.0.113." + i } });
    statuses.push(r.status);
    assert.ok(t.setCookies(r).some((c) => c.startsWith("barta_dev=")), "a forged id is replaced by a real one");
  }
  assert.deepEqual(statuses.slice(0, 20), Array(20).fill(401));
  assert.equal(statuses[20], 429, "the 21st guess waits an hour, forged ids or not");
  const phone = await t.auth("/auth/login", { body: { login: "olive", password: PASSWORD }, cookie: t.device() });
  assert.equal(phone.status, 200, "a phone the server issued an id to still signs in");
  const issued = t.cookieFrom(phone, "barta_dev");
  assert.equal(issued, null, "a valid id is kept, not replaced");
});

test("a wrong password for a real login and an unknown login make the same storage round trips before the answer", async () => {
  t = await crmTest();
  const owner = await t.user("owner", { login: "olive" });
  await t.bootstrap(owner);
  const dev = t.device();
  const run = async (login) => {
    const later = [];
    const before = t.stores.data.calls.length;
    const r = await t.auth("/auth/login", { body: { login, password: "wrong password here" }, cookie: dev, context: { waitUntil: (p) => later.push(p) } });
    const calls = t.stores.data.calls.slice(before);
    // what the answer waited for: everything but the audit event handed to waitUntil
    const ops = calls.filter((c) => !String(c.key).startsWith("evt/")).map((c) => c.op);
    await Promise.all(later);
    return { status: r.status, ops, audit: calls.filter((c) => String(c.key).startsWith("evt/")).length, later: later.length };
  };
  const unknown = await run("nobody");
  const known = await run("olive");
  const invalid = await run("not a login@example.com");
  assert.equal(unknown.status, 401);
  assert.equal(known.status, 401);
  assert.equal(invalid.status, 401);
  assert.deepEqual(known.ops, unknown.ops, "the same calls in the same order");
  assert.deepEqual(invalid.ops, unknown.ops);
  assert.equal(known.audit, 1, "a real login's failure is still audited");
  assert.equal(known.later, 1, "but through waitUntil: the answer doesn't wait for it");
  assert.equal(unknown.later, 0);
});

test("sign out that device: DELETE /users/:id/sessions/:hash with exactly the app's headers signs the other phone out", async () => {
  t = await crmTest();
  const owner = await t.user("owner", { login: "olive" });
  await t.bootstrap(owner);
  const second = t.cookieFrom(await t.auth("/auth/login", { body: { login: "olive", password: PASSWORD } }), SESSION_COOKIE);
  const list = await t.api(`/users/${owner.id}/sessions`, { as: owner });
  assert.equal(list.status, 200);
  assert.equal(list.body.data.length, 2);
  const other = list.body.data.find((s) => !s.current);
  // crm-app/core/api.js: X-CRM, X-CRM-Client, Accept; no Content-Type and no body on a DELETE
  const r = await t.api(`/users/${owner.id}/sessions/${other.hash}`, { method: "DELETE", as: owner, headers: { accept: "application/json" } });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal((await t.api("/me", { cookie: second })).status, 401, "that phone is signed out");
  assert.equal((await t.api("/me", { as: owner })).status, 200, "this one isn't");
  // an owner signs a tech's lost phone out from the Person screen
  const tech = await t.user("tech", { login: "gus" });
  const ts = await t.api(`/users/${tech.id}/sessions`, { as: owner });
  const gone = await t.api(`/users/${tech.id}/sessions/${ts.body.data[0].hash}`, { method: "DELETE", as: owner });
  assert.equal(gone.status, 200);
  assert.equal((await t.api("/me", { as: tech })).status, 401);
  // the CSRF header and the Origin check still apply to a DELETE
  assert.equal((await t.api(`/users/${owner.id}/sessions/${other.hash}`, { method: "DELETE", as: owner, csrf: false })).status, 403);
  assert.equal((await t.api(`/users/${owner.id}/sessions/${other.hash}`, { method: "DELETE", as: owner, headers: { origin: "https://evil.example" } })).status, 403);
});

test("PATCH /users/:id takes only owner, admin or tech as a role", async () => {
  t = await crmTest();
  const owner = await t.user("owner");
  await t.bootstrap(owner);
  const tech = await t.user("tech");
  for (const role of ["Owner", "boss", "", null]) {
    const r = await t.api(`/users/${tech.id}`, { method: "PATCH", as: owner, ifMatch: tech.etag, body: { role } });
    assert.equal(r.status, 400, String(role));
    assert.equal(r.body.error.field, "role");
  }
  const ok = await t.api(`/users/${tech.id}`, { method: "PATCH", as: owner, ifMatch: tech.etag, body: { role: "admin" } });
  assert.equal(ok.status, 200);
  assert.equal(ok.body.data.role, "admin");
});
