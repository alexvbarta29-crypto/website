// Barta CRM client: Light, Dark or Automatic (the owner, Nov 2026: Flyra's
// dark look first, Rotor's light one a tap away). The choice belongs to the
// phone or computer it was made on (localStorage "crm-theme"; a browser
// that keeps nothing gets the default, Dark). crm.css holds every color as
// a token and html[data-theme] picks the set: "light", or dark otherwise.
// Automatic follows the phone's own setting and changes with it. The
// office shell around the frame (/office) hears crm:theme and matches its
// own background and status bar color.
//
//   apply()            at start (main.js), before the first screen draws
//   choice()           "light" | "dark" | "auto"
//   set(v)             saves and applies
//   pickTheme()        the sheet: Light · Dark · Automatic (the Menu's sun
//                      button and My account)

import { html, sheet, icon, attrs, toast } from "./ui.js";

export const THEME_KEY = "crm-theme";
export const CHOICES = Object.freeze([["light", "Light"], ["dark", "Dark"], ["auto", "Automatic"]]);
export const DEFAULT_THEME = "dark";
// the canvas of each (the status bar and the frame behind the app match it)
export const CANVAS = Object.freeze({ light: "#f2f2f7", dark: "#111214" });

let mem = null;   // a browser that keeps nothing: the choice lasts until the page closes
const known = (v) => CHOICES.some(([k]) => k === v);
export function choice() {
  let v = null;
  try { v = localStorage.getItem(THEME_KEY); } catch (e) { /* nothing kept here */ }
  return known(v) ? v : known(mem) ? mem : DEFAULT_THEME;
}

const media = () => (typeof matchMedia === "function" ? matchMedia("(prefers-color-scheme: dark)") : null);
// What shows now: an explicit choice, or the phone's own setting for Automatic.
export function resolve(v = choice(), systemDark = !!(media() && media().matches)) {
  if (v === "light" || v === "dark") return v;
  return systemDark ? "dark" : "light";
}

let listening = false;
export function apply() {
  if (typeof document === "undefined") return DEFAULT_THEME;
  const t = resolve();
  document.documentElement.dataset.theme = t;
  const meta = document.querySelector('meta[name="theme-color"]');
  if (meta) meta.setAttribute("content", CANVAS[t]);
  try { if (window.parent !== window) window.parent.postMessage({ type: "crm:theme", theme: t, canvas: CANVAS[t] }, location.origin); } catch (e) { /* no shell */ }
  const m = media();
  if (m && !listening) {
    listening = true;
    const onChange = () => { if (choice() === "auto") apply(); };
    if (m.addEventListener) m.addEventListener("change", onChange); else if (m.addListener) m.addListener(onChange);
  }
  return t;
}

export function set(v) {
  if (!known(v)) return apply();
  mem = v;
  try { localStorage.setItem(THEME_KEY, v); } catch (e) { /* this browser keeps nothing: for now only */ }
  return apply();
}

// The sheet: Light · Dark · Automatic, the current one ticked.
export function pickTheme({ onPick } = {}) {
  const now = choice();
  const s = sheet({
    title: "Appearance",
    body: html`<ul class="menu theme-pick" role="radiogroup" aria-label="Appearance">${CHOICES.map(([k, l]) => html`<li><button type="button" role="radio" ${attrs({ "data-theme-pick": k, "aria-checked": k === now ? "true" : "false" })}>${icon(k === "light" ? "sun" : k === "dark" ? "moon" : "auto")}<span>${l}</span>${k === now ? html`<span class="theme-ck">${icon("check")}</span>` : ""}</button></li>`)}</ul>
      <p class="small muted">Automatic follows this phone's own setting. Saved on this device.</p>`,
    events: {
      "click [data-theme-pick]": (e, b) => {
        set(b.dataset.themePick);
        s.close();
        toast(`${CHOICES.find(([k]) => k === b.dataset.themePick)[1]} on this device`);
        if (onPick) onPick(choice());
      },
    },
  });
  return s;
}
