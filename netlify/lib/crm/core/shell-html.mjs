// Barta CRM core: the HTML pages crm.mjs serves (design §2.3, §4.4, §9.2):
// the app shell, Team sign-in, first-owner setup, "Setup needed", invite
// acceptance, and small message pages.
//
// Rules (§0 rules 7-8, §2.3): no data in any page but the signed-in
// person's own id, name, role and permissions (in a non-executed
// <script type="application/json">, so the service worker may cache the
// shell); every value escaped; no inline script and no on* attribute
// (the CSP is script-src 'self'): page behaviour lives in /crm-app/*.js.

import { esc, jsonForHtml } from "./text.mjs";
import { APP_VERSION } from "../../../../crm-app/version.js";

export { APP_VERSION };

const LOGO = "/assets/img/logo-bww.png";
const HEAD = (title, extra = "") => `<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">
<meta name="robots" content="noindex, nofollow">
<meta name="theme-color" content="#f4f4f6">
<meta name="format-detection" content="telephone=no">
<title>${esc(title)}</title>
<link rel="icon" href="/assets/img/favicon.svg" type="image/svg+xml">
<link rel="stylesheet" href="/crm-app/styles/crm.css">
${extra}</head>`;

const boot = (id, data) => `<script type="application/json" id="${id}">${jsonForHtml(data)}</script>`;
const pageScript = `<script type="module" src="/crm-app/core/signin.js"></script>`;

// The app shell: nothing in it but the signed-in person (§2.3).
export function shellHtml({ user, perms, nav, office = false, version = APP_VERSION, minClient }) {
  const data = {
    v: version,
    min_client: minClient || version,
    user: { id: user.id, name: user.name, first_name: user.first_name, role: user.role, is_technician: !!user.is_technician, color: user.color },
    perms, nav, office: !!office,
  };
  const pre = ["main.js", "core/api.js", "core/ui.js", "core/router.js", "core/nav.js"].map((f) => `<link rel="modulepreload" href="/crm-app/${f}">`).join("\n");
  return `${HEAD("Barta CRM", pre + "\n")}<body class="crm">
<div class="app" id="app">
  <header class="top" id="top">
    <button type="button" class="top-back" id="top-back" aria-label="Back" hidden><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M15 5l-7 7 7 7"/></svg></button>
    <h1 class="top-title" id="top-title">Barta CRM</h1>
    <div class="top-act" id="top-act"></div>
  </header>
  <div class="banner" id="banner" role="status" hidden></div>
  <main class="view" id="view" tabindex="-1"><div class="boot" id="boot"><span class="spinner" aria-hidden="true"></span><span>Loading…</span></div></main>
  <nav class="tabs" id="tabs" aria-label="CRM sections"></nav>
</div>
<div class="edge" id="edge" aria-hidden="true"></div>
<div id="layer"></div>
<div class="toasts" id="toasts" aria-live="polite"></div>
<noscript><p class="noscript">Barta CRM needs JavaScript. Turn it on in Settings → Safari → Advanced.</p></noscript>
${boot("crm-boot", data)}
<script type="module" src="/crm-app/main.js"></script>
</body></html>`;
}

const card = (inner, cls = "") => `<body class="crm page"><main class="card${cls ? " " + cls : ""}"><img class="logo" src="${LOGO}" alt="Barta Window Washing" width="148" height="40">${inner}</main>`;

// Team sign-in (/crm/login). `to` is where to go after (checked server-side
// again on POST). `office` = this browser already has the office cookie.
export function loginHtml({ to = "/crm", notice = "" } = {}) {
  return `${HEAD("Sign in · Barta CRM")}${card(`
<h1>Team sign-in</h1>
<p class="lead">Sign in with your own login and password.</p>
${notice ? `<div class="note" role="status">${esc(notice)}</div>` : ""}
<form id="signin" class="form" novalidate>
  <div class="err" id="err" role="alert" hidden></div>
  <label class="field"><span>Login</span><input name="login" id="login" type="text" inputmode="text" autocomplete="username" autocapitalize="none" autocorrect="off" spellcheck="false" enterkeyhint="next" required></label>
  <label class="field"><span>Password</span><input name="password" id="password" type="password" autocomplete="current-password" enterkeyhint="go" required></label>
  <details class="more" id="office-more">
    <summary>Office password <small>(optional)</small></summary>
    <p class="hint">Also opens Lights, Purchases and the dashboards on this phone. Owners only.</p>
    <label class="field"><span>Office password</span><input name="office_password" id="office_password" type="password" autocomplete="off"></label>
  </details>
  <button type="submit" class="btn primary block" id="go">Sign in</button>
</form>
<p class="foot">Forgot your password? Ask Alex or Jacob for a reset link.</p>
${boot("crm-page", { page: "login", to })}${pageScript}`)}</body></html>`;
}

// First-owner setup (/crm/setup): office cookie + CRM_SETUP_CODE, once.
export function setupHtml() {
  return `${HEAD("Set up · Barta CRM")}${card(`
<h1>Set up the CRM</h1>
<p class="lead">This makes the first owner account. You need the one-time setup code from Netlify (CRM_SETUP_CODE).</p>
<form id="setup" class="form" novalidate>
  <div class="err" id="err" role="alert" hidden></div>
  <label class="field"><span>Setup code</span><input name="setup_code" id="setup_code" type="password" autocomplete="off" required></label>
  <label class="field"><span>Your name</span><input name="name" id="name" type="text" autocomplete="name" autocapitalize="words" required></label>
  <label class="field"><span>Login</span><input name="login" id="login" type="text" autocomplete="username" autocapitalize="none" autocorrect="off" spellcheck="false" placeholder="alex" required><small>Lowercase, like alex. You type it to sign in.</small></label>
  <label class="field"><span>Password</span><input name="password" id="password" type="password" autocomplete="new-password" minlength="10" required><small>At least 10 characters. A short sentence works well.</small></label>
  <label class="check"><input type="checkbox" name="is_technician" id="is_technician"><span>I also work in the field (I can be put on visits)</span></label>
  <button type="submit" class="btn primary block" id="go">Create my account</button>
</form>
<p class="foot"><a href="/crm/legacy">Open the Customers list</a></p>
${boot("crm-page", { page: "setup" })}${pageScript}`)}</body></html>`;
}

// The CRM can't run yet: the owner still has Netlify settings to add.
// Names only, never values. `office` = the office cookie is present, so the
// Customers list (first slice) is one tap away.
export function setupNeededHtml({ missing = [], office = false } = {}) {
  const list = missing.length ? `<ul class="list">${missing.map((m) => `<li><code>${esc(m)}</code></li>`).join("")}</ul>` : "";
  return `${HEAD("Setup needed · Barta CRM")}${card(`
<h1>Setup needed</h1>
<p class="lead">The new CRM opens once an owner adds its settings in Netlify (Site configuration → Environment variables, Production only)${missing.length ? ":" : "."}</p>
${list}
${office ? `<p>Everything you use today still works. Your customer list is here:</p><a class="btn primary block" href="/crm/legacy">Open the Customers list</a>` : `<p>Until then, use Barta Office with the office password.</p><a class="btn block" href="/office" target="_top">Go to Barta Office</a>`}
`)}</body></html>`;
}

// Invite or reset link (/crm/invite/{userId}.{token}).
export function inviteHtml({ token, first_name, login, kind = "invite" }) {
  const reset = kind === "reset";
  return `${HEAD((reset ? "Reset your password" : "Welcome") + " · Barta CRM")}${card(`
<section id="step-set">
<h1>${reset ? "Pick a new password" : `Welcome${first_name ? ", " + esc(first_name) : ""}`}</h1>
<p class="lead">${reset ? "Pick a new password for" : "Set a password for your Barta login"} <b>${esc(login)}</b>.</p>
<form id="invite" class="form" novalidate>
  <div class="err" id="err" role="alert" hidden></div>
  <input type="text" name="username" value="${esc(login)}" autocomplete="username" class="sr" tabindex="-1" aria-hidden="true" readonly>
  <label class="field"><span>New password</span><input name="password" id="password" type="password" autocomplete="new-password" minlength="10" required><small>At least 10 characters. A short sentence works well.</small></label>
  <label class="field"><span>Type it again</span><input name="again" id="again" type="password" autocomplete="new-password" required></label>
  <button type="submit" class="btn primary block" id="go">Set password</button>
</form>
</section>
<section id="step-done" hidden>
<h1>You're in</h1>
<p class="lead">Now put Barta Office on your home screen. It keeps its own sign-in, so sign in there once more.</p>
<ol class="steps">
  <li>Open <b>bartawindowwashing.com/office</b> in Safari.</li>
  <li>Tap Share <span aria-hidden="true">⬆</span>, then <b>Add to Home Screen</b>.</li>
  <li>Open <b>Barta Office</b> from your home screen and use <b>Team sign-in</b> with your login <b>${esc(login)}</b>.</li>
</ol>
<a class="btn primary block" href="/office" target="_top">Open Barta Office</a>
</section>
${boot("crm-page", { page: "invite", token })}${pageScript}`)}</body></html>`;
}

// A small page with a title, a line of text and optional links.
export function messageHtml({ title, text, links = [] }) {
  const a = links.map((l) => `<a class="btn${l.primary ? " primary" : ""} block" href="${esc(l.href)}"${l.top ? ' target="_top"' : ""}>${esc(l.label)}</a>`).join("\n");
  return `${HEAD(title + " · Barta CRM")}${card(`
<h1>${esc(title)}</h1>
<p class="lead">${esc(text)}</p>
${a}
`)}</body></html>`;
}
