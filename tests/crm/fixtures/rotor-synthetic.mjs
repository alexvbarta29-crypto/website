#!/usr/bin/env node
// A synthetic Rotor export (design §12.5, §10.1 step 1): one JSONL file per
// Rotor entity, shaped like the real export (field names from the Rotor
// data model notes: people, money, ops, comms), with every edge case of
// §10.2 that the import must handle. Nothing in here is real: names come
// from a fixed list of obviously made-up ones, phones are 555 numbers,
// emails are @example.com, streets are "Example Ave" in public service-area
// towns, ids are UUIDs from a seeded generator.
//
//   import { generate, writeExport } from "./rotor-synthetic.mjs";
//   const ex = generate({ scale: 0.05, seed: 1 });   // { [entity]: rows[] }, also ex.media: [{ index row, bytes }]
//   writeExport(dir, { scale: 1 });                  // writes dir/<entity>.jsonl (+ dir/media/ with media: true)
//
//   node tests/crm/fixtures/rotor-synthetic.mjs <out-dir> [--scale 1] [--seed 7] [--media] [--no-site-stores]
//
// At --scale 1 the counts match the 2026-11-09/10 export (gaps.md §4):
// 780 customers, 485 leads, 183 quote contact rows, 980 opportunities,
// 401 quotes, 687 plans, 792 jobs, 623 visits, 712 invoices, 688 payments,
// 10,927 messages, ...; the default 0.05 is about 5% of that. Fixed-size
// tables (5 members, 4 pipelines, 24 stages, 5 agreement templates, 45
// message templates, 8 pin types) stay whole at every scale.

import { mkdirSync, writeFileSync, existsSync, readdirSync } from "node:fs";
import { createHash } from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";

// ------------------------------------------------------------ seeded randomness

function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function rng(seed) {
  const r = mulberry32(seed);
  const api = {
    next: r,
    int: (lo, hi) => lo + Math.floor(r() * (hi - lo + 1)),
    pick: (list) => list[Math.floor(r() * list.length)],
    chance: (p) => r() < p,
    hex: (n) => { let s = ""; for (let i = 0; i < n; i++) s += "0123456789abcdef"[Math.floor(r() * 16)]; return s; },
    alnum: (n) => { const A = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789"; let s = ""; for (let i = 0; i < n; i++) s += A[Math.floor(r() * A.length)]; return s; },
  };
  api.uuid = () => `${api.hex(8)}-${api.hex(4)}-4${api.hex(3)}-${"89ab"[api.int(0, 3)]}${api.hex(3)}-${api.hex(12)}`;
  return api;
}

// ------------------------------------------------------------ vocabulary (made up)

const FIRST = ["Pat", "Sam", "Jordan", "Casey", "Riley", "Morgan", "Taylor", "Quinn", "Reese", "Drew", "Avery", "Rowan", "Sky", "Jamie", "Kendall", "Parker", "Hayden", "Emerson", "Finley", "Harper"];
const LAST = ["Example", "Sample", "Testcase", "Placeholder", "Fixture", "Demo", "Mockley", "Dummyson", "Specimen", "Exampleton"];
// Names Rotor handed back double-encoded (UTF-8 read as Latin-1): the import repairs them.
const MOJIBAKE = [["JosÃ©", "Example"], ["RenÃ©e", "Sample"], ["ZoÃ«", "Testcase"], ["FranÃ§ois", "Demo"]];
const SPAM = [["asdf", "asdf"], ["Test", "Test"], ["www.spam.example", ""], ["qwer", "qwer"]];
const TOWNS = [["Delano", "55328"], ["Mound", "55364"], ["Maple Plain", "55359"], ["Rockford", "55373"], ["Watertown", "55388"], ["Montrose", "55363"],
  ["Waverly", "55390"], ["Buffalo", "55313"], ["Loretto", "55357"], ["Long Lake", "55356"], ["St. Bonifacius", "55375"], ["Hanover", "55341"], ["St. Michael", "55376"]];
const CUSTOMER_SOURCES = ["Website quote form", "Website", "Meta Ads", "Referral", "Returning Customer", "Facebook", "Google", "Family / Friends", "Door Hanger", "Yard Sign",
  "Markate Import", "Referral program", "Holiday Lights Giveaway", "", null, "Test", "Vendor", "Something New"];
const LEAD_SOURCES = ["Meta Ads", "Meta Ads", "Meta Ads", "Website quote form", "Website quote form", "Holiday Lights Giveaway", "Referral", "Facebook", null];
const CUSTOMER_TAGS = ["Website", "Christmas Lights", "Facebook", "Referral Program", "Giveaway 2026", "Giveaway - Coupon Opt-In", "Import: 2026-08-21", "VIP"];
const LEAD_TAGS = ["Sample Form", "Service & Offer", "Lights Form", "Giveaway 2026", "Giveaway - New Lead", "Giveaway - Out of Area", "Giveaway Offers OK", "Website"];
const SERVICE_TYPES = ["Residential Window Cleaning", "Exterior Cleaning", "Christmas Lights"];
const LEAD_SERVICES = ["Exterior Window Cleaning", "Interior Window Cleaning", "Gutter Cleaning", "Christmas Light Installation", "House Washing", "Screen Cleaning"];
const COUNTIES = ["wright_county", "hennepin_county", "carver_county", "meeker_county"];
const LINE_TITLES = [["Exterior Window Cleaning ", "Residential Window Cleaning"], ["Interior Window Cleaning", "Residential Window Cleaning"], ["Screen Cleaning", "Residential Window Cleaning"],
  ["Track Cleaning", "Residential Window Cleaning"], ["Gutter Cleaning", "Exterior Cleaning"], ["Christmas Light Installation - Per Foot", "Christmas Lights"],
  ["FREE Takedown + Storage", "Christmas Lights"], ["Warranty", null]];
const DISCOUNT_NAMES = ["Bi-Annual Discount", "Quarterly Discount", "3-Year Contract", "First Time Customer", "Package Discount", "Google Review & Local Post"];

const SCALE_COUNTS = Object.freeze({
  customers: 780, leads: 485, quote_contacts: 183, opportunities: 980, tasks: 47, quotes: 401, service_plans: 687, jobs: 792, visits: 623,
  visit_timers: 197, timesheets: 85, payroll: 6, invoices: 712, payments: 688, messages: 10927, campaigns: 31, giveaway_entrants: 120, referrals: 40,
});
export const ENTITIES = Object.freeze(["members", "member_availability", "availability_exceptions", "rate_settings", "crews", "customers", "leads", "quote_contacts",
  "pipelines", "pipeline_stages", "opportunities", "tasks", "quotes", "service_plans", "agreement_templates", "jobs", "visits", "visit_timers", "timesheets",
  "payroll", "invoices", "payments", "messages", "message_templates", "campaigns", "map_pin_types"]);
export const SITE_STORE_ENTITIES = Object.freeze(["giveaway_entrants", "referrals"]);

const COMPANY = "00000000-0000-4000-8000-00000000c0de";
const iso = (ms) => new Date(ms).toISOString().replace("Z", "+00:00");
const isoMicros = (ms, rnd) => iso(ms).replace(/\.(\d{3})\+/, (_, m) => `.${m}${String(rnd.int(0, 999)).padStart(3, "0")}+`).replace(/0+\+00:00$/, "+00:00").replace(/\.\+/, ".0+");
const day = 86400000;
const T0 = Date.parse("2026-07-29T19:12:48Z");    // the Markate import batch 1
const MARKATE2 = Date.parse("2026-07-29T21:49:46Z");

// ------------------------------------------------------------ the generator

export function countsFor(scale = 0.05) {
  const out = {};
  for (const [k, v] of Object.entries(SCALE_COUNTS)) out[k] = Math.max(1, Math.round(v * scale));
  return out;
}

export function generate({ scale = 0.05, seed = 1, siteStores = true, media = false } = {}) {
  const r = rng(seed * 7919 + Math.round(scale * 1000));
  const N = countsFor(scale);
  const out = Object.fromEntries(ENTITIES.map((e) => [e, []]));
  let phoneSeq = 0;
  const phone = () => { phoneSeq += 1; return `+1763555${String(phoneSeq % 10000).padStart(4, "0")}`; };
  const addr = (n, { junk = false } = {}) => {
    const [city, zip] = TOWNS[n % TOWNS.length];
    return { street1: `${100 + (n % 900)} Example Ave`, street2: null, city, state: junk ? r.pick(["XX", "32", null, "FL"]) : "MN", zip, country: r.chance(0.2) ? "United States" : "US" };
  };
  const nameFor = (n) => [FIRST[n % FIRST.length], LAST[Math.floor(n / FIRST.length) % LAST.length]];
  const emailFor = (first, last, n) => `${first.toLowerCase().replace(/[^a-z]/g, "")}.${last.toLowerCase().replace(/[^a-z]/g, "") || "x"}${n}@example.com`;

  // ---- members, availability, rates, crews (rows 1-3)
  const MEMBERS = [["Avery", "Sample", "owner", true, "hourly"], ["Blake", "Sample", "owner", true, null], ["Casey", "Specimen", "admin", false, null], ["Drew", "Example", "member", true, "hourly"], ["Emery", "Example", "member", true, "hourly"]];
  const members = MEMBERS.map(([f, l, role]) => ({ user_id: r.uuid(), name: `${f} ${l}`, first_name: f, last_name: l, email: `${f.toLowerCase()}.${l.toLowerCase()}@example.com`, role }));
  out.members = members;
  out.member_availability = members.map((m, i) => ({
    user_id: m.user_id, name: m.name, first_name: m.first_name, last_name: m.last_name, email: m.email, is_technician: MEMBERS[i][3],
    weekly_availability: [1, 2, 3, 4, 5, 6].map((d) => ({ day_of_week: d, start_time: i === 0 && d > 1 ? "07:00" : d === 6 ? "09:00" : "08:00", end_time: "17:00" })),
  }));
  out.rate_settings = [
    ...members.filter((m, i) => MEMBERS[i][4] === "hourly").map((m) => ({ type: "hourly", id: r.uuid(), company_id: COMPANY, user_id: m.user_id, category: "service", rate_cents_per_hour: 2000, created_at: iso(T0) })),
    { type: "hourly", id: r.uuid(), company_id: COMPANY, user_id: members[0].user_id, category: "office", rate_cents_per_hour: 0, created_at: iso(T0) },
    { type: "hourly", id: r.uuid(), company_id: COMPANY, user_id: members[0].user_id, category: "sales", rate_cents_per_hour: 0, created_at: iso(T0) },
    ...[0, 1, 3, 4].map((i, k) => ({ type: "commission", id: 400 + k, company_id: COMPANY, user_id: members[i].user_id, category: "technician", rate: k === 0 ? 25 : 0, created_at: iso(T0) })),
    ...[0, 1].map((i, k) => ({ type: "commission", id: 410 + k, company_id: COMPANY, user_id: members[i].user_id, category: "salesman", rate: 0, created_at: iso(T0) })),
    { type: "commission", id: 420, company_id: COMPANY, user_id: members[1].user_id, category: "upsell", rate: 0, created_at: iso(T0) },
  ];
  const owner = (i = 0) => members[i].user_id;

  // ---- customers (row 6)
  const customers = [];
  for (let i = 0; i < N.customers; i++) {
    let [first, last] = nameFor(i + 3);
    if (i < MOJIBAKE.length) [first, last] = MOJIBAKE[i];
    const markate1 = i < Math.round(N.customers * 0.686);
    const markate2 = !markate1 && i < Math.round(N.customers * 0.8);
    const created = markate1 ? T0 + (i % 4) * 1000 : markate2 ? MARKATE2 : T0 + day * r.int(5, 100);
    const empty = markate1 || markate2 ? "" : null;
    const src = i === 4 ? "Test" : i === 5 ? "Vendor" : i === 6 ? "Referral program" : markate2 ? "Markate Import" : r.pick(CUSTOMER_SOURCES);
    const business = i === 7 || (i > 20 && i % 97 === 0);
    const c = {
      id: r.uuid(), first_name: business ? `${last} Shop LLC` : first, last_name: business ? "" : last, company_name: business ? `${last} Shop LLC` : empty,
      email: i % 6 === 0 ? empty : i % 157 === 3 ? null : emailFor(first, last, i), phone: i === 8 ? `+1763555${String(i).padStart(4, "0")}9` : i % 9 === 0 ? "" : phone(),
      status: i === 9 || i === 10 || i === 11 ? "inactive" : "active", source: src,
      assigned_to: i % 18 === 0 ? [] : i % 111 === 5 ? [owner(0), owner(1)] : [r.chance(0.85) ? owner(0) : owner(1)],
      address: addr(i, { junk: i === 12 || i % 113 === 1 }),
      tags: i % 7 === 0 ? [r.pick(CUSTOMER_TAGS), r.pick(CUSTOMER_TAGS)].filter((t, k, a) => a.indexOf(t) === k) : i === 13 ? ["Giveaway - Coupon Opt-In"] : [],
      notes: i % 5 === 0 ? "Gate code on file. Dog in the back yard." : markate1 || markate2 ? "" : null,
      created_at: isoMicros(created, r),
    };
    if (i >= 14 && i % 11 === 0) {
      c.notes = `Converted from lead on 10/${(i % 27) + 1}/2026\n\nOriginal Lead Notes:\nCustomer notes:\nPlease call after 5.\n\nServices: ${r.pick(LEAD_SERVICES)}\n\nProjected Value: $0`;
      c.source = "Website quote form";
    }
    customers.push(c);
  }
  out.customers = customers;

  // ---- leads (row 8) with overlaps against customers
  const leads = [];
  for (let i = 0; i < N.leads; i++) {
    let [first, last] = nameFor(i + 41);
    const src = r.pick(LEAD_SOURCES);
    let ph = i % 95 === 4 ? "" : phone();
    let em = i % 6 === 1 ? null : emailFor(first, last, 1000 + i);
    const target = customers[(i * 7 + 15) % customers.length];
    if (i % 10 === 2 && target.phone && target.first_name) { ph = target.phone; first = target.first_name; }               // same phone, same first name: joins the customer
    else if (i % 10 === 5 && target.phone) { ph = target.phone; }                                                          // same phone, another name: a merge candidate
    else if (i % 23 === 7 && target.email) { em = target.email; }                                                          // same email
    if (i % 53 === 9) [first, last] = SPAM[(i / 53 | 0) % SPAM.length];
    if (i === 3) ph = "+176355501234";                                                                                     // a 12-digit value
    const meta = src === "Meta Ads";
    const notes = meta
      ? (i % 2 ? `Lead from Meta form: Sample Form | Ad: Service & Offer | Additional info: where_are_you_located?: ${r.pick(COUNTIES)}` : `Form: Sample Form\nAd: Sample Ad\nWhere are you located?: ${r.pick(["Wright County", "Hennepin County"])}`)
      : src === "Website quote form" ? `Customer notes:\nCould you come before the holidays?\n\nServices: ${r.pick(LEAD_SERVICES)}, ${r.pick(LEAD_SERVICES)}\nPlan: ${r.pick(["One-Time", "Semi-Annual", "Quarterly"])}`
        : src === "Holiday Lights Giveaway" ? `Giveaway entry\nShare link: https://www.bartawindowwashing.com/giveaway\nInvited by: Pat (SAMPLE${i})\n$250 coupon texts: ${r.chance(0.5) ? "YES, opted in" : "no"}\nService area: in`
          : r.chance(0.3) ? null : "Called about gutters.";
    leads.push({
      id: r.uuid(), name: last ? `${first} ${last}` : first, email: em, phone: ph, stage: i % 200 === 7 ? null : "New", priority: i % 300 === 11 ? "high" : "medium", source: src,
      service_type: r.chance(0.43) ? `${r.pick(LEAD_SERVICES)}, ${r.pick(LEAD_SERVICES)}`.slice(0, 100) : null, projected_value: i === 6 ? "243.1" : null,
      follow_up_date: i === 10 ? iso(Date.parse("2026-11-20T15:00:00Z")) : null, assigned_to: r.chance(0.55) ? owner(1) : r.chance(0.05) ? owner(0) : null,
      address: { ...addr(i + 500), ...(r.chance(0.4) ? { street1: null, state: null, country: null } : {}) },
      tags: meta ? ["Sample Form", r.pick(["Service & Offer", "Lights Form"])] : src === "Holiday Lights Giveaway" ? ["Giveaway 2026", r.pick(["Giveaway - New Lead", "Giveaway - Out of Area", "Giveaway Offers OK"])] : r.chance(0.2) ? [r.pick(LEAD_TAGS)] : [],
      notes, created_at: isoMicros(Date.parse("2026-09-01T12:00:00Z") + i * 3600000 * 3, r),
    });
  }
  out.leads = leads;
  const archivedLeadIds = Array.from({ length: Math.max(2, Math.round(N.opportunities * 0.12)) }, () => r.uuid());   // referenced, not listable

  // ---- quote contact rows (row 7): one row per contact (the export dedupes them)
  const quoted = new Set();
  for (let i = 0; i < N.quote_contacts; i++) {
    const isLead = i % 9 === 4 && leads.length;
    let base = isLead ? leads[(i * 3) % leads.length] : customers[(i * 4 + 1) % customers.length];
    for (let k = 1; quoted.has(base.id) && k < customers.length; k++) base = customers[(i * 4 + 1 + k) % customers.length];
    if (quoted.has(base.id)) continue;
    quoted.add(base.id);
    const ms = i % 4 === 0 ? {} : { sms: { opted_in: i % 13 !== 2, first_sms_sent: true, first_sms_sent_date: iso(Date.parse("2026-10-01T16:16:24.305Z") + i * day) } };
    const row = {
      id: base.id, contact_type: isLead ? "lead" : "customer", created_at: base.created_at, messaging_config: ms, muted_channels: i % 31 === 3 ? ["email"] : [], muted_at: null, muted_by: null,
      documents: {}, sync: {}, photos: {}, last_called_at: null, deleted_at: null, archived: false,
    };
    if (isLead) Object.assign(row, { name: base.name, email: base.email, phone: base.phone, lead_source: base.source, status: "New", follow_up_due_emitted_at: null });
    else Object.assign(row, { first_name: base.first_name, last_name: base.last_name, email: base.email, phone: base.phone, stripe_customer_id: i % 6 < 5 ? `cus_${r.alnum(14)}` : null, converted_from_lead_id: i % 8 === 1 ? archivedLeadIds[i % archivedLeadIds.length] : null, payment_provider: "stripe" });
    out.quote_contacts.push(row);
  }

  // ---- pipelines (row 13), opportunities (row 14), tasks (row 15)
  const PIPES = [["New Lead - No Estimate Yet", 9], ["Estimate Sent", 5], ["Referrals", 4], ["Christmas Lights", 6]];
  for (const [k, [name, stages]] of PIPES.entries()) {
    const pid = r.uuid();
    out.pipelines.push({ id: pid, company_id: COMPANY, name, description: "Contact throughout the day 9-10, 12-1, 4-5", created_at: iso(T0 + day * 7), updated_at: iso(T0 + day * 70), assigned_to: [owner(0), owner(1)], position: k + 1 });
    for (let s = 0; s < stages; s++) out.pipeline_stages.push({ id: r.uuid(), pipeline_id: pid, name: s === 0 ? "New" : s === stages - 1 ? "Won" : `Step ${s + 1}`, position: s + 1, created_at: iso(T0 + day * 7), updated_at: iso(T0 + day * 70) });
  }
  const stagesOf = (pid) => out.pipeline_stages.filter((s) => s.pipeline_id === pid);
  for (let i = 0; i < N.opportunities; i++) {
    const p = out.pipelines[i % 4];
    const st = r.pick(stagesOf(p.id));
    const kind = i % 8 === 3 ? "archived" : i % 30 === 1 ? "customer" : "lead";
    const contact = kind === "customer" ? customers[i % customers.length] : kind === "lead" ? leads[i % leads.length] : null;
    out.opportunities.push({
      id: r.uuid(), name: contact ? (contact.name || `${contact.first_name} ${contact.last_name}`) : i % 3 ? `${FIRST[i % FIRST.length]} Archived` : "Opportunity from Lead",
      pipeline_id: p.id, stage_id: st.id, status: r.pick(["Open", "Open", "Open", "Won", "Lost", "Abandoned"]), value: i % 40 === 0 ? 0 : null,
      assigned_to: i % 6 === 0 ? [owner(r.int(0, 1))] : [], contact_id: contact ? contact.id : archivedLeadIds[i % archivedLeadIds.length], contact_type: kind === "customer" ? "customer" : "lead",
      notes: i % 41 === 0 ? "" : null, archived: i % 4 === 0, created_at: isoMicros(Date.parse("2026-09-05T12:00:00Z") + i * 3600000, r),
    });
  }
  for (let i = 0; i < N.tasks; i++) {
    const kind = i % 6;
    const contact = kind < 3 ? customers[i % customers.length] : kind < 5 ? leads[i % leads.length] : null;
    const name = kind === 0 ? "Incident: screen bent at back door" : kind === 1 ? "Touch-up: streaks on the bay window" : kind === 2 ? "On-site quote for the lake house" : kind === 3 ? "Call back after 3:30 about gutters" : kind === 4 ? "Call later today – fall window cleaning" : "Dentist";
    const due = Date.parse("2026-10-01T15:00:00Z") + i * day;
    out.tasks.push({
      id: r.uuid(), name, priority: kind === 0 ? "high" : "medium", status: i % 6 === 2 ? "open" : "done", notes: kind === 0 ? "Reported: 2026-10-02" : i % 3 ? null : "",
      due_date: i % 7 === 6 ? null : iso(due), end_date: iso(due + 3600000), contact_id: contact ? contact.id : null, contact_type: contact ? (contact.name ? "lead" : "customer") : null,
      assigned_to: [owner(i % 2)], user_id: owner(i % 2), position: 0, created_at: isoMicros(due - day, r),
    });
  }

  // ---- quotes (rows 4, 5, 10, 18): lines in dollars, five discount shapes, photos, property ids
  const lineItem = (n, { plan = false, visits = 1 } = {}) => {
    const [title, svc] = LINE_TITLES[n % LINE_TITLES.length];
    const unit = n % 3 === 0;
    const qty = title.includes("Per Foot") ? r.int(85, 250) : unit ? r.int(1, 30) : 1;
    const price = title.startsWith("FREE") ? 0 : unit ? r.int(3, 12) : r.int(150, 450) + (n % 2 ? 0.5 : 0);
    const per = unit ? qty * price : price;
    return {
      id: n % 15 === 3 ? `lineitem_${1790000000000 + n}_${r.alnum(5).toLowerCase()}` : r.uuid(), job_id: "", company_id: COMPANY, title, description: n % 4 === 0 ? "20 Panes ONLY" : n % 4 === 1 ? null : "",
      quantity: qty, unit_price: unit ? price : 0, custom_price: unit ? null : price, total_price: plan && n % 10 === 1 ? per * visits : per,       // legacy total × visits on some plan/quote lines
      use_custom_price: !unit, use_unit_pricing: unit, service_type: svc ? [svc] : null, template_id: n % 3 === 1 ? r.uuid() : null,
      jobSchedule: n % 9 === 4 ? { type: "specific", selectedJobs: [1, 3, 4] } : n % 17 === 2 ? { type: "initial" } : { type: "all" }, applyToAllJobs: true,
      upsell_user_id: n % 50 === 7 ? owner(1) : null, measurement_fields: [], show_measurement_fields: false, show_quantity: true, show_unit_price: true, show_description: false,
      is_active: true, photo: null, client_optional: n % 60 === 9, created_at: iso(T0 + day * 20 + n * 60000).replace("+00:00", "Z"),
    };
  };
  const discountShape = (n) => {
    const entry = { name: n % 5 === 2 ? undefined : DISCOUNT_NAMES[n % DISCOUNT_NAMES.length], type: n % 9 === 0 ? "percentage" : "fixed", value: n % 9 === 0 ? 50 : [50, 100][n % 2], jobSchedule: { type: "all" } };
    switch (n % 6) {
      case 0: return [];
      case 1: return { multi: [entry] };
      case 2: return { enabled: true, type: "fixed", value: 50 };
      case 3: return { enabled: true, multi: [entry], type: "fixed", value: 0 };
      case 4: return { enabled: true, multi: [entry] };
      default: return null;
    }
  };
  const FREQ = [{ name: "One-Time", interval: null, interval_count: null }, { name: "Semi-Annual", interval: "month", interval_count: 6 }, { name: "Quarterly", interval: "month", interval_count: 3 }, { name: "Annual", interval: "year", interval_count: 1 }, { name: "Monthly", interval: "month", interval_count: 1 }, null];
  const QSTAT = ["draft", "sent", "sent", "approved", "rejected", "modification_requested", "converted", "converted"];
  for (let i = 0; i < N.quotes; i++) {
    const isLead = i % 7 === 3;
    const c = isLead ? leads[i % leads.length] : customers[(i * 3) % customers.length];
    const freq = FREQ[i % FREQ.length];
    const status = QSTAT[i % QSTAT.length];
    const created = Date.parse("2026-08-08T15:00:00Z") + i * 5 * 3600000;
    const lines = Array.from({ length: (i % 4) + 1 }, (_, k) => lineItem(i * 5 + k, { plan: true, visits: freq && freq.interval_count === 6 ? 2 : 1 }));
    const own = i % 9 === 5;
    out.quotes.push({
      id: r.uuid(), quote_number: 9408 + i * 23, status, archived: false, contact_id: c.id, contact_type: isLead ? "lead" : "customer",
      service_types: [...new Set(lines.flatMap((l) => l.service_type || []))].slice(0, 2), service_length_months: i % 3 === 0 ? 12 : i % 17 === 1 ? 36 : null,
      billing_mode: freq && freq.name !== "One-Time" ? "start_of_month" : "after_jobs", total: Math.round(lines.reduce((s, l) => s + (l.use_unit_pricing ? l.quantity * l.unit_price : l.custom_price), 0) * 100) / 100,
      jobs_config: {
        line_items: lines, discounts: discountShape(i), frequency: freq, notes: i % 3 === 0 ? "Thanks for choosing us!" : undefined,
        ...(i % 2 ? { property_id: 320000 + i, same_as_customer_address: !own } : {}),
        ...(own ? { property_street1: `${7 + i} Lake Rd`, property_street2: "", property_city: "Mound", property_state: i % 18 === 5 ? "32" : "MN", property_zip: "55364", property_country: "US" } : {}),
        ...(i > N.quotes * 0.7 ? { agreement: { template_id: null, auto_advance: true, require_card: i % 4 === 0 }, photos: i % 40 === 1 ? [{ url: `https://example.com/storage/v1/object/public/photos/x/${r.uuid()}.jpg`, path: "x.jpg", thumb_url: `https://example.com/storage/v1/object/public/photos/x/t.jpg`, thumb_path: "t.jpg" }] : [], service_types: [] } : {}),
        ...(i % 25 === 3 ? { plan_template_id: r.uuid() } : {}),
      },
      internal_notes: i % 4 ? null : "", client_notes: i % 5 === 0 ? "A 50% deposit holds your install date." : null,
      sent_at: status !== "draft" ? iso(created + 3600000) : null, viewed_at: ["approved", "converted", "modification_requested"].includes(status) || i % 6 === 1 ? iso(created + 7200000) : null,
      approved_at: ["approved", "converted"].includes(status) ? iso(created + day) : null, rejected_at: status === "rejected" ? iso(created + day) : null,
      modification_requested_at: status === "modification_requested" ? iso(created + day) : null, modification_message: status === "modification_requested" ? "Can you skip the screens?" : null,
      created_by: owner(i % 2), sold_by: owner(i % 2), created_at: isoMicros(created, r),
    });
  }

  // ---- service plans (row 19), agreement templates (17), jobs (22), visits (23), lights (25)
  const AGREE = [["One Time Service Agreement", "Residential Window Cleaning"], ["Bi-Annual Service Agreement ", "Residential Window Cleaning"], ["Quarterly Service Agreement", "Residential Window Cleaning"], ["Monthly Service Agreement ", "Residential Window Cleaning"], ["Christmas Light Installation Agreement", "Christmas Lights"]];
  out.agreement_templates = AGREE.map(([name, svc]) => ({ id: r.uuid(), name, service_type: svc, is_active: true }));
  const PLAN_FREQ = (i) => (i % 12 === 0 ? FREQ[1] : i % 60 === 7 ? FREQ[2] : i % 75 === 11 ? FREQ[3] : FREQ[0]);
  const jobIds = [];
  for (let i = 0; i < N.service_plans; i++) {
    const c = customers[(i * 11) % customers.length];
    const freq = PLAN_FREQ(i);
    const jobsN = freq.name === "One-Time" ? (i % 40 === 3 ? 2 : i % 25 === 0 ? 0 : 1) : freq.name === "Quarterly" ? 4 : freq.name === "Annual" ? 1 : 2;
    const lights = freq.name === "Annual" || i % 13 === 5;
    const lines = Array.from({ length: (i % 3) + 1 }, (_, k) => lineItem(i * 3 + k + (lights ? 5 : 0), { plan: true, visits: jobsN || 1 }));
    const jobs = Array.from({ length: jobsN }, () => ({ id: r.uuid(), status: r.pick(["Pending", "Scheduled", "Completed", "Completed", "Completed", "Cancelled", "In Progress"]), assigned_to: r.chance(0.7) ? [owner(0), members[3].user_id] : [] }));
    jobs.forEach((j) => jobIds.push({ ...j, plan: i, customer: c }));
    const cancelled = i % 229 === 2;
    const own = i % 28 === 9;
    out.service_plans.push({
      id: r.uuid(), name: null, active: freq.name !== "One-Time" && !cancelled, start_date: iso(T0 + day * (i % 90)), end_date: freq.name === "One-Time" ? null : iso(T0 + day * (i % 90) + 365 * day),
      service_type: lights ? "Christmas Lights" : "Residential Window Cleaning", service_types: [lights ? "Christmas Lights" : "Residential Window Cleaning"], service_frequency: freq.name,
      interval: freq.interval, interval_count: freq.interval_count, sale_value: 690, billing_mode: freq.name === "One-Time" ? "after_jobs" : "start_of_month", monthly_price: null,
      is_auto_pay: freq.name !== "One-Time" && i % 2 === 0, auto_renew: freq.name !== "One-Time", cancelled, cancelled_at: cancelled ? iso(T0 + day * 80) : null, cancelled_reason: cancelled ? r.pick(["Price", "Other"]) : null,
      sold_by: i % 3 ? owner(i % 2) : null,
      jobs_config: {
        as_quote: i % 6 === 0 ? null : false, discounts: discountShape(i + 1), line_items: lines, assigned_to: [],
        property_id: own ? 330000 + i : null, property_street1: own ? `${12 + i} Lake Rd` : "", property_street2: "", property_city: own ? "Mound" : "", property_state: own ? "MN" : "", property_zip: own ? "55364" : "", property_country: own ? "US" : "",
        same_as_customer_address: !own, plan_template_id: i % 6 === 1 ? r.uuid() : null,
      },
      job_count: jobsN, jobs, payment_count: r.int(0, 3), customer: { id: c.id, first_name: c.first_name, last_name: c.last_name, company_name: c.company_name },
      created_at: isoMicros(T0 + day * (i % 90), r),
    });
  }
  // the export holds about as many jobs as the plans list; top up with one-job containers when the scale asks for more
  for (let i = 0; jobIds.length < N.jobs; i++) jobIds.push({ id: r.uuid(), status: "Completed", assigned_to: [], plan: i % Math.max(1, out.service_plans.length), customer: customers[i % customers.length] });
  for (const [i, j] of jobIds.slice(0, N.jobs).entries()) {
    const plan = out.service_plans[j.plan] || out.service_plans[0];
    const start = Date.parse("2026-04-01T13:00:00Z") + (i % 300) * day;
    const lines = (plan ? plan.jobs_config.line_items : [lineItem(i)]).map((l) => ({ ...l, id: r.uuid(), job_id: j.id, total_price: l.use_unit_pricing ? l.quantity * l.unit_price : l.custom_price }));
    out.jobs.push({
      id: j.id, job_number: String(7 + i).padStart(7, "0"), status: j.status, start_date: iso(start), end_date: iso(j.status === "Pending" && i % 2 ? start : start + 3 * 3600000),
      assigned_to: i < N.jobs * 0.6 ? j.assigned_to : [], customer: { id: j.customer.id, first_name: j.customer.first_name, last_name: j.customer.last_name, company_name: j.customer.company_name },
      service_plan_id: plan ? plan.id : null, line_items: lines, due_amount: j.status === "Completed" ? 0 : -50, notes: i % 19 === 0 ? "Gate code on file. Dog is friendly." : i < N.jobs * 0.5 ? null : "",
      created_at: isoMicros(i < N.jobs * 0.6 ? Date.parse("2026-08-20T17:18:04Z") : start - 10 * day, r),
    });
  }
  for (let i = 0; i < N.visits; i++) {
    const j = out.jobs[i % out.jobs.length];
    const c = j.customer;
    const cust = customers.find((x) => x.id === c.id);
    const placeholder = i % 17 === 0;
    const start = Date.parse(j.start_date) + (placeholder ? 0 : 0);
    out.visits.push({
      id: 77000 + i * 7, job_id: j.id, start: placeholder ? j.start_date.slice(0, 10) + "T12:00:00+00:00" : iso(start), end: placeholder ? j.start_date.slice(0, 10) + "T13:00:00+00:00" : iso(start + 2 * 3600000),
      status: r.pick(["scheduled", "finished", "finished", "in_progress", "paused"]), crew_id: i < 3 ? 1786 : null, is_anytime: i % 50 === 9, ordering: i % 40 === 21 ? 2 : 1,
      arrival_window: r.pick([0, 60, 120, 120]), job: { id: j.id, job_number: j.job_number, status: j.status, assigned_to: i % 10 === 0 ? [] : [owner(0), members[3].user_id] },
      customer: c, address: cust ? { ...cust.address, ...(i % 13 === 4 ? { state: null } : {}) } : addr(i), service_type: r.pick(SERVICE_TYPES),
    });
  }
  for (let i = 0; i < N.visit_timers; i++) {
    const v = out.visits[i % out.visits.length];
    const running = i === 1;
    const loose = i === 2;
    const s = Date.parse(v.start) - 120000;
    const mins = i % 7 === 0 ? r.int(0, 5) : r.int(60, 240);
    out.visit_timers.push({
      id: 25000 + i, visit_id: loose ? null : v.id, job_id: loose ? null : v.job_id, start: iso(s), end: running ? null : iso(s + mins * 60000), duration_minutes: running ? null : mins,
      is_active: running, assigned_to: i % 9 === 0 ? [] : v.job.assigned_to, start_location: [45.106, -93.741], end_location: running ? null : [45.083, -93.73],
    });
  }
  for (let i = 0; i < N.timesheets; i++) {
    const s = Date.parse("2026-08-20T12:34:13.199Z") + i * day;
    const mins = i === 0 ? 0 : r.int(189, 780);
    out.timesheets.push({ id: 8600 + i, user_id: members[3 + (i % 2)].user_id, category: "service", start: iso(s), end: iso(s + mins * 60000), duration_minutes: mins, is_active: false, notes: [], start_location: [45.036, -93.786], end_location: [45.055, -93.777], created_at: isoMicros(s + 100, r) });
  }
  for (let i = 0; i < N.payroll; i++) {
    const j = out.jobs[i % out.jobs.length];
    const type = ["technician_commission", "salesman_commission", "tip", "hourly", "technician_commission", "tip"][i % 6];
    const m = members[i % 2 ? 3 : 0];
    out.payroll.push({
      id: r.uuid(), company_id: COMPANY, user_id: m.user_id, user_name: m.name, line_key: type === "hourly" ? `hourly:${8600 + i}:2026-09-29T12:42:00.000Z:2026-09-29T16:34:00.000Z` : `${type.split("_")[0]}:${m.user_id}:${77000 + i}-${j.id}`,
      line_type: type, line_label: `#${j.job_number}`, line_detail: `Job #${j.job_number}`, payroll_range_start: null, payroll_range_end: null,
      line_period_start: "2026-09-29T13:00:00+00:00", line_period_end: "2026-09-29T13:00:00+00:00", event_at: "2026-09-29T13:00:00+00:00",
      basis_amount_cents: 52500, amount_cents: type === "technician_commission" ? 13125 : type === "tip" ? 1250 : 7719, hours: type === "hourly" ? 3.8594 : null, rate_percent: type === "technician_commission" ? 25 : null,
      rate_cents_per_hour: type === "hourly" ? 2000 : null, status: "paid", paid_at: "2026-10-01T01:59:35.907+00:00", paid_by_user_id: owner(0), unpaid_at: null, unpaid_by_user_id: null,
      timesheet_id: type === "hourly" ? 8600 + i : null, job_id: j.id, job_series_id: j.service_plan_id, job_line_item_id: null, created_at: "2026-10-29T14:59:02.751725+00:00", updated_at: "2026-10-29T14:59:02.751725+00:00",
    });
  }

  // ---- invoices (row 27) and payments (row 28)
  for (let i = 0; i < N.invoices; i++) {
    const j = out.jobs[i % out.jobs.length];
    const deposit = i % 65 === 3;
    const imported = i < N.invoices * 0.6;
    const number = deposit ? `D-${String(100000 + i * 37).slice(0, 6)}` : imported ? `INV-${String(120000 + i * 13).slice(0, 6)}` : `INV-${String(400 + i).padStart(4, "0")}`;
    const sub = (i % 20 + 1) * 2500;
    const planDisc = i % 37 === 5;
    const lines = imported
      ? [{ title: "Exterior Window Cleaning", quantity: 1, unit_price: (sub + (planDisc ? 5000 : 0)) / 100, total_price: (sub + (planDisc ? 5000 : 0)) / 100 }]
      : [{ kind: "service", title: "Window Cleaning", quantity: 1, unit_price_cents: sub, total_cents: sub },
        ...(i % 29 === 4 ? [{ kind: "credit", title: "Referral Credit", quantity: 1, unit_price_cents: -2500, total_cents: -2500 }] : []),
        ...(i % 31 === 6 ? [{ kind: "service", title: "Card Fee", quantity: 1, unit_price_cents: 300, total_cents: 300 }] : []),
        ...(i % 33 === 7 ? [{ kind: "discount", title: `Already Paid - Deposit D-${100000 + i}`, quantity: 1, unit_price_cents: -1000, total_cents: -1000 }] : []),
        ...(i % 41 === 8 ? [{ kind: "credit", title: "Gift Card", quantity: 1, unit_price_cents: -500, total_cents: -500 }] : [])];
    const total = imported ? sub : lines.reduce((s, l) => s + l.total_cents, 0);
    const status = r.pick(["paid", "paid", "paid", "paid", "open", "overdue", "draft", "void"]);
    out.invoices.push({
      id: r.uuid(), invoice_number: number, status, currency: "usd", subtotal_cents: total, tax_amount_cents: i === 9 ? 2093 : 0, total_cents: total + (i === 9 ? 2093 : 0),
      due_date: imported ? j.start_date.slice(0, 10) + "T12:00:00+00:00" : j.start_date, sent_at: status === "draft" || i % 5 === 0 ? null : iso(Date.parse(j.start_date) + day), paid_at: status === "paid" ? iso(Date.parse(j.start_date) + 2 * day) : null,
      customer: j.customer, job: deposit || (imported && i % 9 === 0) ? null : { id: j.id, job_number: j.job_number, status: j.status }, service_plan_id: deposit ? null : j.service_plan_id,
      line_items: lines, notes: imported ? null : `For Job #${j.job_number}`, terms: imported ? null : "", created_at: isoMicros(Date.parse(j.start_date) - day, r),
    });
  }
  const METHODS = ["Imported-Data", "Imported-Data", "Imported-Data", "stripe", "stripe", "check", "cash", "tap_to_pay", "other"];
  for (let i = 0; i < N.payments; i++) {
    const inv = out.invoices[i % out.invoices.length];
    const refund = i % 98 === 7;
    const method = refund ? "stripe" : METHODS[i % METHODS.length];
    const tip = !refund && i % 14 === 3 ? 2500 : 0;
    const unlinked = i % 170 === 11;
    out.payments.push({
      id: r.uuid(), status: i % 300 === 13 ? "failed" : "succeeded", payment_type: refund ? "refund" : "invoice", payment_method: method, currency: "usd",
      total_amount_cents: inv.total_cents + tip, tip_cents: tip, processing_fee_cents: method === "stripe" && !refund ? Math.round(inv.total_cents * 0.029) + 30 : 0,
      payment_date: method === "Imported-Data" ? inv.due_date.slice(0, 10) + "T12:00:00+00:00" : iso(Date.parse(inv.created_at) + 3600000),
      reference_number: method === "check" ? (i % 2 ? String(r.int(100, 99999)) : `Chk ${r.int(100, 999)} acct ${r.int(10000000, 99999999)}`) : null,
      customer_id: inv.customer.id, customer: inv.customer, invoice_id: unlinked ? null : inv.id, invoice: unlinked ? null : { invoice_number: inv.invoice_number },
      job_id: inv.job ? inv.job.id : null, job: inv.job ? { id: inv.job.id, job_number: inv.job.job_number } : null, service_plan_id: inv.service_plan_id,
      created_at: isoMicros(Date.parse(inv.created_at) + 3600000, r), updated_at: isoMicros(Date.parse(inv.created_at) + 7200000, r),
    });
  }

  // ---- messages (rows 12, 32): STOP replies before any comms phase, attachments, REMINDER texts, HTML emails
  const people = [...customers.map((c) => ({ c, type: "customer" })), ...leads.map((c) => ({ c, type: "lead" }))].filter((p) => p.c.phone);
  const stopCount = Math.max(2, Math.round(N.messages * 83 / 10927));
  const mediaRows = [];
  for (let i = 0; i < N.messages; i++) {
    const missing = i % 400 === 17;
    const p = people[i % people.length];
    const sms = i % 9 < 7;
    const inbound = i % 6 === 2;
    const stop = i < stopCount * 4 && i % 4 === 2;            // inbound, exact STOP family
    const nearStop = i === 6 || i === 30;
    const html = !sms && !inbound;
    let content = stop ? r.pick(["STOP", "Stop", " stop ", "STOP"]) : nearStop ? "Stop by tomorrow?" : inbound ? (sms ? "Sounds good, see you then" : "Thanks! Looks great.\n\nOn Mon, someone wrote:\n> Your quote") : sms
      ? (i % 11 === 0 ? "REMINDER: Barta Window Washing is scheduled for tomorrow between 8:00 and 10:00 AM." : i % 13 === 0 ? `Hi ${p.c.first_name || "there"}! Thanks for reaching out to Barta Window Washing. Reply stop to opt-out.` : "Running about 15 minutes behind, see you soon!")
      : `<!doctype html><html><body><p>Hi ${p.c.first_name || "there"},</p><p>Your quote from BARTA Window Washing is ready.</p></body></html>`;
    const attach = i % 33 === 5 ? [{ url: `https://example.com/storage/v1/object/public/attachments/${COMPANY}/${r.uuid()}.jpg`, name: `photo-${i}.jpg`, type: "image/jpeg" }] : [];
    if (attach.length && media) mediaRows.push({ url: attach[0].url, source: "message_attachment", ref_id: null, n: i });
    const msg = {
      id: r.uuid(), contact_ref_id: 491000 + (i % people.length), contact_id: missing ? r.uuid() : p.c.id, contact_type: p.type, channel: stop || nearStop ? "sms" : sms ? "sms" : "email",
      direction: stop || nearStop || inbound ? "inbound" : "outbound", content, subject: sms || stop || nearStop ? null : inbound ? "Re: Your quote from BARTA Window Washing" : "Your quote from BARTA Window Washing",
      status: inbound || stop || nearStop ? "received" : i % 32 === 9 ? "failed" : i % 40 === 3 ? "sent" : "delivered", read: !(inbound && i % 50 === 2),
      thread_id: inbound ? r.uuid() : i % 13 === 0 ? `surge-${COMPANY}-${String(p.c.phone).replace("+", "")}` : `${1794017082787 + i}-${r.alnum(10).toLowerCase()}`,
      attachments: attach, contact_email: sms ? null : p.c.email || null, contact_phone: sms || stop || nearStop ? p.c.phone || null : null,
      created_at: isoMicros(Date.parse("2026-08-01T15:00:00Z") + i * 600000, r),
    };
    if (attach.length && media) mediaRows[mediaRows.length - 1].ref_id = msg.id;
    out.messages.push(msg);
  }
  if (media) for (const q of out.quotes) for (const ph of (q.jobs_config.photos || [])) mediaRows.push({ url: ph.url, source: "quote_photo", ref_id: q.id });

  // ---- templates (row 16), campaigns (33), pin types (35)
  for (let i = 0; i < 45; i++) {
    const example = i >= 26;
    const email = example ? i % 3 === 0 : i === 24 || i === 25;
    out.message_templates.push({
      id: r.uuid(), name: example ? `Example ${i}` : i < 4 ? `Review ${i + 1} - Day ${[0, 3, 8, 0][i]}` : i < 12 ? `Giveaway ${i - 3} - follow-up` : `Barta template ${i}`, type: email ? "email" : "sms",
      subject: email ? "A note from BARTA Window Washing" : null,
      content: email ? "<!doctype html><html><body><p>Hi {first_name},</p><p>Thanks!</p></body></html>" : `Hi {first_name}, thanks for choosing Barta Window Washing!${i % 4 === 1 ? " Reply STOP to opt out." : ""}`,
      tags: i < 4 ? ["review"] : i < 12 ? ["giveaway"] : example ? ["default-template"] : [], attachments: [], is_example: example, created_at: iso(T0 + day * 30), updated_at: iso(T0 + day * 60),
    });
  }
  for (let i = 0; i < N.campaigns; i++) {
    const t = out.message_templates[i % 26];
    out.campaigns.push({ id: 590 + i * 3, name: `Fall promo ${i + 1}`, description: "Customers in Delano with no fall visit yet", status: i < 2 ? "active" : "inactive", messaging_template_id: t.id,
      sms_provider: i < 3 ? { name: "surge", number: "+17633099790", nickname: null, surge_acct_id: "acct_sample" } : { name: "surge", number: "+17633143400" },
      created_at: isoMicros(Date.parse("2026-09-15T15:00:00Z") + i * day, r), updated_at: new Date(Date.parse("2026-09-15T15:00:00Z") + i * day).toISOString().replace("Z", "") });
  }
  const PINS = [["No Answer", "#808080"], ["Not Interested", "#FF0000"], ["Interested", "#d0b116"], ["Go Back", "#aa15ef"], ["Made Sale", "#03ad00"], ["Never Knock", "#000000"], ["Renter", "#2a78d6"], ["Come Back Later", "#7c4dff"]];
  out.map_pin_types = PINS.map(([label, color]) => ({ id: r.uuid(), label, color, icon: "picon--house", is_active: true }));

  // ---- the site's own stores (row 36), linked by phone; not part of Rotor's export
  if (siteStores) {
    out.giveaway_entrants = Array.from({ length: N.giveaway_entrants }, (_, i) => {
      const p = people[(i * 13 + 2) % people.length];
      return { id: `entrant-${i + 1}`, phone: i % 10 === 9 ? phone() : p.c.phone, offers_opt_in: i % 3 === 0, sms_opt_out: i % 17 === 4, code: `SAMPLE${i + 1}`, referred_by: i % 5 === 1 ? { code: `SAMPLE${i}` } : null };
    });
    out.referrals = Array.from({ length: N.referrals }, (_, i) => ({ id: `referral-${i + 1}`, friend: { phone: people[(i * 17 + 5) % people.length].c.phone }, code: `BARTA-SAMPLE${i + 1}`, sms_opt_out: i % 11 === 3 }));
  }

  // ---- media (§10.1 step 2): what the integrator's fetch script leaves in media/
  const files = [];
  if (media) {
    for (const [k, m] of mediaRows.entries()) {
      const urlSha = createHash("sha256").update(m.url).digest("hex");
      const kind = k % 7 === 3 ? "html" : k % 5 === 2 ? "png" : "jpeg";
      const bytes = kind === "jpeg" ? Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 16, 0x4a, 0x46, 0x49, 0x46, 0, 1, ...Array(200 + k).fill(7)])
        : kind === "png" ? Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, ...Array(150).fill(3)]) : Buffer.from("<!doctype html><html><body>attachment</body></html>");
      const ext = kind === "jpeg" ? "jpg" : kind;
      files.push({ index: { url_sha256: urlSha, source: m.source, ref_id: m.ref_id, name: `file-${k}.${ext}`, content_type: kind === "html" ? "text/html" : `image/${kind}`, bytes: bytes.length, file: `media/${urlSha}.${ext}` }, bytes });
    }
  }
  Object.defineProperty(out, "media", { value: files, enumerable: false });
  Object.defineProperty(out, "members_list", { value: members, enumerable: false });
  return out;
}

// Writes the export: dir/<entity>.jsonl for every entity (empty files for
// empty tables, like the real export), dir/media/ with media: true.
// → { counts: { [entity]: rows }, media: n }
export function writeExport(dir, opts = {}) {
  const ex = generate(opts);
  mkdirSync(dir, { recursive: true });
  const counts = {};
  for (const [entity, rows] of Object.entries(ex)) {
    writeFileSync(path.join(dir, `${entity}.jsonl`), rows.map((x) => JSON.stringify(x)).join("\n") + (rows.length ? "\n" : ""));
    counts[entity] = rows.length;
  }
  if (ex.media.length) {
    mkdirSync(path.join(dir, "media"), { recursive: true });
    for (const f of ex.media) writeFileSync(path.join(dir, f.index.file), f.bytes);
    writeFileSync(path.join(dir, "media", "index.jsonl"), ex.media.map((f) => JSON.stringify(f.index)).join("\n") + "\n");
  }
  return { counts, media: ex.media.length, members: ex.members_list };
}

// ------------------------------------------------------------ CLI

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  const args = process.argv.slice(2);
  const opt = (name, dflt) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : dflt; };
  const dir = args.find((a, i) => !a.startsWith("--") && !["--scale", "--seed"].includes(args[i - 1]));
  if (!dir) { console.error("usage: node tests/crm/fixtures/rotor-synthetic.mjs <out-dir> [--scale 1] [--seed 7] [--media] [--no-site-stores]"); process.exit(2); }
  if (existsSync(dir) && readdirSync(dir).length) { console.error("Refusing: the output folder is not empty."); process.exit(2); }
  const res = writeExport(dir, { scale: Number(opt("--scale", "0.05")), seed: Number(opt("--seed", "1")), media: args.includes("--media"), siteStores: !args.includes("--no-site-stores") });
  console.log(JSON.stringify({ written: dir, counts: res.counts, media: res.media }, null, 2));
}
