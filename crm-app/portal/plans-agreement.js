// The customer's agreement page (design §8.1 /p/agreement/{id}, the hub's
// copy and Present to customer /p/sign/{token}): type your name, sign with
// a finger (optional on a computer), agree, Sign. The server checks the
// text's hash, so a text that changed while the page was open asks for a
// reload instead of signing something the customer didn't read.
//
// No inline script (the portal CSP is script-src 'self'): the page carries
// {id, sha, base, mode} in data-agreement (escaped JSON in an attribute).

import { portalPost } from "./core.js";
import { signaturePad } from "../core/signature.js";

const $ = (sel, root = document) => root.querySelector(sel);

function start() {
  const holder = $("[data-agreement]");
  if (!holder) return;
  let data;
  try { data = JSON.parse(holder.getAttribute("data-agreement")); } catch (e) { return; }
  if (!data || typeof data.base !== "string" || !data.base.startsWith("/api/portal/")) return;
  const canvas = $("[data-sig]");
  const pad = canvas ? signaturePad(canvas) : null;
  const clear = $("[data-sig-clear]");
  if (clear && pad) clear.addEventListener("click", () => pad.clear());
  const btn = $("[data-sign]");
  const err = $("[data-error]");
  const say = (msg) => { if (err) { err.textContent = msg; err.hidden = !msg; } };
  if (!btn) return;
  btn.addEventListener("click", async () => {
    say("");
    const name = (($("input[name=name_typed]") || {}).value || "").trim();
    const agree = $("input[name=agree]");
    if (name.length < 2) { say("Type your full name."); return; }
    if (!agree || !agree.checked) { say("Check the box to agree."); return; }
    const body = { body_sha256: data.sha, name_typed: name, agree: true };
    if (pad && !pad.isEmpty()) {
      try { body.signature_png_b64 = pad.toBase64(); } catch (e) { say(e.message); return; }
    }
    btn.disabled = true;
    btn.textContent = "Signing…";
    try {
      await portalPost(`${data.base}/sign`, body);
      const card = $("[data-sign-card]");
      if (card) card.hidden = true;
      const done = $("[data-signed]");
      if (done) { done.hidden = false; done.scrollIntoView({ behavior: "smooth", block: "start" }); }
    } catch (e) {
      btn.disabled = false;
      btn.textContent = "Sign";
      if (e.code === "updated") { say("This agreement was just updated. The page will reload with the new text."); setTimeout(() => location.reload(), 2500); return; }
      say(e.message);
    }
  });
}

if (typeof document !== "undefined") {
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", start);
  else start();
}
