// Barta CRM client: the hash router (design §2.3, §2.4, §9.1).
//
// Routes come from the module manifests ({ path, load, title, perm,
// parent }; title may be a function of the signed-in person, so one path
// reads "Home" for the office and "Today" for a tech); paths are hashes
// inside the frame (#/team/us_...). A screen
// module default-exports
//   { title?, load(params, ctx) → state, render(state, ctx) → html``,
//     events?: { "click [data-act=x]": (event, el, ctx) => ... },
//     mount?(viewEl, state, ctx), unmount?(), action?(state, ctx) → { label, run } }
//
// Back navigation (home-screen apps on iOS have no browser back): the
// router keeps its own stack of CRM routes, in step with the hash entries
// so Android's system back still works. back() pops that stack; when it is
// empty (a deep link, a notification) it goes to the route's declared
// `parent` with replace, never history.back() past the first CRM entry. A
// sheet that is open closes first. List screens get their scroll position
// (and anything they put in ctx.keep) back when you return to them. Every
// route change is posted to the office shell (crm:route) so /office#crm/...
// mirrors it.
//
// List + detail on wide screens (§9.1): a list route that says `split:
// true` (Contacts, Quotes) stays on the left, in #view, while the screens
// under it (a contact, a quote, a new one) open in #pane beside it, the
// list keeping its search and scroll and lighting the open row. Under
// 1000 px (a phone) every screen is the whole view, as always.

import { html, render, delegate, closeTopSheet, toast, sheet, icon } from "./ui.js";

const routes = [];
let stack = [];
let current = null;          // the screen in focus: { path, route, params, mod, state, ctx, el, off }
let anchor = null;           // on a wide screen, the list beside it (in #view): the same shape
let token = 0;
let pendingReplace = null;
let wentBack = false;
const keep = new Map();      // path → { scrollTop, ...screen's own state }
let env = { can: () => true, isTabRoot: () => false, onRoute: () => {}, api: null, user: null };

const compile = (r, module) => {
  const names = [];
  const re = new RegExp("^" + r.path.split("/").map((s) => (s.startsWith(":") ? (names.push(s.slice(1)), "([^/]+)") : s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))).join("/") + "/?$");
  return { ...r, module, re, names };
};

export function register(manifests) {
  for (const m of manifests) for (const r of m.routes || []) routes.push(compile(r, m.name));
  const params = (r) => r.path.split(":").length - 1;
  routes.sort((a, b) => params(a) - params(b) || b.path.length - a.path.length);
}
export function configure(opts) { env = { ...env, ...opts }; }

export function match(path) {
  for (const r of routes) {
    const m = r.re.exec(path);
    if (m) {
      const params = {};
      r.names.forEach((n, i) => { try { params[n] = decodeURIComponent(m[i + 1]); } catch (e) { params[n] = m[i + 1]; } });
      return { route: r, params };
    }
  }
  return null;
}
export const has = (path) => !!match(path);

const fill = (pattern, params) => pattern.replace(/:([a-z_]+)/gi, (_, n) => encodeURIComponent(params[n] ?? ""));
const parse = () => {
  let h = location.hash.slice(1);
  try { h = decodeURI(h); } catch (e) { /* keep as is */ }
  if (!h || h === "/") return "/today";
  return h.startsWith("/") ? h.split("?")[0] : "/" + h;
};

export const currentPath = () => (current ? current.path : parse());
export const depth = () => stack.length;

// A path and its parents, nearest first: ["/team/us_..", "/team", "/today"].
export function chain(path) {
  const out = [path];
  let m = match(path);
  let guard = 0;
  while (m && m.route.parent && guard++ < 10) {
    const p = fill(m.route.parent, m.params);
    out.push(p);
    m = match(p);
  }
  return out;
}
// The tab a path belongs to: the top of its parent chain.
export const rootOf = (path) => { const c = chain(path); return c[c.length - 1]; };

export function go(path, { replace = false } = {}) {
  if (replace) { pendingReplace = path; location.replace("#" + path); }
  else if (location.hash.slice(1) !== path) location.hash = path;
  else show(path);
}

export function back() {
  if (closeTopSheet()) return;
  if (stack.length > 1) { history.back(); return; }
  if (!current) return;
  const parent = current.route && current.route.parent ? fill(current.route.parent, current.params) : null;
  if (parent && parent !== current.path) { stack = []; go(parent, { replace: true }); }
}
// Tab roots never show a back arrow (§9.1); other screens do when there is
// somewhere to go: the stack, or the declared parent.
export const canGoBack = () => !!current && !env.isTabRoot(current.path) && (stack.length > 1 || !!(current.route && current.route.parent));

export function refresh() { if (current) show(current.path, { keepScroll: true }); }

function onHash() {
  const path = parse();
  if (pendingReplace && path === pendingReplace) {
    pendingReplace = null;
    if (stack.length) stack[stack.length - 1] = path; else stack.push(path);
  } else if (stack.length >= 2 && stack[stack.length - 2] === path) {
    stack.pop();
    wentBack = true;
  } else if (stack[stack.length - 1] !== path) {
    stack.push(path);
  }
  if (stack.length > 50) stack = stack.slice(-50);
  show(path);
}

export function start() {
  // #view and, beside it on a wide screen, #pane (list + detail) in one row
  const v = view();
  if (v && !paneEl()) {
    const main = document.createElement("div");
    main.className = "main";
    main.id = "main";
    v.parentNode.insertBefore(main, v);
    main.appendChild(v);
    const pane = document.createElement("section");
    pane.id = "pane";
    pane.className = "view pane";
    pane.tabIndex = -1;
    pane.hidden = true;
    pane.setAttribute("aria-label", "Details");
    main.appendChild(pane);
  }
  window.addEventListener("hashchange", onHash);
  onHash();
}

const view = () => document.getElementById("view");
const paneEl = () => document.getElementById("pane");
export const SPLIT_MEDIA = "(min-width: 1000px)";
const wide = () => typeof matchMedia === "function" && matchMedia(SPLIT_MEDIA).matches && !!paneEl();
// The list a path opens beside on a wide screen: itself when it is a split
// list, else its nearest ancestor that is one; null on a phone.
// (A list this person may not open is no list: a tech's own contact opens alone.)
function splitOf(path, m) {
  if (!wide()) return null;
  const open = (r) => !!r.split && (!r.perm || env.can(r.perm) === true);
  if (m.route.split) return open(m.route) ? path : null;
  for (const p of chain(path).slice(1)) { const pm = match(p); if (pm && pm.route.split) return open(pm.route) ? p : null; }
  return null;
}
const routeTitle = (route) => (typeof route.title === "function" ? route.title(env.user || {}) : route.title);

function header(title, showBack, act) {
  const t = document.getElementById("top-title");
  const b = document.getElementById("top-back");
  const a = document.getElementById("top-act");
  if (t) t.textContent = title || "Barta CRM";
  if (b) b.hidden = !showBack;
  if (a) {
    render(a, act ? html`<button type="button" class="btn primary" id="top-action">${act.label}</button>` : html``);
    const btn = document.getElementById("top-action");
    if (btn && act) btn.addEventListener("click", () => act.run());
  }
  document.title = (title ? title + " · " : "") + "Barta CRM";
}

function screenCtx(path, params, extra = {}) {
  const k = keep.get(path) || {};
  keep.set(path, k);
  return {
    params, path, api: env.api, user: env.user, can: env.can, go, back, refresh, toast, sheet, keep: k,
    ...extra,
  };
}

// What a screen shows while it loads: a skeleton, never a spinner (§9.4).
// A route may declare skeleton: "list" (rows, for list screens); the
// default is a card.
export function skeleton(kind = "card") {
  const lines = html`<span class="sk h"></span><span class="sk w90"></span><span class="sk w70"></span>`;
  if (kind === "list") {
    const row = html`<li class="sk-row"><span class="sk dot"></span><span class="sk-lines"><span class="sk w50"></span><span class="sk w30"></span></span></li>`;
    return html`<div class="skel" aria-busy="true" aria-label="Loading"><span class="sk h"></span><ul class="list">${[row, row, row, row, row]}</ul></div>`;
  }
  return html`<div class="skel" aria-busy="true" aria-label="Loading"><div class="card">${lines}</div><div class="card"><span class="sk w70"></span><span class="sk w50"></span></div></div>`;
}

const errorView = (e) => html`<div class="stack"><div class="card empty"><div class="art">${icon("shield")}</div><h2>${e && e.code === "offline" ? "No connection" : "That didn't load"}</h2><p>${(e && e.message) || "Try again in a minute."}</p><div class="btn-row"><button type="button" class="btn primary" data-retry>Try again</button></div></div></div>`;

function teardown(rec) {
  if (!rec) return;
  if (rec.off) { rec.off(); rec.off = null; }
  if (rec.mod && rec.mod.unmount) { try { rec.mod.unmount(); } catch (e) { /* ignore */ } }
}
const notForLogin = () => html`<div class="stack"><div class="card empty"><div class="art">${icon("shield")}</div><h2>Not for this login</h2><p>Ask an owner if you need this.</p></div></div>`;

// Loads one screen into an element. The focus screen (the one the address
// names) owns the header, the back arrow and the route message; the list
// beside it on a wide screen (focus: false) only draws itself.
async function mountScreen(el, path, m, { my, focus = true, keepScroll = false }) {
  const { route, params } = m;
  const rec = { path, route, params, mod: null, el, off: null };
  if (focus) current = rec;
  if (route.perm && !env.can(route.perm)) {
    el.classList.remove("flush");
    render(el, notForLogin());
    if (focus) { header(routeTitle(route), canGoBack(), null); env.onRoute(path); }
    return rec;
  }
  if (focus) header(routeTitle(route), canGoBack(), null);
  const v = el;
  if (!keepScroll) { v.classList.remove("flush"); render(v, skeleton(route.skeleton)); }
  if (focus) env.onRoute(path);
  let mod, state;
  const ctx = screenCtx(path, params);
  try {
    mod = (await route.load()).default;
    if (my !== token) return null;
    state = mod.load ? await mod.load(params, ctx) : {};
  } catch (e) {
    if (my !== token) return null;
    if (e && e.status === 401) return null;
    render(el, errorView(e));
    const btn = el.querySelector("[data-retry]");
    if (btn) btn.addEventListener("click", () => show(currentPath()));
    return rec;
  }
  if (my !== token) return null;
  Object.assign(rec, { mod, state, ctx });
  if (focus) current = rec;
  ctx.state = state;
  ctx.rerender = () => paint();
  const title = typeof mod.title === "function" ? mod.title(state, ctx) : mod.title || routeTitle(route);
  const paint = () => {
    el.classList.toggle("flush", !!mod.flush);
    render(el, mod.render(ctx.state, ctx));
    if (focus || current === rec) header(typeof mod.title === "function" ? mod.title(ctx.state, ctx) : title, canGoBack(), mod.action ? mod.action(ctx.state, ctx) : null);
    if (mod.mount) mod.mount(el, ctx.state, ctx);
  };
  paint();
  if (mod.events) {
    const wrapped = {};
    for (const [k, fn] of Object.entries(mod.events)) wrapped[k] = (e, x) => fn(e, x, ctx);
    rec.off = delegate(el, wrapped);
  }
  const k = keep.get(path);
  el.scrollTop = (keepScroll || wentBack) && k ? k.scrollTop || 0 : 0;
  if (focus) {
    wentBack = false;
    if (!keepScroll) { try { el.focus({ preventScroll: true }); } catch (e) { /* old Safari */ } }
  }
  return rec;
}

// The open row of the list beside a detail is lit.
function markOpen(path) {
  const v = view();
  if (!v) return;
  for (const a of v.querySelectorAll('a[aria-current="true"]')) a.removeAttribute("aria-current");
  if (!path) return;
  for (const a of v.querySelectorAll("a[href]")) if (a.getAttribute("href") === "#" + path) a.setAttribute("aria-current", "true");
}

async function show(path, { keepScroll = false } = {}) {
  const my = ++token;
  const v = view();
  if (!v) return;
  let m = match(path);
  if (!m) { m = match("/today"); path = "/today"; }
  if (!m) return;
  const pane = paneEl();
  const listPath = splitOf(path, m);
  // where the leaving screen was scrolled
  if (current && current.path) {
    const k = keep.get(current.path) || {};
    k.scrollTop = (current.el || v).scrollTop;
    keep.set(current.path, k);
  }
  // the list stays when the next screen opens beside the same list (unless it is what's refreshed)
  const stay = !!listPath && !!anchor && anchor.path === listPath && !(keepScroll && current === anchor && path === listPath);
  if (current && !(stay && current === anchor)) teardown(current);
  if (anchor && !stay) { if (anchor !== current) teardown(anchor); anchor = null; }
  const app = document.getElementById("app");
  if (!listPath) {
    if (app) app.classList.remove("split");
    if (pane && !pane.hidden) { pane.hidden = true; render(pane, html``); }
    anchor = null;
    await mountScreen(v, path, m, { my, keepScroll });
    return;
  }
  if (app) app.classList.add("split");
  pane.hidden = false;
  if (!stay) {
    const lm = match(listPath);
    anchor = null;
    const rec = await mountScreen(v, listPath, lm, { my, focus: path === listPath, keepScroll: keepScroll && current && current.path === listPath });
    if (!rec) return;
    anchor = rec;
  } else if (path === listPath) {
    current = anchor;
    header(typeof anchor.mod?.title === "function" ? anchor.mod.title(anchor.state, anchor.ctx) : (anchor.mod && anchor.mod.title) || routeTitle(anchor.route), canGoBack(), anchor.mod && anchor.mod.action ? anchor.mod.action(anchor.state, anchor.ctx) : null);
    env.onRoute(path);
  }
  if (path === listPath) {
    pane.classList.remove("flush");
    const what = String(routeTitle(anchor.route) || "the list").toLowerCase();
    render(pane, html`<div class="pane-empty"><div class="art">${icon("list")}</div><p>${`Pick one of the ${what} to see it here.`}</p></div>`);
    markOpen(null);
    return;
  }
  await mountScreen(pane, path, m, { my, keepScroll });
  if (my === token) markOpen(path);
}

// Crossing 1000 px (a window resized, an iPad turned) draws the screen again.
if (typeof matchMedia === "function") {
  try { matchMedia(SPLIT_MEDIA).addEventListener("change", () => { if (current) show(current.path, { keepScroll: true }); }); } catch (e) { /* old Safari */ }
}
