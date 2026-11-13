// One contact (design §9.2 "Contact"): the header (name, lifecycle, Call ·
// Text · Email · Directions), then tabs: Overview (consent, tags, source,
// owner, notes, what other modules know), Activity (the timeline: website
// requests with their words, notes, edits, merges) and Properties, plus a
// tab for each module that adds one (Sales, Work, Money, Messages, through
// their manifests' contactTabs). A technician sees only what the server
// gives them: the name, the numbers and the properties of their visits.

import { html, icon, sheet, toast, attrs, openExternal, confirmSheet } from "../../core/ui.js";
import { field, select, readForm, clearErrors, showError, busy } from "../../core/forms.js";
import { dateShort, dateTime, money, ago } from "../../core/format.js";
import { pickContact } from "../../core/pickers.js";
import { directionsUrl } from "../../core/map.js";
import { MANIFESTS } from "../index.js";
import {
  ensureStyles, lifecyclePill, consentPill, CONSENT, CONSENT_STATE, ARCHIVE_REASONS, phoneText, telHref, smsHref, mailHref, addressLine,
  avatar, tierPill, forgetIndex, followRun, emptyCard,
} from "./kit.js";

const otherTabs = () => MANIFESTS.flatMap((m) => (m.contactTabs || []).map((t) => ({ ...t, module: m.name }))).sort((a, b) => (a.order || 50) - (b.order || 50));
const ACTIVITY_ICON = { "lead.intake": "inbox", "contact.intake": "inbox", note: "doc", "contact.merged": "contacts", "contact.merge": "contacts", "contact.create": "plus", "contact.update": "doc", message: "text" };
const actLabel = (x) => ({
  "contact.intake": `Website request${x.source ? ` (${x.source})` : ""}`, "contact.create": "Added to the CRM", "contact.update": "Edited",
  "contact.merge": "Merged a duplicate into this contact", "contact.delete": "Deleted", "contact.restore": "Restored", note: "Note added",
})[x.kind] || x.label || x.kind.replace(/^contact\./, "").replace(/[._]/g, " ");

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
  return { ...d, etag: r.etag, tech, users, tab: ctx.keep.tab || "overview", activity: null, offline: !!r.offline };
}

function header(s) {
  const c = s.contact;
  const ph = (c.phones || []).find((p) => p.primary) || (c.phones || [])[0];
  const em = (c.emails || []).find((e) => e.primary) || (c.emails || [])[0];
  const prop = (s.properties || []).find((p) => p.id === c.primary_property_id) || (s.properties || [])[0];
  const where = prop ? addressLine(prop.address) : addressLine(c.billing_address);
  const flags = c.flags || {};
  return html`<section class="card">
    <div class="ct-head">${avatar(c.display_name)}<div class="who" style="min-width:0">
      <h2>${c.display_name || "No name"}</h2>
      <div class="pills">${c.lifecycle ? lifecyclePill(c.lifecycle) : ""}${flags.vip ? html`<span class="pill ink">VIP</span>` : ""}${flags.test ? html`<span class="pill blue">Test contact</span>` : ""}${flags.do_not_service ? html`<span class="pill red">Do not service</span>` : ""}${c.shadow ? "" : ""}</div>
    </div></div>
    <div class="ct-acts">
      ${ph ? html`<a href="${telHref(ph.e164)}">${icon("phone")}Call</a>` : html`<span>${icon("phone")}Call</span>`}
      ${ph && ph.sms !== false ? html`<a href="${smsHref(ph.e164)}">${icon("text")}Text</a>` : html`<span>${icon("text")}Text</span>`}
      ${em ? html`<a href="${mailHref(em.address)}">${icon("mail")}Email</a>` : html`<span>${icon("mail")}Email</span>`}
      ${where ? html`<a ${openExternal(directionsUrl(where))}>${icon("map")}Directions</a>` : html`<span>${icon("map")}Directions</span>`}
    </div>
  </section>`;
}

function tabsBar(s) {
  const tabs = [["overview", "Overview"], ...(s.tech ? [] : [["activity", "Activity"]]), ["properties", "Properties"], ...(s.tech ? [] : otherTabs().map((t) => [t.key, t.label]))];
  return html`<div class="chips ct-tabs" role="tablist">${tabs.map(([k, label]) => html`<button type="button" class="chip" role="tab" ${attrs({ "data-tab": k, "aria-pressed": String(s.tab === k), "aria-selected": String(s.tab === k) })}>${label}</button>`)}</div>`;
}

const userName = (s, id) => (s.users.find((u) => u.id === id) || {}).name || "Someone on the team";

function overview(s, ctx) {
  const c = s.contact;
  const st = s.stats || {};
  const work = st.work || {}, money_ = st.money || {}, plans = st.plans || {};
  const src = c.source || {};
  const facts = [
    work.next_visit_on ? ["Next visit", dateShort(work.next_visit_on)] : null,
    work.last_service_on ? ["Last service", dateShort(work.last_service_on)] : null,
    Number.isFinite(money_.open_balance_cents) && money_.open_balance_cents ? ["Balance", money(money_.open_balance_cents)] : null,
    (plans.active_plan_ids || []).length ? ["Plans", String(plans.active_plan_ids.length)] : null,
    st.contacts && st.contacts.customer_since ? ["Customer since", dateShort(st.contacts.customer_since)] : null,
  ].filter(Boolean);
  if (s.tech) {
    return html`<section class="card"><div class="ct-lines">${(c.phones || []).map((p) => html`<a class="ct-line" href="${telHref(p.e164)}"><span class="lb">${p.label || "Phone"}</span><span class="v">${phoneText(p.e164)}</span></a>`)}</div></section>`;
  }
  return html`
    ${facts.length ? html`<section class="card"><dl class="kv">${facts.map(([k, v]) => html`<dt>${k}</dt><dd class="num">${v}</dd>`)}</dl></section>` : ""}
    <section class="card"><h2>Reach them</h2><div class="ct-lines">
      ${(c.phones || []).map((p) => html`<a class="ct-line" href="${telHref(p.e164)}"><span class="lb">${p.label || "phone"}${p.primary ? " ★" : ""}</span><span class="v num">${phoneText(p.e164)}</span></a>`)}
      ${(c.emails || []).map((e) => html`<a class="ct-line" href="${mailHref(e.address)}"><span class="lb">${e.label || "email"}</span><span class="v">${e.address}</span></a>`)}
      ${c.billing_address ? html`<div class="ct-line"><span class="lb">Address</span><span class="v">${addressLine(c.billing_address)}</span></div>` : ""}
      ${!(c.phones || []).length && !(c.emails || []).length ? html`<p class="muted small">No phone or email on file.</p>` : ""}
    </div></section>
    <section class="card"><div class="row" style="padding:0;min-height:0"><h2 style="flex:1;margin:0">Texts and email</h2>${ctx.can("consent:edit") ? html`<button type="button" class="btn" data-consent>Change</button>` : ""}</div>
      <dl class="kv" style="margin-top:10px">${Object.entries(CONSENT).map(([k, label]) => html`<dt>${label}</dt><dd>${consentPill((c.consent && c.consent[k] && c.consent[k].state) || "unknown")}</dd>`)}</dl>
      ${c.automations_paused ? html`<div class="warn-box" style="margin-top:10px">Automated ${Object.keys(c.automations_paused).map((k) => (k === "sms" ? "texts" : "email")).join(" and ")} paused: ${Object.values(c.automations_paused).map((x) => x.reason).join("; ")}</div>` : ""}
      <p class="small muted" style="margin-top:8px">An opt-out (STOP) is per number and always wins; see Settings → Messaging.</p>
    </section>
    <section class="card"><h2>About</h2><dl class="kv">
      <dt>Source</dt><dd>${src.qr_code && src.campaign ? `${src.campaign} (QR code) · ${src.source || "Website quote form"}` : src.source || "Not known"}${src.channel ? ` · heard from ${src.channel}` : ""}</dd>
      ${src.form || src.ad ? html`<dt>Meta</dt><dd>${[src.form, src.ad, src.campaign].filter(Boolean).join(" · ")}</dd>` : ""}
      ${src.county ? html`<dt>County</dt><dd>${src.county}</dd>` : ""}
      ${src.promo_code || src.referral_code ? html`<dt>Code</dt><dd>${src.referral_code || src.promo_code}</dd>` : ""}
      ${c.owner_id ? html`<dt>Owner</dt><dd>${userName(s, c.owner_id)}</dd>` : ""}
      <dt>Added</dt><dd>${dateShort(c.created_at)}</dd>
      ${c.rotor && (c.rotor.customer_id || (c.rotor.lead_ids || []).length) ? html`<dt>Rotor</dt><dd>Linked${c.import ? " (imported)" : ""}</dd>` : html`<dt>Rotor</dt><dd>${c.intake_pending_rotor ? "Waiting for the next import to link it" : "Made in the CRM"}</dd>`}
    </dl>
    ${(c.tags || []).length ? html`<div class="ct-tags" style="margin-top:10px">${c.tags.map((t) => html`<span class="pill">${t}</span>`)}</div>` : ""}
    </section>
    <section class="card"><div class="row" style="padding:0;min-height:0"><h2 style="flex:1;margin:0">Notes</h2>${ctx.can("contacts:write") ? html`<button type="button" class="btn" data-note>Add note</button>` : ""}</div>
      ${c.notes ? html`<p class="ct-pre" style="margin-top:10px">${c.notes}</p>` : html`<p class="muted small">No notes yet.</p>`}
    </section>
    ${(s.pending_automations || []).length ? "" : ""}
    ${ctx.can("contacts:write") ? html`<div class="ct-act-row">
      <a class="btn" href="${"#/contacts/" + encodeURIComponent(c.id) + "/edit"}">Edit</a>
      ${ctx.can("contacts:merge") && c.lifecycle !== "archived" ? html`<button type="button" class="btn" data-merge>Merge with…</button>` : ""}
      ${ctx.can("consent:edit") ? html`<button type="button" class="btn" data-pause>${c.automations_paused && c.automations_paused.sms ? "Resume automated texts" : "Pause automated texts"}</button>` : ""}
      ${c.lifecycle === "archived" ? html`<button type="button" class="btn" data-restore>Restore</button>` : html`<button type="button" class="btn danger" data-archive>Archive</button>`}
      ${ctx.can("settings:owner") ? html`<button type="button" class="btn" data-test>${c.flags && c.flags.test ? "Not a test contact" : "Mark as test contact"}</button>` : ""}
    </div>` : ""}`;
}

function activity(s) {
  if (!s.activity) return html`<div class="card"><span class="sk w70"></span></div>`;
  if (!s.activity.length) return emptyCard("Nothing here yet", "Website requests, notes, calls, quotes and visits show up here.", "clock");
  return html`<section class="card"><ul class="tl">${s.activity.map((x) => html`<li>
    <span class="ico">${icon(ACTIVITY_ICON[x.kind] || "clock")}</span>
    <span class="body"><span class="t">${actLabel(x)}</span><span class="when">${x.at ? " · " + dateTime(x.at) : ""}</span>
    ${x.note ? html`<div class="said">${x.note}</div>` : ""}</span>
  </li>`)}</ul></section>`;
}

function properties(s, ctx) {
  const list = s.properties || [];
  return html`${list.length ? html`<ul class="list">${list.map((p) => html`<li><a class="row" href="${"#/properties/" + encodeURIComponent(p.id)}">
      <span class="ico">${icon("building")}</span>
      <span class="who"><span class="nm">${p.label || "Property"}${p.id === s.contact.primary_property_id ? " · main" : ""}</span><span class="sub">${addressLine(p.address)}</span></span>
      <span class="end">${s.tech ? "" : tierPill(p.town_tier)}<span class="chev" aria-hidden="true"></span></span></a></li>`)}</ul>`
    : emptyCard("No property yet", "Add the address where the work happens.", "building")}
    ${ctx.can("contacts:write") ? html`<div class="btn-row"><button type="button" class="btn primary" data-add-prop>Add a property</button></div>` : ""}`;
}

async function loadTab(ctx) {
  const s = ctx.state;
  if (s.tab === "activity" && !s.activity) {
    try { s.activity = (await ctx.api(`/contacts/${encodeURIComponent(s.contact.id)}/activity`, { cache: false })).data || []; } catch (e) { s.activity = []; toast(e.message, { bad: true }); }
    ctx.rerender();
  }
  const other = otherTabs().find((t) => t.key === s.tab);
  if (other && !s.tabMod) {
    try { s.tabMod = (await other.load()).default; s.tabState = s.tabMod.load ? await s.tabMod.load({ id: s.contact.id }, ctx) : {}; } catch (e) { s.tabMod = { render: () => emptyCard("That didn't load", e.message || "Try again.", "shield") }; }
    ctx.rerender();
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
    const other = otherTabs().find((t) => t.key === s.tab);
    let body;
    if (s.tab === "activity") body = activity(s);
    else if (s.tab === "properties") body = properties(s, ctx);
    else if (other) body = s.tabMod ? s.tabMod.render(s.tabState || {}, ctx) : html`<div class="card"><span class="sk w70"></span></div>`;
    else body = overview(s, ctx);
    return html`<div class="stack">
      ${s.offline ? html`<div class="note">Offline: this is the last copy on this phone.</div>` : ""}
      ${header(s)}
      ${tabsBar(s)}
      ${body}
      ${!s.tech && s.contact.updated_at ? html`<p class="foot-note">Changed ${ago(s.contact.updated_at)}</p>` : ""}
    </div>`;
  },
  mount(view, s, ctx) { loadTab(ctx); },
  events: {
    "click [data-tab]": (e, el, ctx) => { ctx.state.tab = el.dataset.tab; ctx.keep.tab = el.dataset.tab; ctx.state.tabMod = null; ctx.rerender(); },
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
