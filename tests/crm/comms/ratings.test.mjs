// In-app star ratings (the Rotor guide's S27 with §7.4's changes, owner
// defaults Q3 and Q7): the review page is a portal link scoped to the job;
// a tap of 1 to 5 stars lands once per link (a second tap changes it); the
// Google link shows at every rating by default; its tap is recorded; a low
// rating makes a follow-up task for the owners; the office's list with its
// tiles, the star spread and the crew leaderboard; manual ratings; built
// but off until the switch (the review texts keep the Google link).
// Synthetic people only.
import { test } from "node:test";
import assert from "node:assert/strict";
import { crmTest } from "../../helpers/crm-http.mjs";
import { store, scope, seedContact, W } from "./fixtures.mjs";

const PORTAL = await import("../../../netlify/lib/crm/portal/core.mjs");
const RT = await import("../../../netlify/lib/crm/modules/comms/ratings.mjs");
const ids = await import("../../../netlify/lib/crm/core/ids.mjs");
const PJSON = { "content-type": "application/json", "x-crm-portal": "1", origin: "https://www.bartawindowwashing.com", "user-agent": "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 Mobile/15E148" };

async function cookieFor(t, contactId, id) {
  const l = await scope(() => PORTAL.createPortalLink({ contact_id: contactId, scope: { kind: "review", id } }));
  const r = await t.portal("/api/portal/open", { method: "POST", headers: PJSON, body: { code: l.code } });
  assert.equal(r.status, 200, r.text);
  assert.equal(r.body.data.location, `/p/review/${id}`);
  return t.setCookies(r).find((x) => x.startsWith("barta_portal=")).split(";")[0];
}

test("the star page: 1 to 5 stars once per link, Google's link at every rating, its tap recorded, a low rating makes the owners a task", async () => {
  const t = await crmTest({ now: "2026-11-17T15:00:00Z" });
  try {
    const owner = await t.user("owner");
    const tech = await t.user("tech");
    const c = await scope(() => seedContact(61, { lifecycle: "customer" }));
    const jid = ids.newId("job");
    await store.settledWrite(`rec/job/${jid}`, { id: jid, type: "job", v: 1, wv: 1, contact_id: c.id, status: "completed", assignee_ids: [tech.id], created_at: "2026-11-17T12:00:00.000Z" }, { onlyIfNew: true });
    const cookie = await cookieFor(t, c.id, jid);
    const page = await t.portal(`/p/review/${jid}`, { headers: { cookie } });
    assert.equal(page.status, 200);
    assert.match(page.text, /How did we do\?/);
    assert.match(page.text, /comms-review\.js/);
    assert.doesNotMatch(page.text, /<script>(?!<\/script>)/, "no inline script (CSP)");
    assert.doesNotMatch(page.text, /—/, "no em dashes");
    // another job's page: not with this link
    assert.equal((await t.portal(`/p/review/${ids.newId("job")}`, { headers: { cookie } })).status, 401);
    // a portal POST needs the portal header
    assert.equal((await t.portal(`/api/portal/review/${jid}`, { method: "POST", headers: { cookie, "content-type": "application/json", origin: PJSON.origin }, body: { stars: 5 } })).status, 403);
    assert.equal((await t.portal(`/api/portal/review/${jid}`, { method: "POST", headers: { ...PJSON, cookie }, body: { stars: 9 } })).status, 400);
    // 2 stars: the Google link still shows (Q3), and the owners get a follow-up task when the sales module is there
    const low = await t.portal(`/api/portal/review/${jid}`, { method: "POST", headers: { ...PJSON, cookie }, body: { stars: 2, comment: "Missed a window on the back." } });
    assert.equal(low.status, 200, low.text);
    assert.deepEqual([low.body.data.stars, low.body.data.show_google, low.body.data.low], [2, true, true]);
    assert.match(low.body.data.google_link, /^https:\/\//);
    const rid = RT.ratingIdFor(c.id, jid);
    let rec = t.stores.data.json(`rec/rating/${rid}`);
    assert.deepEqual([rec.stars, rec.job_id, rec.crew_ids, rec.source, rec.public_clicked], [2, jid, [tech.id], "app", false]);
    const tasks = t.stores.data.keys("rec/task/");
    assert.equal(tasks.length, 1, "a follow-up task for the owners");
    const task = t.stores.data.json(tasks[0]);
    assert.match(task.title, /Review needs a follow-up: 2 stars/);
    assert.deepEqual([task.priority, task.contact_id, task.assignee_ids], ["high", c.id, [owner.id]]);
    assert.equal(rec.follow_up.task_id, task.id);
    // a second tap changes it (one per link), no second task
    const hi = await t.portal(`/api/portal/review/${jid}`, { method: "POST", headers: { ...PJSON, cookie }, body: { stars: 5 } });
    assert.equal(hi.body.data.stars, 5);
    assert.equal(t.stores.data.keys("rec/rating/").length, 1);
    assert.equal(t.stores.data.keys("rec/task/").length, tasks.length);
    assert.equal(t.stores.data.json(`rec/rating/${rid}`).comment, "Missed a window on the back.", "the words stay when only the stars change");
    await t.portal(`/api/portal/review/${jid}/clicked`, { method: "POST", headers: { ...PJSON, cookie }, body: {} });
    rec = t.stores.data.json(`rec/rating/${rid}`);
    assert.equal(rec.public_clicked, true);
    // the page shows what they picked
    assert.match((await t.portal(`/p/review/${jid}`, { headers: { cookie } })).text, /value="5" checked/);
    // the office: tiles, the star spread, the crew leaderboard
    const list = await t.api("/ratings", { as: owner });
    assert.equal(list.status, 200);
    assert.deepEqual(list.body.data.tiles, { all: 1, needs_follow_up: 0, public: 1, avg: 5, five_pct: 100 });
    assert.deepEqual(list.body.data.dist, [0, 0, 0, 0, 1]);
    assert.deepEqual(list.body.data.leaderboard.map((x) => [x.user_id, x.count, x.avg]), [[tech.id, 1, 5]]);
    assert.equal(list.body.meta.ratings_on, false, "built, off until the switch");
    assert.equal((await t.api("/ratings?f=nope", { as: owner })).status, 400);
    assert.equal((await t.api("/ratings", { as: tech })).status, 403);
    assert.equal(t.fetchCalls().length, 0, "nothing left the site");
  } finally { t.done(); }
});

test("manual ratings, needs follow-up and followed up; the review page link for the office", async () => {
  const t = await crmTest({ now: "2026-11-17T15:00:00Z" });
  try {
    const owner = await t.user("owner");
    const c = await scope(() => seedContact(62, { lifecycle: "customer" }));
    const m = await t.api("/ratings", { method: "POST", as: owner, body: { contact_id: c.id, stars: 3, comment: "Said so on the phone" } });
    assert.equal(m.status, 201);
    assert.equal(m.body.data.source, "manual");
    assert.equal((await t.api("/ratings", { method: "POST", as: owner, body: { stars: 4 } })).status, 400, "who left it");
    assert.equal((await t.api("/ratings", { method: "POST", as: owner, body: { name: "Card at the door", stars: 6 } })).status, 400);
    let v = (await t.api("/ratings?f=needs_follow_up", { as: owner })).body.data;
    assert.deepEqual(v.rows.map((r) => r.id), [m.body.data.id]);
    assert.equal((await t.api(`/ratings/${m.body.data.id}/followed-up`, { method: "POST", as: owner, body: {} })).status, 200);
    v = (await t.api("/ratings?f=needs_follow_up", { as: owner })).body.data;
    assert.deepEqual(v.rows, []);
    assert.equal((await t.api("/ratings?source=manual", { as: owner })).body.data.rows.length, 1);
    const l = await t.api("/ratings/link", { method: "POST", as: owner, body: { contact_id: c.id } });
    assert.match(l.body.data.url, /^https:\/\/www\.bartawindowwashing\.com\/p\/[0-9A-Za-z]{10}$/);
  } finally { t.done(); }
});

test("settings: ratings off by default; the Google link from N stars; the review texts use the star page only once ratings are on", async () => {
  const t = await crmTest({ now: "2026-11-17T15:00:00Z" });
  try {
    const owner = await t.user("owner");
    const cur = (await t.api("/settings/reviews", { as: owner })).body.data;
    assert.deepEqual([cur.data.ratings, cur.data.link_from_stars], [false, 1]);
    const c = await scope(() => seedContact(63));
    assert.equal(await scope(() => RT.sequenceLink(c.id, null)), null, "off: the texts keep Google's link");
    assert.equal((await t.api("/settings/reviews", { method: "PUT", as: owner, ifMatch: cur.etag || "new", body: { ...cur.data, link_from_stars: 7 } })).status, 400);
    const on = await t.api("/settings/reviews", { method: "PUT", as: owner, ifMatch: cur.etag || "new", body: { ...cur.data, ratings: true, link_from_stars: 4 } });
    assert.equal(on.status, 200, on.text);
    assert.match(await scope(() => RT.sequenceLink(c.id, null)), /^https:\/\/www\.bartawindowwashing\.com\/p\//);
    const cookie = await cookieFor(t, c.id, c.id);
    const r = await t.portal(`/api/portal/review/${c.id}`, { method: "POST", headers: { ...PJSON, cookie }, body: { stars: 3 } });
    assert.deepEqual([r.body.data.show_google, r.body.data.google_link], [false, null], "below the owner's line: no Google link");
  } finally { t.done(); }
});
