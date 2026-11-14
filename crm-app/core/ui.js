// Barta CRM client: building the screen safely (design §2.3, §0 rule 7).
//
// html`...` is the only way screens make markup. It escapes every
// interpolation by where it lands (text, a quoted attribute value) and
// refuses anything that could run script:
//   - an on* attribute (onclick=...) or srcdoc, in the template or from attrs();
//   - a <script> tag in a template;
//   - an interpolation outside text or a quoted attribute value (a value in
//     an attribute-name position could add an onclick), unless it is an
//     attrs() / openExternal() object;
//   - an href/src/action that is javascript:, data: (except data:image in
//     src), another origin, or a portal page (/p/...), unless it came from
//     openExternal(url), which renders target="_blank" rel="noopener".
// tel:, sms: and mailto: links stay in the frame.
//
// Also: raw() (trusted static markup such as icons), render(), delegate(),
// toast(), sheet() (✕ button, swipe down, Escape), confirmSheet(),
// openExternal(), attrs() and the icon set.
//
// And the Rotor-style kit (Nov 2026, at the end of this file; the API for
// the screen tracks is scratchpad simplify/kit-api.md): rnd(), statusPill(),
// pillBtn(), seg(), cardHead(), sectionLabel(), statGrid(), contactRows(),
// personCard(), addressCard(), lineItems(), notesBox(), disclosure(),
// formRow(), toggle(), quickRow(), actionSheet() and sheetPage(). Each
// returns html`` (actionSheet and sheetPage open a sheet); what a tap does is
// the screen's own events on the data-* the helper puts there.

import { money as fmtMoney } from "./format.js";

const SAFE = Symbol("crm-safe-html");
const ATTRS = Symbol("crm-attrs");
const EXTERNAL = Symbol("crm-external");

class SafeHtml {
  constructor(s) { this.__html = s; this[SAFE] = true; }
  toString() { return this.__html; }
}
const isSafe = (v) => !!v && v[SAFE] === true;
const isAttrs = (v) => !!v && v[ATTRS] === true;

const ESC = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;", "`": "&#96;" };
export const escapeHtml = (s) => String(s ?? "").replace(/[&<>"'`]/g, (c) => ESC[c]);

export const raw = (s) => new SafeHtml(String(s ?? ""));

export class UnsafeHtml extends Error {}
const refuse = (why) => { throw new UnsafeHtml("html: " + why); };

const URL_ATTRS = new Set(["href", "src", "action", "formaction", "xlink:href", "poster", "cite", "data", "background"]);
const BANNED_ATTRS = new Set(["srcdoc"]);
const checkName = (name) => {
  const n = name.toLowerCase();
  if (n.startsWith("on")) refuse(`inline handlers (${n}) are not allowed; use delegate()`);
  if (BANNED_ATTRS.has(n)) refuse(`${n} is not allowed`);
  return n;
};

// A URL a page may link or load without openExternal(). A path is judged
// by where the browser would really go: it is resolved against the shell's
// own address (/crm, and /crm/ to be safe) and must stay on this origin
// and off the portal (/p/...), whatever its spelling ("/\\evil.example",
// "//evil.example", "/./p/x", "/crm/../p/x", "/%2e/p/x", "p/x", "/%70/x").
// A backslash is refused outright: browsers read it as a slash.
const HOME = "https://crm.invalid";
const BASES = [HOME + "/crm", HOME + "/crm/"];
const PORTAL = /^\/p(\/|$)/i;
function staysHome(u) {
  for (const base of BASES) {
    let r;
    try { r = new URL(u, base); } catch (e) { return false; }
    if (r.origin !== HOME) return false;
    let path = r.pathname;
    try { path = decodeURIComponent(path).replace(/\/{2,}/g, "/"); } catch (e) { return false; }
    if (PORTAL.test(r.pathname) || PORTAL.test(path) || /(^|\/)\.\.?(\/|$)/.test(path)) return false;
  }
  return true;
}
export function isSafeUrl(url, attr = "href") {
  const u = String(url ?? "").trim();
  if (u === "") return true;
  if (/[\u0000-\u001f\u007f\\]/.test(u)) return false;
  if (u.startsWith("#")) return true;
  const scheme = /^([a-z][a-z0-9+.-]*):/i.exec(u);
  if (!scheme) return staysHome(u);                             // a path: where does it really go?
  const s = scheme[1].toLowerCase();
  if (attr === "href" && ["tel", "sms", "mailto"].includes(s)) return true;
  if (attr === "src" && (s === "blob" || /^data:image\/(png|jpe?g|webp|gif);/i.test(u))) return true;
  return false;                                                  // javascript:, data:, vbscript:, http(s) to anywhere
}

// Attributes as one interpolation in a tag: html`<button ${attrs({ disabled: busy })}>`.
export function attrs(obj) {
  const parts = [];
  for (const [k, v] of Object.entries(obj || {})) {
    if (v === false || v === null || v === undefined) continue;
    const name = checkName(k);
    if (!/^[a-z][a-z0-9:_.-]*$/.test(name)) refuse(`bad attribute name ${k}`);
    if (v === true) { parts.push(name); continue; }
    if (URL_ATTRS.has(name) && !isSafeUrl(v, name)) refuse(`unsafe ${name}`);
    parts.push(`${name}="${escapeHtml(v)}"`);
  }
  return { [ATTRS]: true, __html: parts.join(" ") };
}

// A link that leaves the CRM: a new tab (never inside the frame), or for a
// maps:/geo: style scheme the phone hands to an app, the top window
// (main.js handles data-external="top").
export function openExternal(url) {
  const u = String(url ?? "").trim();
  const scheme = (/^([a-z][a-z0-9+.-]*):/i.exec(u) || [])[1];
  const s = scheme ? scheme.toLowerCase() : "";
  if (s === "https" || s === "http" || u.startsWith("/p/")) {
    return { [ATTRS]: true, [EXTERNAL]: true, __html: `href="${escapeHtml(u)}" target="_blank" rel="noopener"` };
  }
  if (["maps", "geo", "comgooglemaps", "waze"].includes(s)) {
    return { [ATTRS]: true, [EXTERNAL]: true, __html: `href="${escapeHtml(u)}" data-external="top"` };
  }
  refuse("openExternal takes an http(s), portal or maps link");
}

// ------------------------------------------------------------ the template

const T_TEXT = 0, T_TAGNAME = 1, T_TAG = 2, T_ATTR = 3, T_AFTER = 4, T_BEFORE = 5, T_DQ = 6, T_SQ = 7, T_UNQ = 8, T_COMMENT = 9, T_CLOSE = 10;
const WS = /\s/;
const NAME_CH = /[A-Za-z0-9:_.-]/;

function closeAttr(st) {
  if (st.attr && URL_ATTRS.has(st.attr) && !st.dynamicSafe && !isSafeUrl(st.val, st.attr)) refuse(`unsafe ${st.attr} "${String(st.val).slice(0, 40)}"; use openExternal()`);
  st.attr = "";
  st.val = "";
  st.dynamicSafe = false;
}

function scan(st, str) {
  for (let i = 0; i < str.length; i++) {
    const c = str[i];
    switch (st.s) {
      case T_TEXT:
        if (c === "<") {
          if (str.startsWith("!--", i + 1)) { st.s = T_COMMENT; st.cbuf = ""; i += 3; }
          else if (str[i + 1] === "/") { st.s = T_CLOSE; i += 1; }
          else if (/[A-Za-z]/.test(str[i + 1] || "")) { st.s = T_TAGNAME; st.tag = ""; }
        }
        break;
      case T_TAGNAME:
        if (NAME_CH.test(c)) st.tag += c.toLowerCase();
        else {
          if (st.tag === "script") refuse("no <script> in templates");
          if (c === ">") st.s = T_TEXT; else st.s = T_TAG;
        }
        break;
      case T_CLOSE:
        if (c === ">") st.s = T_TEXT;
        break;
      case T_TAG:
        if (WS.test(c) || c === "/") break;
        if (c === ">") { st.s = T_TEXT; break; }
        st.s = T_ATTR; st.name = c;
        break;
      case T_ATTR:
        if (NAME_CH.test(c)) { st.name += c; break; }
        st.attr = checkName(st.name);
        if (c === "=") st.s = T_BEFORE;
        else if (c === ">") { st.s = T_TEXT; st.attr = ""; }
        else if (WS.test(c)) st.s = T_AFTER;
        else { st.s = T_TAG; st.attr = ""; }
        break;
      case T_AFTER:
        if (WS.test(c)) break;
        if (c === "=") { st.s = T_BEFORE; break; }
        st.attr = "";
        if (c === ">") { st.s = T_TEXT; break; }
        if (c === "/") { st.s = T_TAG; break; }
        st.s = T_ATTR; st.name = c;
        break;
      case T_BEFORE:
        if (WS.test(c)) break;
        if (c === '"') { st.s = T_DQ; st.val = ""; break; }
        if (c === "'") { st.s = T_SQ; st.val = ""; break; }
        if (c === ">") { closeAttr(st); st.s = T_TEXT; break; }
        st.s = T_UNQ; st.val = c;
        break;
      case T_DQ:
        if (c === '"') { closeAttr(st); st.s = T_TAG; } else st.val += c;
        break;
      case T_SQ:
        if (c === "'") { closeAttr(st); st.s = T_TAG; } else st.val += c;
        break;
      case T_UNQ:
        if (WS.test(c)) { closeAttr(st); st.s = T_TAG; }
        else if (c === ">") { closeAttr(st); st.s = T_TEXT; }
        else st.val += c;
        break;
      case T_COMMENT:
        st.cbuf += c;
        if (st.cbuf.endsWith("-->")) st.s = T_TEXT;
        break;
    }
  }
}

function textValue(v) {
  if (v === null || v === undefined || v === false || v === true) return "";
  if (isSafe(v)) return v.__html;
  if (isAttrs(v)) refuse("attributes outside a tag");
  if (Array.isArray(v)) return v.map(textValue).join("");
  return escapeHtml(v);
}

export function html(strings, ...values) {
  const st = { s: T_TEXT, tag: "", name: "", attr: "", val: "", dynamicSafe: false, cbuf: "" };
  let out = "";
  for (let i = 0; i < strings.length; i++) {
    const s = strings[i];
    scan(st, s);
    out += s;
    if (i >= values.length) break;
    const v = values[i];
    switch (st.s) {
      case T_TEXT: out += textValue(v); break;
      case T_DQ: case T_SQ: {
        if (isSafe(v) || isAttrs(v) || Array.isArray(v)) refuse(`markup inside the ${st.attr} attribute`);
        const str = v === null || v === undefined || v === false ? "" : String(v);
        if (st.attr && st.attr.startsWith("on")) refuse("inline handlers are not allowed");
        st.val += str;
        out += escapeHtml(str);
        break;
      }
      case T_TAG: case T_AFTER:
        if (v === null || v === undefined || v === false || v === "") break;
        if (!isAttrs(v)) refuse("only attrs() or openExternal() may go inside a tag");
        out += v.__html;
        break;
      default:
        refuse("an interpolation must be text or a quoted attribute value");
    }
  }
  if (st.s !== T_TEXT) {
    if (st.s === T_COMMENT) refuse("unclosed comment");
  }
  return new SafeHtml(out);
}

// ------------------------------------------------------------ DOM helpers

export function render(el, safe) {
  if (!el) return;
  if (!isSafe(safe)) throw new UnsafeHtml("render() takes html`` output");
  el.innerHTML = safe.__html;
}

// delegate(root, { "click [data-act=save]": (event, el) => ... }) → off()
export function delegate(root, events, thisArg) {
  const offs = [];
  for (const [spec, fn] of Object.entries(events || {})) {
    const sp = spec.indexOf(" ");
    const type = sp < 0 ? spec : spec.slice(0, sp);
    const sel = sp < 0 ? null : spec.slice(sp + 1).trim();
    const h = (e) => {
      const t = sel ? (e.target && e.target.closest ? e.target.closest(sel) : null) : root;
      if (!t || (sel && !root.contains(t))) return;
      fn.call(thisArg, e, t);
    };
    root.addEventListener(type, h, type === "focus" || type === "blur");
    offs.push(() => root.removeEventListener(type, h, type === "focus" || type === "blur"));
  }
  return () => offs.forEach((o) => o());
}

export function toast(message, { bad = false, ms = 2600 } = {}) {
  const box = typeof document !== "undefined" && document.getElementById("toasts");
  if (!box) return;
  const t = document.createElement("div");
  t.className = "toast" + (bad ? " bad" : "");
  t.textContent = String(message);
  t.setAttribute("role", bad ? "alert" : "status");
  // one at a time: a newer toast replaces the one showing (a stack covers the buttons)
  while (box.firstChild) box.removeChild(box.firstChild);
  box.appendChild(t);
  setTimeout(() => t.remove(), ms);
}

// ------------------------------------------------------------ sheets

const open = [];

// sheet({ title, body: html``, onClose, events, className, headEnd }) → { el, body, close }
// (className: extra classes on the sheet, "rs-actions" or "rs-sheetpage";
// headEnd: html`` between the title and the ✕, a Done pill)
export function sheet({ title = "", body = raw(""), onClose, events, className = "", headEnd = null } = {}) {
  const layer = document.getElementById("layer") || document.body;
  const back = document.createElement("div");
  back.className = "backdrop";
  const el = document.createElement("section");
  el.className = "sheet" + (className ? " " + className : "");
  el.setAttribute("role", "dialog");
  el.setAttribute("aria-modal", "true");
  el.tabIndex = -1;
  render(el, html`<div class="grab" aria-hidden="true"></div><div class="sheet-head"><h2>${title}</h2>${headEnd || ""}<button type="button" class="sheet-x" data-sheet-x aria-label="Close">✕</button></div><div class="sheet-body"></div>`);
  const bodyEl = el.querySelector(".sheet-body");
  render(bodyEl, body);
  layer.appendChild(back);
  layer.appendChild(el);
  const prevFocus = document.activeElement;
  let closed = false;
  const off = events ? delegate(el, events) : () => {};
  const api = {
    el, body: bodyEl,
    set(content) { render(bodyEl, content); },
    close() {
      if (closed) return;
      closed = true;
      off();
      el.classList.remove("on");
      back.classList.remove("on");
      const i = open.indexOf(api);
      if (i >= 0) open.splice(i, 1);
      setTimeout(() => { el.remove(); back.remove(); }, 260);
      if (prevFocus && prevFocus.focus) { try { prevFocus.focus({ preventScroll: true }); } catch (e) { /* gone */ } }
      if (onClose) onClose();
    },
  };
  back.addEventListener("click", () => api.close());
  el.querySelector("[data-sheet-x]").addEventListener("click", () => api.close());
  // swipe down to close (from the handle/header, or the body when scrolled to the top)
  let y0 = null, dy = 0;
  el.addEventListener("touchstart", (e) => {
    const fromHead = e.target.closest(".grab, .sheet-head");
    if (!fromHead && bodyEl.scrollTop > 0) { y0 = null; return; }
    y0 = e.touches[0].clientY; dy = 0;
  }, { passive: true });
  el.addEventListener("touchmove", (e) => {
    if (y0 === null) return;
    dy = Math.max(0, e.touches[0].clientY - y0);
    if (dy > 0) { el.style.transition = "none"; el.style.transform = `translateY(${dy}px)`; }
  }, { passive: true });
  el.addEventListener("touchend", () => {
    if (y0 === null) return;
    el.style.transition = "";
    el.style.transform = "";
    if (dy > 80) api.close();
    y0 = null; dy = 0;
  });
  open.push(api);
  requestAnimationFrame(() => { back.classList.add("on"); el.classList.add("on"); try { el.focus({ preventScroll: true }); } catch (e) { /* old Safari */ } });
  return api;
}

export const sheetOpen = () => open.length > 0;
// Closes the top sheet; true when there was one (the router's back() asks first).
export function closeTopSheet() {
  const s = open[open.length - 1];
  if (!s) return false;
  s.close();
  return true;
}
if (typeof document !== "undefined") {
  document.addEventListener("keydown", (e) => { if (e.key === "Escape" && closeTopSheet()) e.preventDefault(); });
}

// A yes/no question in a sheet → Promise<boolean>.
export function confirmSheet(text, { title = "Are you sure?", yes = "Yes", no = "Cancel", danger = false } = {}) {
  return new Promise((resolve) => {
    let answered = false;
    const s = sheet({
      title,
      body: html`<p class="muted">${text}</p><div class="btn-row"><button type="button" class="btn" data-a="no">${no}</button><button type="button" class="btn ${danger ? "danger" : "primary"}" data-a="yes">${yes}</button></div>`,
      onClose: () => { if (!answered) resolve(false); },
      events: { "click [data-a]": (e, b) => { answered = true; resolve(b.dataset.a === "yes"); s.close(); } },
    });
  });
}

// ------------------------------------------------------------ icons (static, trusted)

const svg = (d) => raw(`<svg viewBox="0 0 24 24" aria-hidden="true" focusable="false">${d}</svg>`);
export const ICONS = {
  today: svg('<rect x="3.5" y="5" width="17" height="15.5" rx="3"/><path d="M3.5 10h17M8 3v4M16 3v4"/><circle cx="12" cy="15" r="1.6"/>'),
  inbox: svg('<path d="M4 6.5A2.5 2.5 0 0 1 6.5 4h11A2.5 2.5 0 0 1 20 6.5v8a2.5 2.5 0 0 1-2.5 2.5H10l-4.5 3.5V17H6.5A2.5 2.5 0 0 1 4 14.5z"/>'),
  contacts: svg('<circle cx="12" cy="8.5" r="3.5"/><path d="M5 20c.8-3.6 3.6-5.5 7-5.5s6.2 1.9 7 5.5"/>'),
  schedule: svg('<rect x="3.5" y="5" width="17" height="15.5" rx="3"/><path d="M3.5 10h17M8 3v4M16 3v4M8 14h3M8 17h6"/>'),
  more: svg('<circle cx="5.5" cy="12" r="1.7"/><circle cx="12" cy="12" r="1.7"/><circle cx="18.5" cy="12" r="1.7"/>'),
  time: svg('<circle cx="12" cy="12" r="8.5"/><path d="M12 7.5V12l3 2"/>'),
  pay: svg('<rect x="3" y="6" width="18" height="12.5" rx="2.5"/><circle cx="12" cy="12.2" r="2.6"/><path d="M6.5 9.5v.01M17.5 15v.01"/>'),
  me: svg('<circle cx="12" cy="8.5" r="3.5"/><path d="M5 20c.8-3.6 3.6-5.5 7-5.5s6.2 1.9 7 5.5"/>'),
  team: svg('<circle cx="9" cy="9" r="3"/><path d="M3.5 19c.6-3 2.8-4.6 5.5-4.6s4.9 1.6 5.5 4.6"/><circle cx="17" cy="9.5" r="2.4"/><path d="M15.5 14.6c2.6-.3 4.4 1.2 5 4.4"/>'),
  plus: svg('<path d="M12 5v14M5 12h14"/>'),
  key: svg('<circle cx="8" cy="15" r="4"/><path d="M11 12l8-8M16 7l2 2M14 9l2 2"/>'),
  out: svg('<path d="M14 4h4.5A1.5 1.5 0 0 1 20 5.5v13a1.5 1.5 0 0 1-1.5 1.5H14"/><path d="M10 8l-4 4 4 4M6 12h10"/>'),
  phone: svg('<path d="M6.6 3.5h2.6l1.4 4-2 1.5a12 12 0 0 0 6.4 6.4l1.5-2 4 1.4v2.6a2 2 0 0 1-2.2 2A16 16 0 0 1 4.6 5.7a2 2 0 0 1 2-2.2z"/>'),
  list: svg('<path d="M8 6.5h12M8 12h12M8 17.5h12M4 6.5h.01M4 12h.01M4 17.5h.01"/>'),
  shield: svg('<path d="M12 3l7.5 3v5.5c0 4.5-3.2 8-7.5 9.5-4.3-1.5-7.5-5-7.5-9.5V6z"/><path d="M9 12l2 2 4-4"/>'),
  sun: svg('<circle cx="12" cy="12" r="4"/><path d="M12 2.5v2M12 19.5v2M4.6 4.6 6 6M18 18l1.4 1.4M2.5 12h2M19.5 12h2M4.6 19.4 6 18M18 6l1.4-1.4"/>'),
  share: svg('<path d="M12 3v12M8 7l4-4 4 4"/><path d="M8 11H6.5A1.5 1.5 0 0 0 5 12.5v7A1.5 1.5 0 0 0 6.5 21h11a1.5 1.5 0 0 0 1.5-1.5v-7a1.5 1.5 0 0 0-1.5-1.5H16"/>'),
  copy: svg('<rect x="8" y="8" width="12" height="12" rx="2.5"/><path d="M16 8V5.5A1.5 1.5 0 0 0 14.5 4h-9A1.5 1.5 0 0 0 4 5.5v9A1.5 1.5 0 0 0 5.5 16H8"/>'),
  search: svg('<circle cx="11" cy="11" r="7"/><path d="m20 20-3.5-3.5"/>'),
  back: svg('<path d="M15 5l-7 7 7 7"/>'),
  bell: svg('<path d="M6 16.5V11a6 6 0 1 1 12 0v5.5l1.5 2H4.5z"/><path d="M10 20.5a2 2 0 0 0 4 0"/>'),
  gear: svg('<circle cx="12" cy="12" r="3"/><path d="M10.3 3.2h3.4l.5 2.4 1.5.7 2.1-1.3 2.4 2.4-1.3 2.1.7 1.5 2.4.5v3.4l-2.4.5-.7 1.5 1.3 2.1-2.4 2.4-2.1-1.3-1.5.7-.5 2.4h-3.4l-.5-2.4-1.5-.7-2.1 1.3-2.4-2.4 1.3-2.1-.7-1.5-2.4-.5v-3.4l2.4-.5.7-1.5-1.3-2.1 2.4-2.4 2.1 1.3 1.5-.7z"/>'),
  bolt: svg('<path d="M13 2.5 5 13.5h6l-1 8 8-11h-6z"/>'),
  doc: svg('<path d="M7 3h7l4 4v14H7z"/><path d="M14 3v4h4M9.5 12h6M9.5 15.5h6"/>'),
  send: svg('<path d="M4 12 20 4l-5 16-3.5-6.5z"/><path d="m11.5 13.5 3.5-3.5"/>'),
  clock: svg('<circle cx="12" cy="12" r="8.5"/><path d="M12 7.5V12l3 2"/>'),
  check: svg('<path d="m5 12.5 4.5 4.5L19 7.5"/>'),
  mail: svg('<rect x="3.5" y="5.5" width="17" height="13" rx="2.5"/><path d="m4 7 8 6 8-6"/>'),
  text: svg('<path d="M4 6.5A2.5 2.5 0 0 1 6.5 4h11A2.5 2.5 0 0 1 20 6.5v8a2.5 2.5 0 0 1-2.5 2.5H10l-4.5 3.5V17H6.5A2.5 2.5 0 0 1 4 14.5z"/><path d="M8 9h8M8 12h5"/>'),
  money: svg('<rect x="3" y="6" width="18" height="12.5" rx="2.5"/><circle cx="12" cy="12.2" r="2.6"/>'),
  pause: svg('<rect x="6.5" y="5" width="3.5" height="14" rx="1"/><rect x="14" y="5" width="3.5" height="14" rx="1"/>'),
  data: svg('<ellipse cx="12" cy="6" rx="7.5" ry="2.8"/><path d="M4.5 6v12c0 1.5 3.4 2.8 7.5 2.8s7.5-1.3 7.5-2.8V6M4.5 12c0 1.5 3.4 2.8 7.5 2.8s7.5-1.3 7.5-2.8"/>'),
  plug: svg('<path d="M9 3v5M15 3v5M6.5 8h11v3.5a5.5 5.5 0 0 1-11 0zM12 17v4"/>'),
  map: svg('<path d="M9 4 3.5 6v14L9 18l6 2 5.5-2V4L15 6z"/><path d="M9 4v14M15 6v14"/>'),
  chart: svg('<path d="M4 20h16"/><path d="M7 16v-5M12 16V7M17 16v-8"/>'),
  bulb: svg('<path d="M9 18h6M10 21h4"/><path d="M12 3a6 6 0 0 0-3.5 10.9c.6.5 1 1.2 1 2V16h5v-.1c0-.8.4-1.5 1-2A6 6 0 0 0 12 3z"/>'),
  cart: svg('<path d="M3 4h2.5l2.2 10.5a1.5 1.5 0 0 0 1.5 1.2h8.3a1.5 1.5 0 0 0 1.5-1.1L21 8H6.3"/><circle cx="10" cy="19.5" r="1.3"/><circle cx="17" cy="19.5" r="1.3"/>'),
  gift: svg('<rect x="4" y="9" width="16" height="11.5" rx="1.5"/><path d="M3 9h18v3.5H3zM12 9v11.5"/><path d="M12 9c-1.5-3.5-5-4-5.5-2S9 9 12 9zM12 9c1.5-3.5 5-4 5.5-2S15 9 12 9z"/>'),
  link: svg('<path d="M14 5h5v5M19 5l-8 8"/><path d="M18 14v4.5a1.5 1.5 0 0 1-1.5 1.5h-11A1.5 1.5 0 0 1 4 18.5v-11A1.5 1.5 0 0 1 5.5 6H10"/>'),
  building: svg('<rect x="5" y="3.5" width="14" height="17" rx="1.5"/><path d="M9 8h1.5M13.5 8H15M9 12h1.5M13.5 12H15M10.5 20.5v-4h3v4"/>'),
  home: svg('<path d="M4 10.5 12 4l8 6.5"/><path d="M6 9v10a1.5 1.5 0 0 0 1.5 1.5H10v-5.5h4v5.5h2.5A1.5 1.5 0 0 0 18 19V9"/>'),
  grid: svg('<rect x="4" y="4" width="6.5" height="6.5" rx="1.8"/><rect x="13.5" y="4" width="6.5" height="6.5" rx="1.8"/><rect x="4" y="13.5" width="6.5" height="6.5" rx="1.8"/><rect x="13.5" y="13.5" width="6.5" height="6.5" rx="1.8"/>'),
  sales: svg('<path d="M4 19.5h16"/><path d="M5.5 15.5l4.5-4.5 3.5 3 5.5-6.5"/><path d="M15 7.5h4v4"/>'),
  truck: svg('<path d="M3 6.5h11v9.5H3zM14 10h3.8l3.2 3.3V16H14"/><circle cx="7" cy="17.5" r="1.8"/><circle cx="17.5" cy="17.5" r="1.8"/>'),
  // the Nov 2026 phone shell (core/nav.js)
  menu: svg('<path d="M4 7h16M4 12h16M4 17h16"/>'),
  trophy: svg('<path d="M8 4h8v5a4 4 0 0 1-8 0z"/><path d="M8 6H5a3 3 0 0 0 3 4M16 6h3a3 3 0 0 1-3 4M12 13v4M8.5 20.5h7M10 17h4l.5 3.5h-5z"/>'),
  target: svg('<circle cx="12" cy="12" r="6.5"/><circle cx="12" cy="12" r="1.5"/><path d="M12 2.5v4M12 17.5v4M2.5 12h4M17.5 12h4"/>'),
  pipeline: svg('<rect x="4" y="4" width="6" height="6" rx="1.6"/><rect x="14" y="14" width="6" height="6" rx="1.6"/><path d="M7 10v3.5A2.5 2.5 0 0 0 9.5 16H14"/>'),
  filter: svg('<path d="M4 5h16l-6.2 7.6V19l-3.6-1.8v-4.6z"/>'),
  bug: svg('<rect x="7.5" y="7.5" width="9" height="12.5" rx="4.5"/><path d="M12 11v9M9 7.5A3 3 0 0 1 15 7.5M3.5 12h4M16.5 12h4M4.5 18l3-1.5M19.5 18l-3-1.5M4.5 7l3 1.5M19.5 7l-3 1.5"/>'),
  tabbar: svg('<rect x="3.5" y="5" width="17" height="14" rx="3"/><path d="M3.5 15h17M8 17h.01M12 17h.01M16 17h.01"/>'),
  swap: svg('<path d="M5 8.5h13l-3.5-3.5M19 15.5H6l3.5 3.5"/>'),
  close: svg('<path d="M6 6l12 12M18 6 6 18"/>'),
  trend: svg('<path d="M4 16.5l5-5 4 3.5 7-7.5"/><path d="M15 7.5h5v5"/>'),
  // the Nov 2026 look (Flyra's icons): the bar's calendar with its date, the + menu's, the theme's
  cal12: svg('<rect x="3.5" y="4.5" width="17" height="16" rx="2.5"/><path d="M3.5 9h17M8 2.8v3.4M16 2.8v3.4"/><path d="M8.6 13.2l1.4-1v5.6M13.3 13.4c.3-.8 1-1.2 1.7-1.2 1 0 1.6.7 1.6 1.5 0 .7-.4 1.2-1 1.8l-2.4 2.3h3.5" stroke-width="1.4"/>'),
  userplus: svg('<circle cx="10" cy="8" r="3.5"/><path d="M3.5 19.5c.7-3.4 3.3-5.2 6.5-5.2 1.3 0 2.5.3 3.5.9"/><circle cx="17.5" cy="17" r="3.8"/><path d="M17.5 15.2v3.6M15.7 17h3.6"/>'),
  receipt: svg('<path d="M7 3.5h10a1.5 1.5 0 0 1 1.5 1.5v15.5l-2.5-1.5-2.5 1.5-2.5-1.5-2.5 1.5-2.5-1.5V5A1.5 1.5 0 0 1 7 3.5z" transform="translate(-.5 0)"/><path d="M9 8.5h6M9 12h6M9 15.5h3.5"/>'),
  clipboard: svg('<rect x="5" y="4.5" width="14" height="16.5" rx="2.5"/><rect x="9" y="3" width="6" height="3.2" rx="1.2"/><path d="M9.5 10.5h5M9.5 13.5h5M9.5 16.5h3.5"/>'),
  hammer: svg('<path d="M13.5 6.5 4.8 15.2a1.8 1.8 0 0 0 2.5 2.5L16 9"/><path d="M11.5 4.5c2.8-1.2 5.5-.6 7.5 1.5l1.5 1.5-2.5 2.5-1.5-1.5-1.5 1.5-3-3 1.5-1.5z"/>'),
  moon: svg('<path d="M19.5 14.5A8 8 0 0 1 9.5 4.5a8 8 0 1 0 10 10z"/>'),
  auto: svg('<circle cx="12" cy="12" r="8.5"/><path d="M12 3.5v17a8.5 8.5 0 0 0 0-17z" fill="currentColor"/>'),
  chevdown: svg('<path d="m6 9 6 6 6-6"/>'),
  chevleft: svg('<path d="m15 6-6 6 6 6"/>'),
  chevright: svg('<path d="m9 6 6 6-6 6"/>'),
  archive: svg('<rect x="3.5" y="4.5" width="17" height="4.5" rx="1.2"/><path d="M5 9v9.5A1.5 1.5 0 0 0 6.5 20h11a1.5 1.5 0 0 0 1.5-1.5V9M10 13h4"/>'),
  call: svg('<path d="M6.6 3.5h2.6l1.4 4-2 1.5a12 12 0 0 0 6.4 6.4l1.5-2 4 1.4v2.6a2 2 0 0 1-2.2 2A16 16 0 0 1 4.6 5.7a2 2 0 0 1 2-2.2z"/>'),
  chat: svg('<path d="M5 5.5h14a1.5 1.5 0 0 1 1.5 1.5v9a1.5 1.5 0 0 1-1.5 1.5H10l-4.5 3v-3H5A1.5 1.5 0 0 1 3.5 16V7A1.5 1.5 0 0 1 5 5.5z"/>'),
  compose: svg('<path d="M11 4.5H6A1.5 1.5 0 0 0 4.5 6v12A1.5 1.5 0 0 0 6 19.5h12a1.5 1.5 0 0 0 1.5-1.5v-5"/><path d="M17.5 3.5a2 2 0 0 1 3 3L12 15l-4 1 1-4z"/>'),
  undo: svg('<path d="M9 14 4.5 9.5 9 5"/><path d="M4.5 9.5H15a5 5 0 0 1 0 10h-3"/>'),
  route: svg('<path d="M12 2.8 21.2 12 12 21.2 2.8 12z"/><path d="M9.5 14.5v-2.5a1.5 1.5 0 0 1 1.5-1.5h4M13 8.5l2 2-2 2"/>'),
  people: svg('<circle cx="8" cy="8.5" r="3"/><circle cx="16" cy="8.5" r="3"/><path d="M2.5 19c.5-3 2.8-4.6 5.5-4.6 1.6 0 3 .6 4 1.6 1-1 2.4-1.6 4-1.6 2.7 0 5 1.6 5.5 4.6"/>'),
  // the Rotor-style kit (Nov 2026): the pencil, directions, a place, help, a drag handle and the rest
  edit: svg('<path d="M4 20h4L19 9l-4-4L4 16z"/><path d="M13.5 6.5l4 4"/>'),
  nav: svg('<path d="M20 4 3.5 11l7 2.5L13 20.5z"/>'),
  pin: svg('<path d="M12 21s-6.5-6.2-6.5-11a6.5 6.5 0 0 1 13 0c0 4.8-6.5 11-6.5 11z"/><circle cx="12" cy="10" r="2.3"/>'),
  help: svg('<circle cx="12" cy="12" r="8.5"/><path d="M9.6 9.4a2.5 2.5 0 0 1 4.8 1c0 1.7-2.4 2.1-2.4 3.6M12 17.2v.01"/>'),
  drag: svg('<path d="M5 9h14M5 15h14"/>'),
  trash: svg('<path d="M5 7h14M10 7V4.5h4V7M7 7l1 13h8l1-13"/>'),
  flag: svg('<path d="M5 21V4h11l-2 4 2 4H5"/>'),
  minus: svg('<path d="M5 12h14"/>'),
  user: svg('<circle cx="12" cy="8" r="3.5"/><path d="M5 20a7 7 0 0 1 14 0"/>'),
  merge: svg('<path d="M6 4v5a4 4 0 0 0 4 4h8M14 9l4 4-4 4"/>'),
  cal: svg('<rect x="3.5" y="5" width="17" height="15.5" rx="3"/><path d="M3.5 10h17M8 3v4M16 3v4"/>'),
  camera: svg('<path d="M4 8.5A1.5 1.5 0 0 1 5.5 7h2.3l1.5-2.5h5.4L16.2 7h2.3A1.5 1.5 0 0 1 20 8.5v9a1.5 1.5 0 0 1-1.5 1.5h-13A1.5 1.5 0 0 1 4 17.5z"/><circle cx="12" cy="12.8" r="3.3"/>'),
  qr: svg('<rect x="4" y="4" width="6" height="6" rx="1"/><rect x="14" y="4" width="6" height="6" rx="1"/><rect x="4" y="14" width="6" height="6" rx="1"/><path d="M14 14h2.5v2.5H14zM17.5 17.5H20V20h-2.5zM14 20h1M20 14v1"/>'),
};
export const icon = (name) => ICONS[name] || raw("");


// ------------------------------------------------------------ the Rotor-style kit (Nov 2026)
//
// One look for every phone screen (styles/crm.css "the Rotor-style kit"):
// cards, round icon buttons, segmented tabs, pills, a stat card, contact
// rows with round actions, line items, a notes box, the "..." action sheet
// and full-height sheet pages. Markup only: a helper never takes a
// function, a tap is the screen's own events on the data-* it asks for
// (`data: { pick: "owner" }` puts data-pick="owner" there). Every control
// is a 44 px tap target (a 38 px round button sits in a 44 px box).

// { pick: "owner", "data-x": 1, off: false } → { "data-pick": "owner", "data-x": "1" }
export function dataOf(data) {
  const o = {};
  for (const [k, v] of Object.entries(data || {})) {
    if (v === false || v === null || v === undefined) continue;
    o[k.startsWith("data-") ? k : "data-" + k] = v === true ? "" : String(v);
  }
  return o;
}
const kitMoney = (v) => (typeof v === "number" || typeof v === "bigint" ? fmtMoney(v) : v ?? "");
const initialsOf = (name) => String(name || "").trim().split(/\s+/).filter(Boolean).slice(0, 2).map((w) => w[0].toUpperCase()).join("") || "?";
const asLink = (v) => (typeof v === "string" ? { href: v } : v || null);
const external = (u) => !/^(#|tel:|sms:|mailto:)/i.test(String(u || ""));

// A round icon button: rnd("edit", "Edit lead", { tone: "grey", sm: true, href | ext | data, badge }).
// tone: "" (white/dark circle with a soft shadow), "grey" (the inner fill), "red" (the call button),
// "coral" (the old coral +), "solid" (black in light, white in dark); sm: a 38 px circle in a 44 px box.
export function rnd(name, label, { tone = "", sm = false, href = null, ext = null, data = null, badge = 0, pressed, expanded, popup = false, disabled = false, id = null } = {}) {
  const cls = ["rnd", tone === "solid" ? "on" : tone, sm ? "sm" : ""].filter(Boolean).join(" ");
  const a = {
    class: cls, id, "aria-label": label, ...dataOf(data),
    "aria-pressed": pressed === undefined ? null : String(!!pressed),
    "aria-expanded": expanded === undefined ? null : String(!!expanded),
    "aria-haspopup": popup ? "dialog" : null,
  };
  const inner = html`${icon(name)}${badge ? html`<span class="badge">${badge > 99 ? "99+" : String(badge)}</span>` : ""}`;
  if (ext) return html`<a ${openExternal(ext)} ${attrs(a)}>${inner}</a>`;
  if (href) return html`<a ${attrs({ href, ...a })}>${inner}</a>`;
  return html`<button type="button" ${attrs({ ...a, disabled })}>${inner}</button>`;
}

// Status pills (Rotor's colours): the tone from the word, or given.
export const PILL_TONES = Object.freeze({
  booked: "blue", sent: "blue", scheduled: "blue", viewed: "blue", open: "blue", invoiced: "blue", quoted: "blue", new: "blue",
  active: "green", paid: "green", "paid in full": "green", signed: "green", approved: "green", done: "green", completed: "green", won: "green",
  "to book": "amber", pending: "amber", due: "amber", "part paid": "amber", "not invoiced": "amber", paused: "amber", "not signed": "amber",
  overdue: "red", lost: "red", declined: "red", cancelled: "red", void: "red", expired: "red",
  draft: "grey", archived: "grey", test: "grey",
  low: "grey", medium: "orange", high: "orange", "high priority": "orange",
});
export const pillTone = (label) => PILL_TONES[String(label || "").trim().toLowerCase()] || "grey";
const PILL_CLASS = { grey: "", orange: "fill-orange", solid: "ink", white: "wh", "fill-green": "fill-green", blue: "blue", green: "green", amber: "amber", red: "red" };
// statusPill("Booked") → a blue pill; statusPill("Olive Owner", "white"); tones: blue green amber red grey orange solid white fill-green
export function statusPill(label, tone = pillTone(label), { icon: ic = null } = {}) {
  const c = PILL_CLASS[tone] ?? "";
  return html`<span class="${"pill" + (c ? " " + c : "")}">${ic ? icon(ic) : ""}${label}</span>`;
}
// A pill that is also a button (the owner pill: pick an owner): a 44 px box around the 24 px pill.
export function pillTap(label, { tone = "white", icon: ic = null, href = null, data = null, aria = null } = {}) {
  const inner = statusPill(label, tone, { icon: ic });
  const a = { class: "rs-pilltap", "aria-label": aria, ...dataOf(data) };
  return href ? html`<a ${attrs({ href, ...a })}>${inner}</a>` : html`<button type="button" ${attrs(a)}>${inner}</button>`;
}

// A pill-shaped button: pillBtn("Visit", { icon: "plus", tone: "solid" }) ("+ Visit"); tone "grey"
// (default: "+ Item", "Create Invoice"), "solid" (black in light), "red"; wide: the whole row.
export function pillBtn(label, { icon: ic = null, tone = "grey", wide = false, href = null, ext = null, data = null, disabled = false, aria = null } = {}) {
  const a = { class: "rs-pb" + (tone && tone !== "grey" ? " " + tone : "") + (wide ? " wide" : ""), "aria-label": aria, ...dataOf(data) };
  const inner = html`${ic ? icon(ic) : ""}<span>${label}</span>`;
  if (ext) return html`<a ${openExternal(ext)} ${attrs(a)}>${inner}</a>`;
  if (href) return html`<a ${attrs({ href, ...a })}>${inner}</a>`;
  return html`<button type="button" ${attrs({ ...a, disabled })}>${inner}</button>`;
}

// Segmented tabs: seg([["details", "Details"], ["activity", "Activity"]], "details", { name: "tab" }).
// Items may be { key, label, count?, href? } (an href makes it a link, a route's own tabs). A tap is
// the screen's "click [data-seg=tab]" (el.dataset.key); arrow keys move along (ui.js, below).
// black: the plan editor's black "on" segment.
export function seg(items, on, { name = "tab", black = false, label = "" } = {}) {
  const list = (items || []).filter(Boolean).map((x) => (Array.isArray(x) ? { key: x[0], label: x[1] } : x));
  return html`<div class="${"rs-seg" + (black ? " black" : "")}" role="tablist" ${attrs({ "aria-label": label || null })}>${list.map((it) => {
    const sel = String(it.key) === String(on);
    const a = { class: "rs-seg-b", role: "tab", "aria-selected": sel ? "true" : "false", tabindex: sel ? "0" : "-1", "data-seg": name, "data-key": String(it.key) };
    const inner = html`<span class="rs-seg-t">${it.label}</span>${it.count !== undefined && it.count !== null ? html`<span class="n">${String(it.count)}</span>` : ""}`;
    return it.href ? html`<a ${attrs({ href: it.href, ...a })}>${inner}</a>` : html`<button type="button" ${attrs(a)}>${inner}</button>`;
  })}</div>`;
}

// A card's head: title left; right an optional count, a grey round pencil and a grey round +.
// cardHead("Quotes", { add: { label: "New quote", href: "#/quotes/new?contact=ct_..." }, count: "2 quotes" })
export function cardHead(title, { add = null, edit = null, count = null } = {}) {
  const btn = (name, o, fallback) => rnd(name, o.label || fallback, { tone: "grey", sm: true, href: o.href, ext: o.ext, data: o.data, popup: !!o.popup });
  return html`<div class="rs-ch"><h3>${title}</h3>${count !== null && count !== undefined && count !== "" ? html`<span class="rs-ch-n">${String(count)}</span>` : ""}<span class="rs-ch-end">${edit ? btn("edit", edit, "Edit") : ""}${add ? btn("plus", add, "Add") : ""}</span></div>`;
}

// The small caps label above a card ("CONTACT", "BILLING").
export const sectionLabel = (text) => html`<h2 class="rs-label">${text}</h2>`;

// The stat card: 3 columns, a caps label over the value, wrapping to more rows.
// statGrid([{ label: "Stage", value: "Quoted", href? | data?, tone?: "red"|"green", wide?: true }])
export function statGrid(items, { label = "" } = {}) {
  return html`<div class="rs-card rs-stat" ${attrs({ role: "group", "aria-label": label || null })}>${(items || []).filter(Boolean).map((c) => {
    const v = c.value === undefined || c.value === null || c.value === "" ? "-" : c.value;
    const inner = html`<span class="rs-stat-l">${c.label}</span><span class="${"rs-stat-v" + (c.tone ? " " + c.tone : "")}">${v}</span>`;
    const cls = "rs-stat-c" + (c.wide ? " wide" : "");
    if (c.href) return html`<a ${attrs({ class: cls, href: c.href, ...dataOf(c.data) })}>${inner}</a>`;
    if (c.data) return html`<button type="button" ${attrs({ class: cls, ...dataOf(c.data) })}>${inner}</button>`;
    return html`<div class="${cls}">${inner}</div>`;
  })}</div>`;
}

// Contact rows: a circle icon, a caps label and the value, then round buttons.
// contactRows([{ icon: "call", label: "Mobile", value: "(763) 555-0100", href?: "tel:...",
//   actions: [{ icon: "chat", label: "Text", href: "sms:..." }, { icon: "call", label: "Call", tone: "red", href: "tel:..." }] }])
// A row's value is a link (href, or ext for a page that leaves), a button (data) or plain text.
export function contactRows(rows, { card = true } = {}) {
  const one = (r) => {
    const v = html`<span class="rs-cl">${r.label}</span><span class="rs-cval">${r.value}</span>${r.sub ? html`<span class="rs-csub">${r.sub}</span>` : ""}`;
    const val = r.ext ? html`<a class="rs-cv" ${openExternal(r.ext)}>${v}</a>`
      : r.href ? html`<a ${attrs({ class: "rs-cv", href: r.href, ...dataOf(r.data) })}>${v}</a>`
        : r.data ? html`<button type="button" ${attrs({ class: "rs-cv", ...dataOf(r.data) })}>${v}</button>`
          : html`<span class="rs-cv">${v}</span>`;
    const acts = (r.actions || []).filter(Boolean).map((x) => rnd(x.icon, x.label, { tone: x.tone ?? "grey", sm: true, href: x.href, ext: x.ext, data: x.data, popup: !!x.popup }));
    return html`<li class="rs-crow"><span class="rs-ci" aria-hidden="true">${icon(r.icon || "doc")}</span>${val}${acts.length ? html`<span class="rs-acts">${acts}</span>` : ""}</li>`;
  };
  return html`<ul class="${card ? "rs-card rs-crows" : "rs-crows"}">${(rows || []).filter(Boolean).map(one)}</ul>`;
}

// The person card (job, visit, quote, invoice): initials, name and phone (tap: open the contact),
// a red round call and a grey round message. call/text: a tel:/sms: link, or { href | data }.
export function personCard({ name = "", sub = "", href = null, initials = null, call = null, text = null, actions = [] } = {}) {
  const who = html`<span class="rs-av" aria-hidden="true">${initials || initialsOf(name)}</span><span class="rs-pw"><span class="rs-pn">${name}</span>${sub ? html`<span class="rs-ps">${sub}</span>` : ""}</span>`;
  const c = asLink(call);
  const t = asLink(text);
  const more = (actions || []).filter(Boolean).map((x) => rnd(x.icon, x.label, { tone: x.tone ?? "grey", sm: true, href: x.href, ext: x.ext, data: x.data }));
  return html`<div class="rs-card rs-person">${href ? html`<a ${attrs({ class: "rs-pl", href })}>${who}</a>` : html`<span class="rs-pl">${who}</span>`}<span class="rs-acts">${c ? rnd("call", "Call " + name, { tone: "red", sm: true, href: c.href, data: c.data }) : ""}${t ? rnd("chat", "Text " + name, { tone: "grey", sm: true, href: t.href, data: t.data }) : ""}${more}</span></div>`;
}

// The address card: a pin circle, street over the town line (+ gate code), a round navigate
// (nav: a maps:/https: link that leaves, or { href | data }) and a round pencil (edit: { label, href | data }).
export function addressCard({ line1 = "", line2 = "", href = null, nav = null, edit = null } = {}) {
  const body = html`<span class="rs-ci" aria-hidden="true">${icon("pin")}</span><span class="rs-pw"><span class="rs-pn">${line1}</span>${line2 ? html`<span class="rs-ps">${line2}</span>` : ""}</span>`;
  const n = asLink(nav);
  const navBtn = !n ? "" : n.href && external(n.href) ? rnd("nav", "Directions", { tone: "grey", sm: true, ext: n.href }) : rnd("nav", "Directions", { tone: "grey", sm: true, href: n.href, data: n.data });
  const e = asLink(edit);
  return html`<div class="rs-card rs-addr">${href ? html`<a ${attrs({ class: "rs-pl", href })}>${body}</a>` : html`<span class="rs-pl">${body}</span>`}<span class="rs-acts">${navBtn}${e ? rnd("edit", e.label || "Edit the address", { tone: "grey", sm: true, href: e.href, data: e.data }) : ""}</span></div>`;
}

// Line items (job, quote, invoice, plan): each line's title with "2 × $5.00" under it and the
// amount right; a grey "+ Item" pill; Subtotal; discounts; "+ Add discount"; Total; "Paid in full";
// a wide grey pill (Create Invoice). Money: integer cents (formatted here) or a ready string.
// lineItems([{ title, qty, unit, amount, sub?, href? | data? }], { addItem: { label?, href | data },
//   addDiscount, subtotal, discounts: [{ label, amount, href? | data? }], total, totalLabel, paid: true | "Paid Jun 24",
//   cta: { label, href | data, tone? }, empty: "No lines yet" })
export function lineItems(lines, { addItem = null, addDiscount = null, subtotal = null, discounts = [], total = null, totalLabel = "Total", paid = false, cta = null, empty = "No lines yet." } = {}) {
  const list = (lines || []).filter(Boolean);
  const line = (l) => {
    const sub = l.sub !== undefined ? l.sub : l.qty !== undefined && l.unit !== undefined ? `${l.qty} × ${kitMoney(l.unit)}` : "";
    const inner = html`<span class="rs-li-a"><span class="rs-li-t">${l.title}</span>${sub ? html`<span class="rs-li-s">${sub}</span>` : ""}</span><span class="rs-li-m num">${kitMoney(l.amount)}</span>`;
    if (l.href) return html`<a ${attrs({ class: "rs-li", href: l.href, ...dataOf(l.data) })}>${inner}</a>`;
    if (l.data) return html`<button type="button" ${attrs({ class: "rs-li", ...dataOf(l.data) })}>${inner}</button>`;
    return html`<div class="rs-li">${inner}</div>`;
  };
  const add = (o, label) => { const x = asLink(o); return x ? pillBtn(x.label || label, { icon: "plus", href: x.href, data: x.data }) : ""; };
  const sums = [];
  if (subtotal !== null && subtotal !== undefined) sums.push(html`<div class="rs-li-sum"><span>Subtotal</span><span class="num">${kitMoney(subtotal)}</span></div>`);
  // a discount with href | data is a 44 px button (the job page: tap to change or remove it)
  for (const d of (discounts || []).filter(Boolean)) {
    const inner = html`<span>${d.label}</span><span class="num">${kitMoney(d.amount)}</span>`;
    sums.push(d.href ? html`<a ${attrs({ class: "rs-li-sum tap", href: d.href, ...dataOf(d.data) })}>${inner}</a>`
      : d.data ? html`<button type="button" ${attrs({ class: "rs-li-sum tap", ...dataOf(d.data) })}>${inner}</button>` : html`<div class="rs-li-sum">${inner}</div>`);
  }
  const c = asLink(cta);
  return html`<div class="rs-lines">${list.length ? html`<ul class="rs-li-list">${list.map((l) => html`<li>${line(l)}</li>`)}</ul>` : html`<p class="rs-empty">${empty}</p>`}
    ${addItem ? html`<div class="rs-li-add">${add(addItem, "Item")}</div>` : ""}${sums}
    ${addDiscount ? html`<div class="rs-li-add">${add(addDiscount, "Add discount")}</div>` : ""}
    ${total !== null && total !== undefined ? html`<div class="rs-li-tot"><span>${totalLabel}</span><span class="${"num" + (paid ? " paid" : "")}">${kitMoney(total)}</span></div>` : ""}
    ${paid ? html`<p class="rs-paid">${paid === true ? "Paid in full" : paid}</p>` : ""}
    ${c ? html`<div class="rs-li-cta">${pillBtn(c.label, { wide: true, tone: c.tone || "grey", href: c.href, data: c.data, icon: c.icon || null })}</div>` : ""}</div>`;
}

// The notes box: a grey inner box; the screen saves on "change [data-notes=crew]" (a textarea's
// change fires when it loses focus with new text).
export function notesBox(text, { name = "notes", label = "Notes", placeholder = "Add notes...", readonly = false, rows = 3 } = {}) {
  return html`<textarea class="rs-notes" ${attrs({ "data-notes": name, "aria-label": label, placeholder, readonly, rows: String(rows) })}>${text || ""}</textarea>`;
}

// A full-width card row with a chevron: disclosure("Sold by", { value: "Olive Owner", href }) → "Sold by · Olive Owner ›".
export function disclosure(label, { value = null, href = null, data = null, sub = null } = {}) {
  const inner = html`<span class="rs-dl"><span>${label}${value !== null && value !== undefined && value !== "" ? html` · <b>${value}</b>` : ""}</span>${sub ? html`<span class="rs-ds">${sub}</span>` : ""}</span><span class="chev" aria-hidden="true"></span>`;
  if (href) return html`<a ${attrs({ class: "rs-card rs-disc", href, ...dataOf(data) })}>${inner}</a>`;
  return html`<button type="button" ${attrs({ class: "rs-card rs-disc", ...dataOf(data) })}>${inner}</button>`;
}

// A form row (editors): label left (40%), the control right. formRows([...]) is the card they sit in.
export const formRow = (label, control, { hint = null } = {}) => html`<label class="rs-frow"><span class="rs-fl">${label}${hint ? html`<small>${hint}</small>` : ""}</span><span class="rs-fc">${control}</span></label>`;
export const formRows = (rows) => html`<div class="rs-card rs-frows">${(rows || []).filter(Boolean)}</div>`;
// An on/off switch (red when on inside a form row): toggle(on, { data: { autopay: "" }, label: "Auto-Pay" }).
export const toggle = (on, { data = null, label = null, disabled = false } = {}) => html`<button type="button" ${attrs({ class: "switch", role: "switch", "aria-checked": on ? "true" : "false", "aria-label": label, disabled, ...dataOf(data) })}></button>`;

// The labelled quick row (visit: Call · Navigate · Photos · Checklist; invoice: QR · Record · Card):
// 56 px round buttons with a label under each and an optional count badge.
export function quickRow(items) {
  return html`<div class="rs-qrow">${(items || []).filter(Boolean).map((q) => {
    const inner = html`<span class="rs-q-c">${icon(q.icon)}${q.badge ? html`<span class="badge">${String(q.badge)}</span>` : ""}</span><span class="rs-q-l">${q.label}</span>`;
    const a = { class: "rs-q" + (q.tone ? " " + q.tone : ""), ...dataOf(q.data) };
    if (q.ext) return html`<a ${openExternal(q.ext)} ${attrs(a)}>${inner}</a>`;
    if (q.href) return html`<a ${attrs({ href: q.href, ...a })}>${inner}</a>`;
    return html`<button type="button" ${attrs({ ...a, disabled: !!q.disabled })}>${inner}</button>`;
  })}</div>`;
}

// The "..." action sheet: actionSheet("Job S-000001", [[row, row], [row]]) → the sheet.
// A row: { label, icon?, hint?, run?() | href?, danger?, disabled?, data? } (data: the old data-*
// hook, kept on the row). Falsy rows are skipped (`cond && {...}`); red rows go last, in a group
// of their own. A tap closes the sheet, then runs run() (or follows href).
export function actionSheet(title, groups = [], { onClose } = {}) {
  const gs = (groups || []).map((g) => (Array.isArray(g) ? g : [g]).filter(Boolean));
  const calm = gs.map((g) => g.filter((r) => !r.danger)).filter((g) => g.length);
  const red = gs.flat().filter((r) => r.danger);
  const all = red.length ? [...calm, red] : calm;
  const flat = all.flat();
  let n = 0;
  const row = (r) => {
    const i = n++;
    const inner = html`<span class="rs-act-ic">${icon(r.icon || "chevright")}</span><span class="rs-act-l">${r.label}</span>${r.hint ? html`<span class="rs-act-h">${r.hint}</span>` : ""}`;
    const a = { class: "rs-act" + (r.danger ? " danger" : ""), "data-rs-i": String(i), ...dataOf(r.data) };
    if (r.href && !r.disabled) return html`<a ${attrs({ href: r.href, ...a })}>${inner}</a>`;
    return html`<button type="button" ${attrs({ ...a, disabled: !!r.disabled })}>${inner}</button>`;
  };
  const body = flat.length ? html`${all.map((g) => html`<ul class="rs-act-g">${g.map((r) => html`<li>${row(r)}</li>`)}</ul>`)}` : html`<p class="rs-empty">Nothing to do here.</p>`;
  const s = sheet({
    title, body, className: "rs-actions", onClose,
    events: {
      "click [data-rs-i]": (e, el) => {
        const r = flat[Number(el.dataset.rsI)];
        if (!r || r.disabled) return;
        s.close();
        if (r.run) { e.preventDefault(); r.run(e); }
      },
    },
  });
  return s;
}

// A full-height sheet page (plan editor, quote editor, Customize Tabs): grab bar, title, a red
// Done/Save pill, a segmented control on top. panes: { key: html`` } are all drawn once and shown
// one at a time (form fields keep what was typed across tabs); body: html`` or (key) => html``
// for a page without panes. done.run(page, key) → false keeps it open (a problem to fix).
// events: delegate() events on the sheet, called (event, el, page).
// → page: { el, body, key, show(key), set(html), close() }
export function sheetPage({ title = "", seg: sg = null, panes = null, body = null, done = null, events = {}, onClose } = {}) {
  let key = sg ? sg.on : null;
  const drawBody = () => (typeof body === "function" ? body(key) : body || raw(""));
  const draw = () => html`${sg ? seg(sg.items, key, { name: "sheet", black: !!sg.black, label: sg.label || title }) : ""}${panes
    ? Object.entries(panes).map(([k, v]) => html`<div class="rs-sp-pane" ${attrs({ "data-pane": k, hidden: sg && k !== String(key) })}>${v}</div>`)
    : html`<div class="rs-sp-pane">${drawBody()}</div>`}`;
  let page = null;
  const wrapped = {};
  for (const [k, fn] of Object.entries(events || {})) wrapped[k] = (e, el) => fn(e, el, page);
  const s = sheet({
    title, className: "rs-sheetpage", onClose,
    headEnd: done ? html`<button type="button" class="rs-done" data-sheet-done>${done.label || "Done"}</button>` : null,
    events: {
      ...wrapped,
      "click [data-seg=sheet]": (e, el) => { page.show(el.dataset.key); },
      "click [data-sheet-done]": async (e, el) => {
        if (el.disabled) return;
        el.disabled = true;
        let ok;
        try { ok = done && done.run ? await done.run(page, key) : true; } catch (err) { ok = false; toast((err && err.message) || "That didn't save.", { bad: true }); }
        el.disabled = false;
        if (ok !== false) s.close();
      },
    },
  });
  page = {
    el: s.el, body: s.body, close: s.close, set: s.set,
    get key() { return key; },
    show(k) {
      key = k;
      if (panes) {
        for (const b of s.el.querySelectorAll("[data-seg=sheet]")) { const on = b.dataset.key === String(k); b.setAttribute("aria-selected", on ? "true" : "false"); b.tabIndex = on ? 0 : -1; }
        for (const p of s.body.querySelectorAll("[data-pane]")) p.hidden = p.dataset.pane !== String(k);
      } else s.set(draw());
      if (sg && sg.onChange) sg.onChange(k, page);
    },
  };
  s.set(draw());
  return page;
}

// Arrow keys along segmented tabs (Left/Right, Home/End): the next one is picked and focused.
if (typeof document !== "undefined") {
  document.addEventListener("keydown", (e) => {
    const b = e.target && e.target.closest ? e.target.closest(".rs-seg-b") : null;
    if (!b || !["ArrowLeft", "ArrowRight", "Home", "End"].includes(e.key)) return;
    const all = [...b.parentElement.querySelectorAll(".rs-seg-b")];
    const i = all.indexOf(b);
    const j = e.key === "Home" ? 0 : e.key === "End" ? all.length - 1 : (i + (e.key === "ArrowRight" ? 1 : -1) + all.length) % all.length;
    const next = all[j];
    if (!next || next === b) return;
    e.preventDefault();
    const { seg: name, key } = next.dataset;
    const root = b.closest(".sheet") || document;
    next.click();
    // the screen may have drawn itself again: focus the new tab by its name and key
    const again = root.querySelector(`.rs-seg-b[data-seg="${CSS.escape(name)}"][data-key="${CSS.escape(key)}"]`) || next;
    try { again.focus(); } catch (x) { /* gone */ }
  });
}
