// Every place that takes the office password is throttled the same way
// (netlify/lib/office-password.mjs, core/throttle.mjs): the caller's own
// bucket, the address's bucket shared with sign-in, and the office
// password's global bucket; with the CRM's storage down the password is not
// checked at all (fail closed). The places: POST /office, /lights,
// /playbook, /api/crm/auth/forgot and first-owner setup by the office
// password. Synthetic people and documentation addresses only.
import { test, afterEach } from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { crmTest, HOST, OFFICE_PASSWORD, PASSWORD } from "../../helpers/crm-http.mjs";
import { advance, minutes, hours } from "../../helpers/crm-clock.mjs";

const { LOGIN_FREE_FAILS, IP_LIMIT, OFFICE_LIMIT, OFFICE_BUCKET } = await import("../../../netlify/lib/crm/core/throttle.mjs");
const { DOWN_TEXT } = await import("../../../netlify/lib/office-password.mjs");
const { SESSION_COOKIE } = await import("../../../netlify/lib/crm/core/sessions.mjs");
const office = (await import("../../../netlify/functions/office.mjs")).default;
const lights = (await import("../../../netlify/functions/lights.mjs")).default;
const playbook = (await import("../../../netlify/functions/playbook.mjs")).default;

let t;
afterEach(() => { if (t) t.done(); t = null; });

const FORMS = [["/office", office], ["/lights", lights], ["/playbook", playbook]];
const WRONG = "a wrong guess";
const NEW_PW = "a brand new sentence here";
const KEY = randomBytes(32).toString("base64");
const addr = (i) => `203.0.113.${i}`;

// POST the office password to a form page from `ip`, with `cookie`.
async function form(fn, path, password, { cookie, ip = "198.51.100.7", context } = {}) {
  const headers = { "content-type": "application/x-www-form-urlencoded" };
  if (cookie) headers.cookie = cookie;
  const res = await fn(new Request(HOST + path, { method: "POST", headers, body: "password=" + encodeURIComponent(password) }), context || { ip });
  return { status: res.status, headers: res.headers, text: await res.text() };
}
const forgot = (officePw, { login = "olive", cookie, ip = "198.51.100.7" } = {}) =>
  t.auth("/auth/forgot", { cookie, context: { ip }, body: { login, office_password: officePw, password: NEW_PW, again: NEW_PW } });
const officeCookieSet = (r) => /^barta_office=[0-9a-f]{64};/.test(r.headers.get("set-cookie") || "");
const throttled = (r, what) => {
  assert.equal(r.status, 429, what);
  assert.ok(Number(r.headers.get("retry-after")) > 0, what + ": Retry-After");
  assert.equal(r.headers.get("set-cookie"), null, what + ": no cookie");
  assert.match(r.text, /Too many tries\. Wait \d+ (seconds|minutes), then try again\./, what);
};

test("each office-password form locks after the limit; the right password works before it and after the wait", async () => {
  for (const [path, fn] of FORMS) {
    t = await crmTest();
    const cookie = t.device();
    const post = (pw) => form(fn, path, pw, { cookie });
    for (let i = 0; i < LOGIN_FREE_FAILS - 1; i++) assert.equal((await post(WRONG)).status, 401, `${path} try ${i + 1}`);
    let r = await post(OFFICE_PASSWORD);
    assert.equal(r.status, 303, `${path}: the right password before the limit`);
    assert.ok(officeCookieSet(r), path);
    advance(1000);   // failures after the good one (the clock is pinned)
    for (let i = 0; i < LOGIN_FREE_FAILS; i++) assert.equal((await post(WRONG)).status, 401, `${path} try ${i + 1} after`);
    throttled(await post(OFFICE_PASSWORD), `${path}: the next try waits, even with the right password`);
    advance(minutes(1));
    r = await post(OFFICE_PASSWORD);
    assert.equal(r.status, 303, `${path}: after the wait the right password works`);
    t.done();
    t = null;
  }
});

test("one address is refused after its limit on every form and Forgot password, whatever phone or login it uses", async () => {
  t = await crmTest();
  const owner = await t.user("owner", { login: "olive" });
  await t.bootstrap(owner);
  const ip = "198.51.100.20";
  // fresh phones and logins each time, so only the address's bucket adds up
  for (let i = 0; i < IP_LIMIT; i++) {
    const cookie = t.device();
    if (i % 4 === 3) {
      assert.equal((await forgot(WRONG, { login: `nobody${i}`, cookie, ip })).status, 401, "forgot " + i);
    } else {
      const [path, fn] = FORMS[i % 4];
      assert.equal((await form(fn, path, WRONG, { cookie, ip })).status, 401, `${path} ${i}`);
    }
  }
  for (const [path, fn] of FORMS) throttled(await form(fn, path, OFFICE_PASSWORD, { cookie: t.device(), ip }), path);
  const r = await forgot(OFFICE_PASSWORD, { cookie: t.device(), ip });
  assert.equal(r.status, 429, "forgot");
  assert.equal(t.cookieFrom(r, SESSION_COOKIE), null);
  // another address is not held up (30 failures are under the global 40)
  for (const [path, fn] of FORMS) assert.equal((await form(fn, path, OFFICE_PASSWORD, { cookie: t.device(), ip: "198.51.100.21" })).status, 303, path);
});

test("the office password's global bucket: guesses spread over many addresses add up, then every place refuses it for an hour", async () => {
  t = await crmTest({ env: { CRM_SETUP_CODE: undefined, OFFICE_DATA_KEY: KEY } });
  assert.ok(OFFICE_LIMIT > IP_LIMIT, "one address alone never trips the global bucket");
  // one wrong try from each address, phone and login, across every place
  const setupBody = { name: "Olive Owner", login: "olive", password: "a long first password" };
  for (let i = 0; i < OFFICE_LIMIT - 1; i++) {
    const cookie = t.device();
    const ip = addr(i + 1);
    if (i % 5 === 3) {
      assert.equal((await forgot(WRONG, { login: `nobody${i}`, cookie, ip })).status, 401, "forgot " + i);
    } else if (i % 5 === 4) {
      const r = await t.auth("/auth/setup", { office: true, cookie, context: { ip }, body: { ...setupBody, setup_code: WRONG } });
      assert.equal(r.status, 400, "setup " + i);
    } else {
      const [path, fn] = FORMS[i % 5];
      assert.equal((await form(fn, path, WRONG, { cookie, ip })).status, 401, `${path} ${i}`);
    }
  }
  assert.equal(t.stores.data.keys(OFFICE_BUCKET).length, OFFICE_LIMIT - 1, "each failure is its own key in thr/office/");
  // one under the limit: the right password still works
  let r = await form(lights, "/lights", OFFICE_PASSWORD, { cookie: t.device(), ip: addr(200) });
  assert.equal(r.status, 303, "before the limit the right password works");
  // the limit: every place refuses the office password, from any address
  assert.equal((await form(playbook, "/playbook", WRONG, { cookie: t.device(), ip: addr(201) })).status, 401);
  for (const [path, fn] of FORMS) throttled(await form(fn, path, OFFICE_PASSWORD, { cookie: t.device(), ip: addr(202) }), path);
  r = await forgot(OFFICE_PASSWORD, { cookie: t.device(), ip: addr(203) });
  assert.equal(r.status, 429, "forgot");
  assert.ok(Number(r.headers.get("retry-after")) > 0);
  r = await t.auth("/auth/setup", { office: true, cookie: t.device(), context: { ip: addr(204) }, body: { ...setupBody, setup_code: OFFICE_PASSWORD } });
  assert.equal(r.status, 429, "setup");
  // a CRM sign-in with the person's own password is not held up
  const owner = await t.user("owner", { login: "oscar" });
  r = await t.auth("/auth/login", { cookie: t.device(), context: { ip: addr(205) }, body: { login: owner.login, password: PASSWORD } });
  assert.equal(r.status, 200, "Team sign-in doesn't use the office password");
  // an hour later the right password works again
  advance(hours(1) + minutes(1));
  r = await form(office, "/office", OFFICE_PASSWORD, { cookie: t.device(), ip: addr(206) });
  assert.equal(r.status, 303);
  assert.ok(officeCookieSet(r));
});

test("with the CRM's storage down the office password is not checked at all (fail closed), never unthrottled", async () => {
  t = await crmTest();
  await t.bootstrap(await t.user("owner", { login: "olive" }));
  t.stores.data.fail({ op: "list", kind: "denied", times: 1000 });
  for (const [path, fn] of FORMS) {
    const r = await form(fn, path, OFFICE_PASSWORD, { cookie: t.device() });
    assert.equal(r.status, 503, path);
    assert.equal(r.headers.get("set-cookie"), null, path + ": no cookie");
    assert.ok(r.text.includes(DOWN_TEXT.replace(/'/g, "&#39;")) || r.text.includes(DOWN_TEXT), path);
  }
  const r = await forgot(OFFICE_PASSWORD, { cookie: t.device() });
  assert.ok(r.status >= 500, "forgot: " + r.status);
  assert.equal(t.cookieFrom(r, SESSION_COOKIE), null);
  assert.equal(t.cookieFrom(r, "barta_office"), null);
  t.done();

  // production without its settings: the CRM's stores can't be opened
  t = await crmTest({ env: { CRM_PRODUCTION: undefined, OFFICE_DATA_KEY: undefined, CRM_KEY_SALT: undefined } });
  const PROD = { deploy: { context: "production" }, ip: "198.51.100.30" };
  for (const [path, fn] of FORMS) {
    const res = await form(fn, path, OFFICE_PASSWORD, { context: PROD });
    assert.equal(res.status, 503, path);
    assert.equal(res.headers.get("set-cookie"), null, path);
  }
  // a browser already signed in with the office password keeps the tools
  const full = await t.office("/office", { office: true, context: PROD });
  assert.equal(full.status, 200);
  assert.match(full.text, /data-tool="lights"/);
});
