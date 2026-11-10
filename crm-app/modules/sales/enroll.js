// Start a follow-up for a contact (design §5.2 POST /enrollments): pick a
// cadence (the new-lead one, the estimate follow-up...). One open per
// contact and cadence: an open one is shown instead of a second.

import { html, attrs, toast } from "../../core/ui.js";
import { busy } from "../../core/forms.js";
import { ensureStyles, enrollmentPill, emptyCard } from "./kit.js";

async function load(params, ctx) {
  ensureStyles();
  const r = await ctx.api(`/sales/contacts/${encodeURIComponent(params.contact)}`, { cache: false });
  return { ...r.data, pick: ctx.keep.pick || (r.data.cadences[0] && r.data.cadences[0].key) || "" };
}

export default {
  title: "Start a follow-up",
  load,
  render(s) {
    const open = (s.enrollments || []).filter((e) => ["active", "paused"].includes(e.status));
    if (!s.cadences.length) return emptyCard("No cadence to start", "Turn one on in Settings → Cadences.", "phone");
    return html`<div class="stack">
      <p class="muted">For <b>${s.contact.name}</b></p>
      ${open.length ? html`<div class="note">Already following up: ${open.map((e) => e.cadence_name).join(", ")}. Starting the same cadence again opens that one.</div>` : ""}
      <div class="list">${s.cadences.map((c) => html`<label class="row check" style="margin:0;padding:10px 14px;align-items:center">
        <input ${attrs({ type: "radio", name: "cadence", value: c.key, checked: s.pick === c.key })}>
        <span class="who"><span class="nm">${c.name}</span></span>
        ${open.some((e) => e.cadence_key === c.key) ? enrollmentPill("active") : ""}
      </label>`)}</div>
      <button type="button" class="btn primary block" data-start>Start</button>
    </div>`;
  },
  events: {
    "change [name=cadence]": (e, el, ctx) => { ctx.state.pick = el.value; ctx.keep.pick = el.value; },
    "click [data-start]": async (e, el, ctx) => {
      const key = ctx.state.pick;
      if (!key) { toast("Pick a cadence.", { bad: true }); return; }
      busy(el, true, "Starting…");
      try {
        const r = await ctx.api("/enrollments", { method: "POST", body: { contact_id: ctx.state.contact.id, cadence_key: key } });
        toast("Started");
        ctx.go(`/enrollments/${encodeURIComponent(r.data.enrollment.id)}`, { replace: true });
      } catch (err) { busy(el, false); toast(err.message, { bad: true }); }
    },
  },
};
