// One person on the team (owners only; design §4.4, §4.11): role and
// field work, an invite or reset link, disable/enable, and the phones they
// are signed in on. A role change or a disable signs them out everywhere
// within seconds (the server bumps their session epoch).

import { html, icon, toast, confirmSheet } from "../../core/ui.js";
import { select, checkbox, readForm, clearErrors, showError, busy } from "../../core/forms.js";
import { ago, phone, roleLabel, initials, dateShort } from "../../core/format.js";
import { ROLE_OPTIONS, linkSheet, expiresLabel } from "./team.js";

export default {
  title: (s) => (s && s.user ? s.user.first_name || s.user.name : "Person"),
  async load(params, ctx) {
    const id = encodeURIComponent(params.id);
    const r = await ctx.api(`/users/${id}`, { cache: false });
    let sessions = [];
    try { sessions = (await ctx.api(`/users/${id}/sessions`, { cache: false })).data || []; } catch (e) { sessions = []; }
    return { user: r.data, etag: r.etag, sessions, me: ctx.user && ctx.user.id === r.data.id };
  },
  render(s) {
    const u = s.user;
    const pending = u.invite && u.invite.expires_at;
    return html`<div class="stack">
      <div class="card">
        <div class="row" style="padding:0;min-height:0">
          <span class="avatar" style="${"background:" + (u.color || "#4a4a52")}">${initials(u.name)}</span>
          <span class="who"><span class="nm">${u.name}</span><span class="sub">${u.login} · ${roleLabel(u.role)}</span></span>
          <span class="end">${u.status === "active" ? html`<span class="pill green">Active</span>` : u.status === "invited" ? html`<span class="pill amber">Invited</span>` : html`<span class="pill red">Off</span>`}</span>
        </div>
        <dl class="kv" style="margin-top:14px">
          <dt>Last sign-in</dt><dd>${u.last_sign_in_at ? ago(u.last_sign_in_at) : "Never"}</dd>
          ${u.phone ? html`<dt>Mobile</dt><dd>${phone(u.phone)}</dd>` : ""}
          ${pending ? html`<dt>${u.invite.kind === "reset" ? "Reset link" : "Invite link"}</dt><dd>Runs out ${dateShort(u.invite.expires_at)}</dd>` : ""}
        </dl>
        ${u.status === "invited" ? html`<div class="btn-row"><button type="button" class="btn primary" data-act="invite">${icon("share")}${pending ? "New invite link" : "Make an invite link"}</button></div>` : ""}
        ${u.status === "active" && !s.me ? html`<div class="btn-row"><button type="button" class="btn" data-act="reset">${icon("key")}Password reset link</button></div>` : ""}
      </div>

      ${s.me ? "" : html`<div class="section-h">Role</div>
      <form class="card form" id="role-form" novalidate>
        <div class="err" data-form-err hidden></div>
        ${select({ label: "Role", name: "role", value: u.role, options: ROLE_OPTIONS })}
        ${checkbox({ label: "Goes out on visits (can be scheduled)", name: "is_technician", checked: !!u.is_technician })}
        <button type="submit" class="btn dark block">Save role</button>
      </form>`}

      <div class="section-h">Signed in on</div>
      ${s.sessions.length
        ? html`<ul class="list">${s.sessions.map((d) => html`<li><div class="row">${icon("phone")}<span class="who"><span class="nm">${d.ua}</span><span class="sub">Since ${ago(d.created_at)} · last used ${ago(d.last_seen_at)}</span></span><span class="end"><button type="button" class="btn" data-end="${d.hash}">Sign out</button></span></div></li>`)}</ul>`
        : html`<div class="card muted small">Not signed in anywhere.</div>`}

      ${s.me ? "" : html`<div class="btn-row">${u.status === "disabled"
        ? html`<button type="button" class="btn primary" data-act="enable">Turn their login back on</button>`
        : html`<button type="button" class="btn danger" data-act="disable">Turn off their login</button>`}</div>`}
    </div>`;
  },
  events: {
    "click [data-act=invite]": (e, btn, ctx) => link(ctx, btn, "invite"),
    "click [data-act=reset]": async (e, btn, ctx) => {
      if (!(await confirmSheet(`They get signed out everywhere until they pick a new password with the link.`, { title: `Reset ${ctx.state.user.first_name || "their"} password?`, yes: "Make the link" }))) return;
      link(ctx, btn, "reset");
    },
    "submit #role-form": async (e, form, ctx) => {
      e.preventDefault();
      clearErrors(form);
      const v = readForm(form);
      const btn = form.querySelector("button[type=submit]");
      busy(btn, true);
      try {
        await ctx.api(`/users/${encodeURIComponent(ctx.state.user.id)}`, { method: "PATCH", body: { role: v.role, is_technician: !!v.is_technician }, ifMatch: ctx.state.etag });
        toast("Saved");
        ctx.refresh();
      } catch (err) {
        busy(btn, false);
        if (err.status === 412) { toast("Someone else just changed this. Showing the latest.", { bad: true }); ctx.refresh(); return; }
        showError(form, err);
      }
    },
    "click [data-end]": async (e, btn, ctx) => {
      btn.disabled = true;
      try {
        await ctx.api(`/users/${encodeURIComponent(ctx.state.user.id)}/sessions/${encodeURIComponent(btn.dataset.end)}`, { method: "DELETE" });
        toast("Signed out that phone");
        ctx.refresh();
      } catch (err) { btn.disabled = false; toast(err.message, { bad: true }); }
    },
    "click [data-act=disable]": async (e, btn, ctx) => {
      const name = ctx.state.user.first_name || ctx.state.user.name;
      if (!(await confirmSheet(`${name} gets signed out everywhere and can't sign in until you turn it back on.`, { title: `Turn off ${name}'s login?`, yes: "Turn off", danger: true }))) return;
      await status(ctx, btn, "disable");
    },
    "click [data-act=enable]": (e, btn, ctx) => status(ctx, btn, "enable"),
  },
};

async function link(ctx, btn, kind) {
  btn.disabled = true;
  try {
    const r = await ctx.api(`/users/${encodeURIComponent(ctx.state.user.id)}/${kind}`, { method: "POST", body: {} });
    const name = ctx.state.user.first_name || ctx.state.user.name;
    linkSheet({ title: kind === "reset" ? `Reset link for ${name}` : `Invite ${name}`, link: r.data.link, name, expires: expiresLabel(r.data.expires_at) });
    ctx.refresh();
  } catch (err) { toast(err.message, { bad: true }); }
  btn.disabled = false;
}

async function status(ctx, btn, what) {
  btn.disabled = true;
  try {
    await ctx.api(`/users/${encodeURIComponent(ctx.state.user.id)}/${what}`, { method: "POST", body: {} });
    toast(what === "disable" ? "Login turned off" : "Login turned back on");
    ctx.refresh();
  } catch (err) { btn.disabled = false; toast(err.message, { bad: true }); }
}
