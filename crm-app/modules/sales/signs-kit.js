// What the Signs & flyers screens share (signs.js, sign.js, sign-form.js):
// the words for each kind, the pages a code can send people to, the
// numbers strip, and the printable pictures (an 18 × 24 yard sign and a
// quarter-page flyer: the code big, its name and short address under it).
// No data here, only how things read (design §2.3).

import { html, attrs } from "../../core/ui.js";
import { money } from "../../core/format.js";
import { qrPosterSvg, svgToPngBlob, saveFile } from "../../core/qr.js";

export const KINDS = [
  { value: "yard_sign", label: "Yard sign" }, { value: "door_hanger", label: "Door hanger" }, { value: "flyer", label: "Flyer" },
  { value: "truck", label: "Truck" }, { value: "business_card", label: "Business card" }, { value: "other", label: "Something else" },
];
export const kindLabel = (k) => (KINDS.find((x) => x.value === k) || { label: "QR code" }).label;
// Pages of the website a code can open (any other page of the site can be typed in).
export const PAGES = [
  ["/get-quote.html", "the quote page"], ["/", "the home page"],
  ["/services/exterior-window-cleaning.html", "Exterior window cleaning"], ["/services/interior-window-cleaning.html", "Interior window cleaning"],
  ["/services/gutter-cleaning.html", "Gutter cleaning"], ["/services/christmas-light-installation.html", "Christmas lights"],
  ["/services/solar-panel-cleaning.html", "Solar panel cleaning"], ["/services/commercial-cleaning.html", "Commercial cleaning"],
  ["/landing/free-window-cleaning-quote.html", "Free window cleaning quote"], ["/landing/free-gutter-cleaning-estimate.html", "Free gutter cleaning estimate"],
  ["/landing/holiday-lighting-estimate.html", "Holiday lighting estimate"], ["/reviews.html", "Reviews"],
];
export const pageLabel = (p) => (PAGES.find(([x]) => x === p) || [p, p])[1];

// Whole dollars in the small tiles ("$1,185"); the leads list keeps the cents.
const dollars = (cents) => `$${Math.round((cents || 0) / 100).toLocaleString("en-US")}`;
export const numbers = (c, { big = false } = {}) => html`<div class="${"sg-nums" + (big ? " big" : "")}">
  <div><b>${c.scans}</b><small>${c.scans === 1 ? "scan" : "scans"}</small></div>
  <div><b>${c.leads}</b><small>${c.leads === 1 ? "lead" : "leads"}</small></div>
  <div><b>${c.booked}</b><small>booked</small></div>
  <div ${attrs({ title: money(c.revenue_cents || 0) })}><b>${dollars(c.revenue_cents)}</b><small>paid</small></div>
</div>`;

// The print sizes: the viewBox in points and the size it prints at.
export const PRINTS = {
  sign: { label: "Yard sign, 18 × 24 in", width: 1800, height: 2400, physical: ["18in", "24in"], px: 1800, file: "yard-sign-18x24" },
  flyer: { label: "Flyer, quarter page (4.25 × 5.5 in)", width: 1275, height: 1650, physical: ["4.25in", "5.5in"], px: 1275, file: "flyer-quarter-page" },
};
export function printSvg(code, size) {
  const p = PRINTS[size] || PRINTS.sign;
  return qrPosterSvg(code.url, {
    ecl: "Q", width: p.width, height: p.height, physical: p.physical, label: code.name,
    lines: [{ text: code.name, size: 0.05, bold: true }, { text: code.short, size: 0.038 }],
  });
}
export async function savePrint(code, size, kind) {
  const p = PRINTS[size] || PRINTS.sign;
  const svg = printSvg(code, size);
  const name = `${code.slug}-${p.file}.${kind}`;
  const blob = kind === "png" ? await svgToPngBlob(svg, p.px) : new Blob([svg], { type: "image/svg+xml" });
  return saveFile(name, blob, { share: kind === "png", title: code.name });
}
