// Plans module: the customer's pages (design §8.1, §8.5), registered
// through portalRoutes; crm-portal.mjs and portal/core.mjs (core) check the
// link's scope before any of these run, send the portal headers and CSP,
// and require X-CRM-Portal: 1 on POSTs.
//
//   GET  /p/agreement/:id                    scope agreement: read, sign, print
//   POST /api/portal/agreements/:id/sign     { body_sha256, name_typed, agree, signature_png_b64? }
//   GET  /p/hub                              scope hub: the customer's home (P0 minimal)
//   GET  /p/hub/agreements/:id · POST /api/portal/hub/agreements/:id/sign   the same, from the hub
//   POST /api/portal/hub/open {kind: "quote", id}   a short link to one open quote → { location }
//   GET  /p/login · POST /api/portal/login {phone}  public: "text me a link" (a hub link by text)
//   GET  /p/sign/:token · POST /api/portal/sign/:token   in person on the staff phone (a present link)
//   beacon "agreement": sent → viewed
//
// A document link never opens the hub (core's scope check); the hub needs a
// hub link, which /p/login texts to a number on file. /p/login always gives
// the same answer (it never tells whether a number is on file), sends at
// most 1 text per 10 minutes and 3 a day per number, and takes 20 tries an
// hour per IP. GET pages never change anything.

import { createHash, randomBytes } from "node:crypto";
import { getRecord, getRecords, listRel, listKeys, putRaw, hk } from "../../../crm-store.mjs";
import { isId } from "../../core/ids.mjs";
import { now, nowMs, localDate, tsKey, fromTsKey, addLocalDays, zonedToUtc } from "../../core/clock.mjs";
import { ConflictError, InputError, NotFoundError } from "../../core/errors.mjs";
import { clientIp, uaFamily } from "../../core/http.mjs";
import { ipHash } from "../../core/sessions.mjs";
import { has, call } from "../../core/services.mjs";
import { sendMessage } from "../../core/send.mjs";
import { definePortalBeacon, createPortalLink, linkKey } from "../../portal/core.mjs";
import { safeErr } from "../../../referral-lib.mjs";
import { agreementPage, hubPage, loginPage } from "./render.mjs";
import { signAgreement, markViewed } from "./agreements.mjs";
import { activateIfReady } from "./plans.mjs";

const SCRIPT_AGREEMENT = "plans-agreement.js";
const SCRIPT_HUB = "plans-hub.js";
const SCRIPT_LOGIN = "plans-login.js";
export const LOGIN_LIMITS = Object.freeze({ phone_gap_ms: 10 * 60 * 1000, phone_per_day: 3, ip_per_hour: 20 });
export const LOGIN_ANSWER = "If that number is on file, we texted you a link.";
const sha = (s) => createHash("sha256").update(String(s)).digest("hex");

async function agreementFor(p, id) {
  if (!isId(id, "agreement")) return null;
  const g = await getRecord("agreement", id).catch(() => null);
  if (!g || g.data.deleted_at || g.data.contact_id !== p.contact_id || g.data.status === "draft") return null;
  return g.data;
}
const contactOf = async (id) => ((await getRecord("contact", id).catch(() => null)) || {}).data || null;

const answer = (p, fn) => fn().catch((e) => {
  if (e instanceof ConflictError) return p.fail(e.code || "conflict", e.message, 409);
  if (e instanceof InputError) return p.json({ ok: false, error: { code: "invalid", message: e.message, field: e.field } }, 400);
  if (e instanceof NotFoundError) return p.fail("not_found", "That agreement isn't here.", 404);
  throw e;
});
const who = (p, extra) => ({ ip_hash: ipHash(clientIp(p.req, p.context)), ua: uaFamily(p.req.headers.get("user-agent")), ...extra });

async function page(p, a, mode, base, backTo) {
  const contact = await contactOf(a.contact_id);
  const { title, body } = agreementPage({ agreement: a, contact, mode, base, backTo });
  const live = ["sent"].includes(a.status) && mode !== "present";
  return p.portalPage(p.layout({ title, body, script: SCRIPT_AGREEMENT, company: p.company, page: mode === "present" ? "present" : "agreement", beacon: live && mode === "portal" ? { kind: "agreement", id: a.id } : null }));
}

async function sign(p, a, extra) {
  const out = await signAgreement(a.id, p.body || {}, who(p, { contact_id: p.contact_id, ...extra }), p, { onSigned: activateIfReady });
  return p.json({ ok: true, data: { status: out.agreement.status, already: !!out.already } });
}

// ------------------------------------------------------------ the hub

const WINDOW_TEXT = (v) => {
  const t = (s) => { const [h, m] = String(s || "08:00").split(":").map(Number); const ap = h >= 12 ? "PM" : "AM"; return `${((h + 11) % 12) + 1}:${String(m).padStart(2, "0")} ${ap}`; };
  const w = v.window || {};
  if (v.date_only || w.type === "anytime") return "Anytime that day";
  if (w.type === "window" && w.minutes) {
    const [h, m] = String(v.start || "08:00").split(":").map(Number);
    const end = h * 60 + m + w.minutes;
    return `Arriving between ${t(v.start)} and ${t(`${Math.floor(end / 60) % 24}:${String(end % 60).padStart(2, "0")}`)}`;
  }
  return `Arriving at ${t(v.start)}`;
};

export async function hubData(contactId) {
  const day = localDate(now());
  const contact = await contactOf(contactId);
  const jobRows = await listRel("contact-jobs", contactId, { limit: 40 }).catch(() => []);
  const jobs = (await getRecords("job", jobRows.map((r) => r.id))).filter(Boolean).map((g) => g.data).filter((j) => !j.deleted_at && j.contact_id === contactId && ["scheduled", "in_progress"].includes(j.status));
  const visits = (await getRecords("visit", jobs.flatMap((j) => (j.visit_ids || []).slice(-6)).slice(0, 60))).filter(Boolean).map((g) => g.data)
    .filter((v) => v.contact_id === contactId && ["scheduled", "en_route"].includes(v.status) && v.date >= day).sort((a, b) => `${a.date}${a.start}`.localeCompare(`${b.date}${b.start}`));
  let nextVisit = null;
  if (visits[0]) {
    const v = visits[0];
    const users = (await getRecords("user", (v.assignee_ids || []).slice(0, 4))).filter(Boolean).map((g) => g.data);
    nextVisit = { date: v.date, window_text: WINDOW_TEXT(v), techs: users.map((u) => String(u.first_name || u.name || "").split(/\s+/)[0]).filter(Boolean) };
  }
  const agRows = await listRel("contact-agreements", contactId, { limit: 40 }).catch(() => []);
  const agreements = (await getRecords("agreement", agRows.map((r) => r.id))).filter(Boolean).map((g) => g.data).filter((a) => !a.deleted_at && a.contact_id === contactId && ["sent", "viewed"].includes(a.status)).map((a) => ({ id: a.id, title: a.title }));
  const qRows = await listRel("contact-quotes", contactId, { limit: 40 }).catch(() => []);
  const quotes = (await getRecords("quote", qRows.map((r) => r.id))).filter(Boolean).map((g) => g.data).filter((q) => !q.deleted_at && q.contact_id === contactId && ["sent", "viewed"].includes(q.status) && q.current_version_id).map((q) => ({ id: q.id, number: q.number_label || "", expires_on: q.expires_on || null }));
  const pRows = await listRel("contact-plans", contactId, { limit: 40 }).catch(() => []);
  const STATUS = { active: "Active", pending: "Waiting for your signature", paused: "Paused", cancelling: "Ending soon" };
  const plans = (await getRecords("plan", pRows.map((r) => r.id))).filter(Boolean).map((g) => g.data)
    .filter((x) => !x.deleted_at && x.contact_id === contactId && x.kind !== "one_time_series" && STATUS[x.status])
    .map((x) => ({ name: x.name, status_text: STATUS[x.status], next: ((x.ordinals || []).filter((o) => ["unscheduled", "scheduled"].includes(o.status)).map((o) => o.visit_date ? o.visit_date.slice(0, 7) : o.target_month).sort()[0]) || null }));
  return { contact, nextVisit, agreements, quotes, plans };
}

// ------------------------------------------------------------ /p/login

// "+17635550100" from what was typed, or null.
export function phoneE164(raw) {
  let d = String(raw || "").replace(/\D/g, "");
  if (d.length === 11 && d.startsWith("1")) d = d.slice(1);
  return /^[2-9]\d{2}[2-9]\d{6}$/.test(d) ? `+1${d}` : null;
}
const stamp = (prefix) => `${prefix}${tsKey(now())}-${randomBytes(4).toString("hex")}`;
const timesOf = (keys) => keys.map((k) => /(\d{8}t\d{9}z)-[0-9a-f]+$/.exec(k)).filter(Boolean).map((m) => fromTsKey(m[1])).filter(Boolean).map((d) => d.getTime());

// → { ok } | { ok: false, why: "ip" }; phone throttling never shows (the answer is the same).
export async function login(phone, { ip }, ctx = {}) {
  const t = nowMs();
  const ipKey = `thr/plogin-ip/${sha(`${ip || "none"}|${localDate(new Date(t))}`).slice(0, 32)}/`;
  const ipTimes = timesOf(await listKeys(ipKey));
  if (ipTimes.filter((x) => x > t - 3600000).length >= LOGIN_LIMITS.ip_per_hour) return { ok: false, why: "ip" };
  await putRaw(stamp(ipKey), { at: new Date(t).toISOString() });
  const e164 = phoneE164(phone);
  if (!e164) throw new InputError("Enter your 10-digit mobile number.", "phone");
  let key;
  try { key = hk("phone", e164); } catch { return { ok: true, sent: false }; }
  const pKey = `thr/plogin/${String(key).slice(0, 32)}/`;
  const times = timesOf(await listKeys(pKey));
  const today = localDate(new Date(t));
  const todays = times.filter((x) => localDate(new Date(x)) === today);
  if (times.some((x) => x > t - LOGIN_LIMITS.phone_gap_ms) || todays.length >= LOGIN_LIMITS.phone_per_day) return { ok: true, sent: false, throttled: true };
  await putRaw(stamp(pKey), { at: new Date(t).toISOString() });
  if (!has("contacts.findMatches")) return { ok: true, sent: false };
  const matches = ((await call("contacts.findMatches", { phones: [e164] }, ctx)) || []).filter((m) => m.reason === "phone");
  const recs = (await getRecords("contact", matches.map((m) => m.id))).filter(Boolean).map((g) => g.data)
    .filter((c) => !c.deleted_at && !c.merged_into && c.lifecycle !== "archived" && !(c.flags && (c.flags.spam || c.flags.vendor)))
    .sort((a, b) => String(b.updated_at).localeCompare(String(a.updated_at)));
  const c = recs[0];
  if (!c) return { ok: true, sent: false };
  const link = await createPortalLink({ contact_id: c.id, scope: { kind: "hub" }, created_by: "portal:login" });
  const r = await sendMessage({
    contact_id: c.id, channel: "sms", template_key: "portal_login", vars: { portal_link: link.url }, origin: { kind: "system" }, category: "service",
    marker_key: `portal-login--${linkKey(link.code).slice(4, 28)}`,
  }, { by: "portal", origin: "portal", actor_kind: "portal", requestId: ctx.requestId || "portal" }).catch((e) => { console.error(`crm:plans: login text not sent (${safeErr(e)})`); return null; });
  return { ok: true, sent: !!r && ["sent", "dry_run", "queued", "scheduled"].includes(r.status) };
}

// ------------------------------------------------------------ routes

export const portalRoutes = [
  {
    method: "GET", path: "/p/agreement/:id", scope: "agreement",
    handler: async (p) => {
      const a = await agreementFor(p, p.params.id);
      if (!a) return p.message("That agreement isn't here", "Check the link in your text or email, or call us.", { status: 404, company: p.company });
      return page(p, a, "portal", `/api/portal/agreements/${encodeURIComponent(a.id)}`);
    },
  },
  {
    method: "POST", path: "/api/portal/agreements/:id/sign", scope: "agreement", maxBody: 400 * 1024,
    handler: (p) => answer(p, async () => {
      const a = await agreementFor(p, p.params.id);
      if (!a) return p.fail("not_found", "That agreement isn't here.", 404);
      return sign(p, a, { method: "portal" });
    }),
  },
  {
    method: "GET", path: "/p/hub", scope: "hub",
    handler: async (p) => {
      const d = await hubData(p.contact_id);
      const { title, body } = hubPage(d);
      return p.portalPage(p.layout({ title, body, script: SCRIPT_HUB, company: p.company, page: "hub" }));
    },
  },
  {
    method: "GET", path: "/p/hub/agreements/:id", scope: "hub",
    handler: async (p) => {
      const a = await agreementFor(p, p.params.id);
      if (!a) return p.message("That agreement isn't here", "Go back to your account, or call us.", { status: 404, company: p.company });
      return page(p, a, "hub", `/api/portal/hub/agreements/${encodeURIComponent(a.id)}`, "/p/hub");
    },
  },
  {
    method: "POST", path: "/api/portal/hub/agreements/:id/sign", scope: "hub", maxBody: 400 * 1024,
    handler: (p) => answer(p, async () => {
      const a = await agreementFor(p, p.params.id);
      if (!a) return p.fail("not_found", "That agreement isn't here.", 404);
      return sign(p, a, { method: "portal" });
    }),
  },
  {
    method: "POST", path: "/api/portal/hub/open", scope: "hub",
    handler: (p) => answer(p, async () => {
      const b = p.body || {};
      if (b.kind !== "quote" || !isId(b.id, "quote")) throw new InputError("Open which quote?", "id");
      const g = await getRecord("quote", b.id).catch(() => null);
      if (!g || g.data.deleted_at || g.data.contact_id !== p.contact_id || !["sent", "viewed"].includes(g.data.status)) return p.fail("not_found", "That quote isn't here.", 404);
      const link = await createPortalLink({ contact_id: p.contact_id, scope: { kind: "quote", id: b.id }, expires_at: zonedToUtc(addLocalDays(localDate(now()), 1), "23:59").toISOString(), created_by: "portal:hub" });
      return p.json({ ok: true, data: { location: `/p/${link.code}` } });
    }),
  },
  {
    method: "GET", path: "/p/login", scope: "public",
    handler: async (p) => {
      const { title, body } = loginPage();
      return p.portalPage(p.layout({ title, body, script: SCRIPT_LOGIN, company: p.company, page: "login" }));
    },
  },
  {
    method: "POST", path: "/api/portal/login", scope: "public", maxBody: 2 * 1024,
    handler: (p) => answer(p, async () => {
      const r = await login((p.body || {}).phone, { ip: clientIp(p.req, p.context) }, p.write());
      if (!r.ok) return p.fail("rate_limited", "Too many tries. Try again in an hour, or call us.", 429);
      return p.json({ ok: true, data: { message: LOGIN_ANSWER } });
    }),
  },
  {
    method: "GET", path: "/p/sign/:token", scope: "present",
    handler: async (p) => {
      const a = await presentAgreement(p);
      if (!a) return p.message("That agreement isn't here", "Open it again from the plan in the CRM.", { status: 404, company: p.company });
      return page(p, a, "present", `/api/portal/sign/${encodeURIComponent(p.params.token)}`, a.plan_id ? `/office#crm/plans/${encodeURIComponent(a.plan_id)}` : "/office#crm/plans");
    },
  },
  {
    method: "POST", path: "/api/portal/sign/:token", scope: "present", maxBody: 400 * 1024,
    handler: (p) => answer(p, async () => {
      const a = await presentAgreement(p);
      if (!a) return p.fail("not_found", "That agreement isn't here.", 404);
      const staff = isId(p.link.created_by, "user") ? p.link.created_by : null;
      const res = await sign(p, a, { method: "in_person", staff_user_id: staff });
      const { consumeLink } = await import("../../portal/core.mjs");
      await consumeLink(p.params.token).catch(() => {});
      return res;
    }),
  },
];

async function presentAgreement(p) {
  const id = p.link && p.link.scope && p.link.scope.id;
  if (!isId(id, "agreement")) return null;
  const g = await getRecord("agreement", id).catch(() => null);
  if (!g || g.data.deleted_at || g.data.contact_id !== p.contact_id) return null;
  return g.data;
}

// The view beacon: core's POST /api/portal/beacon { kind: "agreement", id } after load.
definePortalBeacon("agreement", async ({ id, session, write }) => {
  const g = isId(id, "agreement") ? await getRecord("agreement", id).catch(() => null) : null;
  if (!g || g.data.contact_id !== session.contact_id) return;
  await markViewed(id, { write });
});

// POST /agreements/:id/present (staff): a single-use 15-minute page to sign on this phone.
export async function presentLink(agreementId, ctx) {
  const g = await getRecord("agreement", agreementId);
  if (!g || g.data.deleted_at) throw new NotFoundError("That agreement isn't there.");
  if (!["draft", "sent", "viewed"].includes(g.data.status)) throw new ConflictError(g.data.status === "signed" ? "This agreement is already signed." : "This agreement can't be signed.");
  if (g.data.template_approved === false) throw new ConflictError("An owner approves the template's text first.", { code: "template_not_approved" });
  const link = await createPortalLink({ contact_id: g.data.contact_id, scope: { kind: "present", id: g.data.id }, single_use: true, created_by: (ctx.user && ctx.user.id) || "system" });
  return { url: `/p/sign/${link.code}`, expires_at: link.expires_at };
}
