// Barta CRM client: start-up (design §2.3, §2.4, §2.5).
//
// Reads the shell's boot JSON (#crm-boot: the signed-in person, their
// permissions and tabs; no customer data, so the service worker may cache
// the shell), registers crm-sw.js (scope /crm) for the offline start,
// mounts the tab bar and starts the router. Then, in the background, it
// re-reads /me (permissions may have changed since a cached shell was
// made), polls /me/badges every 30 s while visible (ETag/304, core/poll.js)
// and replays the offline outbox (core/outbox.js) when there is signal.
//
// Inside the /office frame it talks to the shell with postMessage, same
// origin only: it sends crm:route, crm:badge and crm:signed_out, and takes
// office:insets (safe areas, which iframes don't reliably get),
// office:show {path} and office:overlay {bottom} (the office's "Get the
// app" card floats over the frame: toasts move above it). A new deploy never reloads the app under someone's
// thumb: it shows "New version, tap to reload" instead.

import { APP_VERSION } from "./version.js";
import { MANIFESTS } from "./modules/index.js";
import * as router from "./core/router.js";
import * as nav from "./core/nav.js";
import { edgeSwipe } from "./core/edge.js";
import { api, get, on, signOut, compareVersions, setCacheOwner } from "./core/api.js";
import { html, render, toast } from "./core/ui.js";
import { time as fmtTime } from "./core/format.js";
import { poll } from "./core/poll.js";
import * as outbox from "./core/outbox.js";

const framed = (() => { try { return window.parent !== window; } catch (e) { return true; } })();
const toShell = (msg) => { if (framed) { try { window.parent.postMessage(msg, location.origin); } catch (e) { /* no shell */ } } };

function readBoot() {
  try { return JSON.parse(document.getElementById("crm-boot").textContent); } catch (e) { return null; }
}

const boot = readBoot();
const session = {
  user: boot && boot.user,
  perms: (boot && boot.perms) || {},
  nav: (boot && boot.nav) || ["today"],
  office: !!(boot && boot.office),
};
// office:tools is not a CRM permission: it means this phone has the office
// sign-in (the dashboards and office tools check that cookie themselves).
const can = (perm) => (perm === "office:tools" ? session.office : !!session.perms[perm]);

// ------------------------------------------------------------ banner

const banner = document.getElementById("banner");
let bannerKind = null;
function showBanner(kind, content) {
  bannerKind = kind;
  render(banner, content);
  banner.className = "banner" + (kind === "update" ? " warn" : "");
  banner.hidden = false;
}
function hideBanner(kind) { if (!kind || bannerKind === kind) { banner.hidden = true; bannerKind = null; } }

function offlineBanner(asOf) {
  showBanner("offline", html`<span>Offline${asOf ? ", as of " + fmtTime(asOf) : ""}. Changes need signal.</span>`);
}
function updateBanner() {
  if (bannerKind === "update") return;
  showBanner("update", html`<span>There's a new version of the app.</span><button type="button" data-reload>Tap to reload</button>`);
}
banner.addEventListener("click", (e) => { if (e.target.closest("[data-reload]")) location.reload(); });
window.addEventListener("offline", () => offlineBanner());
window.addEventListener("online", () => { hideBanner("offline"); router.refresh(); });
if (navigator.onLine === false) offlineBanner();
on("outdated", updateBanner);
on("offline", (asOf) => offlineBanner(asOf));

// ------------------------------------------------------------ shell messages

function setInsets(m) {
  const root = document.documentElement.style;
  for (const side of ["top", "right", "bottom", "left"]) {
    const n = Number(m[side]);
    if (Number.isFinite(n) && n >= 0 && n < 200) root.setProperty("--sa" + side[0], n + "px");
  }
}
window.addEventListener("message", (e) => {
  if (e.origin !== location.origin || (framed && e.source !== window.parent)) return;
  const m = e.data || {};
  if (m.type === "office:insets") setInsets(m);
  else if (m.type === "office:overlay") {
    const n = Number(m.bottom);
    document.documentElement.style.setProperty("--lift", (Number.isFinite(n) && n >= 0 && n < 400 ? n : 0) + "px");
  }
  else if (m.type === "office:show" && typeof m.path === "string" && m.path.startsWith("/")) router.go(m.path);
});

// Links the phone hands to an app (maps:) leave through the top window.
document.addEventListener("click", (e) => {
  const a = e.target.closest && e.target.closest('a[data-external="top"]');
  if (!a) return;
  e.preventDefault();
  try { window.top.location.href = a.getAttribute("href"); } catch (x) { location.href = a.getAttribute("href"); }
});

// ------------------------------------------------------------ sign out

async function doSignOut(opts = {}) {
  await signOut(opts);
  if (framed) toShell({ type: "crm:signed_out" });
  location.replace("/crm/login");
}

// ------------------------------------------------------------ start

function start() {
  if (!boot || !session.user) { location.replace("/crm/login"); return; }
  // Offline copies are kept per person: another person's never shows here.
  setCacheOwner(session.user.id);
  if ("serviceWorker" in navigator) navigator.serviceWorker.register("/crm-sw.js", { scope: "/crm" }).catch(() => {});
  router.register(MANIFESTS);
  router.configure({
    can, api, user: session.user,
    isTabRoot: (p) => nav.isTabRoot(p),
    onRoute: (path) => { nav.update(path); toShell({ type: "crm:route", path }); },
    signOut: doSignOut,
  });
  nav.mount({ nav: session.nav, manifests: MANIFESTS, can, onSignOut: () => doSignOut() });
  document.getElementById("top-back").addEventListener("click", () => router.back());
  edgeSwipe(() => router.back(), document);
  const bootEl = document.getElementById("boot");
  if (bootEl) bootEl.remove();
  router.start();
  window.__crm = { session, signOut: doSignOut, version: APP_VERSION };

  // Fresh permissions (a cached shell may be older than a role change).
  get("/me", { cache: false }).then(({ data }) => {
    if (!data) return;
    // A cached shell made for someone else (a shared phone): start again.
    if (data.user && session.user && data.user.id !== session.user.id) { location.reload(); return; }
    const before = JSON.stringify(session.perms);
    session.user = { ...session.user, ...data.user };
    session.perms = data.perms || {};
    if (data.min_client && compareVersions(data.min_client, APP_VERSION) > 0) updateBanner();
    if (JSON.stringify(session.perms) !== before) router.refresh();
  }).catch((e) => { if (e && e.code === "offline") offlineBanner(); });

  // Badges: one cheap read every 30 s while the app is on screen (304 when nothing changed).
  poll("/me/badges", 30000, (data) => {
    if (!data) return;
    nav.setBadges({ inbox: data.inbox_unread || 0, today: (data.attention || 0) + (data.approvals || 0) + (data.notifications || 0) });
    toShell({ type: "crm:badge", inbox: data.inbox_unread || 0, attention: (data.attention || 0) + (data.approvals || 0), notifications: data.notifications || 0 });
  });

  // Offline changes (the tech app, M4b) go out when there is signal.
  outbox.start({ onRefused: (item, e) => toast(`A change made offline was refused: ${e.message}`, { bad: true, ms: 5000 }) });
}

try { start(); } catch (e) {
  render(document.getElementById("view"), html`<div class="card empty"><h2>The app didn't start</h2><p>${String(e && e.message || e)}</p></div>`);
  toast("The app didn't start. Reload.", { bad: true });
}
