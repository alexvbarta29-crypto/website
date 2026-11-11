// My account (design §9.2, §9.3, §5.7.7, §4.9): your name and phone, your
// password, the phones you're signed in on (sign one out, or all of them),
// which notifications reach you and how, push on this phone (the office
// app asks iOS for permission: only the installed app's own page may), your
// API keys (owners and the office), and the app version.

import { html, icon, toast, confirmSheet, sheet, attrs } from "../../core/ui.js";
import { field, readForm, clearErrors, showError, busy, select, checkbox } from "../../core/forms.js";
import { ago, phone, roleLabel, initials, dateShort } from "../../core/format.js";
import { APP_VERSION } from "../../version.js";
import { MODE_LABEL } from "./kit.js";

// The notification settings people see (user.notify keys) and who sees each.
const NOTIFY = [
  { key: "new_lead", label: "New leads", perm: "contacts:read_all" },
  { key: "reply", label: "Replies to texts", perm: "inbox:read" },
  { key: "approval", label: "Approvals waiting", perm: "pending_actions:approve" },
  { key: "payment", label: "Payments", perm: "invoices:read_all" },
  { key: "agreement_signed", label: "Agreements signed", perm: "plans:read" },
  { key: "review", label: "New Google reviews", perm: "reviews:read" },
  { key: "work", label: "My visits and tasks", perm: "account:own" },
  { key: "system", label: "Alerts from the CRM", perm: "account:own" },
];
const DEFAULT_ON = new Set(["new_lead", "reply", "approval", "work", "system"]);
const framed = (() => { try { return window.parent !== window; } catch (e) { return true; } })();

async function loadAll(ctx) {
  const me = await ctx.api(`/me`, { cache: false });
  const id = me.data.user.id;
  const [sessions, push, keys] = await Promise.all([
    ctx.api(`/users/${encodeURIComponent(id)}/sessions`).then((r) => r.data || []).catch(() => []),
    ctx.api("/push/subscriptions", { cache: false }).then((r) => r.data).catch(() => null),
    ctx.can("api_keys:own") ? ctx.api("/api-keys", { cache: false }).catch(() => ({ data: [] })) : null,
  ]);
  return { user: me.data.user, etag: me.data.etag, sessions, push, keys: keys ? keys.data || [] : null, scopes: (keys && keys.meta && keys.meta.scopes) || { read: [], write: [], defaults: [] }, offline: !!me.offline };
}

const pushOn = (u, key) => {
  const v = u.notify && Array.isArray(u.notify[key]) ? u.notify[key] : null;
  return v ? v.includes("push") : DEFAULT_ON.has(key);
};

// The new-key sheet (§4.9): read permissions ticked by default, write
// permissions ticked one by one (only ones the person holds and a key may
// carry). The "path" kind arrives with the MCP connector (M7c); a backup key
// (owners) carries export:all only and shows no scopes.
function newKeySheet(ctx) {
  const owner = ctx.user && ctx.user.role === "owner";
  const sc = ctx.state.scopes || { read: [], write: [], defaults: [] };
  const box = (p, on) => html`<label class="check"><input ${attrs({ type: "checkbox", name: `scope_${p.key}`, checked: on })}><span>${p.label}</span></label>`;
  const s = sheet({
    title: "New API key",
    body: html`<form class="form" data-newkey novalidate>
      <div class="err" data-form-err hidden></div>
      ${field({ label: "Name (what it's for)", name: "name", value: "Claude", required: true })}
      ${select({ label: "Kind", name: "kind", value: "header", options: [{ value: "header", label: "For Claude and tools (sent in a header)" }, ...(owner ? [{ value: "backup", label: "Off-site backup (owners)" }] : [])] })}
      ${field({ label: "Expires after (days)", name: "expires_days", value: "90", inputmode: "numeric" })}
      <div data-scopes>
        <div class="section-h">It can read</div>
        ${sc.read.length ? sc.read.map((p) => box(p, sc.defaults.includes(p.key))) : html`<p class="small muted">Nothing to read yet.</p>`}
        ${sc.write.length ? html`<div class="section-h">It can also change (tick only what it needs)</div>${sc.write.map((p) => box(p, false))}` : ""}
      </div>
      <p class="small muted">Never more than you can do. Texting, charging and anything that reaches a customer always waits for an owner's OK.</p>
      <button type="submit" class="btn primary block">Make the key</button>
    </form>`,
    events: {
      "change [name=kind]": (e, el) => { const d = s.el.querySelector("[data-scopes]"); if (d) d.hidden = el.value === "backup"; },
      "submit [data-newkey]": async (e, form) => {
        e.preventDefault();
        clearErrors(form);
        const v = readForm(form);
        const btn = form.querySelector("button[type=submit]");
        const scopes = [...sc.read, ...sc.write].map((p) => p.key).filter((k) => v[`scope_${k}`]);
        if (v.kind !== "backup" && !scopes.length) { showError(form, { message: "Tick at least one thing it may do.", field: null }); return; }
        busy(btn, true);
        try {
          const r = await ctx.api("/api-keys", { method: "POST", body: { name: v.name, kind: v.kind, expires_days: Number(v.expires_days || 90), ...(v.kind === "backup" ? {} : { scopes }) } });
          s.set(html`<div class="stack"><div class="warn-box">Copy it now. It's shown only this once.</div>
            <div class="copy-box"><input type="text" readonly ${attrs({ value: r.data.key, "aria-label": "API key" })} data-key><button type="button" class="btn dark" data-copy>${icon("copy")}Copy</button></div>
            <p class="small muted">${r.data.name} · ${r.data.kind} · expires ${r.data.expires_at ? dateShort(r.data.expires_at) : "never"}</p></div>`);
          ctx.state.keys = null;
        } catch (err) { busy(btn, false); showError(form, err); }
      },
      "click [data-copy]": async () => {
        const input = s.el.querySelector("[data-key]");
        try { await navigator.clipboard.writeText(input.value); toast("Key copied"); } catch (e) { input.select(); toast("Press and hold to copy it."); }
      },
    },
    onClose: () => { if (ctx.state.keys === null) ctx.refresh(); },
  });
}

// Changes made offline that haven't gone out yet go with a sign-out (§2.5): say how many.
const unsent = () => (window.__crm && typeof window.__crm.unsent === "function" ? window.__crm.unsent() : Promise.resolve(0));
const unsentNote = (n) => (n ? ` ${n === 1 ? "1 change hasn't" : `${n} changes haven't`} gone out yet; signing out deletes ${n === 1 ? "it" : "them"} from this phone.` : "");

export default {
  title: "My account",
  async load(params, ctx) {
    return loadAll(ctx);
  },
  render(s, ctx) {
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

      <div class="section-h">Notifications</div>
      <form class="card form" id="notify-form">
        <p class="small">They always show under the bell on Today. Tick the ones you also want on your phone.</p>
        ${NOTIFY.filter((n) => !n.perm || ctx.can(n.perm)).map((n) => checkbox({ label: n.label, name: `n_${n.key}`, checked: pushOn(u, n.key) }))}
        <button type="submit" class="btn dark block">Save</button>
      </form>

      <div class="section-h">This phone</div>
      <div class="card">
        ${!s.push ? html`<p class="small muted">Couldn't check notifications on this phone.</p>`
          : s.push.mode === "off" ? html`<p class="small">Push notifications aren't switched on for the CRM yet (the owner adds the keys in Netlify). The bell still shows everything.</p>`
          : html`<p class="small">Push: ${MODE_LABEL[s.push.mode] || s.push.mode}${s.push.mode === "dry_run" ? " (this isn't the live site: pushes go to the outbox)" : ""}. ${s.push.subscriptions.length ? `${s.push.subscriptions.length} phone${s.push.subscriptions.length === 1 ? "" : "s"} get them.` : "No phone gets them yet."}</p>
            <div class="btn-row">
              ${s.push.vapid_public || s.push.mode === "dry_run" ? html`<button type="button" class="btn primary" data-push-on>Turn on for this phone</button>` : ""}
              ${s.push.subscriptions.length ? html`<button type="button" class="btn" data-push-test>Send a test</button>` : ""}
            </div>
            <p class="small muted" data-push-status hidden></p>
            ${s.push.subscriptions.length ? html`<ul class="list" style="margin-top:12px">${s.push.subscriptions.map((p) => html`<li><div class="row">${icon("bell")}<span class="who"><span class="nm">${p.ua}</span><span class="sub">${p.last_ok_at ? "Last push " + ago(p.last_ok_at) : "Added " + ago(p.created_at)}</span></span><span class="end"><button type="button" class="btn" data-push-del="${p.hash}">Remove</button></span></div></li>`)}</ul>` : ""}`}
      </div>

      ${s.keys ? html`<div class="section-h">API keys</div>
        <div class="card">
          <p class="small">For Claude (MCP) and command-line tools. Each key can do only what you can, and anything that texts, emails or charges waits for an owner's OK.</p>
          ${s.keys.length ? html`<ul class="list">${s.keys.map((k) => html`<li><div class="row">${icon("key")}<span class="who"><span class="nm">${k.name}</span><span class="sub">${k.kind} · …${k.last4} · ${k.last_used_at ? "used " + ago(k.last_used_at) : "never used"}${k.expires_at ? " · expires " + dateShort(k.expires_at) : ""}</span></span><span class="end"><button type="button" class="btn danger" data-key-del="${k.id}">Revoke</button></span></div></li>`)}</ul>` : ""}
          <div class="btn-row"><button type="button" class="btn dark" data-key-new>${icon("plus")}New key</button></div>
        </div>` : ""}

      <div class="section-h">Signed in on</div>
      ${s.sessions.length
        ? html`<ul class="list">${s.sessions.map((d) => html`<li><div class="row">
            ${icon("phone")}
            <span class="who"><span class="nm">${d.ua}${d.current ? " (this phone)" : ""}</span><span class="sub">Last used ${ago(d.last_seen_at)}</span></span>
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
    "submit #notify-form": async (e, form, ctx) => {
      e.preventDefault();
      const u = ctx.state.user;
      const notify = { ...(u.notify || {}) };
      for (const n of NOTIFY) {
        const box = form.querySelector(`[name=n_${n.key}]`);
        if (!box) continue;
        const rest = (Array.isArray(notify[n.key]) ? notify[n.key] : []).filter((c) => c !== "push");
        notify[n.key] = box.checked ? [...rest, "push"] : rest;
      }
      const btn = form.querySelector("button[type=submit]");
      busy(btn, true);
      try {
        const r = await ctx.api(`/users/${encodeURIComponent(u.id)}`, { method: "PATCH", body: { notify }, ifMatch: ctx.state.etag });
        ctx.state.user = { ...u, ...r.data };
        ctx.state.etag = r.etag;
        toast("Saved");
      } catch (err) {
        if (err.status === 412) { toast("Someone else just changed this. Showing the latest.", { bad: true }); ctx.refresh(); } else toast(err.message, { bad: true });
      }
      busy(btn, false);
    },
    "click [data-push-on]": async (e, btn, ctx) => {
      const status = document.querySelector("[data-push-status]");
      const say = (t) => { if (status) { status.hidden = false; status.textContent = t; } };
      if (!framed) { say("Open Barta Office (the app on your home screen) and turn it on there: notifications go to the installed app."); return; }
      const key = ctx.state.push && ctx.state.push.vapid_public;
      if (!key) { say("Push isn't switched on for this site yet."); return; }
      say("Look at the top of the screen and tap Allow.");
      const done = (ev) => {
        if (ev.origin !== location.origin || !ev.data || ev.data.type !== "office:push") return;
        window.removeEventListener("message", done);
        const why = { install: "On an iPhone, add Barta Office to your home screen first (Share → Add to Home Screen), then turn it on from there.", denied: "Notifications are blocked for Barta Office in the phone's settings.", unsupported: "This browser can't show notifications.", later: "Maybe later, then.", save: "That didn't save. Try again.", failed: "That didn't work. Try again." };
        if (ev.data.ok) { toast("Notifications are on for this phone"); ctx.refresh(); } else say(why[ev.data.reason] || why.failed);
      };
      window.addEventListener("message", done);
      try { window.parent.postMessage({ type: "crm:push_request", key }, location.origin); } catch (x) { say("That didn't work. Try again."); }
    },
    "click [data-push-test]": async (e, btn, ctx) => {
      btn.disabled = true;
      try { await ctx.api("/push/test", { method: "POST", body: {} }); toast("Sent. It arrives in a few seconds."); } catch (err) { toast(err.message, { bad: true }); }
      btn.disabled = false;
    },
    "click [data-push-del]": async (e, btn, ctx) => {
      btn.disabled = true;
      try { await ctx.api(`/push/subscriptions/${encodeURIComponent(btn.getAttribute("data-push-del"))}`, { method: "DELETE" }); toast("Removed"); ctx.refresh(); } catch (err) { btn.disabled = false; toast(err.message, { bad: true }); }
    },
    "click [data-key-new]": (e, btn, ctx) => newKeySheet(ctx),
    "click [data-key-del]": async (e, btn, ctx) => {
      if (!(await confirmSheet("Anything using it stops working at once.", { title: "Revoke this key?", yes: "Revoke", danger: true }))) return;
      try { await ctx.api(`/api-keys/${encodeURIComponent(btn.getAttribute("data-key-del"))}`, { method: "DELETE" }); toast("Revoked"); ctx.refresh(); } catch (err) { toast(err.message, { bad: true }); }
    },
    "click [data-act=out]": async () => {
      const n = await unsent();
      if (!(await confirmSheet(`You'll need your login and password to get back in.${unsentNote(n)}`, { title: "Sign out of this phone?", yes: "Sign out", danger: true }))) return;
      window.__crm.signOut({ warned: true });
    },
    "click [data-act=out-all]": async () => {
      const n = await unsent();
      if (!(await confirmSheet(`Every phone and computer signed in as you gets signed out, this one too.${unsentNote(n)}`, { title: "Sign out everywhere?", yes: "Sign out everywhere", danger: true }))) return;
      window.__crm.signOut({ everywhere: true, warned: true });
    },
  },
};
