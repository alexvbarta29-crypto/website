// Web push in the office app (design §5.7.7, §2.4): office-sw.js shows a
// push (title, body, a /office#crm link; anything else falls back to Today)
// and a tap focuses or opens the installed app there; the office shell asks
// for permission itself (iOS lets only the installed app's own page ask)
// when the CRM frame posts crm:push_request, and saves the subscription.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";

function loadSw() {
  const handlers = {};
  const shown = [];
  const opened = [];
  const sandbox = {
    self: {
      addEventListener: (type, fn) => { handlers[type] = fn; }, skipWaiting: async () => {},
      registration: { showNotification: async (title, opts) => { shown.push({ title, opts }); } },
      clients: { claim: async () => {}, matchAll: async () => [], openWindow: async (u) => { opened.push(u); return null; } },
    },
    caches: { open: async () => ({ add: async () => {}, addAll: async () => {} }), keys: async () => [], match: async () => undefined },
    location: { origin: "https://x.test" }, fetch: async () => new Response("x"), Response, URL, Promise,
  };
  vm.createContext(sandbox);
  vm.runInContext(readFileSync("office-sw.js", "utf8"), sandbox);
  const fire = async (type, ev) => { const w = []; handlers[type]({ ...ev, waitUntil: (p) => w.push(p) }); await Promise.all(w); };
  return { fire, shown, opened };
}

test("office-sw.js shows a push with its link inside the app, and a tap opens /office#crm/<path>", async () => {
  const sw = loadSw();
  await sw.fire("push", { data: { json: () => ({ title: "New lead: Pat in Delano", body: "Website quote form", link: "/approvals", id: "nt_x" }) } });
  assert.equal(sw.shown.length, 1);
  assert.equal(sw.shown[0].title, "New lead: Pat in Delano");
  assert.equal(sw.shown[0].opts.body, "Website quote form");
  assert.equal(sw.shown[0].opts.data.url, "/office#crm/approvals");
  await sw.fire("push", { data: { json: () => ({ title: "x", link: "javascript:alert(1)" }) } });
  assert.equal(sw.shown[1].opts.data.url, "/office#crm/today", "a link that isn't a CRM path falls back to Today");
  await sw.fire("push", { data: { json: () => { throw new Error("not json"); }, text: () => "plain words" } });
  assert.equal(sw.shown[2].title, "Barta CRM");
  let closed = false;
  await sw.fire("notificationclick", { notification: { close: () => { closed = true; }, data: { url: "/office#crm/approvals" } } });
  assert.ok(closed);
  assert.deepEqual(sw.opened, ["/office#crm/approvals"], "no window open: the app opens there");
});

test("the office shell asks for notifications itself and saves the subscription for the CRM", async () => {
  const { officeHtml } = await import("../../../netlify/lib/office-page.mjs");
  for (const page of [officeHtml(), officeHtml({ solo: true })]) {
    assert.match(page, /id="pushask"/);
    assert.match(page, /m\.type === 'crm:push_request'/);
    assert.match(page, /Notification\.requestPermission\(\)/);
    assert.match(page, /pushManager\.subscribe\(\{ userVisibleOnly: true, applicationServerKey: keyBytes\(pushKey\) \}\)/);
    assert.match(page, /fetch\('\/api\/crm\/push\/subscriptions', \{ method: 'POST'/);
    assert.match(page, /'X-CRM': '1'/);
    assert.match(page, /type: 'office:push'/);
  }
});
