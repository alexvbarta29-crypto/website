// Home's one chart (the Money card: collected, scheduled or ARR over a
// period), drawn in the CRM itself. One series in coral (#fb4d3d, the house
// color) as a 2 px smooth line with a faint wash under it, a light dashed
// grid (the owner's pick), three or four clean ticks, a few x labels that
// never collide, labels in ink (never in the series color), and a readout
// above the plot with a marker that follows a tap, a drag, the pointer or
// the arrow keys (the latest point to start with). A null value (a day
// still ahead) breaks the line and is never read out. Every value is also
// in a table for screen readers (srTable).
//
//   const c = lineChart(el, { rows, value: (r) => r.value, fmt, axis, read, readout, start? })
//   c.destroy()
//
// rows [{ key, label, value|null }]; fmt(v) → "$4,320" (the readout),
// axis(v) → "$4K" (the ticks); read(row) → the readout's second line. Drawn
// at the element's own size (its CSS height, else spec.height) and again
// whenever that changes (a ResizeObserver), so text never scales.

import { html, render } from "../../core/ui.js";

// 0 and up to three clean steps (1, 2, 2.5 or 5 × 10^k) whose top is the
// least headroom over the data: 22,700 → 0, 10K, 20K, 30K; 16 → 0, 10, 20.
export function ticks(max, { whole = false } = {}) {
  if (!(max > 0)) return [0, 1, 2];
  let best = null;
  for (const least of [2, 1]) {
    for (let k = Math.floor(Math.log10(max)) - 2; k <= Math.floor(Math.log10(max)) + 1; k++) {
      for (const m of [1, 2, 2.5, 5]) {
        const step = m * 10 ** k;
        if (whole && !Number.isInteger(step)) continue;
        const n = Math.ceil(max / step - 1e-9);
        if (n < least || n > 3) continue;
        if (!best || n * step < best.top || (n * step === best.top && n > best.n)) best = { step, n, top: n * step };
      }
    }
    if (best) break;
  }
  return Array.from({ length: best.n + 1 }, (_, i) => Math.round(best.step * i * 1000) / 1000);
}

const fix = (n) => Math.round(n * 10) / 10;

// A smooth path through points (monotone cubic: it never overshoots, so a
// day of $0 never dips below the baseline).
export function smoothPath(pts) {
  if (!pts.length) return "";
  if (pts.length === 1) return `M${fix(pts[0][0])},${fix(pts[0][1])}`;
  const n = pts.length;
  const dx = [], m = [], t = [];
  for (let i = 0; i < n - 1; i++) { dx[i] = pts[i + 1][0] - pts[i][0]; m[i] = (pts[i + 1][1] - pts[i][1]) / (dx[i] || 1); }
  t[0] = m[0]; t[n - 1] = m[n - 2];
  for (let i = 1; i < n - 1; i++) t[i] = m[i - 1] * m[i] <= 0 ? 0 : (3 * (dx[i - 1] + dx[i])) / ((2 * dx[i] + dx[i - 1]) / m[i - 1] + (dx[i] + 2 * dx[i - 1]) / m[i]);
  let d = `M${fix(pts[0][0])},${fix(pts[0][1])}`;
  for (let i = 0; i < n - 1; i++) {
    const h = dx[i] / 3;
    d += `C${fix(pts[i][0] + h)},${fix(pts[i][1] + h * t[i])} ${fix(pts[i + 1][0] - h)},${fix(pts[i + 1][1] - h * t[i + 1])} ${fix(pts[i + 1][0])},${fix(pts[i + 1][1])}`;
  }
  return d;
}

export function lineChart(el, spec) {
  const rows = spec.rows || [];
  const value = spec.value || ((r) => r.value);
  const has = (i) => i >= 0 && i < rows.length && value(rows[i]) !== null && value(rows[i]) !== undefined;
  const filled = rows.map((_, i) => i).filter(has);
  // today's point when the period has one (scheduled runs past today), else the latest
  const start = spec.start ? rows.findIndex((r) => r.key === spec.start) : -1;
  let sel = has(start) ? start : filled.length ? filled[filled.length - 1] : -1;
  let width = 0, height = 0, geo = null;
  const readEl = spec.readout || null;

  function draw() {
    const W = Math.max(160, Math.floor(el.clientWidth));
    width = el.clientWidth;
    height = el.clientHeight;
    const H = Math.max(100, Math.floor(el.clientHeight) || spec.height || 160);
    const top = 8, band = 22;
    const vals = filled.map((i) => value(rows[i]));
    const max = Math.max(0, ...vals);
    const tk = ticks(max, { whole: !!spec.whole });
    const top1 = tk[tk.length - 1];
    const gutter = Math.max(...tk.map((v) => spec.axis(v).length)) * 6.4 + 10;
    const x0 = gutter, x1 = W - 4, y1 = H - band;
    const n = rows.length;
    const x = (i) => (n <= 1 ? (x0 + x1) / 2 : x0 + ((x1 - x0) * i) / (n - 1));
    const y = (v) => y1 - (Math.max(0, v || 0) / top1) * (y1 - top);
    // runs of points with values (a null breaks the line)
    const runs = [];
    let cur = [];
    rows.forEach((r, i) => { if (has(i)) cur.push([x(i), y(value(r))]); else if (cur.length) { runs.push(cur); cur = []; } });
    if (cur.length) runs.push(cur);
    const lines = runs.map((p) => smoothPath(p));
    const areas = runs.filter((p) => p.length > 1).map((p) => `${smoothPath(p)}L${fix(p[p.length - 1][0])},${y1}L${fix(p[0][0])},${y1}Z`);
    // x labels: as many as fit (about 52 px each), evenly spaced, the last one kept
    const fit = Math.max(2, Math.floor((x1 - x0) / 56));
    const every = Math.max(1, Math.ceil(n / fit));
    const labels = rows.map((r, i) => i).filter((i) => i % every === 0);
    render(el, html`<svg class="hc-svg" width="${W}" height="${H}" viewBox="${`0 0 ${W} ${H}`}" aria-hidden="true">
      ${tk.map((v) => html`<line class="${v === 0 ? "hc-base" : "hc-grid"}" x1="${x0}" x2="${x1}" y1="${fix(y(v)) + 0.5}" y2="${fix(y(v)) + 0.5}"/>
        <text class="hc-t" x="0" y="${fix(y(v) + 3.5)}">${spec.axis(v)}</text>`)}
      ${areas.map((d) => html`<path class="hc-area" d="${d}"/>`)}
      ${lines.map((d) => html`<path class="hc-line" d="${d}"/>`)}
      <line class="hc-cross" x1="0" x2="0" y1="${top}" y2="${y1}" visibility="hidden"/>
      <circle class="hc-dot" r="4.5" cx="0" cy="0" visibility="hidden"/>
      ${labels.map((i) => html`<text class="hc-t" x="${fix(Math.min(Math.max(x(i), x0 + 18), W - 22))}" y="${H - 6}" text-anchor="middle">${rows[i].label}</text>`)}
    </svg>`);
    geo = { x, y, x0, x1, n };
  }

  function show(i) {
    if (!filled.length || !geo) return;
    sel = has(i) ? i : filled.reduce((b, j) => (b < 0 || Math.abs(j - i) < Math.abs(b - i) ? j : b), -1);
    const r = rows[sel];
    const cx = fix(geo.x(sel)), cy = fix(geo.y(value(r)));
    const cross = el.querySelector(".hc-cross"), dot = el.querySelector(".hc-dot");
    if (cross) { cross.setAttribute("x1", cx); cross.setAttribute("x2", cx); cross.setAttribute("visibility", "visible"); }
    if (dot) { dot.setAttribute("cx", cx); dot.setAttribute("cy", cy); dot.setAttribute("visibility", "visible"); }
    if (readEl) {
      const b = readEl.querySelector("b");
      const s = readEl.querySelector("span");
      if (b) b.textContent = spec.fmt(value(r) || 0);
      if (s) s.textContent = spec.read ? spec.read(r) : r.label;
    }
  }
  const step = (d) => { const k = filled.indexOf(sel) + d; if (k >= 0 && k < filled.length) show(filled[k]); };
  const at = (e) => {
    if (!geo) return sel;
    const box = el.getBoundingClientRect();
    const px = e.clientX - box.left;
    return geo.n <= 1 ? 0 : Math.round(((px - geo.x0) / (geo.x1 - geo.x0)) * (geo.n - 1));
  };
  const onPointer = (e) => show(at(e));
  const onKey = (e) => {
    if (e.key === "ArrowLeft") { e.preventDefault(); step(-1); }
    else if (e.key === "ArrowRight") { e.preventDefault(); step(1); }
    else if (e.key === "Home") { e.preventDefault(); show(filled[0]); }
    else if (e.key === "End") { e.preventDefault(); show(filled[filled.length - 1]); }
  };
  el.addEventListener("pointerdown", onPointer);
  el.addEventListener("pointermove", onPointer);
  el.addEventListener("keydown", onKey);
  draw();
  show(sel);
  const redraw = () => { if (Math.abs(el.clientWidth - width) > 1 || Math.abs(el.clientHeight - height) > 1) { draw(); show(sel); } };
  const ro = typeof ResizeObserver === "function" ? new ResizeObserver(() => redraw()) : null;
  if (ro) ro.observe(el);
  return {
    redraw,
    destroy() { if (ro) ro.disconnect(); el.removeEventListener("pointerdown", onPointer); el.removeEventListener("pointermove", onPointer); el.removeEventListener("keydown", onKey); },
  };
}

// A hidden table of every value (screen readers; the chart itself is aria-hidden).
export function srTable(caption, head, rows) {
  return html`<table class="sr"><caption>${caption}</caption><thead><tr>${head.map((h) => html`<th scope="col">${h}</th>`)}</tr></thead><tbody>${rows.map((r) => html`<tr>${r.map((c, i) => (i ? html`<td>${c}</td>` : html`<th scope="row">${c}</th>`))}</tr>`)}</tbody></table>`;
}
