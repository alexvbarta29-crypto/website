// The Christmas lights quote (design §9.2 "Lights quote", barta-rules §1.5,
// §1.7, D30): the runs measured in Light Studio typed in (roofline, peaks,
// bushes...), per foot ($8 install + $2 materials) or one package price,
// the colors (warm white, red, green), the Early Bird deadline in effect,
// a 3-year contract; the Light Studio mockup attached. "Add to the quote"
// puts it on the quote as its own option: every season (a lights plan,
// auto-renew) or this season only.

import { html, attrs, icon, toast } from "../../core/ui.js";
import { busy, readMoney } from "../../core/forms.js";
import { money, dateShort } from "../../core/format.js";
import { capture, uploadPhoto } from "../../core/camera.js";
import { ensureStyles, lineTotal, optionTotals, warningText } from "./kit.js";

const KINDS = ["Roofline", "Peaks", "Gutter line", "Bushes", "Trees", "Pillars", "Garage", "Other"];
const COLOR_NAMES = { warm_white: "Warm white", red: "Red", green: "Green" };

async function load(params, ctx) {
  ensureStyles();
  const [cx, q] = await Promise.all([ctx.api("/pricing/context", { cache: false }), ctx.api(`/quotes/${encodeURIComponent(params.id)}`, { cache: false })]);
  return {
    id: params.id, cx: cx.data, quote: q.data.quote, etag: q.etag,
    runs: [{ label: "Roofline", feet: "" }], pkg: "", usePkg: false, colors: ["warm_white"], early: !!cx.data.early_bird_deadline, three: false, every: true, preview: null, warnings: [],
  };
}

export default {
  title: "Lights quote",
  load,
  render(s) {
    const deadline = s.cx.early_bird_deadline;
    const p = s.preview;
    return html`<div class="qb">
      <section class="card qb-runs"><h2>Runs</h2>
        <p class="small muted">The lengths from Light Studio's Measure roof, one run per line.</p>
        ${s.runs.map((r, i) => html`<div class="run"><select ${attrs({ "data-run-label": i, "aria-label": "Run" })}>${KINDS.map((k) => html`<option ${attrs({ value: k, selected: r.label === k })}>${k}</option>`)}</select><input ${attrs({ "data-run-feet": i, inputmode: "decimal", value: r.feet, placeholder: "ft", "aria-label": "Feet" })}><button type="button" class="x" ${attrs({ "data-run-del": i, "aria-label": "Remove run" })}>✕</button></div>`)}
        <button type="button" class="btn" data-run-add>${icon("plus")}Add a run</button>
        <label class="check" style="margin-top:10px"><input ${attrs({ type: "checkbox", "data-pkg-on": "1", checked: s.usePkg })}><span>One package price instead of per foot</span></label>
        ${s.usePkg ? html`<label class="field"><span>Package price</span><input ${attrs({ "data-pkg": "1", inputmode: "decimal", value: s.pkg, placeholder: "$1,200" })}></label>` : ""}
      </section>
      <section class="card"><h2>Colors</h2><div class="qb-svc">${(s.cx.pricing.lights.colors || []).map((c) => html`<label class="check"><input ${attrs({ type: "checkbox", "data-color": c, checked: s.colors.includes(c) })}><span>${COLOR_NAMES[c] || c}</span></label>`)}</div></section>
      <section class="card"><h2>Offers</h2>
        <label class="check"><input ${attrs({ type: "checkbox", "data-early": "1", checked: s.early, disabled: !deadline })}><span>${deadline ? `Early Bird 50% off (until ${dateShort(deadline)})` : "Early Bird: the deadline has passed"}</span></label>
        <label class="check"><input ${attrs({ type: "checkbox", "data-three": "1", checked: s.three })}><span>3-year contract ($${(s.cx.pricing.lights.three_year_off_cents / 100).toFixed(0)} off)</span></label>
        <div class="qb-seg" role="group" aria-label="How long"><button type="button" ${attrs({ "data-every": "1", "aria-pressed": String(s.every) })}>Every season</button><button type="button" ${attrs({ "data-every": "0", "aria-pressed": String(!s.every) })}>This season only</button></div>
        <button type="button" class="btn primary block" data-preview>${icon("bolt")}Price the lights</button>
        ${s.warnings.length ? html`<ul class="qb-warn">${s.warnings.map((w) => html`<li class="warn-box">${warningText(w)}</li>`)}</ul>` : ""}
      </section>
      ${p ? html`<section class="card"><h2>The lights option</h2>
        <ul class="qb-lines">${p.lines.map((l) => html`<li><span class="ln" style="display:flex;gap:10px;padding:10px 0"><span class="t">${l.title}${l.description ? html`<small>${l.description}</small>` : ""}</span><span class="p">${lineTotal(l) ? money(lineTotal(l)) : "Included"}</span></span></li>`)}
          ${p.discounts.map((d) => html`<li class="d"><span class="ln" style="display:flex;gap:10px;padding:10px 0"><span class="t">${d.name}</span><span class="p">${d.type === "percentage" ? `${d.value / 100}% off` : `−${money(d.value)}`}</span></span></li>`)}</ul>
        <div class="qb-sum"><span>${s.every ? "Each season" : "This season"}</span><b class="big">${money(optionTotals({ kind: "one_time", lines: p.lines, discounts: p.discounts }).first_cents)}</b></div>
      </section>` : ""}
      <section class="card"><h2>Mockup</h2><p class="small muted">The Light Studio picture, so they see their house lit.</p><button type="button" class="btn" data-mockup>${icon("sun")}Attach the mockup</button></section>
      <div class="qb-bar"><button type="button" class="btn primary" data-add ${attrs({ disabled: !p })}>Add to the quote</button></div>
    </div>`;
  },
  events: {
    "change [data-run-label]": (e, el, ctx) => { ctx.state.runs[Number(el.dataset.runLabel)].label = el.value; },
    "input [data-run-feet]": (e, el, ctx) => { ctx.state.runs[Number(el.dataset.runFeet)].feet = el.value; },
    "click [data-run-add]": (e, el, ctx) => { ctx.state.runs.push({ label: "Peaks", feet: "" }); ctx.rerender(); },
    "click [data-run-del]": (e, el, ctx) => { ctx.state.runs.splice(Number(el.dataset.runDel), 1); if (!ctx.state.runs.length) ctx.state.runs.push({ label: "Roofline", feet: "" }); ctx.rerender(); },
    "change [data-pkg-on]": (e, el, ctx) => { ctx.state.usePkg = el.checked; ctx.rerender(); },
    "input [data-pkg]": (e, el, ctx) => { ctx.state.pkg = el.value; },
    "change [data-color]": (e, el, ctx) => { const c = el.dataset.color; ctx.state.colors = el.checked ? [...new Set([...ctx.state.colors, c])] : ctx.state.colors.filter((x) => x !== c); },
    "change [data-early]": (e, el, ctx) => { ctx.state.early = el.checked; },
    "change [data-three]": (e, el, ctx) => { ctx.state.three = el.checked; },
    "click [data-every]": (e, el, ctx) => { ctx.state.every = el.dataset.every === "1"; ctx.rerender(); },
    "click [data-preview]": (e, el, ctx) => preview(el, ctx),
    "click [data-mockup]": async (e, el, ctx) => {
      const file = await capture({ camera: false });
      if (!file) return;
      busy(el, true, "Uploading…");
      try { await uploadPhoto({ ownerType: "quote", ownerId: ctx.state.id, kind: "mockup", file }); toast("Mockup attached"); busy(el, false); } catch (err) { busy(el, false); toast(err.message, { bad: true }); }
    },
    "click [data-add]": (e, el, ctx) => addToQuote(el, ctx),
  },
};

async function preview(el, ctx) {
  const s = ctx.state;
  const runs = s.runs.map((r) => ({ label: r.label, feet: Number(String(r.feet).replace(/,/g, "")) || 0 })).filter((r) => r.feet > 0);
  const pkg = s.usePkg ? readMoney(s.pkg) : null;
  busy(el, true, "Pricing…");
  try {
    const r = await ctx.api("/pricing/lights", { method: "POST", body: { runs, ...(pkg ? { package_cents: pkg } : {}), colors: s.colors, early_bird: s.early, three_year: s.three } });
    s.preview = r.data;
    s.warnings = r.data.warnings || [];
    ctx.rerender();
  } catch (err) { busy(el, false); toast(err.message, { bad: true }); }
}

async function addToQuote(el, ctx) {
  const s = ctx.state;
  if (!s.preview || !s.preview.lines.length) { toast("Price the lights first.", { bad: true }); return; }
  busy(el, true, "Adding…");
  try {
    const cur = await ctx.api(`/quotes/${encodeURIComponent(s.id)}`, { cache: false });
    const q = cur.data.quote;
    const others = (q.options || []).filter((o) => !(o.lines || []).some((l) => l.category === "lights"));
    if (others.length >= 3) { busy(el, false); toast("A quote holds 3 options. Remove one first.", { bad: true }); return; }
    const option = s.every
      ? { name: "Christmas lights, every season", kind: "plan", recommended: !others.length, plan: s.preview.plan, lines: s.preview.lines, discounts: s.preview.discounts }
      : { name: "Christmas lights, this season", kind: "one_time", recommended: !others.length, lines: s.preview.lines, discounts: s.preview.discounts };
    await ctx.api(`/quotes/${encodeURIComponent(s.id)}`, { method: "PATCH", body: { options: [...others, option] }, ifMatch: cur.etag });
    toast("Lights added to the quote");
    ctx.go(`/quotes/${encodeURIComponent(s.id)}`, { replace: true });
  } catch (err) { busy(el, false); toast(err.message, { bad: true }); }
}
