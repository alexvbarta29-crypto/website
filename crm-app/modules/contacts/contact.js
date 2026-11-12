// One contact (design §9.2 "Contact"; the layout report, Nov 2026:
// "Customer pages should answer a phone call at a glance"). This is the
// screen open while a customer is on the line, so its top answers the
// caller: the name, the town and a plan badge, then three numbers (balance
// owed, lifetime spend, next visit; "-" when not known; the money two only
// for someone who may see money) and four buttons (Call · Text · Quote ·
// Book; Email and Directions fill in for someone who may not quote or
// book). On a phone the rest is ONE scrolling page of headed sections, no
// sideways tabs, in this order: upcoming visits; the service plan (apart
// from one-time jobs); quotes and invoices; properties with their access
// notes (gate code, dog, stories); "About to be sent" (what the modules
// know is queued for this person); follow-ups and tasks; the details
// (notes, how to reach them, texts and email, where they came from); then
// messages and the activity (calls, texts, visits, payments in one list).
// Long lists show the latest few with "Show all". On a wide screen the
// header stays put at the top and the activity has its own column.
//
// Modules add their sections through their manifests' `contactTabs`
// (the name stays; each entry is a section now):
//   { key, label, order, load: () => import("./contact-tab.js"),
//     place?: "visits" | "plan" | "docs" | "aside" | "more", heading?, perm? }
// `place` puts it under one of the page's headings (several modules share
// "docs": quotes, then invoices, each under its own small heading); one
// without a place gets a heading of its own (heading, else label) after
// "About to be sent". The module default-exports { load(params, ctx) →
// state, render(state, ctx) → html``, header?(state, ctx) → { plan?,
// next_visit? }, queued?(state, ctx) → [{ at, label, sub?, href? }] }; a
// state of { denied: true } leaves the section out. ctx.section is true;
// setting ctx.state.tabMod = null and calling ctx.rerender() loads that
// section again (Money's credit sheet does). Old links to a tab
// (#/contacts/{id}?tab=money, or a tab remembered from before) scroll to
// its section.
//
// A technician sees only what the server gives them: the name, the numbers
// to call and the properties of their visits.

import { html, icon, sheet, toast, attrs, openExternal, confirmSheet } from "../../core/ui.js";
import { field, select, readForm, clearErrors, showError, busy } from "../../core/forms.js";
import { dateShort, dateTime, money, ago, localDate } from "../../core/format.js";
import { pickContact } from "../../core/pickers.js";
import { directionsUrl } from "../../core/map.js";
import { has as hasRoute, currentPath } from "../../core/router.js";
import { MANIFESTS } from "../index.js";
import {
  ensureStyles, lifecyclePill, consentPill, CONSENT, CONSENT_STATE, ARCHIVE_REASONS, phoneText, telHref, smsHref, mailHref, addressLine,
  avatar, tierPill, forgetIndex, followRun, emptyCard,
} from "./kit.js";

// The page's places, in their order (a module's `place`; anything else is "more").
export const PLACES = Object.freeze([
  ["visits", "Upcoming visits"], ["plan", "Service plan"], ["docs", "Quotes and invoices"], ["properties", "Properties"],
  ["queued", "About to be sent"], ["more", ""], ["details", "Details"], ["aside", ""], ["activity", "Activity"],
]);
const MODULE_PLACES = new Set(["visits", "plan", "docs", "aside", "more"]);
// An old tab → where it is now.
const OLD_TAB = { overview: "ct-sec-details", activity: "ct-sec-activity", properties: "ct-sec-properties" };
const SHOW = 4;            // a long list shows this many, then "Show all"

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
  return { ...d, etag: r.etag, tech, users, secs, activity: tech ? [] : null, jump, offline: !!r.offline, started: false };
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
  return { ...ctx, section: true, state: slot, rerender: () => { if (rec.again) { rec.again = false; loadSection(ctx, rec); } else soon(ctx); }, refresh: () => ctx.refresh() };
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

// ------------------------------------------------------------ the header

const town = (s) => {
  const c = s.contact;
  const prop = (s.properties || []).find((p) => p.id === c.primary_property_id) || (s.properties || [])[0];
  return (prop && prop.address && prop.address.city) || (c.billing_address && c.billing_address.city) || "";
};

// What the sections tell the header (a plan's name, a nearer next visit).
function fromSections(s, ctx) {
  const out = {};
  for (const r of s.secs || []) {
    if (!r.mod || typeof r.mod.header !== "function" || !r.state || r.state.denied) continue;
    try { Object.assign(out, Object.fromEntries(Object.entries(r.mod.header(r.state, r.ctx) || {}).filter(([, v]) => v))); } catch (e) { /* a section never breaks the header */ }
  }
  return out;
}

// The three numbers: balance owed and lifetime spend (only for someone who
// may see money; the server leaves money out for anyone else), next visit.
// "-" when not known. → [{ key, label, value, bad? }]
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

function header(s, ctx) {
  const c = s.contact;
  const id = encodeURIComponent(c.id);
  const ph = (c.phones || []).find((p) => p.primary) || (c.phones || [])[0];
  const em = (c.emails || []).find((e) => e.primary) || (c.emails || [])[0];
  const prop = (s.properties || []).find((p) => p.id === c.primary_property_id) || (s.properties || [])[0];
  const where = prop ? addressLine(prop.address) : addressLine(c.billing_address);
  const flags = c.flags || {};
  const facts = s.tech ? {} : fromSections(s, ctx);
  const plan = facts.plan || ((s.stats && s.stats.plans && (s.stats.plans.active_plan_ids || []).length) ? "On a plan" : "");
  const act = (label, ic, a) => html`<a ${a}>${icon(ic)}<span>${label}</span></a>`;
  const off = (label, ic) => html`<span aria-disabled="true">${icon(ic)}<span>${label}</span></span>`;
  const acts = [
    ph ? act("Call", "phone", attrs({ href: telHref(ph.e164) })) : off("Call", "phone"),
    ph && ph.sms !== false ? act("Text", "text", attrs({ href: smsHref(ph.e164) })) : off("Text", "text"),
  ];
  if (!s.tech && ctx.can("quotes:write") && hasRoute("/quotes/new/" + id)) acts.push(act("Quote", "doc", attrs({ href: "#/quotes/new/" + id })));
  if (!s.tech && ctx.can("schedule:write") && hasRoute("/jobs/new/" + id)) acts.push(act("Book", "schedule", attrs({ href: "#/jobs/new/" + id })));
  if (acts.length < 4) acts.push(em ? act("Email", "mail", attrs({ href: mailHref(em.address) })) : off("Email", "mail"));
  if (acts.length < 4) acts.push(where ? act("Directions", "map", openExternal(directionsUrl(where))) : off("Directions", "map"));
  const nums = s.tech ? [] : headerNumbers(s, ctx.can, facts);
  const t = town(s);
  return html`<section class="card ct-hero" id="ct-hero" aria-label="${c.display_name || "Contact"}">
    <div class="ct-id">${avatar(c.display_name)}<div class="who">
      <h2>${c.display_name || "No name"}</h2>
      ${t ? html`<p class="ct-town">${t}</p>` : ""}
      <div class="pills">${plan ? html`<span class="pill ct-plan">${icon("schedule")}${plan}</span>` : ""}${c.lifecycle ? lifecyclePill(c.lifecycle) : ""}${flags.vip ? html`<span class="pill ink">VIP</span>` : ""}${flags.test ? html`<span class="pill blue">Test contact</span>` : ""}${flags.do_not_service ? html`<span class="pill red">Do not service</span>` : ""}</div>
    </div></div>
    ${nums.length ? html`<dl class="ct-nums">${nums.map((n) => html`<div class="${"ct-num" + (n.bad ? " bad" : "")}" ${attrs({ "data-num": n.key })}><dt>${n.label}</dt><dd class="num">${n.value}</dd></div>`)}</dl>` : ""}
    <div class="ct-acts">${acts}</div>
  </section>`;
}

// ------------------------------------------------------------ the sections

const userName = (s, id) => (s.users.find((u) => u.id === id) || {}).name || "Someone on the team";
const loadingCard = html`<div class="card ct-loading" aria-busy="true"><span class="sk w70"></span><span class="sk w50"></span></div>`;
const shown = (r) => !(r.state && r.state.denied);

function modBlock(r, sub) {
  if (r.loading) return html`<div class="ct-mod" ${attrs({ id: "ct-mod-" + r.key })}>${sub ? html`<h3 class="ct-sub-h">${sub}</h3>` : ""}${loadingCard}</div>`;
  if (r.failed) return html`<div class="ct-mod" ${attrs({ id: "ct-mod-" + r.key })}>${sub ? html`<h3 class="ct-sub-h">${sub}</h3>` : ""}<div class="card ct-failed"><p>${r.def.label || "This part"} didn't load. ${r.failed}</p><button type="button" class="btn small" ${attrs({ "data-retry-sec": r.key })}>Try again</button></div></div>`;
  return html`<div class="ct-mod ct-clip" ${attrs({ id: "ct-mod-" + r.key, "data-clip": r.key })}>${sub ? html`<h3 class="ct-sub-h">${sub}</h3>` : ""}${r.mod.render(r.state || {}, r.ctx)}</div>`;
}

const section = (key, heading, body, extra = "") => html`<section ${attrs({ class: "ct-sec ct-sec-" + key + (extra ? " " + extra : ""), id: "ct-sec-" + key, "aria-labelledby": heading ? "ct-h-" + key : null })}>${heading ? html`<h2 class="ct-sec-h" ${attrs({ id: "ct-h-" + key })}>${heading}</h2>` : ""}${body}</section>`;

// The modules placed under one heading (each with a small heading of its own when there are several).
function placed(s, place, heading) {
  const rs = (s.secs || []).filter((r) => r.def.place === place && shown(r));
  if (!rs.length) return "";
  return section(place, heading, html`${rs.map((r) => modBlock(r, rs.length > 1 ? r.def.title || r.def.label : ""))}`);
}

function properties(s, ctx) {
  const list = s.properties || [];
  const notes = (p) => {
    const a = p.access || {};
    const x = p.assets || {};
    return [a.gate_code ? `Gate ${a.gate_code}` : "", a.pets || "", x.stories ? `${x.stories} ${x.stories === 1 ? "story" : "stories"}` : "", a.parking ? `Parking: ${a.parking}` : "", a.notes || ""].filter(Boolean);
  };
  return section("properties", "Properties", html`${list.length ? html`<ul class="list ct-props">${list.map((p) => {
    const n = notes(p);
    return html`<li><a class="row" href="${"#/properties/" + encodeURIComponent(p.id)}">
      <span class="ico">${icon("building")}</span>
      <span class="who"><span class="nm">${p.label || "Property"}${p.id === s.contact.primary_property_id ? " · main" : ""}</span><span class="sub">${addressLine(p.address)}</span>${n.length ? html`<span class="ct-access">${n.join(" · ")}</span>` : ""}</span>
      <span class="end">${s.tech ? "" : tierPill(p.town_tier)}<span class="chev" aria-hidden="true"></span></span></a></li>`;
  })}</ul>` : emptyCard("No property yet", "Add the address where the work happens.", "building")}
    ${ctx.can("contacts:write") ? html`<div class="btn-row"><button type="button" class="btn" data-add-prop>${icon("plus")}Add a property</button></div>` : ""}`);
}

// "About to be sent": what the modules know is queued for this person.
function queued(s, ctx) {
  const c = s.contact;
  const rows = [];
  let any = false;
  for (const r of s.secs || []) {
    if (!r.mod || typeof r.mod.queued !== "function" || !r.state || r.state.denied) continue;
    any = true;
    try { rows.push(...(r.mod.queued(r.state, r.ctx) || [])); } catch (e) { /* a section never breaks the box */ }
  }
  const waiting = (s.secs || []).some((r) => r.loading && r.def.place !== "aside");
  if (!any && !waiting) return "";
  rows.sort((a, b) => String(a.at || "").localeCompare(String(b.at || "")));
  const paused = c.automations_paused && c.automations_paused.sms;
  const body = html`${paused ? html`<div class="warn-box">Automated texts are paused for them: ${c.automations_paused.sms.reason || "no reason given"}.</div>` : ""}
    ${rows.length ? html`<ul class="list ct-queued">${rows.slice(0, 12).map((x) => {
      const inner = html`<span class="ico">${icon(x.icon || "send")}</span><span class="who"><span class="nm">${x.label}</span><span class="sub">${x.at ? dateTime(x.at) : ""}${x.sub ? `${x.at ? " · " : ""}${x.sub}` : ""}</span></span>`;
      return html`<li>${x.href ? html`<a class="row" ${attrs({ href: x.href })}>${inner}<span class="chev" aria-hidden="true"></span></a>` : html`<div class="row">${inner}</div>`}</li>`;
    })}</ul>` : waiting ? loadingCard : html`<p class="muted small ct-none">Nothing is queued for them right now.</p>`}
    ${rows.length ? html`<p class="small muted ct-fine">What goes out by itself if nothing changes. Check here before texting them yourself.</p>` : ""}`;
  return section("queued", "About to be sent", body);
}

function details(s, ctx) {
  const c = s.contact;
  const src = c.source || {};
  return section("details", "Details", html`
    <section class="card"><div class="ct-card-h"><h3>Notes</h3>${ctx.can("contacts:write") ? html`<button type="button" class="btn small" data-note>Add note</button>` : ""}</div>
      ${c.notes ? html`<p class="ct-pre">${c.notes}</p>` : html`<p class="muted small">No notes yet.</p>`}
    </section>
    <section class="card"><h3>Reach them</h3><div class="ct-lines">
      ${(c.phones || []).map((p) => html`<a class="ct-line" href="${telHref(p.e164)}"><span class="lb">${p.label || "phone"}${p.primary ? " ★" : ""}</span><span class="v num">${phoneText(p.e164)}</span></a>`)}
      ${(c.emails || []).map((e) => html`<a class="ct-line" href="${mailHref(e.address)}"><span class="lb">${e.label || "email"}</span><span class="v">${e.address}</span></a>`)}
      ${c.billing_address ? html`<div class="ct-line"><span class="lb">Address</span><span class="v">${addressLine(c.billing_address)}</span></div>` : ""}
      ${!(c.phones || []).length && !(c.emails || []).length ? html`<p class="muted small">No phone or email on file.</p>` : ""}
    </div></section>
    <section class="card"><div class="ct-card-h"><h3>Texts and email</h3>${ctx.can("consent:edit") ? html`<button type="button" class="btn small" data-consent>Change</button>` : ""}</div>
      <dl class="kv">${Object.entries(CONSENT).map(([k, label]) => html`<dt>${label}</dt><dd>${consentPill((c.consent && c.consent[k] && c.consent[k].state) || "unknown")}</dd>`)}</dl>
      ${c.automations_paused ? html`<div class="warn-box" style="margin-top:10px">Automated ${Object.keys(c.automations_paused).map((k) => (k === "sms" ? "texts" : "email")).join(" and ")} paused: ${Object.values(c.automations_paused).map((x) => x.reason).join("; ")}</div>` : ""}
      <p class="small muted" style="margin-top:8px">An opt-out (STOP) is per number and always wins; see Settings → Messaging.</p>
    </section>
    <section class="card"><h3>About</h3><dl class="kv">
      ${s.stats && s.stats.contacts && s.stats.contacts.customer_since ? html`<dt>Customer since</dt><dd>${dateShort(s.stats.contacts.customer_since)}</dd>` : ""}
      ${s.stats && s.stats.work && s.stats.work.last_service_on ? html`<dt>Last service</dt><dd>${dateShort(s.stats.work.last_service_on)}</dd>` : ""}
      <dt>Source</dt><dd>${src.source || "Not known"}${src.channel ? ` · heard from ${src.channel}` : ""}</dd>
      ${src.form || src.ad ? html`<dt>Meta</dt><dd>${[src.form, src.ad, src.campaign].filter(Boolean).join(" · ")}</dd>` : ""}
      ${src.county ? html`<dt>County</dt><dd>${src.county}</dd>` : ""}
      ${src.promo_code || src.referral_code ? html`<dt>Code</dt><dd>${src.referral_code || src.promo_code}</dd>` : ""}
      ${c.owner_id ? html`<dt>Owner</dt><dd>${userName(s, c.owner_id)}</dd>` : ""}
      <dt>Added</dt><dd>${dateShort(c.created_at)}</dd>
      ${c.rotor && (c.rotor.customer_id || (c.rotor.lead_ids || []).length) ? html`<dt>Rotor</dt><dd>Linked${c.import ? " (imported)" : ""}</dd>` : html`<dt>Rotor</dt><dd>${c.intake_pending_rotor ? "Waiting for the next import to link it" : "Made in the CRM"}</dd>`}
    </dl>
    ${(c.tags || []).length ? html`<div class="ct-tags" style="margin-top:10px">${c.tags.map((t) => html`<span class="pill">${t}</span>`)}</div>` : ""}
    </section>
    ${ctx.can("contacts:write") ? html`<div class="ct-act-row">
      <a class="btn" href="${"#/contacts/" + encodeURIComponent(c.id) + "/edit"}">Edit</a>
      ${ctx.can("contacts:merge") && c.lifecycle !== "archived" ? html`<button type="button" class="btn" data-merge>Merge with…</button>` : ""}
      ${ctx.can("consent:edit") ? html`<button type="button" class="btn" data-pause>${c.automations_paused && c.automations_paused.sms ? "Resume automated texts" : "Pause automated texts"}</button>` : ""}
      ${c.lifecycle === "archived" ? html`<button type="button" class="btn" data-restore>Restore</button>` : html`<button type="button" class="btn danger" data-archive>Archive</button>`}
      ${ctx.can("settings:owner") ? html`<button type="button" class="btn" data-test>${c.flags && c.flags.test ? "Not a test contact" : "Mark as test contact"}</button>` : ""}
    </div>` : ""}`);
}

function activity(s) {
  let body;
  if (!s.activity) body = loadingCard;
  else if (!s.activity.length) body = s.activityFailed ? html`<div class="card ct-failed"><p>The activity didn't load. ${s.activityFailed}</p></div>` : html`<p class="muted small ct-none">Nothing here yet. Website requests, notes, calls, texts, quotes, visits and payments show up here.</p>`;
  else {
    body = html`<div class="card ct-clip" data-clip="activity"><ul class="tl">${s.activity.map((x) => html`<li>
      <span class="ico">${icon(actIcon(x.kind))}</span>
      <span class="body"><span class="t">${actLabel(x)}</span><span class="when">${x.at ? " · " + dateTime(x.at) : ""}</span>
      ${x.note ? html`<div class="said">${x.note}</div>` : ""}</span>
    </li>`)}</ul></div>`;
  }
  return section("activity", "Activity", body);
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
      b.className = "btn small ct-more";
      b.dataset.showall = key;
      b.textContent = `Show all ${n}`;
      ul.after(b);
    });
  }
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

export default {
  title: (s) => (s && s.contact ? s.contact.display_name || "Contact" : "Contact"),
  load,
  render(s, ctx) {
    if (s.redirect) return html``;
    const main = s.tech ? html`${properties(s, ctx)}` : html`
      ${placed(s, "visits", "Upcoming visits")}
      ${placed(s, "plan", "Service plan")}
      ${placed(s, "docs", "Quotes and invoices")}
      ${properties(s, ctx)}
      ${queued(s, ctx)}
      ${(s.secs || []).filter((r) => r.def.place === "more" && shown(r)).map((r) => section("mod-" + r.key, r.def.heading || r.def.label, modBlock(r, "")))}
      ${details(s, ctx)}`;
    const aside = s.tech ? "" : html`${placed(s, "aside", "Messages")}${activity(s)}`;
    return html`<div class="${"stack ct-page" + (s.tech ? " tech" : "")}">
      ${s.offline ? html`<div class="note">Offline: this is the last copy on this phone.</div>` : ""}
      ${header(s, ctx)}
      <div class="ct-cols"><div class="ct-main">${main}</div>${aside ? html`<div class="ct-aside">${aside}</div>` : ""}</div>
      ${!s.tech && s.contact.updated_at ? html`<p class="foot-note">Changed ${ago(s.contact.updated_at)}</p>` : ""}
    </div>`;
  },
  mount(view, s, ctx) {
    if (s.redirect) return;
    if (!s.started) {
      s.started = true;
      for (const r of s.secs || []) loadSection(ctx, r);
      if (!s.tech) loadActivity(ctx);
    }
    clipLists(view, ctx);
    // an old tab link: to its section, once it's there
    if (s.jump && !s.jumped) {
      const r = (s.secs || []).find((x) => x.key === s.jump);
      const id = OLD_TAB[s.jump] || (r ? (r.def.place === "more" ? "ct-sec-mod-" + r.key : "ct-mod-" + r.key) : null);
      const el = id ? view.querySelector("#" + id) : null;
      if (!id || (r && r.loading) || (s.jump === "activity" && !s.activity)) { if (!id) s.jumped = true; return; }
      s.jumped = true;
      if (el) setTimeout(() => el.scrollIntoView({ block: "start" }), 0);
    }
  },
  events: {
    "click [data-showall]": (e, el, ctx) => { (ctx.keep.open || (ctx.keep.open = {}))[el.dataset.showall] = true; ctx.rerender(); },
    "click [data-retry-sec]": (e, el, ctx) => { const r = (ctx.state.secs || []).find((x) => x.key === el.dataset.retrySec); if (r) { loadSection(ctx, r); ctx.rerender(); } },
    "click [data-note]": (e, el, ctx) => noteSheet(ctx),
    "click [data-consent]": (e, el, ctx) => consentSheet(ctx),
    "click [data-pause]": (e, el, ctx) => pauseSheet(ctx),
    "click [data-archive]": (e, el, ctx) => archiveSheet(ctx),
    "click [data-restore]": (e, el, ctx) => after(ctx, ctx.api(`/contacts/${encodeURIComponent(ctx.state.contact.id)}/restore`, { method: "POST", body: {} }), "Restored"),
    "click [data-test]": (e, el, ctx) => after(ctx, ctx.api(`/contacts/${encodeURIComponent(ctx.state.contact.id)}/flags`, { method: "PATCH", body: { test: !(ctx.state.contact.flags && ctx.state.contact.flags.test) } }), "Saved"),
    "click [data-merge]": (e, el, ctx) => mergeFlow(ctx),
    "click [data-add-prop]": (e, el, ctx) => propertySheet(ctx),
  },
};
