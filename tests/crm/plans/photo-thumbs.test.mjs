// Photo thumbnails: the customer's request photos arrive with the phone's
// 400 px copy (kept as the file's thumbnail, checked by its magic bytes);
// ?thumb=1 serves it; a photo made before thumbnails (or whose thumbnail
// never came) answers ?thumb=1 with the photo itself, a PDF never does; a
// bad thumbnail never stops a request; the office's task list carries the
// first photo for its thumbnail.
import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { setup, customer, portalCookie, PJSON, scope, BYTES } from "./fixtures.mjs";

const F = await import("../../../netlify/lib/crm/core/files.mjs");

const postP = (t, path, cookie, body) => t.portal(path, { method: "POST", cookie, headers: PJSON, body });
const tasks = (t) => t.stores.data.keys("rec/task/").map((k) => t.stores.data.json(k));
const b64 = (u8) => Buffer.from(u8).toString("base64");
// two different JPEGs: the photo and its smaller copy
const PHOTO = () => Uint8Array.from([...BYTES.jpeg(), 0x11, 0x22, 0x33, 0x44]);
const THUMB = () => Uint8Array.from([...BYTES.jpeg(), 0x55]);
const bytesOf = async (res) => new Uint8Array(await res.arrayBuffer());
const crmApi = (await import("../../../netlify/functions/crm-api.mjs")).default;
const raw = (t, path, opts = {}) => crmApi(t.request("/api/crm" + path, opts), {});

test("a request's photos keep the phone's thumbnail; the list and ?thumb=1 use it; the full photo is one tap away", async () => {
  const { t, owner } = await setup();
  try {
    const c = await customer(owner);
    const ck = await portalCookie(t, c.id, { kind: "hub" });
    const r = await postP(t, "/api/portal/requests", ck, { client_id: randomUUID(), services: ["gutters"], photos: [b64(PHOTO()), b64(PHOTO())], thumbs: [b64(THUMB()), "not-a-jpeg!!"] });
    assert.equal(r.status, 201, JSON.stringify(r.body));
    const [task] = tasks(t);
    assert.equal(task.photo_ids.length, 2);
    const [a, b] = task.photo_ids.map((id) => t.stores.data.json(`rec/file/${id}`));
    assert.equal(a.has_thumb, true, "the first came with its thumbnail");
    assert.equal(b.has_thumb, false, "a bad thumbnail is left out, the photo still counts");
    // ?thumb=1: the thumbnail's bytes; the photo itself without it
    const ta = await raw(t, `/files/${a.id}?thumb=1`, { as: owner });
    assert.equal(ta.status, 200);
    assert.deepEqual(await bytesOf(ta), THUMB());
    const fa = await raw(t, `/files/${a.id}`, { as: owner });
    assert.deepEqual(await bytesOf(fa), PHOTO(), "the full photo");
    const tb = await raw(t, `/files/${b.id}?thumb=1`, { as: owner });
    assert.equal(tb.status, 200, "no thumbnail: the photo stands in");
    assert.equal(tb.headers.get("x-crm-thumb"), "original");
    assert.equal(tb.headers.get("content-type"), "image/jpeg");
    assert.equal(tb.headers.get("x-content-type-options"), "nosniff");
    assert.equal(tb.headers.get("content-security-policy"), "sandbox");
    assert.deepEqual(await bytesOf(tb), PHOTO());
    // three photos, each with its thumbnail, fit the request's storage budget
    const three = await postP(t, "/api/portal/requests", ck, { client_id: randomUUID(), services: ["screens"], photos: [b64(PHOTO()), b64(PHOTO()), b64(PHOTO())], thumbs: [b64(THUMB()), b64(THUMB()), b64(THUMB())] });
    assert.equal(three.status, 201, JSON.stringify(three.body));
    const t3 = tasks(t).find((x) => x.id === three.body.data.request_id);
    assert.ok(t3.photo_ids.every((id) => t.stores.data.json(`rec/file/${id}`).has_thumb), "every thumbnail kept");
    // the office's task list: the first photo and how many
    const list = await t.api("/tasks", { as: owner });
    const row = list.body.data.find((x) => x.id === task.id);
    assert.equal(row.photo_id, a.id);
    assert.equal(row.photos_n, 2);
  } finally { t.done(); }
});

test("only a photo stands in for its own thumbnail: a PDF or a download-only file without one is 404", async () => {
  const { t, owner } = await setup();
  try {
    const c = await customer(owner);
    const ck = await portalCookie(t, c.id, { kind: "hub" });
    assert.equal((await postP(t, "/api/portal/requests", ck, { client_id: randomUUID(), services: ["gutters"] })).status, 201);
    const [task] = tasks(t);
    const W = { by: owner.id, origin: "api", actor_kind: "user", requestId: "t" };
    const own = { type: "task", id: task.id };
    const pdf = await scope(() => F.storeImportedFile({ bytes: BYTES.pdf(), owner: own, kind: "attachment", contactId: c.id }, W));
    const html = await scope(() => F.storeImportedFile({ bytes: new TextEncoder().encode("<html><script>x</script></html>"), owner: own, kind: "import_media", contactId: c.id }, W));
    const jpg = await scope(() => F.storeImportedFile({ bytes: PHOTO(), owner: own, kind: "photo", contactId: c.id }, W));
    assert.equal(F.thumbFallsBack(pdf), false);
    assert.equal(F.thumbFallsBack(html), false);
    assert.equal(F.thumbFallsBack(jpg), true);
    assert.equal(F.thumbFallsBack({ ...jpg, has_thumb: true }), false, "a real thumbnail is served as itself");
    assert.equal((await t.api(`/files/${pdf.id}?thumb=1`, { as: owner })).status, 404);
    assert.equal((await t.api(`/files/${html.id}?thumb=1`, { as: owner })).status, 404);
    const j = await raw(t, `/files/${jpg.id}?thumb=1`, { as: owner });
    assert.equal(j.status, 200);
    // a revalidation of the stand-in is a 304
    const again = await raw(t, `/files/${jpg.id}?thumb=1`, { as: owner, headers: { "if-none-match": j.headers.get("etag") } });
    assert.equal(again.status, 304);
  } finally { t.done(); }
});
