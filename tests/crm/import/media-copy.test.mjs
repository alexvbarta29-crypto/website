// M8: the photo copy tool for switch day (build/crm_media_copy.mjs; design
// §10.1 step 2, §10.9). It refuses to run without --switch-day, refuses a
// path inside any worktree, fetches only https file-storage URLs (never
// Rotor's app or API), saves each file with its checksum into the media
// folder the pack reads, retries a 5xx, resumes without fetching again what
// it saved, and prints counts only. Fetch is faked: nothing reaches the
// network.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const MC = await import("../../../build/crm_media_copy.mjs");
const pack = await import("../../../build/crm_import_pack.mjs");
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const tmp = () => mkdtempSync(path.join(os.tmpdir(), "barta-media-copy-test-"));
const quiet = () => { const lines = []; return { log: (s) => lines.push(String(s)), error: (s) => lines.push("ERR " + String(s)), lines }; };
const JPEG = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(200, 7)]);
const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(120, 3)]);
const U = (n) => `https://xyzexample.supabase.co/storage/v1/object/public/attachments/${n}.jpg`;

function urlList(dir, rows) {
  const f = path.join(dir, "media-urls.jsonl");
  writeFileSync(f, rows.map((r) => (typeof r === "string" ? r : JSON.stringify(r))).join("\n") + "\n");
  return f;
}
function fakeFetch(plan) {
  const calls = [];
  const fn = async (url) => {
    calls.push(url);
    const p = plan[url];
    const step = Array.isArray(p) ? p.shift() : p;
    if (!step) throw new TypeError("network");
    if (step === "throw") throw new TypeError("network");
    return new Response(step.body || null, { status: step.status || 200, headers: { "content-type": step.type || "image/jpeg", ...(step.len ? { "content-length": String(step.len) } : {}) } });
  };
  fn.calls = calls;
  return fn;
}

test("it refuses without --switch-day, and a path inside any worktree", async () => {
  const dir = tmp();
  try {
    const list = urlList(dir, [{ url: U(1), source: "message_attachment", ref_id: "101" }]);
    const f = fakeFetch({});
    const io = quiet();
    assert.equal(await MC.main([dir, "--urls", list], { ...io, fetch: f }), 2);
    assert.match(io.lines.join("\n"), /switch day only/);
    assert.equal(f.calls.length, 0, "nothing fetched");
    assert.equal(await MC.main([path.join(ROOT, "tests"), "--urls", list, "--switch-day"], { ...quiet(), fetch: f }), 2);
    assert.equal(await MC.main([dir, "--urls", path.join(ROOT, "package.json"), "--switch-day"], { ...quiet(), fetch: f }), 2);
    assert.equal(await MC.main([dir, "--switch-day"], { ...quiet(), fetch: f }), 2, "the URL list is required");
    assert.equal(f.calls.length, 0);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("only https file-storage URLs, never Rotor's app or API", () => {
  assert.equal(MC.urlAllowed(U(1)), true);
  assert.equal(MC.urlAllowed("http://xyzexample.supabase.co/a.jpg"), false, "https only");
  assert.equal(MC.urlAllowed("https://api.getrotor.com/files/1"), false);
  assert.equal(MC.urlAllowed("https://app.getrotor.com/files/1"), false);
  assert.equal(MC.urlAllowed("https://files.example.com/a.jpg"), false, "an unknown host");
  assert.equal(MC.urlAllowed("https://files.example.com/a.jpg", ["files.example.com"]), true, "--allow-host");
  assert.equal(MC.urlAllowed(["https://user:pw", "xyzexample.supabase.co/a.jpg"].join(String.fromCharCode(64))), false, "no credentials in a URL");
});

test("switch day: checksums, retries, failures counted, a second run fetches only what is missing; the pack takes the files", async () => {
  const dir = tmp(), out = tmp();
  try {
    const list = urlList(dir, [
      { url: U(1), source: "message_attachment", ref_id: "101", name: "photo1.jpg" },
      { url: U(2), source: "quote_photo", ref_id: "q-7", name: "front.png" },
      { url: U(3), source: "message_attachment", ref_id: "103" },
      { url: U(4), source: "message_attachment", ref_id: "104" },
      { url: "https://api.getrotor.com/x", source: "message_attachment", ref_id: "105" },
      { url: U(6), source: "job_photo", ref_id: "106" },
      "not json",
      { url: U(1), source: "message_attachment", ref_id: "101" },
    ]);
    const f = fakeFetch({
      [U(1)]: { body: JPEG },
      [U(2)]: [{ status: 503 }, { body: PNG, type: "image/png" }],
      [U(3)]: { status: 404 },
      [U(4)]: { body: Buffer.alloc(10), len: 99 * 1024 * 1024 },
    });
    const io = quiet();
    assert.equal(await MC.main([dir, "--urls", list, "--switch-day"], { ...io, fetch: f, sleep: async () => {} }), 0);
    const first = JSON.parse(io.lines[0]);
    assert.deepEqual(first, { urls: 4, invalid_lines: 2, refused_hosts: 1 });
    const res = JSON.parse(io.lines[io.lines.length - 2]);
    assert.deepEqual({ saved: res.saved, kept: res.kept, failed: res.failed }, { saved: 2, kept: 0, failed: 2 });
    assert.deepEqual(res.failures_by_code, { http_404: 1, too_big: 1 });
    assert.ok(io.lines.every((l) => !/supabase|photo1|front\.png|q-7/.test(l)), "counts only: no URL, name or ref id");
    assert.equal(f.calls.filter((u) => u === U(2)).length, 2, "a 503 is tried again");
    assert.ok(!f.calls.some((u) => /getrotor/.test(u)), "never Rotor's app or API");
    const rows = readFileSync(path.join(dir, "media", "index.jsonl"), "utf8").trim().split("\n").map((l) => JSON.parse(l));
    const one = rows.find((r) => r.ref_id === "101");
    assert.equal(one.url_sha256, MC.sha256(U(1)));
    assert.equal(one.sha256, MC.sha256(JPEG));
    assert.equal(one.bytes, JPEG.length);
    assert.equal(one.file, `media/${one.url_sha256}`);
    assert.deepEqual(readFileSync(path.join(dir, one.file)), JPEG);
    assert.equal(rows.find((r) => r.ref_id === "q-7").content_type, "image/png");

    // again: what is saved and still matches is kept; a damaged file is fetched again; the failures are tried again
    writeFileSync(path.join(dir, "media", MC.sha256(U(2))), Buffer.from("damaged"));
    const f2 = fakeFetch({ [U(2)]: { body: PNG, type: "image/png" }, [U(3)]: { body: JPEG }, [U(4)]: { status: 404 } });
    const io2 = quiet();
    assert.equal(await MC.main([dir, "--urls", list, "--switch-day"], { ...io2, fetch: f2, sleep: async () => {} }), 0);
    const r2 = JSON.parse(io2.lines[io2.lines.length - 2]);
    assert.deepEqual({ saved: r2.saved, kept: r2.kept, failed: r2.failed }, { saved: 2, kept: 1, failed: 1 });
    assert.ok(!f2.calls.includes(U(1)), "a file already saved isn't fetched again");

    // the pack reads them (the media folder it reads is this one)
    writeFileSync(path.join(dir, "customers.jsonl"), JSON.stringify({ id: "c1", first_name: "Pat", last_name: "Sample", phone: "(763) 555-0101", email: "pat@example.com" }) + "\n");
    const media = pack.readMedia(dir);
    assert.equal(media.list.length, 3);
    assert.ok(existsSync(path.join(dir, "media", "index.jsonl")));
  } finally { for (const d of [dir, out]) rmSync(d, { recursive: true, force: true }); }
});
