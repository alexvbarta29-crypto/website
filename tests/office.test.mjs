// /office — one page with tabs for the office tools.
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync } from "node:fs";

process.env.OFFICE_PASSWORD = "test-password";
const office = (await import("../netlify/functions/office.mjs")).default;
const { derive } = await import("../netlify/lib/lights-auth.mjs");
const signedIn = { cookie: "barta_office=" + derive("test-password") };
const { TOOLS } = await import("../netlify/lib/office-page.mjs");

test("office page lists every tool and is never indexed", async () => {
  const res = await office(new Request("https://x.test/office", { headers: signedIn }));
  assert.equal(res.status, 200);
  assert.equal(res.headers.get("x-robots-tag"), "noindex, nofollow");
  const body = await res.text();
  for (const t of TOOLS) assert.match(body, new RegExp(`data-tool="${t.id}"`));
  assert.match(body, /Christmas Lights/);
  assert.match(body, /Follow-ups/);
  assert.match(body, /gwa-key/);
  assert.doesNotMatch(body, /data-tool="referrals"/);
});

test("every tab points at a page that exists", () => {
  for (const t of TOOLS) {
    if (t.src === "/dashboard") assert.ok(existsSync("netlify/functions/dashboard.mjs"));
    else if (t.src === "/lights") assert.ok(existsSync("netlify/functions/lights.mjs"));
    else if (t.src === "/playbook") assert.ok(existsSync("netlify/functions/playbook.mjs"));
    else if (t.src === "/purchases") assert.ok(existsSync("netlify/functions/purchases.mjs"));
    else assert.ok(existsSync("." + t.src), t.src);
  }
});

test("signed out, /office shows the sign-in page, not the tools", async () => {
  const body = await (await office(new Request("https://x.test/office"))).text();
  assert.match(body, /autocomplete="current-password"/);
  assert.doesNotMatch(body, /data-tool=/);
});

test("one office sign-in opens the lights tool and the playbook too", async () => {
  const res = await office(new Request("https://x.test/office", {
    method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: "password=test-password",
  }));
  assert.equal(res.status, 303);
  const sc = res.headers.get("set-cookie");
  assert.match(sc, /Path=\//);
  const cookie = sc.split(";")[0];
  const lights = (await import("../netlify/functions/lights.mjs")).default;
  const playbook = (await import("../netlify/functions/playbook.mjs")).default;
  assert.match(await (await lights(new Request("https://x.test/lights", { headers: { cookie } }))).text(), /Paste or drop the house photos/);
  assert.doesNotMatch(await (await playbook(new Request("https://x.test/playbook", { headers: { cookie } }))).text(), /autocomplete="current-password"/);
});

test("wrong office password is refused", async () => {
  const res = await office(new Request("https://x.test/office", {
    method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: "password=nope",
  }));
  assert.equal(res.status, 401);
  assert.equal(res.headers.get("set-cookie"), null);
});

test("the office installs as a phone app", async () => {
  const { readFileSync } = await import("node:fs");
  const signedInBody = await (await office(new Request("https://x.test/office", { headers: signedIn }))).text();
  const signedOutBody = await (await office(new Request("https://x.test/office"))).text();
  for (const body of [signedInBody, signedOutBody]) {
    assert.match(body, /<link rel="manifest" href="\/office.webmanifest">/);
    assert.match(body, /<link rel="apple-touch-icon" href="\/assets\/img\/app\/office-icon-180\.v1\.png">/);
    assert.match(body, /apple-mobile-web-app-capable/);
  }
  assert.match(signedInBody, /serviceWorker\.register\('\/office-sw\.js', \{ scope: '\/office' \}\)/);

  const m = JSON.parse(readFileSync("office.webmanifest", "utf8"));
  assert.equal(m.start_url, "/office");
  assert.equal(m.scope, "/office");
  assert.equal(m.display, "standalone");
  assert.ok(m.icons.some((i) => i.sizes === "512x512" && i.purpose === "maskable"));
  for (const i of m.icons) assert.ok(existsSync("." + i.src), i.src);
  assert.ok(existsSync("assets/img/app/office-icon-180.v1.png"));

  const deploy = readFileSync("build/make_deploy.py", "utf8");
  assert.match(deploy, /"office\.webmanifest"/);
  assert.match(deploy, /"office-sw\.js"/);
  // The service worker never caches signed-in pages.
  const sw = readFileSync("office-sw.js", "utf8");
  assert.doesNotMatch(sw, /cache\.put|c\.put/);
});
