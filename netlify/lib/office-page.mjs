// Barta Office: one page with tabs for the office's tools, served at /office by
// netlify/functions/office.mjs. Each tool loads in its own frame the first time
// its tab is opened and stays open, so switching tabs never loses work. Each
// tool keeps its own sign-in (its own password, remembered for a year).

export const TOOLS = [
  { id: "lights", label: "Christmas Lights", short: "Lights", src: "/lights", css: ".brand{display:none!important}", icon: '<path d="M9.5 18h5M10.5 21h3"/><path d="M12 3a6 6 0 0 0-3.6 10.8c.7.5 1.1 1.3 1.1 2.1v.1h5v-.1c0-.8.4-1.6 1.1-2.1A6 6 0 0 0 12 3z"/>' },
  { id: "followups", label: "Follow-ups", src: "/playbook", css: ".wrap>header>.brand,.wrap>footer{display:none!important}", icon: '<path d="M4.5 5.5h15a1.5 1.5 0 0 1 1.5 1.5v8.5a1.5 1.5 0 0 1-1.5 1.5H10l-4.5 3.5V17H4.5A1.5 1.5 0 0 1 3 15.5V7a1.5 1.5 0 0 1 1.5-1.5z"/><path d="M7.5 10h9M7.5 13h6"/>' },
  { id: "referrals", label: "Referrals", src: "/admin/referrals.html", css: ".ra-brand,#ra-signout,.skip{display:none!important}", seed: "referralAdminKey", icon: '<circle cx="8.5" cy="8.5" r="3"/><circle cx="16.5" cy="9.5" r="2.5"/><path d="M3 19c.6-3 2.8-4.6 5.5-4.6S13.4 16 14 19M14.6 14.6c.6-.2 1.2-.3 1.9-.3 2.3 0 4 1.4 4.5 4.2"/>' },
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
:root{color-scheme:light;--side:#16161b;--side-2:#24242b;--muted:rgba(255,255,255,.62);--coral:#fb4d3d;--coral-2:#ff6a3d;--mist:#f4f4f6}
*{box-sizing:border-box}
html,body{height:100%;margin:0}
body{display:flex;background:var(--side);color:#16161b;font:500 14px/1.4 'General Sans',system-ui,-apple-system,'Segoe UI',sans-serif;-webkit-font-smoothing:antialiased}
.side{flex:none;width:224px;display:flex;flex-direction:column;padding:18px 12px 14px;padding-left:max(12px,env(safe-area-inset-left));color:#fff}
.brand{display:flex;align-items:center;gap:10px;padding:4px 10px 22px;color:#fff;text-decoration:none}
.brand img{height:24px;width:auto;display:block;filter:brightness(0) invert(1)}
.brand span{font:800 17px/1 'Cabinet Grotesk',system-ui,sans-serif;letter-spacing:-.01em;color:var(--muted)}
.nav{display:flex;flex-direction:column;gap:3px}
.item{display:flex;align-items:center;gap:12px;height:44px;padding:0 12px;border:0;border-radius:12px;background:none;color:var(--muted);font:600 14.5px/1 inherit;font-family:inherit;text-align:left;text-decoration:none;cursor:pointer;transition:background .15s,color .15s}
.item:hover{background:var(--side-2);color:#fff}
.item[aria-selected="true"]{background:linear-gradient(135deg,var(--coral),var(--coral-2));color:#fff;box-shadow:0 8px 22px rgba(251,77,61,.28)}
.item svg{width:20px;height:20px;flex:none}
.item .short{display:none}
.item .ext{width:14px;height:14px;margin-left:auto;opacity:.6}
.side-foot{margin-top:auto;display:flex;flex-direction:column;gap:3px;padding-top:12px;border-top:1px solid rgba(255,255,255,.08)}
main{position:relative;flex:1;min-width:0;margin:8px 8px 8px 0;border-radius:18px;overflow:hidden;background:var(--mist)}
iframe{position:absolute;inset:0;width:100%;height:100%;border:0;background:var(--mist)}
iframe[hidden]{display:none}
.boot{position:absolute;inset:0;display:grid;place-items:center;color:#85858d;font-weight:600}
@media (max-width:860px){
  body{flex-direction:column-reverse}
  .side{width:auto;flex-direction:row;padding:6px max(6px,env(safe-area-inset-right)) max(6px,env(safe-area-inset-bottom)) max(6px,env(safe-area-inset-left))}
  .brand,.side-foot{display:none}
  .nav{flex-direction:row;flex:1;gap:4px}
  .item{flex:1;flex-direction:column;justify-content:center;gap:4px;height:56px;padding:0 4px;font-size:11px;border-radius:12px}
  .item[aria-selected="true"]{box-shadow:none}
  .item .full{display:none}.item .short{display:inline}
  main{margin:0;border-radius:0 0 18px 18px;padding-top:env(safe-area-inset-top)}
}
</style></head><body>
<aside class="side">
  <a class="brand" href="/office" aria-label="Barta Office"><img src="/assets/img/logo-bww.png" alt="" width="89" height="24"><span>Office</span></a>
  <nav class="nav" role="tablist" aria-label="Office tools">
${TOOLS.map((t) => `    <button type="button" class="item" role="tab" data-tool="${t.id}" aria-selected="false">${svg(t.icon)}<span class="full">${esc(t.label)}</span><span class="short">${esc(t.short || t.label)}</span></button>`).join("\n")}
  </nav>
  <div class="side-foot">
${LINKS.map((l) => `    <a class="item" href="${esc(l.href)}" target="_blank" rel="noopener">${svg('<rect x="4" y="4" width="16" height="16" rx="3"/><path d="M8 9h8M8 13h8M8 17h5"/>')}<span>${esc(l.label)}</span>${svg('<path d="M14 5h5v5M19 5l-8 8"/><path d="M18 14v4.5a1.5 1.5 0 0 1-1.5 1.5h-11A1.5 1.5 0 0 1 4 18.5v-11A1.5 1.5 0 0 1 5.5 6H10"/>').replace('<svg ', '<svg class="ext" ')}</a>`).join("\n")}
  </div>
</aside>
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
