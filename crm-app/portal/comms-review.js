// The customer's star page (/p/review/:id; in-app ratings, the Rotor
// guide's S27): tap 1 to 5 stars, add words if they like, Send. Then a
// thank-you, and the Google link at every rating by default (Google's rules
// don't allow asking only happy customers); a tap on it is recorded. A low
// rating also says the owners will call (the guarantee is a free re-clean).

import { portalPost } from "./core.js";

function start() {
  const box = document.querySelector("[data-review]");
  if (!box) return;
  const id = box.getAttribute("data-id");
  const form = box.querySelector("[data-review-f]");
  const err = box.querySelector("[data-error]");
  const thanks = box.querySelector("[data-thanks]");
  const paint = () => {
    const picked = Number((form.querySelector("input[name=stars]:checked") || {}).value || 0);
    for (const l of box.querySelectorAll(".rv-star")) l.classList.toggle("on", Number(l.querySelector("input").value) <= picked);
  };
  form.addEventListener("change", paint);
  paint();
  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    const stars = Number((form.querySelector("input[name=stars]:checked") || {}).value || 0);
    if (err) err.hidden = true;
    if (!stars) { if (err) { err.textContent = "Tap the stars first."; err.hidden = false; } return; }
    const btn = form.querySelector("button[type=submit]");
    btn.disabled = true;
    try {
      const r = await portalPost(`/api/portal/review/${encodeURIComponent(id)}`, { stars, comment: form.querySelector("[name=comment]").value });
      const d = r.data || {};
      thanks.hidden = false;
      thanks.querySelector("[data-low]").hidden = !d.low;
      thanks.querySelector("[data-public]").hidden = !d.show_google;
      form.hidden = true;
    } catch (ex) {
      if (err) { err.textContent = ex.message; err.hidden = false; }
    } finally { btn.disabled = false; }
  });
  const g = box.querySelector("[data-google]");
  if (g) g.addEventListener("click", () => { portalPost(`/api/portal/review/${encodeURIComponent(id)}/clicked`, {}).catch(() => {}); });
}

if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", start); else start();
