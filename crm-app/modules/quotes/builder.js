// The quote builder (design §9.2 "Quote builder"), phone first:
//   who and where → measure (the pane counter with Barta's weights, or By
//   square feet for a phone quote: "confirm panes on site") → services →
//   Price it (the engine's lines, with tier labels; a plan option beside
//   the one-time one, Quarterly by default) → the options (up to 3; one
//   Recommended; lines from the price book or typed, a price override with
//   its reason, which visits a line or discount applies to, add-ons the
//   customer can tick, discounts from the catalog) → notes, photos and
//   mockups → Save. Totals per visit, per year and for the term update as
//   you type (the server recomputes everything on save). Deposits and
//   "require card" appear once Money (M5) is there (§11.3).

import { html, attrs, icon, sheet, toast, confirmSheet, render } from "../../core/ui.js";
import { busy, readMoney } from "../../core/forms.js";
import { pickContact, pickFrom } from "../../core/pickers.js";
import { money, phone } from "../../core/format.js";
import { uuid } from "../../core/api.js";
import { capture, uploadPhoto } from "../../core/camera.js";
import {
  ensureStyles, WINDOW_TYPES, SERVICES, PLAN_NAMES, PLAN_FREQ, BILLING, warningText, scopeWords, parseVisits, qtyText, toMilli, lineTotal,
  optionTotals, discountText, visitsOf,
} from "./kit.js";

const PLAN_KEYS = ["biannual", "quarterly", "monthly", "lights_annual", "custom"];
const CATALOG = {
  biannual: { frequency: { interval: "month", count: 6 }, visits_per_year: 2 }, quarterly: { frequency: { interval: "month", count: 3 }, visits_per_year: 4 },
  monthly: { frequency: { interval: "month", count: 1 }, visits_per_year: 12 }, lights_annual: { frequency: { interval: "year", count: 1 }, visits_per_year: 1 },
  custom: { frequency: { interval: "month", count: 6 }, visits_per_year: 2 },
};
const clone = (v) => JSON.parse(JSON.stringify(v));
const tmpId = (p) => `${p}_${uuid().replace(/[^0-9a-f]/g, "").slice(0, 12)}`;

async function load(params, ctx) {
  ensureStyles();
  const cx = (await ctx.api("/pricing/context", { cache: false })).data;
  const base = {
    cx, tab: 0, warnings: [], saving: false,
    measure: { mode: "panes", windows: Object.fromEntries(WINDOW_TYPES.map(([k]) => [k, 0])), sqft: "", panes_int: "" },
    services: { windows_ext: true }, counts: {}, plan: "quarterly",
  };
  if (params.id && params.id !== "new") {
    const r = await ctx.api(`/quotes/${encodeURIComponent(params.id)}`, { cache: false });
    const q = r.data.quote;
    const m = q.measure || {};
    return {
      ...base, isNew: false, id: q.id, etag: r.etag, status: q.status, number: q.number_label, contact: { id: q.contact_id, name: (r.data.contact && r.data.contact.name) || q.contact_name },
      properties: r.data.properties || [], property_id: q.property_id || "", options: clone(q.options || []), client_notes: q.client_notes || "", internal_notes: q.internal_notes || "",
      agreement: q.agreement || { require_card: false, deposit: { type: "none", value: 0 } }, photo_ids: q.photo_ids || [], mockup_file_ids: q.mockup_file_ids || [],
      measure: { ...base.measure, ...(m.windows ? { windows: { ...base.measure.windows, ...m.windows } } : {}), mode: m.mode === "sqft" ? "sqft" : "panes", sqft: m.sqft ? String(m.sqft) : "", panes_int: m.panes_int ? String(m.panes_int) : "" },
      services: m.services || base.services, counts: m.counts || {}, plan: m.plan !== undefined ? m.plan : base.plan,
    };
  }
  const s = { ...base, isNew: true, contact: null, properties: [], property_id: "", options: [], client_notes: "", internal_notes: "", agreement: { require_card: false, deposit: { type: "none", value: 0 } }, photo_ids: [], mockup_file_ids: [] };
  if (params.contact) await setContact(s, ctx, params.contact);
  return s;
}

async function setContact(s, ctx, id) {
  const r = await ctx.api(`/contacts/${encodeURIComponent(id)}`, { cache: false });
  const c = r.data.contact;
  s.contact = { id: c.id, name: c.display_name || [c.first_name, c.last_name].filter(Boolean).join(" ") || "Contact", phone: (c.phones && c.phones[0] && c.phones[0].e164) || "" };
  s.properties = (r.data.properties || []).map((p) => ({ id: p.id, label: p.label, address: [p.address && p.address.street1, p.address && p.address.city].filter(Boolean).join(", "), assets: p.assets || {} }));
  const prop = s.properties.find((p) => p.id === c.primary_property_id) || s.properties[0];
  s.property_id = prop ? prop.id : "";
  if (prop && prop.assets) {
    if (prop.assets.sqft) { s.measure.mode = "sqft"; s.measure.sqft = String(prop.assets.sqft); }
    if (prop.assets.panes_ext) { s.measure.mode = "panes"; s.measure.windows = { ...s.measure.windows, standard: prop.assets.panes_ext }; }
  }
}

// ------------------------------------------------------------ measuring

const weights = (s) => (s.cx.pricing && s.cx.pricing.pane_weights) || {};
function panesOf(s) {
  const w = weights(s);
  let milli = 0;
  for (const [k, n] of Object.entries(s.measure.windows)) milli += Math.round((w[k] ?? 1) * 1000) * (Number(n) || 0);
  return Math.ceil(milli / 1000);
}
function sqftTier(s) {
  const n = Number(s.measure.sqft);
  if (!s.measure.sqft || !Number.isFinite(n) || n < 0) return null;
  const tiers = [...((s.cx.pricing && s.cx.pricing.sqft_tiers) || [])].sort((a, b) => a.max_sqft - b.max_sqft);
  const i = tiers.findIndex((t) => Math.ceil(n) <= t.max_sqft);
  if (i < 0) return { manual: true };
  return { panes: tiers[i].max_panes, label: `Up to ${tiers[i].max_panes} panes (${i === 0 ? 0 : tiers[i - 1].max_sqft + 1} to ${tiers[i].max_sqft} sq ft)` };
}

function measureCard(s) {
  const m = s.measure;
  const t = sqftTier(s);
  return html`<section class="card"><h2>Measure</h2>
    <div class="qb-seg" role="group" aria-label="How to measure">
      <button type="button" ${attrs({ "data-mode": "panes", "aria-pressed": String(m.mode === "panes") })}>Count panes</button>
      <button type="button" ${attrs({ "data-mode": "sqft", "aria-pressed": String(m.mode === "sqft") })}>By square feet</button>
    </div>
    ${m.mode === "panes" ? html`<div>${WINDOW_TYPES.map(([k, label]) => html`<div class="qb-count"><span class="lb">${label.replace(/ \(.*\)$/, "")}${/\(/.test(label) ? html`<small>${label.match(/\((.*)\)/)[1] === "free" ? "free" : `counts × ${label.match(/\((.*)\)/)[1]}`}</small>` : ""}</span>
        <span class="qb-step"><button type="button" ${attrs({ "data-dec": k, "aria-label": `One fewer ${label}` })}>−</button><input ${attrs({ type: "number", inputmode: "numeric", min: 0, max: 999, "data-win": k, value: m.windows[k] || 0, "aria-label": label })}><button type="button" ${attrs({ "data-inc": k, "aria-label": `One more ${label}` })}>+</button></span></div>`)}</div>
      <div class="qb-total"><span>Exterior panes</span><b data-panes>${panesOf(s)}</b></div>`
    : html`<label class="field"><span>Square feet of the house</span><input ${attrs({ type: "number", inputmode: "numeric", min: 0, name: "sqft", value: m.sqft, placeholder: "e.g. 3200" })} data-sqft></label>
      <p class="small" data-tier>${t ? (t.manual ? "Over 7,999 sq ft: price it by hand." : `${t.label}. Confirm the panes on site.`) : "Phone quotes: the tier comes from the square feet."}</p>`}
    <label class="field"><span>Interior panes (if different)</span><input ${attrs({ type: "number", inputmode: "numeric", min: 0, name: "panes_int", value: m.panes_int, placeholder: "Same as outside" })} data-panes-int></label>
  </section>`;
}

function servicesCard(s) {
  const c = s.counts;
  const count = (k, ph) => (s.services[k] ? html`<input ${attrs({ type: k === "gutters" ? "text" : "number", inputmode: k === "gutters" ? "decimal" : "numeric", min: 0, "data-count": k, value: c[k] || "", placeholder: ph, "aria-label": `${k} count` })}>` : "");
  return html`<section class="card"><h2>Services</h2>
    <div class="qb-svc">${SERVICES.map(([k, label]) => html`<label class="check"><input ${attrs({ type: "checkbox", "data-svc": k, checked: !!s.services[k] })}><span>${label}</span>${k === "screens" ? count(k, "est.") : k === "tracks_standard" || k === "tracks_premium" ? count(k, "how many") : k === "gutters" ? count(k, "$ price") : ""}</label>`)}</div>
    <div class="section-h" style="margin:14px 0 6px">Also offer a plan</div>
    <div class="qb-seg qb-plans" role="group" aria-label="Plan">${[["", "No plan"], ["biannual", "Biannual"], ["quarterly", "Quarterly"], ["monthly", "Monthly"]].map(([k, label]) => html`<button type="button" ${attrs({ "data-plan": k, "aria-pressed": String(s.plan === k) })}>${label}</button>`)}</div>
    <button type="button" class="btn primary block" data-price>${icon("bolt")}Price it</button>
    ${s.warnings.length ? html`<ul class="qb-warn">${s.warnings.map((w) => html`<li class="warn-box">${warningText(w)}</li>`)}</ul>` : ""}
    ${!s.isNew ? html`<a class="btn block" style="margin-top:8px" href="${"#/quotes/" + encodeURIComponent(s.id) + "/lights"}">${icon("sun")}Christmas lights quote</a>` : html`<button type="button" class="btn block" style="margin-top:8px" data-lights>${icon("sun")}Christmas lights quote</button>`}
  </section>`;
}

// ------------------------------------------------------------ options

const floor = (s) => (s.cx.pricing && s.cx.pricing.discount_floor_cents) || 0;
function totalsBox(s, o) {
  const t = optionTotals(o, floor(s));
  const v = visitsOf(o);
  const flat = new Set(t.per_visit_cents).size <= 1;
  return html`<div class="qb-sum" data-totals>
    ${o.kind === "plan" ? html`<span>${flat ? "Each visit" : "First visit"}</span><b class="big">${money(t.first_cents)}</b>
      ${flat ? "" : html`<span>Visits</span><b>${t.per_visit_cents.slice(0, v.year).map((c) => money(c)).join(" · ")}</b>`}
      <span>A year (${v.year} visit${v.year === 1 ? "" : "s"})</span><b>${money(t.annual_cents)}</b>
      ${v.term !== v.year ? html`<span>The term (${v.term} visits)</span><b>${money(t.term_cents)}</b>` : ""}`
    : html`<span>Total</span><b class="big">${money(t.first_cents)}</b>`}
  </div>`;
}

function planFields(s, o) {
  const p = o.plan || {};
  return html`<div class="grid2">
    <label class="field"><span>Plan</span><select data-o="catalog_key">${PLAN_KEYS.map((k) => html`<option ${attrs({ value: k, selected: p.catalog_key === k })}>${PLAN_NAMES[k]}</option>`)}</select></label>
    <label class="field"><span>Term</span><select data-o="term_months">${[12, 24, 36, 48, 60].map((n) => html`<option ${attrs({ value: n, selected: (p.term_months || 12) === n })}>${n} months</option>`)}</select></label>
  </div>
  ${p.catalog_key === "custom" ? html`<label class="field"><span>Visits a year</span><input ${attrs({ type: "number", inputmode: "numeric", min: 1, max: 52, "data-o": "visits_per_year", value: p.visits_per_year || 2 })}></label>` : html`<p class="small muted">${PLAN_FREQ[p.catalog_key] || ""}</p>`}
  <label class="field"><span>Billing</span><select data-o="billing">${BILLING.map((b) => html`<option ${attrs({ value: b.value, selected: (p.billing || "barta_standard") === b.value })}>${b.label}</option>`)}</select></label>`;
}

function optionEditor(s) {
  const o = s.options[s.tab];
  if (!o) return html`<p class="muted">Price it above, or add an option.</p>`;
  return html`<div data-option-editor>
    <label class="field"><span>Name the customer sees</span><input ${attrs({ "data-o": "name", value: o.name || "", maxlength: 60 })}></label>
    <div class="qb-seg" role="group" aria-label="Kind"><button type="button" ${attrs({ "data-kind": "one_time", "aria-pressed": String(o.kind !== "plan") })}>One-time</button><button type="button" ${attrs({ "data-kind": "plan", "aria-pressed": String(o.kind === "plan") })}>Plan</button></div>
    <label class="check"><input ${attrs({ type: "checkbox", "data-o": "recommended", checked: !!o.recommended })}><span>Recommended (shown first and picked for them)</span></label>
    ${o.kind === "plan" ? planFields(s, o) : ""}
    <ul class="qb-lines">${(o.lines || []).map((l, i) => html`<li><button type="button" class="ln" ${attrs({ "data-line": i })}><span class="t">${l.title}${l.optional ? html`<small>Add-on the customer can tick${l.selected ? " (ticked)" : ""}</small>` : ""}${l.scope && l.scope.type !== "all" ? html`<small>${scopeWords(l.scope)}</small>` : ""}${l.tier ? html`<small>${l.tier}</small>` : ""}${l.override ? html`<small class="ov">Price changed: ${l.override.reason}</small>` : ""}${l.unit && l.unit !== "flat" ? html`<small>${qtyText(l.qty_milli)} × ${money(l.unit_cents)}</small>` : ""}</span><span class="p">${money(lineTotal(l))}</span></button></li>`)}
      ${(o.discounts || []).map((d, i) => html`<li class="d"><button type="button" class="ln" ${attrs({ "data-disc": i })}><span class="t">${d.name}<small>${scopeWords(d.scope)}</small></span><span class="p">${discountText(d)}</span></button></li>`)}</ul>
    <div class="qb-add"><button type="button" class="btn" data-add-item>${icon("list")}Price book</button><button type="button" class="btn" data-add-line>${icon("plus")}Custom line</button><button type="button" class="btn" data-add-disc>${icon("money")}Discount</button></div>
    <div data-totals-wrap>${totalsBox(s, o)}</div>
    ${s.options.length > 1 ? html`<button type="button" class="linkish" style="margin-top:8px" data-remove-option>Remove this option</button>` : ""}
  </div>`;
}

function optionsCard(s) {
  return html`<section class="card"><h2><span class="sp">Options</span>${s.options.length < 3 ? html`<button type="button" class="btn" data-add-option>${icon("plus")}Option</button>` : ""}</h2>
    ${s.options.length ? html`<div class="qb-tabs" role="tablist">${s.options.map((o, i) => html`<button type="button" class="chip" ${attrs({ "data-tab": i, "aria-pressed": String(s.tab === i) })}>${o.name || `Option ${i + 1}`}${o.recommended ? " ★" : ""}</button>`)}</div>` : ""}
    ${optionEditor(s)}
  </section>`;
}

function extrasCard(s) {
  const dep = s.cx.features && s.cx.features.deposits;
  return html`<section class="card"><h2>Notes</h2>
    <label class="field"><span>Note to the customer (on the quote)</span><textarea data-f="client_notes" rows="3" maxlength="4000">${s.client_notes}</textarea></label>
    <label class="field"><span>Office note (only us)</span><textarea data-f="internal_notes" rows="2" maxlength="4000">${s.internal_notes}</textarea></label>
  </section>
  ${dep ? html`<section class="card"><h2>Card and deposit</h2>
    <label class="check"><input ${attrs({ type: "checkbox", "data-ag": "require_card", checked: !!s.agreement.require_card })}><span>Card on file when they approve</span></label>
    <div class="grid2"><label class="field"><span>Deposit</span><select data-ag="deposit_type">${[["none", "None"], ["fixed", "Amount"], ["percent", "Percent"]].map(([v, l]) => html`<option ${attrs({ value: v, selected: s.agreement.deposit.type === v })}>${l}</option>`)}</select></label>
    <label class="field"><span>Deposit value</span><input ${attrs({ "data-ag": "deposit_value", inputmode: "decimal", value: s.agreement.deposit.type === "fixed" ? (s.agreement.deposit.value / 100).toFixed(2) : s.agreement.deposit.type === "percent" ? String(s.agreement.deposit.value / 100) : "" })}></label></div>
  </section>` : ""}
  ${!s.isNew ? html`<section class="card"><h2>Photos and mockups</h2>
    ${[...s.mockup_file_ids, ...s.photo_ids].length ? html`<div class="qb-photos">${[...s.mockup_file_ids, ...s.photo_ids].map((id) => html`<img ${attrs({ src: `/api/crm/files/${encodeURIComponent(id)}?thumb=1`, alt: "A photo on this quote", loading: "lazy" })}>`)}</div>` : html`<p class="small muted">The customer sees these on the quote.</p>`}
    <div class="qb-add"><button type="button" class="btn" data-photo="photo">${icon("phone")}Add a photo</button><button type="button" class="btn" data-photo="mockup">${icon("sun")}Add a mockup</button></div>
  </section>` : ""}`;
}

function whoCard(s) {
  return html`<section class="card"><h2>Who and where</h2>
    ${s.contact ? html`<div class="row" style="padding:0"><span class="who"><span class="nm">${s.contact.name}</span>${s.contact.phone ? html`<span class="sub">${phone(s.contact.phone)}</span>` : ""}</span>${s.isNew ? html`<button type="button" class="btn" data-pick>Change</button>` : ""}</div>`
      : html`<button type="button" class="btn primary block" data-pick>${icon("contacts")}Pick who it's for</button>`}
    ${s.properties.length ? html`<label class="field"><span>Property</span><select data-f="property_id"><option value="">No property</option>${s.properties.map((p) => html`<option ${attrs({ value: p.id, selected: p.id === s.property_id })}>${p.label}: ${p.address}</option>`)}</select></label>` : ""}
  </section>`;
}

export default {
  title: (s) => (s && !s.isNew ? `Edit ${s.number}` : "New quote"),
  load,
  render(s) {
    if (s.status && ["approved", "converted"].includes(s.status)) return html`<div class="stack"><div class="card empty"><h2>This quote is approved</h2><p>An approved quote doesn't change. Duplicate it to make a new one.</p></div></div>`;
    return html`<div class="qb">
      ${whoCard(s)}${measureCard(s)}${servicesCard(s)}${optionsCard(s)}${extrasCard(s)}
      <div class="qb-bar"><button type="button" class="btn primary" data-save>${s.isNew ? "Save quote" : "Save"}</button></div>
    </div>`;
  },
  events: {
    "click [data-pick]": async (e, el, ctx) => { const c = await pickContact(ctx.api, { title: "Who is it for?" }); if (!c) return; await setContact(ctx.state, ctx, c.id); ctx.rerender(); },
    "click [data-mode]": (e, el, ctx) => { ctx.state.measure.mode = el.dataset.mode; ctx.rerender(); },
    "click [data-inc]": (e, el, ctx) => step(ctx, el.dataset.inc, 1),
    "click [data-dec]": (e, el, ctx) => step(ctx, el.dataset.dec, -1),
    "input [data-win]": (e, el, ctx) => { ctx.state.measure.windows[el.dataset.win] = Math.max(0, Math.min(999, parseInt(el.value, 10) || 0)); paintPanes(ctx); },
    "input [data-sqft]": (e, el, ctx) => {
      ctx.state.measure.sqft = el.value;
      const t = sqftTier(ctx.state);
      const p = document.querySelector("[data-tier]");
      if (p) p.textContent = t ? (t.manual ? "Over 7,999 sq ft: price it by hand." : `${t.label}. Confirm the panes on site.`) : "Phone quotes: the tier comes from the square feet.";
    },
    "input [data-panes-int]": (e, el, ctx) => { ctx.state.measure.panes_int = el.value; },
    "change [data-svc]": (e, el, ctx) => { ctx.state.services[el.dataset.svc] = el.checked; ctx.rerender(); },
    "input [data-count]": (e, el, ctx) => { ctx.state.counts[el.dataset.count] = el.value; },
    "click [data-plan]": (e, el, ctx) => { ctx.state.plan = el.dataset.plan; ctx.rerender(); },
    "click [data-price]": (e, el, ctx) => priceIt(el, ctx),
    "click [data-tab]": (e, el, ctx) => { ctx.state.tab = Number(el.dataset.tab); ctx.rerender(); },
    "click [data-add-option]": (e, el, ctx) => {
      const s = ctx.state;
      s.options.push({ id: tmpId("op"), name: s.options.length ? `Option ${s.options.length + 1}` : "One-time", kind: "one_time", recommended: !s.options.length, lines: [], discounts: [] });
      s.tab = s.options.length - 1; ctx.rerender();
    },
    "click [data-remove-option]": async (e, el, ctx) => {
      if (!(await confirmSheet("Its lines and discounts go with it.", { title: "Remove this option?", yes: "Remove", danger: true }))) return;
      const s = ctx.state; s.options.splice(s.tab, 1); s.tab = 0;
      if (s.options.length && !s.options.some((o) => o.recommended)) s.options[0].recommended = true;
      ctx.rerender();
    },
    "click [data-kind]": (e, el, ctx) => {
      const o = ctx.state.options[ctx.state.tab];
      o.kind = el.dataset.kind;
      if (o.kind === "plan" && !o.plan) o.plan = { catalog_key: "quarterly", ...clone(CATALOG.quarterly), term_months: 12, billing: "barta_standard", autopay: true, auto_renew: true };
      ctx.rerender();
    },
    "input [data-o]": (e, el, ctx) => optField(ctx, el, false),
    "change [data-o]": (e, el, ctx) => optField(ctx, el, true),
    "input [data-f]": (e, el, ctx) => { ctx.state[el.dataset.f] = el.value; },
    "change [data-f]": (e, el, ctx) => { ctx.state[el.dataset.f] = el.value; },
    "change [data-ag]": (e, el, ctx) => {
      const a = ctx.state.agreement;
      if (el.dataset.ag === "require_card") a.require_card = el.checked;
      if (el.dataset.ag === "deposit_type") { a.deposit = { type: el.value, value: 0 }; ctx.rerender(); }
      if (el.dataset.ag === "deposit_value") a.deposit.value = a.deposit.type === "fixed" ? (readMoney(el.value) || 0) : Math.round(Number(el.value || 0) * 100);
    },
    "click [data-line]": (e, el, ctx) => lineSheet(ctx, Number(el.dataset.line)),
    "click [data-add-line]": (e, el, ctx) => lineSheet(ctx, -1),
    "click [data-add-item]": (e, el, ctx) => addItem(ctx),
    "click [data-add-disc]": (e, el, ctx) => addDiscount(ctx),
    "click [data-disc]": (e, el, ctx) => discountSheet(ctx, Number(el.dataset.disc)),
    "click [data-photo]": (e, el, ctx) => addPhoto(el, ctx),
    "click [data-lights]": async (e, el, ctx) => { const id = await save(el, ctx, { stay: true }); if (id) ctx.go(`/quotes/${encodeURIComponent(id)}/lights`, { replace: true }); },
    "click [data-save]": (e, el, ctx) => save(el, ctx),
  },
};

function step(ctx, k, d) {
  const m = ctx.state.measure;
  m.windows[k] = Math.max(0, Math.min(999, (Number(m.windows[k]) || 0) + d));
  const input = document.querySelector(`[data-win="${k}"]`);
  if (input) input.value = m.windows[k];
  paintPanes(ctx);
}
function paintPanes(ctx) { const b = document.querySelector("[data-panes]"); if (b) b.textContent = String(panesOf(ctx.state)); }
function paintTotals(ctx) {
  const wrap = document.querySelector("[data-totals-wrap]");
  const o = ctx.state.options[ctx.state.tab];
  if (wrap && o) render(wrap, totalsBox(ctx.state, o));
}

function optField(ctx, el, structural) {
  const o = ctx.state.options[ctx.state.tab];
  if (!o) return;
  const k = el.dataset.o;
  if (k === "name") { o.name = el.value; return; }
  if (k === "recommended") { ctx.state.options.forEach((x) => { x.recommended = false; }); o.recommended = el.checked; ctx.rerender(); return; }
  o.plan = o.plan || { catalog_key: "quarterly", ...clone(CATALOG.quarterly), term_months: 12, billing: "barta_standard", autopay: true, auto_renew: true };
  if (k === "catalog_key") {
    o.plan = { ...o.plan, catalog_key: el.value, ...clone(CATALOG[el.value] || CATALOG.custom) };
    if (el.value === "lights_annual") o.plan.billing = "after_visit";
    // the plan's own discount follows the plan (one stack group, D15)
    const per = (ctx.state.cx.pricing.plan_discount_per_visit_cents || {})[el.value];
    o.discounts = (o.discounts || []).filter((d) => d.stack_group !== "plan" && !(d.key || "").startsWith("plan_"));
    const def = (ctx.state.cx.discounts || []).find((d) => d.key === `plan_${el.value}`);
    if (per && def) o.discounts.push({ id: tmpId("dc"), def_id: def.id, key: def.key, name: def.name, type: "fixed", value: per, scope: { type: "all" }, stack_group: "plan" });
    if (!/plan$/i.test(o.name || "")) o.name = `${PLAN_NAMES[el.value]} plan`;
  }
  if (k === "term_months") o.plan.term_months = Number(el.value);
  if (k === "billing") o.plan.billing = el.value;
  if (k === "visits_per_year") o.plan.visits_per_year = Math.max(1, Math.min(52, parseInt(el.value, 10) || 1));
  if (structural) ctx.rerender(); else paintTotals(ctx);
}

// ------------------------------------------------------------ Price it

async function priceIt(el, ctx) {
  const s = ctx.state;
  const services = SERVICES.map(([k]) => k).filter((k) => s.services[k]);
  if (!services.length) { toast("Tick at least one service.", { bad: true }); return; }
  const input = { services, tracks: {} };
  if (s.measure.mode === "panes") input.panes_ext = panesOf(s);
  else if (s.measure.sqft) input.sqft = Number(s.measure.sqft);
  if (!input.panes_ext && !input.sqft && (s.services.windows_ext || s.services.windows_int)) { toast("Count the panes or type the square feet first.", { bad: true }); return; }
  if (s.measure.panes_int) input.panes_int = parseInt(s.measure.panes_int, 10) || undefined;
  if (s.counts.screens) input.screens = parseInt(s.counts.screens, 10) || undefined;
  if (s.counts.tracks_standard) input.tracks.standard = parseInt(s.counts.tracks_standard, 10) || 0;
  if (s.counts.tracks_premium) input.tracks.premium = parseInt(s.counts.tracks_premium, 10) || 0;
  if (s.counts.gutters) input.gutters_cents = readMoney(s.counts.gutters) || undefined;
  if (s.options.some((o) => (o.lines || []).length) && !(await confirmSheet("The engine's prices replace the lines on the one-time and plan options.", { title: "Price it again?", yes: "Replace" }))) return;
  busy(el, true, "Pricing…");
  try {
    const one = (await ctx.api("/pricing/suggest", { method: "POST", body: { input } })).data;
    const plan = s.plan ? (await ctx.api("/pricing/suggest", { method: "POST", body: { input: { ...input, plan: s.plan } } })).data : null;
    const keepOne = s.options.find((o) => o.kind !== "plan");
    const keepPlan = s.options.find((o) => o.kind === "plan" && o.plan && o.plan.catalog_key !== "lights_annual");
    const others = s.options.filter((o) => o !== keepOne && o !== keepPlan);
    const opts = [{ id: keepOne ? keepOne.id : tmpId("op"), name: keepOne ? keepOne.name : "One-time", kind: "one_time", recommended: !plan, lines: one.lines, discounts: keepOne ? (keepOne.discounts || []).filter((d) => d.stack_group !== "plan") : [] }];
    if (plan) opts.push({ id: keepPlan ? keepPlan.id : tmpId("op"), name: `${PLAN_NAMES[s.plan]} plan`, kind: "plan", recommended: true, plan: { ...plan.plan, term_months: (keepPlan && keepPlan.plan && keepPlan.plan.term_months) || 12 }, lines: plan.lines, discounts: plan.discounts });
    s.options = [...opts, ...others].slice(0, 3);
    s.warnings = [...new Set([...one.warnings, ...((plan && plan.warnings) || [])])];
    if (s.measure.mode === "panes") s.measure.panes_ext = one.panes_ext;
    s.tab = 0;
    ctx.rerender();
  } catch (err) { busy(el, false); toast(err.message, { bad: true }); }
}

// ------------------------------------------------------------ lines and discounts

function lineSheet(ctx, i) {
  const s = ctx.state;
  const o = s.options[s.tab];
  if (!o) { toast("Add an option first.", { bad: true }); return; }
  const isNew = i < 0;
  const l = isNew ? { title: "", qty_milli: 1000, unit_cents: 0, scope: { type: "all" }, unit: "flat", category: "other", show: { qty: false, unit: false, description: true } } : clone(o.lines[i]);
  const canOverride = !!(s.cx.can && s.cx.can.override);
  const scopeVal = !l.scope || l.scope.type === "all" ? "all" : l.scope.type;
  // a price the engine or the price book sets changes only as "Change the line total" with a reason (the server agrees)
  const item = l.price_item_id ? (s.cx.book || []).find((x) => x.id === l.price_item_id) : null;
  const locked = Number.isInteger(l.engine_cents) || !!(item && item.unit_cents > 0);
  const qtyLocked = locked && (l.unit || "flat") === "flat";
  const sh = sheet({
    title: isNew ? "Custom line" : "Line",
    body: html`<form class="form" data-lf>
      <label class="field" data-field="title"><span>What it is</span><input ${attrs({ name: "title", value: l.title, maxlength: 160, required: true })}><small class="why" hidden></small></label>
      <label class="field"><span>Description (on the quote)</span><textarea name="description" rows="2" maxlength="2000">${l.description || ""}</textarea></label>
      <div class="grid2"><label class="field"><span>Quantity</span><input ${attrs({ name: "qty", inputmode: "decimal", value: qtyText(l.qty_milli), disabled: qtyLocked })}></label>
      <label class="field"><span>Price each</span><input ${attrs({ name: "unit", inputmode: "decimal", value: (l.unit_cents / 100).toFixed(2), disabled: locked })}></label></div>
      ${locked ? html`<p class="small muted">${canOverride ? "This price comes from the price book. To change it, change the line total and say why." : "This price comes from the price book."}</p>` : ""}
      ${canOverride ? html`<div class="grid2"><label class="field"><span>Change the line total</span><input ${attrs({ name: "ov", inputmode: "decimal", value: l.override ? (l.override.cents / 100).toFixed(2) : "", placeholder: "No change" })}></label>
        <label class="field" data-field="reason"><span>Why</span><input ${attrs({ name: "reason", value: l.override ? l.override.reason : "", maxlength: 200, placeholder: "e.g. neighbor deal" })}><small class="why" hidden></small></label></div>` : (l.override ? html`<p class="small muted">Price changed: ${l.override.reason}</p>` : "")}
      <label class="field"><span>Which visits</span><select name="scope">${[["all", "Every visit"], ["initial", "First visit only"], ["after_initial", "After the first visit"], ["specific", "Some visits…"]].map(([v, t]) => html`<option ${attrs({ value: v, selected: scopeVal === v })}>${t}</option>`)}</select></label>
      <label class="field"><span>Visits (for "some visits")</span><input ${attrs({ name: "visits", inputmode: "numeric", value: l.scope && l.scope.type === "specific" ? l.scope.visits.join(", ") : "", placeholder: "1, 3, 4" })}></label>
      <label class="check"><input ${attrs({ type: "checkbox", name: "optional", checked: !!l.optional })}><span>An add-on the customer can tick</span></label>
      <label class="check"><input ${attrs({ type: "checkbox", name: "selected", checked: !!l.selected })}><span>Ticked to start with</span></label>
      <div class="btn-row">${isNew ? "" : html`<button type="button" class="btn danger" data-del>Remove</button>`}<button type="submit" class="btn primary">Done</button></div>
    </form>`,
    events: {
      "click [data-del]": () => { o.lines.splice(i, 1); sh.close(); ctx.rerender(); },
      "submit [data-lf]": (e, form) => {
        e.preventDefault();
        const f = form.elements;
        const title = f.title.value.trim();
        if (!title) { const w = form.querySelector('[data-field="title"] .why'); w.textContent = "Say what it is."; w.hidden = false; return; }
        const qty = qtyLocked ? l.qty_milli : toMilli(f.qty.value);
        const unit = locked ? l.unit_cents : readMoney(f.unit.value);
        const next = { ...l, id: l.id || tmpId("ln"), title, description: f.description.value, qty_milli: qty === null || qty === undefined ? 1000 : qty, unit_cents: unit === null ? 0 : unit, optional: f.optional.checked || undefined, selected: f.optional.checked ? f.selected.checked : undefined };
        if (!locked && f.unit.value && (qty !== 1000) && next.unit === "flat") next.unit = "each";
        const sc = f.scope.value;
        next.scope = sc === "specific" ? (parseVisits(f.visits.value) || { type: "all" }) : { type: sc };
        if (canOverride) {
          const ov = f.ov.value.trim() ? readMoney(f.ov.value) : null;
          if (ov !== null) {
            if (!f.reason.value.trim()) { const w = form.querySelector('[data-field="reason"] .why'); w.textContent = "Say why the price changed."; w.hidden = false; return; }
            next.override = { cents: ov, reason: f.reason.value.trim() };
          } else delete next.override;
        }
        next.show = { ...(next.show || {}), qty: next.unit !== "flat", unit: next.unit !== "flat" };
        if (isNew) o.lines.push(next); else o.lines[i] = next;
        sh.close(); ctx.rerender();
      },
    },
  });
}

async function addItem(ctx) {
  const s = ctx.state;
  const o = s.options[s.tab];
  if (!o) { toast("Add an option first.", { bad: true }); return; }
  const items = (s.cx.book || []).filter((x) => x.active !== false && x.sellable !== false);
  const pick = await pickFrom({ title: "From the price book", items: items.map((x) => ({ value: x.id, label: x.name, sub: x.unit_cents ? `${money(x.unit_cents)}${x.unit !== "flat" ? ` a ${x.unit}` : ""}` : "Priced by hand" })) });
  if (!pick) return;
  const it = items.find((x) => x.id === (pick.value || pick));
  if (!it) return;
  o.lines.push({ id: tmpId("ln"), price_item_id: it.id, title: it.name, description: it.description || "", qty_milli: 1000, unit_cents: it.unit_cents || 0, scope: { type: "all" }, category: it.category, unit: it.unit, service_type: it.service_type, show: { qty: it.unit !== "flat", unit: it.unit !== "flat", description: true } });
  ctx.rerender();
  lineSheet(ctx, o.lines.length - 1);
}

async function addDiscount(ctx) {
  const s = ctx.state;
  const o = s.options[s.tab];
  if (!o) { toast("Add an option first.", { bad: true }); return; }
  const defs = (s.cx.discounts || []).filter((d) => d.sellable !== false && d.active !== false && (!d.plan_only || (o.kind === "plan" && o.plan && o.plan.catalog_key === d.plan_only)));
  const pick = await pickFrom({ title: "Add a discount", items: defs.map((d) => ({ value: d.id, label: d.name, sub: d.typed_amount ? "Type the amount" : `${d.type === "percentage" ? `${d.value / 100}% off` : `${money(d.value)} off`} · ${scopeWords(d.default_scope)}` })) });
  if (!pick) return;
  const d = defs.find((x) => x.id === (pick.value || pick));
  if (!d) return;
  if (d.stack_group && (o.discounts || []).some((x) => x.stack_group === d.stack_group)) { toast(`${d.name} can't be combined with the discount already on this option.`, { bad: true }); return; }
  o.discounts = o.discounts || [];
  o.discounts.push({ id: tmpId("dc"), def_id: d.id, key: d.key, name: d.name, type: d.type, value: d.value, scope: clone(d.default_scope || { type: "all" }), ...(d.stack_group ? { stack_group: d.stack_group } : {}) });
  ctx.rerender();
  if (d.typed_amount) discountSheet(ctx, o.discounts.length - 1);
}

function discountSheet(ctx, i) {
  const o = ctx.state.options[ctx.state.tab];
  const d = o.discounts[i];
  const sc = !d.scope || d.scope.type === "all" ? "all" : d.scope.type;
  const sh = sheet({
    title: d.name,
    body: html`<form class="form" data-df>
      <label class="field"><span>${d.type === "percentage" ? "Percent off" : "Amount off"}</span><input ${attrs({ name: "value", inputmode: "decimal", value: d.type === "percentage" ? String(d.value / 100) : (d.value / 100).toFixed(2) })}></label>
      <label class="field"><span>Which visits</span><select name="scope">${[["all", "Every visit"], ["initial", "First visit only"], ["after_initial", "After the first visit"], ["specific", "Some visits…"]].map(([v, t]) => html`<option ${attrs({ value: v, selected: sc === v })}>${t}</option>`)}</select></label>
      <label class="field"><span>Visits (for "some visits")</span><input ${attrs({ name: "visits", inputmode: "numeric", value: d.scope && d.scope.type === "specific" ? d.scope.visits.join(", ") : "", placeholder: "1, 3" })}></label>
      <div class="btn-row"><button type="button" class="btn danger" data-del>Remove</button><button type="submit" class="btn primary">Done</button></div>
    </form>`,
    events: {
      "click [data-del]": () => { o.discounts.splice(i, 1); sh.close(); ctx.rerender(); },
      "submit [data-df]": (e, form) => {
        e.preventDefault();
        const f = form.elements;
        const v = d.type === "percentage" ? Math.round(Math.min(100, Math.max(0, Number(f.value.value) || 0)) * 100) : Math.max(0, readMoney(f.value.value) || 0);
        o.discounts[i] = { ...d, value: v, scope: f.scope.value === "specific" ? (parseVisits(f.visits.value) || { type: "all" }) : { type: f.scope.value } };
        sh.close(); ctx.rerender();
      },
    },
  });
}

async function addPhoto(el, ctx) {
  const kind = el.dataset.photo;
  const file = await capture({ camera: kind === "photo" });
  if (!file) return;
  busy(el, true, "Uploading…");
  try {
    const out = await uploadPhoto({ ownerType: "quote", ownerId: ctx.state.id, kind, file });
    if (out && out.file) { if (kind === "mockup") ctx.state.mockup_file_ids.push(out.file.id); else ctx.state.photo_ids.push(out.file.id); }
    toast(kind === "mockup" ? "Mockup added" : "Photo added");
    const r = await ctx.api(`/quotes/${encodeURIComponent(ctx.state.id)}`, { cache: false });
    ctx.state.etag = r.etag;
    ctx.rerender();
  } catch (err) { busy(el, false); toast(err.message, { bad: true }); }
}

// ------------------------------------------------------------ save

function body(s) {
  const options = s.options.map((o) => {
    const x = clone(o);
    x.lines = (x.lines || []).map((l) => { const y = { ...l }; delete y.total_cents; return y; });
    delete x.totals;
    return x;
  });
  const measure = { mode: s.measure.mode, windows: s.measure.windows, services: s.services, counts: s.counts, plan: s.plan };
  if (s.measure.mode === "panes") measure.panes_ext = panesOf(s);
  if (s.measure.sqft) measure.sqft = parseInt(s.measure.sqft, 10) || undefined;
  if (s.measure.panes_int) measure.panes_int = parseInt(s.measure.panes_int, 10) || undefined;
  const out = { options, client_notes: s.client_notes, internal_notes: s.internal_notes, measure, ...(s.property_id ? { property_id: s.property_id } : {}) };
  if (s.cx.features && s.cx.features.deposits) out.agreement = s.agreement;
  return out;
}

async function save(el, ctx, { stay = false } = {}) {
  const s = ctx.state;
  if (!s.contact) { toast("Pick who it's for first.", { bad: true }); return null; }
  busy(el, true, "Saving…");
  try {
    if (s.isNew) {
      s.clientId = s.clientId || uuid();
      const r = await ctx.api("/quotes", { method: "POST", body: { client_id: s.clientId, contact_id: s.contact.id, ...body(s) } });
      toast(`Saved ${r.data.number_label}`);
      if (!stay) ctx.go(`/quotes/${encodeURIComponent(r.data.id)}`, { replace: true });
      return r.data.id;
    }
    await ctx.api(`/quotes/${encodeURIComponent(s.id)}`, { method: "PATCH", body: body(s), ifMatch: s.etag });
    toast("Saved");
    if (!stay) ctx.go(`/quotes/${encodeURIComponent(s.id)}`, { replace: true });
    return s.id;
  } catch (err) {
    busy(el, false);
    if (err.status === 412) toast("Someone else just changed this quote. Reload to see theirs.", { bad: true });
    else toast(err.message, { bad: true });
    return null;
  }
}
