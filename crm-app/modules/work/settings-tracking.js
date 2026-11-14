// Settings → Tracking link (cfg/tracking, settings:general; docs/CRM-WORK.md
// "Tracking link"): On my way's text carries a link to an "on the way"
// page; whether it does, and the vehicle each person drives (shown on the
// page only when "Show the vehicle" is on). The live dot also needs the
// team map (Settings → Maps and the team map).

import { html, attrs, toast } from "../../core/ui.js";
import { busy } from "../../core/forms.js";
import { loadDoc, saveDoc } from "../system/kit.js";

async function load(params, ctx) {
  const [doc, users] = await Promise.all([loadDoc(ctx, "tracking"), ctx.api("/users", { cache: false }).catch(() => ({ data: [] }))]);
  const people = (users.data || []).filter((u) => u.status === "active" && (u.is_technician || u.role !== "admin"));
  return { doc, people };
}

export default {
  title: "Tracking link",
  load,
  render(s) {
    const d = s.doc.data || {};
    const v = d.vehicles || {};
    return html`<form class="stack" data-tracking novalidate>
      <div class="card form">
        <h2>On my way's link</h2>
        <p class="small">When someone taps On my way, the customer's text gets a short link to a page with their first name, the time they should arrive and, while they drive, a dot on a small map. The dot needs the team map on and the person clocked in; it stops when the visit starts and after ${d.location_minutes || 120} minutes. The page never shows other customers, the route, or where they were before.</p>
        <label class="check"><input ${attrs({ type: "checkbox", name: "enabled", checked: d.enabled !== false })}><span><strong>Add the tracking link to On my way</strong></span></label>
        <label class="check"><input ${attrs({ type: "checkbox", name: "show_vehicle", checked: !!d.show_vehicle })}><span><strong>Show the vehicle</strong> so the customer knows who's pulling up</span></label>
      </div>
      <div class="card form">
        <h2>Vehicles</h2>
        ${s.people.length ? s.people.map((u) => html`<label class="field"><span>${u.name}</span><input ${attrs({ name: "v_" + u.id, value: v[u.id] || "", maxlength: 60, placeholder: "e.g. a white Ford Transit" })}></label>`) : html`<p class="small muted">Add the team first.</p>`}
      </div>
      <button type="submit" class="btn primary block">Save</button>
    </form>`;
  },
  events: {
    "submit [data-tracking]": async (e, form, ctx) => {
      e.preventDefault();
      const s = ctx.state;
      const f = form.elements;
      const vehicles = {};
      for (const u of s.people) { const x = f["v_" + u.id]; if (x && x.value.trim()) vehicles[u.id] = x.value.trim(); }
      const value = { ...(s.doc.data || {}), enabled: f.enabled.checked, show_vehicle: f.show_vehicle.checked, vehicles };
      const btn = form.querySelector("[type=submit]");
      busy(btn, true);
      try { await saveDoc(ctx, s.doc, value); toast("Saved"); busy(btn, false); }
      catch (err) { busy(btn, false); toast(err.message, { bad: true }); }
    },
  },
};
