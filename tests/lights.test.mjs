// /lights — the password-protected Barta Light Studio page.
import { test } from "node:test";
import assert from "node:assert/strict";

process.env.OFFICE_PASSWORD = "test-password";
const lights = (await import("../netlify/functions/lights.mjs")).default;

const get = (cookie) => lights(new Request("https://x.test/lights", { headers: cookie ? { cookie } : {} }));
const post = (password) => lights(new Request("https://x.test/lights", {
  method: "POST",
  headers: { "content-type": "application/x-www-form-urlencoded" },
  body: new URLSearchParams({ username: "Barta", password }),
}));
const cookieOf = (res) => res.headers.get("set-cookie").split(";")[0];

test("signed-out visit shows the sign-in page, not the tool", async () => {
  const res = await get();
  const body = await res.text();
  assert.equal(res.status, 200);
  assert.match(body, /autocomplete="current-password"/);
  assert.doesNotMatch(body, /Paste or drop the house photos/);
  assert.equal(res.headers.get("x-robots-tag"), "noindex, nofollow");
});

test("wrong password is refused and sets no cookie", async () => {
  const res = await post("nope");
  assert.equal(res.status, 401);
  assert.equal(res.headers.get("set-cookie"), null);
  assert.match(await res.text(), /isn't right/);
});

test("right password signs in for a year and opens the tool", async () => {
  const res = await post("test-password");
  assert.equal(res.status, 303);
  assert.equal(res.headers.get("location"), "/lights");
  const sc = res.headers.get("set-cookie");
  assert.match(sc, /Max-Age=31536000/);
  assert.match(sc, /HttpOnly/);
  const page = await get(cookieOf(res));
  assert.equal(page.status, 200);
  assert.match(await page.text(), /Paste or drop the house photos/);
});

test("a forged cookie doesn't get in", async () => {
  const res = await get("barta_office=" + "a".repeat(64));
  assert.doesNotMatch(await res.text(), /Paste or drop the house photos/);
});

test("changing OFFICE_PASSWORD swaps the password and signs old devices out", async () => {
  const old = cookieOf(await post("test-password"));
  process.env.OFFICE_PASSWORD = "new-secret";
  try {
    assert.equal((await post("test-password")).status, 401);
    assert.equal((await post("new-secret")).status, 303);
    assert.doesNotMatch(await (await get(old)).text(), /Paste or drop the house photos/);
  } finally {
    process.env.OFFICE_PASSWORD = "test-password";
  }
});

test("with no OFFICE_PASSWORD set, the built-in default still guards the page", async () => {
  delete process.env.OFFICE_PASSWORD;
  try {
    assert.equal((await post("test-password")).status, 401);
    assert.equal((await post("")).status, 401);
    assert.doesNotMatch(await (await get()).text(), /Paste or drop the house photos/);
  } finally {
    process.env.OFFICE_PASSWORD = "test-password";
  }
});

test("the browser maps key is handed only to signed-in browsers", async () => {
  process.env.GOOGLE_MAPS_BROWSER_KEY = "AIza-browser-test";
  try {
    assert.doesNotMatch(await (await get()).text(), /AIza-browser-test/);
    const res = await post("test-password");
    const page = await (await get(cookieOf(res))).text();
    assert.match(page, /window\.BLS_MAPS_KEY="AIza-browser-test"/);
  } finally {
    delete process.env.GOOGLE_MAPS_BROWSER_KEY;
  }
});
