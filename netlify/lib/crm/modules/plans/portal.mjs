// Plans module: the customer's pages (design §8.1, §8.5), registered
// through portalRoutes; crm-portal.mjs and portal/core.mjs (core) check the
// link's scope before any of these run, send the portal headers and CSP,
// and require X-CRM-Portal: 1 on POSTs.
//
//   GET  /p/agreement/:id                    scope agreement: read, sign, print
//   POST /api/portal/agreements/:id/sign     { body_sha256, name_typed, agree, signature_png_b64? }
//   GET  /p/hub and the rest of the customer's account (visits, history, plan, request work,
//        reschedule, contact info and texts): portal/account.mjs, registered here
//   GET  /p/hub/agreements/:id · POST /api/portal/hub/agreements/:id/sign   the same, from the hub
//   POST /api/portal/hub/open {kind: "quote" | "invoice", id}   a short link to one of them → { location }
//   GET  /p/login · POST /api/portal/login {phone}  public: "text me a link" (a hub link by text)
//   GET  /p/sign/:token · POST /api/portal/sign/:token/sign   in person on the staff phone (a present link)
//   beacon "agreement": sent → viewed
//
// A document link never opens the hub (core's scope check); the hub needs a
// hub link, which /p/login texts to a number on file. /p/login always gives
// the same answer (it never tells whether a number is on file), sends at
// most 1 text per 10 minutes and 3 a day per number, and takes 20 tries an
// hour per IP. GET pages never change anything.

import { createHash, randomBytes } from "node:crypto";
import { getRecord, listKeys, putRaw, hk, readPointer } from "../../../crm-store.mjs";
import { isId } from "../../core/ids.mjs";
import { now, nowMs, tsKey, fromTsKey } from "../../core/clock.mjs";
import { ConflictError, InputError, NotFoundError } from "../../core/errors.mjs";
import { clientIp, uaFamily } from "../../core/http.mjs";
import { ipHash } from "../../core/sessions.mjs";
import { has, call } from "../../core/services.mjs";
import { sendMessage } from "../../core/send.mjs";
import { definePortalBeacon, createPortalLink } from "../../portal/core.mjs";
import { enqueue, kickWorker } from "../../core/queue.mjs";
import { keySalt } from "../../core/context.mjs";
import { agreementPage, loginPage } from "./render.mjs";
import { accountRoutes, hubOpen } from "../../portal/account.mjs";
import { signAgreement, markViewed } from "./agreements.mjs";

const SCRIPT_AGREEMENT = "plans-agreement.js";
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
  // the plan activates from agreement.signed on the fast lane (the request stays inside the portal's budget)
  const out = await signAgreement(a.id, p.body || {}, who(p, { contact_id: p.contact_id, ...extra }), p);
  return p.json({ ok: true, data: { status: out.agreement.status, already: !!out.already } });
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

// "Text me a link" (POST /api/portal/login). Every valid number that isn't
// throttled costs exactly the same: the IP bucket, the number's bucket and
// one queue item carrying only the number's keyed hash, then a lane kick the
// request never waits for. Whether the number is on file is looked up later,
// on the fast lane (onLoginQueued): nothing in the answer, its time or its
// storage calls tells a number on file from one that isn't (§8.1).
//   ip: 20 tries an hour (a salted key, a rolling hour); a number: one every
//   10 minutes and 3 a day (rolling); a person: the same, however many
//   numbers they have on file (the text goes to their mobile).
// → { ok } | { ok: false, why: "ip" }; phone throttling never shows.
const DAY_MS = 24 * 3600 * 1000;
const ipKeyOf = (ip) => `thr/plogin-ip/${sha(`plogin|${ip || "none"}|${keySalt() || "dev-only"}`).slice(0, 32)}/`;
const contactKeyOf = (id) => `thr/plogin-c/${sha(`plogin|${id}|${keySalt() || "dev-only"}`).slice(0, 32)}/`;
const capped = (times, t) => times.some((x) => x > t - LOGIN_LIMITS.phone_gap_ms && x <= t) || times.filter((x) => x > t - DAY_MS && x <= t).length >= LOGIN_LIMITS.phone_per_day;
const stampAt = (prefix, t) => `${prefix}${tsKey(new Date(t))}-${randomBytes(4).toString("hex")}`;

export async function login(phone, { ip, waitUntil } = {}, ctx = {}) {
  const t = nowMs();
  const at = new Date(t).toISOString();
  const ipKey = ipKeyOf(ip);
  const ipTimes = timesOf(await listKeys(ipKey));
  if (ipTimes.filter((x) => x > t - 3600000).length >= LOGIN_LIMITS.ip_per_hour) return { ok: false, why: "ip" };
  await putRaw(stamp(ipKey), { at });
  const e164 = phoneE164(phone);
  if (!e164) throw new InputError("Enter your 10-digit mobile number.", "phone");
  const key = hk("phone", e164);
  const pKey = `thr/plogin/${String(key).slice(0, 32)}/`;
  if (capped(timesOf(await listKeys(pKey)), t)) return { ok: true, throttled: true };
  await putRaw(stamp(pKey), { at });
  await enqueue("plans.login", null, {}, now(), { ns: "done", scope: "plogin", key: `${String(key).slice(0, 16)}-${tsKey(new Date(t))}-${randomBytes(4).toString("hex")}` }, { data: { phone_hk: key, at: t }, kick: false });
  // wake the lane without holding the answer (never awaited)
  kickWorker("fast", "plans.login", typeof waitUntil === "function" ? { waitUntil } : {}).catch(() => {});
  return { ok: true };
}

// The queue item: who has that number (ptr/phone, surviving merges), at
// most 3 texts a day each, a hub link and the text to their mobile.
export async function onLoginQueued(h) {
  const key = h.item && h.item.data && h.item.data.phone_hk;
  if (typeof key !== "string" || !key) return { result: "skipped" };
  const ptr = await readPointer("phone", key).catch(() => null);
  const ids = (ptr && Array.isArray(ptr.ids) ? ptr.ids : []).filter((x) => isId(x, "contact")).slice(0, 10);
  const people = new Map();
  for (const id of ids) {
    let cur = id;
    for (let i = 0; i < 5 && isId(cur, "contact"); i++) {
      const g = await getRecord("contact", cur).catch(() => null);
      if (!g) break;
      const next = g.data.merged_into || g.data.merging_into;
      if (next && next !== cur) { cur = next; continue; }
      people.set(g.data.id, g.data);
      break;
    }
  }
  const c = [...people.values()].filter((x) => !x.deleted_at && !x.merged_into && x.lifecycle !== "archived" && !(x.flags && (x.flags.spam || x.flags.vendor)))
    .sort((a, b) => String(b.updated_at).localeCompare(String(a.updated_at)))[0];
  if (!c) return { result: "skipped:not_on_file" };
  // the person's cap counts from when they asked (the item may run later)
  const asked = Number.isSafeInteger(h.item.data.at) && h.item.data.at <= nowMs() ? h.item.data.at : nowMs();
  const cKey = contactKeyOf(c.id);
  if (capped(timesOf(await listKeys(cKey)), asked)) return { result: "skipped:capped" };
  await putRaw(stampAt(cKey, asked), { at: new Date(asked).toISOString() });
  const link = await createPortalLink({ contact_id: c.id, scope: { kind: "hub" }, created_by: "portal:login" });
  const r = await sendMessage({
    contact_id: c.id, channel: "sms", template_key: "portal_login", vars: { portal_link: link.url }, origin: { kind: "system" }, category: "service",
    marker_key: `portal-login--${String((h.marker && h.marker.key) || key.slice(0, 16)).replace(/[^a-z0-9._-]/gi, "-").slice(0, 60)}`,
  }, { by: "portal", origin: "portal", actor_kind: "portal", requestId: "plans-login" });
  return { result: r && r.status ? `sent:${r.status}` : "sent" };
}

// ------------------------------------------------------------ routes

export const portalRoutes = [
  // the customer's account: the hub, visits, history, plan, request work, reschedule, info and texts
  ...accountRoutes,
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
  { method: "POST", path: "/api/portal/hub/open", scope: "hub", handler: (p) => answer(p, () => hubOpen(p)) },
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
      const wait = p.context && typeof p.context.waitUntil === "function" ? (x) => p.context.waitUntil(x) : null;
      const r = await login((p.body || {}).phone, { ip: clientIp(p.req, p.context), waitUntil: wait }, p.write());
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
    method: "POST", path: "/api/portal/sign/:token/sign", scope: "present", maxBody: 400 * 1024,
    handler: (p) => answer(p, async () => {
      const a = await presentAgreement(p);
      if (!a) return p.fail("not_found", "That agreement isn't here.", 404);
      const staff = isId(p.link.created_by, "user") ? p.link.created_by : null;
      const res = await sign(p, a, { method: "in_person", staff_user_id: staff });
      const { consumeLink } = await import("../../portal/core.mjs");
      await consumeLink(p.params.token).catch((e) => console.error(`crm:plans: a present link wasn't spent (${e && e.name})`));
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
