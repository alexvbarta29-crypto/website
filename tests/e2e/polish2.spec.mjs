// Phone checks of the Nov 14 polish (iPhone 13 and SE): photos show as
// thumbnails and open whole in a sheet on a tap (a photo from before
// thumbnails falls back to itself); claude.ai's Connect lands on the CRM's
// Connect Claude screen, Allow goes back to claude.ai with a code that
// trades (PKCE) for a token the MCP endpoint takes, and Settings → Claude
// connector lists the connection and disconnects it. Synthetic data only.
// Run alone: node --test --test-concurrency=1 tests/e2e/polish2.spec.mjs
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { start } from "./server.mjs";
import { launch, phone, signIn, crmFrame, goTo, settled, screenProblems, shot, noInstallCard } from "./kit.mjs";

const store = await import("../../netlify/lib/crm-store.mjs");
const AS = (id) => ({ by: id, origin: "api", actor_kind: "user", requestId: "e2e-polish2" });

let srv, browser, seeded, task;
before(async () => { srv = await start({ port: Number(process.env.E2E_PORT) || 8921 }); seeded = await srv.seed(); browser = await launch(); });
after(async () => { await browser?.close(); await srv?.close(); });

const CB = "https://claude.ai/api/mcp/auth_callback";
const VERIFIER = "e2e-synthetic-pkce-verifier-0123456789-abcdefghij";
const CHALLENGE = createHash("sha256").update(VERIFIER).digest("base64url");

// Real JPEGs (the browser draws them): a 1600 px photo and its 400 px thumbnail.
async function jpegs(page) {
  const make = (w, h) => page.evaluate(([w, h]) => {
    const c = document.createElement("canvas");
    c.width = w; c.height = h;
    const g = c.getContext("2d");
    g.fillStyle = "#2a78d6"; g.fillRect(0, 0, w, h);
    g.fillStyle = "#fff"; g.fillRect(w / 4, h / 4, w / 2, h / 2);
    return c.toDataURL("image/jpeg", 0.8).split(",")[1];
  }, [w, h]);
  return { full: Buffer.from(await make(1600, 1200), "base64"), thumb: Buffer.from(await make(400, 300), "base64") };
}

// A customer's work request with two photos: one with its thumbnail, one from before thumbnails.
async function requestWithPhotos(page) {
  if (task) return task;
  const { full, thumb } = await jpegs(page);
  const owner = seeded.users.owner.id;
  task = await store.withStoreScope({ requestId: "e2e-polish2" }, async () => {
    const t = (await store.createRecord("task", { title: "Work request: Gutter cleaning", kind: "todo", priority: "medium", status: "open", assignee_ids: [owner], notes: "From the customer's account (portal).", contact_id: seeded.contacts.customer, source: "portal" }, AS(owner))).data;
    const ids = [];
    for (const withThumb of [true, false]) {
      const f = (await store.createRecord("file", { kind: "photo", content_type: "image/jpeg", bytes: full.length, sha256: createHash("sha256").update(full).digest("hex"), owner: { type: "task", id: t.id }, contact_id: t.contact_id, customer_visible: false, has_thumb: withThumb, source: "portal" }, AS(owner))).data;
      await store.putFileBytes(f.id, full, { ct: "image/jpeg", bytes: full.length });
      if (withThumb) await store.putFileBytes(f.id, thumb, { ct: "image/jpeg", bytes: thumb.length }, { thumb: true });
      ids.push(f.id);
    }
    return (await store.updateRecord("task", t.id, (x) => ({ ...x, photo_ids: ids }), AS(owner))).data;
  });
  return task;
}

async function openOffice(login, device) {
  const p = await phone(browser, srv, { device });
  await signIn(p, login);
  await p.page.goto("/office");
  const f = await crmFrame(p.page);
  await settled(f);
  await noInstallCard(p.page);
  return { p, page: p.page, f };
}

for (const device of ["iphone13", "iphonese"]) {
  test(`photos (${device}): thumbnails on the task and in the list, the whole photo in a sheet on a tap`, async () => {
    const { p, page, f } = await openOffice("olive", device);
    try {
      const t = await requestWithPhotos(page);
      await goTo(f, `/tasks/${t.id}`);
      await f.waitForFunction(() => [...document.querySelectorAll(".sl-photos .ph-tile img")].length === 2 && [...document.querySelectorAll(".sl-photos .ph-tile img")].every((i) => i.complete && i.naturalWidth > 0), null, { timeout: 8000 });
      const widths = await f.$$eval(".sl-photos .ph-tile img", (els) => els.map((i) => i.naturalWidth));
      assert.deepEqual(widths, [400, 1600], "the thumbnail, and the older photo standing in for its own");
      assert.deepEqual(await screenProblems(f), []);
      await shot(page, `polish2-task-photos-${device}`);
      await f.click(".sl-photos .ph-tile");
      await f.waitForFunction(() => { const i = document.querySelector(".sheet.on .ph-full img"); return !!i && i.complete && i.naturalWidth === 1600; }, null, { timeout: 8000 });
      const fit = await f.$eval(".sheet.on .ph-full img", (i) => { const r = i.getBoundingClientRect(); return r.right <= innerWidth + 1 && r.width > 0; });
      assert.ok(fit, "the whole photo fits the screen");
      assert.deepEqual(await screenProblems(f), []);
      await shot(page, `polish2-photo-sheet-${device}`);
      await f.click(".sheet.on [data-sheet-x]");
      await f.waitForFunction(() => !document.querySelector(".sheet.on"), null, { timeout: 5000 });
      // the office's task list: the first photo's thumbnail
      await goTo(f, "/tasks");
      await f.waitForFunction((id) => { const a = document.querySelector(`a[href="#/tasks/${id}"] .sl-thumb img`); return !!a && a.complete && a.naturalWidth === 400; }, t.id, { timeout: 8000 });
      assert.deepEqual(await screenProblems(f), []);
      await p.clean();
    } finally { await p.close(); }
  });

  test(`Connect Claude (${device}): claude.ai's Connect, the consent screen, Allow, a working token; disconnect in Settings`, async () => {
    const p = await phone(browser, srv, { device });
    try {
      await signIn(p, "olive");
      const reg = await p.ctx.request.post("/api/crm/auth/oauth/register", { data: { client_name: "Claude", redirect_uris: [CB] } });
      assert.equal(reg.status(), 201);
      const cid = (await reg.json()).client_id;
      const q = new URLSearchParams({ response_type: "code", client_id: cid, redirect_uri: CB, code_challenge: CHALLENGE, code_challenge_method: "S256", state: `e2e-${device}`, scope: "crm:read crm:ask", resource: `${srv.url}/api/crm/mcp` });
      // claude.ai's callback, stubbed (nothing leaves this machine)
      await p.page.route((u) => u.origin === "https://claude.ai", (route) => route.fulfill({ status: 200, contentType: "text/html", body: "<!doctype html><title>Claude</title><p>Connected</p>" }));
      await p.page.goto(`/api/crm/auth/oauth/authorize?${q}`);
      const f = await crmFrame(p.page);
      await settled(f);
      assert.match(p.page.url(), /\/crm#\/claude-connect\/bcrq_[0-9a-f]{32}$/);
      const text = await f.textContent("#view");
      assert.match(text, /Claude wants to connect to Barta CRM as Olive/);
      assert.match(text, /go back to claude\.ai/);
      assert.match(text, /Only allow this if you just tapped Connect in Claude yourself/);
      assert.ok(await f.$eval("[data-ask]", (i) => i.checked), "asking ticked");
      assert.deepEqual(await screenProblems(f), []);
      await shot(p.page, `polish2-connect-${device}`);
      const csp = await p.csp();
      assert.deepEqual(csp, [], "no CSP violations on the consent screen");
      await Promise.all([p.page.waitForURL((u) => u.origin === "https://claude.ai", { timeout: 8000 }), f.click("[data-allow]")]);
      const back = new URL(p.page.url());
      assert.equal(back.origin + back.pathname, CB);
      assert.equal(back.searchParams.get("state"), `e2e-${device}`);
      const code = back.searchParams.get("code");
      assert.match(code, /^bcac_/);
      // claude.ai's server trades the code (PKCE) and calls the MCP endpoint
      const tok = await (await fetch(`${srv.url}/api/crm/auth/oauth/token`, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ grant_type: "authorization_code", code, redirect_uri: CB, code_verifier: VERIFIER, client_id: cid }) })).json();
      assert.match(tok.access_token, /^bcat_/, JSON.stringify(tok));
      const mcp = (key) => fetch(`${srv.url}/api/crm/mcp`, { method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${key}` }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }) });
      const listed = await (await mcp(tok.access_token)).json();
      assert.ok(listed.result.tools.some((x) => x.name === "send_message"), "the asking tools");

      // Settings → Claude connector: the connection, and Disconnect
      await p.page.goto("/office");
      const of = await crmFrame(p.page);
      await settled(of);
      await noInstallCard(p.page);
      await goTo(of, "/settings/claude");
      await of.waitForSelector("[data-disconnect]");
      assert.match(await of.textContent("#view"), /Connected apps[\s\S]*Claude[\s\S]*Can ask · via claude\.ai/);
      assert.deepEqual(await screenProblems(of), []);
      await shot(p.page, `polish2-settings-claude-${device}`);
      const n = await of.$$eval("[data-disconnect]", (b) => b.length);
      await of.click("[data-disconnect]");
      await of.waitForSelector(".sheet.on [data-a=yes]");
      await of.click(".sheet.on [data-a=yes]");
      await of.waitForFunction((k) => document.querySelectorAll("[data-disconnect]").length === k - 1, n, { timeout: 8000 });
      assert.equal((await mcp(tok.access_token)).status, 401, "disconnected: the token stops");
      await p.clean();
    } finally { await p.close(); }
  });
}
