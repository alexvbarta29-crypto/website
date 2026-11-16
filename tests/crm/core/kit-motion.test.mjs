// Motion and the light default (Nov 2026, the owner: "a little more premium animations" and "make
// it white, not black"): core/ui.js's motion helpers move things only when the phone allows it
// (prefers-reduced-motion: nothing at all, the page exactly as drawn), screens move once on a route
// change and never on a repaint, the stylesheet's motion is quick and off under reduced motion, and
// core/nav.js makes Light the default and moves an old Dark to Light once.
import { test, afterEach } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const ui = await import("../../../crm-app/core/ui.js");
const nav = await import("../../../crm-app/core/nav.js");
const CSS = readFileSync("crm-app/styles/crm.css", "utf8");

// a tiny page: window.matchMedia, document, Element.prototype.animate (recorded), a clock
let calls = [];
let clock = 0;
const saved = {};
function page({ reduce = false, hidden = false } = {}) {
  for (const k of ["window", "document", "Element", "innerWidth", "innerHeight", "requestAnimationFrame", "getComputedStyle"]) if (!(k in saved)) saved[k] = Object.getOwnPropertyDescriptor(globalThis, k);
  calls = [];
  clock = 1000;
  class El {}
  El.prototype.animate = function (frames, opts) { calls.push({ el: this, frames, opts }); return { onfinish: null }; };
  globalThis.Element = El;
  globalThis.window = { matchMedia: (q) => ({ matches: reduce && /prefers-reduced-motion: reduce/.test(q) }) };
  globalThis.document = { visibilityState: hidden ? "hidden" : "visible", body: { appendChild() {} }, createElement: () => node() };
  globalThis.innerWidth = 390;
  globalThis.innerHeight = 844;
  globalThis.requestAnimationFrame = () => 0;
  globalThis.getComputedStyle = () => ({ display: "block" });
  Object.defineProperty(globalThis, "performance", { value: { now: () => clock }, configurable: true, writable: true });
  return El;
}
// an element: children, a box, classes; `fixed` holds something position:fixed (a sticky step)
function node({ children = [], top = 0, height = 60, fixed = false, item = false } = {}) {
  const El = globalThis.Element;
  const n = Object.create(El.prototype);
  const cls = new Set();
  Object.assign(n, {
    children, isConnected: true, textContent: "", style: { setProperty() {} }, dataset: {},
    classList: { add: (c) => cls.add(c), remove: (c) => cls.delete(c), has: (c) => cls.has(c) },
    matches: () => false,
    querySelector: (sel) => (fixed && /rs-cta/.test(sel) ? {} : null),
    querySelectorAll: () => (item ? children : []),
    getBoundingClientRect: () => ({ top, bottom: top + height, height, width: 300, left: 0 }),
  });
  return n;
}
afterEach(() => {
  for (const [k, d] of Object.entries(saved)) { if (d) Object.defineProperty(globalThis, k, d); else delete globalThis[k]; }
  for (const k of Object.keys(saved)) delete saved[k];
});

test("reduced motion: motionOk() is false and every helper leaves the page exactly as drawn", () => {
  page({ reduce: true });
  assert.equal(ui.motionOk(), false);
  const view = node({ children: [node(), node()] });
  ui.screenGo(view, "push");
  assert.equal(view.__mo, null, "nothing to carry on");
  ui.screenPainted(view);
  ui.screenOut(view);
  assert.equal(ui.riseIn(node({ item: true, children: [node(), node()] })), 0);
  const on = node();
  assert.equal(ui.segSlide(on, { left: 100, width: 80 }), false);
  const n = node();
  ui._countedReset();
  ui.countUp(n, 12480, { format: (x) => "$" + Math.round(x) });
  assert.equal(n.textContent, "$12480", "the final number at once");
  let gone = false;
  ui.toastOut({ isConnected: true, remove: () => { gone = true; }, classList: { add() {} } });
  assert.equal(gone, true, "a toast just goes");
  assert.deepEqual(calls, [], "element.animate was never called");
  // no Web Animations, or a hidden page: the same
  page();
  delete globalThis.Element.prototype.animate;
  assert.equal(ui.motionOk(), false);
  page({ hidden: true });
  assert.equal(ui.motionOk(), false);
  // and on a server (no window): nothing
  for (const k of ["window", "document"]) delete globalThis[k];
  assert.equal(ui.motionOk(), false);
});

test("a route change moves the new screen once: push from the right, back from the left, a tab crossfades; a repaint moves nothing", () => {
  page();
  assert.equal(ui.motionOk(), true);
  const sticky = node({ fixed: true });
  const view = node({ children: [node(), sticky] });
  ui.screenGo(view, "push");
  assert.equal(calls.length, 2);
  assert.deepEqual(calls[0].frames, [{ opacity: 0, transform: "translateX(24px)" }, { opacity: 1, transform: "none" }], "in from the right, a little");
  assert.deepEqual(calls[1].frames, [{ opacity: 0 }, { opacity: 1 }], "a screen holding a fixed bar only fades (a transform would move the bar)");
  assert.ok(calls.every((c) => c.opts.duration >= 150 && c.opts.duration <= 280), "quick");
  // the content comes 100 ms later: it carries on from where the skeleton was, and its rows rise
  calls = [];
  clock += 100;
  view.children = [node()];
  ui.screenPainted(view);
  assert.equal(calls[0].opts.delay, -100, "carried on, not started again");
  // a repaint after the move: nothing
  calls = [];
  clock += 500;
  ui.screenPainted(view);
  ui.screenPainted(view);
  assert.deepEqual(calls, [], "a rerender or a poll never moves anything");
  assert.equal(view.__mo, null);
  // back and a tab
  ui.screenGo(view, "pop");
  assert.equal(calls[0].frames[0].transform, "translateX(-16px)");
  calls = [];
  ui.screenGo(view, "tab");
  assert.deepEqual(calls[0].frames, [{ opacity: 0 }, { opacity: 1 }], "a tab crossfades");
  // a refresh: still
  ui.screenStill(view);
  calls = [];
  ui.screenPainted(view);
  assert.deepEqual(calls, []);
});

test("riseIn: the rows in sight rise one after another (the first 12), the ones below the fold don't", () => {
  page();
  const rows = Array.from({ length: 30 }, (_, i) => node({ top: i * 64 }));
  const list = node({ item: true, children: rows });
  const n = ui.riseIn(list);
  assert.equal(n, 12, "at most 12");
  assert.deepEqual(calls.slice(0, 3).map((c) => c.opts.delay), [40, 68, 96], "28 ms apart");
  assert.ok(calls.every((c) => c.opts.fill === "backwards"), "hidden until their turn, nothing left behind after");
  calls = [];
  assert.equal(ui.riseIn(node({ item: true, children: rows.map((r, i) => node({ top: 900 + i * 64 })) })), 0, "nothing in sight: nothing moves");
});

test("countUp counts once per key; segSlide sets where the pill came from", () => {
  page();
  ui._countedReset();
  const a = node();
  ui.countUp(a, 2500, { key: "home-arr" });
  assert.equal(a.textContent, "0", "starts at 0 (then climbs, a frame at a time)");
  assert.ok(a.classList.has("mo-count"), "tabular figures while it counts");
  const b = node();
  ui.countUp(b, 2500, { key: "home-arr" });
  assert.equal(b.textContent, "2500", "the same number drawn again (a poll): no count");
  const on = node();
  const props = {};
  on.style.setProperty = (k, v) => { props[k] = v; };
  Object.defineProperty(on, "offsetWidth", { get: () => 80 });
  assert.equal(ui.segSlide(on, { left: 100, width: 150 }), true);
  assert.deepEqual(props, { "--seg-dx": "100px", "--seg-sw": "0.5" });
  assert.ok(on.classList.has("seg-slide"));
  assert.equal(ui.segSlide(node(), { left: 0, width: 300 }), false, "the same place: nothing");
});

test("crm.css: the motion is quick, transform and opacity, and off under reduced motion (pseudo-elements too)", () => {
  const motion = CSS.slice(CSS.indexOf("motion (Nov 2026"));
  assert.ok(motion.length > 500, "the motion section");
  for (const [, ms] of motion.matchAll(/--t-(?:fast|mid|slow):(\d+)ms/g)) assert.ok(+ms >= 150 && +ms <= 280, `${ms} ms`);
  assert.match(motion, /\.sheet\.on\{transition:transform var\(--t-slow\) var\(--ease-spring\)\}/, "sheets spring up");
  assert.match(motion, /--ease-spring:cubic-bezier\(\.2,1\.22,\.38,1\)/, "a slight overshoot");
  for (const [, body] of motion.matchAll(/@keyframes [\w-]+\{([^@]*?)\}\}/g)) assert.doesNotMatch(body, /(width|height|top|left|margin|padding):/, "keyframes move transform and opacity only");
  const reduce = motion.slice(motion.indexOf("@media (prefers-reduced-motion:reduce)"));
  assert.match(reduce, /\*,\*::before,\*::after\{animation:none!important;transition:none!important\}/);
  assert.match(CSS, /\.toast\.out\{/);
  assert.doesNotMatch(motion, /—/);
});

test("Light is the default; a Dark from before is moved to Light once, then the phone's own choice stays; Automatic is kept", () => {
  const store = new Map();
  const had = Object.getOwnPropertyDescriptor(globalThis, "localStorage");
  globalThis.localStorage = { getItem: (k) => (store.has(k) ? store.get(k) : null), setItem: (k, v) => store.set(k, String(v)), removeItem: (k) => store.delete(k) };
  try {
    assert.equal(nav.DEFAULT_THEME, "light");
    assert.equal(nav.CANVAS.light, "#f6f6f8");
    nav._resetThemeMove();
    assert.equal(nav.themeChoice(), "light", "a new phone: Light");
    assert.equal(store.get(nav.THEME_MOVED_KEY), "1");
    // a phone that picked Dark before
    store.clear();
    store.set(nav.THEME_KEY, "dark");
    nav._resetThemeMove();
    assert.equal(nav.themeChoice(), "light", "moved to Light");
    assert.equal(store.get(nav.THEME_KEY), "light");
    // ... once: Dark picked again is kept (this page and the next)
    nav.setTheme("dark");
    assert.equal(nav.themeChoice(), "dark");
    nav._resetThemeMove();
    assert.equal(nav.themeChoice(), "dark", "its own choice, kept");
    // Automatic and Light from before stay as they were
    for (const v of ["auto", "light"]) {
      store.clear();
      store.set(nav.THEME_KEY, v);
      nav._resetThemeMove();
      assert.equal(nav.themeChoice(), v);
    }
    assert.equal(nav.resolveTheme("auto", false), "light");
    assert.equal(nav.resolveTheme("auto", true), "dark");
    // a browser that keeps nothing: Light
    globalThis.localStorage = { getItem: () => { throw new Error("blocked"); }, setItem: () => { throw new Error("blocked"); } };
    nav._resetThemeMove();
    assert.equal(nav.themeChoice(), "light");
  } finally {
    if (had) Object.defineProperty(globalThis, "localStorage", had); else delete globalThis.localStorage;
    nav._resetThemeMove();
  }
});
