// Property (design §9.2 "Property", §5.1): the address with Directions,
// where it sits in the service area (the map point comes from Google once
// Maps is live; it can be placed by hand), access notes (gate code, pets,
// parking), the counts quotes reuse (panes, screens, tracks, stories,
// gutter feet) and, for lights customers, the lights profile.

import { html, icon, sheet, toast, openExternal, attrs } from "../../core/ui.js";
import { field, checkbox, readForm, clearErrors, showError, busy } from "../../core/forms.js";
import { directionsUrl } from "../../core/map.js";
import { ensureStyles, addressLine, tierPill } from "./kit.js";

const ASSETS = [["panes_ext", "Window panes (outside)"], ["panes_int", "Window panes (inside)"], ["screens", "Screens"], ["tracks", "Tracks"], ["tracks_premium", "Premium tracks"], ["stories", "Stories"], ["french_panes", "French panes"], ["gutter_ft", "Gutter feet"], ["downspouts", "Downspouts"], ["roofline_ft", "Roofline feet (lights)"], ["sqft", "Square feet"], ["ladder_ft", "Ladder (feet)"]];
// The quote builder's window types (contacts assets.mjs WINDOW_KEYS), counted outside and inside.
const WINDOWS = [["standard", "Standard"], ["slider", "Slider"], ["large", "Large"], ["sliding_door", "Sliding door"], ["french", "French"], ["front_door", "Front door"], ["garage_small", "Small garage"]];
const EDIT_COUNTS = ["screens", "tracks", "tracks_premium", "stories", "gutter_ft", "downspouts", "roofline_ft", "sqft", "ladder_ft"];
const countOf = (v) => (v === "" || v === undefined || v === null ? undefined : Math.max(0, Math.min(100000, Math.round(Number(v)) || 0)));

function countsCard(p, canEdit, canQuote, contact) {
  const as = p.assets || {};
  const counted = ASSETS.filter(([k]) => Number.isFinite(as[k]));
  const w = as.windows || {};
  const wi = as.windows_int || {};
  const rows = WINDOWS.filter(([k]) => w[k] || wi[k]);
  const from = as.from && as.from.kind === "quote" ? "From the last approved quote" : as.from ? "Counted by hand" : "";
  return html`<section class="card" data-counts><h2>Counts for quoting</h2>
    ${rows.length ? html`<table class="pr-win"><thead><tr><th scope="col">Windows</th><th scope="col">Outside</th><th scope="col">Inside</th></tr></thead><tbody>${rows.map(([k, label]) => html`<tr><th scope="row">${label}</th><td class="num">${w[k] || 0}</td><td class="num">${wi[k] || (Object.keys(wi).length ? 0 : "same")}</td></tr>`)}</tbody></table>` : ""}
    ${counted.length ? html`<dl class="kv">${counted.map(([k, label]) => html`<dt>${label}</dt><dd class="num">${as[k]}</dd>`)}</dl>` : rows.length ? "" : html`<p class="muted small">Counted on a quote or here; the next quote starts from them.</p>`}
    ${as.notes ? html`<p class="ct-pre" style="margin-top:8px">${as.notes}</p>` : ""}
    ${from ? html`<p class="small muted" style="margin-top:8px">${from}.</p>` : ""}
    <div class="btn-row">${canEdit ? html`<button type="button" class="btn" data-edit-counts>${icon("clipboard")}Edit counts</button>` : ""}
      ${canQuote && contact ? html`<a class="btn primary" data-requote href="${"#/quotes/new/" + encodeURIComponent(contact.id) + "?property=" + encodeURIComponent(p.id) + "&requote=1"}">${icon("doc")}Re-quote</a>` : ""}</div>
  </section>`;
}

export default {
  title: (s) => (s && s.p ? s.p.label || "Property" : "Property"),
  async load(params, ctx) {
    ensureStyles();
    const r = await ctx.api(`/properties/${encodeURIComponent(params.id)}`);
    return { p: r.data.property, contact: r.data.contact || null, etag: r.etag, tech: !r.data.contact && !ctx.can("contacts:read_all") };
  },
  render(s, ctx) {
    const p = s.p;
    const a = p.access || {};
    const lights = p.lights;
    const canEdit = ctx.can("contacts:write");
    return html`<div class="stack">
      <section class="card">
        <h2>${addressLine(p.address)}</h2>
        ${s.contact ? html`<a class="ct-line" href="${"#/contacts/" + encodeURIComponent(s.contact.id)}"><span class="lb">Contact</span><span class="v">${s.contact.name}</span><span class="chev" aria-hidden="true"></span></a>` : ""}
        <div class="stat-row">${tierPill(p.town_tier)}${Number.isFinite(p.distance_mi) ? html`<span class="pill">${p.distance_mi} mi from Delano</span>` : ""}${p.county ? html`<span class="pill">${p.county[0].toUpperCase() + p.county.slice(1)} County</span>` : ""}</div>
        <div class="btn-row"><a class="btn primary" ${openExternal(directionsUrl(p.geo || p.address))}>${icon("map")}Directions</a>
          ${canEdit && !p.geo ? html`<button type="button" class="btn" data-geocode>Find on the map</button>` : ""}</div>
      </section>
      <section class="card"><h2>Getting in</h2>
        ${Object.keys(a).length ? html`<dl class="kv">
          ${a.gate_code ? html`<dt>Gate code</dt><dd class="num">${a.gate_code}</dd>` : ""}
          ${a.pets ? html`<dt>Pets</dt><dd>${a.pets}</dd>` : ""}
          ${a.parking ? html`<dt>Parking</dt><dd>${a.parking}</dd>` : ""}
          ${a.interior_ok !== undefined ? html`<dt>Inside OK</dt><dd>${a.interior_ok ? "Yes" : "No"}</dd>` : ""}
          ${a.notes ? html`<dt>Notes</dt><dd class="ct-pre">${a.notes}</dd>` : ""}
        </dl>` : html`<p class="muted small">No access notes yet.</p>`}
      </section>
      ${countsCard(p, canEdit, ctx.can("quotes:write"), s.contact)}
      ${lights ? html`<section class="card"><h2>Christmas lights</h2><dl class="kv">
        <dt>Total</dt><dd class="num">${lights.total_ft || 0} ft</dd>
        ${(lights.colors || []).length ? html`<dt>Colors</dt><dd>${lights.colors.map((c) => c.replace("_", " ")).join(", ")}</dd>` : ""}
        ${lights.bin_id ? html`<dt>Bin</dt><dd>${lights.bin_id}</dd>` : ""}
        ${(lights.runs || []).length ? html`<dt>Runs</dt><dd>${lights.runs.map((r) => `${r.kind} ${r.ft} ft`).join(" · ")}</dd>` : ""}
      </dl></section>` : ""}
      ${(p.photo_ids || []).length ? html`<p class="muted small">${p.photo_ids.length} photos (shown with their visits).</p>` : ""}
      ${canEdit ? html`<div class="btn-row"><button type="button" class="btn" data-edit>Edit</button></div>` : ""}
    </div>`;
  },
  events: {
    "click [data-edit-counts]": (e, el, ctx) => countsSheet(ctx),
    "click [data-geocode]": async (e, el, ctx) => {
      el.disabled = true;
      try {
        const r = await ctx.api(`/properties/${encodeURIComponent(ctx.state.p.id)}/geocode`, { method: "POST", body: {} });
        if (r.data && r.data.skipped) toast(r.data.skipped === "no_result" ? "Google didn't find that address." : "Map lookups start when an owner turns Maps on (Settings → Integrations).");
        else toast("On the map");
        ctx.refresh();
      } catch (err) { el.disabled = false; toast(err.message, { bad: true }); }
    },
    "click [data-edit]": (e, el, ctx) => {
      const p = ctx.state.p;
      const a = p.access || {};
      const s = sheet({
        title: "Edit property",
        body: html`<form class="form" id="pr-form" novalidate><div class="err" data-form-err hidden></div>
          ${field({ label: "Name", name: "label", value: p.label || "" })}
          ${field({ label: "Street", name: "street1", value: (p.address && p.address.street1) || "", autocomplete: "address-line1" })}
          <div class="addr-grid">${field({ label: "Town", name: "city", value: (p.address && p.address.city) || "" })}${field({ label: "State", name: "state", value: (p.address && p.address.state) || "MN", maxlength: 2 })}${field({ label: "ZIP", name: "zip", value: (p.address && p.address.zip) || "", inputmode: "numeric", maxlength: 10 })}</div>
          ${field({ label: "Gate code", name: "gate_code", value: a.gate_code || "" })}
          ${field({ label: "Pets", name: "pets", value: a.pets || "" })}
          ${field({ label: "Parking", name: "parking", value: a.parking || "" })}
          ${checkbox({ label: "OK to work inside", name: "interior_ok", checked: !!a.interior_ok })}
          <label class="field" data-field="access.notes"><span>Access notes</span><textarea name="access_notes" rows="3">${a.notes || ""}</textarea></label>
          <button type="submit" class="btn primary block">Save</button></form>`,
        events: {
          "submit #pr-form": async (ev, form) => {
            ev.preventDefault(); clearErrors(form);
            const v = readForm(form);
            const btn = form.querySelector("[type=submit]"); busy(btn, true);
            try {
              await ctx.api(`/properties/${encodeURIComponent(p.id)}`, {
                method: "PATCH", ifMatch: ctx.state.etag,
                body: { label: v.label, address: { street1: v.street1, city: v.city, state: (v.state || "MN").toUpperCase(), zip: v.zip }, access: { ...a, gate_code: v.gate_code || undefined, pets: v.pets || undefined, parking: v.parking || undefined, interior_ok: !!v.interior_ok, notes: v.access_notes || undefined } },
              });
              s.close(); toast("Saved"); ctx.refresh();
            } catch (err) {
              busy(btn, false);
              if (err.status === 412) { s.close(); toast("Someone else just changed this. Showing the latest.", { bad: true }); ctx.refresh(); return; }
              showError(form, err);
            }
          },
        },
      });
    },
  },
};

// Edit counts: windows by type outside and inside, the other counts, the
// ladder and notes. The weighted pane totals follow from the windows (the
// quote builder's weights), so the next quote prices the same house.
function countsSheet(ctx) {
  const p = ctx.state.p;
  const as = p.assets || {};
  const w = as.windows || {};
  const wi = as.windows_int || {};
  const num = (name, value, label) => html`<input ${attrs({ name, value: Number.isFinite(value) && value ? String(value) : "", inputmode: "numeric", pattern: "[0-9]*", "aria-label": label, placeholder: "0" })}>`;
  const s = sheet({
    title: "Counts for quoting",
    body: html`<form class="form" id="pr-counts" novalidate><div class="err" data-form-err hidden></div>
      <table class="pr-win pr-win-edit"><thead><tr><th scope="col">Windows</th><th scope="col">Outside</th><th scope="col">Inside</th></tr></thead>
      <tbody>${WINDOWS.map(([k, label]) => html`<tr><th scope="row">${label}</th><td>${num(`w_${k}`, w[k], `${label} outside`)}</td><td>${num(`wi_${k}`, wi[k], `${label} inside`)}</td></tr>`)}</tbody></table>
      <p class="small muted">Leave Inside empty when it's the same as outside.</p>
      <div class="grid2">${EDIT_COUNTS.map((k) => field({ label: ASSETS.find((x) => x[0] === k)[1], name: `as_${k}`, value: Number.isFinite(as[k]) ? String(as[k]) : "", inputmode: "numeric" }))}</div>
      <label class="field" data-field="assets.notes"><span>Notes (ladder, access, anything for next time)</span><textarea name="as_notes" rows="3" maxlength="2000">${as.notes || ""}</textarea></label>
      <button type="submit" class="btn primary block">Save counts</button></form>`,
    events: {
      "submit #pr-counts": async (ev, form) => {
        ev.preventDefault(); clearErrors(form);
        const v = readForm(form);
        const next = { ...as };
        const windows = {};
        const inside = {};
        for (const [k] of WINDOWS) {
          const o = countOf(v[`w_${k}`]);
          const i = countOf(v[`wi_${k}`]);
          if (o) windows[k] = o;
          if (i) inside[k] = i;
        }
        if (Object.keys(windows).length) next.windows = windows; else delete next.windows;
        if (Object.keys(inside).length) next.windows_int = inside; else delete next.windows_int;
        for (const k of EDIT_COUNTS) { const n = countOf(v[`as_${k}`]); if (n === undefined) delete next[k]; else next[k] = n; }
        next.notes = v.as_notes || undefined;
        // the weighted totals the engine prices (standard 1, slider 2, large 2, sliding door 2, French 0.4, front door 1, small garage free)
        const W = { standard: 1, slider: 2, large: 2, sliding_door: 2, french: 0.4, front_door: 1, garage_small: 0 };
        const panes = (m) => Math.ceil(Object.entries(m).reduce((t, [k, n]) => t + Math.round((W[k] ?? 1) * 1000) * n, 0) / 1000);
        if (Object.keys(windows).length) { next.panes_ext = panes(windows); next.french_panes = windows.french || undefined; }
        if (Object.keys(inside).length) next.panes_int = panes(inside);
        else if (Object.keys(windows).length) delete next.panes_int;
        next.from = { kind: "manual", at: new Date().toISOString() };
        for (const k of Object.keys(next)) if (next[k] === undefined) delete next[k];
        const btn = form.querySelector("[type=submit]"); busy(btn, true);
        try {
          await ctx.api(`/properties/${encodeURIComponent(p.id)}`, { method: "PATCH", ifMatch: ctx.state.etag, body: { assets: next } });
          s.close(); toast("Counts saved"); ctx.refresh();
        } catch (err) {
          busy(btn, false);
          if (err.status === 412) { s.close(); toast("Someone else just changed this. Showing the latest.", { bad: true }); ctx.refresh(); return; }
          showError(form, err);
        }
      },
    },
  });
}
