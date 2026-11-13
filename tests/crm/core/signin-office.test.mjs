// The CRM sign-in is the only way in (the owner, Nov 2026): the office
// cookie comes with an owner's or the office's sign-in (never a tech's),
// signing out clears it, and Forgot password takes the login, the office
// password and a new password (docs/CRM.md "Who signs in how",
// docs/OFFICE.md). Synthetic people only.
import { test, afterEach } from "node:test";
import assert from "node:assert/strict";
import { crmTest, PASSWORD } from "../../helpers/crm-http.mjs";
import { advance, days, minutes } from "../../helpers/crm-clock.mjs";

const lights = await import("../../../netlify/lib/lights-auth.mjs");
const { listEvents, getRecord } = await import("../../../netlify/lib/crm-store.mjs");
const { SESSION_COOKIE } = await import("../../../netlify/lib/crm/core/sessions.mjs");
const { LOGIN_FREE_FAILS } = await import("../../../netlify/lib/crm/core/throttle.mjs");
const purchases = (await import("../../../netlify/functions/purchases.mjs")).default;
const lightsPage = (await import("../../../netlify/functions/lights.mjs")).default;

let t;
afterEach(() => { if (t) t.done(); t = null; });

const NEW_PW = "a brand new sentence here";
const OFFICE = () => process.env.OFFICE_PASSWORD;
const isCrmIssued = (c) => /^barta_office=c1\.us_[0-9a-z]{20}\.\d+\.[A-Za-z0-9_-]{43}$/.test(c || "");
const req = (cookie) => new Request("https://www.bartawindowwashing.com/x", { headers: cookie ? { cookie } : {} });
// What a tool page says to this cookie: the page itself, or the bounce to /office.
const toolOpens = async (fn, path, cookie) => !/Sign in to Barta Office/.test(await (await fn(new Request("https://www.bartawindowwashing.com" + path, { headers: cookie ? { cookie } : {} }))).text());
const cleared = (res, t) => t.setCookies(res).some((c) => /^barta_office=; Path=\/; Max-Age=0;/.test(c));

test("an owner's and an admin's sign-in sets the office cookie every tool page accepts; a tech's never does", async () => {
  t = await crmTest();
  const owner = await t.user("owner", { login: "olive" });
  const admin = await t.user("admin", { login: "ada" });
  await t.user("tech", { login: "theo" });
  await t.bootstrap(owner);
  for (const login of ["olive", "ada"]) {
    const r = await t.auth("/auth/login", { body: { login, password: PASSWORD } });
    assert.equal(r.status, 200, login);
    assert.equal(r.body.data.office_cookie, true, login);
    const c = t.cookieFrom(r, "barta_office");
    assert.ok(isCrmIssued(c), `${login}: ${c}`);
    assert.match(t.setCookies(r).find((x) => x.startsWith("barta_office=")), /; Path=\/; Max-Age=31536000; HttpOnly; Secure; SameSite=Lax$/, "the same cookie as the office password's, a year");
    assert.equal(lights.signedIn(req(c)), true);
    assert.equal(lights.officeCookieKind(req(c)), "crm");
    assert.equal(await toolOpens(purchases, "/purchases", c), true, "Purchases opens");
    assert.equal(await toolOpens(lightsPage, "/lights", c), true, "Light Studio opens");
    // the CRM shell's office:tools follows it
    const shell = await t.page("/crm", { cookie: [t.cookieFrom(r, SESSION_COOKIE), c].join("; ") });
    assert.match(shell.text, /"office":true/, login);
  }
  assert.ok(admin);
  // a tech: no office cookie; one already in this browser is cleared
  let r = await t.auth("/auth/login", { body: { login: "theo", password: PASSWORD } });
  assert.equal(r.status, 200);
  assert.equal(r.body.data.office_cookie, false);
  assert.equal(t.cookieFrom(r, "barta_office"), null);
  r = await t.auth("/auth/login", { body: { login: "theo", password: PASSWORD, office_password: OFFICE() }, office: true });
  assert.equal(r.body.data.office_cookie, false, "the old optional office password opens nothing for a tech");
  assert.ok(cleared(r, t), "a tech's sign-in clears an office cookie on that browser");
  // a tech holding the office password's cookie anyway: office:tools stays off
  const shell = await t.page("/crm", { cookie: t.cookieFrom(r, SESSION_COOKIE), office: true });
  assert.match(shell.text, /"office":false/);
  // nothing about the office password or its token is stored
  const all = [...t.stores.data.snapshot()].map(([k, v]) => k + " " + new TextDecoder().decode(v.bytes)).join("\n");
  assert.ok(!all.includes(lights.derive(OFFICE())));
  assert.ok(!all.includes("c1.us_"), "no issued office cookie is stored");
});

test("the CRM-issued office cookie: forged, stale, another password's or tampered is refused", async () => {
  t = await crmTest();
  const owner = await t.user("owner");
  const v = lights.crmOfficeToken(owner.id);
  assert.equal(lights.signedIn(req("barta_office=" + v)), true);
  assert.equal(lights.crmOfficeUser(req("barta_office=" + v)), owner.id);
  // another user's id under this mac, a changed time, a made-up mac
  const [, , issued, mac] = v.split(".");
  assert.equal(lights.signedIn(req(`barta_office=c1.us_0000000000000000000a.${issued}.${mac}`)), false);
  assert.equal(lights.signedIn(req(`barta_office=c1.${owner.id}.${Number(issued) + 1}.${mac}`)), false);
  assert.equal(lights.signedIn(req(`barta_office=c1.${owner.id}.${issued}.${"A".repeat(43)}`)), false);
  assert.equal(lights.signedIn(req("barta_office=c1.garbage")), false);
  // good for 30 days from issue; /office issues a fresh one on each visit
  advance(days(29));
  assert.equal(lights.signedIn(req("barta_office=" + v)), true);
  advance(days(1) + minutes(1));
  assert.equal(lights.signedIn(req("barta_office=" + v)), false, "past 30 days");
  // changing the office password signs these out too
  const fresh = lights.crmOfficeToken(owner.id);
  assert.equal(lights.signedIn(req("barta_office=" + fresh)), true);
  const saved = process.env.OFFICE_PASSWORD;
  process.env.OFFICE_PASSWORD = "another office password";
  try { assert.equal(lights.signedIn(req("barta_office=" + fresh)), false); } finally { process.env.OFFICE_PASSWORD = saved; }
  assert.equal(lights.signedIn(req("barta_office=" + fresh)), true);
});

test("signing out (this phone or everywhere) clears the office cookie", async () => {
  t = await crmTest();
  const owner = await t.user("owner");
  const r = await t.auth("/auth/login", { body: { login: owner.login, password: PASSWORD } });
  const both = [t.cookieFrom(r, SESSION_COOKIE), t.cookieFrom(r, "barta_office")].join("; ");
  const out = await t.auth("/auth/logout", { cookie: both, body: {} });
  assert.equal(out.status, 200);
  assert.ok(cleared(out, t));
  assert.match(t.setCookies(out).join(";"), /barta_crm=; Path=\/; Max-Age=0/);
  const r2 = await t.auth("/auth/login", { body: { login: owner.login, password: PASSWORD } });
  const all = await t.auth("/auth/logout-all", { cookie: t.cookieFrom(r2, SESSION_COOKIE), body: {} });
  assert.equal(all.status, 200);
  assert.ok(cleared(all, t));
});

test("/office: the office cookie alone shows Team sign-in (no tab row); a CRM session renews the cookie for owners and clears a tech's", async () => {
  t = await crmTest();
  const owner = await t.user("owner");
  const tech = await t.user("tech");
  await t.bootstrap(owner);
  // the office password's cookie alone, once the CRM has an owner: Team sign-in
  let r = await t.office("/office", { office: true });
  assert.equal(r.status, 200);
  assert.match(r.text, /const TEAM = true;/);
  assert.match(r.text, /id="t-login"/);
  assert.doesNotMatch(r.text, /data-tool=|class="bar"|<body class="solo">/, "no tab row, no office");
  assert.equal(r.headers.get("set-cookie"), null, "the password's cookie is left alone");
  // a CRM-issued cookie whose session is gone: Team sign-in, and the cookie is cleared
  const issued = "barta_office=" + lights.crmOfficeToken(owner.id);
  r = await t.office("/office", { cookie: issued });
  assert.match(r.text, /const TEAM = true;/);
  assert.match(r.headers.get("set-cookie") || "", /^barta_office=; Path=\/; Max-Age=0;/);
  // an owner with a CRM session: the CRM full screen, a fresh office cookie, the tools inside
  r = await t.office("/office", { as: owner });
  assert.match(r.text, /<body class="solo">/);
  assert.doesNotMatch(r.text, /class="bar"/);
  assert.ok(isCrmIssued((r.headers.get("set-cookie") || "").split(";")[0]), "issued on the visit");
  assert.match(r.text, /"lights":"\/tools\/lights"/);
  // a tech with an office cookie (any kind): the CRM, and the cookie is cleared
  for (const opts of [{ office: true }, { cookie: issued }]) {
    r = await t.office("/office", { as: tech, ...opts });
    assert.match(r.text, /<body class="solo">/);
    assert.match(r.headers.get("set-cookie") || "", /^barta_office=; Path=\/; Max-Age=0;/);
    assert.match(r.text, /const IN_CRM = \{\};/);
  }
});

test("Forgot password: the right office password sets the new password, signs out the other phones, signs in here, tells the other owners and is audited", async () => {
  t = await crmTest();
  const alex = await t.user("owner", { login: "alex", name: "Alex Example" });
  const jacob = await t.user("owner", { login: "jacob", name: "Jacob Example" });
  const tech = await t.user("tech", { login: "gus" });
  await t.bootstrap(alex);
  const device = t.device();
  const r = await t.auth("/auth/forgot", { cookie: device, body: { login: "Alex", office_password: OFFICE(), password: NEW_PW, again: NEW_PW, to: "/office#crm/today" } });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body.data.user.id, alex.id);
  assert.equal(r.body.data.to, "/office#crm/today");
  assert.equal(r.body.data.office_cookie, true);
  const here = t.cookieFrom(r, SESSION_COOKIE);
  assert.ok(here, "signed in here");
  assert.ok(isCrmIssued(t.cookieFrom(r, "barta_office")), "an owner gets the office tools too");
  advance(6000);
  assert.equal((await t.api("/me", { cookie: here })).status, 200);
  assert.equal((await t.api("/me", { as: alex })).status, 401, "the other phones are signed out");
  assert.equal((await t.api("/me", { as: jacob })).status, 200, "nobody else is");
  // the new password works, the old one doesn't
  assert.equal((await t.auth("/auth/login", { body: { login: "alex", password: PASSWORD } })).status, 401);
  assert.equal((await t.auth("/auth/login", { body: { login: "alex", password: NEW_PW } })).status, 200);
  // audited
  const events = await listEvents("user", alex.id);
  assert.ok(events.some((e) => e.action === "password_reset_office"), events.map((e) => e.action).join(","));
  // the other owners hear it in the bell; Alex and the tech don't
  await t.runWorker({ lane: "fast" });
  const bell = await t.api("/notifications", { as: jacob });
  assert.equal(bell.body.data.length, 1);
  assert.equal(bell.body.data[0].title, "Alex reset their password with the office password");
  assert.equal(bell.body.data[0].link, `/team/${alex.id}`);
  assert.equal((await t.api("/notifications", { cookie: here })).body.data.length, 0);
  assert.equal((await t.api("/notifications", { as: tech })).body.data.length, 0);
  // with a reset link out (the password cleared until it's used): Forgot password still works, and uses the link up
  const link = await t.api(`/users/${alex.id}/reset`, { method: "POST", as: jacob, body: {} });
  assert.equal(link.status, 200, JSON.stringify(link.body));
  const again = await t.auth("/auth/forgot", { body: { login: "alex", office_password: OFFICE(), password: NEW_PW + " two", again: NEW_PW + " two" } });
  assert.equal(again.status, 200, JSON.stringify(again.body));
  assert.equal((await getRecord("user", alex.id)).data.invite, undefined, "the reset link is used up");
  // nothing typed is stored
  const all = [...t.stores.data.snapshot()].map(([k, v]) => k + " " + new TextDecoder().decode(v.bytes)).join("\n");
  assert.ok(!all.includes(NEW_PW) && !all.includes(OFFICE()) && !all.includes(lights.derive(OFFICE())));
});

test("Forgot password: a wrong office password, an unknown login and a turned-off login get the same answer; a tech gets no office cookie", async () => {
  t = await crmTest();
  const owner = await t.user("owner", { login: "olive" });
  await t.user("tech", { login: "theo" });
  await t.user("admin", { login: "offy", status: "disabled" });
  await t.bootstrap(owner);
  const tries = [
    { login: "olive", office_password: "not the office password" },
    { login: "nobody", office_password: OFFICE() },
    { login: "offy", office_password: OFFICE() },
    { login: "nobody", office_password: "not the office password" },
  ];
  const answers = [];
  for (const b of tries) {
    const r = await t.auth("/auth/forgot", { cookie: t.device(), body: { ...b, password: NEW_PW, again: NEW_PW } });
    assert.equal(r.status, 401, JSON.stringify(b));
    assert.equal(t.cookieFrom(r, SESSION_COOKIE), null);
    assert.equal(t.cookieFrom(r, "barta_office"), null);
    answers.push(r.body);
  }
  for (const a of answers) assert.deepEqual(a, answers[0]);
  assert.equal(answers[0].error.message, "That didn't match.");
  // the old password still works for olive
  assert.equal((await t.auth("/auth/login", { body: { login: "olive", password: PASSWORD } })).status, 200);
  // the password rules are the same as everywhere, and the two must match
  let r = await t.auth("/auth/forgot", { body: { login: "olive", office_password: OFFICE(), password: "short", again: "short" } });
  assert.equal(r.status, 400);
  assert.equal(r.body.error.field, "password");
  r = await t.auth("/auth/forgot", { body: { login: "olive", office_password: OFFICE(), password: NEW_PW, again: NEW_PW + "x" } });
  assert.equal(r.status, 400);
  assert.equal(r.body.error.field, "again");
  r = await t.auth("/auth/forgot", { body: { login: "olive", office_password: "", password: NEW_PW } });
  assert.equal(r.status, 400);
  assert.equal(r.body.error.field, "office_password");
  // a tech who knows the office password: a new password and a CRM sign-in, never the office tools
  r = await t.auth("/auth/forgot", { body: { login: "theo", office_password: OFFICE(), password: NEW_PW, again: NEW_PW } });
  assert.equal(r.status, 200);
  assert.equal(r.body.data.office_cookie, false);
  assert.equal(t.cookieFrom(r, "barta_office"), null);
  assert.ok(t.cookieFrom(r, SESSION_COOKIE));
  // CSRF: the header is required like every sign-in route
  r = await t.auth("/auth/forgot", { csrf: false, body: { login: "olive", office_password: OFFICE(), password: NEW_PW, again: NEW_PW } });
  assert.equal(r.status, 403);
});

test("Forgot password is throttled like sign-in: per login and phone, then per address", async () => {
  t = await crmTest();
  const owner = await t.user("owner", { login: "olive" });
  await t.bootstrap(owner);
  const device = t.device();
  const wrong = { login: "olive", office_password: "a wrong guess", password: NEW_PW, again: NEW_PW };
  for (let i = 0; i < LOGIN_FREE_FAILS; i++) assert.equal((await t.auth("/auth/forgot", { cookie: device, body: wrong })).status, 401, "try " + (i + 1));
  // the next try waits, even with the right office password, and says how long
  let r = await t.auth("/auth/forgot", { cookie: device, body: { ...wrong, office_password: OFFICE() } });
  assert.equal(r.status, 429);
  assert.ok(Number(r.headers.get("retry-after")) > 0);
  assert.equal(t.cookieFrom(r, SESSION_COOKIE), null);
  // and it shares sign-in's bucket: a sign-in from that phone waits too
  r = await t.auth("/auth/login", { cookie: device, body: { login: "olive", password: PASSWORD } });
  assert.equal(r.status, 429);
  advance(minutes(1));
  r = await t.auth("/auth/forgot", { cookie: device, body: { ...wrong, office_password: OFFICE() } });
  assert.equal(r.status, 200, "after the wait, the right office password works");
});

test("the office password's own form on /office is throttled like sign-in (it is also the key to Forgot password)", async () => {
  t = await crmTest();
  const device = t.device();
  const post = (password) => t.office("/office", { method: "POST", cookie: device, headers: { "content-type": "application/x-www-form-urlencoded" }, raw: "password=" + encodeURIComponent(password) });
  for (let i = 0; i < LOGIN_FREE_FAILS; i++) assert.equal((await post("a wrong guess")).status, 401, "try " + (i + 1));
  let r = await post(OFFICE());
  assert.equal(r.status, 429, "the next try waits, even with the right password");
  assert.ok(Number(r.headers.get("retry-after")) > 0);
  assert.equal(r.headers.get("set-cookie"), null);
  assert.match(r.text, /Too many tries\. Wait \d+ seconds, then try again\./);
  advance(minutes(1));
  r = await post(OFFICE());
  assert.equal(r.status, 303);
  assert.match(r.headers.get("set-cookie"), /^barta_office=[0-9a-f]{64};/);
});
