// My account (design §9.2, §9.3): your name and phone, your password, the
// phones you're signed in on (sign one out, or all of them), and the app
// version. API keys and notifications arrive with M1.3.

import { html, icon, toast, confirmSheet } from "../../core/ui.js";
import { field, readForm, clearErrors, showError, busy } from "../../core/forms.js";
import { ago, phone, roleLabel, initials } from "../../core/format.js";
import { APP_VERSION } from "../../version.js";

async function loadAll(ctx) {
  const me = await ctx.api(`/me`, { cache: false });
  const id = me.data.user.id;
  let sessions = [];
  try { sessions = (await ctx.api(`/users/${encodeURIComponent(id)}/sessions`)).data || []; } catch (e) { sessions = []; }
  return { user: me.data.user, etag: me.data.etag, sessions, offline: !!me.offline };
}

export default {
  title: "My account",
  async load(params, ctx) {
    return loadAll(ctx);
  },
  render(s) {
    const u = s.user;
    return html`<div class="stack">
      <div class="card"><div class="row" style="padding:0;min-height:0">
        <span class="avatar" style="${"background:" + (u.color || "#4a4a52")}">${initials(u.name)}</span>
        <span class="who"><span class="nm">${u.name}</span><span class="sub">${u.login} · ${roleLabel(u.role)}${u.is_technician && u.role !== "tech" ? " · in the field" : ""}</span></span>
      </div></div>

      <div class="section-h">Your details</div>
      <form class="card form" id="me-form" novalidate>
        <div class="err" data-form-err hidden></div>
        ${field({ label: "Name", name: "name", value: u.name, autocomplete: "name", autocapitalize: "words", required: true })}
        ${field({ label: "Mobile (for staff alerts)", name: "phone", type: "tel", value: u.phone ? phone(u.phone) : "", hint: "Only the office sees it." })}
        <button type="submit" class="btn primary block">Save</button>
      </form>

      <div class="section-h">Password</div>
      <form class="card form" id="pw-form" novalidate>
        <div class="err" data-form-err hidden></div>
        <input type="text" name="username" autocomplete="username" class="sr" tabindex="-1" aria-hidden="true" value="${u.login}" readonly>
        ${field({ label: "Current password", name: "current", type: "password", autocomplete: "current-password" })}
        ${field({ label: "New password", name: "next", type: "password", autocomplete: "new-password", hint: "At least 10 characters. Your other phones get signed out." })}
        <button type="submit" class="btn dark block">Change password</button>
      </form>

      <div class="section-h">Signed in on</div>
      ${s.sessions.length
        ? html`<ul class="list">${s.sessions.map((d) => html`<li><div class="row">
            ${icon("phone")}
            <span class="who"><span class="nm">${d.ua}${d.current ? " (this phone)" : ""}</span><span class="sub">Since ${ago(d.created_at)} · last used ${ago(d.last_seen_at)}</span></span>
            ${d.current ? "" : html`<span class="end"><button type="button" class="btn" data-end="${d.hash}">Sign out</button></span>`}
          </div></li>`)}</ul>`
        : html`<div class="card muted small">No other phones.</div>`}
      <div class="btn-row">
        <button type="button" class="btn danger" data-act="out">Sign out of this phone</button>
        <button type="button" class="btn" data-act="out-all">Sign out everywhere</button>
      </div>
      <p class="foot-note">Barta CRM ${APP_VERSION}</p>
    </div>`;
  },
  events: {
    "submit #me-form": async (e, form, ctx) => {
      e.preventDefault();
      clearErrors(form);
      const v = readForm(form);
      const btn = form.querySelector("button[type=submit]");
      busy(btn, true);
      try {
        const r = await ctx.api(`/users/${encodeURIComponent(ctx.state.user.id)}`, { method: "PATCH", body: { name: v.name, phone: v.phone }, ifMatch: ctx.state.etag });
        ctx.state.user = { ...ctx.state.user, ...r.data };
        ctx.state.etag = r.etag;
        toast("Saved");
        ctx.rerender();
      } catch (err) {
        busy(btn, false);
        if (err.status === 412) { toast("Someone else just changed this. Showing the latest.", { bad: true }); ctx.refresh(); return; }
        showError(form, err);
      }
    },
    "submit #pw-form": async (e, form, ctx) => {
      e.preventDefault();
      clearErrors(form);
      const v = readForm(form);
      const btn = form.querySelector("button[type=submit]");
      busy(btn, true);
      try {
        await ctx.api("/auth/password", { method: "POST", body: { current: v.current, next: v.next } });
        toast("Password changed. Your other phones are signed out.");
        ctx.refresh();
      } catch (err) {
        busy(btn, false);
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
    "click [data-act=out]": async () => {
      if (!(await confirmSheet("You'll need your login and password to get back in.", { title: "Sign out of this phone?", yes: "Sign out", danger: true }))) return;
      window.__crm.signOut();
    },
    "click [data-act=out-all]": async () => {
      if (!(await confirmSheet("Every phone and computer signed in as you gets signed out, this one too.", { title: "Sign out everywhere?", yes: "Sign out everywhere", danger: true }))) return;
      window.__crm.signOut({ everywhere: true });
    },
  },
};
