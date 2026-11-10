// Property (design §9.2 "Property", §5.1): the address with Directions,
// where it sits in the service area (the map point comes from Google once
// Maps is live; it can be placed by hand), access notes (gate code, pets,
// parking), the counts quotes reuse (panes, screens, tracks, stories,
// gutter feet) and, for lights customers, the lights profile.

import { html, icon, sheet, toast, openExternal } from "../../core/ui.js";
import { field, checkbox, readForm, clearErrors, showError, busy } from "../../core/forms.js";
import { directionsUrl } from "../../core/map.js";
import { ensureStyles, addressLine, tierPill } from "./kit.js";

const ASSETS = [["panes_ext", "Window panes (outside)"], ["panes_int", "Window panes (inside)"], ["screens", "Screens"], ["tracks", "Tracks"], ["stories", "Stories"], ["french_panes", "French panes"], ["gutter_ft", "Gutter feet"], ["downspouts", "Downspouts"], ["roofline_ft", "Roofline feet"], ["sqft", "Square feet"]];

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
    const as = p.assets || {};
    const counted = ASSETS.filter(([k]) => Number.isFinite(as[k]));
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
      <section class="card"><h2>Counts</h2>
        ${counted.length ? html`<dl class="kv">${counted.map(([k, label]) => html`<dt>${label}</dt><dd class="num">${as[k]}</dd>`)}</dl>` : html`<p class="muted small">Counted on a quote or a visit; the next quote reuses them.</p>`}
        ${as.notes ? html`<p class="ct-pre" style="margin-top:8px">${as.notes}</p>` : ""}
      </section>
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
      const as = p.assets || {};
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
          <div class="grid2">${ASSETS.slice(0, 6).map(([k, label]) => field({ label, name: `as_${k}`, value: Number.isFinite(as[k]) ? String(as[k]) : "", inputmode: "numeric" }))}</div>
          <button type="submit" class="btn primary block">Save</button></form>`,
        events: {
          "submit #pr-form": async (ev, form) => {
            ev.preventDefault(); clearErrors(form);
            const v = readForm(form);
            const assets = { ...as };
            for (const [k] of ASSETS.slice(0, 6)) { if (v[`as_${k}`] === "") delete assets[k]; else assets[k] = Number(v[`as_${k}`]); }
            const btn = form.querySelector("[type=submit]"); busy(btn, true);
            try {
              await ctx.api(`/properties/${encodeURIComponent(p.id)}`, {
                method: "PATCH", ifMatch: ctx.state.etag,
                body: { label: v.label, address: { street1: v.street1, city: v.city, state: (v.state || "MN").toUpperCase(), zip: v.zip }, access: { ...a, gate_code: v.gate_code || undefined, pets: v.pets || undefined, parking: v.parking || undefined, interior_ok: !!v.interior_ok, notes: v.access_notes || undefined }, assets },
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
