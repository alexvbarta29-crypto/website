// Team (design §4.4, §9.2 "Team & permissions"; owners only): everyone
// with a login, their role and whether they have signed in yet. "Add"
// creates the person (status invited) and hands back a one-time invite link
// to text or AirDrop; they open it, pick a password and are in.

import { html, icon, sheet, toast } from "../../core/ui.js";
import { field, select, checkbox, readForm, clearErrors, showError, busy } from "../../core/forms.js";
import { roleLabel, initials } from "../../core/format.js";

export const ROLE_OPTIONS = [
  { value: "tech", label: "Technician (their own visits, time and pay)" },
  { value: "admin", label: "Office (everything but owner settings)" },
  { value: "owner", label: "Owner (everything)" },
];
const statusPill = (s) => (s === "active" ? html`<span class="pill green">Active</span>` : s === "invited" ? html`<span class="pill amber">Invited</span>` : html`<span class="pill red">Off</span>`);

// Shows a one-time link with Copy and Share (shared by Team and Person).
export function linkSheet({ title, link, name, expires }) {
  const text = `Barta CRM: set your password here (works once, for 7 days): ${link}`;
  const canShare = typeof navigator !== "undefined" && !!navigator.share;
  const s = sheet({
    title,
    body: html`<p class="muted">Send this to ${name} by text or AirDrop. It works once and runs out ${expires}.</p>
      <div class="copy-box"><input type="text" readonly value="${link}" aria-label="Invite link" data-link><button type="button" class="btn dark" data-copy>${icon("copy")}Copy</button></div>
      ${canShare ? html`<div class="btn-row"><button type="button" class="btn primary" data-share>${icon("share")}Share</button></div>` : ""}
      <p class="small muted">Tip: they should add Barta Office to their home screen afterwards and sign in there too.</p>`,
    events: {
      "click [data-copy]": async () => {
        const input = s.el.querySelector("[data-link]");
        try { await navigator.clipboard.writeText(link); toast("Link copied"); }
        catch (e) { input.select(); try { document.execCommand("copy"); toast("Link copied"); } catch (x) { toast("Press and hold the link to copy it."); } }
      },
      "click [data-share]": async () => { try { await navigator.share({ title: "Barta CRM", text }); } catch (e) { /* closed */ } },
    },
  });
  return s;
}

export const expiresLabel = (iso) => {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? "in 7 days" : "on " + d.toLocaleDateString("en-US", { weekday: "short", month: "short", day: "numeric", timeZone: "America/Chicago" });
};

function addSheet(ctx) {
  const s = sheet({
    title: "Add a person",
    body: html`<form class="form" id="add-form" novalidate>
      <div class="err" data-form-err hidden></div>
      ${field({ label: "Name", name: "name", autocomplete: "off", autocapitalize: "words", required: true })}
      ${field({ label: "Login", name: "login", autocapitalize: "none", autocorrect: "off", spellcheck: "false", hint: "Lowercase, like gustov. They type it to sign in.", required: true })}
      ${select({ label: "Role", name: "role", value: "tech", options: ROLE_OPTIONS })}
      ${checkbox({ label: "Goes out on visits (can be scheduled)", name: "is_technician", checked: true })}
      ${field({ label: "Mobile (optional, for staff alerts)", name: "phone", type: "tel" })}
      <button type="submit" class="btn primary block">Add and make an invite link</button>
    </form>`,
    events: {
      "input [name=name]": (e, input) => {
        const login = s.el.querySelector("[name=login]");
        if (login.dataset.touched) return;
        login.value = String(input.value || "").trim().split(/\s+/)[0].toLowerCase().replace(/[^a-z0-9.-]/g, "");
      },
      "input [name=login]": (e, input) => { input.dataset.touched = "1"; },
      "submit #add-form": async (e, form) => {
        e.preventDefault();
        clearErrors(form);
        const v = readForm(form);
        const btn = form.querySelector("button[type=submit]");
        busy(btn, true, "Adding…");
        try {
          const made = await ctx.api("/users", { method: "POST", body: { name: v.name, login: v.login, role: v.role, is_technician: !!v.is_technician, phone: v.phone || undefined } });
          const inv = await ctx.api(`/users/${encodeURIComponent(made.data.id)}/invite`, { method: "POST", body: {} });
          s.close();
          ctx.refresh();
          linkSheet({ title: `Invite ${made.data.first_name || made.data.name}`, link: inv.data.link, name: made.data.first_name || made.data.name, expires: expiresLabel(inv.data.expires_at) });
        } catch (err) {
          busy(btn, false);
          showError(form, err);
        }
      },
    },
  });
}

export default {
  title: "Team",
  async load(params, ctx) {
    const r = await ctx.api("/users");
    return { users: r.data || [], offline: !!r.offline };
  },
  action(s, ctx) {
    return { label: "Add", run: () => addSheet(ctx) };
  },
  render(s) {
    const groups = [["Owners", "owner"], ["Office", "admin"], ["Technicians", "tech"]];
    return html`<div class="stack">
      ${groups.map(([label, role]) => {
        const list = s.users.filter((u) => u.role === role);
        if (!list.length) return "";
        return html`<div><div class="section-h">${label}</div><ul class="list">${list.map((u) => html`<li><a class="row" href="${"#/team/" + encodeURIComponent(u.id)}">
          <span class="avatar" style="${"background:" + (u.color || "#4a4a52")}">${initials(u.name)}</span>
          <span class="who"><span class="nm">${u.name}</span><span class="sub">${u.login} · ${roleLabel(u.role)}${u.is_technician && u.role !== "tech" ? " · in the field" : ""}</span></span>
          <span class="end">${statusPill(u.status)}<span class="chev" aria-hidden="true"></span></span>
        </a></li>`)}</ul></div>`;
      })}
      ${s.users.length <= 1 ? html`<div class="card empty"><div class="art">${icon("team")}</div><h2>Add your team</h2><p>Tap Add for each person. They each get their own login and an invite link to set a password.</p></div>` : ""}
    </div>`;
  },
};
