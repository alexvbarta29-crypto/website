// The "on the way" tracking link (work/track.mjs, portal/track.mjs): On my
// way's text carries a short link; the page shows the tech's first name and
// initials, the vehicle when turned on, the ETA from the tech's shared
// location (team map on, clocked in) or else the arrival window, and a dot
// as a rounded offset from the house while they drive. It never shows
// coordinates, the route, the last stop, or anything once the visit has
// started or 2 hours have passed; an ended link answers 410.
import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { setup, customer, job, visit, outbox, post, live, store, clock, pin } from "./fixtures.mjs";

const TR = await import("../../../netlify/lib/crm/portal/track.mjs");
const PJSON = { "content-type": "application/json", "user-agent": "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 Safari/604.1" };

const HOME = [45.0419, -93.7891];          // the customer's house (Delano)
const LAST_STOP = [45.07, -93.70];          // where the tech tapped On my way (another customer's driveway)
const ON_THE_ROAD = [45.056, -93.745];      // a few kilometres on

const codeIn = (s) => (String(s).match(/\/p\/track\/([0-9A-Za-z]{10})/) || [])[1];
const turnOnMap = (t, owner, people) => t.api("/settings/map", { method: "PUT", as: owner, ifMatch: t.stores.data.has("cfg/map") ? t.stores.data.etagOf("cfg/map") : "new", body: { team_map: { enabled: true, people, every_s: 120, retention_days: 30 } } });
const clockIn = (t, as) => t.api("/clock", { method: "POST", as, body: { action: "in", category: "service", client_id: randomUUID() } });
const pos = (t, as, p, why = "interval") => t.api("/map/position", { method: "POST", as, body: { lat: p[0], lng: p[1], acc: 10, why } });
const data = (t, code) => t.portal(`/api/portal/track/${code}`, { headers: PJSON });

async function onTheWay(t, owner, tech, { geo = HOME } = {}) {
  const c = await customer(owner, {}, { geo });
  const v = await visit(owner, await job(owner, c), { date: "2026-11-17", start: "10:00", end: "12:00", assignee_ids: [tech.id] });
  const body = live({ eta_min: 20, lat: LAST_STOP[0], lng: LAST_STOP[1] });
  const r = await post(t, tech, `/visits/${v.id}/on-my-way`, body);
  assert.equal(r.status, 200, JSON.stringify(r.body));
  return { c, v, r, body, code: codeIn(r.body.data.track_url) };
}

test("On my way texts a short tracking link; the page shows the first name, initials and the arrival window, never the address", async () => {
  const { t, owner, tech } = await setup();
  try {
    const { c, v, r, body, code } = await onTheWay(t, owner, tech);
    assert.ok(code, "the answer carries the link");
    const ob = outbox(t).filter((o) => o.template_key === "on_my_way_track");
    assert.equal(ob.length, 1, "the text with the link (dry-run, in the Outbox)");
    assert.match(ob[0].body, /^Hi Pat, it's Theo with Barta Window Washing\. I'm on my way and should be there in about 20 minutes\. Follow along here: https:\/\/www\.bartawindowwashing\.com\/p\/track\/[0-9A-Za-z]{10}/);
    assert.doesNotMatch(ob[0].body, /—/);
    assert.match(r.body.data.text.hand.body, new RegExp(`/p/track/${code}$`), "the words to send by hand carry the link");
    // a double tap (the same client id) is the same link and one text
    const again = await post(t, tech, `/visits/${v.id}/on-my-way`, body);
    assert.equal(again.status, 200);
    assert.equal(outbox(t).filter((o) => o.template_key === "on_my_way_track").length, 1, "one text");
    assert.equal(t.stores.data.keys("trk/").length, 1, "one link");
    assert.equal(TR.trackCode(v.id, body.client_id), code, "the same tap makes the same code");

    const page = await t.portal(`/p/track/${code}`, { headers: PJSON });
    assert.equal(page.status, 200);
    assert.match(page.headers.get("content-security-policy"), /script-src 'self'/);
    assert.match(page.headers.get("referrer-policy"), /no-referrer/);
    assert.match(page.text, /Theo is on the way/);
    assert.match(page.text, /data-tk-initials>[A-Z]{1,2}</, "initials");
    assert.match(page.text, /Arriving between 10:00 AM and 12:00 PM/);
    assert.match(page.text, /\/crm-app\/portal\/track\.js/);
    assert.doesNotMatch(page.text, /Example Ave|Sample\d|pat\.sample/, "no address, last name or email");
    assert.doesNotMatch(page.text, /<script>(?!<\/script>)/, "no inline script");
    const d = await data(t, code);
    assert.equal(d.status, 200);
    assert.equal(d.body.data.state, "on_the_way");
    assert.equal(d.body.data.eta.source, "window", "the team map is off: the arrival window");
    assert.match(d.body.data.eta.said, /Theo said about 20 minutes at 9:00 AM/);
    assert.equal(d.body.data.map, null);
    // links off: the plain text, no link
    await t.api("/settings/tracking", { method: "PUT", as: owner, ifMatch: "new", body: { enabled: false } });
    const v2 = await visit(owner, await job(owner, c), { date: "2026-11-17", start: "13:00", end: "14:00", assignee_ids: [tech.id] });
    const r2 = await post(t, tech, `/visits/${v2.id}/on-my-way`, live({ eta_min: 15 }));
    assert.equal(r2.body.data.track_url, undefined);
    assert.ok(outbox(t).some((o) => o.template_key === "on_my_way" && !/p\/track/.test(o.body)));
  } finally { t.done(); }
});

test("live: the team map is on and the tech clocked in: an ETA from where they are and a rounded dot; nothing near the last stop, no coordinates, no trail", async () => {
  const { t, owner, tech } = await setup();
  try {
    assert.equal((await turnOnMap(t, owner, [tech.id])).status, 200);
    assert.ok((await clockIn(t, tech)).status < 300);
    // earlier today: the tech's day (other customers' driveways) is on the trail
    await pos(t, tech, [45.1, -93.6], "visit_start");
    clock.setNow("2026-11-17T15:30:00Z");
    await pos(t, tech, LAST_STOP, "visit_finish");
    const { code } = await onTheWay(t, owner, tech);
    // still at the last stop: an ETA, but no dot (that's someone else's house)
    let d = (await data(t, code)).body.data;
    assert.equal(d.eta.source, "live");
    assert.ok(d.eta.minutes > 5, JSON.stringify(d.eta));
    assert.equal(d.map, null, "no dot until they've left the last stop behind");
    // six minutes later, on the road
    clock.setNow("2026-11-17T15:36:00Z");
    await pos(t, tech, ON_THE_ROAD);
    const res = await data(t, code);
    d = res.body.data;
    assert.equal(d.eta.source, "live");
    assert.match(d.eta.text, /^About \d+ minutes? away$/);
    assert.match(d.eta.at_text, /^Around \d{1,2}:\d{2} AM$/);
    assert.ok(d.map, "a dot");
    assert.equal(d.map.east % 50, 0, "rounded to 50 m");
    assert.equal(d.map.north % 50, 0);
    assert.ok(d.map.east > 2500 && d.map.north > 1000, JSON.stringify(d.map));
    const raw = JSON.stringify(res.body);
    assert.doesNotMatch(raw, /45\.0|93\.7|lat|lng|pts/, "no coordinates and no trail leave the server");
    // the data is a GET: it changes nothing (the link record is untouched)
    const keys = t.stores.data.keys("trk/");
    assert.equal(keys.length, 1);
    // arriving: "Pulling up now", the dot on the house
    clock.setNow("2026-11-17T15:52:00Z");
    await pos(t, tech, [HOME[0] + 0.0005, HOME[1]]);
    d = (await data(t, code)).body.data;
    assert.equal(d.eta.text, "Pulling up now");
    assert.deepEqual([d.map.east, d.map.north], [0, 0]);
    // a stale point (over 10 minutes) is not live: the arrival window again
    clock.setNow("2026-11-17T16:05:00Z");
    d = (await data(t, code)).body.data;
    assert.equal(d.eta.source, "window");
    assert.equal(d.map, null);
  } finally { t.done(); }
});

test("no location once the visit starts, after 2 hours, when clocked out or taken off the visit; an ended link is 410, a bad one 404", async () => {
  const { t, owner, tech, tech2 } = await setup();
  try {
    await turnOnMap(t, owner, [tech.id]);
    await clockIn(t, tech);
    const { v, code } = await onTheWay(t, owner, tech);
    clock.setNow("2026-11-17T15:06:00Z");
    await pos(t, tech, ON_THE_ROAD);
    assert.ok((await data(t, code)).body.data.map, "on the way: a dot");
    // started: the visit is under way, no location, no ETA
    const st = await post(t, tech, `/visits/${v.id}/timer`, live({ action: "start" }));
    assert.equal(st.status < 300, true, JSON.stringify(st.body));
    let d = (await data(t, code)).body.data;
    assert.equal(d.state, "started");
    assert.equal(d.headline, "Theo is here");
    assert.equal(d.map, null);
    assert.equal(d.eta, null);
    assert.equal(d.refresh_s, null, "the page stops asking");

    // after 2 hours on the way: no location, the window only
    pin("2026-11-17T15:00:00Z");
    const second = await onTheWay(t, owner, tech);
    clock.setNow("2026-11-17T17:01:00Z");
    await pos(t, tech, ON_THE_ROAD);
    d = (await data(t, second.code)).body.data;
    assert.equal(d.state, "on_the_way");
    assert.equal(d.map, null);
    assert.equal(d.eta.source, "window");
    assert.match(d.sub, /Live location has ended/);

    // given to someone else: no location from the first tech
    pin("2026-11-17T15:00:00Z");
    const third = await onTheWay(t, owner, tech);
    clock.setNow("2026-11-17T15:10:00Z");
    await pos(t, tech, ON_THE_ROAD);
    await store.updateRecord("visit", third.v.id, (x) => ({ ...x, assignee_ids: [tech2.id] }), { by: owner.id, origin: "api", actor_kind: "user", requestId: "t" });
    d = (await data(t, third.code)).body.data;
    assert.equal(d.map, null);
    assert.notEqual(d.state, "on_the_way");

    // clocked out: no location
    const fourth = await onTheWay(t, owner, tech);
    await t.api("/clock", { method: "POST", as: tech, body: { action: "out", client_id: randomUUID() } });
    d = (await data(t, fourth.code)).body.data;
    assert.equal(d.eta.source, "window");
    assert.equal(d.map, null);

    // the next day ends; the link is gone
    clock.setNow("2026-11-19T06:00:00Z");
    assert.equal((await data(t, code)).status, 410);
    assert.equal((await t.portal(`/p/track/${code}`, { headers: PJSON })).status, 410);
    assert.equal((await data(t, "AbC123xYz9")).status, 404, "a made-up code");
    assert.equal((await data(t, "short")).status, 404);
  } finally { t.done(); }
});

test("the vehicle shows only when the owner turns it on; the settings refuse junk", async () => {
  const { t, owner, admin, tech } = await setup();
  try {
    const bad = await t.api("/settings/tracking", { method: "PUT", as: owner, ifMatch: "new", body: { show_vehicle: true, vehicles: { nobody: "A van" } } });
    assert.equal(bad.status, 400);
    assert.equal((await t.api("/settings/tracking", { method: "PUT", as: owner, ifMatch: "new", body: { show_vehicle: true, vehicles: { [tech.id]: "<b>van</b>" } } })).status, 400);
    assert.equal((await t.api("/settings/tracking", { method: "PUT", as: tech, ifMatch: "new", body: { show_vehicle: true } })).status, 403, "a tech can't");
    const ok = await t.api("/settings/tracking", { method: "PUT", as: admin, ifMatch: "new", body: { show_vehicle: true, vehicles: { [tech.id]: "a white Ford Transit" } } });
    assert.equal(ok.status, 200, JSON.stringify(ok.body));
    const { code } = await onTheWay(t, owner, tech);
    const page = await t.portal(`/p/track/${code}`, { headers: PJSON });
    assert.match(page.text, /Look for a white Ford Transit\./);
    assert.equal((await data(t, code)).body.data.vehicle, "a white Ford Transit");
  } finally { t.done(); }
});

test("the page logic (pure): no tech on the visit, cancelled, done; the ETA rule", () => {
  const trk = { user_id: "us_00000000000000000001", created_at: "2026-11-17T15:00:00.000Z", location_until: "2026-11-17T17:00:00.000Z" };
  const v = { status: "en_route", assignee_ids: [trk.user_id], start: "10:00", window: { type: "window", minutes: 120 }, on_my_way: { at: trk.created_at, eta_min: 20 } };
  const t0 = Date.parse("2026-11-17T15:05:00Z");
  assert.equal(TR.trackView({ trk, visit: { ...v, status: "completed" }, tech: { first_name: "Theo" }, t: t0 }).state, "done");
  assert.equal(TR.trackView({ trk, visit: { ...v, status: "cancelled" }, tech: { first_name: "Theo" }, t: t0 }).state, "off");
  assert.equal(TR.trackView({ trk, visit: { ...v, status: "paused" }, tech: { first_name: "Theo" }, t: t0 }).state, "started");
  const noHome = TR.trackView({ trk, visit: v, tech: { first_name: "Theo", name: "Theo Tech" }, live: { sharing: true, pts: [[45, -93.7, t0 / 1000, 5, "i"]] }, home: null, t: t0 });
  assert.equal(noHome.eta.source, "window", "no map point for the house: the window");
  assert.equal(noHome.tech.initials, "TT");
  assert.equal(TR.driveMinutes(1609.344 * 35 / 1.3), 60, "35 mph, × 1.3");
  assert.equal(TR.arrivalText({ start: "08:30", window: { type: "window", minutes: 120 } }), "Arriving between 8:30 AM and 10:30 AM");
  assert.equal(TR.arrivalText({ start: "08:30", date_only: true }), "Anytime that day");
});
