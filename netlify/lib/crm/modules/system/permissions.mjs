// Core "system" module: what Settings → Team permissions and Settings →
// Integrations read (design §4.5, §4.12, §6.1). Owner-only.
//
//   GET /permissions          settings:owner   every permission with its label, group and role defaults
//                                              (D18), the owner-only ones marked, the saved overrides
//                                              (cfg/permissions) and cfg/auth. Saving goes through
//                                              PUT /settings/permissions and /settings/auth (If-Match),
//                                              which move sys/auth-epoch; loadPermissions() fails closed.
//   GET /admin/integrations   settings:owner   per integration: the mode it is set to, the mode it runs
//                                              in now, and whether each secret is set (names, yes/no)

import { getSettingWithEtag } from "../../../crm-store.mjs";
import { PERMISSION_KEYS, ROLE_DEFAULTS, OWNER_ONLY, ROLES } from "../../core/perms.mjs";
import { allPerms } from "../../core/registry.mjs";
import { integrationsStatus } from "../../adapters/index.mjs";

const GROUPS = Object.freeze({
  account: "You", contacts: "Contacts", leads: "Contacts", consent: "Contacts", sales: "Sales", cadences: "Sales", tasks: "Sales", incidents: "Work",
  quotes: "Quotes", prices: "Quotes", pricebook: "Quotes", plans: "Plans", fees: "Plans", agreements: "Plans", agreement_templates: "Plans",
  schedule: "Schedule", visits: "Work", time: "Time", invoices: "Money", payments: "Money", credits: "Money",
  inbox: "Messages", messages: "Messages", templates: "Messages", automations: "Messages", campaigns: "Messages", reviews: "Messages",
  payroll: "Payroll", reports: "Reports", settings: "Settings", users: "Team", integrations: "Settings", import: "Data", cutover: "Data",
  export: "Data", audit: "Data", outbox: "Messages", pending_actions: "Approvals", api_keys: "You",
});

export const LABELS = Object.freeze({
  "account:own": "Their own account", "contacts:read": "See contacts", "contacts:read_all": "Search and list all contacts", "contacts:write": "Edit contacts",
  "leads:create": "Add a lead", "contacts:merge": "Merge duplicates", "contacts:delete": "Delete contacts", "consent:edit": "Change texting and email consent",
  "sales:work": "Work the call list", "cadences:configure": "Set up follow-up cadences", "tasks:read": "See tasks", "tasks:write": "Edit tasks",
  "incidents:create": "Report an incident", "quotes:read": "See quotes", "quotes:write": "Build quotes", "quotes:send": "Send quotes",
  "prices:override": "Override a price", "pricebook:edit": "Edit the price book", "settings:owner": "Owner settings", "plans:read": "See plans",
  "plans:write": "Edit plans", "plans:cancel": "Cancel plans", "fees:waive": "Waive fees", "agreements:send": "Send agreements",
  "agreement_templates:edit": "Edit agreement templates", "schedule:read": "See the schedule", "schedule:write": "Schedule visits",
  "visits:work": "Work visits (timers, checklist, photos)", "visits:add_line": "Add a line on a visit", "visits:prices": "See visit prices",
  "time:own": "Clock in and out", "time:edit_others": "Edit others' time", "invoices:read": "See invoices", "invoices:read_all": "List all invoices",
  "invoices:write": "Edit invoices", "invoices:send": "Send invoices", "invoices:void": "Void invoices", "payments:record": "Record cash and checks",
  "payments:charge": "Charge a card", "payments:refund": "Refund", "credits:issue": "Give account credit", "inbox:read": "Read the inbox",
  "messages:send": "Send texts and emails", "templates:edit": "Edit templates", "automations:configure": "Set up automations",
  "campaigns:write": "Build campaigns and bulk sends", "campaigns:send": "Confirm a campaign or bulk send", "reviews:read": "See reviews",
  "reviews:match": "Match reviews", "payroll:read_own": "See their own pay", "payroll:read_all": "See everyone's pay", "payroll:run": "Run payroll",
  "reports:read": "See reports", "settings:general": "Company settings", "settings:messaging": "Messaging settings", "users:manage": "Manage the team",
  "integrations:manage": "Connect integrations", "import:run": "Import from Rotor", "cutover:run": "Switch over from Rotor", "export:all": "Export everything",
  "audit:read": "See the activity log", "outbox:read": "See the outbox", "pending_actions:approve": "Approve actions", "api_keys:own": "Make API keys",
});

const labelOf = (key) => LABELS[key] || key.replace(/[_:]/g, " ");
const groupOf = (key) => GROUPS[key.split(":")[0]] || "Other";

async function permissions() {
  const [perms, auth] = await Promise.all([getSettingWithEtag("permissions"), getSettingWithEtag("auth")]);
  const registered = allPerms();
  const keys = [...new Set([...PERMISSION_KEYS, ...registered.map((p) => p.key)])];
  const catalog = keys.map((key) => {
    const reg = registered.find((p) => p.key === key);
    const defaults = Object.fromEntries(ROLES.map((role) => [role, Object.hasOwn(ROLE_DEFAULTS[role], key) ? ROLE_DEFAULTS[role][key] : (reg && reg.roles ? reg.roles[role] ?? false : false)]));
    return { key, label: reg ? reg.label : labelOf(key), group: groupOf(key), defaults, owner_only: OWNER_ONLY.has(key) };
  });
  return { data: { catalog, permissions: perms.data, permissions_etag: perms.etag, auth: auth.data, auth_etag: auth.etag } };
}

async function integrations(ctx) {
  const [s, mode] = await Promise.all([getSettingWithEtag("integrations"), ctx.sysMode()]);
  return { data: { ...integrationsStatus({ deploy: ctx.deploy, settings: s.data, mode }), settings: s.data, etag: s.etag } };
}

export const permissionRoutes = [
  { method: "GET", path: "/permissions", auth: "session", perm: "settings:owner", subject: "none", mode: "inline", handler: permissions },
  { method: "GET", path: "/admin/integrations", auth: "session", perm: "settings:owner", subject: "none", mode: "inline", handler: integrations },
];
