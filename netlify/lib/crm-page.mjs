// Barta Office → Customers (docs/CRM.md). The list is rendered on the server
// from the customer index in the "crm" Blobs store (so it shows even before
// the script runs); the same customers are embedded as JSON for instant
// search and the detail sheet, which the browser draws. Phone first: a
// sticky search bar, filter chips, letter groups with sticky headings, a
// letter rail, and a sheet that slides up (a side panel on a laptop). Before
// the first import (and from the "Re-import" link) the page is the Import
// screen instead: pick the sealed export file, upload it, reload. Light
// only, like every office tool.

import { customersSorted, customerView, memberNames, sourceCounts, ROTOR_CUSTOMER_URL } from "./crm-data.mjs";

const esc = (s) => String(s == null ? "" : s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);

// The one thing that can still stop the page: Blobs didn't answer.
const SETUP = {
  store: ["Storage didn't answer", "The customer list couldn't be read right now (Netlify's storage didn't answer in time). Pull to refresh in a minute; if it keeps happening, send Claude a screenshot."],
};

// What the Import screen says for each error code /api/crm/import returns.
// The endpoint answers with these same words as `message`
// (functions/crm-import.mjs imports them), so the two never drift.
export const IMPORT_MESSAGES = Object.freeze({
  "no-key": "The site has no OFFICE_DATA_KEY yet",
  "bad-key": "That file was sealed for a different key",
  "bad-bundle": "That is not a Barta export file",
  "bad-json": "That file isn't readable as JSON",
  "too-large": "That file is too big (6 MB is the most the site accepts)",
  "too-many": "That export has more customers than the Customers tab can hold (5,000 at most)",
  "too-big": "That export is too big for the Customers page to show",
  empty: "That export has no customers in it",
  preview: "Imports only run on the live site, not on a preview",
  store: "Storage didn't answer. Try again in a minute.",
});

export const SOURCE_CHIPS = 6;

const CSS = `
@font-face{font-family:'Cabinet Grotesk';src:url('/assets/fonts/CabinetGrotesk-Extrabold.v1.woff2') format('woff2');font-weight:800}
@font-face{font-family:'General Sans';src:url('/assets/fonts/GeneralSans-Medium.v1.woff2') format('woff2');font-weight:500}
@font-face{font-family:'General Sans';src:url('/assets/fonts/GeneralSans-Semibold.v1.woff2') format('woff2');font-weight:600}
:root{color-scheme:light;--ink:#16161b;--text-2:#4a4a52;--muted:#6b6b73;--line:#ececee;--mist:#f4f4f6;--card:#fff;--coral:#fb4d3d;--coral-wash:rgba(251,77,61,.10);--coral-ink:#d0331f;--fill:rgba(22,22,27,.05);--fill-2:rgba(22,22,27,.09);--green:#13a165;--green-bg:#e6f6ee;--blue:#2a78d6;--bar-h:112px}
*{box-sizing:border-box;-webkit-tap-highlight-color:transparent}
html{-webkit-text-size-adjust:100%}
body{margin:0;min-height:100vh;background:var(--mist);color:var(--ink);font:500 15px/1.45 'General Sans',system-ui,-apple-system,'Segoe UI',sans-serif;-webkit-font-smoothing:antialiased}
button,input{font:inherit;color:inherit}
button{cursor:pointer}
[hidden]{display:none!important}
.locked body{position:fixed;left:0;right:0;width:100%;overflow:hidden}
.top{position:sticky;top:0;z-index:5;background:var(--mist);padding:calc(10px + env(safe-area-inset-top)) max(16px,env(safe-area-inset-left)) 8px max(16px,env(safe-area-inset-right));border-bottom:1px solid var(--line)}
.top-in,.count,.wrap{max-width:760px;margin:0 auto}
.search{position:relative}
.search svg{position:absolute;left:15px;top:50%;width:18px;height:18px;margin-top:-9px;color:var(--muted);pointer-events:none}
.search input{width:100%;height:46px;padding:0 48px 0 42px;border:1.5px solid var(--line);border-radius:999px;background:#fff;font-size:16px;font-weight:500;outline:0;-webkit-appearance:none;appearance:none}
.search input::placeholder{color:#8c8c94}
.search input:focus{border-color:var(--coral);box-shadow:0 0 0 4px var(--coral-wash)}
.search input::-webkit-search-cancel-button,.search input::-webkit-search-decoration{-webkit-appearance:none;appearance:none}
.clear{position:absolute;right:3px;top:50%;transform:translateY(-50%);width:40px;height:40px;border:0;border-radius:50%;background:none;color:var(--text-2);display:grid;place-items:center}
.clear span{width:24px;height:24px;border-radius:50%;background:var(--fill-2);display:grid;place-items:center;font-size:15px;line-height:1}
.chips{display:flex;align-items:center;gap:6px;overflow-x:auto;scrollbar-width:none;margin:8px -16px 0;padding:2px 16px;-webkit-overflow-scrolling:touch}
.chips::-webkit-scrollbar{display:none}
.chip{flex:none;height:44px;padding:0 13px;border:1px solid var(--line);border-radius:999px;background:#fff;color:var(--text-2);font:600 14px/1 'General Sans',system-ui,sans-serif;display:inline-flex;align-items:center;gap:6px;white-space:nowrap}
.chip b{font-weight:600;color:var(--muted)}
.chip[aria-pressed="true"]{background:var(--ink);border-color:var(--ink);color:#fff}
.chip.src[aria-pressed="true"]{background:var(--coral);border-color:var(--coral)}
.chip[aria-pressed="true"] b{color:rgba(255,255,255,.75)}
.chips .sep{flex:none;width:1px;height:22px;background:#dcdce0;margin:0 4px}
.count{padding:12px 16px 2px;color:var(--muted);font-size:13.5px;font-weight:600}
.count b{color:var(--ink);font-weight:600}
.wrap{padding:0 16px calc(40px + env(safe-area-inset-bottom))}
.has-rail .wrap{padding-right:30px}
.grp{scroll-margin-top:calc(var(--bar-h) + 6px)}
.ltr{position:sticky;top:var(--bar-h);z-index:2;margin:0;padding:12px 4px 6px;background:var(--mist);font:800 15px/1 'Cabinet Grotesk',system-ui,sans-serif;letter-spacing:.06em;color:var(--muted)}
.rows{background:var(--card);border:1px solid var(--line);border-radius:20px;overflow:hidden}
.row{display:flex;align-items:center;gap:12px;min-height:60px;margin-top:-1px;padding:10px 14px 10px 16px;color:inherit;text-decoration:none;border-top:1px solid var(--line)}
.row:hover{background:#fcfcfd}
.row:active{background:var(--fill)}
.row:focus-visible{outline:3px solid rgba(251,77,61,.45);outline-offset:-3px}
.who{flex:1;min-width:0}
.nm{display:block;font-weight:600;font-size:16px;line-height:1.3;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.sub{display:block;color:var(--muted);font-size:14px;line-height:1.35;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.town{flex:none;max-width:38%;color:var(--text-2);font-size:14px;text-align:right;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.chev{flex:none;width:8px;height:8px;border-right:1.5px solid #b9b9c0;border-bottom:1.5px solid #b9b9c0;transform:rotate(-45deg);margin-right:2px}
.empty{margin:28px auto;max-width:360px;text-align:center;padding:28px 20px;background:var(--card);border:1px dashed #d4d4d9;border-radius:20px}
.empty b{display:block;font:800 20px/1.2 'Cabinet Grotesk',system-ui,sans-serif;margin-bottom:6px}
.empty p{margin:0 0 14px;color:var(--muted);font-size:14px}
.ghost{height:44px;padding:0 16px;border:0;border-radius:999px;background:var(--fill);font-weight:600;font-size:14px;color:var(--ink)}
.rail{position:fixed;z-index:4;right:0;top:calc(var(--bar-h) + 10px);bottom:calc(10px + env(safe-area-inset-bottom));width:26px;display:flex;flex-direction:column;justify-content:center;touch-action:none;user-select:none;-webkit-user-select:none}
.rail button{flex:0 1 18px;min-height:0;padding:0;border:0;background:none;color:var(--coral-ink);font:800 11px/1 'Cabinet Grotesk',system-ui,sans-serif;text-align:center}
.rail button.off{color:#c3c3c9}
.rail.live{background:rgba(22,22,27,.04);border-radius:999px 0 0 999px}
.bubble{position:fixed;z-index:30;right:40px;width:56px;height:56px;border-radius:50%;background:var(--ink);color:#fff;display:grid;place-items:center;font:800 26px/1 'Cabinet Grotesk',system-ui,sans-serif;transform:translateY(-50%);pointer-events:none;box-shadow:0 10px 30px rgba(0,0,0,.2)}
.back{position:fixed;inset:0;z-index:20;background:rgba(22,22,27,.38);opacity:0;transition:opacity .25s}
.back.on{opacity:1}
.sheet{position:fixed;z-index:21;left:0;right:0;bottom:0;max-height:92vh;max-height:92dvh;display:flex;flex-direction:column;background:#fff;border-radius:24px 24px 0 0;box-shadow:0 -10px 40px rgba(0,0,0,.18);transform:translateY(100%);transition:transform .3s cubic-bezier(.22,.61,.36,1);outline:0}
.sheet.on{transform:none}
.grab{flex:none;width:40px;height:5px;border-radius:999px;background:#d9d9de;margin:8px auto 0}
.sh-head{flex:none;display:flex;align-items:flex-start;gap:10px;padding:10px 12px 0 20px}
.sh-title{flex:1;min-width:0;padding-top:4px}
.sh-title h2{margin:0;font:800 26px/1.1 'Cabinet Grotesk',system-ui,sans-serif;letter-spacing:-.015em;overflow-wrap:anywhere}
.company{margin:4px 0 0;color:var(--text-2);font-size:15px;overflow-wrap:anywhere}
.x{flex:none;width:44px;height:44px;border:0;border-radius:50%;background:none;color:var(--text-2);display:grid;place-items:center}
.x span{width:32px;height:32px;border-radius:50%;background:var(--fill);display:grid;place-items:center;font-size:17px;line-height:1}
.x:hover span{background:var(--fill-2)}
.sh-body{flex:1;min-height:0;overflow:auto;-webkit-overflow-scrolling:touch;padding:8px 20px calc(26px + env(safe-area-inset-bottom))}
.pill{display:inline-flex;align-items:center;gap:6px;height:26px;padding:0 10px;border-radius:999px;font-size:12.5px;font-weight:600;margin-top:10px}
.pill::before{content:"";width:7px;height:7px;border-radius:50%;background:currentColor}
.st-active{background:var(--green-bg);color:var(--green)}
.st-inactive,.st-unknown{background:var(--fill);color:var(--text-2)}
.acts{display:grid;grid-auto-flow:column;grid-auto-columns:1fr;gap:8px;margin:14px 0 20px}
.act{display:flex;flex-direction:column;align-items:center;justify-content:center;gap:6px;min-height:64px;border-radius:16px;background:var(--coral-wash);color:var(--coral-ink);text-decoration:none;font:800 12px/1 'Cabinet Grotesk',system-ui,sans-serif;letter-spacing:.05em;text-transform:uppercase}
.act svg{width:22px;height:22px}
.act:hover{background:rgba(251,77,61,.15)}
.act:active{background:rgba(251,77,61,.22)}
.kv{display:grid;gap:14px}
.k{font-size:12px;font-weight:600;color:var(--muted);text-transform:uppercase;letter-spacing:.07em;margin-bottom:3px}
.v{font-size:15px;line-height:1.45;overflow-wrap:anywhere}
.v a{color:var(--ink);text-decoration:none;border-bottom:1px solid #d4d4d9}
.v a:hover{border-color:var(--coral)}
.v .dim{color:var(--muted)}
.tags{display:flex;flex-wrap:wrap;gap:6px}
.tag{display:inline-flex;align-items:center;height:28px;padding:0 11px;border-radius:999px;background:var(--fill);font-size:13px;font-weight:600;color:var(--text-2)}
.notes{margin:0;white-space:pre-wrap;overflow-wrap:anywhere;background:var(--mist);border-radius:14px;padding:12px 14px;font:inherit;font-size:14.5px;line-height:1.5}
.rotor{display:inline-flex;align-items:center;gap:6px;min-height:44px;margin-top:14px;color:var(--muted);font-size:13.5px;font-weight:600;text-decoration:none}
.rotor:hover{color:var(--ink)}
.rotor svg{width:13px;height:13px}
.err{margin:12px 16px;padding:12px 14px;border-radius:14px;background:#fff5f3;border:1px solid rgba(208,51,31,.25);color:#7a1d12;font-size:13px;line-height:1.4;word-break:break-word}
.err b{display:block;color:#d0331f}
.setup{max-width:520px;margin:12vh auto;text-align:center;padding:0 16px}
.setup h1{margin:0 0 10px;font:800 28px/1.05 'Cabinet Grotesk',system-ui,sans-serif;letter-spacing:-.015em}
.setup p{color:var(--text-2)}
.foot{margin:26px 0 0;text-align:center;color:var(--muted);font-size:13px;font-weight:600}
.foot a{color:var(--muted);text-decoration:underline;text-underline-offset:3px}
.foot a:hover{color:var(--ink)}
.imp{max-width:440px;margin:0 auto;padding:max(36px,9vh) 20px calc(40px + env(safe-area-inset-bottom));text-align:center}
.imp h1{margin:0 0 10px;font:800 30px/1.05 'Cabinet Grotesk',system-ui,sans-serif;letter-spacing:-.015em}
.imp .lead{margin:0 0 22px;color:var(--text-2);font-size:15.5px}
.imp .now{margin:-8px 0 22px;color:var(--muted);font-size:14px}
.btn{display:flex;align-items:center;justify-content:center;width:100%;min-height:58px;border:0;border-radius:999px;font:800 18px/1 'Cabinet Grotesk',system-ui,sans-serif;letter-spacing:.01em;cursor:pointer;text-decoration:none}
.btn.file{position:relative;background:var(--coral);color:#fff}
.btn.file:hover{background:#f03d2c}
.btn.file:active{background:var(--coral-ink)}
.btn.file:focus-within{outline:3px solid rgba(251,77,61,.45);outline-offset:3px}
.btn.go{margin-top:12px;background:var(--ink);color:#fff}
.btn.go:disabled{background:var(--fill-2);color:var(--muted);cursor:default}
.sr{position:absolute;width:1px;height:1px;margin:-1px;padding:0;border:0;overflow:hidden;clip:rect(0 0 0 0);white-space:nowrap}
.fname{min-height:22px;margin:12px 0 0;color:var(--text-2);font-size:14px;overflow-wrap:anywhere}
.status{min-height:22px;margin:14px 0 0;font-size:14.5px;font-weight:600;color:var(--muted)}
.status.bad{color:var(--coral-ink)}
.back-link{display:inline-flex;align-items:center;min-height:44px;margin-top:22px;color:var(--muted);font-weight:600;text-decoration:none}
.back-link:hover{color:var(--ink)}
@media (min-width:900px){
  .sheet{left:auto;top:0;bottom:0;width:460px;max-height:none;border-radius:0;transform:translateX(100%);box-shadow:-10px 0 40px rgba(0,0,0,.12)}
  .grab{display:none}
  .sh-head{padding-top:22px}
  .back{background:rgba(22,22,27,.16)}
  .rail{right:max(0px,calc(50% - 380px - 34px))}
}
@media (prefers-reduced-motion:reduce){.sheet,.back{transition:none}}
`;

// Everything below runs in the browser. The page's inline scripts are these
// fixed strings only (LEGACY_SCRIPTS): /crm/legacy's CSP allows exactly
// their hashes, so nothing a row could inject would run.
const ERROR_HOOK = "window.addEventListener('error',function(e){try{var b=document.getElementById('crm-err');if(!b)return;b.hidden=false;b.lastChild.textContent=(e.message||'Script error')+(e.lineno?' (line '+e.lineno+')':'')+' · '+navigator.userAgent}catch(x){}});";
const CLIENT = String.raw`
(() => { try {
  const D = JSON.parse(document.getElementById('crm-data').textContent);
  const C = D.customers;
  const ROTOR = ${JSON.stringify(ROTOR_CUSTOMER_URL)};
  const $ = (s, el = document) => el.querySelector(s);
  const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
  const html = document.documentElement;
  const phone = window.matchMedia ? matchMedia('(max-width:899px)') : { matches: true };

  // ---- the sticky bar's height drives the sticky letters and the rail ----
  const bar = $('.top');
  const setBar = () => html.style.setProperty('--bar-h', bar.offsetHeight + 'px');
  setBar();
  if (window.ResizeObserver) new ResizeObserver(setBar).observe(bar); else addEventListener('resize', setBar);

  // ---- search and filters ----
  const rows = [...document.querySelectorAll('.row')];
  const groups = [...document.querySelectorAll('.grp')].map((g) => ({ el: g, letter: g.dataset.l, rows: [...g.querySelectorAll('.row')].map((r) => Number(r.dataset.i)) }));
  const q = $('#q'), clearBtn = $('#clear'), count = $('#count'), empty = $('#empty'), rail = $('#rail');
  const railBtns = rail ? [...rail.querySelectorAll('button')] : [];
  const hay = C.map((c) => [c.name, c.company, c.phone, c.phoneFmt, c.address.join(' '), c.email, c.tags.join(' '), c.notes].join(' ').toLowerCase());
  let status = 'all';
  const srcs = new Set();
  const vis = new Array(C.length).fill(true);
  function apply(scrollUp) {
    const words = q.value.toLowerCase().trim().split(/\s+/).filter(Boolean);
    let n = 0;
    for (let i = 0; i < C.length; i++) {
      const c = C[i];
      const ok = (status === 'all' || c.status === status) && (!srcs.size || srcs.has(c.source)) && words.every((w) => hay[i].indexOf(w) !== -1);
      vis[i] = ok; rows[i].hidden = !ok; if (ok) n++;
    }
    const live = {};
    for (const g of groups) { const on = g.rows.some((i) => vis[i]); g.el.hidden = !on; live[g.letter] = on; }
    for (const b of railBtns) b.classList.toggle('off', !live[b.dataset.l]);
    const filtered = words.length || status !== 'all' || srcs.size;
    count.innerHTML = !filtered ? '<b>' + n + '</b> customers' + (D.exported ? ' · from Rotor, ' + esc(D.exported) : '') : n ? '<b>' + n + '</b> of ' + C.length + ' match' : 'No one matches';
    empty.hidden = n > 0;
    if (rail) rail.hidden = words.length > 0 || n < 40;
    html.classList.toggle('has-rail', !!rail && !rail.hidden);
    clearBtn.hidden = !q.value;
    if (scrollUp) scrollTo(0, 0);
  }
  q.addEventListener('input', () => apply(true));
  q.addEventListener('keydown', (e) => { if (e.key === 'Enter') { const i = vis.indexOf(true); if (i !== -1) { e.preventDefault(); q.blur(); open(C[i].id, rows[i]); } } if (e.key === 'Escape' && q.value) { q.value = ''; apply(true); } });
  clearBtn.addEventListener('click', () => { q.value = ''; apply(true); q.focus(); });
  $('#reset').addEventListener('click', () => { q.value = ''; status = 'all'; srcs.clear(); syncChips(); apply(true); });
  const chips = [...document.querySelectorAll('.chip')];
  function syncChips() { for (const b of chips) b.setAttribute('aria-pressed', String(b.dataset.status ? b.dataset.status === status : srcs.has(b.dataset.src))); }
  for (const b of chips) b.addEventListener('click', () => {
    if (b.dataset.status) status = b.dataset.status;
    else if (srcs.has(b.dataset.src)) srcs.delete(b.dataset.src); else srcs.add(b.dataset.src);
    syncChips(); apply(true);
  });

  // ---- letter rail: tap or slide a finger to jump ----
  if (rail) {
    const bubble = $('#bubble');
    let lastL = '';
    const jump = (y) => {
      const b = railBtns.find((x) => { const r = x.getBoundingClientRect(); return y >= r.top && y < r.bottom; });
      if (!b || b.dataset.l === lastL) return;
      lastL = b.dataset.l;
      const g = groups.find((x) => x.letter === lastL && !x.el.hidden);
      if (g) { scrollTo(0, g.el.getBoundingClientRect().top + scrollY - bar.offsetHeight - 6); }
      bubble.textContent = lastL; bubble.hidden = false; bubble.style.top = (b.getBoundingClientRect().top + b.offsetHeight / 2) + 'px';
    };
    const stop = () => { rail.classList.remove('live'); bubble.hidden = true; lastL = ''; };
    rail.addEventListener('pointerdown', (e) => { rail.setPointerCapture(e.pointerId); rail.classList.add('live'); jump(e.clientY); e.preventDefault(); });
    rail.addEventListener('pointermove', (e) => { if (rail.classList.contains('live')) jump(e.clientY); });
    rail.addEventListener('pointerup', stop); rail.addEventListener('pointercancel', stop);
    railBtns.forEach((b) => b.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { lastL = ''; jump(b.getBoundingClientRect().top + 2); setTimeout(stop, 600); } }));
  }

  // ---- the detail sheet ----
  const sheet = $('#sheet'), back = $('#back'), body = $('#sh-body'), title = $('#sh-title');
  const byId = new Map(C.map((c) => [c.id, c]));
  const ICON = {
    call: '<path d="M5 4h4l2 5-2.5 1.5a11 11 0 0 0 5 5L15 13l5 2v4a2 2 0 0 1-2 2A16 16 0 0 1 3 6a2 2 0 0 1 2-2"/>',
    text: '<path d="M21 12a8 8 0 0 1-11.6 7.1L4 21l1.9-4.6A8 8 0 1 1 21 12z"/>',
    email: '<rect x="3" y="5" width="18" height="14" rx="2"/><path d="m3 7 9 6 9-6"/>',
    go: '<path d="M12 21s-6-5.3-6-10a6 6 0 0 1 12 0c0 4.7-6 10-6 10z"/><circle cx="12" cy="11" r="2"/>',
  };
  const svg = (d) => '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' + d + '</svg>';
  const act = (href, icon, label, blank) => '<a class="act" href="' + esc(href) + '"' + (blank ? ' target="_blank" rel="noopener"' : '') + '>' + svg(ICON[icon]) + '<span>' + label + '</span></a>';
  const kv = (k, v) => v ? '<div><div class="k">' + k + '</div><div class="v">' + v + '</div></div>' : '';
  function render(c) {
    title.innerHTML = '<h2>' + esc(c.name) + '</h2>' + (c.company ? '<p class="company">' + esc(c.company) + '</p>' : '');
    const dial = c.phone && c.phone.length === 10 ? c.phone : '';
    const acts = [dial && act('tel:+1' + dial, 'call', 'Call'), dial && act('sms:+1' + dial, 'text', 'Text'), c.email && act('mailto:' + encodeURIComponent(c.email), 'email', 'Email'), c.maps && act(c.maps, 'go', 'Directions', true)].filter(Boolean);
    const label = c.status ? c.status.charAt(0).toUpperCase() + c.status.slice(1) : 'Unknown';
    body.innerHTML = '<span class="pill st-' + esc(c.status) + '">' + esc(label) + '</span>'
      + (acts.length ? '<div class="acts">' + acts.join('') + '</div>' : '<div style="height:14px"></div>')
      + '<div class="kv">'
      + kv('Phone', c.phoneFmt ? (dial ? '<a href="tel:+1' + esc(dial) + '">' + esc(c.phoneFmt) + '</a>' : esc(c.phoneFmt)) : '')
      + kv('Email', c.email ? '<a href="mailto:' + esc(encodeURIComponent(c.email)) + '">' + esc(c.email) + '</a>' : '')
      + kv('Address', c.address.length ? (c.maps ? '<a href="' + esc(c.maps) + '" target="_blank" rel="noopener">' : '<span>') + c.address.map(esc).join('<br>') + (c.maps ? '</a>' : '</span>') : '<span class="dim">No address in Rotor</span>')
      + kv('Source', esc(c.source))
      + kv('Tags', c.tags.length ? '<div class="tags">' + c.tags.map((t) => '<span class="tag">' + esc(t) + '</span>').join('') + '</div>' : '')
      + kv('Assigned to', c.assigned.map(esc).join(', '))
      + kv('Customer since', esc(c.since))
      + kv('Notes', c.notes ? '<pre class="notes">' + esc(c.notes) + '</pre>' : '')
      + '</div>'
      + '<a class="rotor" href="' + esc(ROTOR + encodeURIComponent(c.id)) + '" target="_blank" rel="noopener">Open in Rotor ' + svg('<path d="M14 5h5v5M19 5l-8 8"/><path d="M18 14v4.5a1.5 1.5 0 0 1-1.5 1.5h-11A1.5 1.5 0 0 1 4 18.5v-11A1.5 1.5 0 0 1 5.5 6H10"/>') + '</a>';
  }
  let openId = null, lastRow = null, y0 = 0, hideT = null;
  const lock = () => { if (!phone.matches) return; y0 = scrollY; document.body.style.top = -y0 + 'px'; html.classList.add('locked'); };
  const unlock = () => { if (!html.classList.contains('locked')) return; html.classList.remove('locked'); document.body.style.top = ''; scrollTo(0, y0); };
  function show(id) {
    const c = byId.get(id); if (!c) return hide();
    const fresh = !openId; openId = id; clearTimeout(hideT);
    render(c); body.scrollTop = 0;
    if (fresh) { lock(); sheet.hidden = false; back.hidden = false; void sheet.offsetWidth; sheet.classList.add('on'); back.classList.add('on'); }
    sheet.focus({ preventScroll: true });
  }
  function hide() {
    if (!openId) return;
    openId = null;
    sheet.classList.remove('on'); back.classList.remove('on'); unlock();
    hideT = setTimeout(() => { if (!openId) { sheet.hidden = true; back.hidden = true; } }, 320);
    if (lastRow) { lastRow.focus({ preventScroll: true }); lastRow = null; }
  }
  // The sheet is a history entry, so the phone's back gesture closes it.
  function open(id, row) { lastRow = row || null; history.pushState({ crm: id }, '', '#c=' + encodeURIComponent(id)); show(id); }
  function close() { if (history.state && history.state.crm) history.back(); else hide(); }
  addEventListener('popstate', () => { const s = history.state; if (s && s.crm) show(s.crm); else hide(); });
  rows.forEach((r) => r.addEventListener('click', (e) => { if (e.metaKey || e.ctrlKey) return; e.preventDefault(); open(C[Number(r.dataset.i)].id, r); }));
  $('#x').addEventListener('click', close);
  back.addEventListener('click', close);
  addEventListener('keydown', (e) => { if (e.key === 'Escape' && openId) { e.preventDefault(); close(); } });

  apply(false);
  const m = /#c=([^&]+)/.exec(location.hash);
  if (m) { history.replaceState(null, '', location.pathname + location.search); let id = null; try { id = decodeURIComponent(m[1]); } catch (e) { /* not a valid id */ } if (id) open(id); }
} catch (err) {
  const b = document.getElementById('crm-err');
  if (b) { b.hidden = false; b.lastChild.textContent = (err && err.message || String(err)) + ' · ' + navigator.userAgent; }
} })();
`;

const SEARCH_ICON = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true"><circle cx="11" cy="11" r="7"/><path d="m20 20-3.5-3.5"/></svg>';

function rowHtml(c, i) {
  return `<a class="row" href="#c=${esc(encodeURIComponent(c.id))}" data-i="${i}"><span class="who"><span class="nm">${esc(c.name)}</span>${c.company ? `<span class="sub">${esc(c.company)}</span>` : ""}${c.phoneFmt ? `<span class="sub">${esc(c.phoneFmt)}</span>` : ""}</span>${c.city ? `<span class="town">${esc(c.city)}</span>` : ""}<span class="chev" aria-hidden="true"></span></a>`;
}

// "Nov 8, 2026" from the export's plain date (YYYY-MM-DD) ...
export const exportedLabel = (iso) => {
  const d = new Date(String(iso || "") + "T12:00:00Z");
  return Number.isNaN(d.getTime()) ? "" : d.toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric", timeZone: "UTC" });
};
// ... and from the import's timestamp, in the company's time zone.
export const importedLabel = (iso) => {
  const d = new Date(String(iso || ""));
  return Number.isNaN(d.getTime()) ? "" : d.toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric", timeZone: "America/Chicago" });
};
// The list moved from /crm to /crm/legacy in M1.2 (the new CRM shell owns /crm).
export const LIST_PATH = "/crm/legacy";
export const IMPORT_PATH = "/crm/legacy?import=1";

// The whole page from the customer index { exported_at, imported_at, customers, members }.
export function customersHtml(data) {
  const members = memberNames(data.members || []);
  const views = customersSorted(data.customers || []).map((c) => customerView(c, members));
  const groups = [];
  views.forEach((v, i) => {
    const last = groups[groups.length - 1];
    if (last && last.letter === v.letter) last.items.push(i); else groups.push({ letter: v.letter, items: [i] });
  });
  const counts = { active: views.filter((v) => v.status === "active").length, inactive: views.filter((v) => v.status === "inactive").length };
  const sources = sourceCounts(views).slice(0, SOURCE_CHIPS);
  const exported = exportedLabel(data.exported_at);
  const imported = importedLabel(data.imported_at);
  // The browser gets display strings only; letters live in the markup.
  const payload = { exported, customers: views.map(({ letter, statusLabel, ...v }) => v) };

  const chip = (label, count, attrs, pressed = false) => `<button type="button" class="chip${attrs.includes("data-src") ? " src" : ""}" ${attrs} aria-pressed="${pressed}">${esc(label)} <b>${count}</b></button>`;
  const chips = [
    chip("All", views.length, 'data-status="all"', true),
    chip("Active", counts.active, 'data-status="active"'),
    chip("Inactive", counts.inactive, 'data-status="inactive"'),
    sources.length ? '<span class="sep" aria-hidden="true"></span>' : "",
    ...sources.map((s) => chip(s.label, s.count, `data-src="${esc(s.label)}"`)),
  ].join("");

  const list = groups.map((g) => `<section class="grp" data-l="${esc(g.letter)}"><h2 class="ltr">${esc(g.letter)}</h2><div class="rows">${g.items.map((i) => rowHtml(views[i], i)).join("")}</div></section>`).join("\n");
  const rail = groups.length > 1 ? `<nav class="rail" id="rail" aria-label="Jump to a letter">${groups.map((g) => `<button type="button" data-l="${esc(g.letter)}">${esc(g.letter)}</button>`).join("")}</nav><div class="bubble" id="bubble" aria-hidden="true" hidden></div>` : "";

  return `<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">
<meta name="robots" content="noindex, nofollow">
<meta name="theme-color" content="#f4f4f6">
<title>Customers · Barta Office</title>
<script>${ERROR_HOOK}</script>
<style>${CSS}</style></head><body>
<header class="top"><div class="top-in">
  <div class="search">${SEARCH_ICON}<input type="search" id="q" placeholder="Search name, phone, address…" autocomplete="off" autocorrect="off" autocapitalize="off" spellcheck="false" aria-label="Search customers" enterkeyhint="search"><button type="button" class="clear" id="clear" aria-label="Clear search" hidden><span>&times;</span></button></div>
  <div class="chips" role="group" aria-label="Show">${chips}</div>
</div></header>
<div class="err" id="crm-err" role="alert" hidden><b>The list didn't finish loading.</b> Send Claude a screenshot of this: <span></span></div>
<div class="count" id="count" role="status" aria-live="polite"><b>${views.length}</b> customers${exported ? ` · from Rotor, ${esc(exported)}` : ""}</div>
<main class="wrap">
${list}
<div class="empty" id="empty" hidden><b>No one matches</b><p>Try fewer words, or just a last name or a phone number.</p><button type="button" class="ghost" id="reset">Clear search and filters</button></div>
${imported ? `<p class="foot">Imported ${esc(imported)} · <a href="${IMPORT_PATH}">Re-import</a></p>` : ""}
</main>
${rail}
<div class="back" id="back" hidden></div>
<section class="sheet" id="sheet" role="dialog" aria-modal="true" aria-labelledby="sh-title" tabindex="-1" hidden>
  <div class="grab" aria-hidden="true"></div>
  <div class="sh-head"><div class="sh-title" id="sh-title"></div><button type="button" class="x" id="x" aria-label="Close"><span>&#x2715;</span></button></div>
  <div class="sh-body" id="sh-body"></div>
</section>
<script type="application/json" id="crm-data">${JSON.stringify(payload).replace(/</g, "\\u003c")}</script>
<script>${CLIENT}</script>
</body></html>`;
}

const HEAD = (title) => `<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">
<meta name="robots" content="noindex, nofollow">
<meta name="theme-color" content="#f4f4f6">
<title>${esc(title)}</title>
<style>${CSS}</style></head>`;

export function setupHtml(reason) {
  const [title, text] = SETUP[reason] || SETUP.store;
  return `${HEAD("Customers · Barta Office")}<body><div class="setup"><h1>${esc(title)}</h1><p>${esc(text)}</p><a class="back-link" href="${IMPORT_PATH}">Re-import</a></div></body></html>`;
}

// The upload, in the browser: read the chosen file as text and POST it as
// JSON; the server answers with a code the screen turns into plain words.
// When the file would shrink the list a lot or is older than the one
// loaded, the server asks first (409 "confirm"); "Replace anyway" sends the
// same text again with ?confirm=1.
const IMPORT_CLIENT = String.raw`
(() => {
  const $ = (id) => document.getElementById(id);
  const file = $('file'), go = $('go'), force = $('force'), fname = $('fname'), status = $('status'), form = $('imp');
  const MSG = ${JSON.stringify(IMPORT_MESSAGES)};
  let pending = null;
  const say = (text, bad) => { status.textContent = text; status.classList.toggle('bad', !!bad); };
  const busy = (on) => { go.disabled = on || !file.files[0]; file.disabled = on; force.disabled = on; };
  const ask = (text) => { pending = text; force.hidden = !text; };
  file.addEventListener('change', () => {
    const f = file.files[0];
    fname.textContent = f ? f.name + ' · ' + Math.max(1, Math.round(f.size / 1024)) + ' KB' : '';
    say('');
    ask(null);
    busy(false);
  });
  const send = async (text, confirmed) => {
    busy(true);
    ask(null);
    say('Uploading…');
    try {
      const res = await fetch('/api/crm/import' + (confirmed ? '?confirm=1' : ''), { method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': 'application/json', 'X-CRM': '1' }, body: text });
      if (res.status === 401) { (window.top || window).location.href = '/office#crm'; return; }
      let body = null;
      try { body = await res.json(); } catch (x) { /* not JSON */ }
      if (res.ok && body && body.ok) {
        say('Imported ' + body.counts.customers + ' customers. Loading the list…');
        location.replace('/crm/legacy');
        return;
      }
      const code = body && (typeof body.error === 'string' ? body.error : body.error && body.error.code === 'too_large' ? 'too-large' : body.error && body.error.code);
      if (code === 'confirm' && !confirmed) {
        say(body.message || 'This file would replace a bigger or newer list. Replace it anyway?', true);
        ask(text);
      } else {
        say(MSG[code] || (body && body.message) || ('The import failed (' + res.status + '). Try again.'), true);
      }
    } catch (x) {
      say('No connection. Try again.', true);
    }
    busy(false);
  };
  force.addEventListener('click', () => { if (pending) send(pending, true); });
  form.addEventListener('submit', (e) => {
    e.preventDefault();
    const f = file.files[0];
    if (!f || go.disabled) return;
    busy(true);
    say('Reading the file…');
    const r = new FileReader();
    r.onerror = () => { say("Couldn't read that file.", true); busy(false); };
    r.onload = () => send(r.result, false);
    r.readAsText(f);
  });
})();
`;

// The Import screen: before the first import, and from "Re-import" once
// there is a list (`current` = { imported_at, count } then). `damaged` says
// the saved list couldn't be read, so this import replaces it.
export function importHtml({ current = null, damaged = false } = {}) {
  const when = current ? importedLabel(current.imported_at) : "";
  const now = current
    ? `<p class="now">Last import: ${esc(when ? when + " · " : "")}${Number(current.count) || 0} customers. A re-import replaces everything.</p>`
    : damaged ? '<p class="now">The saved customer list couldn&#39;t be read. Import the file again to replace it.</p>' : "";
  return `${HEAD("Import customers · Barta Office")}<body>
<main class="imp">
  <h1>Import your customers</h1>
  <p class="lead">Upload the sealed export file Claude gave you. It only opens on this site.</p>
  ${now}
  <form id="imp" novalidate>
    <label class="btn file" for="file">Choose file<input type="file" id="file" name="file" accept=".json,application/json" class="sr"></label>
    <div class="fname" id="fname" aria-live="polite"></div>
    <button type="submit" class="btn go" id="go" disabled>Import</button>
    <div class="status" id="status" role="status" aria-live="polite"></div>
    <button type="button" class="btn go" id="force" hidden>Replace anyway</button>
  </form>
  ${current ? '<a class="back-link" href="/crm/legacy">&larr; Back to the list</a>' : ""}
</main>
<script>${IMPORT_CLIENT}</script>
</body></html>`;
}

// The page's inline scripts, for /crm/legacy's CSP hashes (crm.mjs).
export const LEGACY_SCRIPTS = Object.freeze([ERROR_HOOK, CLIENT, IMPORT_CLIENT]);
