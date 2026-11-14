// The customer's account (portal/account.mjs; gaps P1 "Portal extras"):
// upcoming visits, history with the photos the tech marked customer-visible,
// invoices with Pay, the plan, request work, reschedule under the 24-hour
// rule, contact info and text/email choices. A customer sees only their own
// data; a document link never opens any of it; GET pages change nothing;
// nothing moves a visit by itself; every page stays inside the portal's
// storage budget (the memory store is strict: one call too many is a 503).
import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { setup, customer, staffPlan, portalCookie, PJSON, scope, store, WORK, AS, drain, BYTES } from "./fixtures.mjs";

const F = await import("../../../netlify/lib/crm/core/files.mjs");
const W = (u) => AS(u);

const hubCookie = (t, c) => portalCookie(t, c.id, { kind: "hub" });
const get = (t, path, cookie) => t.portal(path, { cookie, headers: PJSON });
const postP = (t, path, cookie, body) => t.portal(path, { method: "POST", cookie, headers: PJSON, body });
const tasks = (t) => t.stores.data.keys("rec/task/").map((k) => t.stores.data.json(k));

let jn = 0;
async function visitFor(owner, c, slot, { status, photos } = {}) {
  jn += 1;
  return scope(async () => {
    const [jid] = await WORK.createJobs([{ contact_id: c.id, kind: "standard", lines: [{ title: "Exterior window cleaning", qty_milli: 1000, unit_cents: 29500, service_type: "Residential Window Cleaning" }] }], `acct-job-${jn}-${randomUUID()}`, "manual", W(owner));
    const r = await WORK.createVisit({ job_id: jid, start: "10:00", end: "12:00", window: { type: "window", minutes: 120 }, assignee_ids: [], ...slot }, W(owner));
    let v = r.visit;
    if (status || photos) {
      v = (await store.updateRecord("visit", v.id, (x) => ({ ...x, ...(status ? { status } : {}), ...(photos ? { photos } : {}), ...(status === "completed" ? { completion: { at: "2026-11-10T17:00:00.000Z", by: owner.id } } : {}) }), W(owner))).data;
    }
    return v;
  });
}
const photoOf = (owner, visitId) => scope(() => F.storeImportedFile({ bytes: BYTES.jpeg(), owner: { type: "visit", id: visitId }, kind: "photo" }, { by: owner.id, origin: "api", actor_kind: "user", requestId: "t" }));
async function invoiceFor(t, owner, c, cents = 29500) {
  const r = await t.api("/invoices", { method: "POST", as: owner, body: { contact_id: c.id, lines: [{ description: "Exterior window cleaning", unit_cents: cents }], issue: true, client_id: randomUUID(), use_credit: false } });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  return r.body.data.invoice;
}

// Two customers, each with a visit coming up, a finished one with photos and an open invoice.
async function twoCustomers(t, owner) {
  const a = await customer(owner);
  const b = await customer(owner, { first_name: "Jordan" });
  const out = {};
  for (const [k, c] of [["a", a], ["b", b]]) {
    const next = await visitFor(owner, c, { date: "2026-11-24" });
    const past = await visitFor(owner, c, { date: "2026-11-10" });
    const before = await photoOf(owner, past.id);
    const after = await photoOf(owner, past.id);
    const issue = await photoOf(owner, past.id);
    await scope(() => store.updateRecord("visit", past.id, (x) => ({ ...x, status: "completed", completion: { at: "2026-11-10T17:00:00.000Z", by: owner.id }, photos: [
      { file_id: before.id, tag: "before", customer_visible: true, at: "2026-11-10T15:00:00.000Z", by: owner.id },
      { file_id: after.id, tag: "after", customer_visible: true, at: "2026-11-10T16:00:00.000Z", by: owner.id },
      { file_id: issue.id, tag: "issue", customer_visible: false, at: "2026-11-10T16:10:00.000Z", by: owner.id },
    ] }), W(owner)));
    const inv = await invoiceFor(t, owner, c, k === "a" ? 24310 : 51200);
    out[k] = { c, next, past, before, after, issue, inv };
  }
  return out;
}

test("a customer sees only their own visits, photos, invoices and requests; a document link or no cookie opens none of it", async () => {
  const { t, owner } = await setup();
  try {
    const { a, b } = await twoCustomers(t, owner);
    const ck = await hubCookie(t, a.c);
    // the hub: A's next visit and invoice, never B's, never an address
    const hub = await get(t, "/p/hub", ck);
    assert.equal(hub.status, 200, hub.text.slice(0, 300));
    assert.match(hub.text, /Hi Pat!/);
    assert.match(hub.text, /Tue, Nov 24/);
    assert.match(hub.text, /Arriving between 10:00 AM and 12:00 PM/);
    assert.match(hub.text, new RegExp(`data-open-id="${a.inv.id}"`));
    assert.match(hub.text, /\$243\.10 due/);
    assert.doesNotMatch(hub.text, new RegExp(b.inv.id));
    assert.doesNotMatch(hub.text, /\$512\.00/);
    assert.doesNotMatch(hub.text, /Example Ave|Jordan/);
    assert.match(hub.text, /\/crm-app\/portal\/account\.js/);
    assert.doesNotMatch(hub.text, /<script>(?!<\/script>)/, "no inline script");
    // upcoming visits
    const vis = await get(t, "/p/visits", ck);
    assert.equal(vis.status, 200);
    assert.ok(vis.text.includes(`data-visit="${a.next.id}"`));
    assert.ok(!vis.text.includes(b.next.id));
    // history: A's before and after photos, not the issue photo, not B's
    const hist = await get(t, "/p/history", ck);
    assert.equal(hist.status, 200);
    assert.ok(hist.text.includes(a.before.id) && hist.text.includes(a.after.id));
    assert.ok(!hist.text.includes(a.issue.id), "an issue photo stays with the office");
    assert.ok(!hist.text.includes(b.before.id));
    assert.match(hist.text, /Tue, Nov 10/);
    assert.equal((await get(t, `/api/portal/hub/files/${a.before.id}`, ck)).status, 200);
    assert.equal((await get(t, `/api/portal/hub/files/${a.issue.id}`, ck)).status, 404, "not customer-visible");
    assert.equal((await get(t, `/api/portal/hub/files/${b.before.id}`, ck)).status, 404, "someone else's photo");
    assert.equal((await get(t, "/api/portal/hub/files/fl_00000000000000000001", ck)).status, 404);
    // someone else's visit and invoice are "not here"
    assert.equal((await get(t, `/p/visits/${b.next.id}/reschedule`, ck)).status, 404);
    assert.equal((await postP(t, `/api/portal/visits/${b.next.id}/reschedule-request`, ck, { client_id: randomUUID(), dates: ["2026-11-30"] })).status, 404);
    assert.equal((await postP(t, "/api/portal/hub/open", ck, { kind: "invoice", id: b.inv.id })).status, 404);
    const mine = await postP(t, "/api/portal/hub/open", ck, { kind: "invoice", id: a.inv.id });
    assert.equal(mine.status, 200);
    // the short link opens the invoice and the hub keeps working (a grant, not a new cookie)
    const opened = await t.portal("/api/portal/open", { method: "POST", cookie: ck, headers: PJSON, body: { code: mine.body.data.location.slice(3) } });
    assert.equal(opened.body.data.location, `/p/invoice/${a.inv.id}`);
    assert.equal((await get(t, `/p/invoice/${a.inv.id}`, ck)).status, 200, "Pay opens from the hub");
    assert.equal((await get(t, "/p/hub", ck)).status, 200);
    // a quote link's cookie (or none) opens none of the account pages or APIs
    const quoteCk = await portalCookie(t, a.c.id, { kind: "quote", id: "qt_00000000000000000001" });
    for (const path of ["/p/hub", "/p/visits", "/p/history", "/p/plan", "/p/request", "/p/account", `/p/visits/${a.next.id}/reschedule`]) {
      assert.equal((await get(t, path, quoteCk)).status, 401, path);
      assert.equal((await get(t, path, null)).status, 401, path);
    }
    for (const [path, body] of [["/api/portal/requests", { client_id: randomUUID(), services: ["gutters"] }], ["/api/portal/preferences", { channel: "sms_marketing", on: true }], ["/api/portal/contact-info", { client_id: randomUUID(), note: "x" }], [`/api/portal/visits/${a.next.id}/reschedule-request`, { client_id: randomUUID(), dates: ["2026-11-30"] }]]) {
      assert.equal((await postP(t, path, quoteCk, body)).status, 401, path);
    }
    assert.equal((await get(t, `/api/portal/hub/files/${a.before.id}`, quoteCk)).status, 401);
    // the portal header (CSRF) is required on every POST
    assert.equal((await t.portal("/api/portal/requests", { method: "POST", cookie: ck, headers: { ...PJSON, "x-crm-portal": "" }, body: { client_id: randomUUID(), services: ["gutters"] } })).status, 403);
    assert.equal(tasks(t).length, 0, "nothing was written");
  } finally { t.done(); }
});

test("reschedule: 24 hours or more ahead becomes an office task (nothing moves); under 24 hours shows the $50 late fee and refuses", async () => {
  const { t, owner } = await setup();
  try {
    const c = await customer(owner);
    const far = await visitFor(owner, c, { date: "2026-11-20" });
    const soon = await visitFor(owner, c, { date: "2026-11-18", start: "08:00", end: "10:00" });     // 23 hours from Tue 09:00
    const ck = await hubCookie(t, c);
    const page = await get(t, `/p/visits/${far.id}/reschedule`, ck);
    assert.equal(page.status, 200);
    assert.match(page.text, /Moving it is free with at least 24 hours' notice/);
    assert.match(page.text, /data-reschedule-form/);
    const body = { client_id: randomUUID(), dates: ["2026-11-25", "2026-11-26"], note: "Mornings are best." };
    const r = await postP(t, `/api/portal/visits/${far.id}/reschedule-request`, ck, body);
    assert.equal(r.status, 201, JSON.stringify(r.body));
    const again = await postP(t, `/api/portal/visits/${far.id}/reschedule-request`, ck, body);
    assert.equal(again.body.data.request_id, r.body.data.request_id, "a double tap is one request");
    const list = tasks(t);
    assert.equal(list.length, 1);
    assert.equal(list[0].title, "Reschedule request: Fri, Nov 20");
    assert.equal(list[0].visit_id, far.id);
    assert.match(list[0].notes, /Days that work: Wed, Nov 25, Thu, Nov 26/);
    assert.match(list[0].notes, /Nothing was moved/);
    assert.ok(list[0].assignee_ids.includes(owner.id), "the office has it");
    const v = (await scope(() => store.getRecord("visit", far.id))).data;
    assert.deepEqual([v.date, v.start, v.status], ["2026-11-20", "10:00", "scheduled"], "nothing moves by itself");
    // late: the policy page and a 409
    const late = await get(t, `/p/visits/${soon.id}/reschedule`, ck);
    assert.match(late.text, /less than 24 hours/);
    assert.match(late.text, /\$50\.00 late fee/);
    assert.doesNotMatch(late.text, /data-reschedule-form/);
    const lr = await postP(t, `/api/portal/visits/${soon.id}/reschedule-request`, ck, { client_id: randomUUID(), dates: ["2026-11-25"] });
    assert.equal(lr.status, 409);
    assert.equal(lr.body.error.code, "late");
    assert.match(lr.body.error.message, /\$50\.00 late fee/);
    // a day in the past or junk
    assert.equal((await postP(t, `/api/portal/visits/${far.id}/reschedule-request`, ck, { client_id: randomUUID(), dates: ["2026-11-17"] })).status, 400);
    assert.equal((await postP(t, `/api/portal/visits/${far.id}/reschedule-request`, ck, { client_id: randomUUID(), dates: ["soon"] })).status, 400);
    assert.equal(tasks(t).length, 1);
    assert.doesNotMatch(late.text + page.text, /—|licensed/i, "Barta's voice");
  } finally { t.done(); }
});

test("request work: services, notes and photos become a task for the office with the photos on it; capped at 5 a day; bad photos refused", async () => {
  const { t, owner, tech } = await setup();
  try {
    const c = await customer(owner);
    const other = await customer(owner);
    const ck = await hubCookie(t, c);
    const page = await get(t, "/p/request", ck);
    assert.equal(page.status, 200);
    assert.match(page.text, /Gutter cleaning/);
    assert.doesNotMatch(page.text, /Example Ave/);
    const photo = Buffer.from(BYTES.jpeg()).toString("base64");
    const body = { client_id: randomUUID(), services: ["gutters", "screens", "bogus"], timing: "two_weeks", notes: "Synthetic: back gutters overflow.", photos: [photo] };
    const r = await postP(t, "/api/portal/requests", ck, body);
    assert.equal(r.status, 201, JSON.stringify(r.body));
    const again = await postP(t, "/api/portal/requests", ck, body);
    assert.equal(again.status, 200);
    assert.equal(again.body.data.request_id, r.body.data.request_id);
    const [task] = tasks(t);
    assert.equal(task.title, "Work request: Gutter cleaning, Screen cleaning");
    assert.equal(task.contact_id, c.id);
    assert.equal(task.source, "portal");
    assert.match(task.notes, /When: In the next two weeks\./);
    assert.match(task.notes, /back gutters overflow/);
    assert.equal(task.photo_ids.length, 1, "the photo rides on the task, once");
    const file = t.stores.data.json(`rec/file/${task.photo_ids[0]}`);
    assert.deepEqual(file.owner, { type: "task", id: task.id });
    assert.equal(file.customer_visible, false);
    assert.equal((await t.api(`/files/${file.id}`, { as: owner })).status, 200, "the office sees the photo");
    assert.ok([403, 404].includes((await t.api(`/files/${file.id}`, { as: tech })).status), "a tech who isn't on the task doesn't");
    await drain(t, 2);
    assert.ok(t.stores.data.keys("rec/notification/").length >= 1, "the office is told");
    // refused: nothing picked, a PDF as a photo, someone else's place, too many photos
    assert.equal((await postP(t, "/api/portal/requests", ck, { client_id: randomUUID(), services: [] })).status, 400);
    assert.equal((await postP(t, "/api/portal/requests", ck, { client_id: randomUUID(), services: ["gutters"], photos: [Buffer.from(BYTES.pdf()).toString("base64")] })).status, 400);
    assert.equal((await postP(t, "/api/portal/requests", ck, { client_id: randomUUID(), services: ["gutters"], property_id: other.primary_property_id })).status, 400);
    assert.equal((await postP(t, "/api/portal/requests", ck, { client_id: randomUUID(), services: ["gutters"], photos: [photo, photo, photo, photo] })).status, 400);
    // 5 a day per customer
    for (let i = 0; i < 4; i++) assert.equal((await postP(t, "/api/portal/requests", ck, { client_id: randomUUID(), services: ["lights"] })).status, 201);
    assert.equal((await postP(t, "/api/portal/requests", ck, { client_id: randomUUID(), services: ["lights"] })).status, 429);
    assert.equal(tasks(t).length, 5);
  } finally { t.done(); }
});

test("your info: text and email choices save as the customer's own (source portal); new contact details become a task, the contact doesn't change", async () => {
  const { t, owner } = await setup();
  try {
    const c = await customer(owner);
    const ck = await hubCookie(t, c);
    const page = await get(t, "/p/account", ck);
    assert.equal(page.status, 200);
    assert.match(page.text, /\(763\) •••-/, "the number masked");
    assert.match(page.text, /p•••@example\.com/);
    assert.doesNotMatch(page.text, /pat\.sample\d+@example\.com/);
    const on = await postP(t, "/api/portal/preferences", ck, { channel: "sms_marketing", on: true });
    assert.equal(on.status, 200, JSON.stringify(on.body));
    let rec = (await scope(() => store.getRecord("contact", c.id))).data;
    assert.equal(rec.consent.sms_marketing.state, "granted");
    assert.equal(rec.consent.sms_marketing.source, "portal");
    assert.ok(t.stores.data.keys("q/").some((k) => JSON.stringify(t.stores.data.json(k)).includes("consent.changed")), "consent.changed for sales and comms");
    assert.equal((await postP(t, "/api/portal/preferences", ck, { channel: "sms_service", on: false })).status, 200);
    rec = (await scope(() => store.getRecord("contact", c.id))).data;
    assert.equal(rec.consent.sms_service.state, "revoked");
    assert.equal((await postP(t, "/api/portal/preferences", ck, { channel: "flags", on: true })).status, 400);
    assert.equal((await postP(t, "/api/portal/preferences", ck, { channel: "sms_marketing", on: "yes" })).status, 400);
    const info = await postP(t, "/api/portal/contact-info", ck, { client_id: randomUUID(), phone: "(763) 555-0177", email: "pat.new@example.com" });
    assert.equal(info.status, 201, JSON.stringify(info.body));
    const task = tasks(t).find((x) => x.title === "Update contact info");
    assert.ok(task);
    assert.match(task.notes, /Mobile: \(763\) 555-0177/);
    rec = (await scope(() => store.getRecord("contact", c.id))).data;
    assert.equal(rec.phones[0].e164, c.phones[0].e164, "the number on file doesn't change by itself");
    assert.equal((await postP(t, "/api/portal/contact-info", ck, { client_id: randomUUID(), phone: "12" })).status, 400);
    assert.equal((await postP(t, "/api/portal/contact-info", ck, { client_id: randomUUID() })).status, 400);
  } finally { t.done(); }
});

test("the plan page: what's included, the next visit, the perks and the rules; a customer without a plan gets a friendly note", async () => {
  const { t, owner } = await setup();
  try {
    const { contact } = await staffPlan(t, owner);
    const ck = await hubCookie(t, contact);
    const page = await get(t, "/p/plan", ck);
    assert.equal(page.status, 200, page.text.slice(0, 400));
    assert.match(page.text, /Quarterly plan/);
    assert.match(page.text, /Exterior Window Cleaning/);
    assert.match(page.text, /Visits 1, 3 and 4 of each year/);
    assert.match(page.text, /Unlimited Touch-Ups/);
    assert.match(page.text, /7-Day Rain Guarantee/);
    assert.match(page.text, /\$50\.00 late fee/);
    assert.match(page.text, /re-clean it for free/);
    assert.doesNotMatch(page.text, /—|licensed|refund/i);
    const hub = await get(t, "/p/hub", ck);
    assert.match(hub.text, /Your plan/);
    const lone = await customer(owner);
    const p2 = await get(t, "/p/plan", await hubCookie(t, lone));
    assert.match(p2.text, /not on a care plan/);
  } finally { t.done(); }
});

test("budget: a busy customer's hub, visits and history stay inside the portal's 30 storage calls", async () => {
  const { t, owner } = await setup();
  try {
    const c = await customer(owner);
    for (let i = 0; i < 8; i++) await visitFor(owner, c, { date: `2026-12-${String(2 + i).padStart(2, "0")}` });
    for (let i = 0; i < 10; i++) {
      const v = await visitFor(owner, c, { date: `2026-${String(6 + (i % 5)).padStart(2, "0")}-${String(3 + i).padStart(2, "0")}` }, { status: "completed" });
      if (i < 3) { const f = await photoOf(owner, v.id); await scope(() => store.updateRecord("visit", v.id, (x) => ({ ...x, photos: [{ file_id: f.id, tag: "after", customer_visible: true, at: "2026-11-01T00:00:00.000Z", by: owner.id }] }), W(owner))); }
    }
    for (let i = 0; i < 9; i++) await invoiceFor(t, owner, c, 10000 + i);
    for (let i = 0; i < 3; i++) await staffPlan(t, owner, { contact: c });
    const ck = await hubCookie(t, c);
    for (const path of ["/p/hub", "/p/visits", "/p/history", "/p/history?before=2026-05", "/p/plan", "/p/request", "/p/account"]) {
      const r = await get(t, path, ck);
      assert.equal(r.status, 200, `${path}: ${r.status} ${r.text.slice(0, 200)}`);
    }
    const hist = await get(t, "/p/history", ck);
    assert.equal((hist.text.match(/data-open-kind="invoice"/g) || []).length >= 6, true);
    // a request with three photos (its own, larger budget)
    const photo = Buffer.from(BYTES.jpeg()).toString("base64");
    const r = await postP(t, "/api/portal/requests", ck, { client_id: randomUUID(), services: ["windows_ext"], photos: [photo, photo, photo] });
    assert.equal(r.status, 201, JSON.stringify(r.body));
  } finally { t.done(); }
});
