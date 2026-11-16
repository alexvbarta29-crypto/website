// Barta CRM client: the create sheets (the owner, Nov 15: "make ours match"
// Flyra's phone app, best of both with Rotor). New job, New quote and New
// plan are full-screen sheets: a round ✕ and a centred title, "Customer"
// with a card (the person, their phone, a clear button; under it the
// property, a tap picks another), the Mockup chip (Light Studio, on lights
// work), the form's cards, and one big Create button at the bottom that
// stays grey until the form can be saved. On a desk the same form sits in
// a centred 560 px sheet over the page.
//
// Markup helpers return html`` like the kit's (a tap is the screen's own
// events on the data-* it passes); the pickers open sheets and resolve with
// the choice, or null when closed. The screen is still a route (deep links,
// back, the e2e hooks): createPage() draws it fixed over the app's header
// and tab bar. Styles: styles/create.css, loaded once by ensureCreateStyles().

import { html, raw, attrs, sheet, toast, render, toggle, dataOf, addressHold } from "./ui.js";
import { money, phone, clock, dateYear, dateShort, localDate } from "./format.js";
import { uuid } from "./api.js";

// → a promise that settles once the sheet's styles are there (a screen's
// load() awaits it, so the form never shows unstyled); 3 s at most.
let styled = null;
export function ensureCreateStyles() {
  if (styled) return styled;
  if (typeof document === "undefined") return Promise.resolve();
  styled = new Promise((ok) => {
    const l = document.createElement("link");
    l.rel = "stylesheet";
    l.href = "/crm-app/styles/create.css";
    l.addEventListener("load", () => ok(), { once: true });
    l.addEventListener("error", () => ok(), { once: true });
    setTimeout(ok, 3000);
    document.head.appendChild(l);
  });
  return styled;
}

// ------------------------------------------------------------ icons (static, trusted)

const svg = (d, w = 24) => raw(`<svg viewBox="0 0 ${w} 24" aria-hidden="true" focusable="false">${d}</svg>`);
export const CF_ICONS = {
  close: svg('<path d="M6 6l12 12M18 6L6 18"/>'),
  person: svg('<circle cx="12" cy="8.5" r="3.6"/><path d="M5 20c.8-3.6 3.6-5.5 7-5.5s6.2 1.9 7 5.5"/>'),
  house: svg('<path d="M4 11.5 12 5l8 6.5"/><path d="M6.5 10v9.5h11V10"/><path d="M10.5 19.5v-5h3v5"/>'),
  plusc: svg('<circle cx="12" cy="12" r="9"/><path d="M12 8v8M8 12h8"/>'),
  tag: svg('<path d="M3.5 12.2V4.5a1 1 0 0 1 1-1h7.7l8.3 8.3a1 1 0 0 1 0 1.4l-7.7 7.7a1 1 0 0 1-1.4 0z"/><circle cx="8" cy="8" r="1.4"/>'),
  updown: svg('<path d="M8 9.5 12 5.5l4 4M8 14.5l4 4 4-4"/>'),
  chevdown: svg('<path d="M6.5 9.5 12 15l5.5-5.5"/>'),
  chevright: svg('<path d="M9.5 6.5 15 12l-5.5 5.5"/>'),
  cal: svg('<rect x="3.5" y="5" width="17" height="15.5" rx="3"/><path d="M3.5 10h17M8 3v4M16 3v4M8 14h.01M12 14h.01M16 14h.01M8 17.5h.01M12 17.5h.01"/>'),
  attach: svg('<rect x="3" y="4.5" width="15" height="12" rx="2.5"/><path d="M3 13.5l4-3.5 4 3.5 2.5-2 4.5 3.5"/><circle cx="18.5" cy="17.5" r="3.5"/><path d="M18.5 16v3M17 17.5h3"/>'),
  lights: svg('<rect x="2.5" y="6" width="19" height="12" rx="3.5"/><path d="M6 12h.01M9 12h.01M12 12h.01M15 12h.01M18 12h.01"/>'),
  service: svg('<rect x="3.5" y="5" width="17" height="15.5" rx="3"/><path d="M3.5 10h17M8 3v4M16 3v4M8 14h.01M12 14h.01M16 14h.01"/>'),
  doc: svg('<path d="M7 3.5h6.5L18 8v12a.5.5 0 0 1-.5.5h-10A.5.5 0 0 1 7 20z"/><path d="M13.5 3.5V8H18M9.5 12.5h5M9.5 16h5"/>'),
  card: svg('<rect x="3" y="5.5" width="18" height="13" rx="2.5"/><path d="M3 10h18M7 14.5h3"/>'),
  ruler: svg('<path d="M3.5 16.5 16.5 3.5l4 4-13 13z"/><path d="M7 13l2 2M10 10l2 2M13 7l2 2"/>'),
  book: svg('<path d="M5 4.5h11a2 2 0 0 1 2 2V20H7a2 2 0 0 1-2-2z"/><path d="M5 18a2 2 0 0 1 2-2h11"/>'),
  pencil: svg('<path d="M4 20h4L19 9l-4-4L4 16z"/><path d="M13.5 6.5l4 4"/>'),
};
const ic = (n) => CF_ICONS[n] || raw("");

// ------------------------------------------------------------ words

// "2026-11-16" → "11/16/26" (Flyra's date pill)
export const dayPill = (d) => (/^\d{4}-\d{2}-\d{2}$/.test(String(d || "")) ? `${Number(d.slice(5, 7))}/${Number(d.slice(8, 10))}/${d.slice(2, 4)}` : "Pick a day");
export const dayLong = (d) => dateYear(d) || "Pick a day";
export const timePill = (t) => clock(t) || "Anytime";
export const addDays = (date, n) => { const x = new Date(date + "T12:00:00Z"); x.setUTCDate(x.getUTCDate() + n); return x.toISOString().slice(0, 10); };
export const today = () => localDate(new Date());
export const toMin = (hhmm) => { const m = /^(\d{1,2}):(\d{2})$/.exec(String(hhmm || "")); return m ? Number(m[1]) * 60 + Number(m[2]) : null; };
export const fromMin = (n) => { const x = Math.max(0, Math.min(1439, n)); return `${String(Math.floor(x / 60)).padStart(2, "0")}:${String(x % 60).padStart(2, "0")}`; };
const qtyText = (milli) => { const q = (Number.isInteger(milli) ? milli : 1000) / 1000; return Number.isInteger(q) ? String(q) : String(Math.round(q * 1000) / 1000); };
const rhu = (num, den) => { const neg = num < 0; const a = Math.abs(num); const q = Math.floor((a * 2 + den) / (den * 2)); return neg ? -q : q; };
export const lineCents = (l) => rhu((l.unit_cents || 0) * (Number.isInteger(l.qty_milli) ? l.qty_milli : 1000), 1000);
// Lines and discounts → the total (percentages first, then amounts; never below 0): the server's job math.
export function totalOf(lines = [], discounts = []) {
  const sub = lines.reduce((n, l) => n + lineCents(l), 0);
  let bp = 0, fixed = 0;
  for (const d of discounts) { if (d.type === "percentage") bp += d.value || 0; else fixed += d.value || 0; }
  return Math.max(0, sub - rhu(sub * Math.min(10000, bp), 10000) - fixed);
}
export const discountWords = (d) => (d.type === "percentage" ? `${(d.value || 0) / 100}% off` : `${money(d.value || 0)} off`);

// ------------------------------------------------------------ the page

// The whole sheet. form: attributes of the <form> (id, data-*: the e2e and
// the screen's events use them); cta: { label, disabled }.
export function createPage({ title, body, cta = null, form = {} }) {
  ensureCreateStyles();
  return html`<div class="cf-page">
    <form ${attrs({ class: "cf", novalidate: true, "aria-labelledby": "cf-title", ...form })}>
      <header class="cf-head"><button type="button" class="cf-x" data-cf-close aria-label="Close">${ic("close")}</button><h1 id="cf-title">${title}</h1><span class="cf-sp" aria-hidden="true"></span></header>
      <div class="cf-body">${body}<p class="cf-err" data-form-err role="alert" hidden></p></div>
      ${cta ? html`<div class="cf-foot"><button ${attrs({ type: "submit", class: "cf-cta", "data-cf-create": true, disabled: !!cta.disabled, "aria-disabled": cta.disabled ? "true" : null })}>${cta.label}</button></div>` : ""}
    </form>
  </div>`;
}

// A label over a card: "Customer", "Line items *", "Schedule ... [switch]".
export const fieldLabel = (text, { required = false, end = null, field = null } = {}) =>
  html`<div ${attrs({ class: "cf-lbl", "data-field": field })}><span class="cf-lt">${text}${required ? html`<i class="cf-req" aria-label="required">*</i>` : ""}</span>${end || ""}<small class="why" hidden></small></div>`;

const tile = (name) => html`<span class="cf-tile">${ic(name)}</span>`;
const addrOf = (p) => {
  const a = (p && p.address) || {};
  return { line1: a.street1 || (p && p.label) || "A property", line2: [a.city, [a.state || (a.city ? "MN" : ""), a.zip].filter(Boolean).join(" ")].filter(Boolean).join(", ") };
};

// The customer card. c: { name, phone } | null; p: the property or null;
// n: how many places they have (a tap picks another, or adds one).
export function customerCard(c, p, { clear = true } = {}) {
  if (!c) {
    return html`<div class="cf-card" data-field="contact_id"><button type="button" class="cf-row" data-cf-pick>${tile("person")}<span class="cf-t"><b>Add a customer</b><small>Search, or add someone new</small></span><span class="cf-ch">${ic("chevright")}</span></button></div>`;
  }
  const a = p ? addrOf(p) : null;
  return html`<div class="cf-card" data-field="contact_id">
    <div class="cf-row cf-who">${tile("person")}<span class="cf-t"><b>${c.name}</b>${c.phone ? html`<small>${phone(c.phone)}</small>` : ""}</span>${clear ? html`<button type="button" class="cf-clear" data-cf-clear aria-label="Pick another customer">${ic("close")}</button>` : ""}</div>
    <button type="button" class="cf-row cf-in" data-cf-prop data-field="property_id" ${addressHold(a && p.address && p.address.street1 ? [a.line1, a.line2].filter(Boolean).join(", ") : "")}>${tile("house")}<span class="cf-t">${a ? html`<b>${a.line1}</b>${a.line2 ? html`<small>${a.line2}</small>` : ""}` : html`<b>No address yet</b><small>Add where the work is</small>`}</span><span class="cf-ch">${ic("chevdown")}</span></button>
  </div>`;
}

// Light Studio (the lights mockup), on lights work only.
export const mockupChip = (show) => (show ? html`<a class="cf-chip" href="#/tools/lights" data-cf-mockup><span class="cf-chip-i">${ic("lights")}</span>Mockup</a>` : "");

// A card that is one button: "Add line item" (⊕), "Add discount" (tag).
export const addRow = (label, { icon = "plusc", data = null } = {}) =>
  html`<button type="button" ${attrs({ class: "cf-card cf-row cf-add", ...dataOf(data) })}><span class="cf-ai">${ic(icon)}</span><span class="cf-t"><b>${label}</b></span></button>`;

// The lines (each a button that edits it) in one card.
// rows: [{ title, sub, cents, data }]
export function itemRows(rows) {
  if (!rows.length) return "";
  return html`<div class="cf-card cf-items">${rows.map((r) => html`<button type="button" ${attrs({ class: "cf-row", ...dataOf(r.data) })}><span class="cf-t"><b>${r.title}</b>${r.sub ? html`<small>${r.sub}</small>` : ""}</span><span class="cf-amt">${r.cents === null || r.cents === undefined ? "" : typeof r.cents === "string" ? r.cents : money(r.cents)}</span></button>`)}</div>`;
}
export const lineRowOf = (l, data) => ({ title: l.title || "Line item", sub: (l.qty_milli ?? 1000) !== 1000 ? `${qtyText(l.qty_milli)} × ${money(l.unit_cents || 0)}` : (l.unit_cents ? "" : "Tap to set the price"), cents: lineCents(l), data });

export const totalRow = (cents, { label = "Total", sub = null, data = "total" } = {}) =>
  html`<div class="cf-card cf-total" ${attrs({ "data-cf-total": data })}><span>${label}${sub ? html`<small>${sub}</small>` : ""}</span><b class="num">${money(cents || 0)}</b></div>`;

// A row with a picker on the right: "Lead source · Direct ⇅".
export const pickRow = (label, value, { data = null, chev = "updown", muted = false } = {}) =>
  html`<button type="button" ${attrs({ class: "cf-row cf-pr", ...dataOf(data) })}><span class="cf-pl">${label}</span><span ${attrs({ class: "cf-pv" + (muted ? " muted" : "") })}>${value}</span><span class="cf-ch">${ic(chev)}</span></button>`;

// A row with a switch: "Arrival window", "Notify the customer".
export const switchRow = (label, on, { data, sub = null, muted = false } = {}) =>
  html`<div ${attrs({ class: "cf-row cf-sw" + (muted ? " muted" : "") })}><span class="cf-t"><span class="cf-sl">${label}</span>${sub ? html`<small>${sub}</small>` : ""}</span>${toggle(on, { data, label })}</div>`;

// A grey pill over a native date / time input (the phone's own picker).
export const pillDate = (name, value, { label, long = false, min = null } = {}) =>
  html`<label class="cf-pill"><span aria-hidden="true">${long ? dayLong(value) : dayPill(value)}</span><input ${attrs({ type: "date", name, value: value || "", min, "aria-label": label || name, "data-cf-pill": "date", "data-long": long ? "1" : null })}></label>`;
export const pillTime = (name, value, { label } = {}) =>
  html`<label class="cf-pill"><span aria-hidden="true">${timePill(value)}</span><input ${attrs({ type: "time", name, value: value || "", step: 900, "aria-label": label || name, "data-cf-pill": "time" })}></label>`;
// A pill that is a button (Time "Anytime").
export const pillBtn = (text, { data = null, label = null } = {}) => html`<button type="button" ${attrs({ class: "cf-pill", "aria-label": label, ...dataOf(data) })}><span>${text}</span></button>`;
// The schedule card's "Starts  [date] [time]" row.
export const slotRow = (label, pills) => html`<div class="cf-row cf-slot"><span class="cf-pl">${label}</span><span class="cf-pills">${pills}</span></div>`;

export const scheduleLink = (data = { "cf-day": true }) => html`<button type="button" ${attrs({ class: "cf-link", ...dataOf(data) })}>${ic("cal")}<span>View schedule</span>${ic("chevright")}</button>`;

export const notesField = (name, value, { placeholder = "Add a note", label = "Notes" } = {}) =>
  html`${fieldLabel(label)}<textarea ${attrs({ class: "cf-notes", name, rows: 4, maxlength: 2000, placeholder, "aria-label": label })}>${value || ""}</textarea>`;

// Files picked before the record exists (uploaded right after it is made).
export const attachRow = (files, { label = "Add Attachments", data = { "cf-attach": true } } = {}) =>
  html`<button type="button" ${attrs({ class: "cf-link cf-att", ...dataOf(data) })}>${ic("attach")}<span>${label}</span></button>${files.length ? html`<ul class="cf-files">${files.map((f, i) => html`<li><span>${f.name || "Photo " + (i + 1)}</span><button type="button" ${attrs({ class: "cf-clear", "data-cf-unattach": String(i), "aria-label": "Remove " + (f.name || "this file") })}>${ic("close")}</button></li>`)}</ul>` : ""}`;

// Flyra's segmented control: an icon over each label.
export const segIcons = (items, on, { name = "cf", label = "" } = {}) =>
  html`<div class="cf-seg" role="tablist" ${attrs({ "aria-label": label })}>${items.map(([key, text, icon]) => html`<button type="button" role="tab" ${attrs({ "aria-selected": key === on ? "true" : "false", "data-cf-seg": name, "data-key": key, tabindex: key === on ? 0 : -1 })}>${ic(icon)}<span>${text}</span></button>`)}</div>`;

// The form's Create button follows what can be saved.
export function setReady(root, ready) {
  const b = root && root.querySelector("[data-cf-create]");
  if (!b) return;
  b.disabled = !ready;
  if (ready) b.removeAttribute("aria-disabled"); else b.setAttribute("aria-disabled", "true");
}

// Draws the screen again where it was scrolled (a switch near the bottom keeps its place).
export function redraw(ctx) {
  const b = typeof document !== "undefined" ? document.querySelector(".cf-body") : null;
  const y = b ? b.scrollTop : 0;
  ctx.rerender();
  const n = typeof document !== "undefined" ? document.querySelector(".cf-body") : null;
  if (n) n.scrollTop = y;
}

// A desk's mouse doesn't open a date input's picker on a click; a phone's tap does.
export const deskPointer = () => typeof matchMedia === "function" && matchMedia("(hover:hover) and (pointer:fine)").matches;

// A date / time pill's text follows its input.
export function pillChanged(el) {
  const span = el.parentElement && el.parentElement.querySelector("span");
  if (!span) return;
  span.textContent = el.dataset.cfPill === "time" ? timePill(el.value) : el.dataset.long ? dayLong(el.value) : dayPill(el.value);
}
// A tap anywhere on a pill opens the phone's picker (where the browser can).
export function openPill(el) {
  const input = el.querySelector("input");
  if (!input) return;
  try { if (typeof input.showPicker === "function") input.showPicker(); else input.focus(); } catch (e) { try { input.focus(); } catch (x) { /* gone */ } }
}

// ------------------------------------------------------------ the customer

// GET /contacts/:id → what the forms use.
export async function loadCustomer(api, id) {
  const r = await api(`/contacts/${encodeURIComponent(id)}`, { cache: false });
  const c = r.data.contact;
  return {
    id: c.id, etag: r.etag || null, name: c.display_name || [c.first_name, c.last_name].filter(Boolean).join(" ") || "Customer",
    phone: (c.phones && c.phones[0] && (c.phones[0].e164 || c.phones[0].number)) || "", source: (c.source && c.source.source) || "",
    primary: c.primary_property_id || null, properties: (r.data.properties || []).filter((p) => !p.deleted_at),
  };
}
export const primaryOf = (c, wanted = "") => (c ? (c.properties.find((p) => p.id === wanted) || c.properties.find((p) => p.id === c.primary) || c.properties[0] || null) : null);

// Lead source: the customer's own "where they came from" (PATCH /contacts/:id when it changed).
export async function saveLeadSource(api, c, source) {
  if (!c || !source || source === c.source) return;
  try {
    let etag = c.etag;
    if (!etag) etag = (await api(`/contacts/${encodeURIComponent(c.id)}`, { cache: false })).etag;
    await api(`/contacts/${encodeURIComponent(c.id)}`, { method: "PATCH", body: { source }, ifMatch: etag });
  } catch (e) { toast("Saved. The lead source didn't change: " + (e.message || "try it on the customer."), { bad: true, ms: 5000 }); }
}

function listSheet({ title, top = [], search, row, empty, placeholder = "Search" }) {
  return new Promise((resolve) => {
    let done = false, timer = null, seq = 0;
    const s = sheet({
      title, className: "cf-picker",
      body: html`<div class="picker">${search ? html`<label class="field"><span class="sr">Search</span><input type="search" ${attrs({ placeholder, autocomplete: "off", autocapitalize: "none", spellcheck: "false", enterkeyhint: "search" })} data-q></label>` : ""}
        ${top.length ? html`<ul class="list picker-list">${top.map((t) => html`<li><button type="button" class="row" ${attrs({ "data-top": t.key })}>${ic(t.icon || "plusc")}<span class="who"><span class="nm">${t.label}</span>${t.sub ? html`<span class="sub">${t.sub}</span>` : ""}</span></button></li>`)}</ul>` : ""}
        <ul class="list picker-list" data-results></ul><p class="muted small" data-empty hidden></p></div>`,
      onClose: () => { if (!done) { done = true; resolve(null); } },
      events: {
        "click [data-top]": (e, el) => { done = true; s.close(); resolve({ top: el.dataset.top }); },
        "click [data-pick]": (e, el) => { done = true; s.close(); resolve({ value: JSON.parse(el.getAttribute("data-pick")) }); },
        "input [data-q]": (e, el) => { clearTimeout(timer); timer = setTimeout(() => run(el.value), 220); },
      },
    });
    const box = s.el.querySelector("[data-results]");
    const none = s.el.querySelector("[data-empty]");
    async function run(q) {
      const my = ++seq;
      let rows = [];
      none.textContent = "";
      try { rows = await search(String(q || "").trim()); } catch (e) { rows = []; none.textContent = e.message || "That didn't load."; }
      if (my !== seq) return;
      render(box, html`${rows.map((r) => html`<li><button type="button" class="row" ${attrs({ "data-pick": JSON.stringify(r.value) })}>${row(r)}</button></li>`)}`);
      none.hidden = rows.length > 0 || !(none.textContent || empty);
      if (!rows.length && !none.textContent) none.textContent = empty || "";
    }
    run("");
    const input = s.el.querySelector("[data-q]");
    if (input) setTimeout(() => { try { input.focus(); } catch (e) { /* old Safari */ } }, 280);
  });
}

// Search contacts, or add someone new. → the customer (loadCustomer) | null
export async function pickCustomer(api, { title = "Customer", canAdd = true, lifecycle = "customer" } = {}) {
  const got = await listSheet({
    title, placeholder: "Name, phone, email or address",
    top: canAdd ? [{ key: "new", label: "New customer", sub: "Name, phone and address", icon: "plusc" }] : [],
    search: async (q) => {
      if (q.length < 2) return [];
      const r = await api(`/search?q=${encodeURIComponent(q)}`, { cache: false });
      return ((r.data && r.data.contacts) || []).map((c) => ({ value: c.id, name: c.name, sub: c.sub, address: c.address }));
    },
    row: (r) => html`${ic("person")}<span class="who"><span class="nm">${r.name}</span><span class="sub" ${addressHold(r.address)}>${r.sub || ""}</span></span>`,
    empty: "Type two letters or more of a name, phone, email or address.",
  });
  if (!got) return null;
  const id = got.top === "new" ? await newCustomer(api, { lifecycle }) : got.value;
  if (!id) return null;
  return loadCustomer(api, id);
}

// POST /contacts: a new customer with their address (it becomes their
// property); a quote's is a lead (Sales follows them up). → contact id | null
export function newCustomer(api, { lifecycle = "customer" } = {}) {
  const cid = uuid();
  let body = null;
  return new Promise((resolve) => {
    let done = false;
    const s = sheet({
      title: "New customer", className: "cf-picker",
      body: html`<form class="form" data-cf-newc novalidate>
        <div class="grid2"><label class="field" data-field="first_name"><span>First name</span><input name="first_name" autocomplete="off" maxlength="80"><small class="why" hidden></small></label>
        <label class="field" data-field="last_name"><span>Last name</span><input name="last_name" autocomplete="off" maxlength="80"><small class="why" hidden></small></label></div>
        <label class="field" data-field="phones"><span>Mobile</span><input name="phone" type="tel" inputmode="tel" autocomplete="off" placeholder="(763) 555-0100"><small class="why" hidden></small></label>
        <label class="field" data-field="emails"><span>Email</span><input name="email" type="email" inputmode="email" autocomplete="off" autocapitalize="none"><small class="why" hidden></small></label>
        <label class="field" data-field="billing_address"><span>Street address</span><input name="street1" autocomplete="off" maxlength="120"><small class="why" hidden></small></label>
        <div class="grid2"><label class="field"><span>Town</span><input name="city" autocomplete="off" maxlength="80"></label><label class="field"><span>ZIP</span><input name="zip" inputmode="numeric" maxlength="10"></label></div>
        <p class="err" data-ncerr hidden></p><div class="btn-row" data-dup hidden></div>
        <button type="submit" class="rs-done cf-wide">Add the customer</button>
      </form>`,
      onClose: () => { if (!done) { done = true; resolve(null); } },
      events: {
        "click [data-use]": (e, el) => { done = true; s.close(); resolve(el.dataset.use); },
        "click [data-force]": (e, el) => { const form = el.closest("form"); form.querySelector("[type=submit]").disabled = true; send(form, true); },
        "submit [data-cf-newc]": async (e, form) => {
          e.preventDefault();
          const f = form.elements;
          const err = form.querySelector("[data-ncerr]");
          const v = (k) => String(f[k].value || "").trim();
          if (!v("first_name") && !v("last_name")) { err.textContent = "Add their name."; err.hidden = false; return; }
          body = { client_id: cid, first_name: v("first_name"), last_name: v("last_name"), lifecycle: lifecycle === "lead" ? "lead" : "customer", ...(v("phone") ? { phone: v("phone") } : {}), ...(v("email") ? { email: v("email") } : {}),
            ...(v("street1") ? { address: { street1: v("street1"), city: v("city"), state: "MN", zip: v("zip"), country: "US" } } : {}) };
          form.querySelector("[type=submit]").disabled = true;
          await send(form, false);
        },
      },
    });
    async function send(form, force) {
      const err = form.querySelector("[data-ncerr]");
      const btn = form.querySelector("[type=submit]");
      try {
        const r = await api("/contacts", { method: "POST", body: { ...body, ...(force ? { force: true } : {}) } });
        done = true; s.close(); resolve(r.data.contact.id);
      } catch (x) {
        btn.disabled = false;
        if (x.code === "possible_duplicate" && x.details && x.details.matches && x.details.matches.length) {
          const m = x.details.matches[0];
          err.textContent = `${m.name || "Someone"} is already on file with this ${m.reason === "phone" ? "phone" : m.reason === "email" ? "email" : "name"}.`;
          err.hidden = false;
          const box = form.querySelector("[data-dup]");
          render(box, html`<button type="button" class="btn" ${attrs({ "data-use": m.id })}>Use ${m.name || "them"}</button><button type="button" class="btn" data-force>Add anyway</button>`);
          box.hidden = false;
          return;
        }
        err.textContent = x.message || "That didn't save."; err.hidden = false;
      }
    }
  });
}

// Which of their places. → property | null (a new one is added first)
export async function pickProperty(api, c, currentId) {
  if (!c) return null;
  const got = await listSheet({
    title: "Property", top: [{ key: "new", label: "Add a property", sub: "A new address for " + c.name, icon: "plusc" }],
    search: async () => c.properties.map((p) => { const a = addrOf(p); return { value: p.id, name: a.line1, sub: [a.line2, p.id === currentId ? "picked" : ""].filter(Boolean).join(" · ") }; }),
    row: (r) => html`${ic("house")}<span class="who"><span class="nm">${r.name}</span><span class="sub">${r.sub || ""}</span></span>`,
    empty: "No address on file yet.",
  });
  if (!got) return null;
  if (got.top !== "new") return c.properties.find((p) => p.id === got.value) || null;
  const p = await newProperty(api, c);
  if (p) c.properties.push(p);
  return p;
}

function newProperty(api, c) {
  const cid = uuid();
  return new Promise((resolve) => {
    let done = false;
    const s = sheet({
      title: "Add a property", className: "cf-picker",
      body: html`<form class="form" data-cf-newp novalidate>
        <label class="field"><span>Street address</span><input name="street1" autocomplete="off" maxlength="120"></label>
        <div class="grid2"><label class="field"><span>Town</span><input name="city" autocomplete="off" maxlength="80"></label><label class="field"><span>ZIP</span><input name="zip" inputmode="numeric" maxlength="10"></label></div>
        <p class="err" data-nperr hidden></p>
        <button type="submit" class="rs-done cf-wide">Add the property</button></form>`,
      onClose: () => { if (!done) { done = true; resolve(null); } },
      events: {
        "submit [data-cf-newp]": async (e, form) => {
          e.preventDefault();
          const f = form.elements;
          const err = form.querySelector("[data-nperr]");
          const street1 = String(f.street1.value || "").trim();
          if (!street1) { err.textContent = "Add the street address."; err.hidden = false; return; }
          try {
            const r = await api(`/contacts/${encodeURIComponent(c.id)}/properties`, { method: "POST", body: { client_id: cid, address: { street1, city: String(f.city.value || "").trim(), state: "MN", zip: String(f.zip.value || "").trim(), country: "US" } } });
            done = true; s.close(); resolve(r.data.property);
          } catch (x) { err.textContent = x.message || "That didn't save."; err.hidden = false; }
        },
      },
    });
  });
}

// ------------------------------------------------------------ lines

// "Add line item": the price book, a custom line, and any extra choices
// (New quote's "Measure and price"). → { item } | { key } | null
export async function pickItem({ book = [], extra = [] } = {}) {
  const items = book.filter((x) => x.active !== false && x.sellable !== false);
  const got = await listSheet({
    title: "Add line item", placeholder: "Search the price book",
    top: [...extra, { key: "custom", label: "Custom line item", sub: "Type the name and price", icon: "pencil" }],
    search: async (q) => { const w = q.toLowerCase(); return items.filter((x) => !w || String(x.name).toLowerCase().includes(w)).slice(0, 60).map((x) => ({ value: x.id, name: x.name, sub: x.unit_cents ? `${money(x.unit_cents)}${x.unit && x.unit !== "flat" ? ` a ${x.unit}` : ""}` : "Priced by hand" })); },
    row: (r) => html`${ic("book")}<span class="who"><span class="nm">${r.name}</span><span class="sub">${r.sub}</span></span>`,
    empty: items.length ? "Nothing matches." : "The price book is empty.",
  });
  if (!got) return null;
  if (got.top) return { key: got.top };
  const it = items.find((x) => x.id === got.value);
  return it ? { item: it } : null;
}
export const lineFromItem = (it) => ({ price_item_id: it.id, title: it.name, description: it.description || "", qty_milli: 1000, unit_cents: it.unit_cents || 0, unit: it.unit || "flat", category: it.category, service_type: it.service_type || undefined });

const SERVICE_TYPES = ["Residential Window Cleaning", "Exterior Cleaning", "Christmas Lights"];

// One line: name, quantity, price, the kind of service. → line | "remove" | null
export function lineSheet(line = null, { locked = false } = {}) {
  const l = line || { title: "", qty_milli: 1000, unit_cents: 0 };
  return new Promise((resolve) => {
    let done = false;
    const s = sheet({
      title: line && line.title ? "Line item" : "New line item", className: "cf-picker",
      body: html`<form class="form" data-cf-line novalidate>
        <label class="field" data-field="title"><span>Name</span><input ${attrs({ name: "title", value: l.title || "", maxlength: 160, placeholder: "Exterior window cleaning" })}><small class="why" hidden></small></label>
        <div class="grid2"><label class="field"><span>Quantity</span><input ${attrs({ name: "qty", inputmode: "decimal", value: qtyText(l.qty_milli) })}></label>
        <label class="field" data-field="unit"><span>Price each</span><input ${attrs({ name: "unit", inputmode: "decimal", value: l.unit_cents ? (l.unit_cents / 100).toFixed(2) : "", placeholder: "0.00", disabled: locked })}><small class="why" hidden></small></label></div>
        <label class="field"><span>Kind of work</span><select name="service_type">${["", ...SERVICE_TYPES].map((t) => html`<option ${attrs({ value: t, selected: (l.service_type || "") === t })}>${t || "Not set"}</option>`)}</select></label>
        <div class="btn-row">${line ? html`<button type="button" class="btn danger" data-cf-remove>Remove</button>` : ""}<button type="submit" class="rs-done">Done</button></div>
      </form>`,
      onClose: () => { if (!done) { done = true; resolve(null); } },
      events: {
        "click [data-cf-remove]": () => { done = true; s.close(); resolve("remove"); },
        "submit [data-cf-line]": (e, form) => {
          e.preventDefault();
          const f = form.elements;
          const say = (k, m) => { const w = form.querySelector(`[data-field="${k}"] .why`); w.textContent = m; w.hidden = false; };
          const title = String(f.title.value || "").trim();
          if (!title) { say("title", "Name the work."); return; }
          const q = Number(String(f.qty.value || "1").replace(/,/g, ""));
          const unit = locked ? l.unit_cents : moneyIn(f.unit.value);
          if (unit === null) { say("unit", "Use a price like 295.00."); return; }
          done = true; s.close();
          resolve({ ...l, title, qty_milli: Number.isFinite(q) && q >= 0 ? Math.round(q * 1000) : 1000, unit_cents: unit, service_type: f.service_type.value || undefined });
        },
      },
    });
    setTimeout(() => { const i = s.el.querySelector(l.title ? "[name=unit]" : "[name=title]"); try { if (i && !i.disabled) i.focus(); } catch (x) { /* old Safari */ } }, 280);
  });
}
export function moneyIn(text) {
  const t = String(text ?? "").replace(/[$,\s]/g, "");
  if (t === "") return 0;
  if (!/^\d+(\.\d{0,2})?$/.test(t)) return null;
  const [d, c = ""] = t.split(".");
  return Number(d) * 100 + Number((c + "00").slice(0, 2));
}

// "Add discount": the catalog's, or a typed amount or percent. defs: the
// discount catalog ([{ id, name, type, value, typed_amount }]). → discount | "remove" | null
export async function discountSheet(defs = [], current = null) {
  let d = current;
  if (!d) {
    const got = await listSheet({
      title: "Add discount", top: [{ key: "fixed", label: "An amount off", sub: "Type the dollars", icon: "tag" }, { key: "percentage", label: "A percent off", sub: "Type the percent", icon: "tag" }],
      search: async () => defs.map((x) => ({ value: x.id, name: x.name, sub: x.typed_amount ? "Type the amount" : x.type === "percentage" ? `${x.value / 100}% off` : `${money(x.value)} off` })),
      row: (r) => html`${ic("tag")}<span class="who"><span class="nm">${r.name}</span><span class="sub">${r.sub}</span></span>`,
      empty: "",
    });
    if (!got) return null;
    if (got.top) d = { name: "", type: got.top, value: 0, typed: true };
    else {
      const def = defs.find((x) => x.id === got.value);
      if (!def) return null;
      d = { def_id: def.id, key: def.key, name: def.name, type: def.type, value: def.value || 0, ...(def.stack_group ? { stack_group: def.stack_group } : {}), ...(def.default_scope ? { scope: def.default_scope } : {}), typed: !!def.typed_amount };
      if (!d.typed) return d;
    }
  }
  return new Promise((resolve) => {
    let done = false;
    const pct = d.type === "percentage";
    const s = sheet({
      title: d.name || (pct ? "A percent off" : "An amount off"), className: "cf-picker",
      body: html`<form class="form" data-cf-disc novalidate>
        ${d.def_id ? "" : html`<label class="field"><span>Name (optional)</span><input ${attrs({ name: "name", value: d.name || "", maxlength: 120, placeholder: "Neighbor deal" })}></label>`}
        <label class="field" data-field="value"><span>${pct ? "Percent off" : "Amount off"}</span><input ${attrs({ name: "value", inputmode: "decimal", value: d.value ? (pct ? String(d.value / 100) : (d.value / 100).toFixed(2)) : "", placeholder: pct ? "10" : "25.00" })}><small class="why" hidden></small></label>
        <div class="btn-row">${current ? html`<button type="button" class="btn danger" data-cf-remove>Remove</button>` : ""}<button type="submit" class="rs-done">Done</button></div>
      </form>`,
      onClose: () => { if (!done) { done = true; resolve(null); } },
      events: {
        "click [data-cf-remove]": () => { done = true; s.close(); resolve("remove"); },
        "submit [data-cf-disc]": (e, form) => {
          e.preventDefault();
          const f = form.elements;
          const raw = String(f.value.value || "").trim();
          const v = pct ? Math.round(Number(raw) * 100) : moneyIn(raw);
          if (!Number.isFinite(v) || v === null || v <= 0 || (pct && v > 10000)) { const w = form.querySelector('[data-field="value"] .why'); w.textContent = pct ? "A percent from 0.01 to 100." : "An amount over $0."; w.hidden = false; return; }
          const { typed, ...rest } = d;
          done = true; s.close();
          const nameIn = form.querySelector("[name=name]");
          resolve({ ...rest, ...(nameIn ? { name: String(nameIn.value || "").trim() || "Discount" } : {}), value: v });
        },
      },
    });
  });
}

// One or a few of a short list (Lead source, Frequency, Repeats...). → value | null
export async function pickOne({ title, items, current = null }) {
  const got = await listSheet({
    title,
    search: async () => items.map((i) => ({ value: i.value, name: i.label, sub: [i.sub, i.value === current ? "picked" : ""].filter(Boolean).join(" · ") })),
    row: (r) => html`<span class="who"><span class="nm">${r.name}</span>${r.sub ? html`<span class="sub">${r.sub}</span>` : ""}</span>`,
    empty: "Nothing to pick.",
  });
  return got ? got.value : null;
}

// Several of a list (Dispatched to). → [values] | null
export function pickMany({ title, items, picked = [], none = "Nobody yet" }) {
  return new Promise((resolve) => {
    let done = false;
    const on = new Set(picked);
    const draw = () => html`<ul class="list picker-list">${items.map((i) => html`<li><button type="button" class="row" ${attrs({ "data-many": i.value, "aria-pressed": on.has(i.value) ? "true" : "false" })}><span class="cf-dot" ${attrs({ style: i.color ? `background:${i.color}` : null })}></span><span class="who"><span class="nm">${i.label}</span>${i.sub ? html`<span class="sub">${i.sub}</span>` : ""}</span><span class="cf-tick" aria-hidden="true">${on.has(i.value) ? "✓" : ""}</span></button></li>`)}</ul>
      <p class="muted small">${on.size ? "" : none}</p><button type="button" class="rs-done cf-wide" data-many-done>Done</button>`;
    const s = sheet({
      title, className: "cf-picker", body: draw(),
      onClose: () => { if (!done) { done = true; resolve(null); } },
      events: {
        "click [data-many]": (e, el) => { const v = el.dataset.many; if (on.has(v)) on.delete(v); else on.add(v); s.set(draw()); },
        "click [data-many-done]": () => { done = true; s.close(); resolve(items.map((i) => i.value).filter((v) => on.has(v))); },
      },
    });
  });
}

// "View schedule ›": that day's visits and what the slot runs into (GET
// /schedule, /schedule/check), without leaving the form.
export function daySheet(api, { date, start, end, users = [] } = {}) {
  const s = sheet({ title: dateShort(date) || "The day", className: "cf-picker", body: html`<div class="skel" aria-busy="true" aria-label="Loading"><span class="sk w90"></span><span class="sk w70"></span></div>` });
  (async () => {
    try {
      const [r, chk] = await Promise.all([
        api(`/schedule?from=${encodeURIComponent(date)}&to=${encodeURIComponent(date)}`, { cache: false }),
        start && end ? api(`/schedule/check?date=${encodeURIComponent(date)}&start=${encodeURIComponent(start)}&end=${encodeURIComponent(end)}&users=${encodeURIComponent(users.join(","))}`, { cache: false }).catch(() => null) : null,
      ]);
      const vs = ((r.data && r.data.visits) || []).map((v) => ({ s: v.s || v.start, e: v.e || v.end, who: v.cn || v.contact_name || "A visit", town: v.town || "", what: v.t || v.job_title || "", st: v.st || v.status }))
        .filter((v) => v.st !== "cancelled").sort((a, b) => String(a.s).localeCompare(String(b.s)));
      const warns = (chk && chk.data && chk.data.warnings) || [];
      s.set(html`${warns.length ? html`<ul class="cf-warn">${warns.map((w) => html`<li>${w.message || w}</li>`)}</ul>` : start ? html`<p class="cf-ok">${clock(start)} to ${clock(end)} is free for who goes.</p>` : ""}
        ${vs.length ? html`<ul class="list cf-day">${vs.map((v) => html`<li class="row"><span class="cf-dt num">${clock(v.s)}</span><span class="who"><span class="nm">${v.who}</span><span class="sub">${[v.what, v.town].filter(Boolean).join(" · ")}</span></span></li>`)}</ul>` : html`<p class="muted">Nothing booked that day.</p>`}
        <a class="btn block" ${attrs({ href: `#/schedule?view=day&date=${date}` })} data-cf-openday>Open the day</a>`);
      const a = s.el.querySelector("[data-cf-openday]");
      if (a) a.addEventListener("click", () => s.close());
    } catch (e) { s.set(html`<p class="muted">${e.message || "That didn't load."}</p>`); }
  })();
  return s;
}

// Files picked on the form (a camera or the library), kept until the record exists.
export function pickFiles({ accept = "image/*,application/pdf", multiple = true } = {}) {
  return new Promise((resolve) => {
    const input = document.createElement("input");
    input.type = "file"; input.accept = accept; input.multiple = multiple; input.hidden = true;
    document.body.appendChild(input);
    input.addEventListener("change", () => { const files = [...(input.files || [])].slice(0, 10); input.remove(); resolve(files); }, { once: true });
    input.click();
  });
}
