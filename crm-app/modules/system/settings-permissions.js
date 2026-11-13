// Settings → Team permissions (design §4.5, §4.12, D14, D18; owners only).
// What the office (admin) and technicians may do by default, one row per
// permission: Yes, Own (techs: only their own visits' records) or No. Owner
// permissions are fixed and can never be given away. The office tools come
// with the sign-in of owners and the office, never techs (core/auth.mjs; no
// setting since Nov 2026, D14's roles are gone). Saving applies on every
// phone within seconds; nobody is signed out. A person's own grants and
// denies are on their Team page.

import { html, attrs, toast } from "../../core/ui.js";

const VAL = { true: "Yes", own: "Own", false: "No" };
const asKey = (v) => (v === true ? "true" : v === "own" ? "own" : "false");
const fromKey = (k) => (k === "true" ? true : k === "own" ? "own" : false);

export default {
  title: "Team permissions",
  async load(params, ctx) {
    const r = await ctx.api("/permissions", { cache: false });
    return { ...r.data, roles: JSON.parse(JSON.stringify((r.data.permissions && r.data.permissions.roles) || {})), dirty: false };
  },
  render(s) {
    const groups = new Map();
    for (const p of s.catalog) { if (!groups.has(p.group)) groups.set(p.group, []); groups.get(p.group).push(p); }
    const cur = (role, p) => (s.roles[role] && Object.hasOwn(s.roles[role], p.key) ? s.roles[role][p.key] : p.defaults[role]);
    const cell = (role, p) => {
      if (p.owner_only) return html`<span class="lock">Owners</span>`;
      const v = cur(role, p);
      const opts = role === "tech" ? ["true", "own", "false"] : ["true", "false"];
      return html`<select ${attrs({ "data-role": role, "data-perm": p.key, "aria-label": `${role === "admin" ? "Office" : "Technicians"}: ${p.label}` })}>${opts.map((o) => html`<option ${attrs({ value: o, selected: asKey(v) === o })}>${VAL[o]}</option>`)}</select>`;
    };
    return html`<div class="stack">
      <div class="note">Changes apply on every phone within seconds. Nobody gets signed out.</div>
      ${[...groups.entries()].map(([g, list]) => html`<div><div class="section-h">${g}</div><div class="card" style="padding:6px 10px">
        <table class="perm-table"><thead><tr><th>Can</th><th>Office</th><th>Techs</th></tr></thead>
        <tbody>${list.map((p) => html`<tr><td>${p.label}</td><td>${cell("admin", p)}</td><td>${cell("tech", p)}</td></tr>`)}</tbody></table>
      </div></div>`)}
      <button type="button" class="btn primary block" data-save-perms>Save permissions</button>
      <div class="section-h">Office tools</div>
      <div class="note">Owners and the office get Lights, Purchases, the Giveaway and the dashboards with their own sign-in. Technicians never do.</div>
    </div>`;
  },
  events: {
    "change [data-perm]": (e, el, ctx) => {
      const role = el.getAttribute("data-role");
      const key = el.getAttribute("data-perm");
      const p = ctx.state.catalog.find((x) => x.key === key);
      const v = fromKey(el.value);
      const roles = ctx.state.roles;
      roles[role] = roles[role] || {};
      if (p && v === p.defaults[role]) delete roles[role][key]; else roles[role][key] = v;
      ctx.state.dirty = true;
    },
    "click [data-save-perms]": async (e, btn, ctx) => {
      btn.disabled = true;
      try {
        const r = await ctx.api("/settings/permissions", { method: "PUT", body: { ...(ctx.state.permissions || {}), roles: ctx.state.roles }, ifMatch: ctx.state.permissions_etag || "new" });
        ctx.state.permissions = r.data.data;
        ctx.state.permissions_etag = r.data.etag;
        ctx.state.dirty = false;
        toast("Saved");
      } catch (err) {
        if (err.status === 412) { toast("Someone else just changed these. Showing the latest.", { bad: true }); ctx.refresh(); } else toast(err.message, { bad: true });
      }
      btn.disabled = false;
    },
  },
};
