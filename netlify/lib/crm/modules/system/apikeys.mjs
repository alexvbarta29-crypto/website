// Core "system" module: API keys (design §4.9, §4.11).
//
//   GET    /api-keys        api_keys:own   my keys: name, kind, scopes, last used, last 4 characters
//   POST   /api-keys        api_keys:own   { name, kind: "header" | "path" | "backup", scopes?, expires_days? }
//                                          → the key, shown ONCE. A secret route: never kept in idem/
//                                          (the registry refuses a secret route that is idempotent)
//   DELETE /api-keys/:id    api_keys:own   revoke one of my keys
//
// Scopes default to the person's read permissions; write scopes are ticked
// one by one; some can never be on a key (core/apikeys.mjs). A "backup"
// key (owners) carries export:all only, for the off-site pull.

import { getRaw, listRel, appendEvent } from "../../../crm-store.mjs";
import { createApiKey, revokeApiKey, APIKEY_KEY } from "../../core/apikeys.mjs";
import { NotFoundError } from "../../core/errors.mjs";
import { isId } from "../../core/ids.mjs";

const view = (k) => ({
  id: k.id, name: k.name, kind: k.kind, scopes: k.scopes || [], last4: k.last4, created_at: k.created_at,
  last_used_at: k.last_used_at || null, expires_at: k.expires_at || null,
});

async function myKeys(user) {
  const rows = await listRel("user-apikeys", user.id, { limit: 50 });
  const got = await Promise.all(rows.map((r) => (/^[0-9a-f]{64}$/.test(r.id) ? getRaw(APIKEY_KEY(r.id)).catch(() => null) : null)));
  return rows.map((r, i) => (got[i] && got[i].data ? { hash: r.id, key: got[i].data } : null)).filter((x) => x && x.key.user_id === user.id);
}

async function list(ctx) {
  return { data: (await myKeys(ctx.user)).map((k) => view(k.key)) };
}

async function create(ctx) {
  const b = ctx.body || {};
  const { key, record } = await createApiKey(ctx.user, { name: b.name, kind: b.kind || "header", scopes: Array.isArray(b.scopes) ? b.scopes : undefined, expires_days: b.expires_days }, { permissions: ctx.permissions });
  await appendEvent("user", ctx.user.id, { action: "api_key_created", by: ctx.user.id, origin: "api", key_id: record.id, kind: record.kind, scopes: record.scopes }).catch(() => {});
  return { status: 201, data: { ...view(record), key } };
}

async function revoke(ctx) {
  const id = ctx.params.id;
  if (!isId(id, "api_key")) throw new NotFoundError("That key isn't there.");
  const mine = (await myKeys(ctx.user)).find((k) => k.key.id === id);
  if (!mine) throw new NotFoundError("That key isn't there.");
  await revokeApiKey(mine.hash);
  await appendEvent("user", ctx.user.id, { action: "api_key_revoked", by: ctx.user.id, origin: "api", key_id: id }).catch(() => {});
  return { data: { ok: true } };
}

const r = (method, path, handler, more = {}) => ({ method, path, auth: "session", perm: "api_keys:own", subject: "none", mode: "inline", handler, ...more });
export const apiKeyRoutes = [
  r("GET", "/api-keys", list),
  r("POST", "/api-keys", create, { secret: true, idempotent: false }),
  r("DELETE", "/api-keys/:id", revoke, { subject: "required" }),
];
