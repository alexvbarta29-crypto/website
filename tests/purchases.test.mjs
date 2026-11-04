// Barta Office → Purchases: ask to buy, everyone votes, Dad decides, then
// ordered (tracking) and delivered. The store is in memory.
import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { createMemoryStore } from "./helpers/referral-harness.mjs";

process.env.OFFICE_PASSWORD = "test-password";
const { derive } = await import("../netlify/lib/lights-auth.mjs");
const api = (await import("../netlify/functions/purchases-api.mjs")).default;
const page = (await import("../netlify/functions/purchases.mjs")).default;
const cookie = "barta_office=" + derive("test-password");

let store;
beforeEach(() => { store = createMemoryStore(); globalThis.__purchasesStoreOverride = store; });

const post = async (body, c = cookie) => {
  const res = await api(new Request("https://x.test/api/purchases", { method: "POST", headers: { "content-type": "application/json", ...(c ? { cookie: c } : {}) }, body: JSON.stringify(body) }));
  return { status: res.status, body: await res.json() };
};
const list = async () => (await (await api(new Request("https://x.test/api/purchases", { headers: { cookie } }))).json()).items;
const ask = () => post({ action: "create", by: "Alex", title: "C9 warm white bulbs", link: "lightsatwholesale.com/c9", price: "$42.50", qty: 6, why: "Thompson job" });

test("signed out gets nothing, and the page sends you to the office sign-in", async () => {
  const r = await post({ action: "create", by: "Alex", title: "x" }, "");
  assert.equal(r.status, 401);
  assert.equal(store.keys().length, 0);
  assert.match(await (await page(new Request("https://x.test/purchases"))).text(), /\/office#purchases/);
});

test("ask to buy: saved with link, price, qty and the asker's thumbs up, waiting on Dad", async () => {
  const r = await ask();
  assert.equal(r.status, 200);
  const it = r.body.item;
  assert.equal(it.link, "https://lightsatwholesale.com/c9");
  assert.equal(it.price, 42.5);
  assert.equal(it.qty, 6);
  assert.equal(it.status, "requested");
  assert.deepEqual(it.votes, { Alex: "yes" });
  assert.equal((await list()).length, 1);
});

test("Jacob's vote doesn't decide; Dad's does", async () => {
  const { item } = (await ask()).body;
  let r = await post({ id: item.id, by: "Jacob", action: "vote", vote: "yes" });
  assert.equal(r.body.item.status, "requested");
  r = await post({ id: item.id, by: "Dad", action: "vote", vote: "no" });
  assert.equal(r.body.item.status, "denied");
  r = await post({ id: item.id, by: "Dad", action: "vote", vote: "yes" });
  assert.equal(r.body.item.status, "approved");
});

test("can't order before Dad approves; then ordered with tracking, then delivered", async () => {
  const { item } = (await ask()).body;
  let r = await post({ id: item.id, by: "Alex", action: "order", order_no: "A1" });
  assert.equal(r.status, 400);
  await post({ id: item.id, by: "Dad", action: "vote", vote: "yes" });
  r = await post({ id: item.id, by: "Jacob", action: "order", order_no: "112-55", tracking: "https://ups.com/track?n=1Z", paid: "250" });
  assert.equal(r.body.item.status, "ordered");
  assert.equal(r.body.item.ordered_by, "Jacob");
  assert.equal(r.body.item.paid, 250);
  r = await post({ id: item.id, by: "Alex", action: "deliver" });
  assert.equal(r.body.item.status, "delivered");
});

test("notes, edits and delete", async () => {
  const { item } = (await ask()).body;
  let r = await post({ id: item.id, by: "Dad", action: "comment", text: "Get the commercial grade ones" });
  assert.equal(r.body.item.comments[0].by, "Dad");
  r = await post({ id: item.id, by: "Alex", action: "edit", fields: { price: "39.99", qty: "8" } });
  assert.equal(r.body.item.price, 39.99);
  assert.equal(r.body.item.qty, 8);
  r = await post({ id: item.id, by: "Alex", action: "delete" });
  assert.equal(r.body.deleted, item.id);
  assert.equal((await list()).length, 0);
});

test("bad input is refused with a plain message", async () => {
  assert.match((await post({ action: "create", by: "Alex", title: "" })).body.error, /required/);
  assert.match((await post({ action: "create", by: "Nobody", title: "x" })).body.error, /who you are/);
  assert.match((await post({ action: "create", by: "Alex", title: "x", price: "lots" })).body.error, /dollar/);
  assert.match((await post({ action: "create", by: "Alex", title: "x", link: "javascript:alert(1)" })).body.error, /link/);
});
