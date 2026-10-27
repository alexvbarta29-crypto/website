// /playbook — the password-protected office follow-up playbook.
import { test } from "node:test";
import assert from "node:assert/strict";

process.env.OFFICE_PASSWORD = "test-password";
const playbook = (await import("../netlify/functions/playbook.mjs")).default;

const get = (cookie) => playbook(new Request("https://x.test/playbook", { headers: cookie ? { cookie } : {} }));
const post = (password) => playbook(new Request("https://x.test/playbook", {
  method: "POST",
  headers: { "content-type": "application/x-www-form-urlencoded" },
  body: new URLSearchParams({ username: "Barta", password }),
}));
const cookieOf = (res) => res.headers.get("set-cookie").split(";")[0];

test("signed-out visit goes to the one office sign-in, not the scripts", async () => {
  const res = await get();
  const body = await res.text();
  assert.equal(res.status, 200);
  assert.match(body, /\/office#followups/);
  assert.doesNotMatch(body, /autocomplete="current-password"/);
  assert.doesNotMatch(body, /phone tag/);
  assert.equal(res.headers.get("x-robots-tag"), "noindex, nofollow");
});

test("wrong password is refused and sets no cookie", async () => {
  const res = await post("nope");
  assert.equal(res.status, 401);
  assert.equal(res.headers.get("set-cookie"), null);
});

test("right password remembers the device for a year and opens the playbook", async () => {
  const res = await post("test-password");
  assert.equal(res.status, 303);
  assert.equal(res.headers.get("location"), "/playbook");
  const sc = res.headers.get("set-cookie");
  assert.match(sc, /Max-Age=31536000/);
  assert.match(sc, /HttpOnly/);
  assert.match(sc, /Path=\/;/);
  const page = await get(cookieOf(res));
  assert.equal(page.status, 200);
  const body = await page.text();
  assert.match(body, /phone tag/);
  assert.match(body, /\/api\/review-stats/);
});

test("a forged cookie does not get in", async () => {
  const res = await get("barta_office=" + "0".repeat(64));
  assert.doesNotMatch(await res.text(), /phone tag/);
});
