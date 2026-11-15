// One job (design §9.2 "Job"), laid out like Rotor's job page (Nov 2026,
// Rotor's screenshot 33 and the Rotor guide's "Inside a job"): "Job
// S-000001" in the header with the round "..."; the head with the status
// pills, the red "Invoice $X" and "Edit job"; three stat cards (Job total,
// Balance due, Time on site); Visits ("+ Add Visit"; each visit with On My
// Way, Start, Reschedule, Add Note); Pricing as a table (Item, Measurement,
// Qty, Unit, Amount; "+ Add item", the discounts and "+ Add discount", the
// total, Create Invoice). Then the right column: CUSTOMER (Call, Text,
// Email, the address and Directions), INVOICES, Sold by, the notes (the
// crew's and the office's, saved as you leave the box; the plan's). A
// phone shows the same in one column, in that order; a desk two columns
// (the page and a 320 px right column). The "..." holds the rest: Book a
// visit, Mark done, Edit the work, Add a discount, Create invoice, the
// quick actions, Open customer, Reopen, Cancel job.
//
// A phone (under 700 px) gets Rotor's phone job page with Flyra's top
// instead (office-job-phone.js; the same data, events and "..." rows), and
// the floating "N left" pill that opens the visit's checklist sheet.
//
// A technician reaches a job only through a visit of theirs; the server
// answers with what they may see (no office notes, prices only with
// visits:prices), and the page shows no office buttons then.

import { html, attrs, icon as iconOf, rnd, sheet, toast, confirmSheet, statusPill, pillBtn, notesBox, disclosure, seg, stepper } from "../../core/ui.js";
import { money, dateShort, dateYear, ago, clock, phone as formatPhone } from "../../core/format.js";
import { readForm, showError, clearErrors, busy, readMoney } from "../../core/forms.js";
import { directionsUrl } from "../../core/map.js";
import {
  ensureStyles, kindLabel, JOB_KINDS, scheduleSheet, reasonSheet, loadUsers, officeView, range, VISIT_STATUS,
  linesEditor, addLine, removeLine, readLines,
} from "./office-kit.js";
import { ensureStyles as svStyles } from "../service/kit.js";
import { phoneView, isPhone, PHONE_MEDIA } from "./office-job-phone.js";
import { openChecklist, checklistPill, checklistStyles } from "./checklist-sheet.js";
import { currentVisit, itemsOf, itemDone } from "./checklist-kit.js";
import { here, etaMinutes } from "./tech-kit.js";
import { uploadPhoto, capture } from "../../core/camera.js";

const JOB_WORD = { unscheduled: "To book", scheduled: "Booked", in_progress: "Under way", completed: "Done", cancelled: "Cancelled" };
const JOB_TONE = { unscheduled: "amber", scheduled: "blue", in_progress: "amber", completed: "green", cancelled: "red" };
const VISIT_TONE = { scheduled: "blue", en_route: "amber", in_progress: "amber", paused: "amber", completed: "green", no_access: "red", cancelled: "red" };
const INV_WORD = { draft: "Draft", open: "Open", paid: "Paid", void: "Void", uncollectible: "Written off" };
const OPEN_VISIT = ["scheduled", "en_route", "in_progress", "paused"];
const MONTH_DAY = new Intl.DateTimeFormat("en-US", { timeZone: "UTC", month: "short", day: "numeric" });
const monthLabel = (m) => (m ? new Intl.DateTimeFormat("en-US", { timeZone: "UTC", month: "long", year: "numeric" }).format(new Date(m + "-15T12:00:00Z")) : "");
const tel = (ph) => String((ph && ph.e164) || "").replace(/[^+\d]/g, "");
const initials = (name) => String(name || "").trim().split(/\s+/).filter(Boolean).slice(0, 2).map((w) => w[0].toUpperCase()).join("") || "?";

async function load(params, ctx) {
  ensureStyles();
  svStyles();
  checklistStyles();
  const r = await ctx.api(`/jobs/${encodeURIComponent(params.id)}`, { cache: false });
  const office = officeView();
  const d = r.data;
  const j = d.job;
  const [users, invoices, quote] = await Promise.all([
    office ? loadUsers(ctx).catch(() => []) : [],
    // the job's invoices: the contact's rows, this job's (its first job) or one the job names
    office && ctx.can("invoices:read_all") && d.contact ? ctx.api(`/invoices?contact=${encodeURIComponent(d.contact.id)}`, { cache: false })
      .then((x) => (x.data || []).filter((i) => i.j === j.id || (j.invoice_ids || []).includes(i.id))).catch(() => null) : null,
    office && j.quote_id && ctx.can("quotes:read") ? ctx.api(`/quotes/${encodeURIComponent(j.quote_id)}`).then((x) => (x.data && (x.data.quote || x.data)) || null).catch(() => null) : null,
  ]);
  // the plan banner (the Rotor guide's SX13): the plan's name, its visits, the next one, its status
  const pr = office && j.plan_id && ctx.can("plans:read") ? await ctx.api(`/plans/${encodeURIComponent(j.plan_id)}`).then((x) => x.data || null).catch(() => null) : null;
  const plan = pr ? pr.plan || pr : null;
  // the phone's plan card: how often, and the card on file (plans' own answer)
  return { ...d, etag: r.etag, users, invoices, quote, plan, planCard: pr ? pr.card || null : null, planFeatures: pr ? pr.features || null : null, planFreq: plan ? freqText(plan.frequency) : "" };
}

const FREQS = { 1: "Monthly", 2: "Every 2 months", 3: "Quarterly", 4: "Every 4 months", 6: "Biannual", 12: "Once a year" };
export function freqText(f) {
  if (!f || !f.count) return "";
  if (f.interval === "month") return FREQS[f.count] || `Every ${f.count} months`;
  if (f.interval === "year") return f.count === 1 ? "Once a year" : `Every ${f.count} years`;
  return `Every ${f.count} ${f.interval}${f.count === 1 ? "" : "s"}`;
}

// What the page knows about billing this job: the live invoice (not void),
// and why Create Invoice can't run when it can't.
export function billing(s, can = () => false) {
  const j = s.job;
  const live = (s.invoices || []).filter((i) => i.st !== "void");
  const inv = live[0] || null;
  let why = null;
  if (inv) why = `Invoice ${inv.n} covers this job.`;
  else if (j.status === "cancelled") why = "This job is cancelled.";
  else if (j.billable === false || ["touch_up", "warranty", "lights_warranty"].includes(j.kind)) why = "This kind of job isn't billed.";
  else if (!j.totals || !(j.totals.total_cents > 0)) why = "There's nothing to bill yet. Add the work first.";
  const may = !!(can("invoices:write") && s.invoices !== null && s.invoices !== undefined);
  return { inv, live, why, may, ready: may && !why };
}

// A visit's lines (Rotor's): "Visit 1", "Tue, Nov 17 · 8:00–10:00 AM · 2 h window", "Theo Tech".
function visitLine(s, v, i) {
  const who = (v.assignee_ids || []).map((id) => (s.people && s.people[id] && s.people[id].name) || "Someone").join(", ");
  const w = v.window && v.window.type === "window" && v.window.minutes > 0 ? `${v.window.minutes % 60 ? `${v.window.minutes} min` : `${v.window.minutes / 60} h`} window` : null;
  const when = [dateShort(v.date), v.date_only ? "Time not set" : range(v.start, v.end), w].filter(Boolean).join(" · ");
  return { title: `Visit ${i + 1}`, when, who: who || "Nobody yet" };
}
// The next step on a visit, for its own people: On my way, then Start (the Visit screen's steps).
function nextStep(v) {
  if (v.status === "scheduled") return pillBtn("On My Way", { tone: "solid", icon: "truck", data: { "v-omw": v.id } });
  if (v.status === "en_route" || v.status === "paused") return pillBtn(v.status === "paused" ? "Resume" : "Start", { tone: "solid", icon: "play", data: { "v-start": v.id } });
  return pillBtn("Open the visit", { tone: "solid", href: "#/visits/" + encodeURIComponent(v.id) });
}
// Under an open visit (Rotor's row of buttons, the Rotor guide's SX4): On My Way and Start for its own
// people; Reschedule and Add Note for the office.
function visitActs(s, v, ctx) {
  if (!OPEN_VISIT.includes(v.status)) return "";
  const mine = ctx && ctx.user && (v.assignee_ids || []).includes(ctx.user.id);
  const office = officeView() && s.can && s.can.write;
  const acts = [
    mine && v.status === "scheduled" && pillBtn("On My Way", { icon: "truck", data: { "v-omw": v.id } }),
    mine && ["scheduled", "en_route", "paused"].includes(v.status) && pillBtn(v.status === "paused" ? "Resume" : "Start", { icon: "play", data: { "v-start": v.id } }),
    office && pillBtn("Reschedule", { icon: "cal", data: { "v-move": v.id } }),
    (office || mine) && pillBtn("Add Note", { icon: "edit", data: { "v-note": v.id }, aria: "Add a note to this visit" }),
  ].filter(Boolean);
  return acts.length ? html`<div class="sv-vacts">${acts}</div>` : "";
}
function visitRow(s, v, i) {
  const l = visitLine(s, v, i);
  const done = v.status === "completed";
  return html`<a class="wk-vrow" href="${"#/visits/" + encodeURIComponent(v.id)}">
    <span class="${"rs-ci" + (done ? " ok" : "")}" aria-hidden="true">${iconOf("check")}</span>
    <span class="wk-vrow-t"><span class="wk-vrow-h"><b>${l.title}</b>${statusPill(v.status === "scheduled" ? "Not started" : VISIT_STATUS[v.status] || v.status, v.status === "scheduled" ? "grey" : VISIT_TONE[v.status] || "grey")}</span><span class="rs-sub num">${l.when}</span><span class="wk-vtech">${l.who}</span></span>
    <span class="chev" aria-hidden="true"></span></a>`;
}
function visitsCard(s, ctx) {
  const c = s.can || {};
  const j = s.job;
  const visits = s.visits || [];
  const plus = c.add_visit ? pillBtn("Add Visit", { icon: "plus", data: { book: true }, aria: "Book a visit" }) : "";
  const head = html`<div class="rs-ch"><h3>Visits</h3>${visits.length ? html`<span class="rs-ch-n wk-cnt">${String(visits.length)}</span>` : ""}<span class="rs-ch-end">${plus}</span></div>`;
  if (!visits.length) {
    return html`<div class="rs-card wk-visits">${head}<div class="wk-vrow none"><span class="rs-ci" aria-hidden="true">${iconOf("cal")}</span>
      <span class="wk-vrow-t"><b>No visit yet</b><span class="rs-sub">${j.target_month && j.status === "unscheduled" ? `Due by ${monthLabel(j.target_month)}` : c.add_visit ? "Book one with Add Visit." : "This job has no visit."}</span></span></div></div>`;
  }
  return html`<div class="rs-card wk-visits">${head}<ul class="wk-vlist">${visits.map((v, i) => html`<li>${visitRow(s, v, i)}${visitActs(s, v, ctx)}</li>`)}</ul></div>`;
}

// What the job's invoices still owe (the live ones), or the total when none is made yet and it's billed.
export function balanceDue(s) {
  const j = s.job;
  if (!j.totals || j.billable === false || j.status === "cancelled") return null;
  const live = (s.invoices || []).filter((i) => i.st !== "void");
  if (s.invoices === null || s.invoices === undefined) return null;
  return live.length ? live.filter((i) => ["draft", "open"].includes(i.st)).reduce((a, i) => a + (i.bal || 0), 0) : j.totals.total_cents;
}
// Time on site: the visits' timer minutes, "1 h 20 m".
export function onSite(visits = []) {
  const m = (visits || []).reduce((a, v) => a + (Number(v.minutes_worked) || 0), 0);
  if (!m) return null;
  return m >= 60 ? `${Math.floor(m / 60)} h${m % 60 ? ` ${m % 60} m` : ""}` : `${m} m`;
}
// Flyra's track (the owner's pick, Q6): Scheduled · On my way · Started · Done · Paid.
export const TRACK = [["scheduled", "Scheduled"], ["omw", "On my way"], ["started", "Started"], ["done", "Done"], ["paid", "Paid"]];
export function trackAt(s) {
  const j = s.job;
  if (j.status === "cancelled" || j.status === "unscheduled") return null;
  const b = billing(s, () => false);
  if (j.status === "completed") return b.inv && b.inv.st === "paid" ? "paid" : "done";
  const v = (s.visits || []).find((x) => OPEN_VISIT.includes(x.status));
  if (!v) return "done";
  return v.status === "en_route" ? "omw" : ["in_progress", "paused"].includes(v.status) ? "started" : "scheduled";
}
// The visit's own people may step it on (the same steps as the Visit screen).
const mineOpen = (s, ctx) => (s.visits || []).find((v) => OPEN_VISIT.includes(v.status) && ctx.user && (v.assignee_ids || []).includes(ctx.user.id));

function planBanner(s) {
  const p = s.plan;
  const j = s.job;
  if (!p || !j.plan_id) return "";
  const n = (j.plan_ordinal && j.plan_ordinal.n) || null;
  const per = p.visits_per_year || ((p.ordinals || []).filter((o) => (o.term || 1) === ((j.plan_ordinal && j.plan_ordinal.term) || 1)).length) || null;
  const next = (p.ordinals || []).filter((o) => ["unscheduled", "scheduled"].includes(o.status) && !(o.job_id === j.id)).map((o) => o.target_month).filter(Boolean).sort()[0];
  const ST = { active: "Active", pending: "Waiting", paused: "Paused", cancelling: "Ending", cancelled: "Cancelled", expired: "Ended" };
  const words = [n ? `Visit ${n}${per ? ` of ${per}` : ""}` : "A plan visit", next ? `next ${MONTH_DAY.format(new Date(next + "-15T12:00:00Z")).replace(/ \d+$/, "")} ${next.slice(0, 4)}` : null, ST[p.status] || p.status].filter(Boolean).join(" · ");
  return html`<a class="rs-inset sv-plan" href="${"#/plans/" + encodeURIComponent(p.id)}"><span class="rs-sub"><b>${p.name || "Service plan"}</b> · ${words}</span><span class="chev" aria-hidden="true"></span></a>`;
}

// The head (Rotor's): the status pills, then "Invoice $X" (the red one: the
// job's invoice, or one made from the job) and "Edit job"; the title, the
// customer, the plan visit, the kind and when it was made; the plan banner,
// the track, and the one next step (Mark done, or the visit's own step).
function topCard(s, ctx) {
  const j = s.job;
  const c = s.can || {};
  const b = billing(s, ctx.can);
  const visits = s.visits || [];
  const first = visits.find((v) => OPEN_VISIT.includes(v.status));
  const when = first ? `Next ${MONTH_DAY.format(new Date(first.date + "T12:00:00Z"))}${first.date_only ? "" : `, ${clock(first.start)}`}` : j.target_month && j.status === "unscheduled" ? `Due by ${monthLabel(j.target_month)}` : "";
  const paid = b.inv && b.inv.st === "paid";
  const part = b.inv && !paid && b.inv.bal > 0 && b.inv.bal < b.inv.tot;
  const billPill = b.inv ? statusPill(paid ? "Paid" : part ? "Partially paid" : "Invoiced", paid ? "green" : part ? "amber" : "blue")
    : j.plan_id ? statusPill("Plan visit", "fill-green")
      : s.invoices && j.billable !== false && j.status !== "cancelled" && j.totals && j.totals.total_cents > 0 ? statusPill("Not invoiced", "amber") : "";
  const allDone = visits.length && visits.every((v) => !OPEN_VISIT.includes(v.status)) && visits.some((v) => v.status === "completed");
  const invBtn = b.inv && officeView() ? pillBtn(`Invoice ${money(paid ? b.inv.tot : b.inv.bal || b.inv.tot)}`, { tone: "red", icon: "doc", href: "#/invoices/" + encodeURIComponent(b.inv.id), aria: `Invoice ${b.inv.n}` })
    : b.ready ? pillBtn(`Invoice ${money(j.totals.total_cents)}`, { tone: "red", icon: "doc", data: { "make-invoice": true }, aria: "Create an invoice from this job" }) : "";
  const sub = [s.contact && s.contact.display_name, j.plan_id && !s.plan ? (j.plan_ordinal && j.plan_ordinal.n ? `Visit ${j.plan_ordinal.n} of a service plan` : "A service plan visit") : "", j.kind !== "standard" ? kindLabel(j.kind) : "", j.created_at ? `Created ${dateYear(j.created_at)}` : "", when].filter(Boolean);
  return html`<section class="wk-jtop">
    <div class="wk-jtop-r"><span class="rs-pills">${statusPill(JOB_WORD[j.status] || j.status, JOB_TONE[j.status] || "grey")}${billPill}${j.billable === false ? statusPill("No charge", "grey") : ""}</span>
      ${invBtn || c.write ? html`<span class="wk-jbtns">${invBtn}${c.write ? pillBtn("Edit job", { icon: "edit", data: { "edit-job": true } }) : ""}</span>` : ""}</div>
    <p class="wk-jtitle">${j.title}</p>
    ${sub.length ? html`<p class="rs-sub wk-jsub">${sub.join(" · ")}</p>` : ""}
    ${planBanner(s)}
    ${trackAt(s) ? html`<div class="sv-track">${stepper(TRACK, trackAt(s), { label: "Job status" })}</div>` : ""}
    ${j.status === "cancelled" && j.cancel_reason ? html`<p class="warn-box">Cancelled: ${j.cancel_reason}</p>` : ""}
    ${j.completed_at && j.status === "completed" ? html`<p class="rs-sub">Done ${dateShort(j.completed_at)}</p>` : ""}
    ${c.complete && allDone ? html`<div class="wk-jtop-act">${pillBtn("Mark done", { icon: "check", tone: "solid", data: { complete: true } })}</div>`
      : mineOpen(s, ctx) ? html`<div class="wk-jtop-act">${nextStep(mineOpen(s, ctx))}</div>` : ""}
  </section>`;
}

// Rotor's three stat cards: Job total, Balance due, Time on site.
function statCards(s) {
  const j = s.job;
  if (!j.totals && !onSite(s.visits)) return "";
  const b = billing(s, () => false);
  const paid = b.inv && b.inv.st === "paid";
  const due = officeView() ? balanceDue(s) : null;
  const one = (label, value, tone = "") => html`<div class="rs-card wk-jstat"><span class="rs-stat-l">${label}</span><span class="${"rs-stat-v" + (tone ? " " + tone : "")}">${value === null || value === undefined || value === "" ? "-" : value}</span></div>`;
  return html`<div class="wk-jstats" role="group" aria-label="This job">
    ${one("Job total", j.totals ? money(j.totals.total_cents) : null, paid ? "green" : "")}
    ${one("Balance due", due === null ? null : money(due), due > 0 && j.status === "completed" ? "red" : due === 0 && paid ? "green" : "")}
    ${one("Time on site", onSite(s.visits) || "0 m", onSite(s.visits) ? "red" : "")}
  </div>`;
}

const pctText = (bp) => `${String(bp / 100).replace(/\.0+$/, "")}%`;
const discLabel = (d) => `${d.name || "Discount"}${d.type === "percentage" ? ` (${pctText(d.value)})` : ""}`;

// Pricing (Rotor's table): Item · Measurement · Qty · Unit · Amount (a line
// opens the editor), then the subtotal, each discount (tap: change it),
// "+ Add discount", the total, and Create Invoice (or why not).
function pricingCard(s, ctx) {
  const j = s.job;
  const c = s.can || {};
  const open = !["completed", "cancelled"].includes(j.status);
  const edit = c.write && open;
  const lines = j.lines || [];
  const prices = !!j.totals;
  const ds = j.discounts || [];
  const b = billing(s, ctx.can);
  // each discount's share of the total, as the invoice will list it (percentages first, never below $0)
  const sub = prices ? j.totals.subtotal_cents : 0;
  let left = prices ? j.totals.discount_cents || 0 : 0;
  const amounts = ds.map((d, i) => { const want = d.type === "percentage" ? Math.round((sub * d.value) / 10000) : d.value; const a = i === ds.length - 1 ? left : Math.min(left, want); left -= a; return a; });
  const qtyOf = (l) => { const q = (l.qty_milli ?? 1000) / 1000; return Number.isInteger(q) ? String(q) : q.toFixed(2); };
  const meas = (l) => (l.measure && l.measure.value ? `${l.measure.value} ${l.measure.unit || ""}`.trim() : "");
  const cells = (l) => html`<span class="wk-pc it"><b>${l.title}</b>${l.description ? html`<span class="wk-pdesc">${l.description}</span>` : ""}${meas(l) ? html`<span class="wk-pmeas-s">${meas(l)}</span>` : ""}</span>
    <span class="wk-pc ms">${meas(l) || html`<span class="rs-dash" aria-hidden="true">-</span>`}</span>
    <span class="wk-pc num">${qtyOf(l)}</span><span class="wk-pc num">${prices && l.unit_cents != null ? money(l.unit_cents) : ""}</span>
    <span class="wk-pc num am">${prices && l.total_cents != null ? money(l.total_cents) : ""}</span>${edit ? html`<span class="wk-pc ed" aria-hidden="true">${iconOf("edit")}</span>` : ""}`;
  const row = (l) => (edit ? html`<li><button type="button" class="wk-prow" ${attrs({ "data-line": l.id, "aria-label": `${l.title}: ${qtyOf(l)} × ${money(l.unit_cents)}, change it` })}>${cells(l)}</button></li>` : html`<li><div class="wk-prow">${cells(l)}</div></li>`);
  const table = lines.length ? html`<div class="${"wk-ptable" + (edit ? " ed" : "")}">
      <div class="wk-prow wk-phead" aria-hidden="true"><span class="wk-pc it">Item</span><span class="wk-pc ms">Measurement</span><span class="wk-pc num">Qty</span><span class="wk-pc num">Unit</span><span class="wk-pc num am">Amount</span>${edit ? html`<span class="wk-pc ed"></span>` : ""}</div>
      <ul class="wk-plist" aria-label="Line items">${lines.map(row)}</ul></div>` : html`<p class="rs-empty">No work on this job yet.</p>`;
  const disc = (d, i) => { const inner = html`<span>${discLabel(d)}</span><span class="num">${money(-amounts[i])}</span>`; return edit ? html`<button type="button" class="rs-li-sum tap" ${attrs({ "data-disc": d.id })}>${inner}</button>` : html`<div class="rs-li-sum">${inner}</div>`; };
  const sums = prices ? html`<div class="wk-psums">
      ${ds.length ? html`<div class="rs-li-sum"><span>Subtotal</span><span class="num">${money(j.totals.subtotal_cents)}</span></div>` : ""}
      ${ds.map(disc)}
      ${edit ? html`<div class="rs-li-add">${pillBtn("Add discount", { icon: "plus", data: { "add-discount": true } })}</div>` : ""}
      <div class="rs-li-tot"><span>Total</span><span class="${"num" + (b.inv && b.inv.st === "paid" ? " paid" : "")}">${money(j.totals.total_cents)}</span></div>
      ${b.inv && b.inv.st === "paid" ? html`<p class="rs-paid">Paid in full</p>` : ""}</div>` : "";
  const cta = b.may && !b.inv ? html`<div class="rs-li-cta">${pillBtn("Create Invoice", { wide: true, data: { "make-invoice": true }, disabled: !b.ready })}${b.why ? html`<p class="rs-sub wk-why">${b.why}</p>` : ""}</div>` : "";
  return html`<div class="rs-card wk-pricing"><div class="rs-ch"><h3>Pricing</h3><span class="rs-ch-end">${edit ? pillBtn("Add item", { icon: "plus", data: { "add-line": true } }) : ""}</span></div>${table}${sums}${cta}</div>`;
}

// The right column (Rotor's): CUSTOMER (the name, Call · Text · Email, the address and Directions),
// INVOICES (each # and what's paid), Sold by, and the notes.
const railHead = (label, end = "") => html`<div class="wk-rhead"><h3 class="rs-label">${label}</h3>${end}</div>`;
function customerCard(s) {
  const c = s.contact;
  const p = s.property;
  const a = p && p.address;
  if (!c && !(a && (a.street1 || a.city))) return "";
  const office = officeView();
  const ph = c ? (c.phones || []).find((x) => x.primary) || (c.phones || [])[0] : null;
  const n = tel(ph);
  const em = c ? ((c.emails || []).find((e) => e.primary) || (c.emails || [])[0] || {}).address : null;
  const name = (c && c.display_name) || "Customer";
  const gate = p && p.access && p.access.gate_code;
  return html`<div class="rs-card wk-cust">
    ${railHead("Customer", c && office ? html`<a class="wk-ropen" ${attrs({ href: "#/contacts/" + encodeURIComponent(c.id) })}>Open</a>` : "")}
    ${c ? html`<div class="wk-cwho"><span class="rs-av" aria-hidden="true">${initials(name)}</span><span class="wk-cperson"><b>${name}</b>${ph && ph.e164 ? html`<span class="rs-sub num">${formatPhone(ph.e164)}</span>` : ""}</span></div>
    ${n || (em && office) ? html`<div class="wk-cbtns">${n ? pillBtn("Call", { icon: "call", href: "tel:" + n, aria: "Call " + name }) : ""}${n ? pillBtn("Text", { icon: "chat", href: "sms:" + n, aria: "Text " + name }) : ""}${em && office ? rnd("mail", "Email " + name, { tone: "grey", sm: true, href: "mailto:" + em }) : ""}</div>` : ""}` : ""}
    ${a && (a.street1 || a.city) ? html`<div class="wk-caddr"><span class="wk-cline"><b>${a.street1 || a.city}</b><span class="rs-sub">${[[a.city, [a.state, a.zip].filter(Boolean).join(" ")].filter(Boolean).join(", "), gate ? `gate ${gate}` : ""].filter(Boolean).join(" · ")}</span></span>
      <span class="wk-cact">${pillBtn("Directions", { icon: "nav", ext: directionsUrl(a) })}${office && p.id ? rnd("edit", "Edit the place and its access", { tone: "grey", sm: true, href: "#/properties/" + encodeURIComponent(p.id) }) : ""}</span></div>` : ""}
  </div>`;
}
function invoicesCard(s, ctx) {
  if (s.invoices === null || s.invoices === undefined) return "";
  const b = billing(s, ctx.can);
  const add = b.ready ? { label: "Create an invoice from this job", data: { "make-invoice": true } }
    : ctx.can("invoices:write") && s.contact ? { label: "A new invoice for this customer", href: `#/invoices/new/${encodeURIComponent(s.contact.id)}` } : null;
  const line = (i) => (i.st === "paid" ? `Paid${i.pd ? ` ${dateYear(String(i.pd).slice(0, 10))}` : ""}` : i.st !== "void" && i.bal > 0 && i.bal !== i.tot ? `${INV_WORD[i.st] || i.st} · ${money(i.bal)} left` : INV_WORD[i.st] || i.st);
  return html`<div class="rs-card wk-invs">${railHead("Invoices", add ? rnd("plus", add.label, { tone: "grey", sm: true, href: add.href, data: add.data }) : "")}
    ${s.invoices.length ? s.invoices.map((i) => html`<a class="wk-irow" href="${"#/invoices/" + encodeURIComponent(i.id)}" ${attrs({ "aria-label": `Invoice ${i.n} · ${INV_WORD[i.st] || i.st} · ${money(i.tot)}` })}><span class="wk-iw"><b>#${i.n}</b><span class="rs-sub">${line(i)}</span></span><span class="${"num wk-iamt" + (i.st === "paid" ? " paid" : "")}">${money(i.st === "paid" ? i.tot : i.tot)}</span></a>`)
      : html`<p class="rs-empty">No invoice yet.${b.ready ? " Create one from Pricing or with +." : ""}</p>`}</div>`;
}
function notesCard(s) {
  const j = s.job;
  const c = s.can || {};
  const office = officeView();
  const plan = office && s.plan && s.plan.notes ? s.plan : null;
  return html`<div class="rs-card wk-jnotes">${railHead("Notes")}
    <h4 class="wk-nlabel">Job notes</h4>
    ${c.write ? notesBox(j.crew_notes, { name: "crew", label: "Notes for the crew", placeholder: "Add notes for this job..." }) : j.crew_notes ? html`<p class="wk-pre">${j.crew_notes}</p>` : html`<p class="rs-empty">No notes.</p>`}
    ${office && (c.write || j.office_notes) ? html`<h4 class="wk-nlabel">Office notes</h4><p class="rs-sub wk-why">The crew never sees these.</p>${c.write ? notesBox(j.office_notes, { name: "office", label: "Office notes", placeholder: "Add a note for the office..." }) : html`<p class="wk-pre">${j.office_notes}</p>`}` : ""}
    ${plan ? html`<h4 class="wk-nlabel">Service plan notes</h4><a class="rs-inset sv-plan" href="${"#/plans/" + encodeURIComponent(plan.id)}"><span class="rs-sub"><b>Plan notes</b><br>${plan.notes}</span><span class="chev" aria-hidden="true"></span></a>` : ""}
  </div>`;
}

function soldBy(s) {
  const q = s.quote;
  if (!q) return "";
  const u = (s.users || []).find((x) => x.id === q.sold_by);
  return disclosure("Sold by", { value: u ? u.name : q.sold_by && !/^us_/.test(q.sold_by) ? q.sold_by : "", sub: `Quote ${q.number || ""}`.trim(), href: "#/quotes/" + encodeURIComponent(q.id) });
}


// ------------------------------------------------------------ sheets

function editSheet(ctx, { add = false, line = null } = {}) {
  const s = ctx.state;
  const j = s.job;
  const closed = ["completed", "cancelled"].includes(j.status);
  let linesDirty = false;
  const sh = sheet({
    title: "Edit the job",
    body: html`<form class="form" id="wk-job-edit" novalidate>
      <div class="err" data-form-err hidden></div>
      <label class="field" data-field="title"><span>Title</span><input name="title" maxlength="160" ${attrs({ value: j.title || "" })}><small>Leave it as it is and it follows the work.</small><small class="why" hidden></small></label>
      ${closed ? "" : html`<label class="field" data-field="kind"><span>Kind</span><select name="kind">${JOB_KINDS.map((k) => html`<option ${attrs({ value: k.value, selected: k.value === j.kind })}>${k.label}</option>`)}</select><small class="why" hidden></small></label>`}
      ${j.status === "unscheduled" ? html`<label class="field" data-field="target_month"><span>Due by (month)</span><input type="month" name="target_month" ${attrs({ value: j.target_month || "" })}><small class="why" hidden></small></label>` : ""}
      ${closed ? "" : linesEditor(j.lines || [])}
      <label class="field" data-field="crew_notes"><span>Notes for the crew</span><textarea name="crew_notes" rows="3" maxlength="2000">${j.crew_notes || ""}</textarea><small class="why" hidden></small></label>
      <label class="field" data-field="office_notes"><span>Office notes (the crew never sees these)</span><textarea name="office_notes" rows="3" maxlength="4000">${j.office_notes || ""}</textarea><small class="why" hidden></small></label>
      <button type="submit" class="btn primary block">Save</button>
    </form>`,
    events: {
      // the lines go back only when someone changed them (a crew-notes edit never prices the job again)
      "click [data-addline]": () => { linesDirty = true; addLine(sh.el); },
      "click [data-unline]": (e, b) => { linesDirty = true; removeLine(b); },
      "input [data-lines]": () => { linesDirty = true; },
      "change [data-lines]": () => { linesDirty = true; },
      "submit #wk-job-edit": async (e, form) => {
        e.preventDefault();
        clearErrors(form);
        const v = readForm(form);
        const body = { title: v.title === j.title ? undefined : v.title, crew_notes: v.crew_notes, office_notes: v.office_notes };
        if (!closed) {
          if (v.kind !== j.kind) body.kind = v.kind;
          if (linesDirty) {
            const got = readLines(form);
            if (got.error) { showError(form, got.error); return; }
            if (!got.lines.length) { showError(form, { field: "lines", message: "Add the work (one line at least)." }); return; }
            body.lines = got.lines;
          }
        }
        if (j.status === "unscheduled") body.target_month = v.target_month || "";
        const btn = form.querySelector("[type=submit]");
        busy(btn, true);
        try {
          await ctx.api(`/jobs/${encodeURIComponent(j.id)}`, { method: "PATCH", body, ifMatch: s.etag });
          sh.close(); toast("Saved"); ctx.refresh();
        } catch (err) {
          busy(btn, false);
          if (err.status === 412) { showError(form, { message: "Someone else just changed this job. Close this and look again." }); return; }
          showError(form, err);
        }
      },
    },
  });
  // "+ Item": a new line ready to type; a line's tap: that line's name
  if (!closed && add) { linesDirty = true; addLine(sh.el); }
  const rows = sh.el.querySelectorAll("[data-lines] input[name=l_title]");
  const i = add ? rows.length - 1 : line !== null ? (j.lines || []).findIndex((l) => l.id === line) : -1;
  if (i >= 0 && rows[i]) setTimeout(() => { try { rows[i].focus(); } catch (e) { /* gone */ } }, 300);
  return sh;
}

// "+ Add discount" (Rotor's): an amount or a percent, a name if they want one;
// tap a discount to change or remove it. The job's total follows, and the
// invoice made from the job lists it.
function discountSheet(ctx, id = null) {
  const s = ctx.state;
  const j = s.job;
  const list = (j.discounts || []).map((d) => ({ id: d.id, name: d.name, type: d.type, value: d.value }));
  const cur = id ? list.find((d) => d.id === id) : null;
  let kind = cur ? cur.type : "fixed";
  const b = billing(s, ctx.can);
  const valueOf = (d) => (d.type === "percentage" ? String(d.value / 100) : (d.value / 100).toFixed(2));
  const sh = sheet({
    title: cur ? "Change the discount" : "Add a discount",
    body: html`<form class="form wk-discf" data-discf novalidate>
      <div class="err" data-form-err hidden></div>
      ${seg([["fixed", "Amount"], ["percentage", "Percent"]], kind, { name: "dkind", label: "Amount or percent" })}
      <label class="field" data-field="value"><span data-vlabel>${kind === "percentage" ? "Percent off" : "Amount off ($)"}</span><input name="value" inputmode="decimal" autocomplete="off" ${attrs({ value: cur ? valueOf(cur) : "", placeholder: kind === "percentage" ? "10" : "25.00" })}><small class="why" hidden></small></label>
      <label class="field" data-field="name"><span>Name (optional; the customer sees it)</span><input name="name" maxlength="120" autocomplete="off" ${attrs({ value: cur ? cur.name || "" : "", placeholder: "Discount" })}><small class="why" hidden></small></label>
      ${b.inv ? html`<p class="small muted">Invoice ${b.inv.n} already covers this job and stays as it is.</p>` : html`<p class="small muted">The total and the invoice made from this job follow.</p>`}
      <button type="submit" class="btn primary block">${cur ? "Save" : "Add the discount"}</button>
      ${cur ? html`<button type="button" class="btn danger block" data-disc-del>Remove the discount</button>` : ""}
    </form>`,
    events: {
      "click [data-seg=dkind]": (e, el) => {
        kind = el.dataset.key;
        for (const x of sh.el.querySelectorAll("[data-seg=dkind]")) { const on = x === el; x.setAttribute("aria-selected", String(on)); x.tabIndex = on ? 0 : -1; }
        sh.el.querySelector("[data-vlabel]").textContent = kind === "percentage" ? "Percent off" : "Amount off ($)";
        sh.el.querySelector("[name=value]").placeholder = kind === "percentage" ? "10" : "25.00";
      },
      "click [data-disc-del]": async (e, el) => { busy(el, true); if (await save(list.filter((d) => d.id !== id), el)) toast("Discount removed"); },
      "submit [data-discf]": async (e, form) => {
        e.preventDefault();
        clearErrors(form);
        const v = readForm(form);
        let value;
        if (kind === "percentage") {
          const p = Number(String(v.value || "").replace(/[%\s]/g, ""));
          value = Number.isFinite(p) ? Math.round(p * 100) : NaN;
          if (!(value > 0 && value <= 10000)) { showError(form, { field: "value", message: "Use a percent from 0.01 to 100." }); return; }
        } else {
          value = readMoney(v.value);
          if (!(value > 0)) { showError(form, { field: "value", message: "How much off?" }); return; }
        }
        const one = { ...(cur ? { id: cur.id } : {}), name: String(v.name || "").trim(), type: kind, value };
        const next = cur ? list.map((d) => (d.id === cur.id ? one : d)) : [...list, one];
        if (await save(next, form.querySelector("[type=submit]"))) toast(cur ? "Saved" : "Discount added");
      },
    },
  });
  async function save(discounts, btn) {
    const form = sh.el.querySelector("form");
    busy(btn, true);
    try {
      await ctx.api(`/jobs/${encodeURIComponent(j.id)}`, { method: "PATCH", body: { discounts }, ifMatch: s.etag });
      sh.close();
      ctx.refresh();
      return true;
    } catch (err) {
      busy(btn, false);
      showError(form, err.status === 412 ? { message: "Someone else just changed this job. Close this and look again." } : err);
      return false;
    }
  }
  setTimeout(() => { const x = sh.el.querySelector("[name=value]"); if (x && !cur) { try { x.focus(); } catch (e) { /* fine */ } } }, 300);
  return sh;
}

// ------------------------------------------------------------ doing things

async function post(ctx, path, body, ok) {
  try { await ctx.api(`/jobs/${encodeURIComponent(ctx.state.job.id)}/${path}`, { method: "POST", body }); toast(ok); }
  catch (err) { toast(err.message || "That didn't save.", { bad: true }); }
  ctx.refresh();
}
const book = (ctx) => {
  const s = ctx.state;
  scheduleSheet(ctx, { job_id: s.job.id, town: s.property && s.property.address && s.property.address.city, onDone: (d) => (d && d.visit ? ctx.go(`/visits/${d.visit.id}`) : ctx.refresh()) });
};
async function markDone(ctx) {
  if (!(await confirmSheet("Mark the job and its open visits done?", { title: "Mark done", yes: "Mark done" }))) return;
  post(ctx, "complete", {}, "Marked done");
}
async function reopen(ctx) {
  if (!(await confirmSheet("Reopen this job? Book a visit on it after.", { title: "Reopen", yes: "Reopen" }))) return;
  post(ctx, "reopen", {}, "Reopened");
}
async function cancelJob(ctx) {
  const r = await reasonSheet({ title: "Cancel this job", label: "Why? (its open visits are cancelled too)", yes: "Cancel the job" });
  if (r) post(ctx, "cancel", { reason: r.reason }, "Cancelled");
}
// Create Invoice: the job's own invoice (POST /jobs/:id/invoice: the same one
// marking the job done would make, so it's never billed twice), as a draft
// the office looks over and sends.
async function makeInvoice(ctx, el) {
  const s = ctx.state;
  const b = billing(s, ctx.can);
  if (!b.ready) { if (b.why) toast(b.why, { bad: true }); return; }
  if (el) busy(el, true);
  try {
    const r = await ctx.api(`/jobs/${encodeURIComponent(s.job.id)}/invoice`, { method: "POST", body: { issue: false } });
    const inv = r.data.invoice;
    toast(r.data.existed ? `Invoice ${inv.number} was already made.` : `Invoice ${inv.number} made. Look it over and send it.`);
    ctx.go(`/invoices/${encodeURIComponent(inv.id)}`);
  } catch (err) {
    if (el) busy(el, false);
    toast(err.message || "That invoice wasn't made.", { bad: true });
    ctx.refresh();
  }
}
// ------------------------------------------------------------ quick actions (the Rotor guide's SX12: dry run until texting is on)

const cid = () => (globalThis.crypto && crypto.randomUUID ? crypto.randomUUID() : `jb-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`);
async function visitStep(ctx, id, what) {
  try {
    if (what === "omw") {
      // about how far: from where the phone is to the house (15 minutes when the phone won't say)
      const p = ctx.state.property;
      const to = p && p.geo && Number.isFinite(p.geo.lat) ? [p.geo.lat, p.geo.lng] : null;
      let eta = 15;
      try { eta = etaMinutes(await here(), to) || 15; } catch (e) { /* the default */ }
      const r = await ctx.api(`/visits/${encodeURIComponent(id)}/on-my-way`, { method: "POST", body: { client_id: cid(), eta_min: Math.min(240, Math.max(1, eta)) } });
      const t = r.data && r.data.text;
      toast(t && t.status === "sent" ? "On my way: texted" : t && (t.status === "dry_run" || t.mode === "dry_run") ? "On my way. Texts aren't switched on yet, so nothing went out." : t && t.status ? `On my way (the text: ${t.status.replace(/_/g, " ")})` : "On my way");
    } else {
      await ctx.api(`/visits/${encodeURIComponent(id)}/timer`, { method: "POST", body: { action: "start", client_id: cid() } });
      toast("Started. The timer is running.");
    }
  } catch (err) { toast(err.message || "That didn't go through.", { bad: true }); }
  ctx.refresh();
}
async function moveVisit(ctx, id) {
  try {
    const r = await ctx.api(`/visits/${encodeURIComponent(id)}`, { cache: false });
    const s = ctx.state;
    scheduleSheet(ctx, { visit: r.data.visit, etag: r.etag, town: s.property && s.property.address && s.property.address.city, onDone: () => ctx.refresh() });
  } catch (err) { toast(err.message || "That visit didn't open.", { bad: true }); }
}
function noteSheet(ctx, id) {
  const sh = sheet({
    title: "A note on this visit",
    body: html`<form class="form" data-vnote-f novalidate><div class="err" data-form-err hidden></div>
      <label class="field" data-field="text"><span>Note</span><textarea name="text" rows="3" maxlength="1000" placeholder="Back gate sticks..."></textarea><small class="why" hidden></small></label>
      <button type="submit" class="btn primary block">Add the note</button></form>`,
    events: {
      "submit [data-vnote-f]": async (e, form) => {
        e.preventDefault();
        clearErrors(form);
        const v = readForm(form);
        const btn = form.querySelector("[type=submit]");
        busy(btn, true);
        // the visit's own people write on the visit; the office adds it to the job's office notes, dated by the visit
        const st = ctx.state;
        const vis = (st.visits || []).find((x) => x.id === id);
        const mine = vis && ctx.user && (vis.assignee_ids || []).includes(ctx.user.id);
        try {
          if (mine) await ctx.api(`/visits/${encodeURIComponent(id)}/notes`, { method: "POST", body: { text: v.text, client_id: cid() } });
          else {
            const line = `${vis ? dateShort(vis.date) + ": " : ""}${String(v.text || "").trim()}`;
            if (!String(v.text || "").trim()) { busy(btn, false); showError(form, { field: "text", message: "Write the note." }); return; }
            const r = await ctx.api(`/jobs/${encodeURIComponent(st.job.id)}`, { method: "PATCH", body: { office_notes: [st.job.office_notes, line].filter(Boolean).join("\n").slice(0, 4000) }, ifMatch: st.etag });
            st.etag = r.etag || st.etag;
          }
          sh.close(); toast("Note added"); ctx.refresh();
        }
        catch (err) { busy(btn, false); showError(form, err); }
      },
    },
  });
}
async function quick(ctx, what) {
  const s = ctx.state;
  const j = s.job;
  const b = billing(s, ctx.can);
  try {
    if (what === "pay") {
      const inv = b.inv;
      if (!inv) { toast(b.ready ? "Make the invoice first (Create invoice)." : b.why || "There's no invoice to pay.", { bad: true }); return; }
      if (inv.st === "paid") { toast("It's paid already."); return; }
      if (inv.st === "draft") { toast("Look the invoice over and send it from there.", { bad: true }); ctx.go(`/invoices/${encodeURIComponent(inv.id)}`); return; }
      await ctx.api(`/invoices/${encodeURIComponent(inv.id)}/send`, { method: "POST", body: { channels: ["sms"] } });
      toast("The pay link is in the Outbox (texting isn't on yet).");
    } else if (what === "callback") {
      if (!(await confirmSheet("Make a no-charge touch-up job to book for this customer?", { title: "Book a callback", yes: "Make it" }))) return;
      const r = await ctx.api(`/jobs/${encodeURIComponent(j.id)}/callback`, { method: "POST", body: {} });
      toast("A callback job to book");
      ctx.go(`/jobs/${encodeURIComponent(r.data.job_id)}`);
      return;
    } else {
      const r = await ctx.api(`/jobs/${encodeURIComponent(j.id)}/${what === "review" ? "review-ask" : "tip-ask"}`, { method: "POST", body: {} });
      const st = r.data && r.data.status;
      toast(st === "sent" ? "Texted" : `${what === "review" ? "Review ask" : "Tip ask"}: ${String(st || "queued").replace(/_/g, " ")}`);
    }
  } catch (err) { toast(err.message || "That didn't go through.", { bad: true }); }
}

// ------------------------------------------------------------ the phone's extras (office-job-phone.js)

// The helpers the phone page draws with (the same rules as the desk).
const INV_LINE = (i) => (i.st === "paid" ? `Paid${i.pd ? ` ${dateYear(String(i.pd).slice(0, 10))}` : ""}` : i.st !== "void" && i.bal > 0 && i.bal !== i.tot ? `${INV_WORD[i.st] || i.st} · ${money(i.bal)} left` : INV_WORD[i.st] || i.st);
const H = { billing, balanceDue, onSite, monthLabel, discLabel: (d) => discLabel(d), invLine: INV_LINE };

// The job's visit the checklist (and the big step) is about.
const jobVisit = (s) => currentVisit(s.visits || []);
function openCk(ctx) {
  const v = jobVisit(ctx.state);
  if (!v || !itemsOf(v).length) { toast("This visit has no checklist.", { bad: true }); return; }
  openChecklist(ctx, { visit: v, property: ctx.state.property, onClose: (changed) => { if (changed) ctx.refresh(); } });
}
// Complete Job (the visit's own people): the required items first, then the visit is done (its timers stop).
async function completeVisit(ctx, id) {
  const v = (ctx.state.visits || []).find((x) => x.id === id);
  const left = v ? itemsOf(v).filter((i) => i.required && !itemDone(i)) : [];
  if (left.length) { toast(`Finish the checklist first: ${left.length} required ${left.length === 1 ? "item" : "items"} left.`, { bad: true }); openCk(ctx); return; }
  try {
    await ctx.api(`/visits/${encodeURIComponent(id)}/complete`, { method: "POST", body: { client_id: cid() } });
    toast("Done. Nice work.");
  } catch (err) { toast(err.message || "That didn't go through.", { bad: true }); }
  ctx.refresh();
}
// Checkout (Flyra's): the visit's Collect payment (Money's sheet: cash or a check, the QR, the
// invoice made when needed); with no visit, the job's invoice (made first when there's none).
async function checkout(ctx, el, mode = null) {
  const s = ctx.state;
  const b = billing(s, ctx.can);
  const v = jobVisit(s);
  if (v && ctx.can("payments:record")) {
    try {
      const mod = (await import("../money/visit-collect.js")).default;
      await mod.run({ visit: v }, { ...ctx, refresh: () => ctx.refresh() });
      if (mode === "qr") setTimeout(() => { const q = document.querySelector(".sheet.on [data-qr]"); if (q) q.click(); }, 350);
    } catch (err) { toast(err.message || "Checkout didn't open.", { bad: true }); }
    return;
  }
  if (b.inv) { ctx.go(`/invoices/${encodeURIComponent(b.inv.id)}`); return; }
  if (b.ready) { makeInvoice(ctx, el); return; }
  toast(b.why || "There's nothing to collect here.", { bad: true });
}
async function payQr(ctx, el) {
  const b = billing(ctx.state, ctx.can);
  if (b.inv && b.inv.st === "open") {
    const id = encodeURIComponent(b.inv.id);
    const { openPayQr } = await import("../money/pay-qr.js");
    openPayQr({ fetch: () => ctx.api(`/invoices/${id}/pay-qr`, { method: "POST", body: {} }), check: async () => (await ctx.api(`/invoices/${id}`, { cache: false })).data.invoice.status === "paid", onClose: () => ctx.refresh() });
    return;
  }
  return checkout(ctx, el, "qr");
}
// a photo of one line (the camera on a line card), kept on the job's visit with the line's name
async function linePhoto(ctx, lineId, el) {
  const s = ctx.state;
  const v = jobVisit(s);
  const l = (s.job.lines || []).find((x) => x.id === lineId);
  if (!v || !l) return;
  const file = await capture();
  if (!file) return;
  busy(el, true);
  try {
    await uploadPhoto({ ownerType: "visit", ownerId: v.id, tag: "other", caption: l.title, file, extra: { line: l.id } });
    toast("Photo saved");
    ctx.refresh();
  } catch (err) { busy(el, false); toast(err.message || "That photo didn't save.", { bad: true }); }
}
// the upload in the notes box: a photo or a PDF kept on the job's visit
async function notesUpload(ctx, el) {
  const v = jobVisit(ctx.state);
  if (!v) { toast("Book a visit first: files are kept on a visit.", { bad: true }); return; }
  const file = await capture({ accept: "image/*,application/pdf", camera: false });
  if (!file) return;
  busy(el, true);
  try { await uploadPhoto({ ownerType: "visit", ownerId: v.id, tag: "other", file }); toast("Saved on the visit"); ctx.refresh(); }
  catch (err) { busy(el, false); toast(err.message || "That file didn't save.", { bad: true }); }
}
function visitsSheet(ctx) {
  const s = ctx.state;
  sheet({ title: `Visits · ${(s.visits || []).length}`, body: html`<div class="wk-visits jp-vsheet"><ul class="wk-vlist">${(s.visits || []).map((v, i) => html`<li>${visitRow(s, v, i)}${visitActs(s, v, ctx)}</li>`)}</ul></div>`,
    events: {
      "click [data-v-omw]": (e, el) => visitStep(ctx, el.dataset.vOmw, "omw"),
      "click [data-v-start]": (e, el) => visitStep(ctx, el.dataset.vStart, "start"),
      "click [data-v-move]": (e, el) => moveVisit(ctx, el.dataset.vMove),
      "click [data-v-note]": (e, el) => noteSheet(ctx, el.dataset.vNote),
    } });
}
// Delete Job (Flyra's red button): our rule is a cancel (with its open visits), so the history stays.
async function deleteJob(ctx) {
  const r = await reasonSheet({ title: "Delete this job", label: "Why? The job and its open visits are cancelled and kept, so its history stays.", yes: "Delete Job" });
  if (r) post(ctx, "cancel", { reason: r.reason }, "Job deleted (kept as cancelled)");
}

async function saveNotes(ctx, field, value) {
  const s = ctx.state;
  if ((s.job[field] || "") === value) return;
  try {
    const r = await ctx.api(`/jobs/${encodeURIComponent(s.job.id)}`, { method: "PATCH", body: { [field]: value }, ifMatch: s.etag });
    s.etag = r.etag || s.etag;
    s.job = { ...s.job, ...(r.data && r.data.job ? { [field]: r.data.job[field], updated_at: r.data.job.updated_at } : { [field]: value }) };
    toast("Saved");
  } catch (err) {
    toast(err.status === 412 ? "Someone else just changed this job. Here it is again." : err.message || "That didn't save.", { bad: true });
    ctx.refresh();
  }
}

let mq = null;
let mqOff = () => {};
export default {
  title: (s) => (s && s.job ? `Job ${s.job.number_label || ""}`.trim() : "Job"),
  load,
  // a phone: Rotor's round check (mark the job done) beside the "..."
  tools: (s, ctx) => (s && s.job && isPhone() && officeView() && s.can && s.can.complete ? [{ icon: "check", label: "Mark the job done", run: () => markDone(ctx) }] : []),
  // crossing 700 px (a phone turned, a window resized) draws the other layout
  mount(view, s, ctx) {
    mqOff();
    if (typeof matchMedia !== "function") return;
    let was = isPhone();
    const on = () => { if (isPhone() !== was) { was = isPhone(); ctx.rerender(); } };
    try { mq = matchMedia(PHONE_MEDIA); mq.addEventListener("change", on); mqOff = () => { try { mq.removeEventListener("change", on); } catch (e) { /* gone */ } mqOff = () => {}; }; } catch (e) { /* old Safari */ }
  },
  unmount() { mqOff(); },
  more: (s, ctx) => {
    if (!s || !s.job || !officeView()) return [];
    const c = s.can || {};
    const j = s.job;
    const open = !["completed", "cancelled"].includes(j.status);
    const b = billing(s, ctx.can);
    return [
      [c.add_visit && { label: "Book a visit", icon: "cal", run: () => book(ctx), data: { book: true } },
        c.complete && { label: "Mark done", icon: "check", run: () => markDone(ctx), data: { complete: true } },
        c.write && { label: "Edit the work", icon: "edit", hint: open ? "lines, notes" : "notes", run: () => editSheet(ctx), data: { edit: true } },
        c.write && open && j.totals && { label: "Add a discount", icon: "minus", run: () => discountSheet(ctx), data: { "add-discount": true } }],
      [b.may && !b.inv && { label: "Create invoice", icon: "money", hint: b.why ? "not now" : "", disabled: !b.ready, run: () => makeInvoice(ctx), data: { "make-invoice": true } },
        ctx.can("invoices:send") && b.inv && b.inv.st === "open" && b.inv.bal > 0 && { label: "Text a pay link", icon: "link", run: () => quick(ctx, "pay"), data: { "q-pay": true } },
        c.write && j.status === "completed" && { label: "Ask for a review now", icon: "trophy", run: () => quick(ctx, "review"), data: { "q-review": true } },
        c.write && j.status === "completed" && b.inv && { label: "Ask for a tip", icon: "gift", run: () => quick(ctx, "tip"), data: { "q-tip": true } },
        c.write && j.status === "completed" && { label: "Book a callback", icon: "undo", hint: "no charge", run: () => quick(ctx, "callback"), data: { "q-callback": true } }],
      [jobVisit(s) && itemsOf(jobVisit(s)).length && { label: "Checklist", icon: "check", hint: (() => { const it = itemsOf(jobVisit(s)); return `${it.filter(itemDone).length} of ${it.length} done`; })(), run: () => openCk(ctx), data: { "ck-open": true } },
        s.contact && { label: "Open customer", icon: "user", href: "#/contacts/" + encodeURIComponent(s.contact.id) }],
      [c.reopen && { label: "Reopen", icon: "undo", hint: "when done", run: () => reopen(ctx), data: { reopen: true } },
        c.cancel && { label: "Cancel job", icon: "close", danger: true, run: () => cancelJob(ctx), data: { cancel: true } }],
    ];
  },
  render(s, ctx) {
    const j = s.job;
    const office = officeView();
    if (isPhone()) return phoneView(s, ctx, H);
    const cv = jobVisit(s);
    return html`<div class="rs-page wk wk-job"><div class="wk-jgrid">
      ${topCard(s, ctx)}
      <div class="wk-jmain">
        ${statCards(s)}
        ${visitsCard(s, ctx)}
        ${(j.lines || []).length || (s.can && s.can.write) ? pricingCard(s, ctx) : ""}
      </div>
      <aside class="wk-jside" aria-label="Customer, invoices and notes">
        ${customerCard(s)}
        ${office ? invoicesCard(s, ctx) : ""}
        ${office ? soldBy(s) : ""}
        ${notesCard(s)}
        ${j.rotor ? html`<p class="foot-note">From Rotor (job ${j.number_label}). Changes here stay in the CRM.</p>` : ""}
        ${office && j.updated_at ? html`<p class="foot-note">Changed ${ago(j.updated_at)}</p>` : ""}
      </aside>
    </div>${cv && itemsOf(cv).length ? checklistPill(cv) : ""}</div>`;
  },
  events: {
    "click [data-book]": (e, el, ctx) => book(ctx),
    "click [data-v-omw]": (e, el, ctx) => visitStep(ctx, el.dataset.vOmw, "omw"),
    "click [data-v-start]": (e, el, ctx) => visitStep(ctx, el.dataset.vStart, "start"),
    "click [data-v-move]": (e, el, ctx) => moveVisit(ctx, el.dataset.vMove),
    "click [data-v-note]": (e, el, ctx) => noteSheet(ctx, el.dataset.vNote),
    "click [data-complete]": (e, el, ctx) => markDone(ctx),
    "click [data-edit-job]": (e, el, ctx) => editSheet(ctx),
    "click [data-add-line]": (e, el, ctx) => editSheet(ctx, { add: true }),
    "click [data-line]": (e, el, ctx) => editSheet(ctx, { line: el.dataset.line }),
    "click [data-add-discount]": (e, el, ctx) => discountSheet(ctx),
    "click [data-disc]": (e, el, ctx) => discountSheet(ctx, el.dataset.disc),
    "click [data-make-invoice]": (e, el, ctx) => makeInvoice(ctx, el),
    "change [data-notes=crew]": (e, el, ctx) => saveNotes(ctx, "crew_notes", el.value),
    "change [data-notes=office]": (e, el, ctx) => saveNotes(ctx, "office_notes", el.value),
    // the phone's (office-job-phone.js)
    "click [data-v-done]": (e, el, ctx) => completeVisit(ctx, el.dataset.vDone),
    "click [data-ck-open]": (e, el, ctx) => openCk(ctx),
    "click [data-jp-more]": () => { const m = document.getElementById("top-more"); if (m) m.click(); },
    "click [data-jp-off]": (e, el) => toast(el.dataset.jpOff),
    "click [data-q-callback]": (e, el, ctx) => quick(ctx, "callback"),
    "click [data-checkout]": (e, el, ctx) => checkout(ctx, el),
    "click [data-pay-link]": (e, el, ctx) => quick(ctx, "pay"),
    "click [data-pay-qr]": (e, el, ctx) => payQr(ctx, el),
    "click [data-pay-cash]": (e, el, ctx) => checkout(ctx, el),
    "click [data-line-photo]": (e, el, ctx) => linePhoto(ctx, el.dataset.linePhoto, el),
    "click [data-notes-upload]": (e, el, ctx) => notesUpload(ctx, el),
    "click [data-jp-visits]": (e, el, ctx) => visitsSheet(ctx),
    "click [data-del-job]": (e, el, ctx) => deleteJob(ctx),
  },
};

export { editSheet, discountSheet };
