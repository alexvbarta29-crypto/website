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

test("Schedule: Day as a column per person (Unassigned first, done of all, money, done struck through, unpaid $, the time line), Sales rep, 3 Day, week, list, the tray; escaped", async () => {
  const sch = await load("office-schedule");
  const data = {
    visits: [
      vrow({ amt: 29500 }), vrow({ id: "vs_00000000000000000002", s: "13:00", e: "14:00", w: { t: "exact", m: 0 }, a: [] }), vrow({ id: "vs_00000000000000000003", s: "10:30", e: "11:30", st: "cancelled" }),
      vrow({ id: "vs_00000000000000000004", s: "10:00", e: "12:00", a: [U2], st: "completed", amt: 41000, pd: 0, cn: "Done Customer" }),
      vrow({ id: "vs_00000000000000000005", s: "14:00", e: "16:00", a: [U2], st: "completed", amt: 10000, pd: 1, cn: "Paid Customer" }),
    ],
    tasks: [{ id: "tk_00000000000000000001", kind: "estimate_visit", title: `Estimate ${XSS}`, date: "2026-11-24", start: "11:00", end: "12:00", a: [U1], cn: "Sam Sample" }],
    warnings: { vs_00000000000000000001: [{ code: "time_off", message: "Theo is off." }] }, stale: false, hours: { 2: ["08:00", "18:00"] },
    sales: [{ id: "tk_00000000000000000002", kind: "call", title: "Call back", date: "2026-11-24", start: "09:30", end: "10:00", a: [U1], cn: "Lee Sample" }, { id: "tk_00000000000000000003", kind: "estimate_visit", title: "Estimate", date: "2026-11-24", start: "13:00", end: "14:00", a: [], cn: "" }],
  };
  const s = { view: "day", by: "tech", date: "2026-11-24", today: "2026-11-24", nowMin: 12 * 60, tech: null, month: "2026-11", users, data, tray: null, cards: { name: true, service: true, price: true, address: false, hideCancelled: false } };
  const h = text(sch.render(s, ctx()));
  assert.ok(!h.includes("<script>alert(1)"), "escaped");
  assert.match(h, /aria-selected="true"[^>]*>Day</, "Day lit");
  for (const v of ["Month", "List", "Day", "3 Day", "Week"]) assert.match(h, new RegExp(`role="tab"[^>]*>${v}<`), v);
  assert.match(h, /data-sday="2026-11-22"[\s\S]*data-sday="2026-11-28"/, "the week strip, Sunday first");
  assert.match(h, /class="wk-sday today sel"[^>]*data-sday="2026-11-24"/, "today chosen, in the coral circle");
  assert.ok(h.indexOf("Unassigned") < h.indexOf("Theo Tech") && h.indexOf("Theo Tech") < h.indexOf("Tess"), "Unassigned first, then each person");
  assert.match(h, /title="0 of 1 visit done">0\/1</, "Theo: done of all");
  assert.match(h, /title="2 of 2 visits done">2\/2</, "Tess: both done");
  assert.match(h, /\$510 \/ \$510/, "Tess's money: done of all");
  assert.match(h, /\$0 \/ \$295/, "Theo's money");
  assert.match(h, /href="#\/visits\/vs_00000000000000000001"/);
  assert.doesNotMatch(h, /vs_00000000000000000003/, "cancelled visits are left out of the columns");
  assert.match(h, /class="wk-blk done"[^>]*href="#\/visits\/vs_00000000000000000004"[\s\S]*?class="wk-unpaid"/, "done and not paid: the red $");
  const paid = h.slice(h.indexOf("vs_00000000000000000005"), h.indexOf("vs_00000000000000000005") + 1200);
  assert.doesNotMatch(paid.split("</a>")[0], /wk-unpaid/, "done and paid: no $");
  assert.match(h, /class="wk-nowline" style="top:240px"/, "the red line at noon (8 AM is the top, 60 px an hour)");
  assert.match(h, /title="Theo is off\."/, "the warning on its block");
  assert.match(h, /href="#\/tasks\/tk_00000000000000000001"/, "timed tasks on their person's column");
  assert.match(h, /href="#\/schedule\/move-day\?date=2026-11-24"/);
  assert.match(h, /href="#\/schedule\/time-off"/);
  assert.match(h, /data-by="tech" aria-pressed="true">Technician/);
  // no prices: no money in the heads or on the blocks
  const quiet = text(sch.render(s, ctx(["schedule:read", "schedule:write"])));
  assert.doesNotMatch(quiet, /\$295|\$510|wk-unpaid/);
  // one person (the Who button): their column only, their route, and a chip to show everyone
  const one = text(sch.render({ ...s, tech: U1 }, ctx()));
  assert.match(one, /href="#\/schedule\/route\/2026-11-24\/us_0000000000000000000t"/);
  assert.doesNotMatch(one, /vs_00000000000000000002|Unassigned/, "only their visits");
  assert.match(one, /data-tech="" aria-label="Showing Theo: show everyone"/);
  // the cards show what the gear says
  const bare = text(sch.render({ ...s, cards: { name: false, service: true, price: false, address: true, hideCancelled: false } }, ctx()));
  assert.doesNotMatch(bare.split("wk-cols")[1], /class="nm">Pat /, "no customer name on the cards");
  assert.match(bare, /class="nm">Exterior window cleaning</, "the service leads instead");
  assert.match(bare, /1 Example Ave, Delano/, "the address");
  assert.doesNotMatch(bare, /<b class="num">\$295<\/b>/, "no price on the cards");
  // Sales rep: the sales side's appointments by person (Unassigned first)
  const sales = text(sch.render({ ...s, by: "sales" }, ctx()));
  assert.match(sales, /data-by="sales" aria-pressed="true">Sales rep/);
  assert.match(sales, /href="#\/tasks\/tk_00000000000000000002"[^>]*>[\s\S]*Lee Sample[\s\S]*Call/);
  assert.match(sales, /href="#\/tasks\/tk_00000000000000000003"/);
  assert.doesNotMatch(sales, /href="#\/visits\//, "no visits in the sales columns");
  // 3 Day: three days, the heads open a day
  const three = text(sch.render({ ...s, view: "3day", data: { ...data, visits: [...data.visits, vrow({ id: "vs_00000000000000000009", d: "2026-11-26", cn: "Later Customer" })] } }, ctx()));
  assert.match(three, /data-goday="2026-11-24"[\s\S]*data-goday="2026-11-25"[\s\S]*data-goday="2026-11-26"/);
  assert.match(three, /class="wk-sday today sel"[^>]*data-sday="2026-11-24"[\s\S]*class="wk-sday span"[^>]*data-sday="2026-11-25"/, "the three days marked on the strip");
  assert.match(three, /vs_00000000000000000009/);
  const wk = text(sch.render({ ...s, view: "week", data: { ...data, visits: [vrow({ d: "2026-11-23" }), vrow({ d: "2026-11-24" }), vrow({ d: "2026-11-24", a: [U2] })] } }, ctx()));
  assert.match(wk, /data-goday="2026-11-24" data-gotech="us_0000000000000000000t"/);
  assert.match(wk, /Sun, Nov 22 – Sat, Nov 28/, "a week starts on Sunday, as the month");
  assert.ok(!wk.includes("<script>alert(1)"));
  const list = text(sch.render({ ...s, view: "list", data: { ...data, from: "2026-11-24" } }, ctx()));
  assert.match(list, /data-sday="2026-11-24"/, "the strip on List");
  assert.match(list, /class="row wk-visit[^"]*" href="#\/visits\/vs_00000000000000000001" data-vopen=/);
  const hidden = text(sch.render({ ...s, view: "list", cards: { ...s.cards, hideCancelled: true }, data: { ...data, from: "2026-11-24" } }, ctx()));
  assert.doesNotMatch(hidden, /vs_00000000000000000003/, "Hide cancelled jobs");
  assert.match(list, /vs_00000000000000000003/);
  const tray = text(sch.render({ ...s, view: "tray", tray: { month: "2026-11", jobs: [{ id: "jb_00000000000000000009", n: "S-000009", cn: `Lee ${XSS}`, t: "Lights takedown", k: "lights_takedown", tm: "2026-11" }], later: 3 } }, ctx()));
  assert.match(tray, /data-book="jb_00000000000000000009"/);
  assert.match(tray, /Lights takedown \(no charge\)/);
  assert.match(tray, /3 more jobs due after November 2026/);
  assert.ok(!tray.includes("<script>alert(1)"));
  assert.match(text(sch.render({ denied: true }, ctx())), /Your day is on Today[\s\S]*href="#\/today"/);
  assert.equal(sch.action(s, { ...ctx(), go: () => {} }).label, "Book", "the top button books");
  // the head: the month to pick, and the round buttons
  for (const b of ["data-mpick", "data-search", "data-mapday", "data-jump", "data-filter", "data-cards"]) assert.match(h, new RegExp(b), b);
  assert.match(h, /<span class="short">Nov<\/span>/);
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
  // Rotor's visit page: the pencil by Who moves or reassigns; the rest of the office's buttons are in the "..." sheet
  assert.match(h, /aria-label="Move or reassign"[^>]*data-move=""/);
  const rows = visit.more(s, ctx()).flat().filter(Boolean);
  const hooks = rows.map((r) => Object.keys(r.data || {})[0]).filter(Boolean);
  for (const b of ["move", "done", "noaccess", "cancel"]) assert.ok(hooks.includes(b), b);
  assert.ok(!hooks.includes("reopen"));
  assert.deepEqual(rows.filter((r) => r.href).map((r) => r.href), ["#/jobs/jb_1", "#/contacts/ct_1"], "Open job, Open customer");
  assert.equal(visit.title(s), "Visit · Tue, Nov 24");
  assert.match(h, /href="tel:\+17635550100"/);
  assert.match(h, /href="sms:\+17635550100"/);
  assert.match(h, /target="_blank"|data-external="top"/, "directions leave the frame");
  assert.match(h, /Texts and emails[\s\S]*1 sent, 1 skipped, 1 to come/, "the texts folded to one line (a sheet lists them)");
  assert.match(h, /href="#\/properties\/pr_1"/, "the pencil on the place edits its access");
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
  assert.equal(visit.more({ ...s, can: { office: false, assignee: true } }, ctx()).flat().filter(Boolean).length, 0, "no office rows in a tech's ...");

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
  const lh = text(jobs.render({ tile: "open", q: "", rows, tiles: [{ key: "open", label: "Open", count: 2, cents: 15000 }] }, ctx()));
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
    if (r.redirect) continue;   // an old link (Visits) opening the Schedule's List
    const mod = (await r.load()).default;
    assert.equal(typeof mod.render, "function", r.path);
  }
  assert.ok(m.routes.some((r) => r.path === "/schedule"), "the Schedule tab");
  assert.ok(m.routes.some((r) => r.path === "/visits/:id"));
  assert.equal(typeof (await m.contactTabs[0].load()).default.render, "function");
  assert.equal(typeof (await m.todayCards[0].load()).default.load, "function");
  assert.deepEqual(m.visitActions.map((a) => a.key), ["field"], "the office adds no visit action; M4b's field panel is the work module's one");
});

test("Job (Rotor's page): pills, the visit row with + Visit, Pricing with discounts and + Add discount, Create Invoice (or why not), the ... rows", async () => {
  const job = await load("office-job");
  const { billing } = await import("../../../crm-app/modules/work/office-job.js");
  const J = "jb_00000000000000000001";
  const s = {
    job: { id: J, number_label: "S-000001", title: `Exterior ${XSS}`, kind: "standard", status: "scheduled", billable: true, contact_id: "ct_1", invoice_ids: [],
      lines: [{ id: "ln_1", title: "Exterior window cleaning", qty_milli: 1000, unit_cents: 29500, total_cents: 29500 }, { id: "ln_2", title: "Screens", qty_milli: 12000, unit_cents: 500, total_cents: 6000 }],
      discounts: [{ id: "dc_1", name: "Neighbor deal", type: "fixed", value: 2500, scope: { type: "all" } }, { id: "dc_2", name: "Senior", type: "percentage", value: 1000, scope: { type: "all" } }],
      totals: { subtotal_cents: 35500, discount_cents: 6050, total_cents: 29450 }, crew_notes: "Dog in back", office_notes: "Pays by check", updated_at: "2026-11-17T15:00:00.000Z" },
    visits: [{ id: "vs_00000000000000000001", date: "2026-11-24", start: "08:00", end: "10:00", status: "scheduled", assignee_ids: [U1] }],
    contact: { id: "ct_1", display_name: `Pat ${XSS}`, phones: [{ e164: "+17635550100", primary: true }] },
    property: { id: "pr_1", address: { street1: "1 Example Ave", city: "Delano", state: "MN", zip: "55328" }, access: { gate_code: "1234" } },
    people: { [U1]: { id: U1, name: "Theo Tech" } },
    can: { write: true, add_visit: true, complete: true, cancel: true, reopen: false }, users, invoices: [], quote: null, etag: "\"1\"",
  };
  const h = text(job.render(s, ctx()));
  assert.ok(!h.includes("<script>alert(1)"), "escaped");
  assert.equal(job.title(s), "Job S-000001");
  assert.match(h, /class="pill blue">Booked<[\s\S]*class="pill amber">Not invoiced</);
  assert.match(h, /Visit · Tue, Nov 24[\s\S]*8:00–10:00 AM · Theo Tech/);
  assert.match(h, /href="#\/visits\/vs_00000000000000000001"/);
  assert.match(h, /data-book=""[^>]*>[\s\S]*?<span>Visit<\/span>/, "+ Visit books another");
  assert.match(h, /href="tel:\+17635550100"[\s\S]*href="sms:\+17635550100"/, "red call, message");
  assert.match(h, /gate 1234/);
  assert.match(h, /href="#\/properties\/pr_1"/);
  assert.match(h, /data-line="ln_2"[\s\S]*12 × \$5\.00/);
  assert.match(h, /data-add-line=""/);
  assert.match(h, /<span>Subtotal<\/span><span class="num">\$355\.00/);
  assert.match(h, /data-disc="dc_1"><span>Neighbor deal<\/span><span class="num">−\$25\.00/);
  assert.match(h, /data-disc="dc_2"><span>Senior \(10%\)<\/span><span class="num">−\$35\.50/, "each discount's share, as the invoice lists it");
  assert.match(h, /data-add-discount=""/);
  assert.match(h, /<span>Total<\/span><span class="num">\$294\.50/);
  assert.match(h, /<button type="button" class="rs-pb wide" data-make-invoice=""><span>Create Invoice/, "ready");
  assert.match(h, /data-notes="crew"[^>]*>Dog in back</);
  assert.match(h, /data-notes="office"[^>]*>Pays by check</);
  const rows = job.more(s, ctx()).flat().filter(Boolean);
  assert.deepEqual(rows.map((r) => r.label), ["Book a visit", "Mark done", "Edit the work", "Add a discount", "Create invoice", "Open customer", "Cancel job"]);
  assert.ok(rows.find((r) => r.label === "Cancel job").danger);
  // an invoice covers it: the pill, the row, Create Invoice gone (the reason when the + would make one)
  const inv = { id: "in_1", n: "SINV-0003", st: "paid", tot: 29450, bal: 0, j: J };
  const paid = text(job.render({ ...s, invoices: [inv] }, ctx()));
  assert.match(paid, /class="pill green">Paid</);
  assert.match(paid, /rs-amt green/);
  assert.match(paid, /Invoice SINV-0003 · Paid · \$294\.50/);
  assert.doesNotMatch(paid, /data-make-invoice/);
  assert.equal(billing({ ...s, invoices: [inv] }, ctx().can).why, "Invoice SINV-0003 covers this job.");
  assert.equal(billing({ ...s, invoices: [{ ...inv, st: "void" }] }, ctx().can).ready, true, "a void invoice doesn't cover it");
  // nothing to bill, cancelled, not billed: disabled with the reason
  const zero = { ...s, job: { ...s.job, lines: [], discounts: [], totals: { subtotal_cents: 0, discount_cents: 0, total_cents: 0 } } };
  assert.match(text(job.render(zero, ctx())), /data-make-invoice="" disabled[\s\S]*Add the work first/);
  assert.equal(billing({ ...s, job: { ...s.job, status: "cancelled" } }, ctx().can).why, "This job is cancelled.");
  assert.equal(billing({ ...s, job: { ...s.job, kind: "warranty" } }, ctx().can).why, "This kind of job isn't billed.");
  // without invoices:write: no Create Invoice anywhere
  const ro = ["schedule:read", "schedule:write", "invoices:read_all"];
  assert.doesNotMatch(text(job.render(s, ctx(ro))), /data-make-invoice/);
  assert.ok(!job.more(s, ctx(ro)).flat().filter(Boolean).some((r) => r.label === "Create invoice"));
  // a closed job: no + Item, no discounts to change
  const done = text(job.render({ ...s, job: { ...s.job, status: "completed", completed_at: "2026-11-24T18:00:00.000Z" }, can: { write: true, reopen: true } }, ctx()));
  assert.doesNotMatch(done, /data-add-line|data-add-discount|data-disc=/);
});

test("Jobs list (Rotor's): the tiles with counts and $, Row2 rows, Due when owed, ▷ for one's own visit today, ✓ when every visit is done", async () => {
  const list = await load("office-jobs");
  const me = "us_00000000000000000009";
  const rows = [{ id: "jb_00000000000000000001", n: "S-000001", cn: `Pat ${XSS}`, t: "Exterior", st: "scheduled", k: "standard", nv: "2026-11-24", tot: 35500, bill: true, a: [] },
    { id: "jb_00000000000000000002", n: "S-000002", cn: "Dee Due", t: "Gutters", st: "completed", k: "standard", done: "2026-11-16T18:00:00.000Z", tot: 22500, bill: true, due: 22500, a: [] },
    { id: "jb_00000000000000000003", n: "S-000003", cn: "Mo Mine", t: "Windows", st: "scheduled", k: "standard", nv: "2026-11-17", tot: 10000, bill: true, a: [me] },
    { id: "jb_00000000000000000004", n: "S-000004", cn: "Al Alldone", t: "Windows", st: "in_progress", k: "standard", nv: null, lv: "2026-11-16", tot: 10000, bill: true, a: [] }];
  const tiles = [{ key: "open", label: "Open", count: 3, cents: 55500 }, { key: "today", label: "Today", count: 1, cents: 10000 }, { key: "overdue", label: "Overdue", count: 2, cents: 0 }];
  const h = text(list.render({ tile: "open", q: "", rows, tiles, today: "2026-11-17" }, { ...ctx(), user: { id: me } }));
  assert.ok(!h.includes("<script>alert(1)"));
  assert.match(h, /data-tile="jobs" data-key="today"[^>]*><span class="rs-tile-l">Today<\/span><span class="rs-tile-v num">1<\/span><span class="rs-tile-m num">\$100\.00/);
  assert.match(h, /class="rs-tile red"[^>]*data-key="overdue"/, "Overdue is red when there are any");
  assert.match(h, /<span class="rs-lr-t">Pat [^<]*<\/span><span class="rs-lr-m num">\$355\.00<\/span>/);
  assert.match(h, /S-000001 · Tue, Nov 24/);
  assert.match(h, /<span class="rs-tag">Due \$225\.00<\/span>/, "what its invoice still owes");
  assert.match(h, /data-job-start="jb_00000000000000000003"/, "▷ for my own visit today");
  assert.match(h, /data-job-done="jb_00000000000000000004"/, "✓ once every visit is done");
  assert.doesNotMatch(h, /data-job-start="jb_00000000000000000001"/);
  assert.match(h, /data-job-more="jb_00000000000000000002"/, "a long press holds the rest");
});

test("the job page's extras (the Rotor guide's SX2, SX4, SX11-SX13): balance due, time on site, the status track, the visit's step pills, the plan banner, the quick actions", async () => {
  const job = await import("../../../crm-app/modules/work/office-job.js");
  const page = job.default;
  globalThis.window = { __crm: { session: { perms: { "schedule:read": true } } } };
  try {
    const me = "us_00000000000000000001";
    const j = { id: "jb_1", number_label: "S-000009", title: "Windows", kind: "standard", status: "scheduled", plan_id: "pl_1", plan_ordinal: { term: 1, n: 2 }, lines: [{ title: "Windows", total_cents: 29500, qty_milli: 1000, unit_cents: 29500, measure: { value: 24, unit: "panes" } }], totals: { total_cents: 29500, discount_cents: 0, subtotal_cents: 29500 }, updated_at: "2026-11-17T15:00:00.000Z" };
    const visits = [{ id: "vs_1", date: "2026-11-17", start: "08:00", end: "10:00", status: "en_route", assignee_ids: [me], minutes_worked: 0 }, { id: "vs_0", date: "2026-11-10", start: "08:00", end: "09:00", status: "completed", assignee_ids: [me], minutes_worked: 85 }];
    const plan = { id: "pl_1", name: `Quarterly ${XSS}`, status: "active", visits_per_year: 4, ordinals: [{ n: 3, target_month: "2027-02", status: "unscheduled" }], notes: "Gate code 4411" };
    const s = { job: j, visits, contact: { id: "ct_1", display_name: "Pat", phones: [], emails: [{ address: "pat@example.com" }] }, property: null, users, invoices: [], plan, can: { write: true, complete: true, cancel: true, add_visit: true } };
    const h = text(page.render(s, ctx()));
    assert.ok(!h.includes("<script>alert(1)"));
    assert.match(h, /Balance due<\/span><span class="rs-stat-v">\$295\.00/, "no invoice yet: the total is what's due");
    assert.match(h, /Time on site<\/span><span class="rs-stat-v">1 h 25 m/);
    assert.match(h, /class="rs-step on" aria-current="step"><span class="rs-step-d" aria-hidden="true">2<\/span><span class="rs-step-l">On my way/, "the track: on the way");
    assert.match(h, /data-v-start="vs_1"/, "Start for the visit's own people");
    assert.match(h, /data-v-move="vs_1"/, "Reschedule for the office");
    assert.match(h, /data-v-note="vs_1"/);
    assert.doesNotMatch(h, /data-v-move="vs_0"/, "a done visit has no step pills");
    assert.match(h, /Visit 2 of 4 · next Feb 2027 · Active/, "the plan banner");
    assert.match(h, /Plan notes[\s\S]*Gate code 4411/);
    assert.match(h, /24 panes · 1 × \$295\.00/, "the line's measure");
    assert.match(h, /href="mailto:pat@example\.com"/);
    // done and invoiced: the quick actions
    const done = { ...s, job: { ...j, status: "completed" }, visits: [{ ...visits[1] }], invoices: [{ id: "in_1", n: "INV-1", st: "open", tot: 29500, bal: 29500 }] };
    const labels = page.more(done, { ...ctx(), can: () => true }).flat().filter(Boolean).map((r) => r.label);
    for (const l of ["Text a pay link", "Ask for a review now", "Ask for a tip", "Book a callback"]) assert.ok(labels.includes(l), l);
    const dh = text(page.render(done, ctx()));
    assert.match(dh, /Balance due<\/span><span class="rs-stat-v red">\$295\.00/, "owed after it's done: red");
    assert.match(dh, /class="rs-step on" aria-current="step"><span class="rs-step-d" aria-hidden="true">4<\/span><span class="rs-step-l">Done/);
    assert.equal(job.trackAt({ ...done, invoices: [{ id: "in_1", st: "paid", tot: 29500, bal: 0 }] }), "paid");
  } finally { delete globalThis.window; }
});
