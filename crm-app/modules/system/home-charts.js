// Home's chart, drawn in the CRM itself: the Money card's (Rotor's, the
// owner's Nov 13 ask): Collected in coral and Scheduled in grey per day of
// a week or a month, smooth lines (monotone: a day of $0 never dips under
// the baseline), a dashed grid, $ ticks at the left, a few dates under it
// that never collide, a readout on tap. Labels in ink, never in a series
// color. Every value is also in a table for screen readers (srTable).
// Drawn at the element's own size (its CSS height, else spec.height) and
// again whenever that changes (a ResizeObserver), so text never scales.

import { html, render } from "../../core/ui.js";

// 0 and up to three (or `most`) clean steps (1, 2, 2.5 or 5 × 10^k) whose top is the
// least headroom over the data: 22,700 → 0, 10K, 20K, 30K; 16 → 0, 10, 20.
export function ticks(max, { whole = false, most = 3 } = {}) {
  if (!(max > 0)) return [0, 1, 2];
  let best = null;
  for (const least of [2, 1]) {
    for (let k = Math.floor(Math.log10(max)) - 2; k <= Math.floor(Math.log10(max)) + 1; k++) {
      for (const m of [1, 2, 2.5, 5]) {
        const step = m * 10 ** k;
        if (whole && !Number.isInteger(step)) continue;
        const n = Math.ceil(max / step - 1e-9);
        if (n < least || n > most) continue;
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

// Rotor's Money chart: the period's days across, Collected (coral) and
// Scheduled (grey) as smooth lines on one $ scale, a dashed grid both ways,
// the $ ticks at the left, a date every few days (Nov 1, Nov 7, Nov 13, ...),
// a dot on each line and a readout for the day under a tap, a drag, the
// pointer or the arrow keys (today's, or the latest, to start with).
//
//   const c = pairChart(el, { keys, label(i), series: [{ cls, dot, values, join? }], axis, onRead(i), start?, height? })
//   c.destroy()
//
// keys: the period's days (YYYY-MM-DD); values: one per key, null where a
// series has no point. A null breaks a line, unless the series is `join`
// (Rotor's weekly points: drawn through the days that have one).
// onRead(i) fills the readout for day i (the caller's words).
export function pairChart(el, spec) {
  const keys = spec.keys || [];
  const n = keys.length;
  const series = (spec.series || []).map((x) => ({ ...x, values: x.values || [] }));
  const val = (s, i) => (s.values[i] === null || s.values[i] === undefined ? null : Number(s.values[i]));
  const any = (i) => i >= 0 && i < n && series.some((s) => val(s, i) !== null);
  const filled = keys.map((_, i) => i).filter(any);
  const start = spec.start ? keys.indexOf(spec.start) : -1;
  // today's day, else the latest point on or before it (a weekly point's week), else the latest
  const before = spec.start ? filled.filter((i) => keys[i] <= spec.start) : [];
  let sel = any(start) ? start : before.length ? before[before.length - 1] : filled.length ? filled[filled.length - 1] : -1;
  let width = 0, height = 0, geo = null;

  function draw() {
    const W = Math.max(160, Math.floor(el.clientWidth));
    width = el.clientWidth;
    height = el.clientHeight;
    const H = Math.max(110, Math.floor(el.clientHeight) || spec.height || 180);
    const top = 8, band = 26;
    const max = Math.max(0, ...series.flatMap((s) => s.values.map((_, i) => val(s, i) || 0)));
    const tk = ticks(max, { most: 4 });
    const top1 = tk[tk.length - 1];
    const gutter = Math.max(...tk.map((v) => spec.axis(v).length)) * 6.6 + 12;
    const x0 = gutter, x1 = W - 6, y1 = H - band;
    const x = (i) => (n <= 1 ? (x0 + x1) / 2 : x0 + ((x1 - x0) * i) / (n - 1));
    const y = (v) => y1 - (Math.max(0, v || 0) / top1) * (y1 - top);
    const paths = series.map((s) => {
      const runs = [];
      let cur = [];
      for (let i = 0; i < n; i++) {
        const v = val(s, i);
        if (v !== null) cur.push([x(i), y(v)]);
        else if (!s.join && cur.length) { runs.push(cur); cur = []; }
      }
      if (cur.length) runs.push(cur);
      return { cls: s.cls, d: runs.map((p) => smoothPath(p)).join("") };
    });
    // a date every 6 days on a month (Rotor's Nov 1, 7, 13, 19, 25), every day or every other on a week
    let every = n > 14 ? 6 : 1;
    while (n > 1 && ((x1 - x0) / (n - 1)) * every < 46) every++;
    const marks = keys.map((_, i) => i).filter((i) => i % every === 0);
    render(el, html`<svg class="hc-svg" width="${W}" height="${H}" viewBox="${`0 0 ${W} ${H}`}" aria-hidden="true">
      ${marks.map((i) => html`<line class="hc-vgrid" x1="${fix(x(i)) + 0.5}" x2="${fix(x(i)) + 0.5}" y1="${top}" y2="${y1}"/>`)}
      ${tk.map((v) => html`<line class="hc-grid dash" x1="${x0}" x2="${x1}" y1="${fix(y(v)) + 0.5}" y2="${fix(y(v)) + 0.5}"/>
        <text class="hc-t" x="${x0 - 8}" y="${fix(y(v) + 4)}" text-anchor="end">${spec.axis(v)}</text>`)}
      ${paths.map((p) => (p.d ? html`<path class="${p.cls}" d="${p.d}"/>` : ""))}
      <line class="hc-cross" x1="0" x2="0" y1="${top}" y2="${y1}" visibility="hidden"/>
      ${series.map((s) => html`<circle class="${`hc-dot ${s.dot || ""}`}" r="4.5" cx="0" cy="0" visibility="hidden"/>`)}
      ${marks.map((i) => html`<text class="hc-t" x="${fix(Math.min(Math.max(x(i), x0 + 16), W - 20))}" y="${H - 6}" text-anchor="middle">${spec.label(i)}</text>`)}
    </svg>`);
    geo = { x, y, x0, x1 };
  }

  function show(i) {
    if (!filled.length || !geo) return;
    sel = any(i) ? i : filled.reduce((b, j) => (b < 0 || Math.abs(j - i) < Math.abs(b - i) ? j : b), -1);
    const cx = fix(geo.x(sel));
    const cross = el.querySelector(".hc-cross");
    if (cross) { cross.setAttribute("x1", cx); cross.setAttribute("x2", cx); cross.setAttribute("visibility", "visible"); }
    el.querySelectorAll(".hc-dot").forEach((dot, k) => {
      const v = series[k] ? val(series[k], sel) : null;
      if (v === null) { dot.setAttribute("visibility", "hidden"); return; }
      dot.setAttribute("cx", cx);
      dot.setAttribute("cy", fix(geo.y(v)));
      dot.setAttribute("visibility", "visible");
    });
    if (spec.onRead) spec.onRead(sel);
  }
  const step = (d) => { const k = filled.indexOf(sel) + d; if (k >= 0 && k < filled.length) show(filled[k]); };
  const at = (e) => {
    if (!geo) return sel;
    const px = e.clientX - el.getBoundingClientRect().left;
    return n <= 1 ? 0 : Math.max(0, Math.min(n - 1, Math.round(((px - geo.x0) / (geo.x1 - geo.x0)) * (n - 1))));
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

// The running total of a period's buckets (the Money card's Collected and
// Scheduled lines climb to the big number, so a partial week or day never
// reads as a crash). Each point keeps its own amount as `own`; a bucket
// with no value (still ahead) stays a gap. What the period's total holds
// beyond its buckets (Rotor's days before the period's first Monday) is
// folded into the first point, so the line ends at the total.
export function cumulative(points, total = null) {
  const sum = (points || []).reduce((a, p) => a + (p.value === null || p.value === undefined ? 0 : p.value), 0);
  const lead = total !== null && total !== undefined && total - sum > 0 ? total - sum : 0;
  let run = lead;
  return (points || []).map((p) => {
    if (p.value === null || p.value === undefined) return { ...p, own: null, value: null };
    run += p.value;
    return { ...p, own: p.value, value: run };
  });
}

// A hidden table of every value (screen readers; the chart itself is aria-hidden).
export function srTable(caption, head, rows) {
  return html`<table class="sr"><caption>${caption}</caption><thead><tr>${head.map((h) => html`<th scope="col">${h}</th>`)}</tr></thead><tbody>${rows.map((r) => html`<tr>${r.map((c, i) => (i ? html`<td>${c}</td>` : html`<th scope="row">${c}</th>`))}</tr>`)}</tbody></table>`;
}
