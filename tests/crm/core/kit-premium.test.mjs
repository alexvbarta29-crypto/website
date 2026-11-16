// The premium pass (Nov 16, the owner: "make everything feel a little bit more premium, how it looks,
// and just like the interactions"): core/ui.js's haptic tick (only after a touch, never twice at once),
// the scroll edge (the bar separates from what scrolls under it; a page's name comes into an empty
// bar once it has gone under it), the count-up of a number drawn as text (once per key, nothing under
// Reduce Motion), core/router.js's crowded large title (its own line, never "Cus..."), and the
// stylesheet's pieces (iOS's switch, the frosted toast, the hairline, all off under reduced motion).
import { test, afterEach } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const ui = await import("../../../crm-app/core/ui.js");
const router = await import("../../../crm-app/core/router.js");
const CSS = readFileSync("crm-app/styles/crm.css", "utf8");
const PREMIUM = CSS.slice(CSS.indexOf("premium (Nov 16"));

const saved = {};
const keep = (...ks) => { for (const k of ks) if (!(k in saved)) saved[k] = Object.getOwnPropertyDescriptor(globalThis, k); };
afterEach(() => {
  for (const [k, d] of Object.entries(saved)) { if (d) Object.defineProperty(globalThis, k, d); else delete globalThis[k]; }
  for (const k of Object.keys(saved)) delete saved[k];
});
const set = (k, v) => { keep(k); Object.defineProperty(globalThis, k, { value: v, configurable: true, writable: true }); };
const classes = () => { const s = new Set(); return { add: (c) => s.add(c), remove: (c) => s.delete(c), contains: (c) => s.has(c), toggle: (c, on) => (on ? s.add(c) : s.delete(c)), has: (c) => s.has(c), all: s }; };
let now = 100000;
const tick = (ms = 100) => { now += ms; };

test("haptic: a light tick only after the person has touched the page, never two at once", () => {
  const buzz = [];
  set("document", { head: {} });
  set("navigator", { userActivation: { hasBeenActive: false }, vibrate: (ms) => { buzz.push(ms); return true; } });
  const realNow = Date.now;
  Date.now = () => now;
  try {
    tick();
    assert.equal(ui.haptic(), false, "before any touch: nothing (Chrome would log an intervention)");
    navigator.userActivation.hasBeenActive = true;
    tick();
    assert.equal(ui.haptic(), true);
    assert.equal(ui.haptic(), false, "a second one in the same moment is dropped (a hold and its click)");
    tick();
    assert.equal(ui.haptic(12), true);
    assert.deepEqual(buzz, [10, 12]);
    // an iPhone: no vibrate, no head in this fake → nothing thrown, false
    set("navigator", { userAgent: "iPhone" });
    set("document", {});
    tick();
    assert.equal(ui.haptic(), false);
  } finally { Date.now = realNow; }
});

test("haptic on an iPhone: iOS's switch tick through a hidden label in <head>, its events kept from the page", () => {
  const made = [];
  const el = (tag) => {
    const n = { tag, style: {}, attrs: {}, kids: [], listeners: {}, clicked: 0, removed: false,
      setAttribute(k, v) { this.attrs[k] = v; }, appendChild(c) { this.kids.push(c); }, addEventListener(t, f) { (this.listeners[t] = this.listeners[t] || []).push(f); },
      click() { this.clicked++; }, remove() { this.removed = true; } };
    made.push(n);
    return n;
  };
  const head = { kids: [], appendChild(c) { this.kids.push(c); } };
  set("document", { head, createElement: el, ontouchend: null });
  set("navigator", { userAgent: "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X)" });
  const realNow = Date.now;
  Date.now = () => now;
  try {
    tick();
    assert.equal(ui.haptic(), true);
  } finally { Date.now = realNow; }
  const label = made.find((n) => n.tag === "label");
  const input = made.find((n) => n.tag === "input");
  assert.equal(input.type, "checkbox");
  assert.ok("switch" in input.attrs, "a switch: Safari answers its toggle with the Taptic Engine");
  assert.equal(label.style.display, "none");
  assert.equal(label.attrs["aria-hidden"], "true");
  assert.equal(label.clicked, 1);
  assert.equal(label.removed, true, "gone again at once");
  for (const t of ["click", "change", "input"]) assert.ok(label.listeners[t] && input.listeners[t], `its ${t} stops at the label`);
});

// a tiny shell: #app, #view (scrolled), #top-title, the page's name
function shell({ scrollTop = 0, title = "", titleWidth = 120, nameBottom = 300 } = {}) {
  const app = { classList: classes() };
  const t = { textContent: title, attrs: {}, getAttribute(k) { return this.attrs[k] ?? null; }, setAttribute(k, v) { this.attrs[k] = v; }, removeAttribute(k) { delete this.attrs[k]; }, getBoundingClientRect: () => ({ width: titleWidth }) };
  const name = nameBottom === null ? null : { textContent: "  Sam Sample ", getClientRects: () => [1], getBoundingClientRect: () => ({ bottom: nameBottom }) };
  const v = { scrollTop, querySelector: (sel) => (/rs-name/.test(sel) ? name : null), getBoundingClientRect: () => ({ top: 60 }) };
  set("document", { getElementById: (id) => ({ app, view: v, "top-title": t })[id] || null });
  return { app, t, v };
}

test("scrollEdge: the bar separates once something is under it; an empty bar takes the page's name once it has gone under", () => {
  let s = shell({ scrollTop: 0 });
  ui.scrollEdge();
  assert.equal(s.app.classList.has("scrolled"), false);
  assert.equal(s.app.classList.has("peek"), false);
  s = shell({ scrollTop: 40, nameBottom: 120 });
  ui.scrollEdge();
  assert.equal(s.app.classList.has("scrolled"), true);
  assert.equal(s.app.classList.has("peek"), false, "the name is still in sight");
  s = shell({ scrollTop: 260, nameBottom: 20 });
  ui.scrollEdge();
  assert.equal(s.app.classList.has("peek"), true);
  assert.equal(s.t.getAttribute("data-peek"), "Sam Sample");
  // a title drawn for screen readers only (the customer page) counts as empty
  s = shell({ scrollTop: 260, nameBottom: 20, title: "Sam Sample", titleWidth: 1 });
  ui.scrollEdge();
  assert.equal(s.app.classList.has("peek"), true);
  // a bar with its own title shown never peeks
  s = shell({ scrollTop: 260, nameBottom: 20, title: "Quote SQ-0002" });
  ui.scrollEdge();
  assert.equal(s.app.classList.has("peek"), false);
  assert.equal(s.t.getAttribute("data-peek"), null);
  // back at the top: the name leaves the bar
  s = shell({ scrollTop: 260, nameBottom: 20 });
  ui.scrollEdge();
  s.v.scrollTop = 0;
  s.v.querySelector = () => ({ textContent: "Sam Sample", getClientRects: () => [1], getBoundingClientRect: () => ({ bottom: 300 }) });
  ui.scrollEdge();
  assert.equal(s.app.classList.has("peek"), false);
  assert.equal(s.t.getAttribute("data-peek"), null);
});

// a number drawn as text inside markup: <span class="hm-mbig"><span class="sr">Collected, </span>$3,815</span>
function bigNumber(text = "$3,815") {
  const sr = { data: "Collected, ", parentElement: { closest: () => ({}) } };
  const num = { data: text, isConnected: true, parentElement: { closest: () => null } };
  const el = { style: { minWidth: "" }, classList: classes(), getBoundingClientRect: () => ({ width: 120 }) };
  set("document", { createTreeWalker: () => { const list = [sr, num]; let i = -1; return { nextNode: () => list[++i] || null }; } });
  return { el, num, sr };
}

test("countUpText: the number's own text counts up from $0 once per key; Reduce Motion draws it at once", () => {
  ui._countedReset();
  // reduced motion: untouched, and counted (no count later on a repaint)
  keep("window", "Element", "requestAnimationFrame", "getComputedStyle", "performance");
  globalThis.window = { matchMedia: () => ({ matches: true }) };
  let b = bigNumber();
  assert.equal(ui.countUpText(b.el, { key: "t-money" }), false);
  assert.equal(b.num.data, "$3,815");
  // motion: starts at $0, the markup around it kept, the screen-reader words untouched
  globalThis.window = { matchMedia: () => ({ matches: false }) };
  class El {}
  El.prototype.animate = () => ({});
  globalThis.Element = El;
  const frames = [];
  globalThis.requestAnimationFrame = (f) => frames.push(f);
  globalThis.getComputedStyle = () => ({ display: "block" });
  let clock = 0;
  Object.defineProperty(globalThis, "performance", { value: { now: () => clock }, configurable: true, writable: true });
  set("document", { ...globalThis.document, visibilityState: "visible" });
  b = bigNumber();
  globalThis.document.visibilityState = "visible";
  assert.equal(ui.countUpText(b.el, { key: "t-money-2" }), true);
  assert.equal(b.num.data, "$0");
  assert.equal(b.sr.data, "Collected, ");
  assert.equal(b.el.style.minWidth, "120px", "its box keeps the final width while it counts");
  clock = 300;
  frames.shift()();
  assert.match(b.num.data, /^\$[\d,]+$/);
  assert.ok(Number(b.num.data.replace(/[$,]/g, "")) > 0 && Number(b.num.data.replace(/[$,]/g, "")) < 3815);
  clock = 700;
  frames.shift()();
  assert.equal(b.num.data, "$3,815", "ends on the number as drawn");
  assert.equal(b.el.style.minWidth, "");
  // once per key: the next paint draws it at once
  const again = bigNumber();
  globalThis.document.visibilityState = "visible";
  assert.equal(ui.countUpText(again.el, { key: "t-money-2" }), false);
  assert.equal(again.num.data, "$3,815");
  // no number yet (still loading "…"): nothing, and the key waits for the real one
  const dots = bigNumber("…");
  globalThis.document.visibilityState = "visible";
  assert.equal(ui.countUpText(dots.el, { key: "t-money-3" }), false);
  const real = bigNumber("$1,250.50");
  globalThis.document.visibilityState = "visible";
  assert.equal(ui.countUpText(real.el, { key: "t-money-3" }), true);
  assert.equal(real.num.data, "$0.00", "cents keep their two places");
});

test("router fitTitle: a large title with no room beside its buttons gets its own line; one that fits stays", () => {
  const app = { classList: classes() };
  app.classList.add("big-top");
  const t = { textContent: "Customers", scrollWidth: 148, clientWidth: 98 };
  set("document", { getElementById: (id) => ({ app, "top-title": t })[id] || null });
  set("matchMedia", (q) => ({ matches: /max-width: 899px/.test(q) }));
  set("requestAnimationFrame", (f) => f());
  router.fitTitle();
  assert.equal(app.classList.has("title-own"), true, "never Cus...");
  t.scrollWidth = 90;
  router.fitTitle();
  assert.equal(app.classList.has("title-own"), false);
  // a deeper screen (no large title) or Home (its own header) never moves its title
  t.scrollWidth = 400;
  app.classList.remove("big-top");
  router.fitTitle();
  assert.equal(app.classList.has("title-own"), false);
  app.classList.add("big-top");
  app.classList.add("own-head");
  router.fitTitle();
  assert.equal(app.classList.has("title-own"), false);
  // a desk: never
  app.classList.remove("own-head");
  set("matchMedia", () => ({ matches: false }));
  router.fitTitle();
  assert.equal(app.classList.has("title-own"), false);
});

test("crm.css premium: iOS's switch, the frosted toast, the hairline, the scroll edge; all of it still off under reduced motion", () => {
  assert.ok(PREMIUM.length > 500, "the premium section is there");
  assert.match(PREMIUM, /\.switch::before\{[^}]*width:51px;height:31px/, "the 51 x 31 track");
  assert.match(PREMIUM, /\.switch::after\{[^}]*width:27px;height:27px/, "the 27 px knob");
  assert.match(PREMIUM, /\.switch:not\(:disabled\):active::after\{width:33px\}/, "the knob stretches while pressed");
  assert.match(PREMIUM, /\.toast\{[^}]*backdrop-filter:[^}]*blur/, "a frosted toast");
  assert.match(PREMIUM, /@media \(min-resolution:2dppx\)\{:root\{--hair:\.5px\}\}/, "true hairlines on a Retina screen");
  assert.match(PREMIUM, /\.app\.scrolled \.top\{box-shadow:0 var\(--hair\) 0 var\(--bar-hair\)\}/);
  assert.match(PREMIUM, /\.app\.big-top\.title-own \.top-title\{order:20;flex:0 0 100%/);
  assert.match(PREMIUM, /caret-color:var\(--coral\)/);
  assert.match(PREMIUM, /-webkit-touch-callout:none;-webkit-user-select:none;user-select:none/);
  // transitions and animations of the section: transform, opacity, scale, colors, a shadow or a width; never top/left/height
  for (const m of PREMIUM.matchAll(/transition:([^;}]+)/g)) assert.doesNotMatch(m[1], /\b(top|left|height|margin|padding)\b/, m[1]);
  // the reduced-motion rule (above it) still covers everything, pseudo-elements included
  assert.match(CSS, /@media \(prefers-reduced-motion:reduce\)\{\s*\*,\*::before,\*::after\{animation:none!important;transition:none!important\}/);
  assert.ok(CSS.indexOf("prefers-reduced-motion:reduce") > 0);
  // the card stack and the picture fade are motion only: Reduce Motion keeps the page where it is
  const deep = PREMIUM.slice(PREMIUM.indexOf("@media (max-width:899px) and (prefers-reduced-motion:no-preference){"));
  assert.ok(deep.length > 100, "a motion-only block");
  assert.match(deep.slice(0, deep.indexOf("\n}")), /body\.sheet-deep \.app\{transform:[^}]*scale\(\.94\)/);
  assert.match(deep.slice(0, deep.indexOf("\n}")), /img\[data-house\]:not\(\.ld\)\{opacity:0\}/);
  assert.doesNotMatch(PREMIUM, /\u2014/, "no em dash");
});
