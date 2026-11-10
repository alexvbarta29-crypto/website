// Files (design §3.11, §4.12, §11.4 M1.3 files.test.mjs): the type comes
// from magic bytes; nosniff; attachment for PDFs and unknown types; CSP
// sandbox; an HTML upload is stored download-only; access follows the
// owner record; deleted bytes are purged only after a backup copy exists.
import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { crmTest } from "../../helpers/crm-http.mjs";
import { fixtureModule, fixtureType, BYTES } from "../../helpers/crm-fixtures.mjs";
import { advance, days } from "../../helpers/crm-clock.mjs";

const F = await import("../../../netlify/lib/crm/core/files.mjs");
const store = await import("../../../netlify/lib/crm-store.mjs");
const L = await import("../../../netlify/lib/crm/core/lanes.mjs");
const crmApi = (await import("../../../netlify/functions/crm-api.mjs")).default;

// A visit-like owner (the work module's visit arrives in M4a): assignees may read and edit its files.
fixtureModule({ types: [fixtureType("fixture_visit", "zv", { example: () => ({ assignee_ids: [], contact_id: null }) })] });
const byAssignee = (ctx, rec) => ctx.can("visits:work", { type: "visit", record: rec });
F.defineFileOwner("fixture_visit", { canRead: byAssignee, canEdit: byAssignee });

let t, owner, tech, other, visit;
beforeEach(async () => {
  // 01:00 local: the nightly bulk sweeps (03:00 and later) are not due, so only the runs a test makes run
  t = await crmTest({ now: "2026-11-17T07:00:00Z" });
  owner = await t.user("owner");
  tech = await t.user("tech");
  other = await t.user("tech");
  visit = (await store.createRecord("fixture_visit", { assignee_ids: [tech.id] }, { by: "system", origin: "api", actor_kind: "user", requestId: "t" })).data;
});
afterEach(() => t.done());

const upload = (as, bytes, type, q = "") => t.api(`/files?owner_type=fixture_visit&owner_id=${visit.id}${q}`, { method: "POST", as, raw: bytes, headers: { "content-type": type } });
const raw = (path, opts = {}) => crmApi(t.request("/api/crm" + path, opts), {});

test("the type comes from the magic bytes, never the uploader's header", () => {
  assert.equal(F.sniffType(BYTES.jpeg()), "image/jpeg");
  assert.equal(F.sniffType(BYTES.png()), "image/png");
  assert.equal(F.sniffType(BYTES.webp()), "image/webp");
  assert.equal(F.sniffType(BYTES.pdf()), "application/pdf");
  assert.equal(F.sniffType(BYTES.html()), "text/html");
  assert.equal(F.sniffType(BYTES.svg()), "image/svg+xml");
  assert.equal(F.sniffType(BYTES.unknown()), null);
  assert.equal(F.sniffType(new Uint8Array([0x47, 0x49, 0x46, 0x38, 0x39, 0x61, 1, 2])), "image/gif");
});

test("a photo upload: stored with its real type, served inline with nosniff, CSP sandbox, ETag and 304", async () => {
  const res = await upload(tech, BYTES.jpeg(), "image/png", "&kind=photo&tag=before");
  assert.equal(res.status, 201, JSON.stringify(res.body));
  const file = res.body.data.file;
  assert.equal(file.content_type, "image/jpeg", "the bytes say JPEG, whatever the header said");
  assert.equal(file.tag, "before");
  const got = await raw(`/files/${file.id}`, { as: tech });
  assert.equal(got.status, 200);
  assert.equal(got.headers.get("content-type"), "image/jpeg");
  assert.equal(got.headers.get("x-content-type-options"), "nosniff");
  assert.equal(got.headers.get("content-security-policy"), "sandbox");
  assert.equal(got.headers.get("content-disposition"), "inline");
  assert.equal(got.headers.get("cache-control"), "private, max-age=31536000, immutable");
  const etag = got.headers.get("etag");
  assert.ok(etag);
  assert.deepEqual(new Uint8Array(await got.arrayBuffer()), BYTES.jpeg());
  const again = await raw(`/files/${file.id}`, { as: tech, headers: { "if-none-match": etag } });
  assert.equal(again.status, 304);
  assert.equal(again.headers.get("etag"), etag);
  assert.ok(t.stores.data.keys(`evt/file/${file.id}/`).some((k) => k.includes("--download--")), "a staff download is audited");
});

test("a PDF is always an attachment; an unknown or HTML upload is refused for staff", async () => {
  const pdf = await upload(owner, BYTES.pdf(), "application/pdf", "&kind=document");
  assert.equal(pdf.status, 201);
  const got = await raw(`/files/${pdf.body.data.file.id}`, { as: owner });
  assert.equal(got.headers.get("content-type"), "application/pdf");
  assert.match(got.headers.get("content-disposition"), /^attachment; filename="file-fl_[0-9a-z]+\.pdf"$/);
  assert.equal((await upload(owner, BYTES.html(), "image/jpeg")).status, 400, "HTML pretending to be a JPEG");
  assert.equal((await upload(owner, BYTES.jpeg(), "text/html")).status, 400, "a declared type outside the list");
  assert.equal((await upload(owner, BYTES.unknown(), "image/jpeg")).status, 400);
  assert.equal((await upload(owner, BYTES.svg(), "image/png")).status, 400);
  assert.equal((await upload(owner, BYTES.jpeg(), "image/jpeg", "&taken_at=yesterday")).status, 400, "taken_at is a time");
  assert.equal((await upload(owner, BYTES.jpeg(), "image/jpeg", "&taken_at=2026-11-17T06:50:00.000Z")).status, 201);
});

test("imported HTML, SVG and unknown media are stored download-only and served as octet-stream attachments", async () => {
  for (const bytes of [BYTES.html(), BYTES.svg(), BYTES.unknown()]) {
    const rec = await store.withStoreScope({ requestId: "imp" }, () => F.storeImportedFile({ bytes, owner: { type: "fixture_visit", id: visit.id }, source: "import" }, { by: "import", origin: "import", requestId: "imp" }));
    assert.equal(rec.download_only, true);
    const got = await raw(`/files/${rec.id}`, { as: owner });
    assert.equal(got.status, 200);
    assert.equal(got.headers.get("content-type"), "application/octet-stream");
    assert.match(got.headers.get("content-disposition"), /^attachment; filename="file-fl_[0-9a-z]+\.bin"$/);
    assert.equal(got.headers.get("content-security-policy"), "sandbox");
    assert.equal(got.headers.get("x-content-type-options"), "nosniff");
  }
  const jpeg = await store.withStoreScope({ requestId: "imp" }, () => F.storeImportedFile({ bytes: BYTES.jpeg(), owner: { type: "fixture_visit", id: visit.id } }, { by: "import", origin: "import", requestId: "imp" }));
  assert.equal(jpeg.download_only, undefined, "an imported photo is an ordinary photo");
});

test("access follows the owner record: another tech gets 403, an unknown owner type 400", async () => {
  const up = await upload(tech, BYTES.jpeg(), "image/jpeg");
  assert.equal((await upload(other, BYTES.jpeg(), "image/jpeg")).status, 403);
  assert.equal((await raw(`/files/${up.body.data.file.id}`, { as: other })).status, 403);
  const bad = await t.api(`/files?owner_type=user&owner_id=${tech.id}`, { method: "POST", as: owner, raw: BYTES.jpeg(), headers: { "content-type": "image/jpeg" } });
  assert.equal(bad.status, 400);
  const noCsrf = await t.api(`/files?owner_type=fixture_visit&owner_id=${visit.id}`, { method: "POST", as: tech, raw: BYTES.jpeg(), csrf: false, headers: { "content-type": "image/jpeg" } });
  assert.equal(noCsrf.status, 403);
});

test("a thumbnail is a JPEG under 400 KB and is served inline; an offline replay with the same client id makes one file", async () => {
  const up = await upload(tech, BYTES.png(), "image/png", "&client_id=3f6b1a2e-0c4d-4e8f-9a1b-2c3d4e5f6a7b");
  const again = await upload(tech, BYTES.png(), "image/png", "&client_id=3f6b1a2e-0c4d-4e8f-9a1b-2c3d4e5f6a7b");
  assert.equal(again.body.data.file.id, up.body.data.file.id);
  assert.equal(t.stores.data.keys("rec/file/").length, 1);
  const id = up.body.data.file.id;
  assert.equal((await t.api(`/files/${id}/thumb`, { method: "POST", as: tech, raw: BYTES.png(), headers: { "content-type": "image/jpeg" } })).status, 400);
  const th = await t.api(`/files/${id}/thumb`, { method: "POST", as: tech, raw: BYTES.jpeg(), headers: { "content-type": "image/jpeg" } });
  assert.equal(th.status, 200);
  assert.equal(th.body.data.file.has_thumb, true);
  const got = await raw(`/files/${id}?thumb=1`, { as: tech });
  assert.equal(got.headers.get("content-type"), "image/jpeg");
  assert.equal(got.headers.get("content-disposition"), "inline");
});

test("delete is soft; the bytes are purged after 30 days, and only once files.backup has copied them", async () => {
  const a = (await upload(owner, BYTES.jpeg(), "image/jpeg")).body.data.file.id;
  const b = (await upload(owner, BYTES.png(), "image/png")).body.data.file.id;
  // a is backed up before both are deleted; b is not
  const backup = await store.withStoreScope({ requestId: "b" }, () => L.createRun("files.backup", {}, { by: "system" }, { kick: false }));
  await t.runWorker({ lane: "bulk" });
  assert.equal((await store.withStoreScope({ requestId: "b" }, () => L.getRun(backup.id))).status, "done");
  assert.ok(t.stores.backups.has(`files/${a}`) && t.stores.backups.has(`files/${b}`));
  t.stores.backups.restore(new Map([...t.stores.backups.snapshot()].filter(([k]) => k !== `files/${b}`)));
  for (const id of [a, b]) assert.equal((await t.api(`/files/${id}`, { method: "DELETE", as: owner })).status, 200);
  assert.equal((await raw(`/files/${a}`, { as: owner })).status, 404, "a deleted file isn't served");
  assert.ok(t.stores.files.has(`f/${a}`), "but its bytes stay for now");
  advance(days(31));
  const purge = await store.withStoreScope({ requestId: "p" }, () => L.createRun("files.purge", {}, { by: "system" }, { kick: false }));
  await t.runWorker({ lane: "bulk" });
  const done = await store.withStoreScope({ requestId: "p" }, () => L.getRun(purge.id));
  assert.equal(done.status, "done");
  assert.deepEqual(done.result, { purged: 1, kept_without_backup: 1 });
  assert.ok(!t.stores.files.has(`f/${a}`), "backed up: purged");
  assert.ok(t.stores.files.has(`f/${b}`), "no copy yet: kept");
  assert.ok(t.stores.data.json(`rec/file/${a}`).purged_at);
});
