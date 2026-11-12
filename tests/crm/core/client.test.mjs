// The phone app's own rules that can be checked without a browser (design
// §2.3, §2.5, §9.1, §9.4; M1.2 review regressions): offline copies belong
// to one person and go on a 401, screens load behind skeletons, and the
// stylesheet keeps the phone rules (44 px taps, 16 px inputs, the weights
// it loads, a left rail on wide screens).
import { test, afterEach } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { strictFetch } from "../../helpers/crm-fetch.mjs";

const api = await import("../../../crm-app/core/api.js");
const cache = await import("../../../crm-app/core/cache.js");

let net = null;
afterEach(async () => {
  if (net) net.restore({ allowRefused: true });
  net = null;
  delete globalThis.location;
  api.setCacheOwner(null);
  await cache.wipe();
});

const fakeLocation = () => {
  const loc = { hash: "#/team", replaced: null, replace(u) { loc.replaced = u; } };
  globalThis.location = loc;
  return loc;
};

test("offline copies are kept per person: someone else on the phone never reads them", async () => {
  // Regression (M1.2 review): copies were keyed by URL alone.
  fakeLocation();
  let online = true;
  net = strictFetch([{ match: "/api/crm/users", respond: () => { if (!online) throw new TypeError("Failed to fetch"); return Response.json({ ok: true, data: [{ id: "us_a" }] }); } }]);
  api.setCacheOwner("us_aaaaaaaaaaaaaaaaaaaa");
  const first = await api.get("/users");
  assert.deepEqual(first.data, [{ id: "us_a" }]);
  online = false;
  const mine = await api.get("/users");
  assert.equal(mine.offline, true, "the same person gets the last good copy offline");
  assert.equal(await cache.get("/api/crm/users"), null, "nothing is keyed by the URL alone");
  api.setCacheOwner("us_bbbbbbbbbbbbbbbbbbbb");
  await assert.rejects(() => api.get("/users"), (e) => e.code === "offline", "another person gets no copy");
  api.setCacheOwner(null);
  await assert.rejects(() => api.get("/users"), (e) => e.code === "offline", "nobody signed in: no copy either");
});

test("a 401 wipes this phone's offline copies before going to sign-in", async () => {
  // Regression (M1.2 review): only an explicit Sign out wiped them.
  const loc = fakeLocation();
  net = strictFetch([
    { match: "/api/crm/users/us_aaaaaaaaaaaaaaaaaaaa/sessions", respond: () => Response.json({ ok: true, data: [{ hash: "h" }] }) },
    { match: "/api/crm/me", respond: () => Response.json({ ok: false, error: { code: "signed_out", message: "Sign in again." } }, { status: 401 }) },
  ]);
  api.setCacheOwner("us_aaaaaaaaaaaaaaaaaaaa");
  await api.get("/users/us_aaaaaaaaaaaaaaaaaaaa/sessions");
  assert.ok(await cache.get("us_aaaaaaaaaaaaaaaaaaaa|/api/crm/users/us_aaaaaaaaaaaaaaaaaaaa/sessions"));
  await assert.rejects(() => api.get("/me", { cache: false }), (e) => e.status === 401);
  await new Promise((r) => setImmediate(r));
  assert.equal(await cache.get("us_aaaaaaaaaaaaaaaaaaaa|/api/crm/users/us_aaaaaaaaaaaaaaaaaaaa/sessions"), null, "wiped");
  assert.equal(loc.replaced, "/crm/login?to=" + encodeURIComponent("/crm#/team"));
  // and a new sign-in wipes them too (signin.js)
  const signin = readFileSync("crm-app/core/signin.js", "utf8");
  assert.match(signin, /import \* as cache from "\.\/cache\.js";/);
  assert.match(signin, /await cache\.wipe\(\)/);
});

test("screens load behind a skeleton, never a spinner", async () => {
  const router = readFileSync("crm-app/core/router.js", "utf8");
  assert.match(router, /render\(v, skeleton\(route\.skeleton\)\)/);
  for (const f of ["crm-app/core/router.js", "crm-app/main.js", "crm-app/styles/crm.css", "netlify/lib/crm/core/shell-html.mjs"]) {
    assert.doesNotMatch(readFileSync(f, "utf8"), /class="spinner"|\.spinner\b/, f);
  }
  assert.match(readFileSync("netlify/lib/crm/core/shell-html.mjs", "utf8"), /<div class="skel" id="boot"/);
});

test("the stylesheet keeps the phone rules: 44 px buttons, 16 px inputs, loaded weights only, a left rail from 900 px", () => {
  const css = readFileSync("crm-app/styles/crm.css", "utf8");
  // Regressions (M1.2 review): the update banner's button was 36 px with a
  // synthesized 700; the link field was 14 px (iOS zooms); no wide layout.
  assert.match(css, /\.banner button\{[^}]*min-height:44px/);
  assert.match(css, /\.copy-box input\{[^}]*font-size:16px/);
  const loaded = [...css.matchAll(/@font-face\{font-family:'([^']+)';[^}]*font-weight:(\d+)/g)].map((m) => m[1] + " " + m[2]);
  assert.deepEqual(loaded.sort(), ["Cabinet Grotesk 700", "Cabinet Grotesk 800", "General Sans 400", "General Sans 500", "General Sans 600"]);
  // no weight that isn't loaded: General Sans stops at 600 (700 and 800 are Cabinet Grotesk's)
  for (const f of ["crm-app/styles/crm.css"]) {
    const text = readFileSync(f, "utf8");
    assert.doesNotMatch(text, /font:\s*(700|800|900)[^;}]*var\(--text\)/, `${f}: General Sans has no 700 or 800 here`);
    assert.doesNotMatch(text, /font(-weight)?:\s*(900|bold)\b/, `${f}: a weight that isn't loaded`);
    for (const m of text.matchAll(/([^{}]*)\{([^}]*font-weight:\s*(700|800)[^}]*)\}/g)) assert.ok(!/var\(--text\)/.test(m[2]), `${f}: ${m[1].trim().slice(-50)} sets a General Sans weight over 600`);
  }
  for (const m of css.matchAll(/font-size:(\d+(?:\.\d+)?)px/g)) {
    const before = css.slice(Math.max(0, m.index - 200), m.index);
    if (/(input|select|textarea)[^{}]*\{[^}]*$/.test(before)) assert.ok(Number(m[1]) >= 16, "an input under 16 px: " + before.slice(-60));
  }
  const wide = /@media \(min-width:900px\)\{([\s\S]*?)\n\}/.exec(css);
  assert.ok(wide, "a wide-screen block");
  assert.match(wide[1], /\.tabs\{[^}]*flex-direction:column/, "the tab bar becomes a left rail");
  assert.match(wide[1], /\.app:not\(\.no-tabs\)\{padding-left:var\(--rail-w\)\}/);
});
