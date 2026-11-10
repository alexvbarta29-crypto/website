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
  box.appendChild(t);
  setTimeout(() => t.remove(), ms);
}

// ------------------------------------------------------------ sheets

const open = [];

// sheet({ title, body: html``, onClose, events }) → { el, body, close }
export function sheet({ title = "", body = raw(""), onClose, events } = {}) {
  const layer = document.getElementById("layer") || document.body;
  const back = document.createElement("div");
  back.className = "backdrop";
  const el = document.createElement("section");
  el.className = "sheet";
  el.setAttribute("role", "dialog");
  el.setAttribute("aria-modal", "true");
  el.tabIndex = -1;
  render(el, html`<div class="grab" aria-hidden="true"></div><div class="sheet-head"><h2>${title}</h2><button type="button" class="sheet-x" data-sheet-x aria-label="Close">✕</button></div><div class="sheet-body"></div>`);
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
  phone: svg('<rect x="7" y="3" width="10" height="18" rx="2.5"/><path d="M11 18h2"/>'),
  list: svg('<path d="M8 6.5h12M8 12h12M8 17.5h12M4 6.5h.01M4 12h.01M4 17.5h.01"/>'),
  shield: svg('<path d="M12 3l7.5 3v5.5c0 4.5-3.2 8-7.5 9.5-4.3-1.5-7.5-5-7.5-9.5V6z"/><path d="M9 12l2 2 4-4"/>'),
  sun: svg('<circle cx="12" cy="12" r="4"/><path d="M12 2.5v2M12 19.5v2M4.6 4.6 6 6M18 18l1.4 1.4M2.5 12h2M19.5 12h2M4.6 19.4 6 18M18 6l1.4-1.4"/>'),
  share: svg('<path d="M12 3v12M8 7l4-4 4 4"/><path d="M8 11H6.5A1.5 1.5 0 0 0 5 12.5v7A1.5 1.5 0 0 0 6.5 21h11a1.5 1.5 0 0 0 1.5-1.5v-7a1.5 1.5 0 0 0-1.5-1.5H16"/>'),
  copy: svg('<rect x="8" y="8" width="12" height="12" rx="2.5"/><path d="M16 8V5.5A1.5 1.5 0 0 0 14.5 4h-9A1.5 1.5 0 0 0 4 5.5v9A1.5 1.5 0 0 0 5.5 16H8"/>'),
  search: svg('<circle cx="11" cy="11" r="7"/><path d="m20 20-3.5-3.5"/>'),
  back: svg('<path d="M15 5l-7 7 7 7"/>'),
};
export const icon = (name) => ICONS[name] || raw("");
