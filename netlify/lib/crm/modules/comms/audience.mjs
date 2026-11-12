// Comms: campaign audiences (design §5.7.5, B4). A pure function over the
// rows of the contacts index (the contact part and every module's stats
// columns), so the builder shows a live count and a preview over the whole
// list finishes inside one request with no record or relation reads.
//
//   evaluateAudience(rows, audience, { channel, suppressed?, recent? })
//     → { ids, count, matched, excluded: { reason: n }, unsupported: [filter] }
//
// Always left out, with the reason counted: archived, spam, test and vendor
// contacts; no address for the channel; an address on the opt-out list;
// a second contact on the same phone or email (one message per address);
// anyone a campaign reached in the last few days.
// Marketing consent is not in the list rows: it is checked contact by
// contact when the send is prepared (the bulk run's preview) and again by
// the sender at send time, so the count here is the upper bound.
//
// A filter that needs a column no module has put in the list yet (services
// done and the last service date arrive with Scheduling's stats; the lights
// season and cancelled plans with Plans') matches nobody and is named in
// `unsupported`, never silently ignored.

const lower = (s) => String(s ?? "").trim().toLowerCase();
const anyOf = (have, want) => { const h = new Set((have || []).map(lower)); return want.some((w) => h.has(lower(w))); };
const has = (rows, k) => rows.some((r) => r[k] !== undefined);

export const AUDIENCE_FILTERS = Object.freeze(["lifecycle", "tags_any", "tags_none", "sources", "towns", "zips", "tiers", "services_quoted", "services_done", "plan_status", "has_lights_season", "last_service_between", "created_between", "no_review", "has_open_quote", "include_ids", "exclude_ids"]);

export function evaluateAudience(rows, audience = {}, { channel = "sms", suppressed = null, recent = null, addressKey = null } = {}) {
  const a = audience || {};
  const unsupported = [];
  const needs = (filter, col) => { if (a[filter] !== undefined && !has(rows, col)) unsupported.push(filter); };
  needs("services_done", "svc_d");
  needs("last_service_between", "ls");
  needs("has_lights_season", "lsn");
  needs("tiers", "tier");
  needs("created_between", "ca");
  if (a.plan_status && a.plan_status.includes("cancelled") && !has(rows, "plx")) unsupported.push("plan_status:cancelled");
  const include = new Set(a.include_ids || []);
  const exclude = new Set(a.exclude_ids || []);
  const filtered = Object.keys(a).some((k) => !["include_ids", "exclude_ids"].includes(k) && a[k] !== undefined && !(Array.isArray(a[k]) && !a[k].length));
  const matches = (r) => {
    if (a.lifecycle && a.lifecycle.length && !a.lifecycle.includes(r.lc)) return false;
    if (a.tags_any && a.tags_any.length && !anyOf(r.tg, a.tags_any)) return false;
    if (a.tags_none && a.tags_none.length && anyOf(r.tg, a.tags_none)) return false;
    if (a.sources && a.sources.length && !a.sources.map(lower).includes(lower(r.src))) return false;
    if (a.towns && a.towns.length && !a.towns.map(lower).includes(lower(r.c))) return false;
    if (a.zips && a.zips.length && !a.zips.includes(String(r.z || ""))) return false;
    if (a.tiers && a.tiers.length && !a.tiers.includes(r.tier)) return false;
    if (a.services_quoted && a.services_quoted.length && !anyOf(r.svc_q, a.services_quoted)) return false;
    if (a.services_done && a.services_done.length && !anyOf(r.svc_d, a.services_done)) return false;
    if (a.plan_status && a.plan_status.length) {
      const active = Array.isArray(r.pl) && r.pl.length > 0;
      const ok = (a.plan_status.includes("active") && active) || (a.plan_status.includes("none") && !active && !r.plx) || (a.plan_status.includes("cancelled") && !!r.plx && !active);
      if (!ok) return false;
    }
    if (a.has_lights_season !== undefined && !(Array.isArray(r.lsn) && r.lsn.includes(a.has_lights_season))) return false;
    if (a.last_service_between && !(r.ls && String(r.ls).slice(0, 10) >= a.last_service_between[0] && String(r.ls).slice(0, 10) <= a.last_service_between[1])) return false;
    if (a.created_between && !(r.ca && String(r.ca).slice(0, 10) >= a.created_between[0] && String(r.ca).slice(0, 10) <= a.created_between[1])) return false;
    if (a.no_review === true && r.rv) return false;
    if (a.no_review === false && !r.rv) return false;
    if (a.has_open_quote === true && !r.oq) return false;
    if (a.has_open_quote === false && r.oq) return false;
    return true;
  };
  const excluded = {};
  const drop = (why) => { excluded[why] = (excluded[why] || 0) + 1; };
  const seen = new Set();
  const ids = [];
  let matched = 0;
  for (const r of rows) {
    if (!r || !r.id) continue;
    // an empty audience is nobody (a campaign to everyone is said out loud: a lifecycle, a tag...)
    const inFilter = include.has(r.id) || (filtered && matches(r));
    if (!inFilter) continue;
    matched += 1;
    if (exclude.has(r.id)) { drop("excluded_by_hand"); continue; }
    if (r.lc === "archived") { drop("archived"); continue; }
    if (r.fl && (r.fl.spam || r.fl.test || r.fl.vendor || r.fl.placeholder)) { drop("excluded_flag"); continue; }
    const addr = channel === "sms" ? (r.p || [])[0] : lower((r.e || [])[0]);
    if (!addr) { drop("no_address"); continue; }
    if (seen.has(addr)) { drop("duplicate"); continue; }
    seen.add(addr);
    if (suppressed && addressKey && suppressed.has(addressKey(addr))) { drop("opted_out"); continue; }
    if (recent && recent.has(r.id)) { drop("recent_campaign"); continue; }
    ids.push(r.id);
  }
  return { ids, count: ids.length, matched, excluded, unsupported };
}

// The values a builder offers, from the same rows: towns, sources and tags that exist, most used first.
export function audienceChoices(rows) {
  const tally = (pick) => { const m = new Map(); for (const r of rows) for (const v of [].concat(pick(r) || [])) if (v) m.set(v, (m.get(v) || 0) + 1); return [...m.entries()].sort((x, y) => y[1] - x[1] || String(x[0]).localeCompare(String(y[0]))).slice(0, 60).map(([value, n]) => ({ value, n })); };
  return { towns: tally((r) => r.c), sources: tally((r) => r.src), tags: tally((r) => r.tg), services_quoted: tally((r) => r.svc_q), zips: tally((r) => r.z).slice(0, 30) };
}
