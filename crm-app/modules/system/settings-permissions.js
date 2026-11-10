// Settings → Team permissions (design §4.5, §4.12, D14, D18; owners only).
// What the office (admin) and technicians may do by default, one row per
// permission: Yes, Own (techs: only their own visits' records) or No. Owner
// permissions are fixed and can never be given away. Which roles' Team
// sign-in may also open the office tools (D14). Saving applies on every
// phone within seconds; nobody is signed out. A person's own grants and
// denies are on their Team page.

import { html, attrs, toast } from "../../core/ui.js";
import { loadDoc } from "./kit.js";

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
    const roles = (s.auth && s.auth.office_cookie_roles) || ["owner"];
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
      <div class="section-h">Office tools with Team sign-in</div>
      <form class="card form" id="office-roles">
        <p class="small">Whose Team sign-in may also open Lights, Purchases and the dashboards, when they type the office password once on that phone.</p>
        ${["owner", "admin", "tech"].map((r) => html`<label class="check"><input ${attrs({ type: "checkbox", name: r, checked: roles.includes(r) })}><span>${r === "owner" ? "Owners" : r === "admin" ? "Office" : "Technicians"}</span></label>`)}
        <button type="submit" class="btn dark block">Save</button>
      </form>
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
    "submit #office-roles": async (e, form, ctx) => {
      e.preventDefault();
      const roles = ["owner", "admin", "tech"].filter((r) => form.querySelector(`[name=${r}]`).checked);
      try {
        const doc = await loadDoc(ctx, "auth").catch(() => ({ name: "auth", etag: ctx.state.auth_etag || "new", data: ctx.state.auth }));
        const r = await ctx.api("/settings/auth", { method: "PUT", body: { ...doc.data, office_cookie_roles: roles }, ifMatch: doc.etag || "new" });
        ctx.state.auth = r.data.data;
        ctx.state.auth_etag = r.data.etag;
        toast("Saved");
      } catch (err) { toast(err.message, { bad: true }); }
    },
  },
};
