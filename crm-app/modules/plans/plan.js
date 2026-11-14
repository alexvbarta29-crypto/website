// One plan (design §9.2 "Plan"), Rotor's service plan look (Nov 2026):
// a top card (status, plan value), the customer, then black segments
// Service | Agree | Schedule. Service: the details (service types, how
// often, agreement length and renewal, start date), pricing, the plan's
// value, billing (card on file, Auto-Pay, billing mode), the property, who
// sold it and notes. Agree: send a new agreement or sign on this phone,
// the agreement notes, each agreement with its status and Email / SMS /
// Read. Schedule: booked and done visits (open the job), visits to book
// (dashed: Schedule = book its job, Skip). The round pencil opens the
// editor, a full-height sheet with the same segments where the terms
// change (the owner, Nov 14: frequency, length, renewal, start date and
// billing stay editable; the server's rule for the visits, a confirm sheet
// first). The round "..." holds what the plan's status allows: Pause /
// Resume, Cancel (the policy calculator first), Keep the plan, Change the
// price, Renew, Activate with a reason, Confirm a lights season, the
// clawback billed or waived. Every change is a run the server finishes.

import {
  html, attrs, icon, sheet, toast, confirmSheet, openExternal, seg, cardHead, sectionLabel, statGrid, personCard, addressCard, lineItems, notesBox,
  formRow, formRows, toggle, pillBtn, statusPill as kitPill, sheetPage, render,
} from "../../core/ui.js";
import { busy, readForm, showError, clearErrors, readMoney } from "../../core/forms.js";
import { money, dateShort, dateYear, phone, localDate } from "../../core/format.js";
import { dateField } from "../../core/pickers.js";
import {
  ensureStyles, statusPill, ORD, AGREEMENT, BILLING, BILLING_SHORT, PLAN_NAMES, SEASON, CANCEL_REASONS, monthLabel, pendingText, waitRun, cents,
} from "./kit.js";

async function load(params, ctx) {
  ensureStyles();
  const r = await ctx.api(`/plans/${encodeURIComponent(params.id)}`, { cache: false });
  return { ...r.data, etag: r.etag || r.data.etag, tab: ctx.keep.tab || "service" };
}

export const FREQS = [[1, "Monthly"], [2, "Every 2 months"], [3, "Quarterly"], [4, "Every 4 months"], [6, "Biannual"], [12, "Once a year"]];
export const LENGTHS = [12, 24, 36, 48, 60];
const FIELD_NAMES = { frequency: "How often", term_months: "Agreement length", auto_renew: "Renews", start_on: "Start date", billing_mode: "Billing", discounts: "Discounts" };
const freqText = (f) => {
  if (!f) return "";
  if (f.interval === "month") return (FREQS.find(([n]) => n === f.count) || [0, `Every ${f.count} months`])[1];
  if (f.interval === "year") return f.count === 1 ? "Once a year" : `Every ${f.count} years`;
  return `Every ${f.count} ${f.interval}${f.count === 1 ? "" : "s"}`;
};
const perksText = (p, names) => {
  const out = [];
  if (p.touch_ups) out.push(names.touch_ups);
  if (p.rain_guarantee_days > 0) out.push(names.rain_guarantee);
  if (p.hard_water) out.push(names.hard_water);
  return out.join(", ") || "None";
};
const renewWords = (m) => (m === 1 ? "every month" : m === 12 ? "every year" : `every ${m} months`);
const scopeText = (sc, vpy) => {
  const x = sc || { type: "all" };
  if (x.type === "initial") return "First visit only";
  if (x.type === "after_initial") return "Every visit after the first";
  if (x.type === "specific") return `Visit${(x.visits || []).length === 1 ? "" : "s"} ${(x.visits || []).join(", ")}${vpy > 1 ? ` of every ${vpy}` : ""}`;
  return "Every visit";
};
const discText = (d) => (d.type === "percentage" ? `${(d.value || 0) / 100}% off` : `${money(d.value || 0)} off`);
const live = (p) => ["pending", "active"].includes(p.status);
const termsEditable = (p) => ["pending", "active", "paused", "cancelling"].includes(p.status);
const canEdit = (s, ctx) => ctx.can("plans:write") && termsEditable(s.plan);
const signedAgreement = (s) => (s.agreements || []).find((a) => a.status === "signed") || null;
const discountsEditable = (p) => p.status === "pending" && p.agreement_status !== "signed" && !(p.ordinals || []).some((o) => o.status === "completed");

// ------------------------------------------------------------ the page's top

function topCard(s) {
  const p = s.plan;
  const t = p.term || {};
  const n = (p.ordinals || []).filter((o) => (o.term || 1) === (t.current_term_n || 1) && !["skipped", "cancelled"].includes(o.status)).length;
  return html`<section class="rs-card pl-top">
    <div class="rs-row"><span class="rs-pills">${statusPill(p.status)}${(p.billing || {}).autopay ? kitPill("Auto-Pay", "white") : ""}${p.import ? kitPill("From Rotor", "grey") : ""}</span><span class="rs-sub">Started ${dateShort(t.start_on)}</span></div>
    <p class="pl-what">${[...new Set([PLAN_NAMES[p.catalog_key] || p.catalog_key, freqText(p.frequency)])].join(" · ")} · ${n} visit${n === 1 ? "" : "s"} this term</p>
    <div class="rs-kv"><span>Plan value</span><span class="rs-amt">${money(p.sale_value_cents)}</span></div>
    ${p.status === "pending" ? html`<p class="warn-box">Waiting for the ${pendingText(p.pending_reasons) || "agreement"}.</p>` : ""}
    ${p.status === "paused" && p.pause ? html`<p class="note">Paused since ${dateShort(p.pause.from)}${p.pause.until ? `, back ${dateShort(p.pause.until)}` : ""}${p.pause.reason ? `: ${p.pause.reason}` : ""}.</p>` : ""}
    ${p.status === "cancelling" && p.cancel ? html`<p class="warn-box">Ends ${dateYear(p.cancel.effective_on)}${p.cancel.clawback_cents ? `. ${p.cancel.storage_fee_cents ? "Storage fee for leaving the contract early" : "First-visit discount back"}: ${cents(p.cancel.clawback_cents)} (${p.cancel.clawback_state === "to_bill" ? "to bill, waiting for your OK" : p.cancel.clawback_state})` : ""}.</p>` : ""}
    ${p.status === "cancelled" && p.cancel && p.cancel.clawback_state === "to_bill" && p.cancel.clawback_cents ? html`<p class="warn-box">${p.cancel.storage_fee_cents ? "Storage fee for leaving the contract early" : "First-visit discount back"}: ${cents(p.cancel.clawback_cents)}, to bill, waiting for your OK.</p>` : ""}
    ${p.agreement_stale ? html`<p class="warn-box" data-stale>The terms changed after the agreement was signed. The signed one stays on file; send a new one from Agree.</p>` : ""}
    ${p.import ? html`<p class="small muted">From Rotor: Rotor stays in charge of this plan until the switch.</p>` : ""}
    ${p.held ? html`<p class="warn-box">Due to ${({ resume: "pick back up", renew: "renew", activate: "start", confirm_season: "go on" })[p.held.action] || p.held.action} since ${dateShort(p.held.since)}, but Rotor is still in charge of this customer, so the CRM doesn't book visits for them by itself. Do it here by hand.</p>` : ""}
  </section>`;
}

function person(s) {
  const c = s.contact || {};
  const p = s.plan;
  return personCard({ name: c.name || p.contact_name || "Contact", sub: [p.town, c.phone && phone(c.phone)].filter(Boolean).join(" · "), href: "#/contacts/" + encodeURIComponent(p.contact_id), call: c.phone ? "tel:" + c.phone : null, text: c.phone ? "sms:" + c.phone : null });
}

// ------------------------------------------------------------ Service

function pricing(s, ctx, { editing = false, discounts = null } = {}) {
  const p = s.plan;
  const ds = discounts || p.discounts || [];
  const vpy = p.visits_per_year;
  const perVisit = (p.ordinals || []).find((o) => o.status !== "skipped" && o.status !== "cancelled") || null;
  const canPrice = ctx.can("plans:write") && p.status === "active";
  return html`<div class="rs-card">${cardHead("Pricing", { edit: canPrice ? { label: "Change the price", data: { act: "price" } } : null })}
    ${lineItems((p.lines || []).map((l) => ({ title: l.title, sub: `${(l.qty_milli || 1000) === 1000 ? "" : `${(l.qty_milli || 0) / 1000} × ${money(l.unit_cents)} · `}${scopeText(l.scope, vpy)}`, amount: l.total_cents ?? l.unit_cents })), {
      discounts: ds.map((d, i) => ({ label: `${d.name} (${scopeText(d.scope, vpy).toLowerCase()})`, amount: d.type === "percentage" ? `${d.value / 100}% off` : `-${money(d.value)}` })),
      addDiscount: editing && discountsEditable(p) ? { data: { "add-discount": true } } : null,
      total: perVisit ? perVisit.total_cents : null, totalLabel: perVisit && perVisit.n === 1 ? "First visit" : "A visit",
      empty: "No lines on this plan.",
    })}
    ${editing && discountsEditable(p) && ds.length ? html`<div class="pl-dchips">${ds.map((d, i) => pillBtn(`Remove ${d.name}`, { icon: "close", data: { "del-discount": i } }))}</div>` : ""}
    ${p.renewal && p.renewal.price_change ? html`<p class="rs-sub">New price from ${dateYear(p.renewal.price_change.effective_on)} (${(p.renewal.price_change.new_lines || []).map((l) => money(l.total_cents ?? l.unit_cents)).join(", ")}).</p>` : ""}
    ${editing && canPrice ? html`<p class="rs-sub">A new price starts at a renewal, with 30 days' notice. Use the pencil above.</p>` : ""}
  </div>`;
}

function valueCard(s) {
  const p = s.plan;
  const n = (p.term && p.term.current_term_n) || 1;
  const term = (p.ordinals || []).filter((o) => (o.term || 1) === n && !["skipped", "cancelled"].includes(o.status));
  const avg = term.length ? Math.round((p.sale_value_cents || 0) / term.length) : 0;
  return html`${sectionLabel("Plan value")}${statGrid([
    { label: "Jobs", value: String(term.length) }, { label: "Avg a job", value: money(avg) }, { label: "This term", value: money(p.sale_value_cents) },
  ], { label: "Plan value" })}`;
}

const cardLine = (s) => {
  const c = s.card;
  if (!s.features.money) return "Cards arrive with Money";
  if (!c || c.status === "none") return "No card on file";
  return c.last4 ? `${String(c.brand || (c.kind === "us_bank_account" ? "Bank" : "Card")).toUpperCase()} ending ${c.last4}` : "On file";
};

function details(s, ctx, ed) {
  const p = s.plan;
  const t = p.term || {};
  const lights = p.kind === "lights_annual";
  const types = (p.service_types || []).length ? p.service_types : [PLAN_NAMES[p.catalog_key] || "Plan"];
  const txt = (v) => html`<span class="pl-val">${v}</span>`;
  const schedOk = ed && live(p) && !lights;
  const first = (t.current_term_n || 1) === 1;
  const noneKept = !(p.ordinals || []).some((o) => o.status !== "unscheduled");
  return html`${sectionLabel("Details")}${formRows([
    html`<div class="rs-frow pl-types"><span class="rs-fl">Service types</span><span class="rs-fc"><span class="pl-chips">${types.map((x) => html`<span class="pill wh">${x}</span>`)}</span></span></div>`,
    formRow("Frequency", schedOk ? html`<select name="frequency" aria-label="How often">${FREQS.map(([n, l]) => html`<option ${attrs({ value: n, selected: p.frequency && p.frequency.interval === "month" && p.frequency.count === n })}>${l}</option>`)}${p.frequency && !(p.frequency.interval === "month" && FREQS.some(([n]) => n === p.frequency.count)) ? html`<option value="" selected>${freqText(p.frequency)}</option>` : ""}</select>` : txt(freqText(p.frequency)), { hint: `${p.visits_per_year} a year` }),
    formRow("Agreement length", schedOk && first ? html`<select name="term_months" aria-label="Agreement length">${[...new Set([...LENGTHS, t.initial_months])].sort((a, b) => a - b).map((m) => html`<option ${attrs({ value: m, selected: t.initial_months === m })}>${m} months</option>`)}</select>` : txt(`${t.initial_months} months`), { hint: first ? `to ${dateYear(t.initial_end_on)}` : `term ${t.current_term_n}, to ${dateYear(t.current_term_end)}` }),
    formRow("Renews", ed ? toggle(t.auto_renew !== false, { data: { renew: true }, label: "Renews" }) : txt(t.auto_renew === false ? "No, it ends with the term" : renewWords(t.renews_every_months)), { hint: t.auto_renew === false ? null : renewWords(t.renews_every_months) }),
    formRow("Start date", schedOk && first && noneKept ? html`<input type="date" name="start_on" ${attrs({ value: t.start_on || "" })} aria-label="Start date">` : txt(dateYear(t.start_on))),
    formRow("Price locked until", txt(dateYear(t.price_locked_until))),
  ])}
  ${ed && lights ? html`<p class="rs-sub">A Christmas lights plan keeps its seasons: its length and dates don't change here.</p>` : ""}
  ${ed && !live(p) && !lights ? html`<p class="rs-sub">${p.status === "paused" ? "Resume the plan to change how often or how long." : "This plan is ending: how often and how long stay as they are."}</p>` : ""}`;
}

function billing(s, ctx, ed) {
  const p = s.plan;
  const b = p.billing || {};
  const w = ctx.can("plans:write");
  return html`${sectionLabel("Billing")}${formRows([
    formRow("Card on file", html`<span class="pl-val">${cardLine(s)}</span>`),
    formRow("Auto-Pay", w && termsEditable(p) ? toggle(!!b.autopay, { data: { autopay: true }, label: "Auto-Pay" }) : html`<span class="pl-val">${b.autopay ? "On" : "Off"}</span>`, { hint: b.autopay && !s.features.money ? "cards arrive with Money" : null }),
    formRow("Billing mode", ed && termsEditable(p) ? html`<select name="billing_mode" aria-label="Billing mode">${Object.entries(BILLING_SHORT).map(([k, l]) => html`<option ${attrs({ value: k, selected: (b.mode || "barta_standard") === k })}>${l}</option>`)}</select>` : html`<span class="pl-val">${BILLING_SHORT[b.mode] || b.mode}</span>`, { hint: BILLING[b.mode || "barta_standard"] }),
  ])}`;
}

function property(s, ctx, ed) {
  const pr = s.property;
  const props = s.properties || [];
  if (ed && ctx.can("plans:write") && props.length > 1) {
    return html`${sectionLabel("Property")}${formRows([formRow("Service address", html`<select name="property_id" aria-label="Service address">${props.map((x) => html`<option ${attrs({ value: x.id, selected: x.id === s.plan.property_id })}>${x.line1}${x.line2 ? `, ${x.line2}` : ""}</option>`)}</select>`)])}`;
  }
  if (!pr) return html`${sectionLabel("Property")}<div class="rs-card"><p class="rs-empty">${s.plan.town ? `In ${s.plan.town}` : "No property on the plan"}</p></div>`;
  const q = encodeURIComponent([pr.line1, pr.line2].filter(Boolean).join(", "));
  return html`${sectionLabel("Property")}${addressCard({ line1: pr.line1 || pr.label, line2: pr.line2, nav: q ? `https://maps.apple.com/?q=${q}` : null })}`;
}

function team(s, ctx, ed) {
  const p = s.plan;
  const w = ctx.can("plans:write");
  return html`${sectionLabel("Team and notes")}
    ${formRows([formRow("Sold by", html`<span class="pl-chips">${kitPill(s.sold_by_name || (p.origin === "import" ? "Rotor" : "Not recorded"), "white", { icon: "user" })}</span>`)])}
    <div class="rs-card">${cardHead("Plan notes")}${notesBox(p.notes, { name: "plan", label: "Plan notes", placeholder: "Add notes for this plan...", readonly: !w })}</div>
    <p class="rs-sub pl-perks">Perks: ${perksText(p.perks || {}, s.perk_names || {})}</p>`;
}

function servicePane(s, ctx, { editing = false, discounts = null } = {}) {
  return html`${details(s, ctx, editing)}${pricing(s, ctx, { editing, discounts })}${valueCard(s)}${billing(s, ctx, editing)}${property(s, ctx, editing)}${team(s, ctx, editing)}${seasonsCard(s, ctx)}`;
}

// ------------------------------------------------------------ Agree

function agreePane(s, ctx) {
  const p = s.plan;
  const st = p.agreement_status || "none";
  const send = ctx.can("agreements:send") && (st !== "signed" || !!p.agreement_stale);
  const open = (s.agreements || []).find((a) => ["sent", "viewed"].includes(a.status));
  const w = ctx.can("plans:write");
  const list = [...(s.agreements || [])].sort((a, b) => String(b.created_at).localeCompare(String(a.created_at)));
  return html`${p.agreement_stale ? html`<p class="warn-box">The terms changed after it was signed (${(p.agreement_stale.fields || []).map((f) => (FIELD_NAMES[f] || f).toLowerCase()).join(", ")}). The signed agreement stays on file; the customer signs a new one.</p>` : ""}
    ${send ? html`<div class="pl-agbtns">${pillBtn(open ? "Send it again" : "Generate New Agreement", { tone: "red", wide: true, icon: "send", data: { act: "send-agreement" } })}${pillBtn("Sign on this phone", { wide: true, icon: "phone", data: { act: "present-agreement" } })}</div>` : ""}
    <div class="rs-card">${cardHead("Agreement notes")}${notesBox(p.agreement_notes, { name: "agreement", label: "Agreement notes", placeholder: "Notes the next agreement carries...", readonly: !w })}<p class="rs-sub">Added to the next agreement you send. A signed one never changes.</p></div>
    ${sectionLabel("Agreements")}
    ${list.length ? list.map((a) => agreementCard(a, ctx)) : html`<div class="rs-card"><p class="rs-empty">${AGREEMENT[st] || "Not sent"}</p></div>`}`;
}

function agreementCard(a, ctx) {
  const words = a.status === "signed" ? "Signed" : a.status === "void" ? "Void" : a.queued ? "Queued" : a.status === "viewed" ? "Opened" : a.status === "sent" ? "Sent" : "Not signed";
  const tone = a.status === "signed" ? "green" : a.status === "void" ? "red" : a.status === "draft" ? "grey" : "amber";
  const canSend = ctx.can("agreements:send") && ["draft", "sent", "viewed"].includes(a.status) && !a.queued;
  return html`<div class="rs-card pl-ag">
    <div class="rs-row"><span class="pl-ag-t"><b>Service Agreement</b><span class="rs-sub">Created ${dateShort(a.created_at)}${a.sent_at ? ` · sent ${dateShort(a.sent_at)}` : ""}</span></span>${kitPill(words, tone)}</div>
    ${a.signature ? html`<p class="rs-sub">${a.signature.name_typed}${a.signature.method === "in_person" ? " (in person)" : ""}, ${dateShort(a.signed_at)}</p>` : ""}
    ${a.reminders && a.reminders.count ? html`<p class="rs-sub">${a.reminders.count} reminder${a.reminders.count === 1 ? "" : "s"} sent</p>` : ""}
    ${a.queued ? html`<p class="rs-sub">Waiting in a bulk send (test and confirm it under Approvals)</p>` : ""}
    ${a.imported ? html`<p class="rs-sub">From Rotor (no signature on file)</p>` : ""}
    <div class="pl-ag-acts">
      ${canSend ? pillBtn("Email", { icon: "mail", data: { "send-ch": `email:${a.id}` } }) : ""}
      ${canSend ? pillBtn("SMS", { icon: "chat", data: { "send-ch": `sms:${a.id}` } }) : ""}
      ${pillBtn("Read", { icon: "doc", data: { read: a.id } })}
    </div></div>`;
}

// ------------------------------------------------------------ Schedule

function schedulePane(s, ctx) {
  const p = s.plan;
  const canSkip = ctx.can("plans:write") && p.status === "active";
  const ords = [...(p.ordinals || [])];
  const multi = new Set(ords.map((o) => o.term || 1)).size > 1;
  const termTag = (o) => (multi ? ` · term ${o.term || 1}` : "");
  const done = ords.filter((o) => ["scheduled", "completed"].includes(o.status));
  const todo = ords.filter((o) => o.status === "unscheduled");
  const gone = ords.filter((o) => ["skipped", "cancelled"].includes(o.status));
  const dateOf = (o) => (o.visit_date ? dateShort(o.visit_date) : o.completed_on ? `Done ${dateShort(o.completed_on)}` : monthLabel(o.target_month));
  return html`<div class="rs-card pl-auto"><p class="rs-sub">${s.features.jobs ? "Jobs for the whole term are made as soon as the plan is set up, waiting to be booked. Book each one below." : "Jobs arrive with Scheduling."}</p></div>
    ${sectionLabel(`Scheduled jobs (${done.length})`)}
    ${done.length ? done.map((o) => { const [, label] = ORD[o.status] || ["", o.status]; return html`<div class="rs-card pl-job">
        <span class="pl-job-t"><b>${dateOf(o)}</b><span class="rs-sub">Visit ${o.n}${termTag(o)}${o.job ? ` · Job ${o.job.number}` : ""}</span></span>
        <span class="pl-job-e"><span class="num">${money(o.total_cents)}</span>${kitPill(label, o.status === "completed" ? "green" : "blue")}</span>
        ${o.job ? pillBtn("Edit", { href: "#/jobs/" + encodeURIComponent(o.job.id), aria: `Open visit ${o.n}'s job` }) : ""}
      </div>`; }) : html`<div class="rs-card"><p class="rs-empty">Nothing booked yet</p></div>`}
    ${sectionLabel(`Pending jobs (${todo.length})`)}
    ${todo.length ? todo.map((o) => html`<div class="rs-card rs-dashed pl-job">
        <span class="pl-job-t"><b>Due ${monthLabel(o.target_month)}</b><span class="rs-sub">Visit ${o.n}${termTag(o)}${o.job ? ` · Job ${o.job.number}` : s.features.jobs ? " · its job is on the way" : ""}</span></span>
        <span class="pl-job-e"><span class="num">${money(o.total_cents)}</span>${kitPill("Pending", "amber")}</span>
        <span class="pl-job-b">${o.job ? pillBtn("Schedule", { tone: "solid", href: "#/jobs/" + encodeURIComponent(o.job.id), aria: `Book visit ${o.n}` }) : ""}${canSkip ? html`<button type="button" class="pl-skip" ${attrs({ "data-skip": `${o.term || 1}:${o.n}` })}>Skip</button>` : ""}</span>
      </div>`) : html`<div class="rs-card"><p class="rs-empty">No visits waiting to be booked</p></div>`}
    ${gone.length ? html`<details class="rs-card pl-gone"><summary>Skipped and cancelled (${gone.length})</summary><ul>${gone.map((o) => html`<li>Visit ${o.n}${termTag(o)} · ${monthLabel(o.target_month)} · ${o.status === "skipped" ? "Skipped" : "Cancelled"}</li>`)}</ul></details>` : ""}`;
}

// A lights plan's seasons after the first wait for the customer's yes (the
// September rebook text): no install is made before the office marks it.
function seasonsToConfirm(p) {
  if (p.kind !== "lights_annual" || !["active", "pending", "paused"].includes(p.status)) return [];
  const yes = new Set(p.confirmed_seasons || []);
  const out = new Set();
  for (const o of p.ordinals || []) {
    const y = Number(String(o.target_month).slice(0, 4));
    if ((o.k || o.n) > 1 && o.status === "unscheduled" && !o.job_id && !yes.has(y)) out.add(y);
  }
  const now = new Date();
  const upcoming = now.getMonth() >= 6 ? now.getFullYear() : null;
  if (upcoming && !yes.has(upcoming) && !(p.ordinals || []).some((o) => Number(String(o.target_month).slice(0, 4)) === upcoming && (o.job_id || o.status !== "unscheduled"))) out.add(upcoming);
  return [...out].sort();
}
function seasonsCard(s, ctx) {
  const p = s.plan;
  if (p.kind !== "lights_annual") return "";
  const waiting = seasonsToConfirm(p);
  const can = ctx.can("plans:write");
  return html`${sectionLabel("Seasons")}<section class="rs-card">
    ${(s.seasons || []).length ? html`<ul class="pl-facts">${s.seasons.map((x) => html`<li><span class="k">${x.season}</span><span class="v"><a href="${"#/lights/" + x.season}">${SEASON[x.status] || x.status}${x.bin_id ? ` · bin ${x.bin_id}` : ""}</a></span></li>`)}</ul>` : html`<p class="rs-empty">No season yet</p>`}
    ${waiting.length ? html`<p class="rs-sub">A new season goes on the schedule once the customer says yes (they get a text each September).</p>
      ${can ? html`<div class="pl-agbtns">${waiting.map((y) => pillBtn(`They said yes to ${y}`, { icon: "check", wide: true, data: { "confirm-season": y } }))}</div>` : html`<p>Waiting for ${waiting.join(", ")}.</p>`}` : ""}
  </section>`;
}

// ------------------------------------------------------------ the "..." sheet

function moreRows(s, ctx) {
  const p = s.plan;
  const w = ctx.can("plans:write");
  const c = ctx.can("plans:cancel");
  const send = ctx.can("agreements:send") && (p.agreement_status !== "signed" || !!p.agreement_stale);
  const fee = !!(p.cancel && p.cancel.storage_fee_cents);
  const claw = p.cancel && p.cancel.clawback_state === "to_bill" && c;
  const run = (fn) => () => fn(null, ctx);
  return [
    [
      canEdit(s, ctx) && { label: "Edit the plan", icon: "edit", hint: "terms, billing", run: () => openEditor(ctx, "service"), data: { act: "edit" } },
      p.status === "active" && w && { label: "Change the price", icon: "money", hint: "from a renewal", run: () => priceSheet(ctx), data: { act: "price" } },
    ],
    [
      p.status === "pending" && w && { label: "Activate anyway", icon: "check", hint: "with a reason", run: () => activateSheet(ctx), data: { act: "activate" } },
      p.status === "active" && w && { label: "Pause", icon: "pause", run: () => pauseSheet(ctx), data: { act: "pause" } },
      p.status === "paused" && w && { label: "Resume", icon: "check", run: () => act(null, ctx, "resume", {}, "Back on"), data: { act: "resume" } },
      p.status === "expired" && w && { label: "Renew", icon: "check", run: () => act(null, ctx, "renew", {}, "Renewed"), data: { act: "renew" } },
      p.status === "cancelling" && c && { label: "Keep the plan", icon: "undo", run: run(withdraw), data: { act: "withdraw" } },
      ...(w ? seasonsToConfirm(p).map((y) => ({ label: `They said yes to ${y}`, icon: "check", run: () => confirmSeason(null, ctx, y), data: { "confirm-season": y } })) : []),
    ],
    [
      send && { label: "Send the agreement", icon: "send", run: () => sendSheet(ctx), data: { act: "send-agreement" } },
      send && { label: "Sign on this phone", icon: "phone", run: () => present(null, ctx), data: { act: "present-agreement" } },
    ],
    [
      claw && { label: fee ? "Storage fee billed" : "Clawback billed", icon: "money", run: () => clawback(ctx, "billed"), data: { act: "claw-billed" } },
      claw && s.can && s.can.waive && { label: fee ? "Waive storage fee" : "Waive clawback", icon: "close", run: () => clawback(ctx, "waived"), data: { act: "claw-waive" } },
      { label: "Open customer", icon: "user", href: "#/contacts/" + encodeURIComponent(p.contact_id) },
    ],
    [["active", "paused", "pending"].includes(p.status) && c && { label: "Cancel plan", icon: "close", danger: true, hint: "see what it costs first", run: () => cancelSheet(ctx), data: { act: "cancel" } }],
  ];
}

const TABS = [["service", "Service"], ["agree", "Agree"], ["schedule", "Schedule"]];

export default {
  title: (s) => (s && s.plan ? s.plan.name : "Plan"),
  load,
  tools: (s, ctx) => [canEdit(s, ctx) && { icon: "edit", label: "Edit the plan", run: () => openEditor(ctx, ctx.state.tab || "service"), data: { "edit-plan": true } }],
  more: (s, ctx) => moreRows(s, ctx),
  moreTitle: (s) => (s && s.plan ? s.plan.name : "Plan"),
  render(s, ctx) {
    const counts = { schedule: (s.plan.ordinals || []).filter((o) => o.status === "unscheduled").length };
    return html`<div class="rs-page pl-page">
      ${topCard(s)}${person(s)}
      ${seg(TABS.map(([k, l]) => ({ key: k, label: l, count: k === "schedule" && counts.schedule ? counts.schedule : null })), s.tab, { name: "plan", black: true, label: "Plan" })}
      <div class="rs-sp-pane" data-tab-pane>${s.tab === "agree" ? agreePane(s, ctx) : s.tab === "schedule" ? schedulePane(s, ctx) : servicePane(s, ctx)}</div>
    </div>`;
  },
  events: {
    "click [data-seg=plan]": (e, el, ctx) => { ctx.state.tab = ctx.keep.tab = el.dataset.key; ctx.rerender(); },
    "click [data-act=send-agreement]": (e, el, ctx) => sendSheet(ctx),
    "click [data-act=present-agreement]": (e, el, ctx) => present(el, ctx),
    "click [data-act=price]": (e, el, ctx) => priceSheet(ctx),
    "click [data-read]": (e, el, ctx) => readSheet(el.dataset.read, ctx),
    "click [data-send-ch]": (e, el, ctx) => resend(el, ctx),
    "click [data-autopay]": (e, el, ctx) => setAutopay(el, ctx),
    "change [data-notes]": (e, el, ctx) => saveNotes(el, ctx),
    "click [data-confirm-season]": (e, el, ctx) => confirmSeason(el, ctx, Number(el.dataset.confirmSeason)),
    "click [data-skip]": (e, el, ctx) => skip(el, ctx),
  },
};

// ------------------------------------------------------------ small actions

async function withdraw(el, ctx) {
  if (await confirmSheet("The cancellation is dropped and the plan goes on as before.", { title: "Keep the plan?", yes: "Keep it" })) act(el, ctx, "withdraw", {}, "The plan goes on");
}
async function confirmSeason(el, ctx, y) {
  if (!(await confirmSheet(`Their ${y} install and takedown are made, ready to book.`, { title: `They said yes to ${y}?`, yes: "Yes, make them" }))) return;
  act(el, ctx, "confirm-season", { season: y }, `${y} is on`);
}
async function skip(el, ctx) {
  const [term, n] = el.dataset.skip.split(":").map(Number);
  if (!(await confirmSheet("The visit comes off and its job is cancelled. Skipping doesn't turn into a credit.", { title: `Skip visit ${n}?`, yes: "Skip it" }))) return;
  act(el, ctx, "skip", { term, n }, "Skipped");
}
async function resend(el, ctx) {
  const [ch, id] = el.dataset.sendCh.split(":");
  busy(el, true, "Sending…");
  try {
    const r = await ctx.api(`/agreements/${encodeURIComponent(id)}/send`, { method: "POST", body: { channels: [ch] } });
    toast(r.data.sms_mode === "live" ? "Agreement sent" : "Sent to the Outbox (dry run)");
    ctx.refresh();
  } catch (err) { busy(el, false); toast(err.message, { bad: true }); }
}
async function patch(ctx, body) {
  const r = await ctx.api(`/plans/${encodeURIComponent(ctx.state.plan.id)}`, { method: "PATCH", body, ifMatch: ctx.state.etag });
  ctx.state.etag = r.etag || ctx.state.etag;
  return r;
}
async function setAutopay(el, ctx) {
  const on = el.getAttribute("aria-checked") !== "true";
  el.setAttribute("aria-checked", on ? "true" : "false");
  if (el.closest(".rs-sheetpage")) return; // the editor saves it with the rest
  try { await patch(ctx, { autopay: on }); toast(on ? "Auto-Pay on" : "Auto-Pay off"); ctx.refresh(); } catch (err) {
    el.setAttribute("aria-checked", on ? "false" : "true");
    toast(err.status === 412 ? "Someone else just changed this plan. Look again." : err.message, { bad: true });
  }
}
async function saveNotes(el, ctx) {
  if (el.closest(".rs-sheetpage")) return;
  const key = el.dataset.notes === "agreement" ? "agreement_notes" : "notes";
  try { await patch(ctx, { [key]: el.value }); toast("Notes saved"); ctx.state.plan[key] = el.value; } catch (err) { toast(err.status === 412 ? "Someone else just changed this plan. Look again." : err.message, { bad: true }); }
}

// ------------------------------------------------------------ the editor (a full-height sheet)

function openEditor(ctx, on = "service") {
  const s = ctx.state;
  const p = s.plan;
  const local = { discounts: (p.discounts || []).map((d) => ({ ...d })) };
  const drawService = () => servicePane(s, ctx, { editing: true, discounts: local.discounts });
  const pane = (k) => (k === "agree" ? agreePane(s, ctx) : k === "schedule" ? schedulePane(s, ctx) : html`<form class="pl-edit" data-plan-edit novalidate>${drawService()}</form>`);
  // a tap on Agree or Schedule's buttons: close the editor, then the page's own action
  const away = (fn) => (e, el, page) => { e.preventDefault(); page.close(); fn(e, el, ctx); };
  const page = sheetPage({
    title: p.name,
    seg: { items: TABS, on: TABS.some(([k]) => k === on) ? on : "service", black: true, label: "Plan" },
    panes: { service: pane("service"), agree: pane("agree"), schedule: pane("schedule") },
    done: { label: "Save", run: (pg) => saveEditor(pg, ctx, local) },
    events: {
      "click [data-autopay]": (e, el) => setAutopay(el, ctx),
      "click [data-renew]": (e, el) => el.setAttribute("aria-checked", el.getAttribute("aria-checked") === "true" ? "false" : "true"),
      "click [data-add-discount]": (e, el, pg) => addDiscountSheet(local, () => redrawService(pg)),
      "click [data-del-discount]": (e, el, pg) => { local.discounts.splice(Number(el.dataset.delDiscount), 1); redrawService(pg); },
      "click [data-act=price]": away(() => priceSheet(ctx)),
      "click [data-act=send-agreement]": away(() => sendSheet(ctx)),
      "click [data-act=present-agreement]": away(() => present(null, ctx)),
      "click [data-send-ch]": away((e, el) => resend(el, ctx)),
      "click [data-read]": (e, el) => readSheet(el.dataset.read, ctx),
      "click [data-skip]": away((e, el) => skip(el, ctx)),
      "click [data-confirm-season]": away((e, el) => confirmSeason(null, ctx, Number(el.dataset.confirmSeason))),
      "submit [data-plan-edit]": (e) => e.preventDefault(),
    },
  });
  function redrawService(pg) {
    const box = pg.body.querySelector('[data-pane="service"] [data-plan-edit]');
    if (!box) return;
    // keep what was typed: read it, redraw, put it back
    const keep = {};
    for (const x of box.querySelectorAll("select[name], input[name], textarea[data-notes]")) keep[x.name || x.dataset.notes] = x.value;
    const sw = {};
    for (const x of box.querySelectorAll("[data-autopay], [data-renew]")) sw[x.hasAttribute("data-autopay") ? "autopay" : "renew"] = x.getAttribute("aria-checked");
    render(box, drawService());
    for (const x of box.querySelectorAll("select[name], input[name], textarea[data-notes]")) { const k = x.name || x.dataset.notes; if (keep[k] !== undefined) x.value = keep[k]; }
    for (const x of box.querySelectorAll("[data-autopay], [data-renew]")) { const k = x.hasAttribute("data-autopay") ? "autopay" : "renew"; if (sw[k]) x.setAttribute("aria-checked", sw[k]); }
  }
  return page;
}

function addDiscountSheet(local, done) {
  const sh = sheet({
    title: "Add a discount",
    body: html`<form class="form" data-disc-form novalidate>
      <label class="field"><span>Name</span><input name="name" maxlength="60" autocomplete="off" value="Plan discount"></label>
      <label class="field"><span>Off each visit ($)</span><input name="amount" inputmode="decimal" placeholder="50.00"></label>
      <p class="err" data-form-err hidden></p>
      <button type="submit" class="btn primary block">Add it</button></form>`,
    events: {
      "submit [data-disc-form]": (e, form) => {
        e.preventDefault();
        const v = readForm(form);
        const c = readMoney(v.amount);
        if (!Number.isInteger(c) || c <= 0) { showError(form, { message: "Use an amount like 50.00." }); return; }
        local.discounts.push({ name: String(v.name || "Plan discount").trim().slice(0, 60) || "Plan discount", type: "fixed", value: c, scope: { type: "all" } });
        sh.close(); done();
      },
    },
  });
}

// What the edit changes, from the sheet's controls. → { changes, patch }
function readEditor(pg, s, local) {
  const p = s.plan;
  const t = p.term || {};
  const q = (sel) => pg.body.querySelector(sel);
  const changes = {};
  const patchBody = {};
  const f = q("select[name=frequency]");
  if (f && f.value && !(p.frequency && p.frequency.interval === "month" && String(p.frequency.count) === f.value)) changes.frequency = { interval: "month", count: Number(f.value) };
  const len = q("select[name=term_months]");
  if (len && Number(len.value) !== t.initial_months) changes.term_months = Number(len.value);
  const st = q("input[name=start_on]");
  if (st && st.value && st.value !== t.start_on) changes.start_on = st.value;
  const rn = q("[data-renew]");
  if (rn && (rn.getAttribute("aria-checked") === "true") !== (t.auto_renew !== false)) changes.auto_renew = rn.getAttribute("aria-checked") === "true";
  const bm = q("select[name=billing_mode]");
  if (bm && bm.value !== ((p.billing || {}).mode || "barta_standard")) changes.billing_mode = bm.value;
  if (JSON.stringify(local.discounts) !== JSON.stringify(p.discounts || [])) changes.discounts = local.discounts.map(({ name, type, value, scope, key, id }) => ({ name, type, value, scope, ...(key ? { key } : {}), ...(id ? { id } : {}) }));
  const ap = q('[data-pane="service"] [data-autopay]');
  if (ap && (ap.getAttribute("aria-checked") === "true") !== !!(p.billing || {}).autopay) patchBody.autopay = ap.getAttribute("aria-checked") === "true";
  const pr = q("select[name=property_id]");
  if (pr && pr.value && pr.value !== p.property_id) patchBody.property_id = pr.value;
  const n1 = q('[data-pane="service"] textarea[data-notes=plan]');
  if (n1 && n1.value !== (p.notes || "")) patchBody.notes = n1.value;
  const n2 = q('[data-pane="agree"] textarea[data-notes=agreement]');
  if (n2 && n2.value !== (p.agreement_notes || "")) patchBody.agreement_notes = n2.value;
  return { changes, patch: patchBody };
}

const showValue = (field, v) => {
  if (field === "frequency") return freqText(v);
  if (field === "term_months") return `${v} months`;
  if (field === "auto_renew") return v ? "Yes" : "No";
  if (field === "start_on") return dateYear(v);
  if (field === "billing_mode") return BILLING_SHORT[v] || v;
  if (field === "discounts") return (v || []).length ? v.map((d) => `${d.name} ${discText(d)}`).join(", ") : "None";
  return String(v);
};

// The confirm sheet: what changes, what happens to the visits and the agreement. → boolean
function confirmEdit(sum) {
  return new Promise((resolve) => {
    let answered = false;
    const v = sum.visits || {};
    const ag = { needs_new: "The signed agreement stays on file. The plan needs a new agreement: send it from Agree.", replaced: "The agreement waiting to be signed says the old terms: it's withdrawn. Send a new one from Agree.", none: "", same: "" }[sum.agreement] || "";
    const s = sheet({
      title: "Save these changes?",
      body: html`<div class="stack" data-edit-confirm>
        <ul class="pl-facts">${(sum.fields || []).map((f) => html`<li><span class="k">${FIELD_NAMES[f.field] || f.field}</span><span class="v">${showValue(f.field, f.from)} → ${showValue(f.field, f.to)}</span></li>`)}</ul>
        ${v.removed || v.added ? html`<p>Visits still to book are made again for the new terms: ${v.removed} out, ${v.added} in${(v.months || []).length ? ` (${v.months.map(monthLabel).join(", ")})` : ""}. Booked and done visits stay as they are.${sum.cancel_jobs ? ` ${sum.cancel_jobs} job${sum.cancel_jobs === 1 ? "" : "s"} waiting to be booked ${sum.cancel_jobs === 1 ? "is" : "are"} cancelled and new ones made.` : ""}</p>` : ""}
        ${ag ? html`<p class="note">${ag}</p>` : ""}
        ${sum.would ? html`<p class="warn-box">Rotor is still in charge of this plan: nothing changes here. Change it in Rotor; the next import brings it over.</p>` : ""}
        <p class="small muted">Plan value this term: ${money(sum.sale_value_cents)}.</p>
        <div class="btn-row"><button type="button" class="btn" data-a="no">Cancel</button><button type="button" class="btn primary" data-a="yes">Save</button></div></div>`,
      onClose: () => { if (!answered) resolve(false); },
      events: { "click [data-a]": (e, b) => { answered = true; resolve(b.dataset.a === "yes"); s.close(); } },
    });
  });
}

async function saveEditor(pg, ctx, local) {
  const s = ctx.state;
  const id = encodeURIComponent(s.plan.id);
  const { changes, patch: body } = readEditor(pg, s, local);
  const hasEdit = Object.keys(changes).length > 0;
  if (!hasEdit && !Object.keys(body).length) return true;
  try {
    let sum = null;
    if (hasEdit) {
      sum = (await ctx.api(`/plans/${id}/edit`, { method: "POST", body: { changes, preview: true } })).data.summary;
      if (!(await confirmEdit(sum))) return false;
    }
    if (Object.keys(body).length) await patch(ctx, body);
    if (hasEdit) {
      const r = await ctx.api(`/plans/${id}/edit`, { method: "POST", body: { changes }, ifMatch: ctx.state.etag });
      if (r.data.would) toast("Rotor is still in charge of this plan: nothing changed here.", { bad: true });
      else {
        const run = await waitRun(ctx.api, r.data.run_id);
        if (!run) toast("Still working. Check back in a minute.");
        else if (run.status === "done") toast("Plan saved");
        else toast((run.result && run.result.message) || "That didn't go through. Try again.", { bad: true });
      }
    } else toast("Plan saved");
    ctx.refresh();
    return true;
  } catch (err) {
    toast(err.status === 412 || (err.code === "stale") ? "Someone else just changed this plan. Look again." : err.message, { bad: true });
    return false;
  }
}

// A change is a run: start it, follow it, refresh.
async function act(el, ctx, action, body, done) {
  if (el) busy(el, true, "Working…");
  try {
    const r = await ctx.api(`/plans/${encodeURIComponent(ctx.state.plan.id)}/${action}`, { method: "POST", body });
    const run = await waitRun(ctx.api, r.data.run_id);
    if (!run) toast("Still working. Check back in a minute.");
    else if (run.status === "done") toast(done);
    else toast("That didn't go through. Try again.", { bad: true });
    ctx.refresh();
  } catch (err) { if (el) busy(el, false); toast(err.message, { bad: true }); }
}

function pauseSheet(ctx) {
  const today = localDate();
  const sh = sheet({
    title: "Pause the plan",
    body: html`<form class="form" data-pause novalidate>
      <p class="muted">Booked visits from that day on come off the schedule and the customer gets a text. Visits still to book wait; when the plan picks back up they move by the paused months.</p>
      ${dateField({ label: "From", name: "from", value: today, min: today })}
      ${dateField({ label: "Back on (optional)", name: "until", min: today })}
      <label class="field" data-field="reason"><span>Why (optional)</span><input name="reason" maxlength="300" autocomplete="off"></label>
      <p class="err" data-form-err hidden></p>
      <button type="submit" class="btn primary block">Pause</button></form>`,
    events: {
      "submit [data-pause]": async (e, form) => {
        e.preventDefault();
        const v = readForm(form);
        sh.close();
        await act(null, ctx, "pause", { from: v.from, until: v.until || undefined, reason: v.reason }, "Paused");
      },
    },
  });
}

function activateSheet(ctx) {
  const sh = sheet({
    title: "Activate without a signature",
    body: html`<form class="form" data-activate novalidate><p class="muted">For a customer who signed on paper or said yes another way. Say how, for the record.</p>
      <label class="field" data-field="override_reason"><span>How they agreed</span><input name="override_reason" maxlength="300" autocomplete="off" required></label>
      <p class="err" data-form-err hidden></p><button type="submit" class="btn primary block">Activate</button></form>`,
    events: {
      "submit [data-activate]": async (e, form) => {
        e.preventDefault();
        const v = readForm(form);
        if (!String(v.override_reason || "").trim()) { showError(form, { field: "override_reason", message: "Say how they agreed." }); return; }
        sh.close();
        await act(null, ctx, "activate", { override_reason: v.override_reason.trim() }, "Active");
      },
    },
  });
}

async function cancelSheet(ctx) {
  const p = ctx.state.plan;
  let q;
  try { q = (await ctx.api(`/plans/${encodeURIComponent(p.id)}/cancel-quote`, { cache: false })).data; } catch (err) { toast(err.message, { bad: true }); return; }
  const owner = ctx.user && ctx.user.role === "owner";
  const sh = sheet({
    title: "Cancel the plan",
    body: html`<form class="form" data-cancel novalidate>
      <div class="card" style="margin:0"><ul class="pl-facts">
        <li><span class="k">Ends</span><span class="v">${q.immediate ? "Today" : dateYear(q.effective_on)}</span></li>
        <li><span class="k">Why then</span><span class="v">${q.inside_initial_term ? `${q.notice_days} days' notice in the first term` : "The end of this renewal term"}</span></li>
        <li><span class="k">Visits still happening</span><span class="v">${q.visits_still_happen}</span></li>
        <li><span class="k">${q.storage_fee_cents ? "Storage fee (3-year contract)" : "First-visit discount back"}</span><span class="v">${q.clawback_cents ? `${cents(q.clawback_cents)} (a draft for an owner's OK)` : "None"}</span></li>
      </ul></div>
      <label class="field" data-field="reason"><span>Why</span><select name="reason">${CANCEL_REASONS.map(([v, l]) => html`<option ${attrs({ value: v })}>${l}</option>`)}</select></label>
      <label class="field" data-field="note"><span>${owner ? "Note (optional)" : "Note"}</span><input name="note" maxlength="500" autocomplete="off"><small class="why" hidden></small></label>
      <p class="err" data-form-err hidden></p>
      <button type="submit" class="btn danger block">Cancel the plan</button></form>`,
    events: {
      "submit [data-cancel]": async (e, form) => {
        e.preventDefault();
        clearErrors(form);
        const v = readForm(form);
        if (!owner && !String(v.note || "").trim()) { showError(form, { field: "note", message: "Add a note on why." }); return; }
        sh.close();
        await act(null, ctx, "cancel", { reason: v.reason, note: v.note || undefined }, "Cancellation set");
      },
    },
  });
}

function priceSheet(ctx) {
  const p = ctx.state.plan;
  const sh = sheet({
    title: "Change the price",
    body: html`<form class="form" data-price novalidate>
      <p class="muted">The new price starts at the first renewal on or after the date (at least 30 days out, after ${dateYear(p.term.price_locked_until)}). The customer gets a notice with the renewal.</p>
      ${(p.lines || []).map((l, i) => html`<label class="field"><span>${l.title}</span><input ${attrs({ name: `line_${i}`, inputmode: "decimal", value: ((l.total_cents || 0) / 100).toFixed(2) })}></label>
        ${l.scope && l.scope.type !== "all" ? html`<label class="check"><input ${attrs({ type: "checkbox", name: `all_${i}` })}><span>Apply to all jobs (now: ${scopeText(l.scope, p.visits_per_year).toLowerCase()})</span></label>` : ""}`)}
      ${dateField({ label: "Starting", name: "effective_on" })}
      <p class="err" data-form-err hidden></p>
      <button type="submit" class="btn primary block">Save the new price</button></form>`,
    events: {
      "submit [data-price]": async (e, form) => {
        e.preventDefault();
        clearErrors(form);
        const v = readForm(form);
        const lines = (p.lines || []).map((l, i) => ({ id: l.id, title: l.title, qty_milli: 1000, unit_cents: readMoney(v[`line_${i}`]), scope: v[`all_${i}`] ? { type: "all" } : l.scope, service_type: l.service_type }));
        if (lines.some((l) => !Number.isInteger(l.unit_cents))) { showError(form, { message: "Use amounts like 245.00." }); return; }
        const btn = form.querySelector("[type=submit]");
        busy(btn, true);
        try {
          await ctx.api(`/plans/${encodeURIComponent(p.id)}/change-price`, { method: "POST", body: { new_lines: lines, effective_on: v.effective_on } });
          sh.close(); toast("New price saved"); ctx.refresh();
        } catch (err) { busy(btn, false); showError(form, err); }
      },
    },
  });
}

async function clawback(ctx, how) {
  let reason;
  if (how === "waived") {
    const sh = await new Promise((resolve) => {
      const s = sheet({
        title: "Waive the clawback",
        body: html`<form class="form" data-waive novalidate><label class="field"><span>Why</span><input name="reason" maxlength="300" autocomplete="off"></label><button type="submit" class="btn primary block">Waive it</button></form>`,
        onClose: () => resolve(null),
        events: { "submit [data-waive]": (e, form) => { e.preventDefault(); const v = readForm(form); if (!String(v.reason || "").trim()) return; resolve(v.reason.trim()); s.close(); } },
      });
    });
    if (!sh) return;
    reason = sh;
  }
  try {
    await ctx.api(`/plans/${encodeURIComponent(ctx.state.plan.id)}`, { method: "PATCH", body: { clawback: how, ...(reason ? { reason } : {}) }, ifMatch: ctx.state.etag });
    toast(how === "waived" ? "Waived" : "Marked billed"); ctx.refresh();
  } catch (err) { toast(err.status === 412 ? "Someone else just changed this plan. Look again." : err.message, { bad: true }); }
}

function sendSheet(ctx) {
  const c = ctx.state.contact || {};
  const dry = ctx.state.sms_mode !== "live" && ctx.state.sms_mode !== "test";
  const sh = sheet({
    title: "Send the agreement",
    body: html`<form class="form" data-send>
      <p class="muted">A link to read and sign it on their phone. It works for 30 days; a reminder goes out each day until it's signed (up to 7).</p>
      <label class="check"><input ${attrs({ type: "checkbox", name: "sms", checked: !!c.phone, disabled: !c.phone })}><span>Text${c.phone ? ` to ${phone(c.phone)}` : " (no mobile on file)"}</span></label>
      <label class="check"><input ${attrs({ type: "checkbox", name: "email", checked: !!c.email && !c.phone, disabled: !c.email })}><span>Email${c.email ? ` to ${c.email}` : " (no email on file)"}</span></label>
      ${dry ? html`<p class="note">Texts and emails don't leave the CRM yet: they land in the Outbox.</p>` : ""}
      <p class="err" data-form-err hidden></p>
      <button type="submit" class="btn primary block">${icon("send")}Send</button></form>`,
    events: {
      "submit [data-send]": async (e, form) => {
        e.preventDefault();
        const channels = ["sms", "email"].filter((k) => form.elements[k] && form.elements[k].checked);
        const err = form.querySelector("[data-form-err]");
        if (!channels.length) { err.textContent = "Pick text, email or both."; err.hidden = false; return; }
        const btn = form.querySelector("[type=submit]");
        busy(btn, true, "Sending…");
        try {
          await ctx.api(`/plans/${encodeURIComponent(ctx.state.plan.id)}/send-agreement`, { method: "POST", body: { channels } });
          sh.close(); toast(dry ? "Sent to the Outbox (dry run)" : "Agreement sent"); ctx.refresh();
        } catch (er) { busy(btn, false); err.textContent = er.message; err.hidden = false; }
      },
    },
  });
}

async function present(el, ctx) {
  busy(el, true, "Getting it ready…");
  try {
    const a = await ctx.api("/agreements", { method: "POST", body: { plan_id: ctx.state.plan.id } });
    const r = await ctx.api(`/agreements/${encodeURIComponent(a.data.id)}/present`, { method: "POST", body: {} });
    busy(el, false);
    sheet({
      title: "Sign on this phone",
      body: html`<div class="stack"><p class="muted">Opens the agreement for the customer on this phone: they read it, type their name, sign with a finger. It works once, for 15 minutes.</p>
        <a class="btn primary block" ${openExternal(r.data.url)}>${icon("phone")}Open for the customer</a></div>`,
    });
  } catch (err) { busy(el, false); toast(err.message, { bad: true }); }
}

async function readSheet(id, ctx) {
  try {
    const r = await ctx.api(`/agreements/${encodeURIComponent(id)}`, { cache: false });
    sheet({ title: r.data.title, body: html`<div class="stack"><p class="small muted">${r.data.status === "signed" ? `Signed ${dateShort(r.data.signed_at)} by ${r.data.signature ? r.data.signature.name_typed : ""}` : "Not signed yet"}</p><div class="pl-doc">${r.data.body_rendered}</div></div>` });
  } catch (err) { toast(err.message, { bad: true }); }
}
