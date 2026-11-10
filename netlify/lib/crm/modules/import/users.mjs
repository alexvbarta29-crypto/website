// The team phases (design §10.2 rows 1-3): Rotor's company members become
// the CRM's users.
//
//   system.users         members (5): each Rotor member is mapped to an
//                        EXISTING CRM user (Alex invited everyone in M1.2):
//                        the owner's choice on the Import screen first, then
//                        the member's earlier mapping (ptr/rotor/user/{rid}),
//                        then the same full name, then the same first name
//                        when only one user has it. Only a member with no
//                        match becomes a new user: status "invited" (no
//                        password: nobody can sign in as them until an owner
//                        sends an invite link), role owner/admin/member →
//                        owner/admin/tech. The user keeps Rotor's facts in
//                        `rotor` (the type's only rotorField); nothing else
//                        an owner set is touched.
//   system.availability  member_availability (5): weekly slots fill an empty
//                        `availability`; is_technician is set only on a user
//                        the import created.
//   system.rates         rate_settings (5 hourly + 7 commission rows): fill a
//                        pay rate that is still 0 (hourly by category, in
//                        cents; commission percent → basis points).
// Row 2 (roles and scopes) maps to roles only; row 3's time off and crews
// belong to Scheduling (work.time_off waits for it; crew ids stay on visits).

import { readIndex, readPointer, getRecord, getRaw, settledWrite } from "../../../crm-store.mjs";
import { idForRotor, isId } from "../../core/ids.mjs";
import { nowIso, nowMs } from "../../core/clock.mjs";
import { USER_COLORS, normLogin } from "../system/types.mjs";
import { rotorKey } from "../contacts/display.mjs";

const str = (v) => (v == null ? "" : String(v)).trim();
const plain = (v) => !!v && typeof v === "object" && !Array.isArray(v);
// a Rotor id: letters, digits, "_", "-", "." (never only dots: "." and ".." are path segments in a key)
const ROTOR_ID = /^(?!\.+$)[A-Za-z0-9_.-]{1,64}$/;
export const ROLE_MAP = Object.freeze({ owner: "owner", admin: "admin", member: "tech" });
// The owner's choice "this Rotor member is nobody here yet: make a new (invited) user".
export const NEW_USER = "new";

export class MemberRowError extends Error {
  constructor(field) { super(`${field} is missing or the wrong type`); this.name = "RowError"; this.field = field; }
}

const normName = (s) => str(s).normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase().replace(/[^a-z ]/g, "").replace(/\s+/g, " ").trim();

export function normalizeMember(row) {
  if (!plain(row)) throw new MemberRowError("row");
  const rid = str(row.user_id || row.id);
  if (!ROTOR_ID.test(rid)) throw new MemberRowError("user_id");
  const first = str(row.first_name), last = str(row.last_name);
  const name = str(row.name) || `${first} ${last}`.trim();
  if (!name) throw new MemberRowError("name");
  return { rid, name: name.slice(0, 60), first_name: (first || name.split(/\s+/)[0]).slice(0, 40), last_name: (last || name.split(/\s+/).slice(1).join(" ")).slice(0, 40), role: str(row.role).toLowerCase() || "member" };
}

// Which CRM user a member is. users: the users index rows ({ id, name,
// first_name, login, status }); taken: user ids already given to another
// member. → { id, how: "override" | "pointer" | "name" | "first_name" } | null
export function matchMember(m, users, { override = null, pointer = null, taken = new Set() } = {}) {
  const live = users.filter((u) => u.status !== "disabled");
  if (override && users.some((u) => u.id === override)) return { id: override, how: "override" };
  if (pointer && users.some((u) => u.id === pointer)) return { id: pointer, how: "pointer" };
  const full = normName(m.name);
  const byName = live.filter((u) => !taken.has(u.id) && (normName(u.name) === full || normName(`${u.first_name || ""} ${u.last_name || ""}`) === full));
  if (byName.length === 1) return { id: byName[0].id, how: "name" };
  const first = normName(m.first_name);
  const byFirst = live.filter((u) => !taken.has(u.id) && first && normName(u.first_name || String(u.name || "").split(/\s+/)[0]) === first);
  if (byFirst.length === 1) return { id: byFirst[0].id, how: "first_name" };
  return null;
}

// The whole map for a run's members (the Import screen shows it before the
// run starts). → [{ rid, name, role, match: { id, how } | null }]
export function proposeMap(members, users, { overrides = {}, pointers = {} } = {}) {
  const taken = new Set();
  const out = members.map((m) => ({ m, match: null, fixed: false }));
  // the owner's choices first ("new": a new user, never a name match), then earlier mappings, so a name match never steals their user
  for (const x of out) {
    const o = overrides[x.m.rid] || null;
    if (o === NEW_USER) { x.fixed = true; continue; }
    const p = pointers[x.m.rid] || null;
    if (o || p) { x.match = matchMember(x.m, users, { override: o, pointer: p }); if (x.match) { taken.add(x.match.id); x.fixed = true; } }
  }
  for (const x of out) if (!x.fixed) { x.match = matchMember(x.m, users, { taken }); if (x.match) taken.add(x.match.id); }
  return out.map((x) => ({ rid: x.m.rid, name: x.m.name, role: x.m.role, match: x.match }));
}

// Users index rows with their ids.
export async function userRows(opts = {}) {
  const ix = await readIndex("users", "", opts);
  return ix.rows.map((r) => ({ id: r.id, name: r.name, first_name: r.first_name, login: r.login, status: r.status, role: r.role }));
}

export async function memberPointers(rids, opts = {}) {
  const out = {};
  await Promise.all(rids.map(async (rid) => { const p = await readPointer("rotor/user", rotorKey(rid), opts); if (p && isId(p.id, "user")) out[rid] = p.id; }));
  return out;
}

// A login nobody has: the first name, then with the last initial, then numbered.
async function freeLogin(m) {
  const base = normName(m.first_name).replace(/[^a-z]/g, "") || "member";
  const last = normName(m.last_name).replace(/[^a-z]/g, "");
  const tries = [base, last ? `${base}${last[0]}` : null, last ? `${base}.${last}` : null, ...[2, 3, 4, 5, 6, 7, 8, 9].map((n) => `${base}${n}`)].filter(Boolean);
  for (const t of tries) {
    let login;
    try { login = normLogin(t); } catch { continue; }
    if (!(await readPointer("login", login))) return login;
  }
  return normLogin(`${base.slice(0, 20)}${nowMs() % 1000}`);
}

// Points ptr/rotor/user/{rid} at a user, replacing an earlier mapping by
// CAS when the owner chose another user.
async function pointMember(rid, uid) {
  const key = `ptr/rotor/user/${rotorKey(rid)}`;
  const cur = await getRaw(key);
  if (cur && cur.data && cur.data.id === uid) return;
  await settledWrite(key, { id: uid, at: nowIso() }, cur ? { onlyIfMatch: cur.etag } : { onlyIfNew: true });
}

// Before the first member: the whole map at once, exactly as the Import
// screen showed it (proposeMap over every member, with the owner's choices
// and the earlier mappings), so one member's match can't take another's user.
async function prepareMembers(rows, ctx) {
  const members = [];
  for (const row of rows) { try { members.push(normalizeMember(row)); } catch { /* skipped with its field later */ } }
  const users = await userRows();
  const pointers = await memberPointers(members.map((m) => m.rid));
  const map = {};
  for (const x of proposeMap(members, users, { overrides: ctx.userOverrides || {}, pointers })) map[x.rid] = x.match ? { id: x.match.id, how: x.match.how } : null;
  return { map };
}

async function mapMember(m, ctx) {
  const planned = ctx.prepared && ctx.prepared.map && Object.hasOwn(ctx.prepared.map, m.rid) ? ctx.prepared.map[m.rid] : undefined;
  let matchId = planned ? planned.id : planned;
  let how = planned ? planned.how : null;
  if (planned === undefined) {
    // a member the map didn't see (only when prepare couldn't run): match it alone
    const users = ctx.cache.users ||= await userRows();
    const pointer = (await memberPointers([m.rid]))[m.rid] || null;
    const taken = new Set([...ctx.users].filter(([rid]) => rid !== m.rid).map(([, uid]) => uid));
    const match = matchMember(m, users, { override: (ctx.userOverrides || {})[m.rid] || null, pointer, taken });
    matchId = match ? match.id : null;
    how = match ? match.how : null;
  }
  const rotor = { user_id: m.rid, role: m.role, name: m.name };
  if (matchId) {
    const got = await getRecord("user", matchId);
    if (!got) return { warnings: ["user_gone"] };
    await pointMember(m.rid, matchId);
    ctx.setUser(m.rid, matchId);
    // the user as it is, plus Rotor's facts in `rotor` (the type's only rotorField)
    return { records: [{ type: "user", data: { ...got.data, rotor } }], warnings: [`user_matched_${how || "name"}`] };
  }
  const id = idForRotor("user", m.rid);
  const existing = await getRecord("user", id);
  if (!existing) {
    const login = await freeLogin(m);
    ctx.setUser(m.rid, id);
    await pointMember(m.rid, id);
    const n = (ctx.cache.made = (ctx.cache.made || 0) + 1);
    return {
      records: [{ type: "user", data: {
        id, login, name: m.name, first_name: m.first_name, last_name: m.last_name, role: ROLE_MAP[m.role] || "tech", status: "invited", is_technician: false,
        color: USER_COLORS[(n + 4) % USER_COLORS.length], password: null, session_epoch: 0, grants: [], denies: [], rotor,
      } }],
      warnings: ["user_created"],
    };
  }
  ctx.setUser(m.rid, id);
  await pointMember(m.rid, id);
  return { records: [{ type: "user", data: { ...existing.data, rotor } }] };
}

// ------------------------------------------------------------ availability (row 1)

export function normalizeAvailability(row) {
  if (!plain(row)) throw new MemberRowError("row");
  const rid = str(row.user_id);
  if (!ROTOR_ID.test(rid)) throw new MemberRowError("user_id");
  const slots = Array.isArray(row.weekly_availability) ? row.weekly_availability : [];
  const out = [];
  for (const s of slots.slice(0, 21)) {
    if (!plain(s) || !Number.isInteger(s.day_of_week) || s.day_of_week < 0 || s.day_of_week > 6) continue;
    const start = str(s.start_time).slice(0, 5), end = str(s.end_time).slice(0, 5);
    if (!/^\d{2}:\d{2}$/.test(start) || !/^\d{2}:\d{2}$/.test(end)) continue;
    out.push({ dow: s.day_of_week, start, end });
  }
  return { rid, is_technician: row.is_technician === true, slots: out };
}

async function mapAvailability(a, ctx) {
  const uid = ctx.users.get(a.rid);
  if (!uid) return { warnings: ["availability_no_user"] };
  const patches = [];
  if (a.slots.length) patches.push({ type: "user", id: uid, fill: { availability: a.slots } });
  // a user the import made learns whether they go out on visits; an owner's choice is never changed
  patches.push({ type: "user", id: uid, set: { is_technician: a.is_technician }, only_if: { created_by: ["import"], status: ["invited"] } });
  return { patches };
}

// ------------------------------------------------------------ pay rates (row 1)

// One rate row, or an object holding the rate tables (both shapes are taken).
export function normalizeRates(row) {
  if (!plain(row)) throw new MemberRowError("row");
  const list = [];
  const one = (r, kind) => {
    if (!plain(r)) return;
    const rid = str(r.user_id);
    if (!ROTOR_ID.test(rid)) return;
    const cat = str(r.category).toLowerCase();
    if ((kind || (r.rate_cents_per_hour !== undefined ? "hourly" : "commission")) === "hourly") {
      if (["service", "sales", "office"].includes(cat) && Number.isFinite(Number(r.rate_cents_per_hour))) list.push({ rid, kind: "hourly", category: cat, value: Math.max(0, Math.round(Number(r.rate_cents_per_hour))) });
    } else if (["technician", "salesman", "upsell"].includes(cat) && Number.isFinite(Number(r.rate))) list.push({ rid, kind: "commission", category: cat, value: Math.max(0, Math.round(Number(r.rate) * 100)) });
  };
  if (Array.isArray(row.hourly_rates) || Array.isArray(row.commission_rates)) {
    for (const r of row.hourly_rates || []) one(r, "hourly");
    for (const r of row.commission_rates || []) one(r, "commission");
  } else one(row, row.type === "hourly" || row.type === "commission" ? row.type : null);
  if (!list.length) throw new MemberRowError("rate");
  return { rates: list };
}

async function mapRates(r, ctx) {
  const patches = [];
  const warnings = [];
  for (const x of r.rates) {
    const uid = ctx.users.get(x.rid);
    if (!uid) { warnings.push("rate_no_user"); continue; }
    if (!x.value) continue;
    const path = x.kind === "hourly" ? `pay.hourly_cents.${x.category}` : `pay.commission_pct.${x.category}`;
    patches.push({ type: "user", id: uid, set: { [path]: x.value }, only_if: { [path]: [0, undefined, null] } });
  }
  return { patches, warnings };
}

export const userPhases = [
  { name: "system.users", entity: "members", after: [], normalize: normalizeMember, prepare: prepareMembers, map: mapMember },
  { name: "system.availability", entity: "member_availability", after: ["system.users"], normalize: normalizeAvailability, map: mapAvailability },
  { name: "system.rates", entity: "rate_settings", after: ["system.users"], normalize: normalizeRates, map: mapRates },
];
