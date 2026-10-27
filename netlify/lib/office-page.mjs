// Barta Office: one page with tabs for the office's tools, served at /office by
// netlify/functions/office.mjs. Each tool loads in its own frame the first time
// its tab is opened and stays open, so switching tabs never loses work. Each
// tool keeps its own sign-in (its own password, remembered for a year).

export const TOOLS = [
  { id: "lights", label: "Christmas Lights", short: "Lights", src: "/lights", css: ".brand{display:none!important}", icon: '<path d="M12 2.8c1.9 1.6 4.8 6.2 4.8 9.6a4.8 4.8 0 0 1-9.6 0c0-3.4 2.9-8 4.8-9.6z"/><path d="M9.6 17.2v2.3c0 .8.6 1.4 1.4 1.4h2c.8 0 1.4-.6 1.4-1.4v-2.3"/><path d="M9.6 19h4.8"/>' },
  { id: "followups", label: "Follow-ups", src: "/playbook", css: ".wrap>header>.brand,.wrap>footer{display:none!important}", icon: '<path d="M4.5 5.5h15a1.5 1.5 0 0 1 1.5 1.5v8.5a1.5 1.5 0 0 1-1.5 1.5H10l-4.5 3.5V17H4.5A1.5 1.5 0 0 1 3 15.5V7a1.5 1.5 0 0 1 1.5-1.5z"/><path d="M7.5 10h9M7.5 13h6"/>' },
  { id: "purchases", label: "Purchases", src: "/purchases", icon: '<path d="M3.5 4.5h2l2.2 10.2a1.5 1.5 0 0 0 1.5 1.2h7.9a1.5 1.5 0 0 0 1.5-1.1l1.6-6.3H6.6"/><circle cx="9.5" cy="19.5" r="1.3"/><circle cx="17" cy="19.5" r="1.3"/>' },
  { id: "giveaway", label: "Giveaway", src: "/admin/giveaway.html", css: "[data-gwa-logout]{display:none!important}", seed: "gwa-key", icon: '<rect x="3.5" y="9" width="17" height="11" rx="1.5"/><path d="M3.5 12.5h17M12 9v11"/><path d="M12 9c-1.5-3.5-5.5-4-5.5-1.5S10 9 12 9zm0 0c1.5-3.5 5.5-4 5.5-1.5S14 9 12 9z"/>' },
];
export const LINKS = [
  { label: "Rotor", href: "https://getrotor.com" },
];

const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);
const svg = (d) => `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${d}</svg>`;

export const OFFICE_HTML = `<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">
<meta name="robots" content="noindex, nofollow">
<meta name="theme-color" content="#16161b">
<title>Barta Office</title>
<style>
@font-face{font-family:'Cabinet Grotesk';src:url('/assets/fonts/CabinetGrotesk-Extrabold.v1.woff2') format('woff2');font-weight:800}
@font-face{font-family:'General Sans';src:url('/assets/fonts/GeneralSans-Medium.v1.woff2') format('woff2');font-weight:500}
@font-face{font-family:'General Sans';src:url('/assets/fonts/GeneralSans-Semibold.v1.woff2') format('woff2');font-weight:600}
:root{color-scheme:light;--ink:#16161b;--slate:#3b3b42;--muted:#67676f;--coral:#fb4d3d;--mist:#f4f4f6;--glass:rgba(255,255,255,.62);--glass-line:rgba(255,255,255,.5)}
*{box-sizing:border-box}
html,body{height:100%;margin:0}
body{background:var(--mist);color:var(--ink);font:500 14px/1.4 'General Sans',system-ui,-apple-system,'Segoe UI',sans-serif;-webkit-font-smoothing:antialiased}
/* Frosted header, like the website's: barely there until you look for it. */
.side{position:fixed;z-index:10;top:max(8px,env(safe-area-inset-top));left:50%;transform:translateX(-50%);width:min(1180px,calc(100% - 16px));height:54px;display:flex;align-items:center;gap:6px;padding:0 8px 0 18px;background:var(--glass);-webkit-backdrop-filter:saturate(180%) blur(40px);backdrop-filter:saturate(180%) blur(40px);border:1px solid var(--glass-line);border-radius:999px;box-shadow:0 6px 24px rgba(14,14,18,.07)}
.brand{display:flex;align-items:center;gap:9px;flex:none;margin-right:10px;color:inherit;text-decoration:none}
.brand img{height:24px;width:auto;display:block}
.brand span{font:800 15px/1 'Cabinet Grotesk',system-ui,sans-serif;letter-spacing:-.01em;color:var(--muted)}
.nav{display:flex;align-items:center;gap:2px;flex:1;min-width:0;overflow-x:auto;scrollbar-width:none}
.nav::-webkit-scrollbar{display:none}
.item{flex:none;display:inline-flex;align-items:center;gap:7px;height:38px;padding:0 13px;border:0;border-radius:999px;background:none;color:var(--slate);font:600 14px/1 inherit;font-family:inherit;text-decoration:none;white-space:nowrap;cursor:pointer;transition:background .2s,color .2s}
.item:hover{background:rgba(251,77,61,.08);color:var(--ink)}
.item[aria-selected="true"]{background:rgba(251,77,61,.1);color:var(--coral)}
.item svg{width:18px;height:18px;flex:none}
.item .short{display:none}
.item .ext{width:13px;height:13px;opacity:.55}
.side-foot{flex:none;display:flex;align-items:center}
main{position:fixed;left:0;right:0;bottom:0;top:calc(max(8px,env(safe-area-inset-top)) + 62px);background:var(--mist)}
iframe{position:absolute;inset:0;width:100%;height:100%;border:0;background:var(--mist)}
iframe[hidden]{display:none}
.boot{position:absolute;inset:0;display:grid;place-items:center;color:#85858d;font-weight:600}
@media (max-width:860px){
  .side{height:50px;padding:0 6px 0 12px}
  .brand span{display:none}
  .brand{margin-right:4px}
  .brand img{height:20px}
  .item{padding:0 8px;gap:5px;font-size:13px}
  .side-foot .item{padding:0 6px}
  .item .full{display:none}.item .short{display:inline}
  .item:not([aria-selected="true"]) .short{display:none}
  .side-foot .item span{display:none}
  main{top:calc(max(8px,env(safe-area-inset-top)) + 58px)}
}
</style></head><body>
<header class="side">
  <a class="brand" href="/office" aria-label="Barta Office"><img src="/assets/img/logo-bww.png" alt="" width="89" height="24"><span>Office</span></a>
  <nav class="nav" role="tablist" aria-label="Office tools">
${TOOLS.map((t) => `    <button type="button" class="item" role="tab" data-tool="${t.id}" aria-selected="false">${svg(t.icon)}<span class="full">${esc(t.label)}</span><span class="short">${esc(t.short || t.label)}</span></button>`).join("\n")}
  </nav>
  <div class="side-foot">
${LINKS.map((l) => `    <a class="item" href="${esc(l.href)}" target="_blank" rel="noopener">${svg('<rect x="4" y="4" width="16" height="16" rx="3"/><path d="M8 9h8M8 13h8M8 17h5"/>')}<span>${esc(l.label)}</span>${svg('<path d="M14 5h5v5M19 5l-8 8"/><path d="M18 14v4.5a1.5 1.5 0 0 1-1.5 1.5h-11A1.5 1.5 0 0 1 4 18.5v-11A1.5 1.5 0 0 1 5.5 6H10"/>').replace('<svg ', '<svg class="ext" ')}</a>`).join("\n")}
  </div>
</header>
<main id="main"><div class="boot">Loading…</div></main>
<script>
(() => {
  const TOOLS = ${JSON.stringify(TOOLS.map(({ id, label, src, css, seed }) => ({ id, label, src, css: css || "", seed: seed || "" })))};
  const main = document.getElementById('main');
  const frames = {};
  const store = { get(k) { try { return localStorage.getItem(k); } catch (e) { return null; } }, set(k, v) { try { localStorage.setItem(k, v); } catch (e) { /* no storage */ } } };
  // Signed in to the office: the dashboards don't need their own admin key.
  for (const t of TOOLS) if (t.seed) { try { if (!sessionStorage.getItem(t.seed)) sessionStorage.setItem(t.seed, 'office'); } catch (e) { /* no storage */ } }
  // Make each tool look like part of one app: drop its own logo, header extras and sign-out.
  function blend(f, t) {
    try {
      const d = f.contentDocument;
      if (!d || !d.head || d.getElementById('office-blend')) return;
      const st = d.createElement('style');
      st.id = 'office-blend';
      st.textContent = t.css;
      d.head.appendChild(st);
    } catch (e) { /* not ready */ }
  }
  function show(id) {
    const t = TOOLS.find((x) => x.id === id) || TOOLS[0];
    const boot = main.querySelector('.boot');
    if (!frames[t.id]) {
      const f = document.createElement('iframe');
      f.title = t.label;
      f.allow = 'clipboard-read; clipboard-write; fullscreen';
      f.addEventListener('load', () => { blend(f, t); if (boot) boot.remove(); });
      f.src = t.src;
      main.appendChild(f);
      frames[t.id] = f;
    }
    for (const k in frames) frames[k].hidden = k !== t.id;
    document.querySelectorAll('.item[data-tool]').forEach((b) => b.setAttribute('aria-selected', String(b.dataset.tool === t.id)));
    document.title = t.label + ' · Barta Office';
    store.set('barta-office-tab', t.id);
    if (location.hash !== '#' + t.id) history.replaceState(null, '', '#' + t.id);
    try { frames[t.id].contentWindow.focus(); } catch (e) { frames[t.id].focus(); }
  }
  document.querySelectorAll('.item[data-tool]').forEach((b) => b.addEventListener('click', () => show(b.dataset.tool)));
  window.addEventListener('hashchange', () => show(location.hash.slice(1)));
  show(location.hash.slice(1) || store.get('barta-office-tab') || TOOLS[0].id);
})();
</script>
</body></html>`;
