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
// Visits, quotes and invoices come with their modules (M3a, M4a, M5); until
// then a tech's day is empty and they see no contacts.

const store = await import("../../netlify/lib/crm-store.mjs");
const PW = await import("../../netlify/lib/crm/core/passwords.mjs");
const AUTH = await import("../../netlify/lib/crm/core/auth.mjs");
const SEED = await import("../../netlify/lib/crm/modules/sales/seed.mjs");
const T = await import("../../netlify/lib/crm/core/templates.mjs");
const E = await import("../../netlify/lib/crm/modules/sales/enroll.mjs");
const CALLS = await import("../../netlify/lib/crm/modules/sales/calls.mjs");
const clock = await import("../../netlify/lib/crm/core/clock.mjs");

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

  // the first slice's Customers list (/crm/legacy, /legacy/customers)
  await store.writeCustomerIndex(store.buildCustomerIndex({ exported_at: "2026-11-08", members: [], customers: Array.from({ length: 24 }, (_, i) => ({
    id: `00000000-0000-4000-8000-${String(i + 1).padStart(12, "0")}`, first_name: FIRST[i % FIRST.length], last_name: LAST[(i * 3) % LAST.length], company_name: "",
    email: `legacy${i}@example.com`, phone: "+1763555" + String(1500 + i).padStart(4, "0"), status: i % 5 ? "active" : "inactive", source: SOURCES[i % SOURCES.length], assigned_to: [],
    address: { street1: `${500 + i} Example Ave`, street2: null, city: TOWNS[i % TOWNS.length], state: "MN", zip: "55328", country: "US" }, tags: [], notes: "", created_at: "2025-03-14T15:00:00+00:00",
  })) }));
  seeded = out;
  return out;
}
