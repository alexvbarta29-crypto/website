// One contact (design §9.2 "Contact"): the lead page and the customer
// page, Rotor's profile (the owner, Nov 2026: "make the customer pages look
// like Rotor"; screenshots 10-13 and 17). Nothing of the earlier page is
// gone; it moved into Rotor's places:
//
//   the header      round back · (no title on a phone: the name is the
//                   page's) · a round pencil (Edit) · the round "..." (every
//                   other action, in groups, Archive and Mark lost red last)
//   the profile     Rotor's left column (a phone: the top of the page; a
//                   desk with room: a 320 px column on the left): the name
//                   with its pill (Active; a lead's priority or stage), the
//                   summary box (a customer: LIFETIME VALUE, SALE VALUE,
//                   FREQUENCY, SERVICE TYPE; a lead: STAGE, EST. VALUE,
//                   FOLLOW-UP, NEXT VISIT; money only for someone who may see
//                   it), email and phone rows (text, call), Mute, "About to be
//                   sent", the primary property and its satellite, Customer
//                   notes, Source, Assigned, Tags, Created, Converted (the rest
//                   folded under More details), then Create Customer (a lead),
//                   Edit, Portal and "..."
//   the tabs        Rotor's, a scrollable segmented row (underlined on a
//                   desk): a customer Service | Payments | Conversation |
//                   Opportunities | Activity | Files; a lead Conversation |
//                   Service | Opportunities | Payments | Activity | Files
//   Service         the tiles (Scheduled jobs x/y, Avg completed job, Avg
//                   future job, Outstanding), then Service Plans, Scheduled
//                   Jobs, Pending Jobs (Delay, Schedule), Quotes, Requests,
//                   each with its red "+ New" pill, and Properties
//   Payments        Payment method, billing cycles, Invoices
//   Conversation    Messages, Texts and email (consent)
//   Opportunities   Follow-ups (the pipelines), Deals, Tasks
//   Activity        the timeline (Show all), Calls
//   Files           photos and PDFs kept on the contact
//
// Modules add their parts through their manifests' `contactTabs` (the name
// stays): { key, label, order, load: () => import("./contact-tab.js"),
// place?, heading?, title?, perm? }. The module default-exports { load(params,
// ctx) → state, cards?(state, ctx) → [{ key, tab: "details" | "activity",
// title, add?: { label, href | data }, count?, body | null, empty? }],
// actions?(state, ctx) → [{ key, label, icon, href | run, data?, hint?,
// danger? }] (rows of the page's "..."), header?(state, ctx) → { plan?,
// next_visit?, deal_id?, stage?, follow_up?, ... }, queued?(state, ctx) →
// [{ at, label, sub?, href? }], render(state, ctx) (a module without cards():
// one card of its own, Activity for place "aside") }; a state of { denied:
// true } leaves it out. ctx.section is true and ctx.contact is the contact;
// setting ctx.state.tabMod = null and calling ctx.rerender() loads that part
// again. Old links to a tab (#/contacts/{id}?tab=money) open its card.
//
// A customer's page on a phone (under 900 px) is Rotor's phone app, as the
// owner's screenshots of Nov 15 show it ("make it just like Rotor"):
// Details | Service | Activity.
//   the header      round back · the round pencil, nothing else. The pencil
//                   opens the edit sheet: Edit details, Owner, Texts and
//                   email, Automations (on: automated texts go out; off is
//                   Mute), Merge, their portal, Convert to Lead, Archive
//   the red +       bottom right (Rotor's): what can be made for them, Book a
//                   job, New quote, New plan, New invoice, credit, a card
//                   link, a call, a follow-up, a task, a note, a property, a file
//   Details         the name and Active, TYPE, SALE VALUE, FREQUENCY, SOURCE;
//                   CONTACT (the phone: a tap calls or texts, copy; the email:
//                   a tap mails, copy; the primary property: a tap opens it;
//                   the satellite in the same card: a tap gives directions);
//                   PAYMENT (the method on file, else Add Payment Method);
//                   Customer notes; then About to be sent, More details
//                   (source, assigned, tags, dates, the rest), their portal,
//                   Properties, Files
//   Service         SERVICE PLAN, SCHEDULED JOBS, PENDING JOBS (Schedule on
//                   the next one, Delay on a long press or its "..."),
//                   BILLING CYCLES (+ New), INVOICES, then Quotes and
//                   Requests, and the numbers (the desk's tiles) at the end
//   Activity        the timeline, Messages, Calls, Follow-ups, Deals, Tasks,
//                   Texts and email
// Each part's card reads as Rotor's: a caps label (with its count and + New)
// over a card. A lead and a technician keep the page above; a desk keeps the
// two columns and the six tabs.
//
// A technician sees only what the server gives them: the name, the numbers
// to call and the properties of their visits.

import { html, icon, sheet, toast, attrs, confirmSheet, seg, cardHead, sectionLabel, contactRows, statusPill, pillTap, pillBtn, rnd, actionSheet, notesBox, disclosure, addressCard, tileRow, formRows, formRow, toggle, openExternal, addressHold, copyText as kitCopy } from "../../core/ui.js";
import { houseReady, houseOn, housePic } from "./house.js";
import { capture, uploadPhoto } from "../../core/camera.js";
import { field, select, readForm, clearErrors, showError, busy } from "../../core/forms.js";
import { dateShort, dateTime, dateYear, money, ago, localDate } from "../../core/format.js";
import { pickContact, pickFrom } from "../../core/pickers.js";
import { directionsUrl } from "../../core/map.js";
import { has as hasRoute, currentPath } from "../../core/router.js";
import { MANIFESTS } from "../index.js";
import {
  ensureStyles, CONSENT, CONSENT_STATE, ARCHIVE_REASONS, phoneText, telHref, smsHref, mailHref, addressLine, consentPill,
  tierPill, forgetIndex, followRun, LIFECYCLE,
} from "./kit.js";

// Where a module's part goes when it has no cards() of its own (the old `place`): aside → Conversation.
const MODULE_PLACES = new Set(["visits", "plan", "docs", "aside", "more"]);
// An old tab → the card it is now.
const OLD_TAB = { overview: "ct-stat", activity: "ct-card-activity", properties: "ct-card-properties", messages: "ct-mod-messages", files: "ct-card-files" };
const SHOW = 4;            // a long list shows this many, then "Show all"
// Rotor's tabs (Attachments is "Files"): a customer's, a lead's (17-lead-detail: Conversation first).
export const PANES = Object.freeze([["service", "Service"], ["payments", "Payments"], ["conversation", "Conversation"], ["opportunities", "Opportunities"], ["activity", "Activity"], ["files", "Files"]]);
export const LEAD_PANES = Object.freeze([["conversation", "Conversation"], ["service", "Service"], ["opportunities", "Opportunities"], ["payments", "Payments"], ["activity", "Activity"], ["files", "Files"]]);
const PANE_KEYS = PANES.map(([k]) => k);
// The cards of each tab, in Rotor's order (a module's card not named here goes by its own `tab`, Service by default).
export const PANE_CARDS = Object.freeze({
  service: ["plan", "visits", "pending", "quotes", "requests", "properties"],
  payments: ["payment", "cycles", "invoices"],
  conversation: ["messages", "consent"],
  opportunities: ["followups", "deals", "tasks"],
  activity: ["activity", "calls"],
  files: ["files"],
});
export const SERVICE_CARDS = PANE_CARDS.service;
// The phone's tabs and their cards in Rotor's phone order (a card not named here goes by its desk tab: PHONE_OF).
export const PHONE_MEDIA = "(max-width: 899px)";
export const PHONE_PANES = Object.freeze([["details", "Details"], ["service", "Service"], ["activity", "Activity"]]);
export const PHONE_CARDS = Object.freeze({
  details: ["payment", "properties", "files"],
  service: ["plan", "visits", "pending", "cycles", "invoices", "quotes", "requests"],
  activity: ["activity", "messages", "calls", "followups", "deals", "tasks", "consent"],
});
const PHONE_OF = { service: "service", payments: "service", conversation: "activity", opportunities: "activity", activity: "activity", files: "details", profile: "details", details: "service" };
export const phonePaneOf = (x) => {
  for (const [k, list] of Object.entries(PHONE_CARDS)) if (list.includes(x.key)) return k;
  return PHONE_OF[x.mod ? x.tab : paneOf(x)] || "service";
};
const narrow = () => typeof matchMedia === "function" && matchMedia(PHONE_MEDIA).matches;
// Rotor's phone page: a customer (not a lead, not a technician) on a phone; s.phone (tests) says which.
export const phoneLayout = (s) => !!(s && s.contact && !s.tech && s.contact.lifecycle !== "lead" && (s.phone === undefined ? narrow() : s.phone));
export const PAYMENT_CARDS = PANE_CARDS.payments;
// a lead's Service: what they asked for and were quoted first
const SERVICE_LEAD = ["quotes", "requests", "plan", "visits", "pending", "properties"];
// a module's loading (or failed, or old one-card) part: the tab its cards will be on
const MOD_PANE = { work: "service", plans: "service", quotes: "service", service: "service", money: "payments", comms: "conversation", sales: "opportunities" };
export const paneOf = (x) => {
  for (const [k, list] of Object.entries(PANE_CARDS)) if (list.includes(x.key)) return k;
  return PANE_KEYS.includes(x.tab) ? x.tab : "service";
};
// An old ?tab= link (or a tab remembered from before) → the tab it is now.
const JUMP_PANE = { activity: "activity", messages: "conversation", money: "payments", work: "service", plans: "service", quotes: "service", requests: "service", sales: "opportunities", files: "files", properties: "service" };
// The "..." rows the modules give, in Rotor's groups (a lead: follow up first; a customer: book first).
const LEAD_ACTS = [["call", "follow", "task"], ["quote", "book", "plan", "invoice", "credit", "cardlink"]];
const CUSTOMER_ACTS = [["book", "quote", "plan", "invoice", "credit", "cardlink"], ["call", "follow", "task"]];
// A lead's priority (Rotor's Low / Medium / High).
export const PRIORITY = Object.freeze({ low: "Low", medium: "Medium", high: "High" });

// The sections the modules add, for this person, in order.
export function contactSections(manifests = MANIFESTS, can = () => true) {
  return manifests.flatMap((m) => (m.contactTabs || []).map((t) => ({ ...t, module: m.name })))
    .filter((t) => t && t.key && typeof t.load === "function" && (!t.perm || can(t.perm)))
    .map((t) => ({ ...t, place: MODULE_PLACES.has(t.place) ? t.place : "more" }))
    .sort((a, b) => (a.order || 50) - (b.order || 50));
}

const ACTIVITY_ICON = {
  "lead.intake": "inbox", "contact.intake": "inbox", note: "doc", "contact.merged": "contacts", "contact.merge": "contacts", "contact.create": "plus", "contact.update": "doc",
  message: "text", "sms.in": "text", "sms.out": "text", "sms.history": "text", "email.in": "mail", "email.out": "mail", "email.history": "mail",
  "payment.succeeded": "money", "invoice.paid": "money", "invoice.created": "doc", "credit.issued": "gift", "review.matched": "check", "task": "check", "cadence.started": "clock",
};
const actIcon = (k) => ACTIVITY_ICON[k] || (/^call\./.test(k) ? "phone" : /^visit\./.test(k) ? "schedule" : /^quote\./.test(k) ? "doc" : /^plan\./.test(k) ? "schedule" : "clock");
const actLabel = (x) => ({
  "contact.intake": `Website request${x.source ? ` (${x.source})` : ""}`, "contact.create": "Added to the CRM", "contact.update": "Edited",
  "contact.merge": "Merged a duplicate into this contact", "contact.delete": "Deleted", "contact.restore": "Restored", note: "Note added",
})[x.kind] || x.label || x.kind.replace(/^contact\./, "").replace(/[._]/g, " ");

// ------------------------------------------------------------ loading

// The section an old tab link (or a tab remembered from before) asks for.
function askedTab(ctx) {
  let q = "";
  try { q = new URLSearchParams((typeof location !== "undefined" && location.hash.split("?")[1]) || "").get("tab") || ""; } catch (e) { q = ""; }
  return q || ctx.keep.tab || "";
}

async function load(params, ctx) {
  ensureStyles();
  // (whether the house picture can come: asked once, beside the contact)
  const [r] = await Promise.all([ctx.api(`/contacts/${encodeURIComponent(params.id)}`), houseReady(ctx)]);
  const d = r.data || {};
  if (d.contact && d.contact.merged_into) { ctx.go(`/contacts/${d.contact.merged_into}`, { replace: true }); return { redirect: true }; }
  const tech = !d.stats;
  let users = [];
  if (!tech && d.contact && (d.contact.owner_id || (d.contact.watcher_ids || []).length) && ctx.can("schedule:read")) {
    users = await ctx.api("/users").then((x) => x.data || []).catch(() => []);
  }
  const secs = tech ? [] : contactSections(MANIFESTS, ctx.can).map((def) => ({ def, key: def.key, mod: null, state: null, loading: true, failed: null }));
  const jump = askedTab(ctx);
  delete ctx.keep.tab;
  // the tab: an old ?tab= link's, else the one used last on this contact while the app is open, else Rotor's
  // first (a customer: Service; a lead: Conversation)
  const first = d.contact && d.contact.lifecycle === "lead" ? "conversation" : "service";
  const pane = JUMP_PANE[jump] || (PANE_KEYS.includes(jump) ? jump : PANE_KEYS.includes(ctx.keep.pane) ? ctx.keep.pane : first);
  // the phone's tab: an old ?tab= link's, else the one used last, else Details
  const jumped = JUMP_PANE[jump] || (PANE_KEYS.includes(jump) ? jump : null);
  const ppane = jumped ? PHONE_OF[jumped] : PHONE_PANES.some(([k]) => k === ctx.keep.ppane) ? ctx.keep.ppane : "details";
  return { ...d, etag: r.etag, tech, users, secs, activity: tech ? [] : null, files: tech || !ctx.can("contacts:read_all") ? [] : null, jump, pane, ppane, offline: !!r.offline, started: false };
}

// Draws again soon (sections arrive one by one), only while this contact is on screen.
function soon(ctx) {
  const s = ctx.state;
  if (s._soon) return;
  s._soon = setTimeout(() => { s._soon = null; if (ctx.state === s && currentPath() === ctx.path) ctx.rerender(); }, 16);
}

// The ctx a section's module gets: its own state slot, so setting
// ctx.state.tabMod = null and calling ctx.rerender() loads it again.
function sectionCtx(ctx, rec) {
  const slot = {};
  Object.defineProperty(slot, "tabMod", { get: () => rec.mod, set: (v) => { if (v == null) rec.again = true; } });
  return { ...ctx, section: true, contact: ctx.state && ctx.state.contact, state: slot, rerender: () => { if (rec.again) { rec.again = false; loadSection(ctx, rec); } else soon(ctx); }, refresh: () => ctx.refresh() };
}

async function loadSection(ctx, rec) {
  const s = ctx.state;
  rec.loading = true;
  rec.failed = null;
  rec.ctx = sectionCtx(ctx, rec);
  try {
    rec.mod = (await rec.def.load()).default;
    rec.state = rec.mod.load ? await rec.mod.load({ id: s.contact.id }, rec.ctx) : {};
  } catch (e) {
    rec.failed = (e && e.message) || "That didn't load.";
  }
  rec.loading = false;
  soon(ctx);
}

async function loadFiles(ctx) {
  const s = ctx.state;
  try { s.files = (await ctx.api(`/contacts/${encodeURIComponent(s.contact.id)}/files`, { cache: false })).data || []; } catch (e) { s.files = []; }
  soon(ctx);
}

async function loadActivity(ctx) {
  const s = ctx.state;
  try { s.activity = (await ctx.api(`/contacts/${encodeURIComponent(s.contact.id)}/activity`, { cache: false })).data || []; } catch (e) { s.activity = []; s.activityFailed = (e && e.message) || "That didn't load."; }
  soon(ctx);
}

// ------------------------------------------------------------ the top

const shown = (r) => !(r.state && r.state.denied);
const lead = (s) => s.contact.lifecycle === "lead";
const customer = (s) => ["customer", "former_customer"].includes(s.contact.lifecycle);

// What the modules tell the page (a plan's name, a nearer next visit, the deal and the follow-up).
function fromSections(s, ctx) {
  const out = {};
  for (const r of s.secs || []) {
    if (!r.mod || typeof r.mod.header !== "function" || !r.state || r.state.denied) continue;
    try { Object.assign(out, Object.fromEntries(Object.entries(r.mod.header(r.state, r.ctx) || {}).filter(([, v]) => v !== null && v !== undefined && v !== ""))); } catch (e) { /* a part never breaks the page */ }
  }
  return out;
}

// Balance owed and lifetime spend (only for someone who may see money; the
// server leaves money out for anyone else), next visit; "-" when not known.
// → [{ key, label, value, bad? }]
export function headerNumbers(s, can, extra = {}) {
  const st = s.stats || {};
  const out = [];
  if (can("invoices:read_all")) {
    const m = st.money || null;
    const ok = (n) => Number.isSafeInteger(n) && n >= 0;
    out.push({ key: "balance", label: "Balance owed", value: m && ok(m.open_balance_cents) ? money(m.open_balance_cents) : "-", bad: !!(m && m.open_balance_cents > 0) });
    out.push({ key: "lifetime", label: "Lifetime spend", value: m && ok(m.lifetime_cents) ? money(m.lifetime_cents) : "-" });
  }
  const today = localDate(new Date());
  const stat = st.work && st.work.next_visit_on >= today ? st.work.next_visit_on : null;
  const next = [stat, extra.next_visit].filter((x) => typeof x === "string" && /^\d{4}-\d{2}-\d{2}$/.test(x) && x >= today).sort()[0] || null;
  out.push({ key: "next", label: "Next visit", value: next ? dateShort(next) : "-" });
  return out;
}

// The street-level photo of the house (Google Street View, else the
// satellite): house.js, docs/CRM-MAP.md "The house picture". Without Google
// the page shows the keyless aerial view, as before.

const sinceText = (s) => {
  const c = s.contact;
  const st = s.stats && s.stats.contacts;
  if (c.lifecycle === "customer" || c.lifecycle === "former_customer") return `${c.lifecycle === "customer" ? "Customer" : "Former customer, a customer"} since ${dateYear((st && st.customer_since) || c.created_at)}`;
  // ("Lead since Nov 17": Rotor's, without the weekday)
  if (c.lifecycle === "lead") return `Lead since ${dateShort(c.created_at).replace(/^[A-Za-z]+, /, "")}`;
  return c.created_at ? `Added ${dateYear(c.created_at)}` : "";
};
const two = (a) => (a ? [[a.street1, a.street2].filter(Boolean).join(", "), [a.city, [a.state, a.zip].filter(Boolean).join(", ")].filter(Boolean).join(", ")].filter(Boolean) : []);
const userName = (s, id) => (s.users.find((u) => u.id === id) || {}).name || "Someone on the team";
const primaryProp = (s) => (s.properties || []).find((p) => p.id === s.contact.primary_property_id) || (s.properties || [])[0] || null;
const hasHighTag = (c) => (c.tags || []).some((t) => String(t).toLowerCase() === "high priority");

// The pill right of the name (Rotor's): a customer "Active"; a lead's priority, else the deal's stage.
export function topPill(s, facts = {}) {
  const c = s.contact;
  if (c.lifecycle === "customer") return statusPill("Active", "green");
  if (PRIORITY[c.priority]) return statusPill(PRIORITY[c.priority], c.priority === "low" ? "grey" : "orange");
  if (hasHighTag(c)) return statusPill("High priority", "orange");
  if (c.lifecycle !== "lead") return statusPill(LIFECYCLE[c.lifecycle] || c.lifecycle, c.lifecycle === "archived" ? "grey" : "amber");
  const word = facts.deal_status === "quoted" ? "Quoted" : facts.enrollment_id ? "Following up" : facts.deal_id ? "Open" : "New";
  return statusPill(word, word === "Following up" ? "amber" : "blue");
}

function top(s, ctx) {
  const c = s.contact;
  const facts = s.tech ? {} : fromSections(s, ctx);
  const flags = c.flags || {};
  const any = flags.vip || flags.test || flags.do_not_service;
  return html`<header class="ct-head" id="ct-head" aria-label="${c.display_name || "Contact"}">
    <div class="rs-name"><h2>${c.display_name || "No name"}</h2>${s.tech ? "" : topPill(s, facts)}</div>
    ${!s.tech && any ? html`<div class="rs-pills ct-pills">${flags.vip ? statusPill("VIP", "solid") : ""}${flags.test ? statusPill("Test contact", "blue") : ""}${flags.do_not_service ? statusPill("Do not service", "red") : ""}</div>` : ""}
  </header>`;
}

// Rotor's summary box: a customer's LIFETIME VALUE, SALE VALUE, FREQUENCY, SERVICE TYPE; a lead's STAGE,
// EST. VALUE, FOLLOW-UP (and the next visit). Someone who may not see money gets the next visit and the source.
export function summaryItems(s, can, facts = {}) {
  const c = s.contact;
  const nums = Object.fromEntries(headerNumbers(s, can, facts).map((n) => [n.key, n]));
  const src = (c.source && c.source.source) || "";
  if (c.lifecycle === "lead") {
    if (!can("sales:work")) return [{ key: "source", label: "Source", value: src || "Not known" }, { key: "next", label: "Next visit", value: nums.next.value }];
    // (Rotor's stage is the pipeline's: the follow-up's name, "Estimate sent - not scheduled" → "Estimate sent"; its step is on the Follow-ups card)
    const stage = facts.pipeline ? String(facts.pipeline).split(" - ")[0] : facts.stage || (facts.deal_status === "quoted" ? "Quoted" : facts.deal_id ? "Open" : "New");
    return [
      { key: "stage", label: "Stage", value: stage, href: facts.deal_id ? "#/deals/" + encodeURIComponent(facts.deal_id) : facts.enrollment_id ? "#/enrollments/" + encodeURIComponent(facts.enrollment_id) : null },
      { key: "value", label: "Est. value", value: facts.deal_value === undefined || facts.deal_value === null ? "-" : money(facts.deal_value) },
      { key: "follow", label: "Follow-up", value: facts.follow_up ? dateShort(facts.follow_up) : "-", href: facts.enrollment_id ? "#/enrollments/" + encodeURIComponent(facts.enrollment_id) : null },
      { key: "next", label: "Next visit", value: nums.next.value },
    ];
  }
  const out = nums.lifetime
    ? [{ key: "lifetime", label: "Lifetime value", value: nums.lifetime.value }, { key: "sale", label: "Sale value", value: Number.isSafeInteger(facts.sale_value) ? money(facts.sale_value) : "-" }]
    : [{ key: "next", label: "Next visit", value: nums.next.value }, { key: "source", label: "Source", value: src || "Not known" }];
  return [...out, { key: "frequency", label: "Frequency", value: facts.frequency || "-" }, { key: "type", label: "Service type", value: facts.service_type || "-" }];
}

// Rotor's phone summary: TYPE, SALE VALUE, FREQUENCY, SOURCE (someone who may not see money: the next visit
// for the sale value; the lifetime value is under More details).
export function phoneSummaryItems(s, can, facts = {}) {
  const c = s.contact;
  const src = (c.source && c.source.source) || "";
  const nums = Object.fromEntries(headerNumbers(s, can, facts).map((n) => [n.key, n]));
  return [
    { key: "type", label: "Type", value: facts.service_type ? `${c.kind === "business" ? "Commercial" : "Residential"} ${facts.service_type}` : "-" },
    nums.lifetime ? { key: "sale", label: "Sale value", value: Number.isSafeInteger(facts.sale_value) ? money(facts.sale_value).replace(/\.00$/, "") : "-" } : { key: "next", label: "Next visit", value: nums.next.value },
    { key: "frequency", label: "Frequency", value: facts.frequency || "-" },
    { key: "source", label: "Source", value: src || "Not known" },
  ];
}

function summary(s, ctx) {
  const items = (phoneLayout(s) ? phoneSummaryItems : summaryItems)(s, ctx.can, fromSections(s, ctx));
  const cell = (x) => {
    const inner = html`<span class="ct-sv-l">${x.label}</span><span class="ct-sv-v">${x.value === undefined || x.value === null || x.value === "" ? "-" : x.value}</span>`;
    return x.href ? html`<a class="ct-sv" ${attrs({ href: x.href, "data-sv": x.key })}>${inner}</a>` : html`<div class="ct-sv" ${attrs({ "data-sv": x.key })}>${inner}</div>`;
  };
  return html`<div id="ct-stat" class="ct-sum" role="group" aria-label="${lead(s) ? "Lead summary" : "Customer summary"}">${items.map(cell)}</div>`;
}

// CONTACT: every phone (a grey round text, a red round call), every email (a round copy; the address mails), the address (a round navigate).
function reach(s, ctx) {
  const c = s.contact;
  const name = c.display_name || "";
  const phones = [...(c.phones || [])].sort((a, b) => Number(!!b.primary) - Number(!!a.primary));
  const emails = [...(c.emails || [])].sort((a, b) => Number(!!b.primary) - Number(!!a.primary));
  const prop = primaryProp(s);
  const addr = lead(s) || s.tech ? (prop ? prop.address : c.billing_address) : c.billing_address || (prop && prop.address);
  const lines = two(addr);
  const geo = prop && prop.geo && Number.isFinite(prop.geo.lat) && Number.isFinite(prop.geo.lng) ? prop.geo : null;
  const plabel = (p) => (p.label && p.label !== "mobile" ? p.label[0].toUpperCase() + p.label.slice(1) : "Mobile");
  const rows = [
    ...phones.map((p) => ({ icon: "call", label: plabel(p), value: phoneText(p.e164), href: telHref(p.e164), actions: [
      p.sms !== false && { icon: "chat", label: `Text ${name}`, href: smsHref(p.e164) },
      { icon: "call", label: `Call ${name}`, tone: "red", href: telHref(p.e164) }] })),
    ...emails.map((e) => ({ icon: "mail", label: "Email", value: e.address, href: mailHref(e.address), actions: [{ icon: "copy", label: "Copy the email", data: { copy: e.address } }, { icon: "send", label: `Email ${name}`, href: mailHref(e.address) }] })),
    lines.length && (lead(s) || s.tech || !prop) && { icon: "pin", label: lead(s) ? "Address" : "Billing address", value: lines[0], sub: lines[1] || null, address: addressLine(addr), actions: [{ icon: "nav", label: "Directions", ext: directionsUrl(geo || addressLine(addr)) }] },
  ].filter(Boolean);
  // a lead (and a tech, and a customer with no property yet): the house picture inside this card (a
  // customer's is in PRIMARY PROPERTY's); with no property, the billing address's (under the contact)
  const pic = !houseOn() || !(lead(s) || s.tech || !prop) ? ""
    : prop ? housePic({ id: prop.id, geo, line: addressLine(prop.address) })
      : !s.tech && addr && addr.street1 ? housePic({ id: c.id, of: "contacts", line: addressLine(addr) }) : "";
  if (pic) return html`<div class="ct-reach" id="ct-reach"><div class="rs-card ct-reach-c">${rows.length ? contactRows(rows, { card: false }) : ""}<div class="ct-house">${pic}</div></div></div>`;
  return html`<div class="ct-reach" id="ct-reach">${rows.length ? contactRows(rows) : html`<div class="rs-card"><p class="rs-empty">No phone, email or address on file</p></div>`}</div>`;
}

// The phone's CONTACT card (Rotor's): each phone (a tap calls or texts them; copy), each email (a tap mails them;
// copy), the primary property (a tap opens it), and the satellite inside the same card (a tap: directions).
const PHONE_LABEL = (p, many) => (!many || !p.label || p.label === "mobile" ? "Phone" : p.label[0].toUpperCase() + p.label.slice(1));
// Rotor's one-line address: "900 Example Ave, Mound MN 55328, US"
export const rotorAddress = (a) => (a ? [[a.street1, a.street2].filter(Boolean).join(", "), [a.city, [a.state, a.zip].filter(Boolean).join(" ")].filter(Boolean).join(" "), a.country || (a.street1 ? "US" : "")].filter(Boolean).join(", ") : "");
function contactCard(s, ctx) {
  const c = s.contact;
  const name = c.display_name || "";
  const phones = [...(c.phones || [])].sort((a, b) => Number(!!b.primary) - Number(!!a.primary));
  const emails = [...(c.emails || [])].sort((a, b) => Number(!!b.primary) - Number(!!a.primary));
  const prop = primaryProp(s);
  const addr = prop ? prop.address : c.billing_address;
  const line = rotorAddress(addr);
  const geo = prop && prop.geo && Number.isFinite(prop.geo.lat) && Number.isFinite(prop.geo.lng) ? prop.geo : null;
  const gate = prop && prop.access && prop.access.gate_code ? `Gate ${prop.access.gate_code}` : "";
  const txt = (ic, label, value, sub = null) => html`<span class="ct-cr-ic" aria-hidden="true">${icon(ic)}</span><span class="ct-cr-t"><span class="ct-cr-l">${label}</span><span class="ct-cr-v">${value}</span>${sub ? html`<span class="ct-cr-s">${sub}</span>` : ""}</span>`;
  const copy = (value, label) => html`<button type="button" class="ct-cr-cp" ${attrs({ "data-copy": value, "aria-label": label })}>${icon("copy")}</button>`;
  const rows = [
    ...phones.map((p) => html`<div class="ct-cr"><button type="button" class="ct-cr-a" ${attrs({ "data-ct-phone": p.e164, "aria-label": `Call or text ${name} at ${phoneText(p.e164)}`, "aria-haspopup": "dialog" })}>${txt("call", PHONE_LABEL(p, phones.length > 1), phoneText(p.e164))}</button>${copy(phoneText(p.e164), "Copy the number")}</div>`),
    ...emails.map((e) => html`<div class="ct-cr"><a class="ct-cr-a" ${attrs({ href: mailHref(e.address), "aria-label": `Email ${name} at ${e.address}` })}>${txt("mail", "Email", e.address)}</a>${copy(e.address, "Copy the email")}</div>`),
    line && html`<div class="ct-cr">${prop ? html`<a class="ct-cr-a" ${addressHold(addressLine(addr))} ${attrs({ href: "#/properties/" + encodeURIComponent(prop.id) })}>${txt("pin", "Primary property", line, gate || null)}</a>` : html`<div class="ct-cr-a" ${addressHold(addressLine(addr))}>${txt("pin", "Billing address", line)}</div>`}</div>`,
  ].filter(Boolean);
  // the house (Rotor's): Street View, else the aerial (house.js); without Google, the keyless satellite
  const house = houseOn() && (prop || (addr && addr.street1));
  const photo = !house && geo && ctx.can("canvass:use") && hasRoute("/map");
  return html`<div class="rs-card ct-ccard" id="ct-reach">${rows.length ? rows : html`<p class="rs-empty">No phone, email or address on file</p>`}
    ${house ? html`<div class="ct-map ct-house">${prop ? housePic({ id: prop.id, geo, line: addressLine(prop.address) }) : housePic({ id: c.id, of: "contacts", line: addressLine(addr) })}</div>` : ""}
    ${photo ? html`<a class="ct-map" ${openExternal(directionsUrl(geo || addressLine(addr)))} ${attrs({ "aria-label": `Directions to ${line || "the property"}` })}><span class="rs-sat ct-photo" ${attrs({ "data-photo": `${geo.lat},${geo.lng}`, role: "img", "aria-label": `Satellite view of ${line || "the property"}` })}></span></a>` : ""}</div>`;
}

// The property from above (the map's keyless aerial), and a customer's primary property over it.
function satellite(s, ctx) {
  const prop = primaryProp(s);
  const geo = prop && prop.geo && Number.isFinite(prop.geo.lat) && Number.isFinite(prop.geo.lng) ? prop.geo : null;
  const house = !!prop && houseOn();
  const photo = !house && !s.tech && geo && ctx.can("canvass:use") && hasRoute("/map");
  const lines = prop ? two(prop.address) : [];
  const pic = photo ? html`<div class="rs-sat ct-photo" ${attrs({ "data-photo": `${geo.lat},${geo.lng}`, role: "img", "aria-label": `Satellite view of ${lines[0] || "the property"}` })}><span class="ct-photo-l">Satellite</span></div>` : "";
  // (a lead's and a tech's house picture is in the CONTACT card, reach())
  if (lead(s) || s.tech || !prop) return pic;
  const a = prop.access || {};
  return html`${sectionLabel("Primary property")}
    ${addressCard({ line1: lines[0] || prop.label || "Property", line2: [lines[1], a.gate_code ? `gate ${a.gate_code}` : ""].filter(Boolean).join(" · "), address: addressLine(prop.address), href: "#/properties/" + encodeURIComponent(prop.id), nav: directionsUrl(geo || addressLine(prop.address)), edit: ctx.can("contacts:write") ? { label: "Edit the property", href: "#/properties/" + encodeURIComponent(prop.id) } : null, pic: house ? housePic({ id: prop.id, geo, line: addressLine(prop.address) }) : null })}
    ${pic}`;
}

// ------------------------------------------------------------ the cards

const loadingBody = html`<div class="ct-loading" aria-busy="true"><span class="sk w70"></span><span class="sk w50"></span></div>`;
// One card: its head (title, count, a round +; Rotor's red "+ New Plan" pill when the add has a short name),
// its body or the one-line empty text.
function head(x) {
  if (!x.add || !x.add.short) return cardHead(x.title, { add: x.add || null, edit: x.edit || null, count: x.count });
  const a = x.add;
  return html`<div class="rs-ch"><h3>${x.title}</h3>${x.count ? html`<span class="rs-ch-n">${String(x.count)}</span>` : ""}<span class="rs-ch-end">${pillBtn(a.short, { icon: "plus", tone: "red", href: a.href || null, ext: a.ext || null, data: a.data || null, aria: a.label || a.short })}</span></div>`;
}
function card(x) {
  return html`<section ${attrs({ class: "rs-card ct-card" + (x.cls ? " " + x.cls : ""), id: x.id || "ct-card-" + x.key, "data-card": x.key, "data-mod": x.mod || null, "aria-label": x.title })}>
    ${head(x)}
    ${x.body ? html`<div class="ct-cb ct-clip" ${attrs({ "data-clip": x.key })}>${x.body}</div>` : html`<p class="rs-empty">${x.empty || "Nothing yet"}</p>`}
  </section>`;
}

// The phone's card (Rotor's phone app): a caps label (its count, a + New pill) over a card; nothing yet: one grey line.
const countText = (x) => {
  const n = typeof x.count === "number" ? x.count : /^\d+$/.test(String(x.count || "")) ? Number(x.count) : null;
  return n && !/\(\d+\)/.test(x.title) ? ` (${n})` : "";
};
const PHONE_ADDS = new Set(["cycles", "properties", "files"]);
function phoneCard(x) {
  // (Rotor's phone cards have no + of their own but Billing Cycles: the red + makes the rest)
  const a = PHONE_ADDS.has(x.key) ? x.add : null;
  const end = a ? pillBtn("New", { icon: "plus", tone: "line", href: a.href || null, ext: a.ext || null, data: a.data || null, aria: a.label || a.short })
    : x.edit ? rnd("edit", x.edit.label, { tone: "grey", sm: true, href: x.edit.href || null, data: x.edit.data || null }) : "";
  return html`<section ${attrs({ class: "ct-pc" + (x.cls ? " " + x.cls : ""), id: x.id || "ct-card-" + x.key, "data-card": x.key, "data-mod": x.mod || null, "aria-label": x.title })}>
    <div class="ct-pc-h"><h3 class="rs-label">${x.title}${countText(x)}</h3>${end}</div>
    ${x.body ? html`<div class="rs-card ct-card ct-pc-b"><div class="ct-cb ct-clip" ${attrs({ "data-clip": x.key })}>${x.body}</div></div>` : html`<p class="ct-pc-e">${x.empty || "Nothing yet"}</p>`}
  </section>`;
}

// What each module gives: its cards (or its old section as one card), a loading or failed card while it can't.
function moduleCards(s, ctx, phone = false) {
  const out = [];
  for (const r of s.secs || []) {
    if (!shown(r)) continue;
    if (r.ctx) r.ctx.phone = phone;
    const def = r.def;
    const title = def.title || def.heading || def.label;
    // (where its old place sits in Rotor's order)
    const sortKey = { visits: "visits", plan: "plan", docs: "invoices", more: "followups", aside: "messages" }[def.place];
    const pane = MOD_PANE[def.module] || (def.place === "aside" ? "conversation" : "service");
    if (r.loading) { out.push({ key: "mod-" + r.key, sortKey, mod: r.key, tab: pane, title, body: loadingBody }); continue; }
    if (r.failed) { out.push({ key: "mod-" + r.key, sortKey, mod: r.key, tab: pane, title, body: html`<div class="ct-failed"><p>${def.label || "This part"} didn't load. ${r.failed}</p><button type="button" class="btn small" ${attrs({ "data-retry-sec": r.key })}>Try again</button></div>` }); continue; }
    let list = null;
    if (typeof r.mod.cards === "function") { try { list = r.mod.cards(r.state || {}, r.ctx) || []; } catch (e) { list = null; } }
    if (!list) { out.push({ key: "mod-" + r.key, sortKey, mod: r.key, tab: pane, title, body: r.mod.render(r.state || {}, r.ctx), cls: "ct-old" }); continue; }
    for (const x of list) out.push({ ...x, mod: r.key, tab: paneOf(x) });
  }
  // the first card of each module carries its old anchor (#ct-mod-money), for old links
  const seen = new Set();
  for (const x of out) if (!seen.has(x.mod)) { seen.add(x.mod); x.id = "ct-mod-" + x.mod; }
  return out;
}

function propertiesCard(s, ctx) {
  const list = s.properties || [];
  const notes = (p) => {
    const a = p.access || {};
    const x = p.assets || {};
    return [a.gate_code ? `Gate ${a.gate_code}` : "", a.pets || "", x.stories ? `${x.stories} ${x.stories === 1 ? "story" : "stories"}` : "", a.parking ? `Parking: ${a.parking}` : "", a.notes || ""].filter(Boolean);
  };
  return {
    key: "properties", tab: "service", title: "Properties", count: list.length > 1 ? `${list.length} properties` : null, empty: "No property yet",
    add: ctx.can("contacts:write") ? { label: "Add a property", data: { "add-prop": true } } : null,
    body: list.length ? html`<ul class="list ct-props">${list.map((p) => {
      const n = notes(p);
      return html`<li><a class="row" ${addressHold(addressLine(p.address))} href="${"#/properties/" + encodeURIComponent(p.id)}">
        <span class="ico">${icon("building")}</span>
        <span class="who"><span class="nm">${p.label || "Property"}${p.id === s.contact.primary_property_id ? " · main" : ""}</span><span class="sub">${addressLine(p.address)}</span>${n.length ? html`<span class="ct-access">${n.join(" · ")}</span>` : ""}</span>
        <span class="end">${s.tech ? "" : tierPill(p.town_tier)}<span class="chev" aria-hidden="true"></span></span></a></li>`;
    })}</ul>` : null,
  };
}

// "About to be sent": what the modules know is queued for this person. → { rows, waiting, any }
function queuedRows(s) {
  const rows = [];
  let any = false;
  for (const r of s.secs || []) {
    if (!r.mod || typeof r.mod.queued !== "function" || !r.state || r.state.denied) continue;
    any = true;
    try { rows.push(...(r.mod.queued(r.state, r.ctx) || [])); } catch (e) { /* a part never breaks the page */ }
  }
  rows.sort((a, b) => String(a.at || "").localeCompare(String(b.at || "")));
  return { rows, any, waiting: (s.secs || []).some((r) => r.loading && r.def.place !== "aside") };
}
function queuedLine(s) {
  const q = queuedRows(s);
  if (!q.any && !q.waiting) return "";
  const n = q.rows.length;
  const paused = s.contact.automations_paused && s.contact.automations_paused.sms;
  return html`<div id="ct-card-queued" data-card="queued">${disclosure("About to be sent", { value: q.waiting && !n ? "..." : n ? `${n} queued` : "Nothing queued", sub: paused ? "Automated texts are paused" : null, data: { queued: true } })}</div>`;
}
function queuedSheet(s) {
  const q = queuedRows(s);
  const c = s.contact;
  const paused = c.automations_paused && c.automations_paused.sms;
  sheet({
    title: "About to be sent",
    body: html`${paused ? html`<div class="warn-box">Automated texts are paused for them: ${c.automations_paused.sms.reason || "no reason given"}.</div>` : ""}
      ${q.rows.length ? html`<ul class="list ct-queued">${q.rows.slice(0, 12).map((x) => {
        const inner = html`<span class="ico">${icon(x.icon || "send")}</span><span class="who"><span class="nm">${x.label}</span><span class="sub">${x.at ? dateTime(x.at) : ""}${x.sub ? `${x.at ? " · " : ""}${x.sub}` : ""}</span></span>`;
        return html`<li>${x.href ? html`<a class="row" ${attrs({ href: x.href })} data-close>${inner}<span class="chev" aria-hidden="true"></span></a>` : html`<div class="row">${inner}</div>`}</li>`;
      })}</ul><p class="small muted ct-fine">What goes out by itself if nothing changes. Check here before texting them yourself.</p>` : html`<p class="muted">Nothing is queued for them right now.</p>`}`,
    events: { "click [data-close]": (e, el) => { const sh = el.closest(".sheet"); const x = sh && sh.querySelector("[data-sheet-x]"); if (x) x.click(); } },
  });
}

function notesCard(s, ctx) {
  const c = s.contact;
  const write = ctx.can("contacts:write");
  return { key: "notes", tab: "profile", title: customer(s) ? "Customer notes" : "Notes", add: write ? { label: "Add a dated note", data: { note: true } } : null,
    body: write ? notesBox(c.notes, { name: "ct-notes", label: "Notes", placeholder: lead(s) ? "Add notes for this lead..." : "Add notes for this customer...", rows: 3 }) : c.notes ? html`<p class="ct-pre">${c.notes}</p>` : null, empty: "No notes yet" };
}

// Rotor's facts under the notes: Source, Assigned (a tap picks the owner), Tags, Created, Customer since, Converted
// from a lead; the rest (where the ad came from, the code, the last service, Rotor) folded under More details.
function factsCard(s, ctx) {
  const c = s.contact;
  const src = c.source || {};
  const open = !!ctx.keep.about;
  const owner = c.owner_id ? userName(s, c.owner_id) : "Unassigned";
  const since = s.stats && s.stats.contacts && s.stats.contacts.customer_since;
  const kv = (label, value) => html`<dt>${label}</dt><dd>${value}</dd>`;
  return html`<div class="ct-facts" id="ct-card-about" data-card="about"><section class="rs-card" aria-label="About">
    <dl class="ct-kv">
      ${kv("Source", `${src.qr_code && src.campaign ? `${src.campaign} (QR code) · ` : ""}${src.source || "Not known"}${src.channel ? ` · heard from ${src.channel}` : ""}`)}
      ${kv("Assigned", ctx.can("contacts:write") && ctx.can("schedule:read") ? pillTap(owner, { icon: "user", data: { "pick-owner": true }, aria: `Assigned: ${owner}. Change` }) : owner)}
      ${kv("Tags", (c.tags || []).length ? html`<span class="ct-tags">${c.tags.map((t) => statusPill(t, "white", { icon: "flag" }))}</span>` : "None")}
      ${kv("Created", dateYear(c.created_at))}
      ${customer(s) && since ? kv(c.lifecycle === "customer" ? "Customer since" : "Former customer, since", dateYear(since)) : ""}
      ${c.converted_at ? kv("Converted from lead", dateYear(c.converted_at)) : ""}
    </dl></section>
    ${disclosure("More details", { sub: open ? null : "the ad, codes, last service, Rotor", data: { about: true } })}
    ${open ? html`<section class="rs-card" aria-label="More details"><dl class="ct-kv">
      ${c.converted_at ? kv("Was a lead", `from ${dateShort(c.created_at)} · became a customer ${dateShort(c.converted_at)}`) : ""}
      ${s.stats && s.stats.work && s.stats.work.last_service_on ? kv("Last service", dateShort(s.stats.work.last_service_on)) : ""}
      ${src.form || src.ad ? kv("Meta", [src.form, src.ad, src.campaign].filter(Boolean).join(" · ")) : ""}
      ${src.county ? kv("County", src.county) : ""}
      ${src.promo_code || src.referral_code ? kv("Code", src.referral_code || src.promo_code) : ""}
      ${PRIORITY[c.priority] ? kv("Priority", PRIORITY[c.priority]) : ""}
      ${kv("Added", `${dateShort(c.created_at)}${sinceText(s) ? ` · ${sinceText(s)}` : ""}`)}
      ${c.rotor && (c.rotor.customer_id || (c.rotor.lead_ids || []).length) ? kv("Rotor", `Linked${c.import ? " (imported)" : ""}`) : kv("Rotor", c.intake_pending_rotor ? "Waiting for the next import to link it" : "Made in the CRM")}
    </dl></section>` : ""}
  </div>`;
}

// The phone's More details: Source, Assigned, Tags, the dates, the lifetime value and the rest, folded.
function phoneFacts(s, ctx) {
  const c = s.contact;
  const src = c.source || {};
  const open = !!ctx.keep.about;
  const owner = c.owner_id ? userName(s, c.owner_id) : "Unassigned";
  const since = s.stats && s.stats.contacts && s.stats.contacts.customer_since;
  const life = headerNumbers(s, ctx.can).find((n) => n.key === "lifetime");
  const kv = (label, value) => html`<dt>${label}</dt><dd>${value}</dd>`;
  return html`<div class="ct-facts" id="ct-card-about" data-card="about">
    ${disclosure("More details", { sub: open ? null : `${src.source || "Source not known"} · ${owner}`, data: { about: true } })}
    ${open ? html`<section class="rs-card" aria-label="More details"><dl class="ct-kv">
      ${kv("Source", `${src.qr_code && src.campaign ? `${src.campaign} (QR code) · ` : ""}${src.source || "Not known"}${src.channel ? ` · heard from ${src.channel}` : ""}`)}
      ${kv("Assigned", ctx.can("contacts:write") && ctx.can("schedule:read") ? pillTap(owner, { icon: "user", data: { "pick-owner": true }, aria: `Assigned: ${owner}. Change` }) : owner)}
      ${kv("Tags", (c.tags || []).length ? html`<span class="ct-tags">${c.tags.map((t) => statusPill(t, "white", { icon: "flag" }))}</span>` : "None")}
      ${life ? kv("Lifetime value", life.value) : ""}
      ${kv("Created", dateYear(c.created_at))}
      ${since ? kv(c.lifecycle === "customer" ? "Customer since" : "Former customer, since", dateYear(since)) : ""}
      ${c.converted_at ? kv("Converted from lead", dateYear(c.converted_at)) : ""}
      ${s.stats && s.stats.work && s.stats.work.last_service_on ? kv("Last service", dateShort(s.stats.work.last_service_on)) : ""}
      ${src.form || src.ad ? kv("Meta", [src.form, src.ad, src.campaign].filter(Boolean).join(" · ")) : ""}
      ${src.county ? kv("County", src.county) : ""}
      ${src.promo_code || src.referral_code ? kv("Code", src.referral_code || src.promo_code) : ""}
      ${c.rotor && (c.rotor.customer_id || (c.rotor.lead_ids || []).length) ? kv("Rotor", `Linked${c.import ? " (imported)" : ""}`) : kv("Rotor", c.intake_pending_rotor ? "Waiting for the next import to link it" : "Made in the CRM")}
    </dl></section>` : ""}
  </div>`;
}

function activityCard(s) {
  let body;
  if (!s.activity) body = loadingBody;
  else if (!s.activity.length) body = s.activityFailed ? html`<div class="ct-failed"><p>The activity didn't load. ${s.activityFailed}</p></div>` : null;
  else {
    body = html`<ul class="tl">${s.activity.map((x) => html`<li>
      <span class="ico">${icon(actIcon(x.kind))}</span>
      <span class="body"><span class="t">${actLabel(x)}</span><span class="when">${x.at ? " · " + dateTime(x.at) : ""}</span>
      ${x.note ? html`<div class="said">${x.note}</div>` : ""}</span>
    </li>`)}</ul>`;
  }
  return { key: "activity", tab: "activity", title: "Activity", body, empty: "Nothing here yet. Website requests, notes, calls, texts, quotes, visits and payments show up here." };
}

function consentCard(s, ctx) {
  const c = s.contact;
  return { key: "consent", tab: "conversation", title: "Texts and email", edit: ctx.can("consent:edit") ? { label: "Change texts and email", data: { consent: true } } : null,
    body: html`<dl class="kv">${Object.entries(CONSENT).map(([k, label]) => html`<dt>${label}</dt><dd>${consentPill((c.consent && c.consent[k] && c.consent[k].state) || "unknown")}</dd>`)}</dl>
      ${c.automations_paused ? html`<div class="warn-box ct-warn">Automated ${Object.keys(c.automations_paused).map((k) => (k === "sms" ? "texts" : "email")).join(" and ")} paused: ${Object.values(c.automations_paused).map((x) => x.reason).join("; ")}</div>` : ""}
      <p class="small muted ct-fine">An opt-out (STOP) is per number and always wins; see Settings → Messaging.</p>` };
}

// The Service tab's tiles (Rotor's: Scheduled jobs 1/3, Avg completed job, Avg future job, Outstanding): info
// only, from what the modules tell (their tiles(state)). → [{ key, label, value, money?, tone? }]
export function serviceTiles(s) {
  const out = [];
  for (const r of s.secs || []) {
    if (!r.mod || typeof r.mod.tiles !== "function" || !r.state || r.state.denied) continue;
    try { out.push(...(r.mod.tiles(r.state, r.ctx) || []).filter(Boolean)); } catch (e) { /* a part never breaks the page */ }
  }
  return out.map((t) => ({ ...t, info: true }));
}
function tilesOf(s, ctx) {
  const out = serviceTiles(s);
  const bal = headerNumbers(s, ctx.can).find((n) => n.key === "balance");
  if (bal && !out.some((t) => t.key === "owed")) out.push({ key: "owed", label: "Outstanding", value: bal.value === "-" ? "$0" : bal.value.replace(/\.00$/, ""), tone: bal.bad ? "red" : null, info: true });
  return out;
}

// Mute (Rotor's switch, up front): automated texts paused or not; a tap opens the same pause sheet as the "...".
function muteRow(s, ctx) {
  if (!ctx.can("consent:edit")) return "";
  const p = s.contact.automations_paused && s.contact.automations_paused.sms;
  return html`<div id="ct-mute">${formRows([formRow(html`<span class="ct-mute-l">${icon("bell")}Mute</span>`, toggle(!!p, { data: { mute: true }, label: "Mute automated messages" }), { hint: p ? `Paused: ${p.reason || "no reason given"}` : "Reminders and follow-up texts go out" })])}</div>`;
}

// Files (Rotor's Attachments tab, as a card): photos and PDFs kept on the contact; + adds one.
const kb = (n) => (n >= 1e6 ? `${(n / 1e6).toFixed(1)} MB` : `${Math.max(1, Math.round(n / 1000))} KB`);
function filesCard(s, ctx) {
  if (s.files === undefined || !ctx.can("contacts:read_all")) return null;
  const list = s.files || [];
  return {
    key: "files", tab: "files", title: "Files", count: list.length ? String(list.length) : null, empty: "No files yet",
    add: ctx.can("contacts:write") ? { label: "Add a file", data: { "add-file": true } } : null,
    body: s.files === null ? loadingBody : list.length ? html`<ul class="list ct-files">${list.map((f) => html`<li><a class="row" ${attrs({ href: f.url, target: "_blank", rel: "noopener" })}><span class="ico">${icon(f.content_type === "application/pdf" ? "doc" : "camera")}</span><span class="who"><span class="nm">${f.caption || (f.content_type === "application/pdf" ? "PDF" : "Photo")}</span><span class="sub">${dateShort(f.created_at)} · ${kb(f.bytes || 0)}</span></span><span class="chev" aria-hidden="true"></span></a></li>`)}</ul>` : null,
  };
}

const byOrder = (order) => (a, b) => {
  const i = (k) => { const n = order.indexOf(k); return n < 0 ? 900 : n; };
  return i(a.sortKey || a.key) - i(b.sortKey || b.key);
};

// ------------------------------------------------------------ the "..."

// Every other action of the page, in Rotor's groups; Archive and Mark lost red at the end.
function moreGroups(s, ctx) {
  if (!s || s.redirect || !s.contact) return [];
  const c = s.contact;
  const write = ctx.can("contacts:write");
  const mods = new Map();
  for (const r of s.secs || []) {
    if (!r.mod || typeof r.mod.actions !== "function" || !shown(r)) continue;
    try { for (const a of r.mod.actions(r.state || {}, r.ctx) || []) if (a && !mods.has(a.key)) mods.set(a.key, a); } catch (e) { /* a part never breaks the sheet */ }
  }
  const order = lead(s) ? LEAD_ACTS : CUSTOMER_ACTS;
  const named = new Set(order.flat());
  const groups = order.map((keys) => keys.map((k) => mods.get(k)).filter(Boolean));
  const extra = [...mods.values()].filter((a) => !named.has(a.key) && !a.danger);
  if (extra.length) groups[1] = [...groups[1], ...extra];
  const red = [...mods.values()].filter((a) => !named.has(a.key) && a.danger);
  const archived = c.lifecycle === "archived";
  groups.push([
    write && { label: lead(s) ? "Edit lead" : "Edit", icon: "edit", href: "#/contacts/" + encodeURIComponent(c.id) + "/edit" },
    write && lead(s) && { label: "Priority", icon: "flag", hint: PRIORITY[c.priority] || "None", run: () => prioritySheet(ctx), data: { priority: true } },
    write && ctx.can("schedule:read") && { label: "Owner", icon: "user", hint: c.owner_id ? userName(s, c.owner_id) : "Unassigned", run: () => pickOwner(ctx), data: { "pick-owner": true } },
    ctx.can("consent:edit") && { label: "Texts and email", icon: "chat", hint: "consent", run: () => consentSheet(ctx), data: { consent: true } },
    write && { label: "Add a note", icon: "doc", run: () => noteSheet(ctx), data: { note: true } },
    write && { label: "Add a property", icon: "building", run: () => propertySheet(ctx), data: { "add-prop": true } },
  ]);
  groups.push([
    write && ctx.can("contacts:merge") && !archived && { label: "Merge with...", icon: "merge", run: () => mergeFlow(ctx), data: { merge: true } },
    ctx.can("consent:edit") && { label: c.automations_paused && c.automations_paused.sms ? "Resume automated texts" : "Pause automated texts", icon: "pause", run: () => pauseSheet(ctx), data: { pause: true } },
    write && !archived && { label: "Open their portal", icon: "share", hint: "what they see", run: () => openPortal(ctx), data: { portal: true } },
    ctx.can("settings:owner") && { label: c.flags && c.flags.test ? "Not a test contact" : "Mark as test contact", icon: "user", run: () => setTest(ctx), data: { test: true } },
    write && archived && { label: "Restore", icon: "undo", run: () => restore(ctx), data: { restore: true } },
    ...red,
    write && !archived && { label: "Archive", icon: "archive", danger: true, run: () => archiveSheet(ctx), data: { archive: true } },
  ]);
  return groups;
}

// ------------------------------------------------------------ the page

// Rotor's buttons at the foot of the profile: Create Customer (a lead), Edit, Portal and the "..." (the header's).
function profileButtons(s, ctx) {
  const c = s.contact;
  const write = ctx.can("contacts:write");
  const archived = c.lifecycle === "archived";
  return html`<div class="ct-btns">
    ${lead(s) && write ? pillBtn("Create Customer", { tone: "red", wide: true, data: { "make-customer": true }, aria: "Make this lead a customer" }) : ""}
    <div class="ct-btn-row">
      ${write ? pillBtn("Edit", { icon: "edit", tone: "solid", href: "#/contacts/" + encodeURIComponent(c.id) + "/edit", aria: lead(s) ? "Edit lead" : "Edit customer" }) : ""}
      ${write && !archived ? pillBtn("Portal", { icon: "share", data: { portal: true }, aria: "Open their portal" }) : ""}
      ${rnd("more", "More actions", { tone: "grey", sm: true, popup: true, data: { "ct-more": true } })}
    </div>
  </div>`;
}

// A module's row that makes something (New request, Add ...): the red +'s; any other: the pencil's.
const MAKES = /^(new|add|book|log|start|text)\b/i;
// The page's own actions, by the modules' keys (a part never breaks the page).
function modActions(s) {
  const mods = new Map();
  for (const r of s.secs || []) {
    if (!r.mod || typeof r.mod.actions !== "function" || !shown(r)) continue;
    try { for (const a of r.mod.actions(r.state || {}, r.ctx) || []) if (a && !mods.has(a.key)) mods.set(a.key, a); } catch (e) { /* a part never breaks the sheet */ }
  }
  return mods;
}

// The red + on a customer's phone page (Rotor's: it makes things): a job, a quote, a plan, an invoice; credit and a
// card link; a call, a follow-up, a task; a note, a property, a file.
export function createGroups(s, ctx) {
  if (!s || !s.contact || s.contact.lifecycle === "archived") return [];
  const mods = modActions(s);
  const write = ctx.can("contacts:write");
  const pick = (keys) => keys.map((k) => mods.get(k)).filter(Boolean);
  return [
    pick(["book", "quote", "plan", "invoice"]),
    pick(["credit", "cardlink"]),
    pick(["call", "follow", "task"]),
    [...mods.values()].filter((a) => !CUSTOMER_ACTS.flat().includes(a.key) && !a.danger && MAKES.test(String(a.label || ""))),
    [
      write && { label: "Add a note", icon: "doc", run: () => noteSheet(ctx), data: { note: true } },
      write && { label: "Add a property", icon: "building", run: () => propertySheet(ctx), data: { "add-prop": true } },
      write && ctx.can("contacts:read_all") && { label: "Add a file", icon: "camera", run: () => addFile(ctx), data: { "add-file": true } },
    ].filter(Boolean),
  ].filter((g) => g.length);
}

// The pencil on a customer's phone page (Rotor's header has only it): edit them, and every other change.
export function editGroups(s, ctx) {
  if (!s || !s.contact) return [];
  const c = s.contact;
  const write = ctx.can("contacts:write");
  const archived = c.lifecycle === "archived";
  const mods = modActions(s);
  const named = new Set(CUSTOMER_ACTS.flat());
  const extra = [...mods.values()].filter((a) => !named.has(a.key) && (a.danger || !MAKES.test(String(a.label || ""))));
  const paused = !!(c.automations_paused && c.automations_paused.sms);
  return [
    [
      write && { label: "Edit details", icon: "edit", hint: "name, phones, emails", href: "#/contacts/" + encodeURIComponent(c.id) + "/edit", data: { "edit-details": true } },
      write && ctx.can("schedule:read") && { label: "Owner", icon: "user", hint: c.owner_id ? userName(s, c.owner_id) : "Unassigned", run: () => pickOwner(ctx), data: { "pick-owner": true } },
      ctx.can("consent:edit") && { label: "Texts and email", icon: "chat", hint: "consent", run: () => consentSheet(ctx), data: { consent: true } },
      ctx.can("consent:edit") && { label: "Automations", icon: "bell", hint: paused ? "Off (muted)" : "On", run: () => pauseSheet(ctx), data: { automations: true, mute: true } },
    ].filter(Boolean),
    [
      write && ctx.can("contacts:merge") && !archived && { label: "Merge with...", icon: "merge", run: () => mergeFlow(ctx), data: { merge: true } },
      write && !archived && { label: "Open their portal", icon: "share", hint: "what they see", run: () => openPortal(ctx), data: { portal: true } },
      ctx.can("settings:owner") && { label: c.flags && c.flags.test ? "Not a test contact" : "Mark as test contact", icon: "user", run: () => setTest(ctx), data: { test: true } },
      ...extra.filter((a) => !a.danger),
    ].filter(Boolean),
    [
      write && !archived && customer(s) && { label: "Convert to Lead", icon: "userplus", hint: "keeps their history", run: () => toLead(ctx), data: { "to-lead": true } },
      write && archived && { label: "Restore", icon: "undo", run: () => restore(ctx), data: { restore: true } },
      ...extra.filter((a) => a.danger),
      write && !archived && { label: "Archive", icon: "archive", danger: true, run: () => archiveSheet(ctx), data: { archive: true } },
    ].filter(Boolean),
  ].filter((g) => g.length);
}
const firstName = (c) => c.first_name || String(c.display_name || "").split(" ")[0] || "them";

// Rotor's phone page for a customer: Details | Service | Activity, the round pencil in the header, the red + at the foot.
function renderPhone(s, ctx) {
  const c = s.contact;
  const write = ctx.can("contacts:write");
  const archived = c.lifecycle === "archived";
  const all = [...moduleCards(s, ctx, true), propertiesCard(s, ctx), filesCard(s, ctx), activityCard(s), consentCard(s, ctx)].filter(Boolean);
  const on = (key) => all.filter((x) => phonePaneOf(x) === key).sort(byOrder(PHONE_CARDS[key]));
  const pane = PHONE_PANES.some(([k]) => k === s.ppane) ? s.ppane : "details";
  const details = on("details");
  const pay = details.filter((x) => x.key === "payment");
  const rest = details.filter((x) => x.key !== "payment");
  const notes = notesCard(s, ctx);
  const tiles = tilesOf(s, ctx);
  const makes = createGroups(s, ctx).length > 0;
  const body = {
    details: html`${summary(s, ctx)}
      ${sectionLabel("Contact")}${contactCard(s, ctx)}
      ${pay.map(phoneCard)}
      <section class="ct-pnotes" id="ct-card-notes" data-card="notes" aria-label="${notes.title}"><h3 class="ct-pn-h">${notes.title}</h3>
        ${notes.body || html`<p class="ct-pc-e">${notes.empty}</p>`}</section>
      <div class="ct-rows-p">
        ${queuedLine(s)}
        ${phoneFacts(s, ctx)}
        ${write && !archived ? disclosure("Their portal", { sub: "what they see, for 15 minutes", data: { portal: true } }) : ""}
        ${write && archived ? disclosure("Restore", { sub: "back on the lists, with everything", data: { restore: true } }) : ""}
      </div>
      ${rest.map(phoneCard)}`,
    service: html`${on("service").length ? on("service").map(phoneCard) : html`<p class="ct-pc-e">No jobs, plans or quotes yet</p>`}
      ${tiles.length ? html`${sectionLabel("At a glance")}<div class="ct-tiles-in" id="ct-svc-tiles">${tileRow(tiles, { name: "svc", label: "Service" })}</div>` : ""}`,
    activity: on("activity").map(phoneCard),
  };
  const paneDiv = ([key, label]) => html`<div ${attrs({ class: "ct-pane rs-page" + (pane === key ? "" : " off"), "data-pane": key, role: "tabpanel", "aria-label": label })}>${body[key]}</div>`;
  return html`<div class="rs-page ct-page ct-phone">
    ${s.offline ? html`<div class="note">Offline: this is the last copy on this phone.</div>` : ""}
    ${top(s, ctx)}
    <div class="ct-seg">${seg(PHONE_PANES, pane, { name: "ctab", label: "Customer" })}</div>
    <div class="ct-panes">${PHONE_PANES.map(paneDiv)}</div>
    ${c.updated_at ? html`<p class="foot-note">Changed ${ago(c.updated_at)}</p>` : ""}
    ${makes ? html`<button type="button" class="ct-fab" data-ct-fab aria-haspopup="dialog" ${attrs({ "aria-label": `New for ${firstName(c)}` })}>${icon("plus")}</button>` : ""}
  </div>`;
}

function render(s, ctx) {
  if (s.redirect) return html``;
  if (phoneLayout(s)) return renderPhone(s, ctx);
  if (s.tech) {
    return html`<div class="rs-page ct-page tech">
      ${s.offline ? html`<div class="note">Offline: this is the last copy on this phone.</div>` : ""}
      ${top(s, ctx)}${reach(s, ctx)}${card(propertiesCard(s, ctx))}
    </div>`;
  }
  const isLead = lead(s);
  const panes = isLead ? LEAD_PANES : PANES;
  const all = [...moduleCards(s, ctx), propertiesCard(s, ctx), filesCard(s, ctx), activityCard(s), consentCard(s, ctx)].filter(Boolean);
  const on = (key) => all.filter((x) => (x.mod ? x.tab : paneOf(x)) === key).sort(byOrder(key === "service" && isLead ? SERVICE_LEAD : PANE_CARDS[key]));
  const pane = panes.some(([k]) => k === s.pane) ? s.pane : panes[0][0];
  const tiles = tilesOf(s, ctx);
  const none = (text) => html`<div class="rs-card"><p class="rs-empty">${text}</p></div>`;
  const body = {
    service: html`${tiles.length ? html`<div class="ct-tiles-in" id="ct-svc-tiles">${tileRow(tiles, { name: "svc", label: "Service" })}</div>` : ""}
      ${on("service").length ? on("service").map(card) : none("No jobs, plans or quotes yet")}`,
    payments: on("payments").length ? on("payments").map(card) : none(ctx.can("invoices:read_all") ? "No invoices yet" : "Payments are for the office"),
    conversation: on("conversation").map(card),
    opportunities: on("opportunities").length ? on("opportunities").map(card) : none(ctx.can("sales:work") ? "No follow-ups, deals or tasks yet" : "Follow-ups and deals are for the office"),
    activity: on("activity").map(card),
    files: on("files").length ? on("files").map(card) : none("Files are for the office"),
  };
  const paneDiv = ([key, label]) => html`<div ${attrs({ class: "ct-pane rs-page" + (pane === key ? "" : " off"), "data-pane": key, role: "tabpanel", "aria-label": label })}>${body[key]}</div>`;
  const notes = notesCard(s, ctx);
  return html`<div class="rs-page ct-page">
    ${s.offline ? html`<div class="note">Offline: this is the last copy on this phone.</div>` : ""}
    <div class="ct-grid">
      <div class="ct-prof rs-page" aria-label="${isLead ? "Lead" : "Customer"}">
        ${top(s, ctx)}
        ${summary(s, ctx)}
        ${reach(s, ctx)}
        ${muteRow(s, ctx)}
        ${queuedLine(s)}
        ${satellite(s, ctx)}
        ${card(notes)}
        ${factsCard(s, ctx)}
        ${profileButtons(s, ctx)}
      </div>
      <div class="ct-main">
        <div class="ct-seg">${seg(panes, pane, { name: "ctab", label: isLead ? "Lead" : "Customer", scroll: true })}</div>
        <div class="ct-panes">${panes.map(paneDiv)}</div>
      </div>
    </div>
    ${s.contact.updated_at ? html`<p class="foot-note">Changed ${ago(s.contact.updated_at)}</p>` : ""}
  </div>`;
}

// A list longer than a few rows shows the latest few and "Show all" (kept per list while this contact is open).
function clipLists(view, ctx) {
  const open = ctx.keep.open || (ctx.keep.open = {});
  for (const box of view.querySelectorAll(".ct-clip")) {
    [...box.querySelectorAll("ul.list, ul.tl")].forEach((ul, i) => {
      const key = `${box.dataset.clip}:${i}`;
      const n = ul.children.length;
      if (n <= SHOW + 1 || open[key] || ul.dataset.clipped) return;
      ul.dataset.clipped = "1";
      ul.classList.add("ct-clipped");
      const b = document.createElement("button");
      b.type = "button";
      b.className = "rs-pb ct-more";
      b.dataset.showall = key;
      b.textContent = `Show all ${n}`;
      ul.after(b);
    });
  }
}

// Another tab without drawing the page again (the satellite stays put).
function showPane(view, ctx, key) {
  if (view.querySelector(".ct-phone")) ctx.state.ppane = ctx.keep.ppane = key;
  else ctx.state.pane = ctx.keep.pane = key;
  for (const p of view.querySelectorAll(".ct-pane")) p.classList.toggle("off", p.dataset.pane !== key);
  for (const b of view.querySelectorAll("[data-seg=ctab]")) { const on = b.dataset.key === key; b.setAttribute("aria-selected", on ? "true" : "false"); b.tabIndex = on ? 0 : -1; }
}

async function after(ctx, p, ok) {
  try { await p; forgetIndex(); toast(ok); ctx.refresh(); } catch (err) { toast(err.message || "That didn't save.", { bad: true }); if (err.status === 412) ctx.refresh(); }
}

function noteSheet(ctx) {
  const s = sheet({
    title: "Add a note",
    body: html`<form class="form" id="note-f" novalidate><div class="err" data-form-err hidden></div>
      <label class="field" data-field="text"><span>Note</span><textarea name="text" rows="5" maxlength="4000" required></textarea><small class="why" hidden></small></label>
      <button type="submit" class="btn primary block">Save note</button></form>`,
    events: {
      "submit #note-f": async (e, form) => {
        e.preventDefault(); clearErrors(form);
        const btn = form.querySelector("[type=submit]"); busy(btn, true);
        try { await ctx.api(`/contacts/${encodeURIComponent(ctx.state.contact.id)}/notes`, { method: "POST", body: { text: readForm(form).text } }); s.close(); toast("Note saved"); ctx.refresh(); }
        catch (err) { busy(btn, false); showError(form, err); }
      },
    },
  });
}

function consentSheet(ctx) {
  const c = ctx.state.contact;
  const opts = Object.entries(CONSENT_STATE).map(([value, label]) => ({ value, label }));
  const s = sheet({
    title: "Texts and email",
    body: html`<form class="form" id="consent-f" novalidate><div class="err" data-form-err hidden></div>
      ${Object.entries(CONSENT).map(([k, label]) => select({ label, name: k, value: (c.consent && c.consent[k] && c.consent[k].state) || "unknown", options: opts }))}
      ${select({ label: "How they told us", name: "source", value: "verbal", options: [{ value: "verbal", label: "They told us (call, in person)" }, { value: "manual", label: "Something else" }] })}
      <button type="submit" class="btn primary block">Save</button></form>`,
    events: {
      "submit #consent-f": async (e, form) => {
        e.preventDefault(); clearErrors(form);
        const v = readForm(form);
        const btn = form.querySelector("[type=submit]"); busy(btn, true);
        try {
          for (const k of Object.keys(CONSENT)) {
            const cur = (c.consent && c.consent[k] && c.consent[k].state) || "unknown";
            if (v[k] !== cur) await ctx.api(`/contacts/${encodeURIComponent(c.id)}/consent`, { method: "PATCH", body: { channel: k, state: v[k], source: v.source } });
          }
          s.close(); toast("Saved"); ctx.refresh();
        } catch (err) { busy(btn, false); showError(form, err); }
      },
    },
  });
}

function pauseSheet(ctx) {
  const c = ctx.state.contact;
  if (c.automations_paused && c.automations_paused.sms) {
    after(ctx, ctx.api(`/contacts/${encodeURIComponent(c.id)}/automations-paused`, { method: "PATCH", body: { channel: "sms", paused: false } }), "Automated texts resumed");
    return;
  }
  const s = sheet({
    title: "Pause automated texts",
    body: html`<form class="form" id="pause-f" novalidate><div class="err" data-form-err hidden></div>
      <p class="muted small">Reminders and follow-up texts skip them; texts a person sends still go out.</p>
      ${field({ label: "Why", name: "reason", value: "Call, don't text reminders", required: true })}
      <button type="submit" class="btn primary block">Pause</button></form>`,
    events: {
      "submit #pause-f": async (e, form) => {
        e.preventDefault(); clearErrors(form);
        const btn = form.querySelector("[type=submit]"); busy(btn, true);
        try { await ctx.api(`/contacts/${encodeURIComponent(c.id)}/automations-paused`, { method: "PATCH", body: { channel: "sms", paused: true, reason: readForm(form).reason } }); s.close(); toast("Paused"); ctx.refresh(); }
        catch (err) { busy(btn, false); showError(form, err); }
      },
    },
  });
}

function archiveSheet(ctx) {
  const c = ctx.state.contact;
  const s = sheet({
    title: "Archive this contact",
    body: html`<form class="form" id="arch-f" novalidate><div class="err" data-form-err hidden></div>
      <p class="muted small">Archived contacts leave the lists but keep their history. Their portal links stop working. You can restore them.</p>
      ${select({ label: "Why", name: "reason", value: "do_not_contact", options: ARCHIVE_REASONS })}
      <button type="submit" class="btn danger block">Archive</button></form>`,
    events: {
      "submit #arch-f": async (e, form) => {
        e.preventDefault();
        const btn = form.querySelector("[type=submit]"); busy(btn, true);
        try { await ctx.api(`/contacts/${encodeURIComponent(c.id)}/archive`, { method: "POST", body: { reason: readForm(form).reason } }); s.close(); forgetIndex(); toast("Archived"); ctx.refresh(); }
        catch (err) { busy(btn, false); showError(form, err); }
      },
    },
  });
}

async function mergeFlow(ctx) {
  const c = ctx.state.contact;
  const other = await pickContact(ctx.api, { title: "Merge which contact into this one?" });
  if (!other) return;
  if (other.id === c.id) { toast("That's this contact."); return; }
  const yes = await confirmSheet(`Keep ${c.display_name} and move ${other.name}'s numbers, emails, notes, properties and history into it. ${other.name} is archived as a duplicate. This can't be undone.`, { title: "Merge into this contact?", yes: "Merge" });
  if (!yes) return;
  try {
    const r = await ctx.api(`/contacts/${encodeURIComponent(c.id)}/merge`, { method: "POST", body: { other_id: other.id } });
    toast("Merging…");
    const run = await followRun(ctx, r.data.run_id);
    forgetIndex();
    toast(run && run.status === "done" ? "Merged" : run && run.status === "failed" ? "The merge stopped. Check Merge review." : "Still merging; it finishes in the background.", { bad: !!(run && run.status === "failed") });
    ctx.refresh();
  } catch (err) { toast(err.message || "That didn't start.", { bad: true }); }
}

function propertySheet(ctx) {
  const c = ctx.state.contact;
  const s = sheet({
    title: "Add a property",
    body: html`<form class="form" id="prop-f" novalidate><div class="err" data-form-err hidden></div>
      ${field({ label: "Name", name: "label", value: (ctx.state.properties || []).length ? "Cabin" : "Home" })}
      ${field({ label: "Street", name: "street1", autocomplete: "address-line1", required: true })}
      <div class="addr-grid">${field({ label: "Town", name: "city", autocomplete: "address-level2" })}${field({ label: "State", name: "state", value: "MN", autocomplete: "address-level1", maxlength: 2 })}${field({ label: "ZIP", name: "zip", inputmode: "numeric", autocomplete: "postal-code", maxlength: 10 })}</div>
      ${field({ label: "Gate code (optional)", name: "gate_code" })}
      <button type="submit" class="btn primary block">Add property</button></form>`,
    events: {
      "submit #prop-f": async (e, form) => {
        e.preventDefault(); clearErrors(form);
        const v = readForm(form);
        const btn = form.querySelector("[type=submit]"); busy(btn, true);
        try {
          await ctx.api(`/contacts/${encodeURIComponent(c.id)}/properties`, { method: "POST", body: { label: v.label, address: { street1: v.street1, city: v.city, state: v.state, zip: v.zip }, access: v.gate_code ? { gate_code: v.gate_code } : {}, client_id: (globalThis.crypto && crypto.randomUUID && crypto.randomUUID()) || undefined } });
          s.close(); toast("Property added"); ctx.refresh();
        } catch (err) { busy(btn, false); showError(form, err); }
      },
    },
  });
}


// The lead's priority (Rotor's Low / Medium / High), or none.
async function prioritySheet(ctx) {
  const c = ctx.state.contact;
  const v = await pickFrom({ title: "Priority", items: [{ value: "high", label: "High" }, { value: "medium", label: "Medium" }, { value: "low", label: "Low" }, { value: "", label: "None", sub: c.priority ? "" : "now" }] });
  if (v === null || v === (c.priority || "")) return;
  after(ctx, ctx.api(`/contacts/${encodeURIComponent(c.id)}`, { method: "PATCH", body: { priority: v || null }, ifMatch: ctx.state.etag }), v ? `Priority: ${PRIORITY[v]}` : "No priority");
}

// The owner pill: someone on the team, or nobody.
async function pickOwner(ctx) {
  const c = ctx.state.contact;
  let users = [];
  try { users = ((await ctx.api("/users")).data || []).filter((u) => u.status === "active"); } catch (e) { toast(e.message || "The team didn't load.", { bad: true }); return; }
  const v = await pickFrom({ title: "Owner", items: [...users.map((u) => ({ value: u.id, label: u.name, sub: u.id === c.owner_id ? "now" : "" })), { value: "", label: "Unassigned", sub: c.owner_id ? "" : "now" }] });
  if (v === null || v === (c.owner_id || "")) return;
  after(ctx, ctx.api(`/contacts/${encodeURIComponent(c.id)}`, { method: "PATCH", body: { owner_id: v || null }, ifMatch: ctx.state.etag }), "Owner saved");
}

const setTest = (ctx) => after(ctx, ctx.api(`/contacts/${encodeURIComponent(ctx.state.contact.id)}/flags`, { method: "PATCH", body: { test: !(ctx.state.contact.flags && ctx.state.contact.flags.test) } }), "Saved");
const restore = (ctx) => after(ctx, ctx.api(`/contacts/${encodeURIComponent(ctx.state.contact.id)}/restore`, { method: "POST", body: {} }), "Restored");

// Create Customer (Rotor's, on a lead): the lead becomes a customer (the contact keeps everything; converted_at is set).
async function makeCustomer(ctx) {
  const c = ctx.state.contact;
  if (!(await confirmSheet(`Make ${c.display_name || "this lead"} a customer? They move to Customers and keep their history.`, { title: "Create customer", yes: "Create customer" }))) return;
  ctx.keep.pane = "service";
  after(ctx, ctx.api(`/contacts/${encodeURIComponent(c.id)}`, { method: "PATCH", body: { lifecycle: "customer" }, ifMatch: ctx.state.etag }), "Now a customer");
}

// Delay (Rotor's, on a pending job): the month it is due moves later; the work part loads again.
const DELAYS = [[1, "A month later"], [2, "2 months later"], [3, "3 months later"], [6, "6 months later"], [12, "A year later"]];
export function laterMonth(month, n) {
  const m = /^(\d{4})-(\d{2})$/.exec(String(month || ""));
  const base = m ? Number(m[1]) * 12 + Number(m[2]) - 1 : null;
  if (base === null) return null;
  const t = base + n;
  return `${Math.floor(t / 12)}-${String((t % 12) + 1).padStart(2, "0")}`;
}
async function delayJob(ctx, id) {
  let got;
  try { got = await ctx.api(`/jobs/${encodeURIComponent(id)}`, { cache: false }); } catch (err) { toast(err.message || "That job didn't load.", { bad: true }); return; }
  const job = (got.data && (got.data.job || got.data)) || {};
  const from = job.target_month || localDate(new Date()).slice(0, 7);
  const n = await pickFrom({ title: "Delay this job", items: DELAYS.map(([k, label]) => ({ value: String(k), label, sub: laterMonth(from, k) })) });
  if (!n) return;
  try {
    await ctx.api(`/jobs/${encodeURIComponent(id)}`, { method: "PATCH", body: { target_month: laterMonth(from, Number(n)) }, ifMatch: got.etag });
    toast("Delayed");
    const r = (ctx.state.secs || []).find((x) => x.def && x.def.module === "work");
    if (r) loadSection(ctx, r); else ctx.refresh();
  } catch (err) { toast(err.status === 412 ? "Someone else just changed this job. Try again." : err.message || "That didn't save.", { bad: true }); }
}

// Convert to Lead (Flyra's): the customer goes back to Leads and keeps everything (plans, jobs, invoices, history).
async function toLead(ctx) {
  const c = ctx.state.contact;
  if (!(await confirmSheet(`Move ${c.display_name || "this customer"} back to Leads? They keep their plans, jobs, invoices and history.`, { title: "Convert to lead", yes: "Convert to lead" }))) return;
  after(ctx, ctx.api(`/contacts/${encodeURIComponent(c.id)}`, { method: "PATCH", body: { lifecycle: "lead" }, ifMatch: ctx.state.etag }), "Now a lead");
}

// A pending job's "..." (a long press, or its round "..."): Schedule, Delay.
function pendingSheet(ctx, id) {
  if (!id || !ctx.can("schedule:write")) return;
  actionSheet("Pending job", [[
    { label: "Schedule", icon: "cal", hint: "book it", href: "#/jobs/" + encodeURIComponent(id), data: { "job-schedule": id } },
    { label: "Delay", icon: "clock", hint: "a later month", run: () => delayJob(ctx, id), data: { "job-delay": id } },
  ]]);
}

// "Open their portal": a 15-minute look at their page as they see it (nothing is paid, changed or counted).
async function openPortal(ctx) {
  try {
    const r = await ctx.api(`/contacts/${encodeURIComponent(ctx.state.contact.id)}/portal-view`, { method: "POST", body: {} });
    const sh = sheet({
      title: "Their portal",
      body: html`<p class="muted small">Their page as they see it. Nothing can be paid or changed from it, and it doesn't count as them looking. The link works once, for 15 minutes.</p><a class="btn primary block" ${openExternal(r.data.url)} data-close>${icon("share")}Open their page</a>`,
      events: { "click [data-close]": () => setTimeout(() => sh.close(), 0) },
    });
  } catch (err) { toast(err.message || "That didn't open.", { bad: true }); }
}

// A photo or a PDF for the Files card.
async function addFile(ctx) {
  const file = await capture({ accept: "image/*,application/pdf", camera: false });
  if (!file) return;
  toast("Uploading…");
  try { await uploadPhoto({ ownerType: "contact", ownerId: ctx.state.contact.id, kind: "document", file }); toast("File added"); loadFiles(ctx); }
  catch (err) { toast(err.message || "That didn't upload.", { bad: true }); }
}

// The notes box saves itself when it loses focus with new text (If-Match: someone else's change is never overwritten).
async function saveNotes(ctx, text) {
  const s = ctx.state;
  if (String(text || "") === String(s.contact.notes || "")) return;
  try {
    const r = await ctx.api(`/contacts/${encodeURIComponent(s.contact.id)}`, { method: "PATCH", body: { notes: text }, ifMatch: s.etag });
    s.contact = { ...s.contact, ...((r.data && r.data.contact) || { notes: text }) };
    s.etag = r.etag || s.etag;
    forgetIndex();
    toast("Notes saved");
  } catch (err) {
    toast(err.status === 412 ? "Someone else just changed this contact. Showing the latest." : err.message || "That didn't save.", { bad: true });
    if (err.status === 412) ctx.refresh();
  }
}

async function copyText(text) {
  // (the kit's: the Clipboard API, else the textarea fallback older iPhones need)
  if (await kitCopy(text)) toast("Copied");
  else toast("That didn't copy. Hold it to copy it.", { bad: true });
}

// The page draws again when the window crosses the phone's width (the phone page and the desk's are not the same).
let widthQ = null;
let widthCtx = null;
function watchWidth(ctx) {
  widthCtx = ctx;
  if (widthQ || typeof matchMedia !== "function") return;
  try {
    widthQ = matchMedia(PHONE_MEDIA);
    widthQ.addEventListener("change", () => { const c = widthCtx; if (c && c.state && c.state.contact && currentPath() === c.path) c.rerender(); });
  } catch (e) { widthQ = null; }
}

// ------------------------------------------------------------ the satellite

// The property's satellite view (the map module's aerial tiles, keyless by
// default: USGS). The tiles are fetched (the CSP lets the map's hosts in
// connect-src) and shown as blob: images, so nothing else is allowed in.
let aerialP = null;
const aerialOf = (ctx) => (aerialP || (aerialP = ctx.api("/map/knock").then((r) => (r.data && r.data.sources && r.data.sources.aerial) || null).catch(() => { aerialP = null; return null; })));
async function paintPhoto(el, ctx) {
  if (!el || el.dataset.painted) return;
  el.dataset.painted = "1";
  const [lat, lng] = el.dataset.photo.split(",").map(Number);
  const a = await aerialOf(ctx);
  if (!a || !a.tiles || typeof fetch !== "function") { el.remove(); return; }
  const z = Math.min(Number(a.maxzoom) || 16, 18);
  const n = 2 ** z;
  const r = (lat * Math.PI) / 180;
  const wx = ((lng + 180) / 360) * n * 256;
  const wy = ((1 - Math.log(Math.tan(r) + 1 / Math.cos(r)) / Math.PI) / 2) * n * 256;
  const scale = z >= 18 ? 1 : 2;
  const W = el.clientWidth || 360, H = el.clientHeight || 190;
  const x0 = wx - W / scale / 2, y0 = wy - H / scale / 2;
  const urls = [];
  let ok = 0;
  const jobs = [];
  for (let tx = Math.floor(x0 / 256); tx <= Math.floor((x0 + W / scale) / 256); tx++) {
    for (let ty = Math.floor(y0 / 256); ty <= Math.floor((y0 + H / scale) / 256); ty++) {
      const url = a.tiles.replace("{z}", z).replace("{x}", tx).replace("{y}", ty);
      jobs.push(fetch(url, { credentials: "omit" }).then((res) => (res.ok ? res.blob() : null)).then((b) => {
        if (!b || !el.isConnected) return;
        const u = URL.createObjectURL(b);
        urls.push(u);
        const img = document.createElement("img");
        img.alt = "";
        img.src = u;
        img.style.cssText = `left:${Math.round((tx * 256 - x0) * scale)}px;top:${Math.round((ty * 256 - y0) * scale)}px;width:${256 * scale}px;height:${256 * scale}px`;
        el.prepend(img);
        ok++;
      }).catch(() => {}));
    }
  }
  await Promise.all(jobs);
  if (!ok && el.isConnected) el.remove();
  setTimeout(() => urls.forEach((u) => URL.revokeObjectURL(u)), 60000);
}

export default {
  // Rotor's lead page shows no title (the name is the page's own, big): the header's h1 keeps it for
  // screen readers and the window's name, out of sight on a phone (contacts.css)
  title: (s) => (s && s.contact ? s.contact.display_name || "Contact" : "Contact"),
  load,
  render,
  // (a customer on a phone: Rotor's header is the back button and the pencil, nothing else; the pencil opens the
  // edit sheet, whose first row is the edit form, and the red + at the foot makes things)
  tools: (s, ctx) => [
    s && s.contact && !s.tech && phoneLayout(s) ? (editGroups(s, ctx).length ? { icon: "edit", label: "Edit", run: () => actionSheet(s.contact.display_name || "Customer", editGroups(ctx.state || s, ctx)), data: { "ct-edit": true } } : null)
      : s && s.contact && !s.tech && ctx.can("contacts:write") && { icon: "edit", label: s.contact.lifecycle === "lead" ? "Edit lead" : "Edit", href: "#/contacts/" + encodeURIComponent(s.contact.id) + "/edit" },
  ],
  more: (s, ctx) => (s && s.tech ? [] : phoneLayout(s) ? [] : moreGroups(s, ctx)),
  moreTitle: (s) => (s && s.contact ? s.contact.display_name || "Contact" : "Contact"),
  mount(view, s, ctx) {
    if (s.redirect) return;
    watchWidth(ctx);
    if (!s.started) {
      s.started = true;
      for (const r of s.secs || []) loadSection(ctx, r);
      if (!s.tech) loadActivity(ctx);
      if (s.files === null) loadFiles(ctx);
    }
    clipLists(view, ctx);
    paintPhoto(view.querySelector(".ct-photo[data-photo]"), ctx);
    // an old tab link: to its card, once it's there
    if (s.jump && !s.jumped) {
      const r = (s.secs || []).find((x) => x.key === s.jump);
      const id = OLD_TAB[s.jump] || (r ? "ct-mod-" + r.key : null);
      if (!id) { s.jumped = true; return; }
      if ((r && r.loading) || (s.jump === "activity" && !s.activity)) return;
      const el = view.querySelector("#" + id);
      s.jumped = true;
      if (el) {
        const pane = el.closest(".ct-pane");
        if (pane && pane.classList.contains("off")) showPane(view, ctx, pane.dataset.pane);
        setTimeout(() => el.scrollIntoView({ block: "start" }), 0);
      }
    }
  },
  events: {
    "click [data-seg=ctab]": (e, el, ctx) => showPane(e.currentTarget || document.getElementById("view"), ctx, el.dataset.key),
    "click [data-showall]": (e, el, ctx) => { (ctx.keep.open || (ctx.keep.open = {}))[el.dataset.showall] = true; ctx.rerender(); },
    "click [data-retry-sec]": (e, el, ctx) => { const r = (ctx.state.secs || []).find((x) => x.key === el.dataset.retrySec); if (r) { loadSection(ctx, r); ctx.rerender(); } },
    "click [data-queued]": (e, el, ctx) => queuedSheet(ctx.state),
    "click [data-about]": (e, el, ctx) => { ctx.keep.about = !ctx.keep.about; ctx.rerender(); },
    "click [data-pick-owner]": (e, el, ctx) => pickOwner(ctx),
    "click [data-copy]": (e, el) => copyText(el.dataset.copy),
    "change [data-notes=ct-notes]": (e, el, ctx) => saveNotes(ctx, el.value),
    "click [data-note]": (e, el, ctx) => noteSheet(ctx),
    "click [data-consent]": (e, el, ctx) => consentSheet(ctx),
    "click [data-add-prop]": (e, el, ctx) => propertySheet(ctx),
    "click [data-mute]": (e, el, ctx) => pauseSheet(ctx),
    "click [data-add-file]": (e, el, ctx) => addFile(ctx),
    "click [data-portal]": (e, el, ctx) => openPortal(ctx),
    "click [data-ct-more]": (e, el, ctx) => actionSheet(ctx.state.contact.display_name || "Contact", moreGroups(ctx.state, ctx)),
    "click [data-make-customer]": (e, el, ctx) => makeCustomer(ctx),
    "click [data-job-delay]": (e, el, ctx) => { e.preventDefault(); delayJob(ctx, el.dataset.jobDelay); },
    "click [data-pend-more]": (e, el, ctx) => { e.preventDefault(); pendingSheet(ctx, el.dataset.pendMore); },
    "rs-hold [data-pend-hold]": (e, el, ctx) => pendingSheet(ctx, el.dataset.pendHold),
    "click [data-restore]": (e, el, ctx) => restore(ctx),
    "click [data-ct-fab]": (e, el, ctx) => actionSheet(`New for ${firstName(ctx.state.contact)}`, createGroups(ctx.state, ctx)),
    "click [data-ct-phone]": (e, el, ctx) => {
      const p = el.dataset.ctPhone;
      const ph = ((ctx.state.contact && ctx.state.contact.phones) || []).find((x) => x.e164 === p) || { e164: p };
      actionSheet(phoneText(p), [[{ label: "Call", icon: "call", href: telHref(p), data: { call: true } }, ph.sms !== false && { label: "Text", icon: "chat", href: smsHref(p), data: { sms: true } }].filter(Boolean)]);
    },
  },
};
