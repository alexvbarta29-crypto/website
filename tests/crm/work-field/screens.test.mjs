// The tech app's screens render with synthetic state through html``
// (design §2.3, §0 rule 7, §9.3): every interpolation is escaped, links
// stay in the frame or leave through openExternal, and each screen says
// what it should (the day, the field panel by status, Time, Pay, the
// office's Timesheets). The phone walks (tests/e2e/work-field.spec.mjs,
// offline.spec.mjs) cover the rest.
import { test } from "node:test";
import assert from "node:assert/strict";

globalThis.window = globalThis.window || { __crm: { session: { perms: {} } } };
const load = async (name) => (await import(`../../../crm-app/modules/work/${name}.js`)).default;
const text = (safe) => String(safe);
const XSS = "</script><script>alert(1)</script>";
const UID = "us_0000000000000000000t";
const ctx = (role = "tech", perms = ["visits:work", "visits:add_line"]) => ({ user: { id: UID, role, first_name: "Theo", is_technician: true }, can: (p) => perms.includes(p), api: async () => ({ data: {} }), refresh: () => {}, rerender: () => {} });

const visitOf = (o = {}) => ({
  id: "vs_00000000000000000001", status: "scheduled", date: "2026-11-17", start: "08:00", end: "10:00", window: { type: "window", minutes: 120 }, town: "Delano",
  service_types: ["Residential Window Cleaning"], job_title: `Windows ${XSS}`, tech_notes: `Gate ${XSS}`, photos: [], updated_at: "2026-11-17T14:00:00.000Z",
  checklist: { items: [{ key: "walkaround_photo", label: `Walk ${XSS}`, required: true, kind: "photo" }, { key: "glass", label: "Glass", kind: "check" }, { key: "clips", label: "Clips", kind: "count" }, { key: "gate_closed", label: "Gate closed", required: true, kind: "check" }] },
  ...o,
});
const stop = (o = {}) => ({
  n: 1, visit: visitOf(o.visit), name: `Pat ${XSS}`, contact: { id: "ct_00000000000000000001", display_name: `Pat ${XSS}`, phones: [{ e164: "+17635550100", primary: true }] },
  property: { address: { street1: "1 Example Ave", city: "Delano", state: "MN", zip: "55328" } }, badges: [{ key: "gate", label: "Gate code" }, { key: "first", label: "First visit" }],
  timers: [], job: { lines: [] }, ...o,
});
// the screen's state: the day it shows, with the phone's own today and its neighbours
const st = (o = {}) => ({ tech: true, date: "2026-11-17", today: "2026-11-17", yesterday: "2026-11-16", tomorrow: "2026-11-18", ...o });
const day = (stops = [stop()], o = {}) => ({ date: "2026-11-17", today: "2026-11-17", tomorrow: "2026-11-18", yesterday: "2026-11-16", clock: { open: null, week_minutes: 300 }, stops, ...o });

test("Today (a tech): the clock bar, the day switcher, the visits in order with Directions, Call and Text; escaped; empty and offline", async () => {
  const card = await load("tech-today");
  const h = text(card.render(st({ day: day([stop(), stop({ n: 2, visit: { id: "vs_00000000000000000002", status: "completed" } })]), offline: false }), ctx()));
  assert.ok(!h.includes("<script>alert(1)"), "escaped");
  assert.match(h, /Not clocked in/);
  assert.match(h, /data-clock="in"/);
  assert.match(h, /href="#\/visits\/vs_00000000000000000001"/);
  assert.ok(h.indexOf("vs_00000000000000000001") < h.indexOf("vs_00000000000000000002"), "in route order");
  assert.match(h, /href="tel:\+17635550100"/);
  assert.match(h, /href="sms:\+17635550100"/);
  assert.match(h, /(target="_blank" rel="noopener"|data-external="top")[^>]*>[\s\S]*?Directions/, "directions leave the frame");
  assert.match(h, /Gate code/);
  assert.match(h, /2 visits, 1 to go/);
  assert.match(h, /data-day="2026-11-18"/);
  const on = text(card.render(st({ day: day([], { clock: { open: { start_at: "2026-11-17T14:00:00.000Z", category: "service" }, week_minutes: 0, near_ot: true } }) }), ctx()));
  assert.match(on, /On the clock/);
  assert.match(on, /data-clock="out"/);
  assert.match(on, /close to 40 h/);
  assert.match(on, /No visits today/);
  const off = text(card.render(st({ day: day([stop()], { waiting: 2 }), offline: true, as_of: "2026-11-17T13:42:00.000Z" }), ctx()));
  // one bar: when the copy is from (with its day when that isn't today) and what waits; the app's banner steps aside
  assert.match(off, /No signal\. Your day as of (Tue, Nov 17, )?7:42 AM\. 2 changes wait; they go out by themselves\./);
  assert.match(off, /class="tf-own-offline"/);
  assert.equal((off.match(/class="tf-wait/g) || []).length, 1, "one bar");
  // an owner who goes out: "My visits", nothing loud when nothing's booked
  const owner = text(card.render(st({ tech: false, day: day([]) }), ctx("owner")));
  assert.match(owner, /My visits/);
  assert.match(owner, /Nothing booked for you today/);
  assert.equal(text(card.render({ none: true }, ctx("owner"))), "", "an owner who doesn't go out: nothing");
  // the morning after with no signal and no copy of today: said plainly, never another day shown as today
  const none = text(card.render(st({ date: "2026-11-18", today: "2026-11-18", yesterday: "2026-11-17", tomorrow: "2026-11-19", error: "No signal, and today's list isn't on this phone yet. It loads when you have signal." }), ctx()));
  assert.match(none, /Today, Wed, Nov 18/);
  assert.match(none, /today(&#39;|')s list isn(&#39;|')t on this phone yet/);
  assert.doesNotMatch(none, /tf-stop/);
});

test("the field panel: buttons by status, the checklist by kind, photos waiting on the phone, the work with or without prices", async () => {
  const panel = await load("visit-field");
  const c = (data = {}) => ({ ...ctx(), data: { job: { lines: [{ id: "ln_1", title: `Screens ${XSS}`, qty_milli: 12000, total_cents: 6000 }], totals: { total_cents: 35500 } }, can: { prices: true }, ...data } });
  let h = text(panel.render({ visit: visitOf(), timers: [], waiting: 0 }, c()));
  assert.ok(!h.includes("<script>alert(1)"));
  assert.match(h, /data-omw/);
  assert.match(h, /data-timer="start"/);
  assert.match(h, /data-late/);
  assert.match(h, /data-noaccess/);
  assert.doesNotMatch(h, /data-complete/, "required items left: Complete waits");
  assert.match(h, /data-item="walkaround_photo"[^>]*data-kind="photo"/);
  assert.match(h, /data-item="clips"[^>]*data-kind="count"/);
  assert.match(h, /\$60\.00/, "prices with visits:prices");
  assert.match(h, /data-addline/);
  // working: the timer and Pause, and what's still to do
  h = text(panel.render({ visit: visitOf({ status: "in_progress" }), timers: [{ id: "tm_1", user_ids: [UID], start_at: "2026-11-17T14:00:00.000Z" }], waiting: 1 }, c()));
  assert.match(h, /data-timer="pause"/);
  assert.match(h, /data-since="2026-11-17T14:00:00.000Z"/);
  assert.match(h, /Still to do before it's done: Walk/);
  assert.match(h, /1 change waits for signal/);
  // someone else's timer runs: start your own
  h = text(panel.render({ visit: visitOf({ status: "in_progress" }), timers: [{ id: "tm_2", user_ids: ["us_0000000000000000000u"], start_at: "2026-11-17T14:00:00.000Z" }] }, c()));
  assert.match(h, /Start my timer/);
  // a photo on the phone, waiting
  h = text(panel.render({ visit: visitOf({ status: "paused", photos: [{ local: true, tag: "before", thumb: "data:image/jpeg;base64,AAAA" }, { file_id: "fl_00000000000000000001", tag: "after" }] }), timers: [] }, c()));
  assert.match(h, /src="data:image\/jpeg;base64,AAAA"/);
  assert.match(h, /src="\/api\/crm\/files\/fl_00000000000000000001\?thumb=1"/);
  assert.match(h, /tf-photo wait/);
  assert.match(h, /data-timer="start"[^>]*>[\s\S]*?Resume/);
  // no prices: titles and quantities only
  h = text(panel.render({ visit: visitOf(), timers: [] }, c({ job: { lines: [{ id: "ln_1", title: "Screens", qty_milli: 12000 }] }, can: { prices: false } })));
  assert.doesNotMatch(h, /\$/);
  // done, no access; the texts
  assert.match(text(panel.render({ visit: visitOf({ status: "completed", completion: { at: "2026-11-17T16:00:00.000Z" } }), timers: [] }, c())), /Done at 10:00 AM/);
  assert.match(text(panel.render({ visit: visitOf({ status: "no_access", no_access: { note: `Locked ${XSS}` } }), timers: [] }, c())), /No access: Locked &lt;\/script&gt;/);
  const sent = text(panel.render({ visit: visitOf({ status: "en_route" }), timers: [], sent: { status: "dry_run", hand: { to: "+17635550100", body: "Hi Pat, it's Theo." } } }, c()));
  assert.match(sent, /href="sms:\+17635550100\?&amp;body=Hi%20Pat%2C%20it&#39;s%20Theo\."/, "the words, escaped in the attribute");
  assert.match(text(panel.render({ visit: visitOf({ status: "en_route" }), timers: [], sent: { status: "blocked", reason: "quiet_hours" } }, c())), /outside texting hours/);
  assert.match(text(panel.render({ visit: visitOf(), timers: [], last: { date: "2026-11-10", text: `Dog ${XSS}` } }, c())), /Last time here/);
});

test("Time, Pay and the office's Timesheets render; links stay in the frame; escaped", async () => {
  const time = await load("tech-time");
  const shift = { id: "ts_00000000000000000001", start_at: "2026-11-17T14:00:00.000Z", end_at: "2026-11-17T22:00:00.000Z", minutes: 480, status: "closed", category: "service", notes: [{ text: `Lunch ${XSS}` }], edits: [{ reason: "x" }], auto_closed: { reason: "forgotten" } };
  let h = text(time.render({ week_start: "2026-11-15", week_end: "2026-11-21", days: { "2026-11-15": 0, "2026-11-16": 0, "2026-11-17": 480 }, totals: { minutes: 2300, near_ot: true }, shifts: [shift], timers: [{ timer: { start_at: "2026-11-17T14:00:00.000Z", end_at: "2026-11-17T16:00:00.000Z", minutes: 120 }, visit: { job_title: `Windows ${XSS}`, town: "Delano" } }], pending: [], open: null }, ctx()));
  assert.ok(!h.includes("<script>alert(1)"));
  assert.match(h, /href="#\/time\?week=2026-11-08"/);
  assert.match(h, /Close to 40 hours/);
  assert.match(h, /Closed for you · Edited by the office/);
  assert.match(h, /data-note="ts_00000000000000000001"/);
  assert.match(h, /data-clock="in"/);
  const pay = await load("tech-pay");
  h = text(pay.render({ period: { start_on: "2026-11-15", end_on: "2026-11-21" }, estimate: { minutes: 2700, regular_min: 2400, ot_min: 300, rate_cents: 2000, rate_is_default: true, regular_cents: 80000, ot_cents: 15000, total_cents: 95000, pending_min: 60 }, past: [{ week_start: "2026-11-08", week_end: "2026-11-14", minutes: 600, ot_min: 0, total_cents: 20000 }], ot_threshold_hours: 40, ot_multiplier: 1.5 }, ctx()));
  assert.match(h, /\$950\.00/);
  assert.match(h, /\$20\.00 an hour \(standard\)/);
  assert.match(h, /estimate/i);
  assert.match(h, /1 h 00 m is waiting for the office/);
  assert.match(h, /href="#\/pay\?period=2026-11-08"/);
  const ts = await load("tech-timesheets");
  h = text(ts.render({ week_start: "2026-11-15", week_end: "2026-11-21", people: [{ id: UID, name: `Theo ${XSS}`, color: "#13a165" }], weeks: [{ user_id: UID, minutes: 2500, ot_min: 100, to_approve: 2, approved: 0, open: 0, pending: 0, entries: [{ id: "ts_00000000000000000001", s: "2026-11-17T14:00:00.000Z", e: "2026-11-17T22:00:00.000Z", min: 480, st: "closed", ac: true, ed: 1, fl: ["timer_auto_closed"] }] }], pending: [{ id: "ts_00000000000000000002", uid: UID, s: "2026-11-16T14:00:00.000Z", e: "2026-11-16T15:00:00.000Z", min: 60, why: "queued_mismatch" }] }, ctx("owner")));
  assert.ok(!h.includes("<script>alert(1)"));
  assert.match(h, /data-approve="us_0000000000000000000t"/);
  assert.match(h, /data-decide="ts_00000000000000000002"/);
  assert.match(h, /the phone&#39;s time didn&#39;t add up/);
  assert.match(h, /Closed for them · Edited · A timer was stopped/);
  const card = await load("tech-timesheets-card");
  assert.equal(text(card.render({ data: { pending: [], weeks: [] } })), "");
  assert.match(text(card.render({ data: { pending: [{}], weeks: [{ to_approve: 1, open: 1 }] } })), /1 time entry to decide[\s\S]*1 week to approve[\s\S]*1 person on the clock/);
});

test("Today draws a module card inside its own wrapper with its events, and a tech's placeholder only when no card shows anything", async () => {
  const today = (await import("../../../crm-app/modules/system/today.js")).default;
  const { html } = await import("../../../crm-app/core/ui.js");
  const base = { now: new Date("2026-11-17T15:00:00Z"), user: { role: "tech", first_name: "Theo" }, badges: {}, health: null };
  const mod = { render: () => html`<p class="mine">My day</p>`, events: { "click .mine": () => {} } };
  let h = text(today.render({ ...base, cards: [{ key: "field", mod, state: {} }] }, { can: () => false }));
  assert.match(h, /<div class="today-card" style="display:contents" data-card="field"><p class="mine">My day<\/p><\/div>/);
  assert.doesNotMatch(h, /No visits today/, "the card took its place");
  h = text(today.render({ ...base, cards: [{ key: "field", mod: { render: () => html`` }, state: {} }] }, { can: () => false }));
  assert.match(h, /No visits today/, "nothing to show: the placeholder");
  assert.doesNotMatch(h, /data-card="field"/, "and no empty wrapper");
});
