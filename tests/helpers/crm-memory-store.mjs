// The CRM's in-memory Blobs double (design §12.1). It mirrors the Store API
// of @netlify/blobs 11.0.2 closely enough that every branch of the store's
// concurrency code (netlify/lib/crm-store.mjs, design §3.4) can be tested
// without a network:
//   - etags are "\"<n>\"" from one counter shared by every key of every
//     double, so a stale etag of one key never matches another;
//   - onlyIfNew on an existing key and onlyIfMatch on a missing key or a
//     different etag answer { modified: false }; both options, a non-string
//     onlyIfMatch or a non-boolean onlyIfNew throw like the client;
//   - setJSON stores JSON.stringify(value), so reads round-trip like the
//     real service; keys (on writes only, like the client), store names and
//     metadata are validated with the client's own messages;
//   - list() pages (pageSize, default 1,000) and, by default for CRM tests,
//     shuffles its order, because the real order is undocumented; with
//     paginate: true every page is its own call (fault hooks fire per page)
//     and the cursor moves only when a page succeeds, like the client.
//
// Fault hooks (each takes { op, key, times = 1 }; op is a method name, a
// list of them, "read", "write" or "*"; key is an exact string or a RegExp):
//   fail({ kind: "internal" | "timeout" | "denied" })  nothing commits; the call throws, except a conditional
//                                                       write failing "internal" or "denied", which answers
//                                                       { modified: true, etag: "" } as @netlify/blobs 11.0.2
//                                                       does for every non-412 status (a 5xx through
//                                                       guardedFetch, a 401/403); "timeout" always throws
//   hang()                                              the call never settles, nothing commits
//   transient({ status: 429 | 503 })                   what guardedFetch makes of a 429/5xx: reads and
//                                                       unconditional writes throw a 424 BlobsInternalError;
//                                                       a conditional write answers { modified: true, etag: "" }
//                                                       (the client's view of a 424); nothing commits
//   commitThenFail({ as: "throw" | "unmodified" | "blank" })   the write commits, then the call throws a
//                                                       5xx/network error ("throw"), answers what the
//                                                       client's own retry would ({ modified: false }), or
//                                                       what a guarded conditional write sees ("blank")
//   slowCommit({ ms, failAfter = 1 })                   the call times out after failAfter ms and the write
//                                                       lands after ms (its condition checked when it lands)
//   beforeConditionalWrite(fn, { key, times })          fn(key, opts, store) runs between the call and the
//                                                       condition check: play the racing writer there
// plus calls (every operation with its key and options), snapshot()/restore(),
// json(key), keys(prefix) and settle() (waits for slow commits to land).

const encoder = new TextEncoder();
let etagCounter = 0;
const nextEtag = () => `"${++etagCounter}"`;

const READ_OPS = ["get", "getWithMetadata", "getMetadata", "list"];
const WRITE_OPS = ["set", "setJSON", "delete"];

function matchesOp(spec, op) {
  if (!spec || spec === "*") return true;
  if (spec === "read") return READ_OPS.includes(op);
  if (spec === "write") return WRITE_OPS.includes(op) && op !== "delete";
  return Array.isArray(spec) ? spec.includes(op) : spec === op;
}
function matchesKey(spec, key) {
  if (spec === undefined) return true;
  if (spec instanceof RegExp) return spec.test(key ?? "");
  return spec === key;
}

function blobsError(status) {
  const e = new Error(`Netlify Blobs has generated an internal error (${status} status code)`);
  e.name = "BlobsInternalError";
  return e;
}
function timeoutError() {
  const e = new Error("The operation was aborted due to timeout");
  e.name = "TimeoutError";
  return e;
}

function validateKey(key) {
  if (key === "") throw new Error("Blob key must not be empty.");
  if (key.startsWith("/") || key.startsWith("%2F")) throw new Error("Blob key must not start with forward slash (/).");
  if (encoder.encode(key).length > 600) throw new Error("Blob key must be a sequence of Unicode characters whose UTF-8 encoding is at most 600 bytes long.");
}
function validateStoreName(name) {
  if (name.includes("/") || name.includes("%2F")) throw new Error("Store name must not contain forward slashes (/).");
  if (encoder.encode(name).length > 64) throw new Error("Store name must be a sequence of Unicode characters whose UTF-8 encoding is at most 64 bytes long.");
}
function validateMetadata(metadata) {
  if (!metadata) return;
  const payload = "b64;" + Buffer.from(JSON.stringify(metadata)).toString("base64");
  if ("netlify-blobs-metadata".length + payload.length > 2048) throw new Error("Metadata object exceeds the maximum size");
}
// The client's getConditions(), word for word in behaviour.
function conditionsOf(options) {
  if ("onlyIfMatch" in options && "onlyIfNew" in options) {
    throw new Error("The 'onlyIfMatch' and 'onlyIfNew' options are mutually exclusive. Using 'onlyIfMatch' will make the write succeed only if there is an entry for the key with the given content, while 'onlyIfNew' will make the write succeed only if there is no entry for the key.");
  }
  if ("onlyIfMatch" in options && options.onlyIfMatch) {
    if (typeof options.onlyIfMatch !== "string") throw new Error("The 'onlyIfMatch' property expects a string representing an ETag.");
    return { onlyIfMatch: options.onlyIfMatch };
  }
  if ("onlyIfNew" in options && options.onlyIfNew) {
    if (typeof options.onlyIfNew !== "boolean") throw new Error("The 'onlyIfNew' property expects a boolean indicating whether the write should fail if an entry for the key already exists.");
    return { onlyIfNew: true };
  }
  return null;
}

// Deterministic shuffle (seeded), so a failing order can be reproduced.
function seeded(seed) {
  let s = seed >>> 0 || 1;
  return () => { s ^= s << 13; s ^= s >>> 17; s ^= s << 5; return (s >>> 0) / 4294967296; };
}

function toBytes(data) {
  if (typeof data === "string") return encoder.encode(data);
  if (data instanceof ArrayBuffer) return new Uint8Array(data.slice(0));
  if (ArrayBuffer.isView(data)) return new Uint8Array(data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength));
  if (typeof Blob !== "undefined" && data instanceof Blob) throw new Error("memory store: pass bytes, not a Blob");
  return encoder.encode(String(data));
}

function render(entry, type) {
  const bytes = entry.bytes;
  const text = () => new TextDecoder().decode(bytes);
  switch (type) {
    case undefined: case "text": return text();
    case "json": return JSON.parse(text());
    case "arrayBuffer": return bytes.slice().buffer;
    case "blob": return new Blob([bytes.slice()]);
    case "stream": return new Blob([bytes.slice()]).stream();
    default: throw new Error(`memory store: unknown type ${type}`);
  }
}

export function createMemoryBlobs({ name = "crm-test", pageSize = 1000, shuffle = true, seed = 7 } = {}) {
  validateStoreName(name);
  let map = new Map();                 // key → { bytes, etag, metadata }
  const hooks = [];
  const pending = new Set();
  const rand = seeded(seed);
  const calls = [];

  const take = (kind, op, key) => {
    for (const h of hooks) {
      if (h.kind !== kind || h.times <= 0 || !matchesOp(h.op, op) || !matchesKey(h.key, key)) continue;
      h.times -= 1;
      return h;
    }
    return null;
  };
  const hook = (kind) => (opts = {}) => { hooks.push({ kind, times: 1, ...opts }); return store; };

  // Commits a write now (conditions checked against the current value).
  function commit(key, data, options, conds) {
    const cur = map.get(key);
    if (conds && conds.onlyIfNew && cur) return { modified: false };
    if (conds && conds.onlyIfMatch && (!cur || cur.etag !== conds.onlyIfMatch)) return { modified: false };
    const etag = nextEtag();
    map.set(key, { bytes: toBytes(data), etag, metadata: options.metadata ? JSON.parse(JSON.stringify(options.metadata)) : {} });
    return { modified: true, etag };
  }

  async function write(op, key, data, options = {}) {
    calls.push({ op, key, opts: { ...options } });
    validateKey(key);
    const conds = conditionsOf(options);
    validateMetadata(options.metadata);
    const f = take("fail", op, key);
    if (f) {
      if (f.errorKind === "timeout") throw timeoutError();
      if (conds) return { modified: true, etag: "" };
      throw blobsError(f.errorKind === "denied" ? 401 : 500);
    }
    if (take("hang", op, key)) return new Promise(() => {});
    const t = take("transient", op, key);
    if (t) {
      if (conds) return { modified: true, etag: "" };
      throw blobsError(424);
    }
    const before = conds && take("before", op, key);
    if (before) await before.fn(key, options, store);
    const slow = take("slow", op, key);
    if (slow) {
      const landing = new Promise((r) => setTimeout(() => { commit(key, data, options, conds); r(); }, slow.ms ?? 20));
      pending.add(landing);
      landing.finally(() => pending.delete(landing));
      await new Promise((r) => setTimeout(r, slow.failAfter ?? 1));
      throw timeoutError();
    }
    const result = commit(key, data, options, conds);
    const ctf = take("ctf", op, key);
    if (ctf) {
      if (ctf.as === "unmodified") return { modified: false };
      if (ctf.as === "blank") return { modified: true, etag: "" };
      throw blobsError(503);
    }
    return conds ? result : { modified: true, etag: result.etag };
  }

  // The client validates keys on writes only (get("") lists the store); the
  // double answers null for "", which is never a stored key.
  async function readOp(op, key, extra = {}) {
    calls.push({ op, key, opts: { ...extra } });
    const f = take("fail", op, key);
    if (f) throw f.errorKind === "timeout" ? timeoutError() : blobsError(f.errorKind === "denied" ? 401 : 500);
    if (take("hang", op, key)) return new Promise(() => {});
    if (take("transient", op, key)) throw blobsError(424);
    return null;
  }

  function listing({ prefix = "", directories = false } = {}) {
    let keys = [...map.keys()].filter((k) => k.startsWith(prefix)).sort();
    const dirs = new Set();
    if (directories) {
      keys = keys.filter((k) => {
        const rest = k.slice(prefix.length);
        const i = rest.indexOf("/");
        if (i === -1) return true;
        dirs.add(prefix + rest.slice(0, i));
        return false;
      });
    }
    if (shuffle) {
      for (let i = keys.length - 1; i > 0; i--) { const j = Math.floor(rand() * (i + 1)); [keys[i], keys[j]] = [keys[j], keys[i]]; }
    }
    return { blobs: keys.map((key) => ({ key, etag: map.get(key).etag })), directories: [...dirs] };
  }

  const store = {
    name,
    calls,
    async get(key, { type } = {}) {
      await readOp("get", key, { type });
      const e = map.get(key);
      return e ? render(e, type) : null;
    },
    async getWithMetadata(key, { type, etag } = {}) {
      await readOp("getWithMetadata", key, { type, etag });
      const e = map.get(key);
      if (!e) return null;
      if (etag && etag === e.etag) return { data: null, etag: e.etag, metadata: { ...e.metadata } };
      return { data: render(e, type), etag: e.etag, metadata: { ...e.metadata } };
    },
    async getMetadata(key) {
      await readOp("getMetadata", key);
      const e = map.get(key);
      return e ? { etag: e.etag, metadata: { ...e.metadata } } : null;
    },
    set(key, data, options = {}) { return write("set", key, data, options); },
    setJSON(key, value, options = {}) { return write("setJSON", key, JSON.stringify(value), options); },
    async delete(key) {
      await readOp("delete", key);
      map.delete(key);
    },
    async deleteAll() {
      calls.push({ op: "deleteAll", key: null, opts: {} });
      const n = map.size;
      map.clear();
      return { deletedBlobs: n };
    },
    list(options = {}) {
      const run = async () => { await readOp("list", options.prefix || "", options); return listing(options); };
      if (options.paginate) {
        const size = options.pageSize || pageSize;
        return {
          [Symbol.asyncIterator]() {
            let all = null;      // the listing as of the first page that succeeded
            let offset = 0;
            let done = false;
            return {
              async next() {
                if (done) return { done: true, value: undefined };
                await readOp("list", options.prefix || "", { ...options, page: offset / size });
                if (!all) all = listing(options);
                const value = { blobs: all.blobs.slice(offset, offset + size), directories: offset === 0 ? all.directories : [] };
                offset += size;
                if (offset >= all.blobs.length) done = true;
                return { done: false, value };
              },
            };
          },
        };
      }
      return run();
    },

    // --- test hooks
    hang: hook("hang"),
    transient: hook("transient"),
    commitThenFail: hook("ctf"),
    slowCommit: hook("slow"),
    beforeConditionalWrite(fn, opts = {}) { hooks.push({ kind: "before", op: ["set", "setJSON"], times: 1, ...opts, fn }); return store; },
    clearHooks() { hooks.length = 0; return store; },
    async settle() { while (pending.size) await Promise.all([...pending]); },
    snapshot: () => new Map([...map].map(([k, v]) => [k, { ...v, bytes: v.bytes.slice(), metadata: { ...v.metadata } }])),
    restore(snap) { map = new Map([...snap].map(([k, v]) => [k, { ...v, bytes: v.bytes.slice(), metadata: { ...v.metadata } }])); },
    json(key) { const e = map.get(key); return e ? JSON.parse(new TextDecoder().decode(e.bytes)) : null; },
    keys(prefix = "") { return [...map.keys()].filter((k) => k.startsWith(prefix)).sort(); },
    etagOf(key) { const e = map.get(key); return e ? e.etag : null; },
    has(key) { return map.has(key); },
    get size() { return map.size; },
  };
  // fail() takes `kind` for the error kind; the hook record keeps its own kind
  store.fail = (opts = {}) => { const { kind, ...rest } = opts; hooks.push({ times: 1, ...rest, kind: "fail", errorKind: kind || "internal" }); return store; };
  return store;
}

// { data, files, backups, probe }: the stores crm-store opens, as doubles.
export function createCrmStores(opts = {}) {
  return {
    data: createMemoryBlobs({ name: "crm", ...opts }),
    files: createMemoryBlobs({ name: "crm-files", ...opts }),
    backups: createMemoryBlobs({ name: "crm-backups", ...opts }),
    probe: createMemoryBlobs({ name: "crm-probe", ...opts }),
  };
}

// Points crm-store at the doubles (a single store is still accepted as the
// data store, so the first slice's tests keep working) and makes the store's
// retry sleeps short. Returns the stores.
export function useCrmStores(stores = createCrmStores(), { sleepScale = 0.02 } = {}) {
  globalThis.__crmStoreOverride = stores;
  globalThis.__crmSleepScale = sleepScale;
  return stores;
}
export function clearCrmStores() {
  delete globalThis.__crmStoreOverride;
  delete globalThis.__crmSleepScale;
}
