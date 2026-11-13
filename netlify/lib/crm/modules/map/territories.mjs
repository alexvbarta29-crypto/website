// Map module: territories (docs/CRM-MAP.md "Territories"). An owner (or the
// office: canvass:manage) draws an area on the door-to-door map, names it
// and assigns it to people; canvassers see every area, theirs lit. Pins
// count toward an area by where they are, worked out when the report is
// read, so a redrawn area recounts at once.
//
//   GET    /map/territories         canvass:use      every active area (the index, one read)
//   POST   /map/territories         canvass:manage   { name, color?, polygon: [[lng, lat], ...], assignee_ids? }
//   PATCH  /map/territories/:id     canvass:manage   If-Match; any of those, or active: false
//   DELETE /map/territories/:id     canvass:manage   gone from the map (the record stays deleted)

import { getRecord, createRecord, updateRecord, softDelete, readIndex } from "../../../crm-store.mjs";
import { InputError, NotFoundError } from "../../core/errors.mjs";
import { isTerritoryId } from "./types.mjs";

const pick = (b, keys) => Object.fromEntries(keys.filter((k) => b[k] !== undefined).map((k) => [k, b[k]]));
const FIELDS = ["name", "color", "polygon", "assignee_ids", "active", "notes"];

async function activeUsers() {
  const ix = await readIndex("users", "");
  return new Map(ix.rows.filter((u) => u.status === "active").map((u) => [u.id, u]));
}
function checkPeople(ids, users) {
  for (const id of ids || []) if (!users.has(id)) throw new InputError("Pick people from the team.", "assignee_ids");
}
const view = (t, users) => ({ ...t, assignees: (t.assignee_ids || []).map((id) => (users.get(id) || {}).name || "Someone") });

export async function listTerritories(ctx) {
  const [ix, users] = await Promise.all([readIndex("territories", ""), activeUsers()]);
  return {
    data: ix.rows.filter((t) => t.act !== false).map((t) => ({ id: t.id, name: t.n, color: t.col, polygon: t.p, assignee_ids: t.a || [], assignees: (t.a || []).map((id) => (users.get(id) || {}).name || "Someone"), mine: (t.a || []).includes(ctx.user.id) })),
  };
}

export async function createTerritory(ctx) {
  const b = ctx.body || {};
  const users = await activeUsers();
  checkPeople(b.assignee_ids, users);
  const made = await createRecord("territory", { ...pick(b, FIELDS), active: true }, ctx.write());
  return { status: 201, data: view(made.data, users), etag: made.etag };
}

async function load(id) {
  if (!isTerritoryId(id)) throw new NotFoundError("That area isn't there.");
  const g = await getRecord("territory", id);
  if (!g || g.data.deleted_at) throw new NotFoundError("That area isn't there.");
  return g;
}

export async function getTerritory(ctx) {
  const g = await load(ctx.params.id);
  return { data: view(g.data, await activeUsers()), etag: g.etag };
}

export async function patchTerritory(ctx) {
  if (!ctx.ifMatch) throw new InputError("This change needs the version you edited (If-Match).", "if-match");
  const b = ctx.body || {};
  await load(ctx.params.id);
  const users = await activeUsers();
  if (b.assignee_ids !== undefined) checkPeople(b.assignee_ids, users);
  const r = await updateRecord("territory", ctx.params.id, (t) => (t.deleted_at ? null : { ...t, ...pick(b, FIELDS) }), ctx.write({ ifMatch: ctx.ifMatch }));
  return { data: view(r.data, users), etag: r.etag };
}

export async function deleteTerritory(ctx) {
  const g = await load(ctx.params.id);
  await softDelete("territory", g.data.id, ctx.write());
  return { data: { deleted: true } };
}
