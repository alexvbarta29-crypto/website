// Home's one chart (collected per week this month), drawn in the CRM
// itself. The dataviz rules: one series in coral (#fb4d3d, the house
// color), columns at most 24 px wide with 4 px rounded tops on one
// baseline, hairline solid gridlines, three clean ticks, labels in ink
// (never in the series color), x labels that never collide, and a readout
// above the plot that follows a tap, a drag, the pointer or the arrow keys
// (the latest week with money to start with). A slot whose value is null
// (a week still ahead) keeps its place and label but draws nothing and is
// never read out. Every value is also in a table for screen readers.
//
//   const c = columns(el, { rows, value: (r) => r.value, fmt, axis, read })
//   c.destroy()
//
// rows [{ key, label, ... }]; fmt(v) → "$4,320" (the readout), axis(v) →
// "$4K" (the ticks); read(row) → the readout's second line. Drawn at the
// element's own size (its CSS height, else spec.height) and again whenever
// that changes (a ResizeObserver), so text never scales.

import { html, render } from "../../core/ui.js";

// Colors live in home.css (.hc-cur coral, the selected column a step
// darker, hairline gridlines, ink-3 labels).

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

// A column with a rounded data end, square at the baseline.
function colPath(x, y, w, base) {
  const h = base - y;
  if (h <= 0.5) return "";
  const r = Math.min(4, w / 2, h);
  return `M${x},${base}V${y + r}Q${x},${y} ${x + r},${y}H${x + w - r}Q${x + w},${y} ${x + w},${y + r}V${base}Z`;
}
const fix = (n) => Math.round(n * 10) / 10;

export function columns(el, spec) {
  const rows = spec.rows || [];
  const value = spec.value || ((r) => r.value);
  const has = (i) => i >= 0 && i < rows.length && value(rows[i]) !== null && value(rows[i]) !== undefined;
  const filled = rows.map((_, i) => i).filter(has);
  let sel = filled.length ? filled[filled.length - 1] : -1;
  let width = 0, height = 0;
  const readEl = spec.readout || null;

  function draw() {
    const W = Math.max(120, Math.floor(el.clientWidth));
    width = el.clientWidth;
    height = el.clientHeight;
    const H = Math.max(80, Math.floor(el.clientHeight) || spec.height || 128);
    const top = 6, band = 22;
    const max = Math.max(0, ...filled.map((i) => value(rows[i]) || 0));
    const tk = ticks(max, { whole: !!spec.whole });
    const top1 = tk[tk.length - 1];
    const gutter = Math.max(...tk.map((v) => spec.axis(v).length)) * 6.4 + 8;
    const x0 = gutter, x1 = W, y1 = H - band;
    const y = (v) => y1 - ((v || 0) / top1) * (y1 - top);
    const n = Math.max(1, rows.length);
    const slot = (x1 - x0) / n;
    const bw = Math.min(24, slot * 0.56);
    const labelW = Math.max(...rows.map((r) => String(r.label).length)) * 6 + 8;
    const every = Math.max(1, Math.ceil(labelW / slot));
    const bars = rows.map((r, i) => {
      const cx = x0 + slot * i + slot / 2;
      return { i, cx, b: has(i) ? colPath(fix(cx - bw / 2), fix(y(value(r))), fix(bw), y1) : "" };
    });
    render(el, html`<svg class="hc-svg" width="${W}" height="${H}" viewBox="${`0 0 ${W} ${H}`}" aria-hidden="true">
      ${tk.map((v) => html`<line class="${v === 0 ? "hc-base" : "hc-grid"}" x1="${x0}" x2="${x1}" y1="${fix(y(v)) + 0.5}" y2="${fix(y(v)) + 0.5}"/>
        <text class="hc-t" x="0" y="${fix(y(v) + 3.5)}">${spec.axis(v)}</text>`)}
      ${bars.map((b) => html`<g class="${"hc-col" + (b.i === sel ? " on" : "")}" data-i="${b.i}">${b.b ? html`<path class="hc-cur" d="${b.b}"/>` : ""}</g>`)}
      ${bars.filter((b) => (n - 1 - b.i) % every === 0).map((b) => html`<text class="${"hc-t" + (has(b.i) ? "" : " hc-ahead")}" x="${fix(Math.min(Math.max(b.cx, x0 + labelW / 2 - 4), W - labelW / 2 + 4))}" y="${H - 6}" text-anchor="middle">${rows[b.i].label}</text>`)}
    </svg>`);
    el.dataset.x0 = String(x0);
    el.dataset.slot = String(slot);
  }

  // the nearest slot with a value (a tap on a week still ahead reads the latest one)
  const nearest = (i) => filled.reduce((best, j) => (best < 0 || Math.abs(j - i) < Math.abs(best - i) ? j : best), -1);
  function show(i) {
    if (!filled.length) return;
    sel = has(i) ? i : nearest(i);
    el.querySelectorAll(".hc-col").forEach((g) => g.classList.toggle("on", Number(g.dataset.i) === sel));
    if (readEl) {
      const r = rows[sel];
      const b = readEl.querySelector("b");
      const s = readEl.querySelector("span");
      if (b) b.textContent = spec.fmt(value(r) || 0);
      if (s) s.textContent = spec.read ? spec.read(r) : r.label;
    }
  }
  const step = (d) => { const k = filled.indexOf(sel) + d; if (k >= 0 && k < filled.length) show(filled[k]); };

  const at = (e) => {
    const box = el.getBoundingClientRect();
    const x = e.clientX - box.left - Number(el.dataset.x0 || 0);
    return Math.floor(x / Number(el.dataset.slot || 1));
  };
  // a tap or a drag on a phone, the pointer on a desk
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
