// Signs & flyers (sales/signs.mjs, signs-scan.mjs; docs/CRM-SALES.md
// "Signs & flyers"): QR codes for yard signs, door hangers and flyers. The
// codes and who may make them; /q/{code} (counts the scan, sends people on,
// an unknown code is a 404, a flood is held back, nothing personal is
// kept); and a scan that becomes a lead, end to end through the website's
// own quote form (lead.mjs, unchanged: Rotor gets byte for byte what it
// always got) to the contact's source, its deal and follow-up, and the
// code's leads, bookings and money. Synthetic people only.
import { test } from "node:test";
import assert from "node:assert/strict";
import { setup, store, AS, AUTOMATION, drain, hook } from "./fixtures.mjs";

process.env.ROTOR_API_KEY = process.env.ROTOR_API_KEY || "test-dummy-key-not-real";
const S = await import("../../../netlify/lib/crm/modules/sales/signs.mjs");
const SCAN = await import("../../../netlify/lib/crm/modules/sales/signs-scan.mjs");
const qFn = (await import("../../../netlify/functions/crm-q.mjs")).default;
const leadFn = (await import("../../../netlify/functions/lead.mjs")).default;
const OFF = await import("../../../netlify/lib/crm/modules/work/office.mjs");
const U = await import("../../../netlify/lib/crm/modules/money/upsert.mjs");
const qr = await import("../../../crm-app/core/qr.js");

const HOST = "https://www.bartawindowwashing.com";
const IPHONE = "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 Safari/604.1";
const ANDROID = "Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 Chrome/131.0 Mobile Safari/537.36";
const IP = "203.0.113.7";
const uuid = (n) => `00000000-0000-4000-8000-${String(400000 + n).padStart(12, "0")}`;
const scope = (fn) => store.withStoreScope({ requestId: "test" }, fn);
const scan = (path, { ua = IPHONE, ip = IP, method = "GET", cookie } = {}) => qFn(new Request(HOST + path, { method, headers: { "user-agent": ua, ...(cookie ? { cookie } : {}) } }), { ip });
const stats = (t, id) => { const k = `ptr/qr-stats/${id}`; return t.stores.data.keys(k).length ? t.stores.data.json(k) : null; };
const make = async (t, as, body, n) => {
  const r = await t.api("/qr-codes", { method: "POST", as, body: { client_id: uuid(n), ...body } });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  return r.body.data.code;
};

test("a code: made by the office (a short unguessable path, the quote page by default), the same request twice is one code, edited with its version, retired and back; pages outside the public site are refused", async () => {
  const { t, owner, admin } = await setup();
  try {
    const c = await make(t, admin, { name: "Yard sign, Maple Grove", kind: "yard_sign", area: "Maple Grove", placed_on: "2026-10-12" }, 1);
    assert.match(c.slug, S.SLUG_RE);
    assert.equal(c.url, `${HOST}/q/${c.slug}`);
    assert.equal(c.short, `bartawindowwashing.com/q/${c.slug}`);
    assert.deepEqual([c.dest.kind, c.dest_path, c.lead_label], ["quote", "/get-quote.html", "Yard sign: Maple Grove"]);
    assert.deepEqual([c.scans, c.leads, c.booked, c.revenue_cents], [0, 0, 0, 0]);
    // the printed code is small and sturdy: error correction Q, version 4
    const m = qr.qrMatrix(c.url, { ecl: "Q" });
    assert.ok(m.version <= 4, `version ${m.version}`);
    // the same request again is the same code
    const again = await t.api("/qr-codes", { method: "POST", as: admin, body: { client_id: uuid(1), name: "Yard sign, Maple Grove", kind: "yard_sign" } });
    assert.deepEqual([again.status, again.body.data.code.id], [200, c.id]);
    assert.equal(t.stores.data.keys("rec/qr_code/").length, 1);
    // a door hanger to a service page; its label is its name when it has no area
    const d = await make(t, owner, { name: "Door hanger, Oct", kind: "door_hanger", dest: { kind: "page", path: "/services/Gutter-Cleaning.html" } }, 2);
    assert.deepEqual([d.dest_path, d.lead_label], ["/services/gutter-cleaning.html", "Door hanger, Oct"]);
    assert.notEqual(d.slug, c.slug);
    // what a code can't be
    const bad = async (body, field) => {
      const r = await t.api("/qr-codes", { method: "POST", as: owner, body: { client_id: uuid(90 + Math.floor(Math.random() * 9000)), ...body } });
      assert.equal(r.status, 400, JSON.stringify(body));
      if (field) assert.equal(r.body.error.field, field, JSON.stringify(r.body));
    };
    await bad({ kind: "yard_sign" }, "name");
    await bad({ name: "x", kind: "billboard" }, "kind");
    await bad({ name: "x", kind: "flyer", placed_on: "Oct 12" }, "placed_on");
    for (const path of ["https://evil.example/x", "//evil.example", "/crm", "/crm/", "/office", "/api/lead", "/p/abc", "/q/abcd2345", "/../crm", "/services/../crm/", "/assets/js/main.min.js", "/a b.html", "/admin/"]) await bad({ name: "x", kind: "flyer", dest: { kind: "page", path } }, "dest.path");
    await bad({ name: "x", kind: "flyer", client_id: "nope" }, "client_id");
    assert.equal(t.stores.data.keys("rec/qr_code/").length, 2, "nothing made by a bad form");
    // edit: the version it was read at; the short path never changes
    const one = await t.api(`/qr-codes/${c.id}`, { as: owner });
    assert.equal(one.status, 200);
    assert.equal((await t.api(`/qr-codes/${c.id}`, { method: "PATCH", as: owner, body: { area: "Maple Grove East" } })).status, 400, "needs If-Match");
    const p = await t.api(`/qr-codes/${c.id}`, { method: "PATCH", as: owner, ifMatch: one.headers.get("etag") || one.body.etag, body: { area: "Maple Grove East", slug: "zzzzzzzz", placed_on: "" } });
    assert.equal(p.status, 200, JSON.stringify(p.body));
    assert.deepEqual([p.body.data.code.slug, p.body.data.code.lead_label, p.body.data.code.placed_on], [c.slug, "Yard sign: Maple Grove East", null]);
    assert.equal((await t.api(`/qr-codes/${c.id}`, { method: "PATCH", as: owner, ifMatch: one.headers.get("etag") || one.body.etag, body: { name: "Stale" } })).status, 412);
    // retire it: off the list, under Retired, and it still works
    assert.equal((await t.api(`/qr-codes/${c.id}/archive`, { method: "POST", as: owner, body: {} })).body.data.code.archived, true);
    let list = await t.api("/qr-codes", { as: admin });
    assert.deepEqual(list.body.data.map((x) => x.id), [d.id]);
    assert.equal(list.body.meta.archived_count, 1);
    assert.deepEqual((await t.api("/qr-codes?archived=1", { as: admin })).body.data.map((x) => x.id), [c.id]);
    assert.equal((await scan(`/q/${c.slug}`)).status, 302, "a retired sign still sends people to the website");
    await t.api(`/qr-codes/${c.id}/restore`, { method: "POST", as: owner, body: {} });
    list = await t.api("/qr-codes", { as: admin });
    assert.equal(list.body.data.length, 2);
    assert.equal(list.body.meta.totals.scans, 1);
  } finally { t.done(); }
});

test("who may: owners and the office; never a technician, and an owner can take it from the office", async () => {
  const { t, owner, admin, tech } = await setup();
  try {
    const c = await make(t, owner, { name: "Truck", kind: "truck" }, 3);
    const calls = [["GET", "/qr-codes"], ["POST", "/qr-codes", { client_id: uuid(4), name: "x", kind: "flyer" }], ["GET", `/qr-codes/${c.id}`], ["PATCH", `/qr-codes/${c.id}`, { name: "y" }], ["POST", `/qr-codes/${c.id}/archive`, {}], ["POST", `/qr-codes/${c.id}/restore`, {}]];
    for (const [method, path, body] of calls) assert.equal((await t.api(path, { method, as: tech, ...(body ? { body, ifMatch: '"x"' } : {}) })).status, 403, `${method} ${path} as a tech`);
    assert.equal((await t.api("/qr-codes", { as: admin })).status, 200);
    // the permission is the module's own (Settings → Team permissions)
    const R = await import("../../../netlify/lib/crm/core/registry.mjs");
    assert.deepEqual(R.allPerms().find((p) => p.key === "signs:manage").roles, { owner: true, admin: true, tech: false });
    await scope(() => store.putSetting("permissions", { roles: { admin: { "signs:manage": false } } }, { by: owner.id, origin: "api", actor_kind: "user", requestId: "t", ifMatch: "new" }));
    (await import("../../../netlify/lib/crm/core/auth.mjs")).clearPermissionsCache();
    assert.equal((await t.api("/qr-codes", { as: admin })).status, 403);
    assert.equal((await t.api("/qr-codes", { as: owner })).status, 200);
  } finally { t.done(); }
});

test("/q/{code}: counted (when, the kind of phone) and sent on with the source; an unknown code is a 404; a flood is held back; HEAD and link previews count nothing; nothing personal is kept", async () => {
  const { t, owner } = await setup();
  try {
    const c = await make(t, owner, { name: "Yard sign, Maple Grove", kind: "yard_sign", area: "Maple Grove" }, 5);
    const d = await make(t, owner, { name: "Flyer", kind: "flyer", dest: { kind: "page", path: "/services/gutter-cleaning.html" } }, 6);
    const r = await scan(`/q/${c.slug}`);
    assert.equal(r.status, 302);
    assert.equal(r.headers.get("location"), `/get-quote.html?utm_source=qr&utm_medium=yard_sign&utm_campaign=${c.slug}`);
    assert.equal(r.headers.get("cache-control"), "no-store", "every scan reaches the counter");
    const ck = r.headers.get("set-cookie");
    assert.match(ck, new RegExp(`^barta_q=${c.slug}\\.\\d+\\.[A-Za-z0-9_-]{16}; Path=/; Max-Age=2592000; HttpOnly; Secure; SameSite=Lax$`));
    let st = stats(t, c.id);
    assert.deepEqual([st.scans, st.dev.ios, st.days["2026-11-17"], st.first_at, st.last_at], [1, 1, 1, "2026-11-17T14:55:00.000Z", "2026-11-17T14:55:00.000Z"]);
    // the page a flyer sends to; an Android phone; a code typed in capitals; a trailing slash
    const r2 = await scan(`/q/${d.slug.toUpperCase()}/`, { ua: ANDROID, ip: "192.0.2.50" });
    assert.equal(r2.headers.get("location"), `/services/gutter-cleaning.html?utm_source=qr&utm_medium=flyer&utm_campaign=${d.slug}`);
    assert.equal(stats(t, d.id).dev.android, 1);
    // unknown or malformed: a 404 page that still points at the quote page
    for (const path of ["/q/abcd2345", "/q/short", "/q/", "/q/abcd2345/x", `/q/${c.slug}%3Cscript%3E`]) {
      const x = await scan(path);
      assert.equal(x.status, 404, path);
      assert.match(await x.text(), /This code isn(&#39;|')t ours anymore[\s\S]*href="\/get-quote\.html\?utm_source=qr"/);
    }
    assert.equal((await scan(`/q/${c.slug}`, { method: "POST" })).status, 405);
    // HEAD and link previews: sent on, never counted, no cookie
    const h = await scan(`/q/${c.slug}`, { method: "HEAD" });
    assert.equal(h.status, 302);
    const bot = await scan(`/q/${c.slug}`, { ua: "facebookexternalhit/1.1" });
    assert.deepEqual([bot.status, bot.headers.get("set-cookie")], [302, null]);
    assert.equal(stats(t, c.id).scans, 1);
    // a flood from one connection: 30 counted a minute, then held back (with Retry-After); another connection is fine
    for (let i = 1; i < SCAN.SCAN_RATE_PER_MIN; i++) assert.equal((await scan(`/q/${c.slug}`)).status, 302);
    const held = await scan(`/q/${c.slug}`);
    assert.equal(held.status, 429);
    assert.ok(Number(held.headers.get("retry-after")) >= 1);
    assert.match(await held.text(), /Try again in a minute, or go straight to the website/);
    assert.equal(stats(t, c.id).scans, SCAN.SCAN_RATE_PER_MIN, "the held-back scan isn't counted");
    assert.equal((await scan(`/q/${c.slug}`, { ip: "198.51.100.23" })).status, 302);
    // the next minute it counts again
    (await import("../../helpers/crm-clock.mjs")).advance(61 * 1000);
    assert.equal((await scan(`/q/${c.slug}`)).status, 302);
    st = stats(t, c.id);
    assert.equal(st.scans, SCAN.SCAN_RATE_PER_MIN + 2);
    // nothing personal anywhere: no address, no browser string, in keys or values
    const all = t.stores.data.keys("").map((k) => k + " " + JSON.stringify(t.stores.data.json(k) ?? ""));
    for (const secret of [IP, "198.51.100.23", "192.0.2.50", "Pixel 8", "iPhone OS 17_0", "facebookexternalhit"]) assert.equal(all.some((x) => x.includes(secret)), false, `${secret} is kept somewhere`);
    assert.ok(t.stores.data.keys("thr/qr/").length > 0, "the rate limit's day-salted buckets (swept after a day)");
    assert.deepEqual(Object.keys(st).filter((k) => k !== "_w").sort(), ["days", "dev", "first_at", "last_at", "lead_n", "leads", "scans"], "a count, a day, a kind of phone: nothing else");
  } finally { t.done(); }
});

test("a sign keeps working when the CRM can't answer: before its setup, or with storage down, the quote page (uncounted)", async () => {
  const { t, owner } = await setup();
  try {
    const c = await make(t, owner, { name: "Yard sign", kind: "yard_sign" }, 7);
    const saved = { CONTEXT: process.env.CONTEXT, CRM_PRODUCTION: process.env.CRM_PRODUCTION, OFFICE_DATA_KEY: process.env.OFFICE_DATA_KEY };
    process.env.CONTEXT = "production"; delete process.env.CRM_PRODUCTION; delete process.env.OFFICE_DATA_KEY;
    try {
      const before = t.stores.data.calls.length;
      const r = await scan(`/q/${c.slug}`);
      assert.deepEqual([r.status, r.headers.get("location")], [302, "/get-quote.html?utm_source=qr"]);
      assert.equal(t.stores.data.calls.length, before, "no store call");
    } finally { for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; } }
    // storage that doesn't answer the lookup
    t.stores.data.fail({ op: "read", key: /^ptr\/qr-slug\//, kind: "timeout", times: 20 });
    const r = await scan(`/q/${c.slug}`);
    assert.deepEqual([r.status, r.headers.get("location")], [302, "/get-quote.html?utm_source=qr"]);
    assert.equal(r.headers.get("set-cookie"), null);
    assert.equal(stats(t, c.id), null, "uncounted");
  } finally { t.done(); }
});

test("a scan becomes a lead, end to end: the quote form (lead.mjs, Rotor's payload unchanged) → the contact's source \"Yard sign: Maple Grove\", its deal and follow-up, the call list; the code's leads, bookings and money", async () => {
  const { t, owner, admin } = await setup();
  const rotorBodies = [];
  const strict = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    if (String(url).startsWith("https://api.getrotor.com/")) { rotorBodies.push(init.body); return new Response(JSON.stringify({ id: `rl-${rotorBodies.length}` }), { status: 201 }); }
    return strict(url, init);
  };
  try {
    await scope(() => store.putSetting("intake", { mode: "dual" }, { by: owner.id, origin: "api", actor_kind: "user", requestId: "t", ifMatch: "new" }));
    hook.clearModeCache();
    const c = await make(t, owner, { name: "Yard sign, Maple Grove", kind: "yard_sign", area: "Maple Grove" }, 8);
    const s = await scan(`/q/${c.slug}`);
    const cookie = s.headers.get("set-cookie").split(";")[0];
    const form = (n, extra = {}) => ({
      first_name: "Quinn", last_name: `Signfolk${n}`, phone: `(763) 555-02${String(n).padStart(2, "0")}`, email: `quinn.signfolk${n}@example.com`,
      address_street: `${n} Example Ave`, address_city: "Maple Grove", address_state: "MN", address_zip: "55311",
      services: ["Exterior Window Cleaning"], referral_source: "Yard Sign", notes: "Saw your sign.", reminders: "on", page: "/get-quote.html", ...extra,
    });
    const post = async (b, ck) => {
      const waits = [];
      const res = await leadFn(new Request(`${HOST}/api/lead`, { method: "POST", headers: { "content-type": "application/json", ...(ck ? { cookie: ck } : {}) }, body: JSON.stringify(b) }), { waitUntil: (p) => waits.push(p) });
      await Promise.all(waits);
      return res;
    };
    assert.equal((await post(form(11), `other=1; ${cookie}`)).status, 200);
    assert.equal((await post(form(12))).status, 200);
    // Rotor got exactly what it would have without the scan (the same form, the same tags, no code anywhere)
    const [withScan, without] = rotorBodies.map((b) => JSON.parse(b));
    assert.deepEqual(Object.keys(withScan).sort(), Object.keys(without).sort());
    assert.deepEqual(withScan.tags, ["Website", "Yard Sign"]);
    assert.doesNotMatch(rotorBodies[0], new RegExp(c.slug));
    const contacts = t.stores.data.keys("rec/contact/").map((k) => t.stores.data.json(k));
    const q = contacts.find((x) => x.last_name === "Signfolk11");
    const plain = contacts.find((x) => x.last_name === "Signfolk12");
    assert.deepEqual([q.source.source, q.source.campaign, q.source.qr_code, q.source.channel], ["Website quote form", "Yard sign: Maple Grove", c.id, "Yard Sign"]);
    assert.equal(plain.source.qr_code, undefined);
    // the follow-up and the deal say where it came from; the call list shows it
    await drain(t);
    const en = t.stores.data.keys("rec/enrollment/").map((k) => t.stores.data.json(k)).find((e) => e.contact_id === q.id);
    assert.equal(en.source_label, "Yard sign: Maple Grove");
    const dl = t.stores.data.json(`rec/deal/${en.deal_id}`);
    assert.deepEqual([dl.source.source, dl.source.campaign, dl.source.qr_code], ["Website quote form", "Yard sign: Maple Grove", c.id]);
    const calls = await t.api("/calls/list", { as: admin });
    const row = [...calls.body.data.due, ...calls.body.data.later, ...calls.body.data.upcoming].find((r) => r.contact_id === q.id);
    assert.equal(row.source_label, "Yard sign: Maple Grove");
    assert.equal([...calls.body.data.due, ...calls.body.data.later, ...calls.body.data.upcoming].find((r) => r.contact_id === plain.id).source_label, undefined);
    // the code's numbers: one scan, one lead (the same person sending the form again is still one)
    assert.equal((await post(form(11, { notes: "One more thing." }), cookie)).status, 200);
    let one = await t.api(`/qr-codes/${c.id}`, { as: owner });
    assert.deepEqual([one.body.data.code.scans, one.body.data.code.leads, one.body.data.code.booked, one.body.data.code.revenue_cents], [1, 1, 0, 0]);
    assert.deepEqual(one.body.data.leads.map((l) => [l.contact_id, l.name, l.booked]), [[q.id, "Quinn Signfolk11", false]]);
    // they book and pay: a visit done, $295 in cash (the CRM's own records)
    const W = AS(owner);
    const [jobId] = await scope(() => OFF.createJobs([{ contact_id: q.id, kind: "standard", lines: [{ title: "Exterior window cleaning", qty_milli: 1000, unit_cents: 29500, service_type: "Residential Window Cleaning" }] }], "sign-test-job", "manual", W));
    await scope(() => OFF.createVisit({ job_id: jobId, date: "2026-11-20", start: "09:00", end: "11:00", window: { type: "window", minutes: 120 }, assignee_ids: [] }, W));
    await drain(t);
    one = await t.api(`/qr-codes/${c.id}`, { as: owner });
    assert.equal(one.body.data.code.booked, 1, "a visit booked");
    await scope(() => U.upsertPayment({ id: U.payId.client(uuid(9)), contact_id: q.id, kind: "payment", method: "cash", status: "succeeded", amount_cents: 29500, tip_cents: 2000 }, W));
    await drain(t);
    one = await t.api(`/qr-codes/${c.id}`, { as: owner });
    assert.deepEqual([one.body.data.code.booked, one.body.data.code.revenue_cents], [1, 31500]);
    assert.equal(one.body.data.leads[0].paid_cents, 31500);
    const list = await t.api("/qr-codes", { as: owner });
    assert.deepEqual([list.body.meta.totals.scans, list.body.meta.totals.leads, list.body.meta.totals.booked, list.body.meta.totals.revenue_cents], [1, 1, 1, 31500]);
    // the contact screen's data carries the source as stored
    const ct = await t.api(`/contacts/${q.id}`, { as: owner });
    assert.equal(ct.body.data.contact.source.campaign, "Yard sign: Maple Grove");
  } finally { globalThis.fetch = strict; t.done(); }
});

test("a cookie names a code only when it is the site's own, recent and the code is still there", async () => {
  const { t, owner } = await setup();
  try {
    const c = await make(t, owner, { name: "Flyer, Oct", kind: "flyer" }, 10);
    const ref = S.refFor(c.slug);
    assert.deepEqual(await scope(() => S.qrResolve(ref)), { code_id: c.id, label: "Flyer, Oct", scanned_at: "2026-11-17T14:55:00.000Z" });
    const parts = ref.split(".");
    for (const bad of [
      `${parts[0]}.${parts[1]}.${"A".repeat(16)}`,                  // a made-up signature
      `${"abcd2345"}.${parts[1]}.${parts[2]}`,                        // another code with this signature
      S.refFor(c.slug, Date.parse("2026-10-01T00:00:00Z")),          // more than 30 days ago
      S.refFor("zzzz2345"),                                           // a code that isn't there
      "", "x".repeat(200), `${ref};`, `${ref}.x`,
    ]) assert.equal(await scope(() => S.qrResolve(bad)), null, bad);
    // the hook only reads a well-formed cookie, and only for the quote form
    const req = (ck) => new Request(`${HOST}/api/lead`, { method: "POST", headers: { cookie: ck } });
    assert.equal(hook.withScan({ a: 1 }, "lead-form", req(`barta_q=${ref}`)).qr_ref, ref);
    assert.equal(hook.withScan({ a: 1 }, "giveaway", req(`barta_q=${ref}`)).qr_ref, undefined);
    assert.equal(hook.withScan({ a: 1 }, "lead-form", req("barta_q=<script>")).qr_ref, undefined);
    assert.equal(hook.withScan({ a: 1 }, "lead-form", null).qr_ref, undefined);
    // a lead counts once per person for a code
    const someone = "ct_00000000000000000042";
    assert.equal(await scope(() => S.qrLead({ code_id: c.id, contact_id: someone })), true);
    assert.equal(await scope(() => S.qrLead({ code_id: c.id, contact_id: someone })), false);
    assert.equal(await scope(() => S.qrLead({ code_id: "nope", contact_id: someone })), false);
    assert.equal(stats(t, c.id).lead_n, 1);
  } finally { t.done(); }
});

test("the screens: the list with each code's numbers, one code with its QR to print at sign and flyer size, the form; everything escaped", async () => {
  const XSS = "</script><script>alert(1)</script>";
  const ctx = { can: () => true, user: { id: "us_00000000000000000001", role: "owner" }, keep: {}, params: {}, go: () => {} };
  const code = { id: "qr_00000000000000000001", name: `Yard sign ${XSS}`, kind: "yard_sign", area: "Maple Grove", placed_on: "2026-10-12", slug: "abcd2345", url: `${HOST}/q/abcd2345`, short: "bartawindowwashing.com/q/abcd2345", dest: { kind: "quote" }, dest_path: "/get-quote.html", lead_label: "Yard sign: Maple Grove", archived: false, scans: 12, leads: 3, booked: 1, revenue_cents: 29500, last_scan_at: "2026-11-17T14:00:00.000Z" };
  const list = (await import("../../../crm-app/modules/sales/signs.js")).default;
  const out = String(list.render({ tab: "active", codes: [code], meta: { totals: { scans: 12, leads: 3, booked: 1, revenue_cents: 29500 }, archived_count: 2 } }, ctx));
  assert.match(out, /href="#\/signs\/qr_00000000000000000001"/);
  assert.match(out, /<b>12<\/b><small>scans<\/small>[\s\S]*<b>3<\/b><small>leads<\/small>[\s\S]*<b>1<\/b><small>booked<\/small>[\s\S]*<b>\$295\.00<\/b><small>paid<\/small>/);
  assert.match(out, /Yard sign · Maple Grove · placed/);
  assert.match(out, /Retired <span class="n">2<\/span>/);
  assert.doesNotMatch(out, /<script>/);
  assert.match(String(list.render({ tab: "active", codes: [], meta: {} }, ctx)), /No codes yet[\s\S]*href="#\/signs\/new"/);
  const one = (await import("../../../crm-app/modules/sales/sign.js")).default;
  const o = String(one.render({ code, note: null, stats: { days: Array.from({ length: 30 }, (_, i) => ({ date: `2026-10-${String(19 + (i % 12)).padStart(2, "0")}`, n: i === 29 ? 4 : 0 })), dev: { ios: 9, android: 3, other: 0 }, first_at: "2026-10-12T15:00:00.000Z", last_at: "2026-11-17T14:00:00.000Z" }, leads: [{ contact_id: "ct_00000000000000000001", name: `Quinn ${XSS}`, town: "Maple Grove", at: "2026-11-17T14:10:00.000Z", booked: true, paid_cents: 29500 }] }, ctx));
  assert.match(o, /<svg [^>]*viewBox="0 0 41 41"[^>]*aria-label="QR code for Yard sign/);
  assert.match(o, /bartawindowwashing\.com\/q\/abcd2345/);
  assert.match(o, /data-print="sign" data-kind="png"[\s\S]*data-print="sign" data-kind="svg"[\s\S]*data-print="flyer" data-kind="png"/);
  assert.match(o, /Yard sign, 18 × 24 in[\s\S]*Flyer, quarter page/);
  assert.match(o, /iPhone 9 · Android 3/);
  assert.match(o, /Leads from it show as <b>Yard sign: Maple Grove<\/b>/);
  assert.match(o, /href="#\/contacts\/ct_00000000000000000001"[\s\S]*Booked/);
  assert.doesNotMatch(o, /<script>/);
  // the print pictures: 18 × 24 inches and a quarter page, the code's name and short address under it, level Q
  const kit = await import("../../../crm-app/modules/sales/signs-kit.js");
  const sign = kit.printSvg(code, "sign");
  assert.match(sign, /^<svg [^>]*viewBox="0 0 1800 2400" width="18in" height="24in"/);
  assert.match(sign, />Yard sign &lt;\/script&gt;[\s\S]*<\/text><text [^>]*>bartawindowwashing\.com\/q\/abcd2345<\/text>/);
  assert.match(kit.printSvg(code, "flyer"), /viewBox="0 0 1275 1650" width="4.25in" height="5.5in"/);
  const form = (await import("../../../crm-app/modules/sales/sign-form.js"));
  const f = String(form.formBody({}, { isNew: true }));
  assert.match(f, /name="name"[\s\S]*name="kind"[\s\S]*name="area"[\s\S]*name="placed_on"[\s\S]*value="quote" checked[\s\S]*name="dest_path"/);
  assert.deepEqual(form.readCode({ name: "A", kind: "flyer", dest_kind: "page", dest_path: " /reviews.html " }), { name: "A", kind: "flyer", area: "", placed_on: "", note: "", dest: { kind: "page", path: "/reviews.html" } });
  const M = (await import("../../../crm-app/modules/sales/manifest.js")).default;
  assert.ok(M.nav.some((n) => n.path === "/signs" && n.section === "sales" && n.perm === "signs:manage"));
  assert.ok(M.routes.filter((r) => r.path.startsWith("/signs")).every((r) => r.perm === "signs:manage"));
});
