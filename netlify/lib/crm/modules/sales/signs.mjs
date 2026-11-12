// Sales module: QR codes for yard signs, door hangers and flyers (Flyra's
// "QR code tracking for signs and flyers"; docs/CRM-SALES.md "Signs &
// flyers"). Menu → Sales → Signs & flyers (signs:manage: owners and the
// office; never a technician).
//
// A code (record type qr_code) has a name ("Yard sign, Maple Grove"), a
// kind, an optional town or area and placement date, and where it sends
// people: the website's quote page (the default) or another page of the
// site. Each gets a short, unguessable path, /q/{8 characters}
// (signs-scan.mjs), which counts the scan (when, and only the rough kind of
// phone) and sends the visitor on with the source in the address
// (utm_source=qr) and in a first-party cookie, barta_q, for 30 days.
//
// Attribution (the website's lead path stays byte for byte as it was): the
// quote form's POST to /api/lead carries the cookie, the CRM's intake reads
// it (contacts/hook.mjs → intake.mjs, through the services below), and the
// new lead's source says "Yard sign: Maple Grove" (source.campaign, with the
// code's id in source.qr_code), its deal and follow-up too. Rotor gets
// exactly what it always got.
//
// Numbers per code: scans and leads live in one small blob per code,
// ptr/qr-stats/{id} (written with compare-and-swap, backed up with ptr/);
// booked and revenue are worked out when the screen asks, from the
// contacts index (a visit ahead or done; lifetime paid, practice payments
// never counted), so they include what the CRM learns later (the import,
// Money).
//
// Services (called by the contacts intake; feature-gated there):
//   sales.qrResolve(ref) → { code_id, label, scanned_at } | null   (a cookie value, checked)
//   sales.qrLead({ code_id, contact_id }, ctx) → true when it was new for the code

import { createHmac, randomBytes } from "node:crypto";
import { getRecord, createRecord, updateRecord, readIndex, readPointer, getRaw, settledWrite } from "../../../crm-store.mjs";
import { deriveId, isId } from "../../core/ids.mjs";
import { nowIso, nowMs, localDate, isLocalDate, now } from "../../core/clock.mjs";
import { contactShard } from "../../core/stats.mjs";
import { CANONICAL_ORIGIN, keySalt } from "../../core/context.mjs";
import { InputError, NotFoundError, ExistsError } from "../../core/errors.mjs";
import { defineType } from "../../core/registry.mjs";
import { shape, str, enumValue } from "../../core/validate.mjs";

export const PERM = "signs:manage";
export const KINDS = Object.freeze(["yard_sign", "flyer", "door_hanger", "truck", "business_card", "other"]);
export const KIND_LABEL = Object.freeze({ yard_sign: "Yard sign", flyer: "Flyer", door_hanger: "Door hanger", truck: "Truck", business_card: "Business card", other: "QR code" });
export const DEST_KINDS = Object.freeze(["quote", "page"]);
export const QUOTE_PAGE = "/get-quote.html";
// 8 characters a person can read off a sign and type: no 0/o, 1/l/i (≈39.6 bits)
export const SLUG_ALPHABET = "23456789abcdefghjkmnpqrstuvwxyz";
export const SLUG_LEN = 8;
export const SLUG_RE = new RegExp(`^[${SLUG_ALPHABET}]{${SLUG_LEN}}$`);
export const COOKIE = "barta_q";
export const COOKIE_DAYS = 30;
export const STATS_DAYS = 120;           // the daily counts kept per code
export const MAX_LEADS = 1000;           // lead ids kept per code (the count goes on)
const isObj = (v) => !!v && typeof v === "object" && !Array.isArray(v);
const clean = (o) => { for (const k of Object.keys(o)) if (o[k] === undefined) delete o[k]; return o; };

// ------------------------------------------------------------ destinations

// A page of the public site: "/", "/get-quote.html", "/services/gutter-cleaning.html",
// "/window-cleaning-delano-mn/". Never the CRM, the office, the portal, the API or another site.
const PAGE_RE = /^\/(?:[a-z0-9][a-z0-9-]{0,60}\/){0,3}(?:[a-z0-9][a-z0-9-]{0,80}\.html)?$/;
const NOT_PUBLIC = new Set(["api", "p", "q", "r", "crm", "crm-app", "office", "admin", "assets", "preview", "netlify", "dashboard", "lights", "playbook", "purchases", "giveaway-admin", "referral-admin"]);
export function cleanPath(v, field = "dest.path") {
  const s = str(v, { field, max: 120 }).toLowerCase();
  const first = s.split("/")[1] || "";
  if (!PAGE_RE.test(s) || NOT_PUBLIC.has(first.replace(/\.html$/, ""))) throw new InputError("Pick a page of the website, like /services/gutter-cleaning.html.", field);
  return s;
}
function cleanDest(v, field = "dest") {
  if (v === undefined || v === null || v === "") return { kind: "quote" };
  if (!isObj(v)) throw new InputError("Where should it send people?", field);
  const kind = enumValue(v.kind || "quote", DEST_KINDS, { field: `${field}.kind`, required: true });
  if (kind === "quote") return { kind };
  return { kind, path: cleanPath(v.path, `${field}.path`) };
}
export const destPathOf = (code) => (code && code.dest && code.dest.kind === "page" && code.dest.path ? code.dest.path : QUOTE_PAGE);
// Where a scan goes: the page, with the source in the address (the site's analytics read utm_*).
export const redirectOf = (code) => `${destPathOf(code)}?utm_source=qr&utm_medium=${encodeURIComponent(code.kind || "other")}&utm_campaign=${encodeURIComponent(code.slug)}`;
export const shortUrl = (slug) => `${CANONICAL_ORIGIN}/q/${slug}`;
// What a lead from this code says as its source: "Yard sign: Maple Grove" (or the code's name).
export const leadLabel = (code) => (code.area ? `${KIND_LABEL[code.kind] || "QR code"}: ${code.area}` : String(code.name || KIND_LABEL[code.kind] || "QR code")).slice(0, 120);

// ------------------------------------------------------------ the record

export function validateQrCode(data, { op } = {}) {
  const stored = op === "update";
  const out = shape(data, {
    name: (v, f) => str(v, { field: f, max: 80, required: true }),
    kind: (v, f) => enumValue(v, KINDS, { field: f, required: true, stored }),
    area: (v, f) => str(v, { field: f, max: 60 }) || undefined,
    placed_on: (v, f) => { if (v === undefined || v === null || v === "") return undefined; if (!isLocalDate(v)) throw new InputError("Use a date like 2026-10-12.", f); return v; },
    dest: (v, f) => (stored && isObj(v) && DEST_KINDS.includes(v.kind) ? clean({ kind: v.kind, path: v.kind === "page" ? String(v.path || QUOTE_PAGE).slice(0, 120) : undefined }) : cleanDest(v, f)),
    slug: (v, f) => { if (!SLUG_RE.test(String(v || ""))) throw new InputError("A code needs its short path.", f); return v; },
    archived_at: (v, f) => (v === undefined || v === null || v === "" ? undefined : (typeof v === "string" && !Number.isNaN(Date.parse(v)) ? new Date(v).toISOString() : (() => { throw new InputError("That date doesn't look right.", f); })())),
    note: (v, f) => str(v, { field: f, max: 300 }) || undefined,
  });
  return clean(out);
}

export const qrCodeRow = (r) => clean({
  n: r.name, k: r.kind, a: r.area || undefined, p: r.placed_on || undefined, s: r.slug, d: (r.dest && r.dest.kind) || "quote", dp: r.dest && r.dest.kind === "page" ? r.dest.path : undefined,
  ar: r.archived_at ? 1 : undefined, at: r.created_at, u: r.updated_at,
});

export const qrCodeType = defineType({
  type: "qr_code",
  prefix: "qr",
  v: 1,
  validate: validateQrCode,
  rotorFields: [],
  techFields: ["id"],
  readPerm: PERM,
  indexes: [{ name: "qr-codes", shard: (r) => (r.deleted_at ? null : ""), row: qrCodeRow }],
  // /q/{slug} finds its code through this pointer (claimed at create: two codes never share a path)
  pointers: [{ kind: "qr-slug", key: (r) => (SLUG_RE.test(String(r.slug || "")) ? r.slug : null) }],
  summary: (r) => ({ id: r.id, name: r.name, kind: r.kind }),
  example: () => ({ name: "Yard sign, Example Street", kind: "yard_sign", area: "Delano", placed_on: "2026-10-12", dest: { kind: "quote" }, slug: "abcd2345" }),
});

export function newSlug(rand = randomBytes) {
  let out = "";
  while (out.length < SLUG_LEN) for (const b of rand(16)) if (b < 248 && out.length < SLUG_LEN) out += SLUG_ALPHABET[b % SLUG_ALPHABET.length];
  return out;
}

// ------------------------------------------------------------ the numbers (ptr/qr-stats/{id})

export const statsKey = (id) => `ptr/qr-stats/${id}`;
export const deviceOf = (ua) => (/iPhone|iPad|iPod/i.test(ua || "") ? "ios" : /Android/i.test(ua || "") ? "android" : "other");
const EMPTY = () => ({ scans: 0, dev: { ios: 0, android: 0, other: 0 }, days: {}, leads: [], lead_n: 0 });

// One more scan (pure). The daily counts keep the last STATS_DAYS days.
export function withScan(cur, device, at = nowIso()) {
  const s = { ...EMPTY(), ...(isObj(cur) ? cur : {}) };
  const day = localDate(new Date(at));
  const days = { ...(s.days || {}), [day]: ((s.days || {})[day] || 0) + 1 };
  const keep = Object.keys(days).sort().slice(-STATS_DAYS);
  const dev = { ios: 0, android: 0, other: 0, ...(s.dev || {}) };
  dev[["ios", "android"].includes(device) ? device : "other"] += 1;
  return { ...s, scans: (s.scans || 0) + 1, dev, days: Object.fromEntries(keep.map((d) => [d, days[d]])), first_at: s.first_at || at, last_at: at };
}
// One more lead (pure; null when this contact is already one of the code's).
export function withLead(cur, contactId, at = nowIso()) {
  const s = { ...EMPTY(), ...(isObj(cur) ? cur : {}) };
  const leads = Array.isArray(s.leads) ? s.leads : [];
  if (leads.some((l) => l && l.c === contactId)) return null;
  return { ...s, leads: [...leads, { c: contactId, at }].slice(-MAX_LEADS), lead_n: (s.lead_n || leads.length) + 1, last_lead_at: at };
}

async function casStats(id, change, opts = {}) {
  const key = statsKey(id);
  for (let i = 0; i < 6; i++) {
    const got = await getRaw(key, opts);
    const cur = got && got.data ? (({ _w, ...rest }) => rest)(got.data) : null;
    const next = change(cur);
    if (!next) return { changed: false, data: cur };
    const w = await settledWrite(key, next, got ? { onlyIfMatch: got.etag } : { onlyIfNew: true }, opts);
    if (w.ok) return { changed: true, data: next };
  }
  throw new Error("qr stats kept changing");
}
export const countScan = (id, device, at = nowIso(), opts = {}) => casStats(id, (cur) => withScan(cur, device, at), opts);
export const readStats = async (id, opts = {}) => {
  const got = await getRaw(statsKey(id), opts);
  return got && got.data ? (({ _w, ...rest }) => ({ ...EMPTY(), ...rest }))(got.data) : EMPTY();
};

// ------------------------------------------------------------ the cookie a scan leaves

const sign = (body, salt = keySalt() || "dev-only") => createHmac("sha256", salt).update(`qr-scan:${body}`).digest("base64url").slice(0, 16);
// "{slug}.{seconds}.{mac}": which code, when; signed so a made-up cookie names no code.
export const refFor = (slug, at = nowMs()) => { const body = `${slug}.${Math.floor(at / 1000)}`; return `${body}.${sign(body)}`; };
export function readRef(v, t = nowMs()) {
  const m = /^([2-9a-z]{8})\.(\d{9,11})\.([A-Za-z0-9_-]{16})$/.exec(String(v || "").trim());
  if (!m || !SLUG_RE.test(m[1])) return null;
  const body = `${m[1]}.${m[2]}`;
  const want = sign(body);
  let same = want.length === m[3].length;
  for (let i = 0; i < want.length; i++) same = same && want[i] === m[3][i];
  if (!same) return null;
  const at = Number(m[2]) * 1000;
  if (!(at <= t + 60000) || t - at > COOKIE_DAYS * 86400000) return null;
  return { slug: m[1], at: new Date(at).toISOString() };
}
export const cookieFor = (slug, at = nowMs()) => `${COOKIE}=${refFor(slug, at)}; Path=/; Max-Age=${COOKIE_DAYS * 86400}; HttpOnly; Secure; SameSite=Lax`;

// The code a slug names (a live record), or null.
export async function codeBySlug(slug, opts = {}) {
  if (!SLUG_RE.test(String(slug || ""))) return null;
  const p = await readPointer("qr-slug", slug, opts);
  if (!p || !isId(p.id, "qr_code")) return null;
  const g = await getRecord("qr_code", p.id, opts);
  return g && !g.data.deleted_at && g.data.slug === slug ? g.data : null;
}

// sales.qrResolve: the cookie value from the quote form's request → where the lead came from.
export async function qrResolve(ref) {
  const r = readRef(ref);
  if (!r) return null;
  const code = await codeBySlug(r.slug);
  return code ? { code_id: code.id, label: leadLabel(code), scanned_at: r.at } : null;
}
// sales.qrLead: the lead counts for the code (once per contact).
export async function qrLead({ code_id, contact_id } = {}) {
  if (!isId(code_id, "qr_code") || !isId(contact_id, "contact")) return false;
  const r = await casStats(code_id, (cur) => withLead(cur, contact_id));
  return r.changed;
}

// ------------------------------------------------------------ what the screens read

const CONTACTS_SHARD = () => contactShard("ct_00000000000000000000");
// A lead's outcome from its contacts index row: booked (a visit ahead or done, or a customer now) and paid (lifetime, real money only).
const outcome = (row) => ({ booked: !!row && (!!row.nv || !!row.ls || row.lc === "customer" || row.lc === "former_customer"), paid_cents: (row && Number.isSafeInteger(row.ml) ? row.ml : 0) });

export function codeView(r, stats, contacts) {
  const leads = (stats.leads || []).map((l) => ({ ...l, row: contacts.get(l.c) || null }));
  const outs = leads.map((l) => outcome(l.row));
  return {
    id: r.id, name: r.name, kind: r.kind, kind_label: KIND_LABEL[r.kind] || "QR code", area: r.area || null, placed_on: r.placed_on || null,
    slug: r.slug, url: shortUrl(r.slug), short: `${CANONICAL_ORIGIN.replace(/^https?:\/\/(www\.)?/, "")}/q/${r.slug}`, dest: r.dest || { kind: "quote" }, dest_path: destPathOf(r), lead_label: leadLabel(r),
    archived: !!r.archived_at, created_at: r.created_at,
    scans: stats.scans || 0, leads: stats.lead_n || leads.length, booked: outs.filter((o) => o.booked).length, revenue_cents: outs.reduce((s, o) => s + o.paid_cents, 0),
    last_scan_at: stats.last_at || null,
  };
}

const rowToCode = (row) => ({ id: row.id, name: row.n, kind: row.k, area: row.a, placed_on: row.p, slug: row.s, dest: row.d === "page" ? { kind: "page", path: row.dp } : { kind: "quote" }, archived_at: row.ar ? "x" : undefined, created_at: row.at });

// GET /qr-codes?archived=1 → { data: [code…], meta: { totals } }
async function listCodes(ctx) {
  const archived = ctx.query.get("archived") === "1";
  const ix = await readIndex("qr-codes", "");
  const rows = ix.rows.filter((r) => !!r.ar === archived).sort((a, b) => String(b.at || "").localeCompare(String(a.at || ""))).slice(0, 60);
  const [stats, cx] = await Promise.all([Promise.all(rows.map((r) => readStats(r.id))), readIndex("contacts", CONTACTS_SHARD())]);
  const contacts = new Map(cx.rows.map((r) => [r.id, r]));
  const data = rows.map((r, i) => codeView(rowToCode(r), stats[i], contacts));
  const totals = { scans: 0, leads: 0, booked: 0, revenue_cents: 0 };
  for (const c of data) for (const k of Object.keys(totals)) totals[k] += c[k];
  return { data, meta: { totals, archived_count: archived ? rows.length : ix.rows.filter((r) => r.ar).length, more: ix.rows.filter((r) => !!r.ar === archived).length > rows.length } };
}

async function codeRecord(id) {
  if (!isId(id, "qr_code")) throw new NotFoundError("That code isn't here.");
  const g = await getRecord("qr_code", id);
  if (!g || g.data.deleted_at) throw new NotFoundError("That code isn't here.");
  return g;
}

// GET /qr-codes/:id → { code, stats: { days (30), dev, first_at, last_at }, leads: [...] }
async function getCode(ctx) {
  const g = await codeRecord(ctx.params.id);
  const [stats, cx] = await Promise.all([readStats(g.data.id), readIndex("contacts", CONTACTS_SHARD())]);
  const contacts = new Map(cx.rows.map((r) => [r.id, r]));
  const day = localDate(now());
  const days = [];
  for (let i = 29; i >= 0; i--) { const d = new Date(Date.parse(`${day}T12:00:00Z`) - i * 86400000).toISOString().slice(0, 10); days.push({ date: d, n: (stats.days || {})[d] || 0 }); }
  const leads = (stats.leads || []).slice(-100).reverse().map((l) => {
    const row = contacts.get(l.c);
    const o = outcome(row);
    return { contact_id: l.c, name: row ? row.n || "No name" : "A contact that was merged or removed", town: (row && row.c) || null, at: l.at, lifecycle: row ? row.lc : null, ...o };
  });
  return {
    data: { code: codeView(g.data, stats, contacts), note: g.data.note || null, stats: { days, dev: stats.dev, first_at: stats.first_at || null, last_at: stats.last_at || null }, leads },
    etag: g.etag,
  };
}

const CLIENT_ID = /^[A-Za-z0-9-]{8,64}$/;
const EDITABLE = ["name", "kind", "area", "placed_on", "dest", "note"];

// POST /qr-codes { name, kind, area?, placed_on?, dest?, note?, client_id }
async function createCode(ctx) {
  const b = ctx.body || {};
  if (!(typeof b.client_id === "string" && CLIENT_ID.test(b.client_id))) throw new InputError("This needs its request id.", "client_id");
  const fields = {};
  for (const k of EDITABLE) if (b[k] !== undefined && b[k] !== null && b[k] !== "") fields[k] = b[k];
  // checked once before any write: a bad form claims no path
  validateQrCode({ ...fields, slug: "abcd2345" });
  const id = deriveId("qr_code", `c:${b.client_id.toLowerCase()}`);
  const had = await getRecord("qr_code", id);
  if (had) return { status: 200, data: { code: codeView(had.data, await readStats(id), new Map()) } };
  for (let i = 0; i < 4; i++) {
    try {
      const r = await createRecord("qr_code", { ...fields, id, slug: newSlug() }, ctx.write());
      return { status: 201, data: { code: codeView(r.data, await readStats(id), new Map()) } };
    } catch (e) {
      if (!(e instanceof ExistsError)) throw e;
      const again = await getRecord("qr_code", id);
      if (again) return { status: 200, data: { code: codeView(again.data, await readStats(id), new Map()) } };
      // the short path was taken (one in a trillion): another one
    }
  }
  throw new ExistsError("Couldn't make a short path. Try again.");
}

// PATCH /qr-codes/:id (If-Match): the name, kind, area, date, where it sends, the note. The short path never changes.
async function patchCode(ctx) {
  if (!ctx.ifMatch) throw new InputError("This change needs the version you edited (If-Match).", "if-match");
  const b = ctx.body || {};
  const patch = {};
  for (const k of EDITABLE) if (b[k] !== undefined) patch[k] = b[k] === "" ? undefined : b[k];
  if (patch.dest !== undefined) patch.dest = cleanDest(patch.dest);
  await codeRecord(ctx.params.id);
  const r = await updateRecord("qr_code", ctx.params.id, (c) => {
    const next = { ...c, ...patch };
    for (const k of Object.keys(patch)) if (patch[k] === undefined) delete next[k];
    return next;
  }, { ...ctx.write(), ifMatch: ctx.ifMatch });
  return { data: { code: codeView(r.data, await readStats(r.data.id), new Map()) }, etag: r.etag };
}

// POST /qr-codes/:id/archive · /restore: off the list (its code keeps working: a sign may still be out there).
const archiveCode = (on) => async (ctx) => {
  await codeRecord(ctx.params.id);
  const r = await updateRecord("qr_code", ctx.params.id, (c) => {
    if (!!c.archived_at === on) return null;
    const next = { ...c };
    if (on) next.archived_at = nowIso(); else delete next.archived_at;
    return next;
  }, ctx.write());
  return { data: { code: codeView(r.data, await readStats(r.data.id), new Map()) } };
};

const R = (method, path, handler, extra = {}) => ({ method, path, auth: "session", perm: PERM, subject: path.includes(":id") ? "required" : "none", mode: "inline", handler, ...extra });
export const signRoutes = [
  // one stats blob per code (60 at most) and the contacts index
  R("GET", "/qr-codes", listCodes, { maxCalls: 80 }),
  R("POST", "/qr-codes", createCode, { maxCalls: 40 }),
  R("GET", "/qr-codes/:id", getCode),
  R("PATCH", "/qr-codes/:id", patchCode, { maxCalls: 40 }),
  R("POST", "/qr-codes/:id/archive", archiveCode(true), { maxCalls: 40 }),
  R("POST", "/qr-codes/:id/restore", archiveCode(false), { maxCalls: 40 }),
];

// The module part (sales/index.mjs composes it).
export const signsPart = {
  types: [qrCodeType],
  perms: [{ key: PERM, label: "Signs & flyers: make QR codes and see their scans and leads", roles: { owner: true, admin: true, tech: false } }],
  routes: signRoutes,
  services: {
    // (cookie value) → { code_id, label, scanned_at } | null
    "sales.qrResolve": (ref) => qrResolve(ref),
    // ({ code_id, contact_id }, ctx) → true when new for the code
    "sales.qrLead": (input) => qrLead(input || {}),
  },
  exportTypes: ["qr_code"],
};

