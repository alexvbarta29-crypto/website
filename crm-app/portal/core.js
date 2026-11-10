// Barta CRM client portal: the script every portal page loads (design §8.1,
// §8.3, §8.4). No inline script anywhere (the portal's CSP is
// script-src 'self'); pages carry what this script needs in data-*
// attributes, never customer data in script.
//
// - The entry page (/p/{code}, body[data-portal="open"]) POSTs the code to
//   /api/portal/open, which sets the scoped cookie, then goes where the
//   answer says. GET pages never change anything: a link preview or an email
//   scanner that fetches the page opens nothing.
// - The view beacon (body[data-beacon-kind]) is one POST after load.
// - Unsubscribe: the button POSTs /api/portal/unsubscribe/{code}.
// - [data-print] prints (the pages have a print stylesheet: Save as PDF).
// - portalPost() is how the modules' page scripts (quotes-quote.js,
//   plans-agreement.js, money-invoice.js...) talk to /api/portal/*: the
//   X-CRM-Portal header (CSRF), JSON, a 15 s timeout, plain-English errors.

export async function portalPost(path, body = {}, { timeout = 15000 } = {}) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeout);
  let res;
  try {
    res = await fetch(path, { method: "POST", credentials: "same-origin", headers: { "Content-Type": "application/json", "X-CRM-Portal": "1", Accept: "application/json" }, body: JSON.stringify(body), signal: ctrl.signal });
  } catch (e) {
    throw new Error("No connection. Try again when you have signal.");
  } finally {
    clearTimeout(timer);
  }
  if (res.status === 204) return { ok: true, data: null };
  let out = null;
  try { out = await res.json(); } catch (e) { out = null; }
  if (!res.ok || !out || out.ok !== true) {
    const err = new Error((out && out.error && out.error.message) || "That didn't work. Try again, or call us.");
    err.status = res.status;
    err.code = out && out.error && out.error.code;
    throw err;
  }
  return out;
}

const $ = (sel, root = document) => root.querySelector(sel);

async function openLink() {
  const box = $("[data-code]");
  if (!box) return;
  const status = $("[data-status]", box);
  const form = $("form", box);
  if (form) form.hidden = true;
  try {
    const r = await portalPost("/api/portal/open", { code: box.getAttribute("data-code") });
    const to = r.data && r.data.location;
    if (typeof to === "string" && to.startsWith("/p/")) { location.replace(to); return; }
    throw new Error("That link isn't right.");
  } catch (e) {
    if (status) status.textContent = e.message;
    const h = $("h1", box);
    if (h) h.textContent = e.status === 410 ? "That link no longer works" : "We couldn't open that";
    if (form && e.status !== 410 && e.status !== 404) form.hidden = false;
  }
}

function beacon() {
  const kind = document.body.getAttribute("data-beacon-kind");
  if (!kind) return;
  const id = document.body.getAttribute("data-beacon-id") || "";
  const send = () => portalPost("/api/portal/beacon", { kind, id }).catch(() => {});
  if (document.visibilityState === "visible") send();
  else document.addEventListener("visibilitychange", function once() { if (document.visibilityState === "visible") { document.removeEventListener("visibilitychange", once); send(); } });
}

function unsubscribeButton() {
  const box = $("[data-unsubscribe-code]");
  if (!box) return;
  const btn = $("[data-unsubscribe]", box);
  if (!btn) return;
  btn.addEventListener("click", async () => {
    btn.disabled = true;
    const err = $("[data-error]", box);
    if (err) err.hidden = true;
    try {
      await portalPost(`/api/portal/unsubscribe/${encodeURIComponent(box.getAttribute("data-unsubscribe-code"))}`, {});
      const done = $("[data-done]", box);
      if (done) done.hidden = false;
      btn.hidden = true;
    } catch (e) {
      btn.disabled = false;
      if (err) { err.textContent = e.message; err.hidden = false; }
    }
  });
}

function printButtons() {
  document.addEventListener("click", (e) => {
    const b = e.target.closest && e.target.closest("[data-print]");
    if (b) { e.preventDefault(); window.print(); }
  });
}

function start() {
  const page = document.body.getAttribute("data-portal");
  if (page === "open") openLink();
  unsubscribeButton();
  printButtons();
  beacon();
}

if (typeof document !== "undefined") {
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", start); else start();
}
