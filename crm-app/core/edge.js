// Barta CRM client: the left-edge swipe (design §2.4). Home-screen apps on
// iOS have no edge-swipe back, so a touch that starts within 20 px of the
// left edge and moves more than 60 px to the right (and mostly sideways)
// calls the router's back(), the same as the back arrow.

export const EDGE_PX = 20;
export const MIN_DX = 60;

export function edgeSwipe(onBack, root = document) {
  let x0 = null, y0 = 0, fired = false;
  const start = (e) => {
    const t = e.touches && e.touches[0];
    if (!t || e.touches.length !== 1) { x0 = null; return; }
    if (t.clientX > EDGE_PX) { x0 = null; return; }
    x0 = t.clientX; y0 = t.clientY; fired = false;
  };
  const move = (e) => {
    if (x0 === null || fired) return;
    const t = e.touches[0];
    const dx = t.clientX - x0, dy = Math.abs(t.clientY - y0);
    if (dx > MIN_DX && dx > dy * 1.5) { fired = true; x0 = null; onBack(); }
  };
  const end = () => { x0 = null; };
  root.addEventListener("touchstart", start, { passive: true });
  root.addEventListener("touchmove", move, { passive: true });
  root.addEventListener("touchend", end, { passive: true });
  root.addEventListener("touchcancel", end, { passive: true });
  return () => {
    root.removeEventListener("touchstart", start);
    root.removeEventListener("touchmove", move);
    root.removeEventListener("touchend", end);
    root.removeEventListener("touchcancel", end);
  };
}
