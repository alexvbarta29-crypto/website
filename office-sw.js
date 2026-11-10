// Barta Office app (docs/OFFICE.md, "The phone app"). Registered by /office
// with scope "/office", so it never touches the public website. Office pages
// are private and always fetched fresh; nothing signed-in is ever cached.
//
// One addition for the CRM (design §2.5): the data-free LAUNCHER page
// (/office/launch: a full-screen CRM frame and an "Offline" strip, no data,
// no tool list) is kept here. It is cached at install and refreshed on every
// online /office visit. When opening /office fails (no signal), the app
// shows the launcher only if this phone has a CRM to start (the CRM's own
// service worker, crm-sw.js, keeps its shell in the "crm-shell" cache, which
// exists only for someone signed in to the CRM); the CRM frame then starts
// from that copy. Otherwise (office password only, signed out, nothing
// cached) it shows the branded "No connection" page, never a frame with the
// browser's error page in it. The only URLs ever cached here are LAUNCHER
// and the KEEP files: never /office itself, never anything under /api/.
// Bump VERSION to replace them.
const VERSION = "barta-office-v4";
const LAUNCHER = "/office/launch";
const CRM_SHELL_CACHE = "crm-shell";
const CRM_SHELL = "/crm";
const KEEP = [
  "/assets/img/app/office-icon-192.v2.png",
  "/assets/fonts/CabinetGrotesk-Extrabold.v1.woff2",
  "/assets/fonts/GeneralSans-Medium.v1.woff2",
  "/assets/fonts/GeneralSans-Semibold.v1.woff2",
];

const keepLauncher = () => caches.open(VERSION).then((c) => c.add(LAUNCHER)).catch(() => {});

self.addEventListener("install", (e) => {
  e.waitUntil(caches.open(VERSION)
    .then((c) => Promise.all([c.addAll(KEEP).catch(() => {}), c.add(LAUNCHER).catch(() => {})]))
    .catch(() => {})
    .then(() => self.skipWaiting()));
});

self.addEventListener("activate", (e) => {
  e.waitUntil(caches.keys()
    .then((keys) => Promise.all(keys.filter((k) => k.startsWith("barta-office-") && k !== VERSION).map((k) => caches.delete(k))))
    .then(() => self.clients.claim()));
});

const OFFLINE = `<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">
<meta name="theme-color" content="#16161b"><title>Barta Office</title>
<style>
@font-face{font-family:'Cabinet Grotesk';src:url('/assets/fonts/CabinetGrotesk-Extrabold.v1.woff2') format('woff2');font-weight:800}
@font-face{font-family:'General Sans';src:url('/assets/fonts/GeneralSans-Medium.v1.woff2') format('woff2');font-weight:500}
body{margin:0;min-height:100vh;display:grid;place-items:center;padding:24px 16px;background:#f4f4f6;color:#16161b;font:500 16px/1.5 'General Sans',system-ui,-apple-system,sans-serif;text-align:center}
img{width:64px;height:64px;border-radius:16px}
h1{margin:18px 0 6px;font:800 1.6rem/1.1 'Cabinet Grotesk',system-ui,sans-serif}
p{margin:0 0 22px;color:#67676f}
button{border:0;border-radius:999px;padding:14px 28px;font:800 .95rem/1 'Cabinet Grotesk',system-ui,sans-serif;letter-spacing:.045em;text-transform:uppercase;color:#fff;background:#fb4d3d;cursor:pointer}
</style></head><body><div>
<img src="/assets/img/app/office-icon-192.v2.png" alt="">
<h1>No connection</h1>
<p>Barta Office needs signal. It'll open again as soon as you're back online.</p>
<button type="button" onclick="location.reload()">Try again</button>
</div><script>addEventListener('online',function(){location.reload()})</script></body></html>`;

const offlinePage = () => new Response(OFFLINE, { headers: { "Content-Type": "text/html; charset=utf-8" } });

// The launcher when this phone has a CRM shell to start, else No connection.
async function offlineStart() {
  let shell = null;
  try { shell = await (await caches.open(CRM_SHELL_CACHE)).match(CRM_SHELL); } catch (e) { shell = null; }
  if (!shell) return offlinePage();
  const hit = await caches.match(LAUNCHER).catch(() => null);
  return hit || offlinePage();
}

self.addEventListener("fetch", (e) => {
  const req = e.request;
  if (req.method !== "GET") return;
  const url = new URL(req.url);
  if (req.mode === "navigate") {
    const isOffice = url.origin === location.origin && (url.pathname === "/office" || url.pathname === "/office/");
    e.respondWith(fetch(req)
      .then((res) => {
        // Online: refresh the launcher for the next cold start with no signal.
        if (isOffice && res.ok) e.waitUntil(keepLauncher());
        return res;
      })
      .catch(() => (isOffice || url.pathname === LAUNCHER ? offlineStart() : offlinePage())));
    return;
  }
  if (url.origin === location.origin && KEEP.includes(url.pathname)) {
    e.respondWith(caches.match(req, { ignoreSearch: true }).then((hit) => hit || fetch(req)));
  }
});
