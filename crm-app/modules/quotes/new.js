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

import { html, toast, confirmSheet, attrs as attrsOf } from "../../core/ui.js";
import { uuid } from "../../core/api.js";
import { busy } from "../../core/forms.js";
import { uploadPhoto } from "../../core/camera.js";
import {
  ensureCreateStyles, createPage, fieldLabel, customerCard, mockupChip, addRow, itemRows, lineRowOf, totalRow, pickRow, notesField, setReady, redraw, loadCustomer, primaryOf,
  saveLeadSource, pickCustomer, pickProperty, pickItem, lineFromItem, lineSheet, discountSheet, discountWords, pickOne, pickFiles, CF_ICONS,
} from "../../core/create.js";
import { ensureStyles, PLAN_NAMES, optionTotals, visitsOf } from "./kit.js";
import { money } from "../../core/format.js";
import { SOURCES } from "../contacts/kit.js";

const PLAN_KEYS = ["biannual", "quarterly", "monthly", "custom"];
const CATALOG = {
  biannual: { frequency: { interval: "month", count: 6 }, visits_per_year: 2 }, quarterly: { frequency: { interval: "month", count: 3 }, visits_per_year: 4 },
  monthly: { frequency: { interval: "month", count: 1 }, visits_per_year: 12 }, custom: { frequency: { interval: "month", count: 6 }, visits_per_year: 2 },
};
const tmpId = (p) => `${p}_${uuid().replace(/[^0-9a-f]/g, "").slice(0, 12)}`;
const typeText = (o) => (o.kind === "plan" && o.plan ? `${PLAN_NAMES[o.plan.catalog_key] || "Custom"} plan` : "One-time job");
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
  return { cx, contact, property: primaryOf(contact, q.get("property") || ""), source: contact ? contact.source : "", options: [oneTime(0)], notes: "", files: [], client_id: uuid() };
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
function render(s, ctx) {
  if (s.gone) return html``;
  const body = html`
    ${fieldLabel("Customer")}
    ${customerCard(s.contact, s.property)}
    ${mockupChip(LIGHTS(s) && ctx.can("office:tools"))}
    ${s.options.map((o, i) => optionBlock(s, o, i))}
    <button type="button" class="cf-link" data-cf-measure>${CF_ICONS.ruler}<span>Measure and price</span>${CF_ICONS.chevright}</button>
    ${fieldLabel("Attachments")}
    <div class="cf-card"><div class="cf-row"><span class="cf-t"><span class="cf-sl">Files for your customer</span>${s.files.length ? html`<small>${s.files.map((f) => f.name || "A photo").join(", ")}</small>` : ""}</span><button type="button" class="cf-pill cf-addpill" data-cf-attach>${s.files.length ? "Add more" : "Add"}</button></div></div>
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
  o.plan = { catalog_key: key, ...JSON.parse(JSON.stringify(CATALOG[key])), term_months: (o.plan && o.plan.term_months) || 12, billing: "barta_standard", autopay: true, auto_renew: true };
  o.name = `${PLAN_NAMES[key]} plan`;
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

async function choose(ctx) {
  const s = ctx.state;
  const c = await pickCustomer(ctx.api, { title: "Customer", lifecycle: "lead" });
  if (!c) return;
  s.contact = c;
  s.property = primaryOf(c);
  s.source = c.source || "";
  redraw(ctx);
}
