// One estimate template (#/settings/estimate-templates/:id, "new" for a new
// one): its name and one line, its kind, up to 3 options (one-time or a
// plan: Biannual, Quarterly, Monthly, Christmas lights every season,
// Custom), each with line items from the price book (a set quantity, blank,
// or "from the property's counts": panes, screens, tracks, roofline feet),
// discounts from the catalog (or typed), the lights offers (Early Bird, the
// 3-year contract, colors), and the notes. Archive / Restore at the bottom.
// Engine-priced items (exterior and interior windows) carry no price here:
// the engine prices them from the property's panes when the template is used.

import { html, attrs, icon, sheet, toast, confirmSheet } from "../../core/ui.js";
import { busy } from "../../core/forms.js";
import { money } from "../../core/format.js";
import { pickItem, discountSheet, moneyIn } from "../../core/create.js";
import { ensureStyles, discountText } from "./kit.js";

const TYPES = [["one_time", "One-time job"], ["biannual", "Biannual plan"], ["quarterly", "Quarterly plan"], ["monthly", "Monthly plan"], ["lights_annual", "Christmas lights, every season"], ["custom", "Custom plan"]];
const FROM = [["", "Blank (fill it in on the quote)"], ["fixed", "A set number"], ["panes_ext", "The property's panes (outside)"], ["panes_int", "The property's panes (inside)"], ["screens", "The property's screens"], ["tracks", "The property's tracks"], ["tracks_premium", "The property's premium tracks"], ["roofline_ft", "The property's roofline feet"], ["gutter_ft", "The property's gutter feet"]];
const COLOR_NAMES = { warm_white: "Warm white", red: "Red", green: "Green" };
const ENGINE = new Set(["exterior_tiers", "interior_segments"]);
const blankTpl = () => ({ name: "", summary: "", kind: "one_time", client_notes: "", internal_notes: "", archived: false, options: [{ name: "One-time", kind: "one_time", recommended: true, items: [], discounts: [] }] });
const typeOf = (o) => (o.kind === "plan" ? o.plan_key || "custom" : "one_time");

async function load(params, ctx) {
  ensureStyles();
  const [cx, t] = await Promise.all([
    ctx.api("/pricing/context").then((r) => r.data),
    params.id === "new" ? null : ctx.api(`/quote-templates/${encodeURIComponent(params.id)}`, { cache: false }),
  ]);
  return { id: params.id === "new" ? null : params.id, etag: t ? t.etag : null, tpl: t ? t.data : blankTpl(), book: cx.book || [], defs: cx.discounts || [], colors: (cx.pricing && cx.pricing.lights && cx.pricing.lights.colors) || ["warm_white", "red", "green"], can: ctx.can("settings:general") };
}

const itemOf = (s, it) => (it.price_item_id && s.book.find((b) => b.id === it.price_item_id)) || (it.key && s.book.find((b) => b.key === it.key)) || null;
function itemWords(s, it) {
  const b = itemOf(s, it);
  const name = it.title || (b && b.name) || "Line item";
  let qty;
  if (b && ENGINE.has(b.engine)) qty = "Priced from the property's pane count";
  else if (it.from) qty = (FROM.find(([k]) => k === it.from) || [, "From the property"])[1].replace(/^The property's/, "From the property's");
  else if (Number.isSafeInteger(it.qty_milli)) qty = `Quantity ${it.qty_milli / 1000}`;
  else qty = b && b.unit === "flat" ? "" : "Quantity on the quote";
  const price = Number.isSafeInteger(it.unit_cents) ? money(it.unit_cents) + (b && b.unit !== "flat" ? ` a ${b.unit}` : "") : b && b.unit_cents ? "Price book" : b && ENGINE.has(b.engine) ? "" : "Priced on the quote";
  return { name: it.note ? `${name} (${it.note})` : name, sub: [qty, price].filter(Boolean).join(" · ") };
}

function optionCard(s, o, i) {
  const lightsy = o.items.some((it) => { const b = itemOf(s, it); return b && b.category === "lights"; }) || typeOf(o) === "lights_annual";
  const L = o.lights || { early_bird: false, three_year: false, colors: ["warm_white"] };
  return html`<section class="card qt-tpl-opt" ${attrs({ "data-opt": String(i) })}>
    <h2>${s.tpl.options.length > 1 ? `Option ${i + 1}` : "The option"}<span class="sp"></span>${s.tpl.options.length > 1 ? html`<button type="button" class="btn small" ${attrs({ "data-opt-rm": String(i), "aria-label": `Remove option ${i + 1}` })}>${icon("trash")}</button>` : ""}</h2>
    <label class="field"><span>Name the customer sees</span><input ${attrs({ "data-opt-name": String(i), value: o.name || "", maxlength: 80 })}></label>
    <label class="field"><span>Kind</span><select ${attrs({ "data-opt-type": String(i) })}>${TYPES.map(([k, l]) => html`<option ${attrs({ value: k, selected: typeOf(o) === k })}>${l}</option>`)}</select></label>
    <ul class="list">${o.items.map((it, j) => { const w = itemWords(s, it); return html`<li><button type="button" class="row" ${attrs({ "data-item": `${i}:${j}` })}><span class="who"><span class="nm">${w.name}</span>${w.sub ? html`<span class="sub">${w.sub}</span>` : ""}</span><span class="end"><span class="chev" aria-hidden="true"></span></span></button></li>`; })}</ul>
    <button type="button" class="btn block" ${attrs({ "data-item-add": String(i) })}>${icon("plus")}Add line item</button>
    ${o.discounts.length ? html`<ul class="list">${o.discounts.map((d, j) => { const def = d.key ? s.defs.find((x) => x.key === d.key) : null; return html`<li><button type="button" class="row" ${attrs({ "data-disc": `${i}:${j}` })}><span class="who"><span class="nm">${def ? def.name : d.name}</span><span class="sub">${def ? discountText(def) : discountText(d)}</span></span><span class="end">${icon("close")}</span></button></li>`; })}</ul>` : ""}
    <button type="button" class="btn block" ${attrs({ "data-disc-add": String(i) })}>${icon("plus")}Add discount</button>
    ${typeOf(o) !== "one_time" && typeOf(o) !== "lights_annual" && typeOf(o) !== "custom" ? html`<p class="small muted">The plan's own discount is added by itself.</p>` : ""}
    ${lightsy ? html`<div class="qt-tpl-lights">
      <label class="check"><input ${attrs({ type: "checkbox", "data-lt-early": String(i), checked: !!L.early_bird })}><span>Early Bird (while the season's deadline is open)</span></label>
      <label class="check"><input ${attrs({ type: "checkbox", "data-lt-three": String(i), checked: !!L.three_year, disabled: typeOf(o) !== "lights_annual" })}><span>3-year contract (every season only)</span></label>
      <div class="qb-svc">${s.colors.map((c) => html`<label class="check"><input ${attrs({ type: "checkbox", "data-lt-color": `${i}:${c}`, checked: (L.colors || []).includes(c) })}><span>${COLOR_NAMES[c] || c}</span></label>`)}</div>
    </div>` : ""}
    <label class="check"><input ${attrs({ type: "radio", name: "recommended", "data-opt-rec": String(i), checked: !!o.recommended })}><span>Recommended</span></label>
  </section>`;
}

export default {
  title: (s) => (s && s.id ? (s.tpl.name || "Template") : "New template"),
  load,
  render(s) {
    const t = s.tpl;
    return html`<form class="stack qb qt-tpl-edit" data-tpl-form novalidate>
      ${t.archived ? html`<p class="warn-box">Archived: New Quote doesn't offer it. Restore it at the bottom.</p>` : ""}
      <section class="card">
        <label class="field" data-field="name"><span>Template name</span><input ${attrs({ name: "name", value: t.name, maxlength: 80, placeholder: "Exterior windows", autocomplete: "off" })}><small class="why" hidden></small></label>
        <label class="field"><span>One line about it</span><input ${attrs({ name: "summary", value: t.summary || "", maxlength: 140, placeholder: "What it is and who it's for", autocomplete: "off" })}></label>
        <label class="field"><span>Kind of estimate</span><select name="kind">${[["one_time", "One-time"], ["plan", "Plan"], ["lights", "Christmas lights"]].map(([k, l]) => html`<option ${attrs({ value: k, selected: t.kind === k })}>${l}</option>`)}</select></label>
      </section>
      ${t.options.map((o, i) => optionCard(s, o, i))}
      ${t.options.length < 3 ? html`<button type="button" class="btn block" data-opt-add>${icon("plus")}Add an option</button>` : ""}
      <section class="card">
        <label class="field"><span>Note for the customer</span><textarea ${attrs({ name: "client_notes", rows: 3, maxlength: 4000 })}>${t.client_notes || ""}</textarea></label>
        <label class="field"><span>Office note</span><textarea ${attrs({ name: "internal_notes", rows: 2, maxlength: 4000 })}>${t.internal_notes || ""}</textarea></label>
      </section>
      <p class="err" data-form-err role="alert" hidden></p>
      ${s.can ? html`<div class="qt-mk-acts"><button type="submit" class="btn primary" data-tpl-save>Save</button>${s.id ? html`<button type="button" class="btn" data-tpl-archive>${t.archived ? "Restore" : "Archive"}</button>` : ""}</div>` : ""}
    </form>`;
  },
  events: {
    "input [name=name]": (e, el, ctx) => { ctx.state.tpl.name = el.value; },
    "input [name=summary]": (e, el, ctx) => { ctx.state.tpl.summary = el.value; },
    "change [name=kind]": (e, el, ctx) => { ctx.state.tpl.kind = el.value; },
    "input [name=client_notes]": (e, el, ctx) => { ctx.state.tpl.client_notes = el.value; },
    "input [name=internal_notes]": (e, el, ctx) => { ctx.state.tpl.internal_notes = el.value; },
    "input [data-opt-name]": (e, el, ctx) => { ctx.state.tpl.options[Number(el.dataset.optName)].name = el.value; },
    "change [data-opt-type]": (e, el, ctx) => {
      const o = ctx.state.tpl.options[Number(el.dataset.optType)];
      if (el.value === "one_time") { o.kind = "one_time"; delete o.plan_key; if (o.lights) o.lights.three_year = false; } else { o.kind = "plan"; o.plan_key = el.value; }
      ctx.rerender();
    },
    "change [data-opt-rec]": (e, el, ctx) => { ctx.state.tpl.options.forEach((o, i) => { o.recommended = i === Number(el.dataset.optRec); }); },
    "click [data-opt-add]": (e, el, ctx) => { const t = ctx.state.tpl; if (t.options.length < 3) { t.options.push({ name: `Option ${t.options.length + 1}`, kind: "one_time", recommended: false, items: [], discounts: [] }); ctx.rerender(); } },
    "click [data-opt-rm]": (e, el, ctx) => { const t = ctx.state.tpl; t.options.splice(Number(el.dataset.optRm), 1); if (!t.options.some((o) => o.recommended)) t.options[0].recommended = true; ctx.rerender(); },
    "click [data-item-add]": async (e, el, ctx) => {
      const s = ctx.state;
      const o = s.tpl.options[Number(el.dataset.itemAdd)];
      const got = await pickItem({ book: s.book });
      if (!got) return;
      const it = got.item ? { price_item_id: got.item.id, ...(got.item.key ? { key: got.item.key } : {}) } : { title: "" };
      const done = await itemSheet(s, it, true);
      if (done && done !== "remove") { o.items.push(done); ctx.rerender(); }
    },
    "click [data-item]": async (e, el, ctx) => {
      const s = ctx.state;
      const [i, j] = el.dataset.item.split(":").map(Number);
      const o = s.tpl.options[i];
      const done = await itemSheet(s, o.items[j], false);
      if (!done) return;
      if (done === "remove") o.items.splice(j, 1); else o.items[j] = done;
      ctx.rerender();
    },
    "click [data-disc-add]": async (e, el, ctx) => {
      const s = ctx.state;
      const o = s.tpl.options[Number(el.dataset.discAdd)];
      const d = await discountSheet(s.defs.filter((x) => x.sellable !== false && x.active !== false && !x.plan_only && !["early_bird", "three_year"].includes(x.key)));
      if (!d || d === "remove") return;
      o.discounts.push(d.key ? { key: d.key } : { name: d.name || "Discount", type: d.type, value: d.value });
      ctx.rerender();
    },
    "click [data-disc]": (e, el, ctx) => { const [i, j] = el.dataset.disc.split(":").map(Number); ctx.state.tpl.options[i].discounts.splice(j, 1); ctx.rerender(); },
    "change [data-lt-early]": (e, el, ctx) => { lightsOf(ctx.state.tpl.options[Number(el.dataset.ltEarly)]).early_bird = el.checked; },
    "change [data-lt-three]": (e, el, ctx) => { lightsOf(ctx.state.tpl.options[Number(el.dataset.ltThree)]).three_year = el.checked; },
    "change [data-lt-color]": (e, el, ctx) => {
      const [i, c] = el.dataset.ltColor.split(":");
      const L = lightsOf(ctx.state.tpl.options[Number(i)]);
      L.colors = el.checked ? [...new Set([...(L.colors || []), c])] : (L.colors || []).filter((x) => x !== c);
    },
    "click [data-tpl-archive]": (e, el, ctx) => archive(el, ctx),
    "submit [data-tpl-form]": (e, form, ctx) => { e.preventDefault(); save(form, ctx); },
  },
};

const lightsOf = (o) => (o.lights ||= { early_bird: false, three_year: false, colors: ["warm_white"] });

// One line item of a template. → item | "remove" | null
function itemSheet(s, it, isNew) {
  const b = itemOf(s, it);
  const engine = b && ENGINE.has(b.engine);
  const mode = it.from || (Number.isSafeInteger(it.qty_milli) ? "fixed" : "");
  return new Promise((resolve) => {
    let done = false;
    const sh = sheet({
      title: b ? b.name : "Custom line item",
      body: html`<form class="form" data-tpl-item novalidate>
        ${b ? "" : html`<label class="field" data-field="title"><span>Name</span><input ${attrs({ name: "title", value: it.title || "", maxlength: 160 })}><small class="why" hidden></small></label>`}
        ${engine ? html`<p class="muted">Priced by the engine from the property's pane count when the template is used (or set on the quote).</p>` : html`
          <label class="field"><span>Quantity</span><select name="from">${FROM.filter(([k]) => !b || b.unit !== "flat" || k === "" || k === "fixed").map(([k, l]) => html`<option ${attrs({ value: k, selected: mode === k })}>${l}</option>`)}</select></label>
          <label class="field"><span>The set number</span><input ${attrs({ name: "qty", inputmode: "decimal", value: Number.isSafeInteger(it.qty_milli) ? String(it.qty_milli / 1000) : "" })}></label>
          <label class="field" data-field="unit"><span>${b && b.unit_cents ? `Price each (blank: the price book's ${money(b.unit_cents)})` : "Price each (blank: priced on the quote)"}</span><input ${attrs({ name: "unit", inputmode: "decimal", value: Number.isSafeInteger(it.unit_cents) ? (it.unit_cents / 100).toFixed(2) : "" })}><small class="why" hidden></small></label>`}
        <label class="field"><span>A word on the line (optional)</span><input ${attrs({ name: "note", value: it.note || "", maxlength: 120, placeholder: b && b.category === "lights" ? "Roofline" : "" })}></label>
        <div class="btn-row">${isNew ? "" : html`<button type="button" class="btn danger" data-remove>Remove</button>`}<button type="submit" class="btn primary">Done</button></div>
      </form>`,
      onClose: () => { if (!done) { done = true; resolve(null); } },
      events: {
        "click [data-remove]": () => { done = true; sh.close(); resolve("remove"); },
        "submit [data-tpl-item]": (e, form) => {
          e.preventDefault();
          const f = form.elements;
          const say = (k, m) => { const w = form.querySelector(`[data-field="${k}"] .why`); w.textContent = m; w.hidden = false; };
          const out = { ...(it.price_item_id ? { price_item_id: it.price_item_id } : {}), ...(it.key ? { key: it.key } : {}) };
          if (!b) { const t = String(f.title.value || "").trim(); if (!t) { say("title", "Name the work."); return; } out.title = t; }
          if (it.description) out.description = it.description;
          if (!engine) {
            const m = f.from.value;
            if (m === "fixed") { const q = Number(String(f.qty.value || "").replace(/,/g, "")); out.qty_milli = Number.isFinite(q) && q >= 0 ? Math.round(q * 1000) : 1000; } else if (m) out.from = m;
            if (String(f.unit.value || "").trim()) { const u = moneyIn(f.unit.value); if (u === null) { say("unit", "Use a price like 295.00."); return; } out.unit_cents = u; }
          }
          const note = String(f.note.value || "").trim();
          if (note) out.note = note;
          done = true; sh.close(); resolve(out);
        },
      },
    });
  });
}

async function save(form, ctx) {
  const s = ctx.state;
  const err = form.querySelector("[data-form-err]");
  err.hidden = true;
  const t = s.tpl;
  if (!String(t.name || "").trim()) { err.textContent = "Name the template."; err.hidden = false; return; }
  if (!t.options.some((o) => o.items.length)) { err.textContent = "Add a line item."; err.hidden = false; return; }
  const body = {
    name: t.name.trim(), summary: (t.summary || "").trim(), kind: t.kind, client_notes: t.client_notes || "", internal_notes: t.internal_notes || "",
    options: t.options.filter((o) => o.items.length).map((o) => ({ name: (o.name || "").trim(), kind: o.kind, ...(o.kind === "plan" ? { plan_key: o.plan_key } : {}), recommended: !!o.recommended, items: o.items, discounts: o.discounts, ...(o.lights ? { lights: { ...o.lights, three_year: !!o.lights.three_year && o.plan_key === "lights_annual" } } : {}) })),
  };
  const btn = form.querySelector("[data-tpl-save]");
  busy(btn, true, "Saving…");
  try {
    if (s.id) await ctx.api(`/quote-templates/${encodeURIComponent(s.id)}`, { method: "PATCH", body, ifMatch: s.etag });
    else await ctx.api("/quote-templates", { method: "POST", body });
    toast("Template saved");
    ctx.go("/settings/estimate-templates", { replace: true });
  } catch (er) { busy(btn, false); err.textContent = er.message; err.hidden = false; }
}

async function archive(el, ctx) {
  const s = ctx.state;
  const to = !s.tpl.archived;
  if (to && !(await confirmSheet("New Quote stops offering it. It stays here to restore.", { title: "Archive this template?", yes: "Archive" }))) return;
  busy(el, true);
  try {
    await ctx.api(`/quote-templates/${encodeURIComponent(s.id)}`, { method: "PATCH", body: { archived: to }, ifMatch: s.etag });
    toast(to ? "Archived" : "Restored");
    ctx.go("/settings/estimate-templates", { replace: true });
  } catch (er) { busy(el, false); toast(er.message, { bad: true }); }
}
