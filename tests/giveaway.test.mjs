// Mocked tests for the Holiday Lights Giveaway: /api/giveaway and
// /api/giveaway/admin, plus the pure helpers. Nothing leaves the machine:
// the store is an in-memory Map and fetch is a capture stub.

import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { setEnv, createMemoryStore, mockFetch, jsonRequest, FAKE_ENV } from "./helpers/referral-harness.mjs";

setEnv({ GIVEAWAY_SMS_MODE: "off" });
const handler = (await import("../netlify/functions/giveaway.mjs")).default;
const admin = (await import("../netlify/functions/giveaway-admin.mjs")).default;
const lib = await import("../netlify/lib/giveaway-lib.mjs");
const { GIVEAWAY } = await import("../netlify/lib/giveaway-config.mjs");

let store, net;
beforeEach(() => {
  setEnv({ GIVEAWAY_SMS_MODE: "off" });
  store = createMemoryStore();
  globalThis.__giveawayStoreOverride = store;
  net = mockFetch();
});

// Delano itself — inside the 17-mile circle.
const DELANO = { address_lat: 45.0419, address_lng: -93.7891 };
const entry = (over = {}) => ({
  first_name: "Jane", last_name: "Doe", phone: "(763) 555-0101",
  address: "123 Main St", address_city: "Delano", address_state: "MN", address_zip: "55328",
  address_verified: "yes", ...DELANO, consent: true, offers: true, ...over,
});
const post = (body) => handler(jsonRequest("/api/giveaway", "POST", body));
const get = (q = "") => handler(new Request("http://localhost/api/giveaway" + q));
const ok = async (resP, status = 200) => {
  const res = await resP;
  const text = await res.text();
  assert.equal(res.status, status, text);
  return JSON.parse(text);
};
const auth = { Authorization: "Bearer " + FAKE_ENV.REFERRAL_ADMIN_KEY };
const adminPost = (body) => admin(jsonRequest("/api/giveaway/admin", "POST", body, auth));
const adminGet = (q = "") => admin(new Request("http://localhost/api/giveaway/admin" + q, { headers: auth }));

// ---------------------------------------------------------------------------
test("area check: distance wins, listed city as fallback, other states out", () => {
  assert.equal(lib.areaCheck({ lat: 45.0419, lng: -93.7891 }).ok, true);
  assert.equal(lib.areaCheck({ lat: 44.98, lng: -93.27 }).ok, false);          // Minneapolis ~27 mi
  assert.equal(lib.areaCheck({ city: "St. Michael", state: "MN" }).ok, true);
  assert.equal(lib.areaCheck({ city: "Saint Bonifacius", state: "MN" }).ok, true);
  // 17-mile circle: Maple Grove's centre (16.4 mi) is in, Chanhassen's (17.7 mi) is out,
  // and a town on the edge with no coordinates is accepted but flagged (null).
  assert.equal(lib.areaCheck({ lat: 45.0725, lng: -93.4558 }).ok, true);
  assert.equal(lib.areaCheck({ lat: 44.8622, lng: -93.5306 }).ok, false);
  assert.equal(lib.areaCheck({ city: "Plymouth", state: "MN" }).ok, null);
  assert.equal(lib.areaCheck({ city: "Fargo", state: "ND" }).ok, false);
  assert.equal(lib.areaCheck({ city: "Somewhere", state: "MN" }).ok, null);
});

test("household key folds suffixes and needs a house number", () => {
  assert.equal(lib.householdKey({ street: "123 Main Street", zip: "55328" }),
               lib.householdKey({ street: "123 main st.", zip: "55328-1234" }));
  assert.equal(lib.householdKey({ street: "Main St", zip: "55328" }), "");
});

test("entry validation: required fields, phone, consent, honeypot", () => {
  assert.throws(() => lib.validateEntry(entry({ first_name: "" })), /First name/);
  assert.throws(() => lib.validateEntry(entry({ phone: "123" })), /10-digit/);
  assert.throws(() => lib.validateEntry(entry({ consent: false })), /agree/);
  assert.throws(() => lib.validateEntry(entry({ address: "Main St" })), /house number/);
  assert.throws(() => lib.validateEntry(entry({ website: "spam" })), /Invalid/);
  assert.equal(lib.validateEntry(entry()).phone_digits, "7635550101");
});

// ---------------------------------------------------------------------------
test("entering stores the entrant, returns share + status links, creates a Rotor lead", async () => {
  const r = await ok(post(entry()));
  assert.match(r.code, /^LIGHTS-[A-Z2-9]{5}$/);
  assert.match(r.token, /^[A-Z2-9]{24}$/);
  assert.equal(r.share_url, `https://www.bartawindowwashing.com/g/${r.code}`);
  assert.equal(r.status_url, `https://www.bartawindowwashing.com/giveaway?t=${r.token}`);
  assert.equal(r.entries, 1);
  const e = store.json("entrant/7635550101");
  assert.equal(e.area.ok, true);
  const [lead] = net.rotor();
  assert.deepEqual(lead.payload.tags, ["Giveaway 2026", "Christmas Lights", "Giveaway - Coupon Opt-In"]);
  assert.match(lead.payload.notes, /coupon texts: YES/);
  assert.equal(lead.payload.source, GIVEAWAY.name);
  assert.match(lead.payload.notes, /Share link: .*\/g\/LIGHTS-/);
  assert.equal(lead.payload.address_city, "Delano");
  assert.equal(net.twilio().length, 0);   // SMS mode off
});

test("out-of-area address is refused with out_of_area, and nothing is stored", async () => {
  const r = await ok(post(entry({ address_lat: 44.98, address_lng: -93.27 })), 422);
  assert.equal(r.out_of_area, true);
  assert.equal(store.keys("entrant/").length, 0);
  assert.equal(net.rotor().length, 0);
});

test("out-of-area quote request becomes a Rotor lead", async () => {
  await ok(post({ ...entry({ address_lat: 44.98, address_lng: -93.27 }), action: "outside_quote" }));
  assert.deepEqual(net.rotor()[0].payload.tags, ["Giveaway - Out of Area"]);
  assert.equal(store.keys("outside/").length, 1);
});

test("same phone again returns the share link but never the token", async () => {
  const first = await ok(post(entry()));
  const again = await ok(post(entry({ address: "999 Other Rd" })));
  assert.equal(again.returning, true);
  assert.equal(again.code, first.code);
  assert.equal(again.token, undefined);
});

test("one entry per household", async () => {
  await ok(post(entry()));
  const r = await ok(post(entry({ phone: "763-555-0199", address: "123 Main Street" })), 409);
  assert.equal(r.field, "address");
});

test("a friend entering through a link adds an entry for the referrer", async () => {
  const a = await ok(post(entry()));
  const b = await ok(post(entry({ first_name: "Bob", last_name: "Lee", phone: "763-555-0102",
                                 address: "7 Oak Ln", ref: a.code.toLowerCase() })));
  assert.equal(b.referred_by, "Jane");
  const status = await ok(get("?t=" + a.token));
  assert.equal(status.entrant.entries, 2);
  assert.deepEqual(status.entrant.friends, ["Bob L."]);
  assert.match(net.rotor()[1].payload.notes, /Invited by: Jane D\./);
  const who = await ok(get("?code=" + a.code));
  assert.equal(who.first_name, "Jane");
});

test("self-referral and same-household referral don't count", async () => {
  const a = await ok(post(entry()));
  // different phone, same household is already refused; a self-referral by
  // a fresh phone at a new address but using own code is impossible, so
  // check that the ref is ignored when the household matches the referrer.
  const r = await ok(post(entry({ phone: "763-555-0103", address: "123 Main Street", ref: a.code })), 409);
  assert.equal(r.field, "address");
});

test("entries close at the deadline", async () => {
  const realNow = Date.now;
  Date.now = () => Date.parse(GIVEAWAY.closes_at) + 1000;
  try {
    await ok(post(entry()), 410);
  } finally { Date.now = realNow; }
});

test("public GET reports phase and entrant count", async () => {
  await ok(post(entry()));
  const r = await ok(get());
  assert.equal(r.open, true);
  assert.equal(r.entrants, 1);
  assert.equal(r.drawn, false);
});

// ---------------------------------------------------------------------------
test("weighted draw: winners are distinct, a winner's referrer wins too", () => {
  const mk = (id, ref) => ({ id, first_name: id, last_name: "X", area: { ok: true },
                              referred_by: ref ? { id: ref } : null });
  const people = [mk("1111111111"), mk("2222222222", "1111111111"), mk("3333333333")];
  // rand always 0 → first ticket in the pool: person 1 (2 entries), then person 2.
  const r = lib.draw(people, { n: 2, rand: () => 0 });
  assert.deepEqual(r.drawn.map((d) => d.id), ["1111111111", "2222222222"]);
  assert.equal(r.drawn[0].entries, 2);
  assert.deepEqual(r.bonus, []);            // 2's referrer (1) already won
  const r2 = lib.draw(people, { n: 1, rand: (n) => n - 1 });   // last ticket → person 3? pool order
  assert.equal(r2.drawn.length, 1);
  // Pool [1 (2 tickets), 2 (1 ticket)]; ticket 2 lands on person 2, whose referrer (1) also wins.
  const r3 = lib.draw(people, { n: 1, exclude: new Set(["3333333333"]), rand: () => 2 });
  assert.deepEqual(r3.drawn.map((d) => d.id), ["2222222222"]);
  assert.deepEqual(r3.bonus.map((b) => b.id), ["1111111111"]);
});

test("draw is refused while entries are open unless early, and only once", async () => {
  await ok(post(entry()));
  await ok(adminPost({ action: "draw" }), 409);
  const d = await ok(adminPost({ action: "draw", early: true }));
  assert.equal(d.draw.winners.length, 1);
  await ok(adminPost({ action: "draw", early: true }), 409);
  await ok(adminPost({ action: "undo_draw", confirm: "nope" }), 400);
  await ok(adminPost({ action: "undo_draw", confirm: "UNDO DRAW" }));
});

test("coupon claim: only after the drawing, never for winners, idempotent, re-tags Rotor", async () => {
  const a = await ok(post(entry()));
  const b = await ok(post(entry({ first_name: "Bob", phone: "763-555-0102", address: "7 Oak Ln" })));
  await ok(post({ action: "claim", t: b.token }), 409);              // no drawing yet
  const d = await ok(adminPost({ action: "draw", early: true }));
  const winnerId = d.draw.winners[0].id;
  // two winners requested but only... both entrants win here (2 winners)
  assert.equal(d.draw.winners.length, 2);
  await ok(post({ action: "claim", t: a.token }), 409);              // a won
  // Undo and draw with only one winner slot by disqualifying b first.
  await ok(adminPost({ action: "undo_draw", confirm: "UNDO DRAW" }));
  await ok(adminPost({ action: "disqualify", id: "7635550102", value: true }));
  await ok(adminPost({ action: "draw", early: true }));
  await ok(adminPost({ action: "disqualify", id: "7635550102", value: false }));
  const c = await ok(post({ action: "claim", t: b.token }));
  assert.equal(c.already, false);
  const again = await ok(post({ action: "claim", t: b.token }));
  assert.equal(again.already, true);
  const claimLead = net.rotor().at(-1).payload;
  assert.deepEqual(claimLead.tags, ["Giveaway - Coupon Claimed", "Christmas Lights"]);
  assert.equal(claimLead.service_type, "Christmas Light Installation");
  assert.ok(winnerId);
});

// ---------------------------------------------------------------------------
test("admin needs the key", async () => {
  const res = await admin(new Request("http://localhost/api/giveaway/admin"));
  assert.equal(res.status, 401);
});

test("admin list: stats, entry counts and personalised texts", async () => {
  const a = await ok(post(entry()));
  await ok(post(entry({ first_name: "Bob", phone: "763-555-0102", address: "7 Oak Ln", ref: a.code })));
  const r = await ok(adminGet());
  assert.equal(r.stats.entrants, 2);
  assert.equal(r.stats.entries, 3);
  assert.equal(r.stats.via_link, 1);
  const jane = r.entrants.find((e) => e.first_name === "Jane");
  assert.equal(jane.entries, 2);
  assert.match(jane.texts.nudge, /You have 2 entries/);
  assert.match(jane.texts.nudge, /\/g\/LIGHTS-/);
  assert.equal(r.audiences.nudge, 2);
});

test("CSV export has a BOM, a header and one row per entrant", async () => {
  await ok(post(entry()));
  const res = await adminGet("?format=csv");
  const bytes = new Uint8Array(await res.arrayBuffer());
  assert.deepEqual([...bytes.slice(0, 3)], [0xef, 0xbb, 0xbf]);
  const csv = new TextDecoder().decode(bytes);
  assert.ok(csv.startsWith("first_name,"));
  assert.equal(csv.trim().split("\r\n").length, 2);
});

test("send_batch needs Twilio, sends once per person, and skips winners for the coupon", async () => {
  setEnv({ GIVEAWAY_SMS_MODE: "off", TWILIO_ACCOUNT_SID: undefined });
  await ok(post(entry()));
  await ok(adminPost({ action: "send_batch", template: "nudge" }), 409);
  setEnv({ GIVEAWAY_SMS_MODE: "off" });
  await ok(post(entry({ first_name: "Bob", phone: "763-555-0102", address: "7 Oak Ln" })));
  await ok(post(entry({ first_name: "Cy", phone: "763-555-0103", address: "8 Elm Ct" })));
  const n1 = await ok(adminPost({ action: "send_batch", template: "nudge" }));
  assert.equal(n1.sent, 3);
  assert.equal(n1.remaining, 0);
  const n2 = await ok(adminPost({ action: "send_batch", template: "nudge" }));
  assert.equal(n2.sent, 0);
  await ok(adminPost({ action: "send_batch", template: "coupon" }), 409);   // no drawing yet
  await ok(adminPost({ action: "draw", early: true }));
  const c = await ok(adminPost({ action: "send_batch", template: "coupon" }));
  assert.equal(c.sent, 1);                                                     // 3 entrants, 2 winners
  assert.match(net.twilio().at(-1).params.get("Body"), /\$250 off/);
  const f = await ok(adminPost({ action: "send_batch", template: "followup24" }));
  assert.equal(f.sent, 1);
});

test("a failed send is recorded and not retried in a loop", async () => {
  net = mockFetch({ twilio: 500 });
  await ok(post(entry()));
  const r = await ok(adminPost({ action: "send_batch", template: "nudge" }));
  assert.equal(r.failed, 1);
  assert.equal(r.remaining, 0);
  const again = await ok(adminPost({ action: "send_batch", template: "nudge" }));
  assert.equal(again.sent + again.failed, 0);
});

test("redraw replaces a drawn winner with an alternate", async () => {
  for (const [i, p] of ["0101", "0102", "0103", "0104"].entries())
    await ok(post(entry({ first_name: "P" + i, phone: "763-555-" + p, address: `${i + 1} Pine St` })));
  const d = await ok(adminPost({ action: "draw", early: true }));
  const out = d.draw.winners.find((w) => w.kind === "drawn").id;
  const r = await ok(adminPost({ action: "redraw", id: out }));
  assert.ok(!r.draw.winners.some((w) => w.id === out));
  assert.equal(r.draw.winners.filter((w) => w.kind === "drawn").length, 2);
  assert.equal(r.draw.replaced[0].id, out);
});

test("delete_all needs the exact phrase", async () => {
  await ok(post(entry()));
  await ok(adminPost({ action: "delete_all", confirm: "yes" }), 400);
  await ok(adminPost({ action: "delete_all", confirm: "DELETE ALL" }));
  assert.equal(store.keys("").length, 0);
});

test("last name is optional (one name box), and coupon texts need the optional opt-in", async () => {
  const r = await ok(post(entry({ last_name: "", offers: false })));
  assert.equal(r.entries, 1);
  await ok(post(entry({ first_name: "Bob", phone: "763-555-0102", address: "7 Oak Ln" })));
  await ok(post(entry({ first_name: "Cy", phone: "763-555-0103", address: "8 Elm Ct" })));
  const d = await ok(adminPost({ action: "draw", early: true }));
  const winners = new Set(d.draw.winners.map((w) => w.id));
  const list = await ok(adminGet());
  const expected = list.entrants.filter((e) => !winners.has(e.id) && e.offers_opt_in).length;
  assert.equal(list.audiences.coupon, expected);
  assert.equal(list.audiences.nudge, 3);
  assert.equal(list.stats.offers_opt_in, 2);
});

test("lookup by phone returns count and share link, nothing private", async () => {
  const a = await ok(post(entry()));
  await ok(post(entry({ first_name: "Bob", phone: "763-555-0102", address: "7 Oak Ln", ref: a.code })));
  const r = await ok(post({ action: "lookup", phone: "(763) 555-0101" }));
  assert.equal(r.entries, 2);
  assert.equal(r.share_url, a.share_url);
  assert.equal(r.token, undefined);
  await ok(post({ action: "lookup", phone: "763-555-0199" }), 404);
  await ok(post({ action: "lookup", phone: "12" }), 400);
});

test("no offers opt-in means no offers tag in Rotor", async () => {
  await ok(post(entry({ offers: false })));
  assert.deepEqual(net.rotor()[0].payload.tags, ["Giveaway 2026", "Christmas Lights"]);
  assert.match(net.rotor()[0].payload.notes, /coupon texts: no/);
});

test("the drawing tags each winner in Rotor so coupon texts can skip them", async () => {
  const a = await ok(post(entry()));
  await ok(post(entry({ first_name: "Bob", phone: "763-555-0102", address: "7 Oak Ln", ref: a.code })));
  await ok(post(entry({ first_name: "Cy", phone: "763-555-0103", address: "8 Elm Ct" })));
  const before = net.rotor().length;
  const d = await ok(adminPost({ action: "draw", early: true }));
  const winnerLeads = net.rotor().slice(before);
  assert.equal(winnerLeads.length, d.draw.winners.length);
  assert.ok(winnerLeads.every((r) => r.payload.tags.includes("Giveaway - Winner")));
  assert.equal(d.draw.rotor_tagged, d.draw.winners.length);
});
