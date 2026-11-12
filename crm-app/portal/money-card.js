// The customer's "card on file" page (design §8.1 /p/card): one button that
// goes to the hosted page where they enter the card (Stripe's, or the
// practice stand-in while payments are in dry run). We never see the number.

import { portalPost } from "./core.js";

function start() {
  const box = document.querySelector("[data-card]");
  if (!box) return;
  const btn = box.querySelector("[data-card-btn]");
  const err = document.querySelector("[data-error]");
  if (!btn) return;
  btn.addEventListener("click", async () => {
    if (err) err.hidden = true;
    btn.disabled = true;
    const was = btn.textContent;
    btn.textContent = "One moment…";
    try {
      const r = await portalPost("/api/portal/card/checkout", {});
      const url = r.data && r.data.url;
      if (typeof url === "string" && (url.startsWith("https://checkout.stripe.com/") || url.startsWith("/p/dry-checkout/"))) { location.assign(url); return; }
      throw new Error("That didn't work. Try again, or call us.");
    } catch (e) {
      btn.disabled = false;
      btn.textContent = was;
      if (err) { err.textContent = e.message; err.hidden = false; }
    }
  });
}

if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", start);
else start();
