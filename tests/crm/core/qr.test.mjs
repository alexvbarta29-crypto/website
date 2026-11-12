// The shared QR encoder (crm-app/core/qr.js): the pay QR on an invoice or a
// visit and the codes on signs and flyers. Checked three ways: the
// standard's own tables (format and version bits, capacities, alignment
// centres), reference symbols made by an independent encoder for fixed
// inputs (the python-qrcode package, BSD; generated once, outside the
// repo), and a small decoder below that reads every symbol back: the format
// bits, the mask off, the zigzag, the blocks apart, each block's
// Reed-Solomon check, byte mode, the text.
import { test } from "node:test";
import assert from "node:assert/strict";

const qr = await import("../../../crm-app/core/qr.js");
const money = await import("../../../crm-app/modules/money/qr.js");

const REFERENCE = [
  { text: "https://www.bartawindowwashing.com/p/Zk3mQ9x7Lw", ecl: "M", mask: 2, version: 4,
    rows: ["fe18bd3f8","827922a08","baaa8fae8","bad8262e8","bac3cdae8","82b654a08","feaaaabf8","00a29e800","be4453be0","24fcdb368","db97c6ab0","e8757d6f8","535a9b1d8","b4b927658","5729c87f0","a4ed04fa0","826f43d88","00c09ff68","8b832a1b0","35af077f8","469834440","d0998da48","beca564d0","b0ac9cef8","861a52fd8","00aaf98a8","fe35cbab0","82b8798e8","ba938efd8","ba8b254a8","babfadf20","824507ea0","fee5cbd10"] },
  { text: "https://www.bartawindowwashing.com/q/Ab3dE7gH", ecl: "Q", mask: 5, version: 4,
    rows: ["fec6223f8","828326a08","ba6e2fae8","ba0aa8ae8","ba13edae8","822548208","feaaaabf8","00189a800","43b842c18","245cd10f0","f2a3c4eb0","608d7b3f0","4aa9c8318","4d10b9238","43bec86d0","606a535e8","63ee83d88","607d9be68","a7d6d3768","149f016f8","ef2d58dd0","bca999980","9ed46e5b0","aca3487f0","f242f8fc0","00a6198b8","feea09ab0","8268d18f0","ba2682fd0","ba5be9588","ba7f7e9b8","82a22a7e0","fe230bf10"] },
  { text: "Barta Window Washing, Delano MN: scan to pay 1234567890 abcdefghijklmnopqrstuvw", ecl: "Q", mask: 3, version: 7,
    rows: ["fe57da5e8bf8","82c3fc1f5208","ba9cfac412e8","ba72bad25ae8","ba165fa1fae8","820cb88b4208","feaaaaaaabf8","004fd8aa5000","76182fca5830","d44833ca9da8","7376395e3408","3d702c44e748","62a93a846058","01292ff447c0","16b4df6e4ea0","504c0978d7f8","eb99e9439978","8c61fd146490","937c6a601e70","f4e03c42d390","3f9c7ff25fe8","d8bca8fc58b8","9a843abcaaf8","48884885a8d0","4fd2bfc33f80","40207431de40","a6e9243384c0","39cac14e1770","0a79a0011628","f93ad11db998","e238ae79a430","e0f7a32c2188","2791a2782010","2468a7171808","0a13e7323798","7941c082f298","9b97bfa22f98","00ae88a598d8","fe517ab63ae0","82e078cc88e0","ba6eaff5efe8","ba9e5554e910","baa949a87810","82c5d4f46708","fe3e316d2ee0"] },
];

const hexRow = (h, size) => [...h].flatMap((c) => [3, 2, 1, 0].map((i) => ((parseInt(c, 16) >> i) & 1) === 1)).slice(0, size);

// Reads a symbol back. → { version, ecl, mask, text, blocks }
function decode(rows) {
  const size = rows.length;
  const ver = (size - 17) / 4;
  assert.ok(Number.isInteger(ver) && ver >= 1 && ver <= 40, "a symbol's side is 17 + 4 × version");
  // the format bits, read from both copies (they must agree)
  const a = [], b = [];
  for (let i = 0; i <= 5; i++) a[i] = rows[i][8];
  a[6] = rows[7][8]; a[7] = rows[8][8]; a[8] = rows[8][7];
  for (let i = 9; i < 15; i++) a[i] = rows[8][14 - i];
  for (let i = 0; i < 8; i++) b[i] = rows[8][size - 1 - i];
  for (let i = 8; i < 15; i++) b[i] = rows[size - 15 + i][8];
  const num = (bits) => bits.reduce((v, x, i) => v | ((x ? 1 : 0) << i), 0);
  assert.equal(num(a), num(b), "the two copies of the format bits agree");
  let ecl = null, mask = null;
  for (const e of qr.ECLS) for (let k = 0; k < 8; k++) if (qr.formatBits(k, e) === num(a)) { ecl = e; mask = k; }
  assert.ok(ecl, "format bits of a level and a mask");
  assert.equal(rows[size - 8][8], true, "the dark module");
  if (ver >= 7) {
    let v1 = 0, v2 = 0;
    for (let i = 0; i < 18; i++) { if (rows[Math.floor(i / 3)][size - 11 + (i % 3)]) v1 |= 1 << i; if (rows[size - 11 + (i % 3)][Math.floor(i / 3)]) v2 |= 1 << i; }
    assert.equal(v1, qr.versionBits(ver), "version bits, top right");
    assert.equal(v2, qr.versionBits(ver), "version bits, bottom left");
  }
  // timing patterns
  for (let i = 8; i < size - 8; i++) { assert.equal(rows[6][i], i % 2 === 0); assert.equal(rows[i][6], i % 2 === 0); }
  const fn = qr.functionModules(ver);
  const stream = [];
  for (let right = size - 1; right >= 1; right -= 2) {
    if (right === 6) right = 5;
    for (let vert = 0; vert < size; vert++) for (let j = 0; j < 2; j++) {
      const x = right - j, y = ((right + 1) & 2) === 0 ? size - 1 - vert : vert;
      if (!fn[y][x]) stream.push(rows[y][x] !== qr.MASKS[mask](x, y) ? 1 : 0);
    }
  }
  const raw = Math.floor(qr.rawModules(ver) / 8);
  assert.equal(stream.length >= raw * 8, true);
  const cw = [];
  for (let i = 0; i < raw * 8; i += 8) cw.push(stream.slice(i, i + 8).reduce((v, x) => (v << 1) | x, 0));
  // the blocks apart (short blocks first, each with its check bytes): the
  // split is found, not looked up, as the one whose every block divides
  // evenly by the generator (every Reed-Solomon syndrome zero)
  const data = qr.dataCodewords(ver, ecl);
  const ecc = raw - data;
  const split = (nb) => {
    const per = ecc / nb, shortLen = Math.floor(raw / nb), short = nb - (raw % nb);
    const blocks = Array.from({ length: nb }, (_, i) => ({ data: [], ecc: [], dlen: shortLen - per + (i < short ? 0 : 1) }));
    if (blocks.reduce((s, bl) => s + bl.dlen, 0) !== data) return null;
    let k = 0;
    for (let i = 0; i < shortLen - per + 1; i++) for (const bl of blocks) if (i < bl.dlen) bl.data.push(cw[k++]);
    for (let i = 0; i < per; i++) for (const bl of blocks) bl.ecc.push(cw[k++]);
    if (k !== raw) return null;
    for (const bl of blocks) {
      const all = bl.data.concat(bl.ecc);
      for (let i = 0, root = 1; i < per; i++, root = qr.gfMul(root, 2)) if (all.reduce((v, c) => qr.gfMul(v, root) ^ c, 0) !== 0) return null;
    }
    return blocks;
  };
  let blocks = null, nb = 0;
  for (let n = 1; n <= 81 && !blocks; n++) if (ecc % n === 0 && ecc / n >= 7 && ecc / n <= 30) { blocks = split(n); nb = n; }
  assert.ok(blocks, "every block's Reed-Solomon check holds");
  const bits = blocks.flatMap((bl) => bl.data).flatMap((c) => [7, 6, 5, 4, 3, 2, 1, 0].map((i) => (c >> i) & 1));
  const read = (from, n) => parseInt(bits.slice(from, from + n).join(""), 2);
  assert.equal(read(0, 4), 4, "byte mode");
  const lenBits = ver < 10 ? 8 : 16;
  const len = read(4, lenBits);
  const bytes = [];
  for (let i = 0; i < len; i++) bytes.push(read(4 + lenBits + i * 8, 8));
  return { version: ver, ecl, mask, text: new TextDecoder("utf-8", { fatal: true }).decode(new Uint8Array(bytes)), blocks: nb };
}

test("QR: the standard's tables (format bits of every level and mask, version bits, capacities, alignment centres)", () => {
  // ISO/IEC 18004 Annex C
  assert.deepEqual([0, 1, 2, 3, 4, 5, 6, 7].map((k) => qr.formatBits(k, "M").toString(2).padStart(15, "0")), ["101010000010010", "101000100100101", "101111001111100", "101101101001011", "100010111111001", "100000011001110", "100111110010111", "100101010100000"]);
  assert.deepEqual([0, 1, 2, 3, 4, 5, 6, 7].map((k) => qr.formatBits(k, "Q").toString(2).padStart(15, "0")), ["011010101011111", "011000001101000", "011111100110001", "011101000000110", "010010010110100", "010000110000011", "010111011011010", "010101111101101"]);
  assert.equal(qr.formatBits(0, "L").toString(2), "111011111000100");
  assert.equal(qr.formatBits(7, "H").toString(2).padStart(15, "0"), "000100000111011");
  assert.equal(qr.formatBits(3), qr.formatBits(3, "M"), "M unless asked");
  // Annex D
  assert.deepEqual([7, 8, 10, 20, 32, 40].map(qr.versionBits), [0x07c94, 0x085bc, 0x0a4d3, 0x149a6, 0x209d5, 0x28c69]);
  // byte-mode capacity (Table 7)
  const cap = (e) => [1, 2, 3, 4, 5, 10, 20, 40].map((v) => qr.byteCapacity(v, e));
  assert.deepEqual(cap("L"), [17, 32, 53, 78, 106, 271, 858, 2953]);
  assert.deepEqual(cap("M"), [14, 26, 42, 62, 84, 213, 666, 2331]);
  assert.deepEqual(cap("Q"), [11, 20, 32, 46, 60, 151, 482, 1663]);
  assert.deepEqual(cap("H"), [7, 14, 24, 34, 44, 119, 382, 1273]);
  assert.deepEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10].map((v) => qr.dataCodewords(v)), [16, 28, 44, 64, 86, 108, 124, 154, 182, 216]);
  // Annex E (version 32 is the one whose spacing isn't the formula's plain rounding)
  assert.deepEqual(qr.alignmentPositions(1), []);
  assert.deepEqual(qr.alignmentPositions(7), [6, 22, 38]);
  assert.deepEqual(qr.alignmentPositions(32), [6, 34, 60, 86, 112, 138]);
  assert.deepEqual(qr.alignmentPositions(40), [6, 30, 58, 86, 114, 142, 170]);
  assert.throws(() => qr.qrMatrix("x", { ecl: "X" }), RangeError);
  assert.throws(() => qr.qrMatrix("x".repeat(3000)), RangeError);
});

test("QR: the same symbols an independent encoder makes for the same text, level and mask", () => {
  for (const r of REFERENCE) {
    const q = qr.qrMatrix(r.text, { ecl: r.ecl, mask: r.mask });
    assert.equal(q.version, r.version, r.text);
    assert.deepEqual(q.rows, r.rows.map((h) => hexRow(h, q.size)), `${r.ecl}/${r.mask}: ${r.text}`);
    const d = decode(q.rows);
    assert.deepEqual([d.text, d.ecl, d.mask, d.version], [r.text, r.ecl, r.mask, r.version]);
  }
});

test("QR: every symbol reads back (pay links, sign links, long and UTF-8 text; versions 1 to 25; M and Q; every mask chosen fairly)", () => {
  const texts = [
    "https://www.bartawindowwashing.com/p/Zk3mQ9x7Lw", "https://www.bartawindowwashing.com/q/Ab3dE7gH", "pay 123", "ünïcödé ✓ pay",
    "https://www.bartawindowwashing.com/get-quote.html?utm_source=qr&utm_medium=yard_sign&utm_campaign=Ab3dE7gH", "x".repeat(150), "y".repeat(400), "z".repeat(700),
  ];
  const masks = new Set();
  for (const ecl of ["M", "Q", "L", "H"]) for (const t of texts) {
    if (new TextEncoder().encode(t).length > qr.byteCapacity(40, ecl)) continue;
    const q = qr.qrMatrix(t, { ecl });
    masks.add(q.mask);
    const d = decode(q.rows);
    assert.deepEqual([d.text, d.ecl, d.version], [t, ecl, q.version], `${ecl}: ${t.slice(0, 30)}`);
    // the smallest version that holds it
    if (q.version > 1) assert.ok(new TextEncoder().encode(t).length > qr.byteCapacity(q.version - 1, ecl));
  }
  assert.ok(masks.size >= 3, "the masks are scored, not fixed");
  // every mask of one text
  for (let k = 0; k < 8; k++) assert.equal(decode(qr.qrMatrix(texts[0], { mask: k }).rows).mask, k);
  // a pay link fits a small symbol a phone reads off another phone's screen
  assert.ok(qr.qrMatrix(texts[0]).version <= 4);
  assert.ok(qr.qrMatrix(texts[1], { ecl: "Q" }).version <= 5, "a sign's short link stays small at Q too");
  assert.equal(qr.qrMatrix("x", { minVersion: 6 }).version, 6, "a bigger symbol on request");
  // the reader is a real check: one data module flipped and it refuses the symbol
  const bad = qr.qrMatrix(texts[0]);
  const fn = qr.functionModules(bad.version);
  const [fx, fy] = [bad.size - 1, bad.size - 1];
  assert.equal(fn[fy][fx], false);
  bad.rows[fy][fx] = !bad.rows[fy][fx];
  assert.throws(() => decode(bad.rows), /Reed-Solomon/);
});

test("QR: the SVG is black on white with its quiet zone, and words can't break out of it", () => {
  const svg = qr.qrSvg("https://example.com/p/abc", { label: 'Scan "to" <pay>' });
  assert.match(svg, /^<svg [^>]*viewBox="0 0 33 33"/, "25 modules and a four-module quiet zone on every side");
  assert.match(svg, /<rect width="33" height="33" fill="#fff"\/>/);
  assert.match(svg, /fill="#000"/);
  assert.doesNotMatch(svg, /<pay>|"to"/);
  const poster = qr.qrPosterSvg("https://www.bartawindowwashing.com/q/Ab3dE7gH", { width: 1800, height: 2400, lines: [{ text: "Yard sign, Maple Grove <b>", size: 0.05, bold: true }, { text: "bartawindowwashing.com/q/Ab3dE7gH", size: 0.035 }, { text: "" }] });
  assert.match(poster, /^<svg [^>]*viewBox="0 0 1800 2400"/);
  assert.match(poster, /Yard sign, Maple Grove &lt;b&gt;<\/text>/);
  assert.equal((poster.match(/<text /g) || []).length, 2, "an empty line is left out");
  assert.doesNotMatch(poster, /<b>/);
  // the money screens' old import path is the same encoder
  assert.equal(money.qrSvg, qr.qrSvg);
});
