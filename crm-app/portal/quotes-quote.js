// The customer's quote page (design §8.1 /p/quote/{id} and Present to
// customer /p/present/{token}): pick an option (the recommended one is
// picked to start with), tick add-ons and see the price change, read the
// terms (and a plan's agreement), type your name, sign with a finger, agree,
// Approve. The approval is a run: the page shows "Processing your
// approval…" and follows it; a card or deposit then continues to Checkout.
// "Want something changed?" and "Not interested?" send their answer.
//
// No inline script anywhere (the portal CSP is script-src 'self'): the page
// carries what this needs in data-quote (escaped JSON in an attribute). The
// prices here are only for the customer to see while choosing; the server
// approves the frozen version and recomputes everything.

import { portalPost } from "./core.js";
import { signaturePad } from "../core/signature.js";

const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

const money = (c) => {
  const n = Math.round(Number(c) || 0);
  const neg = n < 0;
  const a = Math.abs(n);
  return `${neg ? "−" : ""}$${Math.floor(a / 100).toString().replace(/\B(?=(\d{3})+(?!\d))/g, ",")}.${String(a % 100).padStart(2, "0")}`;
};
const rhu = (num, den) => { const neg = num < 0; const a = Math.abs(num); const q = Math.floor((a * 2 + den) / (den * 2)); return neg ? -q : q; };
const covers = (s, k) => { const t = s && s.type; if (!t || t === "all") return true; if (t === "initial") return k === 1; if (t === "after_initial") return k > 1; if (t === "specific") return (s.visits || []).includes(k); return false; };

function visitPrices(o, picked, floor) {
  const per = [];
  for (let k = 1; k <= o.visits.term; k++) {
    const base = o.lines.filter((l) => (l.o ? picked.has(l.id) : true) && covers(l.s, k)).reduce((s, l) => s + l.c, 0);
    let bp = 0, fixed = 0;
    for (const d of o.discounts) { if (!covers(d.s, k)) continue; if (d.t === "percentage") bp += d.v; else fixed += d.v; }
    bp = Math.min(10000, bp);
    per.push(Math.max(Math.min(floor, base), base - rhu(base * bp, 10000) - fixed));
  }
  return per;
}

async function getJson(path) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 15000);
  try {
    const res = await fetch(path, { credentials: "same-origin", headers: { Accept: "application/json" }, signal: ctrl.signal });
    let out = null;
    try { out = await res.json(); } catch (e) { out = null; }
    return { status: res.status, body: out };
  } finally { clearTimeout(timer); }
}

function start() {
  const holder = $("[data-quote]");
  if (!holder) return;
  let data;
  try { data = JSON.parse(holder.getAttribute("data-quote")); } catch (e) { return; }
  const picked = new Map(data.options.map((o) => [o.id, new Set(o.lines.filter((l) => l.o && l.sel).map((l) => l.id))]));
  const chosen = () => { const r = $("input[name=option]:checked"); return r ? r.value : (data.options[0] && data.options[0].id); };

  function paint() {
    const id = chosen();
    for (const o of data.options) {
      const per = visitPrices(o, picked.get(o.id), data.floor || 0);
      const flat = per.every((x) => x === per[0]);
      const el = $(`[data-price="${CSS.escape(o.id)}"]`);
      if (el) el.textContent = money(o.kind === "plan" && flat ? per[0] : per[0]);
      const yr = $(`[data-annual="${CSS.escape(o.id)}"]`);
      if (yr) yr.textContent = `${money(per.slice(0, o.visits.year).reduce((a, b) => a + b, 0))} a year`;
      const card = $(`[data-option="${CSS.escape(o.id)}"]`);
      if (card) card.classList.toggle("on", o.id === id);
    }
    const o = data.options.find((x) => x.id === id);
    if (o) {
      const per = visitPrices(o, picked.get(o.id), data.floor || 0);
      const name = $("[data-chosen-name]");
      const price = $("[data-chosen-price]");
      if (name) name.textContent = o.name;
      if (price) price.textContent = o.kind === "plan" ? `${money(per[0])} ${per.every((x) => x === per[0]) ? "a visit" : "for the first visit"}` : money(per[0]);
    }
    for (const d of $$("[data-agreement-for]")) d.hidden = d.getAttribute("data-agreement-for") !== id;
  }

  document.addEventListener("change", (e) => {
    const t = e.target;
    if (t.matches && t.matches("input[name=option]")) paint();
    if (t.matches && t.matches("[data-optline]")) {
      const [oid, lid] = t.getAttribute("data-optline").split("|");
      const set = picked.get(oid);
      if (set) { if (t.checked) set.add(lid); else set.delete(lid); }
      paint();
    }
  });
  paint();

  // ------------------------------------------------------------ approve
  const card = $("[data-approve-card]");
  const canvas = $("[data-sig]");
  const pad = canvas ? signaturePad(canvas) : null;
  const clear = $("[data-sig-clear]");
  if (clear && pad) clear.addEventListener("click", () => pad.clear());
  const btn = $("[data-approve]");
  const err = $("[data-error]");
  const working = $("[data-working]");
  const say = (msg) => { if (err) { err.textContent = msg; err.hidden = !msg; } };

  async function follow(runId) {
    for (let i = 0; i < 90; i++) {
      await new Promise((ok) => setTimeout(ok, i < 5 ? 800 : 1500));
      let r;
      try { r = await getJson(`${data.base}/runs/${encodeURIComponent(runId)}`); } catch (e) { continue; }
      // a present link is spent once its approval went through: that means done
      if (data.mode === "present" && r.status === 410) return { status: "done", result: { status: "approved" } };
      if (!r.body || !r.body.ok) continue;
      const run = r.body.data;
      if (run.status === "done" || run.status === "failed") return run;
    }
    return null;
  }

  function finished(run) {
    if (working) working.hidden = true;
    if (card) card.hidden = true;
    const done = $("[data-done]");
    if (!done) return;
    done.hidden = false;
    const url = run && run.result && run.result.checkout_url;
    const linkBox = $("[data-card]", done);
    const link = $("[data-card-link]", done);
    if (url && link && linkBox && /^(https:\/\/checkout\.stripe\.com\/|\/p\/dry-checkout\/)/.test(url)) {
      link.setAttribute("href", url);
      linkBox.hidden = false;
      const t = $("[data-done-text]", done);
      if (t) t.textContent = "Thanks! One more step: add your card so we can keep your plan running.";
    }
    for (const x of $$(".qx")) x.hidden = true;
    for (const i of $$("input[name=option], [data-optline]")) i.disabled = true;
    done.scrollIntoView({ behavior: "smooth", block: "start" });
  }

  if (btn) {
    btn.addEventListener("click", async () => {
      say("");
      const name = ($("input[name=name_typed]") || {}).value || "";
      const agree = $("input[name=agree]");
      if (name.trim().length < 2) { say("Type your full name."); return; }
      if (!pad || pad.isEmpty()) { say("Sign in the box with your finger."); return; }
      if (!agree || !agree.checked) { say("Check the box to agree to the terms."); return; }
      let sig;
      try { sig = pad.toBase64(); } catch (e) { say(e.message); return; }
      const id = chosen();
      btn.disabled = true;
      btn.textContent = "Approving…";
      try {
        const r = await portalPost(`${data.base}/approve`, {
          version_id: data.version_id, version_sha256: data.sha, option_id: id, selected_line_ids: [...(picked.get(id) || [])],
          name_typed: name.trim(), signature_png_b64: sig, agree: true,
        });
        if (working) working.hidden = false;
        btn.hidden = true;
        const run = await follow(r.data.run_id);
        if (!run) { if (working) working.textContent = "This is taking longer than usual. We'll text you when it's done."; return; }
        if (run.status === "failed") {
          if (working) working.hidden = true;
          btn.hidden = false; btn.disabled = false; btn.textContent = "Approve";
          say(run.code === "updated" ? "This quote was just updated. The page will reload with the new version." : "That didn't go through. Try again, or call us.");
          if (run.code === "updated") setTimeout(() => location.reload(), 2500);
          return;
        }
        finished(run);
      } catch (e) {
        btn.disabled = false; btn.textContent = "Approve";
        say(e.message);
        if (e.code === "updated") setTimeout(() => location.reload(), 2500);
      }
    });
  }

  // ------------------------------------------------------------ changes and decline
  const changes = $("[data-changes]");
  if (changes) changes.addEventListener("click", async () => {
    const box = $("[data-changes-error]");
    const msg = (($("textarea[name=message]") || {}).value || "").trim();
    if (!msg) { box.textContent = "Tell us what you'd like changed."; box.hidden = false; return; }
    changes.disabled = true;
    try { await portalPost(`${data.base}/changes`, { message: msg }); location.reload(); } catch (e) { changes.disabled = false; box.textContent = e.message; box.hidden = false; }
  });
  const decline = $("[data-decline]");
  if (decline) decline.addEventListener("click", async () => {
    const box = $("[data-decline-error]");
    decline.disabled = true;
    try { await portalPost(`${data.base}/decline`, { reason: (($("input[name=reason]") || {}).value || "").trim() }); location.reload(); } catch (e) { decline.disabled = false; box.textContent = e.message; box.hidden = false; }
  });
}

if (typeof document !== "undefined") {
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", start); else start();
}
