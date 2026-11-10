// Barta Office: one app, served at /office by netlify/functions/office.mjs.
// One row of tabs across the top: the dashboard's views (Overview, Money,
// Sales, Plans, Jobs) and then the office tools, the CRM first. The
// dashboard is one frame that switches view by its #hash; each tool loads
// in its own frame the first time it's opened and stays open, so switching
// tabs never loses work.
//
// Who sees what (design §2.4): the office password's cookie opens every
// tab. A CRM sign-in alone (techs, and anyone without the office password)
// gets SOLO mode: no tab row, the CRM fills the screen. The CRM tab talks to
// this page with postMessage (same origin only, both sides check):
//   from the CRM:  crm:route {path} (mirrored into #crm/<path>),
//                  crm:badge {inbox, attention, notifications} (a dot on the tab),
//                  crm:signed_out (reload), crm:push_request (M1.3)
//   to the CRM:    office:insets {top,right,bottom,left} (safe areas: iframes
//                  don't reliably get env(safe-area-inset-*)), office:show {path},
//                  office:overlay {bottom} (the "Get the app" card's height,
//                  so the CRM lifts its toasts above it)
// The office remembers the CRM's last screen (crm:route), so switching to
// another tab and back keeps /office#crm/<path> in step with the frame.
// Deep links: /office#crm opens the tab, /office#crm/<path> opens that CRM
// screen. Below 860 px the logo row hides while the CRM tab is open.
//
// The signed-out page offers Team sign-in (the CRM's own logins) next to the
// office password; the installed app opens on Team sign-in. /office/launch
// is the data-free launcher office-sw.js keeps for a cold start with no
// signal (§2.5).

// The dashboard's views, shown first in the tab row (docs/DASHBOARD.md).
export const VIEWS = [
  { id: "overview", label: "Overview" },
  { id: "money", label: "Money" },
  { id: "sales", label: "Sales" },
  { id: "plans", label: "Plans" },
  { id: "jobs", label: "Jobs" },
];
// needs: "office" = only with the office cookie; "crm" = the CRM tab, also
// open to a CRM session alone (solo mode). compact: hide the logo row on phones.
export const TOOLS = [
  { id: "dashboard", label: "Dashboard", src: "/dashboard?embed=1", needs: "office" },
  { id: "crm", label: "CRM", src: "/crm", compact: true, needs: "crm" },
  { id: "lights", label: "Lights", src: "/lights", css: ".brand{display:none!important}", needs: "office" },
  { id: "followups", label: "Follow-ups", src: "/playbook", css: ".wrap>header>.brand,.wrap>footer{display:none!important}", needs: "office" },
  { id: "purchases", label: "Purchases", src: "/purchases", needs: "office" },
  { id: "giveaway", label: "Giveaway", src: "/admin/giveaway.html", css: "[data-gwa-logout]{display:none!important}", seed: "gwa-key", needs: "office" },
];
// Old tab ids that still open the right tab (bookmarks, home-screen links).
export const OLD = { dashboard: "overview", customers: "crm" };
export const LINKS = [
  { label: "Rotor", href: "https://app.getrotor.com" },
];

// Makes /office a phone app (docs/OFFICE.md, "The phone app"): the manifest
// and icons for Add to Home Screen, and full-screen launch on iPhone. The
// sign-in page carries it too, so the app installs from either screen.
export const APP_ICON = "/assets/img/app/office-icon-180.v2.png";
export const APP_HEAD = `<link rel="manifest" href="/office.webmanifest">
<link rel="icon" href="/assets/img/favicon.svg" type="image/svg+xml">
<link rel="apple-touch-icon" href="${APP_ICON}">
<meta name="apple-mobile-web-app-capable" content="yes">
<meta name="mobile-web-app-capable" content="yes">
<meta name="apple-mobile-web-app-title" content="Barta Office">
<meta name="apple-mobile-web-app-status-bar-style" content="default">`;

const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);
const svg = (d) => `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${d}</svg>`;

const FONTS = `@font-face{font-family:'Cabinet Grotesk';src:url('/assets/fonts/CabinetGrotesk-Extrabold.v1.woff2') format('woff2');font-weight:800}
@font-face{font-family:'General Sans';src:url('/assets/fonts/GeneralSans-Medium.v1.woff2') format('woff2');font-weight:500}
@font-face{font-family:'General Sans';src:url('/assets/fonts/GeneralSans-Semibold.v1.woff2') format('woff2');font-weight:600}`;

// Measures the safe areas (iframes don't reliably get them) and tells the
// CRM frame; topless = the office bar already covers the top.
const INSETS_JS = String.raw`
  function insets() {
    const p = document.getElementById('sa-probe');
    if (!p) return { top: 0, right: 0, bottom: 0, left: 0 };
    const cs = getComputedStyle(p);
    const n = (v) => Math.round(parseFloat(v) || 0);
    return { top: n(cs.paddingTop), right: n(cs.paddingRight), bottom: n(cs.paddingBottom), left: n(cs.paddingLeft) };
  }
  function postInsets(f, topless) {
    if (!f || !f.contentWindow) return;
    const i = insets();
    if (topless) i.top = 0;
    try { f.contentWindow.postMessage(Object.assign({ type: 'office:insets' }, i), location.origin); } catch (e) { /* not ready */ }
  }`;

const PROBE = `<div id="sa-probe" aria-hidden="true" style="position:fixed;top:0;left:0;width:0;height:0;visibility:hidden;pointer-events:none;padding:env(safe-area-inset-top) env(safe-area-inset-right) env(safe-area-inset-bottom) env(safe-area-inset-left)"></div>`;

// The office shell. solo = a CRM session without the office cookie: no tab
// row, no other tools, the CRM fills the screen.
export function officeHtml({ solo = false } = {}) {
  const tools = solo ? TOOLS.filter((t) => t.needs === "crm") : TOOLS;
  const views = solo ? [] : VIEWS;
  const bar = solo ? "" : `<header class="bar"><div class="bar-in">
  <a class="brand" href="/office" aria-label="Barta Window Washing office"><img src="/assets/img/logo-bww.png" alt="BWW Barta Window Washing" width="111" height="30"></a>
  <nav class="nav" role="tablist" aria-label="Barta Office">
${views.map((v) => `    <button type="button" class="tab" role="tab" data-tool="${v.id}" aria-selected="false">${esc(v.label)}</button>`).join("\n")}
    <span class="sep" aria-hidden="true"></span>
${tools.filter((t) => t.id !== "dashboard").map((t) => `    <button type="button" class="tab tool" role="tab" data-tool="${t.id}" aria-selected="false">${esc(t.label)}<span class="dot" hidden></span></button>`).join("\n")}
${LINKS.map((l) => `    <a class="tab" href="${esc(l.href)}" target="_blank" rel="noopener">${esc(l.label)}${svg('<path d="M14 5h5v5M19 5l-8 8"/><path d="M18 14v4.5a1.5 1.5 0 0 1-1.5 1.5h-11A1.5 1.5 0 0 1 4 18.5v-11A1.5 1.5 0 0 1 5.5 6H10"/>')}</a>`).join("\n")}
  </nav>
</div></header>`;
  return `<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">
<meta name="robots" content="noindex, nofollow">
<meta name="theme-color" content="#f4f4f6">
${APP_HEAD}
<title>Barta Office</title>
<style>
${FONTS}
:root{color-scheme:light;--ink:#16161b;--slate:#3b3b42;--muted:#67676f;--line:#ececee;--coral:#fb4d3d;--mist:#f4f4f6}
*{box-sizing:border-box}
html,body{height:100%;margin:0}
body{display:flex;flex-direction:column;height:100vh;height:100dvh;background:var(--mist);color:var(--ink);font:500 14px/1.4 'General Sans',system-ui,-apple-system,'Segoe UI',sans-serif;-webkit-font-smoothing:antialiased}
.bar{flex:none;padding:max(10px,env(safe-area-inset-top)) 0 10px;background:var(--mist);border-bottom:1px solid var(--line)}
.bar-in{max-width:1180px;margin:0 auto;padding:0 16px;display:flex;align-items:center;gap:16px}
.brand{flex:none;display:block;line-height:0}
.brand img{height:30px;width:auto}
.nav{flex:1;min-width:0;display:flex;align-items:center;gap:4px;overflow-x:auto;scrollbar-width:none;-webkit-overflow-scrolling:touch}
.nav::-webkit-scrollbar{display:none}
.tab{position:relative;flex:none;height:38px;padding:0 15px;border:1px solid var(--line);border-radius:999px;background:#fff;color:var(--slate);font:600 14px/1 'General Sans',system-ui,sans-serif;white-space:nowrap;cursor:pointer;text-decoration:none;display:inline-flex;align-items:center;gap:6px;transition:background .15s,color .15s,border-color .15s}
.tab:hover{border-color:#dcdce0;color:var(--ink)}
.tab[aria-selected="true"]{background:var(--ink);border-color:var(--ink);color:#fff}
.tab.tool[aria-selected="true"]{background:var(--coral);border-color:var(--coral)}
.tab .dot{position:absolute;top:5px;right:6px;width:8px;height:8px;border-radius:50%;background:var(--coral);box-shadow:0 0 0 2px #fff}
.tab.tool[aria-selected="true"] .dot{background:#fff;box-shadow:none}
.sep{flex:none;width:1px;height:22px;background:#dcdce0;margin:0 6px}
.tab svg{width:13px;height:13px;opacity:.6}
main{flex:1;position:relative;min-height:0}
iframe{position:absolute;inset:0;width:100%;height:100%;border:0;background:var(--mist)}
iframe[hidden]{display:none}
.boot{position:absolute;inset:0;display:grid;place-items:center;color:#85858d;font-weight:600}
/* "Get the app" card: only in a browser tab, never inside the installed app. */
.install{position:fixed;z-index:20;left:50%;bottom:max(14px,env(safe-area-inset-bottom));transform:translateX(-50%);width:min(440px,calc(100% - 24px));display:flex;align-items:center;gap:12px;padding:12px 10px 12px 12px;background:#fff;border:1px solid #ececee;border-radius:20px;box-shadow:0 18px 48px rgba(14,14,18,.16)}
.install[hidden]{display:none}
/* above the CRM's own tab bar, never over it */
body.compact .install,body.solo .install{bottom:calc(max(14px,env(safe-area-inset-bottom)) + 62px)}
.install img{width:44px;height:44px;border-radius:11px;flex:none}
.install-text{flex:1;min-width:0;font-size:13.5px;line-height:1.35;color:var(--slate)}
.install-text b{display:block;font:800 15px/1.2 'Cabinet Grotesk',system-ui,sans-serif;color:var(--ink)}
.install-text strong{font-weight:600;color:var(--ink)}
.install-text svg{width:15px;height:15px;vertical-align:-3px;color:#0a84ff}
.install-go{flex:none;min-height:44px;border:0;border-radius:999px;padding:10px 16px;background:var(--coral);color:#fff;font:800 13px/1 'Cabinet Grotesk',system-ui,sans-serif;letter-spacing:.04em;text-transform:uppercase;cursor:pointer}
.install-go[hidden]{display:none}
.install-x{flex:none;width:44px;height:44px;border:0;border-radius:999px;background:none;color:#85858d;font-size:24px;line-height:1;cursor:pointer}
@media (max-width:860px){
  .bar-in{flex-wrap:wrap;gap:10px 0;padding:0}
  .brand{padding:0 16px}
  .brand img{height:26px}
  .nav{flex-basis:100%;padding:0 16px}
  body.compact .brand{display:none}
  body.compact .bar-in{gap:0}
}
</style></head><body class="${solo ? "solo" : ""}">
${bar}
<main id="main"><div class="boot">Loading…</div></main>
${PROBE}
<div class="install" id="install" role="dialog" aria-label="Get the Barta Office app" hidden>
  <img src="${APP_ICON}" alt="">
  <div class="install-text"><b>Get the app</b><span id="install-how">Put Barta Office on your home screen.</span><span id="install-ios" hidden>Tap Share ${svg('<path d="M12 3v12M8 7l4-4 4 4"/><path d="M8 11H6.5A1.5 1.5 0 0 0 5 12.5v7A1.5 1.5 0 0 0 6.5 21h11a1.5 1.5 0 0 0 1.5-1.5v-7a1.5 1.5 0 0 0-1.5-1.5H16"/>')} then <strong>Add to Home Screen</strong>.</span></div>
  <button type="button" class="install-go" id="install-go" hidden>Install</button>
  <button type="button" class="install-x" id="install-x" aria-label="Not now">&times;</button>
</div>
<script>
(() => {
  const SOLO = ${solo ? "true" : "false"};
  const VIEWS = ${JSON.stringify(views)};
  const TOOLS = ${JSON.stringify(tools.map(({ id, label, src, css, seed, compact }) => ({ id, label, src, css: css || "", seed: seed || "", compact: !!compact })))};
  const OLD = ${JSON.stringify(OLD)};
  const main = document.getElementById('main');
  const frames = {};
  let crmPath = '';   // the CRM frame's screen, from its last crm:route
  const store = { get(k) { try { return localStorage.getItem(k); } catch (e) { return null; } }, set(k, v) { try { localStorage.setItem(k, v); } catch (e) { /* no storage */ } } };
  let current = null;
${INSETS_JS}
  // Signed in to the office: the dashboards don't need their own admin key.
  for (const t of TOOLS) if (t.seed) { try { if (!sessionStorage.getItem(t.seed)) sessionStorage.setItem(t.seed, 'office'); } catch (e) { /* no storage */ } }
  // Make each tool look like part of one app: drop its own logo, header extras and sign-out.
  function blend(f, t) {
    if (!t.css) return;
    try {
      const d = f.contentDocument;
      if (!d || !d.head || d.getElementById('office-blend')) return;
      const st = d.createElement('style');
      st.id = 'office-blend';
      st.textContent = t.css;
      d.head.appendChild(st);
    } catch (e) { /* not ready */ }
  }
  // The view the dashboard should show once it has loaded. Never touch a
  // frame's location before its page has loaded: Safari treats that as a new
  // navigation and drops the page that was loading, leaving the frame blank.
  let pendingView = null;
  function frame(t, hash) {
    if (frames[t.id]) return frames[t.id];
    const boot = main.querySelector('.boot');
    const f = document.createElement('iframe');
    f.title = t.label;
    f.allow = 'clipboard-read; clipboard-write; fullscreen';
    f.addEventListener('load', () => {
      f.dataset.loaded = '1';
      blend(f, t);
      if (boot) boot.remove();
      if (t.id === 'dashboard' && pendingView) { const v = pendingView; pendingView = null; setView(f, v); }
      if (t.id === 'crm') { postInsets(f, !SOLO); postOverlay(); }
    });
    f.src = t.src + (hash ? '#' + hash : '');
    main.appendChild(f);
    return (frames[t.id] = f);
  }
  function setView(f, id) {
    if (!f.dataset.loaded) { pendingView = id; return; }
    try { if (f.contentWindow.location.hash !== '#' + id) f.contentWindow.location.hash = id; } catch (e) { /* not reachable */ }
  }
  function show(raw) {
    raw = String(raw || '');
    const slash = raw.indexOf('/');
    let id = slash >= 0 ? raw.slice(0, slash) : raw;
    const sub = slash >= 0 ? raw.slice(slash) : '';
    id = OLD[id] || id;
    const view = VIEWS.find((v) => v.id === id);
    const tool = view ? TOOLS.find((x) => x.id === 'dashboard') : (TOOLS.find((x) => x.id === id && x.id !== 'dashboard') || null);
    if (!view && !tool) return show(VIEWS.length ? VIEWS[0].id : TOOLS[0].id);
    const isNew = !frames[tool.id];
    const f = frame(tool, view ? view.id : (tool.id === 'crm' && sub ? sub : ''));
    if (view && !isNew) setView(f, view.id);
    if (tool.id === 'crm' && sub && !isNew && f.dataset.loaded) { try { f.contentWindow.postMessage({ type: 'office:show', path: sub }, location.origin); } catch (e) { /* not ready */ } }
    for (const k in frames) frames[k].hidden = frames[k] !== f;
    current = view ? view.id : tool.id;
    document.body.classList.toggle('compact', !view && !!tool.compact);
    let sel = null;
    document.querySelectorAll('.tab[data-tool]').forEach((b) => { const on = b.dataset.tool === id; b.setAttribute('aria-selected', String(on)); if (on) sel = b; });
    if (sel) sel.scrollIntoView({ block: 'nearest', inline: 'nearest' });
    document.title = (view || tool).label + ' · Barta Office';
    store.set('barta-office-tab', id);
    if (tool.id === 'crm' && sub) crmPath = sub;
    const want = '#' + id + (tool.id === 'crm' ? (sub || crmPath) : '');
    if (location.hash !== want) history.replaceState(null, '', want);
  }
  document.querySelectorAll('.tab[data-tool]').forEach((b) => b.addEventListener('click', () => show(b.dataset.tool)));
  window.addEventListener('hashchange', () => show(location.hash.slice(1)));
  // Messages from the CRM frame (same origin only).
  window.addEventListener('message', (e) => {
    if (e.origin !== location.origin || !frames.crm || e.source !== frames.crm.contentWindow) return;
    const m = e.data || {};
    if (m.type === 'crm:route' && typeof m.path === 'string') {
      crmPath = m.path.charAt(0) === '/' ? m.path : '/' + m.path;
      const want = '#crm' + crmPath;
      if (current === 'crm' && location.hash !== want) history.replaceState(null, '', want);
    } else if (m.type === 'crm:badge') {
      const on = !!(m.inbox || m.attention || m.notifications);
      document.querySelectorAll('.tab[data-tool="crm"] .dot').forEach((d) => { d.hidden = !on; });
    } else if (m.type === 'crm:signed_out') {
      location.reload();
    }
  });
  const reposition = () => { if (frames.crm) postInsets(frames.crm, !SOLO); };
  window.addEventListener('resize', reposition);
  window.addEventListener('orientationchange', () => setTimeout(reposition, 250));
  const start = location.hash.slice(1) || (SOLO ? 'crm' : store.get('barta-office-tab')) || (VIEWS.length ? VIEWS[0].id : 'crm');
  show(start);

  // The phone app: offline launcher, plus a one-time "Get the app" card.
  if ('serviceWorker' in navigator) navigator.serviceWorker.register('/office-sw.js', { scope: '/office' }).catch(() => {});
  const installed = (window.matchMedia && matchMedia('(display-mode: standalone)').matches) || navigator.standalone === true;
  const card = document.getElementById('install');
  const go = document.getElementById('install-go');
  // While the card floats over the CRM, the CRM lifts its toasts above it.
  function postOverlay() {
    const f = frames.crm;
    if (!f || !f.contentWindow || !f.dataset.loaded) return;
    const bottom = card && !card.hidden ? Math.round(card.getBoundingClientRect().height) + 12 : 0;
    try { f.contentWindow.postMessage({ type: 'office:overlay', bottom }, location.origin); } catch (e) { /* not ready */ }
  }
  new MutationObserver(postOverlay).observe(card, { attributes: true, attributeFilter: ['hidden'] });
  const hide = (forGood) => { card.hidden = true; if (forGood) store.set('barta-office-install', 'no'); };
  document.getElementById('install-x').addEventListener('click', () => hide(true));
  if (!installed && store.get('barta-office-install') !== 'no') {
    const ios = /iPhone|iPad|iPod/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
    if (ios) {
      document.getElementById('install-how').hidden = true;
      document.getElementById('install-ios').hidden = false;
      card.hidden = false;
    }
    let prompt = null;
    window.addEventListener('beforeinstallprompt', (e) => {
      e.preventDefault();
      prompt = e;
      go.hidden = false;
      card.hidden = false;
    });
    go.addEventListener('click', async () => {
      if (!prompt) return;
      prompt.prompt();
      try { await prompt.userChoice; } catch (e) { /* closed */ }
      prompt = null;
      hide(false);
    });
    window.addEventListener('appinstalled', () => hide(true));
  }
})();
</script>
</body></html>`;
}

// The full office (office cookie), rendered once.
export const OFFICE_HTML = officeHtml();

// The signed-out /office page: Team sign-in (one login per person, the
// CRM's) and the office password. `team` = the CRM is set up, so Team
// sign-in can work; `error` goes with the office-password form.
export function officeLoginHtml({ error = "", team = true } = {}) {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">
<meta name="robots" content="noindex, nofollow">
${APP_HEAD}
<meta name="theme-color" content="#f7f7f8">
<title>Barta Office</title>
<style>
${FONTS}
:root{color-scheme:light}
*{box-sizing:border-box}
body{margin:0;min-height:100vh;min-height:100dvh;display:grid;place-items:center;padding:max(24px,env(safe-area-inset-top)) 16px max(24px,env(safe-area-inset-bottom));background:#f7f7f8;color:#121215;font:500 16px/1.5 'General Sans',system-ui,-apple-system,'Segoe UI',sans-serif;-webkit-font-smoothing:antialiased}
.card{width:100%;max-width:380px;background:#fff;border:1px solid #ececee;border-radius:28px;padding:30px 24px 26px;box-shadow:0 20px 50px rgba(13,27,42,.10),0 8px 20px rgba(13,27,42,.06)}
.logo{display:block;width:160px;height:auto;margin:0 0 20px}
h1{margin:0;font:800 1.7rem/1.1 'Cabinet Grotesk',system-ui,sans-serif;letter-spacing:-.015em}
p{margin:8px 0 18px;color:#67676f}
.seg{display:flex;gap:4px;padding:4px;margin:0 0 18px;background:#f1f1f3;border-radius:999px}
.seg[hidden]{display:none}
.seg button{flex:1;min-height:44px;border:0;border-radius:999px;background:none;color:#3b3b42;font:600 14px/1 'General Sans',system-ui,sans-serif;cursor:pointer}
.seg button[aria-pressed="true"]{background:#fff;color:#16161b;box-shadow:0 1px 3px rgba(13,27,42,.12)}
form[hidden]{display:none}
label{display:block;font:800 .78rem/1 'Cabinet Grotesk',system-ui,sans-serif;letter-spacing:.12em;text-transform:uppercase;color:#67676f;margin:14px 0 8px}
input[type=password],input[type=text]{width:100%;font:inherit;font-size:1.05rem;padding:13px 16px;min-height:48px;border:1.5px solid #ececee;border-radius:14px;background:#f7f7f8;outline:0}
input:focus{border-color:#fb4d3d;background:#fff;box-shadow:0 0 0 4px rgba(251,77,61,.12)}
input.user{position:absolute;left:0;top:0;width:1px!important;height:1px!important;min-height:0!important;padding:0!important;border:0!important;overflow:hidden;clip:rect(0 0 0 0);white-space:nowrap}
.card{position:relative}
button.go{margin-top:18px;width:100%;min-height:52px;border:0;border-radius:999px;padding:16px;font:800 1rem/1 'Cabinet Grotesk',system-ui,sans-serif;letter-spacing:.045em;text-transform:uppercase;color:#fff;background:linear-gradient(135deg,#fb4d3d,#ff6a3d);box-shadow:0 14px 38px rgba(251,77,61,.34);cursor:pointer}
button.go:disabled{opacity:.6}
details{margin-top:14px;border-top:1px solid #ececee;padding-top:6px}
summary{min-height:44px;display:flex;align-items:center;font-weight:600;font-size:.95rem;color:#3b3b42;cursor:pointer}
summary small{color:#85858d;font-weight:500;margin-left:4px}
.hint{margin:0 0 4px;font-size:.88rem}
.err{margin:0 0 14px;padding:10px 14px;border-radius:12px;background:#fff5f3;border:1px solid rgba(208,51,31,.25);color:#d0331f;font-size:.92rem}
.err[hidden]{display:none}
.err.ok{background:#fff8e6;border-color:rgba(183,121,31,.3);color:#7a4f12}
.foot{margin:16px 0 0;font-size:.88rem;color:#85858d}
</style></head><body>
<main class="card">
<img class="logo" src="/assets/img/logo-bww.png" alt="Barta Window Washing" width="160" height="43">
<h1>Barta Office</h1>
<p id="say">Sign in to open the office tools. This browser will remember you.</p>
<div class="seg" id="seg" role="group" aria-label="How to sign in" hidden>
  <button type="button" data-mode="team" aria-pressed="false">Team sign-in</button>
  <button type="button" data-mode="office" aria-pressed="true">Office password</button>
</div>
<form id="team" novalidate hidden>
  <div class="err" id="team-err" role="alert" hidden></div>
  <label for="t-login">Login</label>
  <input id="t-login" type="text" name="login" autocomplete="username" autocapitalize="none" autocorrect="off" spellcheck="false" enterkeyhint="next">
  <label for="t-pw">Password</label>
  <input id="t-pw" type="password" name="password" autocomplete="current-password" enterkeyhint="go">
  <details id="t-more"><summary>Office password <small>(optional)</small></summary>
    <p class="hint">Also opens Lights, Purchases and the dashboards on this phone. Owners only.</p>
    <input id="t-office" type="password" name="office_password" autocomplete="off" aria-label="Office password">
  </details>
  <button type="submit" class="go" id="t-go">Sign in</button>
  <p class="foot">Forgot your password? Ask Alex or Jacob for a reset link.</p>
</form>
<form id="office" method="post" action="/office">
${error ? `<div class="err" role="alert">${esc(error)}</div>` : ""}
<input class="user" type="text" name="username" value="Barta" autocomplete="username" tabindex="-1" aria-hidden="true" readonly>
<label for="pw">Office password</label>
<input id="pw" type="password" name="password" autocomplete="current-password" required${error ? " autofocus" : ""}>
<button type="submit" class="go">Open</button>
</form>
</main>
<script>
(() => {
  const TEAM = ${team ? "true" : "false"};
  const ERROR = ${error ? "true" : "false"};
  const $ = (id) => document.getElementById(id);
  const store = { get(k) { try { return localStorage.getItem(k); } catch (e) { return null; } }, set(k, v) { try { localStorage.setItem(k, v); } catch (e) { /* no storage */ } } };
  $('office').addEventListener('submit', (e) => { if (location.hash) e.target.action = e.target.getAttribute('action') + location.hash; });
  if (!TEAM) return;
  const seg = $('seg');
  seg.hidden = false;
  const installed = (window.matchMedia && matchMedia('(display-mode: standalone)').matches) || navigator.standalone === true;
  function mode(m) {
    $('team').hidden = m !== 'team';
    $('office').hidden = m !== 'office';
    seg.querySelectorAll('button').forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.mode === m)));
    store.set('barta-office-signin', m);
  }
  seg.addEventListener('click', (e) => { const b = e.target.closest('button[data-mode]'); if (b) mode(b.dataset.mode); });
  mode(ERROR ? 'office' : installed ? 'team' : (store.get('barta-office-signin') || 'office'));
  const err = $('team-err');
  const say = (t) => { err.classList.remove('ok'); err.textContent = t; err.hidden = !t; };
  $('team').addEventListener('submit', async (e) => {
    e.preventDefault();
    const login = $('t-login').value.trim();
    const password = $('t-pw').value;
    if (!login || !password) { say('Type your login and password.'); return; }
    const go = $('t-go');
    go.disabled = true;
    say('');
    try {
      const res = await fetch('/api/crm/auth/login', { method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': 'application/json', 'X-CRM': '1' }, body: JSON.stringify({ login, password, office_password: $('t-office').value || undefined, to: '/office' + location.hash }) });
      let body = null;
      try { body = await res.json(); } catch (x) { /* not JSON */ }
      if (res.ok && body && body.ok) {
        const to = (body.data && body.data.to) || '/office';
        const at = to.indexOf('#');
        // Already on that page (only the #hash differs): reload so it sees the new sign-in.
        const open = () => { if ((at < 0 ? to : to.slice(0, at)) === location.pathname) { if (at >= 0) location.hash = to.slice(at + 1); location.reload(); } else location.href = to; };
        if (body.data && body.data.office_cookie === false) {
          // Signed in to the CRM, but the optional office password didn't take: say so before the CRM opens alone.
          say("You're signed in. The office password wasn't right (or isn't for your login), so only the CRM opens on this phone.");
          err.classList.add('ok');
          setTimeout(open, 3500);
          return;
        }
        open();
        return;
      }
      say((body && body.error && body.error.message) || 'Sign-in failed (' + res.status + '). Try again.');
    } catch (x) {
      say('No connection. Try again.');
    }
    go.disabled = false;
  });
})();
</script>
</body></html>`;
}

// /office/launch: what the installed app shows when it starts with no
// signal (office-sw.js keeps it). No data, no tool list: a full-screen CRM
// frame (the CRM's own service worker serves its cached shell) and an
// "Offline" strip. Back online, it reloads the real /office.
export function launcherHtml() {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">
<meta name="robots" content="noindex, nofollow">
<meta name="theme-color" content="#f4f4f6">
${APP_HEAD}
<title>Barta Office</title>
<style>
${FONTS}
*{box-sizing:border-box}
html,body{height:100%;margin:0}
body{display:flex;flex-direction:column;height:100vh;height:100dvh;background:#f4f4f6;color:#16161b;font:600 13px/1.3 'General Sans',system-ui,-apple-system,sans-serif}
.off{flex:none;display:flex;align-items:center;justify-content:center;gap:10px;padding:max(6px,env(safe-area-inset-top)) 16px 6px;background:#16161b;color:#fff}
.off[hidden]{display:none}
.off span{min-width:0}
.off button{flex:none;white-space:nowrap;min-height:44px;border:0;border-radius:999px;padding:0 16px;background:#fff;color:#16161b;font:600 12px/1 'General Sans',system-ui,sans-serif;cursor:pointer}
main{flex:1;position:relative;min-height:0}
iframe{position:absolute;inset:0;width:100%;height:100%;border:0;background:#f4f4f6}
</style></head><body>
<div class="off" id="off" role="status" hidden><span>Offline · this phone's saved copy</span><button type="button" id="retry">Try again</button></div>
<main><iframe id="crm" title="Barta CRM" src="/crm"></iframe></main>
${PROBE}
<script>
(() => {
  const f = document.getElementById('crm');
  const off = document.getElementById('off');
${INSETS_JS}
  const sync = () => { off.hidden = navigator.onLine !== false; postInsets(f, !off.hidden); };
  f.addEventListener('load', sync);
  window.addEventListener('resize', sync);
  window.addEventListener('offline', sync);
  window.addEventListener('online', () => location.replace('/office'));
  document.getElementById('retry').addEventListener('click', () => location.replace('/office'));
  window.addEventListener('message', (e) => {
    if (e.origin !== location.origin || e.source !== f.contentWindow) return;
    if (e.data && e.data.type === 'crm:signed_out') location.replace('/office');
  });
  sync();
  if ('serviceWorker' in navigator) navigator.serviceWorker.register('/office-sw.js', { scope: '/office' }).catch(() => {});
})();
</script>
</body></html>`;
}
