// Barta Office: one app, served at /office by netlify/functions/office.mjs.
// One row of tabs across the top: the dashboard's views (Overview, Money,
// Sales, Plans, Jobs) and then the office tools. The dashboard is one frame
// that switches view by its #hash; each tool loads in its own frame the first
// time it's opened and stays open, so switching tabs never loses work.

// The dashboard's views, shown first in the tab row (docs/DASHBOARD.md).
export const VIEWS = [
  { id: "overview", label: "Overview" },
  { id: "money", label: "Money" },
  { id: "sales", label: "Sales" },
  { id: "plans", label: "Plans" },
  { id: "jobs", label: "Jobs" },
];
export const TOOLS = [
  { id: "dashboard", label: "Dashboard", src: "/dashboard?embed=1" },
  { id: "customers", label: "Customers", src: "/crm" },
  { id: "lights", label: "Lights", src: "/lights", css: ".brand{display:none!important}" },
  { id: "followups", label: "Follow-ups", src: "/playbook", css: ".wrap>header>.brand,.wrap>footer{display:none!important}" },
  { id: "purchases", label: "Purchases", src: "/purchases" },
  { id: "giveaway", label: "Giveaway", src: "/admin/giveaway.html", css: "[data-gwa-logout]{display:none!important}", seed: "gwa-key" },
];
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

export const OFFICE_HTML = `<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">
<meta name="robots" content="noindex, nofollow">
<meta name="theme-color" content="#f4f4f6">
${APP_HEAD}
<title>Barta Office</title>
<style>
@font-face{font-family:'Cabinet Grotesk';src:url('/assets/fonts/CabinetGrotesk-Extrabold.v1.woff2') format('woff2');font-weight:800}
@font-face{font-family:'General Sans';src:url('/assets/fonts/GeneralSans-Medium.v1.woff2') format('woff2');font-weight:500}
@font-face{font-family:'General Sans';src:url('/assets/fonts/GeneralSans-Semibold.v1.woff2') format('woff2');font-weight:600}
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
.tab{flex:none;height:38px;padding:0 15px;border:1px solid var(--line);border-radius:999px;background:#fff;color:var(--slate);font:600 14px/1 'General Sans',system-ui,sans-serif;white-space:nowrap;cursor:pointer;text-decoration:none;display:inline-flex;align-items:center;gap:6px;transition:background .15s,color .15s,border-color .15s}
.tab:hover{border-color:#dcdce0;color:var(--ink)}
.tab[aria-selected="true"]{background:var(--ink);border-color:var(--ink);color:#fff}
.tab.tool[aria-selected="true"]{background:var(--coral);border-color:var(--coral)}
.sep{flex:none;width:1px;height:22px;background:#dcdce0;margin:0 6px}
.tab svg{width:13px;height:13px;opacity:.6}
main{flex:1;position:relative;min-height:0}
iframe{position:absolute;inset:0;width:100%;height:100%;border:0;background:var(--mist)}
iframe[hidden]{display:none}
.boot{position:absolute;inset:0;display:grid;place-items:center;color:#85858d;font-weight:600}
/* "Get the app" card: only in a browser tab, never inside the installed app. */
.install{position:fixed;z-index:20;left:50%;bottom:max(14px,env(safe-area-inset-bottom));transform:translateX(-50%);width:min(440px,calc(100% - 24px));display:flex;align-items:center;gap:12px;padding:12px 10px 12px 12px;background:#fff;border:1px solid #ececee;border-radius:20px;box-shadow:0 18px 48px rgba(14,14,18,.16)}
.install[hidden]{display:none}
.install img{width:44px;height:44px;border-radius:11px;flex:none}
.install-text{flex:1;min-width:0;font-size:13.5px;line-height:1.35;color:var(--slate)}
.install-text b{display:block;font:800 15px/1.2 'Cabinet Grotesk',system-ui,sans-serif;color:var(--ink)}
.install-text strong{font-weight:600;color:var(--ink)}
.install-text svg{width:15px;height:15px;vertical-align:-3px;color:#0a84ff}
.install-go{flex:none;border:0;border-radius:999px;padding:10px 16px;background:var(--coral);color:#fff;font:800 13px/1 'Cabinet Grotesk',system-ui,sans-serif;letter-spacing:.04em;text-transform:uppercase;cursor:pointer}
.install-go[hidden]{display:none}
.install-x{flex:none;width:32px;height:32px;border:0;border-radius:999px;background:none;color:#85858d;font-size:22px;line-height:1;cursor:pointer}
@media (max-width:860px){
  .bar-in{flex-wrap:wrap;gap:10px 0;padding:0}
  .brand{padding:0 16px}
  .brand img{height:26px}
  .nav{flex-basis:100%;padding:0 16px}
}
</style></head><body>
<header class="bar"><div class="bar-in">
  <a class="brand" href="/office" aria-label="Barta Window Washing office"><img src="/assets/img/logo-bww.png" alt="BWW Barta Window Washing" width="111" height="30"></a>
  <nav class="nav" role="tablist" aria-label="Barta Office">
${VIEWS.map((v) => `    <button type="button" class="tab" role="tab" data-tool="${v.id}" aria-selected="false">${esc(v.label)}</button>`).join("\n")}
    <span class="sep" aria-hidden="true"></span>
${TOOLS.filter((t) => t.id !== "dashboard").map((t) => `    <button type="button" class="tab tool" role="tab" data-tool="${t.id}" aria-selected="false">${esc(t.label)}</button>`).join("\n")}
${LINKS.map((l) => `    <a class="tab" href="${esc(l.href)}" target="_blank" rel="noopener">${esc(l.label)}${svg('<path d="M14 5h5v5M19 5l-8 8"/><path d="M18 14v4.5a1.5 1.5 0 0 1-1.5 1.5h-11A1.5 1.5 0 0 1 4 18.5v-11A1.5 1.5 0 0 1 5.5 6H10"/>')}</a>`).join("\n")}
  </nav>
</div></header>
<main id="main"><div class="boot">Loading…</div></main>
<div class="install" id="install" role="dialog" aria-label="Get the Barta Office app" hidden>
  <img src="${APP_ICON}" alt="">
  <div class="install-text"><b>Get the app</b><span id="install-how">Put Barta Office on your home screen.</span><span id="install-ios" hidden>Tap Share ${svg('<path d="M12 3v12M8 7l4-4 4 4"/><path d="M8 11H6.5A1.5 1.5 0 0 0 5 12.5v7A1.5 1.5 0 0 0 6.5 21h11a1.5 1.5 0 0 0 1.5-1.5v-7a1.5 1.5 0 0 0-1.5-1.5H16"/>')} then <strong>Add to Home Screen</strong>.</span></div>
  <button type="button" class="install-go" id="install-go" hidden>Install</button>
  <button type="button" class="install-x" id="install-x" aria-label="Not now">&times;</button>
</div>
<script>
(() => {
  const VIEWS = ${JSON.stringify(VIEWS)};
  const TOOLS = ${JSON.stringify(TOOLS.map(({ id, label, src, css, seed }) => ({ id, label, src, css: css || "", seed: seed || "" })))};
  const OLD = { dashboard: 'overview' };
  const main = document.getElementById('main');
  const frames = {};
  const store = { get(k) { try { return localStorage.getItem(k); } catch (e) { return null; } }, set(k, v) { try { localStorage.setItem(k, v); } catch (e) { /* no storage */ } } };
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
    });
    f.src = t.src + (hash ? '#' + hash : '');
    main.appendChild(f);
    return (frames[t.id] = f);
  }
  function setView(f, id) {
    if (!f.dataset.loaded) { pendingView = id; return; }
    try { if (f.contentWindow.location.hash !== '#' + id) f.contentWindow.location.hash = id; } catch (e) { /* not reachable */ }
  }
  function show(id) {
    id = OLD[id] || id;
    const view = VIEWS.find((v) => v.id === id);
    const tool = view ? TOOLS[0] : (TOOLS.find((x) => x.id === id && x.id !== 'dashboard') || null);
    if (!view && !tool) return show(VIEWS[0].id);
    const isNew = !frames[tool.id];
    const f = frame(tool, view && view.id);
    if (view && !isNew) setView(f, view.id);
    for (const k in frames) frames[k].hidden = frames[k] !== f;
    let sel = null;
    document.querySelectorAll('.tab[data-tool]').forEach((b) => { const on = b.dataset.tool === id; b.setAttribute('aria-selected', String(on)); if (on) sel = b; });
    if (sel) sel.scrollIntoView({ block: 'nearest', inline: 'nearest' });
    document.title = (view || tool).label + ' · Barta Office';
    store.set('barta-office-tab', id);
    if (location.hash !== '#' + id) history.replaceState(null, '', '#' + id);
  }
  document.querySelectorAll('.tab[data-tool]').forEach((b) => b.addEventListener('click', () => show(b.dataset.tool)));
  window.addEventListener('hashchange', () => show(location.hash.slice(1)));
  show(location.hash.slice(1) || store.get('barta-office-tab') || VIEWS[0].id);

  // The phone app: offline screen, plus a one-time "Get the app" card.
  if ('serviceWorker' in navigator) navigator.serviceWorker.register('/office-sw.js', { scope: '/office' }).catch(() => {});
  const installed = (window.matchMedia && matchMedia('(display-mode: standalone)').matches) || navigator.standalone === true;
  const card = document.getElementById('install');
  const go = document.getElementById('install-go');
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
