// The tech app's API (design §5.5 field endpoints, §2.5, §4.6, §5.7.4
// visit.on_my_way / visit.running_late, D11): what a person on a visit can
// do, what a technician is told (techFields only, prices only with
// visits:prices), the texts (dry-run, consent, quiet hours, the
// templates), photos through the files route, the checklist's rules, the
// office's Timesheets and the pay estimate (D3).
import { test } from "node:test";
import assert from "node:assert/strict";
import { pin, advance, minutes, hours } from "../../helpers/crm-clock.mjs";
import { BYTES } from "../../helpers/crm-fixtures.mjs";
import { setup, customer, job, visit, clock, store, AS, TS, FIELD, cid, live, offline, post, patch, rec, sheets, outbox, queued } from "./fixtures.mjs";

const T = await import("../../../netlify/lib/crm/core/templates.mjs");
const jpeg = () => Buffer.from(BYTES.jpeg()).toString("base64");
const CANARY = "Office-only canary 9K";

test("the templates: Barta's voice, the closed variable set, no STOP line and no em dash", () => {
  for (const t of FIELD.templates) {
    assert.doesNotMatch(t.body, /STOP/i, t.key);
    assert.doesNotMatch(t.body, /—/, t.key);
    assert.doesNotMatch(t.body, /licensed/i, t.key);
    const parsed = T.parseTemplate ? T.parseTemplate(t) : null;
    if (parsed && parsed.problems) assert.deepEqual(parsed.problems, [], t.key);
    assert.equal(t.category, "service");
  }
  assert.deepEqual(FIELD.templates.map((t) => t.key), ["on_my_way", "running_late"]);
  assert.deepEqual(FIELD.automations.map((a) => [a.key, a.trigger, a.category]), [["visit.on_my_way", "manual", "service"], ["visit.running_late", "manual", "service"]]);
});

test("on my way: the visit goes en route and the customer's text lands in the Outbox (dry-run), with the words to send by hand", async () => {
  const { t, owner, tech } = await setup();
  try {
    const c = await customer(owner);
    const v = await visit(owner, await job(owner, c), { date: "2026-11-17", start: "10:00", end: "12:00", assignee_ids: [tech.id] });
    const r = await post(t, tech, `/visits/${v.id}/on-my-way`, live({ eta_min: 20, lat: 45.04, lng: -93.79 }));
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(r.body.data.visit.status, "en_route");
    assert.equal(r.body.data.visit.on_my_way.eta_min, 20);
    const text = r.body.data.text;
    assert.equal(text.status, "dry_run");
    assert.equal(text.hand.to, c.phones[0].e164);
    // with the tracking link (work/track.mjs; tests/crm/work-field/track.test.mjs)
    assert.match(text.hand.body, /^Hi Pat, it's Theo with Barta Window Washing\. I'm on my way and should be there in about 20 minutes\. Follow along here: https:\/\/www\.bartawindowwashing\.com\/p\/track\/[0-9A-Za-z]{10}$/);
    const ob = outbox(t);
    assert.equal(ob.length, 1);
    assert.equal(ob[0].template_key, "on_my_way_track");
    assert.equal(ob[0].category, "service");
    assert.match(ob[0].body, /Reply STOP to opt out\.$/, "the sender adds the footer on a first text, never the template");
    assert.doesNotMatch(text.hand.body, /STOP/, "the words to send by hand leave it out");
    // running late: a new ETA, the second text
    const late = await post(t, tech, `/visits/${v.id}/running-late`, live({ eta_min: 25 }));
    assert.equal(late.status, 200, JSON.stringify(late.body));
    assert.equal(late.body.data.visit.status, "en_route");
    assert.equal(late.body.data.visit.running_late.length, 1);
    assert.match(outbox(t).find((x) => x.template_key === "running_late").body, /running a little behind and should be there in about 25 minutes/);
    // the automation log has both
    const alog = t.stores.data.keys("alog/");
    assert.ok(alog.some((k) => k.includes("visit.on_my_way")) && alog.some((k) => k.includes("visit.running_late")));
  } finally { t.done(); }
});

test("on my way outside texting hours, to someone who opted out, or turned off: the visit still moves, no text, and the tech is told why", async () => {
  const { t, owner, tech } = await setup("2026-11-17T13:30:00Z");                 // 07:30 in Delano
  try {
    const c = await customer(owner);
    const v = await visit(owner, await job(owner, c), { date: "2026-11-17", start: "08:00", end: "10:00", assignee_ids: [tech.id] });
    let r = await post(t, tech, `/visits/${v.id}/on-my-way`, live({ eta_min: 15 }));
    assert.equal(r.status, 200);
    assert.deepEqual(r.body.data.text, { status: "blocked", reason: "quiet_hours" });
    assert.equal(r.body.data.visit.status, "en_route");
    assert.equal(outbox(t).length, 0, "never scheduled for later: a late on-my-way is worse than none");
    pin("2026-11-17T15:00:00Z");
    const c2 = await customer(owner, { consent: { sms_service: { state: "revoked", source: "manual" } } });
    const v2 = await visit(owner, await job(owner, c2), { date: "2026-11-17", start: "10:00", end: "12:00", assignee_ids: [tech.id] });
    r = await post(t, tech, `/visits/${v2.id}/on-my-way`, live({ eta_min: 15 }));
    assert.equal(r.body.data.text.status, "blocked");
    assert.equal(r.body.data.text.reason, "no_consent");
    // the owner turned the automation off
    await t.api("/automations/visit.on_my_way", { method: "PATCH", as: owner, body: { enabled: false } });
    const v3 = await visit(owner, await job(owner, c), { date: "2026-11-17", start: "13:00", end: "14:00", assignee_ids: [tech.id] });
    r = await post(t, tech, `/visits/${v3.id}/on-my-way`, live({ eta_min: 15 }));
    assert.deepEqual(r.body.data.text, { status: "off", reason: "turned_off" });
    r = await post(t, tech, `/visits/${v3.id}/on-my-way`, live({ eta_min: 0 }));
    assert.equal(r.status, 400, "an ETA in minutes, 1 to 240");
  } finally { t.done(); }
});

test("the day payload: the person's own visits in route order, techFields only, prices with visits:prices only, badges, last notes", async () => {
  const { t, owner, admin, tech, tech2 } = await setup();
  try {
    const c = await customer(owner, { notes: `${CANARY} (contact notes)` });
    await store.updateRecord("property", c.primary_property_id, (p) => ({ ...p, access: { gate_code: "4321", pets: "Dog", notes: "Side gate" } }), AS(owner));
    const j = await job(owner, c, { office_notes: CANARY, crew_notes: "Synthetic: ladder needed." });
    // a finished visit last week with notes, then today's two
    const prior = await visit(owner, j, { date: "2026-11-10", start: "09:00", end: "11:00", assignee_ids: [tech.id] });
    await store.updateRecord("visit", prior.id, (x) => ({ ...x, status: "completed", tech_notes: "Synthetic: hard water on the south side.", completion: { at: "2026-11-10T17:00:00.000Z", by: tech.id } }), AS(owner));
    const j2 = await job(owner, c, { office_notes: CANARY, crew_notes: "Synthetic: ladder needed." });
    const late = await visit(owner, j2, { date: "2026-11-17", start: "13:00", end: "15:00", assignee_ids: [tech.id], route_order: { [tech.id]: 1 } });
    const early = await visit(owner, await job(owner, await customer(owner)), { date: "2026-11-17", start: "08:00", end: "10:00", assignee_ids: [tech.id, tech2.id], route_order: { [tech.id]: 2 } });
    await visit(owner, await job(owner, await customer(owner)), { date: "2026-11-17", start: "11:00", end: "12:00", assignee_ids: [tech2.id] });
    const cancelled = await visit(owner, await job(owner, c), { date: "2026-11-17", start: "16:00", end: "17:00", assignee_ids: [tech.id] });
    await post(t, admin, `/visits/${cancelled.id}/cancel`, { reason: "Customer called" });

    const r = await t.api("/tech/day", { as: tech });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    const d = r.body.data;
    assert.equal(d.date, "2026-11-17");
    assert.deepEqual(d.stops.map((s) => s.visit.id), [late.id, early.id], "route order, cancelled left out, Tess's own left out");
    assert.ok(!r.text.includes(CANARY), "no office notes, no contact notes");
    const VTF = new Set((await import("../../../netlify/lib/crm/modules/work/types.mjs")).VISIT_TECH_FIELDS);
    for (const s of d.stops) {
      assert.deepEqual(Object.keys(s.visit).filter((k) => !VTF.has(k)), [], "techFields only");
      assert.deepEqual(Object.keys(s.contact).sort(), ["display_name", "first_name", "id", "phones"]);
    }
    const s0 = d.stops[0];
    assert.equal(s0.name, "Pat S.");
    assert.equal(s0.property.access.gate_code, "4321");
    assert.deepEqual(s0.badges.map((b) => b.key).sort(), ["gate", "pets"]);
    assert.equal(s0.job.crew_notes, "Synthetic: ladder needed.");
    assert.equal(s0.job.office_notes, undefined);
    assert.equal(s0.last_notes.text, "Synthetic: hard water on the south side.");
    assert.equal(s0.last_notes.date, "2026-11-10");
    assert.equal(s0.job.lines[0].unit_cents, 29500, "D11: techs see their own visit's prices");
    assert.equal(s0.prices, true);
    assert.equal(d.clock.open, null);

    // the owner turns visit prices off for techs: titles and quantities only
    await t.api("/settings/permissions", { method: "PUT", as: owner, ifMatch: "new", body: { roles: { tech: { "visits:prices": false } } } });
    const auth = await import("../../../netlify/lib/crm/core/auth.mjs");
    auth.clearPermissionsCache();
    const r2 = await t.api("/tech/day", { as: tech });
    const line = r2.body.data.stops[0].job.lines[0];
    assert.equal(line.unit_cents, undefined);
    assert.equal(line.total_cents, undefined);
    assert.equal(r2.body.data.stops[0].job.totals, undefined);
    assert.equal(r2.body.data.stops[0].prices, false);
    const book = await t.api(`/visits/${late.id}/pricebook`, { as: tech });
    assert.equal(book.status, 200);
    assert.equal(book.body.data.prices, false);

    // a tech with no visits that day: an empty day
    const r3 = await t.api("/tech/day?date=2026-11-18", { as: tech2 });
    assert.equal(r3.body.data.stops.length, 0);
  } finally { t.done(); }
});

test("photos: through the JSON route or /files with owner_type=visit; bytes kept as sent; issue photos aren't for the customer", async () => {
  const { t, owner, tech, tech2 } = await setup();
  try {
    const v = await visit(owner, await job(owner, await customer(owner)), { date: "2026-11-17", start: "09:00", end: "11:00", assignee_ids: [tech.id] });
    // a JPEG with an EXIF segment: kept byte for byte (the owner's rule: never strip GPS or EXIF)
    const exif = Buffer.from([0xff, 0xd8, 0xff, 0xe1, 0x00, 0x10, ...Buffer.from("Exif\0\0", "latin1"), 0x49, 0x49, 0x2a, 0x00, 0x08, 0x00, 0x00, 0x00, 0xff, 0xd9]);
    let r = await post(t, tech, `/visits/${v.id}/photos`, live({ data: exif.toString("base64"), tag: "issue", caption: "Synthetic: cracked pane" }));
    assert.equal(r.status, 201, JSON.stringify(r.body));
    const fileId = r.body.data.photo.id;
    const dl = await t.api(`/files/${fileId}`, { as: tech });
    assert.equal(dl.status, 200);
    assert.equal(Buffer.from(dl.text, "latin1").includes(Buffer.from("Exif", "latin1")), true);
    let after = await rec("visit", v.id);
    assert.equal(after.photos[0].tag, "issue");
    assert.equal(after.photos[0].customer_visible, false);
    // a PNG named a JPEG is still a PNG (magic bytes), and HTML is refused
    r = await post(t, tech, `/visits/${v.id}/photos`, live({ data: Buffer.from(BYTES.png()).toString("base64"), tag: "before" }));
    assert.equal(r.status, 201);
    assert.equal(t.stores.data.json(`rec/file/${r.body.data.photo.id}`).content_type, "image/png");
    r = await post(t, tech, `/visits/${v.id}/photos`, live({ data: Buffer.from(BYTES.html()).toString("base64"), tag: "before" }));
    assert.equal(r.status, 400);
    // the raw files route works for a visit too, and ticks the item named
    const raw = await t.api(`/files?owner_type=visit&owner_id=${v.id}&kind=photo&tag=after&item=after_photo&client_id=${cid()}`, { method: "POST", as: tech, raw: BYTES.jpeg(), headers: { "content-type": "image/jpeg" } });
    assert.equal(raw.status, 201, JSON.stringify(raw.body));
    after = await rec("visit", v.id);
    assert.equal(after.photos.length, 3);
    assert.ok(after.checklist.items.find((i) => i.key === "after_photo").done_at, "the item is done by its photo");
    assert.equal(after.photos.find((p) => p.tag === "after").customer_visible, true);
    // someone not on the visit can't add one, nor read one
    r = await post(t, tech2, `/visits/${v.id}/photos`, live({ data: jpeg(), tag: "before" }));
    assert.equal(r.status, 404);
    assert.equal((await t.api(`/files/${fileId}`, { as: tech2 })).status, 403);
    assert.equal((await t.api(`/files/${fileId}`, { as: owner })).status, 200, "the office reads them");
  } finally { t.done(); }
});

test("the checklist: items by kind; nothing undone on a closed visit; notes add up and stay under the cap", async () => {
  const { t, owner, tech } = await setup();
  try {
    const c = await customer(owner);
    const j = await job(owner, c, { kind: "lights_install", lines: [{ title: "Christmas lights install", unit_cents: 90000, service_type: "Christmas Lights" }] });
    const v = await visit(owner, j, { date: "2026-11-17", start: "09:00", end: "13:00", assignee_ids: [tech.id] });
    assert.equal(v.checklist.template_key, "lights_install");
    let r = await patch(t, tech, `/visits/${v.id}/checklist`, { key: "clips", done: true, value: 240 });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(r.body.data.visit.checklist.items.find((i) => i.key === "clips").value, 240);
    r = await patch(t, tech, `/visits/${v.id}/checklist`, { key: "clips", done: true, value: -1 });
    assert.equal(r.status, 400);
    r = await patch(t, tech, `/visits/${v.id}/checklist`, { key: "power_notes", done: true, value: "" });
    assert.equal(r.status, 400, "a note item needs words");
    r = await patch(t, tech, `/visits/${v.id}/checklist`, { key: "power_notes", done: true, value: "Synthetic: outlet by the garage." });
    assert.equal(r.status, 200);
    r = await patch(t, tech, `/visits/${v.id}/checklist`, { key: "timer_set", done: true });
    r = await patch(t, tech, `/visits/${v.id}/checklist`, { key: "timer_set", done: false });
    assert.equal(r.body.data.visit.checklist.items.find((i) => i.key === "timer_set").done_at, undefined, "unticked");
    r = await patch(t, tech, `/visits/${v.id}/checklist`, { key: "nope", done: true });
    assert.equal(r.status, 400);
    await patch(t, tech, `/visits/${v.id}/checklist`, { key: "timer_set", done: true });
    r = await post(t, tech, `/visits/${v.id}/complete`, live());
    assert.equal(r.status, 200, JSON.stringify(r.body));
    r = await patch(t, tech, `/visits/${v.id}/checklist`, { key: "timer_set", done: false });
    assert.equal(r.status, 409, "a closed visit keeps its checklist");
    // notes: appended, capped
    const v2 = await visit(owner, await job(owner, c), { date: "2026-11-17", start: "14:00", end: "15:00", assignee_ids: [tech.id] });
    await post(t, tech, `/visits/${v2.id}/notes`, live({ text: "Synthetic: one." }));
    r = await post(t, tech, `/visits/${v2.id}/notes`, live({ text: "Synthetic: two." }));
    assert.equal(r.body.data.visit.tech_notes, "Synthetic: one.\n\nSynthetic: two.");
    for (let i = 0; i < 5; i++) r = await post(t, tech, `/visits/${v2.id}/notes`, live({ text: "x".repeat(990) }));
    assert.equal(r.status, 409, "the notes are full");
    r = await post(t, tech, `/visits/${v2.id}/notes`, { text: "no client id" });
    assert.equal(r.status, 400);
  } finally { t.done(); }
});

test("no access: the visit closes, the owners get the late-cancel decision; an upsell line is the tech's and moves the total", async () => {
  const { t, owner, tech } = await setup();
  try {
    const c = await customer(owner);
    const v = await visit(owner, await job(owner, c), { date: "2026-11-17", start: "09:00", end: "11:00", assignee_ids: [tech.id] });
    let r = await post(t, tech, `/visits/${v.id}/no-access`, live({ note: "Synthetic: gate locked, nobody home." }));
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(r.body.data.visit.status, "no_access");
    const tasks = t.stores.data.keys("rec/task/").map((k) => t.stores.data.json(k));
    assert.ok(tasks.some((x) => x.approval && x.approval.kind === "late_cancel_fee" && x.visit_id === v.id), "M4a's late-cancel approval for the owners");
    r = await post(t, tech, `/visits/${v.id}/timer`, live({ action: "start" }));
    assert.equal(r.status, 409, "a visit with no access is closed");

    const j = await job(owner, c);
    const v2 = await visit(owner, j, { date: "2026-11-17", start: "12:00", end: "13:00", assignee_ids: [tech.id] });
    const item = (await store.createRecord("price_item", { key: "tracks", name: "Track Detailing", category: "tracks", service_type: "Residential Window Cleaning", unit: "track", unit_cents: 800, active: true, sellable: true }, AS(owner))).data;
    const off = (await store.createRecord("price_item", { key: "old_thing", name: "Old thing", category: "other", unit: "flat", unit_cents: 1000, active: false, sellable: true }, AS(owner))).data;
    const book = await t.api(`/visits/${v2.id}/pricebook`, { as: tech });
    assert.ok(book.body.data.items.some((i) => i.id === item.id));
    assert.ok(!book.body.data.items.some((i) => i.id === off.id), "inactive items aren't offered");
    r = await post(t, tech, `/visits/${v2.id}/lines`, live({ price_item_id: item.id, qty: 8 }));
    assert.equal(r.status, 201, JSON.stringify(r.body));
    assert.equal(r.body.data.line.total_cents, 6400);
    const jr = await rec("job", j.id);
    const up = jr.lines.find((l) => l.price_item_id === item.id);
    assert.equal(up.upsell_user_id, tech.id, "credited to the tech");
    assert.equal(jr.totals.total_cents, 29500 + 6400);
    r = await post(t, tech, `/visits/${v2.id}/lines`, live({ price_item_id: off.id, qty: 1 }));
    assert.equal(r.status, 400);
  } finally { t.done(); }
});

test("an incident: a high-priority task for the owners with no due date, reported today, linked to the visit", async () => {
  const { t, owner, tech } = await setup();
  try {
    const v = await visit(owner, await job(owner, await customer(owner)), { date: "2026-11-17", start: "09:00", end: "11:00", assignee_ids: [tech.id] });
    const r = await post(t, tech, `/visits/${v.id}/incident`, live({ text: "Synthetic: ladder scuffed the siding.\nCustomer saw it." }));
    assert.equal(r.status, 201, JSON.stringify(r.body));
    assert.deepEqual(Object.keys(r.body.data), ["task_id"], "a tech is told the task's id only");
    const task = await rec("task", r.body.data.task_id);
    assert.equal(task.kind, "incident");
    assert.equal(task.title, "Incident: Synthetic: ladder scuffed the siding.");
    assert.equal(task.priority, "high");
    assert.equal(task.reported_on, "2026-11-17");
    assert.equal(task.due_at, undefined);
    assert.equal(task.visit_id, v.id);
    assert.deepEqual(task.assignee_ids, [owner.id]);
  } finally { t.done(); }
});

test("the office's Timesheets: the week per person, edit with a reason (If-Match), approve the week, decide on what waits", async () => {
  const { t, owner, admin, tech, tech2 } = await setup("2026-11-18T14:00:00Z");      // Wednesday 08:00
  try {
    await post(t, tech, "/clock", live({ action: "in" }));
    advance(hours(8));
    await post(t, tech, "/clock", live({ action: "out" }));
    // Tess: a shift with a device time the server didn't take
    await post(t, tech2, "/clock", offline({ action: "in" }, new Date(clock.nowMs() - hours(7)).toISOString(), { queuedAt: new Date(clock.nowMs() - hours(6)).toISOString() }));
    await post(t, tech2, "/clock", live({ action: "out" }));
    let r = await t.api("/timesheets?week=2026-11-18", { as: admin });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    const wk = r.body.data;
    assert.equal(wk.week_start, "2026-11-15", "Sunday to Saturday");
    const theo = wk.weeks.find((w) => w.user_id === tech.id);
    assert.equal(theo.minutes, 480);
    assert.equal(theo.to_approve, 1);
    assert.equal(wk.pending.length, 1);
    assert.equal(wk.pending[0].uid, tech2.id);
    assert.equal((await t.api("/timesheets", { as: tech })).status, 403, "the office's screen");

    // an edit says why, and needs the version it edited
    const id = theo.entries[0].id;
    const one = await t.api(`/timesheets/${id}`, { as: admin });
    r = await patch(t, admin, `/timesheets/${id}`, { end_at: "2026-11-18T21:30:00.000Z" }, { ifMatch: one.headers.get("etag") });
    assert.equal(r.status, 400);
    assert.equal(r.body.error.field, "reason");
    r = await patch(t, admin, `/timesheets/${id}`, { end_at: "2026-11-18T21:30:00.000Z", reason: "Synthetic: left early." }, { ifMatch: one.headers.get("etag") });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(r.body.data.sheet.minutes, 450);
    assert.equal(r.body.data.sheet.edits[0].reason, "Synthetic: left early.");
    assert.equal(r.body.data.sheet.edits[0].by, admin.id);
    r = await patch(t, admin, `/timesheets/${id}`, { end_at: "2026-11-18T21:45:00.000Z", reason: "again" }, { ifMatch: one.headers.get("etag") });
    assert.equal(r.status, 412, "someone else changed it");
    // the tech sees the edit on their Time screen
    const mine = await t.api("/me/timesheets", { as: tech });
    assert.equal(mine.body.data.shifts[0].edits[0].reason, "Synthetic: left early.");

    r = await post(t, owner, "/timesheets/approve", { user_id: tech.id, week_start: "2026-11-15" });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(r.body.data.approved, 1);
    assert.equal((await rec("timesheet", id)).status, "approved");
    r = await post(t, owner, "/timesheets/approve", { user_id: tech2.id, week_start: "2026-11-15" });
    assert.equal(r.body.data.pending, 1, "what waits needs its own decision");

    const pend = wk.pending[0].id;
    r = await post(t, admin, `/timesheets/${pend}/decide`, { decision: "approve", start_at: "2026-11-18T14:00:00.000Z" });
    assert.equal(r.status, 400, "an edited time says why");
    r = await post(t, admin, `/timesheets/${pend}/decide`, { decision: "approve", start_at: "2026-11-18T14:00:00.000Z", reason: "Synthetic: started at 8." });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(r.body.data.sheet.status, "approved");
    assert.equal(r.body.data.sheet.start_at, "2026-11-18T14:00:00.000Z");
    r = await post(t, admin, `/timesheets/${pend}/decide`, { decision: "reject" });
    assert.equal(r.status, 409, "decided already");
  } finally { t.done(); }
});

test("the pay estimate (D3): $20 an hour for service unless set, overtime over 40 h at 1.5x, Sunday to Saturday; only one's own", async () => {
  const user = { pay: { hourly_cents: { service: 0, sales: 0, office: 0 } } };
  const sh = (m, status = "closed", category = "service") => ({ start_at: "2026-11-16T14:00:00.000Z", end_at: "2026-11-17T00:00:00.000Z", minutes: m, status, category });
  let e = TS.payEstimate([sh(45 * 60)], user);
  assert.equal(e.rate_cents, 2000);
  assert.equal(e.rate_is_default, true);
  assert.deepEqual([e.regular_min, e.ot_min], [2400, 300]);
  assert.equal(e.total_cents, 40 * 2000 + 5 * 3000, "$800 + $150");
  e = TS.payEstimate([sh(30 * 60), sh(10 * 60, "pending_approval"), sh(60, "rejected"), sh(120, "adjusted")], user);
  assert.equal(e.minutes, 1800, "pending, rejected and adjusted time isn't paid here");
  assert.equal(e.pending_min, 600);
  e = TS.payEstimate([sh(40 * 60), sh(10 * 60, "approved", "office")], { pay: { hourly_cents: { service: 2400, office: 1800 } } });
  // 40 h at $24 + 10 h at $18 = $1,140 straight; weighted $22.80; 10 h over at 1.5x = $342
  assert.equal(e.rate_cents, 2280);
  assert.equal(e.regular_cents, 91200);
  assert.equal(e.ot_cents, 34200);
  assert.equal(TS.weekOf("2026-11-21"), "2026-11-15");
  assert.equal(TS.weekOf("2026-11-22"), "2026-11-22");

  const { t, tech, tech2 } = await setup("2026-11-16T14:00:00Z");
  try {
    await post(t, tech, "/clock", live({ action: "in" }));
    advance(hours(9));
    await post(t, tech, "/clock", live({ action: "out" }));
    const r = await t.api("/me/pay", { as: tech });
    assert.equal(r.status, 200);
    assert.equal(r.body.data.estimate.minutes, 540);
    assert.equal(r.body.data.estimate.total_cents, 18000);
    assert.equal(r.body.data.period.start_on, "2026-11-15");
    assert.equal(r.body.data.past.length, 4);
    const other = await t.api("/me/pay", { as: tech2 });
    assert.equal(other.body.data.estimate.minutes, 0, "only one's own");
  } finally { t.done(); }
});
