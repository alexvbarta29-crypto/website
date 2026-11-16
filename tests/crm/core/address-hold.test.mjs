// The address hold (core/ui.js; the owner, Nov 2026: "make addresses
// copyable whenever you hold down on them") and the house picture's markup
// (modules/contacts/house.js): what the helpers mark, the clipboard helper
// and its fallback for older iPhones, the buzz and the toast, and that a
// long press on an address copies it while one on a row still opens its
// "...". A tiny fake document stands in for the browser.
import { test, afterEach } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const ui = await import("../../../crm-app/core/ui.js");
const house = await import("../../../crm-app/modules/contacts/house.js");
const { addressAttrs, addressHold, contactRows, addressCard, listRow, boardCard, dataTable, personCard, html, copyText, copyAddress, holdFire, ADDRESS_HOLD_MS, HOLD_MS } = ui;
const h = (x) => String(x);
const CSS = readFileSync("crm-app/styles/crm.css", "utf8");
const LINE = "100 Example Ave, Delano, MN 55328";

// ------------------------------------------------------------ a tiny browser
const saved = { nav: Object.getOwnPropertyDescriptor(globalThis, "navigator"), doc: globalThis.document };
afterEach(() => {
  if (saved.nav) Object.defineProperty(globalThis, "navigator", saved.nav);
  if (saved.doc === undefined) delete globalThis.document; else globalThis.document = saved.doc;
});
function fakeBrowser({ clipboard = "ok", exec = true, vibrate = true } = {}) {
  const out = { clip: null, exec: [], buzz: [], toasts: [], appended: 0 };
  const nav = {};
  if (clipboard) nav.clipboard = { writeText: async (v) => { if (clipboard !== "ok") throw new Error("NotAllowedError"); out.clip = v; } };
  if (vibrate) nav.vibrate = (ms) => { out.buzz.push(ms); return true; };
  Object.defineProperty(globalThis, "navigator", { value: nav, configurable: true, writable: true });
  const toasts = { firstChild: null, removeChild() { this.firstChild = null; }, appendChild(t) { this.firstChild = t; out.toasts.push({ text: t.textContent, bad: /bad/.test(t.className) }); } };
  const el = (tag) => ({ tag, style: {}, attrs: {}, value: "", setAttribute(k, v) { this.attrs[k] = v; }, focus() {}, select() { out.selected = this.value; }, setSelectionRange() {}, remove() { out.removed = (out.removed || 0) + 1; } });
  globalThis.document = {
    body: { appendChild() { out.appended += 1; } },
    activeElement: null,
    createElement: (tag) => el(tag),
    getElementById: (id) => (id === "toasts" ? toasts : null),
    execCommand: (cmd) => { out.exec.push(cmd); if (exec && out.selected !== undefined) out.clip = out.selected; return exec; },
  };
  return out;
}
const tick = () => new Promise((r) => setTimeout(r, 0));

test("addressAttrs / addressHold: one tidy line in data-address; nothing without an address; quotes escaped", () => {
  assert.deepEqual(addressAttrs("  100 Example Ave,\n  Delano  "), { "data-address": "100 Example Ave, Delano" });
  assert.deepEqual(addressAttrs(""), {});
  assert.deepEqual(addressAttrs(null), {});
  assert.equal(addressAttrs("x".repeat(400))["data-address"].length, 300);
  assert.equal(h(html`<a ${addressHold('1 "Quote" Rd')} href="#/x">a</a>`), '<a data-address="1 &quot;Quote&quot; Rd" href="#/x">a</a>');
  assert.ok(ADDRESS_HOLD_MS < HOLD_MS && ADDRESS_HOLD_MS >= 400 && ADDRESS_HOLD_MS <= 500, "about 450 ms");
});

test("the kit marks every address it draws: contact rows, the address card, Row2, board cards, a table column, the person card", () => {
  assert.match(h(contactRows([{ icon: "pin", label: "Address", value: "100 Example Ave", sub: "Delano, MN 55328", address: LINE, href: "#/properties/pr_1" }])), new RegExp(`<a class="rs-cv" href="#/properties/pr_1" data-address="${LINE}">`));
  assert.doesNotMatch(h(contactRows([{ icon: "call", label: "Mobile", value: "(763) 555-0100" }])), /data-address/, "a phone row is not an address");
  // the address card: line1 and line2 by default; the caller's line when line2 holds a gate code
  assert.match(h(addressCard({ line1: "100 Example Ave", line2: "Delano, MN 55328", href: "#/properties/pr_1" })), new RegExp(`class="rs-pl" href="#/properties/pr_1" data-address="${LINE}"`));
  const gated = h(addressCard({ line1: "100 Example Ave", line2: "Delano, MN 55328 · gate 1234", address: LINE }));
  assert.match(gated, new RegExp(`<span class="rs-pl" data-address="${LINE}">`));
  assert.match(h(addressCard({ line1: "100 Example Ave", line2: "Delano, MN 55328 · gate 1234" })), new RegExp(`<span class="rs-pl" data-address="${LINE}">`), "the default leaves the gate code out too");
  assert.doesNotMatch(gated, /data-address="[^"]*gate/, "the gate code is never copied");
  assert.match(h(addressCard({ line1: "1 A St", pic: html`<div class="rs-house"></div>` })), /^<div class="rs-card rs-addr-c"><div class="rs-addr">.*<div class="rs-house"><\/div><\/div>$/s, "a house picture inside the card");
  assert.doesNotMatch(h(addressCard({ line1: "1 A St", thumb: html`<a class="rs-hlink"></a>` })), /rs-ci/, "a thumbnail in place of the pin");
  // Row2: the whole row without a hold; with a hold (the "..."), only its second line
  assert.match(h(listRow({ title: "Pat", sub: "Delano", address: LINE, href: "#/c" })), new RegExp(`^<li class="rs-lrow" data-address="${LINE}">`));
  const held = h(listRow({ title: "Pat", sub: "Delano", address: LINE, href: "#/c", hold: { "row-more": "ct_1" } }));
  assert.match(held, /^<li class="rs-lrow" data-hold="" data-row-more="ct_1">/);
  assert.match(held, new RegExp(`<span class="rs-lr-2" data-address="${LINE}">`));
  assert.match(h(listRow({ title: "Pat", thumb: html`<img class="rs-hthumb">` })), /<img class="rs-hthumb">/);
  assert.match(h(boardCard({ title: "Pat", sub: "Website", address: LINE })), new RegExp(`<span class="rs-bc-s" data-address="${LINE}">`));
  const t = h(dataTable({ columns: [{ key: "n", label: "Name" }, { key: "c", label: "City", address: true }], rows: [{ cells: { n: "Pat", c: "Delano" }, address: LINE }, { cells: { n: "Sam", c: "Mound" } }] }));
  assert.match(t, new RegExp(`<span class="rs-td c-text" data-address="${LINE}">Delano</span>`));
  assert.match(t, /<span class="rs-td c-text" data-address="Mound">Mound<\/span>/, "the cell's own text without a row address");
  assert.match(h(personCard({ name: "Pat", sub: `(763) 555-0100 · ${LINE}`, address: LINE })), new RegExp(`<span class="rs-ps" data-address="${LINE}">`));
});

test("copyText: the Clipboard API; refused (an older iPhone), a hidden textarea and execCommand; neither, false", async () => {
  let b = fakeBrowser();
  assert.equal(await copyText(LINE), true);
  assert.equal(b.clip, LINE);
  assert.deepEqual(b.exec, [], "no fallback needed");
  b = fakeBrowser({ clipboard: "refused" });
  assert.equal(await copyText(LINE), true);
  assert.deepEqual(b.exec, ["copy"]);
  assert.equal(b.clip, LINE, "the textarea held the address");
  assert.equal(b.removed, 1, "and is gone again");
  b = fakeBrowser({ clipboard: null });
  assert.equal(await copyText(LINE), true, "no Clipboard API at all");
  fakeBrowser({ clipboard: "refused", exec: false });
  assert.equal(await copyText(LINE), false);
  assert.equal(await copyText(""), false, "nothing to copy");
});

test("copyAddress: a light buzz and \"Address copied\"; a failure says how to copy it by hand", async () => {
  let b = fakeBrowser();
  assert.equal(await copyAddress(`  ${LINE} `), true);
  assert.equal(b.clip, LINE);
  assert.deepEqual(b.buzz, [12]);
  assert.deepEqual(b.toasts, [{ text: "Address copied", bad: false }]);
  b = fakeBrowser({ vibrate: false });
  assert.equal(await copyAddress(LINE), true, "no buzz where the phone can't (an iPhone)");
  assert.deepEqual(b.toasts.map((x) => x.text), ["Address copied"]);
  b = fakeBrowser({ clipboard: "refused", exec: false });
  assert.equal(await copyAddress(LINE), false);
  assert.equal(b.toasts[0].bad, true);
  assert.match(b.toasts[0].text, /Couldn't copy/);
  assert.doesNotMatch(b.toasts[0].text, /\u2014/, "no em dash");
  b = fakeBrowser({ clipboard: "refused", exec: false });
  await copyAddress(LINE, { quiet: true });
  assert.deepEqual(b.toasts, [], "quiet: the hold tries again when the finger lifts");
});

test("holdFire: a long press on an address copies it; on a row's [data-hold] it still sends rs-hold", async () => {
  const b = fakeBrowser();
  const sent = [];
  const el = (attrs) => ({ hasAttribute: (k) => k in attrs, getAttribute: (k) => attrs[k], dispatchEvent: (e) => sent.push(e.type) });
  assert.equal(await holdFire(el({ "data-address": LINE })), true);
  assert.equal(b.clip, LINE);
  assert.deepEqual(sent, [], "no rs-hold for an address");
  assert.equal(holdFire(el({ "data-hold": "" })), null);
  assert.deepEqual(sent, ["rs-hold"]);
  await tick();
});

test("the stylesheet: no callout or text selection under the finger on an address; the house picture's pieces", () => {
  assert.match(CSS, /\[data-address\]\{-webkit-touch-callout:none\}/);
  assert.match(CSS, /@media \(pointer:coarse\)\{\[data-address\]\{-webkit-user-select:none;user-select:none\}\}/);
  for (const cls of ["rs-house", "rs-house-a", "rs-house-none", "rs-house-seg", "rs-hthumb", "rs-hlink", "rs-addr-c"]) assert.match(CSS, new RegExp(`\\.${cls}[{ .,:]`), cls);
  assert.match(CSS, /\.rs-house-seg button\{min-width:44px;min-height:44px/, "the Street | Aerial switch: 44 px targets");
});

test("the house picture: our own route (img-src stays 'self'), Street View first, a tap opens Google Maps in a new tab, the switch", () => {
  assert.equal(house.houseSrc("pr_1"), "/api/crm/properties/pr_1/house.jpg?kind=street");
  assert.equal(house.houseSrc("ct_1", "aerial", "thumb", "contacts"), "/api/crm/contacts/ct_1/house.jpg?kind=aerial&size=thumb");
  const geo = { lat: 45.0412345, lng: -93.7891234 };
  assert.equal(house.streetViewUrl(geo, LINE), "https://www.google.com/maps/@?api=1&map_action=pano&viewpoint=45.041235,-93.789123");
  assert.equal(house.aerialUrl(geo, LINE), "https://www.google.com/maps/@?api=1&map_action=map&center=45.041235,-93.789123&zoom=20&basemap=satellite");
  assert.equal(house.streetViewUrl(null, LINE), `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(LINE)}`, "no map point: a search for the address");
  const pic = h(house.housePic({ id: "pr_1", geo, line: LINE }));
  assert.match(pic, /<img src="\/api\/crm\/properties\/pr_1\/house\.jpg\?kind=street" alt="" loading="lazy" decoding="async" data-house="street"/);
  assert.match(pic, /href="https:\/\/www\.google\.com\/maps\/@\?api=1&amp;map_action=pano[^"]*" target="_blank" rel="noopener"/);
  assert.match(pic, new RegExp(`aria-label="Street View of ${LINE} \\(opens Google Maps\\)"`));
  assert.match(pic, /data-house-kind="street" aria-pressed="true">Street<\/button><button type="button" data-house-kind="aerial" aria-pressed="false">Aerial</);
  assert.doesNotMatch(h(house.housePic({ id: "pr_1", toggle: false })), /data-house-kind/);
  assert.equal(house.housePic({}), "", "no property, no picture");
  assert.match(h(house.houseThumb("ct_1", { of: "contacts" })), /class="rs-hthumb" src="\/api\/crm\/contacts\/ct_1\/house\.jpg\?kind=street&amp;size=thumb" alt="" loading="lazy"/);
  assert.match(h(house.houseThumbLink({ id: "pr_1", geo, line: LINE })), /^<a class="rs-hlink" href="https:\/\/www\.google\.com\/maps\/@\?api=1&amp;map_action=pano/);
  assert.equal(house.addressText({ street1: "100 Example Ave", street2: "Unit 2", city: "Delano", state: "MN", zip: "55328" }), "100 Example Ave, Unit 2, Delano, MN 55328");
  assert.equal(house.addressText(null), "");
});

test("a picture that doesn't come: Street View turns into the aerial, the aerial into the plain square; a thumb goes", () => {
  // a fake box: the picture, its link, the switch
  const mk = () => {
    const attrs = (o) => ({ ...o, setAttribute(k, v) { this[k] = v; }, getAttribute(k) { return this[k]; } });
    const img = attrs({ tagName: "IMG", dataset: { house: "street", base: "/api/crm/properties/pr_1/house.jpg" }, src: "/api/crm/properties/pr_1/house.jpg?kind=street", hasAttribute: (k) => k === "data-house" });
    const a = attrs({ "aria-label": "Street View of x (opens Google Maps)", href: "https://www.google.com/maps/@?api=1&map_action=pano" });
    const sb = attrs({ dataset: { houseKind: "street" }, disabled: false });
    const ab = attrs({ dataset: { houseKind: "aerial" } });
    const classes = new Set();
    const box = attrs({ dataset: { kind: "street" }, "data-url-aerial": "https://www.google.com/maps/@?api=1&map_action=map", classList: { add: (c) => classes.add(c), remove: (c) => classes.delete(c) },
      querySelector: (q) => (q.startsWith("img") ? img : q === "[data-house-link]" ? a : q.includes('"street"') ? sb : null), querySelectorAll: () => [sb, ab] });
    img.closest = (q) => (q === "[data-house-box]" ? box : null);
    return { img, a, sb, ab, box, classes };
  };
  const x = mk();
  house.pictureFailed(x.img);
  assert.equal(x.box.dataset.kind, "aerial");
  assert.equal(x.img.src, "/api/crm/properties/pr_1/house.jpg?kind=aerial");
  assert.equal(x.a.href, "https://www.google.com/maps/@?api=1&map_action=map", "a tap opens the satellite map now");
  assert.match(x.a["aria-label"], /^Satellite view of x/);
  assert.equal(x.sb.disabled, true, "Street can't be picked where there is none");
  assert.deepEqual([x.sb["aria-pressed"], x.ab["aria-pressed"]], ["false", "true"]);
  house.pictureFailed(x.img);
  assert.ok(x.classes.has("none"), "no aerial either: the plain square with a pin");
  // a list thumb: street → aerial → gone
  let gone = 0;
  const th = { dataset: { house: "street", base: "/api/crm/contacts/ct_1/house.jpg" }, hasAttribute: (k) => k === "data-house-thumb", setAttribute(k, v) { this[k] = v; }, closest: () => null, remove: () => { gone += 1; } };
  house.pictureFailed(th);
  assert.equal(th.src, "/api/crm/contacts/ct_1/house.jpg?kind=aerial&size=thumb");
  house.pictureFailed(th);
  assert.equal(gone, 1);
});
