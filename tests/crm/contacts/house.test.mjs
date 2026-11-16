// The house picture (docs/CRM-MAP.md "The house picture"): Street View when
// Google has it (metadata first: never the grey tile), else the aerial; one
// Google call per address and kind (Blobs after that), a new address asks
// again, the budget counts every billed call before it is made, the sweep
// warms every property a few at a time, and who may see a property may see
// its picture. Google is a fake "maps" adapter (and a mocked fetch for the
// adapter itself); synthetic addresses only.
import { test, afterEach } from "node:test";
import assert from "node:assert/strict";
import { crmTest } from "../../helpers/crm-http.mjs";
import { seedImportedContact } from "../../helpers/crm-fixtures.mjs";

const store = await import("../../../netlify/lib/crm-store.mjs");
const ids = await import("../../../netlify/lib/crm/core/ids.mjs");
const H = await import("../../../netlify/lib/crm/modules/contacts/house.mjs");
const maps = await import("../../../netlify/lib/crm/adapters/maps-google.mjs");
const { registerAdapter } = await import("../../../netlify/lib/crm/adapters/index.mjs");
const { automationCtx } = await import("../../../netlify/lib/crm/core/activity.mjs");
const { deployContext } = await import("../../../netlify/lib/crm/core/context.mjs");
const crmApi = (await import("../../../netlify/functions/crm-api.mjs")).default;

const PROD_ENV = { CONTEXT: "production", CRM_PRODUCTION: "1", CRM_KEY_SALT: "test-salt-not-real", GOOGLE_MAPS_API_KEY: "test-key-not-real" };
const JPEG = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00, 0x01, ...new Array(200).fill(9)]);
const W = (by = "system") => ({ by, origin: "api", actor_kind: "user", requestId: "house-test" });
const SET = { by: "system", origin: "seed", actor_kind: "user", requestId: "house-test" };

let t = null;
afterEach(() => { registerAdapter("maps", "live", maps.mapsLive); if (t) t.done(); t = null; });

// A fake Google: "Farm Rd" is out in the country (no Street View there); a house's map point is
// from its street number; the panorama sits 20 m south-west of the house.
function fakeGoogle() {
  const calls = [];
  const geoOf = (a) => ({ lat: 45 + (parseInt(a.street1, 10) || 1) / 1000, lng: -93.7 });
  const impl = {
    geocode: async (a) => { calls.push({ k: "geocode" }); return { ...geoOf(a), county: "wright" }; },
    streetMeta: async (at) => {
      calls.push({ k: "meta", at });
      if (typeof at === "string" ? /Farm Rd/.test(at) : at.lat > 45.5) return { status: "none" };
      const lat = typeof at === "string" ? 45.1 : at.lat - 0.00013, lng = typeof at === "string" ? -93.7 : at.lng - 0.00018;
      return { status: "OK", pano: "PANO_test_000001", lat, lng };
    },
    streetImage: async (o) => { calls.push({ k: "street", o }); return JPEG; },
    aerialImage: async (o) => { calls.push({ k: "aerial", o }); return JPEG; },
  };
  return { impl, calls, billed: () => calls.filter((c) => c.k !== "meta").length };
}

async function live(env = PROD_ENV) {
  t = await crmTest({ env });
  const g = fakeGoogle();
  registerAdapter("maps", "live", g.impl);
  await store.putSetting("integrations", { maps: { mode: "live" } }, SET);
  return g;
}

async function house(owner, { street1 = "120 Example Ave", geo = undefined, imported = false } = {}) {
  const c = imported ? await seedImportedContact(7) : (await store.createRecord("contact", { first_name: "Pat", last_name: "Example", phones: [{ e164: "+17635550170", sms: true }], lifecycle: "customer", source: { source: "Referral" } }, W(owner.id))).data;
  const IMPORT = { run_id: "ir_00000000000000000001", at: "2026-11-08T00:00:00.000Z", hash: "0".repeat(64) };
  const p = (await store.createRecord("property", { contact_id: c.id, label: "Home", address: { street1, city: "Delano", state: "MN", zip: "55328" }, access: {}, ...(geo ? { geo } : {}), ...(imported ? { import: IMPORT } : {}) }, imported ? { by: "system", origin: "import", actor_kind: "import", requestId: "house-test" } : W(owner.id))).data;
  if (imported) assert.ok(p.import, "an imported property (the guard watches its Rotor fields)");
  return { c, p };
}

const pic = async (path, as, headers = {}) => {
  const res = await crmApi(t.request("/api/crm" + path, { as, headers }), {});
  const bytes = new Uint8Array(await res.arrayBuffer());
  return { status: res.status, bytes, headers: res.headers };
};

test("the adapter: metadata first (no key: no call); no coverage is 'none'; images are asked with return_error_code; the key never reaches a log", async () => {
  const saved = globalThis.fetch;
  const seen = [];
  const logs = [];
  const err = console.error;
  console.error = (...a) => logs.push(a.join(" "));
  let answer = { status: "OK", pano_id: "PANO_abc_123456", location: { lat: 45.0411, lng: -93.7898 } };
  globalThis.fetch = async (url) => {
    const u = new URL(String(url));
    seen.push(u);
    if (u.pathname.endsWith("/streetview/metadata")) return Response.json(answer);
    if (u.pathname.endsWith("/streetview")) return u.searchParams.get("pano") === "PANO_gone_123456" ? new Response("", { status: 404 }) : new Response(JPEG, { headers: { "content-type": "image/jpeg" } });
    if (u.pathname.endsWith("/staticmap")) return new Response(JPEG, { headers: { "content-type": "image/jpeg" } });
    return new Response("", { status: 500 });
  };
  const env = { GOOGLE_MAPS_API_KEY: "test-key-not-real" };
  try {
    assert.deepEqual(await maps.streetMeta({ lat: 45, lng: -93 }, { env: {} }), { status: "error" });
    assert.equal(seen.length, 0, "no key, no call");
    const m = await maps.streetMeta({ lat: 45.0412, lng: -93.79 }, { env });
    assert.deepEqual(m, { status: "OK", pano: "PANO_abc_123456", lat: 45.0411, lng: -93.7898 });
    assert.equal(seen[0].searchParams.get("source"), "outdoor");
    assert.equal(seen[0].searchParams.get("location"), "45.0412000,-93.7900000");
    answer = { status: "ZERO_RESULTS" };
    seen.length = 0;
    assert.deepEqual(await maps.streetMeta("1 Farm Rd, Delano, MN 55328", { env }), { status: "none" });
    assert.equal(seen.length, 2, "close, then a little further along the road");
    answer = { status: "REQUEST_DENIED", error_message: "This API project is not authorized" };
    assert.deepEqual(await maps.streetMeta({ lat: 45, lng: -93 }, { env }), { status: "denied" });
    seen.length = 0;
    const img = await maps.streetImage({ pano: "PANO_abc_123456", heading: 31.6, pitch: 8, fov: 95, size: "640x400" }, { env });
    assert.equal(img.length, JPEG.length);
    assert.equal(seen[0].searchParams.get("return_error_code"), "true", "Google answers 404 rather than its grey tile");
    assert.equal(seen[0].searchParams.get("heading"), "32");
    assert.equal(await maps.streetImage({ pano: "PANO_gone_123456", size: "640x400" }, { env }), null);
    seen.length = 0;
    await maps.aerialImage({ center: { lat: 45.0412, lng: -93.79 }, zoom: 20, size: "640x400" }, { env });
    assert.equal(seen[0].searchParams.get("maptype"), "satellite");
    assert.equal(seen[0].searchParams.get("zoom"), "20");
    assert.equal(seen[0].searchParams.get("markers"), "color:red|45.0412000,-93.7900000", "a pin on the house");
    assert.ok(!logs.join("\n").includes("test-key-not-real"), "the key never reaches a log");
    assert.ok(!logs.join("\n").includes("Farm"), "nor an address");
  } finally { globalThis.fetch = saved; console.error = err; }
});

test("aim: the camera at the pano looks at the house (bearing), closer houses get a wider view", () => {
  const house = { lat: 45.0, lng: -93.0 };
  assert.equal(H.aim({ lat: 44.9999, lng: -93.0 }, house).heading, 0, "a pano due south looks north");
  assert.equal(H.aim({ lat: 45.0, lng: -92.9998 }, house).heading, 270, "a pano due east looks west");
  assert.ok(H.aim({ lat: 44.99993, lng: -93.0 }, house).fov > H.aim({ lat: 44.9996, lng: -93.0 }, house).fov);
  assert.deepEqual(H.aim({ lat: 45, lng: -93 }, null), { pitch: 8, fov: 90 }, "no map point: Google aims at the address");
  const a = { street1: "1 Example Ave", city: "Delano", state: "MN", zip: "55328" };
  assert.equal(H.houseHash({ address: a }), H.houseHash({ address: { ...a } }));
  assert.notEqual(H.houseHash({ address: a }), H.houseHash({ address: { ...a, street1: "2 Example Ave" } }), "a new address is a new picture");
  assert.notEqual(H.houseHash({ address: a }), H.houseHash({ address: a, geo: { lat: 45, lng: -93 } }), "and so is a map point");
});

test("the route: Street View once (then Blobs, then 304), the aerial on request, no coverage is 404 (asked once), a new address asks again", async () => {
  const g = await live();
  const owner = await t.user("owner");
  const { p } = await house(owner, { geo: { lat: 45.12, lng: -93.7, source: "google" } });
  assert.deepEqual((await t.api("/house/status", { as: owner })).body.data, { on: true });

  const one = await pic(`/properties/${p.id}/house.jpg`, owner);
  assert.equal(one.status, 200);
  assert.equal(one.headers.get("content-type"), "image/jpeg");
  assert.equal(one.headers.get("x-content-type-options"), "nosniff");
  assert.match(one.headers.get("cache-control"), /^private/);
  assert.deepEqual(one.bytes, JPEG);
  const shot = g.calls.find((c) => c.k === "street");
  assert.equal(shot.o.pano, "PANO_test_000001");
  assert.ok(shot.o.heading > 20 && shot.o.heading < 60, `aimed north-east at the house (${shot.o.heading})`);
  assert.equal(shot.o.size, "640x400");
  const billed = g.billed();
  assert.equal((await pic(`/properties/${p.id}/house.jpg`, owner)).status, 200);
  assert.equal(g.billed(), billed, "a second view is a Blobs read, not a Google call");
  assert.equal(g.calls.filter((c) => c.k === "meta").length, 1, "and the metadata is remembered");
  assert.equal((await pic(`/properties/${p.id}/house.jpg`, owner, { "if-none-match": one.headers.get("etag") })).status, 304);

  assert.equal((await pic(`/properties/${p.id}/house.jpg?kind=aerial`, owner)).status, 200);
  const air = g.calls.find((c) => c.k === "aerial");
  assert.deepEqual([air.o.zoom, air.o.pin, air.o.center.lat], [20, true, 45.12]);
  assert.equal((await pic(`/properties/${p.id}/house.jpg?kind=street&size=thumb`, owner)).status, 200);
  assert.equal(g.calls.filter((c) => c.k === "street").pop().o.size, "160x160");
  assert.equal(t.stores.files.keys(`h/${p.id}/`).length, 3, "full, aerial and thumb kept");

  // no Street View out on the farm: 404 (the screen shows the aerial), and the free metadata call isn't made twice
  const farm = (await house(owner, { street1: "1 Farm Rd", geo: { lat: 46.1, lng: -93.7, source: "google" } })).p;
  assert.equal((await pic(`/properties/${farm.id}/house.jpg`, owner)).status, 404);
  const metas = g.calls.filter((c) => c.k === "meta").length;
  assert.equal((await pic(`/properties/${farm.id}/house.jpg`, owner)).status, 404);
  assert.equal(g.calls.filter((c) => c.k === "meta").length, metas, "no coverage is remembered");
  assert.equal((await pic(`/properties/${farm.id}/house.jpg?kind=aerial`, owner)).status, 200);

  // a new address (the edit takes the map point away): Google again, the old pictures deleted
  const cur = await t.api(`/properties/${p.id}`, { as: owner });
  const moved = await t.api(`/properties/${p.id}`, { method: "PATCH", as: owner, ifMatch: cur.headers.get("etag"), body: { address: { street1: "130 Example Ave", city: "Delano", state: "MN", zip: "55328" } } });
  assert.equal(moved.status, 200, JSON.stringify(moved.body));
  const before = g.billed();
  assert.equal((await pic(`/properties/${p.id}/house.jpg`, owner)).status, 200);
  assert.ok(g.billed() > before, "the new house is asked for");
  assert.equal(g.calls.filter((c) => c.k === "geocode").length, 1, "its map point found once (it had none)");
  assert.ok((await store.getRecord("property", p.id)).data.geo, "and kept on the property");
  const left = t.stores.files.keys(`h/${p.id}/`);
  assert.equal(left.length, 1, "only the new address's picture is left");
  assert.ok(!t.logs().some((l) => /Example Ave|Farm Rd|test-key-not-real/.test(l)), "no address or key in a log");
});

test("who may see the property may see its picture: a tech with a visit there, not another tech; nobody signed out", async () => {
  await live();
  const owner = await t.user("owner");
  const tech = await t.user("tech");
  const other = await t.user("tech");
  const { c, p } = await house(owner, { geo: { lat: 45.12, lng: -93.7, source: "google" } });
  const vid = ids.newId("visit");
  await store.settledWrite(`rec/visit/${vid}`, { id: vid, type: "visit", v: 1, wv: 1, contact_id: c.id, assignee_ids: [tech.id], date: "2026-11-18", created_at: "2026-11-17T15:00:00.000Z" }, { onlyIfNew: true });
  await store.addRel("tech-visits", tech.id, "2026-11-18", vid);
  assert.equal((await pic(`/properties/${p.id}/house.jpg`, tech)).status, 200);
  assert.equal((await pic(`/properties/${p.id}/house.jpg`, other)).status, 404);
  assert.equal((await pic(`/properties/${p.id}/house.jpg`, null)).status, 401);
  assert.equal((await pic(`/properties/pr_00000000000000000000/house.jpg`, owner)).status, 404);
});

test("off (no key, dry-run, a local deploy): status off and 404 without a Google call; the screens show the keyless satellite", async () => {
  t = await crmTest();
  const g = fakeGoogle();
  registerAdapter("maps", "live", g.impl);
  const owner = await t.user("owner");
  const { p } = await house(owner);
  assert.deepEqual((await t.api("/house/status", { as: owner })).body.data, { on: false });
  assert.equal((await pic(`/properties/${p.id}/house.jpg`, owner)).status, 404);
  assert.equal(g.calls.length, 0);
});

test("the budget: every billed call is counted before it is made; a full day (or person, or month) is a 429 with no call", async () => {
  const g = await live();
  const owner = await t.user("owner");
  const { p } = await house(owner, { geo: { lat: 45.12, lng: -93.7, source: "google" } });
  assert.equal(await H.spend({ uid: owner.id }), true);
  const doc = t.stores.data.json("geo/house/use/2026-11");
  assert.deepEqual([doc.n, doc.d, doc.dn, doc.u[owner.id]], [1, "2026-11-17", 1, 1]);
  await store.putRaw("geo/house/use/2026-11", { n: 10, d: "2026-11-17", dn: 10, ds: 0, u: { [owner.id]: H.CAPS.userDay } });
  const r = await pic(`/properties/${p.id}/house.jpg`, owner);
  assert.equal(r.status, 429, "this person's day is used up");
  assert.equal(g.calls.filter((c) => c.k === "street").length, 0, "and no picture was asked for");
  assert.equal(await H.spend({ uid: "us_someoneelse0000000" }), true, "another person may");
  await store.putRaw("geo/house/use/2026-11", { n: 10, d: "2026-11-17", dn: 10, ds: H.CAPS.sweepDay, u: {} });
  assert.equal(await H.spend({ sweep: true }), false, "the sweep's share of the day");
  assert.equal(await H.spend({ uid: "us_someoneelse0000000" }), true, "leaves room for people");
  await store.putRaw("geo/house/use/2026-11", { n: 10, d: "2026-11-17", dn: H.CAPS.day, ds: 0, u: {} });
  assert.equal(await H.spend({}), false, "the day");
  await store.putRaw("geo/house/use/2026-11", { n: H.CAPS.month, d: "2026-11-16", dn: H.CAPS.day, ds: 0, u: {} });
  assert.equal(await H.spend({}), false, "the month, though yesterday's day is over");
  await store.putRaw("geo/house/use/2026-11", { n: 10, d: "2026-11-16", dn: H.CAPS.day, ds: H.CAPS.sweepDay, u: {} });
  assert.equal(await H.spend({ sweep: true }), true, "a new day starts over");
});

test("the contacts.house sweep: a few properties a pass, resumes where it stopped, done for the day, geocodes an imported property (derived geo only), drops a deleted one's pictures", async () => {
  const g = await live();
  const owner = await t.user("owner");
  const made = [];
  for (let i = 0; i < 7; i++) made.push((await house(owner, { street1: `${200 + i} Example Ave`, geo: { lat: 45.2 + i / 1000, lng: -93.7, source: "census" } })).p);
  const farm = (await house(owner, { street1: "3 Farm Rd", geo: { lat: 46.2, lng: -93.7, source: "census" } })).p;
  const imported = await house(owner, { street1: "250 Example Ave", imported: true });
  const prod = deployContext(new Request("https://www.bartawindowwashing.com/"), { deploy: { context: "production" } }, { CRM_PRODUCTION: "1" });
  const ctx = () => ({ ...automationCtx({ mode: { system_of_record: "rotor", paused: false }, key: "contacts.house", requestId: "house-test" }), deploy: prod, budget: store.withBudget(120000, 100000, { strict: false }) });
  const pass = () => store.withStoreScope({ deploy: prod, requestId: "house-test" }, () => H.runHouseSweep(ctx()));

  const first = await pass();
  assert.match(first.result, /^batch:5$/, JSON.stringify(first));
  const st = t.stores.data.json(H.SWEEP_KEY);
  assert.ok(st.after && !st.day_done, "it remembers where it stopped");
  const second = await pass();
  assert.match(second.result, /^walked:/, JSON.stringify(second));
  assert.equal(t.stores.data.json(H.SWEEP_KEY).day_done, "2026-11-17");
  for (const p of [...made, imported.p]) assert.ok(t.stores.files.keys(`h/${p.id}/`).length === 2, `street full and thumb for each (${p.id})`);
  assert.equal(t.stores.files.keys(`h/${farm.id}/`).length, 2, "the farm: the aerial instead");
  assert.ok(t.stores.files.keys(`h/${farm.id}/`).every((k) => k.includes("-aerial-")));
  const ip = (await store.getRecord("property", imported.p.id)).data;
  assert.equal(ip.geo.source, "google", "the imported property got its map point (a derived field)");
  assert.deepEqual([ip.address, ip.label, ip.import], [imported.p.address, imported.p.label, imported.p.import], "and nothing Rotor owns changed");
  assert.equal((await pass()).result, "done_today");
  const billed = g.billed();

  // tomorrow: one deleted property loses its pictures; nothing else is asked for again
  const { setNow } = await import("../../../netlify/lib/crm/core/clock.mjs");
  setNow("2026-11-18T15:00:00Z");
  await store.softDelete("property", made[0].id, W(owner.id));
  let out;
  do { out = await pass(); } while (!/^walked:/.test(out.result));
  assert.equal(g.billed(), billed, "warm pictures are not asked for again");
  assert.equal(t.stores.files.keys(`h/${made[0].id}/`).length, 0, "the deleted property's pictures are gone");
});

test("the sweep in dry-run or without the key: nothing is called", async () => {
  t = await crmTest();
  const g = fakeGoogle();
  registerAdapter("maps", "live", g.impl);
  const dev = deployContext(new Request("https://www.bartawindowwashing.com/"), {}, {});
  const ctx = { ...automationCtx({ mode: { system_of_record: "rotor", paused: false }, key: "contacts.house", requestId: "house-test" }), deploy: dev };
  const out = await store.withStoreScope({ requestId: "house-test" }, () => H.runHouseSweep(ctx));
  assert.match(out.result, /^skipped:/);
  assert.equal(g.calls.length, 0);
});
