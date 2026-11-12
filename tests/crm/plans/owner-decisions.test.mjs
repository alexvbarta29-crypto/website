// The owner's answers of Nov 12 in the plans module:
//   - the agreement texts: the legal name "Barta Window Washing LLC", the $50
//     late cancel or reschedule fee (plans and one-time jobs), what each perk
//     covers (Quarterly and Monthly only), Quarterly visit 2 inside glass only
//     with the $100 off, add-ons only when asked, the Monthly $150 payback,
//     lights: Early Bird and 3-year $200 every season, the same price all three
//     seasons, a $400 storage fee to leave a 3-year contract early; one Owner
//     check left (how the crew hangs the lights);
//   - a 3-year lights plan: seasons 2 and 3 cost what season 1 costs; the
//     storage fee in the calculator, the cancel and the text alike;
//   - seed v3, the one-time upgrade of the live CRM's stored texts: an
//     untouched seeded draft moves once (a new version, never approved by
//     the upgrade), an owner's edit stays with the new draft beside it as a
//     suggestion (one notice), the legal name moves only where nobody typed
//     one, a second run changes nothing.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { setup, customer, scope, store, AG, M, PL, CAT, AS, AUTOMATION, recOf, queued, drain } from "./fixtures.mjs";

const TX = await import("../../../netlify/lib/crm/modules/plans/texts.mjs");
const P = await import("../../../netlify/lib/crm/modules/quotes/pricing.mjs");
const QSEED = await import("../../../netlify/lib/crm/modules/quotes/seed.mjs");
const sha = (s) => createHash("sha256").update(String(s)).digest("hex");
const book = () => QSEED.SEED_PRICE_BOOK.map((i) => ({ ...i, id: QSEED.seedItemId(i.key) }));
const defs = () => QSEED.SEED_DISCOUNTS.map((d) => QSEED.seedDiscount(d.key));
const D = P.PRICING_DEFAULTS;
const BAD = /—|licensed|refund|reply stop/i;

// A quote's plan option, as the engine makes it.
function windowsOption(plan, extra = {}) {
  const s = P.suggestOption({ services: ["windows_ext", "screens"], panes_ext: 40, screens: 20, plan, ...extra }, D, book(), defs());
  return { id: `op_${plan}`, name: `${plan[0].toUpperCase()}${plan.slice(1)} plan`, kind: "plan", plan: s.plan, lines: s.lines.map((l) => ({ ...l, total_cents: P.lineTotal(l) })), discounts: s.discounts };
}
function lightsOption({ three = true } = {}) {
  const lines = P.lightsLines({ runs: [{ label: "Roofline", feet: 150 }], colors: ["warm_white"] }, D, book());
  const discounts = P.lightsDiscounts({ early_bird: true, three_year: three, on: "2026-11-17" }, D, defs());
  return { id: "op_lights", name: "Christmas lights, every season", kind: "plan", plan: { catalog_key: "lights_annual", frequency: { interval: "year", count: 1 }, visits_per_year: 1, term_months: three ? 36 : 12, billing: "after_visit", autopay: false, auto_renew: true }, lines, discounts };
}
const textFor = (c, opt) => scope(() => AG.agreementForOption({ id: "qt_0000000000000000000q", contact_id: c.id }, { options: [opt] }, opt));

test("the agreement texts say what the owner decided (legal name, $50 late fee, perks, visit 2, add-ons, the Monthly $150)", async () => {
  const { t, owner } = await setup();
  try {
    const c = await customer(owner);
    const q = (await textFor(c, windowsOption("quarterly"))).body_rendered;
    assert.match(q, /^## Quarterly plan service agreement\n\nThis agreement is between Barta Window Washing LLC \("Barta Window Washing", "we", "us"\)/);
    assert.match(q, /- Unlimited Touch-Ups: any glass on your plan, any time between visits\./);
    assert.match(q, /- 7-Day Rain Guarantee: if weather leaves spots on your exterior glass within 7 days of a visit, we'll come back and touch it up for free\./);
    assert.match(q, /- Free Hard Water Removal: a light hard-water spot treatment on up to 5 panes each visit\. More panes are an add-on, and deep or etched staining is quoted separately\./);
    assert.match(q, /Your interior visit \(visit 2 each year\) is inside glass only/);
    assert.match(q, /- Interior Window Cleaning: \$160\.00, visit 2 of each year/);
    assert.match(q, /- Quarterly plan discount: \$100\.00 off every visit/, "visit 2 gets the $100 off too");
    assert.match(q, /Your price: first visit \$295\.00, then \$195\.00 a visit \(visit 2 of each year: \$60\.00\), locked in/, "the screens they asked for ride on visit 1 only");
    assert.match(q, /- Screen Cleaning: \$100\.00, your first visit/);
    assert.match(q, /Want screens, tracks or gutters done too\? Just ask and we'll add them to that visit\./);
    assert.match(q, /Cancelling or rescheduling with less than 24 hours' notice, or a visit where we can't get in and weren't told, is a \$50\.00 late cancellation fee\. There's never a fee when we're the ones moving a visit/);
    assert.match(q, /you pay back the plan discount that visit got \(\$100\.00\)/);
    const m = (await textFor(c, windowsOption("monthly"))).body_rendered;
    assert.match(m, /you pay back the plan discount that visit got \(\$150\.00\)/, "the Monthly payback is its $150");
    assert.match(m, /## Your plan perks\n\n- Unlimited Touch-Ups/);
    const b = (await textFor(c, windowsOption("biannual"))).body_rendered;
    assert.doesNotMatch(b, /perk|Touch-Ups|Rain Guarantee|Hard Water/i, "Biannual has no perks");
    assert.match(b, /\$50\.00 late cancellation fee/);
    // the one-time text: the same $50 rule
    const one = TX.AGREEMENT_DRAFTS.find((d) => d.key === "one_time").body_md;
    assert.match(one, /is a \{\{late_cancel_fee\}\} late cancellation fee\. There's never a fee when we're the ones moving the visit\./);
    for (const body of [q, m, b, one]) {
      assert.doesNotMatch(body, BAD);
      assert.doesNotMatch(body, /Owner check|may have a/);
    }
  } finally { t.done(); }
});

test("lights: the text says Early Bird and $200 off every season, the same price all three seasons, and the $400 storage fee", async () => {
  const { t, owner } = await setup();
  try {
    const c = await customer(owner);
    const body = (await textFor(c, lightsOption())).body_rendered;
    assert.match(body, /- Early Bird: 50% off every season/);
    assert.match(body, /- 3-year contract: \$200\.00 off every season/);
    assert.match(body, /- Christmas Light Materials: \$300\.00, every season/);
    assert.match(body, /Your price: \$550\.00 a season\./, "the same price each season, nothing first-season only");
    assert.match(body, /Your plan is a 3-season contract at the same price every season\./);
    assert.match(body, /If you cancel before the 3 seasons are up, there's a \$400\.00 storage fee\./);
    assert.match(body, /is a \$50\.00 late cancellation fee/);
    assert.doesNotMatch(body, BAD);
    // a plan without the contract: Early Bird every season, no storage fee
    const annual = (await textFor(c, lightsOption({ three: false }))).body_rendered;
    assert.match(annual, /Your price: \$750\.00 a season\./);
    assert.doesNotMatch(annual, /storage fee|contract/);
    // the one check left in the lights draft: how the crew hangs them
    assert.deepEqual(AG.ownerChecksIn(TX.AGREEMENT_DRAFTS.find((d) => d.key === "lights").body_md).length, 1);
  } finally { t.done(); }
});

test("a 3-year lights plan: seasons 2 and 3 cost what season 1 costs; the storage fee in the calculator, the cancel and the text", async () => {
  const cat = CAT.catalogWith({});
  const o = lightsOption();
  const plan = PL.buildPlan({ id: "pl_00000000000000000003", contact_id: "ct_00000000000000000001", catalog_key: "lights_annual", lines: o.lines.map((l) => ({ ...l, total_cents: P.lineTotal(l) })), discounts: o.discounts, term_months: 36, frequency: o.plan.frequency, visits_per_year: 1 }, cat, { start_on: "2026-11-17" });
  assert.equal(plan.ordinals.length, 3);
  assert.deepEqual(plan.ordinals.map((x) => M.ordinalTotals(plan, x).total_cents), [55000, 55000, 55000]);
  assert.ok(plan.ordinals.every((x) => M.ordinalDiscounts(plan, x).some((d) => d.key === "early_bird")), "the Early Bird on each season's install");
  assert.equal(plan.policy.storage_fee_cents, 40000);
  assert.equal(AG.perVisitText(plan), "$550.00 a season");
  const active = { ...plan, status: "active" };
  const q = M.cancelQuote(active, "2027-03-01");
  assert.equal(q.inside_initial_term, true);
  assert.deepEqual([q.clawback_cents, q.storage_fee_cents], [40000, 40000]);
  const after = M.cancelQuote(active, "2029-12-01");
  assert.equal(after.inside_initial_term, false);
  assert.equal(after.clawback_cents, 0);
  const cancelled = M.applyAction(active, "cancel", { reason: "price" }, { today: "2027-03-01", at: "x", by: "u" }).next;
  assert.deepEqual([cancelled.cancel.clawback_cents, cancelled.cancel.storage_fee_cents, cancelled.cancel.clawback_state], [40000, 40000, "to_bill"]);
  // the text the plan's agreement renders says the same figure
  assert.match(AG.renewalTerms(plan), /\$400\.00 storage fee/);
  // the owner's own figure (Settings → Plans catalog): the plan carries it, the text says it
  const p300 = PL.buildPlan({ id: "pl_00000000000000000004", contact_id: "ct_00000000000000000001", catalog_key: "lights_annual", lines: o.lines, discounts: o.discounts, term_months: 36 }, CAT.catalogWith({ lights_storage_fee_cents: 30000 }), { start_on: "2026-11-17" });
  assert.equal(M.cancelQuote({ ...p300, status: "active" }, "2027-01-05").clawback_cents, 30000);
  assert.match(AG.renewalTerms(p300), /\$300\.00 storage fee/);
  // an every-season plan without the contract, and window plans: no storage fee
  const annual = PL.buildPlan({ id: "pl_00000000000000000005", contact_id: "ct_00000000000000000001", catalog_key: "lights_annual", lines: o.lines, discounts: [], term_months: 12 }, cat, { start_on: "2026-11-17" });
  assert.equal(M.cancelQuote({ ...annual, status: "active" }, "2027-01-05").clawback_cents, 0);
  assert.equal(M.storageFeeCents({ kind: "recurring", catalog_key: "quarterly", term: { initial_months: 36 } }), 0);
  // a lights contract made before Nov 12 (no figure on it) uses the owner's $400
  assert.equal(M.storageFeeCents({ kind: "lights_annual", term: { initial_months: 36 }, policy: {} }), 40000);
  assert.equal(CAT.validateCatalog({ lights_storage_fee_cents: 40000 }).lights_storage_fee_cents, 40000);
  assert.throws(() => CAT.validateCatalog({ lights_storage_fee_cents: -1 }), /cents/);
});

// What the first seeds left on the live CRM (Nov 11): the v2-era drafts.
const V2_BIANNUAL = "## {{plan_name}} service agreement\n\nThis agreement is between {{legal_name}} (\"{{company_name}}\", \"we\", \"us\") and {{full_name}} (\"you\").\n\n>> Owner check: confirm the legal name (Settings, Company) is exactly the business's registered name.\n\n## What you get\n\n- Window cleaning {{visit_schedule}}, with the services listed under Your price.\n- Our 100% satisfaction guarantee: if anything isn't right, tell us and we'll come back and re-clean it for free.\n\n## Your price\n\n{{price_details}}\n\nYour price: {{per_visit_price}}, locked in for the first {{term_months}} months.{{addon_note}}\n\n## Scheduling\n\nWe book each visit with you ahead of time and confirm it by text.\n\n## Reminders and rescheduling\n\nWe text or email you about 2 weeks and again 2 days before each visit. We give you an arrival window, not an exact time.\n\nNeed to move a visit? Just let us know at least 24 hours ahead. A cancel or reschedule with less than 24 hours' notice, or a visit where we can't get in and weren't told, may have a {{late_cancel_fee}} fee. There's never a fee when we're the ones moving a visit (rain, for example).\n\n>> Owner check: the late-cancel fee (Settings, Plans catalog & perks) isn't on the public website's terms yet. Keep it, change it, or take the fee sentence out.\n\n## Payments\n\n{{billing_terms}} We don't charge sales tax.\n\n## Skipped visits\n\nYou can skip a visit. Skipping doesn't cancel your plan, and a skipped visit doesn't turn into a credit.\n\n## Term and renewal\n\nYour plan starts with a {{term_months}}-month term at the price above. {{renewal_terms}} If your price ever changes after the first {{term_months}} months, we'll tell you in writing at least 30 days before.\n\n## Cancelling in the first {{term_months}} months\n\nGive us {{notice_days}} days' notice in writing (a text or email is fine). {{clawback_terms}}\n\n## Cancelling after the first {{term_months}} months\n\nCancel any time. It takes effect at the end of your current renewal term, and visits until then still happen and are billed.\n\n## The fine print\n\nWe're fully insured. You don't need to be home for exterior work as long as gates are unlocked; we set up interior visits with you. We're not responsible for damage that was already there, or for old or defective windows, frames, screens or seals.\n\nQuestions? Call or text us at {{company_phone}}. Thanks for trusting us with your home!";

test("seed v3: untouched drafts move once (a new version, not approved), an edited one keeps its words with the new draft as a suggestion, the legal name moves; a second run changes nothing", async () => {
  const { t, owner } = await setup(undefined, { approve: false });
  try {
    assert.ok(TX.PREVIOUS_DRAFT_SHAS.biannual.includes(sha(V2_BIANNUAL)) && TX.PREVIOUS_DRAFT_SHAS.custom.includes(sha(V2_BIANNUAL)), "the fixture is the real Nov 11 text");
    const id = (k) => AG.seedTemplateId(k);
    const OWN = "## {{plan_name}}\n\nOur own quarterly words. We're insured.";
    await scope(async () => {
      for (const k of ["biannual", "custom"]) await store.updateRecord("agreement_template", id(k), (x) => ({ ...x, body_md: V2_BIANNUAL, version: 2 }), AUTOMATION);
      // the owner rewrote the quarterly text and approved it
      await store.updateRecord("agreement_template", id("quarterly"), (x) => ({ ...x, body_md: OWN, version: 3, approved_version: 3, approved_at: "2026-11-11T18:00:00.000Z", approved_by: owner.id }), AS(owner));
      // the owner saved Settings → Company once (the page holds every field)
      await store.putSetting("company", { name: "Barta Window Washing", legal_name: "BARTA WINDOW WASHING LLC", phone: "(763) 314-3400", email: "office@bartawindowwashing.com" }, { ...AS(owner), ifMatch: "new" });
    });
    const out = await scope(() => AG.upgradeOwnerDecisions({ write: () => AUTOMATION }));
    assert.equal(out.suggested, 1);
    assert.equal(out.legal_name, "upgraded");
    for (const k of ["biannual", "custom"]) {
      const r = await recOf("agreement_template", id(k));
      assert.equal(r.body_md, TX.AGREEMENT_DRAFTS.find((d) => d.key === k).body_md, `${k}: the untouched text is the new draft`);
      assert.equal(r.version, 3);
      assert.equal(r.approved_version, undefined, "never approved by the upgrade");
      assert.equal(r.suggested_body_md, undefined);
    }
    const qt = await recOf("agreement_template", id("quarterly"));
    assert.equal(qt.body_md, OWN, "the owner's words stay");
    assert.equal(qt.version, 3);
    assert.equal(qt.approved_version, 3, "still approved: nothing the customer reads changed");
    assert.equal(qt.suggested_body_md, TX.AGREEMENT_DRAFTS.find((d) => d.key === "quarterly").body_md);
    assert.equal((await scope(() => store.getSetting("company"))).legal_name, "Barta Window Washing LLC");
    assert.ok(t.stores.data.keys("evt/cfg/company/").length >= 2, "the legal name change is in the settings journal");
    const notes = () => queued(t, "notify.deliver").filter((x) => x.data && x.data.note && x.data.note.title === "New suggested agreement wording");
    assert.equal(notes().length, 1);
    assert.match(notes()[0].data.note.body, /New suggested wording for Quarterly plan agreement/);
    // a second run: nothing
    const wv = Object.fromEntries(await Promise.all(["biannual", "custom", "quarterly", "monthly", "lights", "one_time"].map(async (k) => [k, (await recOf("agreement_template", id(k))).wv])));
    const again = await scope(() => AG.upgradeOwnerDecisions({ write: () => AUTOMATION }));
    assert.deepEqual([again.upgraded, again.suggested, again.legal_name], [0, 0, "current"]);
    for (const [k, v] of Object.entries(wv)) assert.equal((await recOf("agreement_template", id(k))).wv, v, `${k} untouched`);
    assert.equal(notes().length, 1, "told once");
    // the screens: the list flags it, the text carries it; keeping theirs or taking it clears it
    const list = await t.api("/agreement-templates", { as: owner });
    assert.equal(list.body.data.find((x) => x.key === "quarterly").suggested, true);
    assert.equal(list.body.data.find((x) => x.key === "biannual").suggested, false);
    const g = await t.api(`/agreement-templates/${id("quarterly")}`, { as: owner });
    assert.equal(g.body.data.suggested_body_md, qt.suggested_body_md);
    const take = await t.api(`/agreement-templates/${id("quarterly")}`, { method: "PATCH", as: owner, ifMatch: g.headers.get("etag"), body: { body_md: g.body.data.suggested_body_md } });
    assert.equal(take.status, 200, JSON.stringify(take.body));
    assert.equal(take.body.data.suggested_body_md, undefined);
    assert.equal(take.body.data.version, 4);
    assert.equal(take.body.data.approved, false, "the new text needs the owner's OK again");
  } finally { t.done(); }
});

test("seed v3: a legal name the owner typed stays (and they hear of the suggestion); keep-mine clears a suggestion; it runs where seeds run", async () => {
  const { t, owner } = await setup(undefined, { approve: false });
  try {
    await scope(async () => {
      await store.putSetting("company", { name: "Barta Window Washing", legal_name: "Barta Window Washing, LLC", phone: "(763) 314-3400" }, { ...AS(owner), ifMatch: "new" });
      await store.updateRecord("agreement_template", AG.seedTemplateId("monthly"), (x) => ({ ...x, body_md: "## Monthly\n\nOur words.", version: 2 }), AS(owner));
    });
    for (let i = 0; i < 4; i++) await t.runWorker({ lane: "fast" });
    const j = t.stores.data.json("op/seed--plans--v3");
    assert.equal(j.status, "done", JSON.stringify(j));
    assert.equal((await scope(() => store.getSetting("company"))).legal_name, "Barta Window Washing, LLC");
    // the worker delivered the one notice to the owner's bell
    await drain(t, 2);
    const notes = t.stores.data.keys("rec/notification/").map((k) => t.stores.data.json(k)).filter((n) => n.title === "New suggested agreement wording");
    assert.equal(notes.length, 1, "one owner, one notice");
    assert.equal(notes[0].user_id, owner.id);
    assert.match(notes[0].body, /Monthly plan agreement/);
    assert.match(notes[0].body, /legal name in Settings, Company stays as you typed it \(suggested: Barta Window Washing LLC\)/);
    const g = await t.api(`/agreement-templates/${AG.seedTemplateId("monthly")}`, { as: owner });
    assert.ok(g.body.data.suggested_body_md);
    const keep = await t.api(`/agreement-templates/${AG.seedTemplateId("monthly")}`, { method: "PATCH", as: owner, ifMatch: g.headers.get("etag"), body: { dismiss_suggestion: true } });
    assert.equal(keep.status, 200, JSON.stringify(keep.body));
    assert.equal(keep.body.data.suggested_body_md, undefined);
    assert.equal(keep.body.data.body_md, "## Monthly\n\nOur words.");
    assert.equal(keep.body.data.version, 2, "keeping theirs is no new version");
    // the untouched drafts were already current (a fresh install): the pass made no new versions
    assert.equal((await recOf("agreement_template", AG.seedTemplateId("biannual"))).version, 1);
  } finally { t.done(); }
});

test("the public terms page states the late cancel rule the agreements use ($50, under 24 hours, never when we move it)", async () => {
  const { readFile } = await import("node:fs/promises");
  const RULE = "Please cancel or reschedule at least 24 hours ahead. Cancelling or rescheduling with less than 24 hours' notice, or a missed appointment, is a $50 late cancellation fee. There's no fee if we're the ones who reschedule.";
  const page = await readFile(new URL("../../../terms.html", import.meta.url), "utf8");
  const source = await readFile(new URL("../../../build/build.py", import.meta.url), "utf8");
  for (const s of [page, source]) {
    assert.ok(s.includes(RULE), "the generated page and its source say the same");
    assert.doesNotMatch(s, /may result in a cancellation fee/);
  }
  assert.doesNotMatch(RULE, /—|licensed/);
  assert.equal(CAT.CATALOG_DEFAULTS.late_cancel_fee_cents, 5000, "the agreements' fee is the page's $50");
});
