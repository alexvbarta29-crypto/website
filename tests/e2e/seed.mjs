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
// this month, and a day off. Quotes and invoices come with their modules
// (M3a, M5).

const store = await import("../../netlify/lib/crm-store.mjs");
const PW = await import("../../netlify/lib/crm/core/passwords.mjs");
const AUTH = await import("../../netlify/lib/crm/core/auth.mjs");
const SEED = await import("../../netlify/lib/crm/modules/sales/seed.mjs");
const T = await import("../../netlify/lib/crm/core/templates.mjs");
const E = await import("../../netlify/lib/crm/modules/sales/enroll.mjs");
const CALLS = await import("../../netlify/lib/crm/modules/sales/calls.mjs");
const clock = await import("../../netlify/lib/crm/core/clock.mjs");
const WORK = await import("../../netlify/lib/crm/modules/work/office.mjs");

export const PASSWORD = "a long synthetic passphrase";
const TOWNS = ["Delano", "Maple Plain", "Mound", "Waconia", "Orono", "Wayzata", "Medina", "Rogers", "Watertown", "Buffalo"];
const FIRST = ["Pat", "Sam", "Chris", "Dana", "Lee", "Robin", "Alex", "Jordan", "Casey", "Morgan", "Taylor", "Jamie", "Avery", "Quinn", "Reese", "Skyler", "Emerson", "Hayden", "Parker", "Rowan"];
const LAST = ["Sample", "Example", "Tester", "Demo", "Placeholder", "Fakename", "Notreal", "Madeup", "Abbott", "Barker", "Carver", "Dunmore", "Ellison", "Fairway", "Garland", "Holloway", "Iverson", "Jarvis", "Kendrick", "Larkin"];
const SOURCES = ["Website quote form", "Meta Ads", "Referral", "Returning Customer", "Google", "Yard Sign", "Door Hanger"];
const AUTO = { by: "system:e2e", origin: "worker", actor_kind: "automation", requestId: "e2e-seed", mode: { system_of_record: "rotor", paused: false } };

let seeded = null;
export async function seed({ contacts = 200 } = {}) {
  if (seeded) return seeded;
  globalThis.__crmPbkdf2Iterations = 1000;
  const users = (await store.readIndex("users", "")).rows;
  const out = { password: PASSWORD, users: {}, contacts: {}, enrollments: {} };
  const person = async (key, login, name, role, tech) => {
    const had = users.find((u) => u.login === login || (key === "owner" && u.role === "owner"));
    if (had) { out.users[key] = { id: had.id, login: had.login, name: had.name }; return; }
    const r = await store.createRecord("user", { login, name, role, status: "active", is_technician: tech, password: await PW.hashPassword(PASSWORD), session_epoch: 0, grants: [], denies: [] }, { by: "system", origin: "api", actor_kind: "user", requestId: "e2e-seed" });
    out.users[key] = { id: r.data.id, login, name };
  };
  await person("owner", "olive", "Olive Owner", "owner", true);
  await person("admin", "ada", "Ada Admin", "admin", false);
  await person("tech", "theo", "Theo Tech", "tech", true);
  await person("tech2", "tess", "Tess Tech", "tech", true);
  await store.settledWrite(AUTH.BOOTSTRAP_KEY, { state: "done", user_id: out.users.owner.id, at: clock.nowIso() }, { onlyIfNew: true }).catch(() => {});
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

  // the first slice's Customers list (/crm/legacy, /legacy/customers)
  await store.writeCustomerIndex(store.buildCustomerIndex({ exported_at: "2026-11-08", members: [], customers: Array.from({ length: 24 }, (_, i) => ({
    id: `00000000-0000-4000-8000-${String(i + 1).padStart(12, "0")}`, first_name: FIRST[i % FIRST.length], last_name: LAST[(i * 3) % LAST.length], company_name: "",
    email: `legacy${i}@example.com`, phone: "+1763555" + String(1500 + i).padStart(4, "0"), status: i % 5 ? "active" : "inactive", source: SOURCES[i % SOURCES.length], assigned_to: [],
    address: { street1: `${500 + i} Example Ave`, street2: null, city: TOWNS[i % TOWNS.length], state: "MN", zip: "55328", country: "US" }, tags: [], notes: "", created_at: "2025-03-14T15:00:00+00:00",
  })) }));
  seeded = out;
  return out;
}
