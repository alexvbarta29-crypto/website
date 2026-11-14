// Automations module: what a condition reads, and whether it holds.
//
// Facts = { c: the contact's side, r: the record's side, since }:
//   c: { source, tags, town, owner, lifecycle, has_plan, quoted, services,
//        last_inbound_at, reviewed }
//   r: { type, status, amount, services, plan_type, town, owner } | null
//   since: when the run started ("they replied" means after this)
// built either from records (the contact, its contact_stats, the run's
// record: factsFromRecords) or from one row of the contacts index
// (factsFromRow: the daily "On a schedule" trigger reads the whole list in
// one go, no record reads). holds(cond, facts, at) is pure.

import { getRecord } from "../../../crm-store.mjs";
import { isId } from "../../core/ids.mjs";
import { localDate, localTime, localDow, now } from "../../core/clock.mjs";
import { FIELDS, serviceKey } from "./catalog.mjs";

const lower = (s) => String(s ?? "").trim().toLowerCase();
const uniq = (list) => [...new Set(list.filter(Boolean))];

export const recordAmount = (type, r) => {
  if (!r) return null;
  if (type === "invoice") return Number.isInteger(r.balance_cents) && r.status === "open" ? r.balance_cents : r.total_cents ?? null;
  if (type === "quote") {
    const o = (r.options || []).find((x) => x.id === r.selected_option_id) || (r.options || []).find((x) => x.recommended) || (r.options || [])[0];
    return o && o.totals ? o.totals.first_cents ?? null : null;
  }
  if (type === "job" || type === "visit") return r.totals ? r.totals.total_cents ?? null : r.total_cents ?? null;
  if (type === "plan") return r.sale_value_cents ?? null;
  return r.total_cents ?? r.amount_cents ?? null;
};
export const planTypeOf = (p) => (!p ? null : p.kind === "lights_annual" ? "lights" : ["biannual", "quarterly", "monthly"].includes(p.catalog_key) ? p.catalog_key : "other");

export function recordSide(type, r) {
  if (!r) return null;
  const services = uniq([...(r.service_types || []), ...(r.services || [])].map(serviceKey));
  if (type === "plan" && r.kind === "lights_annual" && !services.includes("lights")) services.push("lights");
  if (type === "job" && /^lights/.test(r.kind || "") && !services.includes("lights")) services.push("lights");
  return {
    type, status: type === "contact" ? r.lifecycle : r.status || null, amount: recordAmount(type, r), services,
    plan_type: type === "plan" ? planTypeOf(r) : null, town: r.town || null, owner: r.owner_id || null,
  };
}

export function factsFromRecords({ contact, stats, type, record, since } = {}) {
  const st = stats || {};
  const q = st.quotes || {};
  const c = contact || {};
  return {
    c: {
      source: (c.source && c.source.source) || "", tags: c.tags || [], town: (c.billing_address && c.billing_address.city) || "",
      owner: c.owner_id || null, lifecycle: c.lifecycle || "lead",
      has_plan: Array.isArray(st.plans && st.plans.active_plan_ids) && st.plans.active_plan_ids.length > 0,
      quoted: !!q.open_quote || (Array.isArray(q.svc_q) && q.svc_q.length > 0) || (Array.isArray(q.open_ids) && q.open_ids.length > 0),
      services: uniq((q.svc_q || []).map(serviceKey)),
      last_inbound_at: (st.comms && st.comms.last_inbound_at) || null,
      reviewed: !!(st.reviews && st.reviews.review_left_at),
    },
    r: type ? recordSide(type, record) : null,
    since: since || null,
  };
}

// One contacts index row (the contact part and the modules' stats columns).
export function factsFromRow(row, { since } = {}) {
  return {
    c: {
      source: row.src || "", tags: row.tg || [], town: row.c || "", owner: row.o || null, lifecycle: row.lc || "lead",
      has_plan: Array.isArray(row.pl) && row.pl.length > 0, quoted: !!row.oq || (Array.isArray(row.svc_q) && row.svc_q.length > 0),
      services: uniq((row.svc_q || []).map(serviceKey)), last_inbound_at: row.li || null, reviewed: !!row.rv,
    },
    r: null,
    since: since || null,
  };
}

// Does one condition hold? at: the instant it's asked (time conditions).
export function holds(cond, f, at = now()) {
  const def = FIELDS[cond.field];
  if (!def) return false;
  const c = f.c || {};
  const r = f.r || null;
  const v = cond.value;
  const is = (x) => (cond.op === "is" || cond.op === "includes" || cond.op === "has" ? x : !x);
  switch (cond.field) {
    case "source": return is(lower(c.source) === lower(v));
    case "tags": return is((c.tags || []).some((t) => lower(t) === lower(v)));
    case "town": return is(lower((r && r.town) || c.town) === lower(v));
    case "owner": {
      const o = c.owner || (r && r.owner) || null;
      return cond.op === "none" ? !o : is(o === v);
    }
    case "lifecycle": return is(c.lifecycle === v);
    case "service": {
      const list = r && r.services && r.services.length ? r.services : c.services || [];
      return is(list.includes(v));
    }
    case "plan_type": return is(!!r && r.plan_type === v);
    case "has_plan": return cond.op === "yes" ? !!c.has_plan : !c.has_plan;
    case "amount": {
      const a = r ? r.amount : null;
      if (!Number.isInteger(a)) return false;
      return cond.op === "gte" ? a >= v * 100 : a <= v * 100;
    }
    case "status": return is(!!r && r.status === v);
    case "replied": {
      const yes = !!c.last_inbound_at && (!f.since || c.last_inbound_at > f.since);
      return cond.op === "yes" ? yes : !yes;
    }
    case "quoted": return cond.op === "yes" ? !!c.quoted : !c.quoted;
    case "reviewed": return cond.op === "yes" ? !!c.reviewed : !c.reviewed;
    case "weekday": { const d = localDow(at); const wk = d >= 1 && d <= 5; return cond.op === "weekday" ? wk : !wk; }
    case "time": { const t = localTime(at); return t >= v[0] && t < v[1]; }
    case "date": {
      const md = localDate(at).slice(5);
      return v[0] <= v[1] ? md >= v[0] && md <= v[1] : md >= v[0] || md <= v[1];
    }
    default: return false;
  }
}

export const allHold = (conds, f, at) => (conds || []).every((c) => holds(c, f, at));
export const firstHolding = (conds, f, at) => (conds || []).find((c) => holds(c, f, at)) || null;

// ------------------------------------------------------------ loading

const data = async (type, id) => {
  if (!isId(id, type)) return null;
  const g = await getRecord(type, id).catch(() => null);
  return g && g.data && !g.data.deleted_at ? g.data : null;
};

// The run's record, its contact and the contact's stats. → { record, contact, stats }
export async function loadFacts({ subject, contact_id } = {}) {
  const type = subject && subject.type;
  const record = type && type !== "contact" ? await data(type, subject.id) : null;
  const cid = contact_id || (record && record.contact_id) || (type === "contact" ? subject.id : null);
  const [contact, stats] = await Promise.all([data("contact", cid), isId(cid, "contact") ? getRecord("contact_stats", cid).then((g) => (g ? g.data : null)).catch(() => null) : null]);
  return { record: type === "contact" ? contact : record, contact, stats, type };
}
