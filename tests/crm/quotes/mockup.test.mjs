// The automatic Christmas lights mockup's server half (the owner, Nov 16):
// the house photo from Street View (Google mocked), Claude's lines (the
// Messages API mocked: nothing leaves the machine), the answer's checks, the
// fallbacks (no key, the day's budget, a slow or refusing model, nothing
// usable), the route permissions, and that only the photo reaches the
// model, never a name, phone or address. Synthetic data only.
import { test } from "node:test";
import assert from "node:assert/strict";
import { setup, makeContact, scope, store, AS, pin } from "./fixtures.mjs";

const M = await import("../../../netlify/lib/crm/modules/quotes/mockup.mjs");

// a JPEG header that says 640 x 480 (jpegSize reads the SOF marker; nothing decodes it)
export function fakeJpeg(w = 640, h = 480) {
  const app0 = [0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00, 0x01, 0x01, 0x00, 0x00, 0x01, 0x00, 0x01, 0x00, 0x00];
  const sof = [0xff, 0xc0, 0x00, 0x11, 0x08, h >> 8, h & 255, w >> 8, w & 255, 0x03, 0x01, 0x22, 0x00, 0x02, 0x11, 0x01, 0x03, 0x11, 0x01];
  return new Uint8Array([0xff, 0xd8, ...app0, ...sof, ...new Array(64).fill(0), 0xff, 0xd9]);
}

const ANSWER = {
  house_found: true,
  lines: [
    { kind: "eave", points: [{ x: 120, y: 260 }, { x: 520, y: 262 }] },
    { kind: "rake", points: [{ x: 120, y: 260 }, { x: 320, y: 150 }, { x: 520, y: 262 }] },
    { kind: "bush", points: [{ x: 140, y: 380 }, { x: 200, y: 360 }, { x: 240, y: 390 }, { x: 180, y: 410 }] },
  ],
};

// Google and Claude, mocked. claude(): the reply for each Messages call.
function net({ claude = () => Response.json({ stop_reason: "end_turn", content: [{ type: "text", text: JSON.stringify(ANSWER) }], usage: { input_tokens: 1400, output_tokens: 300 } }), google = {} } = {}) {
  const calls = { google: [], claude: [] };
  const saved = globalThis.fetch;
  globalThis.fetch = async (url, init = {}) => {
    const u = String(url);
    if (u.startsWith("https://maps.googleapis.com/")) {
      calls.google.push(u);
      if (u.includes("/geocode/json")) return Response.json(google.geocode || { status: "OK", results: [{ geometry: { location: { lat: 45.0416, lng: -93.7889 } } }] });
      if (u.includes("/streetview/metadata")) return Response.json(google.metadata || { status: "OK", pano_id: "pano_synthetic_0001", location: { lat: 45.0414, lng: -93.7893 } });
      if (u.includes("/streetview?")) return google.image ? google.image() : new Response(fakeJpeg(), { status: 200, headers: { "content-type": "image/jpeg" } });
    }
    if (u === M.CLAUDE_URL) { calls.claude.push({ url: u, init }); return claude(init, calls.claude.length); }
    throw new TypeError("unexpected request " + u);
  };
  return { calls, restore: () => { globalThis.fetch = saved; } };
}

function withEnv(vars, fn) {
  const saved = {};
  for (const [k, v] of Object.entries(vars)) { saved[k] = process.env[k]; if (v === undefined) delete process.env[k]; else process.env[k] = v; }
  return Promise.resolve().then(fn).finally(() => { for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; } });
}

async function house(owner) {
  const c = await makeContact(owner);
  const p = (await scope(() => store.createRecord("property", { contact_id: c.id, label: "Home", address: { street1: "300 Example Ave", city: "Delano", state: "MN", zip: "55328" }, access: {}, assets: { roofline_ft: 110 }, photo_ids: [] }, AS(owner)))).data;
  return { c, p };
}

test("parseLines: known kinds, points in the photo, tiny and far-off lines dropped, usable only with a roof line", () => {
  const ok = M.parseLines(ANSWER, 640, 480);
  assert.equal(ok.usable, true);
  assert.deepEqual(ok.lines.map((l) => [l.kind, l.points.length]), [["eave", 2], ["rake", 3], ["bush", 4]]);
  assert.deepEqual(ok.lines[1].points[1], [320, 150]);
  assert.deepEqual(M.parseLines(JSON.stringify(ANSWER), 640, 480).lines, ok.lines, "the JSON text works too");
  // slightly outside: pulled to the edge; far outside: the whole line goes
  const edge = M.parseLines({ house_found: true, lines: [{ kind: "eave", points: [{ x: -10, y: 100 }, { x: 650, y: 101 }] }, { kind: "eave", points: [{ x: 10, y: 100 }, { x: 9000, y: 100 }] }] }, 640, 480);
  assert.deepEqual(edge.lines, [{ kind: "eave", points: [[0, 100], [640, 101]] }]);
  // tiny, unknown, broken, duplicate points
  const junk = M.parseLines({ house_found: true, lines: [
    { kind: "eave", points: [{ x: 10, y: 10 }, { x: 15, y: 10 }] },
    { kind: "window", points: [{ x: 10, y: 10 }, { x: 300, y: 10 }] },
    { kind: "rake", points: [{ x: "a", y: 1 }, { x: 300, y: 10 }] },
    { kind: "eave", points: [{ x: 100, y: 200 }, { x: 100.5, y: 200 }, { x: 400, y: 200 }] },
    { kind: "bush", points: [{ x: 1, y: 1 }, { x: 2, y: 2 }, { x: 3, y: 1 }] },
  ] }, 640, 480);
  assert.deepEqual(junk.lines, [{ kind: "eave", points: [[100, 200], [400, 200]] }]);
  assert.equal(M.parseLines({ house_found: false, lines: ANSWER.lines }, 640, 480).usable, false, "no house: nothing drawn");
  assert.equal(M.parseLines({ house_found: true, lines: [ANSWER.lines[2]] }, 640, 480).usable, false, "a bush alone isn't a mockup");
  for (const bad of [null, "not json", { lines: "x" }, 42]) assert.deepEqual(M.parseLines(bad, 640, 480), { lines: [], usable: false });
  assert.deepEqual(M.parseLines(ANSWER, 0, 480), { lines: [], usable: false });
  assert.ok(M.parseLines({ house_found: true, lines: Array.from({ length: 200 }, (_, i) => ({ kind: "eave", points: [{ x: 0, y: i }, { x: 600, y: i }] })) }, 640, 480).lines.length <= M.MAX_LINES);
});

test("jpegSize reads the SOF marker; not a JPEG is null", () => {
  assert.deepEqual(M.jpegSize(fakeJpeg(640, 480)), { w: 640, h: 480 });
  assert.deepEqual(M.jpegSize(fakeJpeg(320, 200)), { w: 320, h: 200 });
  assert.equal(M.jpegSize(new Uint8Array([0x89, 0x50, 0x4e, 0x47])), null);
  assert.equal(M.jpegSize(new Uint8Array([0xff, 0xd8, 0xff])), null);
});

test("the photo: Street View aimed at the house, cached per property; without the Google key the app is told why; techs can't", async () => {
  const { t, owner, tech } = await setup();
  const n = net();
  try {
    const { p } = await house(owner);
    await withEnv({ GOOGLE_MAPS_API_KEY: undefined }, async () => {
      const off = await t.api("/lights-mockup/photo", { method: "POST", as: owner, body: { property_id: p.id } });
      assert.equal(off.status, 200);
      assert.deepEqual(off.body.data, { photo: null, reason: "streetview_off" });
    });
    await withEnv({ GOOGLE_MAPS_API_KEY: "test-google-key" }, async () => {
      assert.equal((await t.api("/lights-mockup/photo", { method: "POST", as: tech, body: { property_id: p.id } })).status, 403);
      const r = await t.api("/lights-mockup/photo", { method: "POST", as: owner, body: { property_id: p.id } });
      assert.equal(r.status, 200, JSON.stringify(r.body));
      assert.equal(r.body.data.photo.w, 640);
      assert.equal(r.body.data.photo.h, 480);
      assert.match(r.body.data.photo.url, new RegExp(`^/api/crm/lights-mockup/${p.id}/photo\\.jpg\\?v=`), "a same-origin URL (the app's CSP)");
      const geocodes = n.calls.google.filter((u) => u.includes("/geocode/")).length;
      assert.equal(geocodes, 1, "no map point on the property: one geocode");
      const img = n.calls.google.find((u) => u.includes("/streetview?"));
      assert.match(img, /pano=pano_synthetic_0001/);
      assert.match(img, /heading=\d+/);
      const before = n.calls.google.length;
      const again = await t.api("/lights-mockup/photo", { method: "POST", as: owner, body: { property_id: p.id } });
      assert.equal(again.body.data.photo.at, r.body.data.photo.at);
      assert.equal(n.calls.google.length, before, "the second look costs Google nothing");
      const file = await t.api(`/lights-mockup/${p.id}/photo.jpg`, { as: owner });
      assert.equal(file.status, 200);
      assert.equal(file.headers.get("content-type"), "image/jpeg");
      assert.equal(file.headers.get("x-content-type-options"), "nosniff");
      assert.equal((await t.api(`/lights-mockup/${p.id}/photo.jpg`, { as: tech })).status, 403);
      assert.equal((await t.api("/lights-mockup/photo", { method: "POST", as: owner, body: { property_id: "pr_nope" } })).status, 400);
    });
    // no Street View there
    await withEnv({ GOOGLE_MAPS_API_KEY: "test-google-key" }, async () => {
      n.restore();
      const n2 = net({ google: { metadata: { status: "ZERO_RESULTS" } } });
      try {
        const { p: p2 } = await house(owner);
        assert.deepEqual((await t.api("/lights-mockup/photo", { method: "POST", as: owner, body: { property_id: p2.id } })).body.data, { photo: null, reason: "no_imagery" });
      } finally { n2.restore(); }
    });
  } finally { n.restore(); t.done(); }
});

test("the lines: only the photo goes to Claude (structured JSON, Opus 5.5, cached instructions); cached until Regenerate", async () => {
  const { t, owner } = await setup();
  const n = net();
  try {
    const { c, p } = await house(owner);
    await withEnv({ GOOGLE_MAPS_API_KEY: "test-google-key", ANTHROPIC_API_KEY: "test-anthropic-key" }, async () => {
      assert.equal((await t.api("/lights-mockup/lines", { method: "POST", as: owner, body: { property_id: p.id } })).status, 409, "the photo first");
      await t.api("/lights-mockup/photo", { method: "POST", as: owner, body: { property_id: p.id } });
      const r = await t.api("/lights-mockup/lines", { method: "POST", as: owner, body: { property_id: p.id } });
      assert.equal(r.status, 200, JSON.stringify(r.body));
      assert.equal(r.body.data.source, "claude");
      assert.deepEqual(r.body.data.lines.map((l) => l.kind), ["eave", "rake", "bush"]);
      assert.equal(n.calls.claude.length, 1);
      const call = n.calls.claude[0];
      const sent = JSON.parse(call.init.body);
      assert.equal(call.init.headers["x-api-key"], "test-anthropic-key");
      assert.equal(call.init.headers["anthropic-version"], M.CLAUDE_VERSION);
      assert.equal(sent.model, "claude-opus-5-5");
      assert.equal(sent.output_config.format.type, "json_schema");
      assert.equal(sent.output_config.effort, "low");
      assert.equal(sent.system[0].cache_control.type, "ephemeral");
      assert.equal(sent.system[0].text, M.SYSTEM_PROMPT, "the cached prefix never changes");
      assert.equal(sent.messages[0].content[0].type, "image");
      assert.equal(sent.messages[0].content[0].source.media_type, "image/jpeg");
      // never the customer's name, phone, email or address
      const body = call.init.body;
      for (const s of [c.first_name, c.last_name, c.phones[0].e164, c.emails[0].address, "Example Ave", "Delano", p.id, c.id]) assert.ok(!body.includes(s), `the request holds ${s}`);
      assert.ok(!t.logs().some((l) => l.includes("test-anthropic-key")), "the key is never logged");
      // a second look: the cached lines; Regenerate asks again
      const again = await t.api("/lights-mockup/lines", { method: "POST", as: owner, body: { property_id: p.id } });
      assert.equal(again.body.data.cached, true);
      assert.equal(n.calls.claude.length, 1);
      await t.api("/lights-mockup/lines", { method: "POST", as: owner, body: { property_id: p.id, regenerate: true } });
      assert.equal(n.calls.claude.length, 2);
    });
  } finally { n.restore(); t.done(); }
});

test("fallbacks: no key, the day's budget, a busy / refusing / slow model, nothing usable: source none with the reason (the app's edge finder takes over)", async () => {
  const { t, owner } = await setup();
  let reply = () => Response.json({ stop_reason: "end_turn", content: [{ type: "text", text: JSON.stringify(ANSWER) }] });
  const n = net({ claude: (init, i) => reply(init, i) });
  try {
    const { p } = await house(owner);
    await withEnv({ GOOGLE_MAPS_API_KEY: "k", ANTHROPIC_API_KEY: undefined, CRM_MOCKUP_DAILY_MAX: "3" }, async () => {
      await t.api("/lights-mockup/photo", { method: "POST", as: owner, body: { property_id: p.id } });
      const nokey = await t.api("/lights-mockup/lines", { method: "POST", as: owner, body: { property_id: p.id } });
      assert.deepEqual(nokey.body.data, { source: "none", reason: "no_key", lines: [], w: 640, h: 480 });
      assert.equal(n.calls.claude.length, 0);
    });
    await withEnv({ GOOGLE_MAPS_API_KEY: "k", ANTHROPIC_API_KEY: "test-anthropic-key", CRM_MOCKUP_DAILY_MAX: "3" }, async () => {
      const ask = async (as = owner) => (await t.api("/lights-mockup/lines", { method: "POST", as, body: { property_id: p.id, regenerate: true } })).body.data;
      reply = () => new Response(JSON.stringify({ type: "error", error: { type: "overloaded_error" } }), { status: 529 });
      assert.equal((await ask()).reason, "busy");
      reply = () => Response.json({ stop_reason: "refusal", content: [], stop_details: { type: "refusal", category: null } });
      assert.equal((await ask()).reason, "refused");
      reply = () => Response.json({ stop_reason: "end_turn", content: [{ type: "text", text: JSON.stringify({ house_found: false, lines: [] }) }] });
      assert.equal((await ask()).reason, "unusable");
      // the day's 3 model calls are spent: no 4th call
      const before = n.calls.claude.length;
      const over = await ask();
      assert.equal(over.reason, "daily_limit");
      assert.equal(n.calls.claude.length, before);
      // the next day starts again; old counters go in the nightly sweep
      pin("2026-11-13T16:00:00Z");
      reply = () => Response.json({ stop_reason: "end_turn", content: [{ type: "text", text: JSON.stringify(ANSWER) }] });
      assert.equal((await ask()).source, "claude");
      assert.equal(await scope(() => M.pruneBudget()), 3, "two days back and older go");
      assert.equal(t.stores.data.keys("mkd/").length, 1);
    });
    await withEnv({ GOOGLE_MAPS_API_KEY: "k", ANTHROPIC_API_KEY: "test-anthropic-key", CRM_MOCKUP_DAILY_MAX: "100" }, async () => {
      // six a minute per person, then a 429
      pin("2026-11-13T18:00:00Z");
      let last;
      for (let i = 0; i < 6; i++) last = await t.api("/lights-mockup/lines", { method: "POST", as: owner, body: { property_id: p.id, regenerate: true } });
      assert.equal(last.status, 200);
      const slow = await t.api("/lights-mockup/lines", { method: "POST", as: owner, body: { property_id: p.id, regenerate: true } });
      assert.equal(slow.status, 429);
    });
  } finally { n.restore(); t.done(); }
});

test("askClaude: a timeout, a refused key and a cut-off answer each come back as a reason, never a throw", async () => {
  const photo = { bytes: fakeJpeg(), w: 640, h: 480 };
  const env = { ANTHROPIC_API_KEY: "k" };
  const hang = (url, init) => new Promise((ok, no) => init.signal.addEventListener("abort", () => no(Object.assign(new Error("timed out"), { name: "TimeoutError" }))));
  const keep = setTimeout(() => {}, 2000); // AbortSignal.timeout's timer doesn't hold the test's event loop open
  assert.deepEqual(await M.askClaude(photo, { env, fetchImpl: hang, timeoutMs: 20 }), { ok: false, reason: "timeout" });
  clearTimeout(keep);
  assert.deepEqual(await M.askClaude(photo, { env, fetchImpl: async () => new Response("{}", { status: 401 }) }), { ok: false, reason: "key_refused" });
  assert.deepEqual(await M.askClaude(photo, { env, fetchImpl: async () => new Response("{}", { status: 400 }) }), { ok: false, reason: "model_error" });
  assert.deepEqual(await M.askClaude(photo, { env, fetchImpl: async () => Response.json({ stop_reason: "max_tokens", content: [{ type: "text", text: "{\"house" }] }) }), { ok: false, reason: "unusable" });
  assert.deepEqual(await M.askClaude(photo, { env, fetchImpl: async () => { throw new TypeError("fetch failed"); } }), { ok: false, reason: "unreachable" });
  assert.deepEqual(await M.askClaude(photo, { env: {} }), { ok: false, reason: "no_key" });
  const good = await M.askClaude(photo, { env, fetchImpl: async () => Response.json({ stop_reason: "end_turn", content: [{ type: "thinking", thinking: "" }, { type: "text", text: JSON.stringify(ANSWER) }], usage: { input_tokens: 10, output_tokens: 5 } }) });
  assert.equal(good.ok, true);
  assert.deepEqual(good.answer, ANSWER);
});
