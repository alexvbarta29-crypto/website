// Barta CRM core: the contact_stats sidecar (design §5.1 "Stats ownership").
//
// Everything the system keeps up to date about a contact (counters, last
// contact times, card status, first text per number) lives in
// rec/contact_stats/{contactId}, one part per owning module, so a payment or
// an incoming text never makes an office user's edit of the contact go stale.
// A module declares its part in its manifest (statsParts: { quotes: {
// defaults, row } }) and writes it only through crm-store updateStats() (the
// "stats.update" service). The contacts index row has a "contact" part (from
// the contact record) and a "stats" part built here from every module's row().

import { allStatsParts, statsPart, indexFeeds } from "./registry.mjs";
import { InputError } from "./errors.mjs";

export const STATS_TYPE = "contact_stats";
export const STATS_INDEX = "contacts";
export const STATS_INDEX_PART = "stats";

const clone = (v) => (v === undefined ? undefined : JSON.parse(JSON.stringify(v)));

// The registered defaults of a part (a fresh copy).
export function partDefaults(part) {
  const def = statsPart(part);
  if (!def) throw new InputError(`Unknown stats part ${part}.`, "part");
  return clone(def.defaults);
}

// A stats record with every registered part filled in (missing parts get
// their defaults; parts of modules this code doesn't know are kept).
export function withDefaults(stats) {
  const out = { ...(stats || {}) };
  for (const [part, def] of allStatsParts()) out[part] = { ...clone(def.defaults), ...(out[part] || {}) };
  return out;
}

// The stats part of a contacts index row: every module's row() merged.
export function statsIndexRow(stats) {
  const full = withDefaults(stats);
  const row = {};
  for (const [part, def] of allStatsParts()) Object.assign(row, def.row(full[part]) || {});
  return row;
}

// The contacts-index shard of a contact id, from the contact type's own
// shard rule (single shard "" until the contacts module says otherwise).
export function contactShard(contactId) {
  const feed = indexFeeds(STATS_INDEX).find((f) => f.type === "contact");
  if (!feed) return "";
  try {
    const s = feed.shard({ id: contactId });
    return typeof s === "string" ? s : "";
  } catch { return ""; }
}
