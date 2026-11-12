// The door-to-door map (docs/CRM-MAP.md): pin types, pins (drop, knock
// again, correct, note, delete, offline replay), customers and leads on the
// map, Convert to lead (contacts.intake with source Door to Door, the
// canvasser as owner, the follow-up the sales rules start), territories
// (point in polygon), the leaderboard and report, and who may do what
// (a technician only when an owner turns it on). Synthetic people only.
import { test, afterEach } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { crmTest } from "../../helpers/crm-http.mjs";

const store = await import("../../../netlify/lib/crm-store.mjs");
const T = await import("../../../netlify/lib/crm/modules/map/types.mjs");
const PINS = await import("../../../netlify/lib/crm/modules/map/pins.mjs");
const GEO = await import("../../../netlify/lib/crm/modules/map/geo.mjs");
const KIT = await import("../../../crm-app/modules/map/kit.js");
const SEED = await import("../../../netlify/lib/crm/modules/sales/seed.mjs");

let t;
afterEach(() => { if (t) t.done(); t = null; });
const cid = () => randomUUID();
const W = (by) => ({ by, origin: "api", actor_kind: "user", requestId: "map-test" });
const AUTO = { by: "system:test", origin: "worker", actor_kind: "automation", requestId: "map-test" };
const C = { lat: 45.0419, lng: -93.7891 };
const drop = (as, body = {}) => t.api("/map/pins", { method: "POST", as, body: { client_id: cid(), lat: C.lat, lng: C.lng, type_key: "not_home", ...body } });
const pinsOf = () => t.stores.data.keys("rec/pin/");

async function world() {
  t = await crmTest({ now: "2026-11-17T15:00:00Z" });
  const owner = await t.user("owner");
  const admin = await t.user("admin");
  const tech = await t.user("tech");
  const knocker = await t.user("tech", { grants: ["canvass:use"] });
  return { owner, admin, tech, knocker };
}

test("pin types: Barta's defaults when none are saved; Rotor's types get stable keys and outcomes from their names; saved keys and outcomes are kept", async () => {
  assert.deepEqual(T.pinTypesOf({ types: [] }).map((x) => x.key), ["not_home", "not_interested", "interested", "come_back", "booked", "renter", "never_knock"]);
  const rotor = T.pinTypesOf({ types: [
    { rotor_id: "4f0e7a52-3c1d-4b8e-9a6f-0d2c1b3a4e5f", label: "No Answer", color: "#808080" }, { rotor_id: "5a1f8b63-4d2e-4c9f-8b7a-1e3d2c4b5f6a", label: "Not Interested", color: "#FF0000" },
    { rotor_id: "6b2a9c74-5e3f-4dab-9c8b-2f4e3d5c6a7b", label: "Made Sale", color: "#03ad00" }, { rotor_id: "7c3bad85-6f4a-4ebc-ad9c-3a5f4e6d7b8c", label: "Never Knock", color: "#000000" },
    { rotor_id: "8d4cbe96-7a5b-4fcd-be0d-4b6a5f7e8c9d", label: "Go Back", color: "#aa15ef", outcome: "interested", key: "go_back" },
  ] });
  assert.deepEqual(rotor.map((x) => x.outcome), ["not_home", "not_interested", "booked", "skip", "interested"]);
  assert.match(rotor[0].key, /^r_4f0e7a52_3c1d/, "from Rotor's id: the same key on every read");
  assert.equal(rotor[4].key, "go_back", "a saved key wins");
  assert.equal(T.inferOutcome("Come Back Later"), "talked");
  assert.equal(T.inferOutcome("Interested"), "interested");

  const { owner } = await world();
  // the comms setting keeps key and outcome now (and still drops anything else)
  const put = await t.api("/settings/pin_types", { method: "PUT", as: owner, ifMatch: "new", body: { types: [{ label: "Knocked", color: "#808080", key: "knocked", outcome: "not_home", junk: 1 }, { label: "Sold", color: "#03ad00", outcome: "bogus" }] } });
  assert.equal(put.status, 200, JSON.stringify(put.body));
  const saved = t.stores.data.json("cfg/pin_types").types;
  assert.deepEqual(saved[0], { rotor_id: "", label: "Knocked", color: "#808080", active: true, key: "knocked", outcome: "not_home" });
  assert.equal(saved[1].outcome, undefined, "an outcome that isn't one is dropped (worked out from the name)");
  const start = await t.api("/map/knock", { as: owner });
  assert.deepEqual(start.body.data.types.map((x) => [x.key, x.outcome]), [["knocked", "not_home"], ["l_sold", "booked"]]);
});

test("dropping a pin: one knock now, its type's label and color kept; the same client id again is the same pin; a type that isn't one is refused", async () => {
  const { owner } = await world();
  const client = cid();
  const a = await t.api("/map/pins", { method: "POST", as: owner, body: { client_id: client, lat: C.lat, lng: C.lng, type_key: "interested", note: "Two stories, wants gutters too.", follow_up_on: "2026-11-20", address: { street1: "100 Example Ave", city: "Delano", state: "MN", zip: "55328" }, address_source: "reverse" } });
  assert.equal(a.status, 201, JSON.stringify(a.body));
  const p = a.body.data;
  assert.equal(p.outcome, "interested");
  assert.equal(p.type_label, "Interested");
  assert.equal(p.knocks.length, 1);
  assert.equal(p.knocks[0].at, "2026-11-17T15:00:00.000Z");
  assert.equal(p.canvasser_id, owner.id);
  assert.equal(p.address_source, "reverse");
  const again = await t.api("/map/pins", { method: "POST", as: owner, body: { client_id: client, lat: C.lat, lng: C.lng, type_key: "booked" } });
  assert.ok([200, 201].includes(again.status));
  assert.equal(again.body.data.id, p.id);
  assert.equal(again.body.data.type_key, "interested", "a retry changes nothing");
  assert.equal(pinsOf().length, 1);
  for (const [body, field] of [[{ type_key: "nope" }, "type_key"], [{ lat: 95 }, "lat"], [{ client_id: undefined }, "client_id"]]) {
    const r = await t.api("/map/pins", { method: "POST", as: owner, body: { client_id: cid(), lat: C.lat, lng: C.lng, type_key: "not_home", ...body } });
    assert.equal(r.status, 400, JSON.stringify(body));
    assert.equal(r.body.error.field, field);
  }
  // the index row the map reads: no note, no address
  const ix = JSON.stringify(t.stores.data.json("ix/pins/2026"));
  assert.match(ix, /"t":"interested"/);
  assert.ok(!ix.includes("gutters") && !ix.includes("Delano"), "no note in the index, and of the address only the street (the map's search)");
});

test("a pin dropped with no signal arrives later once, at the phone's time; one with a week-old time is kept but marked unverified", async () => {
  const { knocker } = await world();
  const client = cid();
  const body = { client_id: client, lat: C.lat, lng: C.lng, type_key: "not_home", queued_offline: true, client_at: "2026-11-17T14:20:00.000Z", queued_at: "2026-11-17T14:20:00.000Z" };
  const a = await t.api("/map/pins", { method: "POST", as: knocker, body, headers: { "x-crm-sent-at": "2026-11-17T15:00:00.000Z" } });
  assert.equal(a.status, 201, JSON.stringify(a.body));
  assert.equal(a.body.data.knocks[0].at, "2026-11-17T14:20:00.000Z");
  assert.equal(a.body.data.knocks[0].unverified, undefined);
  const b = await t.api("/map/pins", { method: "POST", as: knocker, body });
  assert.equal(b.body.data.id, a.body.data.id, "the replay of a pin that landed is a no-op");
  const old = await t.api("/map/pins", { method: "POST", as: knocker, body: { ...body, client_id: cid(), client_at: "2026-11-01T14:20:00.000Z", queued_at: "2026-11-01T14:20:00.000Z" } });
  assert.equal(old.body.data.knocks[0].unverified, true);
  assert.equal(pinsOf().length, 2);
});

test("knocks: a same-day change by the same person corrects that knock; Knocked again adds one; a replayed change is one change; note, go-back date and address set and clear", async () => {
  const { owner, admin } = await world();
  const p = (await drop(owner)).body.data;
  const patch = (as, body, client = cid()) => t.api(`/map/pins/${p.id}`, { method: "PATCH", as, body: { client_id: client, ...body } });
  let r = await patch(owner, { type_key: "interested" });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body.data.knocks.length, 1, "a correction, not a second knock");
  assert.equal(r.body.data.knocks[0].outcome, "interested");
  r = await patch(owner, { type_key: "interested", knock: true });
  assert.equal(r.body.data.knocks.length, 2);
  const client = cid();
  r = await patch(admin, { type_key: "booked" }, client);
  assert.equal(r.body.data.knocks.length, 3, "someone else's knock counts");
  r = await patch(admin, { type_key: "booked" }, client);
  assert.equal(r.body.data.knocks.length, 3, "the same change replayed");
  r = await patch(owner, { note: "Call after 5.", follow_up_on: "2026-11-19", address: { street1: "101 Example Ave", city: "Delano" } });
  assert.equal(r.body.data.note, "Call after 5.");
  assert.equal(r.body.data.follow_up_on, "2026-11-19");
  assert.equal(r.body.data.address_source, "typed");
  r = await patch(owner, { note: "", follow_up_on: null, address: null });
  assert.equal(r.body.data.note, undefined);
  assert.equal(r.body.data.follow_up_on, undefined);
  assert.equal(r.body.data.address, undefined);
  assert.equal((await patch(owner, { follow_up_on: "soon" })).status, 400);
  assert.equal((await t.api(`/map/pins/pn_00000000000000000000`, { method: "PATCH", as: owner, body: { client_id: cid(), type_key: "booked" } })).status, 404);
});

test("pure knock rules: applyKnock corrects or adds; the next day is a new knock", () => {
  const type = (key, outcome) => ({ key, label: key, color: "#000000", outcome });
  const base = { type_key: "not_home", knocks: [{ at: "2026-11-17T15:00:00.000Z", by: "us_a", type_key: "not_home", outcome: "not_home" }] };
  assert.equal(PINS.applyKnock(base, type("interested", "interested"), { by: "us_a", at: "2026-11-17T18:00:00.000Z" }).knocks.length, 1);
  assert.equal(PINS.applyKnock(base, type("interested", "interested"), { by: "us_a", at: "2026-11-18T14:00:00.000Z" }).knocks.length, 2);
  assert.equal(PINS.applyKnock(base, type("not_home", "not_home"), { by: "us_a", at: "2026-11-18T14:00:00.000Z" }), base, "nothing new");
  assert.equal(PINS.applyKnock(base, type("not_home", "not_home"), { by: "us_a", at: "2026-11-17T16:00:00.000Z", knock: true }).knocks.length, 2);
});

test("deleting a pin: the person who dropped it, the same day; a manager any time; never a pin that became a lead", async () => {
  const { owner, knocker } = await world();
  const mine = (await drop(knocker)).body.data;
  const theirs = (await drop(owner)).body.data;
  assert.equal((await t.api(`/map/pins/${theirs.id}`, { method: "DELETE", as: knocker })).status, 403);
  assert.equal((await t.api(`/map/pins/${mine.id}`, { method: "DELETE", as: knocker })).status, 200);
  assert.equal((await t.api(`/map/pins/${mine.id}`, { as: knocker })).status, 404);
  assert.equal((await t.api(`/map/pins/${theirs.id}`, { method: "DELETE", as: owner })).status, 200);
  const rows = (await t.api("/map/pins", { as: owner })).body.data.pins;
  assert.equal(rows.length, 0, "deleted pins leave the map");
});

test("the map's pins and places: a box, last year's pins too; customers and open leads with a map point, names only for the office", async () => {
  const { owner, knocker } = await world();
  await drop(owner, { lat: 45.05, lng: -93.80 });
  await drop(owner, { lat: 44.90, lng: -93.50 });
  await store.createRecord("pin", { ...T.pinType.example(), canvasser_id: owner.id, knocks: [{ at: "2025-06-01T15:00:00.000Z", by: owner.id, type_key: "not_home", outcome: "not_home" }] }, W(owner.id));
  let r = await t.api("/map/pins", { as: owner });
  assert.equal(r.body.data.pins.length, 3, "this year's and last year's");
  r = await t.api("/map/pins?bbox=-93.9,45.0,-93.7,45.1", { as: owner });
  assert.equal(r.body.data.pins.length, 2);
  assert.equal((await t.api("/map/pins?bbox=-99,40,-90,46", { as: owner })).status, 400, "too big a box");

  const person = async (n, lifecycle, flags = {}) => {
    const c = (await store.createRecord("contact", { first_name: "Map", last_name: `Person${n}`, phones: [{ e164: `+1763555${String(3100 + n)}`, sms: true }], lifecycle, source: { source: "Referral" }, flags }, W(owner.id))).data;
    await store.createRecord("property", { contact_id: c.id, label: "Home", address: { street1: `${n} Example Ave`, city: "Delano", state: "MN", zip: "55328" }, access: {}, geo: { lat: 45.04 + n / 1000, lng: -93.79, source: "manual" } }, W(owner.id));
    return c;
  };
  const cust = await person(1, "customer");
  await person(2, "lead");
  await person(3, "customer", { test: true });
  await person(4, "archived");
  await store.createRecord("property", { contact_id: cust.id, label: "Cabin", address: { street1: "9 Sample St", city: "Mound", state: "MN", zip: "55364" }, access: {} }, W(owner.id));
  r = await t.api("/map/places", { as: owner });
  assert.deepEqual(r.body.data.places.map((p) => p.k).sort(), ["customer", "lead"], "no test, archived or unmapped ones");
  assert.ok(r.body.data.places.every((p) => p.n && p.c && p.a), "the office sees names");
  r = await t.api("/map/places", { as: knocker });
  assert.equal(r.status, 200);
  assert.deepEqual(Object.keys(r.body.data.places[0]).sort(), ["k", "la", "ln"], "a technician sees only that someone is a customer");
  assert.doesNotMatch(r.text, /ct_[0-9a-z]{20}|Person1|Example Ave/);
});

test("Convert to lead: contacts.intake with source Door to Door, the pin's address and the canvasser as owner; the pin's map point on the property; once", async () => {
  const { owner, knocker } = await world();
  await SEED.seedCadences({ write: () => AUTO });
  const p = (await drop(knocker, { type_key: "interested", address: { street1: "212 Example Ave", city: "Delano", state: "MN", zip: "55328" }, note: "Wants a quote for windows and gutters." })).body.data;
  assert.equal((await t.api(`/map/pins/${p.id}/convert`, { method: "POST", as: knocker, body: { client_id: cid(), first_name: "Pat" } })).status, 400, "a phone or an email first");
  const r = await t.api(`/map/pins/${p.id}/convert`, { method: "POST", as: knocker, body: { client_id: cid(), first_name: "Pat", last_name: "Doorstep", phone: "763-555-0142", sms_consent: true } });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body.data.created, true);
  assert.equal(r.body.data.contact_id, undefined, "a technician isn't told the contact's id");
  const pin = (await store.getRecord("pin", p.id)).data;
  assert.ok(pin.contact_id && pin.property_id && pin.converted_by === knocker.id);
  const c = (await store.getRecord("contact", pin.contact_id)).data;
  assert.equal(c.source.source, "Door to Door");
  assert.equal(c.owner_id, knocker.id, "the canvasser owns the lead");
  assert.equal(c.lifecycle, "lead");
  assert.ok(c.tags.includes("Door to door"));
  assert.match(c.notes, /At the door: Wants a quote/);
  assert.equal(c.consent.sms_service.state, "granted");
  const prop = (await store.getRecord("property", pin.property_id)).data;
  assert.equal(prop.address.street1, "212 Example Ave");
  assert.deepEqual([prop.geo.lat, prop.geo.lng, prop.geo.source], [pin.lat, pin.lng, "pin"]);
  // the sales module's rules: the seeded New lead cadence takes other sources, so no automatic follow-up
  assert.equal(r.body.data.enrolled, false);
  const again = await t.api(`/map/pins/${p.id}/convert`, { method: "POST", as: owner, body: { client_id: cid(), first_name: "Pat", phone: "763-555-0142" } });
  assert.equal(again.body.data.already, true);
  assert.equal(again.body.data.contact_id, pin.contact_id, "the office is told which contact");
  assert.equal(t.stores.data.keys("rec/contact/").length, 1);
  // the office's view of the pin names the lead; the technician's doesn't
  const asOffice = await t.api(`/map/pins/${p.id}`, { as: owner });
  assert.equal(asOffice.body.data.contact.id, pin.contact_id);
  const asTech = await t.api(`/map/pins/${p.id}`, { as: knocker });
  assert.equal(asTech.body.data.contact_id, undefined);
  assert.equal(asTech.body.data.contact, undefined);
});

test("Convert to lead starts the follow-up when the owner adds Door to Door to the New lead cadence; a phone already on file joins that contact without changing its owner", async () => {
  const { owner, knocker } = await world();
  await SEED.seedCadences({ write: () => AUTO });
  const cad = (await store.getRecord("cadence", await SEED.seedCadenceId("new_lead"))).data;
  await store.updateRecord("cadence", cad.id, (x) => ({ ...x, entry: { ...x.entry, sources: [...x.entry.sources, "Door to Door"] } }), W(owner.id));
  const p = (await drop(knocker, { address: { street1: "300 Example Ave", city: "Delano", zip: "55328" } })).body.data;
  const r = await t.api(`/map/pins/${p.id}/convert`, { method: "POST", as: owner, body: { client_id: cid(), first_name: "Lee", last_name: "Knocked", phone: "763-555-0143" } });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body.data.enrolled, true);
  const en = t.stores.data.keys("rec/enrollment/");
  assert.equal(en.length, 1);
  assert.equal(t.stores.data.json(en[0]).owner_id, owner.id, "the enrollment belongs to the canvasser too");

  const known = (await store.createRecord("contact", { first_name: "Known", last_name: "Customer", phones: [{ e164: "+17635550144", sms: true }], lifecycle: "customer", source: { source: "Referral" }, owner_id: knocker.id }, W(owner.id))).data;
  const q = (await drop(owner, { lat: 45.05, address: { street1: "302 Example Ave", city: "Delano", zip: "55328" } })).body.data;
  const r2 = await t.api(`/map/pins/${q.id}/convert`, { method: "POST", as: owner, body: { client_id: cid(), first_name: "Known", phone: "(763) 555-0144" } });
  assert.equal(r2.body.data.created, false);
  assert.equal(r2.body.data.contact_id, known.id);
  assert.equal((await store.getRecord("contact", known.id)).data.owner_id, knocker.id, "an existing contact keeps its owner");
});

test("territories: an owner draws one and assigns it; a canvasser sees theirs lit; pins inside count toward it (point in polygon); edits need If-Match", async () => {
  const { owner, knocker, tech } = await world();
  const square = [[-93.80, 45.03], [-93.78, 45.03], [-93.78, 45.05], [-93.80, 45.05]];
  assert.equal((await t.api("/map/territories", { method: "POST", as: knocker, body: { name: "Mine", polygon: square } })).status, 403, "drawing is canvass:manage");
  assert.equal((await t.api("/map/territories", { method: "POST", as: owner, body: { name: "Bad", polygon: square.slice(0, 2) } })).status, 400);
  assert.equal((await t.api("/map/territories", { method: "POST", as: owner, body: { name: "Bad", polygon: square, assignee_ids: ["us_00000000000000000000"] } })).status, 400);
  const made = await t.api("/map/territories", { method: "POST", as: owner, body: { name: "North Delano", color: "#2563eb", polygon: [...square, square[0]], assignee_ids: [knocker.id] } });
  assert.equal(made.status, 201, JSON.stringify(made.body));
  assert.equal(made.body.data.polygon.length, 4, "a closed ring is kept open");
  let list = (await t.api("/map/territories", { as: knocker })).body.data;
  assert.deepEqual(list.map((x) => [x.name, x.mine]), [["North Delano", true]]);
  assert.equal((await t.api("/map/territories", { as: tech })).status, 403);
  // pins inside and outside
  await drop(knocker, { lat: 45.04, lng: -93.79, type_key: "interested" });
  await drop(knocker, { lat: 45.04, lng: -93.70 });
  const pin = (await drop(owner, { lat: 45.035, lng: -93.785, type_key: "booked" })).body.data;
  const got = await t.api(`/map/pins/${pin.id}`, { as: knocker });
  assert.deepEqual(got.body.data.territories.map((x) => x.name), ["North Delano"]);
  const rep = (await t.api(`/map/report?from=2026-11-17&to=2026-11-17&territory=${made.body.data.id}`, { as: owner })).body.data;
  assert.deepEqual([rep.territories[0].doors, rep.territories[0].conversations, rep.territories[0].booked, rep.totals.doors], [2, 2, 1, 2]);
  assert.equal((await t.api(`/map/territories/${made.body.data.id}`, { method: "PATCH", as: owner, body: { name: "North" } })).status, 400, "If-Match");
  const cur = await t.api(`/map/territories/${made.body.data.id}`, { as: owner });
  const ok = await t.api(`/map/territories/${made.body.data.id}`, { method: "PATCH", as: owner, ifMatch: cur.headers.get("etag") || JSON.parse(cur.text).etag, body: { name: "North", assignee_ids: [] } });
  assert.ok([200].includes(ok.status), JSON.stringify(ok.body));
  list = (await t.api("/map/territories", { as: knocker })).body.data;
  assert.deepEqual(list.map((x) => [x.name, x.mine]), [["North", false]]);
  assert.equal((await t.api(`/map/territories/${made.body.data.id}`, { method: "DELETE", as: owner })).status, 200);
  assert.equal((await t.api("/map/territories", { as: owner })).body.data.length, 0);
});

test("point in polygon: inside, outside, on an edge, a concave shape; the client's copy agrees", () => {
  const sq = [[0, 0], [10, 0], [10, 10], [0, 10]];
  const ell = [[0, 0], [10, 0], [10, 3], [3, 3], [3, 10], [0, 10]];
  const cases = [[[5, 5], sq, true], [[15, 5], sq, false], [[10, 5], sq, true], [[0, 0], sq, true], [[5, 5], ell, false], [[1, 8], ell, true], [[8, 1], ell, true], [[NaN, 1], sq, false], [[1, 1], sq.slice(0, 2), false]];
  for (const [pt, poly, want] of cases) {
    assert.equal(GEO.pointInPolygon(pt, poly), want, JSON.stringify(pt));
    assert.equal(KIT.pointInPolygon(pt, poly), want, "client " + JSON.stringify(pt));
  }
  assert.deepEqual(GEO.parseBbox("-93.9,45,-93.7,45.1"), [-93.9, 45, -93.7, 45.1]);
  assert.equal(GEO.parseBbox("1,2,3"), null);
  assert.equal(GEO.thin(Array.from({ length: 10 }, (_, i) => i), 6).length, 6);
  assert.deepEqual(GEO.thin(Array.from({ length: 10 }, (_, i) => i), 6).slice(-3), [7, 8, 9], "the newest kept whole");
});

test("the leaderboard and report: doors (every knock), conversations, leads (conversions), booked, per person, per day or week, per area", () => {
  const rows = [
    { la: 1, ln: 1, k: [["2026-11-16", "us_a", "not_home"], ["2026-11-17", "us_a", "interested"]], cv: "2026-11-17", cb: "us_a" },
    { la: 1, ln: 1, k: [["2026-11-17", "us_b", "booked"]] },
    { la: 5, ln: 5, k: [["2026-11-17", "us_b", "skip"], ["2026-11-10", "us_b", "talked"]] },
    { la: 1, ln: 1, k: [["2026-11-15", "us_a", "not_interested"]] },
  ];
  const users = [{ id: "us_a", name: "Ann" }, { id: "us_b", name: "Bo" }];
  const terr = [{ id: "tr_a", n: "Square", p: [[0, 0], [2, 0], [2, 2], [0, 2]] }];
  const r = PINS.buildReport(rows, { from: "2026-11-15", to: "2026-11-17", group: "day", users, territories: terr });
  assert.deepEqual(r.totals, { doors: 5, conversations: 3, leads: 1, booked: 1 });
  assert.deepEqual(r.people.map((p) => [p.name, p.doors, p.conversations, p.leads, p.booked]), [["Ann", 3, 2, 1, 0], ["Bo", 2, 1, 0, 1]]);
  assert.deepEqual(r.periods.map((p) => [p.key, p.doors]), [["2026-11-15", 1], ["2026-11-16", 1], ["2026-11-17", 3]]);
  assert.deepEqual([r.territories[0].doors, r.territories[0].pins, r.territories[0].leads], [4, 3, 1]);
  const w = PINS.buildReport(rows, { from: "2026-11-01", to: "2026-11-17", group: "week", users, territories: [] });
  assert.deepEqual(w.periods.map((p) => [p.key, p.doors]), [["2026-11-08", 1], ["2026-11-15", 5]]);
});

test("the report through the API, and who may knock: a technician only when an owner turned it on; the team map and drawing are the office's", async () => {
  const { owner, admin, tech, knocker } = await world();
  await drop(knocker, { type_key: "booked" });
  await drop(owner);
  const rep = await t.api("/map/report?from=2026-11-17&to=2026-11-17", { as: knocker });
  assert.equal(rep.status, 200, JSON.stringify(rep.body));
  assert.deepEqual(rep.body.data.totals, { doors: 2, conversations: 1, leads: 0, booked: 1 });
  assert.equal((await t.api("/map/report?from=2026-11-18&to=2026-11-01", { as: owner })).status, 400);
  for (const [path, method] of [["/map/knock", "GET"], ["/map/pins", "GET"], ["/map/places", "GET"], ["/map/report", "GET"], ["/map/territories", "GET"], ["/map/team", "GET"], ["/map/reverse?lat=45&lng=-93", "GET"]]) {
    assert.equal((await t.api(path, { method, as: tech })).status, 403, `${path}: a technician without the switch`);
  }
  assert.equal((await drop(tech)).status, 403);
  assert.equal((await t.api("/map/knock", { as: admin })).status, 200, "the office knocks too");
  assert.equal((await t.api("/map/team", { as: knocker })).status, 403, "knocking doesn't open the team map");
  // turning it on per person goes through the user's grants (owners only)
  const u = await t.api(`/users/${tech.id}`, { as: owner });
  const g = await t.api(`/users/${tech.id}`, { method: "PATCH", as: owner, ifMatch: u.headers.get("etag"), body: { grants: ["canvass:use"] } });
  assert.equal(g.status, 200, JSON.stringify(g.body));
  const fresh = await t.user("tech", { grants: ["canvass:use"] });
  assert.equal((await t.api("/map/knock", { as: fresh })).status, 200);
});
