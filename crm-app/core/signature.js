// Barta CRM client: a signature pad (design §2.3 signature.js, §8.5: the
// approve and sign endpoints take signature_png_b64, at most 200 KB).
// Pointer events (finger, pen, mouse), drawn at the screen's pixel ratio,
// smoothed with quadratic curves; the page never scrolls while signing.
// Used by the portal's page scripts and by "Present to customer".
//
//   const pad = signaturePad(canvas, { onChange: (empty) => ... });
//   pad.isEmpty(); pad.clear(); pad.toBase64(); pad.destroy();

export const MAX_PNG_BYTES = 200 * 1024;

export function signaturePad(canvas, { onChange, color = "#16161b", width = 2.4 } = {}) {
  const g = canvas.getContext("2d");
  let strokes = [];
  let current = null;
  const ratio = () => Math.max(1, Math.min(3, window.devicePixelRatio || 1));

  function size() {
    const r = canvas.getBoundingClientRect();
    const k = ratio();
    canvas.width = Math.max(1, Math.round(r.width * k));
    canvas.height = Math.max(1, Math.round(r.height * k));
    redraw();
  }
  function line(points) {
    const k = ratio();
    g.lineWidth = width * k;
    g.lineCap = "round";
    g.lineJoin = "round";
    g.strokeStyle = color;
    g.beginPath();
    if (points.length === 1) { g.arc(points[0].x * k, points[0].y * k, (width * k) / 2, 0, Math.PI * 2); g.fillStyle = color; g.fill(); return; }
    g.moveTo(points[0].x * k, points[0].y * k);
    for (let i = 1; i < points.length - 1; i++) {
      const mx = (points[i].x + points[i + 1].x) / 2;
      const my = (points[i].y + points[i + 1].y) / 2;
      g.quadraticCurveTo(points[i].x * k, points[i].y * k, mx * k, my * k);
    }
    const last = points[points.length - 1];
    g.lineTo(last.x * k, last.y * k);
    g.stroke();
  }
  function redraw() {
    g.clearRect(0, 0, canvas.width, canvas.height);
    for (const s of strokes) line(s);
  }
  const at = (e) => { const r = canvas.getBoundingClientRect(); return { x: e.clientX - r.left, y: e.clientY - r.top }; };
  const changed = () => { if (onChange) onChange(strokes.length === 0); };

  function down(e) {
    e.preventDefault();
    canvas.setPointerCapture && canvas.setPointerCapture(e.pointerId);
    current = [at(e)];
    strokes.push(current);
    redraw();
  }
  function move(e) {
    if (!current) return;
    e.preventDefault();
    current.push(at(e));
    redraw();
  }
  function up() {
    if (!current) return;
    current = null;
    changed();
  }

  canvas.style.touchAction = "none";
  canvas.addEventListener("pointerdown", down);
  canvas.addEventListener("pointermove", move);
  canvas.addEventListener("pointerup", up);
  canvas.addEventListener("pointercancel", up);
  canvas.addEventListener("pointerleave", up);
  window.addEventListener("resize", size);
  size();

  return {
    isEmpty: () => strokes.length === 0,
    clear() { strokes = []; redraw(); changed(); },
    // A PNG on white, as the APIs take it (base64 without the data: prefix).
    toBase64() {
      const out = document.createElement("canvas");
      out.width = canvas.width;
      out.height = canvas.height;
      const o = out.getContext("2d");
      o.fillStyle = "#ffffff";
      o.fillRect(0, 0, out.width, out.height);
      o.drawImage(canvas, 0, 0);
      const b64 = out.toDataURL("image/png").split(",")[1] || "";
      if (b64.length * 0.75 > MAX_PNG_BYTES) throw new Error("That signature is too big. Clear it and sign again.");
      return b64;
    },
    destroy() {
      canvas.removeEventListener("pointerdown", down);
      canvas.removeEventListener("pointermove", move);
      canvas.removeEventListener("pointerup", up);
      canvas.removeEventListener("pointercancel", up);
      canvas.removeEventListener("pointerleave", up);
      window.removeEventListener("resize", size);
    },
  };
}
