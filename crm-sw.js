// Barta CRM service worker (design §2.5). Registered by crm-app/main.js
// with scope "/crm", so it serves the CRM's own pages and files only.
//
// - /crm-app/* is served cache-first from PRECACHE (every file under
//   crm-app/, written by build/crm_precache.mjs), installed under VERSION
//   (= APP_VERSION) and swapped on activate, so a phone always runs one
//   consistent version of the app.
// - The shell /crm is stale-while-revalidate (it holds no customer data,
//   only the signed-in person and their permissions): with one bar of
//   signal or none the app starts at once from cache. A shell answer that
//   is not the shell (a redirect to sign-in) drops the cached copy.
// - Never cached: /crm/legacy, /crm/login, /crm/setup, /crm/invite/*, and
//   anything under /api/. Data the app keeps offline lives in IndexedDB,
//   which sign-out wipes.
const VERSION = "2026.11.11-7";
const PRECACHE = [
  "/crm-app/core/api.js",
  "/crm-app/core/cache.js",
  "/crm-app/core/camera.js",
  "/crm-app/core/edge.js",
  "/crm-app/core/format.js",
  "/crm-app/core/forms.js",
  "/crm-app/core/map.js",
  "/crm-app/core/nav.js",
  "/crm-app/core/outbox.js",
  "/crm-app/core/pickers.js",
  "/crm-app/core/poll.js",
  "/crm-app/core/router.js",
  "/crm-app/core/signature.js",
  "/crm-app/core/signin.js",
  "/crm-app/core/ui.js",
  "/crm-app/main.js",
  "/crm-app/modules/comms/manifest.js",
  "/crm-app/modules/contacts/contact.js",
  "/crm-app/modules/contacts/contacts.css",
  "/crm-app/modules/contacts/edit.js",
  "/crm-app/modules/contacts/hooks.js",
  "/crm-app/modules/contacts/kit.js",
  "/crm-app/modules/contacts/list.js",
  "/crm-app/modules/contacts/manifest.js",
  "/crm-app/modules/contacts/merge.js",
  "/crm-app/modules/contacts/property.js",
  "/crm-app/modules/contacts/quick.js",
  "/crm-app/modules/import/conflicts.js",
  "/crm-app/modules/import/import.css",
  "/crm-app/modules/import/kit.js",
  "/crm-app/modules/import/list.js",
  "/crm-app/modules/import/manifest.js",
  "/crm-app/modules/import/run.js",
  "/crm-app/modules/index.js",
  "/crm-app/modules/mcp/manifest.js",
  "/crm-app/modules/money/manifest.js",
  "/crm-app/modules/payroll/manifest.js",
  "/crm-app/modules/plans/manifest.js",
  "/crm-app/modules/quotes/manifest.js",
  "/crm-app/modules/reports/manifest.js",
  "/crm-app/modules/sales/cadence.js",
  "/crm-app/modules/sales/cadences.js",
  "/crm-app/modules/sales/calls.js",
  "/crm-app/modules/sales/contact-tab.js",
  "/crm-app/modules/sales/deal.js",
  "/crm-app/modules/sales/enroll.js",
  "/crm-app/modules/sales/enrollment.js",
  "/crm-app/modules/sales/kit.js",
  "/crm-app/modules/sales/log.js",
  "/crm-app/modules/sales/manifest.js",
  "/crm-app/modules/sales/sales.css",
  "/crm-app/modules/sales/task.js",
  "/crm-app/modules/sales/tasks.js",
  "/crm-app/modules/sales/today-card.js",
  "/crm-app/modules/system/activity.js",
  "/crm-app/modules/system/approvals.js",
  "/crm-app/modules/system/automations.js",
  "/crm-app/modules/system/dashboard.js",
  "/crm-app/modules/system/kit.js",
  "/crm-app/modules/system/legacy.js",
  "/crm-app/modules/system/manifest.js",
  "/crm-app/modules/system/me.js",
  "/crm-app/modules/system/notifications.js",
  "/crm-app/modules/system/outbox.js",
  "/crm-app/modules/system/person.js",
  "/crm-app/modules/system/settings-data.js",
  "/crm-app/modules/system/settings-general.js",
  "/crm-app/modules/system/settings-integrations.js",
  "/crm-app/modules/system/settings-messaging.js",
  "/crm-app/modules/system/settings-permissions.js",
  "/crm-app/modules/system/settings.js",
  "/crm-app/modules/system/team.js",
  "/crm-app/modules/system/template.js",
  "/crm-app/modules/system/templates.js",
  "/crm-app/modules/system/today.js",
  "/crm-app/modules/system/tool.js",
  "/crm-app/modules/work/manifest.js",
  "/crm-app/modules/work/office-checklist.js",
  "/crm-app/modules/work/office-checklists.js",
  "/crm-app/modules/work/office-contact-tab.js",
  "/crm-app/modules/work/office-job-new.js",
  "/crm-app/modules/work/office-job.js",
  "/crm-app/modules/work/office-jobs.js",
  "/crm-app/modules/work/office-kit.js",
  "/crm-app/modules/work/office-moveday.js",
  "/crm-app/modules/work/office-route.js",
  "/crm-app/modules/work/office-schedule.js",
  "/crm-app/modules/work/office-styles.css",
  "/crm-app/modules/work/office-timeoff.js",
  "/crm-app/modules/work/office-today-card.js",
  "/crm-app/modules/work/visit.js",
  "/crm-app/portal/core.js",
  "/crm-app/styles/crm.css",
  "/crm-app/version.js",
];
const ASSETS = [
  "/assets/fonts/CabinetGrotesk-Extrabold.v1.woff2",
  "/assets/fonts/GeneralSans-Medium.v1.woff2",
  "/assets/fonts/GeneralSans-Semibold.v1.woff2",
  "/assets/img/logo-bww.png",
];
const APP_CACHE = "crm-app-" + VERSION;
const SHELL_CACHE = "crm-shell";
const SHELL = "/crm";
const NEVER = [/^\/api\//, /^\/crm\/legacy(\/|$)/, /^\/crm\/login(\/|$)/, /^\/crm\/setup(\/|$)/, /^\/crm\/invite(\/|$)/];

self.addEventListener("install", (e) => {
  e.waitUntil(caches.open(APP_CACHE)
    .then((c) => c.addAll(PRECACHE).then(() => c.addAll(ASSETS).catch(() => {})))
    .then(() => self.skipWaiting()));
});

self.addEventListener("activate", (e) => {
  e.waitUntil(caches.keys()
    .then((keys) => Promise.all(keys.filter((k) => k.startsWith("crm-app-") && k !== APP_CACHE).map((k) => caches.delete(k))))
    .then(() => self.clients.claim()));
});

function shell(e) {
  // Revalidate in the background (a fresh request: a navigation request
  // can't be re-issued with other options).
  const fresh = fetch(SHELL, { credentials: "same-origin", redirect: "manual" }).then(async (res) => {
    const c = await caches.open(SHELL_CACHE);
    if (res.ok && res.headers.get("X-CRM-Shell") === "1") await c.put(SHELL, res.clone());
    else if (res.type === "opaqueredirect" || res.status === 401 || res.status === 403) await c.delete(SHELL);
    return res;
  });
  e.waitUntil(fresh.catch(() => {}));
  return caches.open(SHELL_CACHE)
    .then((c) => c.match(SHELL))
    .then((hit) => hit || fetch(e.request))
    .catch(() => fetch(e.request));
}

self.addEventListener("fetch", (e) => {
  const req = e.request;
  if (req.method !== "GET") return;
  const url = new URL(req.url);
  if (url.origin !== location.origin) return;
  if (NEVER.some((re) => re.test(url.pathname))) return;
  if ((url.pathname === SHELL || url.pathname === SHELL + "/") && req.mode === "navigate") {
    e.respondWith(shell(e));
    return;
  }
  if (url.pathname.startsWith("/crm-app/") || ASSETS.includes(url.pathname)) {
    e.respondWith(caches.open(APP_CACHE)
      .then((c) => c.match(url.pathname, { ignoreSearch: true }))
      .then((hit) => hit || fetch(req)));
  }
});
