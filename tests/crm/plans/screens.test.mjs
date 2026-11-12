// The plans screens render with synthetic state through html`` (design
// §2.3, §0 rule 7): every interpolation escaped, links stay in the CRM, and
// each screen offers only what the plan's status and the login allow. The
// phone walk (tests/e2e/plans.spec.mjs) covers the rest.
import { test } from "node:test";
import assert from "node:assert/strict";

const load = async (name) => (await import(`../../../crm-app/modules/plans/${name}.js`)).default;
const M = (await import("../../../crm-app/modules/plans/manifest.js")).default;
const kit = await import("../../../crm-app/modules/plans/kit.js");
const ctx = (perms = null, role = "owner") => ({ can: (p) => (perms ? perms.includes(p) : true), user: { id: "us_00000000000000000001", role }, keep: {}, path: "/x", params: {} });
const text = (safe) => String(safe);
const XSS = "</script><script>alert(1)</script>";
const NOW = "2026-11-10T16:00:00.000Z";

const row = (o = {}) => ({ id: "pl_00000000000000000001", c: "ct_00000000000000000001", cn: `Pat ${XSS}`, nm: "Quarterly plan", ck: "quarterly", k: "quarterly", st: "active", pr: [], nx: "2026-12", ap: true, ag: "signed", u: NOW, ...o });
const plan = (o = {}) => ({
  id: "pl_00000000000000000001", name: `Quarterly ${XSS}`, contact_id: "ct_00000000000000000001", contact_name: `Pat ${XSS}`, catalog_key: "quarterly", kind: "quarterly", status: "active", visits_per_year: 4,
  term: { start_on: "2026-11-17", initial_months: 12, initial_end_on: "2027-11-16", current_term_n: 1, current_term_start: "2026-11-17", current_term_end: "2027-11-16", renews_every_months: 3, auto_renew: true, price_locked_until: "2027-11-16" },
  billing: { mode: "barta_standard", autopay: true }, perks: { touch_ups: true, rain_guarantee_days: 7, hard_water: true }, sale_value_cents: 64500, pending_reasons: [], agreement_status: "signed", agreement_id: "ag_00000000000000000001",
  lines: [{ id: "ln_e", title: `Exterior ${XSS}`, qty_milli: 1000, unit_cents: 29500, total_cents: 29500, scope: { type: "specific", visits: [1, 3, 4] } }],
  ordinals: [
    { term: 1, n: 1, k: 1, target_month: "2026-11", status: "unscheduled", total_cents: 19500, job_id: "jb_00000000000000000001", job: { id: "jb_00000000000000000001", number: "J-0001", status: "unscheduled" } },
    { term: 1, n: 2, k: 2, target_month: "2027-02", status: "unscheduled", total_cents: 6000 },
    { term: 1, n: 3, k: 3, target_month: "2027-05", status: "completed", completed_on: "2027-05-04", total_cents: 19500 },
  ],
  ...o,
});
const planState = (o = {}, p = {}) => ({
  plan: plan(p), etag: '"e1"', contact: { id: "ct_00000000000000000001", name: `Pat ${XSS}`, phone: "+17635550100", email: "pat@example.com" },
  agreements: [{ id: "ag_00000000000000000001", title: `Quarterly plan service agreement ${XSS}`, status: "signed", signed_at: NOW, signature: { name_typed: `Pat ${XSS}`, method: "in_person" } }],
  seasons: [], perk_names: { touch_ups: "Unlimited Touch-Ups", rain_guarantee: "7-Day Rain Guarantee", hard_water: "Free Hard Water Removal" }, features: { jobs: true, money: false, bulk: true }, sms_mode: "dry_run",
  can: { write: true, cancel: true, send: true, waive: true }, readiness: [], ...o,
});

test("the manifest: routes with permissions and parents, More → Plans and Lights season, New plan, the contact's Plans tab, the Today card, two settings pages", () => {
  assert.equal(M.name, "plans");
  assert.ok(M.routes.every((r) => r.perm && typeof r.load === "function" && r.parent));
  for (const p of ["/plans", "/plans/new", "/plans/new/:contact", "/plans/due", "/plans/:id", "/lights", "/lights/:season", "/settings/plans", "/settings/agreement-templates", "/settings/agreement-templates/:id"]) assert.ok(M.routes.some((r) => r.path === p), p);
  assert.ok(M.routes.some((r) => r.path === "/settings/plans" && r.perm === "settings:owner"));
  assert.ok(M.routes.filter((r) => r.path.startsWith("/plans") || r.path.startsWith("/lights")).every((r) => r.perm.startsWith("plans:")), "techs see none of it (plans:* is office only)");
  assert.deepEqual(M.nav.map((n) => n.path), ["/plans", "/lights"]);
  assert.equal(M.creates[0].path, "/plans/new");
  assert.equal(M.contactTabs[0].key, "plans");
  assert.equal(M.todayCards[0].key, "plans");
  assert.deepEqual(M.settings.map((s) => s.path), ["/settings/plans", "/settings/agreement-templates"]);
});

test("Plans list and the contact's tab: chips with counts, rows escaped, waiting plans say what for", async () => {
  const list = await load("list");
  const rows = [row(), row({ id: "pl_00000000000000000002", cn: "Sam Sample", st: "pending", pr: ["signature"], nx: null })];
  const h = text(list.render({ rows, counts: { active: 1, pending: 1, due: 1 }, chip: "active", q: "", special: null }, ctx()));
  assert.ok(!h.includes("<script>alert(1)"));
  assert.match(h, /href="#\/plans\/pl_00000000000000000001"/);
  assert.match(h, /Active <span class="n">1<\/span>/);
  assert.match(h, /next Dec 2026 · autopay/);
  assert.doesNotMatch(h, /Sam Sample/, "a waiting plan isn't under Active");
  assert.match(text(list.render({ rows, counts: { active: 1, pending: 1 }, chip: "pending", q: "", special: null }, ctx())), /waiting for agreement to sign/);
  assert.match(text(list.render({ rows, counts: { active: 1 }, chip: "active", q: "nobody", special: null }, ctx())), /Nothing here|No active plans/);
  const tab = await load("contact-tab");
  const th = text(tab.render({ id: "ct_1", rows, agreements: [{ id: "ag_1", plan_id: "pl_00000000000000000002", title: `Agreement ${XSS}`, status: "viewed" }] }, ctx()));
  assert.ok(!th.includes("<script>alert(1)"));
  assert.match(th, /href="#\/plans\/new\/ct_1"/);
  assert.match(th, /Opened, not signed/);
  assert.doesNotMatch(text(tab.render({ id: "ct_1", rows, agreements: [] }, ctx(["plans:read"]))), /New plan/, "read-only: no New plan");
  assert.match(text(tab.render({ denied: true }, ctx())), /Not for this login/);
});

test("one plan: the visits with Book and Skip, the agreement, the terms; the buttons its status allows; escaped", async () => {
  const view = await load("plan");
  const h = text(view.render(planState(), ctx()));
  assert.ok(!h.includes("<script>alert(1)"));
  assert.match(h, /href="#\/jobs\/jb_00000000000000000001">Book/);
  assert.match(h, /data-skip="1:1"/);
  assert.doesNotMatch(h, /data-skip="1:3"/, "a done visit can't be skipped");
  assert.match(h, /Done /);
  assert.match(h, /\$195\.00/);
  assert.match(h, /\(in person\)/);
  assert.match(h, /data-act="pause"/);
  assert.match(h, /data-act="cancel"/);
  assert.match(h, /data-act="price"/);
  assert.doesNotMatch(h, /data-act="send-agreement"/, "a signed agreement isn't sent again");
  assert.match(h, /Unlimited Touch-Ups, 7-Day Rain Guarantee, Free Hard Water Removal/);
  assert.match(h, /On \(cards arrive with Money\)/);
  // pending: Activate anyway, send and present; no Skip
  const pend = text(view.render(planState({ agreements: [] }, { status: "pending", pending_reasons: ["signature"], agreement_status: "none" }), ctx()));
  assert.match(pend, /Waiting for the agreement to sign/);
  assert.match(pend, /data-act="activate"/);
  assert.match(pend, /data-act="send-agreement"/);
  assert.match(pend, /data-act="present-agreement"/);
  assert.doesNotMatch(pend, /data-skip/);
  // cancelling with a clawback to bill: Keep the plan, billed / waive
  const ending = text(view.render(planState({}, { status: "cancelling", cancel: { requested_on: "2026-11-20", effective_on: "2026-11-27", reason: "moving", clawback_cents: 10000, clawback_state: "to_bill" } }), ctx()));
  assert.match(ending, /Ends Nov 27, 2026/);
  assert.match(ending, /data-act="withdraw"/);
  assert.match(ending, /data-act="claw-billed"/);
  assert.match(ending, /data-act="claw-waive"/);
  // someone who reads only: no buttons
  const ro = text(view.render(planState(), ctx(["plans:read"])));
  assert.doesNotMatch(ro, /data-act=|data-skip/);
  // a paused plan resumes; an ended one renews; Rotor's plan says who's in charge
  assert.match(text(view.render(planState({}, { status: "paused", pause: { from: "2026-12-01", reason: `Away ${XSS}` } }), ctx())), /data-act="resume"/);
  assert.match(text(view.render(planState({}, { status: "expired" }), ctx())), /data-act="renew"/);
  assert.match(text(view.render(planState({}, { import: { rotor_id: "x" } }), ctx())), /Rotor stays in charge/);
});

test("visits due by town, the lights board, the Today card", async () => {
  const due = await load("due");
  const visits = [{ plan_id: "pl_1", plan_name: "Quarterly plan", contact_name: `Pat ${XSS}`, town: "Mound", n: 2, target_month: "2026-10", job_id: "jb_1", overdue: true }, { plan_id: "pl_2", plan_name: "Biannual plan", contact_name: "Sam", town: "", n: 1, target_month: "2026-11", job_id: null }];
  const dh = text(due.render({ month: kit.thisMonth(), visits }, ctx()));
  assert.ok(!dh.includes("<script>alert(1)"));
  assert.match(dh, /Mound/);
  assert.match(dh, /Town not set/);
  assert.match(dh, /\(overdue\)/);
  assert.match(dh, /href="#\/jobs\/jb_1"/);
  assert.match(dh, /its job is on the way/);
  assert.match(text(due.render({ month: kit.thisMonth(), visits: [] }, ctx())), /Nothing to book/);
  const lights = await load("lights");
  const rows = [{ id: "si_1", contact_id: "ct_1", contact_name: `Pat ${XSS}`, town: "Delano", status: "taken_down", footage_ft: 150, bin_id: null, install_job_id: "jb_1", takedown_job_id: "jb_2" }, { id: "si_2", contact_id: "ct_2", contact_name: "Sam", status: "stored", footage_ft: 80, bin_id: "B-14", three_year: true }];
  const lh = text(lights.render({ season: 2026, rows, counts: { taken_down: 1, stored: 1 }, footage_ft: 230, needs_bin: 1 }, ctx()));
  assert.ok(!lh.includes("<script>alert(1)"));
  assert.match(lh, /Taken down · 1/);
  assert.match(lh, /bin B-14 · 3-year/);
  assert.match(lh, /<b>230<\/b>/);
  assert.match(lh, /href="#\/lights\/2027"/);
  assert.match(text(lights.render({ season: 2026, rows: [], counts: {}, footage_ft: 0, needs_bin: 0 }, ctx())), /No lights this season/);
  const card = await load("today-card");
  assert.equal(text(card.render({ due: 0, unsigned: 0, drafts: 0, clawbacks: 0 })), "");
  const ch = text(card.render({ due: 3, unsigned: 1, drafts: 5, clawbacks: 1 }));
  assert.match(ch, /3 plan visits to book/);
  assert.match(ch, /1 agreement not signed/);
  assert.match(ch, /5 agreement texts to approve/);
  assert.match(ch, /1 clawback to bill/);
});

test("Settings: the catalog, the lights dates, request signatures; agreement texts with their approval; escaped", async () => {
  const CAT = await import("../../../netlify/lib/crm/modules/plans/catalog.mjs");
  const settings = await load("settings");
  const cat = CAT.catalogWith({ perk_names: { touch_ups: `Touch-ups ${XSS}` } });
  const sh = text(settings.render({ cat, catEtag: "new", lights: { ...CAT.LIGHTS_DEFAULTS }, lightsEtag: "new", unsigned: ["pl_1", "pl_2"] }, ctx()));
  assert.ok(!sh.includes("<script>alert(1)"));
  assert.match(sh, /name="quarterly\.visits_per_year" inputmode="numeric" value="4"/);
  assert.match(sh, /name="quarterly\.discount" inputmode="decimal" value="100\.00"/);
  assert.match(sh, /name="rebook_on" value="09-01"/);
  assert.match(sh, /Request signatures for 2 plans/);
  assert.doesNotMatch(text(settings.render({ cat, catEtag: "new", lights: { ...CAT.LIGHTS_DEFAULTS }, lightsEtag: "new", unsigned: [] }, ctx())), /data-request/);
  const list = await load("templates");
  const lh = text(list.render({ rows: [{ id: "at_1", name: `Quarterly ${XSS}`, version: 2, approved: false, active: true, catalog_keys: ["quarterly"] }, { id: "at_2", name: "Biannual", version: 1, approved: true, active: true, catalog_keys: ["biannual"] }] }, ctx()));
  assert.ok(!lh.includes("<script>alert(1)"));
  assert.match(lh, /Needs approval/);
  assert.match(lh, /Approved/);
  assert.match(lh, /href="#\/settings\/agreement-templates\/at_1"/);
  const one = await load("template");
  const t = { id: "at_1", name: "Quarterly", version: 2, approved: false, active: true, body_md: `## {{plan_name}}\n\n${XSS}`, applies_to: { catalog_keys: ["quarterly"] } };
  const oh = text(one.render({ t, etag: '"e"', preview: `Hello ${XSS}` }, ctx()));
  assert.ok(!oh.includes("<script>alert(1)"));
  assert.match(oh, /Draft, needs owner approval/);
  assert.match(oh, /data-approve/);
  assert.match(oh, /data-var="per_visit_price"/);
  const ro = text(one.render({ t, etag: '"e"', preview: null }, ctx(["plans:read"])));
  assert.doesNotMatch(ro, /data-approve|type="submit"/, "an admin reads; an owner edits and approves");
  assert.match(ro, /readonly/);
});

test("new plan: the catalog fills the plan discount; quarterly asks for the interior price", async () => {
  const CAT = await import("../../../netlify/lib/crm/modules/plans/catalog.mjs");
  const n = await load("new");
  const s = { cat: CAT.catalogWith({}), contact: { id: "ct_1", name: `Pat ${XSS}` }, client_id: "c1", key: "quarterly" };
  const h = text(n.render(s, ctx()));
  assert.ok(!h.includes("<script>alert(1)"));
  assert.match(h, /Interior visit price \(visit 2\)/);
  assert.match(h, /name="disc" inputmode="decimal" value="100\.00"/);
  assert.match(h, /4 visits a year, \$100 off each visit/);
  const b = text(n.render({ ...s, key: "biannual", contact: null }, ctx()));
  assert.doesNotMatch(b, /Interior visit price/);
  assert.match(b, /data-pick/);
  assert.match(b, /name="disc" inputmode="decimal" value="50\.00"/);
});

test("review fixes on screen: a lights season waits for a yes, a held plan says so, a queued agreement isn't 'sent', owner checks block Approve", async () => {
  const view = await load("plan");
  const lights = planState({ seasons: [{ season: 2026, status: "stored", bin_id: "B-1" }] }, {
    kind: "lights_annual", catalog_key: "lights_annual", name: "Christmas lights plan", visits_per_year: 1,
    ordinals: [{ term: 1, n: 1, k: 1, target_month: "2026-11", status: "completed", total_cents: 75000 }, { term: 2, n: 1, k: 2, target_month: "2027-11", status: "unscheduled", total_cents: 120000 }],
  });
  const lh = text(view.render(lights, ctx()));
  assert.match(lh, /data-confirm-season="2027"/);
  assert.match(lh, /once the customer says yes/);
  assert.doesNotMatch(text(view.render({ ...lights, plan: { ...lights.plan, confirmed_seasons: [2027] } }, ctx())), /data-confirm-season="2027"/);
  assert.match(text(view.render(planState({}, { held: { action: "resume", since: "2026-11-24" } }), ctx())), /Rotor is still in charge of this customer/);
  const queued = text(view.render(planState({ agreements: [{ id: "ag_00000000000000000001", title: "x", status: "draft", queued: true }] }, { agreement_status: "draft" }), ctx()));
  assert.match(queued, /Waiting in a bulk send/);
  const board = await load("lights");
  const bh = text(board.render({ season: 2027, rows: [], counts: {}, footage_ft: 0, needs_bin: 0, to_confirm: [{ plan_id: "pl_1", contact_name: `Pat ${XSS}`, town: "Delano", plan_name: "Christmas lights plan" }] }, ctx()));
  assert.ok(!bh.includes("<script>alert(1)"));
  assert.match(bh, /Waiting for a yes · 1/);
  assert.match(bh, /href="#\/plans\/pl_1"/);
  const one = await load("template");
  const t = { id: "at_1", name: "Quarterly", version: 1, approved: false, active: true, body_md: `## {{plan_name}}\n\n>> Owner check: confirm the fee ${XSS}\n\nText.`, applies_to: { catalog_keys: ["quarterly"] } };
  const th = text(one.render({ t, etag: '"e"', preview: null }, ctx()));
  assert.ok(!th.includes("<script>alert(1)"));
  assert.match(th, /1 line needs your OK first/);
  assert.doesNotMatch(th, /data-approve/, "no Approve while a check is left");
  assert.match(th, /data-var="price_details"/);
  assert.match(text(one.render({ t: { ...t, body_md: "## {{plan_name}}\n\nText." }, etag: '"e"', preview: null }, ctx())), /data-approve/);
});

test("the owner's answers on screen (Nov 12): suggested wording beside an edited text, the lights storage fee, the late fee for one-time jobs too", async () => {
  const list = await load("templates");
  const lh = text(list.render({ rows: [{ id: "at_1", name: "Quarterly", version: 3, approved: true, active: true, catalog_keys: ["quarterly"], suggested: true }, { id: "at_2", name: "Biannual", version: 3, approved: false, active: true, catalog_keys: ["biannual"], suggested: false }] }, ctx()));
  assert.equal((lh.match(/New wording/g) || []).length, 1, "only the text with a suggestion says so");
  const one = await load("template");
  const t = { id: "at_1", name: "Quarterly", version: 3, approved: true, active: true, body_md: "## Ours", suggested_body_md: `## New ${XSS}`, applies_to: { catalog_keys: ["quarterly"] } };
  const oh = text(one.render({ t, etag: '"e"', preview: null }, ctx()));
  assert.ok(!oh.includes("<script>alert(1)"));
  assert.match(oh, /New suggested wording is available/);
  assert.match(oh, /data-use-suggested/);
  assert.match(oh, /data-keep-mine/);
  assert.match(oh, /data-var="perks_details"/);
  const ro = text(one.render({ t, etag: '"e"', preview: null }, ctx(["plans:read"])));
  assert.match(ro, /New suggested wording is available/);
  assert.doesNotMatch(ro, /data-use-suggested|data-keep-mine/, "only an owner picks");
  assert.doesNotMatch(text(one.render({ t: { ...t, suggested_body_md: undefined }, etag: '"e"', preview: null }, ctx())), /suggested wording/);
  // a 3-year lights plan ending early: the storage fee, said as one
  const view = await load("plan");
  const ending = text(view.render(planState({}, { kind: "lights_annual", catalog_key: "lights_annual", status: "cancelling", cancel: { requested_on: "2027-03-01", effective_on: "2027-03-08", clawback_cents: 40000, storage_fee_cents: 40000, clawback_state: "to_bill" } }), ctx()));
  assert.match(ending, /Storage fee for leaving the contract early: \$400\.00 \(to bill, waiting for your OK\)/);
  assert.match(ending, /Storage fee billed/);
  assert.match(ending, /Waive storage fee/);
  const ended = text(view.render(planState({}, { kind: "lights_annual", catalog_key: "lights_annual", status: "cancelled", cancel: { requested_on: "2027-03-01", effective_on: "2027-03-08", clawback_cents: 40000, storage_fee_cents: 40000, clawback_state: "to_bill" } }), ctx()));
  assert.match(ended, /Storage fee for leaving the contract early: \$400\.00, to bill, waiting for your OK\./, "still said once the plan has ended");
  const windows = text(view.render(planState({}, { status: "cancelling", cancel: { requested_on: "2027-03-01", effective_on: "2027-03-08", clawback_cents: 10000, clawback_state: "to_bill" } }), ctx()));
  assert.match(windows, /First-visit discount back: \$100\.00/);
  // Settings → Plans catalog: the storage fee and what the late fee covers
  const CAT = await import("../../../netlify/lib/crm/modules/plans/catalog.mjs");
  const settings = await load("settings");
  const sh = text(settings.render({ cat: CAT.catalogWith({}), catEtag: "new", lights: { ...CAT.LIGHTS_DEFAULTS }, lightsEtag: "new", unsigned: [] }, ctx()));
  assert.match(sh, /name="storage_fee" inputmode="decimal" value="400\.00"/);
  assert.match(sh, /on a plan or a one-time job/);
});
