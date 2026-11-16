// Home's charts, drawn in the CRM itself: the top's line (flyraLine,
// Flyra's, Nov 15), ARR's bars by month with each month's value on its bar (monthBars, Nov 15; Nov 16: its recurring revenue) and Rotor's Money chart (pairChart, Reports uses it):
// Collected in coral and Scheduled in grey per day of
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

// The top of Home (Nov 15, Flyra's): one thin line across the whole width,
// the values at the left on faint solid grid lines, a dotted line under
// the baseline, a soft wash under the line, no dates under it. A tap, a
// drag, the pointer or the arrow keys (once the chart has focus) put a
// hairline and a dot on a point and call onRead(i); leaving it calls
// onRead(null). Nothing is read out before that.
//
//   const c = flyraLine(el, { keys, values, axis, onRead })
//   c.destroy()
//
// values: one per key, null where there is no point (days still ahead): the line stops there.
let washes = 0;
export function flyraLine(el, spec) {
  const keys = spec.keys || [];
  const n = keys.length;
  const vals = (spec.values || []).map((v) => (v === null || v === undefined || !Number.isFinite(Number(v)) ? null : Number(v)));
  const filled = keys.map((_, i) => i).filter((i) => vals[i] !== null);
  const wash = `hf-wash-${++washes}`;
  let sel = -1, width = 0, height = 0, geo = null;
  function draw() {
    const W = Math.max(160, Math.floor(el.clientWidth));
    const H = Math.max(110, Math.floor(el.clientHeight) || 200);
    width = el.clientWidth;
    height = el.clientHeight;
    const top = 8, bottom = 14;
    const max = Math.max(0, ...filled.map((i) => vals[i]));
    const tk = ticks(max, { most: 4 });
    const top1 = tk[tk.length - 1] || 1;
    const gutter = Math.max(...tk.map((v) => spec.axis(v).length)) * 7 + 14;
    const x0 = gutter, x1 = W - 4, y1 = H - bottom;
    const x = (i) => (n <= 1 ? (x0 + x1) / 2 : x0 + ((x1 - x0) * i) / (n - 1));
    const y = (v) => y1 - (Math.max(0, v || 0) / top1) * (y1 - top);
    const runs = [];
    let cur = [];
    for (let i = 0; i < n; i++) {
      if (vals[i] !== null) cur.push([x(i), y(vals[i])]);
      else if (cur.length) { runs.push(cur); cur = []; }
    }
    if (cur.length) runs.push(cur);
    const line = runs.map((p) => smoothPath(p)).join("");
    const area = runs.filter((p) => p.length > 1).map((p) => `${smoothPath(p)}L${fix(p[p.length - 1][0])},${y1}L${fix(p[0][0])},${y1}Z`).join("");
    render(el, html`<svg class="hf-svg" width="${W}" height="${H}" viewBox="${`0 0 ${W} ${H}`}" aria-hidden="true">
      <defs><linearGradient id="${wash}" x1="0" y1="0" x2="0" y2="1"><stop class="hf-wash-a" offset="0"/><stop class="hf-wash-b" offset="1"/></linearGradient></defs>
      ${tk.map((v) => html`<line class="hf-grid" x1="${x0}" x2="${x1}" y1="${fix(y(v)) + 0.5}" y2="${fix(y(v)) + 0.5}"/>
        <text class="hf-t" x="${x0 - 12}" y="${fix(y(v) + 4)}" text-anchor="end">${spec.axis(v)}</text>`)}
      <line class="hf-base" x1="${x0}" x2="${x1}" y1="${y1 + 9.5}" y2="${y1 + 9.5}"/>
      ${area ? html`<path class="hf-area" d="${area}" fill="${`url(#${wash})`}"/>` : ""}
      ${line ? html`<path class="hf-line" d="${line}"/>` : ""}
      <line class="hf-cross" x1="0" x2="0" y1="${top}" y2="${y1}" visibility="hidden"/>
      <circle class="hf-dot" r="4.5" cx="0" cy="0" visibility="hidden"/>
    </svg>`);
    geo = { x, y, x0, x1 };
  }
  function show(i) {
    if (!filled.length || !geo) return;
    sel = vals[i] !== null && vals[i] !== undefined ? i : filled.reduce((b, j) => (b < 0 || Math.abs(j - i) < Math.abs(b - i) ? j : b), -1);
    const cx = fix(geo.x(sel));
    const cross = el.querySelector(".hf-cross"), dot = el.querySelector(".hf-dot");
    if (cross) { cross.setAttribute("x1", cx); cross.setAttribute("x2", cx); cross.setAttribute("visibility", "visible"); }
    if (dot) { dot.setAttribute("cx", cx); dot.setAttribute("cy", fix(geo.y(vals[sel]))); dot.setAttribute("visibility", "visible"); }
    if (spec.onRead) spec.onRead(sel);
  }
  function hide() {
    sel = -1;
    el.querySelectorAll(".hf-cross,.hf-dot").forEach((x) => x.setAttribute("visibility", "hidden"));
    if (spec.onRead) spec.onRead(null);
  }
  const at = (e) => {
    if (!geo) return 0;
    const px = e.clientX - el.getBoundingClientRect().left;
    return n <= 1 ? 0 : Math.max(0, Math.min(n - 1, Math.round(((px - geo.x0) / (geo.x1 - geo.x0)) * (n - 1))));
  };
  const step = (d) => { const k = sel < 0 ? filled.length - 1 : filled.indexOf(sel) + d; if (k >= 0 && k < filled.length) show(filled[k]); };
  const onPointer = (e) => show(at(e));
  const onLeave = (e) => { if (e.pointerType === "mouse" && document.activeElement !== el) hide(); };
  const onKey = (e) => {
    if (e.key === "ArrowLeft") { e.preventDefault(); step(-1); }
    else if (e.key === "ArrowRight") { e.preventDefault(); step(1); }
    else if (e.key === "Home") { e.preventDefault(); show(filled[0]); }
    else if (e.key === "End") { e.preventDefault(); show(filled[filled.length - 1]); }
    else if (e.key === "Escape") hide();
  };
  const onFocus = () => { if (sel < 0 && filled.length) show(filled[filled.length - 1]); };
  const onBlur = () => hide();
  el.addEventListener("pointerdown", onPointer);
  el.addEventListener("pointermove", onPointer);
  el.addEventListener("pointerleave", onLeave);
  el.addEventListener("keydown", onKey);
  el.addEventListener("focus", onFocus);
  el.addEventListener("blur", onBlur);
  draw();
  const redraw = () => { if (Math.abs(el.clientWidth - width) > 1 || Math.abs(el.clientHeight - height) > 1) { draw(); if (sel >= 0) show(sel); } };
  const ro = typeof ResizeObserver === "function" ? new ResizeObserver(() => redraw()) : null;
  if (ro) ro.observe(el);
  return {
    redraw, show, hide,
    destroy() {
      if (ro) ro.disconnect();
      for (const [k, f] of [["pointerdown", onPointer], ["pointermove", onPointer], ["pointerleave", onLeave], ["keydown", onKey], ["focus", onFocus], ["blur", onBlur]]) el.removeEventListener(k, f);
    },
  };
}

// ARR by month (the owner's Nov 15 asks: "ARR by month", then "make it like
// ARR with showing the MRR in all 12 months"): a bar a month, each with its
// own value on top of it (short: "$154", "$3.2k"; without the "$" when
// a phone is too narrow for it), so no axis and no grid; short month names
// under the bars (as many as fit, always this month's). This month is lit
// (`now`); one month is picked (this month to start with): its bar full,
// a soft column behind it. A tap, a drag, the pointer or the arrow keys
// pick another and call onRead(i). Nov 16: a bar is the month's recurring
// revenue, and the part of it that is only expected (`soft`: projected
// ahead, still to do in the past) sits on top of the rest in a lighter
// fill with a dashed edge.
//
//   const c = monthBars(el, { keys, labels, values, soft, value, now, start, onRead })
//   c.destroy()
//
// keys: the months (YYYY-MM); labels: their short names; values: one per
// key, null where there is no point; soft: the lighter part of each value
// (optional); value(v, tight): a bar's label (tight: the narrow form); now:
// this month's key; start: the key picked first.
// (the "$" is drawn at 80%: hb-cur)
const CHAR_W = { ".": 0.3, ",": 0.3, $: 0.5, k: 0.55, K: 0.66, M: 0.86, "−": 0.62, "-": 0.36 };
// a label's width at a font size (tabular digits; a little extra for the weight)
export const labelWidth = (text, fs) => [...String(text)].reduce((w, c) => w + (CHAR_W[c] || 0.61), 0) * fs * 1.04;
// the labels' form and size: the full form at 12.5 px down to 10 px ("$3.2k" on all
// 12 bars of an iPhone SE), else the tight form, else it on every k-th bar (always this month's)
export function barLabels(vals, slot, value) {
  const full = vals.map((v) => (v === null ? "" : value(v, false)));
  const tight = vals.map((v) => (v === null ? "" : value(v, true)));
  const room = slot - 2.5;
  const widest = (xs, fs) => Math.max(0, ...xs.map((x) => labelWidth(x, fs)));
  for (const fs of [12.5, 12, 11.5, 11, 10.5, 10]) if (widest(full, fs) <= room) return { text: full, fs, every: 1 };
  for (const fs of [11.5, 11, 10.5, 10]) if (widest(tight, fs) <= room) return { text: tight, fs, every: 1 };
  let every = 2;
  while (slot * every - 6 < widest(tight, 10.5) && every < vals.length) every++;
  return { text: tight, fs: 10.5, every };
}
export function monthBars(el, spec) {
  const keys = spec.keys || [];
  const labels = spec.labels || keys;
  const n = keys.length;
  const vals = (spec.values || []).map((v) => (v === null || v === undefined || !Number.isFinite(Number(v)) ? null : Number(v)));
  const filled = keys.map((_, i) => i).filter((i) => vals[i] !== null);
  const first = spec.start ? keys.indexOf(spec.start) : -1;
  const nowI = spec.now ? keys.indexOf(spec.now) : -1;
  const value = spec.value || ((v) => String(v));
  const soft = keys.map((_, i) => { const v = Number(spec.soft && spec.soft[i]); return vals[i] !== null && Number.isFinite(v) && v > 0 ? Math.min(v, vals[i]) : 0; });
  let sel = first >= 0 && vals[first] !== null ? first : filled.length ? filled[filled.length - 1] : -1;
  let width = 0, height = 0, geo = null;
  function draw() {
    const W = Math.max(160, Math.floor(el.clientWidth));
    const H = Math.max(120, Math.floor(el.clientHeight) || 220);
    width = el.clientWidth;
    height = el.clientHeight;
    const x0 = 2, x1 = W - 2, band = 26;
    const slot = (x1 - x0) / Math.max(1, n);
    const lab = barLabels(vals, slot, value);
    const top = Math.ceil(lab.fs) + 10, y1 = H - band;
    const max = Math.max(0, ...filled.map((i) => vals[i])) || 1;
    const bw = Math.max(4, Math.min(36, slot * 0.66));
    const cx = (i) => x0 + slot * (i + 0.5);
    const y = (v) => y1 - (Math.max(0, v || 0) / max) * (y1 - top);
    // a bar with rounded top corners ($0: a 2 px stub, so its "$0" sits on something)
    const bar = (i) => {
      const h = Math.max(2, y1 - y(vals[i]));
      const r = Math.min(5, bw / 2, h), l = cx(i) - bw / 2, t = y1 - h;
      return `M${fix(l)},${y1}V${fix(t + r)}Q${fix(l)},${fix(t)} ${fix(l + r)},${fix(t)}H${fix(l + bw - r)}Q${fix(l + bw)},${fix(t)} ${fix(l + bw)},${fix(t + r)}V${y1}Z`;
    };
    // a bar in two parts: the solid one from the baseline (square on top), the soft one over it (rounded)
    const part = (i, lo, hi, round) => {
      const b = lo > 0 ? y(lo) : y1, t = Math.min(b, y(hi));
      const r = round ? Math.min(5, bw / 2, b - t) : 0, l = cx(i) - bw / 2;
      return `M${fix(l)},${fix(b)}V${fix(t + r)}Q${fix(l)},${fix(t)} ${fix(l + r)},${fix(t)}H${fix(l + bw - r)}Q${fix(l + bw)},${fix(t)} ${fix(l + bw)},${fix(t + r)}V${fix(b)}Z`;
    };
    // the values on as many bars as fit (every one on a phone's 12), counted back from this month
    const last = nowI >= 0 ? nowI : n - 1;
    const valued = filled.filter((i) => lab.every === 1 || (last - i) % lab.every === 0);
    // as many month names as fit (24 px each at least: every month on a phone's 12), counted back from this month
    let every = 1;
    while (slot * every < 24) every++;
    const named = keys.map((_, i) => i).filter((i) => (n - 1 - i) % every === 0);
    const cls = (base, i) => base + (i === nowI ? " now" : "");
    render(el, html`<svg class="hf-svg hb-svg" width="${W}" height="${H}" viewBox="${`0 0 ${W} ${H}`}" aria-hidden="true">
      <rect class="hb-col" x="0" y="0" width="${fix(Math.min(slot - 2, bw + 16))}" height="${fix(y1 + 4)}" rx="8" visibility="hidden"/>
      <line class="hb-base" x1="${x0}" x2="${x1}" y1="${y1 + 0.5}" y2="${y1 + 0.5}"/>
      ${keys.map((_, i) => (vals[i] === null ? "" : !soft[i] ? html`<path class="${cls("hb-bar", i)}" data-i="${i}" d="${bar(i)}"/>`
        : html`<path class="${cls("hb-bar", i)}" data-i="${i}" d="${part(i, 0, vals[i] - soft[i], false)}"/><path class="${cls("hb-soft", i)}" data-i="${i}" d="${part(i, vals[i] - soft[i], vals[i], true)}"/>`))}
      ${valued.map((i) => { const [, sign, cur, rest] = /^(−?)(\$?)(.*)$/.exec(lab.text[i]); return html`<text class="${cls("hb-v", i)}" data-i="${i}" x="${fix(cx(i))}" y="${fix(y(vals[i]) - 6)}" text-anchor="middle" style="${`font-size:${lab.fs}px`}">${sign}${cur ? html`<tspan class="hb-cur">$</tspan>` : ""}${rest}</text>`; })}
      ${named.map((i) => html`<text class="${cls("hf-t hb-m", i)}" data-i="${i}" x="${fix(cx(i))}" y="${H - 7}" text-anchor="middle">${labels[i]}</text>`)}
    </svg>`);
    geo = { cx, x0, x1, slot, bw, top, y1 };
  }
  function show(i, quiet = false) {
    if (!filled.length || !geo) return;
    sel = vals[i] !== null && vals[i] !== undefined ? i : filled.reduce((b, j) => (b < 0 || Math.abs(j - i) < Math.abs(b - i) ? j : b), -1);
    el.querySelectorAll(".hb-bar, .hb-soft, .hb-m, .hb-v").forEach((b) => b.classList.toggle("on", Number(b.dataset.i) === sel));
    const col = el.querySelector(".hb-col");
    if (col) { col.setAttribute("x", fix(geo.cx(sel) - Number(col.getAttribute("width")) / 2)); col.setAttribute("visibility", "visible"); }
    if (spec.onRead && !quiet) spec.onRead(sel);
  }
  const at = (e) => {
    if (!geo) return sel;
    const px = e.clientX - el.getBoundingClientRect().left;
    return Math.max(0, Math.min(n - 1, Math.floor((px - geo.x0) / geo.slot)));
  };
  const step = (d) => { const k = filled.indexOf(sel) + d; if (k >= 0 && k < filled.length) show(filled[k]); };
  const onDown = (e) => show(at(e));
  // a mouse picks as it moves; a finger as it drags along
  const onMove = (e) => { if (e.pointerType === "mouse" || e.buttons) { const i = at(e); if (i !== sel) show(i); } };
  const onKey = (e) => {
    if (e.key === "ArrowLeft") { e.preventDefault(); step(-1); }
    else if (e.key === "ArrowRight") { e.preventDefault(); step(1); }
    else if (e.key === "Home") { e.preventDefault(); show(filled[0]); }
    else if (e.key === "End") { e.preventDefault(); show(filled[filled.length - 1]); }
  };
  el.addEventListener("pointerdown", onDown);
  el.addEventListener("pointermove", onMove);
  el.addEventListener("keydown", onKey);
  draw();
  show(sel, true);
  const redraw = () => { if (Math.abs(el.clientWidth - width) > 1 || Math.abs(el.clientHeight - height) > 1) { draw(); show(sel, true); } };
  const ro = typeof ResizeObserver === "function" ? new ResizeObserver(() => redraw()) : null;
  if (ro) ro.observe(el);
  return {
    redraw, show,
    destroy() {
      if (ro) ro.disconnect();
      for (const [k, f] of [["pointerdown", onDown], ["pointermove", onMove], ["keydown", onKey]]) el.removeEventListener(k, f);
    },
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
