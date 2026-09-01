// Shared scaffolding for the referral-program tests. Nothing here talks to
// the network: the store is a Map with the same surface as a Netlify Blobs
// store (get/setJSON/set/list/delete), and globalThis.fetch is replaced with
// a capture stub that answers for Rotor and Twilio. Every credential the
// tests set is an obvious placeholder.
//
// Not a test file itself — npm test only picks up tests/**/*.test.mjs.

export const FAKE_ENV = Object.freeze({
  ROTOR_API_KEY: "test-dummy-rotor-key-not-real",
  REFERRAL_ADMIN_KEY: "test-dummy-admin-key-not-real-0123456789",
  TWILIO_ACCOUNT_SID: "ACtestdummysid00000000000000000000",
  TWILIO_AUTH_TOKEN: "test-dummy-twilio-token-not-real",
  TWILIO_FROM: "+17635550000",
  REFERRAL_OFFICE_PHONE: "+17633143400",
  SITE_URL: "https://www.bartawindowwashing.com",
});
export function setEnv(overrides = {}) {
  for (const [k, v] of Object.entries({ ...FAKE_ENV, ...overrides })) {
    if (v === undefined || v === null) delete process.env[k];
    else process.env[k] = v;
  }
}

// In-memory stand-in for @netlify/blobs' Store. Values round-trip through
// JSON so tests see exactly what a real store would hand back (no shared
// references, undefined dropped).
export function createMemoryStore() {
  const map = new Map();
  return {
    map,
    async get(key, opts = {}) {
      if (!map.has(key)) return null;
      const raw = map.get(key);
      return opts.type === "json" ? JSON.parse(raw) : raw;
    },
    async setJSON(key, value) {
      map.set(key, JSON.stringify(value));
      return { modified: true, etag: "test" };
    },
    async set(key, value) {
      map.set(key, String(value));
      return { modified: true, etag: "test" };
    },
    async list({ prefix = "" } = {}) {
      const blobs = [...map.keys()].filter((k) => k.startsWith(prefix)).sort()
        .map((key) => ({ key, etag: "test" }));
      return { blobs, directories: [] };
    },
    async delete(key) { map.delete(key); },
    // test conveniences
    json(key) { return map.has(key) ? JSON.parse(map.get(key)) : null; },
    keys(prefix = "") { return [...map.keys()].filter((k) => k.startsWith(prefix)).sort(); },
  };
}
// A store where every call rejects — Blobs unavailable.
export function failingStore(message = "simulated Blobs outage") {
  const boom = async () => { throw new Error(message); };
  return { get: boom, setJSON: boom, set: boom, list: boom, delete: boom };
}
// A store where every call never settles — Blobs hanging.
export function hangingStore() {
  const never = () => new Promise(() => {});
  return { get: never, setJSON: never, set: never, list: never, delete: never };
}
export function useStore(store) {
  globalThis.__referralStoreOverride = store;
  return store;
}

// Replaces globalThis.fetch. `rotor` / `twilio` are HTTP statuses, or
// "throw" to simulate an unreachable host, or a function of the captured
// request returning either.
export function mockFetch({ rotor = 201, twilio = 201 } = {}) {
  const requests = [];
  const pick = (v, entry) => (typeof v === "function" ? v(entry) : v);
  globalThis.fetch = async (url, options = {}) => {
    const u = String(url);
    const entry = { url: u, options, headers: options.headers || {} };
    let outcome = 200;
    if (u.includes("getrotor.com")) {
      entry.kind = "rotor";
      entry.payload = JSON.parse(options.body);
      outcome = pick(rotor, entry);
    } else if (u.includes("twilio.com")) {
      entry.kind = "twilio";
      entry.params = new URLSearchParams(options.body);
      outcome = pick(twilio, entry);
    } else {
      entry.kind = "other";
    }
    requests.push(entry);
    if (outcome === "throw") throw new TypeError("fetch failed");
    return new Response("{}", { status: outcome });
  };
  return {
    requests,
    rotor: () => requests.filter((r) => r.kind === "rotor"),
    twilio: () => requests.filter((r) => r.kind === "twilio"),
  };
}

export const ORIGIN = "http://localhost";
export const jsonRequest = (path, method, body, headers = {}) =>
  new Request(ORIGIN + path, {
    method,
    headers: { "Content-Type": "application/json", ...headers },
    body: body === undefined ? undefined : JSON.stringify(body),
  });

// A complete, valid submission; override any part.
export const submission = ({ referrer = {}, friends, consent = true, extra = {} } = {}) => ({
  referrer: {
    first_name: "Alex", last_name: "Barta", phone: "(763) 555-0100",
    email: "alex@example.com", reward_pref: "credit", ...referrer,
  },
  friends: friends || [{
    first_name: "Jane", last_name: "Doe", phone: "763-555-0101",
    email: "", address: "123 Main St, Delano, MN 55328", note: "Neighbor, big house",
  }],
  consent,
  page: "/refer.html",
  ...extra,
});

export const CODE_RE = /^BARTA-[ABCDEFGHJKLMNPQRSTUVWXYZ23456789]{5}$/;
export const TOKEN_RE = /^[ABCDEFGHJKLMNPQRSTUVWXYZ23456789]{24}$/;
