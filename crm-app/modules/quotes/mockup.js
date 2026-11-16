// The automatic lights mockup (the owner, Nov 16: "say you do a Christmas
// lights quote and you hit Mockup, have that mockup just generate an
// automatic mockup of the person's house"). Mockup on New Quote (lights
// work) and on a lights quote opens this sheet and does it all:
//
//   1. the house from the street (POST /lights-mockup/photo: Street View
//      aimed at the property, cached on the server),
//   2. the rooflines (POST /lights-mockup/lines: Claude's vision model marks
//      the eaves, gutter lines and gable edges; only the photo goes to it),
//      else the app's own edge finder (bulbs.js detectRoofline),
//   3. C9 bulbs drawn along them with a glow and a dusk look (bulbs.js,
//      Light Studio's drawing).
//
// Then: Regenerate, the bulb colors (warm white, pure white, multicolor) and
// sizes, Edit in Light Studio (the photo and the lines carried over, so the
// owner adjusts them), Save to the quote (a mockup photo the customer sees on
// the quote) and Share / download.

import { html, attrs, icon, sheet, toast } from "../../core/ui.js";
import { busy } from "../../core/forms.js";
import { uploadPhoto } from "../../core/camera.js";
import { saveFile } from "../../core/qr.js";
import { PALETTES, SIZES, renderMockup, detectRoofline, toGray } from "./bulbs.js";

export const PRELOAD_KEY = "bls-preload";
const SCALE = 2;                      // the 640 px Street View photo drawn at 1280 px, so the bulbs stay sharp

const WHY = {
  streetview_off: "Street View isn't switched on yet (the Google key). Open Light Studio and paste a photo of the house instead.",
  no_address: "This property has no street address yet. Add it, or paste a photo in Light Studio.",
  not_found: "Google couldn't find that address. Check it, or paste a photo in Light Studio.",
  no_imagery: "Street View has no picture of this house. Paste a photo in Light Studio instead.",
  google_error: "Street View didn't answer. Try again in a minute.",
};
const LINES_WHY = {
  no_key: "Drawn by the app's edge finder (Claude isn't switched on yet). Check the lines.",
  daily_limit: "Drawn by the app's edge finder (today's Claude mockups are used up). Check the lines.",
  timeout: "Drawn by the app's edge finder (Claude took too long). Check the lines or Regenerate.",
  busy: "Drawn by the app's edge finder (Claude was busy). Check the lines or Regenerate.",
};

function loadImage(src) {
  return new Promise((ok, no) => {
    const img = new Image();
    img.decoding = "async";
    img.onload = () => ok(img);
    img.onerror = () => no(new Error("The house photo didn't load."));
    img.src = src;
  });
}

// The edge finder on a 320 px copy, its points scaled back to the photo.
export function fallbackLines(img, w, h) {
  const k = Math.min(1, 320 / w);
  const sw = Math.max(32, Math.round(w * k)), sh = Math.max(32, Math.round(h * k));
  const c = document.createElement("canvas");
  c.width = sw; c.height = sh;
  const x = c.getContext("2d", { willReadFrequently: true });
  x.drawImage(img, 0, 0, sw, sh);
  const got = detectRoofline(toGray(x.getImageData(0, 0, sw, sh).data, sw, sh), sw, sh);
  if (!got) return null;
  return got.lines.map((l) => ({ ...l, points: l.points.map((p) => [Math.round((p[0] / k) * 10) / 10, Math.round((p[1] / k) * 10) / 10]) }));
}

const canvasBlob = (c, type = "image/jpeg", q = 0.9) => new Promise((ok, no) => c.toBlob((b) => (b ? ok(b) : no(new Error("The picture couldn't be made."))), type, q));

// Light Studio (an office tool in a frame on the same origin) reads this
// once when it opens: the photo as a data URL and the lines in its pixels.
export function preloadLightStudio({ img, w, h, lines, palette, size }) {
  const c = document.createElement("canvas");
  c.width = w; c.height = h;
  c.getContext("2d").drawImage(img, 0, 0, w, h);
  const data = { v: 1, photo: c.toDataURL("image/jpeg", 0.92), w, h, lines: lines || [], palette, size };
  try { sessionStorage.setItem(PRELOAD_KEY, JSON.stringify(data)); return true; } catch (e) { return false; }
}

// opts: { propertyId, quoteId (null on New Quote), name (for the file),
// studio (false: no Edit in Light Studio, an office tool), onSave(file) when
// there is no quote yet (New Quote keeps it to upload after Create), onSaved() }
export function openMockup(ctx, opts = {}) {
  if (!opts.propertyId) { toast("Add the customer's address first: the mockup is of their house.", { bad: true }); return null; }
  const st = { stage: "photo", photo: null, img: null, lines: [], source: "", note: "", palette: "warm", size: "m", reason: "", saved: false, busy: false };
  const body = () => html`<div class="qt-mk">
    <div class="qt-mk-fig" ${attrs({ "data-mk-stage": st.stage, "aria-busy": st.stage === "photo" || st.stage === "lines" ? "true" : "false" })}>
      <canvas data-mk-canvas ${attrs({ hidden: st.stage !== "done", role: "img", "aria-label": "The house with Christmas lights" })}></canvas>
      ${st.stage === "photo" || st.stage === "lines" ? html`<div class="qt-mk-wait"><span class="qt-mk-spin" aria-hidden="true"></span><span>${st.stage === "photo" ? "Getting the house from Street View…" : "Finding the roofline…"}</span></div>` : ""}
      ${st.stage === "failed" ? html`<div class="qt-mk-wait"><span>${st.reason}</span></div>` : ""}
    </div>
    ${st.stage === "done" ? html`<p class="small muted qt-mk-note" data-mk-note>${st.note}</p>
      <div class="qb-seg qt-mk-seg" role="group" aria-label="Bulb color">${PALETTES.map((p) => html`<button type="button" ${attrs({ "data-mk-color": p.id, "aria-pressed": String(st.palette === p.id) })}>${p.name}</button>`)}</div>
      <div class="qb-seg qt-mk-seg" role="group" aria-label="Bulb size">${SIZES.map((z) => html`<button type="button" ${attrs({ "data-mk-size": z.id, "aria-pressed": String(st.size === z.id) })}>${z.name}</button>`)}</div>` : ""}
    <div class="qt-mk-acts">
      ${st.stage === "done" ? html`<button type="button" class="btn primary" data-mk-save ${attrs({ disabled: st.saved })}>${icon("check")}${st.saved ? "Saved" : opts.quoteId ? "Save to the quote" : "Add to the quote"}</button>` : ""}
      ${st.stage === "done" || st.stage === "failed" ? html`<button type="button" class="btn" data-mk-regen>${icon("undo")}Regenerate</button>` : ""}
      ${st.stage !== "photo" && st.stage !== "lines" && opts.studio !== false ? html`<button type="button" class="btn" data-mk-studio>${icon("bulb")}Edit in Light Studio</button>` : ""}
      ${st.stage === "done" ? html`<button type="button" class="btn" data-mk-share>${icon("share")}Share</button>` : ""}
    </div>
  </div>`;
  const s = sheet({
    title: "Lights mockup", className: "qt-mk-sheet", body: body(),
    events: {
      "click [data-mk-color]": (e, el) => { st.palette = el.dataset.mkColor; st.saved = false; draw(); },
      "click [data-mk-size]": (e, el) => { st.size = el.dataset.mkSize; st.saved = false; draw(); },
      "click [data-mk-regen]": () => run(true),
      "click [data-mk-studio]": () => studio(),
      "click [data-mk-save]": (e, el) => save(el),
      "click [data-mk-share]": (e, el) => share(el),
    },
  });
  const canvas = () => s.el.querySelector("[data-mk-canvas]");
  function paint() {
    const c = canvas();
    if (!c || !st.img) return;
    c.width = st.photo.w * SCALE; c.height = st.photo.h * SCALE;
    const k = (SIZES.find((z) => z.id === st.size) || SIZES[1]).k;
    st.bulbs = renderMockup(c, { photo: st.img, w: st.photo.w, h: st.photo.h, lines: st.lines, size: k, palette: st.palette, night: 0.6 });
    c.dataset.bulbs = String(st.bulbs);
  }
  function draw() { s.set(body()); if (st.stage === "done") paint(); }

  async function run(again = false) {
    if (st.busy) return;
    st.busy = true;
    try {
      if (!st.img || again) {
        st.stage = "photo"; draw();
        const r = await ctx.api("/lights-mockup/photo", { method: "POST", body: { property_id: opts.propertyId }, timeout: 12000 });
        if (!r.data.photo) { st.stage = "failed"; st.reason = WHY[r.data.reason] || WHY.google_error; draw(); return; }
        st.photo = r.data.photo;
        st.img = await loadImage(st.photo.url);
      }
      st.stage = "lines"; draw();
      let got = null;
      try { got = (await ctx.api("/lights-mockup/lines", { method: "POST", body: { property_id: opts.propertyId, regenerate: again }, timeout: 15000 })).data; } catch (err) { got = { source: "none", reason: err.status === 429 ? "busy" : "timeout", lines: [] }; }
      if (got.source === "claude" && got.lines.length) {
        st.lines = got.lines; st.source = "claude"; st.note = "Lines marked by Claude from the Street View photo. Edit in Light Studio to fine-tune.";
      } else {
        const lines = fallbackLines(st.img, st.photo.w, st.photo.h);
        if (!lines) {
          st.lines = []; st.stage = "failed";
          st.reason = "The roofline couldn't be found on its own. Edit in Light Studio: the photo is ready there to draw the lines.";
          draw(); return;
        }
        st.lines = lines; st.source = "edges"; st.note = LINES_WHY[got.reason] || "Drawn by the app's edge finder. Check the lines, or Edit in Light Studio.";
      }
      st.stage = "done"; st.saved = false;
      draw();
    } catch (err) {
      st.stage = "failed"; st.reason = err.message || "That didn't work. Try again."; draw();
    } finally { st.busy = false; }
  }

  function studio() {
    if (st.img) preloadLightStudio({ img: st.img, w: st.photo.w, h: st.photo.h, lines: st.lines, palette: st.palette, size: (SIZES.find((z) => z.id === st.size) || SIZES[1]).k });
    s.close();
    ctx.go("/tools/lights");
  }

  const fileName = () => `${String(opts.name || "house").replace(/[^A-Za-z0-9 -]+/g, "").trim().replace(/\s+/g, "-").slice(0, 40) || "house"}-lights-mockup.jpg`;
  async function save(el) {
    const c = canvas();
    if (!c) return;
    busy(el, true, "Saving…");
    try {
      const blob = await canvasBlob(c);
      const file = new File([blob], fileName(), { type: "image/jpeg" });
      if (opts.quoteId) await uploadPhoto({ ownerType: "quote", ownerId: opts.quoteId, kind: "mockup", file, caption: "Christmas lights mockup" });
      else if (opts.onSave) opts.onSave(file);
      st.saved = true;
      toast(opts.quoteId ? "Mockup saved to the quote" : "Mockup added: it goes on the quote when you create it");
      draw();
      if (opts.onSaved) opts.onSaved();
    } catch (err) { busy(el, false); toast(err.message, { bad: true }); }
  }
  async function share(el) {
    const c = canvas();
    if (!c) return;
    busy(el, true);
    try { await saveFile(fileName(), await canvasBlob(c), { share: true, title: "Christmas lights mockup" }); } catch (err) { toast(err.message, { bad: true }); }
    busy(el, false);
  }

  run(false);
  return { sheet: s, state: st };
}
