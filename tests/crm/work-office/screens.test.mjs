// The scheduling screens render with synthetic state through html`` (design
// §2.3, §0 rule 7): every interpolation is escaped, links stay in the frame
// or leave through openExternal, and each screen says what it should. The
// visitActions contract (work/manifest.js) is checked here; the phone walk
// (tests/e2e/work-office.spec.mjs) covers the rest.
import { test } from "node:test";
import assert from "node:assert/strict";

globalThis.window = { __crm: { session: { perms: { "schedule:read": true, "schedule:write": true } } } };
const load = async (name) => (await import(`../../../crm-app/modules/work/${name}.js`)).default;
const kit = await import("../../../crm-app/modules/work/office-kit.js");
const ctx = (perms = null) => ({ can: (p) => (perms ? perms.includes(p) : true), user: { id: "us_00000000000000000001", role: "owner" }, keep: {}, path: "/x", params: {} });
const text = (safe) => String(safe);
const XSS = "</script><script>alert(1)</script>";
const U1 = "us_0000000000000000000t", U2 = "us_0000000000000000000u";
const users = [{ id: U1, name: "Theo Tech", color: "#2563eb", is_technician: true }, { id: U2, name: `Tess ${XSS}`, color: "#13a165", is_technician: true }];

const vrow = (o = {}) => ({ id: "vs_00000000000000000001", j: "jb_00000000000000000001", jn: "S-000001", c: "ct_00000000000000000001", cn: `Pat ${XSS}`, town: "Delano", ad: "1 Example Ave, Delano", d: "2026-11-24", s: "08:00", e: "10:00", w: { t: "window", m: 120 }, a: [U1], st: "scheduled", t: "Exterior window cleaning", geo: [45.04, -93.79], ...o });

test("office-kit: slot text, windows, ranges, lines read back", () => {
  assert.equal(kit.slotText({ start: "08:00", end: "10:00", window: { type: "window", minutes: 120 } }), "Arrive 8:00–10:00 AM");
  assert.equal(kit.slotText({ start: "11:00", end: "13:00", window: { type: "window", minutes: 120 } }), "Arrive 11:00 AM–1:00 PM");
  assert.equal(kit.slotText({ start: "09:30", end: "11:00", window: { type: "exact" } }), "At 9:30 AM");
  assert.equal(kit.slotText({ s: "08:00", e: "18:00", w: { t: "anytime", m: 0 } }), "Anytime (8 AM–6 PM)");
  assert.equal(kit.slotText({ do: true }), "Time not set");
  assert.deepEqual(kit.windowFrom("window:60"), { type: "window", minutes: 60 });
  assert.deepEqual(kit.windowFrom("exact:0"), { type: "exact", minutes: 0 });
  assert.equal(kit.windowValue({ type: "anytime", minutes: 0 }), "anytime:0");
  assert.equal(kit.addDays("2026-03-07", 1), "2026-03-08", "dates never trip on DST");
  assert.equal(kit.addDays("2026-03-08", 1), "2026-03-09");
  assert.equal(kit.weekStart("2026-11-22"), "2026-11-16", "weeks start on Monday");
  assert.ok(!text(kit.faces(users, [U2])).includes("<script>"), "names are escaped");
  // the lines editor reads back cents and thousandths, and refuses a bad price
  const li = (title, price, qty, type = "") => ({ dataset: {}, querySelector: (q) => ({ "[name=l_title]": { value: title }, "[name=l_price]": { value: price }, "[name=l_qty]": { value: qty }, "[name=l_type]": { value: type } })[q] });
  const form = (rows) => ({ querySelectorAll: () => rows });
  assert.deepEqual(kit.readLines(form([li("Exterior", "295.50", "1", "Residential Window Cleaning"), li("", "", "1"), li("Screens", "$5", "2.5")])).lines, [
    { title: "Exterior", unit_cents: 29550, qty_milli: 1000, service_type: "Residential Window Cleaning" }, { title: "Screens", unit_cents: 500, qty_milli: 2500 },
  ]);
  assert.equal(kit.readLines(form([li("Bad", "12.345", "1")])).error.field, "lines");
  assert.equal(kit.readLines(form([li("", "20", "1")])).error.message, "Line 1 needs a name.");
});

test("Schedule: day (visits and tasks in time order, warnings, faces), week grid, list, the tray; escaped", async () => {
  const sch = await load("office-schedule");
  const data = {
    visits: [vrow(), vrow({ id: "vs_00000000000000000002", s: "13:00", e: "14:00", w: { t: "exact", m: 0 }, a: [] }), vrow({ id: "vs_00000000000000000003", s: "10:30", e: "11:30", st: "cancelled" })],
    tasks: [{ id: "tk_00000000000000000001", kind: "estimate_visit", title: `Estimate ${XSS}`, date: "2026-11-24", start: "11:00", end: "12:00", a: [U1], cn: "Sam Sample" }],
    warnings: { vs_00000000000000000001: [{ code: "time_off", message: "Theo is off." }] }, stale: false,
  };
  const s = { view: "day", date: "2026-11-24", tech: null, month: "2026-11", users, data, tray: null };
  const h = text(sch.render(s, ctx()));
  assert.ok(!h.includes("<script>alert(1)"), "escaped");
  assert.match(h, /href="#\/visits\/vs_00000000000000000001"/);
  assert.match(h, /href="#\/tasks\/tk_00000000000000000001"/);
  assert.ok(h.indexOf("vs_00000000000000000001") < h.indexOf("vs_00000000000000000003") && h.indexOf("vs_00000000000000000003") < h.indexOf("tk_00000000000000000001") && h.indexOf("tk_00000000000000000001") < h.indexOf("vs_00000000000000000002"), "in time order");
  assert.match(h, /title="Theo is off\."/, "the warning");
  assert.match(h, /Nobody yet/, "an unassigned visit says so");
  assert.match(h, /2 visits/, "cancelled visits don't count");
  assert.match(h, /href="#\/schedule\/move-day\?date=2026-11-24"/);
  // one tech: their route
  const one = text(sch.render({ ...s, tech: U1 }, ctx()));
  assert.match(one, /href="#\/schedule\/route\/2026-11-24\/us_0000000000000000000t"/);
  assert.doesNotMatch(one, /vs_00000000000000000002/, "only their visits");
  const wk = text(sch.render({ ...s, view: "week", data: { ...data, visits: [vrow({ d: "2026-11-23" }), vrow({ d: "2026-11-24" }), vrow({ d: "2026-11-24", a: [U2] })] } }, ctx()));
  assert.match(wk, /data-goday="2026-11-24" data-gotech="us_0000000000000000000t"/);
  assert.ok(!wk.includes("<script>alert(1)"));
  const tray = text(sch.render({ ...s, view: "tray", tray: { month: "2026-11", jobs: [{ id: "jb_00000000000000000009", n: "S-000009", cn: `Lee ${XSS}`, t: "Lights takedown", k: "lights_takedown", tm: "2026-11" }], later: 3 } }, ctx()));
  assert.match(tray, /data-book="jb_00000000000000000009"/);
  assert.match(tray, /Lights takedown \(no charge\)/);
  assert.match(tray, /3 more jobs due after November 2026/);
  assert.ok(!tray.includes("<script>alert(1)"));
  assert.match(text(sch.render({ denied: true }, ctx())), /Your day is on Today[\s\S]*href="#\/today"/);
  assert.equal(sch.action(s, { ...ctx(), go: () => {} }).label, "Book", "the top button books; Time off sits with the day's buttons");
  assert.match(h, /href="#\/schedule\/time-off"/);
});

test("Visit: the office's view (buttons by what the server allows, texts sent or would-send) and visitActions", async () => {
  const visit = await load("visit");
  const { actionsFor } = await import("../../../crm-app/modules/work/visit.js");
  const data = {
    visit: { id: "vs_1", job_id: "jb_1", date: "2026-11-24", start: "08:00", end: "10:00", window: { type: "window", minutes: 120 }, status: "scheduled", assignee_ids: [U1], town: "Delano",
      checklist: { items: [{ key: "glass", label: `Glass ${XSS}`, required: true, done: true }, { key: "screens", label: "Screens", required: false }] }, tech_notes: "Gate was open", updated_at: "2026-11-17T15:00:00.000Z" },
    job: { id: "jb_1", number_label: "S-000001", title: "Exterior window cleaning", kind: "standard", lines: [{ title: "Exterior", total_cents: 29500, qty_milli: 1000 }], totals: { total_cents: 29500 }, crew_notes: "Dog in back", office_notes: "Pays by check" },
    contact: { id: "ct_1", display_name: `Pat ${XSS}`, phones: [{ e164: "+17635550100", primary: true }] },
    property: { id: "pr_1", address: { street1: "1 Example Ave", city: "Delano", state: "MN", zip: "55328" }, access: { gate_code: "1234" } },
    people: [{ id: U1, name: "Theo Tech" }], arrival: "arriving between 8:00 and 10:00 AM",
    reminders: { confirm: { state: "done", dry: true, at: "2026-11-17T15:10:00.000Z" }, d14: null, d2: { state: "skipped", dry: true, at: "2026-11-17T16:00:00.000Z", result: { reason: "soon" } } },
    can: { office: true, assignee: false, prices: true, reopen: false, move: true, cancel: true, no_access: true, done: true },
  };
  const s = { ...data, etag: "\"1\"", users, panels: [], buttons: [] };
  const h = text(visit.render(s, ctx()));
  assert.ok(!h.includes("<script>alert(1)"), "escaped");
  for (const b of ["data-move", "data-done", "data-noaccess", "data-cancel"]) assert.match(h, new RegExp(b));
  assert.doesNotMatch(h, /data-reopen/);
  assert.match(h, /href="tel:\+17635550100"/);
  assert.match(h, /target="_blank"|data-external="top"/, "directions leave the frame");
  assert.match(h, /Would have sent/);
  assert.match(h, /Skipped/);
  assert.match(h, /1 of 2/);
  // the crew's ticks are done_at (the server's finish gate, §5.5): the office counts those
  const ticked = text(visit.render({ ...s, visit: { ...s.visit, checklist: { items: [{ key: "a", label: "A", done_at: "2026-11-24T14:10:00.000Z" }, { key: "b", label: "B", kind: "photo", value: "fl_00000000000000000001" }, { key: "c", label: "C" }] } } }, ctx()));
  assert.match(ticked, /2 of 3/);
  assert.match(h, /Gate code/);
  assert.match(h, /Pays by check/);
  assert.match(h, /\$295/);
  // no prices for someone without them, no office buttons for an assignee
  const tech = text(visit.render({ ...s, reminders: undefined, users: [], can: { office: false, assignee: true, prices: false } }, ctx()));
  assert.doesNotMatch(tech, /data-move|data-cancel|\$295|Texts and emails/);

  // visitActions: when, perm and order; panels render inline, buttons run on tap
  const manifests = [
    { name: "work", visitActions: [{ key: "field", label: "Field", when: "assignee", panel: true, order: 10, load: async () => ({}) }] },
    { name: "money", visitActions: [{ key: "collect", label: "Collect payment", when: "any", perm: "payments:collect", order: 30, load: async () => ({}) }, { key: "bad" }] },
  ];
  const keys = (d, perms) => actionsFor(d, ctx(perms).can, manifests).map((a) => a.key);
  assert.deepEqual(keys({ can: { office: true, assignee: false } }, null), ["collect"]);
  assert.deepEqual(keys({ can: { office: true, assignee: true } }, null), ["field", "collect"]);
  assert.deepEqual(keys({ can: { office: false, assignee: true } }, ["schedule:read"]), ["field"], "perm checked");
  const panelMod = { render: (st) => kit.emptyCard(`Panel ${st.n}`, "x"), events: {} };
  const withPanel = text(visit.render({ ...s, panels: [{ key: "field", label: "Field", mod: panelMod, state: { n: 7 }, ctx: {} }], buttons: [{ key: "collect", label: "Collect payment" }] }, ctx()));
  assert.match(withPanel, /data-panel="field"[^>]*>.*Panel 7/s);
  assert.match(withPanel, /data-vact="collect"/);
  const failed = text(visit.render({ ...s, panels: [{ key: "field", label: "Field", failed: `boom ${XSS}` }] }, ctx()));
  assert.match(failed, /Field didn't load/);
  assert.ok(!failed.includes("<script>alert(1)"));
});

test("Job, Jobs, New job, Route, Rain day, Time off, Work tab, Today card, Checklists: render and escape", async () => {
  const job = await load("office-job");
  const j = { id: "jb_1", number_label: "885", title: `Windows ${XSS}`, kind: "lights_install", status: "scheduled", lines: [{ title: "Lights", total_cents: 120000, qty_milli: 1000 }], totals: { total_cents: 120000, discount_cents: 0 }, crew_notes: "Ladder", office_notes: "VIP", rotor: { job_id: 1 }, updated_at: "2026-11-17T15:00:00.000Z" };
  const jh = text(job.render({ job: j, visits: [{ id: "vs_1", date: "2026-11-24", start: "08:00", end: "10:00", window: { type: "exact" }, status: "completed", assignee_ids: [U1] }], contact: { id: "ct_1", display_name: "Pat" }, property: null, users, can: { write: true, complete: true, cancel: true, add_visit: true } }, ctx()));
  assert.ok(!jh.includes("<script>alert(1)"));
  assert.match(jh, /Christmas lights install/);
  assert.match(jh, /data-complete/);
  assert.match(jh, /From Rotor \(job 885\)/);
  assert.match(jh, /href="#\/visits\/vs_1"/);

  const jobs = await load("office-jobs");
  const rows = [{ id: "jb_2", n: "S-000002", cn: `Lee ${XSS}`, t: "Gutters", st: "scheduled", k: "standard", nv: "2026-11-24", tot: 15000, bill: true, stale: "scheduled_past" }, { id: "jb_3", n: "S-000003", cn: "Sam", t: "Windows", st: "unscheduled", k: "standard", tm: "2026-12", tot: 0 }];
  const lh = text(jobs.render({ tab: "open", year: "2026", q: "", rows }, ctx()));
  assert.ok(!lh.includes("<script>alert(1)"));
  assert.match(lh, /Booked, but the date went by/);
  assert.match(lh, /due 2026-12/);
  assert.match(lh, /2 jobs/);
  assert.match(text(jobs.render({ tab: "open", year: "2026", q: "sam", rows }, ctx())), /1 job</);

  const nj = await load("office-job-new");
  const nh = text(nj.render({ contact: { id: "ct_1", name: `Pat ${XSS}`, properties: [{ id: "pr_1", address: { street1: "1 Example Ave", city: "Delano" } }, { id: "pr_2", label: "Cabin" }], primary: "pr_1" }, users, people: [], book: true }, ctx()));
  assert.ok(!nh.includes("<script>alert(1)"));
  assert.match(nh, /name="property_id"/);
  assert.match(nh, /Save and book/);
  assert.match(nh, /data-person="us_0000000000000000000t"/);

  const route = await load("office-route");
  const stops = [vrow(), vrow({ id: "vs_2", geo: null, ad: "", town: "Mound" })];
  const rh = text(route.render({ date: "2026-11-24", user_id: U1, stops, order: ["vs_2", "vs_00000000000000000001"], person: users[0], dirty: true }, ctx()));
  assert.ok(!rh.includes("<script>alert(1)"));
  assert.ok(rh.indexOf("vs_2") < rh.indexOf("vs_00000000000000000001"), "in the order on screen");
  assert.match(rh, /One stop has no map location/);
  assert.match(rh, /google\.com\/maps\/dir\/\?api=1[^"]*" target="_blank"/);
  assert.match(rh, /Save to keep this order/);

  const move = await load("office-moveday");
  const base = { from: "2026-11-24", to: "2026-11-25", users, people: [], services: [], notify: true, preview: null, run: null, err: null };
  assert.match(text(move.render(base, ctx())), /See what moves/);
  const pv = text(move.render({ ...base, preview: { from_date: "2026-11-24", to_date: "2026-11-25", notify: true, token: "t", warnings: [{ message: "We're closed on Wed, Nov 25." }], visits: [{ id: "vs_1", contact_name: `Pat ${XSS}`, town: "Delano", start: "08:00", end: "10:00", window: { t: "window", m: 120 }, assignee_ids: [U1] }], customers: [{ id: "ct_1" }], techs: [U1] } }, ctx()));
  assert.ok(!pv.includes("<script>alert(1)"));
  assert.match(pv, /Move 1 visit/);
  assert.match(pv, /1 customer get a text once an owner confirms it/);
  assert.match(pv, /closed on Wed, Nov 25/);
  const dn = text(move.render({ ...base, run: { status: "done", result: { bulk_run_id: "br_1", moved: 3, skipped: 1 } } }, ctx()));
  assert.match(dn, /3 visits moved\. 1 visit had changed/);
  assert.match(dn, /href="#\/approvals"/);

  const off = await load("office-timeoff");
  const { offWhen } = await import("../../../crm-app/modules/work/office-timeoff.js");
  assert.equal(offWhen({ s: "2026-12-24T06:00:00.000Z", e: "2026-12-27T06:00:00.000Z", ad: true }), "Thu, Dec 24 – Sat, Dec 26");
  assert.equal(offWhen({ s: "2027-03-15T14:00:00.000Z", e: "2027-03-15T16:30:00.000Z", ad: false }), "Mon, Mar 15, 9:00 AM–11:30 AM");
  const oh = text(off.render({ rows: [{ id: "to_1", uid: U2, s: "2099-12-24T06:00:00.000Z", e: "2099-12-27T06:00:00.000Z", ad: true, r: `Trip ${XSS}` }], users }, ctx()));
  assert.ok(!oh.includes("<script>alert(1)"));
  assert.match(oh, /data-del="to_1"/);

  const tab = await load("office-contact-tab");
  const th = text(tab.render({ contact: { id: "ct_1", display_name: "Pat" }, jobs: [{ id: "jb_1", number_label: "885", title: `W ${XSS}`, kind: "standard", status: "scheduled", totals: { total_cents: 100 } }], upcoming: [{ id: "vs_1", date: "2026-11-24", start: "08:00", end: "10:00", window: { type: "exact" }, status: "scheduled", job_title: "W" }], past: [] }, ctx()));
  assert.ok(!th.includes("<script>alert(1)"));
  assert.match(th, /href="#\/jobs\/new\/ct_1"/);
  assert.match(th, /href="#\/visits\/vs_1"/);

  const card = await load("office-today-card");
  const ch = text(card.render({ date: "2026-11-24", day: { visits: [vrow(), vrow({ id: "vs_9", a: [U1, U2], st: "completed" }), vrow({ id: "vs_8", a: [] })] }, tray: { jobs: [{ id: "jb_1" }] }, stale: { jobs: [{ id: "jb_2" }, { id: "jb_3" }] }, users }, ctx()));
  assert.ok(!ch.includes("<script>alert(1)"));
  assert.match(ch, /href="#\/schedule\/route\/2026-11-24\/us_0000000000000000000t"/);
  assert.match(ch, /2 visits, 1 to go/);
  assert.match(ch, /Nobody assigned/);
  assert.match(ch, /2 jobs need a look/);
  assert.match(ch, /href="#\/jobs\?status=stale"/);

  const cls = await load("office-checklists");
  const clh = text(cls.render({ rows: [{ id: "ck_1", k: "windows_exterior", n: `Exterior ${XSS}`, svc: ["Residential Window Cleaning"], jk: [], ni: 4, nr: 2, act: true }] }, ctx()));
  assert.ok(!clh.includes("<script>alert(1)"));
  assert.match(clh, /4 items, 2 required/);
  const cl = await load("office-checklist");
  const eh = text(cl.render({ c: { id: "ck_1", key: "windows_exterior", name: "Exterior", active: true, items: [{ key: "glass", label: `Glass ${XSS}`, kind: "check", required: true }] }, kinds: [], svc: ["Residential Window Cleaning"] }, ctx()));
  assert.ok(!eh.includes("<script>alert(1)"));
  assert.match(eh, /data-key="glass"/);
  assert.match(eh, /data-svc="Residential Window Cleaning" aria-pressed="true"/);
});

test("the manifest: the office part and the field part merge; every route loads a screen", async () => {
  const m = (await import("../../../crm-app/modules/work/manifest.js")).default;
  assert.equal(m.name, "work");
  for (const r of m.routes) {
    const mod = (await r.load()).default;
    assert.equal(typeof mod.render, "function", r.path);
  }
  assert.ok(m.routes.some((r) => r.path === "/schedule"), "the Schedule tab");
  assert.ok(m.routes.some((r) => r.path === "/visits/:id"));
  assert.equal(typeof (await m.contactTabs[0].load()).default.render, "function");
  assert.equal(typeof (await m.todayCards[0].load()).default.load, "function");
  assert.deepEqual(m.visitActions, [], "the office adds no visit action; M4b and Money do");
});
