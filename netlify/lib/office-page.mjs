// Barta Office: one page with tabs for the office's tools, served at /office by
// netlify/functions/office.mjs. Each tool loads in its own frame the first time
// its tab is opened and stays open, so switching tabs never loses work. Each
// tool keeps its own sign-in (its own password, remembered for a year).

export const TOOLS = [
  { id: "lights", label: "Christmas Lights", src: "/lights", icon: '<path d="M9.5 18h5M10.5 21h3"/><path d="M12 3a6 6 0 0 0-3.6 10.8c.7.5 1.1 1.3 1.1 2.1v.1h5v-.1c0-.8.4-1.6 1.1-2.1A6 6 0 0 0 12 3z"/>' },
  { id: "followups", label: "Follow-ups", src: "/playbook", icon: '<path d="M4.5 5.5h15a1.5 1.5 0 0 1 1.5 1.5v8.5a1.5 1.5 0 0 1-1.5 1.5H10l-4.5 3.5V17H4.5A1.5 1.5 0 0 1 3 15.5V7a1.5 1.5 0 0 1 1.5-1.5z"/><path d="M7.5 10h9M7.5 13h6"/>' },
  { id: "referrals", label: "Referrals", src: "/admin/referrals.html", icon: '<circle cx="8.5" cy="8.5" r="3"/><circle cx="16.5" cy="9.5" r="2.5"/><path d="M3 19c.6-3 2.8-4.6 5.5-4.6S13.4 16 14 19M14.6 14.6c.6-.2 1.2-.3 1.9-.3 2.3 0 4 1.4 4.5 4.2"/>' },
  { id: "giveaway", label: "Giveaway", src: "/admin/giveaway.html", icon: '<rect x="3.5" y="9" width="17" height="11" rx="1.5"/><path d="M3.5 12.5h17M12 9v11"/><path d="M12 9c-1.5-3.5-5.5-4-5.5-1.5S10 9 12 9zm0 0c1.5-3.5 5.5-4 5.5-1.5S14 9 12 9z"/>' },
];
export const LINKS = [
  { label: "Rotor", href: "https://getrotor.com" },
];

const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);
const svg = (d) => `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${d}</svg>`;

export const OFFICE_HTML = `<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">
<meta name="robots" content="noindex, nofollow">
<title>Barta Office</title>
<style>
@font-face{font-family:'Cabinet Grotesk';src:url('/assets/fonts/CabinetGrotesk-Extrabold.v1.woff2') format('woff2');font-weight:800}
@font-face{font-family:'General Sans';src:url('/assets/fonts/GeneralSans-Medium.v1.woff2') format('woff2');font-weight:500}
@font-face{font-family:'General Sans';src:url('/assets/fonts/GeneralSans-Semibold.v1.woff2') format('woff2');font-weight:600}
:root{color-scheme:light;--ink:#16161b;--ink-2:#4a4a52;--ink-3:#85858d;--line:#e7e7ea;--mist:#f4f4f6;--coral:#fb4d3d;--fill:rgba(22,22,27,.05);--fill-2:rgba(22,22,27,.09)}
*{box-sizing:border-box}
html,body{height:100%;margin:0}
body{display:flex;flex-direction:column;background:var(--mist);color:var(--ink);font:500 14px/1.4 'General Sans',system-ui,-apple-system,'Segoe UI',sans-serif;-webkit-font-smoothing:antialiased}
.bar{flex:none;display:flex;align-items:center;gap:10px;padding:8px max(12px,env(safe-area-inset-right)) 8px max(12px,env(safe-area-inset-left));padding-top:max(8px,env(safe-area-inset-top));background:#fff;border-bottom:1px solid var(--line)}
.brand{display:flex;align-items:center;gap:10px;flex:none;padding-right:6px;text-decoration:none;color:inherit}
.brand img{height:26px;width:auto;display:block}
.brand b{font:800 16px/1 'Cabinet Grotesk',system-ui,sans-serif;letter-spacing:-.01em}
.tabs{display:flex;gap:4px;overflow-x:auto;scrollbar-width:none;flex:1;min-width:0}
.tabs::-webkit-scrollbar{display:none}
.tab{flex:none;height:40px;padding:0 15px 0 12px;border:0;border-radius:999px;background:none;display:inline-flex;align-items:center;gap:8px;font:600 14px/1 inherit;font-family:inherit;color:var(--ink-2);cursor:pointer;text-decoration:none;white-space:nowrap;transition:background .15s,color .15s}
.tab:hover{background:var(--fill-2);color:var(--ink)}
.tab[aria-selected="true"]{background:var(--ink);color:#fff}
.tab svg{width:19px;height:19px;flex:none}
.ext{color:var(--ink-3)}
.ext svg{width:15px;height:15px}
.sep{flex:none;width:1px;height:24px;background:var(--line);margin:0 4px}
main{position:relative;flex:1;min-height:0}
iframe{position:absolute;inset:0;width:100%;height:100%;border:0;background:var(--mist)}
iframe[hidden]{display:none}
@media (max-width:720px){.brand b{display:none}.tab{padding:0 12px 0 10px;font-size:13px}.tab span{display:none}.tab[aria-selected="true"] span{display:inline}}
</style></head><body>
<header class="bar">
  <a class="brand" href="/office" aria-label="Barta Office"><img src="/assets/img/logo-bww.png" alt="" width="97" height="26"><b>Office</b></a>
  <nav class="tabs" role="tablist" aria-label="Office tools">
${TOOLS.map((t) => `    <button type="button" class="tab" role="tab" data-tool="${t.id}" aria-selected="false" title="${esc(t.label)}">${svg(t.icon)}<span>${esc(t.label)}</span></button>`).join("\n")}
    <span class="sep" aria-hidden="true"></span>
${LINKS.map((l) => `    <a class="tab ext" href="${esc(l.href)}" target="_blank" rel="noopener" title="${esc(l.label)} (opens a new tab)"><span>${esc(l.label)}</span>${svg('<path d="M14 5h5v5M19 5l-8 8"/><path d="M18 14v4.5a1.5 1.5 0 0 1-1.5 1.5h-11A1.5 1.5 0 0 1 4 18.5v-11A1.5 1.5 0 0 1 5.5 6H10"/>')}</a>`).join("\n")}
  </nav>
</header>
<main id="main"></main>
<script>
(() => {
  const TOOLS = ${JSON.stringify(TOOLS.map(({ id, label, src }) => ({ id, label, src })))};
  const main = document.getElementById('main');
  const frames = {};
  const store = { get(k) { try { return localStorage.getItem(k); } catch (e) { return null; } }, set(k, v) { try { localStorage.setItem(k, v); } catch (e) { /* no storage */ } } };
  function show(id) {
    const t = TOOLS.find((x) => x.id === id) || TOOLS[0];
    if (!frames[t.id]) {
      const f = document.createElement('iframe');
      f.title = t.label;
      f.src = t.src;
      f.allow = 'clipboard-read; clipboard-write; fullscreen';
      main.appendChild(f);
      frames[t.id] = f;
    }
    for (const k in frames) frames[k].hidden = k !== t.id;
    document.querySelectorAll('.tab[data-tool]').forEach((b) => b.setAttribute('aria-selected', String(b.dataset.tool === t.id)));
    document.title = t.label + ' · Barta Office';
    store.set('barta-office-tab', t.id);
    if (location.hash !== '#' + t.id) history.replaceState(null, '', '#' + t.id);
    frames[t.id].focus();
  }
  document.querySelectorAll('.tab[data-tool]').forEach((b) => b.addEventListener('click', () => show(b.dataset.tool)));
  window.addEventListener('hashchange', () => show(location.hash.slice(1)));
  show(location.hash.slice(1) || store.get('barta-office-tab') || TOOLS[0].id);
})();
</script>
</body></html>`;
