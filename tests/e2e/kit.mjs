// What every phone check shares (design §12.4): Playwright's Chromium from
// the machine's own `playwright` package (never a dependency of this site:
// Netlify installs package.json's dependencies on every deploy), phone-sized
// contexts, and the checks every screen must pass.
//
//   const browser = await launch();
//   const p = await phone(browser, srv, { device: "iphonese", office: true });   // { ctx, page, errors, ... }
//   await signIn(p, "theo");                  // a CRM session cookie for this context
//   const f = await crmFrame(p.page);          // the CRM inside /office
//   await p.clean();                           // no console errors, no CSP violations, no 5xx
//
// Nothing leaves this machine: every request to another host is aborted
// (and recorded in p.outside), so Rotor, Google and the rest never see one.
import { createRequire } from "node:module";
import assert from "node:assert/strict";

const require = createRequire(import.meta.url);
export function playwright() {
  try {
    return require("playwright");
  } catch (e) {
    throw new Error("npm run e2e needs Playwright and its Chromium on this machine (not a dependency of the site): npm i -g playwright && npx playwright install chromium");
  }
}
export const launch = () => playwright().chromium.launch();

export const DEVICES = {
  iphone13: { viewport: { width: 390, height: 844 } },
  iphonese: { viewport: { width: 375, height: 667 } },
  // the office desk and a small laptop or an iPad on its side: mouse, no touch, a desktop browser
  desk1440: { viewport: { width: 1440, height: 900 }, desktop: true },
  desk1024: { viewport: { width: 1024, height: 768 }, desktop: true },
};
export const UA = "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1";
export const DESK_UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";
export const OFFICE_PASSWORD = "test-password";

// The office cookie the server sets for the office password (lights-auth.mjs derive()).
async function officeCookie(srv) {
  const res = await fetch(srv.url + "/office", { method: "POST", body: new URLSearchParams({ password: OFFICE_PASSWORD }), redirect: "manual" });
  const c = (res.headers.getSetCookie ? res.headers.getSetCookie() : [res.headers.get("set-cookie")]).find((x) => x && x.startsWith("barta_office="));
  assert.ok(c, "the office password gives the office cookie");
  return c.split(";")[0].split("=").slice(1).join("=");
}

export async function phone(browser, srv, { device = "iphone13", office = false, serviceWorkers = "allow" } = {}) {
  const d = DEVICES[device];
  const ctx = await browser.newContext({ viewport: d.viewport, deviceScaleFactor: 1, isMobile: !d.desktop, hasTouch: !d.desktop, userAgent: d.desktop ? DESK_UA : UA, serviceWorkers, baseURL: srv.url });
  const outside = [];
  await ctx.route((url) => url.origin !== srv.url, (route) => { outside.push(route.request().url()); return route.abort(); });
  // every document, frames too: CSP violations are collected, never ignored.
  // On window, not document: a frame's first navigation keeps the window of
  // its initial about:blank document (and this script's first run) but not
  // that document, so a document listener would hear nothing.
  await ctx.addInitScript(() => {
    if (window.__cspOn) return;
    window.__cspOn = true;
    window.__csp = [];
    window.addEventListener("securitypolicyviolation", (e) => window.__csp.push(`${e.violatedDirective} ${e.blockedURI} (${location.pathname})`));
  });
  if (office) await ctx.addCookies([{ name: "barta_office", value: await officeCookie(srv), url: srv.url }]);
  const page = await ctx.newPage();
  const errors = [];
  const watch = (pg) => {
    pg.on("console", (m) => { if (m.type() === "error") errors.push(`${m.text()} @ ${m.location().url || ""}`); });
    pg.on("pageerror", (e) => errors.push(String(e)));
  };
  watch(page);
  ctx.on("page", watch);
  const p = {
    ctx, page, errors, outside, srv,
    // every frame's CSP violations
    async csp() {
      const out = [];
      for (const pg of ctx.pages()) for (const f of pg.frames()) out.push(...(await f.evaluate(() => window.__csp || []).catch(() => [])));
      return out;
    },
    // console errors the CRM can't help: a request this harness refused (another host, or offline on purpose)
    async clean({ allow = [] } = {}) {
      const real = errors.filter((e) => !/net::ERR_(FAILED|INTERNET_DISCONNECTED|ABORTED)|Failed to load resource/.test(e) && !allow.some((re) => re.test(e)));
      assert.deepEqual(real, [], "no console errors");
      assert.deepEqual(await p.csp(), [], "no CSP violations");
      assert.deepEqual(srv.errors.splice(0), [], "no 5xx from the server");
    },
    close: () => ctx.close(),
  };
  return p;
}

// A CRM session for this context (the Team sign-in API, as the sign-in page sends it).
export async function signIn(p, login, password = "a long synthetic passphrase") {
  const res = await p.ctx.request.post("/api/crm/auth/login", { headers: { "content-type": "application/json", "x-crm": "1" }, data: { login, password } });
  assert.equal(res.status(), 200, `${login} signs in (${res.status()})`);
}

// The CRM frame inside /office (solo or a tab), once its shell has started.
export async function crmFrame(page, { timeout = 10000 } = {}) {
  const deadline = Date.now() + timeout;
  for (;;) {
    const f = page.frames().find((x) => { try { return new URL(x.url()).pathname === "/crm"; } catch { return false; } });
    if (f && (await f.$("#view").catch(() => null))) return f;
    if (Date.now() > deadline) throw new Error("the CRM frame did not start: " + page.frames().map((x) => x.url()).join(", "));
    await page.waitForTimeout(100);
  }
}

// Goes to a CRM route inside the frame (as a tap on a link would) and waits for the screen.
export async function goTo(frame, path) {
  await frame.evaluate((p) => { location.hash = p; }, path);
  await settled(frame, { hash: "#" + path });
}
// The screen has loaded: the address is `hash` (when given; a tap's route
// change comes a moment later) and no skeleton is left in #view.
export async function settled(frame, { hash, timeout = 10000 } = {}) {
  if (hash) {
    await frame.waitForFunction((h) => location.hash === h, hash, { timeout });
    await frame.evaluate(() => new Promise((ok) => setTimeout(ok, 30)));   // the hashchange task runs first
  }
  // (and, on a wide screen, the detail beside a list)
  await frame.waitForFunction(() => {
    const v = document.getElementById("view");
    const p = document.getElementById("pane");
    return v && v.children.length && !v.querySelector("[aria-busy=true]") && (!p || p.hidden || (p.children.length && !p.querySelector("[aria-busy=true]")));
  }, null, { timeout });
}
// Closes the office's "Get the app" card (a person does once; it floats over the CRM's bottom edge).
export async function noInstallCard(page) {
  const x = await page.$("#install-x");
  if (x && (await x.isVisible())) await x.click();
}
export const title = (frame) => frame.evaluate(() => (document.getElementById("top-title") || {}).textContent || "");
export const hashOf = (frame) => frame.evaluate(() => location.hash);
export const backShown = (frame) => frame.evaluate(() => { const b = document.getElementById("top-back"); return !!b && !b.hidden; });

// Links that leave the CRM (another origin, or the portal /p/...) must open a new tab.
export async function badLinks(frame) {
  return frame.evaluate(() => [...document.querySelectorAll("a[href]")].filter((a) => {
    const href = a.getAttribute("href");
    if (/^(tel|sms|mailto):/i.test(href) || a.dataset.external === "top") return false;
    let u;
    try { u = new URL(href, location.href); } catch (e) { return true; }
    if (!/^https?:$/.test(u.protocol)) return false;
    const leaves = u.origin !== location.origin || /^\/p(\/|$)/.test(u.pathname);
    return leaves && !(a.target === "_blank" && /noopener/.test(a.rel || ""));
  }).map((a) => a.outerHTML.slice(0, 120)));
}

// A swipe with real touch events (CDP: Chromium only).
export async function swipe(page, from, to, steps = 8) {
  const cdp = await page.context().newCDPSession(page);
  const pt = (x, y) => [{ x, y, id: 1, radiusX: 2, radiusY: 2, force: 1 }];
  await cdp.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: pt(from.x, from.y) });
  for (let i = 1; i <= steps; i++) {
    const x = from.x + ((to.x - from.x) * i) / steps;
    const y = from.y + ((to.y - from.y) * i) / steps;
    await cdp.send("Input.dispatchTouchEvent", { type: "touchMove", touchPoints: pt(x, y) });
  }
  await cdp.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
  await cdp.detach();
}

// A tap where an element is now (a real touch, without Playwright scrolling it into view first).
export async function tap(page, frame, selector) {
  const o = await frameOffset(page, frame);
  const r = await frame.$eval(selector, (el) => { const b = el.getBoundingClientRect(); return { x: b.left + b.width / 2, y: b.top + b.height / 2 }; });
  await page.touchscreen.tap(o.x + r.x, o.y + r.y);
}

// Where a frame sits on the page (touch points are page coordinates).
export async function frameOffset(page, frame) {
  const el = await frame.frameElement().catch(() => null);
  if (!el) return { x: 0, y: 0 };
  const b = await el.boundingBox();
  return { x: b.x, y: b.y };
}

// The phone checks every screen passes (§9.4): no sideways scroll, tap
// targets of 44 px, inputs of 16 px (no iOS zoom). → a list of problems.
// A desk with a mouse (900 px and up, a fine pointer: never a phone or a
// tablet) may have controls of 32 px; the CSS sizes them for the pointer.
export async function screenProblems(frame) {
  return frame.evaluate(() => {
    const out = [];
    const min = matchMedia("(min-width: 900px) and (hover: hover) and (pointer: fine)").matches ? 31.5 : 43.5;
    if (document.documentElement.scrollWidth > innerWidth + 1) out.push(`scrolls sideways (${document.documentElement.scrollWidth} > ${innerWidth})`);
    for (const el of document.querySelectorAll("#view a, #view button, #view select, #view input:not([type=checkbox]):not([type=radio]), #pane a, #pane button, #pane select, #pane input:not([type=checkbox]):not([type=radio]), .top button, .tabs .tab, .sheet a, .sheet button, .fab")) {
      const r = el.getBoundingClientRect();
      if (!r.width || !r.height || getComputedStyle(el).visibility === "hidden" || el.classList.contains("sr") || el.closest("[hidden]")) continue;
      const box = el.closest("label") ? el.closest("label").getBoundingClientRect() : r;
      if (box.height < min || box.width < min) out.push(`small tap target ${el.tagName.toLowerCase()} "${(el.textContent || el.getAttribute("aria-label") || el.name || "").trim().slice(0, 24)}" ${Math.round(box.width)}x${Math.round(box.height)}`);
    }
    for (const i of document.querySelectorAll("#view input:not([type=checkbox]):not([type=radio]), #view select, #view textarea, #pane input:not([type=checkbox]):not([type=radio]), #pane select, #pane textarea, .sheet input:not([type=checkbox]):not([type=radio]), .sheet select, .sheet textarea")) {
      if (i.offsetParent && !i.classList.contains("sr") && parseFloat(getComputedStyle(i).fontSize) < 16) out.push(`input under 16 px: ${i.name || i.id}`);
    }
    return out;
  });
}

export async function shot(page, name) {
  if (!process.env.E2E_SHOTS) return;
  const { mkdirSync } = await import("node:fs");
  mkdirSync(process.env.E2E_SHOTS, { recursive: true });
  await page.screenshot({ path: `${process.env.E2E_SHOTS}/${name}.png` });
}
