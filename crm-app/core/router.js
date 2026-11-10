// Barta CRM client: the hash router (design §2.3, §2.4, §9.1).
//
// Routes come from the module manifests ({ path, load, title, perm,
// parent }); paths are hashes inside the frame (#/team/us_...). A screen
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

import { html, render, delegate, closeTopSheet, toast, sheet, icon } from "./ui.js";

const routes = [];
let stack = [];
let current = null;          // { path, route, params, mod, state }
let offEvents = null;
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
  window.addEventListener("hashchange", onHash);
  onHash();
}

const view = () => document.getElementById("view");

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

async function show(path, { keepScroll = false } = {}) {
  const my = ++token;
  const v = view();
  if (!v) return;
  if (current && current.path) {
    const k = keep.get(current.path) || {};
    k.scrollTop = v.scrollTop;
    keep.set(current.path, k);
  }
  if (offEvents) { offEvents(); offEvents = null; }
  if (current && current.mod && current.mod.unmount) { try { current.mod.unmount(); } catch (e) { /* ignore */ } }
  let m = match(path);
  if (!m) { m = match("/today"); path = "/today"; }
  if (!m) return;
  const { route, params } = m;
  if (route.perm && !env.can(route.perm)) {
    current = { path, route, params, mod: null };
    header(route.title, canGoBack(), null);
    render(v, html`<div class="stack"><div class="card empty"><div class="art">${icon("shield")}</div><h2>Not for this login</h2><p>Ask an owner if you need this.</p></div></div>`);
    env.onRoute(path);
    return;
  }
  current = { path, route, params, mod: null };
  header(route.title, canGoBack(), null);
  if (!keepScroll) { v.classList.remove("flush"); render(v, skeleton(route.skeleton)); }
  env.onRoute(path);
  let mod, state;
  const ctx = screenCtx(path, params);
  try {
    mod = (await route.load()).default;
    if (my !== token) return;
    state = mod.load ? await mod.load(params, ctx) : {};
  } catch (e) {
    if (my !== token) return;
    if (e && e.status === 401) return;
    render(v, errorView(e));
    const btn = v.querySelector("[data-retry]");
    if (btn) btn.addEventListener("click", () => show(path));
    return;
  }
  if (my !== token) return;
  current = { path, route, params, mod, state, ctx };
  ctx.state = state;
  ctx.rerender = () => paint();
  const title = typeof mod.title === "function" ? mod.title(state, ctx) : mod.title || route.title;
  const paint = () => {
    v.classList.toggle("flush", !!mod.flush);
    render(v, mod.render(ctx.state, ctx));
    const act = mod.action ? mod.action(ctx.state, ctx) : null;
    header(title, canGoBack(), act);
    if (mod.mount) mod.mount(v, ctx.state, ctx);
  };
  paint();
  if (mod.events) {
    const wrapped = {};
    for (const [k, fn] of Object.entries(mod.events)) wrapped[k] = (e, el) => fn(e, el, ctx);
    offEvents = delegate(v, wrapped);
  }
  const k = keep.get(path);
  v.scrollTop = (keepScroll || wentBack) && k ? k.scrollTop || 0 : 0;
  wentBack = false;
  if (!keepScroll) { try { v.focus({ preventScroll: true }); } catch (e) { /* old Safari */ } }
}
