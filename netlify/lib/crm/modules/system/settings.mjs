// Core "system" module: the owner-only settings documents sign-in reads
// (design §4.5, §4.12). Both are settings:owner; the Settings screens and
// GET/PUT /settings/:name arrive in M1.3. Changing either bumps everyone's
// session epoch there.
//
//   cfg/auth        { office_cookie_roles: ["owner"] }  which roles' Team
//                   sign-in may also set the office cookie (D14)
//   cfg/permissions { roles: { admin: { "invoices:void": true }, tech: {...} } }
//                   overrides of the D18 role defaults; owner-only
//                   permissions can never be given to admin or tech

import { InputError } from "../../core/errors.mjs";
import { isPlainObject } from "../../core/validate.mjs";
import { OWNER_ONLY, ROLES } from "../../core/perms.mjs";

function validateAuth(v) {
  const out = isPlainObject(v) ? { ...v } : {};
  const roles = out.office_cookie_roles === undefined ? ["owner"] : out.office_cookie_roles;
  if (!Array.isArray(roles) || roles.some((r) => !ROLES.includes(r))) throw new InputError("Pick roles from owner, admin and tech.", "office_cookie_roles");
  out.office_cookie_roles = [...new Set(roles)];
  return out;
}

function validatePermissions(v) {
  const out = isPlainObject(v) ? { ...v } : {};
  const roles = isPlainObject(out.roles) ? out.roles : {};
  const clean = {};
  for (const [role, perms] of Object.entries(roles)) {
    if (!["admin", "tech"].includes(role)) throw new InputError("Only admin and tech defaults can change.", `roles.${role}`);
    if (!isPlainObject(perms)) throw new InputError("Expected permission: value pairs.", `roles.${role}`);
    clean[role] = {};
    for (const [perm, val] of Object.entries(perms)) {
      if (!/^[a-z_]+:[a-z_]+$/.test(perm)) throw new InputError("That isn't a permission.", `roles.${role}.${perm}`);
      if (OWNER_ONLY.has(perm)) throw new InputError("Owner-only permissions can't be given to anyone else.", `roles.${role}.${perm}`);
      if (!(val === true || val === false || val === "own")) throw new InputError("Use yes, own or no.", `roles.${role}.${perm}`);
      clean[role][perm] = val;
    }
  }
  out.roles = clean;
  return out;
}

export const systemSettings = {
  auth: { defaults: { office_cookie_roles: ["owner"] }, validate: validateAuth, perm: "settings:owner" },
  permissions: { defaults: { roles: {} }, validate: validatePermissions, perm: "settings:owner" },
};
