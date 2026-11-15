// The quotes screens render with synthetic state through html`` (design
// §2.3, §0 rule 7): every interpolation escaped, links stay in the CRM (the
// customer's page opens in a new tab), and the builder's live totals use the
// same integer math as the server's engine. The phone walk covers the rest.
import { test } from "node:test";
import assert from "node:assert/strict";

const load = async (name) => (await import(`../../../crm-app/modules/quotes/${name}.js`)).default;
const kit = await import("../../../crm-app/modules/quotes/kit.js");
const P = await import("../../../netlify/lib/crm/modules/quotes/pricing.mjs");
const M = (await import("../../../crm-app/modules/quotes/manifest.js")).default;
const ctx = (perms = null) => ({ can: (p) => (perms ? perms.includes(p) : true), user: { id: "us_00000000000000000001", role: "owner" }, keep: {}, path: "/x", params: {} });
const text = (safe) => String(safe);
const XSS = "</script><script>alert(1)</script>";
const NOW = "2026-11-10T16:00:00.000Z";

const option = (o = {}) => ({
  id: "op_a", name: `Exterior ${XSS}`, kind: "one_time", recommended: true,
  lines: [{ id: "ln_1", title: `Exterior Window Cleaning ${XSS}`, qty_milli: 1000, unit_cents: 29500, scope: { type: "all" }, unit: "flat" }, { id: "ln_2", title: "Screens", qty_milli: 20000, unit_cents: 500, scope: { type: "initial" }, unit: "screen", optional: true }],
  discounts: [{ id: "dc_1", name: "First Time Customer", type: "fixed", value: 5000, scope: { type: "initial" } }], totals: { first_cents: 24500, per_visit_cents: [24500], term_cents: 24500, annual_cents: 24500 }, ...o,
});
const plan = () => ({
  id: "op_b", name: "Quarterly plan", kind: "plan", recommended: false, plan: { catalog_key: "quarterly", visits_per_year: 4, term_months: 12, billing: "barta_standard", frequency: { interval: "month", count: 3 } },
  lines: [{ id: "ln_3", title: "Exterior", qty_milli: 1000, unit_cents: 29500, scope: { type: "specific", visits: [1, 3, 4] } }, { id: "ln_4", title: "Interior", qty_milli: 1000, unit_cents: 16000, scope: { type: "specific", visits: [2] } }],
  discounts: [{ id: "dc_2", name: "Quarterly plan discount", type: "fixed", value: 10000, scope: { type: "all" }, stack_group: "plan" }],
  totals: { first_cents: 19500, per_visit_cents: [19500, 6000, 19500, 19500], term_cents: 64500, annual_cents: 64500 },
});

test("the manifest: routes with permissions and parents, More → Quotes, New quote, the contact's Quotes tab, two settings pages", () => {
  assert.ok(M.routes.every((r) => r.perm && typeof r.load === "function"));
  assert.ok(M.routes.some((r) => r.path === "/quotes/:id/edit" && r.perm === "quotes:write"));
  assert.ok(M.routes.some((r) => r.path === "/settings/pricing" && r.perm === "settings:owner"));
  assert.equal(M.nav[0].path, "/quotes");
  assert.equal(M.creates[0].path, "/quotes/new");
  assert.equal(M.contactTabs[0].key, "quotes");
});

test("the builder's live totals agree with the server's engine (integer math, scopes, percentages first, the floor)", () => {
  const cases = [option(), plan(), { kind: "plan", plan: { visits_per_year: 1, term_months: 36 }, lines: [{ qty_milli: 154500, unit_cents: 800 }], discounts: [{ type: "percentage", value: 5000 }, { type: "fixed", value: 10000 }] },
    { kind: "one_time", lines: [{ qty_milli: 1500, unit_cents: 333 }, { qty_milli: 1000, unit_cents: 8000, override: { cents: 7000, reason: "x" } }], discounts: [{ type: "percentage", value: 1500 }] },
    { kind: "one_time", lines: [{ qty_milli: 1000, unit_cents: 8000 }], discounts: [{ type: "fixed", value: 10000 }] },
    // 10 free screens tied to an add-on: nothing off until it's ticked, then $50
    { kind: "one_time", lines: [{ id: "ln_a1", qty_milli: 1000, unit_cents: 29500 }, { id: "ln_s1", qty_milli: 20000, unit_cents: 500, optional: true }], discounts: [{ type: "fixed", value: 5000, line_id: "ln_s1" }] },
    { kind: "one_time", lines: [{ id: "ln_a1", qty_milli: 1000, unit_cents: 29500 }, { id: "ln_s1", qty_milli: 20000, unit_cents: 500, optional: true, selected: true }], discounts: [{ type: "fixed", value: 5000, line_id: "ln_s1" }] }];
  for (const o of cases) assert.deepEqual(kit.optionTotals(o), P.optionTotals(o, P.PRICING_DEFAULTS));
  assert.deepEqual([cases[5], cases[6]].map((o) => kit.optionTotals(o).first_cents), [29500, 34500]);
  assert.equal(kit.scopeWords({ type: "specific", visits: [1, 3, 4] }), "Visits 1, 3, 4");
  assert.deepEqual(kit.parseVisits("1, 3 4"), { type: "specific", visits: [1, 3, 4] });
  assert.equal(kit.toMilli("1.5"), 1500);
});

test("Quotes list (Rotor's tiles) and the contact's tab: tiles with counts and $, viewed, rows escaped", async () => {
  const list = await load("list");
  const rows = [{ id: "qt_00000000000000000001", n: "SQ-0001", cn: `Pat ${XSS}`, st: "viewed", first: 29500, sent: NOW, viewed: NOW, at: NOW, u: NOW, k: ["one_time"] }, { id: "qt_00000000000000000002", n: "Q-18641", cn: "Sam Sample", st: "converted", first: 19500, at: NOW, u: NOW, k: ["one_time"] },
    { id: "qt_00000000000000000003", n: "SQ-0003", cn: "Ed Expired", st: "sent", first: 10000, sent: NOW, exp: "2026-11-01", at: NOW, u: NOW, k: ["plan"], annual: 78000 }];
  const base = { rows, tile: "open", q: "", today: "2026-11-17" };
  const h = text(list.render(base, ctx()));
  assert.ok(!h.includes("<script>alert(1)"));
  assert.match(h, /href="#\/quotes\/qt_00000000000000000001"/);
  assert.match(h, /\$295\.00/);
  assert.match(h, /data-key="open"[^>]*><span class="rs-tile-l">Open<\/span><span class="rs-tile-v num">2<\/span><span class="rs-tile-m num">\$395\.00/, "Open with its $");
  assert.match(h, /viewed/, "the viewed flag");
  assert.doesNotMatch(h, /Q-18641/, "a booked quote isn't open");
  assert.match(text(list.render({ ...base, tile: "converted" }, ctx())), /Q-18641/);
  const ex = text(list.render({ ...base, tile: "expired" }, ctx()));
  assert.match(ex, /Ed Expired/);
  assert.match(ex, /\$780\.00\/yr/, "a plan quote shows its year");
  const tab = await load("contact-tab");
  assert.match(text(tab.render({ id: "ct_1", rows }, ctx())), /href="#\/quotes\/new\/ct_1"/);
  assert.match(text(tab.render({ denied: true }, ctx())), /Not for this login/);
});

// The quote page (Rotor's look, Nov 2026): Options and Activity, and the round ...'s rows written as their
// data-* hooks and labels (they open in a sheet, not in the page).
const hooks = (r) => Object.entries(r.data || {}).map(([k, v]) => ` data-${k}="${v}"`).join("");
const whole = (view, s, c) => ["options", "activity"].map((tab) => text(view.render({ ...s, tab }, c))).join("\n")
  + view.more(s, c).flat().filter(Boolean).map((r) => `<li${hooks(r)}>${r.label}</li>`).join("");

test("a quote: status, timeline, the customer's version, the actions its status allows; escaped", async () => {
  const view = await load("view");
  const q = { id: "qt_00000000000000000001", number_label: "SQ-0001", status: "viewed", contact_id: "ct_1", contact_name: `Pat ${XSS}`, created_at: NOW, sent_at: NOW, sent_via: ["sms"], viewed_at: NOW, expires_on: "2026-12-10", current_version_id: "qv_00000000000000000001", options: [option(), plan()], client_notes: `Thanks ${XSS}` };
  const s = { quote: q, contact: { name: `Pat ${XSS}`, phone: "+17635550100" }, properties: [], versions: [{ id: "qv_1", n: 1, sent_at: NOW, sent_via: ["sms"] }], current_version: { id: "qv_1", n: 1, options: [option(), plan()] }, convertible: false, sms_mode: "dry_run" };
  const h = whole(view, s, ctx());
  assert.ok(!h.includes("<script>alert(1)"));
  assert.match(h, /data-act="send"/);
  assert.match(h, /data-act="present"/);
  assert.match(h, /Approved by phone/);
  assert.match(h, /href="\/api\/crm\/quotes\/qt_00000000000000000001\/preview" target="_blank" rel="noopener"/);
  assert.match(h, /What the customer sees \(version 1\)/);
  assert.equal(view.title(s), "Quote SQ-0001");
  assert.ok(view.tools(s, ctx()).some((t) => t && t.icon === "edit"), "the round pencil edits it");
  assert.match(h, /data-act="decline"[^>]*>Mark declined/);
  assert.match(h, /data-act="archive"[^>]*>Archive/);
  assert.match(h, /data-act="duplicate"/);
  assert.match(h, /Opened by the customer/);
  // read-only for someone without write or send
  const ro = whole(view, s, ctx(["quotes:read"]));
  assert.doesNotMatch(ro, /data-act="send"|data-act="archive"/);
  // approved, waiting for Scheduling: says so instead of a broken button
  const ap = whole(view, { ...s, quote: { ...q, status: "approved", approved_at: NOW, approval: { option_id: "op_a", method: "phone" } }, convertible: false }, ctx());
  assert.match(ap, /be made into a job from here yet/);
  assert.doesNotMatch(ap, /data-act="convert"/);
  assert.match(whole(view, { ...s, quote: { ...q, status: "approved", approved_at: NOW, approval: { option_id: "op_a" } }, convertible: true }, ctx()), /data-act="convert"/);
  assert.match(whole(view, { ...s, quote: { ...q, status: "changes_requested", change_message: `Add the garage ${XSS}` } }, ctx()), /They asked for changes/);
});

test("the builder: who, measure (panes or square feet), services, options with lines, discounts and totals; deposits hidden before Money", async () => {
  const b = await load("builder");
  const cx = { pricing: P.PRICING_DEFAULTS, book: [], discounts: [], features: { deposits: false }, can: { override: true } };
  const s = {
    cx, isNew: false, id: "qt_1", number: "SQ-0001", status: "draft", contact: { id: "ct_1", name: `Pat ${XSS}` }, properties: [{ id: "pr_1", label: "Home", address: "1 Example Ave, Delano" }], property_id: "pr_1",
    measure: { mode: "panes", windows: { standard: 30, french: 3 }, sqft: "", panes_int: "" }, services: { windows_ext: true, screens: true }, counts: {}, plan: "quarterly", warnings: ["count_screens_on_site"], tab: 1,
    options: [option(), plan()], client_notes: "", internal_notes: "", agreement: { require_card: false, deposit: { type: "none", value: 0 } }, photo_ids: [], mockup_file_ids: [],
  };
  // the editor's segments (Rotor's look, Nov 2026): Measure, Price, Extras; every field still there
  const segs = (st) => ["measure", "price", "extras"].map((seg) => text(b.render({ ...st, seg }, ctx()))).join("\n");
  const h = segs(s);
  assert.ok(!h.includes("<script>alert(1)"));
  assert.match(text(b.render(s, ctx())), /aria-selected="true" tabindex="0" data-seg="qb" data-key="price"/, "an existing quote opens on Price");
  assert.match(h, /data-panes>32</, "30 standard + 3 French × 0.4 → 32");
  assert.match(h, /Screens are estimated at half the panes/);
  assert.match(h, /Visits 1, 3, 4/);
  assert.match(h, /\$195\.00 · \$60\.00 · \$195\.00 · \$195\.00/, "per-visit prices of the quarterly option");
  assert.doesNotMatch(h, /Card and deposit/, "hidden before Money (§11.3)");
  assert.match(segs({ ...s, cx: { ...cx, features: { deposits: true } } }), /Card and deposit/);
  const sq = segs({ ...s, measure: { ...s.measure, mode: "sqft", sqft: "3200" } });
  assert.match(sq, /Up to 40 panes \(2500 to 3499 sq ft\)\. Confirm the panes on site\./);
  assert.match(text(b.render({ ...s, status: "approved" }, ctx())), /An approved quote doesn't change/);
});

test("lights quote, pricing settings, discounts: render and escape", async () => {
  const lights = await load("lights");
  const cx = { pricing: P.PRICING_DEFAULTS, early_bird_deadline: "2026-12-01" };
  const lh = text(lights.render({ id: "qt_1", cx, runs: [{ label: "Roofline", feet: "120" }], pkg: "", usePkg: false, colors: ["warm_white"], early: true, three: false, every: true, warnings: [],
    preview: { lines: P.lightsLines({ runs: [{ label: "Roofline", feet: 120 }] }, P.PRICING_DEFAULTS), discounts: [{ name: "Early Bird", type: "percentage", value: 5000, scope: { type: "all" } }], plan: { catalog_key: "lights_annual", visits_per_year: 1, term_months: 12 } } }, ctx()));
  assert.match(lh, /Early Bird 50% off every season \(book by Tue, Dec 1\)/);
  assert.match(lh, /3-year contract \(\$200 off every season\)/);
  assert.match(lh, /Christmas Light Installation/);
  assert.match(lh, /\$600\.00/, "120 ft × $10 = $1,200, 50% off");
  assert.match(lh, /Each season[\s\S]*The same price every season\./, "the bulbs and the offers count every season (the owner, Nov 12)");
  const once = text(lights.render({ id: "qt_1", cx, runs: [{ label: "Roofline", feet: "120" }], pkg: "", usePkg: false, colors: [], early: false, three: true, every: false, warnings: [], preview: null }, ctx()));
  assert.match(once, /data-three="1" disabled/, "this season only: no 3-year contract");
  assert.match(once, /for every season only/);
  const st = await load("settings");
  const sh = text(st.render({ cfg: P.pricingWith({}), etag: "x", book: [{ id: "pi_1", name: `Screens ${XSS}`, unit: "screen", unit_cents: 500, active: true, key: "screens" }, { id: "pi_2", key: "tracks_standard", name: "Track Detailing", unit: "track", unit_cents: 500, active: true }] }, ctx()));
  assert.ok(!sh.includes("<script>alert(1)"));
  assert.match(sh, /name="tier_c_2" inputmode="decimal" value="395\.00"/, "41-60 panes: $395");
  assert.match(sh, /name="trk" inputmode="decimal" value="5\.00"/, "track detailing: the price-book item's price (one source)");
  assert.match(sh, /name="dl1_2027"/, "next season's Early Bird dates can go in now");
  const dc = await load("discounts");
  const dh = text(dc.render({ defs: [{ id: "dd_1", name: `Neighbor ${XSS}`, type: "fixed", value: 2500, default_scope: { type: "initial" } }, { id: "dd_2", name: "5-Year Contract", type: "fixed", value: 20000, sellable: false }], can: false }, ctx()));
  assert.ok(!dh.includes("<script>alert(1)"));
  assert.match(dh, /Kept for history/);
});

test("New quote (Flyra's New Estimate sheet): options with line items, a plan option with its own discount; the builder is Measure and price", async () => {
  const routes = Object.fromEntries(M.routes.map((r) => [r.path, r]));
  for (const p of ["/quotes/new", "/quotes/new/:contact", "/quotes/measure", "/quotes/measure/:contact"]) assert.equal(routes[p].perm, "quotes:write", p);
  assert.ok(M.routes.findIndex((r) => r.path === "/quotes/measure") < M.routes.findIndex((r) => r.path === "/quotes/:id"), "before /quotes/:id");
  const n = await load("new");
  const contact = { contact: { id: "ct_1", display_name: `Pat ${XSS}`, phones: [], source: {} }, properties: [] };
  const cx = { pricing: { plan_discount_per_visit_cents: { quarterly: 10000 } }, discounts: [{ id: "dd_1", key: "plan_quarterly", name: "Quarterly plan discount", type: "fixed", value: 10000 }], book: [] };
  const api = async (path) => (path.startsWith("/contacts/") ? { data: contact } : { data: cx });
  const c = { ...ctx(), api };
  const s = await n.load({ contact: "ct_1" }, c);
  let h = text(n.render(s, c));
  assert.ok(!h.includes("<script>alert(1)"));
  assert.match(h, /New Estimate/);
  assert.match(h, /One-time job/);
  assert.match(h, /data-cf-addopt/);
  assert.match(h, /Measure and price/);
  assert.match(h, /Files for your customer/);
  assert.match(h, /data-cf-create disabled/);
  s.options[0].lines.push({ title: "Exterior window cleaning", unit_cents: 29500, qty_milli: 1000, scope: { type: "all" } });
  s.options.push({ id: "op_x", name: "Option 2", kind: "one_time", lines: [{ title: "Exterior window cleaning", unit_cents: 24500, qty_milli: 1000 }], discounts: [] });
  h = text(n.render(s, c));
  assert.doesNotMatch(h, /data-cf-create disabled/);
  assert.match(h, /\$295\.00/);
  assert.match(h, /data-cf-rmopt="1"/);
  // a re-quote from the property opens the builder
  const gone = [];
  globalThis.location = { hash: "#/quotes/new/ct_1?property=pr_1&requote=1" };
  try {
    const r = await n.load({ contact: "ct_1" }, { ...c, go: (p) => gone.push(p) });
    assert.equal(r.gone, true);
    assert.deepEqual(gone, ["/quotes/measure/ct_1?property=pr_1&requote=1"]);
  } finally { delete globalThis.location; }
});
