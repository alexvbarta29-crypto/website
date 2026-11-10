// The contacts API through the real dispatcher (design §5.1 "Endpoints",
// §12.3): edits with If-Match, archive and restore, notes, consent, paused
// automations, test flags, properties, the lead webhook and its tokens, and
// the maps adapter staying silent without its key.
import { test } from "node:test";
import assert from "node:assert/strict";
import { crmTest } from "../../helpers/crm-http.mjs";
import { store } from "./fixtures.mjs";

const maps = await import("../../../netlify/lib/crm/adapters/maps-google.mjs");
const { geocodeProperty } = await import("../../../netlify/lib/crm/modules/contacts/properties.mjs");

async function newContact(t, as, body = {}) {
  const r = await t.api("/contacts", { method: "POST", as, body: { first_name: "Pat", last_name: "Example", phone: "7635550140", email: "pat.api@example.com", address: { street1: "140 Example Ave", city: "Delano", state: "MN", zip: "55328" }, ...body } });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  return { c: r.body.data.contact, etag: r.headers.get("etag") };
}

test("edit, archive, restore, notes, consent and paused automations", async () => {
  const t = await crmTest();
  try {
    const owner = await t.user("owner");
    const admin = await t.user("admin");
    const { c, etag } = await newContact(t, owner, { lifecycle: "customer" });
    assert.ok(c.primary_property_id, "the address became the first property");
    const got = await t.api(`/contacts/${c.id}`, { as: admin });
    assert.equal(got.status, 200);
    assert.equal(got.body.data.properties.length, 1);
    assert.deepEqual(got.body.data.deals, [], "other modules' parts are empty until they ship");

    const p = await t.api(`/contacts/${c.id}`, { method: "PATCH", as: admin, ifMatch: etag, body: { last_name: "Sample", phones: [{ e164: "7635550141", label: "home" }], flags: { vip: true, test: true } } });
    assert.equal(p.status, 200, JSON.stringify(p.body));
    assert.equal(p.body.data.contact.display_name, "Pat Sample");
    assert.equal(p.body.data.contact.flags.vip, true);
    assert.equal(p.body.data.contact.flags.test, undefined, "only an owner marks a test contact, on its own route");
    assert.equal((await store.readPointer("phone", store.hk("phone", "+17635550141"))).ids[0], c.id, "the new number's lookup");
    assert.deepEqual((await store.readPointer("phone", store.hk("phone", "+17635550140"))).ids, [], "the old number no longer finds them");
    assert.equal((await t.api(`/contacts/${c.id}`, { method: "PATCH", as: admin, body: { last_name: "X" } })).status, 400, "If-Match required");
    assert.equal((await t.api(`/contacts/${c.id}`, { method: "PATCH", as: admin, ifMatch: p.headers.get("etag"), body: { lifecycle: "archived" } })).status, 400);

    const n = await t.api(`/contacts/${c.id}/notes`, { method: "POST", as: admin, body: { text: "Prefers texts." } });
    assert.match(n.body.data.contact.notes, /Note, Nov 17, 2026 \(Ada\)[\s\S]*Prefers texts\./);

    const cs = await t.api(`/contacts/${c.id}/consent`, { method: "PATCH", as: admin, body: { channel: "sms_marketing", state: "revoked", source: "verbal" } });
    assert.equal(cs.body.data.contact.consent.sms_marketing.state, "revoked");
    assert.equal(cs.body.data.contact.consent.sms_marketing.by, admin.id);
    const pz = await t.api(`/contacts/${c.id}/automations-paused`, { method: "PATCH", as: admin, body: { channel: "sms", paused: true, reason: "Call, don't text reminders" } });
    assert.equal(pz.body.data.contact.automations_paused.sms.reason, "Call, don't text reminders");
    const pz2 = await t.api(`/contacts/${c.id}/automations-paused`, { method: "PATCH", as: admin, body: { channel: "sms", paused: false } });
    assert.equal(pz2.body.data.contact.automations_paused, undefined);

    const ar = await t.api(`/contacts/${c.id}/archive`, { method: "POST", as: admin, body: { reason: "do_not_contact" } });
    assert.equal(ar.body.data.contact.lifecycle, "archived");
    const ix = await store.readIndex("contacts", "");
    assert.equal(ix.rows.find((r) => r.id === c.id).lc, "archived", "kept for history, hidden from lists by default");
    const rs = await t.api(`/contacts/${c.id}/restore`, { method: "POST", as: admin, body: {} });
    assert.equal(rs.body.data.contact.lifecycle, "customer", "back to what it was");
    assert.equal(rs.body.data.contact.archived_reason, undefined);

    const act = await t.api(`/contacts/${c.id}/activity`, { as: admin });
    assert.equal(act.status, 200);
    assert.ok(act.body.data.some((x) => x.kind === "note"), "the note on the timeline");
    assert.ok(act.body.data.some((x) => x.kind === "contact.create"), "its own history too");
  } finally { t.done(); }
});

test("only an owner marks a test contact; the bulk-send test contact needs one", async () => {
  const t = await crmTest();
  try {
    const owner = await t.user("owner");
    const admin = await t.user("admin");
    const { c } = await newContact(t, owner, { first_name: "Olive", last_name: "Team", phone: "7635550142", email: "olive.team@example.com" });
    assert.equal((await t.api(`/contacts/${c.id}/flags`, { method: "PATCH", as: admin, body: { test: true } })).status, 403);
    assert.equal((await t.api("/settings/messaging_test", { method: "PUT", as: owner, ifMatch: "new", body: { contact_id: c.id } })).status, 400, "not a test contact yet");
    const f = await t.api(`/contacts/${c.id}/flags`, { method: "PATCH", as: owner, body: { test: true } });
    assert.equal(f.body.data.contact.flags.test, true);
    assert.equal((await t.api("/settings/messaging_test", { method: "PUT", as: owner, ifMatch: "new", body: { contact_id: c.id } })).status, 200);
  } finally { t.done(); }
});

test("properties: add, read, edit (a new address goes back in line for a map point), geocode stays dry-run", async () => {
  const t = await crmTest();
  try {
    const owner = await t.user("owner");
    const { c } = await newContact(t, owner);
    const add = await t.api(`/contacts/${c.id}/properties`, { method: "POST", as: owner, body: { label: "Cabin", address: { street1: "9 Lake Rd", city: "Mound", state: "MN", zip: "55364" }, access: { gate_code: "2468", pets: "Friendly dog" }, assets: { panes_ext: 24, stories: 2 }, client_id: "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee" } });
    assert.equal(add.status, 201, JSON.stringify(add.body));
    const pid = add.body.data.property.id;
    assert.equal((await t.api(`/contacts/${c.id}/properties`, { method: "POST", as: owner, body: { label: "Cabin", address: { street1: "9 Lake Rd", city: "Mound", state: "MN", zip: "55364" }, client_id: "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee" } })).body.data.property.id, pid, "a double tap is one property");
    assert.equal(t.stores.data.keys("rel/geo-pending/all/").length, 2, "both wait for a map point");
    const g = await t.api(`/properties/${pid}`, { as: owner });
    assert.equal(g.body.data.property.access.gate_code, "2468");
    assert.equal(g.body.data.contact.id, c.id);
    // a manual pin, then an address change clears it
    const e1 = await t.api(`/properties/${pid}`, { method: "PATCH", as: owner, ifMatch: g.headers.get("etag"), body: { geo: { lat: 44.94, lng: -93.66 } } });
    assert.equal(e1.body.data.property.geo.source, "manual");
    const e2 = await t.api(`/properties/${pid}`, { method: "PATCH", as: owner, ifMatch: e1.headers.get("etag"), body: { address: { street1: "11 Lake Rd", city: "Mound", state: "MN", zip: "55364" } } });
    assert.equal(e2.body.data.property.geo, undefined);
    assert.equal(e2.body.data.property.town_tier, "unknown");
    const geo = await t.api(`/properties/${pid}/geocode`, { method: "POST", as: owner, body: {} });
    assert.deepEqual(geo.body.data, { skipped: "dry_run" }, "no Google call outside production's live mode");
    assert.equal(t.fetchCalls().length, 0);
  } finally { t.done(); }
});

test("the maps adapter: no key → no call; a key → one Geocoding call with a timeout, county and ZIP", async () => {
  const saved = globalThis.fetch;
  const seen = [];
  globalThis.fetch = async (url, init) => {
    seen.push({ url: String(url), signal: !!(init && init.signal) });
    return Response.json({ status: "OK", results: [{ formatted_address: "140 Example Ave, Delano, MN 55328, USA", geometry: { location: { lat: 45.04, lng: -93.79 } }, address_components: [{ long_name: "Wright County", types: ["administrative_area_level_2"] }, { short_name: "55328", types: ["postal_code"] }] }] });
  };
  try {
    assert.equal(await maps.geocode({ street1: "140 Example Ave", city: "Delano", state: "MN", zip: "55328" }, { env: {} }), null);
    assert.equal(seen.length, 0, "no key, no call");
    const r = await maps.geocode({ street1: "140 Example Ave", city: "Delano", state: "MN", zip: "55328" }, { env: { GOOGLE_MAPS_API_KEY: "test-key-not-real" } });
    assert.deepEqual({ lat: r.lat, lng: r.lng, county: r.county, zip: r.zip }, { lat: 45.04, lng: -93.79, county: "wright", zip: "55328" });
    assert.equal(seen.length, 1);
    assert.ok(seen[0].url.startsWith("https://maps.googleapis.com/maps/api/geocode/json?") && seen[0].url.includes("components=country:US"));
    assert.ok(seen[0].signal, "a timeout on the call");
  } finally { globalThis.fetch = saved; }
});

test("the lead webhook: tokens shown once and kept as a hash; a bad token 401; a leadgen id twice is one contact", async () => {
  const t = await crmTest();
  try {
    const owner = await t.user("owner");
    const admin = await t.user("admin");
    assert.equal((await t.api("/intake/webhook-tokens", { method: "POST", as: admin, body: {} })).status, 403);
    const made = await t.api("/intake/webhook-tokens", { method: "POST", as: owner, body: { label: "Zapier (Meta)" } });
    assert.equal(made.status, 201);
    const { token, url, id } = made.body.data;
    assert.ok(url.startsWith("https://www.bartawindowwashing.com/api/crm/hooks/lead/blh_"));
    assert.ok(!JSON.stringify(t.stores.data.json("cfg/intake")).includes(token), "only the hash is kept");
    const list = await t.api("/intake/webhook-tokens", { as: owner });
    assert.deepEqual(Object.keys(list.body.data[0]).sort(), ["created_at", "id", "label", "source"]);

    const meta = { full_name: "Meta Person", phone_number: "+17635550143", email: "meta.person@example.com", form_name: "Sample Form", ad_name: "Sample Ad", where_are_you_located: "Wright County", id: "880000000000012" };
    assert.equal((await t.api("/hooks/lead/blh_wrongwrongwrongwrongwrongwrong", { method: "POST", csrf: false, body: meta })).status, 401);
    const one = await t.api(`/hooks/lead/${token}`, { method: "POST", csrf: false, client: false, body: meta });
    assert.equal(one.status, 200, JSON.stringify(one.body));
    assert.equal(one.body.data.created, true);
    const two = await t.api(`/hooks/lead/${token}`, { method: "POST", csrf: false, client: false, body: { ...meta, phone_number: "+17635550144" } });
    assert.equal(two.body.data.contact_id, one.body.data.contact_id);
    assert.equal(two.body.data.duplicate, true);
    const c = (await store.getRecord("contact", one.body.data.contact_id)).data;
    assert.deepEqual([c.source.source, c.source.form, c.source.ad, c.source.county], ["Meta Ads", "Sample Form", "Sample Ad", "wright"]);
    assert.equal((await t.api(`/hooks/lead/${token}`, { method: "POST", csrf: false, body: { full_name: "No Number" } })).status, 400);
    assert.ok(!t.logs().some((l) => l.includes(token)), "the token never reaches a log");

    // saving the intake mode keeps the tokens (the screen sends the whole page back)
    const doc = await t.api("/settings/intake", { as: owner });
    const saved = await t.api("/settings/intake", { method: "PUT", as: owner, ifMatch: doc.body.data.etag, body: { ...doc.body.data.data, mode: "dual" } });
    assert.equal(saved.status, 200, JSON.stringify(saved.body));
    assert.equal(saved.body.data.data.webhook_tokens.length, 1);

    assert.equal((await t.api(`/intake/webhook-tokens/${id}`, { method: "DELETE", as: owner })).status, 200);
    assert.equal((await t.api(`/hooks/lead/${token}`, { method: "POST", csrf: false, body: meta })).status, 401, "revoked");
  } finally { t.done(); }
});

test("geocodeProperty: a live adapter fills geo, county, distance and tier (derived fields only)", async () => {
  const t = await crmTest();
  const { registerAdapter, __unregisterAdapterForTests } = await import("../../../netlify/lib/crm/adapters/index.mjs");
  try {
    const owner = await t.user("owner");
    const { c } = await newContact(t, owner);
    registerAdapter("maps", "live", { geocode: async () => ({ lat: 45.0419, lng: -93.7891, county: "wright" }) });
    const { deployContext } = await import("../../../netlify/lib/crm/core/context.mjs");
    const prod = deployContext(new Request("https://www.bartawindowwashing.com/"), { deploy: { context: "production" } }, { CRM_PRODUCTION: "1" });
    await store.putSetting("integrations", { maps: { mode: "live" } }, { by: "system", origin: "worker" });
    const out = await geocodeProperty(c.primary_property_id, { by: "system", origin: "worker", actor_kind: "automation" }, { deploy: prod });
    assert.equal(out.town_tier, "primary");
    assert.equal(out.distance_mi, 0);
    assert.equal(out.county, "wright");
    assert.equal(t.stores.data.keys("rel/geo-pending/all/").length, 0, "out of the geocode line");
  } finally {
    registerAdapter("maps", "live", maps.mapsLive);
    t.done();
  }
});

test("search (the contact picker) shows contacts by name and town, archived ones left out", async () => {
  const t = await crmTest();
  try {
    const owner = await t.user("owner");
    await newContact(t, owner, { first_name: "Riley", last_name: "Pickme", phone: "7635550145", email: "riley.pick@example.com" });
    const gone = await newContact(t, owner, { first_name: "Riley", last_name: "Archived", phone: "7635550146", email: "riley.gone@example.com" });
    await t.api(`/contacts/${gone.c.id}/archive`, { method: "POST", as: owner, body: { reason: "spam" } });
    const r = await t.api("/search?q=riley", { as: owner });
    assert.deepEqual(r.body.data.contacts.map((c) => c.name), ["Riley Pickme"]);
    assert.match(r.body.data.contacts[0].sub, /Delano/);
  } finally { t.done(); }
});
