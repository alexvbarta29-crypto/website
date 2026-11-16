// The house picture on the screens (the owner, Nov 2026: "make sure every
// lead and customer has a Google Street View or a Google Earth view or
// something of the house"; the server: modules/contacts/house.mjs,
// docs/CRM-MAP.md "The house picture").
//
//   houseReady(ctx) → Promise<bool>   whether pictures can come at all (GET
//       /house/status, asked once every 10 minutes): a screen awaits it in
//       load(), then houseOn() answers while it draws.
//   housePic({ id, geo, line, toggle })   the picture (Street View first),
//       a tap opens Google Maps (Street View, or the satellite map) in a new
//       tab; toggle: Rotor's small Street | Aerial switch on it.
//   houseThumb(id)   a small square for a list row (lazy, the thumb size).
//   houseThumbLink({ id, geo, line })   the same square as a link to Street
//       View (a job's and a visit's address card).
//   addressText(address)   "100 Example Ave, Delano, MN 55328": the one line
//       an address hold copies (core/ui.js addressHold).
//
// Everything after the drawing is here, once, for every screen: a Street
// View that isn't there (Google has no coverage) turns into the aerial, an
// aerial that isn't there into a plain square with a pin (a thumb just
// goes), and the switch swaps the picture and where a tap goes. The
// pictures come from the CRM's own route, so the page's img-src stays 'self'.

import { html, attrs, openExternal, icon } from "../../core/ui.js";

const TTL_MS = 10 * 60 * 1000;
let asked = null, askedAt = 0, on = false;
export function houseReady(ctx) {
  if (asked && Date.now() - askedAt < TTL_MS) return asked;
  askedAt = Date.now();
  asked = Promise.resolve(ctx && ctx.api ? ctx.api("/house/status", { cache: false }) : null)
    .then((r) => { on = !!(r && r.data && r.data.on); return on; })
    .catch(() => { on = false; asked = null; return false; });
  return asked;
}
export const houseOn = () => on;
// (tests)
export function __setHouseOn(v) { on = !!v; asked = Promise.resolve(on); askedAt = Date.now(); }

export const addressText = (a) => (a ? [a.street1, a.street2, [a.city, [a.state, a.zip].filter(Boolean).join(" ")].filter(Boolean).join(", ")].map((x) => String(x || "").trim()).filter(Boolean).join(", ") : "");
const okGeo = (g) => !!(g && Number.isFinite(g.lat) && Number.isFinite(g.lng));
// The picture's address: a property's, or (a list row) a contact's primary property's.
const baseOf = (id, of = "properties") => `/api/crm/${of === "contacts" ? "contacts" : "properties"}/${encodeURIComponent(id)}/house.jpg`;
const srcOf = (base, kind, size) => `${base}?kind=${kind === "aerial" ? "aerial" : "street"}${size === "thumb" ? "&size=thumb" : ""}`;
export const houseSrc = (id, kind = "street", size = "full", of = "properties") => srcOf(baseOf(id, of), kind, size);
// Google Maps in a new tab: Street View at the house (Google picks the nearest panorama), or the
// satellite map over it; without a map point, a search for the address.
const search = (line) => `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(String(line || ""))}`;
export const streetViewUrl = (geo, line) => (okGeo(geo) ? `https://www.google.com/maps/@?api=1&map_action=pano&viewpoint=${geo.lat.toFixed(6)},${geo.lng.toFixed(6)}` : search(line));
export const aerialUrl = (geo, line) => (okGeo(geo) ? `https://www.google.com/maps/@?api=1&map_action=map&center=${geo.lat.toFixed(6)},${geo.lng.toFixed(6)}&zoom=20&basemap=satellite` : search(line));

const LABEL = { street: "Street View", aerial: "Satellite view" };
// The picture (Street View first). id: the property's id; geo: its map point; line: its one-line address.
export function housePic({ id, geo = null, line = "", toggle = true, cls = "" } = {}) {
  if (!id) return "";
  const where = line || "the house";
  const urls = { "data-url-street": streetViewUrl(geo, line), "data-url-aerial": aerialUrl(geo, line) };
  return html`<div ${attrs({ class: "rs-house" + (cls ? " " + cls : ""), "data-house-box": "", "data-kind": "street", ...urls })}>
    <a class="rs-house-a" ${openExternal(streetViewUrl(geo, line))} ${attrs({ "data-house-link": "", "aria-label": `${LABEL.street} of ${where} (opens Google Maps)` })}><img ${attrs({ src: houseSrc(id, "street"), alt: "", loading: "lazy", decoding: "async", "data-house": "street", "data-base": baseOf(id) })}></a>
    <span class="rs-house-none" aria-hidden="true">${icon("pin")}<span>No picture of the house yet</span></span>
    ${toggle ? html`<span class="rs-house-seg" role="group" aria-label="House picture"><button type="button" ${attrs({ "data-house-kind": "street", "aria-pressed": "true" })}>Street</button><button type="button" ${attrs({ "data-house-kind": "aerial", "aria-pressed": "false" })}>Aerial</button></span>` : ""}
  </div>`;
}

// A small square for a list row (lazy; the server's thumb size): a property's, or with
// { of: "contacts" } a contact's primary property's.
export const houseThumb = (id, { of = "properties" } = {}) => (id ? html`<img ${attrs({ class: "rs-hthumb", src: houseSrc(id, "street", "thumb", of), alt: "", loading: "lazy", decoding: "async", "data-house": "street", "data-house-thumb": "", "data-base": baseOf(id, of) })}>` : "");

// The square as a link to Street View (to the satellite map once Street View isn't there).
export function houseThumbLink({ id, geo = null, line = "" } = {}) {
  if (!id) return "";
  return html`<a class="rs-hlink" ${openExternal(streetViewUrl(geo, line))} ${attrs({ "data-url-aerial": aerialUrl(geo, line), "aria-label": `Street View of ${line || "the house"} (opens Google Maps)` })}>${houseThumb(id)}</a>`;
}

// One box to street or aerial: the picture, where a tap goes, the switch.
export function showKind(box, kind) {
  if (!box) return;
  const img = box.querySelector("img[data-house]");
  const a = box.querySelector("[data-house-link]");
  box.dataset.kind = kind;
  box.classList.remove("none");
  if (img) {
    img.dataset.house = kind;
    const want = srcOf(img.dataset.base, kind, "full");
    if (img.getAttribute("src") !== want) img.setAttribute("src", want);
  }
  if (a) {
    a.setAttribute("href", box.getAttribute(`data-url-${kind}`) || "#");
    a.setAttribute("aria-label", String(a.getAttribute("aria-label") || "").replace(/^(Street View|Satellite view)/, LABEL[kind]));
  }
  for (const b of box.querySelectorAll("[data-house-kind]")) b.setAttribute("aria-pressed", String(b.dataset.houseKind === kind));
}

// A picture that didn't come: Street View → the aerial; the aerial → a plain square (a thumb goes).
export function pictureFailed(img) {
  if (img.hasAttribute("data-house-thumb")) {
    const link = img.closest(".rs-hlink");
    if (img.dataset.house === "street") {
      img.dataset.house = "aerial";
      img.setAttribute("src", srcOf(img.dataset.base, "aerial", "thumb"));
      if (link && link.dataset.urlAerial) { link.setAttribute("href", link.dataset.urlAerial); link.setAttribute("aria-label", String(link.getAttribute("aria-label") || "").replace(/^Street View/, "Satellite view")); }
    } else (link || img).remove();
    return;
  }
  const box = img.closest("[data-house-box]");
  if (!box) return;
  if (img.dataset.house === "street") {
    const sb = box.querySelector('[data-house-kind="street"]');
    if (sb) { sb.disabled = true; sb.title = "No Street View here"; }
    showKind(box, "aerial");
    return;
  }
  box.classList.add("none");
}

if (typeof document !== "undefined") {
  // (an img's error doesn't bubble: listen while it goes down)
  document.addEventListener("error", (e) => {
    const img = e.target;
    if (img && img.tagName === "IMG" && img.hasAttribute("data-house")) pictureFailed(img);
  }, true);
  document.addEventListener("click", (e) => {
    const b = e.target && e.target.closest ? e.target.closest("[data-house-kind]") : null;
    if (!b || b.disabled) return;
    e.preventDefault();
    showKind(b.closest("[data-house-box]"), b.dataset.houseKind === "aerial" ? "aerial" : "street");
  });
}
