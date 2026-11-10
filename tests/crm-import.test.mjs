// /api/crm/import — loading the sealed Rotor export into the "crm" store
// (a Map here), and the rule behind it: customer data never sits in the
// repo. Fixture people are made up (555 numbers, example.com).
import { test, beforeEach, mock } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, existsSync, mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, symlinkSync, linkSync, statSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { spawnSync } from "node:child_process";
import os from "node:os";
import path from "node:path";
import { createMemoryStore, failingStore, hangingStore } from "./helpers/referral-harness.mjs";

process.env.OFFICE_PASSWORD = "test-password";
const { seal, open, newKeyPair, privateKey } = await import("../netlify/lib/office-data.mjs");
const mod = await import("../netlify/functions/crm-import.mjs");
const api = mod.default;
const { MAX_BODY, MAX_PLAINTEXT, MAX_PAGE_BYTES, IMPORT_BUDGET_MS, SHRINK_RATIO, MESSAGES, isSealedBox, readBodyText, needsConfirm, previewContext } = mod;
const { KEYS, TIMEOUT_MS } = await import("../netlify/lib/crm-store.mjs");
const { normalizeBundle, normalizeCustomer, isExportDate, LIMITS, ID_RE } = await import("../netlify/lib/crm-data.mjs");
const { derive, readCookie } = await import("../netlify/lib/lights-auth.mjs");
const crm = (await import("../netlify/functions/crm.mjs")).default;
const { insideRepo, realTarget, writeOutside, ROOT } = await import("../build/crm_seal_import.mjs");
const cookie = "barta_office=" + derive("test-password");
const keys = newKeyPair();

const addr = (street1, city, state, zip) => ({ street1, street2: null, city, state, zip, country: "US" });
const FIX = {
  v: 1,
  exported_at: "2026-11-08",
  members: [{ user_id: "m1", name: "Alex Barta", first_name: "Alex", last_name: "Barta", email: "alex@example.com", role: "owner" }, { user_id: "m2", name: "Jacob Barta", first_name: "Jacob", last_name: "Barta", email: "jacob@example.com", role: "owner" }],
  customers: [
    { id: "0b1c2d3e-0000-4000-8000-000000000001", first_name: "Pat", last_name: "Zimmer", company_name: "", email: "pat@example.com", phone: "+15550100123", status: "active", source: "Referral", assigned_to: ["m1"], address: addr("100 Example Ave", "Delano", "MN", "55328"), tags: ["Website"], notes: "Gate code 4321", created_at: "2025-03-14T15:00:00+00:00" },
    { id: "0b1c2d3e-0000-4000-8000-000000000002", first_name: "Sam", last_name: "Ames", company_name: "Ames Dental", email: "", phone: "", status: "inactive", source: "Website quote form", assigned_to: [], address: addr(null, null, null, null), tags: [], notes: "", created_at: "2026-07-29T19:12:48+00:00" },
    { id: "0b1c2d3e-0000-4000-8000-000000000003", first_name: "Ana", last_name: "Ávila", company_name: "", email: "ana@example.com", phone: "+15550100155", status: "active", source: "Facebook", assigned_to: ["m2"], address: addr("9 Birch Ln", "Waconia", "MN", "55387"), tags: [], notes: "", created_at: "2026-09-02T12:00:00+00:00" },
  ],
};
const BOX = seal(FIX, keys.publicKeyPem);
const uuid = (n) => `0b1c2d3e-0000-4000-8000-${String(n).padStart(12, "0")}`;
const MEMBERS = [{ user_id: "m1", name: "Alex Barta" }, { user_id: "m2", name: "Jacob Barta" }];
const URL_ = "https://x.test/api/crm/import";

let store;
beforeEach(() => { store = createMemoryStore(); globalThis.__crmStoreOverride = store; });
const quietly = async (fn) => { const e = mock.method(console, "error", () => {}); const l = mock.method(console, "log", () => {}); try { return await fn(); } finally { e.mock.restore(); l.mock.restore(); } };
const withKey = async (key, fn) => {
  const saved = process.env.OFFICE_DATA_KEY;
  if (key === undefined) delete process.env.OFFICE_DATA_KEY; else process.env.OFFICE_DATA_KEY = key;
  try { return await quietly(fn); } finally { if (saved === undefined) delete process.env.OFFICE_DATA_KEY; else process.env.OFFICE_DATA_KEY = saved; }
};
const call = async (method, body, { c = cookie, type = "application/json", headers = {} } = {}) => {
  const res = await api(new Request(URL_, { method, headers: { ...(type ? { "content-type": type } : {}), ...(c ? { cookie: c } : {}), ...headers }, body }));
  return { status: res.status, headers: res.headers, body: await res.json().catch(() => null) };
};
const post = (box, opts = {}) => call("POST", typeof box === "string" ? box : JSON.stringify(box), opts);
const postTo = (url, box, opts = {}) => api(new Request(url, { method: "POST", headers: { "content-type": "application/json", cookie, ...(opts.headers || {}) }, body: JSON.stringify(box) }), opts.context).then(async (res) => ({ status: res.status, body: await res.json().catch(() => null) }));
const sealed = (bundle) => seal(bundle, keys.publicKeyPem);
const get = (opts) => call("GET", undefined, { type: null, ...opts });

test("signed out, GET and POST answer 401 and the store stays empty", async () => {
  await withKey(keys.privateKey, async () => {
    const g = await get({ c: "" });
    assert.equal(g.status, 401);
    assert.deepEqual(g.body, { ok: false, error: "signed_out" });
    const p = await post(BOX, { c: "" });
    assert.equal(p.status, 401);
    assert.deepEqual(p.body, { ok: false, error: "signed_out" });
    assert.equal(store.keys().length, 0);
    const bad = await post(BOX, { c: "barta_office=" + derive("wrong-password") });
    assert.equal(bad.status, 401);
    assert.equal(store.keys().length, 0);
  });
});

test("without OFFICE_DATA_KEY the site cannot open the file: 503 no-key, and nothing is written", async () => {
  await withKey(undefined, async () => {
    const r = await post(BOX);
    assert.equal(r.status, 503);
    assert.equal(r.body.error, "no-key");
    assert.equal(r.body.message, "The site has no OFFICE_DATA_KEY yet");
    assert.equal(store.keys().length, 0);
  });
  await withKey("x".repeat(3312), async () => {
    const r = await post(BOX);
    assert.equal(r.status, 503);
    assert.equal(r.body.error, "bad-env-key");
    assert.equal(store.keys().length, 0);
  });
});

test("a file sealed for a different key: 400 bad-key", async () => {
  await withKey(newKeyPair().privateKey, async () => {
    const r = await post(BOX);
    assert.equal(r.status, 400);
    assert.equal(r.body.error, "bad-key");
    assert.equal(r.body.message, MESSAGES["bad-key"]);
    assert.equal(store.keys().length, 0);
  });
  // A box that was tampered with doesn't open either.
  await withKey(keys.privateKey, async () => {
    const r = await post({ ...BOX, tag: Buffer.from("0".repeat(16)).toString("base64") });
    assert.equal(r.status, 400);
    assert.equal(r.body.error, "bad-key");
    // Nor does one whose GCM tag was cut short (Node would check only the bytes given),
    // or whose nonce or key is the wrong size.
    const b64 = (s) => Buffer.from(s, "base64");
    const cut = (k, n) => ({ ...BOX, [k]: b64(BOX[k]).subarray(0, n).toString("base64") });
    for (const box of [cut("tag", 4), cut("tag", 12), cut("iv", 8), cut("epk", 31), { ...BOX, iv: Buffer.concat([b64(BOX.iv), Buffer.alloc(4)]).toString("base64") }]) {
      const t = await post(box);
      assert.equal(t.status, 400);
      assert.equal(t.body.error, "bad-key");
      assert.throws(() => open(box, privateKey({ OFFICE_DATA_KEY: keys.privateKey })), /malformed snapshot/, "refused on size, before any crypto");
    }
    assert.equal(store.keys().length, 0);
  });
});

test("a good file: 200 with counts; one index blob lands in the store, with no emails and nothing per customer", async () => {
  await withKey(keys.privateKey, async () => {
    const before = await get();
    assert.equal(before.status, 200);
    assert.deepEqual(before.body, { ok: true, imported_at: null });
    const r = await post(BOX);
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(r.headers.get("cache-control"), "private, no-store");
    assert.equal(r.headers.get("x-robots-tag"), "noindex, nofollow");
    assert.equal(r.body.ok, true);
    assert.deepEqual(r.body.counts, { customers: 3, members: 2 });
    assert.equal(r.body.exported_at, "2026-11-08");
    assert.ok(!Number.isNaN(Date.parse(r.body.imported_at)), "imported_at is a timestamp");
    assert.deepEqual(store.keys(), [KEYS.customers], "an import is one write: no customer/{id} copies, no meta record");
    const idx = store.json(KEYS.customers);
    assert.equal(idx.v, 1);
    assert.equal(idx.count, 3);
    assert.equal(idx.imported_at, r.body.imported_at);
    assert.deepEqual(idx.customers, FIX.customers);
    assert.deepEqual(idx.members, MEMBERS);
    assert.doesNotMatch(JSON.stringify(idx.members), /@|role|first_name/);
    const after = await get();
    assert.equal(after.status, 200);
    assert.deepEqual(after.body, { ok: true, imported_at: r.body.imported_at, exported_at: "2026-11-08", counts: { customers: 3, members: 2 } }, "GET reads the summary from the index itself");
    assert.equal(after.headers.get("cache-control"), "private, no-store");
    // The same file again (a retry after a timeout) goes straight through.
    const again = await post(BOX);
    assert.equal(again.status, 200);
  });
});

test("a re-import that drops customers asks first, then leaves no trace of them in the store", async () => {
  await withKey(keys.privateKey, async () => {
    assert.equal((await post(BOX)).status, 200);
    const smaller = sealed({ ...FIX, customers: FIX.customers.slice(0, 1), exported_at: "2026-11-09" });
    const asked = await post(smaller);
    assert.equal(asked.status, 409);
    assert.equal(asked.body.error, "confirm");
    assert.deepEqual(asked.body.current, { count: 3, exported_at: "2026-11-08" });
    assert.deepEqual(asked.body.incoming, { count: 1, exported_at: "2026-11-09" });
    assert.equal(asked.body.message, "This file has 1 customer (export of Nov 9, 2026). The list has 3 customers (export of Nov 8, 2026). Replace it anyway?");
    assert.equal(store.json(KEYS.customers).count, 3, "nothing changed yet");
    const yes = await postTo(URL_ + "?confirm=1", smaller);
    assert.equal(yes.status, 200, JSON.stringify(yes.body));
    assert.deepEqual(yes.body.counts, { customers: 1, members: 2 });
    assert.deepEqual(store.keys(), [KEYS.customers]);
    const raw = [...store.map.values()].join("\n");
    for (const gone of FIX.customers.slice(1)) {
      assert.ok(!raw.includes(gone.id), "the dropped customer's id is gone");
      if (gone.email) assert.ok(!raw.includes(gone.email), "and so is their email");
    }
    // An older export asks too, even when it is just as long.
    const older = await post(sealed({ ...FIX, customers: FIX.customers.slice(0, 1), exported_at: "2026-10-01" }));
    assert.equal(older.status, 409);
    assert.equal(older.body.error, "confirm");
  });
  // The rule itself: more than 1% shorter, or older.
  assert.equal(SHRINK_RATIO, 0.99);
  assert.equal(needsConfirm(null, { count: 1, exported_at: "2026-11-08" }), false, "a first import never asks");
  assert.equal(needsConfirm({ count: 1000, exported_at: "2026-11-08" }, { count: 975, exported_at: "2026-11-08" }), true, "a pass of Rotor's list that came back short");
  assert.equal(needsConfirm({ count: 1000, exported_at: "2026-11-08" }, { count: 991, exported_at: "2026-11-09" }), false, "a few deleted customers");
  assert.equal(needsConfirm({ count: 1000, exported_at: "2026-11-08" }, { count: 1020, exported_at: "2026-11-09" }), false);
  assert.equal(needsConfirm({ count: 1000, exported_at: "2026-11-08" }, { count: 1020, exported_at: "2026-11-01" }), true);
  assert.equal(needsConfirm({ count: 0, exported_at: "" }, { count: 5, exported_at: "2026-11-01" }), false);
});

test("a sealed bundle that isn't a customer export: 400 bad-bundle, nothing written", async () => {
  await withKey(keys.privateKey, async () => {
    const ok = (over = {}) => ({ ...FIX.customers[0], ...over });
    const cases = [
      { v: 1, exported_at: "2026-11-08", members: [] },                                         // no customers
      { v: 1, exported_at: "2026-11-08", customers: [{ id: 42 }], members: [] },                // ids must be strings
      { v: 1, exported_at: "2026-11-08", customers: [{ id: "a/b" }], members: [] },             // and UUIDs, never a path
      { v: 1, exported_at: "2026-11-08", customers: [{ id: "." }], members: [] },               // or a dot segment, which the
      { v: 1, exported_at: "2026-11-08", customers: [{ id: ".." }], members: [] },              // Blobs client would resolve
      { v: 1, exported_at: "2026-11-08", customers: [{ id: "..." }], members: [] },             // inside the store's URL
      { v: 1, exported_at: "2026-11-08", customers: [{ id: "c-1" }], members: [] },             // a plain token isn't a Rotor id
      { v: 1, exported_at: "2026-11-08", customers: [ok(), ok()], members: [] },                // and unique
      { v: 1, exported_at: "2026-11-08", customers: [ok(), ok({ id: ok().id.toUpperCase() })], members: [] }, // whatever the case
      { v: 1, exported_at: "2026-11-08", customers: [ok()] },                                   // members missing
      { v: 1, exported_at: "2026-11-08", customers: [ok()], members: [{ user_id: "../x" }] },   // a member id is a token
      { v: 1, exported_at: "yesterday", customers: [ok()], members: [] },                       // bad date
      { v: 1, exported_at: "2026-99-99", customers: [ok()], members: [] },                      // not a calendar day
      { v: 1, exported_at: "2026-02-30", customers: [ok()], members: [] },
      { v: 1, exported_at: "2099-01-01", customers: [ok()], members: [] },                      // from the future
      { v: 2, exported_at: "2026-11-08", customers: [ok()], members: [] },                      // wrong version
      { v: 1, exported_at: "2026-11-08", customers: [ok({ phone: 5550100123 })], members: [] }, // strings only
      { v: 1, exported_at: "2026-11-08", customers: [ok({ notes: "n".repeat(LIMITS.notes + 1) })], members: [] }, // within the caps
      { v: 1, exported_at: "2026-11-08", customers: [ok({ first_name: "f".repeat(LIMITS.name + 1) })], members: [] },
      { v: 1, exported_at: "2026-11-08", customers: [ok({ tags: Array(LIMITS.tags + 1).fill("t") })], members: [] },
      { v: 1, exported_at: "2026-11-08", customers: [ok({ address: "1 Elm St" })], members: [] },
      { v: 1, exported_at: "2026-11-08", customers: [ok({ notes: JSON.parse("[".repeat(1000) + "]".repeat(1000)) })], members: [] }, // any shape
      { v: 1, exported_at: "2026-11-08", customers: [null], members: [] },
      { hello: "world" },
      [1, 2, 3],
      "text",
    ];
    for (const bundle of cases) {
      const r = await post(sealed(bundle));
      assert.equal(r.status, 400, JSON.stringify(bundle).slice(0, 120));
      assert.equal(r.body.error, "bad-bundle");
      assert.equal(r.body.message, "That is not a Barta export file");
      assert.equal(normalizeBundle(bundle).ok, false);
    }
    assert.equal(normalizeBundle(FIX).ok, true);
    assert.equal(store.keys().length, 0);
    // The reply says where, never what.
    const where = await post(sealed({ ...FIX, customers: [FIX.customers[0], ok({ id: uuid(9), notes: "secret ".repeat(2000) })] }));
    assert.equal(where.body.field, "customers[1].notes");
    assert.doesNotMatch(JSON.stringify(where.body), /secret/);
    // A row nested 50,000 deep (JSON.parse takes it; JSON.stringify would throw) is refused before anything is stored.
    const deep = JSON.parse(`{"v":1,"exported_at":"2026-11-08","members":[],"customers":[{"id":"${uuid(1)}","notes":${"[".repeat(50000)}${"]".repeat(50000)}}]}`);
    assert.deepEqual(normalizeBundle(deep), { ok: false, error: "bad-bundle", field: "customers[0].notes" });
    // JSON that isn't a sealed box at all (say, the plain export by mistake) is bad-bundle too, and is never stored.
    for (const notABox of [FIX, { v: 1, epk: "a", iv: "b", tag: "c", data: "d" }, { v: 2, epk: "a", iv: "b", tag: "c" }, [], 7, null]) {
      const r = await post(notABox);
      assert.equal(r.status, 400, JSON.stringify(notABox));
      assert.equal(r.body.error, "bad-bundle");
      assert.equal(isSealedBox(notABox), false);
    }
    assert.equal(isSealedBox(BOX), true);
    assert.equal(store.keys().length, 0);
  });
});

test("rows are stored as the 13 fields the page uses, nothing else; ids are Rotor's UUIDs", async () => {
  const row = { ...FIX.customers[0], ssn: "987-65-4321", internal: { score: 7, history: [1, 2, 3] }, address: { ...FIX.customers[0].address, lockbox: "4321" } };
  await withKey(keys.privateKey, async () => {
    const r = await post(sealed({ ...FIX, customers: [row, ...FIX.customers.slice(1)], members: [{ ...FIX.members[0], phone: "5550100999" }, FIX.members[1]] }));
    assert.equal(r.status, 200, JSON.stringify(r.body));
  });
  const idx = store.json(KEYS.customers);
  assert.deepEqual(idx.customers[0], FIX.customers[0]);
  assert.deepEqual(Object.keys(idx.customers[0]), ["id", "first_name", "last_name", "company_name", "email", "phone", "status", "source", "assigned_to", "address", "tags", "notes", "created_at"]);
  assert.doesNotMatch(JSON.stringify(idx), /ssn|987-65|internal|lockbox|5550100999/);
  assert.deepEqual(idx.members, MEMBERS);
  // Missing fields come back as null or [], so the page never sees undefined.
  assert.deepEqual(normalizeCustomer({ id: uuid(5) }), { id: uuid(5), first_name: null, last_name: null, company_name: null, email: null, phone: null, status: null, source: null, assigned_to: [], address: null, tags: [], notes: null, created_at: null });
  for (const id of [uuid(1), "A0B1C2D3-0000-4000-8000-00000000000F"]) assert.ok(ID_RE.test(id), id);
  for (const id of [".", "..", "...", "a/b", "c-1", "", uuid(1) + "x", uuid(1).replace(/-/g, "")]) assert.ok(!ID_RE.test(id), id);
  assert.equal(isExportDate("2026-11-08", new Date("2026-11-08T12:00:00Z")), true);
  assert.equal(isExportDate("2026-11-10", new Date("2026-11-08T12:00:00Z")), true, "two days of clock and time-zone slack");
  assert.equal(isExportDate("2026-11-11", new Date("2026-11-08T12:00:00Z")), false);
  assert.equal(isExportDate("1999-12-31"), false);
});

test("an empty export is refused instead of wiping the list", async () => {
  await withKey(keys.privateKey, async () => {
    assert.equal((await post(BOX)).status, 200);
    const r = await post(sealed({ v: 1, exported_at: "2026-11-09", customers: [], members: [] }));
    assert.equal(r.status, 400);
    assert.equal(r.body.error, "empty");
    assert.equal(r.body.message, "That export has no customers in it");
    assert.equal(store.json(KEYS.customers).count, 3, "the list is untouched");
  });
});

test("too many rows, too big a file or too big a page: 413 before anything is written", async () => {
  await withKey(keys.privateKey, async () => {
    // More rows than the cap (these are tiny, so the file itself is small).
    assert.equal(LIMITS.customers, 5000);
    const many = sealed({ v: 1, exported_at: "2026-11-08", members: [], customers: Array.from({ length: LIMITS.customers + 1 }, (_, i) => ({ id: uuid(i) })) });
    const r = await post(many);
    assert.equal(r.status, 413);
    assert.equal(r.body.error, "too-many");
    assert.match(r.body.message, /5,000 at most/);
    const members = await post(sealed({ ...FIX, members: Array.from({ length: LIMITS.members + 1 }, (_, i) => ({ user_id: "m" + i, name: "M" })) }));
    assert.equal(members.status, 413);
    assert.equal(members.body.error, "too-many");
    // A box whose contents would decrypt to more than MAX_PLAINTEXT is refused before it is opened
    // (this one isn't even a real box: opening it would say bad-key).
    const huge = { ...BOX, data: randomBytes(MAX_PLAINTEXT + 1024).toString("base64") };
    const big = await post(huge);
    assert.equal(big.status, 413);
    assert.equal(big.body.error, "too-big");
    // Under every row cap, but the page it would make is over budget: 200 notes of 10,000 "<"
    // (each one is 6 bytes once escaped for the page's JSON).
    const angry = sealed({ ...FIX, customers: Array.from({ length: 200 }, (_, i) => ({ ...FIX.customers[0], id: uuid(i), notes: "<".repeat(LIMITS.notes) })) });
    assert.ok(Buffer.byteLength(JSON.stringify(angry)) < MAX_BODY);
    const page = await post(angry);
    assert.equal(page.status, 413);
    assert.equal(page.body.error, "too-big");
    assert.equal(store.keys().length, 0);
    assert.ok(MAX_PAGE_BYTES < 6 * 1024 * 1024);
  });
});

test("bad uploads: not JSON → 400, the wrong content type → 415, other methods → 405", async () => {
  await withKey(keys.privateKey, async () => {
    const r = await post("{not json");
    assert.equal(r.status, 400);
    assert.equal(r.body.error, "bad-json");
    const t = await post(BOX, { type: "text/plain" });
    assert.equal(t.status, 415);
    assert.equal(t.body.error, "unsupported-type");
    const none = await post(BOX, { type: null });
    assert.equal(none.status, 415);
    const charset = await post(BOX, { type: "application/json; charset=utf-8" });
    assert.equal(charset.status, 200, "a charset parameter is fine");
    const d = await call("DELETE", undefined, { type: null });
    assert.equal(d.status, 405);
    assert.equal(d.headers.get("allow"), "GET, HEAD, POST");
  });
});

test("a 7 MB body is refused with 413 before it is read", async () => {
  await withKey(keys.privateKey, async () => {
    assert.equal(MAX_BODY, 6 * 1024 * 1024);
    // Declared up front: refused without touching the body.
    const declared = await post(BOX, { headers: { "content-length": String(7 * 1024 * 1024) } });
    assert.equal(declared.status, 413);
    assert.equal(declared.body.error, "too-large");
    // Streamed with no length: the read stops as soon as the cap is passed.
    let pulled = 0;
    const chunk = new Uint8Array(256 * 1024).fill(0x61);
    const total = 28; // 7 MB
    const body = new ReadableStream({ pull(ctrl) { if (pulled++ < total) ctrl.enqueue(chunk); else ctrl.close(); } });
    const res = await api(new Request(URL_, { method: "POST", headers: { "content-type": "application/json", cookie }, body, duplex: "half" }));
    assert.equal(res.status, 413);
    assert.ok(pulled < total, `stopped after ${pulled} of ${total} chunks`);
    assert.equal(store.keys().length, 0);
    // readBodyText itself hands back small bodies whole.
    assert.equal(await readBodyText(new Request(URL_, { method: "POST", body: "hello" })), "hello");
  });
});

test("when storage fails, GET and POST answer 503 store, and nothing is half-written", async () => {
  globalThis.__crmStoreOverride = failingStore();
  await withKey(keys.privateKey, async () => {
    const g = await get();
    assert.equal(g.status, 503);
    assert.equal(g.body.error, "store");
    const p = await post(BOX);
    assert.equal(p.status, 503);
    assert.equal(p.body.error, "store");
    assert.equal(p.body.message, MESSAGES.store);
  });
  // Reads work, the one write fails: the old list stays exactly as it was.
  await withKey(keys.privateKey, async () => assert.equal((await post(BOX)).status, 503));
  globalThis.__crmStoreOverride = store;
  await withKey(keys.privateKey, async () => assert.equal((await post(BOX)).status, 200));
  const before = store.map.get(KEYS.customers);
  globalThis.__crmStoreOverride = { ...store, setJSON: async () => { throw new Error("simulated write failure"); } };
  await withKey(keys.privateKey, async () => {
    const r = await post(sealed({ ...FIX, exported_at: "2026-11-09" }));
    assert.equal(r.status, 503);
  });
  assert.equal(store.map.get(KEYS.customers), before);
  assert.deepEqual(store.keys(), [KEYS.customers]);
});

test("a corrupt saved list is imported over, not a dead end", async () => {
  await store.set(KEYS.customers, "{truncated");
  await withKey(keys.privateKey, async () => {
    const g = await get();
    assert.deepEqual(g.body, { ok: true, imported_at: null });
    const r = await post(BOX);
    assert.equal(r.status, 200);
  });
  assert.equal(store.json(KEYS.customers).count, 3);
});

test("the whole import fits one time budget, even when every Blobs call is slow but under its own timeout", async () => {
  // The read takes 7 s and the write would take 5 s: each is under the 8 s
  // timeout, but together they'd pass the budget, so the write is given
  // what is left (2 s) and the import answers 503 at 9 s.
  const inner = createMemoryStore();
  const calls = { get: 0, set: 0, landed: 0 };
  globalThis.__crmStoreOverride = {
    get: (k, o) => { calls.get++; return new Promise((r) => setTimeout(() => r(inner.get(k, o)), 7000)); },
    setJSON: (k, v) => { calls.set++; return new Promise((r) => setTimeout(() => { calls.landed++; r(inner.setJSON(k, v)); }, 5000)); },
  };
  assert.equal(IMPORT_BUDGET_MS, 9000);
  assert.equal(TIMEOUT_MS, 8000);
  await withKey(keys.privateKey, async () => {
    mock.timers.enable({ apis: ["setTimeout", "Date"], now: Date.parse("2026-11-09T18:00:00Z") });
    try {
      const t0 = Date.now();
      const settle = async (until) => { for (let i = 0; i < 200 && !until(); i++) await new Promise((r) => setImmediate(r)); };
      let done = null;
      const pending = post(BOX).then((r) => { done = r; });
      await settle(() => calls.get === 1);
      mock.timers.tick(7000);
      await settle(() => calls.set === 1);
      assert.equal(done, null);
      mock.timers.tick(1999);
      await settle(() => done);
      assert.equal(done, null, "still inside the budget");
      mock.timers.tick(1);
      await settle(() => done);
      assert.ok(done, "the import answered when the budget ran out");
      await pending;
      assert.equal(done.status, 503);
      assert.equal(done.body.error, "store");
      assert.equal(Date.now() - t0, IMPORT_BUDGET_MS);
      // Blobs can't be told to stop, so the late write may still land; it is
      // one whole export either way, never a mix.
      mock.timers.tick(3000);
      await settle(() => calls.landed === 1);
      assert.equal(JSON.parse(inner.map.get(KEYS.customers)).count, 3);
    } finally {
      mock.timers.reset();
    }
  });
  // A store that never answers: 503 after one timeout, nothing written.
  globalThis.__crmStoreOverride = hangingStore();
  await withKey(keys.privateKey, async () => {
    mock.timers.enable({ apis: ["setTimeout", "Date"], now: Date.parse("2026-11-09T18:00:00Z") });
    try {
      let done = null;
      const pending = post(BOX).then((r) => { done = r; });
      for (let i = 0; i < 50; i++) await new Promise((r) => setImmediate(r));
      mock.timers.tick(TIMEOUT_MS);
      for (let i = 0; i < 50 && !done; i++) await new Promise((r) => setImmediate(r));
      assert.ok(done, "answered after one timeout");
      await pending;
      assert.equal(done.status, 503);
    } finally {
      mock.timers.reset();
    }
  });
});

test("deploy previews and branch deploys can't replace the live list", async () => {
  const saved = { CONTEXT: process.env.CONTEXT, CRM_ALLOW_PREVIEW_WRITES: process.env.CRM_ALLOW_PREVIEW_WRITES };
  const restore = () => { for (const [k, v] of Object.entries(saved)) if (v === undefined) delete process.env[k]; else process.env[k] = v; };
  try {
    await withKey(keys.privateKey, async () => {
      for (const ctx of ["deploy-preview", "branch-deploy"]) {
        process.env.CONTEXT = ctx;
        const r = await post(BOX);
        assert.equal(r.status, 403, ctx);
        assert.equal(r.body.error, "preview");
        assert.equal(r.body.message, "Imports only run on the live site, not on a preview");
      }
      assert.equal(store.keys().length, 0);
      assert.equal((await get()).status, 200, "reading is fine");
      process.env.CRM_ALLOW_PREVIEW_WRITES = "1";
      assert.equal((await post(BOX)).status, 200, "unless the site opts in");
      delete process.env.CRM_ALLOW_PREVIEW_WRITES;
      delete process.env.CONTEXT;
      // The function's own context says the same when the env var isn't there.
      const viaContext = await postTo(URL_, BOX, { context: { deploy: { context: "deploy-preview" } } });
      assert.equal(viaContext.status, 403);
      process.env.CONTEXT = "production";
      assert.equal((await post(BOX)).status, 200);
    });
  } finally {
    restore();
  }
  assert.equal(previewContext({}, null), false, "local runs have no context");
  assert.equal(previewContext({ CONTEXT: "dev" }), false);
  assert.equal(previewContext({}, { deploy: { context: "production" } }), false);
});

test("a malformed office cookie is just signed out (401), never a crash", async () => {
  for (const c of ["barta_office=%E0%A4%A", "barta_office=%", "other=1; barta_office=%zz"]) {
    assert.equal(readCookie(new Request(URL_, { headers: { cookie: c } })), "");
    const g = await get({ c });
    assert.equal(g.status, 401, c);
    assert.deepEqual(g.body, { ok: false, error: "signed_out" });
    assert.equal((await post(BOX, { c })).status, 401);
    const page = await crm(new Request("https://x.test/crm", { headers: { cookie: c } }));
    assert.match(await page.text(), /\/office#customers/);
  }
  assert.equal(readCookie(new Request(URL_, { headers: { cookie: "a=b; barta_office=abc%20d" } })), "abc d", "good values still decode");
});

test("the repo holds no customer data: netlify/data has only the dashboard snapshot, and the seal script refuses to write inside the repo", () => {
  assert.deepEqual(readdirSync("netlify/data"), ["office-dashboard.sealed.mjs"]);
  assert.equal(existsSync("netlify/data/crm-import.sealed.mjs"), false);
  // The guard, with symlinks and not-yet-existing folders in mind.
  assert.equal(insideRepo(path.join(ROOT, "netlify/data/crm-import.sealed.json")), true);
  assert.equal(insideRepo(path.join(ROOT, "x.json")), true);
  assert.equal(insideRepo(path.join(ROOT, "new-folder/deeper/x.json")), true);
  assert.equal(insideRepo("netlify/data/x.json"), true, "relative to the cwd, which is the repo");
  assert.equal(insideRepo(ROOT), true);
  assert.equal(insideRepo(ROOT + "-other/x.json"), false, "a sibling folder with the same prefix is outside");
  assert.equal(insideRepo(path.join(os.tmpdir(), "x.json")), false);
  assert.equal(insideRepo(path.join(path.dirname(ROOT), "x.json")), false);
  // The script itself, as the owner runs it, on a made-up export.
  const tmp = mkdtempSync(path.join(os.tmpdir(), "crm-seal-"));
  try {
    writeFileSync(path.join(tmp, "customers.jsonl"), FIX.customers.map((c) => JSON.stringify(c)).join("\n") + "\n");
    writeFileSync(path.join(tmp, "members.jsonl"), FIX.members.map((m) => JSON.stringify(m)).join("\n") + "\n");
    const run = (...args) => spawnSync(process.execPath, ["build/crm_seal_import.mjs", ...args], { encoding: "utf8", env: { ...process.env, OFFICE_DATA_KEY: "" } });
    const refused = run(tmp, "netlify/data/crm-import.sealed.json", "--as-of", "2026-11-08");
    assert.equal(refused.status, 2);
    assert.match(refused.stderr, /inside the repo/);
    assert.equal(existsSync("netlify/data/crm-import.sealed.json"), false);
    assert.deepEqual(readdirSync("netlify/data"), ["office-dashboard.sealed.mjs"]);
    const noOut = run(tmp);
    assert.equal(noOut.status, 2);
    assert.match(noOut.stderr, /usage/);
    const out = path.join(tmp, "out.sealed.json");
    const ok = run(tmp, out, "--as-of", "2026-11-08");
    assert.equal(ok.status, 0, ok.stderr);
    assert.match(ok.stdout, /sealed 3 customers and 2 members \(export of 2026-11-08\)/);
    assert.doesNotMatch(ok.stdout, /@|\d{10}|Zimmer/, "the script prints counts only");
    const text = readFileSync(out, "utf8");
    const box = JSON.parse(text);
    assert.equal(box.v, 2);
    assert.ok(box.epk && box.iv && box.tag && box.data);
    assert.doesNotMatch(text, /@|\d{10}|first_name|Zimmer|notes/, "nothing readable in the sealed file");
    const print = run(tmp, "--print");
    assert.equal(print.status, 0);
    const summary = JSON.parse(print.stdout);
    assert.equal(summary.customers, 3);
    assert.equal(summary.members, 2);
    assert.ok(summary.fields.includes("phone"));
    assert.doesNotMatch(print.stdout, /@|\d{10}|Zimmer/);
    assert.equal(run(tmp, out, "--print-all").status, 2, "--print-all is gone");
    assert.equal(statSync(out).mode & 0o777, 0o600, "only the owner can read the sealed file");
    // Running again onto the same file replaces it.
    const rerun = run(tmp, out, "--as-of", "2026-11-08");
    assert.equal(rerun.status, 0, rerun.stderr);
    assert.notEqual(readFileSync(out, "utf8"), text, "a fresh seal");
    // A row the site would refuse stops the script before anything is written, naming the place only.
    const badDir = path.join(tmp, "bad");
    mkdirSync(badDir);
    writeFileSync(path.join(badDir, "customers.jsonl"), JSON.stringify({ ...FIX.customers[0], notes: "Gate code 4321 ".repeat(1000) }) + "\n");
    const badOut = path.join(tmp, "bad.sealed.json");
    const refusedRow = run(badDir, badOut, "--as-of", "2026-11-08");
    assert.equal(refusedRow.status, 2);
    assert.match(refusedRow.stderr, /customers\[0\]\.notes/);
    assert.doesNotMatch(refusedRow.stderr, /Gate code/);
    assert.equal(existsSync(badOut), false);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test("the seal script can't be steered into the repo by a symlink, a link plus '..', or a hard link", () => {
  const tmp = mkdtempSync(path.join(os.tmpdir(), "crm-seal-links-"));
  const probe = path.join(ROOT, `crm-seal-probe-${process.pid}.json`);
  try {
    writeFileSync(path.join(tmp, "customers.jsonl"), FIX.customers.map((c) => JSON.stringify(c)).join("\n") + "\n");
    const run = (out) => spawnSync(process.execPath, ["build/crm_seal_import.mjs", tmp, out, "--as-of", "2026-11-08"], { encoding: "utf8", env: { ...process.env, OFFICE_DATA_KEY: "" } });
    // (a) A dangling symlink outside the repo that points at a repo file not made yet.
    const dangling = path.join(tmp, "dangling.sealed.json");
    symlinkSync(probe, dangling);
    const a = run(dangling);
    assert.equal(a.status, 2, a.stdout);
    assert.match(a.stderr, /symlink|inside the repo/);
    assert.equal(existsSync(probe), false, "nothing was created in the repo");
    // (b) A symlink to a repo folder followed by "..": as text it is outside, but the kernel lands in the repo.
    symlinkSync(path.join(ROOT, "build"), path.join(tmp, "repo-build"));
    const viaDots = `${tmp}/repo-build/../${path.basename(probe)}`;
    assert.equal(realTarget(viaDots), probe, "resolved the way the filesystem resolves it");
    assert.equal(insideRepo(realTarget(viaDots)), true);
    const b = run(viaDots);
    assert.equal(b.status, 2, b.stdout);
    assert.match(b.stderr, /inside the repo/);
    assert.equal(existsSync(probe), false);
    assert.equal(realTarget(path.join(tmp, "no-such-folder", "x.json")), null);
    assert.match(run(path.join(tmp, "no-such-folder", "x.json")).stderr, /folder doesn't exist/);
    // (c) A hard link: writing replaces the link's own entry, never the file it shares.
    const fakeRoot = path.join(tmp, "repo");
    mkdirSync(fakeRoot);
    const secret = path.join(fakeRoot, "kept.json");
    writeFileSync(secret, "keep");
    const outside = path.join(tmp, "hard.sealed.json");
    linkSync(secret, outside);
    assert.equal(writeOutside(outside, "sealed", fakeRoot), true);
    assert.equal(readFileSync(secret, "utf8"), "keep");
    assert.equal(readFileSync(outside, "utf8"), "sealed");
    // And the last check catches a target that turns out to be inside after all.
    const inside = path.join(fakeRoot, "x.json");
    assert.equal(writeOutside(inside, "sealed", fakeRoot), false);
    assert.equal(existsSync(inside), false, "removed again");
    assert.deepEqual(readdirSync(fakeRoot), ["kept.json"], "no temporary file left behind");
  } finally {
    rmSync(tmp, { recursive: true, force: true });
    rmSync(probe, { force: true });
  }
});
