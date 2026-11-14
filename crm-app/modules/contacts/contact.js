// One contact (design §9.2 "Contact"): the lead page and the customer
// page, Rotor's (the owner, Nov 2026: "make it like Rotor, with the same
// capability as desktop"; build spec §4.1, §4.2). Nothing of the earlier
// page is gone; it moved into Rotor's places:
//
//   the header      round back · (no title: the name is the page's) · a
//                   round pencil (Edit) · the round "..." (every other
//                   action, in groups, Archive and Mark lost red at the end)
//   the name        30 px, a pill on the right: the lead's priority (Low,
//                   Medium, High: Rotor's) or, without one, the deal's stage
//                   ("Quoted", "New"); under it white pills: the plan
//                   (green), the owner (a tap picks one), "Lead since
//                   Nov 17" / "Customer since 2026", VIP, test, do not service
//   Details | Activity  segmented, remembered for this contact; on a wide
//                   screen both, side by side
//   Details         the stat card (a lead: STAGE, FOLLOW UP, VALUE, SOURCE,
//                   NEXT VISIT; a customer: BALANCE, LIFETIME, NEXT VISIT,
//                   PLAN, SOURCE; money only for someone who may see it),
//                   CONTACT rows (every phone with a grey round text and a red
//                   round call, every email with a round copy, the address
//                   with a round navigate), the satellite (a customer's under
//                   PRIMARY PROPERTY), then the modules' cards with a round +
//                   (Quotes, Follow-ups, Tasks, Visits, Plan, Invoices,
//                   Payment), Properties, "About to be sent" on one line (a
//                   sheet with the list), Notes (the box saves itself; + adds
//                   a dated note) and About (folded)
//   Activity        Messages, Calls, Deals, the timeline (Show all) and Texts
//                   and email (consent, Change)
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
// A technician sees only what the server gives them: the name, the numbers
// to call and the properties of their visits.

import { html, icon, sheet, toast, attrs, openExternal, confirmSheet, rnd, seg, cardHead, sectionLabel, statGrid, contactRows, statusPill, pillTap, notesBox, disclosure, addressCard } from "../../core/ui.js";
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

// Where a module's part goes when it has no cards() of its own (the old `place`): aside → Activity.
const MODULE_PLACES = new Set(["visits", "plan", "docs", "aside", "more"]);
// An old tab → the card it is now.
const OLD_TAB = { overview: "ct-stat", activity: "ct-card-activity", properties: "ct-card-properties", messages: "ct-mod-messages" };
const SHOW = 4;            // a long list shows this many, then "Show all"
// The cards in Rotor's order: a lead's, a customer's (a module's card not named here comes after, in module order).
export const LEAD_ORDER = Object.freeze(["quotes", "followups", "tasks", "visits", "plan", "invoices", "payment", "properties", "queued", "notes", "about"]);
export const CUSTOMER_ORDER = Object.freeze(["visits", "plan", "quotes", "invoices", "payment", "properties", "followups", "tasks", "queued", "notes", "about"]);
export const ACTIVITY_ORDER = Object.freeze(["messages", "calls", "deals", "activity", "consent"]);
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
  const r = await ctx.api(`/contacts/${encodeURIComponent(params.id)}`);
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
  // Details | Activity, remembered for this contact while the app is open (an old ?tab=activity link opens Activity)
  const pane = jump === "activity" || jump === "messages" ? "activity" : ctx.keep.pane || "details";
  return { ...d, etag: r.etag, tech, users, secs, activity: tech ? [] : null, jump, pane, offline: !!r.offline, started: false };
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

// A street-level photo of the property (Flyra's Apple Maps look) needs a
// paid key (Google Street View or Apple MapKit). Not built: an owner who
// adds one would fill this in (docs/CRM-CONTACTS.md). Until then the page
// shows the keyless aerial view instead.
export const STREET_PHOTO = null;

const sinceText = (s) => {
  const c = s.contact;
  const st = s.stats && s.stats.contacts;
  if (c.lifecycle === "customer" || c.lifecycle === "former_customer") return `${c.lifecycle === "customer" ? "Customer" : "Former customer, a customer"} since ${dateYear((st && st.customer_since) || c.created_at)}`;
  if (c.lifecycle === "lead") return `Lead since ${dateShort(c.created_at)}`;
  return c.created_at ? `Added ${dateYear(c.created_at)}` : "";
};
const two = (a) => (a ? [[a.street1, a.street2].filter(Boolean).join(", "), [a.city, [a.state, a.zip].filter(Boolean).join(", ")].filter(Boolean).join(", ")].filter(Boolean) : []);
const userName = (s, id) => (s.users.find((u) => u.id === id) || {}).name || "Someone on the team";
const primaryProp = (s) => (s.properties || []).find((p) => p.id === s.contact.primary_property_id) || (s.properties || [])[0] || null;
const hasHighTag = (c) => (c.tags || []).some((t) => String(t).toLowerCase() === "high priority");

// The pill right of the name: the lead's priority (Rotor's), else the deal's stage; a customer's priority only.
export function topPill(s, facts = {}) {
  const c = s.contact;
  if (PRIORITY[c.priority]) return statusPill(PRIORITY[c.priority], c.priority === "low" ? "grey" : "orange");
  if (hasHighTag(c)) return statusPill("High priority", "orange");
  if (c.lifecycle !== "lead") return c.lifecycle === "customer" ? "" : statusPill(LIFECYCLE[c.lifecycle] || c.lifecycle, c.lifecycle === "archived" ? "grey" : "amber");
  const word = facts.deal_status === "quoted" ? "Quoted" : facts.enrollment_id ? "Following up" : facts.deal_id ? "Open" : "New";
  return statusPill(word, word === "Following up" ? "amber" : "blue");
}

function top(s, ctx) {
  const c = s.contact;
  const facts = s.tech ? {} : fromSections(s, ctx);
  const plan = facts.plan || ((s.stats && s.stats.plans && (s.stats.plans.active_plan_ids || []).length) ? "On a plan" : "");
  const flags = c.flags || {};
  const owner = c.owner_id ? userName(s, c.owner_id) : "Unassigned";
  return html`<header class="ct-head" id="ct-head" aria-label="${c.display_name || "Contact"}">
    <div class="rs-name"><h2>${c.display_name || "No name"}</h2>${s.tech ? "" : topPill(s, facts)}</div>
    ${s.tech ? "" : html`<div class="rs-pills ct-pills">
      ${plan ? statusPill(plan, "fill-green", { icon: "swap" }) : ""}
      ${ctx.can("contacts:write") && ctx.can("schedule:read") ? pillTap(owner, { icon: "user", data: { "pick-owner": true }, aria: `Owner: ${owner}. Change` }) : statusPill(owner, "white", { icon: "user" })}
      ${sinceText(s) ? statusPill(sinceText(s), "white") : ""}
      ${flags.vip ? statusPill("VIP", "solid") : ""}${flags.test ? statusPill("Test contact", "blue") : ""}${flags.do_not_service ? statusPill("Do not service", "red") : ""}
    </div>`}
  </header>`;
}

// The stat card: a lead's deal and follow-up, a customer's money, the next visit, the source.
function stats(s, ctx) {
  const c = s.contact;
  const facts = fromSections(s, ctx);
  const nums = Object.fromEntries(headerNumbers(s, ctx.can, facts).map((n) => [n.key, n]));
  const src = (c.source && c.source.source) || "";
  const items = [];
  if (lead(s)) {
    const sales = ctx.can("sales:work");
    if (sales) {
      // (Rotor's stage is the pipeline's: the follow-up's name, "Estimate sent - not scheduled" → "Estimate sent"; its step is on the Follow-ups card)
      const stage = facts.pipeline ? String(facts.pipeline).split(" - ")[0] : facts.stage || (facts.deal_status === "quoted" ? "Quoted" : facts.deal_id ? "Open" : "New");
      items.push({ label: "Stage", value: stage, href: facts.deal_id ? "#/deals/" + encodeURIComponent(facts.deal_id) : facts.enrollment_id ? "#/enrollments/" + encodeURIComponent(facts.enrollment_id) : null });
      items.push({ label: "Follow up", value: facts.follow_up ? dateShort(facts.follow_up) : "-", href: facts.enrollment_id ? "#/enrollments/" + encodeURIComponent(facts.enrollment_id) : null });
      items.push({ label: "Value", value: facts.deal_value === undefined || facts.deal_value === null ? "-" : money(facts.deal_value).replace(/\.00$/, "") });
    }
    items.push({ label: "Source", value: src || "Not known", wide: sales });
    items.push({ label: "Next visit", value: nums.next.value });
  } else {
    if (nums.balance) items.push({ label: "Balance", value: nums.balance.value, tone: nums.balance.bad ? "red" : null });
    if (nums.lifetime) items.push({ label: "Lifetime", value: nums.lifetime.value });
    items.push({ label: "Next visit", value: nums.next.value });
    items.push({ label: "Plan", value: facts.plan || "None", wide: true });
    items.push({ label: "Source", value: src || "Not known" });
  }
  return html`<div id="ct-stat">${statGrid(items, { label: lead(s) ? "Lead details" : "Customer details" })}</div>`;
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
    ...emails.map((e) => ({ icon: "mail", label: "Email", value: e.address, href: mailHref(e.address), actions: [{ icon: "copy", label: "Copy the email", data: { copy: e.address } }] })),
    lines.length && (lead(s) || s.tech || !prop) && { icon: "pin", label: lead(s) ? "Address" : "Billing address", value: lines[0], sub: lines[1] || null, actions: [{ icon: "nav", label: "Directions", ext: directionsUrl(geo || addressLine(addr)) }] },
  ].filter(Boolean);
  return html`${sectionLabel("Contact")}${rows.length ? contactRows(rows) : html`<div class="rs-card"><p class="rs-empty">No phone, email or address on file</p></div>`}`;
}

// The property from above (the map's keyless aerial), and a customer's primary property over it.
function satellite(s, ctx) {
  const prop = primaryProp(s);
  const geo = prop && prop.geo && Number.isFinite(prop.geo.lat) && Number.isFinite(prop.geo.lng) ? prop.geo : null;
  const photo = !s.tech && geo && ctx.can("canvass:use") && hasRoute("/map");
  const lines = prop ? two(prop.address) : [];
  const pic = photo ? html`<div class="rs-sat ct-photo" ${attrs({ "data-photo": `${geo.lat},${geo.lng}`, role: "img", "aria-label": `Satellite view of ${lines[0] || "the property"}` })}><span class="ct-photo-l">Satellite</span></div>` : "";
  if (lead(s) || s.tech || !prop) return pic;
  const a = prop.access || {};
  return html`${sectionLabel("Primary property")}
    ${addressCard({ line1: lines[0] || prop.label || "Property", line2: [lines[1], a.gate_code ? `gate ${a.gate_code}` : ""].filter(Boolean).join(" · "), href: "#/properties/" + encodeURIComponent(prop.id), nav: directionsUrl(geo || addressLine(prop.address)), edit: ctx.can("contacts:write") ? { label: "Edit the property", href: "#/properties/" + encodeURIComponent(prop.id) } : null })}
    ${pic}`;
}

// ------------------------------------------------------------ the cards

const loadingBody = html`<div class="ct-loading" aria-busy="true"><span class="sk w70"></span><span class="sk w50"></span></div>`;
// One card: its head (title, count, a round +), its body or the one-line empty text.
function card(x) {
  return html`<section ${attrs({ class: "rs-card ct-card" + (x.cls ? " " + x.cls : ""), id: x.id || "ct-card-" + x.key, "data-card": x.key, "data-mod": x.mod || null, "aria-label": x.title })}>
    ${cardHead(x.title, { add: x.add || null, edit: x.edit || null, count: x.count })}
    ${x.body ? html`<div class="ct-cb ct-clip" ${attrs({ "data-clip": x.key })}>${x.body}</div>` : html`<p class="rs-empty">${x.empty || "Nothing yet"}</p>`}
  </section>`;
}

// What each module gives: its cards (or its old section as one card), a loading or failed card while it can't.
function moduleCards(s, ctx) {
  const out = [];
  for (const r of s.secs || []) {
    if (!shown(r)) continue;
    const def = r.def;
    const tab = def.place === "aside" ? "activity" : "details";
    const title = def.title || def.heading || def.label;
    // (where its old place sits in Rotor's order)
    const sortKey = { visits: "visits", plan: "plan", docs: "invoices", more: "followups", aside: "messages" }[def.place];
    if (r.loading) { out.push({ key: "mod-" + r.key, sortKey, mod: r.key, tab, title, body: loadingBody }); continue; }
    if (r.failed) { out.push({ key: "mod-" + r.key, sortKey, mod: r.key, tab, title, body: html`<div class="ct-failed"><p>${def.label || "This part"} didn't load. ${r.failed}</p><button type="button" class="btn small" ${attrs({ "data-retry-sec": r.key })}>Try again</button></div>` }); continue; }
    let list = null;
    if (typeof r.mod.cards === "function") { try { list = r.mod.cards(r.state || {}, r.ctx) || []; } catch (e) { list = null; } }
    if (!list) { out.push({ key: "mod-" + r.key, sortKey, mod: r.key, tab, title, body: r.mod.render(r.state || {}, r.ctx), cls: "ct-old" }); continue; }
    for (const x of list) out.push({ ...x, mod: r.key, tab: x.tab === "activity" ? "activity" : "details" });
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
    key: "properties", tab: "details", title: "Properties", count: list.length > 1 ? `${list.length} properties` : null, empty: "No property yet",
    add: ctx.can("contacts:write") ? { label: "Add a property", data: { "add-prop": true } } : null,
    body: list.length ? html`<ul class="list ct-props">${list.map((p) => {
      const n = notes(p);
      return html`<li><a class="row" href="${"#/properties/" + encodeURIComponent(p.id)}">
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
  return { key: "notes", tab: "details", title: customer(s) ? "Customer notes" : "Notes", add: write ? { label: "Add a dated note", data: { note: true } } : null,
    body: write ? notesBox(c.notes, { name: "ct-notes", label: "Notes", placeholder: lead(s) ? "Add notes for this lead..." : "Add notes for this customer...", rows: 3 }) : c.notes ? html`<p class="ct-pre">${c.notes}</p>` : null, empty: "No notes yet" };
}

function aboutCard(s, ctx) {
  const c = s.contact;
  const src = c.source || {};
  const open = !!ctx.keep.about;
  return html`<div id="ct-card-about" data-card="about">${disclosure("About", { sub: open ? null : "where they came from, owner, Rotor", data: { about: true } })}
    ${open ? html`<section class="rs-card ct-about"><dl class="kv">
      ${s.stats && s.stats.contacts && s.stats.contacts.customer_since ? html`<dt>Customer since</dt><dd>${dateShort(s.stats.contacts.customer_since)}</dd>` : ""}
      ${s.stats && s.stats.work && s.stats.work.last_service_on ? html`<dt>Last service</dt><dd>${dateShort(s.stats.work.last_service_on)}</dd>` : ""}
      <dt>Source</dt><dd>${src.qr_code && src.campaign ? `${src.campaign} (QR code) · ${src.source || "Website quote form"}` : src.source || "Not known"}${src.channel ? ` · heard from ${src.channel}` : ""}</dd>
      ${src.form || src.ad ? html`<dt>Meta</dt><dd>${[src.form, src.ad, src.campaign].filter(Boolean).join(" · ")}</dd>` : ""}
      ${src.county ? html`<dt>County</dt><dd>${src.county}</dd>` : ""}
      ${src.promo_code || src.referral_code ? html`<dt>Code</dt><dd>${src.referral_code || src.promo_code}</dd>` : ""}
      ${c.owner_id ? html`<dt>Owner</dt><dd>${userName(s, c.owner_id)}</dd>` : ""}
      ${PRIORITY[c.priority] ? html`<dt>Priority</dt><dd>${PRIORITY[c.priority]}</dd>` : ""}
      <dt>Added</dt><dd>${dateShort(c.created_at)}</dd>
      ${c.rotor && (c.rotor.customer_id || (c.rotor.lead_ids || []).length) ? html`<dt>Rotor</dt><dd>Linked${c.import ? " (imported)" : ""}</dd>` : html`<dt>Rotor</dt><dd>${c.intake_pending_rotor ? "Waiting for the next import to link it" : "Made in the CRM"}</dd>`}
    </dl>
    ${(c.tags || []).length ? html`<div class="ct-tags">${c.tags.map((t) => html`<span class="pill">${t}</span>`)}</div>` : ""}</section>` : ""}</div>`;
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
  return { key: "consent", tab: "activity", title: "Texts and email", edit: ctx.can("consent:edit") ? { label: "Change texts and email", data: { consent: true } } : null,
    body: html`<dl class="kv">${Object.entries(CONSENT).map(([k, label]) => html`<dt>${label}</dt><dd>${consentPill((c.consent && c.consent[k] && c.consent[k].state) || "unknown")}</dd>`)}</dl>
      ${c.automations_paused ? html`<div class="warn-box ct-warn">Automated ${Object.keys(c.automations_paused).map((k) => (k === "sms" ? "texts" : "email")).join(" and ")} paused: ${Object.values(c.automations_paused).map((x) => x.reason).join("; ")}</div>` : ""}
      <p class="small muted ct-fine">An opt-out (STOP) is per number and always wins; see Settings → Messaging.</p>` };
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
    ctx.can("settings:owner") && { label: c.flags && c.flags.test ? "Not a test contact" : "Mark as test contact", icon: "user", run: () => setTest(ctx), data: { test: true } },
    write && archived && { label: "Restore", icon: "undo", run: () => restore(ctx), data: { restore: true } },
    ...red,
    write && !archived && { label: "Archive", icon: "archive", danger: true, run: () => archiveSheet(ctx), data: { archive: true } },
  ]);
  return groups;
}

// ------------------------------------------------------------ the page

function render(s, ctx) {
  if (s.redirect) return html``;
  if (s.tech) {
    return html`<div class="rs-page ct-page tech">
      ${s.offline ? html`<div class="note">Offline: this is the last copy on this phone.</div>` : ""}
      ${top(s, ctx)}${reach(s, ctx)}${card(propertiesCard(s, ctx))}
    </div>`;
  }
  const mods = moduleCards(s, ctx);
  const details = [...mods.filter((x) => x.tab === "details"), propertiesCard(s, ctx), notesCard(s, ctx)].sort(byOrder(lead(s) ? LEAD_ORDER : CUSTOMER_ORDER));
  const activity = [...mods.filter((x) => x.tab === "activity"), activityCard(s), consentCard(s, ctx)].sort(byOrder(ACTIVITY_ORDER));
  const pane = s.pane === "activity" ? "activity" : "details";
  return html`<div class="rs-page ct-page">
    ${s.offline ? html`<div class="note">Offline: this is the last copy on this phone.</div>` : ""}
    ${top(s, ctx)}
    <div class="ct-seg">${seg([["details", "Details"], ["activity", "Activity"]], pane, { name: "ctab", label: lead(s) ? "Lead" : "Customer" })}</div>
    <div class="ct-panes">
      <div ${attrs({ class: "ct-pane rs-page" + (pane === "details" ? "" : " off"), "data-pane": "details", role: "tabpanel", "aria-label": "Details" })}>
        ${stats(s, ctx)}${reach(s, ctx)}${satellite(s, ctx)}
        ${details.map(card)}
        ${queuedLine(s)}
        ${aboutCard(s, ctx)}
      </div>
      <div ${attrs({ class: "ct-pane rs-page" + (pane === "activity" ? "" : " off"), "data-pane": "activity", role: "tabpanel", "aria-label": "Activity" })}>
        ${activity.map(card)}
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

// Details | Activity without drawing the page again (the satellite stays put).
function showPane(view, ctx, key) {
  ctx.state.pane = ctx.keep.pane = key;
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
  try { if (navigator.clipboard && navigator.clipboard.writeText) { await navigator.clipboard.writeText(text); toast("Copied"); return; } } catch (e) { /* fall through */ }
  toast("Hold the email to copy it.", { bad: true });
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
  // Rotor's lead page has no title: the name is the page's own
  title: () => "",
  load,
  render,
  tools: (s, ctx) => [s && s.contact && !s.tech && ctx.can("contacts:write") && { icon: "edit", label: s.contact.lifecycle === "lead" ? "Edit lead" : "Edit", href: "#/contacts/" + encodeURIComponent(s.contact.id) + "/edit" }],
  more: (s, ctx) => (s && s.tech ? [] : moreGroups(s, ctx)),
  moreTitle: (s) => (s && s.contact ? s.contact.display_name || "Contact" : "Contact"),
  mount(view, s, ctx) {
    if (s.redirect) return;
    if (!s.started) {
      s.started = true;
      for (const r of s.secs || []) loadSection(ctx, r);
      if (!s.tech) loadActivity(ctx);
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
  },
};
