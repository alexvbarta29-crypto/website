// Settings → Door to door (settings:general; docs/CRM-MAP.md): the pin
// types (Rotor's eight came over with the import: name, color, what a knock
// of the type counts as, on or off) and, for owners, who may knock doors
// (owners and the office always may; a technician when an owner turns it on
// here, which is a per-person permission: their phones sign in again once).

import { html, attrs, toast } from "../../core/ui.js";
import { busy } from "../../core/forms.js";
import { roleLabel } from "../../core/format.js";
import { loadDoc, saveDoc } from "../system/kit.js";
import { ensureStyles, OUTCOME_LABELS, OUTCOMES } from "./kit.js";

const PALETTE = ["#808080", "#e5484d", "#d0b116", "#7c4dff", "#03ad00", "#2a78d6", "#16161b", "#aa15ef", "#ff8a00", "#0f766e"];
const slug = (s) => String(s || "").toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "").slice(0, 30) || "type";

async function load(params, ctx) {
  ensureStyles();
  const owner = ctx.can("settings:owner") && ctx.can("users:manage");
  const [doc, start, users] = await Promise.all([
    loadDoc(ctx, "pin_types"),
    ctx.api("/map/knock", { cache: false }).catch(() => null),
    owner ? ctx.api("/users", { cache: false }).catch(() => null) : null,
  ]);
  // what the map uses: the saved types with their keys and outcomes worked out, else Barta's defaults
  const types = (start && start.data && start.data.types) || [];
  const rotor = new Map((doc.data.types || []).filter((t) => t.rotor_id).map((t) => [t.rotor_id, t.rotor_id]));
  return { doc, rows: types.map((t) => ({ ...t, rotor_id: rotor.get(t.rotor_id) || t.rotor_id || "" })), owner, users: users ? (users.data || []).filter((u) => u.status === "active") : [] };
}

function typeRow(t, i) {
  const colors = [...new Set([t.color, ...PALETTE])];
  return html`<li class="mp-type-row" ${attrs({ "data-row": String(i) })}>
    <label class="field"><span>Name</span><input ${attrs({ name: "label_" + i, value: t.label, maxlength: "40" })}></label>
    <label class="field"><span>Color</span><select ${attrs({ name: "color_" + i })}>${colors.map((c) => html`<option ${attrs({ value: c, selected: c === t.color })}>${c}</option>`)}</select></label>
    <label class="field"><span>Counts as</span><select ${attrs({ name: "outcome_" + i })}>${OUTCOMES.map((o) => html`<option ${attrs({ value: o, selected: o === t.outcome })}>${OUTCOME_LABELS[o]}</option>`)}</select></label>
    <label class="check"><input ${attrs({ type: "checkbox", name: "active_" + i, checked: t.active !== false })}><span>In use</span></label>
  </li>`;
}

export default {
  title: "Door to door",
  load,
  render(s) {
    return html`<div class="stack">
      <form class="card form" data-types novalidate>
        <p class="small">The buttons a canvasser taps at a door. "Counts as" decides the report: a door is every knock; No answer and Don't knock aren't conversations.</p>
        <ul class="mp-type-list">${s.rows.map((t, i) => typeRow(t, i))}</ul>
        <button type="button" class="btn" data-add>Add a type</button>
        <button type="submit" class="btn primary block">Save the pin types</button>
      </form>
      ${s.owner ? html`<div class="section-h">Who can knock doors</div>
        <div class="card">
          <p class="small muted">Owners and the office always can. Turning it on for a technician gives them the door-to-door map (from Today) and Convert to lead; they'll sign in again once on their phones.</p>
          <ul class="mp-people-perm">${s.users.map((u) => {
            const always = u.role !== "tech";
            return html`<li><label class="check"><input ${attrs({ type: "checkbox", "data-grant": u.id, checked: always || !!u.canvass, disabled: always })}><span>${u.name} <span class="muted small">${roleLabel(u.role)}${always ? " · always" : ""}</span></span></label></li>`;
          })}</ul>
        </div>` : ""}
    </div>`;
  },
  async mount(el, s, ctx) {
    // the technicians' current grants (one read each, owners only)
    if (!s.owner || s.grantsRead) return;
    s.grantsRead = true;
    for (const u of s.users.filter((x) => x.role === "tech")) {
      try {
        const r = await ctx.api(`/users/${encodeURIComponent(u.id)}`, { cache: false });
        u.canvass = (r.data.grants || []).includes("canvass:use") && !(r.data.denies || []).includes("canvass:use");
        const box = el.querySelector(`[data-grant="${u.id}"]`);
        if (box) box.checked = u.canvass;
      } catch (e) { /* stays off */ }
    }
  },
  events: {
    "click [data-add]": (e, b, ctx) => {
      ctx.state.rows.push({ key: "", label: "New type", color: PALETTE[ctx.state.rows.length % PALETTE.length], outcome: "talked", active: true });
      ctx.rerender();
    },
    "submit [data-types]": async (e, form, ctx) => {
      e.preventDefault();
      const s = ctx.state;
      const btn = form.querySelector("[type=submit]");
      const used = new Set(s.rows.map((t) => t.key).filter(Boolean));
      const types = s.rows.map((t, i) => {
        const label = String(form.elements["label_" + i].value || "").trim().slice(0, 40);
        let key = t.key;
        if (!key) { key = "c_" + slug(label); let n = 2; while (used.has(key)) key = "c_" + slug(label).slice(0, 26) + "_" + n++; used.add(key); }
        return { key, label, color: form.elements["color_" + i].value, outcome: form.elements["outcome_" + i].value, active: form.elements["active_" + i].checked, ...(t.rotor_id ? { rotor_id: t.rotor_id } : {}) };
      }).filter((t) => t.label);
      if (!types.some((t) => t.active)) { toast("Keep at least one type in use.", { bad: true }); return; }
      busy(btn, true);
      try { await saveDoc(ctx, s.doc, { types }); toast("Pin types saved"); ctx.refresh(); }
      catch (err) { busy(btn, false); toast(err.message, { bad: true }); }
    },
    "change [data-grant]": async (e, box, ctx) => {
      const id = box.dataset.grant;
      box.disabled = true;
      try {
        const cur = await ctx.api(`/users/${encodeURIComponent(id)}`, { cache: false });
        const grants = new Set(cur.data.grants || []);
        const denies = new Set(cur.data.denies || []);
        if (box.checked) { grants.add("canvass:use"); denies.delete("canvass:use"); } else grants.delete("canvass:use");
        await ctx.api(`/users/${encodeURIComponent(id)}`, { method: "PATCH", ifMatch: cur.etag, body: { grants: [...grants], denies: [...denies] } });
        toast(box.checked ? "They can knock doors now" : "Door to door is off for them");
      } catch (err) { box.checked = !box.checked; toast(err.message, { bad: true }); }
      box.disabled = false;
    },
  },
};
