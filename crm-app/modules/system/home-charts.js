// Home's charts, drawn in the CRM itself (no frame of /dashboard). The
// dataviz rules: one series per chart in coral (#fb4d3d, the house color;
// last year beside this year in a recessive gray, the emphasis form),
// columns at most 24 px wide with 4 px rounded tops on one baseline,
// hairline solid gridlines, three clean ticks, labels in ink (never in the
// series color), a few x labels that never collide, and a readout above
// the plot that follows a tap, a drag, the pointer or the arrow keys (the
// latest bar to start with). Every value is also in a table for screen
// readers, and on the Dashboard's "Show table" behind "See more".
//
//   const c = columns(el, { rows, value: (r) => r.value, prev?: (r) => r.prev, fmt, axis, read, label })
//   c.destroy()
//
// rows [{ key, label, ... }]; fmt(v) → "$4,320" (the readout), axis(v) →
// "$4K" (the ticks); read(row) → the readout's second line. Drawn at the
// element's own size (its CSS height, else spec.height) and again whenever
// that changes (a ResizeObserver), so text never scales.

import { html, render } from "../../core/ui.js";

// Colors live in home.css (.hc-cur coral #fb4d3d, .hc-prev gray, the
// selected column a step darker, hairline gridlines, ink-3 labels), so a
// chart on the dark money card takes that card's steps.

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
  const prev = spec.prev || null;
  let sel = rows.length - 1;
  let width = 0, height = 0;
  const readEl = spec.readout || null;

  function draw() {
    const W = Math.max(120, Math.floor(el.clientWidth));
    width = el.clientWidth;
    height = el.clientHeight;
    const H = Math.max(80, Math.floor(el.clientHeight) || spec.height || 128);
    const top = 6, band = 22;
    const max = Math.max(0, ...rows.map((r) => Math.max(value(r) || 0, prev ? prev(r) || 0 : 0)));
    const tk = ticks(max, { whole: !!spec.whole });
    const top1 = tk[tk.length - 1];
    const gutter = Math.max(...tk.map((v) => spec.axis(v).length)) * 6.4 + 8;
    const x0 = gutter, x1 = W, y1 = H - band;
    const y = (v) => y1 - ((v || 0) / top1) * (y1 - top);
    const n = Math.max(1, rows.length);
    const slot = (x1 - x0) / n;
    const pairGap = 2;
    const bw = prev ? Math.min(10, (slot * 0.66 - pairGap) / 2) : Math.min(24, slot * 0.56);
    const labelW = Math.max(...rows.map((r) => String(r.label).length)) * 6 + 8;
    const every = Math.max(1, Math.ceil(labelW / slot));
    const bars = rows.map((r, i) => {
      const cx = x0 + slot * i + slot / 2;
      const cur = value(r) || 0;
      if (prev) {
        return { i, cx, a: colPath(fix(cx - pairGap / 2 - bw), fix(y(prev(r) || 0)), fix(bw), y1), b: colPath(fix(cx + pairGap / 2), fix(y(cur)), fix(bw), y1) };
      }
      return { i, cx, b: colPath(fix(cx - bw / 2), fix(y(cur)), fix(bw), y1) };
    });
    render(el, html`<svg class="hc-svg" width="${W}" height="${H}" viewBox="${`0 0 ${W} ${H}`}" aria-hidden="true">
      ${tk.map((v) => html`<line class="${v === 0 ? "hc-base" : "hc-grid"}" x1="${x0}" x2="${x1}" y1="${fix(y(v)) + 0.5}" y2="${fix(y(v)) + 0.5}"/>
        <text class="hc-t" x="0" y="${fix(y(v) + 3.5)}">${spec.axis(v)}</text>`)}
      ${bars.map((b) => html`<g class="${"hc-col" + (b.i === sel ? " on" : "")}" data-i="${b.i}">${prev && b.a ? html`<path class="hc-prev" d="${b.a}"/>` : ""}${b.b ? html`<path class="hc-cur" d="${b.b}"/>` : ""}</g>`)}
      ${bars.filter((b) => (n - 1 - b.i) % every === 0).map((b) => html`<text class="hc-t" x="${fix(Math.min(Math.max(b.cx, x0 + labelW / 2 - 4), W - labelW / 2 + 4))}" y="${H - 6}" text-anchor="middle">${rows[b.i].label}</text>`)}
    </svg>`);
    el.dataset.x0 = String(x0);
    el.dataset.slot = String(slot);
  }

  function show(i) {
    if (!rows.length) return;
    sel = Math.max(0, Math.min(rows.length - 1, i));
    el.querySelectorAll(".hc-col").forEach((g) => g.classList.toggle("on", Number(g.dataset.i) === sel));
    if (readEl) {
      const r = rows[sel];
      const b = readEl.querySelector("b");
      const s = readEl.querySelector("span");
      if (b) b.textContent = spec.fmt(value(r) || 0);
      if (s) s.textContent = spec.read ? spec.read(r) : r.label;
    }
  }

  const at = (e) => {
    const box = el.getBoundingClientRect();
    const x = e.clientX - box.left - Number(el.dataset.x0 || 0);
    return Math.floor(x / Number(el.dataset.slot || 1));
  };
  // a tap or a drag on a phone, the pointer on a desk
  const onPointer = (e) => show(at(e));
  const onKey = (e) => {
    if (e.key === "ArrowLeft") { e.preventDefault(); show(sel - 1); }
    else if (e.key === "ArrowRight") { e.preventDefault(); show(sel + 1); }
    else if (e.key === "Home") { e.preventDefault(); show(0); }
    else if (e.key === "End") { e.preventDefault(); show(rows.length - 1); }
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
