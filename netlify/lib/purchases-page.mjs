// Barta Office → Purchases page (served at /purchases by functions/purchases.mjs).
export const PURCHASES_HTML = String.raw`<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">
<meta name="robots" content="noindex, nofollow">
<title>Purchases · Barta Office</title>
<style>
@font-face{font-family:'Cabinet Grotesk';src:url('/assets/fonts/CabinetGrotesk-Extrabold.v1.woff2') format('woff2');font-weight:800}
@font-face{font-family:'General Sans';src:url('/assets/fonts/GeneralSans-Medium.v1.woff2') format('woff2');font-weight:500}
@font-face{font-family:'General Sans';src:url('/assets/fonts/GeneralSans-Semibold.v1.woff2') format('woff2');font-weight:600}
:root{color-scheme:light;--ink:#16161b;--ink-2:#4a4a52;--ink-3:#85858d;--line:#e7e7ea;--mist:#f4f4f6;--fill:rgba(22,22,27,.05);--fill-2:rgba(22,22,27,.09);--coral:#fb4d3d;--coral-2:#ff6a3d;--coral-ink:#d0331f;--green:#13a165;--green-bg:#e6f6ee;--amber:#b7791f;--amber-bg:#fff4dc;--blue:#2563eb;--blue-bg:#e8efff;--red-bg:#fdecea}
*{box-sizing:border-box}
html,body{margin:0}
body{background:var(--mist);color:var(--ink);font:500 15px/1.45 'General Sans',system-ui,-apple-system,'Segoe UI',sans-serif;-webkit-font-smoothing:antialiased}
button,input,textarea,select{font:inherit;color:inherit}
button{cursor:pointer}
.wrap{max-width:980px;margin:0 auto;padding:22px max(16px,env(safe-area-inset-left)) 60px}
.head{display:flex;flex-wrap:wrap;align-items:center;gap:12px 16px}
h1{margin:0;font:800 32px/1.05 'Cabinet Grotesk',system-ui,sans-serif;letter-spacing:-.02em}
.who{display:flex;align-items:center;gap:6px;margin-left:auto;padding:4px;border-radius:999px;background:#fff;border:1px solid var(--line)}
.who span{font-size:13px;font-weight:600;color:var(--ink-3);padding:0 6px 0 10px}
.who button{height:34px;padding:0 14px;border:0;border-radius:999px;background:none;font-weight:600;font-size:14px;color:var(--ink-2)}
.who button[aria-pressed="true"]{background:var(--ink);color:#fff}
.who.need{box-shadow:0 0 0 3px rgba(251,77,61,.35);animation:nudge .5s}
@keyframes nudge{25%{transform:translateX(-5px)}75%{transform:translateX(5px)}}
.cta{height:44px;padding:0 20px 0 16px;border:0;border-radius:999px;display:inline-flex;align-items:center;gap:8px;background:linear-gradient(135deg,var(--coral),var(--coral-2));color:#fff;font:800 14px/1 'Cabinet Grotesk',system-ui,sans-serif;letter-spacing:.04em;text-transform:uppercase;box-shadow:0 10px 26px rgba(251,77,61,.3)}
.cta svg{width:18px;height:18px}
.ghost{height:36px;padding:0 14px;border:0;border-radius:999px;background:var(--fill);font-weight:600;font-size:13.5px;color:var(--ink)}
.ghost:hover{background:var(--fill-2)}
.sums{display:grid;grid-template-columns:repeat(auto-fit,minmax(170px,1fr));gap:10px;margin:18px 0 14px}
.sum{background:#fff;border:1px solid var(--line);border-radius:16px;padding:12px 16px}
.sum b{display:block;font:800 22px/1.1 'Cabinet Grotesk',system-ui,sans-serif}
.sum span{font-size:12.5px;color:var(--ink-3);font-weight:600}
.tabs{display:flex;gap:6px;overflow-x:auto;scrollbar-width:none;padding:2px 0 12px}
.tabs::-webkit-scrollbar{display:none}
.tab{flex:none;height:36px;padding:0 14px;border:1px solid var(--line);border-radius:999px;background:#fff;font-weight:600;font-size:13.5px;color:var(--ink-2)}
.tab b{margin-left:4px;color:var(--ink-3)}
.tab[aria-pressed="true"]{background:var(--ink);border-color:var(--ink);color:#fff}
.tab[aria-pressed="true"] b{color:rgba(255,255,255,.7)}
.list{display:flex;flex-direction:column;gap:12px}
.card{background:#fff;border:1px solid var(--line);border-radius:20px;padding:16px 18px}
.row1{display:flex;gap:12px;align-items:flex-start}
.title{flex:1;min-width:0}
.title h3{margin:0;font:800 19px/1.2 'Cabinet Grotesk',system-ui,sans-serif;letter-spacing:-.01em;overflow-wrap:anywhere}
.title h3 a{color:inherit;text-decoration:none}
.title h3 a:hover{color:var(--coral-ink);text-decoration:underline}
.meta{margin-top:3px;font-size:13px;color:var(--ink-3)}
.price{flex:none;text-align:right}
.price b{display:block;font:800 20px/1.1 'Cabinet Grotesk',system-ui,sans-serif}
.price span{font-size:12.5px;color:var(--ink-3)}
.why{margin:10px 0 0;color:var(--ink-2);white-space:pre-wrap;overflow-wrap:anywhere}
.pill{display:inline-flex;align-items:center;gap:6px;height:26px;padding:0 10px;border-radius:999px;font-size:12.5px;font-weight:600}
.pill::before{content:"";width:7px;height:7px;border-radius:50%;background:currentColor}
.st-requested{background:var(--amber-bg);color:var(--amber)}
.st-approved{background:var(--green-bg);color:var(--green)}
.st-denied{background:var(--red-bg);color:var(--coral-ink)}
.st-ordered{background:var(--blue-bg);color:var(--blue)}
.st-delivered{background:var(--fill);color:var(--ink-2)}
.votes{display:flex;flex-wrap:wrap;align-items:center;gap:6px;margin-top:12px}
.vote{display:inline-flex;align-items:center;gap:5px;height:28px;padding:0 10px;border-radius:999px;background:var(--fill);font-size:13px;font-weight:600;color:var(--ink-3)}
.vote.yes{background:var(--green-bg);color:var(--green)}
.vote.no{background:var(--red-bg);color:var(--coral-ink)}
.vote.decider{outline:1.5px solid currentColor;outline-offset:-1.5px}
.vote small{font-weight:500;opacity:.8}
.acts{display:flex;flex-wrap:wrap;gap:8px;margin-top:12px;align-items:center}
.btn{height:38px;padding:0 15px;border:0;border-radius:999px;font-weight:600;font-size:14px;display:inline-flex;align-items:center;gap:6px;text-decoration:none}
.btn.yes{background:var(--green);color:#fff}
.btn.no{background:#fff;color:var(--coral-ink);border:1.5px solid #f3c2bb}
.btn.main{background:var(--ink);color:#fff}
.btn.soft{background:var(--fill);color:var(--ink)}
.btn.link{background:var(--blue-bg);color:var(--blue)}
.btn:disabled{opacity:.5;cursor:default}
.more{margin-left:auto;background:none;border:0;color:var(--ink-3);font-size:13px;font-weight:600;padding:6px}
.more:hover{color:var(--ink)}
.order,.editf,.newf{display:grid;gap:10px;margin-top:12px;padding:14px;border-radius:16px;background:var(--mist)}
.grid2{display:grid;grid-template-columns:1fr 1fr;gap:10px}
label.f{display:grid;gap:5px;font-size:12.5px;font-weight:600;color:var(--ink-2)}
label.f input,label.f textarea{width:100%;padding:11px 13px;border:1.5px solid var(--line);border-radius:12px;background:#fff;font-size:15px;font-weight:500;outline:0}
label.f input:focus,label.f textarea:focus{border-color:var(--coral);box-shadow:0 0 0 4px rgba(251,77,61,.12)}
label.f textarea{min-height:70px;resize:vertical}
.notes{margin-top:12px;display:grid;gap:6px}
.note{font-size:14px;color:var(--ink-2);padding:8px 12px;border-radius:12px;background:var(--mist)}
.note b{color:var(--ink)}
.note time{color:var(--ink-3);font-size:12px;margin-left:6px}
.addnote{display:flex;gap:8px}
.addnote input{flex:1;min-width:0;padding:9px 13px;border:1.5px solid var(--line);border-radius:999px;background:#fff;outline:0;font-size:14px}
.addnote input:focus{border-color:var(--coral)}
.track{font-size:13px;color:var(--ink-2);margin-top:10px}
.empty{padding:40px 20px;text-align:center;color:var(--ink-3);background:#fff;border:1px dashed var(--line-2,#d4d4d9);border-radius:20px}
.panel{background:#fff;border:1px solid var(--line);border-radius:20px;padding:18px;margin:16px 0}
.panel h2{margin:0 0 10px;font:800 20px/1.1 'Cabinet Grotesk',system-ui,sans-serif}
.err{color:var(--coral-ink);font-size:13.5px;font-weight:600}
.toast{position:fixed;left:50%;bottom:22px;transform:translateX(-50%);background:var(--ink);color:#fff;padding:10px 18px;border-radius:999px;font-weight:600;font-size:14px;box-shadow:0 10px 30px rgba(0,0,0,.2);z-index:9}
[hidden]{display:none!important}
@media (max-width:640px){.sums{grid-template-columns:repeat(3,1fr);gap:6px}.sum{padding:10px 10px}.sum b{font-size:17px}.sum span{font-size:11px}h1{font-size:26px}.who{margin-left:0;width:100%;justify-content:space-between}.grid2{grid-template-columns:1fr}.row1{flex-wrap:wrap}.price{text-align:left}}
</style></head><body>
<div class="wrap">
  <div class="head">
    <h1>Purchases</h1>
    <button type="button" class="cta" id="newBtn"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M12 5v14M5 12h14"/></svg>Ask to buy</button>
    <div class="who" id="who" role="group" aria-label="Who are you?"><span>I'm</span></div>
  </div>

  <form class="panel" id="newForm" hidden autocomplete="off">
    <h2>Ask to buy something</h2>
    <div class="newf" style="background:none;padding:0;margin:0">
      <label class="f">What do we need to buy?<input name="title" required maxlength="160" placeholder="e.g. 6 boxes of C9 warm white bulbs"></label>
      <label class="f">Link to it<input name="link" inputmode="url" placeholder="Paste the product link"></label>
      <div class="grid2">
        <label class="f">Price (each)<input name="price" inputmode="decimal" placeholder="$0.00"></label>
        <label class="f">How many<input name="qty" inputmode="numeric" value="1"></label>
      </div>
      <label class="f">Why do we need it?<textarea name="why" maxlength="2000" placeholder="What it's for, why now, what happens if we don't"></textarea></label>
      <div class="acts"><button class="btn main" type="submit">Send for approval</button><button class="btn soft" type="button" id="newCancel">Cancel</button><span class="err" id="newErr"></span></div>
    </div>
  </form>

  <div class="sums" id="sums"></div>
  <div class="tabs" id="tabs" role="group" aria-label="Show"></div>
  <div class="list" id="list"><div class="empty">Loading…</div></div>
</div>
<div class="toast" id="toast" hidden></div>
<script>
(() => {
  const API = '/api/purchases';
  let PEOPLE = ['Alex', 'Jacob', 'Dad'], DECIDER = 'Dad', items = [], tab = 'open';
  const open = new Set();
  const $ = (s, r = document) => r.querySelector(s);
  const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
  const money = (n) => n == null ? '' : '$' + Number(n).toLocaleString('en-US', { minimumFractionDigits: n % 1 ? 2 : 0, maximumFractionDigits: 2 });
  const total = (it) => it.price == null ? null : it.price * (it.qty || 1);
  const when = (iso) => iso ? new Date(iso).toLocaleDateString('en-US', { month: 'short', day: 'numeric' }) : '';
  const store = { get(k) { try { return localStorage.getItem(k); } catch (e) { return null; } }, set(k, v) { try { localStorage.setItem(k, v); } catch (e) {} } };
  let me = store.get('barta-purchases-me') || '';

  function toast(t) { const el = $('#toast'); el.textContent = t; el.hidden = false; clearTimeout(toast.t); toast.t = setTimeout(() => { el.hidden = true; }, 2600); }
  function needMe() { if (me) return true; const w = $('#who'); w.classList.remove('need'); void w.offsetWidth; w.classList.add('need'); toast('Pick who you are first.'); return false; }
  function renderWho() {
    const w = $('#who');
    w.querySelectorAll('button').forEach((b) => b.remove());
    for (const p of PEOPLE) {
      const b = document.createElement('button');
      b.type = 'button'; b.textContent = p; b.setAttribute('aria-pressed', String(p === me));
      b.onclick = () => { me = p; store.set('barta-purchases-me', p); w.classList.remove('need'); renderWho(); render(); };
      w.appendChild(b);
    }
  }

  async function call(method, body) {
    const res = await fetch(API, { method, credentials: 'same-origin', headers: body ? { 'Content-Type': 'application/json' } : {}, body: body ? JSON.stringify(body) : undefined });
    const data = await res.json().catch(() => ({}));
    if (res.status === 401) { (window.top || window).location.href = '/office#purchases'; throw new Error('Signed out'); }
    if (!res.ok || !data.ok) throw new Error(data.error || 'Something went wrong.');
    return data;
  }
  async function load() {
    try {
      const d = await call('GET');
      PEOPLE = d.people || PEOPLE; DECIDER = d.decider || DECIDER; items = d.items || [];
      renderWho(); render();
    } catch (e) { if (!items.length) $('#list').innerHTML = '<div class="empty">' + esc(e.message) + '</div>'; }
  }
  async function act(id, body, msg) {
    if (!needMe()) return;
    try {
      const d = await call('POST', { id, by: me, ...body });
      if (d.deleted) items = items.filter((x) => x.id !== d.deleted);
      else items = items.map((x) => x.id === id ? d.item : x);
      render(); if (msg) toast(msg);
    } catch (e) { toast(e.message); }
  }

  const TABS = [
    ['open', 'Needs a decision', (it) => it.status === 'requested'],
    ['approved', 'Approved, to order', (it) => it.status === 'approved'],
    ['ordered', 'Ordered', (it) => it.status === 'ordered'],
    ['delivered', 'Delivered', (it) => it.status === 'delivered'],
    ['denied', 'Denied', (it) => it.status === 'denied'],
    ['all', 'All', () => true],
  ];
  const LABEL = { approved: 'Approved', denied: 'Denied', ordered: 'Ordered', delivered: 'Delivered' };

  function sumOf(f) { return items.filter(f).reduce((s, it) => s + (total(it) || 0), 0); }
  function render() {
    const month = new Date().toISOString().slice(0, 7);
    const sums = [
      [money(sumOf((it) => it.status === 'requested')) || '$0', 'waiting on ' + DECIDER],
      [money(sumOf((it) => it.status === 'approved')) || '$0', 'approved, not ordered yet'],
      [money(sumOf((it) => (it.status === 'ordered' || it.status === 'delivered') && String(it.ordered_at || '').slice(0, 7) === month)) || '$0', 'ordered this month'],
    ];
    $('#sums').innerHTML = sums.map(([b, s]) => '<div class="sum"><b>' + esc(b) + '</b><span>' + esc(s) + '</span></div>').join('');
    $('#tabs').innerHTML = TABS.map(([id, label, f]) => '<button type="button" class="tab" data-tab="' + id + '" aria-pressed="' + (id === tab) + '">' + esc(label) + '<b>' + items.filter(f).length + '</b></button>').join('');
    $('#tabs').querySelectorAll('[data-tab]').forEach((b) => b.onclick = () => { tab = b.dataset.tab; render(); });
    const f = (TABS.find((t) => t[0] === tab) || TABS[0])[2];
    const rows = items.filter(f);
    const list = $('#list');
    if (!rows.length) {
      list.innerHTML = '<div class="empty">' + (items.length ? 'Nothing here.' : 'Nothing on the list yet. Tap <b>Ask to buy</b> to add the first thing.') + '</div>';
      return;
    }
    list.innerHTML = rows.map(card).join('');
    list.querySelectorAll('[data-act]').forEach((b) => b.onclick = () => onAct(b));
    list.querySelectorAll('form[data-order]').forEach((fm) => fm.onsubmit = (e) => { e.preventDefault(); const d = Object.fromEntries(new FormData(fm)); act(fm.dataset.order, { action: 'order', ...d }, 'Marked ordered.'); });
    list.querySelectorAll('form[data-edit]').forEach((fm) => fm.onsubmit = (e) => { e.preventDefault(); const d = Object.fromEntries(new FormData(fm)); open.delete('edit:' + fm.dataset.edit); act(fm.dataset.edit, { action: 'edit', fields: d }, 'Saved.'); });
    list.querySelectorAll('form[data-note]').forEach((fm) => fm.onsubmit = (e) => { e.preventDefault(); const t = fm.text.value.trim(); if (t) act(fm.dataset.note, { action: 'comment', text: t }); });
  }
  function card(it) {
    const t = total(it);
    const st = it.status;
    const label = st === 'requested' ? 'Waiting on ' + DECIDER : LABEL[st];
    const votes = PEOPLE.map((p) => {
      const v = it.votes && it.votes[p];
      const dec = p === DECIDER;
      return '<span class="vote ' + (v || '') + (dec ? ' decider' : '') + '">' + (v === 'yes' ? '✓ ' : v === 'no' ? '✕ ' : '') + esc(p) + (dec ? ' <small>decides</small>' : '') + '</span>';
    }).join('');
    const mine = me && it.votes ? it.votes[me] : null;
    let acts = '';
    if (st === 'requested' || st === 'approved' || st === 'denied') {
      const isDec = me === DECIDER;
      acts += '<button class="btn yes" data-act="vote" data-v="' + (mine === 'yes' ? '' : 'yes') + '" data-id="' + it.id + '">' + (mine === 'yes' ? (isDec ? 'Approved ✓ (undo)' : 'Thumbs up ✓ (undo)') : isDec ? 'Approve' : 'Thumbs up') + '</button>';
      acts += '<button class="btn no" data-act="vote" data-v="' + (mine === 'no' ? '' : 'no') + '" data-id="' + it.id + '">' + (mine === 'no' ? (isDec ? 'Denied ✕ (undo)' : 'Thumbs down ✕ (undo)') : isDec ? 'Deny' : 'Thumbs down') + '</button>';
    }
    if (st === 'approved') acts += '<button class="btn main" data-act="orderform" data-id="' + it.id + '">Mark ordered</button>';
    if (st === 'ordered') {
      if (it.tracking) acts += '<a class="btn link" href="' + esc(it.tracking) + '" target="_blank" rel="noopener">Track package ↗</a>';
      acts += '<button class="btn main" data-act="deliver" data-id="' + it.id + '">Mark delivered</button>';
      acts += '<button class="btn soft" data-act="orderform" data-id="' + it.id + '">Edit order</button>';
    }
    if (st === 'delivered') {
      if (it.tracking) acts += '<a class="btn link" href="' + esc(it.tracking) + '" target="_blank" rel="noopener">Tracking ↗</a>';
      acts += '<button class="btn soft" data-act="undeliver" data-id="' + it.id + '">Not delivered yet</button>';
    }
    if (it.link) acts += '<a class="btn soft" href="' + esc(it.link) + '" target="_blank" rel="noopener">Open link ↗</a>';
    acts += '<button class="more" data-act="editform" data-id="' + it.id + '">Edit</button><button class="more" data-act="delete" data-id="' + it.id + '" style="margin-left:0">Delete</button>';
    const orderOpen = open.has('order:' + it.id);
    const editOpen = open.has('edit:' + it.id);
    const host = it.link ? (() => { try { return new URL(it.link).hostname.replace(/^www\./, ''); } catch (e) { return ''; } })() : '';
    return '<article class="card">' +
      '<div class="row1"><div class="title"><h3>' + (it.link ? '<a href="' + esc(it.link) + '" target="_blank" rel="noopener">' + esc(it.title) + '</a>' : esc(it.title)) + '</h3>' +
      '<div class="meta">' + esc(it.requested_by) + ' asked ' + esc(when(it.created_at)) + (host ? ' · ' + esc(host) : '') + '</div></div>' +
      '<div class="price">' + (t != null ? '<b>' + esc(money(t)) + '</b>' + (it.qty > 1 ? '<span>' + it.qty + ' × ' + esc(money(it.price)) + '</span>' : '') : '<span>No price yet</span>') + '</div></div>' +
      '<div style="margin-top:10px"><span class="pill st-' + st + '">' + esc(label) + '</span></div>' +
      (it.why ? '<p class="why">' + esc(it.why) + '</p>' : '') +
      '<div class="votes">' + votes + '</div>' +
      (st === 'ordered' || st === 'delivered' ? '<div class="track">Ordered by ' + esc(it.ordered_by || '') + ' ' + esc(when(it.ordered_at)) + (it.order_no ? ' · Order #' + esc(it.order_no) : '') + (it.paid != null ? ' · Paid ' + esc(money(it.paid)) : '') + (it.delivered_at ? ' · Delivered ' + esc(when(it.delivered_at)) : '') + '</div>' : '') +
      '<div class="acts">' + acts + '</div>' +
      (orderOpen ? '<form class="order" data-order="' + it.id + '"><div class="grid2"><label class="f">Order number<input name="order_no" value="' + esc(it.order_no || '') + '" maxlength="80"></label><label class="f">What we actually paid<input name="paid" inputmode="decimal" value="' + esc(it.paid != null ? it.paid : (t != null ? t : '')) + '"></label></div><label class="f">Tracking link<input name="tracking" inputmode="url" value="' + esc(it.tracking || '') + '" placeholder="Paste the tracking link"></label><div class="acts"><button class="btn main" type="submit">Save — mark ordered</button><button class="btn soft" type="button" data-act="orderform" data-id="' + it.id + '">Cancel</button></div></form>' : '') +
      (editOpen ? '<form class="editf" data-edit="' + it.id + '"><label class="f">What to buy<input name="title" required maxlength="160" value="' + esc(it.title) + '"></label><label class="f">Link<input name="link" value="' + esc(it.link || '') + '"></label><div class="grid2"><label class="f">Price (each)<input name="price" inputmode="decimal" value="' + esc(it.price != null ? it.price : '') + '"></label><label class="f">How many<input name="qty" inputmode="numeric" value="' + esc(it.qty || 1) + '"></label></div><label class="f">Why<textarea name="why">' + esc(it.why || '') + '</textarea></label><div class="acts"><button class="btn main" type="submit">Save</button><button class="btn soft" type="button" data-act="editform" data-id="' + it.id + '">Cancel</button></div></form>' : '') +
      '<div class="notes">' + (it.comments || []).map((c) => '<div class="note"><b>' + esc(c.by) + '</b> ' + esc(c.text) + '<time>' + esc(when(c.at)) + '</time></div>').join('') +
      '<form class="addnote" data-note="' + it.id + '"><input name="text" maxlength="1000" placeholder="Add a note…"><button class="btn soft" type="submit">Post</button></form></div>' +
      '</article>';
  }
  function onAct(b) {
    const id = b.dataset.id, a = b.dataset.act;
    if (a === 'vote') return act(id, { action: 'vote', vote: b.dataset.v || null });
    if (a === 'orderform') { const k = 'order:' + id; open.has(k) ? open.delete(k) : open.add(k); return render(); }
    if (a === 'editform') { const k = 'edit:' + id; open.has(k) ? open.delete(k) : open.add(k); return render(); }
    if (a === 'deliver') return act(id, { action: 'deliver' }, 'Marked delivered.');
    if (a === 'undeliver') return act(id, { action: 'deliver', undo: true });
    if (a === 'delete') { if (confirm('Delete this from the list for everyone?')) act(id, { action: 'delete' }, 'Deleted.'); }
  }

  $('#newBtn').onclick = () => { if (!needMe()) return; $('#newForm').hidden = false; $('#newForm').title.focus(); };
  $('#newCancel').onclick = () => { $('#newForm').hidden = true; $('#newErr').textContent = ''; };
  $('#newForm').onsubmit = async (e) => {
    e.preventDefault();
    if (!needMe()) return;
    const fm = e.target, d = Object.fromEntries(new FormData(fm));
    $('#newErr').textContent = '';
    try {
      const r = await call('POST', { action: 'create', by: me, ...d });
      items = [r.item, ...items]; fm.reset(); fm.qty.value = 1; fm.hidden = true; tab = 'open'; render();
      toast('Sent for approval.');
    } catch (err) { $('#newErr').textContent = err.message; }
  };
  document.addEventListener('submit', (e) => { const f = e.target; if (f.dataset && f.dataset.order) open.delete('order:' + f.dataset.order); }, true);
  renderWho();
  load();
  setInterval(() => { if (!document.hidden && !document.activeElement.closest('form')) load(); }, 20000);
  document.addEventListener('visibilitychange', () => { if (!document.hidden) load(); });
})();
</script>
</body></html>`;
