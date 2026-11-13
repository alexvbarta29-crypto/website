// Barta CRM client: the sign-in pages (design §4.4, §4.11, §9.2): Team
// sign-in (/crm/login), first-owner setup (/crm/setup) and invite or reset
// links (/crm/invite/...). The pages are server-rendered and data-free;
// this script only sends the form as JSON (with the X-CRM header the server
// requires) and goes where the server says. Inside the /office frame a
// destination under /office goes to the top window.

import { APP_VERSION } from "../version.js";
import * as cache from "./cache.js";

const $ = (id) => document.getElementById(id);
let page = {};
try { page = JSON.parse($("crm-page").textContent); } catch (e) { page = {}; }

function say(text) {
  const box = $("err");
  if (!box) return;
  box.textContent = text || "";
  box.hidden = !text;
  if (text) box.scrollIntoView({ block: "nearest" });
}

// Goes to `dest`; a page that is already there (only the #hash differs)
// is reloaded, so it sees the new sign-in.
function navigate(win, dest) {
  const [pathPart, hash] = dest.split("#");
  if (win.location.pathname === pathPart) {
    if (hash !== undefined) win.location.hash = hash;
    win.location.reload();
  } else win.location.href = dest;
}

function go(to) {
  const dest = typeof to === "string" && /^\/(office|crm)(#|\/|$)/.test(to) ? to : "/crm";
  let framed = false;
  try { framed = window.top !== window; } catch (e) { framed = true; }
  if (framed && dest.startsWith("/office")) { try { navigate(window.top, dest); return; } catch (e) { /* fall through */ } }
  navigate(window, dest);
}

// The service worker's copy of the shell and the offline copies belong to
// whoever was signed in before: drop them, so this person never sees theirs.
async function forgetShell() {
  try { await cache.wipe(); } catch (e) { /* nothing kept */ }
  try { if (typeof caches !== "undefined") await caches.delete("crm-shell"); } catch (e) { /* no Cache Storage */ }
}

async function send(path, body) {
  const res = await fetch("/api/crm" + path, {
    method: "POST",
    credentials: "same-origin",
    headers: { "Content-Type": "application/json", "X-CRM": "1", "X-CRM-Client": APP_VERSION },
    body: JSON.stringify(body),
  });
  let json = null;
  try { json = await res.json(); } catch (e) { json = null; }
  if (res.ok && json && json.ok) return json.data || {};
  const err = (json && json.error && typeof json.error === "object") ? json.error : {};
  const e = new Error(err.message || (res.status === 429 ? "Too many tries. Wait a little, then try again." : `That didn't work (${res.status}). Try again.`));
  e.field = err.field;
  throw e;
}

function wire(formId, build, path, after) {
  const form = $(formId);
  if (!form) return;
  const btn = $("go");
  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    say("");
    let body;
    try { body = build(form); } catch (x) { say(x.message); return; }
    btn.disabled = true;
    const label = btn.textContent;
    btn.textContent = "One moment…";
    try {
      const data = await send(path, body);
      await forgetShell();
      after(data);
      return;
    } catch (x) {
      say(x && x.message === "Failed to fetch" ? "No connection. Try again when you have signal." : (x && x.message) || "That didn't work. Try again.");
      if (x && x.field && form.elements[x.field]) form.elements[x.field].focus();
    }
    btn.disabled = false;
    btn.textContent = label;
  });
}

const val = (form, name) => (form.elements[name] ? form.elements[name].value : "");

if (page.page === "login") {
  wire("signin", (f) => {
    const login = val(f, "login").trim();
    const password = val(f, "password");
    if (!login) throw new Error("Type your login.");
    if (!password) throw new Error("Type your password.");
    return { login, password, to: page.to || "/crm" };
  }, "/auth/login", (data) => go(data.to || page.to || "/crm"));
  const login = $("login");
  if (login && !login.value) login.focus();
}

if (page.page === "setup") {
  wire("setup", (f) => {
    const name = val(f, "name").trim();
    if (!val(f, "setup_code").trim()) throw new Error(f.elements.setup_code && f.elements.setup_code.closest("label") && /office/i.test(f.elements.setup_code.closest("label").textContent) ? "Type the office password." : "Type the setup code from Netlify.");
    if (!name) throw new Error("Type your name.");
    return { setup_code: val(f, "setup_code").trim(), name, login: val(f, "login").trim().toLowerCase(), password: val(f, "password"), is_technician: !!(f.elements.is_technician && f.elements.is_technician.checked) };
  }, "/auth/setup", (data) => go(data.to || "/office#crm"));
}

if (page.page === "invite") {
  wire("invite", (f) => {
    const pw = val(f, "password");
    if (pw.length < 10) throw new Error("Use at least 10 characters.");
    if (pw !== val(f, "again")) throw new Error("The two passwords don't match.");
    return { token: page.token, password: pw };
  }, "/auth/invite", () => {
    $("step-set").hidden = true;
    $("step-done").hidden = false;
    window.scrollTo(0, 0);
  });
}
