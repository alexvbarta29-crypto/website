// The Blobs double itself (design §12.1): its answers match what
// @netlify/blobs 11.0.2 does, so the store's tests mean something. The
// store contract suite runs the same flows against a real BlobsServer
// with CRM_IT=1.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createMemoryBlobs, createCrmStores } from "../../helpers/crm-memory-store.mjs";

test("conditional writes: onlyIfNew, onlyIfMatch, one etag counter for every key", async () => {
  const s = createMemoryBlobs({ shuffle: false });
  const a = await s.setJSON("a", { v: 1 }, { onlyIfNew: true });
  assert.equal(a.modified, true);
  assert.match(a.etag, /^"\d+"$/);
  assert.deepEqual(await s.setJSON("a", { v: 2 }, { onlyIfNew: true }), { modified: false });
  const b = await s.setJSON("b", { v: 1 });
  assert.notEqual(a.etag, b.etag, "a stale etag of one key never matches another");
  assert.deepEqual(await s.setJSON("b", { v: 2 }, { onlyIfMatch: a.etag }), { modified: false });
  assert.deepEqual(await s.setJSON("missing", { v: 2 }, { onlyIfMatch: a.etag }), { modified: false });
  const b2 = await s.setJSON("b", { v: 2 }, { onlyIfMatch: b.etag });
  assert.equal(b2.modified, true);
  assert.deepEqual(await s.get("b", { type: "json" }), { v: 2 });
  await assert.rejects(s.setJSON("c", 1, { onlyIfNew: true, onlyIfMatch: '"1"' }), /mutually exclusive/);
  await assert.rejects(s.setJSON("c", 1, { onlyIfNew: true, onlyIfMatch: undefined }), /mutually exclusive/, "like the client: the key's presence is enough");
  await assert.rejects(s.setJSON("c", 1, { onlyIfMatch: 7 }), /expects a string/);
  await assert.rejects(s.setJSON("c", 1, { onlyIfNew: "yes" }), /expects a boolean/);
});

test("reads: types, the 304 shape, metadata", async () => {
  const s = createMemoryBlobs();
  const { etag } = await s.set("k", "hello", { metadata: { ct: "text/plain" } });
  assert.equal(await s.get("k"), "hello");
  assert.equal(new TextDecoder().decode(await s.get("k", { type: "arrayBuffer" })), "hello");
  assert.equal(await (await s.get("k", { type: "blob" })).text(), "hello");
  assert.equal(await new Response(await s.get("k", { type: "stream" })).text(), "hello");
  assert.equal(await s.get("nope"), null);
  assert.deepEqual(await s.getWithMetadata("k", { etag }), { data: null, etag, metadata: { ct: "text/plain" } });
  assert.deepEqual(await s.getMetadata("k"), { etag, metadata: { ct: "text/plain" } });
  assert.equal(await s.getMetadata("nope"), null);
  await s.setJSON("j", { a: [1, 2] });
  assert.equal(await s.get("j"), '{"a":[1,2]}', "setJSON stores JSON text");
});

test("validation uses the client's messages", async () => {
  const s = createMemoryBlobs();
  await assert.rejects(s.set("", "x"), /must not be empty/);
  await assert.rejects(s.set("/a", "x"), /forward slash/);
  await assert.rejects(s.set("%2Fa", "x"), /forward slash/);
  await assert.rejects(s.set("k".repeat(601), "x"), /at most 600 bytes/);
  await assert.rejects(s.set("k", "x", { metadata: { big: "x".repeat(2000) } }), /Metadata object exceeds the maximum size/);
  assert.throws(() => createMemoryBlobs({ name: "n".repeat(65) }), /at most 64 bytes/);
  assert.throws(() => createMemoryBlobs({ name: "a/b" }), /forward slashes/);
});

test("list: prefixes, directories, pages of pageSize, shuffled order", async () => {
  const s = createMemoryBlobs({ pageSize: 3, seed: 3 });
  for (const k of ["q/2026-11-17/1500--a", "q/2026-11-17/1515--b", "q/2026-11-18/0900--c", "q/x", "r/1", "r/2", "r/3", "r/4", "r/5"]) await s.set(k, "1");
  const r = await s.list({ prefix: "r/" });
  assert.deepEqual(r.blobs.map((b) => b.key).sort(), ["r/1", "r/2", "r/3", "r/4", "r/5"]);
  assert.notDeepEqual(r.blobs.map((b) => b.key), ["r/1", "r/2", "r/3", "r/4", "r/5"], "the order is not something to rely on");
  const pages = [];
  for await (const page of s.list({ prefix: "r/", paginate: true })) pages.push(page.blobs.length);
  assert.deepEqual(pages, [3, 2]);
  const d = await s.list({ prefix: "q/", directories: true });
  assert.deepEqual(d.blobs.map((b) => b.key), ["q/x"]);
  assert.deepEqual(d.directories.sort(), ["q/2026-11-17", "q/2026-11-18"]);
  assert.deepEqual((await s.list({ prefix: "zzz" })).blobs, []);
  await s.delete("r/1");
  await s.delete("r/1");
  assert.equal((await s.deleteAll()).deletedBlobs, 8);
});

test("fault hooks fire for the matching op and key only, as many times as asked", async () => {
  const s = createMemoryBlobs();
  s.fail({ op: "get", key: /^a/, times: 2 });
  await assert.rejects(s.get("a1"), (e) => e.name === "BlobsInternalError");
  assert.equal(await s.get("b1"), null);
  await assert.rejects(s.get("a2"));
  assert.equal(await s.get("a3"), null);
  s.fail({ op: "setJSON", kind: "timeout" });
  await assert.rejects(s.setJSON("x", 1), (e) => e.name === "TimeoutError");
  s.commitThenFail({ op: "setJSON", key: "y" });
  await assert.rejects(s.setJSON("y", 1));
  assert.equal(s.json("y"), 1, "the write landed");
  s.transient({ op: "setJSON", key: "z" });
  assert.deepEqual(await s.setJSON("z", 1, { onlyIfNew: true }), { modified: true, etag: "" });
  assert.equal(s.has("z"), false, "a transient never commits");
  const snap = s.snapshot();
  await s.setJSON("w", 1);
  s.restore(snap);
  assert.equal(s.has("w"), false);
  assert.ok(s.calls.length > 5);
  const stores = createCrmStores();
  assert.deepEqual(Object.keys(stores), ["data", "files", "backups", "probe"]);
});

test("like @netlify/blobs 11.0.2: a failed conditional write answers blank, reads never validate keys", async () => {
  const s = createMemoryBlobs();
  for (const kind of ["internal", "denied"]) {
    s.fail({ op: "setJSON", kind });
    assert.deepEqual(await s.setJSON("c", 1, { onlyIfNew: true }), { modified: true, etag: "" }, kind);
    assert.equal(s.has("c"), false);
  }
  s.fail({ op: "setJSON", kind: "denied" });
  await assert.rejects(s.setJSON("u", 1), (e) => e.name === "BlobsInternalError" && /401/.test(e.message), "an unconditional write throws");
  s.fail({ op: "setJSON", kind: "timeout" });
  await assert.rejects(s.setJSON("c", 1, { onlyIfNew: true }), (e) => e.name === "TimeoutError");
  assert.equal(await s.get(""), null);
  assert.equal(await s.getWithMetadata(""), null);
  assert.equal(await s.getMetadata(""), null);
  await s.delete("");
});

test("paginated listing: every page is its own call (fault hooks fire per page), the cursor moves only on success", async () => {
  const s = createMemoryBlobs({ pageSize: 3 });
  for (let i = 0; i < 7; i++) await s.set(`k/${i}`, "1");
  const it = s.list({ prefix: "k/", paginate: true })[Symbol.asyncIterator]();
  const keys = [];
  keys.push(...(await it.next()).value.blobs.map((b) => b.key));
  s.fail({ op: "list" });
  await assert.rejects(it.next(), (e) => e.name === "BlobsInternalError");
  keys.push(...(await it.next()).value.blobs.map((b) => b.key));
  keys.push(...(await it.next()).value.blobs.map((b) => b.key));
  assert.equal((await it.next()).done, true);
  assert.deepEqual(keys.sort(), ["k/0", "k/1", "k/2", "k/3", "k/4", "k/5", "k/6"], "the failed page was asked again, nothing skipped");
  assert.equal(s.calls.filter((c) => c.op === "list").length, 4);
});
