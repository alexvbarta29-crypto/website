// The practice Checkout (/p/dry-checkout/{session}, design §13 D2 and the
// owner's Stripe rules): stands in for Stripe's page while payments are in
// dry run. Each button tells the server what "happened" (paid by test card,
// paid by bank, declined, cancelled); nothing is charged and no card is
// asked for. The server only has this page while payments are in dry run.

import { portalPost } from "./core.js";

function start() {
  const box = document.querySelector("[data-dry]");
  if (!box) return;
  const sid = box.getAttribute("data-dry");
  const err = document.querySelector("[data-error]");
  const buttons = [...box.querySelectorAll("[data-dry-act]")];
  for (const btn of buttons) {
    btn.addEventListener("click", async () => {
      if (err) err.hidden = true;
      buttons.forEach((b) => { b.disabled = true; });
      try {
        const r = await portalPost(`/api/portal/dry-checkout/${encodeURIComponent(sid)}`, { action: btn.getAttribute("data-dry-act"), method: btn.getAttribute("data-method") || "card" });
        const to = r.data && r.data.location;
        if (typeof to === "string" && to.startsWith("/p/")) { location.assign(to); return; }
        throw new Error("That didn't work. Try again.");
      } catch (e) {
        buttons.forEach((b) => { b.disabled = false; });
        if (err) { err.textContent = e.message; err.hidden = false; }
      }
    });
  }
}

if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", start);
else start();
