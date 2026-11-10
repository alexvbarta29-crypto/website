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
  const dev = "barta_dev=abcdefghijklmnopqrstuvwx";
  const tryLogin = (password, opts = {}) => t.auth("/auth/login", { body: { login: "olive", password }, cookie: dev, ...opts });
  for (let i = 0; i < LOGIN_FREE_FAILS; i++) assert.equal((await tryLogin("wrong password " + i)).status, 401);
  let r = await tryLogin(PASSWORD);
  assert.equal(r.status, 429, "after 5 failures even the right password waits");
  assert.equal(r.headers.get("retry-after"), "30");
  assert.ok(r.body.error.details.retry_after_s <= 30);
  // another phone of the same person is not locked out
  const other = await t.auth("/auth/login", { body: { login: "olive", password: PASSWORD }, cookie: "barta_dev=zyxwvutsrqponmlkjihgfedc" });
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
  for (let i = 0; i < IP_LIMIT; i++) await t.auth("/auth/login", { body: { login: "x" + i, password: "nope nope nope" }, headers: { "x-nf-client-connection-ip": "198.51.100.7" }, cookie: "barta_dev=dev" + String(i).padStart(21, "0") });
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
  const phone = await t.auth("/auth/login", { body: { login: "olive", password: PASSWORD }, cookie: "barta_dev=abcdefghijklmnopqrstuvwx" });
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
