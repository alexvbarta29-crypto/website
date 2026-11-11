// The customer's account page (design §8.1 /p/hub): an open quote opens
// through a fresh one-day link (POST /api/portal/hub/open answers where to
// go). Everything else on the page is plain links.

import { portalPost } from "./core.js";

function start() {
  document.addEventListener("click", async (e) => {
    const b = e.target.closest && e.target.closest("[data-open-kind]");
    if (!b) return;
    e.preventDefault();
    const box = document.querySelector("[data-open-error]");
    if (box) box.hidden = true;
    b.disabled = true;
    try {
      const r = await portalPost("/api/portal/hub/open", { kind: b.getAttribute("data-open-kind"), id: b.getAttribute("data-open-id") });
      const to = r.data && r.data.location;
      if (typeof to === "string" && to.startsWith("/p/")) { location.assign(to); return; }
      throw new Error("That didn't open. Try again, or call us.");
    } catch (err) {
      b.disabled = false;
      if (box) { box.textContent = err.message; box.hidden = false; }
    }
  });
}

if (typeof document !== "undefined") {
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", start);
  else start();
}
