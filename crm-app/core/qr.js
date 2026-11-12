// Barta CRM client: QR codes, drawn on the phone (no library, no outside
// service): the pay QR on an invoice or a visit (money) and the codes on
// yard signs, door hangers and flyers (sales). Byte mode (UTF-8), error
// correction L, M, Q or H (M for a pay link on a screen; Q for print that
// lives outdoors), versions 1 to 40 (a pay link needs about 3), the eight
// masks scored the standard way (ISO/IEC 18004).
//
//   qrMatrix(text, { ecl, mask }) → { size, version, ecl, mask, rows }   rows[y][x] true = dark
//   qrSvg(text, { ecl, margin, label }) → one <svg> (black on white, a quiet zone of `margin` modules)
//   qrPosterSvg(text, { ecl, lines, width, height }) → a printable <svg>: the code and words under it
//   svgToPngBlob(svg, px) → Promise<Blob>  (browser only: draws the svg on a canvas)
//   saveFile(name, blob)                   (browser only: a download, never a page that leaves the CRM)
//
// Nothing here reaches the network.

const ECL = Object.freeze({ L: 1, M: 0, Q: 3, H: 2 });       // the format bits of each level
// [L, M, Q, H] per version (index 0 unused): error-correction codewords per block, and blocks
const ECC_PER_BLOCK = [
  [-1, 7, 10, 15, 20, 26, 18, 20, 24, 30, 18, 20, 24, 26, 30, 22, 24, 28, 30, 28, 28, 28, 28, 30, 30, 26, 28, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30],
  [-1, 10, 16, 26, 18, 24, 16, 18, 22, 22, 26, 30, 22, 22, 24, 24, 28, 28, 26, 26, 26, 26, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28],
  [-1, 13, 22, 18, 26, 18, 24, 18, 22, 20, 24, 28, 26, 24, 20, 30, 24, 28, 28, 26, 30, 28, 30, 30, 30, 30, 28, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30],
  [-1, 17, 28, 22, 16, 22, 28, 26, 26, 24, 28, 24, 28, 22, 24, 24, 30, 28, 28, 26, 28, 30, 24, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30],
];
const BLOCKS = [
  [-1, 1, 1, 1, 1, 1, 2, 2, 2, 2, 4, 4, 4, 4, 4, 6, 6, 6, 6, 7, 8, 8, 9, 9, 10, 12, 12, 12, 13, 14, 15, 16, 17, 18, 19, 19, 20, 21, 22, 24, 25],
  [-1, 1, 1, 1, 2, 2, 4, 4, 4, 5, 5, 5, 8, 9, 9, 10, 10, 11, 13, 14, 16, 17, 17, 18, 20, 21, 23, 25, 26, 28, 29, 31, 33, 35, 37, 38, 40, 43, 45, 47, 49],
  [-1, 1, 1, 2, 2, 4, 4, 6, 6, 8, 8, 8, 10, 12, 16, 12, 17, 16, 18, 21, 20, 23, 23, 25, 27, 29, 34, 34, 35, 38, 40, 43, 45, 48, 51, 53, 56, 59, 62, 65, 68],
  [-1, 1, 1, 2, 4, 4, 4, 5, 6, 8, 8, 11, 11, 16, 16, 18, 16, 19, 21, 25, 25, 25, 34, 30, 32, 35, 37, 40, 42, 45, 48, 51, 54, 57, 60, 63, 66, 70, 74, 77, 81],
];
const ROW = { L: 0, M: 1, Q: 2, H: 3 };
export const MAX_VERSION = 40;
export const ECLS = Object.freeze(Object.keys(ROW));

// (anything but a level's letter, such as an index from Array.map, means M)
const level = (ecl) => {
  const e = typeof ecl === "string" && ecl ? ecl.toUpperCase() : "M";
  if (!Object.hasOwn(ROW, e)) throw new RangeError("error correction is L, M, Q or H");
  return e;
};

// Modules left for data and error correction after the fixed patterns.
export function rawModules(ver) {
  let r = (16 * ver + 128) * ver + 64;
  if (ver >= 2) {
    const n = Math.floor(ver / 7) + 2;
    r -= (25 * n - 10) * n - 55;
    if (ver >= 7) r -= 36;
  }
  return r;
}
export const dataCodewords = (ver, ecl = "M") => {
  const e = ROW[level(ecl)];
  return Math.floor(rawModules(ver) / 8) - ECC_PER_BLOCK[e][ver] * BLOCKS[e][ver];
};
// How many bytes fit in byte mode at this version and level.
export const byteCapacity = (ver, ecl = "M") => Math.floor((dataCodewords(ver, ecl) * 8 - 4 - (ver < 10 ? 8 : 16)) / 8);

// ---- Reed-Solomon over GF(256), polynomial 0x11D
export function gfMul(x, y) {
  let z = 0;
  for (let i = 7; i >= 0; i--) { z = (z << 1) ^ ((z >>> 7) * 0x11d); z ^= ((y >>> i) & 1) * x; }
  return z;
}
function rsDivisor(degree) {
  const out = new Array(degree).fill(0);
  out[degree - 1] = 1;
  let root = 1;
  for (let i = 0; i < degree; i++) {
    for (let j = 0; j < degree; j++) { out[j] = gfMul(out[j], root); if (j + 1 < degree) out[j] ^= out[j + 1]; }
    root = gfMul(root, 2);
  }
  return out;
}
export function rsRemainder(data, divisor) {
  const out = divisor.map(() => 0);
  for (const b of data) {
    const f = b ^ out.shift();
    out.push(0);
    for (let i = 0; i < divisor.length; i++) out[i] ^= gfMul(divisor[i], f);
  }
  return out;
}

// The data codewords of `text` (UTF-8, byte mode) for the smallest version that holds it.
function encodeData(text, ecl, minVersion = 1) {
  const bytes = [...new TextEncoder().encode(String(text))];
  let ver = Math.max(1, Math.min(MAX_VERSION, minVersion | 0));
  for (; ver <= MAX_VERSION; ver++) if (4 + (ver < 10 ? 8 : 16) + bytes.length * 8 <= dataCodewords(ver, ecl) * 8) break;
  if (ver > MAX_VERSION) throw new RangeError("too long for a QR code");
  const bits = [];
  const put = (val, len) => { for (let i = len - 1; i >= 0; i--) bits.push((val >>> i) & 1); };
  put(4, 4);
  put(bytes.length, ver < 10 ? 8 : 16);
  for (const b of bytes) put(b, 8);
  const cap = dataCodewords(ver, ecl) * 8;
  put(0, Math.min(4, cap - bits.length));
  put(0, (8 - (bits.length % 8)) % 8);
  for (let pad = 0xec; bits.length < cap; pad ^= 0xec ^ 0x11) put(pad, 8);
  const data = [];
  for (let i = 0; i < bits.length; i += 8) data.push(bits.slice(i, i + 8).reduce((v, b) => (v << 1) | b, 0));
  return { ver, data };
}

// Splits into blocks, adds each block's error correction, interleaves.
function withEcc(data, ver, ecl) {
  const e = ROW[ecl];
  const nb = BLOCKS[e][ver], ecc = ECC_PER_BLOCK[e][ver], raw = Math.floor(rawModules(ver) / 8);
  const short = nb - (raw % nb), shortLen = Math.floor(raw / nb);
  const div = rsDivisor(ecc);
  const blocks = [];
  for (let i = 0, k = 0; i < nb; i++) {
    const dat = data.slice(k, k + shortLen - ecc + (i < short ? 0 : 1));
    k += dat.length;
    const rem = rsRemainder(dat, div);
    if (i < short) dat.push(0);
    blocks.push(dat.concat(rem));
  }
  const out = [];
  for (let i = 0; i < blocks[0].length; i++) blocks.forEach((b, j) => { if (i !== shortLen - ecc || j >= short) out.push(b[i]); });
  return out;
}

export function alignmentPositions(ver) {
  if (ver === 1) return [];
  const size = ver * 4 + 17, n = Math.floor(ver / 7) + 2;
  const step = Math.floor((ver * 8 + n * 3 + 5) / (n * 4 - 4)) * 2;   // (version 32's 26 included)
  const out = [6];
  for (let pos = size - 7; out.length < n; pos -= step) out.splice(1, 0, pos);
  return out;
}

// The 15 format bits for a level and a mask (BCH, then the fixed XOR).
export function formatBits(mask, ecl = "M") {
  const data = (ECL[level(ecl)] << 3) | mask;
  let rem = data;
  for (let i = 0; i < 10; i++) rem = (rem << 1) ^ ((rem >>> 9) * 0x537);
  return ((data << 10) | rem) ^ 0x5412;
}
export function versionBits(ver) {
  let rem = ver;
  for (let i = 0; i < 12; i++) rem = (rem << 1) ^ ((rem >>> 11) * 0x1f25);
  return (ver << 12) | rem;
}

export const MASKS = Object.freeze([
  (x, y) => (x + y) % 2 === 0, (x, y) => y % 2 === 0, (x) => x % 3 === 0, (x, y) => (x + y) % 3 === 0,
  (x, y) => (Math.floor(x / 3) + Math.floor(y / 2)) % 2 === 0, (x, y) => ((x * y) % 2) + ((x * y) % 3) === 0,
  (x, y) => (((x * y) % 2) + ((x * y) % 3)) % 2 === 0, (x, y) => (((x + y) % 2) + ((x * y) % 3)) % 2 === 0,
]);

// The function patterns of a version: which modules are fixed (finders,
// separators, timing, alignment, format and version areas, the dark module).
export function functionModules(ver) {
  const size = ver * 4 + 17;
  const fn = Array.from({ length: size }, () => new Array(size).fill(false));
  const mark = (x, y) => { if (x >= 0 && y >= 0 && x < size && y < size) fn[y][x] = true; };
  for (let i = 0; i < size; i++) { mark(6, i); mark(i, 6); }
  for (const [cx, cy] of [[3, 3], [size - 4, 3], [3, size - 4]]) for (let dy = -4; dy <= 4; dy++) for (let dx = -4; dx <= 4; dx++) mark(cx + dx, cy + dy);
  const ap = alignmentPositions(ver);
  ap.forEach((ax, i) => ap.forEach((ay, j) => {
    if ((i === 0 && j === 0) || (i === 0 && j === ap.length - 1) || (i === ap.length - 1 && j === 0)) return;
    for (let dy = -2; dy <= 2; dy++) for (let dx = -2; dx <= 2; dx++) mark(ax + dx, ay + dy);
  }));
  for (let i = 0; i < 9; i++) { mark(8, i); mark(i, 8); }
  for (let i = 0; i < 8; i++) { mark(size - 1 - i, 8); mark(8, size - 1 - i); }
  if (ver >= 7) for (let i = 0; i < 18; i++) { mark(size - 11 + (i % 3), Math.floor(i / 3)); mark(Math.floor(i / 3), size - 11 + (i % 3)); }
  return fn;
}

function build(ver, codewords, mask, ecl) {
  const size = ver * 4 + 17;
  const m = Array.from({ length: size }, () => new Array(size).fill(false));
  const fn = Array.from({ length: size }, () => new Array(size).fill(false));
  const set = (x, y, dark) => { m[y][x] = !!dark; fn[y][x] = true; };
  const bit = (v, i) => ((v >>> i) & 1) !== 0;
  for (let i = 0; i < size; i++) { set(6, i, i % 2 === 0); set(i, 6, i % 2 === 0); }
  for (const [cx, cy] of [[3, 3], [size - 4, 3], [3, size - 4]]) {
    for (let dy = -4; dy <= 4; dy++) for (let dx = -4; dx <= 4; dx++) {
      const x = cx + dx, y = cy + dy, d = Math.max(Math.abs(dx), Math.abs(dy));
      if (x >= 0 && x < size && y >= 0 && y < size) set(x, y, d !== 2 && d !== 4);
    }
  }
  const ap = alignmentPositions(ver);
  ap.forEach((ax, i) => ap.forEach((ay, j) => {
    if ((i === 0 && j === 0) || (i === 0 && j === ap.length - 1) || (i === ap.length - 1 && j === 0)) return;
    for (let dy = -2; dy <= 2; dy++) for (let dx = -2; dx <= 2; dx++) set(ax + dx, ay + dy, Math.max(Math.abs(dx), Math.abs(dy)) !== 1);
  }));
  const fb = formatBits(mask, ecl);
  for (let i = 0; i <= 5; i++) set(8, i, bit(fb, i));
  set(8, 7, bit(fb, 6)); set(8, 8, bit(fb, 7)); set(7, 8, bit(fb, 8));
  for (let i = 9; i < 15; i++) set(14 - i, 8, bit(fb, i));
  for (let i = 0; i < 8; i++) set(size - 1 - i, 8, bit(fb, i));
  for (let i = 8; i < 15; i++) set(8, size - 15 + i, bit(fb, i));
  set(8, size - 8, true);
  if (ver >= 7) {
    const vb = versionBits(ver);
    for (let i = 0; i < 18; i++) { const a = size - 11 + (i % 3), b = Math.floor(i / 3); set(a, b, bit(vb, i)); set(b, a, bit(vb, i)); }
  }
  // the codewords, zigzag from the bottom right, two columns at a time
  let i = 0;
  for (let right = size - 1; right >= 1; right -= 2) {
    if (right === 6) right = 5;
    for (let vert = 0; vert < size; vert++) {
      for (let j = 0; j < 2; j++) {
        const x = right - j;
        const y = ((right + 1) & 2) === 0 ? size - 1 - vert : vert;
        if (!fn[y][x] && i < codewords.length * 8) { m[y][x] = bit(codewords[i >>> 3], 7 - (i & 7)); i++; }
      }
    }
  }
  for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) if (!fn[y][x] && MASKS[mask](x, y)) m[y][x] = !m[y][x];
  return m;
}

// The standard penalty of a finished symbol: lower reads better.
function penalty(m) {
  const size = m.length;
  let score = 0, dark = 0;
  const lines = [];
  for (let y = 0; y < size; y++) lines.push(m[y]);
  for (let x = 0; x < size; x++) lines.push(m.map((row) => row[x]));
  for (const line of lines) {
    let run = 1;
    for (let i = 1; i <= size; i++) {
      if (i < size && line[i] === line[i - 1]) run++;
      else { if (run >= 5) score += run - 2; run = 1; }
    }
    // a finder-like 1:1:3:1:1 with four light modules on a side
    for (let i = 0; i + 10 < size; i++) {
      const s = line.slice(i, i + 11).map((b) => (b ? "1" : "0")).join("");
      if (s === "10111010000" || s === "00001011101") score += 40;
    }
  }
  for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) {
    if (m[y][x]) dark++;
    if (x + 1 < size && y + 1 < size && m[y][x] === m[y][x + 1] && m[y][x] === m[y + 1][x] && m[y][x] === m[y + 1][x + 1]) score += 3;
  }
  score += Math.floor(Math.abs(dark * 20 - size * size * 10) / (size * size)) * 10;
  return score;
}

// → { size, version, ecl, mask, rows } (rows[y][x] true = dark).
// opts.ecl "L" | "M" (default) | "Q" | "H"; opts.mask forces one of the
// eight; opts.minVersion makes a bigger symbol than the text needs.
export function qrMatrix(text, { mask, ecl = "M", minVersion = 1 } = {}) {
  const e = level(ecl);
  const { ver, data } = encodeData(text, e, minVersion);
  const cw = withEcc(data, ver, e);
  let best = null;
  for (let k = 0; k < 8; k++) {
    if (Number.isInteger(mask) && mask !== k) continue;
    const rows = build(ver, cw, k, e);
    const p = penalty(rows);
    if (!best || p < best.p) best = { p, rows, mask: k };
  }
  if (!best) throw new RangeError("mask is 0 to 7");
  return { size: best.rows.length, version: ver, ecl: e, mask: best.mask, rows: best.rows };
}

// The dark modules as one SVG path (runs of a row in one rectangle each).
function pathOf(q, ox, oy, unit = 1) {
  let d = "";
  for (let y = 0; y < q.size; y++) {
    for (let x = 0; x < q.size; x++) {
      if (!q.rows[y][x]) continue;
      let w = 1;
      while (x + w < q.size && q.rows[y][x + w]) w++;
      d += `M${round(ox + x * unit)} ${round(oy + y * unit)}h${round(w * unit)}v${round(unit)}h-${round(w * unit)}z`;
      x += w - 1;
    }
  }
  return d;
}
const round = (n) => Math.round(n * 1000) / 1000;
// Words for an SVG text node or attribute: escaped, never markup.
export const svgText = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);

// One <svg>: dark modules as a single path, a quiet zone (four modules by
// default), black on white (it must scan in dark mode too).
export function qrSvg(text, { margin = 4, label = "QR code to pay", ecl = "M" } = {}) {
  const q = qrMatrix(text, { ecl });
  const n = q.size + margin * 2;
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${n} ${n}" role="img" aria-label="${String(label).replace(/[^\w .,:-]/g, "")}" shape-rendering="crispEdges"><rect width="${n}" height="${n}" fill="#fff"/><path d="${pathOf(q, margin, margin)}" fill="#000"/></svg>`;
}

// A printable sheet: the code (as big as fits, with its quiet zone) and up
// to four lines of words under it. width × height are in "points" of the
// viewBox (the print size sets the real size); lines: [{ text, size, bold }].
export function qrPosterSvg(text, { ecl = "Q", width = 1800, height = 2400, lines = [], label = "QR code", pad = 0.06 } = {}) {
  const q = qrMatrix(text, { ecl });
  const m = Math.round(Math.min(width, height) * pad);
  const words = lines.filter((l) => l && String(l.text || "").trim()).slice(0, 4);
  const textH = words.reduce((s, l) => s + Math.round((l.size || 0.05) * width * 1.35), 0);
  const quiet = 4;
  const side = Math.max(10, Math.min(width - 2 * m, height - 2 * m - textH - (words.length ? m * 0.5 : 0)));
  const unit = side / (q.size + quiet * 2);
  const x0 = (width - side) / 2, y0 = m;
  let y = y0 + side + (words.length ? m * 0.35 : 0);
  const out = words.map((l) => {
    const fs = Math.round((l.size || 0.05) * width);
    y += Math.round(fs * 1.2);
    return `<text x="${round(width / 2)}" y="${round(y)}" text-anchor="middle" font-family="Helvetica, Arial, sans-serif" font-size="${fs}" font-weight="${l.bold ? 700 : 400}" fill="#000">${svgText(String(l.text).slice(0, 80))}</text>`;
  }).join("");
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${width} ${height}" width="${width}" height="${height}" role="img" aria-label="${svgText(label)}"><rect width="${width}" height="${height}" fill="#fff"/><path d="${pathOf(q, x0 + quiet * unit, y0 + quiet * unit, unit)}" fill="#000" shape-rendering="crispEdges"/>${out}</svg>`;
}

// ---- the browser (never imported by the server)

// The svg drawn onto a canvas of `px` pixels across → a PNG Blob.
export function svgToPngBlob(svg, px = 1200) {
  return new Promise((resolve, reject) => {
    const vb = /viewBox="0 0 ([\d.]+) ([\d.]+)"/.exec(svg);
    const w = vb ? Number(vb[1]) : 1, h = vb ? Number(vb[2]) : 1;
    const canvas = document.createElement("canvas");
    canvas.width = Math.round(px);
    canvas.height = Math.round((px * h) / w);
    const img = new Image();
    const url = URL.createObjectURL(new Blob([svg], { type: "image/svg+xml" }));
    img.onload = () => {
      try {
        const g = canvas.getContext("2d");
        g.fillStyle = "#fff";
        g.fillRect(0, 0, canvas.width, canvas.height);
        g.imageSmoothingEnabled = false;
        g.drawImage(img, 0, 0, canvas.width, canvas.height);
        URL.revokeObjectURL(url);
        canvas.toBlob((b) => (b ? resolve(b) : reject(new Error("That picture couldn't be made."))), "image/png");
      } catch (e) { URL.revokeObjectURL(url); reject(e); }
    };
    img.onerror = () => { URL.revokeObjectURL(url); reject(new Error("That picture couldn't be made.")); };
    img.src = url;
  });
}

// A file to keep (a download; on a phone, the share sheet when it can take files).
export async function saveFile(name, blob, { share = false, title } = {}) {
  const file = typeof File === "function" ? new File([blob], name, { type: blob.type }) : null;
  if (share && file && navigator.canShare && navigator.canShare({ files: [file] })) {
    try { await navigator.share({ files: [file], title: title || name }); return "shared"; } catch (e) { if (e && e.name === "AbortError") return "cancelled"; }
  }
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = name;
  a.rel = "noopener";
  a.style.display = "none";
  document.body.appendChild(a);
  a.click();
  setTimeout(() => { a.remove(); URL.revokeObjectURL(url); }, 1000);
  return "saved";
}
