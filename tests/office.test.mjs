// /office — one page with tabs for the office tools (docs/OFFICE.md), the
// CRM tab, solo mode for a CRM sign-in alone, Team sign-in, and the
// offline launcher (design §2.4, §2.5; M1.2).
import { test, afterEach } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import vm from "node:vm";
import { crmTest } from "./helpers/crm-http.mjs";

process.env.OFFICE_PASSWORD = "test-password";
const office = (await import("../netlify/functions/office.mjs")).default;
const { derive } = await import("../netlify/lib/lights-auth.mjs");
const signedIn = { cookie: "barta_office=" + derive("test-password") };
const { TOOLS, VIEWS, OLD, launcherHtml } = await import("../netlify/lib/office-page.mjs");

let t;
afterEach(() => { if (t) t.done(); t = null; });

test("office page lists every tool, the CRM first, and is never indexed", async () => {
  const res = await office(new Request("https://x.test/office", { headers: signedIn }));
  assert.equal(res.status, 200);
  assert.equal(res.headers.get("x-robots-tag"), "noindex, nofollow");
  const body = await res.text();
  for (const t of TOOLS) if (t.id !== "dashboard") assert.match(body, new RegExp(`data-tool="${t.id}"`));
  for (const v of VIEWS) assert.match(body, new RegExp(`data-tool="${v.id}"`));
  assert.match(body, />Lights</);
  assert.match(body, /Follow-ups/);
  assert.match(body, /logo-bww\.png/);
  assert.match(body, /gwa-key/);
  assert.doesNotMatch(body, /data-tool="referrals"/);
  assert.doesNotMatch(body, /data-tool="customers"/, "the Customers tab became the CRM tab");
  assert.equal(TOOLS[1].id, "crm");
  assert.deepEqual(TOOLS[1], { id: "crm", label: "CRM", src: "/crm", compact: true, needs: "crm" });
  assert.ok(TOOLS.filter((x) => x.id !== "crm").every((x) => x.needs === "office"), "every other tool needs the office password");
  assert.equal(OLD.customers, "crm", "old #customers bookmarks open the CRM tab");
  assert.ok(body.indexOf('data-tool="crm"') < body.indexOf('data-tool="lights"'), "CRM is the first tool tab");
  // the CRM conversation: routes, badges, sign-out, insets, deep links
  for (const s of ["crm:route", "crm:badge", "crm:signed_out", "office:insets", "office:show", "e.origin !== location.origin", "body.compact .brand{display:none}"]) assert.ok(body.includes(s), s);
});

test("every tab points at a page that exists", () => {
  for (const t of TOOLS) {
    if (t.src.startsWith("/dashboard")) assert.ok(existsSync("netlify/functions/dashboard.mjs"));
    else if (t.src === "/crm") assert.ok(existsSync("netlify/functions/crm.mjs"));
    else if (t.src === "/lights") assert.ok(existsSync("netlify/functions/lights.mjs"));
    else if (t.src === "/playbook") assert.ok(existsSync("netlify/functions/playbook.mjs"));
    else if (t.src === "/purchases") assert.ok(existsSync("netlify/functions/purchases.mjs"));
    else assert.ok(existsSync("." + t.src), t.src);
  }
  assert.ok(!existsSync("netlify/functions/crm-import.mjs"), "crm-import.mjs moved into crm-api in M1.2");
});

test("signed out, /office shows the sign-in page, not the tools", async () => {
  const body = await (await office(new Request("https://x.test/office"))).text();
  assert.match(body, /autocomplete="current-password"/);
  assert.match(body, /class="logo" src="\/assets\/img\/logo-bww\.png"/);
  assert.doesNotMatch(body, /data-tool=/);
});

test("one office sign-in opens the lights tool and the playbook too", async () => {
  const res = await office(new Request("https://x.test/office", {
    method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: "password=test-password",
  }));
  assert.equal(res.status, 303);
  const sc = res.headers.get("set-cookie");
  assert.match(sc, /Path=\//);
  const cookie = sc.split(";")[0];
  const lights = (await import("../netlify/functions/lights.mjs")).default;
  const playbook = (await import("../netlify/functions/playbook.mjs")).default;
  assert.match(await (await lights(new Request("https://x.test/lights", { headers: { cookie } }))).text(), /Paste or drop the house photos/);
  assert.doesNotMatch(await (await playbook(new Request("https://x.test/playbook", { headers: { cookie } }))).text(), /autocomplete="current-password"/);
});

test("wrong office password is refused", async () => {
  const res = await office(new Request("https://x.test/office", {
    method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: "password=nope",
  }));
  assert.equal(res.status, 401);
  assert.equal(res.headers.get("set-cookie"), null);
  assert.match(await res.text(), /That password isn&#39;t right|That password isn't right/);
});

test("a CRM sign-in alone gets solo mode: the CRM fills the screen, no dashboards, no other tools", async () => {
  t = await crmTest();
  const tech = await t.user("tech");
  const r = await t.office("/office", { as: tech });
  assert.equal(r.status, 200);
  assert.match(r.text, /<body class="solo">/);
  assert.match(r.text, /"src":"\/crm"/);
  for (const id of ["overview", "money", "lights", "purchases", "followups", "giveaway", "dashboard"]) assert.doesNotMatch(r.text, new RegExp(`"id":"${id}"|data-tool="${id}"`), id);
  assert.doesNotMatch(r.text, /dashboard\?embed|\/lights|\/purchases|admin\/giveaway/);
  assert.equal(r.headers.get("set-cookie"), null, "no office cookie for a CRM session");
  // an owner with both cookies gets the whole office
  const owner = await t.user("owner");
  const both = await t.office("/office", { as: owner, office: true });
  assert.doesNotMatch(both.text, /<body class="solo">/);
  assert.match(both.text, /data-tool="lights"/);
  // a disabled or expired session is just signed out
  const gone = await t.office("/office", { cookie: "barta_crm=us_00000000000000000000." + "a".repeat(43) });
  assert.match(gone.text, /autocomplete="current-password"/);
});

test("the signed-out page offers Team sign-in once the CRM is set up, and only the office password before", async () => {
  t = await crmTest();
  let r = await t.office("/office");
  assert.match(r.text, /const TEAM = false;/, "before setup: office password only");
  const owner = await t.user("owner");
  await t.bootstrap(owner);
  r = await t.office("/office");
  assert.match(r.text, /const TEAM = true;/);
  assert.match(r.text, /Team sign-in/);
  assert.match(r.text, /fetch\('\/api\/crm\/auth\/login'/);
  assert.match(r.text, /'X-CRM': '1'/);
  assert.match(r.text, /Forgot your password\? Ask Alex or Jacob for a reset link\./);
  assert.match(r.text, /installed \? 'team'/, "the installed app opens on Team sign-in");
  // the office keeps working when the CRM's store does not (production without its settings)
  const prod = await t.office("/office", { context: { deploy: { context: "production" } } });
  assert.equal(prod.status, 200);
  assert.match(prod.text, /const TEAM = false;/);
  const full = await t.office("/office", { office: true, context: { deploy: { context: "production" } } });
  assert.match(full.text, /data-tool="crm"/);
});

test("/office/launch is public, data-free and re-checked on every load", async () => {
  const res = await office(new Request("https://x.test/office/launch"));
  assert.equal(res.status, 200);
  assert.equal(res.headers.get("cache-control"), "no-cache");
  assert.equal(res.headers.get("x-robots-tag"), "noindex, nofollow");
  assert.equal(res.headers.get("set-cookie"), null);
  const body = await res.text();
  assert.equal(body, launcherHtml());
  assert.match(body, /<iframe id="crm" title="Barta CRM" src="\/crm"><\/iframe>/);
  assert.match(body, /Offline/);
  assert.doesNotMatch(body, /data-tool=|dashboard|\/lights|\/purchases|giveaway|"user"|\w@\w/, "no tools, no data");
  // the same for anyone: a signed-in request gets the same bytes
  assert.equal(await (await office(new Request("https://x.test/office/launch", { headers: signedIn }))).text(), body);
});

test("the office installs as a phone app", async () => {
  const signedInBody = await (await office(new Request("https://x.test/office", { headers: signedIn }))).text();
  const signedOutBody = await (await office(new Request("https://x.test/office"))).text();
  for (const body of [signedInBody, signedOutBody, launcherHtml()]) {
    assert.match(body, /<link rel="manifest" href="\/office.webmanifest">/);
    assert.match(body, /<link rel="apple-touch-icon" href="\/assets\/img\/app\/office-icon-180\.v2\.png">/);
    assert.match(body, /apple-mobile-web-app-capable/);
  }
  assert.match(signedInBody, /serviceWorker\.register\('\/office-sw\.js', \{ scope: '\/office' \}\)/);

  const m = JSON.parse(readFileSync("office.webmanifest", "utf8"));
  assert.equal(m.start_url, "/office");
  assert.equal(m.scope, "/office");
  assert.equal(m.display, "standalone");
  assert.ok(m.icons.some((i) => i.sizes === "512x512" && i.purpose === "maskable"));
  for (const i of m.icons) assert.ok(existsSync("." + i.src), i.src);
  assert.ok(existsSync("assets/img/app/office-icon-180.v2.png"));

  const deploy = readFileSync("build/make_deploy.py", "utf8");
  assert.match(deploy, /"office\.webmanifest"/);
  assert.match(deploy, /"office-sw\.js"/);
});

// office-sw.js in a sandbox: what it caches, and what a cold start with no signal shows.
function loadOfficeSw({ online = true } = {}) {
  const src = readFileSync("office-sw.js", "utf8");
  const handlers = {};
  const cached = [];
  const store = new Map();
  const cache = {
    async put(req, res) { const u = typeof req === "string" ? req : req.url; cached.push(u); store.set(new URL(u, "https://x.test").pathname, res); },
    async add(u) { cached.push(u); store.set(u, new Response("launcher", { headers: { "Content-Type": "text/html" } })); },
    async addAll(list) { for (const u of list) await cache.add(u); },
  };
  const sandbox = {
    self: { addEventListener: (type, fn) => { handlers[type] = fn; }, skipWaiting: async () => {}, clients: { claim: async () => {} } },
    caches: { open: async () => cache, keys: async () => [], delete: async () => true, match: async (u) => store.get(typeof u === "string" ? u : new URL(u.url).pathname) },
    location: { origin: "https://x.test" },
    fetch: async () => { if (!online) throw new TypeError("offline"); return new Response("page", { status: 200 }); },
    Response, URL, Promise,
  };
  vm.createContext(sandbox);
  vm.runInContext(src, sandbox);
  const fire = async (url, mode = "navigate") => {
    let responded = null;
    const waits = [];
    handlers.fetch({ request: { url: "https://x.test" + url, method: "GET", mode }, respondWith: (p) => { responded = p; }, waitUntil: (p) => waits.push(p) });
    const res = responded ? await responded : null;
    await Promise.allSettled(waits);
    return res;
  };
  const install = async () => { const w = []; handlers.install({ waitUntil: (p) => w.push(p) }); await Promise.all(w); };
  return { cached, fire, install, sandbox };
}

test("office-sw.js caches only LAUNCHER and the KEEP files, never /office itself or /api/", async () => {
  const src = readFileSync("office-sw.js", "utf8");
  assert.match(src, /const VERSION = "barta-office-v3";/);
  assert.match(src, /const LAUNCHER = "\/office\/launch";/);
  const keep = JSON.parse(/const KEEP = (\[[\s\S]*?\]);/.exec(src)[1].replace(/,\s*\]/, "]"));
  const allowed = new Set(["/office/launch", ...keep]);
  const sw = loadOfficeSw();
  await sw.install();
  await sw.fire("/office");
  await sw.fire("/office/");
  await sw.fire("/api/crm/me", "cors");
  await sw.fire("/crm");
  await sw.fire(keep[0], "no-cors");
  assert.ok(sw.cached.length > 0);
  for (const u of sw.cached) assert.ok(allowed.has(u), `cached ${u}`);
  assert.ok(sw.cached.includes("/office/launch"));
  assert.doesNotMatch(src, /\.put\(/, "it never puts a fetched page");
});

test("with no signal, opening /office shows the cached launcher; without one, the No connection page", async () => {
  const sw = loadOfficeSw({ online: false });
  await sw.install();
  const res = await sw.fire("/office");
  assert.equal(await res.text(), "launcher");
  const cold = loadOfficeSw({ online: false });
  const res2 = await cold.fire("/office");
  assert.match(await res2.text(), /No connection/);
});
