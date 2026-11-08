// Barta Office → Dashboard (docs/DASHBOARD.md). The page is rendered on the
// server with the snapshot embedded, then the charts are drawn in the browser
// as plain SVG/HTML (no chart library). Light only, like every office tool.

const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);

const SETUP = {
  "no-key": ["Almost there", "The numbers are in the site, locked. To unlock them, add the <b>OFFICE_DATA_KEY</b> environment variable in Netlify (Site configuration → Environment variables), then redeploy. See docs/DASHBOARD.md."],
  "bad-key": ["Key doesn't match", "OFFICE_DATA_KEY in Netlify doesn't open these numbers. It should be the short key (44 characters) Claude gave you, not the older long one. Paste it again, then redeploy."],
  "no-data": ["No numbers yet", "Ask Claude to refresh the dashboard from Rotor."],
};

const CSS = `
@font-face{font-family:'Cabinet Grotesk';src:url('/assets/fonts/CabinetGrotesk-Extrabold.v1.woff2') format('woff2');font-weight:800}
@font-face{font-family:'General Sans';src:url('/assets/fonts/GeneralSans-Medium.v1.woff2') format('woff2');font-weight:500}
@font-face{font-family:'General Sans';src:url('/assets/fonts/GeneralSans-Semibold.v1.woff2') format('woff2');font-weight:600}
:root{color-scheme:light;--ink:#16161b;--text-2:#4a4a52;--muted:#6b6b73;--line:#ececee;--grid:#efeff1;--mist:#f4f4f6;--card:#fff;--coral:#fb4d3d;--coral-wash:rgba(251,77,61,.10);--blue:#2a78d6;
--good:#0ca30c;--warning:#fab219;--serious:#ec835a;--critical:#d03b3b;--good-text:#006300}
*{box-sizing:border-box}
html{-webkit-text-size-adjust:100%}
body{margin:0;background:var(--mist);color:var(--ink);font:500 15px/1.45 'General Sans',system-ui,-apple-system,'Segoe UI',sans-serif;-webkit-font-smoothing:antialiased}
.wrap{max-width:1180px;margin:0 auto;padding:14px 16px calc(40px + env(safe-area-inset-bottom))}
.top{display:flex;align-items:flex-end;justify-content:space-between;gap:12px;flex-wrap:wrap;margin:6px 2px 14px}
h1{margin:0;font:800 28px/1.05 'Cabinet Grotesk',system-ui,sans-serif;letter-spacing:-.015em}
.asof{color:var(--muted);font-size:13px}
.embed h1,.embed .tabs{display:none}
.embed .top{margin:2px 2px 10px;justify-content:flex-end}
.tabs{display:flex;gap:4px;overflow-x:auto;scrollbar-width:none;margin:0 -16px 16px;padding:0 16px}
.tabs::-webkit-scrollbar{display:none}
.tab{flex:none;height:38px;padding:0 16px;border:1px solid var(--line);border-radius:999px;background:var(--card);color:var(--text-2);font:600 14px/1 'General Sans',system-ui,sans-serif;cursor:pointer}
.tab[aria-selected="true"]{background:var(--ink);border-color:var(--ink);color:#fff}
.view[hidden]{display:none}
.grid{display:grid;gap:12px;grid-template-columns:repeat(12,1fr)}
.card{grid-column:span 12;background:var(--card);border:1px solid var(--line);border-radius:20px;padding:18px 18px 16px;min-width:0}
.c6{grid-column:span 6}.c4{grid-column:span 4}.c3{grid-column:span 3}.c8{grid-column:span 8}
@media (max-width:900px){.c3{grid-column:span 6}.c4,.c6,.c8{grid-column:span 12}}
h2{margin:0 0 2px;font:800 17px/1.2 'Cabinet Grotesk',system-ui,sans-serif;letter-spacing:-.005em}
.sub{margin:0 0 12px;color:var(--muted);font-size:13px}
.hero .label,.tile .label{color:var(--text-2);font-size:13.5px;font-weight:600}
.hero .value{font:600 52px/1.05 'General Sans',system-ui,sans-serif;letter-spacing:-.02em;margin:6px 0 6px}
.tile .value{font:600 30px/1.1 'General Sans',system-ui,sans-serif;letter-spacing:-.01em;margin:6px 0 4px}
.delta{display:inline-flex;align-items:center;gap:5px;font-size:13px;font-weight:600;color:var(--text-2)}
.delta .up{color:var(--good-text)}
.note{color:var(--muted);font-size:12.5px;margin-top:4px}
.target{display:flex;align-items:center;gap:6px;font-size:12.5px;color:var(--text-2);margin-top:6px}
.dot{width:8px;height:8px;border-radius:50%;flex:none}
.meter{position:relative;height:8px;border-radius:999px;background:#ffe1dd;margin:10px 0 2px}
.meter i{position:absolute;left:0;top:0;bottom:0;border-radius:999px;background:var(--coral)}
.meter b{position:absolute;top:-4px;bottom:-4px;width:2px;background:var(--ink);border-radius:1px}
.chart{position:relative;width:100%}
.chart svg{display:block;width:100%;overflow:visible}
.legend{display:flex;gap:14px;flex-wrap:wrap;margin:0 0 8px;font-size:12.5px;color:var(--text-2)}
.legend span{display:inline-flex;align-items:center;gap:6px}
.legend i{width:10px;height:10px;border-radius:3px;display:inline-block}
.bars{display:grid;gap:9px}
.bar{display:grid;grid-template-columns:minmax(90px,38%) 1fr;align-items:center;gap:10px;font-size:13.5px}
.bar .name{color:var(--text-2);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.bar .track{display:flex;align-items:center;gap:8px;min-width:0}
.bar .fill{height:16px;border-radius:0 4px 4px 0;background:var(--coral);min-width:2px;transition:filter .15s}
.bar:hover .fill,.bar:focus .fill{filter:brightness(1.08)}
.bar .val{flex:none;font-variant-numeric:tabular-nums;color:var(--ink);font-weight:600}
.seg{display:flex;gap:2px;height:28px;margin:6px 0 10px}
.seg div{border-radius:4px;color:#fff;font-size:12.5px;font-weight:600;display:flex;align-items:center;padding-left:8px;white-space:nowrap;overflow:hidden;min-width:0}
.todo{list-style:none;margin:0;padding:0;display:grid;gap:8px}
.todo a{display:flex;align-items:center;gap:12px;padding:12px 14px;border:1px solid var(--line);border-radius:14px;color:inherit;text-decoration:none;background:#fcfcfd}
.todo a:hover{border-color:#dcdce0}
.todo .ic{width:28px;height:28px;border-radius:9px;display:grid;place-items:center;flex:none;color:#fff;font:800 15px/1 'Cabinet Grotesk',system-ui,sans-serif}
.todo b{display:block;font-weight:600}
.todo small{color:var(--muted);font-size:12.5px}
.todo .lvl{margin-left:auto;font-size:12px;color:var(--text-2);flex:none}
details.tbl{margin-top:10px;font-size:13px}
details.tbl summary{cursor:pointer;color:var(--muted);font-size:12.5px;width:max-content}
details.tbl table{width:100%;border-collapse:collapse;margin-top:6px;font-variant-numeric:tabular-nums}
details.tbl th,details.tbl td{text-align:right;padding:5px 6px;border-bottom:1px solid var(--grid)}
details.tbl th:first-child,details.tbl td:first-child{text-align:left}
.tip{position:fixed;z-index:50;pointer-events:none;background:var(--ink);color:#fff;border-radius:10px;padding:8px 10px;font-size:12.5px;line-height:1.35;box-shadow:0 8px 24px rgba(0,0,0,.18);opacity:0;transition:opacity .1s;max-width:240px}
.tip.on{opacity:1}
.tip .t{color:#c9c9cf;margin-bottom:3px}
.tip .r{display:flex;align-items:center;gap:7px}
.tip .r i{width:12px;height:2px;border-radius:1px;display:inline-block}
.tip .r b{font-weight:600}
.err{margin:4px 0 12px;padding:12px 14px;border-radius:14px;background:#fff5f3;border:1px solid rgba(208,51,31,.25);color:#7a1d12;font-size:13px;line-height:1.4;word-break:break-word}
.err b{display:block;color:#d0331f}
.err[hidden]{display:none}
.empty{max-width:520px;margin:12vh auto;text-align:center;padding:0 16px}
.empty h1{margin-bottom:10px}
.empty p{color:var(--text-2)}
`;

// Everything below runs in the browser.
const CLIENT = String.raw`
(() => { try {
  const D = JSON.parse(document.getElementById('dash-data').textContent);
  const $ = (s, el = document) => el.querySelector(s);
  const C = { coral: '#fb4d3d', blue: '#2a78d6', grid: '#efeff1', axis: '#6b6b73', ink: '#16161b' };
  const money = (n) => '$' + Math.round(n).toLocaleString('en-US');
  const compactMoney = (n) => n >= 1000 ? '$' + (n / 1000).toFixed(n >= 10000 ? 0 : 1).replace(/\.0$/, '') + 'K' : '$' + Math.round(n);
  const num = (n) => Math.round(n).toLocaleString('en-US');
  // Older iPhones (before iOS 14) have no replaceChildren.
  const clear = (node) => { while (node.firstChild) node.removeChild(node.firstChild); return node; };
  const el = (tag, attrs = {}, text) => { const e = document.createElement(tag); for (const k in attrs) e.setAttribute(k, attrs[k]); if (text != null) e.textContent = text; return e; };
  const NS = 'http://www.w3.org/2000/svg';
  const sv = (tag, attrs = {}) => { const e = document.createElementNS(NS, tag); for (const k in attrs) e.setAttribute(k, attrs[k]); return e; };

  // One tooltip for the page. Values lead, labels follow.
  const tip = el('div', { class: 'tip', role: 'status' });
  document.body.appendChild(tip);
  function showTip(x, y, title, rows) {
    clear(tip).appendChild(el('div', { class: 't' }, title));
    for (const r of rows) {
      const row = el('div', { class: 'r' });
      if (r.color) { const k = el('i'); k.style.background = r.color; row.appendChild(k); }
      row.appendChild(el('b', {}, r.value));
      if (r.name) row.appendChild(el('span', {}, ' ' + r.name));
      tip.appendChild(row);
    }
    tip.classList.add('on');
    const w = tip.offsetWidth, h = tip.offsetHeight;
    tip.style.left = Math.max(8, Math.min(innerWidth - w - 8, x - w / 2)) + 'px';
    tip.style.top = (y - h - 12 < 8 ? y + 16 : y - h - 12) + 'px';
  }
  const hideTip = () => tip.classList.remove('on');
  addEventListener('scroll', hideTip, { passive: true });

  // Top of the axis: 4 gridline steps, each a clean number (1, 2, 2.5, 5 x 10^n).
  function niceMax(v) {
    if (v <= 0) return 4;
    const raw = v / 4, p = Math.pow(10, Math.floor(Math.log10(raw)));
    for (const m of [1, 1.5, 2, 2.5, 3, 4, 5, 6, 8, 10]) if (m * p >= raw && (m * p >= 1 || m * p === Math.round(m * p))) return Math.max(4, m * p * 4);
    return 40 * p;
  }

  function table(host, head, rows) {
    const d = el('details', { class: 'tbl' });
    d.appendChild(el('summary', {}, 'Show table'));
    const t = el('table');
    const tr = el('tr');
    head.forEach((h) => tr.appendChild(el('th', {}, h)));
    t.appendChild(tr);
    rows.forEach((r) => { const row = el('tr'); r.forEach((c) => row.appendChild(el('td', {}, c))); t.appendChild(row); });
    d.appendChild(t);
    host.appendChild(d);
  }

  function legend(host, series) {
    if (series.length < 2) return;
    const l = el('div', { class: 'legend' });
    series.forEach((s) => { const sp = el('span'); const i = el('i'); i.style.background = s.color; sp.append(i, document.createTextNode(s.name)); l.appendChild(sp); });
    host.appendChild(l);
  }

  // Columns: one or two series per group, one baseline, rounded tops.
  function columns(host, { rows, series, fmt, axisFmt, height = 220, labelLast = true }) {
    const box = el('div', { class: 'chart' });
    legend(host, series);
    host.appendChild(box);
    const draw = () => {
      clear(box);
      const W = Math.max(280, box.clientWidth), H = height, L = 46, R = 6, T = 18, B = 26;
      const svg = sv('svg', { viewBox: '0 0 ' + W + ' ' + H, height: H, role: 'img', 'aria-label': host.dataset.title || '' });
      const max = niceMax(Math.max(...rows.flatMap((r) => r.values)));
      const y = (v) => T + (H - T - B) * (1 - v / max);
      for (let i = 0; i <= 4; i++) {
        const v = (max / 4) * i, yy = Math.round(y(v)) + 0.5;
        svg.appendChild(sv('line', { x1: L, x2: W - R, y1: yy, y2: yy, stroke: C.grid }));
        const t = sv('text', { x: L - 8, y: yy + 4, 'text-anchor': 'end', 'font-size': 11, fill: C.axis }); t.textContent = axisFmt(v); svg.appendChild(t);
      }
      const band = (W - L - R) / rows.length, n = series.length;
      const bw = Math.min(24, (band * 0.72 - 2 * (n - 1)) / n);
      const every = Math.ceil(rows.length / Math.floor((W - L) / 34));
      rows.forEach((r, i) => {
        const cx = L + band * i + band / 2, x0 = cx - (bw * n + 2 * (n - 1)) / 2;
        r.values.forEach((v, j) => {
          const h = Math.max(0, y(0) - y(v)); if (!h) return;
          const x = x0 + j * (bw + 2), top = y(v), rr = Math.min(4, h, bw / 2);
          svg.appendChild(sv('path', { d: 'M' + x + ',' + y(0) + 'V' + (top + rr) + 'Q' + x + ',' + top + ' ' + (x + rr) + ',' + top + 'H' + (x + bw - rr) + 'Q' + (x + bw) + ',' + top + ' ' + (x + bw) + ',' + (top + rr) + 'V' + y(0) + 'Z', fill: series[j].color }));
        });
        if (i % every === 0 || i === rows.length - 1) { const t = sv('text', { x: cx, y: H - 8, 'text-anchor': 'middle', 'font-size': 11, fill: C.axis }); t.textContent = r.label; svg.appendChild(t); }
        const hit = sv('rect', { x: L + band * i, y: T, width: band, height: H - T - B, fill: 'transparent', tabindex: 0, 'aria-label': r.label + ': ' + r.values.map((v, j) => series[j].name + ' ' + fmt(v)).join(', ') });
        const on = (e) => { const b = hit.getBoundingClientRect(); showTip(e && e.clientX != null ? e.clientX : b.left + b.width / 2, b.top + 10, r.title || r.label, r.values.map((v, j) => ({ color: series[j].color, value: fmt(v), name: n > 1 ? series[j].name : '' }))); hit.setAttribute('fill', 'rgba(22,22,27,.04)'); };
        const off = () => { hideTip(); hit.setAttribute('fill', 'transparent'); };
        hit.addEventListener('pointermove', on); hit.addEventListener('pointerleave', off); hit.addEventListener('focus', () => on()); hit.addEventListener('blur', off);
        svg.appendChild(hit);
      });
      if (labelLast) {
        const i = rows.length - 1, v = rows[i].values[0], cx = L + band * i + band / 2 - (n > 1 ? (bw + 2) / 2 : 0);
        if (v) { const t = sv('text', { x: Math.min(cx, W - 20), y: y(v) - 6, 'text-anchor': 'middle', 'font-size': 11.5, 'font-weight': 600, fill: C.ink }); t.textContent = axisFmt(v); svg.appendChild(t); }
      }
      box.appendChild(svg);
    };
    draw(); redraws.push(draw);
    table(host, ['', ...series.map((s) => s.name)], rows.map((r) => [r.title || r.label, ...r.values.map(fmt)]));
  }

  // Line with a soft area wash, crosshair and end label.
  function line(host, { rows, fmt, axisFmt, height = 200, name }) {
    const box = el('div', { class: 'chart' });
    host.appendChild(box);
    const draw = () => {
      clear(box);
      const W = Math.max(280, box.clientWidth), H = height, L = 46, R = 46, T = 14, B = 26;
      const svg = sv('svg', { viewBox: '0 0 ' + W + ' ' + H, height: H, role: 'img', 'aria-label': host.dataset.title || '' });
      const max = niceMax(Math.max(...rows.map((r) => r.value)));
      const x = (i) => L + (W - L - R) * (rows.length === 1 ? 0.5 : i / (rows.length - 1));
      const y = (v) => T + (H - T - B) * (1 - v / max);
      for (let i = 0; i <= 4; i++) {
        const v = (max / 4) * i, yy = Math.round(y(v)) + 0.5;
        svg.appendChild(sv('line', { x1: L, x2: W - R, y1: yy, y2: yy, stroke: C.grid }));
        const t = sv('text', { x: L - 8, y: yy + 4, 'text-anchor': 'end', 'font-size': 11, fill: C.axis }); t.textContent = axisFmt(v); svg.appendChild(t);
      }
      const pts = rows.map((r, i) => [x(i), y(r.value)]);
      const d = pts.map((p, i) => (i ? 'L' : 'M') + p[0] + ',' + p[1]).join('');
      svg.appendChild(sv('path', { d: d + 'L' + x(rows.length - 1) + ',' + y(0) + 'L' + x(0) + ',' + y(0) + 'Z', fill: C.coral, 'fill-opacity': 0.1 }));
      svg.appendChild(sv('path', { d, fill: 'none', stroke: C.coral, 'stroke-width': 2, 'stroke-linejoin': 'round', 'stroke-linecap': 'round' }));
      const every = Math.ceil(rows.length / Math.floor((W - L - R) / 56));
      rows.forEach((r, i) => { if (i % every === 0 || i === rows.length - 1) { const t = sv('text', { x: x(i), y: H - 8, 'text-anchor': 'middle', 'font-size': 11, fill: C.axis }); t.textContent = r.label; svg.appendChild(t); } });
      const last = pts[pts.length - 1];
      svg.appendChild(sv('circle', { cx: last[0], cy: last[1], r: 4, fill: C.coral, stroke: '#fff', 'stroke-width': 2 }));
      const end = sv('text', { x: last[0] + 8, y: last[1] + 4, 'font-size': 11.5, 'font-weight': 600, fill: C.ink }); end.textContent = axisFmt(rows[rows.length - 1].value); svg.appendChild(end);
      const cross = sv('line', { y1: T, y2: H - B, stroke: C.ink, 'stroke-opacity': 0.25, visibility: 'hidden' });
      const ring = sv('circle', { r: 5, fill: C.coral, stroke: '#fff', 'stroke-width': 2, visibility: 'hidden' });
      svg.append(cross, ring);
      const hit = sv('rect', { x: L, y: 0, width: W - L - R, height: H, fill: 'transparent', tabindex: 0, 'aria-label': (name || '') + ', use left and right arrows' });
      let cur = rows.length - 1;
      const show = (i, cx) => {
        cur = Math.max(0, Math.min(rows.length - 1, i));
        const [px, py] = pts[cur];
        cross.setAttribute('x1', px); cross.setAttribute('x2', px); cross.setAttribute('visibility', 'visible');
        ring.setAttribute('cx', px); ring.setAttribute('cy', py); ring.setAttribute('visibility', 'visible');
        const b = svg.getBoundingClientRect(), s = b.width / W;
        showTip(cx != null ? cx : b.left + px * s, b.top + py * s, rows[cur].title || rows[cur].label, [{ color: C.coral, value: fmt(rows[cur].value), name: name || '' }]);
      };
      const off = () => { hideTip(); cross.setAttribute('visibility', 'hidden'); ring.setAttribute('visibility', 'hidden'); };
      hit.addEventListener('pointermove', (e) => { const b = svg.getBoundingClientRect(), px = (e.clientX - b.left) * (W / b.width); show(Math.round(((px - L) / (W - L - R)) * (rows.length - 1)), e.clientX); });
      hit.addEventListener('pointerleave', off); hit.addEventListener('blur', off);
      hit.addEventListener('focus', () => show(cur));
      hit.addEventListener('keydown', (e) => { if (e.key === 'ArrowLeft') { show(cur - 1); e.preventDefault(); } if (e.key === 'ArrowRight') { show(cur + 1); e.preventDefault(); } });
      svg.appendChild(hit);
      box.appendChild(svg);
    };
    draw(); redraws.push(draw);
    table(host, ['', name || 'Value'], rows.map((r) => [r.title || r.label, fmt(r.value)]));
  }

  // Horizontal bars, value at the tip.
  function bars(host, rows, fmt, color = C.coral) {
    const max = Math.max(...rows.map((r) => r.value), 1);
    const wrap = el('div', { class: 'bars' });
    rows.forEach((r) => {
      const b = el('div', { class: 'bar', tabindex: 0, 'aria-label': r.label + ': ' + fmt(r.value) });
      const tr = el('div', { class: 'track' });
      const f = el('div', { class: 'fill' }); f.style.width = 'calc((100% - 60px) * ' + (r.value / max).toFixed(4) + ')'; f.style.background = color;
      tr.append(f, el('span', { class: 'val' }, fmt(r.value)));
      b.append(el('span', { class: 'name' }, r.label), tr);
      if (r.hint) { const on = (e) => { const bb = f.getBoundingClientRect(); showTip(e && e.clientX != null ? e.clientX : bb.right, bb.top, r.label, [{ color, value: fmt(r.value) }, { value: r.hint }]); }; b.addEventListener('pointermove', on); b.addEventListener('focus', () => on()); b.addEventListener('pointerleave', hideTip); b.addEventListener('blur', hideTip); }
      wrap.appendChild(b);
    });
    host.appendChild(wrap);
  }

  function tileSpark(host, values) {
    const W = 120, H = 30, max = Math.max(...values, 1);
    const svg = sv('svg', { viewBox: '0 0 ' + W + ' ' + H, width: W, height: H, 'aria-hidden': 'true' });
    const x = (i) => 2 + (W - 8) * (i / (values.length - 1)), y = (v) => H - 3 - (H - 8) * (v / max);
    svg.appendChild(sv('path', { d: values.map((v, i) => (i ? 'L' : 'M') + x(i) + ',' + y(v)).join(''), fill: 'none', stroke: '#b9b9c0', 'stroke-width': 1.5, 'stroke-linejoin': 'round' }));
    svg.appendChild(sv('circle', { cx: x(values.length - 1), cy: y(values[values.length - 1]), r: 3, fill: C.coral }));
    host.appendChild(svg);
  }

  const redraws = [];
  let rt; addEventListener('resize', () => { clearTimeout(rt); rt = setTimeout(() => redraws.forEach((f) => f()), 120); });

  // ---- fill the views ----
  const R = D.revenue, S = D.sales, P = D.plans, O = D.ops;
  const months = R.monthly.map((m, i) => ({ label: m.label, title: m.label + ' ' + m.key.slice(0, 4) + (i === R.monthly.length - 1 ? ' (so far)' : ''), values: [m.cur, m.prev] }));
  const yearSeries = [{ name: 'Past 12 months', color: C.coral }, { name: 'Same month, year before', color: C.blue }];
  const weeks = R.weekly.map((w) => ({ label: w.label, title: 'Week of ' + w.label, value: w.value }));
  const charts = {
    'rev-weekly': (h) => line(h, { rows: weeks, fmt: money, axisFmt: compactMoney, name: 'collected' }),
    'rev-weekly-2': (h) => line(h, { rows: weeks, fmt: money, axisFmt: compactMoney, name: 'collected' }),
    'rev-monthly': (h) => columns(h, { rows: months, series: yearSeries, fmt: money, axisFmt: compactMoney, height: 240 }),
    'leads-weekly': (h) => columns(h, { rows: S.leads_weekly.map((w) => ({ label: w.label, title: 'Week of ' + w.label, values: [w.value] })), series: [{ name: 'Leads', color: C.coral }], fmt: num, axisFmt: num }),
    'leads-weekly-spark': (h) => tileSpark(h, S.leads_weekly.map((w) => w.value)),
    'lead-sources': (h) => bars(h, S.lead_sources, num),
    'customer-sources': (h) => bars(h, S.customer_sources, num),
    'plan-mix': (h) => bars(h, P.mix.map((m) => ({ ...m, hint: money(m.worth) + ' on the books' })), num),
    'plan-reps': (h) => bars(h, P.by_rep, num),
    'plans-created': (h) => columns(h, { rows: P.created_monthly.map((m) => ({ label: m.label, values: [m.value] })), series: [{ name: 'Agreements', color: C.coral }], fmt: num, axisFmt: num, height: 180 }),
    'jobs-status': (h) => bars(h, O.jobs, num),
    'visits-next': (h) => columns(h, { rows: O.visits_next.map((w) => ({ label: w.label.replace('Week of ', ''), title: w.label, values: [w.value] })), series: [{ name: 'Visits', color: C.coral }], fmt: num, axisFmt: num, height: 180 }),
    'visits-monthly': (h) => columns(h, { rows: O.visits_monthly.map((m) => ({ label: m.label, values: [m.value] })), series: [{ name: 'Visits', color: C.coral }], fmt: num, axisFmt: num }),
  };
  const drawn = new Set();
  function drawIn(view) {
    view.querySelectorAll('[data-chart]').forEach((h) => { if (!drawn.has(h)) { drawn.add(h); charts[h.dataset.chart](h); } });
  }

  // Quote outcomes: one whole, split into parts.
  (function () {
    const host = $('#quote-seg'); if (!host) return;
    const q = S.quotes, parts = [['Won', q.won, '#0ca30c'], ['Waiting', q.sent, '#2a78d6'], ['Asked for changes', q.changes, '#eda100'], ['Lost', q.rejected, '#d03b3b']].filter((p) => p[1]);
    const total = parts.reduce((s, p) => s + p[1], 0);
    const seg = el('div', { class: 'seg', role: 'img', 'aria-label': parts.map((p) => p[0] + ' ' + p[1]).join(', ') });
    parts.forEach(([n, v, c]) => { const d = el('div', {}, (v / total) > 0.12 ? Math.round((v / total) * 100) + '%' : ''); d.style.flex = String(v); d.style.background = c; d.addEventListener('pointermove', (e) => showTip(e.clientX, d.getBoundingClientRect().top, n, [{ color: c, value: num(v) + ' quotes' }, { value: Math.round((v / total) * 100) + '% of quotes sent' }])); d.addEventListener('pointerleave', hideTip); seg.appendChild(d); });
    host.appendChild(seg);
    legend(host, parts.map(([n, , c]) => ({ name: n, color: c })));
    table(host, ['Quotes', 'Count'], parts.map(([n, v]) => [n, num(v)]));
  })();

  // Tabs.
  const tabs = [...document.querySelectorAll('.tab')];
  const store = { get(k) { try { return localStorage.getItem(k); } catch (e) { return null; } }, set(k, v) { try { localStorage.setItem(k, v); } catch (e) { /* none */ } } };
  function show(id) {
    const t = tabs.find((x) => x.dataset.view === id) || tabs[0];
    tabs.forEach((x) => x.setAttribute('aria-selected', String(x === t)));
    document.querySelectorAll('.view').forEach((v) => { v.hidden = v.id !== 'v-' + t.dataset.view; });
    drawIn($('#v-' + t.dataset.view));
    if (!embedded) store.set('barta-dash-view', t.dataset.view);
  }
  // Inside Barta Office the office's own tab row picks the view (#money etc.).
  const embedded = document.documentElement.classList.contains('embed');
  tabs.forEach((t) => t.addEventListener('click', () => show(t.dataset.view)));
  addEventListener('hashchange', () => show(location.hash.slice(1)));
  show(location.hash.slice(1) || (embedded ? 'overview' : store.get('barta-dash-view')) || 'overview');
} catch (err) {
  const b = document.getElementById('dash-err');
  if (b) { b.hidden = false; b.lastChild.textContent = (err && err.message || String(err)) + ' · ' + navigator.userAgent; }
} })();
`;

const money = (n) => "$" + Math.round(n).toLocaleString("en-US");
const num = (n) => Math.round(n).toLocaleString("en-US");
const pct = (a, b) => (b ? Math.round(((a - b) / b) * 100) : 0);
const UP = '<svg width="11" height="11" viewBox="0 0 12 12" aria-hidden="true"><path d="M6 2l4 5H2z" fill="currentColor"/></svg>';
const ICON = { critical: "!", serious: "!", warning: "•", good: "✓" };
const LEVEL = { critical: "Urgent", serious: "Money waiting", warning: "To do", good: "Good" };

function tile(label, value, extra = "", cls = "c3") {
  return `<div class="card tile ${cls}"><div class="label">${esc(label)}</div><div class="value">${value}</div>${extra}</div>`;
}
function targetLine(ok, text) {
  return `<div class="target"><span class="dot" style="background:var(--${ok ? "good" : "warning"})"></span>${ok ? "On target" : "Below target"} · ${esc(text)}</div>`;
}
function chartCard(title, sub, chart, cls = "", extra = "") {
  return `<section class="card ${cls}"><h2>${esc(title)}</h2>${sub ? `<p class="sub">${esc(sub)}</p>` : ""}${extra}<div data-chart="${chart}" data-title="${esc(title)}"></div></section>`;
}

export function dashboardHtml(d) {
  const R = d.revenue, S = d.sales, P = d.plans, O = d.ops, T = d.targets;
  const ytdUp = pct(R.collected_ytd, R.collected_ytd_prev);
  const asOf = new Date(d.as_of + "T12:00:00Z").toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric", timeZone: "UTC" });
  const lastLeads = S.leads_weekly[S.leads_weekly.length - 1]?.value || 0;
  const closeOk = S.close_rate >= T.close_rate[0];
  const meter = (v, target, max = 100) => `<div class="meter" aria-hidden="true"><i style="width:${Math.min(100, (v / max) * 100)}%"></i><b style="left:${(target / max) * 100}%"></b></div>`;

  const todo = d.todo.length ? `<ul class="todo">${d.todo.map((t) => `<li><a href="${esc(t.href)}" target="_blank" rel="noopener"><span class="ic" style="background:var(--${t.level})" aria-hidden="true">${ICON[t.level]}</span><span><b>${esc(t.title)}</b><small>${esc(t.detail)}</small></span><span class="lvl">${LEVEL[t.level]}</span></a></li>`).join("")}</ul>` : `<p class="sub">Nothing waiting. Nice.</p>`;

  const overview = `<div class="grid">
  <section class="card hero c8"><div class="label">Collected this year</div><div class="value">${money(R.collected_ytd)}</div>
    <div class="delta"><span class="up">${UP} ${ytdUp}%</span> vs ${money(R.collected_ytd_prev)} by this date in ${d.year - 1}</div>
    <p class="sub" style="margin:16px 0 4px">Collected per week, last 12 weeks</p>
    <div data-chart="rev-weekly" data-title="Collected per week"></div></section>
  <section class="card c4"><h2>Needs attention</h2><p class="sub">Open Rotor to take care of these</p>${todo}</section>
  ${tile("Close rate", `${S.close_rate}%`, meter(S.close_rate, T.close_rate[0]) + targetLine(closeOk, `goal ${T.close_rate[0]}–${T.close_rate[1]}%`))}
  ${tile("Average ticket", money(R.avg_ticket), targetLine(R.avg_ticket >= T.avg_ticket, `goal ${money(T.avg_ticket)}+`))}
  ${tile("Recurring plans", num(P.recurring), `<div class="note">${money(P.recurring_value)} on the books</div>`)}
  ${tile("Leads this week", num(lastLeads), `<div data-chart="leads-weekly-spark"></div>`)}
  ${tile("Visits this week", num(O.visits_this_week), `<div class="note">${num(O.jobs_unscheduled)} sold jobs not scheduled</div>`)}
  ${tile(`${R.this_month_label} so far`, money(R.this_month), `<div class="note">collected this month</div>`)}
  ${tile("Customers owe", money(O.owed.amount), `<div class="note">${num(O.owed.count)} invoices sent, not paid</div>`)}
  ${tile("Quotes waiting", num(S.quotes.sent), `<div class="note">sent, no answer yet</div>`)}
</div>`;

  const revenue = `<div class="grid">
  ${tile("Collected this year", money(R.collected_ytd), `<div class="delta"><span class="up">${UP} ${ytdUp}%</span> vs last year</div>`, "c3")}
  ${tile(`${R.this_month_label} so far`, money(R.this_month), "", "c3")}
  ${tile("Average ticket", money(R.avg_ticket), targetLine(R.avg_ticket >= T.avg_ticket, `goal ${money(T.avg_ticket)}+`), "c3")}
  ${tile("Payments this year", num(R.payments_ytd), R.refunds_ytd ? `<div class="note">${money(R.refunds_ytd)} refunded</div>` : "", "c3")}
  ${chartCard("Collected by month", "Each month compared with the same month a year earlier", "rev-monthly")}
  ${chartCard("Collected per week", "Last 12 weeks", "rev-weekly-2")}
</div>`;

  const sales = `<div class="grid">
  ${tile("Leads since Aug", num(S.leads_total), `<div class="note">when Rotor went live</div>`, "c4")}
  ${tile("Close rate", `${S.close_rate}%`, meter(S.close_rate, T.close_rate[0]) + targetLine(closeOk, `goal ${T.close_rate[0]}–${T.close_rate[1]}%`), "c4")}
  ${tile("Quotes won", num(S.quotes.won), `<div class="note">${num(S.quotes.draft)} drafts never sent</div>`, "c4")}
  ${chartCard("New leads per week", "", "leads-weekly")}
  <section class="card c6"><h2>How quotes turned out</h2><p class="sub">Every quote that went out</p><div id="quote-seg"></div></section>
  ${chartCard("Where leads come from", "Since Aug", "lead-sources", "c6")}
  ${chartCard("Where new customers come from", "Past 12 months, not counting imported customers", "customer-sources", "c6")}
</div>`;

  const plans = `<div class="grid">
  ${tile("Recurring plans", num(P.recurring), "", "c3")}
  ${tile("On the books", money(P.recurring_value), `<div class="note">recurring plan value</div>`, "c3")}
  ${tile("Agreements that recur", `${P.recurring_share}%`, meter(P.recurring_share, T.recurring_share) + targetLine(P.recurring_share >= T.recurring_share, `goal ${T.recurring_share}%+`), "c3")}
  ${tile("Cancelled", num(P.cancelled_12m), `<div class="note">plans, past 12 months</div>`, "c3")}
  ${chartCard("Plan mix", "Active recurring plans", "plan-mix", "c6")}
  ${chartCard("Agreements by who sold them", `All ${num(P.active_agreements)} active agreements`, "plan-reps", "c6")}
  ${chartCard("New agreements per month", "", "plans-created")}
</div>`;

  const jobs = `<div class="grid">
  ${tile("Visits this week", num(O.visits_this_week), "", "c4")}
  ${tile("Not scheduled yet", num(O.jobs_unscheduled), `<div class="note">sold jobs without a date</div>`, "c4")}
  ${tile("Drafts not invoiced", money(O.draft_invoices.amount), `<div class="note">${num(O.draft_invoices.count)} draft invoices</div>`, "c4")}
  ${chartCard("Visits coming up", "Next 4 weeks", "visits-next", "c6")}
  ${chartCard("Jobs by status", "Past 12 months", "jobs-status", "c6")}
  ${chartCard("Visits by month", "Past 12 months, your busy seasons", "visits-monthly")}
</div>`;

  const VIEWS = [["overview", "Overview", overview], ["money", "Money", revenue], ["sales", "Sales", sales], ["plans", "Plans", plans], ["jobs", "Jobs", jobs]];
  return `<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">
<meta name="robots" content="noindex, nofollow">
<title>Dashboard · Barta Office</title>
<script>if(/[?&]embed=1/.test(location.search))document.documentElement.className='embed';
window.addEventListener('error',function(e){try{var b=document.getElementById('dash-err');if(!b)return;b.hidden=false;b.lastChild.textContent=(e.message||'Script error')+(e.lineno?' (line '+e.lineno+')':'')+' · '+navigator.userAgent}catch(x){}});</script>
<style>${CSS}</style></head><body>
<div class="wrap">
  <div class="err" id="dash-err" role="alert" hidden><b>The charts didn't load.</b> Send Claude a screenshot of this: <span></span></div>
  <div class="top"><h1>Dashboard</h1><div class="asof">From Rotor · updated ${esc(asOf)}</div></div>
  <div class="tabs" role="tablist" aria-label="Dashboards">${VIEWS.map(([id, label]) => `<button type="button" class="tab" role="tab" data-view="${id}" aria-selected="false">${label}</button>`).join("")}</div>
  ${VIEWS.map(([id, , html], i) => `<div class="view" id="v-${id}" role="tabpanel"${i ? " hidden" : ""}>${html}</div>`).join("\n")}
</div>
<script type="application/json" id="dash-data">${JSON.stringify(d).replace(/</g, "\\u003c")}</script>
<script>${CLIENT}</script>
</body></html>`;
}

export function setupHtml(reason) {
  const [title, text] = SETUP[reason] || SETUP["no-data"];
  return `<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="robots" content="noindex, nofollow"><title>Dashboard · Barta Office</title>
<style>${CSS}</style></head><body><div class="empty"><h1>${esc(title)}</h1><p>${text}</p></div></body></html>`;
}
