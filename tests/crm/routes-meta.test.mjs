// M1.4 guards (design §11.4 "routes-meta.test.mjs", §12.3 suites 3 and 15,
// §4.5, §4.6): every route the modules registered, read from the registry,
// so a route added by a later module is covered without touching this file.
//
//   1. Meta: every route declares auth, perm, subject and mode; the perm is
//      a real permission; the registry refuses a route that forgets one; a
//      route that checks its own credentials (auth "hook") says who it lets
//      in (HOOKS below).
//   2. The permission matrix, generated: every route is called through the
//      real dispatcher (crm-api.mjs, memory stores, synthetic fixtures) as
//      nobody, the office cookie, an owner, an admin, tech A, tech B, two of
//      the owner's API keys (read scopes; one narrow scope) and an import
//      upload key. The expected answer comes from the route's auth, perm and
//      subject and the role defaults (§4.5): a person without the
//      permission gets 403, the wrong kind of credential 401, a permission
//      held only as "own" opens no list (subject "none"). Path params are
//      filled from fixtures by the segment before them (/contacts/:id → a
//      contact), each route once with the office's records and again with
//      the records a tech may see (tech A's visit contact, the person's own
//      user, tech A's task). Writes run against a snapshot that is put back
//      afterwards, so the order of the rows never matters.
//   3. The tech leak crawl: every JSON answer to a tech is searched for
//      contact ids. Tech A has a visit for contact X tomorrow (and one for Y
//      40 days out, outside the ±7/30-day window); tech B has none. Any
//      contact id other than the tech's window and the tech's own quick
//      leads fails, as does any office-only text, and any record whose
//      fields go beyond its type's techFields.
//   4. Explicit 403 rows for techs: /crm/legacy, /legacy/customers,
//      /contacts, /contacts/index and search.
//
// Synthetic data only: made-up names, 555 numbers, example.com emails.
import { test } from "node:test";
import assert from "node:assert/strict";
import { crmTest } from "../helpers/crm-http.mjs";
import { BYTES } from "../helpers/crm-fixtures.mjs";

const store = await import("../../netlify/lib/crm-store.mjs");
await import("../../netlify/lib/crm/modules/index.mjs");
const R = await import("../../netlify/lib/crm/core/registry.mjs");
const P = await import("../../netlify/lib/crm/core/perms.mjs");
const ids = await import("../../netlify/lib/crm/core/ids.mjs");
const sessions = await import("../../netlify/lib/crm/core/sessions.mjs");
const auth = await import("../../netlify/lib/crm/core/auth.mjs");
const { RegistryError } = await import("../../netlify/lib/crm/core/errors.mjs");
const { keyCan } = await import("../../netlify/lib/crm/core/apikeys.mjs");
const L = await import("../../netlify/lib/crm/core/lanes.mjs");
const F = await import("../../netlify/lib/crm/core/files.mjs");
const PA = await import("../../netlify/lib/crm/core/pending.mjs");
const B = await import("../../netlify/lib/crm/core/bulk.mjs");
const N = await import("../../netlify/lib/crm/core/notify.mjs");
const T = await import("../../netlify/lib/crm/core/templates.mjs");
const SEED = await import("../../netlify/lib/crm/modules/sales/seed.mjs");
const E = await import("../../netlify/lib/crm/modules/sales/enroll.mjs");
const MATCH = await import("../../netlify/lib/crm/modules/contacts/match.mjs");
const HOOK = await import("../../netlify/lib/crm/modules/contacts/hook.mjs");

const DEBUG = process.env.CRM_MATRIX_DEBUG;   // a file path: the whole matrix, one row per call

// ------------------------------------------------------------ meta

// Routes that check their own credentials (auth "hook"), by who they let in.
// A new hook route fails the meta test until it is listed here.
const HOOKS = [
  { method: "GET", re: /^\/import\/upload$/, kind: "upload key" },           // the upload script asks what its key is for
  { re: /^\/import\/runs\/:id\//, kind: "upload key or owner" },           // the import upload (runs.mjs uploadAuth)
  { re: /^\/hooks\/cron$/, kind: "worker secret" },                         // the D39 cron fallback (x-crm-worker header)
  { re: /^\/hooks\/lead\/:token$/, kind: "lead token" },                    // the lead webhook (Zapier for Meta, D6)
  { re: /^\/hooks\/twilio\/(sms|status)$/, kind: "twilio signature" },       // inbound texts and delivery statuses (comms/inbound.mjs; 403 until Twilio is connected)
  { re: /^\/hooks\/email\/postmark$/, kind: "postmark token" },             // delivery, bounce and complaint webhooks (?token=)
];
const hookKind = (r) => (HOOKS.find((h) => (!h.method || h.method === r.method) && h.re.test(r.path)) || {}).kind || null;
const permKeys = () => new Set([...P.PERMISSION_KEYS, ...R.allPerms().map((p) => p.key)]);
const routeName = (r) => `${r.method} ${r.path}`;

test("every route declares auth, perm, subject and mode, with a real permission", async () => {
  const { AUTH_ROUTES } = await import("../../netlify/lib/crm/core/auth.mjs");
  const routes = [...R.allRoutes(), ...AUTH_ROUTES.map((r) => ({ ...r, module: "auth" }))];
  assert.ok(routes.length > 100, "the modules' routes are registered");
  const known = permKeys();
  const bad = [];
  for (const r of routes) {
    const name = routeName(r);
    if (!R.ROUTE_AUTH.includes(r.auth)) bad.push(`${name}: auth ${r.auth}`);
    if (!["required", "none"].includes(r.subject)) bad.push(`${name}: subject ${r.subject}`);
    if (!["inline", "run"].includes(r.mode)) bad.push(`${name}: mode ${r.mode}`);
    if (!Object.hasOwn(r, "perm")) bad.push(`${name}: no perm`);
    else if (r.perm === null) { if (!["public", "hook"].includes(r.auth)) bad.push(`${name}: perm null on a ${r.auth} route`); }
    else if (!known.has(r.perm)) bad.push(`${name}: ${r.perm} is not a permission (a typo here would lock everyone out)`);
    if (r.auth === "hook" && !hookKind(r)) bad.push(`${name}: a hook route that isn't in HOOKS (say who it lets in)`);
    if (typeof r.module !== "string" || !r.module) bad.push(`${name}: no module`);
  }
  assert.deepEqual(bad, []);
});

test("the registry refuses a route that forgets auth, perm, subject or mode", () => {
  const ok = { method: "GET", path: "/meta-probe", auth: "session", perm: "contacts:read_all", subject: "none", mode: "inline", handler: async () => ({ data: 1 }) };
  assert.doesNotThrow(() => R.defineModule({ name: "meta-ok", routes: [ok] }));
  for (const k of ["auth", "perm", "subject", "mode"]) {
    const r = { ...ok };
    delete r[k];
    assert.throws(() => R.defineModule({ name: `meta-no-${k}`, routes: [r] }), RegistryError, `a route without ${k}`);
  }
  assert.throws(() => R.defineModule({ name: "meta-null-perm", routes: [{ ...ok, perm: null }] }), RegistryError, "perm null only on public and hook routes");
});

// ------------------------------------------------------------ the fixture world

const CANARY = "Office-only canary 7Q";        // in notes and access fields a tech must never get
const W = (by = "system") => ({ by, origin: "api", actor_kind: "user", requestId: "meta" });
const AUTO = { by: "system:meta", origin: "worker", actor_kind: "automation", requestId: "meta", mode: { system_of_record: "rotor", paused: false } };
const scope = (fn) => store.withStoreScope({ requestId: "meta" }, fn);

let pn = 0;
async function person(by, extra = {}) {
  pn += 1;
  const n = String(400 + pn).padStart(4, "0");
  return (await store.createRecord("contact", {
    first_name: "Meta", last_name: `Person${pn}`, phones: [{ e164: `+1763555${n}`, sms: true }], emails: [{ address: `meta.person${pn}@example.com` }],
    lifecycle: "customer", source: { source: "Other" }, notes: `${CANARY} (contact notes)`, consent: { sms_service: { state: "granted" } },
    billing_address: { street1: `${pn} Example Ave`, city: "Delano", state: "MN", zip: "55328" }, ...extra,
  }, W(by))).data;
}
const property = async (by, contactId) => (await store.createRecord("property", { contact_id: contactId, label: "Home", address: { street1: "1 Example Ave", city: "Delano", state: "MN", zip: "55328" }, access: { gate_code: "1234", notes: "Side gate" } }, W(by))).data;

// A visit of a tech's for a contact: through the visit type once scheduling
// (M4a) registers it (its rels keep rel/tech-visits), else the way M4a
// keeps it: rec/visit/{id} plus rel/tech-visits/{uid}/{local date}--{visitId}.
async function visitFor(techId, contactId, date) {
  const def = R.getType("visit");
  if (def) {
    const r = await store.createRecord("visit", { ...def.example(), contact_id: contactId, assignee_ids: [techId], date }, W()).catch(() => null);
    if (r) return r.data.id;
  }
  const id = ids.newId("visit");
  await store.settledWrite(`rec/visit/${id}`, { id, type: "visit", v: 1, wv: 1, contact_id: contactId, assignee_ids: [techId], date, created_at: "2026-11-17T15:00:00.000Z" }, { onlyIfNew: true });
  await store.addRel("tech-visits", techId, date, id);
  return id;
}

async function world(t) {
  HOOK.clearModeCache();
  const owner = await t.user("owner");
  const admin = await t.user("admin");
  const tech = await t.user("tech");          // tech A
  const tech2 = await t.user("tech");         // tech B: no visits
  const owner2 = await t.user("owner");       // a second owner: the "office" user in the rows (and role changes need one left)
  await SEED.seedCadences({ write: () => AUTO });
  await T.seedTemplates(AUTO);
  T.clearTemplateSeedCache();

  const Z = await person(owner.id);           // the office's customer: no tech ever has a visit
  const Z2 = await person(owner.id, { phones: [{ e164: "+17635550499", sms: true }] });
  const X = await person(owner.id);           // tech A's visit tomorrow
  const Y = await person(owner.id);           // tech A's visit 40 days out (outside the window)
  const pZ = await property(owner.id, Z.id);
  const pX = await property(owner.id, X.id);
  const pY = await property(owner.id, Y.id);
  const visitX = await visitFor(tech.id, X.id, "2026-11-18");
  await visitFor(tech.id, Y.id, "2026-12-27");

  const en = await scope(() => E.enroll(Z.id, "new_lead", {}, W(owner.id)));
  const enRec = (await store.getRecord("enrollment", en)).data;
  const task = (k, extra) => store.createRecord("task", { title: `Meta task ${k}`, kind: "todo", priority: "medium", status: "open", ...extra }, W(owner.id)).then((r) => r.data);
  const officeTask = await task("office", { contact_id: Z.id, contact_name: "Meta Person", assignee_ids: [owner.id], notes: CANARY });
  const techTask = await task("tech", { contact_id: Z.id, contact_name: "Meta Person", assignee_ids: [tech.id], notes: "Bring the long ladder." });
  const cand = await scope(() => MATCH.createCandidate(Z.id, Z2.id, { reason: "phone", confidence: "high" }, W(owner.id)));

  // each tech's own quick lead: the one contact id a tech is told about (only { contact_id })
  const quick = await t.api("/contacts", { method: "POST", as: tech, body: { name: "Meta Quicklead", phone: "763-555-0498", client_id: "4f0e7a52-3c1d-4b8e-9a6f-0d2c1b3a4e5f" } });
  const quick2 = await t.api("/contacts", { method: "POST", as: tech2, body: { name: "Meta Otherlead", phone: "763-555-0496", client_id: "5a1f8b63-4d2e-4c9f-8b7a-1e3d2c4b5f6a" } });
  for (const q of [quick, quick2]) {
    assert.equal(q.status, 201, JSON.stringify(q.body));
    assert.deepEqual(Object.keys(q.body.data), ["contact_id"]);
  }

  const run = await scope(() => L.createRun("export.csv", { type: "user", date: "2026-11-17" }, W(owner.id), { kick: false }));
  const pending = await scope(() => PA.createPendingAction({ kind: "outbox_review", title: "Review", requested_by: tech.id, items: [] }, W(owner.id)));
  const bulk = await scope(() => B.createBulkRun({ recipients: [Z.id, Z2.id], template_key: "lead_ack", requested_by: owner.id }, W(owner.id)));
  const tpl = (await store.createRecord("template", { key: "meta_note", name: "Meta note", channel: "sms", category: "service", body: "Hi {{first_name|there}}.", tags: [], active: true }, W(owner.id))).data;
  // two imports: the office's, and the one an upload key was made for
  const imp1 = await t.api("/import/runs", { method: "POST", as: owner, body: {} });
  const imp = await t.api("/import/runs", { method: "POST", as: owner, body: {} });
  assert.equal(imp1.status, 201, JSON.stringify(imp1.body));
  assert.equal(imp.status, 201, JSON.stringify(imp.body));
  const importRun = imp1.body.data.run;
  const file = await scope(() => F.storeImportedFile({ bytes: BYTES.jpeg(), owner: { type: "import_run", id: importRun.id } }, { ...W(), origin: "import" }));
  await scope(() => N.notify([tech.id], { kind: "system", title: "Meta notice", body: "Synthetic.", link: "/today" }));
  await scope(() => N.notify([owner.id], { kind: "lead", title: "New lead", body: "Synthetic.", link: `/contacts/${Z.id}` }));
  for (let i = 0; i < 4 && t.stores.data.keys("q/").length; i++) await t.runWorker({ lane: "fast" });
  const PUSH = { p256dh: "BCVxsr7N_eNgVRqvHtD0zTZsEc6-VV-JvLexhqUzORcxaOzi6-AYWXvTBHm4bjyPjs7Vd8pZGH6SRpkNtoIAiw4", auth: "BTBZMqHH6r4Tts7J_aSIgg" };
  const push = {};
  for (const [who, u] of [["owner", owner], ["tech A", tech]]) push[who] = (await scope(() => N.savePushSubscription(u.id, { endpoint: `https://fcm.googleapis.com/fcm/send/meta-${who}`, keys: PUSH }))).hash;
  const readKey = await t.api("/api-keys", { method: "POST", as: owner, body: { name: "Meta read key" } });
  const narrowKey = await t.api("/api-keys", { method: "POST", as: owner, body: { name: "Meta narrow key", scopes: ["audit:read"] } });
  assert.equal(readKey.status, 201, JSON.stringify(readKey.body));
  assert.equal(narrowKey.status, 201, JSON.stringify(narrowKey.body));
  // the first slice's customer list
  await store.writeCustomerIndex(store.buildCustomerIndex({ exported_at: "2026-11-08", members: [], customers: [
    { id: "00000000-0000-4000-8000-000000000001", first_name: "Legacy", last_name: "Sample", email: "legacy@example.com", phone: "+17635550497", status: "active", source: "Referral", assigned_to: [], address: { street1: "9 Example Ave", city: "Mound", state: "MN", zip: "55364" }, tags: [], notes: CANARY, created_at: "2025-03-14T15:00:00+00:00" },
  ] }));

  const fx = {
    owner, admin, tech, tech2,
    contacts: { Z, Z2, X, Y }, quick: { A: quick.body.data.contact_id, B: quick2.body.data.contact_id },
    // params by type: the office's record, and the one a tech may see
    byType: {
      contact: { office: Z.id, visible: X.id, far: Y.id },
      property: { office: pZ.id, visible: pX.id, far: pY.id },
      merge_candidate: { office: cand.id },
      enrollment: { office: en },
      deal: { office: enRec.deal_id },
      cadence: { office: await SEED.seedCadenceId("new_lead") },
      task: { office: officeTask.id, own: techTask.id },
      user: { office: owner2.id },
      run: { office: run.id },
      pending_action: { office: pending.id },
      bulk_run: { office: bulk.id },
      template: { office: tpl.id },
      import_run: { office: importRun.id },
      file: { office: file.id },
      // tech A's own visit, once visits are records of a registered type
      ...(R.getType("visit") ? { visit: { own: visitX } } : {}),
    },
    push,
    keys: { read: readKey.body.data.key, narrow: narrowKey.body.data.key },
    readScopes: readKey.body.data.scopes || null,
    uploadKey: imp.body.data.upload_key,
    uploadRun: imp.body.data.run.id,
    windowA: new Set([X.id]),
  };
  // one record of every other registered type, made from its example(), so
  // a later module's routes are called with a real record of theirs and not
  // only a made-up id (a type whose example needs more is left to the dummy)
  fx.skipped = [];
  for (const def of R.allTypes()) {
    if ((fx.byType[def.type] && fx.byType[def.type].office) || !def.prefix) continue;
    try {
      const r = await store.createRecord(def.type, def.example(), W(owner.id));
      fx.byType[def.type] = { ...(fx.byType[def.type] || {}), office: r.data.id };
    } catch (e) { fx.skipped.push(`${def.type} (${e.message})`); }
  }
  // every fixture record, for the gates that judge one record (history, files)
  fx.records = {};
  for (const [type, v] of Object.entries(fx.byType)) {
    for (const id of Object.values(v)) { const g = await store.getRecord(type, id); if (g) fx.records[id] = { type, data: g.data }; }
  }
  return fx;
}

// ------------------------------------------------------------ probes

const segType = (segs, i) => {
  const prev = (segs[i - 1] || "").replace(/-/g, "_").replace(/\.csv$/, "");
  const prev2 = (segs[i - 2] || "").replace(/-/g, "_");
  const one = (s) => s.replace(/ies$/, "y").replace(/s$/, "");
  for (const c of [prev2 && !prev2.startsWith(":") ? `${prev2}_${one(prev)}` : null, one(prev), prev]) if (c && R.getType(c)) return c;
  return null;
};

// The ways one route is called: { label, kind?, at(actor) → { path, ids } }
// with every param filled (ids: the record ids in the path, in order).
const DUMMY = { hash: "0".repeat(64), sha: "0".repeat(64), n: "1", date: "2026-11-17", token: "blh_" + "0".repeat(32), name: "contacts-0001", key: "meta.none" };
const dummy = (p) => DUMMY[p.name] || "zz_00000000000000000000";
function probes(route, fx) {
  const segs = route.path.split("/").filter(Boolean);
  const params = segs.map((s, i) => (s.startsWith(":") ? { i, name: s.slice(1), type: segType(segs, i) } : null)).filter(Boolean);
  const make = (label, kind, valueOf, extra = {}) => ({
    label, kind, ...extra,
    at(actor) {
      const ids = [];
      const path = "/" + segs.map((s, i) => {
        if (!s.startsWith(":")) return s;
        const p = params.find((x) => x.i === i);
        const v = valueOf(p, actor);
        if (p.type) ids.push(v);
        return encodeURIComponent(v);
      }).join("/");
      return { path, ids };
    },
  });
  if (!params.length) return [make("-", null, () => "")];
  // /settings/:name: one row per settings document
  if (route.path === "/settings/:name") return R.allSettings().map((s) => make(`doc ${s.name}`, null, () => s.name, { setting: s }));
  // /records/:type/:id/history: one row per record type, with the office's record and the one a tech may see
  if (params[0].name === "type") {
    const out = [];
    for (const [type, v] of Object.entries(fx.byType)) {
      for (const kind of ["office", "visible"]) {
        if (!v[kind]) continue;
        out.push({ label: `${type} ${kind}`, kind, type, at: () => ({ path: route.path.replace(":type", type).replace(":id", v[kind]), ids: [v[kind]] }) });
      }
    }
    return out;
  }
  const typed = params.filter((p) => p.type && fx.byType[p.type]);
  const of = (kind) => (p) => { const v = p.type && fx.byType[p.type]; return (v && (v[kind] || v.office)) || dummy(p); };
  const out = [make("office", "office", of("office"))];
  for (const kind of ["visible", "far", "own"]) if (typed.some((p) => fx.byType[p.type][kind])) out.push(make(kind, kind, of(kind)));
  // the person's own user record (users/:id, users/:id/sessions)
  if (params.some((p) => p.type === "user")) out.push(make("self", "self", (p, a) => (p.type === "user" ? (a.user ? a.user.id : dummy(p)) : dummy(p))));
  // one's own push subscription
  if (route.path === "/push/subscriptions/:hash") out.push(make("own", "own", (p, a) => fx.push[a.name] || dummy(p)));
  // the run the upload key belongs to
  if (params.some((p) => p.type === "import_run")) out.push(make("upload run", "upload", (p) => (p.type === "import_run" ? fx.uploadRun : of("office")(p))));
  return out;
}

// ------------------------------------------------------------ expectations

// Routes whose declared perm only says "signed in" (account:own) and whose
// handler applies the real rule. Each gate reads that rule from where it
// lives (the settings registry, the type's readPerm, the file's owner), so
// a new settings document, record type or file owner is covered as it
// registers. → true (allowed) | false (403 or 404).
const asCtx = (a) => ({ user: a.user, can: (perm, subject) => P.can(a.user, perm, subject), holds: (perm) => P.holds(a.user, perm) });
const selfOrManage = (a, p) => p.kind === "self" || P.can(a.user, "users:manage");
const fileGate = (how) => (a, p, fx) => {
  const f = fx.records[p.ids[0]];
  const owner = f && fx.records[f.data.owner.id];
  const spec = owner && F.fileOwner(f.data.owner.type);
  return !!spec && !!spec[how](asCtx(a), owner.data);
};
const GATES = {
  "GET /settings/:name": (a, p) => P.can(a.user, p.setting.perm),
  "PUT /settings/:name": (a, p) => P.can(a.user, p.setting.perm),
  // the type's readPerm (audit:read without one), unscoped or for this one record (§4.6)
  "GET /records/:type/:id/history": (a, p, fx) => {
    const def = R.getType(p.type);
    const perm = def.readPerm || "audit:read";
    const rec = fx.records[p.ids[0]];
    const cid = p.type === "contact" ? p.ids[0] : rec && rec.data.contact_id;
    return P.can(a.user, perm, { type: p.type, record: rec ? rec.data : {}, visible: !!cid && a.tech === "A" && fx.windowA.has(cid) });
  },
  "GET /users/:id": selfOrManage,
  "PATCH /users/:id": selfOrManage,
  "GET /users/:id/sessions": selfOrManage,
  "DELETE /users/:id/sessions/:hash": selfOrManage,
  // nobody switches themself off (or "on" again)
  "POST /users/:id/disable": (a, p) => p.kind !== "self" && P.can(a.user, "users:manage"),
  "POST /users/:id/enable": (a, p) => p.kind !== "self" && P.can(a.user, "users:manage"),
  "GET /files/:id": fileGate("canRead"),
  "POST /files/:id/thumb": fileGate("canEdit"),
  "DELETE /files/:id": fileGate("canEdit"),
};

const ALLOW = Object.freeze({ not: [401, 403] });
// the record types whose "own" rule is a tech's (core/perms.mjs scopeFor)
const SCOPED_TYPES = new Set(["visit", "job", "contact", "property", "conversation", "message", "invoice", "payment", "timesheet", "pay_line", "timer", "task", "user"]);
const meets = (exp, status) => status < 500 && (exp.codes ? exp.codes.includes(status) : exp.refused ? status >= 400 && status !== 401 : !exp.not.includes(status));
const says = (exp) => (exp.codes ? exp.codes.join(" or ") : exp.refused ? "a 4xx refusal" : "anything but " + (exp.not.join(", ") || "5xx"));
const isUpload = (hk) => hk === "upload key" || hk === "upload key or owner";

// → { codes: [..] } (one of) | { not: [..] } (anything but) | { refused } (a 4xx, not 401); never 5xx
function expected(route, actor, probe, fx) {
  const hk = route.auth === "hook" ? hookKind(route) : null;
  if (hk) {
    if (!isUpload(hk)) return { codes: [401, 403, 404] };        // a secret or token nobody here holds
    if (actor.kind === "upload") return hk === "upload key" || probe.kind === "upload" ? ALLOW : { codes: [401] };
    if (hk === "upload key or owner" && actor.kind === "session") return P.can(actor.user, "import:run") ? ALLOW : { codes: [403] };
    return { codes: [401] };
  }
  if (route.auth === "public") return { not: [] };
  const sessionOk = ["session", "session_or_key", "session_or_office"].includes(route.auth);
  const keyOk = ["session_or_key", "key"].includes(route.auth);
  const officeOk = ["office_cookie", "session_or_office"].includes(route.auth);
  if (actor.kind === "nobody" || actor.kind === "upload") return { codes: [401] };
  if (actor.kind === "office") return officeOk ? ALLOW : { codes: [401] };
  if (actor.kind === "key") {
    if (!keyOk) return { codes: [401] };
    const allowed = route.subject === "none" ? keyCan(actor.user, actor.apiKey, route.perm) : actor.apiKey.scopes.includes(route.perm) && !!P.holds(actor.user, route.perm);
    return allowed ? ALLOW : { codes: [403] };
  }
  // a person's session
  if (!sessionOk) return { codes: [401] };
  const h = P.holds(actor.user, route.perm);
  if (!h) return { codes: [403] };
  if (h === "own" && route.subject === "none") return { codes: [403] };
  if (h === "own") {
    // the handler scopes it (§4.6): a record of a scoped type that isn't
    // the tech's is 403/404 (a write: refused one way or another); tech A's
    // own (the visit contact, the assigned task) opens for a read
    const scoped = probe.ids.some((id) => SCOPED_TYPES.has(ids.typeOf(id)));
    if (!scoped) return { not: [401] };                       // the crawl checks what comes back
    const mine = actor.tech === "A" && (probe.kind === "visible" || probe.kind === "own");
    // (a write on one's own record is found, though a field it may not change is still refused)
    if (mine) return route.method === "GET" ? { codes: [200] } : { not: [401, 404] };
    return route.method === "GET" ? { codes: [403, 404] } : { refused: true };
  }
  const gate = GATES[routeName(route)];
  if (gate) return gate(actor, probe, fx) ? ALLOW : { codes: [403, 404] };
  return ALLOW;
}

// ------------------------------------------------------------ the crawl

const CT_RE = /ct_[0-9a-hjkmnp-tv-z]{20}/g;
const BENIGN = new Set(["type", "created_at", "updated_at", "contact_id"]);
const empty = (x) => x === null || x === undefined || x === "" || (Array.isArray(x) && !x.length) || (typeof x === "object" && !Array.isArray(x) && !Object.keys(x).length);
function crawl(actor, row, text, fx, problems) {
  const allowed = actor.allowedContacts;
  for (const id of new Set(String(text).match(CT_RE) || [])) {
    if (!allowed.has(id)) problems.push(`${row}: contact ${id === fx.contacts.Z.id ? "Z (office)" : id === fx.contacts.Y.id ? "Y (outside the window)" : id === fx.contacts.X.id ? "X" : id} outside ${actor.name}'s window`);
  }
  if (String(text).includes(CANARY)) problems.push(`${row}: office-only text`);
  let body = null;
  try { body = JSON.parse(text); } catch { return; }
  const walk = (v, depth = 0) => {
    if (!v || typeof v !== "object" || depth > 12) return;
    if (Array.isArray(v)) { for (const x of v) walk(x, depth + 1); return; }
    const type = typeof v.id === "string" ? ids.typeOf(v.id) : null;
    const def = type && R.getType(type);
    if (def && !(type === "user" && v.id === actor.user.id)) {
      // a field beyond the type's techFields that carries something (a null
      // or empty placeholder says nothing); a task's contact may be named
      // only when it is one the tech may see (the id itself is crawled above)
      const extra = Object.keys(v).filter((k) => !def.techFields.includes(k) && !BENIGN.has(k) && !empty(v[k]) && !(k === "contact_name" && allowed.has(v.contact_id)));
      if (extra.length) problems.push(`${row}: a ${type} with fields beyond its techFields (${extra.join(", ")})`);
    }
    for (const x of Object.values(v)) walk(x, depth + 1);
  };
  walk(body);
}

// ------------------------------------------------------------ the matrix

test("the permission matrix (every route × nobody, office cookie, owner, admin, tech A, tech B, API keys, upload key) and the tech leak crawl", async () => {
  const t = await crmTest({ now: "2026-11-17T15:00:00Z" });
  globalThis.__crmSleepScale = 0.01;
  try {
    const fx = await world(t);
    const keyRec = async (key) => (await store.getRaw(`apikey/${(await import("node:crypto")).createHash("sha256").update(key).digest("hex")}`)).data;
    const actors = [
      { name: "nobody", kind: "nobody" },
      { name: "office cookie", kind: "office", office: true },
      { name: "owner", kind: "session", as: fx.owner, user: fx.owner.user },
      { name: "admin", kind: "session", as: fx.admin, user: fx.admin.user },
      { name: "tech A", kind: "session", as: fx.tech, user: fx.tech.user, tech: "A" },
      { name: "tech B", kind: "session", as: fx.tech2, user: fx.tech2.user, tech: "B" },
      { name: "read key", kind: "key", user: fx.owner.user, apiKey: await keyRec(fx.keys.read), bearer: fx.keys.read },
      { name: "narrow key", kind: "key", user: fx.owner.user, apiKey: await keyRec(fx.keys.narrow), bearer: fx.keys.narrow },
      { name: "upload key", kind: "upload", bearer: fx.uploadKey },
    ];
    // what each tech may be told about: the window (§4.6) and their own quick leads
    const windows = { A: new Set([fx.contacts.X.id, fx.quick.A]), B: new Set([fx.quick.B]) };
    const techWindow = { A: await scope(() => P.techVisibleContacts(fx.tech.id)), B: await scope(() => P.techVisibleContacts(fx.tech2.id)) };
    assert.deepEqual([...techWindow.A], [fx.contacts.X.id], "tech A's window holds X only (Y is 40 days out)");
    assert.equal(techWindow.B.size, 0);
    for (const a of actors) if (a.tech) a.allowedContacts = windows[a.tech];

    const routes = R.allRoutes();
    const problems = [];
    const leaks = [];
    const rows = [];
    let calls = 0;
    const snapAll = () => ({ data: t.stores.data.snapshot(), files: t.stores.files.snapshot(), backups: t.stores.backups.snapshot() });
    const restoreAll = (s) => {
      t.stores.data.restore(s.data); t.stores.files.restore(s.files); t.stores.backups.restore(s.backups);
      sessions.clearSessionCache(); auth.clearPermissionsCache(); T.clearTemplateSeedCache(); HOOK.clearModeCache(); L.clearSecretCache();
    };
    for (const route of routes) {
      for (const probe of probes(route, fx)) {
        for (const actor of actors) {
          if (probe.kind === "self" && !actor.user) continue;
          const { path, ids: used } = probe.at(actor);
          const pr = { ...probe, ids: used };
          const headers = {};
          if (actor.bearer) headers.authorization = `Bearer ${actor.bearer}`;
          const write = route.method !== "GET";
          const snap = write ? snapAll() : null;
          const body = route.body === "raw" ? undefined : write && route.method !== "DELETE" ? {} : undefined;
          const raw = route.body === "raw" ? BYTES.jpeg() : undefined;
          if (raw) headers["content-type"] = "image/jpeg";
          let res;
          try {
            res = await t.api(path, { method: route.method, as: actor.as, office: actor.office, headers, body, raw });
          } finally {
            if (snap) restoreAll(snap);
          }
          calls += 1;
          const row = `${route.method} ${route.path} [${probe.label}] as ${actor.name}`;
          const exp = expected(route, actor, pr, fx);
          const ok = meets(exp, res.status);
          if (DEBUG) rows.push(`${ok ? "  " : "XX"} ${res.status} ${row}${res.status >= 400 && res.body && res.body.error ? " " + (res.body.error.code || res.body.error) : ""} expect ${says(exp)}`);
          if (!ok) problems.push(`${row}: ${res.status} (expected ${says(exp)})${res.body && res.body.error ? " " + JSON.stringify(res.body.error).slice(0, 160) : ""}`);
          if (actor.tech && res.status < 400) crawl(actor, row, res.text, fx, leaks);
        }
      }
    }
    if (DEBUG) (await import("node:fs")).writeFileSync(DEBUG, rows.join("\n") + `\n${calls} calls; types without a fixture: ${fx.skipped.join(", ") || "none"}\n`);
    // every route was called by every kind of caller (a route the probes skipped would hide here)
    assert.ok(calls >= routes.length * actors.length, `${calls} calls for ${routes.length} routes`);
    assert.deepEqual(problems, [], "the permission matrix");
    assert.deepEqual(leaks, [], "the tech leak crawl");
  } finally {
    delete globalThis.__crmSleepScale;
    t.done();
  }
});

// ------------------------------------------------------------ explicit rows

test("explicit 403 rows for techs: /crm/legacy, /legacy/customers, /contacts, /contacts/index, search", async () => {
  const t = await crmTest({ now: "2026-11-17T15:00:00Z" });
  try {
    const owner = await t.user("owner");
    const admin = await t.user("admin");
    const tech = await t.user("tech");
    await store.writeCustomerIndex(store.buildCustomerIndex({ exported_at: "2026-11-08", members: [], customers: [
      { id: "00000000-0000-4000-8000-000000000002", first_name: "Legacy", last_name: "Example", email: "legacy2@example.com", phone: "+17635550495", status: "active", source: "Referral", assigned_to: [], address: { street1: "8 Example Ave", city: "Delano", state: "MN", zip: "55328" }, tags: [], notes: "", created_at: "2025-03-14T15:00:00+00:00" },
    ] }));
    // the page (crm.mjs): the office cookie and the office's people open it; a tech gets "Not for this login"
    assert.equal((await t.page("/crm/legacy", { as: tech })).status, 403, "/crm/legacy as a tech");
    for (const who of [{ as: owner }, { as: admin }, { office: true }]) assert.equal((await t.page("/crm/legacy", who)).status, 200);
    const rows = [
      ["GET", "/legacy/customers"],
      ["GET", "/contacts"],
      ["GET", "/contacts?q=example"],
      ["GET", "/contacts/index"],
      ["GET", "/search?q=example"],
      ["GET", "/search?q=Q-18641"],
      ["POST", "/search/deep", { q: "example" }],
    ];
    for (const [method, path, body] of rows) {
      const res = await t.api(path, { method, as: tech, body });
      assert.equal(res.status, 403, `${method} ${path} as a tech`);
      assert.equal(res.body.error.code, "forbidden");
      assert.ok(!res.text.includes("ct_"), "no contact id in the refusal");
      assert.notEqual((await t.api(path, { method, as: owner, body })).status, 403, `${method} ${path} as an owner`);
    }
  } finally {
    t.done();
  }
});
