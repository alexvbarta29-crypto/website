// The job page on a phone, just like Rotor's (Nov 2026, the owner: "make it
// just like Rotor"; his screenshots of Rotor's phone job page). A desk keeps
// the Rotor-desktop two columns (office-job.js); under 700 px the page is
// Rotor's one scroll, card after card:
//
//   the visit card: the big day ("Nov 18") with a round calendar (move the
//   visit, or book one) and a round "..." (the visit's own rows), the time
//   with the length chip ("2 hrs"), who goes (colored dots), and two pills:
//   the red "Start visit" and the grey "On My Way" (then Complete visit and
//   Pause, Resume, ...); the customer (call, text); the address (directions,
//   the pencil); Pricing (a row a line: the name, the amount; "Added on site"
//   with the tech who added it; "+ Item", Subtotal, each discount green with
//   its pencil, "+ Add discount", Total, Create Invoice); Invoices (+); Job
//   notes (with an upload); "Sold by"; and the floating "N left" pill that
//   opens the visit's checklist.
//
// Everything else lives in the round "..." of the header (office-job.js
// more()): Checkout and the ways to be paid (pay link, QR, cash or check),
// the plan, office notes, a callback, a photo of a line, Cancel job.
//
// The visit card, the customer and address cards, Pricing and Job notes are
// built here for the tech's Visit screen too (visit.js, visit-field.js), so
// both pages look the same.

import { html, attrs, raw, openExternal, addressHold } from "../../core/ui.js";
import { houseOn, houseThumbLink, addressText } from "../contacts/house.js";
import { money, clock, phone as formatPhone } from "../../core/format.js";
import { directionsUrl } from "../../core/map.js";
import { officeView } from "./office-kit.js";
import { checklistPill } from "./checklist-sheet.js";
import { currentVisit, itemsOf, itemDone } from "./checklist-kit.js";

export const PHONE_MEDIA = "(max-width: 699px)";
export const isPhone = () => typeof matchMedia === "function" && matchMedia(PHONE_MEDIA).matches;

const OPEN_VISIT = ["scheduled", "en_route", "in_progress", "paused"];
const svg = (d) => raw(`<svg viewBox="0 0 24 24" aria-hidden="true" focusable="false">${d}</svg>`);
export const RI = {
  play: svg('<path d="M7 4.8v14.4a1 1 0 0 0 1.5.86l11.6-7.2a1 1 0 0 0 0-1.72L8.5 3.94A1 1 0 0 0 7 4.8z" fill="currentColor" stroke="none"/>'),
  truck: svg('<path d="M2.8 6.5h10.4v9.8H2.8zM13.2 9.5h4.1l3.9 3.9v2.9h-8"/><circle cx="6.6" cy="17.4" r="1.9"/><circle cx="16.9" cy="17.4" r="1.9"/>'),
  cal: svg('<rect x="4" y="5" width="16" height="15.5" rx="2.5"/><path d="M4 10h16M8.5 3v4M15.5 3v4"/>'),
  more: svg('<circle cx="5.5" cy="12" r="1.6" fill="currentColor" stroke="none"/><circle cx="12" cy="12" r="1.6" fill="currentColor" stroke="none"/><circle cx="18.5" cy="12" r="1.6" fill="currentColor" stroke="none"/>'),
  clock: svg('<circle cx="12" cy="12" r="8.5"/><path d="M12 7.5V12l3 2"/>'),
  chev: svg('<path d="M7.5 10l4.5 4.5 4.5-4.5"/>'),
  call: svg('<path d="M6.6 3.5h2.6l1.4 4-2 1.3a11 11 0 0 0 5.6 5.6l1.3-2 4 1.4v2.6a2 2 0 0 1-2.2 2A15.5 15.5 0 0 1 4.6 5.7a2 2 0 0 1 2-2.2z"/>'),
  chat: svg('<path d="M4.5 5.5h15v10.5h-9l-4.5 3.5v-3.5H4.5z"/>'),
  pin: svg('<path d="M12 21s-6.5-6.2-6.5-11.2a6.5 6.5 0 0 1 13 0C18.5 14.8 12 21 12 21z"/><circle cx="12" cy="9.8" r="2.4"/>'),
  nav: svg('<path d="M20 4L3.8 10.9l7 2.3 2.3 7z"/>'),
  pen: svg('<path d="M15.6 4.6l3.8 3.8L8.6 19.2 4 20l.8-4.6z"/><path d="M13.6 6.6l3.8 3.8"/>'),
  plus: svg('<path d="M12 5v14M5 12h14"/>'),
  upload: svg('<path d="M12 15.5V4M7.5 8.5L12 4l4.5 4.5M4.5 14.5V18a2 2 0 0 0 2 2h11a2 2 0 0 0 2-2v-3.5"/>'),
  check: svg('<path d="M5 12.5l4.5 4.5L19 7.5"/>'),
  pause: svg('<path d="M8.5 5v14M15.5 5v14"/>'),
  late: svg('<circle cx="12" cy="13" r="7.5"/><path d="M12 9v4.2l2.6 1.6M9.5 2.8h5"/>'),
};
const tel = (ph) => String((ph && ph.e164) || "").replace(/[^+\d]/g, "");
export const initialsOf = (name) => String(name || "").trim().split(/\s+/).filter(Boolean).slice(0, 2).map((w) => w[0].toUpperCase()).join("") || "?";
const DOTS = ["#d2d5da", "#3f4e8e", "#13a165", "#d97706", "#db3a29", "#7c3aed"];
const MD = new Intl.DateTimeFormat("en-US", { timeZone: "UTC", month: "short", day: "numeric" });
const MONTH = new Intl.DateTimeFormat("en-US", { timeZone: "UTC", month: "long", year: "numeric" });
const dataOf = (o) => Object.fromEntries(Object.entries(o || {}).filter(([, v]) => v !== null && v !== undefined && v !== false).map(([k, v]) => [k.startsWith("data-") || k.startsWith("aria-") ? k : `data-${k}`, v === true ? "" : v]));

// "Nov 18"
export const dayText = (d) => (d ? MD.format(new Date(d + "T12:00:00Z")) : "");
// "8:00 AM – 10:00 AM" (Rotor's)
export const timeText = (v) => (v && !v.date_only && v.start && v.end ? `${clock(v.start)} – ${clock(v.end)}` : v && v.date_only ? "Anytime that day" : "");

// "2 hrs", "1 hr 30 min", "45 min" from a visit's start and end
export function lengthText(v) {
  const m = (s) => { const x = /^(\d{1,2}):(\d{2})$/.exec(String(s || "")); return x ? Number(x[1]) * 60 + Number(x[2]) : null; };
  const a = m(v && v.start), b = m(v && v.end);
  if (a === null || b === null || b <= a) return "";
  const d = b - a, h = Math.floor(d / 60), r = d % 60;
  return h ? `${h} ${h === 1 ? "hr" : "hrs"}${r ? ` ${r} min` : ""}` : `${r} min`;
}

// Who goes: [{ name, color }] (a person's own color, else Rotor's grey and blue).
export function whoGoes(v, users = [], people = null) {
  return v ? (v.assignee_ids || []).map((id, i) => {
    const u = (users || []).find((x) => x.id === id);
    const p = Array.isArray(people) ? people.find((x) => x.id === id) : people && people[id];
    return { name: (p && p.name) || (u && u.name) || "Someone", color: (u && u.color) || (p && p.color) || DOTS[i % DOTS.length] };
  }) : [];
}

// A round button: a 44 px tap target, its circle drawn at d px (Rotor's 36, 44, 48).
export function roundBtn(ic, label, { d = 44, tone = "", href = null, data = null, ext = false, cls = "" } = {}) {
  const a = { class: ["jp-o", tone, cls].filter(Boolean).join(" "), style: `--d:${d}px`, "aria-label": label, ...dataOf(data) };
  if (href && ext) return html`<a ${openExternal(href)} ${attrs(a)}>${ic}</a>`;
  if (href) return html`<a ${attrs({ ...a, href })}>${ic}</a>`;
  return html`<button type="button" ${attrs(a)}>${ic}</button>`;
}
// A pill (Rotor's): red (the step), grey (the second step, "+ Item", Create Invoice).
function pill(label, { ic = null, tone = "grey", data = null, href = null, cls = "", disabled = false, aria = null } = {}) {
  const a = { class: ["jp-pill", tone, cls].filter(Boolean).join(" "), "aria-label": aria, ...dataOf(data) };
  const inner = html`${ic || ""}<span>${label}</span>`;
  if (href) return html`<a ${attrs({ ...a, href })}>${inner}</a>`;
  return html`<button type="button" ${attrs({ ...a, disabled: disabled || null })}>${inner}</button>`;
}

// The visit card (Rotor's), for the job page and the Visit screen:
//   { day, dayHref, cal: { label, data } | null, more: { label, data } | null, time, chip: { text, data? } | null,
//     people: [{ name, color }], lines: html (status, timer, notes) , go: [{ label, ic, tone, data, aria? }], id, cls }
export function visitCard({ day = "", dayHref = null, cal = null, more = null, time = "", chip = null, people = [], lines = "", go = [], id = null, cls = "", label = "The visit" } = {}) {
  const c = chip ? html`<span class="jp-chip-v">${RI.clock}<span>${chip.text}</span>${chip.data ? RI.chev : ""}</span>` : "";
  return html`<section ${attrs({ class: ["rs-card jp-card jp-visit", cls].filter(Boolean).join(" "), id, "aria-label": label })}>
    <div class="jp-vrow"><h2 class="jp-vday">${dayHref ? html`<a ${attrs({ href: dayHref })}>${day}</a>` : day}</h2>
      <span class="jp-vbtns">${cal ? roundBtn(RI.cal, cal.label, { d: 36, tone: "soft", data: cal.data }) : ""}${more ? roundBtn(RI.more, more.label, { d: 36, tone: "soft", data: more.data }) : ""}</span></div>
    ${time || chip ? html`<div class="jp-vtime">${time ? html`<span class="num">${time}</span>` : ""}${chip ? (chip.data ? html`<button type="button" ${attrs({ class: "jp-chip", "aria-label": chip.aria || chip.text, ...dataOf(chip.data) })}>${c}</button>` : html`<span class="jp-chip">${c}</span>`) : ""}</div>` : ""}
    ${people.length ? html`<p class="jp-people">${people.map((p) => html`<span class="jp-person"><i ${attrs({ style: `background:${p.color}` })} aria-hidden="true"></i>${p.name}</span>`)}</p>` : ""}
    ${lines}
    ${go.length ? html`<div class="jp-go">${go.map((g) => pill(g.label, { ic: g.ic, tone: g.tone || "grey", data: g.data, aria: g.aria, cls: g.cls || "" }))}</div>` : ""}
  </section>`;
}

// The customer card: the initial on a grey tile, the name and phone, a red round call and a round message.
export function customerCard(c, { office = officeView() } = {}) {
  if (!c) return "";
  const ph = (c.phones || []).find((x) => x.primary) || (c.phones || [])[0];
  const n = tel(ph);
  const name = c.display_name || "Customer";
  const who = html`<span class="jp-tile" aria-hidden="true">${initialsOf(name).slice(0, 1)}</span><span class="jp-pw"><span class="jp-pn">${name}</span>${ph && ph.e164 ? html`<span class="jp-ps num">${formatPhone(ph.e164)}</span>` : ""}</span>`;
  return html`<div class="rs-card jp-card jp-row rs-person">${office ? html`<a ${attrs({ class: "jp-pl", href: "#/contacts/" + encodeURIComponent(c.id) })}>${who}</a>` : html`<span class="jp-pl">${who}</span>`}
    <span class="jp-acts">${n ? roundBtn(RI.call, "Call " + name, { tone: "red", href: "tel:" + n }) : ""}${n ? roundBtn(RI.chat, "Text " + name, { tone: "white", href: "sms:" + n }) : ""}</span></div>`;
}
// The address card: a pin tile, the street over "Town, MN, 55328" (+ the gate code), round navigate and pencil.
export function placeCard(p, { office = officeView(), where = "" } = {}) {
  const a = p && p.address;
  if (!(a && (a.street1 || a.city)) && !where) return "";
  const gate = p && p.access && p.access.gate_code;
  const line1 = a ? a.street1 || a.city : where;
  const line2 = a ? [[a.city, a.state, a.zip].filter(Boolean).join(", "), gate ? `gate ${gate}` : ""].filter(Boolean).join(" · ") : "";
  const nav = directionsUrl(a || where);
  // a long press on the address copies it; the house (Street View) as a small square once Google is on
  const line = a ? addressText(a) : where;
  const thumb = p && p.id && a && a.street1 && houseOn() ? houseThumbLink({ id: p.id, geo: p.geo, line }) : "";
  return html`<div class="rs-card jp-card jp-row rs-addr">${thumb}<span class="jp-pl" ${addressHold(line)}>${thumb ? "" : html`<span class="jp-tile" aria-hidden="true">${RI.pin}</span>`}<span class="jp-pw"><span class="jp-pn">${line1}</span>${line2 ? html`<span class="jp-ps">${line2}</span>` : ""}</span></span>
    <span class="jp-acts">${nav ? roundBtn(RI.nav, "Directions", { tone: "white", href: nav, ext: true }) : ""}${office && p && p.id ? roundBtn(RI.pen, "Edit the place and its access", { tone: "white", href: "#/properties/" + encodeURIComponent(p.id) }) : ""}</span></div>`;
}

// Pricing (Rotor's):
//   rows: [{ title, amount, sub?, by?: { name, color }, data? }]; add: { data, label? } ("+ Item");
//   subtotal; discounts: [{ label, amount, data? }]; addDiscount: { data }; total; paid; cta: { label, data, disabled, why }
export function pricingCard({ rows = [], add = null, subtotal = null, discounts = [], addDiscount = null, total = null, paid = false, cta = null, empty = "No work on this job yet.", cls = "" } = {}) {
  const row = (r) => {
    const top = html`<span class="jp-rt"><span class="jp-rn">${r.title}</span>${r.amount ? html`<span class="jp-ra num">${r.amount}</span>` : ""}</span>${r.sub ? html`<span class="jp-rs">${r.sub}</span>` : ""}${r.by ? html`<span class="jp-onsite"><span class="jp-tag">Added on site</span><span class="jp-av" ${attrs({ title: r.by.name, style: r.by.color ? `background:${r.by.color}` : null })}>${initialsOf(r.by.name)}</span><span class="sr">by ${r.by.name}</span></span>` : ""}`;
    return html`<li>${r.data ? html`<button type="button" ${attrs({ class: "jp-r", "aria-label": r.aria || null, ...dataOf(r.data) })}>${top}</button>` : html`<div class="jp-r">${top}</div>`}</li>`;
  };
  const sums = subtotal !== null || total !== null;
  return html`<section ${attrs({ class: ["rs-card jp-card jp-pricing", cls].filter(Boolean).join(" ") })}><h3 class="jp-h">Pricing</h3>
    ${rows.length ? html`<ul class="jp-rows" aria-label="Line items">${rows.map(row)}</ul>` : html`<p class="rs-empty jp-empty">${empty}</p>`}
    ${add ? html`<div class="jp-add">${pill(add.label || "Item", { ic: RI.plus, data: add.data, aria: add.aria || "Add an item", cls: "sm" })}</div>` : ""}
    ${sums ? html`<div class="jp-sums">
      ${subtotal !== null ? html`<div class="jp-sum"><span>Subtotal</span><span class="num">${subtotal}</span></div>` : ""}
      ${discounts.map((d) => html`<div class="jp-sum green"><span class="jp-dl">${d.label}${d.data ? html`<button type="button" ${attrs({ class: "jp-o jp-pen", style: "--d:28px", "aria-label": `Change ${d.label}`, ...dataOf(d.data) })}>${RI.pen}</button>` : ""}</span><span class="num">${d.amount}</span></div>`)}
      ${addDiscount ? html`<div class="jp-add">${pill("Add discount", { ic: RI.plus, data: addDiscount.data, cls: "sm" })}</div>` : ""}
      ${total !== null ? html`<div class="jp-tot"><span>Total</span><span class="${"num" + (paid ? " paid" : "")}">${total}</span></div>` : ""}
      ${paid ? html`<p class="rs-paid">Paid in full</p>` : ""}</div>` : ""}
    ${cta ? html`<div class="jp-cta">${pill(cta.label, { data: cta.data, disabled: cta.disabled, cls: "wide" })}${cta.why ? html`<p class="rs-sub wk-why">${cta.why}</p>` : ""}</div>` : ""}
  </section>`;
}

// Each discount's share of the job's discount (percentages of the subtotal, the last takes what's left),
// as the desk and the invoice show it: cents, one per job.discounts.
export function discountShares(j) {
  const ds = (j && j.discounts) || [];
  if (!j || !j.totals) return ds.map(() => 0);
  const sub = j.totals.subtotal_cents || 0;
  let left = j.totals.discount_cents || 0;
  return ds.map((d, i) => { const want = d.type === "percentage" ? Math.round((sub * d.value) / 10000) : d.value; const a = i === ds.length - 1 ? left : Math.min(left, want); left -= a; return a; });
}
const pct = (bp) => `${String(bp / 100).replace(/\.0+$/, "")}%`;
export const discountLabel = (d) => `${d.name || "Discount"}${d.type === "percentage" ? ` (${pct(d.value)})` : ""}`;

// ------------------------------------------------------------ the job page

// The pills under the visit, for the visit's own people (the same steps as
// the Visit screen); someone else gets the office's step (book, mark done).
export function goPills(s, ctx, v) {
  const c = s.can || {};
  const j = s.job;
  const mine = !!(v && ctx && ctx.user && (v.assignee_ids || []).includes(ctx.user.id) && OPEN_VISIT.includes(v.status));
  if (mine) {
    const left = itemsOf(v).filter((i) => i.required && !itemDone(i)).length;
    const why = left ? `${left} required ${left === 1 ? "item" : "items"} on the checklist first` : null;
    if (v.status === "scheduled") return [{ label: "Start visit", ic: RI.play, tone: "red", data: { "v-start": v.id } }, { label: "On My Way", ic: RI.truck, data: { "v-omw": v.id } }];
    if (v.status === "en_route") return [{ label: "Start visit", ic: RI.play, tone: "red", data: { "v-start": v.id } }, { label: "On the way", ic: RI.truck, data: { "jp-off": "On my way went out. Start the visit when you get there." }, cls: "done" }];
    if (v.status === "paused") return [{ label: "Resume", ic: RI.play, tone: "red", data: { "v-start": v.id } }, { label: "Complete", ic: RI.check, data: { "v-done": v.id }, aria: why ? `Complete visit: ${why}` : null }];
    return [{ label: "Complete visit", ic: RI.check, tone: "red", data: { "v-done": v.id }, aria: why ? `Complete visit: ${why}` : null }, { label: "Pause", ic: RI.pause, data: { "v-pause": v.id } }];
  }
  const visits = s.visits || [];
  if (!visits.some((x) => OPEN_VISIT.includes(x.status)) && c.add_visit && j.status === "unscheduled") return [{ label: "Book a visit", ic: RI.cal, tone: "red", data: { book: true } }];
  const allDone = visits.length && visits.every((x) => !OPEN_VISIT.includes(x.status)) && visits.some((x) => x.status === "completed");
  if (c.complete && allDone && j.status !== "completed") return [{ label: "Mark done", ic: RI.check, tone: "red", data: { complete: true } }];
  return [];
}

const VS_WORD = { en_route: "On the way", in_progress: "Working", paused: "Paused", completed: "Done", no_access: "No access", cancelled: "Cancelled" };
function jobVisitCard(s, ctx, v, h) {
  const j = s.job;
  const c = s.can || {};
  const office = officeView();
  const openV = v && OPEN_VISIT.includes(v.status);
  const move = office && c.write && v && v.status === "scheduled";
  const len = v && !v.date_only ? lengthText(v) : "";
  const cal = move ? { label: "Reschedule the visit", data: { "v-move": v.id } } : office && c.add_visit && !openV ? { label: "Book a visit", data: { book: true } } : null;
  const day = v ? dayText(v.date) : j.target_month && j.status === "unscheduled" ? `Due by ${MONTH.format(new Date(j.target_month + "-15T12:00:00Z"))}` : "Not booked yet";
  const lines = [];
  if (v && v.status !== "scheduled" && VS_WORD[v.status]) lines.push(html`<p class="jp-vst">${VS_WORD[v.status]}${h.onSite(s.visits) ? ` · ${h.onSite(s.visits)} on site` : ""}</p>`);
  if (j.status === "cancelled" && j.cancel_reason) lines.push(html`<p class="warn-box">Cancelled: ${j.cancel_reason}</p>`);
  const go = goPills(s, ctx, v);
  const left = v && go.some((g) => g.data && g.data["v-done"]) ? itemsOf(v).filter((i) => i.required && !itemDone(i)).length : 0;
  if (left) lines.push(html`<p class="jp-vnote">${left} required ${left === 1 ? "item" : "items"} on the checklist first</p>`);
  return visitCard({
    day, dayHref: v ? "#/visits/" + encodeURIComponent(v.id) : null,
    cal, more: v || (s.visits || []).length ? { label: "The visit's options", data: { "jp-vmore": true } } : null,
    time: v ? timeText(v) : "", chip: len ? { text: len, data: move ? { "v-move": v.id } : null, aria: move ? `${len}, change the time` : len } : null,
    people: whoGoes(v, s.users, s.people), lines, go,
  });
}

function jobPricing(s, ctx, h) {
  const j = s.job;
  const c = s.can || {};
  const open = !["completed", "cancelled"].includes(j.status);
  const edit = c.write && open;
  const lines = j.lines || [];
  const prices = !!j.totals;
  const ds = j.discounts || [];
  const b = h.billing(s, ctx.can);
  if (!lines.length && !edit) return "";
  const users = s.users || [];
  const qty = (l) => { const q = (l.qty_milli ?? 1000) / 1000; return Number.isInteger(q) ? String(q) : q.toFixed(2); };
  const amounts = discountShares(j);
  const rows = lines.map((l) => {
    const by = l.upsell_user_id ? users.find((u) => u.id === l.upsell_user_id) || (s.people && s.people[l.upsell_user_id]) || { name: "The tech" } : null;
    const q = qty(l);
    return {
      title: l.title, amount: prices && l.total_cents != null ? money(l.total_cents) : "",
      sub: q !== "1" ? `${q} × ${prices && l.unit_cents != null ? money(l.unit_cents) : "each"}` : "",
      by, data: edit && l.id ? { line: l.id } : null, aria: edit ? `${l.title}, change it` : null,
    };
  });
  return pricingCard({
    cls: "wk-pricing", rows, add: edit ? { data: { "add-line": true } } : null,
    subtotal: prices ? money(j.totals.subtotal_cents) : null,
    discounts: prices ? ds.map((d, i) => ({ label: h.discLabel(d), amount: money(-amounts[i]), data: edit ? { disc: d.id } : null })) : [],
    addDiscount: prices && edit ? { data: { "add-discount": true } } : null,
    total: prices ? money(j.totals.total_cents) : null, paid: !!(b.inv && b.inv.st === "paid"),
    cta: b.may && !b.inv ? { label: "Create Invoice", data: { "make-invoice": true }, disabled: !b.ready, why: b.why } : null,
  });
}

function invoices(s, ctx, h) {
  if (!officeView() || s.invoices === null || s.invoices === undefined) return "";
  const b = h.billing(s, ctx.can);
  const add = b.ready ? { label: "Create an invoice from this job", data: { "make-invoice": true } }
    : ctx.can("invoices:write") && s.contact ? { label: "A new invoice for this customer", href: `#/invoices/new/${encodeURIComponent(s.contact.id)}` } : null;
  return html`<section class="rs-card jp-card jp-invs wk-invs"><div class="jp-ch"><h3 class="jp-h">Invoices</h3>${add ? roundBtn(RI.plus, add.label, { d: 32, tone: "bare", href: add.href, data: add.data }) : ""}</div>
    ${s.invoices.length ? s.invoices.map((i) => html`<a class="wk-irow" href="${"#/invoices/" + encodeURIComponent(i.id)}"><span class="wk-iw"><b>#${i.n}</b><span class="rs-sub">${h.invLine(i)}</span></span><span class="${"num wk-iamt" + (i.st === "paid" ? " paid" : "")}">${money(i.tot)}</span></a>`)
      : html`<p class="jp-none">No invoices yet</p>`}</section>`;
}

// Job notes: the crew's notes in Rotor's grey box with the upload; the office's own notes under it once
// there are some (the "..." opens them otherwise).
function notes(s, v) {
  const j = s.job;
  const c = s.can || {};
  const office = officeView();
  const up = v && c.write ? html`<button type="button" class="jp-o jp-up white" style="--d:32px" data-notes-upload aria-label="Attach a photo or a file to this visit">${RI.upload}</button>` : "";
  return html`<section class="rs-card jp-card jp-notes wk-jnotes"><h3 class="jp-h">Job notes</h3>
    ${c.write ? html`<div class="jp-nbox"><textarea class="jp-ta" data-notes="crew" aria-label="Job notes (the crew sees these)" placeholder="Add notes for this job..." rows="2">${j.crew_notes || ""}</textarea>${up}</div>` : j.crew_notes ? html`<p class="wk-pre">${j.crew_notes}</p>` : html`<p class="jp-none">No notes.</p>`}
    ${office && j.office_notes ? html`<h4 class="wk-nlabel">Office notes</h4><div class="jp-nbox">${c.write ? html`<textarea class="jp-ta" data-notes="office" aria-label="Office notes (the crew never sees these)" placeholder="Add a note for the office..." rows="2">${j.office_notes}</textarea>` : html`<p class="wk-pre">${j.office_notes}</p>`}</div>` : ""}
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
  return html`<a class="jp-sold" ${attrs({ href })}><span class="jp-av md" ${attrs({ style: u && u.color ? `background:${u.color}` : null })} aria-hidden="true">${initialsOf(name)}</span><span class="jp-sold-w"><span class="jp-sold-n">Sold by ${name}</span><span class="jp-sold-s">${q ? `Edit on quote ${q.number || ""}`.trim() : "Edit on the service plan"}</span></span></a>`;
}

// Flyra's "Amount due" (now rows of the "..."): what's owed, when there's something to collect.
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

export function phoneView(s, ctx, h) {
  const j = s.job;
  const v = currentVisit(s.visits || []);
  return html`<div class="rs-page wk wk-job jp">
    ${jobVisitCard(s, ctx, v, h)}
    ${customerCard(s.contact)}
    ${placeCard(s.property)}
    ${jobPricing(s, ctx, h)}
    ${invoices(s, ctx, h)}
    ${notes(s, v)}
    ${soldBy(s)}
    ${j.rotor ? html`<p class="foot-note">From Rotor (job ${j.number_label}). Changes here stay in the CRM.</p>` : ""}
    ${v && itemsOf(v).length ? html`<div class="ck-room" aria-hidden="true"></div>${checklistPill(v)}` : ""}
  </div>`;
}
