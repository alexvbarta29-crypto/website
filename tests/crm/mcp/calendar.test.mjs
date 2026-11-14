// The calendar feed (iCal): a private, revocable link per person that
// Google Calendar and Apple Calendar subscribe to. Checks: a valid
// iCalendar file (CRLF, folded lines, VTIMEZONE, TZID times in
// America/Chicago, all-day visits, across the DST change), scoping (a tech
// gets their own visits only; the office picks theirs or everyone's), the
// token (long, random, stored hashed; a new link kills the old one; off
// kills it; a disabled person's feed stops), and no personal detail beyond
// the customer's first name and town.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { setup, customer, visit, store, CAL, AS } from "./fixtures.mjs";

const fetchFeed = async (t, url) => {
  const path = new URL(url).pathname.replace(/^\/api\/crm/, "");
  const r = await t.api(path, { client: false, csrf: false });
  return { status: r.status, text: r.text, type: r.headers.get("content-type") };
};
const events = (ics) => ics.split("BEGIN:VEVENT").slice(1).map((e) => e.split("END:VEVENT")[0]);
const unfold = (ics) => ics.replace(/\r\n[ \t]/g, "");

async function world() {
  const w = await setup();
  const { owner, tech, tech2 } = w;
  const pat = await customer(owner, { first_name: "Pat", last_name: "Zeppelinsky" }, { town: "Delano" });
  const sam = await customer(owner, { first_name: "Sam", last_name: "Quixotic", phones: [{ e164: "+17635550299", sms: true, primary: true }] }, { town: "Mound" });
  w.c = { pat, sam };
  w.v = {
    mine: await visit(owner, pat, { date: "2026-11-18", start: "08:00", end: "10:00", assignee_ids: [tech.id], town: "Delano" }),
    other: await visit(owner, sam, { date: "2026-11-19", start: "13:30", end: "15:00", assignee_ids: [tech2.id], town: "Mound", services: ["Gutter Cleaning"] }),
    allDay: await visit(owner, pat, { date: "2026-11-20", start: "08:00", end: "10:00", assignee_ids: [tech.id], date_only: true }),
    cancelled: await visit(owner, pat, { date: "2026-11-21", assignee_ids: [tech.id], status: "cancelled" }),
    far: await visit(owner, pat, { date: "2027-06-01", assignee_ids: [tech.id] }),           // outside the 120-day window
    afterDst: await visit(owner, sam, { date: "2027-03-15", start: "08:00", end: "09:30", assignee_ids: [tech.id] }),
  };
  return w;
}

test("a tech turns it on: a valid iCalendar file of their own visits, in Central time", async () => {
  const w = await world();
  const { t, tech } = w;
  try {
    assert.deepEqual((await t.api("/calendar-feed", { as: tech })).body.data, { on: false, scope: null, last4: null, created_at: null, can_all: false });
    const on = await t.api("/calendar-feed", { method: "POST", as: tech, body: {} });
    assert.equal(on.status, 201, JSON.stringify(on.body));
    const url = on.body.data.url;
    assert.match(url, /^https:\/\/www\.bartawindowwashing\.com\/api\/crm\/cal\/bcal_[A-Za-z0-9_-]{43}\.ics$/);
    assert.equal(on.body.data.webcal_url, url.replace("https:", "webcal:"));
    assert.equal(on.body.data.scope, "mine");
    // shown once: the status never carries it again
    const st = await t.api("/calendar-feed", { as: tech });
    assert.equal(st.body.data.on, true);
    assert.equal(st.body.data.url, undefined);
    assert.ok(!JSON.stringify(st.body).includes(url.split("/").pop().replace(".ics", "")));
    // a tech can't pick everyone's
    assert.equal((await t.api("/calendar-feed", { method: "PATCH", as: tech, body: { scope: "all" } })).status, 403);

    const f = await fetchFeed(t, url);
    assert.equal(f.status, 200);
    assert.match(f.type, /^text\/calendar/);
    const ics = f.text;
    assert.ok(ics.startsWith("BEGIN:VCALENDAR\r\nVERSION:2.0\r\n"));
    assert.ok(ics.endsWith("END:VCALENDAR\r\n"));
    assert.ok(!/[^\r]\n/.test(ics), "every line ends with CRLF");
    for (const line of ics.split("\r\n")) assert.ok(Buffer.byteLength(line, "utf8") <= 75, `folded: ${line}`);
    assert.match(ics, /BEGIN:VTIMEZONE\r\nTZID:America\/Chicago/);
    assert.match(ics, /X-WR-TIMEZONE:America\/Chicago/);
    assert.equal((ics.match(/BEGIN:VEVENT/g) || []).length, (ics.match(/END:VEVENT/g) || []).length);
    const ev = events(unfold(ics));
    const uids = ev.map((e) => /UID:([^\r]+)/.exec(e)[1]);
    assert.deepEqual(uids.sort(), [w.v.mine.id, w.v.allDay.id, w.v.afterDst.id].map((id) => `${id}@bartawindowwashing.com`).sort(), "own visits only; not cancelled, not past the window, not tech B's");
    const mine = ev.find((e) => e.includes(w.v.mine.id));
    assert.match(mine, /DTSTART;TZID=America\/Chicago:20261118T080000/);
    assert.match(mine, /DTEND;TZID=America\/Chicago:20261118T100000/);
    assert.match(mine, /SUMMARY:Pat · Delano · Window cleaning/);
    assert.match(mine, /DTSTAMP:\d{8}T\d{6}Z/);
    const allDay = ev.find((e) => e.includes(w.v.allDay.id));
    assert.match(allDay, /DTSTART;VALUE=DATE:20261120/);
    assert.match(allDay, /DTEND;VALUE=DATE:20261121/);
    // after the March DST change the wall-clock time stays 08:00 (TZID, not a fixed offset)
    assert.match(ev.find((e) => e.includes(w.v.afterDst.id)), /DTSTART;TZID=America\/Chicago:20270315T080000/);
    for (const e of ev) for (const k of ["UID:", "DTSTAMP:", "DTSTART", "DTEND", "SUMMARY:"]) assert.ok(e.includes(k), `${k} in every event`);
  } finally {
    t.done();
  }
});

test("no personal detail beyond the first name and town", async () => {
  const w = await world();
  const { t, owner } = w;
  try {
    const on = await t.api("/calendar-feed", { method: "POST", as: owner, body: { scope: "all" } });
    assert.equal(on.status, 201);
    const ics = unfold((await fetchFeed(t, on.body.data.url)).text);
    assert.match(ics, /SUMMARY:Pat · Delano/);
    assert.match(ics, /SUMMARY:Sam · Mound · Gutters/);
    for (const c of Object.values(w.c)) {
      assert.ok(!ics.includes(c.last_name), "no last name");
      for (const p of c.phones) { assert.ok(!ics.includes(p.e164)); assert.ok(!ics.includes(p.e164.slice(2))); }
      for (const e of c.emails) assert.ok(!ics.includes(e.address), "no email");
      assert.ok(!ics.includes(c.billing_address.street1), "no street");
    }
    for (const bad of ["Example Ave", "Gate code", "4321", "Dog", "@example.com", "$", "cents"]) assert.ok(!ics.includes(bad), `no ${bad}`);
  } finally {
    t.done();
  }
});

test("the office picks theirs or everyone's; the scope follows a PATCH; the schedule's changes show on the next fetch", async () => {
  const w = await world();
  const { t, owner, tech } = w;
  try {
    const on = await t.api("/calendar-feed", { method: "POST", as: owner, body: { scope: "all" } });
    assert.equal(on.body.data.can_all, true);
    let ev = events(unfold((await fetchFeed(t, on.body.data.url)).text));
    assert.equal(ev.length, 4, "everyone's visits in the window");
    assert.match(ev.find((e) => e.includes(w.v.other.id)), /Crew: Tess/);
    // the owner's own visits: none
    assert.equal((await t.api("/calendar-feed", { method: "PATCH", as: owner, body: { scope: "mine" } })).body.data.scope, "mine");
    assert.equal(events((await fetchFeed(t, on.body.data.url)).text).length, 0);
    await t.api("/calendar-feed", { method: "PATCH", as: owner, body: { scope: "all" } });
    // a visit moves and one is cancelled: the next fetch says so
    await store.updateRecord("visit", w.v.mine.id, (v) => ({ ...v, date: "2026-11-24", start: "09:00", end: "11:00" }), AS(owner));
    await store.updateRecord("visit", w.v.other.id, (v) => ({ ...v, status: "cancelled" }), AS(owner));
    ev = events(unfold((await fetchFeed(t, on.body.data.url)).text));
    assert.match(ev.find((e) => e.includes(w.v.mine.id)), /DTSTART;TZID=America\/Chicago:20261124T090000/);
    assert.ok(!ev.some((e) => e.includes(w.v.other.id)));
    assert.equal((await t.api("/calendar-feed", { method: "PATCH", as: owner, body: { scope: "everything" } })).status, 400);
    void tech;
  } finally {
    t.done();
  }
});

test("the token: long, random, stored hashed; a new link kills the old one; off kills it; a disabled person's feed stops", async () => {
  const w = await world();
  const { t, owner, tech } = w;
  try {
    const one = (await t.api("/calendar-feed", { method: "POST", as: tech, body: {} })).body.data.url;
    const token = one.split("/").pop().replace(".ics", "");
    assert.equal(token.length, 48);
    const hash = createHash("sha256").update(token).digest("hex");
    const dump = JSON.stringify(t.stores.data.snapshot());
    assert.ok(!dump.includes(token), "the token is never stored");
    assert.ok(t.stores.data.keys(`ptr/cal-feed/${hash}`).length === 1, "only its hash");
    assert.equal((await fetchFeed(t, one)).status, 200);

    const two = (await t.api("/calendar-feed", { method: "POST", as: tech, body: {} })).body.data.url;
    assert.notEqual(two, one);
    assert.equal((await fetchFeed(t, one)).status, 404, "the old link stops");
    assert.equal((await fetchFeed(t, two)).status, 200);
    // even if the old token's pointer had survived, the person's own record no longer names it
    await store.settledWrite(`ptr/cal-feed/${hash}`, { user_id: tech.id, created_at: "2026-11-17T15:00:00.000Z" }, { onlyIfNew: true });
    assert.equal((await fetchFeed(t, one)).status, 404);

    assert.equal((await t.api("/calendar-feed", { method: "DELETE", as: tech })).status, 200);
    assert.equal((await fetchFeed(t, two)).status, 404, "off: the link stops at once");
    assert.equal((await t.api("/calendar-feed", { as: tech })).body.data.on, false);

    const three = (await t.api("/calendar-feed", { method: "POST", as: tech, body: {} })).body.data.url;
    assert.equal((await fetchFeed(t, three)).status, 200);
    await store.updateRecord("user", tech.id, (u) => ({ ...u, status: "disabled" }), AS(owner));
    assert.equal((await fetchFeed(t, three)).status, 404, "a disabled person's feed stops");

    // made-up and malformed tokens
    for (const p of ["/cal/bcal_" + "A".repeat(43) + ".ics", "/cal/nope.ics", "/cal/" + "x".repeat(300)]) assert.equal((await t.api(p, { client: false })).status, 404, p);
    assert.equal((await t.api("/calendar-feed", { method: "PATCH", as: owner, body: { scope: "all" } })).status, 400, "nothing to change before it's on");
  } finally {
    t.done();
  }
});

test("permissions: signed-out callers get nothing; anyone without the schedule gets no feed", async () => {
  const w = await world();
  const { t, owner } = w;
  try {
    assert.equal((await t.api("/calendar-feed")).status, 401);
    assert.equal((await t.api("/calendar-feed", { method: "POST", body: {} })).status, 401);
    const nobody = await t.user("tech", { denies: ["schedule:read"] });
    assert.equal((await t.api("/calendar-feed", { as: nobody })).status, 403);
    assert.equal((await t.api("/calendar-feed", { method: "POST", as: nobody, body: {} })).status, 403);
    // an owner whose feed is "all" loses the office's reach (denied schedule:read): no feed at all
    const url = (await t.api("/calendar-feed", { method: "POST", as: owner, body: { scope: "all" } })).body.data.url;
    await store.updateRecord("user", owner.id, (u) => ({ ...u, denies: ["schedule:read"] }), AS(owner));
    assert.equal((await fetchFeed(t, url)).status, 404);
  } finally {
    t.done();
  }
});

test("folding and escaping", () => {
  assert.equal(CAL.icsText("a,b;c\\d\ne"), "a\\,b\\;c\\\\d\\ne");
  const long = "DESCRIPTION:" + "ü".repeat(80);
  const folded = CAL.fold(long);
  for (const l of folded.split("\r\n")) assert.ok(Buffer.byteLength(l, "utf8") <= 75);
  assert.equal(folded.replace(/\r\n /g, ""), long);
  assert.equal(CAL.firstName("Pat Example"), "Pat");
  assert.equal(CAL.firstName("  "), "");
  assert.equal(CAL.firstName("<script>alert(1)</script> Doe"), "scriptalertscript");
});
