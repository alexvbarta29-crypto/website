// "Text me a link" (design §8.1 /p/login): the customer enters their
// mobile number and, if it's on file, gets a text with a link to their
// account. The answer is the same either way, so the page never tells
// anyone whether a number is a customer's.

import { portalPost } from "./core.js";

const $ = (sel, root = document) => root.querySelector(sel);

function start() {
  const box = $("[data-login]");
  if (!box) return;
  const input = $("input[name=phone]", box);
  const btn = $("[data-login-send]", box);
  const err = $("[data-error]", box);
  const done = $("[data-done]", box);
  const say = (msg) => { if (err) { err.textContent = msg; err.hidden = !msg; } };
  async function send() {
    say("");
    const digits = String((input && input.value) || "").replace(/\D/g, "");
    if (digits.length < 10) { say("Enter your 10-digit mobile number."); return; }
    btn.disabled = true;
    try {
      const r = await portalPost("/api/portal/login", { phone: input.value });
      if (done) { done.textContent = (r.data && r.data.message) || "If that number is on file, we texted you a link."; done.hidden = false; }
      btn.hidden = true;
      if (input) input.disabled = true;
    } catch (e) {
      btn.disabled = false;
      say(e.message);
    }
  }
  if (btn) btn.addEventListener("click", send);
  if (input) input.addEventListener("keydown", (e) => { if (e.key === "Enter") { e.preventDefault(); send(); } });
}

if (typeof document !== "undefined") {
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", start);
  else start();
}
