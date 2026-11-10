// Settings → Pricing & price book (design §9.2, §5.3 cfg/pricing, D26; owners):
// the engine's numbers (exterior tiers, interior per 20 panes, screens,
// tracks, plan discounts per visit, lights per foot, Early Bird and its
// deadlines, the 3-year discount, how long a quote is good, booking right
// after approval) and the price book's items (price, on or off, sellable).
// Every number is a setting: an owner's change applies to the next quote,
// never to one already sent or imported.

import { html, attrs, sheet, toast } from "../../core/ui.js";
import { busy, readMoney } from "../../core/forms.js";
import { money } from "../../core/format.js";
import { ensureStyles } from "./kit.js";

const dollars = (c) => (Number.isInteger(c) ? (c / 100).toFixed(2) : "");

async function load(params, ctx) {
  ensureStyles();
  const [set, book] = await Promise.all([ctx.api("/settings/pricing", { cache: false }), ctx.api("/pricebook", { cache: false })]);
  return { cfg: set.data.data, etag: set.data.etag || set.etag || "new", book: book.data || [] };
}

const moneyField = (label, name, cents) => html`<label class="field"><span>${label}</span><input ${attrs({ name, inputmode: "decimal", value: dollars(cents) })}></label>`;

export default {
  title: "Pricing & price book",
  load,
  render(s) {
    const c = s.cfg;
    const season = Object.keys(c.lights.deadlines || {}).sort().pop() || String(new Date().getFullYear());
    const dl = (c.lights.deadlines || {})[season] || [];
    return html`<div class="stack">
      <form class="form qp" data-pricing novalidate>
        <section class="card qp-tiers"><h2>Exterior windows</h2><p class="small muted">Up to this many panes costs this much. Over the last tier is priced by hand.</p>
          ${c.exterior_tiers.map((t, i) => html`<div class="tier"><label class="field"><span>Up to panes</span><input ${attrs({ name: `tier_p_${i}`, inputmode: "numeric", value: t.max_panes })}></label>${moneyField("Price", `tier_c_${i}`, t.cents)}</div>`)}
        </section>
        <section class="card"><h2>Add-ons</h2>
          <div class="grid2">${moneyField("Interior, per 20 panes", "int", c.interior.per_segment_cents)}${moneyField("Screen, each", "scr", c.screens.each_cents)}</div>
          <div class="grid2">${moneyField("Track detailing, each", "trk", c.tracks.standard_cents)}${moneyField("Premium tracks, each", "trp", c.tracks.premium_cents)}</div>
        </section>
        <section class="card"><h2>Plan discount per visit</h2>
          <div class="grid3">${moneyField("Biannual", "pd_biannual", c.plan_discount_per_visit_cents.biannual)}${moneyField("Quarterly", "pd_quarterly", c.plan_discount_per_visit_cents.quarterly)}${moneyField("Monthly", "pd_monthly", c.plan_discount_per_visit_cents.monthly)}</div>
        </section>
        <section class="card"><h2>Christmas lights</h2>
          <div class="grid2">${moneyField("Install, per foot", "li", c.lights.install_per_ft_cents)}${moneyField("Materials, per foot", "lm", c.lights.materials_per_ft_cents)}</div>
          <div class="grid2"><label class="field"><span>Early Bird, percent off</span><input ${attrs({ name: "eb", inputmode: "numeric", value: c.lights.early_bird_bp / 100 })}></label>${moneyField("3-year contract, off", "ty", c.lights.three_year_off_cents)}</div>
          <div class="grid2"><label class="field"><span>${season} first deadline</span><input ${attrs({ type: "date", name: "dl1", value: dl[0] || "" })}></label><label class="field"><span>${season} final deadline</span><input ${attrs({ type: "date", name: "dl2", value: dl[1] || "" })}></label></div>
        </section>
        <section class="card"><h2>Quotes</h2>
          <label class="field"><span>A quote is good for (days)</span><input ${attrs({ name: "exp", inputmode: "numeric", value: c.quote_expiry_days })}></label>
          <label class="check"><input ${attrs({ type: "checkbox", name: "auto", checked: c.auto_convert !== false })}><span>Book it right after the customer approves</span></label>
        </section>
        <p class="err" data-form-err hidden></p>
        <button type="submit" class="btn primary block">Save pricing</button>
      </form>
      <div class="section-h">Price book</div>
      <ul class="list">${s.book.map((i) => html`<li><button type="button" class="row" ${attrs({ "data-item": i.id })}><span class="who"><span class="nm">${i.name}</span><span class="sub">${i.unit_cents ? `${money(i.unit_cents)}${i.unit !== "flat" ? ` a ${i.unit}` : ""}` : i.engine && i.engine !== "manual" ? "Priced by the engine" : "Priced by hand"}</span></span><span class="end">${i.active ? "" : html`<span class="pill">Off</span>`}<span class="chev" aria-hidden="true"></span></span></button></li>`)}</ul>
      <button type="button" class="btn block" data-new-item>Add an item</button>
    </div>`;
  },
  events: {
    "submit [data-pricing]": async (e, form, ctx) => {
      e.preventDefault();
      const s = ctx.state;
      const f = form.elements;
      const c = JSON.parse(JSON.stringify(s.cfg));
      const m = (n, fb) => { const v = readMoney(f[n].value); return v === null ? fb : v; };
      c.exterior_tiers = c.exterior_tiers.map((t, i) => ({ max_panes: parseInt(f[`tier_p_${i}`].value, 10) || t.max_panes, cents: m(`tier_c_${i}`, t.cents) }));
      c.interior = { ...c.interior, per_segment_cents: m("int", c.interior.per_segment_cents) };
      c.screens = { ...c.screens, each_cents: m("scr", c.screens.each_cents) };
      c.tracks = { standard_cents: m("trk", c.tracks.standard_cents), premium_cents: m("trp", c.tracks.premium_cents) };
      c.plan_discount_per_visit_cents = { biannual: m("pd_biannual", 5000), quarterly: m("pd_quarterly", 10000), monthly: m("pd_monthly", 15000) };
      const season = Object.keys(c.lights.deadlines || {}).sort().pop() || String(new Date().getFullYear());
      c.lights = { ...c.lights, install_per_ft_cents: m("li", 800), materials_per_ft_cents: m("lm", 200), early_bird_bp: Math.round((Number(f.eb.value) || 0) * 100), three_year_off_cents: m("ty", 10000), deadlines: { ...c.lights.deadlines, [season]: [f.dl1.value, f.dl2.value].filter(Boolean) } };
      c.quote_expiry_days = parseInt(f.exp.value, 10) || 30;
      c.auto_convert = f.auto.checked;
      const btn = form.querySelector("[type=submit]");
      const err = form.querySelector("[data-form-err]");
      busy(btn, true);
      try {
        const r = await ctx.api("/settings/pricing", { method: "PUT", body: c, ifMatch: s.etag });
        s.cfg = r.data.data || r.data; s.etag = r.data.etag || r.etag || s.etag;
        toast("Pricing saved");
        ctx.refresh();
      } catch (er) { busy(btn, false); err.textContent = er.status === 412 ? "Someone else just saved pricing. Reload to see theirs." : er.message; err.hidden = false; }
    },
    "click [data-item]": (e, el, ctx) => itemSheet(ctx, el.dataset.item),
    "click [data-new-item]": (e, el, ctx) => itemSheet(ctx, null),
  },
};

async function itemSheet(ctx, id) {
  let item = { name: "", unit: "flat", unit_cents: 0, description: "", active: true, sellable: true, category: "other" };
  let etag = null;
  if (id) { const r = await ctx.api(`/pricebook/${encodeURIComponent(id)}`, { cache: false }); item = r.data; etag = r.etag; }
  const sh = sheet({
    title: id ? item.name : "New price book item",
    body: html`<form class="form" data-item-f>
      <label class="field"><span>Name</span><input ${attrs({ name: "name", value: item.name, maxlength: 120 })}></label>
      <div class="grid2"><label class="field"><span>Price</span><input ${attrs({ name: "price", inputmode: "decimal", value: dollars(item.unit_cents) })}></label>
      <label class="field"><span>Per</span><select name="unit">${["flat", "pane", "screen", "track", "ft", "each", "hour"].map((u) => html`<option ${attrs({ value: u, selected: item.unit === u })}>${u === "flat" ? "job (flat)" : u}</option>`)}</select></label></div>
      <label class="field"><span>Description (on the quote)</span><textarea name="description" rows="3" maxlength="2000">${item.description || ""}</textarea></label>
      <label class="check"><input ${attrs({ type: "checkbox", name: "active", checked: item.active !== false })}><span>On (offered in the builder)</span></label>
      <label class="check"><input ${attrs({ type: "checkbox", name: "sellable", checked: item.sellable !== false })}><span>Sellable</span></label>
      <p class="err" data-form-err hidden></p><button type="submit" class="btn primary block">Save</button></form>`,
    events: {
      "submit [data-item-f]": async (e, form) => {
        e.preventDefault();
        const f = form.elements;
        const body = { name: f.name.value.trim(), unit: f.unit.value, unit_cents: readMoney(f.price.value) || 0, description: f.description.value, active: f.active.checked, sellable: f.sellable.checked };
        try {
          if (id) await ctx.api(`/pricebook/${encodeURIComponent(id)}`, { method: "PATCH", body, ifMatch: etag });
          else await ctx.api("/pricebook", { method: "POST", body });
          sh.close(); toast("Saved"); ctx.refresh();
        } catch (er) { const err = form.querySelector("[data-form-err]"); err.textContent = er.message; err.hidden = false; }
      },
    },
  });
}
