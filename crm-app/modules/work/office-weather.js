// The forecast on the Schedule (the month's days, the week's heads, the
// day bar and the day's list): a small icon and the high, and the chance
// of rain or snow when it's 40% or more. The server reads the National
// Weather Service (GET /schedule/weather); this file only draws what it
// answered: { days: { "yyyy-mm-dd": { hi, lo, pop, icon, text } } }.
// Nothing here when there's no forecast: the schedule simply shows none.

import { html, raw } from "../../core/ui.js";

export const WET_POP = 40;

// Static, trusted icons (24 × 24, drawn with the stroke like the app's own).
const svg = (d) => raw(`<svg viewBox="0 0 24 24" aria-hidden="true" focusable="false">${d}</svg>`);
const CLOUD = "M7 17.5h10a3.5 3.5 0 0 0 .5-6.96A5 5 0 0 0 7.6 9.1 4.2 4.2 0 0 0 7 17.5z";
const CLOUD_UP = "M7 14.5h10a3.4 3.4 0 0 0 .5-6.77A4.9 4.9 0 0 0 7.6 6.3 4.1 4.1 0 0 0 7 14.5z";
export const WX_ICONS = {
  sun: svg('<circle cx="12" cy="12" r="4"/><path d="M12 2.5v2M12 19.5v2M4.6 4.6 6 6M18 18l1.4 1.4M2.5 12h2M19.5 12h2M4.6 19.4 6 18M18 6l1.4-1.4"/>'),
  partly: svg('<path d="M8.5 3v1.3M3.3 8.2h1.3M4.8 4.6l.9.9M12.3 4.6l-.9.9M5.4 11.3A3.6 3.6 0 0 1 11.6 6.6"/><path d="M9.5 19.5h8.2a3.1 3.1 0 0 0 .4-6.17 4.4 4.4 0 0 0-8.5-1.08 3.65 3.65 0 0 0-.1 7.25z"/>'),
  cloud: svg(`<path d="${CLOUD}"/>`),
  rain: svg(`<path d="${CLOUD_UP}"/><path d="M8.5 17.5 7.5 20M12.5 17.5l-1 2.5M16.5 17.5l-1 2.5"/>`),
  snow: svg(`<path d="${CLOUD_UP}"/><path d="M8 18.2v.01M12 19.6v.01M16 18.2v.01M10 21.4v.01M14 21.4v.01"/>`),
  storm: svg(`<path d="${CLOUD_UP}"/><path d="M12.6 15.5 10.6 18.6h3l-2 3.2"/>`),
  fog: svg('<path d="M4 8.5h16M6 12.5h14M4 16.5h13M7 20.5h9"/>'),
  wind: svg('<path d="M3 9h10.5a2.8 2.8 0 1 0-2.8-2.8M3 13h15a2.8 2.8 0 1 1-2.8 2.8M3 17h6"/>'),
};
export const wxIcon = (name) => WX_ICONS[name] || WX_ICONS.cloud;

const KIND_WORD = { snow: "snow", storm: "storms", rain: "rain" };
export const wet = (w) => !!w && Number(w.pop) >= WET_POP;
// "34°" (the high, else tonight's low)
export const temp = (w) => (!w ? "" : Number.isFinite(w.hi) ? `${w.hi}°` : Number.isFinite(w.lo) ? `${w.lo}°` : "");
// "60% snow"
export const wetWords = (w) => (wet(w) ? `${w.pop}% ${KIND_WORD[w.icon] || "rain"}` : "");
// For a screen reader and a title: "Mostly Cloudy, high 34°, 60% chance of snow"
export function wxWords(w) {
  if (!w) return "";
  const t = Number.isFinite(w.hi) ? `high ${w.hi}°` : Number.isFinite(w.lo) ? `low ${w.lo}°` : "";
  return [w.text || "", t, wet(w) ? `${w.pop}% chance of ${KIND_WORD[w.icon] || "rain"}` : ""].filter(Boolean).join(", ");
}
export const dayWx = (wx, d) => (wx && wx.days && wx.days[d]) || null;

// The small mark in a day cell: the icon and the high (and the chance, where `pop` asks).
export function wxMark(w, { pop = false, cls = "wk-wx" } = {}) {
  if (!w) return "";
  return html`<span class="${`${cls} wx-${w.icon || "cloud"}`}">${wxIcon(w.icon)}<b class="num">${temp(w)}</b>${pop && wet(w) ? html`<em class="num">${w.pop}%</em>` : ""}</span>`;
}
// One line for the day's list and the day bar: the icon, the words, the high, the chance.
export function wxLine(w) {
  if (!w) return "";
  const t = Number.isFinite(w.hi) ? `High ${w.hi}°` : Number.isFinite(w.lo) ? `Low ${w.lo}°` : "";
  return html`<span class="${`wk-wxline wx-${w.icon || "cloud"}`}">${wxIcon(w.icon)}<span>${[w.text, t, wet(w) ? `${w.pop}% chance of ${KIND_WORD[w.icon] || "rain"}` : ""].filter(Boolean).join(" · ")}</span></span>`;
}
