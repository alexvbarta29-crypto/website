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
  assert.match(body, /referralAdminKey/);
});

test("every tab points at a page that exists", () => {
  for (const t of TOOLS) {
    if (t.src === "/lights") assert.ok(existsSync("netlify/functions/lights.mjs"));
    else if (t.src === "/playbook") assert.ok(existsSync("netlify/functions/playbook.mjs"));
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
