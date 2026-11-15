// The job page on a phone (Nov 2026, the owner's screenshots: Rotor's phone
// job page, with Flyra's top, "best of both"). A desk keeps the Rotor-desktop
// two columns (office-job.js); under 700 px the page is this one scroll:
//
//   Flyra's top: the title (the work, "Service #2" on a plan), "customer ·
//   job number", the visit's day and time with Rotor's duration chip, who
//   goes (colored dots), the status and amount pills, when it was made; the
//   one big step button (On my way → Start Job → Complete Job) with the
//   4-step bar under it; the address (Rotor's card: directions, the pencil);
//   the quick row Reschedule · Invoice · Callback · More; the plan card (its
//   name, how often and the price a visit, the card on file); Amount due
//   with Checkout and Send link · QR code · Cash or check.
//   Then Rotor's cards: the customer (call, text), Pricing (a card a line:
//   the name, "Added on site" with the tech who added it, a camera for a
//   photo of the line, Qty and Price; "+ Item", Subtotal, discounts with a
//   pencil, "+ Add discount", Total, Create Invoice), Invoices (+), Job notes
//   (with an upload), the office's and the plan's notes, Sold by, the other
//   visits; a red-outline Delete Job; and the floating "N left" checklist pill.
//
// What the desk's stat cards and track show lives here too: the job total is
// the amount pill, the balance is Amount due, time on site is in the top
// card, the track is the 4-step bar and the pills. Everything else is in
// the round "..." (the same rows as the desk).

import { html, attrs, icon, raw, rnd, statusPill, pillBtn, notesBox, personCard, addressCard, disclosure } from "../../core/ui.js";
import { money, dateShort, dateYear, time as fmtTime, phone as formatPhone } from "../../core/format.js";
import { directionsUrl } from "../../core/map.js";
import { range, officeView, VISIT_STATUS } from "./office-kit.js";
import { checklistPill } from "./checklist-sheet.js";
import { currentVisit, itemsOf, itemDone } from "./checklist-kit.js";
import { QR_ICON } from "../money/pay-qr.js";

export const PHONE_MEDIA = "(max-width: 699px)";
export const isPhone = () => typeof matchMedia === "function" && matchMedia(PHONE_MEDIA).matches;

const OPEN_VISIT = ["scheduled", "en_route", "in_progress", "paused"];
const JOB_WORD = { unscheduled: "To book", scheduled: "Scheduled", in_progress: "In progress", completed: "Done", cancelled: "Cancelled" };
const JOB_TONE = { unscheduled: "amber", scheduled: "blue", in_progress: "amber", completed: "green", cancelled: "red" };
const svg = (d) => raw(`<svg viewBox="0 0 24 24" aria-hidden="true" focusable="false">${d}</svg>`);
const I = {
  repeat: svg('<path d="M17 3.5l3 3-3 3M20 6.5H8.5A4.5 4.5 0 0 0 4 11M7 20.5l-3-3 3-3M4 17.5h11.5A4.5 4.5 0 0 0 20 13"/>'),
  callback: svg('<path d="M6.6 3.5h2.6l1.4 4-2 1.3a11 11 0 0 0 5.6 5.6l1.3-2 4 1.4v2.6a2 2 0 0 1-2.2 2A15.5 15.5 0 0 1 4.6 5.7a2 2 0 0 1 2-2.2zM15 3.5h5.5V9M20.5 3.5L14 10"/>'),
  invoice: svg('<rect x="3.5" y="5.5" width="17" height="13" rx="2"/><path d="M4 7l8 6 8-6"/>'),
  wallet: svg('<path d="M4.5 7.5V17a2 2 0 0 0 2 2h12a1.5 1.5 0 0 0 1.5-1.5v-8A1.5 1.5 0 0 0 18.5 8H6.5a2 2 0 0 1-2-2 2 2 0 0 1 2-2H17v4"/><circle cx="16" cy="13.5" r="1.2"/>'),
  tap: svg('<path d="M8 8.5a5 5 0 0 1 0 7M11.5 6a8.5 8.5 0 0 1 0 12M15 3.5a12 12 0 0 1 0 17"/>'),
  upload: svg('<path d="M12 15.5V4M7.5 8.5L12 4l4.5 4.5M4.5 14.5V18a2 2 0 0 0 2 2h11a2 2 0 0 0 2-2v-3.5"/>'),
  chev: svg('<path d="M7 10l5 5 5-5"/>'),
};
const tel = (ph) => String((ph && ph.e164) || "").replace(/[^+\d]/g, "");
const initialsOf = (name) => String(name || "").trim().split(/\s+/).filter(Boolean).slice(0, 2).map((w) => w[0].toUpperCase()).join("") || "?";
const DOTS = ["#c7c7cc", "#3b4cca", "#13a165", "#d97706", "#db3a29", "#7c3aed"];

// "2 hrs", "1 hr 30 min", "45 min" from a visit's start and end
export function lengthText(v) {
  const m = (s) => { const x = /^(\d{1,2}):(\d{2})$/.exec(String(s || "")); return x ? Number(x[1]) * 60 + Number(x[2]) : null; };
  const a = m(v && v.start), b = m(v && v.end);
  if (a === null || b === null || b <= a) return "";
  const d = b - a, h = Math.floor(d / 60), r = d % 60;
  return h ? `${h} ${h === 1 ? "hr" : "hrs"}${r ? ` ${r} min` : ""}` : `${r} min`;
}

// Flyra's 4 steps for the job's visit: On my way · Arrive · Start Job · Complete Job (how many are done).
export const STEPS4 = ["On my way", "Arrive", "Start Job", "Complete Job"];
export function stepsDone(v) {
  if (!v) return 0;
  if (v.status === "completed") return 4;
  const arrived = itemsOf(v).some((i) => i.hook === "start" && itemDone(i));
  if (["in_progress", "paused"].includes(v.status)) return 3;
  if (v.status === "en_route") return arrived ? 2 : 1;
  return 0;
}

// The big step button for the visit's own people (the Visit screen's steps); someone else gets the office's step.
export function bigStep(s, ctx, v) {
  const c = s.can || {};
  const mine = !!(v && ctx && ctx.user && (v.assignee_ids || []).includes(ctx.user.id) && OPEN_VISIT.includes(v.status));
  if (mine) {
    if (v.status === "scheduled") return { label: "On my way", attr: { "data-v-omw": v.id }, icon: "truck" };
    if (v.status === "en_route") return { label: "Start Job", attr: { "data-v-start": v.id }, icon: "play" };
    if (v.status === "paused") return { label: "Resume", attr: { "data-v-start": v.id }, icon: "play" };
    const left = itemsOf(v).filter((i) => i.required && !itemDone(i)).length;
    return { label: "Complete Job", attr: { "data-v-done": v.id }, icon: "check", note: left ? `${left} required ${left === 1 ? "item" : "items"} on the checklist first` : "" };
  }
  const j = s.job;
  if (!(s.visits || []).some((x) => OPEN_VISIT.includes(x.status)) && c.add_visit && j.status === "unscheduled") return { label: "Book a visit", attr: { "data-book": true }, icon: "cal" };
  const allDone = (s.visits || []).length && (s.visits || []).every((x) => !OPEN_VISIT.includes(x.status)) && (s.visits || []).some((x) => x.status === "completed");
  if (c.complete && allDone) return { label: "Mark done", attr: { "data-complete": true }, icon: "check" };
  return null;
}

function headCard(s, ctx, v, h) {
  const j = s.job;
  const n = j.plan_ordinal && j.plan_ordinal.n;
  const title = `${j.title || "Job"}${n && !/visit \d|service #/i.test(j.title || "") ? ` - Service #${n}` : ""}`;
  const who = [s.contact && s.contact.display_name, j.number_label].filter(Boolean).join(" · ");
  const users = s.users || [];
  const people = v ? (v.assignee_ids || []).map((id, i) => {
    const u = users.find((x) => x.id === id);
    return { name: (s.people && s.people[id] && s.people[id].name) || (u && u.name) || "Someone", color: (u && u.color) || DOTS[i % DOTS.length] };
  }) : [];
  const len = v && !v.date_only ? lengthText(v) : "";
  const when = v ? `${dateShort(v.date)}${v.date_only ? " · Anytime" : ""}` : j.target_month && j.status === "unscheduled" ? `Due by ${h.monthLabel(j.target_month)}` : "Not booked yet";
  const b = h.billing(s, ctx.can);
  const paid = b.inv && b.inv.st === "paid";
  const part = b.inv && !paid && b.inv.bal > 0 && b.inv.bal < b.inv.tot;
  const bill = b.inv ? statusPill(paid ? "Paid" : part ? "Partially paid" : "Invoiced", paid ? "green" : part ? "amber" : "blue")
    : j.plan_id ? statusPill("Plan visit", "fill-green")
    : s.invoices && j.billable !== false && j.status !== "cancelled" && j.totals && j.totals.total_cents > 0 && officeView() ? statusPill("Not invoiced", "amber") : "";
  const site = h.onSite(s.visits);
  const move = v && OPEN_VISIT.includes(v.status) && v.status === "scheduled" && officeView() && s.can && s.can.write;
  return html`<section class="jp-head" aria-label="The job">
    <h2 class="jp-title">${title}</h2>
    ${who ? html`<p class="jp-who">${who}</p>` : ""}
    <div class="jp-when"><span class="jp-day">${when}</span>${v && !v.date_only ? html`<span class="jp-time num">${range(v.start, v.end)}</span>` : ""}
      ${len ? (move ? html`<button type="button" class="jp-len" ${attrs({ "data-v-move": v.id, "aria-label": `${len}, change the time` })}>${icon("clock")}<span>${len}</span>${I.chev}</button>` : html`<span class="jp-len">${icon("clock")}<span>${len}</span></span>`) : ""}</div>
    ${people.length ? html`<p class="jp-people">${people.map((p) => html`<span class="jp-person"><i ${attrs({ style: `background:${p.color}` })} aria-hidden="true"></i>${p.name}</span>`)}</p>` : ""}
    <p class="rs-pills jp-pills">${statusPill(JOB_WORD[j.status] || j.status, JOB_TONE[j.status] || "grey")}${j.totals ? statusPill(money(j.totals.total_cents), "white") : ""}${bill}${j.billable === false ? statusPill("No charge", "grey") : ""}</p>
    ${j.status === "cancelled" && j.cancel_reason ? html`<p class="warn-box">Cancelled: ${j.cancel_reason}</p>` : ""}
    <p class="jp-made">${[j.created_at ? `Created ${dateYear(j.created_at)} at ${fmtTime(j.created_at)}` : "", site ? `${site} on site` : ""].filter(Boolean).join(" · ")}</p>
  </section>`;
}

function stepCard(s, ctx, v) {
  const go = bigStep(s, ctx, v);
  const n = stepsDone(v);
  if (!go && !v) return "";
  return html`<section class="jp-step" aria-label="The visit's steps">
    ${go ? html`<button type="button" class="jp-go" ${attrs(go.attr)}>${icon(go.icon)}<span>${go.label}</span></button>${go.note ? html`<p class="jp-note">${go.note}</p>` : ""}` : ""}
    ${v ? html`<ol class="jp-bar" ${attrs({ "aria-label": `${n} of 4 steps done` })}>${STEPS4.map((l, i) => html`<li ${attrs({ class: i < n ? "on" : "", "aria-current": i === n ? "step" : null })}><i aria-hidden="true"></i><span>${l}</span></li>`)}</ol>` : ""}
  </section>`;
}

function quick(s, ctx, v, h) {
  const j = s.job;
  const c = s.can || {};
  const office = officeView();
  const b = h.billing(s, ctx.can);
  const tile = (label, ic, a = {}, off = false) => html`<button type="button" class="jp-q" ${attrs({ ...a, "aria-disabled": off ? "true" : null })}>${ic}<span>${label}</span></button>`;
  const link = (label, ic, href) => html`<a class="jp-q" ${attrs({ href })}>${ic}<span>${label}</span></a>`;
  const open = v && v.status === "scheduled";
  return html`<nav class="jp-quick" aria-label="Quick actions">
    ${office && c.write && open ? tile("Reschedule", icon("cal"), { "data-v-move": v.id }) : office && c.add_visit ? tile("Reschedule", icon("cal"), { "data-book": true, "aria-label": "Book a visit" }) : tile("Reschedule", icon("cal"), { "data-jp-off": "Only the office moves a visit." }, true)}
    ${b.inv && office ? link("Invoice", I.invoice, "#/invoices/" + encodeURIComponent(b.inv.id)) : b.ready ? tile("Invoice", I.invoice, { "data-make-invoice": true, "aria-label": "Create an invoice from this job" }) : tile("Invoice", I.invoice, { "data-jp-off": b.why || "There's no invoice to open." }, true)}
    ${office && c.write && j.status === "completed" ? tile("Callback", I.callback, { "data-q-callback": true, "aria-label": "Book a callback (no charge)" }) : tile("Callback", I.callback, { "data-jp-off": "A callback is booked once the job is done." }, true)}
    ${tile("More", icon("more"), { "data-jp-more": true, "aria-haspopup": "dialog" })}
  </nav>`;
}

function planCard(s) {
  const p = s.plan;
  if (!p || !s.job.plan_id) return "";
  const card = s.planCard;
  const has = card && card.status !== "none" && (card.last4 || card.status === "active");
  const per = s.job.totals ? `${money(s.job.totals.total_cents)} / visit` : "";
  const how = [s.planFreq || "", per].filter(Boolean).join(" · ");
  return html`<section class="rs-card jp-plan">
    <a class="jp-plan-top" ${attrs({ href: "#/plans/" + encodeURIComponent(p.id) })}><span class="jp-tile" aria-hidden="true">${I.repeat}</span><span class="jp-plan-w"><b>${p.name || "Service plan"}</b>${how ? html`<span class="rs-sub">${how}</span>` : ""}</span><span class="chev" aria-hidden="true"></span></a>
    ${s.planFeatures && s.planFeatures.money === false ? "" : html`<div class="jp-plan-card">${has ? statusPill(card.last4 ? `${String(card.brand || "Card").toUpperCase()} ending ${card.last4}` : "Card on file", "green") : html`${statusPill("No card on file", "amber")}${pillBtn("Add card on file", { tone: "white", href: "#/plans/" + encodeURIComponent(p.id) })}`}</div>`}
  </section>`;
}

// Flyra's "Amount due" with Checkout and its three ways to be paid (dry run until payments are live).
export function amountDue(s, ctx, h) {
  if (!officeView()) return null;
  if (!(ctx.can("payments:record") || ctx.can("invoices:send") || ctx.can("invoices:write"))) return null;
  const due = h.balanceDue(s);
  if (!(due > 0)) return null;
  const b = h.billing(s, ctx.can);
  const j = s.job;
  if (!(b.inv && ["open", "draft"].includes(b.inv.st)) && !["in_progress", "completed"].includes(j.status)) return null;
  return due;
}
function dueCard(s, ctx, h) {
  const due = amountDue(s, ctx, h);
  if (due === null) return "";
  const act = (label, ic, data) => html`<button type="button" class="jp-pay" ${attrs(data)}>${ic}<span>${label}</span></button>`;
  return html`<section class="rs-card jp-due" aria-label="Amount due">
    <p class="jp-due-l">Amount due</p><p class="jp-due-v num">${money(due)}</p>
    <button type="button" class="jp-checkout" data-checkout>${I.tap}<span>Checkout</span></button>
    <div class="jp-pays">${act("Send link", icon("send"), { "data-pay-link": true })}${act("QR code", QR_ICON, { "data-pay-qr": true })}${act("Cash or check", I.wallet, { "data-pay-cash": true })}</div>
  </section>`;
}

function customer(s) {
  const c = s.contact;
  if (!c) return "";
  const ph = (c.phones || []).find((x) => x.primary) || (c.phones || [])[0];
  const n = tel(ph);
  const name = c.display_name || "Customer";
  return personCard({ name, sub: ph && ph.e164 ? formatPhone(ph.e164) : "", href: officeView() ? "#/contacts/" + encodeURIComponent(c.id) : null, initials: initialsOf(name).slice(0, 1), call: n ? "tel:" + n : null, text: n ? "sms:" + n : null });
}
function place(s) {
  const p = s.property;
  const a = p && p.address;
  if (!a || !(a.street1 || a.city)) return "";
  const gate = p.access && p.access.gate_code;
  return addressCard({
    line1: a.street1 || a.city,
    line2: [[a.city, [a.state, a.zip].filter(Boolean).join(" ")].filter(Boolean).join(", "), gate ? `gate ${gate}` : ""].filter(Boolean).join(" · "),
    nav: directionsUrl(a),
    edit: officeView() && p.id ? { label: "Edit the place and its access", href: "#/properties/" + encodeURIComponent(p.id) } : null,
  });
}

// Pricing: Flyra's card a line (name, camera, Qty and Price) inside Rotor's card.
function pricing(s, ctx, v, h) {
  const j = s.job;
  const c = s.can || {};
  const open = !["completed", "cancelled"].includes(j.status);
  const edit = c.write && open;
  const lines = j.lines || [];
  const prices = !!j.totals;
  const ds = j.discounts || [];
  const b = h.billing(s, ctx.can);
  if (!lines.length && !edit) return "";
  const photos = (s.visits || []).flatMap((x) => x.photos || []);
  const users = s.users || [];
  const canPhoto = !!(v && v.status !== "cancelled" && (c.write || (ctx.user && (v.assignee_ids || []).includes(ctx.user.id))));
  const qty = (l) => { const q = (l.qty_milli ?? 1000) / 1000; return Number.isInteger(q) ? String(q) : q.toFixed(2); };
  const card = (l) => {
    const by = l.upsell_user_id ? users.find((u) => u.id === l.upsell_user_id) || (s.people && s.people[l.upsell_user_id]) || { name: "The tech" } : null;
    const shots = photos.filter((p) => p.line && p.line === l.id).length;
    const main = html`<span class="jp-li-name"><b>${l.title}</b>${by ? html`<span class="jp-onsite"><span class="jp-tag">Added on site</span><span class="jp-av" ${attrs({ title: by.name, style: by.color ? `background:${by.color}` : null })}>${initialsOf(by.name)}</span><span class="sr">by ${by.name}</span></span>` : ""}</span>`;
    const foot = html`<span class="jp-li-q"><span class="jp-li-k">Qty${edit ? I.chev : ""}</span><span class="num">${qty(l)}</span></span><span class="jp-li-p"><span class="jp-li-k">Price</span><b class="num">${prices && l.total_cents != null ? money(l.total_cents) : ""}</b></span>`;
    return html`<li class="jp-li">
      <div class="jp-li-top">${edit ? html`<button type="button" class="jp-li-open" ${attrs({ "data-line": l.id, "aria-label": `${l.title}, change it` })}>${main}</button>` : html`<span class="jp-li-open">${main}</span>`}
        ${canPhoto && l.id ? html`<button type="button" class="jp-cam" ${attrs({ "data-line-photo": l.id, "aria-label": `A photo of ${l.title}${shots ? `, ${shots} so far` : ""}` })}>${icon("camera")}${shots ? html`<span class="jp-cam-n">${String(shots)}</span>` : ""}</button>` : ""}</div>
      ${edit ? html`<button type="button" class="jp-li-foot" ${attrs({ "data-line": l.id, "aria-label": `${l.title}: quantity ${qty(l)}, change it` })}>${foot}</button>` : html`<div class="jp-li-foot">${foot}</div>`}
    </li>`;
  };
  // each discount's share of the total, as the desk shows it
  const sub = prices ? j.totals.subtotal_cents : 0;
  let left = prices ? j.totals.discount_cents || 0 : 0;
  const amounts = ds.map((d, i) => { const want = d.type === "percentage" ? Math.round((sub * d.value) / 10000) : d.value; const a = i === ds.length - 1 ? left : Math.min(left, want); left -= a; return a; });
  return html`<section class="rs-card jp-pricing wk-pricing"><h3 class="jp-h">Pricing</h3>
    ${lines.length ? html`<ul class="jp-lines" aria-label="Line items">${lines.map(card)}</ul>` : html`<p class="rs-empty">No work on this job yet.</p>`}
    ${edit ? html`<div class="jp-add">${pillBtn("Item", { icon: "plus", data: { "add-line": true }, aria: "Add an item" })}</div>` : ""}
    ${prices ? html`<div class="jp-sums">
      <div class="jp-sum"><span>Subtotal</span><span class="num">${money(j.totals.subtotal_cents)}</span></div>
      ${ds.map((d, i) => html`<div class="jp-sum green"><span class="jp-dl">${h.discLabel(d)}${edit ? rnd("edit", `Change ${h.discLabel(d)}`, { tone: "grey", sm: true, data: { disc: d.id } }) : ""}</span><span class="num">${money(-amounts[i])}</span></div>`)}
      ${edit ? html`<div class="jp-add">${pillBtn("Add discount", { icon: "plus", data: { "add-discount": true } })}</div>` : ""}
      <div class="jp-tot"><span>Total</span><span class="${"num" + (b.inv && b.inv.st === "paid" ? " paid" : "")}">${money(j.totals.total_cents)}</span></div>
      ${b.inv && b.inv.st === "paid" ? html`<p class="rs-paid">Paid in full</p>` : ""}</div>` : ""}
    ${b.may && !b.inv ? html`<div class="jp-cta">${pillBtn("Create Invoice", { wide: true, data: { "make-invoice": true }, disabled: !b.ready })}${b.why ? html`<p class="rs-sub wk-why">${b.why}</p>` : ""}</div>` : ""}
  </section>`;
}

function invoices(s, ctx, h) {
  if (!officeView() || s.invoices === null || s.invoices === undefined) return "";
  const b = h.billing(s, ctx.can);
  const add = b.ready ? { label: "Create an invoice from this job", data: { "make-invoice": true } }
    : ctx.can("invoices:write") && s.contact ? { label: "A new invoice for this customer", href: `#/invoices/new/${encodeURIComponent(s.contact.id)}` } : null;
  return html`<section class="rs-card jp-invs wk-invs"><div class="jp-ch"><h3 class="jp-h">Invoices</h3>${add ? rnd("plus", add.label, { sm: true, href: add.href, data: add.data }) : ""}</div>
    ${s.invoices.length ? s.invoices.map((i) => html`<a class="wk-irow" href="${"#/invoices/" + encodeURIComponent(i.id)}"><span class="wk-iw"><b>#${i.n}</b><span class="rs-sub">${h.invLine(i)}</span></span><span class="${"num wk-iamt" + (i.st === "paid" ? " paid" : "")}">${money(i.tot)}</span></a>`)
      : html`<p class="rs-empty">No invoices yet</p>`}</section>`;
}

function notes(s, v) {
  const j = s.job;
  const c = s.can || {};
  const office = officeView();
  const plan = office && s.plan && s.plan.notes ? s.plan : null;
  const up = v && c.write ? html`<button type="button" class="jp-up" data-notes-upload aria-label="Attach a photo or a file to this visit">${I.upload}</button>` : "";
  return html`<section class="rs-card jp-notes wk-jnotes"><h3 class="jp-h">Job notes</h3>
    ${c.write ? html`<div class="jp-nbox">${notesBox(j.crew_notes, { name: "crew", label: "Job notes (the crew sees these)", placeholder: "Add notes for this job...", rows: 4 })}${up}</div>` : j.crew_notes ? html`<p class="wk-pre">${j.crew_notes}</p>` : html`<p class="rs-empty">No notes.</p>`}
    ${office && (c.write || j.office_notes) ? html`<h4 class="wk-nlabel">Office notes</h4><p class="rs-sub wk-why">The crew never sees these.</p>${c.write ? notesBox(j.office_notes, { name: "office", label: "Office notes", placeholder: "Add a note for the office..." }) : html`<p class="wk-pre">${j.office_notes}</p>`}` : ""}
    ${plan ? html`<h4 class="wk-nlabel">Service plan notes</h4><a class="rs-inset sv-plan" href="${"#/plans/" + encodeURIComponent(plan.id)}"><span class="rs-sub"><b>Plan notes</b><br>${plan.notes}</span><span class="chev" aria-hidden="true"></span></a>` : ""}
  </section>`;
}

function soldBy(s) {
  if (!officeView()) return "";
  const q = s.quote;
  const p = s.plan;
  const id = (q && q.sold_by) || (p && p.sold_by) || null;
  if (!id) return "";
  const u = (s.users || []).find((x) => x.id === id);
  const name = u ? u.name : !/^us_/.test(id) ? id : "";
  if (!name) return "";
  const href = q ? "#/quotes/" + encodeURIComponent(q.id) : "#/plans/" + encodeURIComponent(p.id);
  return html`<a class="jp-sold" ${attrs({ href })}><span class="jp-av lg" ${attrs({ style: u && u.color ? `background:${u.color}` : null })} aria-hidden="true">${initialsOf(name)}</span><span class="jp-sold-w"><b>Sold by ${name}</b><span class="rs-sub">${q ? `Edit on quote ${q.number || ""}`.trim() : "Edit on the service plan"}</span></span></a>`;
}

export function phoneView(s, ctx, h) {
  const j = s.job;
  const c = s.can || {};
  const office = officeView();
  const v = currentVisit(s.visits || []);
  const visits = s.visits || [];
  return html`<div class="rs-page wk wk-job jp">
    ${headCard(s, ctx, v, h)}
    ${stepCard(s, ctx, v)}
    ${place(s)}
    ${office ? quick(s, ctx, v, h) : ""}
    ${office ? planCard(s) : ""}
    ${dueCard(s, ctx, h)}
    ${customer(s)}
    ${pricing(s, ctx, v, h)}
    ${invoices(s, ctx, h)}
    ${notes(s, v)}
    ${soldBy(s)}
    ${visits.length > 1 ? disclosure("Visits", { value: String(visits.length), sub: visits.map((x) => `${dateShort(x.date)} ${VISIT_STATUS[x.status] || x.status}`).slice(0, 3).join(" · "), data: { "jp-visits": true } }) : ""}
    ${j.rotor ? html`<p class="foot-note">From Rotor (job ${j.number_label}). Changes here stay in the CRM.</p>` : ""}
    ${office && c.cancel ? html`<button type="button" class="jp-del" data-del-job>Delete Job</button>` : ""}
    ${v && itemsOf(v).length ? html`<div class="ck-room" aria-hidden="true"></div>${checklistPill(v)}` : ""}
  </div>`;
}
