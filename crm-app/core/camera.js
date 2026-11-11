// Barta CRM client: photos (design §3.11, §2.3 camera.js). Take or pick a
// photo, shrink it on the phone (longest side 2048 px, JPEG quality 0.82,
// plus a 400 px thumbnail), then upload the bytes to POST /api/crm/files
// and the thumbnail to POST /api/crm/files/:id/thumb. The server checks the
// type by its magic bytes, never by what the phone says.
//
// A photo keeps its EXIF, the location included (the owner's rule: never
// strip GPS or EXIF): a JPEG already small enough goes up byte for byte,
// and a shrunk one gets the original's EXIF and XMP segments back (APP1),
// with the orientation set to upright because the pixels are drawn upright.
// Only the thumbnail carries none.
//
//   const file = await capture();                         // the camera or the library
//   const p = await prepare(file);                         // { full, thumb, width, height }
//   const out = await uploadPhoto({ ownerType: "visit", ownerId, kind: "photo", tag: "before", file });

import { APP_VERSION } from "../version.js";
import { uuid } from "./api.js";

export const MAX_SIDE = 2048;
export const QUALITY = 0.82;
export const THUMB_SIDE = 400;
export const MAX_BYTES = 4000000;

// Opens the camera (or the photo library) and resolves with the chosen file, or null.
export function capture({ accept = "image/*", camera = true } = {}) {
  return new Promise((resolve) => {
    const input = document.createElement("input");
    input.type = "file";
    input.accept = accept;
    if (camera) input.setAttribute("capture", "environment");
    input.style.position = "fixed";
    input.style.left = "-1000px";
    let done = false;
    const finish = (v) => { if (done) return; done = true; input.remove(); resolve(v); };
    input.addEventListener("change", () => finish((input.files && input.files[0]) || null));
    window.addEventListener("focus", () => setTimeout(() => { if (!input.files || !input.files.length) finish(null); }, 800), { once: true });
    document.body.appendChild(input);
    input.click();
  });
}

async function bitmapOf(file) {
  if (typeof createImageBitmap === "function") {
    try { return await createImageBitmap(file, { imageOrientation: "from-image" }); } catch (e) { /* fall back to <img> */ }
  }
  const url = URL.createObjectURL(file);
  try {
    const img = new Image();
    img.decoding = "async";
    img.src = url;
    await img.decode();
    return img;
  } finally {
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }
}

async function encode(bmp, side, quality) {
  const w = bmp.width || bmp.naturalWidth;
  const h = bmp.height || bmp.naturalHeight;
  const k = Math.min(1, side / Math.max(w, h));
  const canvas = document.createElement("canvas");
  canvas.width = Math.max(1, Math.round(w * k));
  canvas.height = Math.max(1, Math.round(h * k));
  const g = canvas.getContext("2d");
  g.imageSmoothingQuality = "high";
  g.drawImage(bmp, 0, 0, canvas.width, canvas.height);
  const blob = await new Promise((r) => canvas.toBlob(r, "image/jpeg", quality));
  if (!blob) throw new Error("This phone couldn't prepare the photo.");
  return blob;
}

// A JPEG no larger than `side` on its longest edge, with the original's
// EXIF kept (a JPEG original). → Blob
export async function downscale(file, { side = MAX_SIDE, quality = QUALITY, exif = true } = {}) {
  const bmp = await bitmapOf(file);
  try {
    const out = await encode(bmp, side, quality);
    if (!exif) return out;
    return new Blob([keepExif(new Uint8Array(await file.arrayBuffer()), new Uint8Array(await out.arrayBuffer()))], { type: "image/jpeg" });
  } finally {
    if (bmp.close) bmp.close();
  }
}

// What goes up for a photo: the full picture (EXIF kept) and a 400 px
// thumbnail. A JPEG that is already no larger than `side` and `maxBytes`
// goes up untouched. → { full: Blob, thumb: Blob, width, height, untouched }
export async function prepare(file, { side = MAX_SIDE, quality = QUALITY, maxBytes = MAX_BYTES } = {}) {
  if (!file) throw new Error("Pick a photo first.");
  const bmp = await bitmapOf(file);
  try {
    const width = bmp.width || bmp.naturalWidth;
    const height = bmp.height || bmp.naturalHeight;
    const original = new Uint8Array(await file.arrayBuffer());
    const isJpeg = original[0] === 0xff && original[1] === 0xd8;
    let full;
    let untouched = false;
    if (isJpeg && Math.max(width, height) <= side && original.length <= maxBytes) {
      full = new Blob([original], { type: "image/jpeg" });
      untouched = true;
    } else {
      for (const [s, q] of [[side, quality], [Math.round(side * 0.8), 0.75], [Math.round(side * 0.6), 0.7]]) {
        const out = await encode(bmp, s, q);
        full = new Blob([keepExif(original, new Uint8Array(await out.arrayBuffer()))], { type: "image/jpeg" });
        if (full.size <= maxBytes) break;
      }
      if (full.size > maxBytes) throw new Error("That photo is too big to send.");
    }
    const thumb = await encode(bmp, THUMB_SIDE, 0.75);
    return { full, thumb, width, height, untouched };
  } finally {
    if (bmp.close) bmp.close();
  }
}

// ------------------------------------------------------------ EXIF (pure; tested in node)

// The JPEG's segments before its image data: [{ marker, start, end }]
// (start at the 0xFF, end past the segment), or [] when it isn't a JPEG.
export function jpegSegments(b) {
  const out = [];
  if (!(b && b.length > 4 && b[0] === 0xff && b[1] === 0xd8)) return out;
  let i = 2;
  while (i + 4 <= b.length) {
    if (b[i] !== 0xff) break;
    const marker = b[i + 1];
    if (marker === 0xd8 || (marker >= 0xd0 && marker <= 0xd7) || marker === 0x01) { i += 2; continue; }
    if (marker === 0xd9 || marker === 0xda) break;             // end, or the image data begins
    const len = (b[i + 2] << 8) | b[i + 3];
    if (len < 2 || i + 2 + len > b.length) break;
    out.push({ marker, start: i, end: i + 2 + len });
    i += 2 + len;
  }
  return out;
}

const ascii = (b, from, n) => String.fromCharCode(...b.subarray(from, from + n));

// The Orientation tag (0x0112) of an Exif APP1 segment set to 1 (upright),
// in a copy. → Uint8Array
export function uprightExif(seg) {
  const b = new Uint8Array(seg);
  if (b.length < 18 || ascii(b, 4, 6) !== "Exif\0\0") return b;
  const tiff = 10;
  const le = ascii(b, tiff, 2) === "II";
  const u16 = (o) => (le ? b[o] | (b[o + 1] << 8) : (b[o] << 8) | b[o + 1]);
  const u32 = (o) => (le ? (b[o] | (b[o + 1] << 8) | (b[o + 2] << 16) | (b[o + 3] << 24)) >>> 0 : ((b[o] << 24) | (b[o + 1] << 16) | (b[o + 2] << 8) | b[o + 3]) >>> 0);
  const ifd = tiff + u32(tiff + 4);
  if (ifd + 2 > b.length) return b;
  const n = u16(ifd);
  for (let k = 0; k < n; k++) {
    const e = ifd + 2 + k * 12;
    if (e + 12 > b.length) break;
    if (u16(e) === 0x0112) {
      if (le) { b[e + 8] = 1; b[e + 9] = 0; } else { b[e + 8] = 0; b[e + 9] = 1; }
      break;
    }
  }
  return b;
}

// The encoded JPEG with the original's APP1 segments (Exif, with an upright
// orientation, and XMP) put back after its SOI and JFIF header. A non-JPEG
// original, or one without them, leaves the encoded bytes as they are.
// → Uint8Array
export function keepExif(original, encoded) {
  const app1 = jpegSegments(original).filter((s) => s.marker === 0xe1).map((s) => {
    const seg = original.subarray(s.start, s.end);
    return ascii(seg, 4, 6) === "Exif\0\0" ? uprightExif(seg) : new Uint8Array(seg);
  });
  const segs = jpegSegments(encoded);
  if (!app1.length || !(encoded[0] === 0xff && encoded[1] === 0xd8)) return encoded;
  const drop = new Set(segs.filter((s) => s.marker === 0xe1).map((s) => s.start));     // the encoder's own, if any
  const at = segs.length && segs[0].marker === 0xe0 ? segs[0].end : 2;
  const parts = [encoded.subarray(0, at), ...app1];
  let i = at;
  for (const s of segs.filter((x) => x.start >= at)) {
    if (drop.has(s.start)) { parts.push(encoded.subarray(i, s.start)); i = s.end; }
  }
  parts.push(encoded.subarray(i));
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let o = 0;
  for (const p of parts) { out.set(p, o); o += p.length; }
  return out;
}

async function postBytes(path, blob, type = "image/jpeg") {
  const res = await fetch("/api/crm" + path, {
    method: "POST", credentials: "same-origin",
    headers: { "X-CRM": "1", "X-CRM-Client": APP_VERSION, "Content-Type": type, "Idempotency-Key": uuid() },
    body: blob,
  });
  let body = null;
  try { body = await res.json(); } catch (e) { body = null; }
  if (!res.ok || !body || !body.ok) {
    const err = new Error((body && body.error && body.error.message) || "The photo didn't upload. Try again.");
    err.status = res.status;
    throw err;
  }
  return body.data;
}

// Shrinks (EXIF kept), uploads, then adds the thumbnail. → { file }
export async function uploadPhoto({ ownerType, ownerId, kind = "photo", tag, caption, file } = {}) {
  if (!file) throw new Error("Pick a photo first.");
  const pdf = file.type === "application/pdf";
  const p = pdf ? { full: file, thumb: null } : await prepare(file);
  if (p.full.size > MAX_BYTES) throw new Error("That file is too big (4 MB at most).");
  const q = new URLSearchParams({ owner_type: ownerType, owner_id: ownerId, kind });
  if (tag) q.set("tag", tag);
  if (caption) q.set("caption", caption);
  const out = await postBytes(`/files?${q}`, p.full, pdf ? "application/pdf" : "image/jpeg");
  if (p.thumb && out && out.file && out.file.id) {
    try { await postBytes(`/files/${encodeURIComponent(out.file.id)}/thumb`, p.thumb); } catch (e) { /* the full photo is what matters */ }
  }
  return out;
}
