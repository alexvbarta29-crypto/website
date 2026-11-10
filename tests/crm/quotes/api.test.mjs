// The quotes API through the real handlers (design §5.3 "Endpoints", §12.3):
// permissions (techs see nothing; a price override needs prices:override and
// a reason; the price book is the owner's), If-Match, the send through the
// core sender (dry-run, the link inline), Sales hearing quote.*, the portal's
// changes and decline, archive / restore / duplicate, the preview, merges.
import { test } from "node:test";
import assert from "node:assert/strict";
import { setup, sentQuote, makeContact, oneTime, quarterly, line, portalCookie, PJSON, quoteOf, outbox, fakes, scope, store, Q, AS, SEED } from "./fixtures.mjs";

const XSS = "</script><script>alert(1)</script>";

test("create, read, edit (If-Match), list: techs get nothing; prices change only with prices:override and a reason", async () => {
  const { t, owner, admin, tech } = await setup();
  try {
    const c = await makeContact(owner);
    assert.equal((await t.api("/quotes", { as: tech })).status, 403);
    assert.equal((await t.api("/quotes", { method: "POST", as: tech, body: { contact_id: c.id } })).status, 403);
    const made = await t.api("/quotes", { method: "POST", as: owner, body: { client_id: "c-1", contact_id: c.id, options: [oneTime(), quarterly()] } });
    assert.equal(made.status, 201, JSON.stringify(made.body));
    const q = made.body.data;
    assert.match(q.number_label, /^SQ-\d{4}$/, "a shadow number while Rotor is in charge (§3.9)");
    assert.equal(q.status, "draft");
    assert.equal(q.options[0].totals.first_cents, 29500);
    assert.deepEqual(q.options[1].totals.per_visit_cents, [19500, 6000, 19500, 19500]);
    assert.ok(q.options.every((o) => /^op_/.test(o.id) && o.lines.every((l) => /^ln_/.test(l.id))));
    assert.equal(q.sold_by, owner.id);
    const again = await t.api("/quotes", { method: "POST", as: owner, body: { client_id: "c-1", contact_id: c.id, options: [oneTime()] } });
    assert.equal(again.body.data.id, q.id, "a double tap (same client id) is one quote");
    assert.equal(t.stores.data.keys("rec/quote/").length, 1);
    assert.equal((await t.api(`/quotes/${q.id}`, { as: tech })).status, 403);

    const got = await t.api(`/quotes/${q.id}`, { as: admin });
    const etag = got.headers.get("etag");
    // an override without a reason; with a reason; by someone without the permission
    const opts = got.body.data.quote.options.map((o, i) => (i === 0 ? { ...o, lines: [{ ...o.lines[0], override: { cents: 25000 } }] } : o));
    assert.equal((await t.api(`/quotes/${q.id}`, { method: "PATCH", as: admin, ifMatch: etag, body: { options: opts } })).body.error.field, "options.0.lines.0.override.reason");
    const denied = await t.user("admin", { denies: ["prices:override"] });
    assert.equal((await t.api(`/quotes/${q.id}`, { method: "PATCH", as: denied, ifMatch: etag, body: { options: opts.map((o, i) => (i === 0 ? { ...o, lines: [{ ...o.lines[0], override: { cents: 25000, reason: "neighbor deal" } }] } : o)) } })).status, 403);
    const ok = await t.api(`/quotes/${q.id}`, { method: "PATCH", as: admin, ifMatch: etag, body: { options: opts.map((o, i) => (i === 0 ? { ...o, lines: [{ ...o.lines[0], override: { cents: 25000, reason: "neighbor deal" } }] } : o)) } });
    assert.equal(ok.status, 200, JSON.stringify(ok.body));
    const ln = ok.body.data.options[0].lines[0];
    assert.equal(ln.total_cents, 25000);
    assert.equal(ln.override.by, admin.id);
    assert.equal(ln.engine_cents ?? null, null);
    assert.equal(ok.body.data.options[0].totals.first_cents, 25000);
    // the old etag: 412 with the current copy
    const stale = await t.api(`/quotes/${q.id}`, { method: "PATCH", as: owner, ifMatch: etag, body: { client_notes: "x" } });
    assert.equal(stale.status, 412);
    // the same override kept on a later edit by someone without the permission is fine
    const e2 = (await t.api(`/quotes/${q.id}`, { as: denied })).headers.get("etag");
    assert.equal((await t.api(`/quotes/${q.id}`, { method: "PATCH", as: denied, ifMatch: e2, body: { client_notes: "See you soon" } })).status, 200);
    // two plan discounts in one stack group can't combine (D15)
    const e3 = (await t.api(`/quotes/${q.id}`, { as: owner })).headers.get("etag");
    const cur3 = (await t.api(`/quotes/${q.id}`, { as: owner })).body.data.quote.options;
    const two = cur3.map((o) => (o.kind === "plan" ? { ...o, discounts: [...o.discounts, { name: "Neighbor plan deal", type: "fixed", value: 2500, stack_group: "plan" }] } : o));
    const bad = await t.api(`/quotes/${q.id}`, { method: "PATCH", as: owner, ifMatch: e3, body: { options: two } });
    assert.equal(bad.status, 400);
    assert.match(bad.body.error.message, /can't be combined/);
    // a plan's own discount only on that plan (plan_only): not on the quarterly plan, not on a one-time option
    const wrongPlan = cur3.map((o) => (o.kind === "plan" ? { ...o, discounts: [{ key: "plan_biannual", name: "Biannual plan discount", type: "fixed", value: 5000, scope: { type: "all" } }] } : o));
    const wp = await t.api(`/quotes/${q.id}`, { method: "PATCH", as: owner, ifMatch: e3, body: { options: wrongPlan } });
    assert.equal(wp.status, 400);
    assert.match(wp.body.error.message, /for the biannual plan only/);
    const oneTimePlanDisc = cur3.map((o) => (o.kind === "one_time" ? { ...o, discounts: [{ key: "plan_quarterly", name: "Quarterly plan discount", type: "fixed", value: 10000, scope: { type: "all" } }] } : o));
    assert.equal((await t.api(`/quotes/${q.id}`, { method: "PATCH", as: owner, ifMatch: e3, body: { options: oneTimePlanDisc } })).status, 400, "the Quarterly plan discount on a one-time option");
    // measured by square feet: the property keeps it for a re-quote
    const prop = (await scope(() => store.createRecord("property", { contact_id: c.id, label: "Home", address: { street1: "300 Example Ave", city: "Delano", state: "MN", zip: "55328" }, access: {}, assets: {}, photo_ids: [] }, AS(owner)))).data;
    const e4 = (await t.api(`/quotes/${q.id}`, { as: owner })).headers.get("etag");
    const m = await t.api(`/quotes/${q.id}`, { method: "PATCH", as: owner, ifMatch: e4, body: { property_id: prop.id, measure: { sqft: 3200, panes_ext: 40 } } });
    assert.equal(m.status, 200, JSON.stringify(m.body));
    assert.deepEqual(t.stores.data.json(`rec/property/${prop.id}`).assets, { sqft: 3200, panes_ext: 40 });
    // the list: chips with counts
    const list = await t.api("/quotes", { as: owner });
    assert.equal(list.body.data.length, 1);
    assert.equal(list.body.meta.counts.draft, 1);
    assert.equal(list.body.data[0].n, q.number_label);
    assert.equal((await t.api(`/quotes?contact=${c.id}`, { as: owner })).body.data.length, 1);
  } finally { t.done(); }
});

test("pricing endpoints: the builder's context, suggest by panes or square feet, totals; the price book is the owner's", async () => {
  const { t, owner, admin } = await setup();
  try {
    const ctx = await t.api("/pricing/context", { as: admin });
    assert.equal(ctx.status, 200);
    assert.ok(ctx.body.data.book.some((i) => i.key === "exterior"));
    assert.ok(ctx.body.data.discounts.some((d) => d.key === "first_time" && d.value === 5000));
    assert.equal(ctx.body.data.features.deposits, false, "before Money, deposits are hidden (§11.3)");
    assert.equal(ctx.body.data.can.pricebook, false);
    const s = await t.api("/pricing/suggest", { method: "POST", as: admin, body: { input: { services: ["windows_ext", "screens"], sqft: 3000, plan: "quarterly" } } });
    assert.equal(s.status, 200);
    assert.equal(s.body.data.panes_ext, 40);
    assert.ok(s.body.data.warnings.includes("confirm_panes_on_site"));
    assert.equal(s.body.data.lines.find((l) => l.category === "windows_ext").tier, "Up to 40 Panes (2500 - 3499 Sqft)");
    assert.equal(s.body.data.discounts[0].value, 10000);
    const w = await t.api("/pricing/suggest", { method: "POST", as: admin, body: { input: { services: ["windows_ext"], windows: [{ type: "standard", qty: 30 }, { type: "french", qty: 3 }] } } });
    assert.equal(w.body.data.panes_ext, 32);
    assert.equal(w.body.data.lines[0].total_cents, 29500);
    const tot = await t.api("/pricing/totals", { method: "POST", as: admin, body: { option: quarterly() } });
    assert.deepEqual(tot.body.data.totals.per_visit_cents, [19500, 6000, 19500, 19500]);
    // price book and discounts: owners only
    const item = (await t.api("/pricebook", { as: admin })).body.data.find((i) => i.key === "screens");
    assert.equal((await t.api(`/pricebook/${item.id}`, { method: "PATCH", as: admin, ifMatch: "x", body: { unit_cents: 600 } })).status, 403);
    const g = await t.api(`/pricebook/${item.id}`, { as: owner });
    const p = await t.api(`/pricebook/${item.id}`, { method: "PATCH", as: owner, ifMatch: g.headers.get("etag"), body: { unit_cents: 600 } });
    assert.equal(p.body.data.unit_cents, 600);
    const nd = await t.api("/discounts", { method: "POST", as: owner, body: { name: "Neighbor Deal", type: "fixed", value: 2500, default_scope: { type: "initial" } } });
    assert.equal(nd.status, 201);
    assert.equal(nd.body.data.key, "neighbor_deal");
    // cfg/pricing: owner-only settings
    assert.equal((await t.api("/settings/pricing", { as: admin })).status, 403);
    const sp = await t.api("/settings/pricing", { as: owner });
    assert.equal(sp.body.data.data.exterior_tiers[2].cents, 39500);
  } finally { t.done(); }
});

test("send: the link goes out through the core sender (dry-run, Outbox only), one message per channel; Sales hears quote.sent", async () => {
  const { t, owner } = await setup();
  const f = fakes();
  try {
    const c = await makeContact(owner, { first_name: `Pat${XSS}` });
    const d = (await scope(() => store.createRecord("deal", { contact_id: c.id, status: "open", services: ["Exterior Window Cleaning"], quote_ids: [], job_ids: [], plan_ids: [], history: [] }, AS(owner)))).data;
    const made = await t.api("/quotes", { method: "POST", as: owner, body: { contact_id: c.id, options: [oneTime()] } });
    assert.equal(made.body.data.deal_id, d.id, "the contact's open deal");
    const id = made.body.data.id;
    assert.equal((await t.api(`/quotes/${id}/send`, { method: "POST", as: owner, body: { channels: [] } })).status, 400);
    const sent = await t.api(`/quotes/${id}/send`, { method: "POST", as: owner, body: { channels: ["sms", "email"] } });
    assert.equal(sent.status, 200, JSON.stringify(sent.body));
    assert.equal(sent.body.data.sms_mode, "dry_run");
    for (let i = 0; i < 4; i++) await t.runWorker({ lane: "fast" });
    const out = outbox(t).filter((o) => o.related && o.related.quote_id === id);
    assert.equal(out.length, 2, JSON.stringify(outbox(t).map((o) => [o.kind, o.mode, o.blocked_reason])));
    const sms = out.find((o) => o.kind === "sms");
    const email = out.find((o) => o.kind === "email");
    assert.equal(sms.mode, "dry_run");
    assert.match(sms.body, /here's your quote from Barta Window Washing: https:\/\/www\.bartawindowwashing\.com\/p\/[0-9A-Za-z]{10} /);
    assert.match(email.subject, /Your quote from Barta Window Washing/);
    assert.match(email.body, /good through Thu, Dec 10/);
    assert.equal(sms.body.match(/Reply STOP to opt out\./g).length, 1, "the sender adds the footer once (D5), the template never does");
    // the link opens this quote
    const code = /\/p\/([0-9A-Za-z]{10})/.exec(sms.body)[1];
    const open = await t.portal("/api/portal/open", { method: "POST", headers: PJSON, body: { code } });
    assert.equal(open.body.data.location, `/p/quote/${id}`);
    // Sales: the deal is quoted, the estimate follow-up starts (once per quote)
    const enr = t.stores.data.keys("rec/enrollment/").map((k) => t.stores.data.json(k));
    assert.ok(enr.some((e) => e.cadence_key === "estimate_followup" && e.quote_id === id), "estimate follow-up started");
    const deal = t.stores.data.json(`rec/deal/${d.id}`);
    assert.equal(deal.status, "quoted");
    assert.ok(deal.quote_ids.includes(id));
    // the timeline and the contact's stats part
    assert.ok(t.stores.data.keys(`rel/contact-activity/${c.id}/`).some((k) => k.includes("quote.sent")));
    const st = t.stores.data.json(`rec/contact_stats/${c.id}`);
    assert.equal(st.quotes.open_quote, true);
    assert.deepEqual(st.quotes.svc_q, ["Residential Window Cleaning"]);
  } finally { f.restore(); t.done(); }
});

test("a quote isn't sent with a line nobody priced; techs can't send", async () => {
  const { t, owner, tech } = await setup();
  try {
    const c = await makeContact(owner);
    const made = await t.api("/quotes", { method: "POST", as: owner, body: { contact_id: c.id, options: [oneTime({ lines: [line(), { title: "Gutter Cleaning", qty_milli: 1000, unit_cents: 0, category: "gutters" }] })] } });
    const r = await t.api(`/quotes/${made.body.data.id}/send`, { method: "POST", as: owner, body: { channels: ["sms"] } });
    assert.equal(r.status, 400);
    assert.match(r.body.error.message, /Price Gutter Cleaning before sending/);
    assert.equal((await t.api(`/quotes/${made.body.data.id}/send`, { method: "POST", as: tech, body: { channels: ["sms"] } })).status, 403);
  } finally { t.done(); }
});

test("the customer asks for changes or declines in the portal; Sales makes the task; staff decline, archive, restore, duplicate", async () => {
  const { t, owner } = await setup();
  const f = fakes();
  try {
    const { quote } = await sentQuote(t, owner);
    const cookie = await portalCookie(t, quote);
    assert.equal((await t.portal(`/api/portal/quotes/${quote.id}/changes`, { method: "POST", cookie, headers: PJSON, body: { message: " " } })).status, 400);
    const ch = await t.portal(`/api/portal/quotes/${quote.id}/changes`, { method: "POST", cookie, headers: PJSON, body: { message: `Can you add the garage? ${XSS}` } });
    assert.equal(ch.status, 200, JSON.stringify(ch.body));
    const q = await quoteOf(quote.id);
    assert.equal(q.status, "changes_requested");
    assert.match(q.change_message, /add the garage/);
    for (let i = 0; i < 3; i++) await t.runWorker({ lane: "fast" });
    const tasks = t.stores.data.keys("rec/task/").map((k) => t.stores.data.json(k));
    assert.ok(tasks.some((x) => /Quote changes requested/.test(x.title)), "Sales makes the task");
    assert.ok(t.stores.data.keys("rec/notification/").length >= 1, "the staff hear about it");
    const page = await t.portal(`/p/quote/${quote.id}`, { cookie });
    assert.match(page.text, /We got your note/);
    assert.ok(!page.text.includes("<script>alert(1)"));
    // staff edit and send again, then decline for them; archive, restore, duplicate
    const dup = await t.api(`/quotes/${quote.id}/duplicate`, { method: "POST", as: owner, body: {} });
    assert.equal(dup.status, 201);
    assert.notEqual(dup.body.data.id, quote.id);
    assert.equal(dup.body.data.status, "draft");
    assert.notEqual(dup.body.data.options[0].lines[0].id, q.options[0].lines[0].id, "new line ids");
    const dec = await t.api(`/quotes/${quote.id}/decline`, { method: "POST", as: owner, body: { reason: "Went with a neighbor" } });
    assert.equal(dec.body.data.quote.status, "declined");
    assert.equal((await t.api(`/quotes/${quote.id}/archive`, { method: "POST", as: owner, body: {} })).body.data.quote.status, "archived");
    assert.equal((await quoteOf(quote.id)).archive_reason, "manual");
    assert.equal((await t.api(`/quotes/${quote.id}/restore`, { method: "POST", as: owner, body: {} })).body.data.quote.status, "draft");
    assert.equal((await t.portal(`/p/quote/${quote.id}`, { cookie })).status, 200);
  } finally { f.restore(); t.done(); }
});

test("the staff preview is the customer's view, escaped, with the portal's CSP; a merge moves the quotes to the survivor", async () => {
  const { t, owner } = await setup();
  const f = fakes();
  try {
    const c = await makeContact(owner, { first_name: "Pat" });
    const made = await t.api("/quotes", { method: "POST", as: owner, body: { contact_id: c.id, options: [oneTime({ name: `Option ${XSS}` })], client_notes: `Thanks! ${XSS}` } });
    const id = made.body.data.id;
    await t.api(`/quotes/${id}/send`, { method: "POST", as: owner, body: { channels: ["sms"] } });
    const pv = await t.api(`/quotes/${id}/preview`, { as: owner });
    assert.equal(pv.status, 200);
    assert.match(pv.headers.get("content-type"), /text\/html/);
    assert.match(pv.headers.get("content-security-policy"), /script-src 'self'/);
    assert.ok(!pv.text.includes("<script>alert(1)"), "every value escaped");
    assert.match(pv.text, /Customer view of version 1/);
    assert.doesNotMatch(pv.text, /data-approve\b/, "read-only");
    const b = await makeContact(owner);
    await scope(() => Q.onMergeQuotes(b.id, c.id, AS(owner)));
    const q = await quoteOf(id);
    assert.equal(q.contact_id, b.id);
    assert.equal(t.stores.data.keys(`rel/contact-quotes/${b.id}/`).length, 1);
    assert.equal(t.stores.data.keys(`rel/contact-quotes/${c.id}/`).length, 0);
  } finally { f.restore(); t.done(); }
});

test("the seeded price book and discount catalog match barta-rules and D15/D26 (written once, never overwritten)", async () => {
  const { t, owner } = await setup();
  try {
    const book = (await t.api("/pricebook", { as: owner })).body.data;
    const by = Object.fromEntries(book.map((i) => [i.key, i]));
    assert.equal(by.screens.unit_cents, 500);
    assert.equal(by.tracks_standard.unit_cents, 800, "D26");
    assert.equal(by.tracks_premium.unit_cents, 1500);
    assert.equal(by.interior_upper.unit_cents, 1200, "D26");
    assert.equal(by.lights_install.unit_cents, 800);
    assert.equal(by.lights_materials.unit_cents, 200);
    for (const k of ["soft_wash", "pressure_wash", "solar", "commercial", "card_fee"]) assert.equal(by[k].active, false, `${k} kept inactive (D40, D32)`);
    const defs = Object.fromEntries((await t.api("/discounts", { as: owner })).body.data.map((d) => [d.key, d]));
    assert.equal(defs.first_time.value, 5000);
    assert.equal(defs.plan_quarterly.stack_group, "plan");
    assert.equal(defs.early_bird.type, "percentage");
    assert.equal(defs.early_bird.value, 5000);
    assert.equal(defs.five_year.sellable, false);
    // an owner's edit survives the seed running again
    const g = await t.api(`/discounts/${defs.first_time.id}`, { as: owner });
    await t.api(`/discounts/${defs.first_time.id}`, { method: "PATCH", as: owner, ifMatch: g.headers.get("etag"), body: { value: 10000 } });
    await scope(() => SEED.seedPriceBook({}));
    assert.equal((await t.api(`/discounts/${defs.first_time.id}`, { as: owner })).body.data.value, 10000);
    // no customer-facing seed text says "licensed", promises a refund, carries STOP text or an em dash
    const words = JSON.stringify([SEED.SEED_PRICE_BOOK, SEED.TEMPLATES]);
    assert.doesNotMatch(words, /licensed|refund|reply stop|—/i);
  } finally { t.done(); }
});
