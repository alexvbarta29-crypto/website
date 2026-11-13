// The live team map (docs/CRM-MAP.md "Team map"): a phone's position is
// kept only while its person is clocked in, the company and the person are
// turned on, at most one a short while, in one bounded blob a day; the
// office's map shows the last position, its age, the current or next visit
// and the route; old days are deleted (the retention sweep, the owner's
// button); nothing of it is ever backed up. Synthetic people only.
import { test, afterEach } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { crmTest } from "../../helpers/crm-http.mjs";

const store = await import("../../../netlify/lib/crm-store.mjs");
const clock = await import("../../../netlify/lib/crm/core/clock.mjs");
const TEAM = await import("../../../netlify/lib/crm/modules/map/team.mjs");
const OFF = await import("../../../netlify/lib/crm/modules/work/office.mjs");
const BK = await import("../../../netlify/lib/crm/core/backup.mjs");
const { setNow } = clock;

let t;
afterEach(() => { if (t) t.done(); t = null; });
const W = (by) => ({ by, origin: "api", actor_kind: "user", requestId: "team-test" });
const scope = (fn) => store.withStoreScope({ requestId: "team-test" }, fn);
const pos = (as, body = {}) => t.api("/map/position", { method: "POST", as, body: { lat: 45.0419, lng: -93.7891, acc: 8, ...body } });
const dayKeys = () => t.stores.data.keys("loc/");
const turnOn = (owner, people, extra = {}) => t.api("/settings/map", { method: "PUT", as: owner, ifMatch: t.stores.data.has("cfg/map") ? t.stores.data.etagOf("cfg/map") : "new", body: { team_map: { enabled: true, people, every_s: 120, retention_days: 30, ...extra } } });
const clockIn = (as) => t.api("/clock", { method: "POST", as, body: { action: "in", category: "service", client_id: randomUUID() } });
const clockOut = (as) => t.api("/clock", { method: "POST", as, body: { action: "out", client_id: randomUUID() } });

async function world() {
  t = await crmTest({ now: "2026-11-17T15:00:00Z" });
  return { owner: await t.user("owner"), admin: await t.user("admin"), tech: await t.user("tech"), tech2: await t.user("tech") };
}

test("nothing is kept unless the company, the person and an open shift all say yes", async () => {
  const { owner, tech, tech2 } = await world();
  let r = await pos(tech);
  assert.equal(r.status, 200);
  assert.deepEqual([r.body.data.sharing, r.body.data.reason], [false, "off"], "off by default");
  assert.deepEqual((await t.api("/map/sharing", { as: tech })).body.data.sharing, false);
  assert.equal((await turnOn(owner, [tech.id])).status, 200);
  r = await pos(tech2);
  assert.deepEqual([r.body.data.sharing, r.body.data.reason], [false, "not_you"]);
  r = await pos(tech);
  assert.deepEqual([r.body.data.sharing, r.body.data.reason], [false, "clocked_out"]);
  assert.deepEqual(dayKeys(), [], "no position from anyone so far");
  assert.equal((await clockIn(tech)).status < 300, true);
  assert.deepEqual((await t.api("/map/sharing", { as: tech })).body.data, { sharing: true, every_s: 120 });
  r = await pos(tech, { why: "clock_in" });
  assert.deepEqual([r.body.data.sharing, r.body.data.kept], [true, true]);
  assert.deepEqual(dayKeys(), [`loc/day/2026-11-17/${tech.id}`]);
  // clocked out: the next one isn't kept and the phone stops
  assert.ok((await clockOut(tech)).status < 300);
  setNow("2026-11-17T15:05:00Z");
  r = await pos(tech);
  assert.deepEqual([r.body.data.sharing, r.body.data.reason], [false, "clocked_out"]);
  assert.equal(t.stores.data.json(`loc/day/2026-11-17/${tech.id}`).pts.length, 1);
  // the company switched off: nothing
  await clockIn(tech);
  await t.api("/settings/map", { method: "PUT", as: owner, ifMatch: t.stores.data.etagOf("cfg/map"), body: { team_map: { enabled: false, people: [tech.id] } } });
  assert.equal((await pos(tech)).body.data.sharing, false);
  assert.equal(t.stores.data.json(`loc/day/2026-11-17/${tech.id}`).pts.length, 1);
});

test("one blob a person a day, bounded: a timed position too soon after the last is skipped; visit start and finish always count; the trail is thinned, the newest kept whole", async () => {
  const { owner, tech } = await world();
  await turnOn(owner, [tech.id]);
  await clockIn(tech);
  assert.equal((await pos(tech)).body.data.kept, true);
  setNow("2026-11-17T15:00:10Z");
  assert.equal((await pos(tech, { lat: 45.05 })).body.data.kept, false, "10 s later: skipped");
  assert.equal((await pos(tech, { lat: 45.05, why: "visit_start" })).body.data.kept, true);
  const doc = t.stores.data.json(`loc/day/2026-11-17/${tech.id}`);
  assert.deepEqual(doc.pts.map((p) => p[4]), ["i", "s"]);
  assert.deepEqual(doc.pts[1].slice(0, 2), [45.05, -93.7891]);
  // a long day
  for (let i = 1; i <= TEAM.MAX_TRAIL + 40; i++) {
    setNow(new Date(Date.parse("2026-11-17T15:01:00Z") + i * 60000).toISOString());
    await pos(tech, { lat: 45 + i / 10000 });
  }
  const pts = t.stores.data.json(`loc/day/2026-11-17/${tech.id}`).pts;
  assert.ok(pts.length <= TEAM.MAX_TRAIL, `${pts.length} points`);
  assert.equal(pts[pts.length - 1][0], Math.round((45 + (TEAM.MAX_TRAIL + 40) / 10000) * 1e5) / 1e5, "the latest is the last point");
  assert.equal((await pos(tech, { lat: 91 })).status, 400);
});

test("the office's team map: each person's last position and its age, on the clock or not, the current and next visit, the route; techs never see it", async () => {
  const { owner, admin, tech, tech2 } = await world();
  await turnOn(owner, [tech.id, tech2.id]);
  // a day for tech: one visit under way, one later
  const c = await scope(async () => (await store.createRecord("contact", { first_name: "Route", last_name: "Sample", phones: [{ e164: "+17635550188", sms: true }], lifecycle: "customer", source: { source: "Referral" } }, W(owner.id))).data);
  const [jobId] = await scope(() => OFF.createJobs([{ contact_id: c.id, kind: "standard", lines: [{ title: "Exterior window cleaning", unit_cents: 29500 }] }], "team-map-job", "manual", W(owner.id)));
  const v1 = await scope(async () => (await OFF.createVisit({ job_id: jobId, date: "2026-11-17", start: "08:00", end: "10:00", assignee_ids: [tech.id] }, W(owner.id))).visit);
  await scope(async () => (await OFF.createVisit({ job_id: jobId, date: "2026-11-17", start: "13:00", end: "14:00", assignee_ids: [tech.id] }, W(owner.id))).visit);
  await scope(() => store.updateRecord("visit", v1.id, (x) => ({ ...x, status: "in_progress" }), W(owner.id)));
  await clockIn(tech);
  await pos(tech);
  setNow("2026-11-17T15:03:00Z");
  const r = await t.api("/map/team", { as: admin });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  const d = r.body.data;
  assert.equal(d.enabled, true);
  assert.ok(d.sources && d.sources.streets.style.startsWith("https://tiles.openfreemap.org/"));
  const me = d.people.find((p) => p.id === tech.id);
  assert.equal(me.sharing, true);
  assert.equal(me.clocked_in, true);
  assert.equal(me.last.age_s, 180, "3 minutes ago");
  assert.equal(me.visits.length, 2);
  assert.equal(me.current.id, v1.id);
  assert.equal(me.next.s, "13:00");
  assert.equal(me.visits[0].name, "Route S.", "first name and last initial");
  const other = d.people.find((p) => p.id === tech2.id);
  assert.equal(other.last, undefined);
  assert.equal(other.clocked_in, false);
  assert.equal((await t.api("/map/team", { as: tech })).status, 403);
  assert.equal((await t.api("/map/team?date=2026-10-01", { as: owner })).status, 400, "older than the retention days");
  assert.equal((await t.api("/map/team?date=2026-11-16", { as: owner })).status, 200, "an earlier day within them");
});

test("retention: position days older than the setting go (the sweep, maintenance, so even while paused); the owner's button deletes them all; loc/ is never in a backup", async () => {
  const { owner, tech } = await world();
  await turnOn(owner, [tech.id], { retention_days: 7 });
  for (const day of ["2026-11-01", "2026-11-09", "2026-11-10", "2026-11-11", "2026-11-17"]) {
    await store.settledWrite(TEAM.dayKey(day, tech.id), { uid: tech.id, day, pts: [[45, -93.7, 1, 5, "i"]] }, { onlyIfNew: true });
  }
  await store.settledWrite("geo/rev/2026-08/45.00000_-93.70000", { address: { street1: "1 Example Ave" } }, { onlyIfNew: true });
  await store.settledWrite("geo/rev/2026-11/45.00000_-93.70000", { address: { street1: "1 Example Ave" } }, { onlyIfNew: true });
  const r = await scope(() => TEAM.runRetention({}));
  assert.equal(r.done, true);
  assert.deepEqual(dayKeys().map((k) => k.split("/")[2]), ["2026-11-10", "2026-11-11", "2026-11-17"]);
  assert.deepEqual(t.stores.data.keys("geo/rev/"), ["geo/rev/2026-11/45.00000_-93.70000"]);
  const sweep = (await import("../../../netlify/lib/crm/core/registry.mjs")).allSweeps().find((s) => s.key === "map.retention");
  assert.equal(sweep.maintenance, true);
  // never backed up
  const parts = await scope(() => BK.planPartitions());
  assert.ok(!parts.some((p) => (p.prefix || "").startsWith("loc/") || (p.prefix || "").startsWith("geo/")), "positions and lookups aren't in a snapshot");
  // the owner's button
  assert.equal((await t.api("/map/team/forget", { method: "POST", as: tech, body: {} })).status, 403);
  const f = await t.api("/map/team/forget", { method: "POST", as: owner, body: {} });
  assert.equal(f.status, 200);
  assert.deepEqual(dayKeys(), []);
});

test("Settings → Maps: only people of the team, sensible numbers, the geocoders on or off", async () => {
  const { owner, admin, tech } = await world();
  const put = (body, as = owner) => t.api("/settings/map", { method: "PUT", as, ifMatch: t.stores.data.has("cfg/map") ? t.stores.data.etagOf("cfg/map") : "new", body });
  assert.equal((await put({ team_map: { people: ["someone"] } })).status, 400);
  assert.equal((await put({ team_map: { every_s: 5 } })).status, 400);
  assert.equal((await put({ geocoding: { batch: "google" } })).status, 400);
  assert.equal((await put({ team_map: { enabled: true, people: [tech.id] } }, admin)).status, 403, "owners only");
  const ok = await put({ team_map: { enabled: true, people: [tech.id, tech.id] }, geocoding: { batch: "off", reverse: "off" } });
  assert.equal(ok.status, 200, JSON.stringify(ok.body));
  const saved = t.stores.data.json("cfg/map");
  assert.deepEqual(saved.team_map, { enabled: true, people: [tech.id], every_s: 120, retention_days: 30 });
  assert.deepEqual(saved.geocoding, { batch: "off", reverse: "off" });
});
