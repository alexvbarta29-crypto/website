// Barta Office app (docs/OFFICE.md, "The phone app"). Registered by /office
// with scope "/office", so it never touches the public website. Office pages
// are private and always fetched fresh; nothing signed-in is ever cached.
// With no signal it shows a "you're offline" screen instead of the browser's
// error page. Bump VERSION to replace the cached icon and fonts.
const VERSION = "barta-office-v2";
const KEEP = [
  "/assets/img/app/office-icon-192.v2.png",
  "/assets/fonts/CabinetGrotesk-Extrabold.v1.woff2",
  "/assets/fonts/GeneralSans-Medium.v1.woff2",
];

self.addEventListener("install", (e) => {
  e.waitUntil(caches.open(VERSION).then((c) => c.addAll(KEEP)).catch(() => {}).then(() => self.skipWaiting()));
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

self.addEventListener("fetch", (e) => {
  const req = e.request;
  if (req.method !== "GET") return;
  if (req.mode === "navigate") {
    e.respondWith(fetch(req).catch(() => new Response(OFFLINE, { headers: { "Content-Type": "text/html; charset=utf-8" } })));
    return;
  }
  const url = new URL(req.url);
  if (url.origin === location.origin && KEEP.includes(url.pathname)) {
    e.respondWith(caches.match(req, { ignoreSearch: true }).then((hit) => hit || fetch(req)));
  }
});
