// Synthetic data for the phone checks (design §12.4, §12.5): made-up names,
// 555 numbers, example.com emails, "Example Ave" addresses in real towns.
// Called by server.mjs's seed() inside a store scope:
//
//   one user per role (an owner, an admin, two techs), the first owner kept
//   if setup already made one; 200 contacts (leads and customers, some with
//   a property); the sales seeds (cadences and templates), follow-ups at
//   different steps, a talked-to lead with a callback task, tasks for the
//   owner and a tech, an incident; the first slice's customer list.
//
// Scheduling (M4a): the crew's checklists, eight work customers in towns
// around Delano (a property with a map location each), jobs with visits
// today and tomorrow for both techs, a job to book and a lights takedown due
// this month, and a day off. Invoices come with Money (M5).
//   the quotes seeds (price book, discount catalog), a draft quote for the
//   fresh lead and one sent (dry-run, the Outbox) to the talked-to lead with
//   a one-time and a quarterly option.
// Plans (M3b): the agreement texts (four approved, the one-time lights text
//   left for the owner), an active quarterly plan signed in person with its
//   visits' jobs, two waiting plans with their agreements sent (a portal
//   link to the first), a lights plan with this season's install and
//   takedown.
//
// seed({ home: true }) also makes today look like a real business day for
// Home's screenshots (home.spec): one visit done, one under way, three more
// this afternoon (one with two people), a pair of likely duplicates and a
// phone's offline work waiting for the owner's OK. seed({ teamOnly: true })
// makes only the team (Home before any CRM data: the empty state), and a
// later seed() keeps those people.
//

const store = await import("../../netlify/lib/crm-store.mjs");
const PW = await import("../../netlify/lib/crm/core/passwords.mjs");
const AUTH = await import("../../netlify/lib/crm/core/auth.mjs");
const SEED = await import("../../netlify/lib/crm/modules/sales/seed.mjs");
const T = await import("../../netlify/lib/crm/core/templates.mjs");
const E = await import("../../netlify/lib/crm/modules/sales/enroll.mjs");
const CALLS = await import("../../netlify/lib/crm/modules/sales/calls.mjs");
const clock = await import("../../netlify/lib/crm/core/clock.mjs");
const WORK = await import("../../netlify/lib/crm/modules/work/office.mjs");
const QSEED = await import("../../netlify/lib/crm/modules/quotes/seed.mjs");
const Q = await import("../../netlify/lib/crm/modules/quotes/quotes.mjs");
const AG = await import("../../netlify/lib/crm/modules/plans/agreements.mjs");
const PL = await import("../../netlify/lib/crm/modules/plans/plans.mjs");
const CAT = await import("../../netlify/lib/crm/modules/plans/catalog.mjs");
const PORTAL = await import("../../netlify/lib/crm/portal/core.mjs");

export const PASSWORD = "a long synthetic passphrase";
const TOWNS = ["Delano", "Maple Plain", "Mound", "Waconia", "Orono", "Wayzata", "Medina", "Rogers", "Watertown", "Buffalo"];
const FIRST = ["Pat", "Sam", "Chris", "Dana", "Lee", "Robin", "Alex", "Jordan", "Casey", "Morgan", "Taylor", "Jamie", "Avery", "Quinn", "Reese", "Skyler", "Emerson", "Hayden", "Parker", "Rowan"];
const LAST = ["Sample", "Example", "Tester", "Demo", "Placeholder", "Fakename", "Notreal", "Madeup", "Abbott", "Barker", "Carver", "Dunmore", "Ellison", "Fairway", "Garland", "Holloway", "Iverson", "Jarvis", "Kendrick", "Larkin"];
const SOURCES = ["Website quote form", "Meta Ads", "Referral", "Returning Customer", "Google", "Yard Sign", "Door Hanger"];
const AUTO = { by: "system:e2e", origin: "worker", actor_kind: "automation", requestId: "e2e-seed", mode: { system_of_record: "rotor", paused: false } };

let seeded = null;
export async function seed(opts = {}) {
  const { contacts = 200 } = opts;
  if (seeded) return seeded;
  globalThis.__crmPbkdf2Iterations = 1000;
  const users = (await store.readIndex("users", "")).rows;
  const out = { password: PASSWORD, users: {}, contacts: {}, enrollments: {} };
  const person = async (key, login, name, role, tech, color) => {
    const had = users.find((u) => u.login === login || (key === "owner" && u.role === "owner"));
    if (had) { out.users[key] = { id: had.id, login: had.login, name: had.name }; return; }
    const r = await store.createRecord("user", { login, name, role, status: "active", is_technician: tech, ...(color ? { color } : {}), password: await PW.hashPassword(PASSWORD), session_epoch: 0, grants: [], denies: [] }, { by: "system", origin: "api", actor_kind: "user", requestId: "e2e-seed" });
    out.users[key] = { id: r.data.id, login, name };
  };
  // the two techs: different initials and colors, as the schedule shows people
  await person("owner", "olive", "Olive Owner", "owner", true, "#2a78d6");
  await person("admin", "ada", "Ada Admin", "admin", false, "#7c4dff");
  await person("tech", "theo", "Theo Tech", "tech", true, "#13a165");
  await person("tech2", "tess", "Tess Rowe", "tech", true, "#b7791f");
  await store.settledWrite(AUTH.BOOTSTRAP_KEY, { state: "done", user_id: out.users.owner.id, at: clock.nowIso() }, { onlyIfNew: true }).catch(() => {});
  if (opts.teamOnly) return out;
  const O = { by: out.users.owner.id, origin: "api", actor_kind: "user", requestId: "e2e-seed" };
  const ctxO = { write: (x = {}) => ({ ...O, ...x }), user: { id: out.users.owner.id, role: "owner", name: "Olive Owner" } };

  await SEED.seedCadences({ write: () => AUTO });
  await T.seedTemplates(AUTO);
  T.clearTemplateSeedCache();

  // 200 people: leads and customers, a property for every third
  for (let i = 0; i < contacts; i++) {
    const first = FIRST[i % FIRST.length];
    const last = LAST[(i * 7 + Math.floor(i / FIRST.length)) % LAST.length];
    const town = TOWNS[i % TOWNS.length];
    const c = (await store.createRecord("contact", {
      first_name: first, last_name: last, phones: [{ e164: "+1763555" + String(1000 + i).padStart(4, "0"), sms: true }],
      emails: [{ address: `${first.toLowerCase()}.${last.toLowerCase()}${i}@example.com` }], lifecycle: i % 3 ? "customer" : "lead",
      source: { source: SOURCES[i % SOURCES.length] }, tags: i % 5 ? [] : ["Christmas Lights"], notes: i % 4 ? "" : "Synthetic note: two-story, dog in the yard.",
      consent: { sms_service: { state: "granted", source: "website_form" } },
      billing_address: { street1: `${100 + i} Example Ave`, city: town, state: "MN", zip: "55328" },
    }, O)).data;
    if (i % 3 === 0) await store.createRecord("property", { contact_id: c.id, label: "Home", address: { street1: `${100 + i} Example Ave`, city: town, state: "MN", zip: "55328" }, access: { notes: "Side gate (synthetic)." } }, O);
    if (i === 0) out.contacts.first = c.id;
    if (i === 1) out.contacts.customer = c.id;
  }

  // follow-ups: a fresh lead (step 1 due now), one with a call logged, one talked to (paused, a task)
  const lead = async (first, last, n) => (await store.createRecord("contact", {
    first_name: first, last_name: last, phones: [{ e164: "+1763555" + String(1900 + n).padStart(4, "0"), sms: true }], emails: [{ address: `${first.toLowerCase()}.${last.toLowerCase()}@example.com` }],
    lifecycle: "lead", source: { source: "Website quote form" }, consent: { sms_service: { state: "granted", source: "website_form" } },
    billing_address: { street1: `${300 + n} Example Ave`, city: "Delano", state: "MN", zip: "55328" },
  }, O)).data;
  const a = await lead("Avery", "Newlead", 1);
  out.contacts.lead = a.id;
  out.enrollments.lead = await E.enroll(a.id, "new_lead", {}, O);
  const b = await lead("Blair", "Calledonce", 2);
  out.contacts.called = b.id;
  out.enrollments.called = await E.enroll(b.id, "new_lead", {}, O);
  await CALLS.logCall({ contact_id: b.id, enrollment_id: out.enrollments.called, outcome: "no_answer" }, ctxO);
  const f = await lead("Quinn", "Talkedto", 3);
  out.contacts.talked = f.id;
  out.enrollments.talked = await E.enroll(f.id, "new_lead", {}, O);
  await CALLS.logCall({ contact_id: f.id, enrollment_id: out.enrollments.talked, outcome: "spoke", note: "Wants gutters too. Call back Thursday." }, ctxO);

  const task = (x, by = O) => store.createRecord("task", { status: "open", priority: "medium", kind: "todo", ...x }, by).then((r) => r.data);
  await task({ title: "Call back about the gutter add-on", kind: "call", contact_id: f.id, contact_name: "Quinn Talkedto", assignee_ids: [out.users.owner.id], due_at: clock.nowIso() });
  out.tasks = { tech: (await task({ title: "Pick up the ladder hooks", assignee_ids: [out.users.tech.id], due_at: clock.nowIso() })).id };
  await task({ title: "Cracked storm window at arrival", kind: "incident", priority: "high", reported_on: clock.localDate(clock.now()), assignee_ids: [out.users.owner.id], notes: "Synthetic." }, { by: out.users.tech.id, origin: "api", actor_kind: "user", requestId: "e2e-seed" });

  // scheduling (M4a)
  await WORK.seedChecklists({ write: () => AUTO });
  const day = clock.localDate(clock.now());
  const tomorrow = clock.addLocalDays(day, 1);
  const GEO = [[45.0419, -93.7886], [44.9897, -93.7258], [44.9633, -93.6630], [44.8494, -93.7869], [44.9760, -93.5900], [44.9705, -93.5133], [45.0216, -93.5835], [45.1919, -93.5530]];
  out.jobs = {}; out.visits = {};
  for (let k = 0; k < GEO.length; k++) {
    const town = TOWNS[k];
    const c = (await store.createRecord("contact", {
      first_name: FIRST[(k + 5) % FIRST.length], last_name: "Workday", phones: [{ e164: "+1763555" + String(1800 + k).padStart(4, "0"), sms: true }],
      emails: [{ address: `workday${k}@example.com` }], lifecycle: "customer", source: { source: SOURCES[k % SOURCES.length] }, consent: { sms_service: { state: "granted", source: "website_form" } },
      billing_address: { street1: `${700 + k} Example Ave`, city: town, state: "MN", zip: "55328" },
    }, O)).data;
    const p = (await store.createRecord("property", { contact_id: c.id, label: "Home", address: { street1: `${700 + k} Example Ave`, city: town, state: "MN", zip: "55328", country: "US" }, access: { gate_code: k % 3 ? undefined : "1234", notes: "Synthetic: side gate." }, geo: { lat: GEO[k][0], lng: GEO[k][1], source: "manual", at: clock.nowIso() } }, O)).data;
    await store.updateRecord("contact", c.id, (x) => ({ ...x, primary_property_id: p.id }), O);
    const lights = k === 7;
    const [jobId] = await WORK.createJobs([{
      contact_id: c.id, kind: lights ? "lights_takedown" : "standard", crew_notes: k % 2 ? "" : "Synthetic: dog in the back yard.",
      lines: lights ? [{ title: "Christmas lights takedown", unit_cents: 0, service_type: "Christmas Lights" }] : [{ title: "Exterior window cleaning", unit_cents: 29500 + k * 1000, service_type: "Residential Window Cleaning" }, { title: "Screens", unit_cents: 500, qty_milli: 12000 }],
      ...(k >= 6 ? { target_month: day.slice(0, 7) } : {}),
    }], `e2e-work-${k}`, "manual", O);
    out.jobs[k] = jobId;
    if (k < 6) {
      const who = k % 2 ? out.users.tech2.id : out.users.tech.id;
      const hh = 8 + 2 * Math.floor(k / 2);
      const v = await WORK.createVisit({ job_id: jobId, date: k < 4 ? day : tomorrow, start: `${String(hh).padStart(2, "0")}:00`, end: `${String(hh + 2).padStart(2, "0")}:00`, window: { type: "window", minutes: 120 }, assignee_ids: [who] }, O);
      out.visits[k] = v.visit.id;
    }
  }
  out.visits.tech = out.visits[0];                     // Theo's first visit today
  out.jobs.tech = out.jobs[0];
  await store.createRecord("time_off", { user_id: out.users.tech2.id, start_at: `${clock.addLocalDays(day, 3)}T06:00:00.000Z`, end_at: `${clock.addLocalDays(day, 4)}T06:00:00.000Z`, all_day: true, reason: "Synthetic day off" }, O);
  // quotes (M3a): a draft for the fresh lead, one sent to the talked-to lead
  await QSEED.seedPriceBook({ write: () => AUTO });
  const ext = (x = {}) => ({ title: "Exterior Window Cleaning", qty_milli: 1000, unit_cents: 29500, category: "windows_ext", service_type: "Residential Window Cleaning", ...x });
  const options = () => [
    { name: "Windows inside and out", kind: "one_time", recommended: false, lines: [ext(), { title: "Interior Window Cleaning", qty_milli: 1000, unit_cents: 16000, category: "windows_int" }, { title: "Track Detailing", qty_milli: 8000, unit_cents: 800, category: "tracks", unit: "track", optional: true }], discounts: [{ key: "first_time", name: "First Time Customer", type: "fixed", value: 5000, scope: { type: "initial" } }] },
    { name: "Quarterly plan", kind: "plan", recommended: true, plan: { catalog_key: "quarterly", frequency: { interval: "month", count: 3 }, visits_per_year: 4, term_months: 12, billing: "barta_standard" }, lines: [ext({ scope: { type: "specific", visits: [1, 3, 4] } }), { title: "Interior Window Cleaning", qty_milli: 1000, unit_cents: 16000, category: "windows_int", scope: { type: "specific", visits: [2] } }], discounts: [{ key: "plan_quarterly", name: "Quarterly plan discount", type: "fixed", value: 10000, scope: { type: "all" }, stack_group: "plan" }] },
  ];
  const qctx = { user: { id: out.users.owner.id, role: "owner" }, can: () => true, write: () => O };
  out.quotes = { draft: (await Q.createQuote({ contact_id: a.id, options: options(), client_notes: "Thanks for having us out!" }, qctx)).data.id };
  out.quotes.sent = (await Q.createQuote({ contact_id: f.id, options: options() }, qctx)).data.id;
  await Q.sendQuote(out.quotes.sent, { channels: ["sms"] }, qctx);

  // plans (M3b)
  await AG.seedAgreementTemplates(AUTO);
  for (const k of ["biannual", "quarterly", "monthly", "lights"]) await AG.approveTemplate(AG.seedTemplateId(k), ctxO);
  out.templates = { quarterly: AG.seedTemplateId("quarterly"), one_time: AG.seedTemplateId("one_time") };
  const planCustomer = async (first, n, town) => {
    const c = (await store.createRecord("contact", {
      first_name: first, last_name: "Planfolk", phones: [{ e164: "+1763555" + String(1700 + n).padStart(4, "0"), sms: true }], emails: [{ address: `${first.toLowerCase()}.planfolk@example.com` }],
      lifecycle: "customer", source: { source: "Returning Customer" }, consent: { sms_service: { state: "granted", source: "website_form" } },
      billing_address: { street1: `${900 + n} Example Ave`, city: town, state: "MN", zip: "55328" },
    }, O)).data;
    const pr = (await store.createRecord("property", { contact_id: c.id, label: "Home", address: { street1: `${900 + n} Example Ave`, city: town, state: "MN", zip: "55328", country: "US" }, access: {} }, O)).data;
    await store.updateRecord("contact", c.id, (x) => ({ ...x, primary_property_id: pr.id }), O);
    return { id: c.id, name: `${first} Planfolk`, property_id: pr.id, town };
  };
  const QLINES = [{ id: "ln_e", title: "Exterior Window Cleaning", qty_milli: 1000, unit_cents: 29500, total_cents: 29500, service_type: "Residential Window Cleaning", scope: { type: "specific", visits: [1, 3, 4] } }, { id: "ln_i", title: "Interior Window Cleaning", qty_milli: 1000, unit_cents: 16000, total_cents: 16000, service_type: "Residential Window Cleaning", scope: { type: "specific", visits: [2] } }];
  const QDISC = [{ id: "dc_p", name: "Quarterly plan discount", type: "fixed", value: 10000, scope: { type: "all" } }];
  const makePlan = async (c, { status, catalog_key = "quarterly", lines = QLINES, discounts = QDISC }) => {
    const p = PL.buildPlan({ contact_id: c.id, contact_name: c.name, property_id: c.property_id, town: c.town, catalog_key, lines, discounts, origin: "staff" }, CAT.catalogWith({}), { start_on: day });
    delete p.id;
    const r = await store.createRecord("plan", { ...p, status, pending_reasons: status === "pending" ? ["signature"] : [], agreement_status: "none" }, O);
    await PL.ensureJobs(r.data.id, O);
    return r.data.id;
  };
  out.plans = {};
  const harper = await planCustomer("Harper", 0, "Mound");
  out.contacts.plan = harper.id;
  out.plans.active = await makePlan(harper, { status: "active" });
  const agA = (await AG.agreementForPlan(out.plans.active, {}, ctxO)).data;
  const signedA = await AG.signAgreement(agA.id, { body_sha256: agA.body_sha256, name_typed: "Harper Planfolk", agree: true }, { method: "in_person", staff_user_id: out.users.owner.id }, ctxO);
  await AG.afterSigned(signedA.agreement, ctxO);
  const waiting = async (first, n, town) => {
    const c = await planCustomer(first, n, town);
    const id = await makePlan(c, { status: "pending" });
    const a = (await AG.agreementForPlan(id, {}, ctxO)).data;
    await AG.sendAgreement(a.id, { channels: ["sms"] }, ctxO);
    return { plan: id, agreement: a.id, contact: c.id };
  };
  const wa = await waiting("Finley", 1, "Waconia");
  const wb = await waiting("Emerson", 2, "Orono");
  out.plans.pending = wa.plan;
  out.plans.present = wb.plan;
  out.agreements = { pending: wa.agreement, present: wb.agreement };
  out.portal = { agreement: `/p/${(await PORTAL.createPortalLink({ contact_id: wa.contact, scope: { kind: "agreement", id: wa.agreement }, created_by: out.users.owner.id })).code}` };
  out.plans.lights = await makePlan(await planCustomer("Rowan", 3, "Wayzata"), { status: "active", catalog_key: "lights_annual", lines: [{ id: "ln_l", title: "Christmas Light Installation", qty_milli: 150000, unit_cents: 800, total_cents: 120000, unit: "ft", service_type: "Christmas Lights", description: "Roofline 150 ft. Colors: warm white", scope: { type: "all" } }], discounts: [] });
  const lp = await store.getRecord("plan", out.plans.lights);
  out.seasons = { year: (await store.getRecord("season_install", lp.data.season_install_ids[0])).data.season, id: lp.data.season_install_ids[0] };

  // the first slice's Customers list (/crm/legacy, /legacy/customers)
  await store.writeCustomerIndex(store.buildCustomerIndex({ exported_at: "2026-11-08", members: [], customers: Array.from({ length: 24 }, (_, i) => ({
    id: `00000000-0000-4000-8000-${String(i + 1).padStart(12, "0")}`, first_name: FIRST[i % FIRST.length], last_name: LAST[(i * 3) % LAST.length], company_name: "",
    email: `legacy${i}@example.com`, phone: "+1763555" + String(1500 + i).padStart(4, "0"), status: i % 5 ? "active" : "inactive", source: SOURCES[i % SOURCES.length], assigned_to: [],
    address: { street1: `${500 + i} Example Ave`, street2: null, city: TOWNS[i % TOWNS.length], state: "MN", zip: "55328", country: "US" }, tags: [], notes: "", created_at: "2025-03-14T15:00:00+00:00",
  })) }));
  if (opts.home) await homeDay(out, O, day);
  seeded = out;
  return out;
}

// Today as a real day (Home's screenshots): Theo's first visit done, Tess on
// site at her first, three more this afternoon (Olive and Theo together at
// one), a likely duplicate, offline work waiting for the owner's OK.
async function homeDay(out, O, day) {
  const MATCH = await import("../../netlify/lib/crm/modules/contacts/match.mjs");
  const PA = await import("../../netlify/lib/crm/core/pending.mjs");
  await WORK.changeVisit(out.visits[0], "office_complete", { ctx: O });
  await WORK.changeVisit(out.visits[1], "start", { ctx: O });
  const slots = [["Wayzata", "12:30", [out.users.owner.id, out.users.tech.id], 41500], ["Orono", "13:00", [out.users.tech2.id], 33500], ["Medina", "15:00", [out.users.tech.id], 26500]];
  for (const [k, [town, start, who, cents]] of slots.entries()) {
    const c = (await store.createRecord("contact", {
      first_name: ["Morgan", "Reese", "Skyler"][k], last_name: "Afternoon", phones: [{ e164: "+1763555" + String(1950 + k).padStart(4, "0"), sms: true }],
      emails: [{ address: `afternoon${k}@example.com` }], lifecycle: "customer", source: { source: "Referral" }, consent: { sms_service: { state: "granted", source: "website_form" } },
      billing_address: { street1: `${960 + k} Example Ave`, city: town, state: "MN", zip: "55391" },
    }, O)).data;
    const p = (await store.createRecord("property", { contact_id: c.id, label: "Home", address: { street1: `${960 + k} Example Ave`, city: town, state: "MN", zip: "55391", country: "US" }, access: {} }, O)).data;
    await store.updateRecord("contact", c.id, (x) => ({ ...x, primary_property_id: p.id }), O);
    const [jobId] = await WORK.createJobs([{ contact_id: c.id, kind: "standard", lines: [{ title: k === 2 ? "Gutter cleaning" : "Exterior window cleaning", unit_cents: cents, service_type: k === 2 ? "Exterior Cleaning" : "Residential Window Cleaning" }] }], `e2e-home-${k}`, "manual", O);
    const [hh, mm] = start.split(":").map(Number);
    await WORK.createVisit({ job_id: jobId, date: day, start, end: `${String(hh + 2).padStart(2, "0")}:${String(mm).padStart(2, "0")}`, window: { type: "window", minutes: 120 }, assignee_ids: who }, O);
  }
  const twins = [];
  for (const n of [0, 1]) {
    twins.push((await store.createRecord("contact", {
      first_name: "Jamie", last_name: "Twofold", phones: [{ e164: "+17635551960", sms: true }], emails: [{ address: n ? "jamie.twofold@example.com" : "jtwofold@example.com" }],
      lifecycle: "lead", source: { source: n ? "Meta Ads" : "Website quote form" }, consent: { sms_service: { state: "granted", source: "website_form" } },
      billing_address: { street1: "975 Example Ave", city: "Rogers", state: "MN", zip: "55374" },
    }, O)).data);
  }
  await MATCH.createCandidate(twins[0].id, twins[1].id, { reason: "phone", confidence: "high" }, O);
  await PA.createPendingAction({ kind: "outbox_review", title: "Theo's offline notes from last week", requested_by: out.users.tech.id, items: [] }, O);
}
