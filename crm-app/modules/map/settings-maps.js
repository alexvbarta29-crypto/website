// Settings → Maps and the team map (owners; docs/CRM-MAP.md): the live team
// map (on for the company, on for each person, how often, how long it's
// kept, delete everything now), the geocoders (the Census Bureau for
// addresses, OpenStreetMap's Nominatim for a dropped pin) and which map
// services the app uses (set in Netlify, shown here).

import { html, attrs, toast, confirmSheet } from "../../core/ui.js";
import { busy } from "../../core/forms.js";
import { roleLabel, plural } from "../../core/format.js";
import { loadDoc, saveDoc } from "../system/kit.js";
import { ensureStyles } from "./kit.js";

async function load(params, ctx) {
  ensureStyles();
  const [doc, users, geo] = await Promise.all([loadDoc(ctx, "map"), ctx.api("/users", { cache: false }), ctx.api("/map/geocode", { cache: false }).catch(() => null)]);
  return { doc, users: (users.data || []).filter((u) => u.status === "active"), geo: geo ? geo.data : null };
}

const opt = (v, label, cur) => html`<option ${attrs({ value: String(v), selected: String(v) === String(cur) })}>${label}</option>`;

export default {
  title: "Maps and the team map",
  load,
  render(s) {
    const tm = s.doc.data.team_map || {};
    const g = s.doc.data.geocoding || {};
    const src = s.geo && s.geo.sources;
    return html`<form class="stack" data-map-settings novalidate>
      <div class="card form">
        <h2 class="mp-h">Team map</h2>
        <p class="small">While someone is clocked in with Barta Office open, their phone shares where it is with the office (Menu → Work → Team map). Never when they're clocked out or the app is closed; an iPhone home-screen app can't share in the background at all. They see "Sharing your location while on the clock" whenever it's on.</p>
        <label class="check"><input ${attrs({ type: "checkbox", name: "enabled", checked: !!tm.enabled })}><span><strong>Turn on the team map</strong></span></label>
        <div class="section-h">Who shares</div>
        <ul class="mp-people-perm">${s.users.map((u) => html`<li><label class="check"><input ${attrs({ type: "checkbox", name: "p_" + u.id, checked: (tm.people || []).includes(u.id) })}><span>${u.name} <span class="muted small">${roleLabel(u.role)}${u.is_technician ? " · goes out on visits" : ""}</span></span></label></li>`)}</ul>
        <div class="mp-two">
          <label class="field"><span>Share every</span><select name="every_s">${[[60, "1 minute"], [120, "2 minutes"], [180, "3 minutes"], [300, "5 minutes"]].map(([v, l]) => opt(v, l, tm.every_s))}</select></label>
          <label class="field"><span>Keep positions</span><select name="retention_days">${[[7, "7 days"], [14, "14 days"], [30, "30 days"], [60, "60 days"], [90, "90 days"]].map(([v, l]) => opt(v, l, tm.retention_days))}</select></label>
        </div>
        <button type="button" class="btn danger" data-forget>Delete every stored position now</button>
      </div>
      <div class="card form">
        <h2 class="mp-h">Finding places</h2>
        <label class="check"><input ${attrs({ type: "checkbox", name: "batch", checked: g.batch !== "off" })}><span><strong>Map points for customers' addresses</strong> from the US Census Bureau's free geocoder. It gets the street, town, state and ZIP, nothing else. Google Maps does this instead once it's connected.</span></label>
        ${s.geo ? html`<p class="small muted">${s.geo.waiting ? `${s.geo.more ? "500+" : s.geo.waiting} ${s.geo.waiting === 1 ? "address waits" : "addresses wait"} for a map point.` : "Every address with a street has a map point (or couldn't be found)."}${s.geo.sent_today ? ` ${plural(s.geo.sent_today, "address", "addresses")} looked up today.` : ""}${s.geo.backoff_until ? " The geocoder didn't answer; it tries again in a while." : ""}</p>
          <button type="button" class="btn" data-geocode ${attrs({ disabled: !s.geo.waiting })}>Find map points now</button>` : ""}
        <label class="check"><input ${attrs({ type: "checkbox", name: "reverse", checked: g.reverse !== "off" })}><span><strong>Fill in a dropped pin's address</strong> from OpenStreetMap (Nominatim). It gets the pin's two coordinates only.</span></label>
      </div>
      <div class="card">
        <h2 class="mp-h">The map</h2>
        ${src ? html`<p class="small">Streets: ${src.streets.label}${src.streets.waiting_for_key ? ` (${src.streets.waiting_for_key} waits for its key)` : ""}. Aerial: ${src.aerial ? src.aerial.label : "off"}${src.aerial && src.aerial.waiting_for_key ? ` (${src.aerial.waiting_for_key} waits for its key)` : ""}.</p>` : ""}
        <p class="small muted">Free and keyless today. A sharper aerial view (Esri World Imagery) or another street map needs a key: set CRM_MAP_AERIAL and CRM_MAP_AERIAL_KEY in Netlify (docs/CRM-MAP.md).</p>
      </div>
      <button type="submit" class="btn primary block">Save</button>
    </form>`;
  },
  events: {
    "submit [data-map-settings]": async (e, form, ctx) => {
      e.preventDefault();
      const s = ctx.state;
      const btn = form.querySelector("[type=submit]");
      const f = form.elements;
      const value = {
        team_map: { enabled: f.enabled.checked, people: s.users.filter((u) => f["p_" + u.id] && f["p_" + u.id].checked).map((u) => u.id), every_s: Number(f.every_s.value), retention_days: Number(f.retention_days.value) },
        geocoding: { batch: f.batch.checked ? "census" : "off", reverse: f.reverse.checked ? "nominatim" : "off" },
      };
      busy(btn, true);
      try { await saveDoc(ctx, s.doc, value); toast("Saved"); busy(btn, false); }
      catch (err) { busy(btn, false); toast(err.message, { bad: true }); }
    },
    "click [data-forget]": async (e, b, ctx) => {
      if (!(await confirmSheet("Every position the team map has kept is deleted now. Pins and visits stay.", { title: "Delete every stored position?", yes: "Delete", danger: true }))) return;
      busy(b, true, "Deleting…");
      try {
        let more = true;
        let n = 0;
        for (let i = 0; more && i < 30; i++) { const r = await ctx.api("/map/team/forget", { method: "POST", body: {} }); n += r.data.deleted || 0; more = !!r.data.more; }
        toast(n ? "Every stored position is deleted" : "There were none");
      } catch (err) { toast(err.message, { bad: true }); }
      busy(b, false);
    },
    "click [data-geocode]": async (e, b, ctx) => {
      busy(b, true, "Asked…");
      try { await ctx.api("/map/geocode", { method: "POST", body: {} }); toast("The background worker looks them up in the next few minutes."); }
      catch (err) { busy(b, false); toast(err.message, { bad: true }); }
    },
  },
};
