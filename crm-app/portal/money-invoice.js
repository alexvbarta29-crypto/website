// The customer's invoice page (design §8.1 /p/invoice/{id}): pick a tip (or
// none), see the total change, tick "save this card for my plan", then Pay
// goes to the hosted Checkout the server starts. The numbers here are only
// for the customer to see while choosing: the server works the tip out
// again from the choice and the balance. No inline script (the portal CSP
// is script-src 'self'); the page carries what this needs in data-pay.

import { portalPost } from "./core.js";

const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];
const money = (c) => { const n = Math.max(0, Math.round(Number(c) || 0)); return `$${Math.floor(n / 100).toString().replace(/\B(?=(\d{3})+(?!\d))/g, ",")}.${String(n % 100).padStart(2, "0")}`; };
// "12", "12.5", "$12.50" → cents, or null
const cents = (s) => { const m = /^\$?\s*(\d{1,5})(?:\.(\d{1,2}))?$/.exec(String(s || "").trim()); return m ? Number(m[1]) * 100 + Number((m[2] || "").padEnd(2, "0") || 0) : null; };
// round half up, as the server does (core/money.mjs percentOfBps)
const pct = (amount, percent) => Math.floor((amount * percent * 100 * 2 + 10000) / 20000);

function start() {
  const box = $("[data-pay]");
  if (!box) return;
  let data;
  try { data = JSON.parse(box.getAttribute("data-pay")); } catch (e) { return; }
  const btn = $("[data-pay-btn]", box), err = $("[data-error]", box), total = $("[data-paytotal]", box), custom = $("[data-custom]", box);
  const input = custom ? $("input", custom) : null;
  const choice = () => { const c = $$("input[name=tip_choice]", box).find((r) => r.checked); return c ? c.value : "0"; };
  const tip = () => {
    const c = choice();
    if (c === "custom") { const v = cents(input && input.value); return v === null ? 0 : Math.min(v, data.max); }
    return pct(data.balance, Number(c) || 0);
  };
  const paint = () => {
    if (custom) custom.hidden = choice() !== "custom";
    const t = data.balance + tip();
    if (total) total.textContent = money(t);
    if (btn) btn.textContent = `Pay ${money(t)}`;
  };
  $$("input[name=tip_choice]", box).forEach((r) => r.addEventListener("change", () => { paint(); if (r.value === "custom" && r.checked && input) input.focus(); }));
  if (input) input.addEventListener("input", paint);
  paint();
  if (!btn) return;
  btn.addEventListener("click", async () => {
    if (err) err.hidden = true;
    const c = choice();
    const body = { tip_choice: c };
    if (c === "custom") {
      const v = cents(input && input.value);
      if (v === null) { if (err) { err.textContent = "Enter the tip as dollars, like 10 or 12.50."; err.hidden = false; } if (input) input.focus(); return; }
      body.custom_tip_cents = v;
    }
    const save = $("input[name=save_card]", box);
    if (save && save.checked) body.save_card = true;
    btn.disabled = true;
    const was = btn.textContent;
    btn.textContent = "One moment…";
    try {
      const r = await portalPost(`/api/portal/invoices/${encodeURIComponent(data.id)}/checkout`, body);
      const url = r.data && r.data.url;
      if (typeof url === "string" && (url.startsWith("https://checkout.stripe.com/") || url.startsWith("/p/dry-checkout/"))) { location.assign(url); return; }
      throw new Error("That didn't work. Try again, or call us.");
    } catch (e) {
      btn.disabled = false;
      btn.textContent = was;
      if (err) { err.textContent = e.message; err.hidden = false; }
      // paid or changed since the page loaded: show what is true now
      if (e.status === 409) setTimeout(() => location.reload(), 2500);
    }
  });
}

if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", start);
else start();
