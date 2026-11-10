// Contacts module: the API (design §5.1 "Endpoints", §4.5, §4.6, §2.2).
//
// Lists, the index and search need contacts:read_all (techs: 403). One
// contact needs contacts:read, which a tech holds only for contacts with a
// visit of theirs in the window (§4.6), and then sees techFields only. A
// tech's quick lead (leads:create) creates a lead and answers { contact_id }
// only: when the number or email is already on file a merge candidate goes
// to the office, and the tech never learns whose it is.

import {
  getRecord, createRecord, updateRecord, readIndex, readIndexIfChanged, listEvents, getEvent, addActivity, hk,
} from "../../../crm-store.mjs";
import { deriveId, isId } from "../../core/ids.mjs";
import { now, nowIso } from "../../core/clock.mjs";
import { InputError, NotFoundError, ForbiddenError, ConflictError, ExistsError } from "../../core/errors.mjs";
import { techVisibleContacts, techView } from "../../core/perms.mjs";
import { withDefaults, contactShard } from "../../core/stats.mjs";
import { timeline } from "../../core/activity.mjs";
import { emit } from "../../core/events.mjs";
import { revokeLinks } from "../../portal/core.mjs";
import { fail } from "../../core/http.mjs";
import { safeErr } from "../../../referral-lib.mjs";
import { CONSENT_CHANNELS, CONSENT_STATES, CONSENT_SOURCES, LIFECYCLES, SOURCES } from "./types.mjs";
import { findMatches, createCandidate, resolveContact } from "./match.mjs";
import { propertiesOf, ensureProperty, geocodeProperty } from "./properties.mjs";
import { startMerge, startBulk, runView } from "./merge.mjs";
import { normalizePhone, normalizeEmail, normalizeAddress, dateLabel, collator, sortName, initial } from "./display.mjs";
import { appendNote } from "./intake.mjs";

const SHARD = () => contactShard("ct_00000000000000000000");
const str = (v) => (v == null ? "" : String(v)).trim();
const isObj = (v) => !!v && typeof v === "object" && !Array.isArray(v);
export const LIST_LIMIT = 100;
export const LIST_MAX = 200;

// ------------------------------------------------------------ access

// The contact if this person may read it: office → always; tech → only
// one in their visit window (else 404, so a tech can't probe ids).
async function readable(ctx, id) {
  if (!isId(id, "contact")) throw new NotFoundError("That contact isn't there.");
  const got = await getRecord("contact", id);
  if (!got || got.data.deleted_at) throw new NotFoundError("That contact isn't there.");
  if (ctx.can("contacts:read_all")) return { ...got, tech: false };
  const visible = (await techVisibleContacts(ctx.user.id)).has(got.data.merged_into || id);
  if (!ctx.can("contacts:read", { type: "contact", record: got.data, visible })) throw new NotFoundError("That contact isn't there.");
  return { ...got, tech: true };
}

async function writable(id) {
  if (!isId(id, "contact")) throw new NotFoundError("That contact isn't there.");
  const got = await getRecord("contact", id);
  if (!got || got.data.deleted_at) throw new NotFoundError("That contact isn't there.");
  if (got.data.merged_into) throw new ConflictError("This contact was merged into another one. Open that one instead.");
  return got;
}

// What the API shows of a contact (no writer nonce; the rest as stored).
const view = (c) => { const { _w, ...rest } = c; return rest; };

// ------------------------------------------------------------ lists

async function indexRoute(ctx) {
  const inm = ctx.req.headers.get("if-none-match");
  if (inm) {
    const r = await readIndexIfChanged("contacts", SHARD(), inm);
    if (r === null) return new Response(null, { status: 304, headers: { ETag: inm, "Cache-Control": "no-store" } });
    return { data: { rows: r.rows, built_at: r.built_at, stale: r.stale }, ...(r.etag ? { etag: r.etag } : {}) };
  }
  const r = await readIndex("contacts", SHARD());
  return { data: { rows: r.rows, built_at: r.built_at, stale: r.stale }, ...(r.etag ? { etag: r.etag } : {}) };
}

const words = (q) => String(q || "").toLowerCase().split(/\s+/).filter(Boolean);
const digits = (s) => String(s || "").replace(/\D/g, "");
// Every word must appear in the row's name, phone, email, address or tags (pure).
export function rowMatches(row, ws) {
  if (!ws.length) return true;
  const text = [row.n, row.co, ...(row.e || []), row.a, row.c, row.z, ...(row.tg || []), row.src].join(" ").toLowerCase();
  const phones = (row.p || []).join(" ");
  return ws.every((w) => text.includes(w) || (digits(w).length >= 3 && digits(w) === w.replace(/[^\d]/g, "") && phones.includes(digits(w))));
}

// The list screen's filter (pure): lifecycle / tag / source / town / plan.
export function filterRows(rows, { q, lifecycle, tag, source, town, plan } = {}) {
  const ws = words(q);
  return rows.filter((r) => {
    if (lifecycle) { if (r.lc !== lifecycle) return false; } else if (r.lc === "archived") return false;
    if (tag && !(r.tg || []).some((t) => t.toLowerCase() === tag.toLowerCase())) return false;
    if (source && r.src !== source) return false;
    if (town && String(r.c || "").toLowerCase() !== town.toLowerCase()) return false;
    if (plan === "1" && !(Array.isArray(r.pl) ? r.pl.length : r.pl)) return false;
    return rowMatches(r, ws);
  });
}

export function sortRows(rows) {
  const key = (r) => ({ last_name: r.l, first_name: r.f, company_name: r.co });
  return [...rows].sort((a, b) => {
    const ia = initial(key(a)), ib = initial(key(b));
    if (ia !== ib) return ia === "#" ? 1 : ib === "#" ? -1 : ia < ib ? -1 : 1;
    return collator.compare(sortName(key(a)), sortName(key(b))) || collator.compare(a.f || "", b.f || "") || (a.id < b.id ? -1 : 1);
  });
}

async function listRoute(ctx) {
  const q = ctx.query;
  const limit = Math.min(LIST_MAX, Math.max(1, Number(q.get("limit")) || LIST_LIMIT));
  const offset = Math.max(0, Number(q.get("cursor")) || 0);
  const ix = await readIndex("contacts", SHARD());
  const rows = sortRows(filterRows(ix.rows, { q: q.get("q"), lifecycle: q.get("lifecycle"), tag: q.get("tag"), source: q.get("source"), town: q.get("town"), plan: q.get("plan") }));
  const page = rows.slice(offset, offset + limit);
  return { data: page, meta: { next_cursor: offset + limit < rows.length ? String(offset + limit) : null, total: rows.length, as_of: ix.built_at, stale: ix.stale } };
}

// ------------------------------------------------------------ create

const phoneList = (b) => {
  const list = Array.isArray(b.phones) ? b.phones : b.phone ? [{ e164: b.phone }] : [];
  return list.map((p) => (typeof p === "string" ? { e164: p } : p)).filter((p) => p && str(p.e164 || p.number || p.phone));
};
const emailList = (b) => {
  const list = Array.isArray(b.emails) ? b.emails : b.email ? [{ address: b.email }] : [];
  return list.map((e) => (typeof e === "string" ? { address: e } : e)).filter((e) => e && str(e.address || e.email));
};

// The fields a person may set on a contact (create and edit).
const EDITABLE = ["kind", "first_name", "last_name", "company_name", "phones", "emails", "billing_address", "source", "tags", "notes", "owner_id", "watcher_ids", "primary_property_id", "lifecycle"];
const FLAG_EDITABLE = ["vip", "do_not_service", "vendor", "spam"];

function officeFields(b) {
  const out = {};
  for (const k of EDITABLE) if (b[k] !== undefined) out[k] = b[k];
  out.phones = phoneList(b);
  out.emails = emailList(b);
  if (out.lifecycle !== undefined && !["lead", "customer", "former_customer"].includes(out.lifecycle)) throw new InputError("Pick lead or customer.", "lifecycle");
  if (b.address && !out.billing_address) out.billing_address = b.address;
  if (isObj(b.consent)) {
    const at = nowIso();
    out.consent = {};
    for (const ch of CONSENT_CHANNELS) if (b.consent[ch] === true) out.consent[ch] = { state: "granted", at, source: "manual" };
  }
  if (isObj(b.flags)) out.flags = Object.fromEntries(FLAG_EDITABLE.filter((k) => b.flags[k] === true).map((k) => [k, true]));
  return out;
}

// A tech's quick lead: name, phone, email, address, services, a note. Always a lead.
function quickLeadFields(b, user) {
  const services = (Array.isArray(b.services) ? b.services : []).map(str).filter(Boolean).slice(0, 12);
  const note = [services.length ? "Services: " + services.join(", ") : "", str(b.notes || b.note)].filter(Boolean).join("\n");
  let first = str(b.first_name), last = str(b.last_name);
  if (!first && !last && str(b.name)) { const p = str(b.name).split(/\s+/); first = p[0]; last = p.slice(1).join(" "); }
  return {
    first_name: first.slice(0, 80), last_name: last.slice(0, 80), phones: phoneList(b), emails: emailList(b),
    ...(b.address ? { billing_address: b.address } : {}), lifecycle: "lead",
    source: { source: SOURCES.includes(str(b.source)) ? str(b.source) : "Door to Door" },
    tags: ["Quick lead"], notes: note ? `— Quick lead from ${user.first_name || user.name || "the field"}, ${dateLabel(now())} —\n${note}` : "",
  };
}

async function createRoute(ctx) {
  const b = ctx.body || {};
  const office = ctx.can("contacts:write");
  await ctx.sysMode();
  const clientId = typeof b.client_id === "string" && /^[A-Za-z0-9-]{8,64}$/.test(b.client_id) ? b.client_id.toLowerCase() : null;
  const id = clientId ? deriveId("contact", `c:${clientId}`) : undefined;
  if (id) {
    const had = await getRecord("contact", id);
    if (had) return office ? { status: 200, data: { contact: view(had.data), matches: [] }, etag: had.etag } : { status: 200, data: { contact_id: id } };
  }
  const fields = office ? officeFields(b) : quickLeadFields(b, ctx.user);
  const probe = {
    phones: fields.phones.map((p) => p.e164 || p.number || p.phone), emails: fields.emails.map((e) => e.address || e.email),
    first_name: fields.first_name, last_name: fields.last_name, zip: fields.billing_address && fields.billing_address.zip,
  };
  const matches = await findMatches(probe);
  if (office && matches.length && b.force !== true) {
    return fail("possible_duplicate", "This might be someone already on file.", 409, { details: { matches } });
  }
  let rec;
  try {
    rec = await createRecord("contact", { ...fields, ...(id ? { id } : {}) }, ctx.write());
  } catch (e) {
    if (e instanceof ExistsError && id) {
      const had = await getRecord("contact", id);
      if (had) return office ? { data: { contact: view(had.data), matches: [] }, etag: had.etag } : { data: { contact_id: id } };
    }
    throw e;
  }
  const c = rec.data;
  let propertyId = null;
  const addr = (isObj(b.property) && b.property.address) || c.billing_address;
  if (addr) propertyId = await ensureProperty(c.id, addr, ctx.write()).catch((e) => { console.error(`crm:contacts: property not saved (${safeErr(e)})`); return null; });
  if (!office) {
    // the office learns about the overlap; the tech never does
    for (const m of matches.slice(0, 3)) await createCandidate(c.id, m.id, { reason: m.reason, confidence: m.confidence }, ctx.write()).catch(() => null);
  }
  if (c.lifecycle === "lead") {
    await emit("lead.created", { id: c.id, wv: c.wv, contact_id: c.id, origin: "app", source: (c.source && c.source.source) || "Other" }, ctx.write()).catch((e) => console.error(`crm:contacts: lead.created not queued (${safeErr(e)})`));
  }
  if (!office) return { status: 201, data: { contact_id: c.id } };
  const fresh = propertyId ? await getRecord("contact", c.id) : null;
  return { status: 201, data: { contact: view(fresh ? fresh.data : c), property_id: propertyId, matches }, etag: fresh ? fresh.etag : rec.etag };
}

// ------------------------------------------------------------ one contact

async function getRoute(ctx) {
  const got = await readable(ctx, ctx.params.id);
  const c = got.data;
  if (got.tech) {
    const props = await propertiesOf(c.id);
    return { data: { contact: techView("contact", c), properties: props.map((p) => techView("property", p)) } };
  }
  const [stats, properties] = await Promise.all([getRecord("contact_stats", c.id), propertiesOf(c.id)]);
  return {
    data: {
      contact: view(c), stats: withDefaults(stats ? stats.data : {}), properties: properties.map(({ etag, ...p }) => view(p)),
      // filled by their modules as they ship (§11.3 feature gates)
      deals: [], enrollments: [], plans: [], open_invoices: [], next_visits: [], pending_automations: [],
    },
    etag: got.etag,
  };
}

async function patchRoute(ctx) {
  if (!ctx.ifMatch) throw new InputError("This change needs the version you edited (If-Match).", "if-match");
  const b = ctx.body || {};
  const patch = {};
  for (const k of EDITABLE) if (b[k] !== undefined) patch[k] = b[k];
  if (patch.lifecycle !== undefined && !["lead", "customer", "former_customer"].includes(patch.lifecycle)) throw new InputError("Archive and restore have their own buttons.", "lifecycle");
  if (b.phones !== undefined) patch.phones = phoneList(b);
  if (b.emails !== undefined) patch.emails = emailList(b);
  const flags = isObj(b.flags) ? Object.fromEntries(FLAG_EDITABLE.filter((k) => b.flags[k] !== undefined).map((k) => [k, b.flags[k] === true])) : null;
  const before = await writable(ctx.params.id);
  if (before.data.lifecycle === "archived" && patch.lifecycle) throw new InputError("Restore this contact first.", "lifecycle");
  const r = await updateRecord("contact", ctx.params.id, (rec) => {
    const next = { ...rec, ...patch };
    if (flags) { next.flags = { ...(rec.flags || {}) }; for (const [k, v] of Object.entries(flags)) { if (v) next.flags[k] = true; else delete next.flags[k]; } }
    return next;
  }, { ...ctx.write(), ifMatch: ctx.ifMatch });
  return { data: { contact: view(r.data) }, etag: r.etag };
}

async function previousLifecycle(id) {
  const evts = (await listEvents("contact", id, { limit: 40 })).filter((e) => e.action === "update").slice(0, 10);
  for (const e of evts) {
    const v = await getEvent(e.key);
    const d = v && v.diff && v.diff.lifecycle;
    if (Array.isArray(d) && d[1] === "archived" && d[0] && d[0] !== "archived") return d[0];
  }
  return null;
}

async function archiveRoute(ctx) {
  const reason = str((ctx.body || {}).reason) || "other";
  if (!["spam", "test", "vendor", "duplicate", "out_of_area", "do_not_contact", "other"].includes(reason)) throw new InputError("Pick a reason.", "reason");
  await writable(ctx.params.id);
  const r = await updateRecord("contact", ctx.params.id, (c) => (c.lifecycle === "archived" && c.archived_reason === reason ? null : { ...c, lifecycle: "archived", archived_reason: reason }), ctx.write());
  await revokeLinks(ctx.params.id, { by: ctx.user.id }).catch((e) => console.error(`crm:contacts: links not revoked (${safeErr(e)})`));
  return { data: { contact: view(r.data) }, etag: r.etag };
}

async function restoreRoute(ctx) {
  const got = await writable(ctx.params.id);
  if (got.data.lifecycle !== "archived") return { data: { contact: view(got.data) }, etag: got.etag };
  const prev = (await previousLifecycle(ctx.params.id)) || (got.data.rotor && got.data.rotor.customer_id ? "customer" : "lead");
  const r = await updateRecord("contact", ctx.params.id, (c) => {
    if (c.lifecycle !== "archived") return null;
    const next = { ...c, lifecycle: prev };
    delete next.archived_reason;
    return next;
  }, ctx.write());
  return { data: { contact: view(r.data) }, etag: r.etag };
}

// The merged timeline: what modules added (activity rows) and the contact's
// own history (its events: created, edited, notes, website requests, merges).
async function activityRoute(ctx) {
  const got = await readable(ctx, ctx.params.id);
  const before = ctx.query.get("before") || undefined;
  const rows = await timeline(got.data.id, { limit: 50, before });
  if (got.tech) return { data: rows.filter((r) => !/^lead|^contact|^note/.test(r.kind)) };
  const events = (await listEvents("contact", got.data.id, { limit: 60 })).filter((e) => !before || (e.at && e.at < before));
  // the newest website requests carry their words (one read each, at most 8)
  const withNotes = await Promise.all(events.slice(0, 8).map(async (e) => {
    if (e.action !== "intake") return { at: e.at, kind: `contact.${e.action}`, actor: e.actor, ref: e.key };
    const v = await getEvent(e.key).catch(() => null);
    return { at: e.at, kind: "contact.intake", actor: e.actor, ref: e.key, source: v && v.source, note: v && v.note };
  }));
  const rest = events.slice(8).map((e) => ({ at: e.at, kind: `contact.${e.action}`, actor: e.actor, ref: e.key }));
  const all = [...rows.filter((r) => r.kind !== "lead.intake").map((r) => ({ at: r.at, kind: r.kind, label: r.label, ref: r.refId })), ...withNotes, ...rest];
  all.sort((a, b) => String(b.at || "").localeCompare(String(a.at || "")));
  return { data: all.slice(0, 80) };
}

async function notesRoute(ctx) {
  const text = str((ctx.body || {}).text);
  if (!text) throw new InputError("Write the note first.", "text");
  if (text.length > 4000) throw new InputError("Keep a note under 4,000 characters.", "text");
  await writable(ctx.params.id);
  const who = ctx.user.first_name || ctx.user.name || "staff";
  const block = `— Note, ${dateLabel(now())} (${who}) —\n${text}`;
  const r = await updateRecord("contact", ctx.params.id, (c) => ({ ...c, notes: appendNote(c.notes, block) }), ctx.write());
  await addActivity(ctx.params.id, "note", ctx.params.id, now()).catch(() => {});
  return { data: { contact: view(r.data) }, etag: r.etag };
}

const primaryHk = (c, channel) => {
  try {
    if (channel.startsWith("sms")) { const p = (c.phones || []).find((x) => x.primary) || (c.phones || [])[0]; return p ? hk("phone", p.e164) : "none"; }
    const e = (c.emails || []).find((x) => x.primary) || (c.emails || [])[0];
    return e ? hk("email", e.address) : "none";
  } catch { return "none"; }
};

async function consentRoute(ctx) {
  const b = ctx.body || {};
  if (!CONSENT_CHANNELS.includes(b.channel)) throw new InputError("Pick texts about their work, marketing texts or marketing email.", "channel");
  if (!CONSENT_STATES.includes(b.state)) throw new InputError("Pick yes, unknown or no.", "state");
  const source = CONSENT_SOURCES.includes(b.source) ? b.source : "manual";
  await writable(ctx.params.id);
  const r = await updateRecord("contact", ctx.params.id, (c) => {
    const cur = (c.consent || {})[b.channel] || {};
    if (cur.state === b.state && cur.source === source) return null;
    return { ...c, consent: { ...(c.consent || {}), [b.channel]: { state: b.state, at: nowIso(), source, by: ctx.user.id } } };
  }, ctx.write());
  if (r.changed) {
    await emit("consent.changed", { id: r.data.id, wv: r.data.wv, contact_id: r.data.id, channel: b.channel, address_hk: primaryHk(r.data, b.channel), state: b.state }, ctx.write())
      .catch((e) => console.error(`crm:contacts: consent.changed not queued (${safeErr(e)})`));
  }
  return { data: { contact: view(r.data) }, etag: r.etag };
}

async function pausedRoute(ctx) {
  const b = ctx.body || {};
  if (!["sms", "email"].includes(b.channel)) throw new InputError("Pick texts or email.", "channel");
  if (typeof b.paused !== "boolean") throw new InputError("Pause or resume.", "paused");
  const reason = str(b.reason).slice(0, 200);
  if (b.paused && !reason) throw new InputError("Say why (it shows to the office).", "reason");
  await writable(ctx.params.id);
  const r = await updateRecord("contact", ctx.params.id, (c) => {
    const cur = { ...(c.automations_paused || {}) };
    if (b.paused) cur[b.channel] = { reason, by: ctx.user.id, at: nowIso() }; else delete cur[b.channel];
    const next = { ...c, automations_paused: Object.keys(cur).length ? cur : undefined };
    if (!next.automations_paused) delete next.automations_paused;
    return next;
  }, ctx.write());
  return { data: { contact: view(r.data) }, etag: r.etag };
}

// Owners mark the team's own contacts as test contacts: automation may act
// on them before cutover and bulk sends go to one first (§3.3, §5.7.5).
async function flagsRoute(ctx) {
  const b = ctx.body || {};
  if (typeof b.test !== "boolean") throw new InputError("Say yes or no.", "test");
  await writable(ctx.params.id);
  const r = await updateRecord("contact", ctx.params.id, (c) => {
    const flags = { ...(c.flags || {}) };
    if (b.test === !!flags.test) return null;
    if (b.test) flags.test = true; else delete flags.test;
    return { ...c, flags };
  }, ctx.write());
  return { data: { contact: view(r.data) }, etag: r.etag };
}

// ------------------------------------------------------------ properties

async function listPropertiesRoute(ctx) {
  const got = await readable(ctx, ctx.params.id);
  const props = await propertiesOf(got.data.id);
  return { data: props.map(({ etag, ...p }) => (got.tech ? techView("property", p) : view(p))) };
}

const PROPERTY_EDITABLE = ["label", "address", "access", "assets", "county"];

async function addPropertyRoute(ctx) {
  const b = ctx.body || {};
  await writable(ctx.params.id);
  const clientId = typeof b.client_id === "string" && /^[A-Za-z0-9-]{8,64}$/.test(b.client_id) ? b.client_id.toLowerCase() : null;
  const data = { contact_id: ctx.params.id, label: b.label, address: b.address, access: b.access || {}, assets: b.assets || {}, photo_ids: [] };
  let rec;
  try {
    rec = await createRecord("property", { ...data, ...(clientId ? { id: deriveId("property", `c:${clientId}`) } : {}) }, ctx.write());
  } catch (e) {
    if (e instanceof ExistsError && clientId) {
      const had = await getRecord("property", deriveId("property", `c:${clientId}`));
      if (had) return { data: { property: view(had.data) }, etag: had.etag };
    }
    throw e;
  }
  const c = await getRecord("contact", ctx.params.id);
  if (c && !c.data.primary_property_id) await updateRecord("contact", ctx.params.id, (x) => (x.primary_property_id ? null : { ...x, primary_property_id: rec.data.id }), ctx.write());
  return { status: 201, data: { property: view(rec.data) }, etag: rec.etag };
}

async function readableProperty(ctx, id) {
  if (!isId(id, "property")) throw new NotFoundError("That property isn't there.");
  const got = await getRecord("property", id);
  if (!got || got.data.deleted_at) throw new NotFoundError("That property isn't there.");
  if (ctx.can("contacts:read_all")) return { ...got, tech: false };
  const visible = (await techVisibleContacts(ctx.user.id)).has(got.data.contact_id);
  if (!ctx.can("contacts:read", { type: "property", record: got.data, visible })) throw new NotFoundError("That property isn't there.");
  return { ...got, tech: true };
}

async function getPropertyRoute(ctx) {
  const got = await readableProperty(ctx, ctx.params.id);
  if (got.tech) return { data: { property: techView("property", got.data) } };
  const c = await getRecord("contact", got.data.contact_id);
  return { data: { property: view(got.data), contact: c ? { id: c.data.id, name: c.data.display_name, lifecycle: c.data.lifecycle } : null }, etag: got.etag };
}

async function patchPropertyRoute(ctx) {
  if (!ctx.ifMatch) throw new InputError("This change needs the version you edited (If-Match).", "if-match");
  const b = ctx.body || {};
  const patch = {};
  for (const k of PROPERTY_EDITABLE) if (b[k] !== undefined) patch[k] = b[k];
  if (isObj(b.geo) && Number.isFinite(b.geo.lat) && Number.isFinite(b.geo.lng)) patch.geo = { lat: b.geo.lat, lng: b.geo.lng, source: "manual", at: nowIso() };
  if (!isId(ctx.params.id, "property")) throw new NotFoundError("That property isn't there.");
  const r = await updateRecord("property", ctx.params.id, (p) => {
    const next = { ...p, ...patch };
    // a new address needs a new map point (back into the geocode queue)
    if (patch.address && JSON.stringify(normalizeAddress(patch.address)) !== JSON.stringify(normalizeAddress(p.address)) && !patch.geo) {
      delete next.geo; delete next.geo_tried_at; delete next.distance_mi; next.town_tier = "unknown";
    }
    return next;
  }, { ...ctx.write(), ifMatch: ctx.ifMatch });
  return { data: { property: view(r.data) }, etag: r.etag };
}

async function geocodeRoute(ctx) {
  const out = await geocodeProperty(ctx.params.id, ctx.write(), { deploy: ctx.deploy });
  return { data: out };
}

// ------------------------------------------------------------ merge review

async function candidatesRoute(ctx) {
  const status = ctx.query.get("status") || "pending";
  const [ix, cx] = await Promise.all([readIndex("merge-candidates", ""), readIndex("contacts", SHARD())]);
  const byId = new Map(cx.rows.map((r) => [r.id, r]));
  const rows = ix.rows.filter((r) => status === "all" || r.st === status)
    .sort((a, b) => (a.k ?? 3) - (b.k ?? 3) || String(b.at).localeCompare(String(a.at)))
    .slice(0, 100)
    .map((r) => ({ id: r.id, reason: r.r, confidence: r.cf, status: r.st, created_at: r.at, a: byId.get(r.a) || { id: r.a, gone: true }, b: byId.get(r.b) || { id: r.b, gone: true } }));
  const counts = { high: 0, medium: 0, low: 0 };
  for (const r of ix.rows) if (r.st === "pending" && Object.hasOwn(counts, r.cf)) counts[r.cf] += 1;
  return { data: rows, meta: { counts, total: ix.rows.filter((r) => status === "all" || r.st === status).length } };
}

async function candidateOf(id) {
  if (!isId(id, "merge_candidate")) throw new NotFoundError("That pair isn't there.");
  const got = await getRecord("merge_candidate", id);
  if (!got) throw new NotFoundError("That pair isn't there.");
  return got.data;
}

async function mergeCandidateRoute(ctx) {
  const m = await candidateOf(ctx.params.id);
  if (m.status !== "pending") throw new ConflictError("This pair was already decided.");
  const survivor = (ctx.body || {}).survivor === "b" ? "b" : "a";
  const [keep, drop] = survivor === "a" ? [m.a, m.b] : [m.b, m.a];
  const run = await startMerge(keep, drop, ctx.write());
  return { status: 202, data: { run_id: run.id, run: runView(run) } };
}

async function dismissRoute(ctx) {
  const m = await candidateOf(ctx.params.id);
  const r = await updateRecord("merge_candidate", m.id, (x) => (x.status !== "pending" ? null : { ...x, status: "dismissed", decided_by: ctx.user.id, decided_at: nowIso(), ...(str((ctx.body || {}).note) ? { note: str(ctx.body.note).slice(0, 500) } : {}) }), ctx.write());
  return { data: { status: r.data.status } };
}

async function bulkRoute(ctx) {
  const b = ctx.body || {};
  const run = await startBulk(b.action, b.confirm, ctx.write());
  return { status: 202, data: { run_id: run.id, run: runView(run) } };
}

async function mergeContactRoute(ctx) {
  const other = str((ctx.body || {}).other_id);
  const keep = await resolveContact(ctx.params.id);
  if (!keep) throw new NotFoundError("That contact isn't there.");
  const run = await startMerge(keep.id, other, ctx.write());
  return { status: 202, data: { run_id: run.id, run: runView(run) } };
}

// ------------------------------------------------------------ the table

const R = (method, path, perm, subject, handler, extra = {}) => ({ method, path, auth: "session", perm, subject, mode: "inline", handler, ...extra });

export const contactRoutes = [
  R("GET", "/contacts/index", "contacts:read_all", "none", indexRoute),
  R("GET", "/contacts", "contacts:read_all", "none", listRoute),
  R("POST", "/contacts", "leads:create", "none", createRoute, { maxCalls: 60 }),
  R("GET", "/contacts/:id", "contacts:read", "required", getRoute),
  R("PATCH", "/contacts/:id", "contacts:write", "required", patchRoute, { maxCalls: 40 }),
  R("POST", "/contacts/:id/archive", "contacts:write", "required", archiveRoute, { maxCalls: 40 }),
  R("POST", "/contacts/:id/restore", "contacts:write", "required", restoreRoute, { maxCalls: 40 }),
  R("GET", "/contacts/:id/activity", "contacts:read", "required", activityRoute),
  R("POST", "/contacts/:id/notes", "contacts:write", "required", notesRoute),
  R("PATCH", "/contacts/:id/consent", "consent:edit", "required", consentRoute),
  R("PATCH", "/contacts/:id/automations-paused", "consent:edit", "required", pausedRoute),
  R("PATCH", "/contacts/:id/flags", "settings:owner", "required", flagsRoute),
  R("GET", "/contacts/:id/properties", "contacts:read", "required", listPropertiesRoute),
  R("POST", "/contacts/:id/properties", "contacts:write", "required", addPropertyRoute, { maxCalls: 30 }),
  R("GET", "/properties/:id", "contacts:read", "required", getPropertyRoute),
  R("PATCH", "/properties/:id", "contacts:write", "required", patchPropertyRoute),
  R("POST", "/properties/:id/geocode", "contacts:write", "required", geocodeRoute),
  R("GET", "/merge-candidates", "contacts:merge", "none", candidatesRoute),
  R("POST", "/merge-candidates/bulk", "contacts:merge", "none", bulkRoute, { mode: "run" }),
  R("POST", "/merge-candidates/:id/merge", "contacts:merge", "required", mergeCandidateRoute, { mode: "run" }),
  R("POST", "/merge-candidates/:id/dismiss", "contacts:merge", "required", dismissRoute),
  R("POST", "/contacts/:id/merge", "contacts:merge", "required", mergeContactRoute, { mode: "run" }),
];

export { LIFECYCLES };
