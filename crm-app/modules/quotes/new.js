// New quote (Flyra's "New Estimate" sheet, the owner, Nov 15; design §9.2):
// the customer and their property, the Mockup chip on lights work, then
// the options: "Line items · One-time job ⇅" (or a plan: Biannual,
// Quarterly, Monthly, Custom, with the plan's own discount) and "+ Add
// option" (up to 3), each with its line items (the price book, a custom
// line, or "Measure and price": our pane counter and price engine, the
// builder), discounts and total; files for the customer, the lead source
// (the customer's own) and a note for the customer. Create Estimate saves
// a draft and opens it (Send is there). A retry never makes two (client id).
// The builder stays for Edit and for "Measure and price" (#/quotes/measure).
// "Start from a template" (the owner, Nov 16) at the top fills the options
// and the note from an estimate template (POST /quote-templates/:id/apply,
// priced from today's price book and the property's counts); the customer
// stays and everything stays editable. On lights work the Mockup chip makes
// the mockup of the house right here (mockup.js); it goes on the quote with
// Create.

import { html, toast, confirmSheet, attrs as attrsOf } from "../../core/ui.js";
import { uuid } from "../../core/api.js";
import { busy } from "../../core/forms.js";
import { uploadPhoto } from "../../core/camera.js";
import {
  ensureCreateStyles, createPage, fieldLabel, customerCard, mockupChip, addRow, itemRows, lineRowOf, totalRow, pickRow, notesField, setReady, redraw, loadCustomer, primaryOf,
  saveLeadSource, pickCustomer, pickProperty, pickItem, lineFromItem, lineSheet, discountSheet, discountWords, pickOne, pickFiles, CF_ICONS,
} from "../../core/create.js";
import { ensureStyles, PLAN_NAMES, optionTotals, visitsOf } from "./kit.js";
import { openMockup } from "./mockup.js";
import { money } from "../../core/format.js";
import { SOURCES } from "../contacts/kit.js";

const PLAN_KEYS = ["biannual", "quarterly", "monthly", "custom"];
const CATALOG = {
  biannual: { frequency: { interval: "month", count: 6 }, visits_per_year: 2 }, quarterly: { frequency: { interval: "month", count: 3 }, visits_per_year: 4 },
  monthly: { frequency: { interval: "month", count: 1 }, visits_per_year: 12 }, custom: { frequency: { interval: "month", count: 6 }, visits_per_year: 2 },
  lights_annual: { frequency: { interval: "year", count: 1 }, visits_per_year: 1 },
};
const tmpId = (p) => `${p}_${uuid().replace(/[^0-9a-f]/g, "").slice(0, 12)}`;
const typeText = (o) => (o.kind === "plan" && o.plan ? (o.plan.catalog_key === "lights_annual" ? "Lights plan" : `${PLAN_NAMES[o.plan.catalog_key] || "Custom"} plan`) : "One-time job");
const LIGHTS = (s) => s.options.some((o) => (o.lines || []).some((l) => /christmas lights/i.test(l.service_type || "") || l.category === "lights" || /\blights?\b/i.test(l.title || "")));
const oneTime = (n) => ({ id: tmpId("op"), name: n ? `Option ${n + 1}` : "One-time", kind: "one_time", recommended: !n, lines: [], discounts: [] });

async function load(params, ctx) {
  ensureStyles();
  await ensureCreateStyles();
  const q = new URLSearchParams((typeof location !== "undefined" && location.hash.split("?")[1]) || "");
  // the property's Re-quote prices from its counts: that is the builder's job
  if (q.get("requote") === "1") {
    ctx.go(`/quotes/measure${params.contact ? "/" + encodeURIComponent(params.contact) : ""}?${q.toString()}`, { replace: true });
    return { gone: true };
  }
  const [cx, contact] = await Promise.all([
    ctx.api("/pricing/context", { cache: false }).then((r) => r.data),
    params.contact ? loadCustomer(ctx.api, params.contact).catch(() => null) : null,
  ]);
  return { cx, contact, property: primaryOf(contact, q.get("property") || ""), source: contact ? contact.source : "", options: [oneTime(0)], notes: "", files: [], mockups: [], template: null, tplWarnings: [], client_id: uuid() };
}

const ready = (s) => !!s.contact && s.options.some((o) => o.lines.length);
const floor = (s) => (s.cx.pricing && s.cx.pricing.discount_floor_cents) || 0;

function optionBlock(s, o, i) {
  const t = optionTotals(o, floor(s));
  const v = visitsOf(o);
  const end = html`<button type="button" class="cf-lbl-link" ${attrsOf({ "data-cf-otype": String(i), "aria-label": `Option ${i + 1}: ${typeText(o)}, change` })}><span>${typeText(o)}</span>${CF_ICONS.updown}</button>
    ${i === 0 && s.options.length < 3 ? html`<button type="button" class="cf-lbl-link cf-addopt" data-cf-addopt>${CF_ICONS.plusc}<span>Add option</span></button>` : ""}
    ${i > 0 ? html`<button type="button" class="cf-clear" ${attrsOf({ "data-cf-rmopt": String(i), "aria-label": `Remove option ${i + 1}` })}>${CF_ICONS.close}</button>` : ""}`;
  return html`<section class="cf-opt" ${attrsOf({ "data-cf-option": String(i) })}>
    ${fieldLabel(html`${s.options.length > 1 ? `Option ${i + 1}` : "Line items"} <span class="cf-dotsep">·</span>`, { end, field: i === 0 ? "options" : null })}
    ${itemRows(o.lines.map((l, j) => lineRowOf(l, { "cf-line": `${i}:${j}` })))}
    ${addRow("Add line item", { data: { "cf-addline": String(i) } })}
    ${itemRows((o.discounts || []).map((d, j) => ({ title: d.name || "Discount", sub: discountWords(d), cents: null, data: { "cf-disc": `${i}:${j}` } })))}
    ${addRow("Add discount", { icon: "tag", data: { "cf-adddisc": String(i) } })}
    ${totalRow(t.first_cents, o.kind === "plan" ? { label: new Set(t.per_visit_cents).size <= 1 ? "Total a visit" : "First visit", sub: `${money(t.annual_cents)} a year (${v.year} visit${v.year === 1 ? "" : "s"})`, data: String(i) } : { data: String(i) })}
  </section>`;
}
// What a template left to do, in words (POST /quote-templates/:id/apply warnings).
export const TPL_WARNINGS = {
  count_panes: "No pane count on file: set the exterior price, or Measure and price.",
  confirm_panes_on_site: "Priced from square feet: confirm the panes on site.",
  count_screens_on_site: "Add how many screens.",
  count_tracks: "Add how many tracks.",
  count_on_site: "Add the counts on site.",
  measure_lights: "Add the feet (Light Studio's Measure roof).",
  set_price: "Set the price on the lines at $0.",
  price_gutters: "Gutters are priced by hand ($100 to $299 is typical).",
  early_bird_over: "The Early Bird deadline has passed, so it's left off.",
  over_100_panes: "Over 100 panes: price the exterior by hand.",
  over_100_panes_interior: "Over 100 panes: price the interior by hand.",
  missing_item: "A price book item in this template is gone, so it was left out.",
  missing_discount: "A discount in this template is gone, so it was left out.",
};

function templateRow(s) {
  if (!s.template) return html`<button type="button" class="cf-link qt-tpl-start" data-cf-tpl>${CF_ICONS.doc}<span>Start from a template</span>${CF_ICONS.chevright}</button>`;
  return html`<div class="cf-card qt-tpl-start">${pickRow("Template", s.template.name, { data: { "cf-tpl": true } })}</div>
    ${s.tplWarnings.length ? html`<ul class="qb-warn">${s.tplWarnings.map((w) => html`<li class="warn-box">${TPL_WARNINGS[w] || w}</li>`)}</ul>` : ""}`;
}

function render(s, ctx) {
  if (s.gone) return html``;
  const body = html`
    ${ctx.can("quotes:write") ? templateRow(s) : ""}
    ${fieldLabel("Customer")}
    ${customerCard(s.contact, s.property)}
    ${mockupChip(LIGHTS(s) && ctx.can("quotes:write"), { auto: true })}
    ${s.options.map((o, i) => optionBlock(s, o, i))}
    <button type="button" class="cf-link" data-cf-measure>${CF_ICONS.ruler}<span>Measure and price</span>${CF_ICONS.chevright}</button>
    ${fieldLabel("Attachments")}
    <div class="cf-card"><div class="cf-row"><span class="cf-t"><span class="cf-sl">Files for your customer</span>${s.files.length || s.mockups.length ? html`<small>${[...s.mockups.map(() => "Lights mockup"), ...s.files.map((f) => f.name || "A photo")].join(", ")}</small>` : ""}</span><button type="button" class="cf-pill cf-addpill" data-cf-attach>${s.files.length ? "Add more" : "Add"}</button></div></div>
    <div class="cf-card">${pickRow("Lead source", s.source || "None", { data: { "cf-source": true }, muted: !s.source })}</div>
    ${notesField("client_notes", s.notes, { placeholder: "Add a note (the customer sees it)", label: "Notes" })}`;
  return createPage({ title: "New Estimate", body, form: { id: "qt-new", "data-qt-new": true }, cta: { label: "Create Estimate", disabled: !ready(s) } });
}

function body(s) {
  const options = s.options.map((o, i) => ({
    id: o.id, name: o.name || (o.kind === "plan" ? typeText(o) : i ? `Option ${i + 1}` : "One-time"), kind: o.kind, recommended: !!o.recommended, ...(o.kind === "plan" ? { plan: o.plan } : {}),
    lines: o.lines.map((l) => ({ ...l, id: l.id || tmpId("ln"), scope: l.scope || { type: "all" }, show: l.show || { qty: (l.qty_milli ?? 1000) !== 1000, unit: (l.qty_milli ?? 1000) !== 1000, description: true } })),
    discounts: (o.discounts || []).map((d) => ({ ...d, id: d.id || tmpId("dc"), scope: d.scope || { type: "all" } })),
  })).filter((o, i) => i === 0 || o.lines.length);
  return { client_id: s.client_id, contact_id: s.contact.id, ...(s.property ? { property_id: s.property.id } : {}), options, client_notes: s.notes };
}

async function save(form, ctx) {
  const s = ctx.state;
  const err = form.querySelector("[data-form-err]");
  err.hidden = true;
  if (!ready(s)) { err.textContent = !s.contact ? "Pick the customer first." : "Add a line item."; err.hidden = false; return; }
  const btn = form.querySelector("[data-cf-create]");
  busy(btn, true, "Creating…");
  try {
    const r = await ctx.api("/quotes", { method: "POST", body: body(s) });
    const id = r.data.id;
    const warns = [];
    await saveLeadSource(ctx.api, s.contact, s.source);
    for (const f of s.mockups) await uploadPhoto({ ownerType: "quote", ownerId: id, kind: "mockup", file: f, caption: "Christmas lights mockup" }).catch((e) => warns.push(`The mockup didn't upload: ${e.message}`));
    for (const f of s.files) await uploadPhoto({ ownerType: "quote", ownerId: id, kind: "photo", file: f }).catch((e) => warns.push(`${f.name || "A file"} didn't upload: ${e.message}`));
    toast(warns.length ? `Saved ${r.data.number_label}. ${warns[0]}` : `Saved ${r.data.number_label}`, { ms: warns.length ? 5000 : 2600 });
    ctx.go(`/quotes/${encodeURIComponent(id)}`, { replace: true });
  } catch (e) {
    busy(btn, false);
    err.textContent = e.message || "That didn't save.";
    err.hidden = false;
    err.scrollIntoView({ block: "nearest" });
  }
}

const at = (v) => String(v).split(":").map(Number);

// A plan option: its catalog entry and the plan's own discount (one stack group, D15).
function setType(s, o, key) {
  o.discounts = (o.discounts || []).filter((d) => d.stack_group !== "plan" && !String(d.key || "").startsWith("plan_"));
  if (key === "one_time") { o.kind = "one_time"; delete o.plan; if (/plan$/i.test(o.name || "")) o.name = "One-time"; return; }
  o.kind = "plan";
  const lights = key === "lights_annual";
  o.plan = { catalog_key: key, ...JSON.parse(JSON.stringify(CATALOG[key])), term_months: (o.plan && o.plan.term_months) || 12, billing: lights ? "after_visit" : "barta_standard", autopay: !lights, auto_renew: true };
  o.name = lights ? "Christmas lights, every season" : `${PLAN_NAMES[key]} plan`;
  const per = ((s.cx.pricing && s.cx.pricing.plan_discount_per_visit_cents) || {})[key];
  const def = (s.cx.discounts || []).find((d) => d.key === `plan_${key}`);
  if (per && def) o.discounts.push({ id: tmpId("dc"), def_id: def.id, key: def.key, name: def.name, type: "fixed", value: per, scope: { type: "all" }, stack_group: "plan" });
}

async function goMeasure(ctx) {
  const s = ctx.state;
  if (s.options.some((o) => o.lines.length) && !(await confirmSheet("The pane counter and price engine fill the options there. What's typed here isn't kept.", { title: "Measure and price?", yes: "Open it" }))) return;
  const q = s.property ? `?property=${encodeURIComponent(s.property.id)}` : "";
  ctx.go(`/quotes/measure${s.contact ? "/" + encodeURIComponent(s.contact.id) : ""}${q}`, { replace: true });
}

export default {
  title: "New quote",
  load,
  render,
  events: {
    "click [data-cf-close]": (e, el, ctx) => ctx.back(),
    "click [data-cf-pick]": (e, el, ctx) => choose(ctx),
    "click [data-cf-clear]": (e, el, ctx) => choose(ctx),
    "click [data-cf-prop]": async (e, el, ctx) => {
      const s = ctx.state;
      const p = await pickProperty(ctx.api, s.contact, s.property && s.property.id);
      if (p) { s.property = p; redraw(ctx); }
    },
    "click [data-cf-addopt]": (e, el, ctx) => { const s = ctx.state; if (s.options.length < 3) { s.options.push(oneTime(s.options.length)); redraw(ctx); } },
    "click [data-cf-rmopt]": (e, el, ctx) => { const s = ctx.state; s.options.splice(Number(el.dataset.cfRmopt), 1); if (!s.options.some((o) => o.recommended)) s.options[0].recommended = true; redraw(ctx); },
    "click [data-cf-otype]": async (e, el, ctx) => {
      const s = ctx.state;
      const o = s.options[Number(el.dataset.cfOtype)];
      const v = await pickOne({ title: "Line items", current: o.kind === "plan" ? o.plan.catalog_key : "one_time", items: [
        { value: "one_time", label: "One-time job" }, ...PLAN_KEYS.map((k) => ({ value: k, label: `${PLAN_NAMES[k]} plan`, sub: k === "custom" ? "2 visits a year to start" : `${CATALOG[k].visits_per_year} visits a year` })),
        ...((o.lines || []).some((l) => l.category === "lights") ? [{ value: "lights_annual", label: "Christmas lights plan", sub: "Every season" }] : []),
      ] });
      if (!v) return;
      setType(s, o, v);
      redraw(ctx);
    },
    "click [data-cf-addline]": async (e, el, ctx) => {
      const s = ctx.state;
      const o = s.options[Number(el.dataset.cfAddline)];
      const got = await pickItem({ book: s.cx.book || [], extra: [{ key: "measure", label: "Measure and price", sub: "Count panes or square feet; the engine prices it", icon: "ruler" }] });
      if (!got) return;
      if (got.key === "measure") { goMeasure(ctx); return; }
      let line = got.item ? lineFromItem(got.item) : null;
      if (!line || !line.unit_cents) line = await lineSheet(line);
      if (!line || line === "remove") return;
      o.lines.push({ ...line, id: tmpId("ln"), scope: { type: "all" } });
      redraw(ctx);
    },
    "click [data-cf-line]": async (e, el, ctx) => {
      const s = ctx.state;
      const [i, j] = at(el.dataset.cfLine);
      const o = s.options[i];
      const l = o.lines[j];
      const item = l.price_item_id ? (s.cx.book || []).find((x) => x.id === l.price_item_id) : null;
      const got = await lineSheet(l, { locked: !!(item && item.unit_cents > 0) || Number.isInteger(l.engine_cents) });
      if (!got) return;
      if (got === "remove") o.lines.splice(j, 1); else o.lines[j] = got;
      redraw(ctx);
    },
    "click [data-cf-adddisc]": async (e, el, ctx) => {
      const s = ctx.state;
      const o = s.options[Number(el.dataset.cfAdddisc)];
      const defs = (s.cx.discounts || []).filter((d) => d.sellable !== false && d.active !== false && (!d.plan_only || (o.kind === "plan" && o.plan && o.plan.catalog_key === d.plan_only)));
      const d = await discountSheet(defs);
      if (!d || d === "remove") return;
      if (d.stack_group && (o.discounts || []).some((x) => x.stack_group === d.stack_group)) { toast(`${d.name} can't be combined with the discount already on this option.`, { bad: true }); return; }
      o.discounts.push({ ...d, id: tmpId("dc"), scope: d.scope || { type: "all" } });
      redraw(ctx);
    },
    "click [data-cf-disc]": async (e, el, ctx) => {
      const s = ctx.state;
      const [i, j] = at(el.dataset.cfDisc);
      const o = s.options[i];
      const d = await discountSheet([], o.discounts[j]);
      if (!d) return;
      if (d === "remove") o.discounts.splice(j, 1); else o.discounts[j] = d;
      redraw(ctx);
    },
    "click [data-cf-measure]": (e, el, ctx) => goMeasure(ctx),
    "click [data-cf-tpl]": (e, el, ctx) => startFromTemplate(el, ctx),
    "click [data-cf-mockup-auto]": (e, el, ctx) => {
      const s = ctx.state;
      openMockup(ctx, { propertyId: s.property && s.property.id, quoteId: null, name: s.contact && s.contact.name, studio: ctx.can("office:tools"), onSave: (file) => { s.mockups = [file]; redraw(ctx); } });
    },
    "click [data-cf-source]": async (e, el, ctx) => {
      if (!ctx.state.contact) { toast("Pick the customer first.", { bad: true }); return; }
      const v = await pickOne({ title: "Lead source", current: ctx.state.source, items: SOURCES.map((x) => ({ value: x, label: x })) });
      if (v) { ctx.state.source = v; redraw(ctx); }
    },
    "click [data-cf-attach]": async (e, el, ctx) => {
      const files = await pickFiles({ accept: "image/*,application/pdf" });
      if (files.length) { ctx.state.files = [...ctx.state.files, ...files].slice(0, 10); redraw(ctx); }
    },
    "input [name=client_notes]": (e, el, ctx) => { ctx.state.notes = el.value; },
    "submit #qt-new": (e, form, ctx) => { e.preventDefault(); save(form, ctx); },
  },
  mount(el, s) { if (s && !s.gone) setReady(el, ready(s)); },
};

// "Start from a template": Flyra's picker (the name and its one line), then
// the template's options priced for this property fill the form.
async function startFromTemplate(el, ctx) {
  const s = ctx.state;
  let rows;
  try { rows = (await ctx.api("/quote-templates", { cache: false })).data; } catch (err) { toast(err.message, { bad: true }); return; }
  if (!rows.length) { toast("No templates yet. Add them in Settings, Services & pricing.", { bad: true }); return; }
  const id = await pickOne({ title: "Start from a template", current: s.template && s.template.id, items: rows.map((r) => ({ value: r.id, label: r.name, sub: r.summary })) });
  if (!id) return;
  if (s.options.some((o) => o.lines.length) && !(await confirmSheet("The template's options take the place of the line items here.", { title: "Use this template?", yes: "Use it" }))) return;
  busy(el, true, "Filling it in…");
  try {
    const r = await ctx.api(`/quote-templates/${encodeURIComponent(id)}/apply`, { method: "POST", body: s.property ? { property_id: s.property.id } : {} });
    const out = r.data;
    s.options = out.options.slice(0, 3).map((o, i) => ({ ...o, id: tmpId("op"), recommended: !!o.recommended, lines: o.lines || [], discounts: o.discounts || [], name: o.name || (i ? `Option ${i + 1}` : "One-time") }));
    if (!s.options.length) s.options = [oneTime(0)];
    if (!s.options.some((o) => o.recommended)) s.options[0].recommended = true;
    if (out.client_notes && !s.notes.trim()) s.notes = out.client_notes;
    s.template = { id, name: out.template.name };
    s.tplWarnings = out.warnings || [];
    redraw(ctx);
    toast(`Started from ${out.template.name}`);
  } catch (err) { busy(el, false); toast(err.message, { bad: true }); }
}

async function choose(ctx) {
  const s = ctx.state;
  const c = await pickCustomer(ctx.api, { title: "Customer", lifecycle: "lead" });
  if (!c) return;
  s.contact = c;
  s.property = primaryOf(c);
  s.source = c.source || "";
  redraw(ctx);
}
