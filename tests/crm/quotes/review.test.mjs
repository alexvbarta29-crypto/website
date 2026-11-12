// Regressions from the M3a review (each was a real bug): an approval that
// failed once blocked the quote for good; a restored quote's old version
// (with ended offers, or past its date) stayed approvable; approval by phone
// dropped the add-ons ticked to start with; two sources for add-on prices;
// Early Bird after its deadline; the 3-year lights discount on one season
// and on every season; staff attaching another record's file; changing an
// engine price without the override permission; 10 free screens on an
// unticked add-on; huge quantities; changes and decline on an edited quote;
// quarterly add-ons on the interior visit.
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  setup, sentQuote, makeContact, oneTime, quarterly, line, portalCookie, approveBody, PJSON, quoteOf, finishRun, fakes, scope, store, Q, P, A, SEED,
  AUTOMATION, pin, advance,
} from "./fixtures.mjs";

const crmAuto = { ...AUTOMATION, mode: { system_of_record: "crm", paused: false } };
const editAndResend = async (t, owner, id) => {
  const cur = await t.api(`/quotes/${id}`, { as: owner });
  const opts = cur.body.data.quote.options.map((o) => ({ ...o, name: `${o.name} (front and back)` }));
  assert.equal((await t.api(`/quotes/${id}`, { method: "PATCH", as: owner, ifMatch: cur.headers.get("etag"), body: { options: opts } })).status, 200);
  assert.equal((await t.api(`/quotes/${id}/send`, { method: "POST", as: owner, body: { channels: ["sms"] } })).status, 200);
  return (await t.api(`/quotes/${id}`, { as: owner })).body.data.current_version;
};

test("B1: an approval whose run failed (a re-send in between) doesn't block the next one: a new try, its own run; a double tap of it is one run", async () => {
  const { t, owner } = await setup();
  const f = fakes({ plans: false, work: false, money: false });
  try {
    const { quote, version } = await sentQuote(t, owner, { options: [oneTime()] });
    const cookie = await portalCookie(t, quote);
    const r1 = await t.portal(`/api/portal/quotes/${quote.id}/approve`, { method: "POST", cookie, headers: PJSON, body: approveBody(version, version.options[0].id) });
    assert.equal(r1.status, 202);
    const v2 = await editAndResend(t, owner, quote.id);
    const run1 = await finishRun(t, r1.body.data.run_id);
    assert.equal(run1.status, "failed");
    assert.equal(run1.error.code, "updated");
    // the customer approves version 2: try 2, a new run (twice: one run)
    const [a, b] = await Promise.all([1, 2].map(() => t.portal(`/api/portal/quotes/${quote.id}/approve`, { method: "POST", cookie, headers: PJSON, body: approveBody(v2, v2.options[0].id) })));
    assert.equal(a.status, 202);
    assert.notEqual(a.body.data.run_id, r1.body.data.run_id);
    assert.equal(b.body.data.run_id, a.body.data.run_id, "a double tap of try 2 is one run");
    assert.equal(a.body.data.run_id, A.approveRunId(quote.id, 1, 2));
    assert.equal((await finishRun(t, a.body.data.run_id)).status, "done");
    const q = await quoteOf(quote.id);
    assert.equal(q.status, "approved");
    assert.equal(q.approvals_count, 1);
    assert.equal(q.approval.attempt, 2);
    assert.equal(q.approval.version_id, v2.id);
    assert.equal(t.stores.data.keys(`op/approve--${quote.id}--1--2`).length, 1, "try 2 is its own op");
    assert.equal(A.approveOpId(quote.id, 1), `approve--${quote.id}--1`, "try 1 keeps the plain id");
    // a replay after it went through: the same (try 2) run
    const again = await t.portal(`/api/portal/quotes/${quote.id}/approve`, { method: "POST", cookie, headers: PJSON, body: approveBody(v2, v2.options[0].id) });
    assert.deepEqual(again.body.data, { run_id: a.body.data.run_id, already: true });
  } finally { f.restore(); t.done(); }
});

test("B1: archived between the tap and the run, restored and re-sent: approved by phone goes through (and a failed try stays history)", async () => {
  const { t, owner } = await setup();
  const f = fakes({ plans: false, work: false, money: false });
  try {
    const { quote, version } = await sentQuote(t, owner, { options: [oneTime()] });
    const cookie = await portalCookie(t, quote);
    const r1 = await t.portal(`/api/portal/quotes/${quote.id}/approve`, { method: "POST", cookie, headers: PJSON, body: approveBody(version, version.options[0].id) });
    await t.api(`/quotes/${quote.id}/archive`, { method: "POST", as: owner, body: {} });
    const run1 = await finishRun(t, r1.body.data.run_id);
    assert.equal(run1.status, "failed");
    assert.equal(run1.error.code, "not_open");
    await t.api(`/quotes/${quote.id}/restore`, { method: "POST", as: owner, body: {} });
    await t.api(`/quotes/${quote.id}/send`, { method: "POST", as: owner, body: { channels: ["sms"] } });
    const v = (await t.api(`/quotes/${quote.id}`, { as: owner })).body.data.current_version;
    const ph = await t.api(`/quotes/${quote.id}/approve`, { method: "POST", as: owner, body: { by_phone: true, option_id: v.options[0].id } });
    assert.equal(ph.status, 202, JSON.stringify(ph.body));
    assert.notEqual(ph.body.data.run_id, r1.body.data.run_id);
    assert.equal((await finishRun(t, ph.body.data.run_id)).status, "done");
    assert.equal((await quoteOf(quote.id)).status, "approved");
    assert.equal((await scope(() => store.getRecord("run", r1.body.data.run_id))).data.status, "failed");
  } finally { f.restore(); t.done(); }
});

test("M1: a restored quote shows nothing to approve until it is sent again; the follow-up's ended offer can't be approved; a version past its date can't either", async () => {
  const { t, owner } = await setup();
  const f = fakes({ plans: false, work: false, money: false });
  try {
    const { quote } = await sentQuote(t, owner, { options: [oneTime()] });
    const cookie = await portalCookie(t, quote);
    await scope(() => Q.applyOffer(quote.id, "followup_50", {}, crmAuto));
    const withOffer = (await t.api(`/quotes/${quote.id}`, { as: owner })).body.data.current_version;
    assert.equal(withOffer.options[0].totals.first_cents, 24500, "the $50 offer is on the version the link shows");
    await scope(() => Q.archiveForSales(quote.id, { reason: "no_response" }, crmAuto));
    assert.equal((await t.api(`/quotes/${quote.id}/restore`, { method: "POST", as: owner, body: {} })).status, 200);
    const q = await quoteOf(quote.id);
    assert.equal(q.status, "draft");
    assert.equal(q.current_version_id, undefined, "a restore leaves no version to approve");
    const page = await t.portal(`/p/quote/${quote.id}`, { cookie });
    assert.doesNotMatch(page.text, /data-approve\b/);
    assert.doesNotMatch(page.text, /\$245\.00/);
    const r = await t.portal(`/api/portal/quotes/${quote.id}/approve`, { method: "POST", cookie, headers: PJSON, body: approveBody(withOffer, withOffer.options[0].id) });
    assert.equal(r.status, 409);
    assert.notEqual((await quoteOf(quote.id)).status, "approved");
    // sent again: the new version has no offer (it ended), at $295
    await t.api(`/quotes/${quote.id}/send`, { method: "POST", as: owner, body: { channels: ["sms"] } });
    const fresh = (await t.api(`/quotes/${quote.id}`, { as: owner })).body.data.current_version;
    assert.equal(fresh.options[0].totals.first_cents, 29500);

    // a version whose offer is no longer on the quote (an offer list changed by hand): refused, said plainly
    await scope(() => store.updateRecord("quote", quote.id, (x) => ({ ...x, current_version_id: withOffer.id, status: "sent" }), crmAuto));
    const page2 = await t.portal(`/p/quote/${quote.id}`, { cookie });
    assert.match(page2.text, /This offer has ended/);
    const r2 = await t.portal(`/api/portal/quotes/${quote.id}/approve`, { method: "POST", cookie, headers: PJSON, body: approveBody(withOffer, withOffer.options[0].id) });
    assert.equal(r2.status, 409);
    assert.equal(r2.body.error.code, "expired");

    // past expires_on (the sweep hasn't run yet): refused, and the page says it expired
    const b = await sentQuote(t, owner, { options: [oneTime()] });
    advance(31 * 86400000);
    const cb = await portalCookie(t, b.quote);
    const late = await t.portal(`/api/portal/quotes/${b.quote.id}/approve`, { method: "POST", cookie: cb, headers: PJSON, body: approveBody(b.version, b.version.options[0].id) });
    assert.equal(late.status, 409);
    assert.equal(late.body.error.code, "expired");
    assert.match((await t.portal(`/p/quote/${b.quote.id}`, { cookie: cb })).text, /This quote has expired/);
    const byPhone = await t.api(`/quotes/${b.quote.id}/approve`, { method: "POST", as: owner, body: { by_phone: true, option_id: b.version.options[0].id } });
    assert.equal(byPhone.status, 409);
    assert.match(byPhone.body.error.message, /Send it again/);
  } finally { f.restore(); t.done(); }
});

test("M2: approved by phone keeps the add-ons ticked to start with (no list sent), or exactly the ones sent", async () => {
  const { t, owner } = await setup();
  const f = fakes({ plans: false, work: true, money: false });
  try {
    const addOn = line({ title: "Premium Track Detailing", qty_milli: 8000, unit_cents: 1500, category: "tracks", unit: "track", optional: true, selected: true });
    const { quote, version } = await sentQuote(t, owner, { options: [oneTime({ lines: [line(), addOn] })] });
    const o = version.options[0];
    assert.equal(o.totals.first_cents, 41500);
    const r = await t.api(`/quotes/${quote.id}/approve`, { method: "POST", as: owner, body: { option_id: o.id, by_phone: true, name_typed: "" } });
    assert.equal(r.status, 202, JSON.stringify(r.body));
    await finishRun(t, r.body.data.run_id);
    const q = await quoteOf(quote.id);
    assert.equal(q.approval.totals.first_cents, 41500, "the total read out on the phone");
    assert.deepEqual(q.approval.selected_line_ids, [o.lines[1].id]);
    assert.deepEqual(f.calls.createJobs[0].jobs[0].lines.map((l) => l.title), ["Exterior Window Cleaning", "Premium Track Detailing"]);
    // the sheet sends the list: unticked on the phone → not approved
    const b = await sentQuote(t, owner, { options: [oneTime({ lines: [line(), addOn] })] });
    const rb = await t.api(`/quotes/${b.quote.id}/approve`, { method: "POST", as: owner, body: { option_id: b.version.options[0].id, by_phone: true, selected_line_ids: [] } });
    await finishRun(t, rb.body.data.run_id);
    assert.equal((await quoteOf(b.quote.id)).approval.totals.first_cents, 29500);
  } finally { f.restore(); t.done(); }
});

test("M3: one source per add-on price: the price-book item (cfg only without one), for screens, tracks and lights per foot", () => {
  const book = SEED.SEED_PRICE_BOOK.map((i) => ({ ...i, id: SEED.seedItemId(i.key) }));
  const cfg = P.pricingWith({ screens: { each_cents: 600, estimate_ratio: 0.5 }, tracks: { standard_cents: 500, premium_cents: 2000 }, lights: { install_per_ft_cents: 900, materials_per_ft_cents: 300 } });
  const s = P.suggestLines({ services: ["screens", "tracks_standard", "tracks_premium"], panes_ext: 40, screens: 10, tracks: { standard: 10, premium: 2 } }, cfg, book);
  assert.deepEqual(s.lines.map((l) => l.unit_cents), [500, 500, 1500], "the book's $5 screens, $5 tracks (the owner, Nov 12), $15 premium");
  const edited = book.map((i) => (i.key === "tracks_standard" ? { ...i, unit_cents: 600 } : i));
  assert.equal(P.suggestLines({ services: ["tracks_standard"], tracks: { standard: 10 } }, P.PRICING_DEFAULTS, edited).lines[0].unit_cents, 600, "standard tracks is one field: the item");
  const lights = P.lightsLines({ runs: [{ label: "Roofline", feet: 100 }] }, cfg, book);
  assert.deepEqual(lights.slice(0, 2).map((l) => l.unit_cents), [800, 200]);
  // no item in the book: cfg's copy
  assert.equal(P.suggestLines({ services: ["tracks_standard"], tracks: { standard: 1 } }, cfg, []).lines[0].unit_cents, 500);
  assert.equal(P.addOnUnit([], "screens", cfg), 600);
  assert.equal(P.addOnUnit(book, "screens", cfg), 500);
});

test("M4: Early Bird after its deadline: not sent, not presented, not approved by phone; dropped on duplicate; the expiry honors offer_until", async () => {
  const { t, owner } = await setup("2026-10-20T16:00:00Z");
  const f = fakes({ plans: false, work: false, money: false });
  try {
    const eb = (until) => ({ key: "early_bird", name: "Early Bird", type: "percentage", value: 5000, scope: { type: "initial" }, ...(until ? { offer_until: until } : {}) });
    const lights = (until) => oneTime({ name: "Christmas lights", lines: [{ title: "Christmas Light Installation", qty_milli: 120000, unit_cents: 800, category: "lights", unit: "ft", service_type: "Christmas Lights" }], discounts: [eb(until)] });
    const a = await sentQuote(t, owner, { options: [lights("2026-11-01")] });
    assert.equal(a.quote.expires_on, "2026-11-01", "priced before Nov 1: good through Nov 1");
    pin("2026-11-05T16:00:00Z");
    // its own offer_until passed (Nov 1), though Dec 1 is still ahead: refused
    const send = await t.api(`/quotes/${a.quote.id}/send`, { method: "POST", as: owner, body: { channels: ["sms"] } });
    assert.equal(send.status, 400);
    assert.match(send.body.error.message, /The Early Bird deadline has passed\. Take the Early Bird discount off, then send\./);
    assert.equal((await t.api(`/quotes/${a.quote.id}/present`, { method: "POST", as: owner, body: {} })).status, 409);
    assert.equal((await t.api(`/quotes/${a.quote.id}/approve`, { method: "POST", as: owner, body: { by_phone: true, option_id: a.version.options[0].id } })).status, 409);
    const cookie = await portalCookie(t, a.quote);
    assert.match((await t.portal(`/p/quote/${a.quote.id}`, { cookie })).text, /This quote has expired|The Early Bird deadline has passed/);
    // after the season's last deadline, without offer_until either
    pin("2026-12-02T16:00:00Z");
    const c = await makeContact(owner);
    const made = await t.api("/quotes", { method: "POST", as: owner, body: { contact_id: c.id, options: [lights(null)] } });
    const s2 = await t.api(`/quotes/${made.body.data.id}/send`, { method: "POST", as: owner, body: { channels: ["sms"] } });
    assert.equal(s2.status, 400);
    // duplicate: the Early Bird that's over stays behind
    const dup = await t.api(`/quotes/${made.body.data.id}/duplicate`, { method: "POST", as: owner, body: {} });
    assert.equal(dup.status, 201, JSON.stringify(dup.body));
    assert.deepEqual(dup.body.data.options[0].discounts, []);
    assert.equal(dup.body.data.options[0].totals.first_cents, 96000);
  } finally { f.restore(); t.done(); }
});

test("M5, M6: the 3-year discount only on a lights plan (never this season only); Early Bird, the 3-year discount and materials every season (the owner, Nov 12)", async () => {
  const { t, owner } = await setup();
  try {
    const one = await t.api("/pricing/lights", { method: "POST", as: owner, body: { runs: [{ label: "Roofline", feet: 150 }], every_season: false, three_year: true } });
    assert.equal(one.status, 400);
    assert.match(one.body.error.message, /every season, not this season only/);
    const c = await makeContact(owner);
    const bad = await t.api("/quotes", { method: "POST", as: owner, body: { contact_id: c.id, options: [oneTime({ discounts: [{ key: "three_year", name: "3-year contract", type: "fixed", value: 10000, scope: { type: "initial" } }] })] } });
    assert.equal(bad.status, 400);
    assert.match(bad.body.error.message, /3-year discount is for a plan/);
    // a 3-year lights plan with Early Bird: every season is $1,500 → 50% → −$200 = $550
    const r = await t.api("/pricing/lights", { method: "POST", as: owner, body: { runs: [{ label: "Roofline", feet: 150 }], early_bird: true, three_year: true } });
    assert.equal(r.status, 200);
    assert.deepEqual(r.body.data.discounts.map((d) => d.scope.type), ["all", "all"]);
    const plan = P.optionTotals({ kind: "plan", plan: r.body.data.plan, lines: r.body.data.lines, discounts: r.body.data.discounts }, P.PRICING_DEFAULTS);
    assert.deepEqual(plan.per_visit_cents, [55000, 55000, 55000]);
    const seed = SEED.SEED_DISCOUNTS.filter((d) => ["early_bird", "three_year"].includes(d.key)).map((d) => [d.default_scope.type, d.value]);
    assert.deepEqual(seed, [["all", 5000], ["all", 20000]]);
    // this season only: no plan, no 3-year
    const once = await t.api("/pricing/lights", { method: "POST", as: owner, body: { runs: [{ label: "Roofline", feet: 150 }], every_season: false } });
    assert.equal(once.body.data.plan, null);
  } finally { t.done(); }
});

test("M7: photo_ids take only this quote's own files; the portal serves only a photo of this quote (never another customer's signature)", async () => {
  const { t, owner } = await setup();
  const f = fakes({ plans: false, work: false, money: false });
  try {
    const a = await sentQuote(t, owner, { options: [oneTime()] });
    const ca = await portalCookie(t, a.quote);
    const ra = await t.portal(`/api/portal/quotes/${a.quote.id}/approve`, { method: "POST", cookie: ca, headers: PJSON, body: approveBody(a.version, a.version.options[0].id) });
    await finishRun(t, ra.body.data.run_id);
    const sigId = (await quoteOf(a.quote.id)).approval.signature_id;
    const c = await makeContact(owner);
    const made = await t.api("/quotes", { method: "POST", as: owner, body: { contact_id: c.id, options: [oneTime()] } });
    const got = await t.api(`/quotes/${made.body.data.id}`, { as: owner });
    const p = await t.api(`/quotes/${made.body.data.id}`, { method: "PATCH", as: owner, ifMatch: got.headers.get("etag"), body: { photo_ids: [sigId] } });
    assert.equal(p.status, 400);
    assert.equal(p.body.error.field, "photo_ids");
    // even if one got in (data from before this fix), the portal won't serve it
    await scope(() => store.updateRecord("quote", made.body.data.id, (x) => ({ ...x, photo_ids: [sigId] }), crmAuto));
    await t.api(`/quotes/${made.body.data.id}/send`, { method: "POST", as: owner, body: { channels: ["sms"] } });
    const qb = await quoteOf(made.body.data.id);
    const cb = await portalCookie(t, qb);
    assert.equal((await t.portal(`/api/portal/quotes/${qb.id}/files/${sigId}`, { cookie: cb })).status, 404);
    // removing a photo (a subset of what's there) is fine
    const g2 = await t.api(`/quotes/${qb.id}`, { as: owner });
    assert.equal((await t.api(`/quotes/${qb.id}`, { method: "PATCH", as: owner, ifMatch: g2.headers.get("etag"), body: { photo_ids: [] } })).status, 200);
  } finally { f.restore(); t.done(); }
});

test("M8: an engine or price-book price changes only as an override (permission and reason); a recount of screens and a hand-priced item are fine", async () => {
  const { t, owner } = await setup();
  try {
    const c = await makeContact(owner);
    const scr = line({ title: "Screen Cleaning", qty_milli: 20000, unit_cents: 500, category: "screens", unit: "screen", price_item_id: SEED.seedItemId("screens"), engine_cents: 10000 });
    const hand = line({ title: "Gutter Cleaning", qty_milli: 1000, unit_cents: 0, category: "gutters", price_item_id: SEED.seedItemId("gutters") });
    const made = await t.api("/quotes", { method: "POST", as: owner, body: { contact_id: c.id, options: [oneTime({ lines: [line({ engine_cents: 29500 }), scr, hand] })] } });
    assert.equal(made.status, 201, JSON.stringify(made.body));
    const denied = await t.user("admin", { denies: ["prices:override"] });
    const edit = async (as, fn) => {
      const got = await t.api(`/quotes/${made.body.data.id}`, { as });
      const opts = got.body.data.quote.options.map((o) => ({ ...o, lines: o.lines.map(fn) }));
      return t.api(`/quotes/${made.body.data.id}`, { method: "PATCH", as, ifMatch: got.headers.get("etag"), body: { options: opts } });
    };
    assert.equal((await edit(denied, (l) => (l.category === "windows_ext" ? { ...l, unit_cents: 100 } : l))).status, 403, "the reviewer's case: no permission");
    const withPerm = await edit(owner, (l) => (l.category === "windows_ext" ? { ...l, unit_cents: 100 } : l));
    assert.equal(withPerm.status, 400);
    assert.match(withPerm.body.error.message, /change the line total and say why/);
    assert.equal((await edit(denied, (l) => (l.category === "windows_ext" ? { ...l, qty_milli: 500 } : l))).status, 403, "the quantity of a flat tier line is its price");
    // a new line claiming a price-book item at another price
    const got = await t.api(`/quotes/${made.body.data.id}`, { as: denied });
    const sneak = got.body.data.quote.options.map((o) => ({ ...o, lines: [...o.lines, line({ title: "Track Detailing", qty_milli: 10000, unit_cents: 100, category: "tracks", unit: "track", price_item_id: SEED.seedItemId("tracks_standard") })] }));
    assert.equal((await t.api(`/quotes/${made.body.data.id}`, { method: "PATCH", as: denied, ifMatch: got.headers.get("etag"), body: { options: sneak } })).status, 403);
    // fine: 24 screens counted on site; the gutters typed in; an override with a reason
    const ok = await edit(denied, (l) => (l.category === "screens" ? { ...l, qty_milli: 24000 } : l.category === "gutters" ? { ...l, unit_cents: 19900 } : l));
    assert.equal(ok.status, 200, JSON.stringify(ok.body));
    assert.equal(ok.body.data.options[0].totals.first_cents, 29500 + 12000 + 19900);
    const ov = await edit(owner, (l) => (l.category === "windows_ext" ? { ...l, override: { cents: 26500, reason: "Neighbor on the same street" } } : l));
    assert.equal(ov.status, 200, JSON.stringify(ov.body));
    assert.equal(ov.body.data.options[0].lines[0].total_cents, 26500);
    // duplicating keeps the prices as they were (a server copy)
    assert.equal((await t.api(`/quotes/${made.body.data.id}/duplicate`, { method: "POST", as: denied, body: {} })).status, 201);
  } finally { t.done(); }
});

test("minor: 10 free screens count only when the screens add-on is ticked; huge amounts are a 400; plan add-ons only on the visit asked for", async () => {
  const { t, owner } = await setup();
  try {
    const scr = line({ title: "Screen Cleaning", qty_milli: 20000, unit_cents: 500, category: "screens", unit: "screen", optional: true });
    const { quote } = await sentQuote(t, owner, { options: [oneTime({ lines: [line(), scr] })] });
    await scope(() => Q.applyOffer(quote.id, "ten_free_screens", {}, crmAuto));
    const q = await quoteOf(quote.id);
    assert.equal(q.options[0].totals.first_cents, 29500, "the add-on isn't ticked: nothing off");
    const d = q.options[0].discounts.find((x) => x.key === "ten_free_screens");
    assert.equal(d.line_id, q.options[0].lines[1].id);
    const ticked = { ...q.options[0], lines: q.options[0].lines.map((l) => (l.optional ? { ...l, selected: true } : l)) };
    assert.equal(P.optionTotals(ticked, P.PRICING_DEFAULTS).first_cents, 29500 + 10000 - 5000, "ticked: $100 of screens, $50 off");
    // the customer's page carries the tie so its live price agrees
    const cookie = await portalCookie(t, q);
    const page = await t.portal(`/p/quote/${quote.id}`, { cookie });
    assert.match(page.text, new RegExp(`&quot;l&quot;:&quot;${d.line_id}&quot;`));

    // huge quantities: 400, never 500
    const c = await makeContact(owner);
    const big = Array.from({ length: 50 }, () => line({ qty_milli: 1000000000, unit_cents: 100000000 }));
    const plan = quarterly({ lines: big, plan: { catalog_key: "monthly", frequency: { interval: "month", count: 1 }, visits_per_year: 52, term_months: 60, billing: "barta_standard" }, discounts: [] });
    assert.equal((await t.api("/quotes", { method: "POST", as: owner, body: { contact_id: c.id, options: [plan] } })).status, 400);
    assert.equal((await t.api("/pricing/totals", { method: "POST", as: owner, body: { option: plan } })).status, 400);

    // quarterly: screens, tracks and gutters only on the visit the customer asked for (the first), never the interior visit 2 (the owner, Nov 12)
    const book = SEED.SEED_PRICE_BOOK.map((i) => ({ ...i, id: SEED.seedItemId(i.key) }));
    const s = P.suggestOption({ services: ["windows_ext", "screens", "tracks_standard", "gutters"], panes_ext: 40, tracks: { standard: 6 }, gutters_cents: 15000, plan: "quarterly" }, P.PRICING_DEFAULTS, book, []);
    for (const l of s.lines.filter((x) => ["screens", "tracks", "gutters"].includes(x.category))) assert.deepEqual(l.scope, { type: "initial" }, l.title);
  } finally { t.done(); }
});

test("minor: on a quote the office is editing (draft, the sent version on the link), approve, changes and decline agree", async () => {
  const { t, owner } = await setup();
  try {
    const { quote } = await sentQuote(t, owner, { options: [oneTime()] });
    const cookie = await portalCookie(t, quote);
    const cur = await t.api(`/quotes/${quote.id}`, { as: owner });
    await t.api(`/quotes/${quote.id}`, { method: "PATCH", as: owner, ifMatch: cur.headers.get("etag"), body: { client_notes: "edited" } });
    assert.equal((await quoteOf(quote.id)).status, "draft");
    assert.equal((await t.portal(`/api/portal/quotes/${quote.id}/changes`, { method: "POST", cookie, headers: PJSON, body: { message: "Add the garage, please." } })).status, 200);
    const b = await sentQuote(t, owner, { options: [oneTime()] });
    const cb = await portalCookie(t, b.quote);
    const cur2 = await t.api(`/quotes/${b.quote.id}`, { as: owner });
    await t.api(`/quotes/${b.quote.id}`, { method: "PATCH", as: owner, ifMatch: cur2.headers.get("etag"), body: { client_notes: "edited" } });
    assert.equal((await t.portal(`/api/portal/quotes/${b.quote.id}/decline`, { method: "POST", cookie: cb, headers: PJSON, body: {} })).status, 200);
  } finally { t.done(); }
});
