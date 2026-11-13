// Scan to pay (design §9.2 Invoice and Visit → Collect payment, D38): the
// customer's pay page as a QR code, full screen, black on white, big
// enough to scan from arm's length, with what's due, the customer's first
// name and "Scan with your phone camera to pay". The Invoice screen also
// saves it as a picture (PNG or SVG) for a printed invoice. The code is the
// customer's own pay link (one invoice, nothing more); the screen keeps it
// awake while it shows. When there is no code to show (paid, void, Rotor
// still bills them...) the screen says why instead.

import { html, raw, sheet, toast } from "../../core/ui.js";
import { money, dateYear } from "../../core/format.js";
import { busy } from "../../core/forms.js";
import { qrSvg, qrPosterSvg, svgToPngBlob, saveFile } from "../../core/qr.js";
import { ensureStyles } from "./kit.js";

export const SCAN_WORDS = "Scan with your phone camera to pay";
export const QR_ICON = raw('<svg viewBox="0 0 24 24" aria-hidden="true" focusable="false"><rect x="4" y="4" width="6" height="6" rx="1"/><rect x="14" y="4" width="6" height="6" rx="1"/><rect x="4" y="14" width="6" height="6" rx="1"/><path d="M14 14h2.5v2.5H14zM17.5 17.5H20V20h-2.5zM14 18.5V20M18.5 14H20"/></svg>');

const until = (iso) => (iso ? dateYear(String(iso).slice(0, 10)) : "");

// The code itself. link = { url, number, balance_cents, first_name, expires_at }.
// opts: back (a Back button: Collect payment's form), check ("Did it go
// through?"), save (PNG and SVG for a printed invoice).
export function codeView(link, { back = false, check = true, save = false } = {}) {
  const first = String(link.first_name || "").trim();
  return html`<div class="mn-qr mn-scan" data-pay-qr>
    <p class="mn-scan-amt">${money(link.balance_cents)}</p>
    <p class="mn-scan-who">${first ? `${first} · ${link.number}` : link.number}</p>
    <div class="mn-scan-code">${raw(qrSvg(link.url, { label: SCAN_WORDS, ecl: "M" }))}</div>
    <p class="mn-scan-say">${SCAN_WORDS}</p>
    <p class="small muted mn-scan-note">They can add a tip there.${link.expires_at ? ` The code works until ${until(link.expires_at)}.` : ""}</p>
    ${save ? html`<div class="btn-row mn-scan-save"><button type="button" class="btn" data-qr-png aria-label="Save the code as a picture (PNG) for a printed invoice">Save PNG</button><button type="button" class="btn" data-qr-svg aria-label="Save the code as an SVG for a printed invoice">Save SVG</button></div>` : ""}
    <div class="btn-row mn-scan-acts">${back ? html`<button type="button" class="btn" data-back>Back</button>` : ""}${check ? html`<button type="button" class="btn primary" data-check>Did it go through?</button>` : ""}</div>
  </div>`;
}

// Instead of a code: why there's none.
export const refusedView = (message, { back = false } = {}) => html`<div class="mn-qr mn-scan mn-scan-none" data-pay-qr-none>
  <p class="mn-scan-amt">No code to scan</p>
  <p class="mn-scan-why">${message || "This invoice can't be paid by card right now."}</p>
  <div class="btn-row mn-scan-acts">${back ? html`<button type="button" class="btn" data-back>Back</button>` : html`<button type="button" class="btn primary" data-qr-close>Close</button>`}</div>
</div>`;

const loadingView = () => html`<div class="mn-qr mn-scan" aria-busy="true"><p class="mn-scan-say">Making the code…</p></div>`;

// The picture for a printed invoice: the code and the words under it.
export function printSvg(link) {
  const first = String(link.first_name || "").trim();
  return qrPosterSvg(link.url, {
    ecl: "M", width: 1200, height: 1560, label: SCAN_WORDS,
    lines: [
      { text: `${money(link.balance_cents)} · ${link.number}${first ? ` · ${first}` : ""}`, size: 0.05, bold: true },
      { text: SCAN_WORDS, size: 0.042 },
      { text: link.expires_at ? `Barta Window Washing · works until ${until(link.expires_at)}` : "Barta Window Washing", size: 0.032 },
    ],
  });
}

async function save(link, kind, el) {
  busy(el, true);
  try {
    const svg = printSvg(link);
    const name = `pay-${String(link.number || "invoice").replace(/[^A-Za-z0-9-]/g, "")}.${kind}`;
    const blob = kind === "png" ? await svgToPngBlob(svg, 1200) : new Blob([svg], { type: "image/svg+xml" });
    const how = await saveFile(name, blob, { share: kind === "png", title: "Pay code" });
    if (how !== "cancelled") toast(how === "shared" ? "Shared" : "Saved");
  } catch (e) { toast(e.message || "That picture couldn't be made.", { bad: true }); }
  busy(el, false);
}

// Keeps the screen on while the code shows (where the browser can).
export function keepAwake() {
  let lock = null;
  let off = false;
  try {
    if (navigator.wakeLock && navigator.wakeLock.request) navigator.wakeLock.request("screen").then((l) => { if (off) l.release().catch(() => {}); else lock = l; }).catch(() => {});
  } catch (e) { /* not on this browser */ }
  return () => { off = true; if (lock) lock.release().catch(() => {}); lock = null; };
}

// The full-screen sheet on its own (the Invoice screen): fetch() → the pay
// link (POST), check() → true when the invoice is paid now.
export function openPayQr({ fetch, check, save: canSave = false, title = "Scan to pay", onClose }) {
  ensureStyles();
  let link = null;
  let release = () => {};
  const sh = sheet({
    title,
    body: loadingView(),
    onClose: () => { release(); if (onClose) onClose(); },
    events: {
      "click [data-check]": async (e, el) => {
        busy(el, true);
        try {
          if (await check()) { sh.close(); toast("Paid. Thank you!"); return; }
          toast("Not yet. Give it a few seconds after they finish.");
        } catch (err) { toast(err.message || "That didn't load.", { bad: true }); }
        busy(el, false);
      },
      "click [data-qr-png]": (e, el) => save(link, "png", el),
      "click [data-qr-svg]": (e, el) => save(link, "svg", el),
      "click [data-qr-close]": () => sh.close(),
    },
  });
  sh.el.classList.add("mn-full");
  (async () => {
    try {
      link = (await fetch()).data;
      sh.set(codeView(link, { save: canSave }));
      release = keepAwake();
    } catch (err) {
      sh.set(refusedView(err && err.status === 0 ? "Making a pay code needs signal. Try again when you're back online." : err.message));
    }
  })();
  return sh;
}

