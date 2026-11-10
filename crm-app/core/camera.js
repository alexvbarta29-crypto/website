// Barta CRM client: photos (design §3.11, §2.3 camera.js). Take or pick a
// photo, shrink it on the phone (longest side 2048 px, JPEG quality 0.82,
// plus a 400 px thumbnail), then upload the bytes to POST /api/crm/files
// and the thumbnail to POST /api/crm/files/:id/thumb. The server checks the
// type by its magic bytes, never by what the phone says.
//
//   const file = await capture();                         // the camera or the library
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

// A JPEG no larger than `side` on its longest edge. → Blob
export async function downscale(file, { side = MAX_SIDE, quality = QUALITY } = {}) {
  const bmp = await bitmapOf(file);
  const w = bmp.width || bmp.naturalWidth;
  const h = bmp.height || bmp.naturalHeight;
  const k = Math.min(1, side / Math.max(w, h));
  const canvas = document.createElement("canvas");
  canvas.width = Math.max(1, Math.round(w * k));
  canvas.height = Math.max(1, Math.round(h * k));
  const g = canvas.getContext("2d");
  g.imageSmoothingQuality = "high";
  g.drawImage(bmp, 0, 0, canvas.width, canvas.height);
  if (bmp.close) bmp.close();
  const blob = await new Promise((r) => canvas.toBlob(r, "image/jpeg", quality));
  if (!blob) throw new Error("This phone couldn't prepare the photo.");
  return blob;
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

// Shrinks, uploads, then adds the thumbnail. → { file }
export async function uploadPhoto({ ownerType, ownerId, kind = "photo", tag, caption, file } = {}) {
  if (!file) throw new Error("Pick a photo first.");
  const full = file.type === "application/pdf" ? file : await downscale(file);
  if (full.size > MAX_BYTES) throw new Error("That file is too big (4 MB at most).");
  const q = new URLSearchParams({ owner_type: ownerType, owner_id: ownerId, kind });
  if (tag) q.set("tag", tag);
  if (caption) q.set("caption", caption);
  const out = await postBytes(`/files?${q}`, full, file.type === "application/pdf" ? "application/pdf" : "image/jpeg");
  if (file.type !== "application/pdf" && out && out.file && out.file.id) {
    try { await postBytes(`/files/${encodeURIComponent(out.file.id)}/thumb`, await downscale(file, { side: THUMB_SIDE, quality: 0.75 })); } catch (e) { /* the full photo is what matters */ }
  }
  return out;
}
